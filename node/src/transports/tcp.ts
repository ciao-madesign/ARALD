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
  ) {}

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
    if (!entry) {
      throw new Error(`no active TCP connection to peer ${peerId}`);
    }
    entry.socket.write(encodePacket(packet));
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
    const rl = createInterface({ input: socket });
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
