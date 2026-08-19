import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { MessageType, PRIORITY_LEVEL_COUNT, createPacket, decodePacket, encodePacket, type Packet } from "../packet.js";
import { PriorityQueue } from "../priority-queue.js";
import type {
  PacketHandler,
  PeerAddress,
  PeerConnectedHandler,
  PeerDisconnectedHandler,
  Transport,
} from "../transport.js";

const CONNECT_TIMEOUT_MS = 5000;

/** Sized from `Priority` itself (packet.ts, spec §50) so it can never drift out of sync with the enum. */
const PRIORITY_LEVELS = PRIORITY_LEVEL_COUNT;

/** Bounds memory per peer if sends are produced faster than a socket can drain them (spec §57). */
const MAX_QUEUED_SENDS_PER_PEER = 500;

/**
 * `readline`'s Interface has no maximum line length — it buffers indefinitely
 * while waiting for a `\n`, so a peer that just never sends one can grow that
 * buffer without bound (a memory-exhaustion DoS reachable from a single
 * connected peer, independent of and prior to `decodePacket()`/the packet
 * rate limiter, which only ever see fully-decoded packets). This caps bytes
 * received since the last newline, well above any legitimate packet this
 * protocol produces (spec §57 resource limits).
 */
const MAX_LINE_BYTES = 2 * 1024 * 1024;

interface QueuedSend {
  packet: Packet;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface SocketEntry {
  socket: Socket;
  peerId: string;
  queue: PriorityQueue<QueuedSend>;
  draining: boolean;
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

  /**
   * Queues `packet` for `peerId`, ordered by `packet.priority` (spec §50)
   * ahead of anything already queued at a lower priority — a burst of
   * traffic to the same peer (e.g. a chunked transfer in flight) no longer
   * makes an EMERGENCY packet wait its turn behind BULK ones just because
   * they were queued first. Resolves once *this* packet has actually been
   * written, which can be later than the call if higher-priority sends
   * jumped ahead of it in the meantime.
   */
  async send(peerId: string, packet: Packet): Promise<void> {
    const entry = this.sockets.get(peerId);
    if (!entry || entry.socket.destroyed || !entry.socket.writable) {
      throw new Error(`no active TCP connection to peer ${peerId}`);
    }
    if (entry.queue.size >= MAX_QUEUED_SENDS_PER_PEER) {
      throw new Error(`send queue full for peer ${peerId}`);
    }
    await new Promise<void>((resolve, reject) => {
      entry.queue.enqueue(packet.priority, { packet, resolve, reject });
      this.drainQueue(entry);
    });
  }

  /** Writes queued packets for `entry` in priority order until the queue is empty or the socket dies. Safe to call repeatedly — a no-op while already draining. */
  private drainQueue(entry: SocketEntry): void {
    if (entry.draining) return;
    entry.draining = true;
    void (async () => {
      let next: QueuedSend | undefined;
      while ((next = entry.queue.dequeue())) {
        if (entry.socket.destroyed || !entry.socket.writable) {
          const err = new Error(`no active TCP connection to peer ${entry.peerId}`);
          next.reject(err);
          continue; // drain the rest too, rejecting each — a dead socket won't come back to life mid-loop
        }
        try {
          await this.writePacket(entry.socket, next.packet);
          next.resolve();
        } catch (err) {
          next.reject(err as Error);
        }
      }
      entry.draining = false;
    })();
  }

  /**
   * A write can fail three different ways once a socket is dying (e.g. the
   * remote end closed moments after the liveness check above): a
   * synchronous throw, an error passed to the write callback, or — for some
   * libuv-level failures like a broken pipe — an 'error' event instead of
   * (or alongside) that callback. All three must resolve this promise, or
   * the failure surfaces as an unhandled exception instead of a normal
   * rejection the caller's try/catch already handles.
   */
  private writePacket(socket: Socket, packet: Packet): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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
    // writePacket() attaches a transient, self-removing 'error' listener per write; drainQueue()
    // serializes writes to at most one in flight per socket, so this alone never approaches Node's
    // default 10-listener heuristic. Other long-lived listeners are wired below (readline, socket
    // 'data'/'close'/'error'), so raise the threshold as a margin rather than chase an exact count.
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
    // A second, independent listener on the same 'data' event — Node fans out 'data' to every
    // registered listener, so this doesn't disrupt readline's own consumption of the stream.
    let bytesSinceNewline = 0;
    socket.on("data", (chunk: Buffer) => {
      const lastNewline = chunk.lastIndexOf(0x0a);
      bytesSinceNewline = lastNewline === -1 ? bytesSinceNewline + chunk.length : chunk.length - lastNewline - 1;
      if (bytesSinceNewline > MAX_LINE_BYTES) socket.destroy(new Error("line exceeds max packet size"));
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

        this.sockets.set(peerId, { socket, peerId, queue: new PriorityQueue(PRIORITY_LEVELS), draining: false });
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
