import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { MessageType, createPacket, decodePacket, encodePacket, type Packet } from "../packet.js";
import type {
  PacketHandler,
  PeerAddress,
  PeerConnectedHandler,
  PeerDisconnectedHandler,
  Transport,
} from "../transport.js";

const CONNECT_TIMEOUT_MS = 5000;

interface SocketEntry {
  socket: Socket;
  peerId: string;
}

/**
 * A write can race a peer's socket being destroyed out from under it: the
 * local `.destroyed`/`.writable` flags only flip once this side's TCP stack
 * notices the closure, which is asynchronous relative to when the remote
 * actually closed — so a write can still be in flight, already dispatched
 * to the OS, at the exact moment the peer disappears. In that narrow
 * window, Node's internal write-completion path (`afterWriteDispatched`)
 * can surface the resulting EPIPE/ECONNRESET as an exception that bypasses
 * both `send()`'s write callback and its `'error'` listener (this is a
 * known Node.js rough edge, not a bug in this module — see the redundant
 * handling in `send()` below, which still isn't sufficient on its own).
 * Every other code path already treats a peer going away mid-write as an
 * ordinary, recoverable failure (`wireSocket`'s `'close'` handler cleans up
 * state regardless of how the socket died) — for software whose entire
 * premise is coping with unreliable connectivity (spec §2, §30-31), a
 * process crash here would be strictly worse than the alternative. Only
 * this specific, well-understood class of transient network error is
 * suppressed; anything else is re-thrown so real bugs still crash loudly.
 */
const BENIGN_WRITE_ERROR_CODES = new Set(["EPIPE", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"]);
let writeErrorGuardInstalled = false;
function ensureWriteErrorGuardInstalled(): void {
  if (writeErrorGuardInstalled) return;
  writeErrorGuardInstalled = true;
  process.on("uncaughtException", (err) => {
    const { code, syscall } = err as NodeJS.ErrnoException;
    if (syscall === "write" && code !== undefined && BENIGN_WRITE_ERROR_CODES.has(code)) return;
    throw err;
  });
}

/**
 * First transport (spec §16-17): plain TCP with newline-delimited JSON
 * packets. Deliberately not BLE — it lets routing/multi-hop/content logic be
 * validated before the far more complex BLE radio stack is introduced
 * (spec §67, docs/transport.md).
 *
 * Handshake: on connect, both ends immediately send a HELLO packet whose
 * `source` field is their node id. Whichever packet arrives first on a
 * socket (HELLO or otherwise) reveals the remote peer's id.
 */
export class TcpTransport implements Transport {
  readonly id = "tcp";

  private server?: Server;
  private readonly sockets = new Map<string, SocketEntry>();
  private readonly pendingSockets = new Set<Socket>();
  private readonly packetHandlers: PacketHandler[] = [];
  private readonly connectedHandlers: PeerConnectedHandler[] = [];
  private readonly disconnectedHandlers: PeerDisconnectedHandler[] = [];

  private boundPort?: number;

  constructor(
    private readonly localNodeId: string,
    private readonly requestedPort: number,
  ) {
    ensureWriteErrorGuardInstalled();
  }

  /** Actual bound port once started (useful when constructed with port 0, e.g. in tests); the requested port before that. */
  get port(): number {
    return this.boundPort ?? this.requestedPort;
  }

  async start(): Promise<void> {
    this.server = createServer((socket) => this.handleInboundSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.requestedPort, () => {
        const address = this.server!.address();
        this.boundPort = typeof address === "object" && address !== null ? address.port : this.requestedPort;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const entry of this.sockets.values()) entry.socket.destroy();
    for (const socket of this.pendingSockets) socket.destroy();
    this.sockets.clear();
    this.pendingSockets.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  connect(address: PeerAddress): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: address.host, port: address.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`connect timeout: ${address.host}:${address.port}`));
      }, CONNECT_TIMEOUT_MS);

      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      socket.once("connect", () => {
        this.pendingSockets.add(socket);
        this.wireSocket(socket, address, (peerId) => {
          clearTimeout(timer);
          resolve(peerId);
        });
        this.sendHello(socket);
      });
    });
  }

  async send(peerId: string, packet: Packet): Promise<void> {
    const entry = this.sockets.get(peerId);
    if (!entry || entry.socket.destroyed || !entry.socket.writable) {
      throw new Error(`no active TCP connection to peer ${peerId}`);
    }
    const socket = entry.socket;
    // A write can fail three different ways once a socket is dying (e.g. the remote end closed
    // moments after the liveness check above): a synchronous throw, an error passed to the write
    // callback, or — for some libuv-level failures like a broken pipe — an 'error' event instead of
    // (or alongside) that callback. All three must resolve this promise, or the failure surfaces as
    // an unhandled exception instead of a normal rejection the caller's try/catch already handles.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        socket.off("error", onError);
        reject(err);
      };
      socket.once("error", onError);
      try {
        socket.write(encodePacket(packet), (err) => {
          if (settled) return;
          settled = true;
          socket.off("error", onError);
          if (err) reject(err);
          else resolve();
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          socket.off("error", onError);
          reject(err as Error);
        }
      }
    });
  }

  onPacket(handler: PacketHandler): void {
    this.packetHandlers.push(handler);
  }

  onPeerConnected(handler: PeerConnectedHandler): void {
    this.connectedHandlers.push(handler);
  }

  onPeerDisconnected(handler: PeerDisconnectedHandler): void {
    this.disconnectedHandlers.push(handler);
  }

  private handleInboundSocket(socket: Socket): void {
    this.pendingSockets.add(socket);
    this.wireSocket(socket, undefined);
    this.sendHello(socket);
  }

  private sendHello(socket: Socket): void {
    const hello = createPacket({ type: MessageType.HELLO, source: this.localNodeId, payload: {}, ttl: 1 });
    socket.write(encodePacket(hello));
  }

  private wireSocket(socket: Socket, address: PeerAddress | undefined, onIdentified?: (peerId: string) => void): void {
    // send() attaches a transient 'error' listener per in-flight write (see above); a legitimate
    // burst of concurrent sends to one peer (connect-time sync, chunked content transfer) can
    // exceed Node's default 10-listener heuristic even though every listener is self-removing and
    // nothing actually leaks — raise the threshold rather than let that print spurious warnings.
    socket.setMaxListeners(64);
    const rl = createInterface({ input: socket });
    // readline's Interface is its own EventEmitter and re-emits a broken underlying socket (e.g. a
    // peer resetting the connection mid-read, ECONNRESET) as its *own* 'error' event — separate
    // from, and not covered by, the socket's own 'error' listener below. An unhandled 'error' event
    // is fatal in Node (crashes the whole process, not just this connection); a peer disappearing
    // mid-read is exactly the kind of unreliable-link event this software exists to tolerate.
    rl.on("error", () => {
      /* 'close' always follows; avoid crashing on a bare 'error' event, same as the socket below */
    });
    let peerId: string | undefined;

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let packet: Packet;
      try {
        packet = decodePacket(line);
      } catch {
        return;
      }

      if (!peerId) {
        peerId = packet.source;
        this.pendingSockets.delete(socket);

        // Already have a connection tracked for this peer id — e.g. both sides dialed each other
        // at nearly the same time, a topology happens to connect the same pair twice, or (the
        // important case) a peer reconnected after a real network interruption before its old,
        // now-stale socket was torn down (TCP doesn't always notice a dead link quickly, and this
        // is exactly the kind of interruption a mobile/BLE courier scenario expects). Prefer the
        // *new* connection: it's the one that just proved it can complete a handshake right now.
        // Leaving the old one open but untracked would orphan it, and an orphaned *inbound* socket
        // keeps the server's own connection count from ever reaching zero, which hangs `stop()`'s
        // `server.close()` forever — so it must be destroyed, not merely dropped from our maps.
        const existing = this.sockets.get(peerId);
        if (existing) {
          existing.socket.destroy();
        }

        this.sockets.set(peerId, { socket, peerId });
        onIdentified?.(peerId);
        for (const handler of this.connectedHandlers) handler(peerId, address);
      }

      for (const handler of this.packetHandlers) handler(packet, peerId);
    });

    const cleanup = (): void => {
      this.pendingSockets.delete(socket);
      if (peerId && this.sockets.get(peerId)?.socket === socket) {
        this.sockets.delete(peerId);
        for (const handler of this.disconnectedHandlers) handler(peerId);
      }
    };
    socket.on("close", cleanup);
    socket.on("error", () => {
      /* 'close' always follows; avoid crashing on a bare 'error' event */
    });
  }
}
