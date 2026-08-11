import { EventEmitter } from "node:events";
import { Identity } from "./identity.js";
import { PeerTable } from "./peer.js";
import { MessageType, Priority, createPacket, type Packet } from "./packet.js";
import {
  ChunkAssembler,
  ContentStore,
  computeContentId,
  contentSigningPayload,
  verifyContentSignature,
  type ContentMetadata,
} from "./content.js";
import { RemoteCatalog } from "./catalog.js";
import { SeenCache, decideForward } from "./routing.js";
import { PendingDeliveryQueue } from "./store-and-forward.js";
import { RateLimiter } from "./rate-limit.js";
import { TrustLevel, TrustManager, meetsTrustLevel } from "./trust.js";
import { RelayPolicy, type RelayPolicyOptions } from "./relay-policy.js";
import type { PeerAddress, Transport } from "./transport.js";

export interface NomadNodeOptions {
  displayName?: string;
  identity?: Identity;
  defaultTtl?: number;
  contentRequestTimeoutMs?: number;
  /** How long an undeliverable unicast packet is held before being dropped (spec §30, milestone 12). */
  storeAndForwardTtlMs?: number;
  /** Max packets held in the store-and-forward queue at once (spec §57 resource limits). */
  maxPendingDeliveries?: number;
  /** Max entries held in the remote (metadata-only) content catalog at once (spec §57 resource limits). */
  maxRemoteCatalogEntries?: number;
  /** Max node ids tracked in the trust table at once (spec §57 resource limits). */
  maxTrustEntries?: number;
  /** Max packets a single peer may send per window before further packets are dropped (spec §57). */
  maxPacketsPerWindow?: number;
  /** Rate-limiting window length in milliseconds. */
  rateLimitWindowMs?: number;
  /**
   * Minimum trust level (spec §54) a directly-connected peer must have
   * before this node will relay traffic on its behalf. Does not affect
   * whether that peer's own direct requests to us are served — only
   * whether we extend relay effort for it. Undefined (default) disables
   * this gate entirely, matching the prototype's previous behavior.
   *
   * Note: `TrustLevel.SEEN` is not a meaningful threshold here — every
   * peer that can reach this gate at all is already at least `SEEN`
   * (that level is assigned the moment a peer connects, before it can
   * send anything else), so `minTrustToRelay: SEEN` behaves identically
   * to leaving this unset. Use `VERIFIED` or higher for an actual gate.
   */
  minTrustToRelay?: TrustLevel;
  /** Whether/when this node relays traffic on behalf of others (spec §51, §58) — battery/charging-aware opt-out. */
  relayPolicy?: RelayPolicyOptions;
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

interface SyncRequestPayload {
  /** Content ids the sender already knows about (has locally, or has previously learned of via sync) — spec §33. */
  knownContentIds: string[];
}

interface SyncResponsePayload {
  /** Metadata only, never the bytes (spec §33: "confrontare cataloghi", not re-transfer everything). */
  entries: ContentMetadata[];
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
  /** Content known to exist elsewhere in the mesh via catalog sync (spec §33-34, milestone 13) but not fetched locally. */
  readonly remoteCatalog: RemoteCatalog;
  /** Per-node-id trust state (spec §54): SEEN/VERIFIED are earned automatically, TRUSTED/ADMIN are operator-assigned. */
  readonly trust: TrustManager;

  private readonly defaultTtl: number;
  private readonly contentRequestTimeoutMs: number;
  private readonly minTrustToRelay?: TrustLevel;
  private readonly seenCache = new SeenCache();
  private readonly requesterAssembler = new ChunkAssembler();
  private readonly relayAssembler = new ChunkAssembler();
  private readonly transports: Transport[] = [];
  private readonly peerTransport = new Map<string, Transport>();
  private readonly pendingContentRequests = new Map<string, PendingContentEntry>();
  private readonly pendingDeliveries: PendingDeliveryQueue;
  private readonly rateLimiter: RateLimiter;
  private readonly relayPolicy: RelayPolicy;
  private started = false;

  constructor(options: NomadNodeOptions = {}) {
    super();
    this.identity = options.identity ?? Identity.generate();
    this.displayName = options.displayName ?? `NODE-${this.identity.nodeId.slice(0, 8)}`;
    this.defaultTtl = options.defaultTtl ?? 8;
    this.contentRequestTimeoutMs = options.contentRequestTimeoutMs ?? 3000;
    this.minTrustToRelay = options.minTrustToRelay;
    this.pendingDeliveries = new PendingDeliveryQueue({
      ttlMs: options.storeAndForwardTtlMs,
      maxSize: options.maxPendingDeliveries,
    });
    this.remoteCatalog = new RemoteCatalog({ maxSize: options.maxRemoteCatalogEntries });
    this.trust = new TrustManager({ maxSize: options.maxTrustEntries });
    this.rateLimiter = new RateLimiter({
      maxPacketsPerWindow: options.maxPacketsPerWindow,
      windowMs: options.rateLimitWindowMs,
    });
    this.relayPolicy = new RelayPolicy(options.relayPolicy);
  }

  get nodeId(): string {
    return this.identity.nodeId;
  }

  get status(): "ONLINE" | "OFFLINE" {
    return this.started ? "ONLINE" : "OFFLINE";
  }

  /** Packets currently held for a destination that wasn't reachable yet (spec §30, milestone 12). */
  get pendingDeliveryCount(): number {
    return this.pendingDeliveries.size;
  }

  addTransport(transport: Transport): void {
    transport.onPacket((packet, fromPeerId) => this.handlePacket(packet, fromPeerId));
    transport.onPeerConnected((peerId, address) => {
      this.peers.upsert(peerId, address);
      this.peerTransport.set(peerId, transport);
      this.trust.markSeen(peerId);
      this.emit("peer:connected", peerId);
      void this.flushPendingDeliveries();
      void this.startCatalogSync(peerId);
    });
    transport.onPeerDisconnected((peerId) => {
      this.peers.remove(peerId);
      this.peerTransport.delete(peerId);
      this.rateLimiter.reset(peerId);
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

  /**
   * Publishes local content, making it discoverable via CONTENT_QUERY
   * (spec §23-25). Signs the full metadata — not just the content id — with
   * this node's identity (spec §55), so any other node that later receives
   * it can verify both that the bytes are unmodified AND that the claimed
   * name/type/size actually came from this publisher, not relabeled by a
   * relay along the way. Goes through the same `putVerified` trust gate as
   * content received from the network, rather than a separate
   * "local, unchecked" path.
   */
  publishContent(name: string, mimeType: string, data: Buffer): ContentMetadata {
    const contentId = computeContentId(data);
    const size = data.length;
    const publisherId = this.nodeId;
    const signature = this.identity.sign(contentSigningPayload({ contentId, name, mimeType, size, publisherId })).toString("hex");
    const metadata: ContentMetadata = { contentId, name, mimeType, size, createdAt: Date.now(), publisherId, signature };
    if (!this.contentStore.putVerified(metadata, data)) {
      throw new Error("internal error: freshly signed content failed its own signature verification");
    }
    return metadata;
  }

  /**
   * Everything this node can currently tell a user about: content it
   * actually holds plus content it only knows exists elsewhere via catalog
   * sync (spec §33, §59 "Search" UI). Local entries win on conflict, since
   * they mean the bytes are already here.
   */
  listKnownContent(): ContentMetadata[] {
    const merged = new Map<string, ContentMetadata>();
    for (const metadata of this.remoteCatalog.list()) merged.set(metadata.contentId, metadata);
    for (const metadata of this.contentStore.list()) merged.set(metadata.contentId, metadata);
    return Array.from(merged.values());
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

  /** Returns whether the send actually succeeded, so callers can tell a real delivery from a swallowed failure. */
  private async sendToPeer(peerId: string, packet: Packet): Promise<boolean> {
    const transport = this.peerTransport.get(peerId);
    if (!transport) return false;
    try {
      await transport.send(peerId, packet);
      return true;
    } catch {
      // best-effort: a peer that dropped mid-send will be cleaned up via onPeerDisconnected;
      // the caller (floodExcept) decides whether the failed send warrants a store-and-forward retry.
      return false;
    }
  }

  /**
   * Floods a packet to every currently connected peer (except the one it
   * arrived from, if any). If this is a unicast packet (a specific
   * destination is known, and it isn't us) and either there is nobody to
   * flood it to, or every send attempt failed, it is held in the
   * store-and-forward queue instead of being silently dropped (spec §30) —
   * retried automatically the next time a new peer connects (see
   * `flushPendingDeliveries`). Returns whether at least one send succeeded.
   */
  private async floodExcept(packet: Packet, exceptPeerId?: string): Promise<boolean> {
    const targets = this.peers.list().filter((p) => p.id !== exceptPeerId);
    const isUnicastElsewhere = packet.destination !== undefined && packet.destination !== this.nodeId;

    const delivered =
      targets.length > 0 && (await Promise.all(targets.map((p) => this.sendToPeer(p.id, packet)))).some(Boolean);

    if (!delivered && isUnicastElsewhere) {
      this.pendingDeliveries.enqueue(packet, exceptPeerId);
      this.emit("store-and-forward:queued", packet);
    }

    return delivered;
  }

  /**
   * Retries every packet still worth delivering, typically triggered by a
   * new peer connecting (spec §32, courier). A queued packet originally
   * relayed on behalf of `exceptPeerId` (as opposed to one we originated
   * ourselves) must pass the same trust/relay-policy gates a fresh forward
   * decision would — conditions can change between when it was queued and
   * when it's retried (trust revoked, battery since dropped) — otherwise
   * store-and-forward would be a silent way around both gates.
   */
  private async flushPendingDeliveries(): Promise<void> {
    await Promise.all(
      this.pendingDeliveries.drain().map(async ({ packet, exceptPeerId }) => {
        if (exceptPeerId !== undefined) {
          const gate = this.relayGateFor(exceptPeerId);
          if (gate !== "ok") {
            // Still worth retrying later if circumstances change — re-queue rather than drop.
            this.pendingDeliveries.enqueue(packet, exceptPeerId);
            this.emitRelayGateDenied(gate, exceptPeerId, packet.type);
            return;
          }
        }
        await this.floodExcept(packet, exceptPeerId);
      }),
    );
  }

  /** Whether this node is currently willing to relay on behalf of `peerId` (spec §54, §51/§58). */
  private relayGateFor(peerId: string): "trust" | "policy" | "ok" {
    if (this.minTrustToRelay && !meetsTrustLevel(this.trust.get(peerId), this.minTrustToRelay)) return "trust";
    if (!this.relayPolicy.canRelayNow()) return "policy";
    return "ok";
  }

  private emitRelayGateDenied(gate: "trust" | "policy", peerId: string, packetType: MessageType): void {
    if (gate === "trust") {
      this.emit("trust:relay-denied", peerId, this.trust.get(peerId));
    } else {
      this.emit("relay-policy:denied", peerId, packetType);
    }
  }

  /**
   * Announces this node's catalog to a newly connected peer (spec §33-34,
   * milestone 13). This is a direct, single-hop exchange — sent straight to
   * the peer via `sendToPeer`, not flooded — because it only ever concerns
   * the two nodes that just connected, exactly like the HELLO handshake.
   */
  private async startCatalogSync(peerId: string): Promise<void> {
    const knownContentIds = this.listKnownContent().map((m) => m.contentId);
    const request = this.originate<SyncRequestPayload>(
      MessageType.SYNC_REQUEST,
      { knownContentIds },
      { destination: peerId, priority: Priority.CONTROL },
    );
    await this.sendToPeer(peerId, request);
  }

  private handlePacket(packet: Packet, fromPeerId: string): void {
    if (!this.rateLimiter.allow(fromPeerId)) {
      // Over budget for this window (spec §57): drop without processing, forwarding, or even
      // touching the peer table — a flooding peer shouldn't cost this node more than the check itself.
      this.emit("rate-limit:exceeded", fromPeerId, packet.type);
      return;
    }

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
      // This peer's own direct requests to us are unaffected either way — these gates only
      // decide whether we extend relay effort ferrying its traffic onward to others (spec §54, §57, §51/§58).
      const gate = this.relayGateFor(fromPeerId);
      if (gate !== "ok") {
        const denied = decision.forwardPacket;
        if (denied.destination !== undefined && denied.destination !== this.nodeId) {
          // Worth retrying later — trust can be upgraded, a battery-gated policy can recover —
          // so this is a queue, not a drop (consistent with how flushPendingDeliveries re-queues
          // on a denial found at retry time, so the packet is treated the same regardless of
          // which attempt — first or retried — the gate happened to catch it on).
          this.pendingDeliveries.enqueue(denied, fromPeerId);
        }
        this.emitRelayGateDenied(gate, fromPeerId, denied.type);
      } else {
        void this.floodExcept(decision.forwardPacket, fromPeerId);
      }
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

      case MessageType.SYNC_REQUEST:
        this.handleSyncRequest(packet as Packet<SyncRequestPayload>, fromPeerId);
        break;

      case MessageType.SYNC_RESPONSE:
        this.handleSyncResponse(packet as Packet<SyncResponsePayload>);
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

    // putVerified() re-checks the hash (redundant with tryComplete's own check, harmless) and —
    // critically — the publisher signature (spec §55). A caller must never be handed bytes this
    // node itself wouldn't trust enough to cache: resolving with `data` regardless of this result
    // would let a node with a forged/missing signature still succeed a getContent() call.
    const stored = data ? this.contentStore.putVerified(metadata, data) : false;

    if (!stored) {
      if (entry) {
        this.pendingContentRequests.delete(contentId);
        const error = new Error(
          data
            ? `content signature invalid or untrusted publisher: ${contentId}`
            : `content hash mismatch or incomplete transfer: ${contentId}`,
        );
        for (const waiter of entry.waiters) {
          clearTimeout(waiter.timeout);
          waiter.reject(error);
        }
      }
      return;
    }

    // A successfully verified signature is real evidence this publisher controls its claimed
    // identity's private key (spec §54) — independent of whether we happen to trust *this* content.
    if (metadata.publisherId) this.trust.markVerified(metadata.publisherId);

    if (entry) {
      this.pendingContentRequests.delete(contentId);
      for (const waiter of entry.waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve(data!);
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
      if (data && this.contentStore.putVerified(metadata, data) && metadata.publisherId) {
        this.trust.markVerified(metadata.publisherId);
      }
    }
  }

  /** Replies with catalog entries the requester doesn't already know about (spec §33) — metadata only, never bytes. */
  private handleSyncRequest(packet: Packet<SyncRequestPayload>, fromPeerId: string): void {
    const known = new Set(packet.payload.knownContentIds);
    const newEntries = this.listKnownContent().filter((metadata) => !known.has(metadata.contentId));
    if (newEntries.length === 0) return;

    const response = this.originate<SyncResponsePayload>(
      MessageType.SYNC_RESPONSE,
      { entries: newEntries },
      { destination: packet.source, priority: Priority.CONTROL },
    );
    void this.sendToPeer(fromPeerId, response);
  }

  /**
   * Records what a peer's catalog reply announced — existence only;
   * retrieval still happens on demand via getContent(). A SYNC_RESPONSE is
   * untrusted network input just like a CONTENT_COMPLETE: each entry must
   * carry a valid publisher signature (spec §55) before it's trusted enough
   * to keep and re-advertise to the next peer — otherwise a single
   * malicious node could inject fabricated "this content exists, signed by
   * <victim>" claims that propagate transitively across catalog syncs.
   */
  private handleSyncResponse(packet: Packet<SyncResponsePayload>): void {
    const accepted: ContentMetadata[] = [];
    for (const metadata of packet.payload.entries) {
      if (this.contentStore.has(metadata.contentId)) continue; // we already hold the actual bytes
      if (!verifyContentSignature(metadata)) continue; // unsigned or forged claim — never trust it
      this.remoteCatalog.record(metadata);
      if (metadata.publisherId) this.trust.markVerified(metadata.publisherId);
      accepted.push(metadata);
    }
    if (accepted.length > 0) this.emit("catalog-sync", accepted);
  }
}
