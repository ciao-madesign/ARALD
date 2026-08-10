import { EventEmitter } from "node:events";
import { Identity } from "./identity.js";
import { PeerTable } from "./peer.js";
import { MessageType, Priority, createPacket, type Packet } from "./packet.js";
import { ChunkAssembler, ContentStore, type ContentMetadata } from "./content.js";
import { SeenCache, decideForward } from "./routing.js";
import type { PeerAddress, Transport } from "./transport.js";

export interface NomadNodeOptions {
  displayName?: string;
  identity?: Identity;
  defaultTtl?: number;
  contentRequestTimeoutMs?: number;
}

interface ContentWaiter {
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingContentEntry {
  contentId: string;
  /** True once a CONTENT_QUERY has been flooded for this content id, so concurrent local callers don't re-flood. */
  queried: boolean;
  /** True once a CONTENT_REQUEST has been sent to a specific provider, so multiple CONTENT_FOUND replies only trigger one request. */
  requested: boolean;
  waiters: ContentWaiter[];
}

interface ContentQueryPayload {
  contentId: string;
}

interface ContentFoundPayload {
  queryId: string;
  contentId: string;
  metadata: ContentMetadata;
}

interface ContentChunkPayload {
  contentId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string;
}

interface ContentCompletePayload {
  contentId: string;
  metadata: ContentMetadata;
}

/**
 * A Nomad-Net mesh node (spec §7): wires identity, peer table, one or more
 * transports, controlled-flooding routing and the content-centric protocol
 * together. This is `nomad-node` (spec §13), currently implementing
 * milestones 0-7 of docs/roadmap.md.
 */
export class NomadNode extends EventEmitter {
  readonly identity: Identity;
  readonly displayName: string;
  readonly peers = new PeerTable();
  readonly contentStore = new ContentStore();

  private readonly defaultTtl: number;
  private readonly contentRequestTimeoutMs: number;
  private readonly seenCache = new SeenCache();
  private readonly requesterAssembler = new ChunkAssembler();
  private readonly relayAssembler = new ChunkAssembler();
  private readonly transports: Transport[] = [];
  private readonly peerTransport = new Map<string, Transport>();
  private readonly pendingContentRequests = new Map<string, PendingContentEntry>();
  private started = false;

  constructor(options: NomadNodeOptions = {}) {
    super();
    this.identity = options.identity ?? Identity.generate();
    this.displayName = options.displayName ?? `NODE-${this.identity.nodeId.slice(0, 8)}`;
    this.defaultTtl = options.defaultTtl ?? 8;
    this.contentRequestTimeoutMs = options.contentRequestTimeoutMs ?? 3000;
  }

  get nodeId(): string {
    return this.identity.nodeId;
  }

  get status(): "ONLINE" | "OFFLINE" {
    return this.started ? "ONLINE" : "OFFLINE";
  }

  addTransport(transport: Transport): void {
    transport.onPacket((packet, fromPeerId) => this.handlePacket(packet, fromPeerId));
    transport.onPeerConnected((peerId, address) => {
      this.peers.upsert(peerId, address);
      this.peerTransport.set(peerId, transport);
      this.emit("peer:connected", peerId);
    });
    transport.onPeerDisconnected((peerId) => {
      this.peers.remove(peerId);
      this.peerTransport.delete(peerId);
      this.emit("peer:disconnected", peerId);
    });
    this.transports.push(transport);
  }

  async start(): Promise<void> {
    for (const transport of this.transports) await transport.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    for (const transport of this.transports) await transport.stop();
    this.started = false;
  }

  async connect(address: PeerAddress, transportId?: string): Promise<string> {
    const transport = this.pickTransport(transportId);
    const peerId = await transport.connect(address);
    this.peers.upsert(peerId, address);
    this.peerTransport.set(peerId, transport);
    return peerId;
  }

  /** Publishes local content, making it discoverable via CONTENT_QUERY (spec §23-25). */
  publishContent(name: string, mimeType: string, data: Buffer): ContentMetadata {
    return this.contentStore.put(name, mimeType, data);
  }

  /**
   * Resolves a content id to its bytes: served from local cache if present,
   * otherwise discovered and retrieved through the mesh (spec §90-92,
   * "first/second/third technical objective").
   */
  getContent(contentId: string, options: { timeoutMs?: number } = {}): Promise<Buffer> {
    const cached = this.contentStore.get(contentId);
    if (cached) return Promise.resolve(cached.data);

    return new Promise<Buffer>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.contentRequestTimeoutMs;

      let entry = this.pendingContentRequests.get(contentId);
      if (!entry) {
        entry = { contentId, queried: false, requested: false, waiters: [] };
        this.pendingContentRequests.set(contentId, entry);
      }
      const activeEntry = entry;

      const waiter: ContentWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          activeEntry.waiters = activeEntry.waiters.filter((w) => w !== waiter);
          if (activeEntry.waiters.length === 0) this.pendingContentRequests.delete(contentId);
          reject(new Error(`content not found within mesh: ${contentId}`));
        }, timeoutMs),
      };
      activeEntry.waiters.push(waiter);

      // Only the first caller for a given content id actually floods a query;
      // concurrent callers for the same id piggyback on the same in-flight request.
      if (!activeEntry.queried) {
        activeEntry.queried = true;
        const query = this.originate<ContentQueryPayload>(
          MessageType.CONTENT_QUERY,
          { contentId },
          { priority: Priority.CONTENT },
        );
        void this.floodExcept(query);
      }
    });
  }

  ping(destination: string): void {
    const packet = this.originate(MessageType.PING, {}, { destination, priority: Priority.CONTROL });
    void this.floodExcept(packet);
  }

  sendData(destination: string, payload: unknown): string {
    const packet = this.originate(MessageType.DATA, payload, { destination, priority: Priority.MESSAGING });
    void this.floodExcept(packet);
    return packet.id;
  }

  /** Announces this node's known peers (spec §15 "PEER_LIST"), informational only — does not auto-connect. */
  sharePeerList(destination?: string): void {
    const list = this.peers.list().map((p) => ({ id: p.id, address: p.address }));
    const packet = this.originate(MessageType.PEER_LIST, list, { destination, priority: Priority.CONTROL });
    void this.floodExcept(packet);
  }

  private pickTransport(transportId?: string): Transport {
    const transport = transportId ? this.transports.find((t) => t.id === transportId) : this.transports[0];
    if (!transport) throw new Error("no transport available");
    return transport;
  }

  private originate<T>(
    type: MessageType,
    payload: T,
    opts: { destination?: string; priority?: Priority; ttl?: number } = {},
  ): Packet<T> {
    const packet = createPacket({
      type,
      source: this.nodeId,
      destination: opts.destination,
      payload,
      priority: opts.priority,
      ttl: opts.ttl ?? this.defaultTtl,
    });
    // Mark our own packets as seen so a flooded copy that loops back to us is dropped, not reprocessed.
    this.seenCache.markSeen(packet.id);
    return packet;
  }

  private async sendToPeer(peerId: string, packet: Packet): Promise<void> {
    const transport = this.peerTransport.get(peerId);
    if (!transport) return;
    await transport.send(peerId, packet).catch(() => {
      /* best-effort: a peer that dropped mid-send will be cleaned up via onPeerDisconnected */
    });
  }

  private async floodExcept(packet: Packet, exceptPeerId?: string): Promise<void> {
    const targets = this.peers.list().filter((p) => p.id !== exceptPeerId);
    await Promise.all(targets.map((p) => this.sendToPeer(p.id, packet)));
  }

  private handlePacket(packet: Packet, fromPeerId: string): void {
    this.peers.touch(fromPeerId);

    if (packet.type === MessageType.HELLO) {
      // Handshake-only: identifies the peer at the transport layer, never routed or delivered further.
      return;
    }

    const decision = decideForward(packet, this.nodeId, this.seenCache);
    if (decision.duplicate) return;

    // A relay caches transiting content whenever it isn't the final destination itself — including the
    // edge case where TTL is exhausted on arrival and the packet is about to be dropped rather than forwarded.
    if (!decision.deliverLocally && (packet.type === MessageType.CONTENT_CHUNK || packet.type === MessageType.CONTENT_COMPLETE)) {
      this.observeRelayedContent(packet);
    }

    if (decision.deliverLocally) {
      this.deliver(packet, fromPeerId);
    }

    if (decision.forwardPacket) {
      void this.floodExcept(decision.forwardPacket, fromPeerId);
    }
  }

  private deliver(packet: Packet, fromPeerId: string): void {
    switch (packet.type) {
      case MessageType.PING:
        void this.sendToPeer(
          fromPeerId,
          this.originate(MessageType.PONG, {}, { destination: packet.source, priority: Priority.CONTROL }),
        );
        this.emit("ping", packet.source);
        break;

      case MessageType.PONG:
        this.emit("pong", packet.source);
        break;

      case MessageType.PEER_LIST:
        for (const entry of packet.payload as Array<{ id: string; address?: PeerAddress }>) {
          if (entry.id !== this.nodeId) this.peers.upsert(entry.id, entry.address);
        }
        this.emit("peer-list", packet.payload);
        break;

      case MessageType.DATA:
        this.emit("data", packet);
        void this.sendToPeer(
          fromPeerId,
          this.originate(MessageType.ACK, { ackOf: packet.id }, { destination: packet.source, priority: Priority.CONTROL }),
        );
        break;

      case MessageType.ACK:
        this.emit("ack", packet);
        break;

      case MessageType.CONTENT_QUERY:
        this.handleContentQuery(packet as Packet<ContentQueryPayload>);
        break;

      case MessageType.CONTENT_FOUND:
        this.handleContentFound(packet as Packet<ContentFoundPayload>);
        break;

      case MessageType.CONTENT_REQUEST:
        this.handleContentRequest(packet as Packet<ContentQueryPayload>);
        break;

      case MessageType.CONTENT_CHUNK:
        this.handleContentChunk(packet as Packet<ContentChunkPayload>);
        break;

      case MessageType.CONTENT_COMPLETE:
        this.handleContentComplete(packet as Packet<ContentCompletePayload>);
        break;

      default:
        break;
    }
  }

  private handleContentQuery(packet: Packet<ContentQueryPayload>): void {
    const stored = this.contentStore.get(packet.payload.contentId);
    if (!stored) return; // We don't have it; decideForward already keeps the flood going.
    const response = this.originate<ContentFoundPayload>(
      MessageType.CONTENT_FOUND,
      { queryId: packet.id, contentId: packet.payload.contentId, metadata: stored.metadata },
      { destination: packet.source, priority: Priority.CONTENT },
    );
    void this.floodExcept(response);
  }

  private handleContentFound(packet: Packet<ContentFoundPayload>): void {
    const entry = this.pendingContentRequests.get(packet.payload.contentId);
    if (!entry || entry.requested) return; // Not waiting on this, or already requested from an earlier reply.
    entry.requested = true;
    const request = this.originate<ContentQueryPayload>(
      MessageType.CONTENT_REQUEST,
      { contentId: packet.payload.contentId },
      { destination: packet.source, priority: Priority.CONTENT },
    );
    void this.floodExcept(request);
  }

  private handleContentRequest(packet: Packet<ContentQueryPayload>): void {
    const stored = this.contentStore.get(packet.payload.contentId);
    if (!stored) return;
    const chunks = this.contentStore.chunksFor(packet.payload.contentId);
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const chunkPacket = this.originate<ContentChunkPayload>(
        MessageType.CONTENT_CHUNK,
        { contentId: packet.payload.contentId, chunkIndex, totalChunks: chunks.length, data: chunk.toString("base64") },
        { destination: packet.source, priority: Priority.CONTENT },
      );
      void this.floodExcept(chunkPacket);
    }
    const completePacket = this.originate<ContentCompletePayload>(
      MessageType.CONTENT_COMPLETE,
      { contentId: packet.payload.contentId, metadata: stored.metadata },
      { destination: packet.source, priority: Priority.CONTENT },
    );
    void this.floodExcept(completePacket);
  }

  private handleContentChunk(packet: Packet<ContentChunkPayload>): void {
    const { contentId, chunkIndex, totalChunks, data } = packet.payload;
    this.requesterAssembler.addChunk(contentId, chunkIndex, totalChunks, Buffer.from(data, "base64"));
  }

  private handleContentComplete(packet: Packet<ContentCompletePayload>): void {
    const { contentId, metadata } = packet.payload;
    const entry = this.pendingContentRequests.get(contentId);
    const data = this.requesterAssembler.tryComplete(contentId, metadata);

    if (!data) {
      if (entry) {
        this.pendingContentRequests.delete(contentId);
        const error = new Error(`content hash mismatch or incomplete transfer: ${contentId}`);
        for (const waiter of entry.waiters) {
          clearTimeout(waiter.timeout);
          waiter.reject(error);
        }
      }
      return;
    }

    this.contentStore.putVerified(metadata, data);
    if (entry) {
      this.pendingContentRequests.delete(contentId);
      for (const waiter of entry.waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve(data);
      }
    }
  }

  /** Passive/opportunistic caching (spec §27, §91-92): a relay reassembles content it forwards and caches it too. */
  private observeRelayedContent(packet: Packet): void {
    if (packet.type === MessageType.CONTENT_CHUNK) {
      const { contentId, chunkIndex, totalChunks, data } = packet.payload as ContentChunkPayload;
      if (this.contentStore.has(contentId)) return;
      this.relayAssembler.addChunk(contentId, chunkIndex, totalChunks, Buffer.from(data, "base64"));
    } else if (packet.type === MessageType.CONTENT_COMPLETE) {
      const { contentId, metadata } = packet.payload as ContentCompletePayload;
      if (this.contentStore.has(contentId)) {
        this.relayAssembler.discard(contentId);
        return;
      }
      const data = this.relayAssembler.tryComplete(contentId, metadata);
      if (data) this.contentStore.putVerified(metadata, data);
    }
  }
}
