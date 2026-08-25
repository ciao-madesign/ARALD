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
import { TrustLevel, TrustManager, meetsTrustLevel, trustRank } from "./trust.js";
import { RelayPolicy, type RelayPolicyOptions } from "./relay-policy.js";
import {
  EncryptionIdentity,
  decryptFromPeer,
  encryptForPeer,
  signIdentityAnnouncement,
  verifyIdentityAnnouncement,
  type EncryptedPayload,
  type IdentityAnnouncement,
} from "./encryption.js";
import { PeerDirectory } from "./peer-directory.js";
import { MessageHistory, MAX_MESSAGE_TEXT_LENGTH } from "./message-history.js";
import { RoutingTable } from "./routing-table.js";
import { ServiceDirectory } from "./service-directory.js";
import { serviceSigningPayload, verifyServiceAnnouncement, type ServiceAnnouncement, type ServiceHandler } from "./service.js";
import type { PeerAddress, Transport } from "./transport.js";

export interface NomadNodeOptions {
  displayName?: string;
  identity?: Identity;
  defaultTtl?: number;
  contentRequestTimeoutMs?: number;
  /** How long a content provider may stay silent before getContent() tries the next known candidate, instead of waiting out contentRequestTimeoutMs on one unresponsive provider. */
  contentProviderTimeoutMs?: number;
  /** How long an undeliverable unicast packet is held before being dropped (spec §30, milestone 12). */
  storeAndForwardTtlMs?: number;
  /** Max packets held in the store-and-forward queue at once (spec §57 resource limits). */
  maxPendingDeliveries?: number;
  /** Max entries held in the remote (metadata-only) content catalog at once (spec §57 resource limits). */
  maxRemoteCatalogEntries?: number;
  /** Max node ids tracked in the trust table at once (spec §57 resource limits). */
  maxTrustEntries?: number;
  /** Max distinct content ids held (bytes included) in this node's local content store at once (spec §57 resource limits). */
  maxContentStoreEntries?: number;
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
  /** X25519 key pair for end-to-end encrypted private messages (spec §52). Generated automatically if omitted. */
  encryptionIdentity?: EncryptionIdentity;
  /** Max node ids tracked in the peer encryption-key directory at once (spec §57 resource limits). */
  maxPeerDirectoryEntries?: number;
  /** Max destinations tracked in the routing table at once (spec §57 resource limits). */
  maxRoutingTableEntries?: number;
  /** Routes with a hop-count cost above this are never adopted, bounding how far distance-vector updates propagate (spec §22). */
  maxRouteCost?: number;
  /** Max distinct content ids being chunk-reassembled at once, for both the requester and relay assemblers (spec §57 resource limits). */
  maxChunkAssemblyEntries?: number;
  /** Max chunks a single content id may claim during reassembly; also bounds the largest content this node will attempt to reassemble. */
  maxChunksPerContent?: number;
  /** Max (serviceId, providerId) entries tracked in the remote service directory at once (spec §57 resource limits). */
  maxServiceDirectoryEntries?: number;
  /** Max distinct 1:1 conversations tracked in `messageHistory` at once (spec §57 resource limits). */
  maxMessageHistoryPeers?: number;
  /** Max messages kept per conversation in `messageHistory` — the oldest is dropped once exceeded. */
  maxMessagesPerPeer?: number;
}

interface ContentWaiter {
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

/** Bounds how many alternate providers a single content request will remember (spec §57 resource limits). */
const MAX_CONTENT_CANDIDATES = 16;

/**
 * Outranks any trust level `TrustManager` can actually assign (spec §54's
 * highest, ADMIN, ranks 4) for `ContentStore` eviction purposes. A node
 * never records trust for its own node id in its own `TrustManager` (there
 * is nothing to "earn" trust from itself for) — without this, content this
 * node published itself would score the same UNKNOWN rank as a freshly
 * minted throwaway identity, and could be evicted from a full store just as
 * readily. Deliberately finite, not `Infinity`: `BoundedFifoMap`'s eviction
 * search seeds its own "best so far" at `Infinity`, so a score of exactly
 * `Infinity` would never register as strictly lower than that sentinel.
 */
const OWN_CONTENT_TRUST_RANK = trustRank(TrustLevel.ADMIN) + 1;

/**
 * Bounds how many route entries a single ROUTE_ANNOUNCE packet may affect (spec §57). Unlike
 * SYNC_RESPONSE/IDENTITY_RESPONSE entries, a route carries no signature of its own to individually
 * rate-limit trust in — routingTable's trust-weighted eviction (node.ts constructor, `RoutingTable`
 * options) already protects against a low-trust announcer evicting high-trust routes, but without
 * this cap a single oversized packet could still spend a large amount of CPU/memory processing
 * thousands of fabricated destinations in one call, regardless of how few of them ultimately "win"
 * eviction. Generous for any real mesh's neighbor route table while still bounding one packet's
 * worst case; extra entries beyond this are silently dropped, not rejected outright.
 */
const MAX_ROUTES_PER_ANNOUNCE = 512;

interface PendingContentEntry {
  contentId: string;
  /** True once a CONTENT_QUERY has been flooded for this content id, so concurrent local callers don't re-flood. */
  queried: boolean;
  /** Node id of the provider a CONTENT_REQUEST is currently outstanding to, if any. */
  activeProvider?: string;
  /**
   * Other providers that replied CONTENT_FOUND while `activeProvider` was already being tried —
   * tried in arrival order if the active one goes silent (spec §90-92: a peer that answered a
   * moment ago isn't guaranteed to still be reachable in an unreliable mesh).
   */
  candidates: string[];
  /** Retries the next candidate once the active provider has made no progress for this long — refreshed on each chunk received, cleared on success, `undefined` once candidates run out. */
  providerTimer?: NodeJS.Timeout;
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

/**
 * Explicit "I no longer have this" reply to a CONTENT_REQUEST (spec §25),
 * sent by a provider that answered CONTENT_FOUND a moment ago but has since
 * lost the content — evicted from a bounded cache, or expired (spec §24) —
 * by the time the requester actually asked for the bytes. Lets the
 * requester fail over to the next known candidate immediately instead of
 * silently waiting out `contentProviderTimeoutMs` on a provider that will
 * never answer.
 */
interface ContentNotFoundPayload {
  contentId: string;
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
 * Proactive broadcast announcing a piece of content's existence — the
 * push counterpart to the pull-based CONTENT_QUERY cycle (spec §25).
 * Carries only signed metadata, never the bytes: a recipient still fetches
 * the actual content through the normal CONTENT_QUERY -> CONTENT_COMPLETE
 * cycle if/when it wants it. Opt-in per publish (`publishContent()`'s
 * `announce` option) — most publishers (e.g. KiwixGateway's catalog sync)
 * still rely on pull discovery/periodic catalog sync, this is for content
 * that should reach already-connected peers immediately (e.g. an
 * emergency bulletin or a new chat message) instead of waiting for either.
 */
interface ContentAnnouncePayload {
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

interface IdentityRequestPayload {
  /** Node ids the sender already has a directory entry for — mirrors SyncRequestPayload's shape for content. */
  knownNodeIds: string[];
}

interface IdentityResponsePayload {
  announcements: IdentityAnnouncement[];
}

/**
 * A PRIVATE_MESSAGE carries the sender's own self-signed `IdentityAnnouncement`
 * alongside the ciphertext. Identity sync (like catalog sync) only exchanges
 * entries point-to-point at connection time and is never retroactively
 * re-announced to already-connected peers — so a destination reached only
 * via a relay that met the sender *after* the destination's own sync round
 * would otherwise never learn the sender's encryption key and could never
 * decrypt. Piggybacking a self-verifiable announcement removes that
 * dependency on sync ordering entirely: the destination can always decrypt
 * as long as the announcement's signature checks out.
 */
interface PrivateMessagePayload extends EncryptedPayload {
  senderAnnouncement: IdentityAnnouncement;
}

/**
 * A PRIVATE_MESSAGE payload's `text` field, if it has one shaped as a plain
 * chat message — used by `sendPrivateMessage()`/`handlePrivateMessage()` to
 * decide what's worth recording into `messageHistory` (never assumes
 * `payload` is trusted or well-formed; other private-message payloads
 * simply aren't chat messages). A `text` longer than
 * `MAX_MESSAGE_TEXT_LENGTH` is treated the same as a missing one — this is
 * the one place both the send and the *receive* path funnel through, so it
 * has to reject an oversized message on its own: a connected peer can send
 * an arbitrarily large `PRIVATE_MESSAGE` directly (spec §57, no HTTP layer
 * or its own request-body limit is involved on that path at all), unlike
 * `POST /api/messages`'s own length check, which only ever sees messages
 * *this* node originates.
 */
function extractChatText(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && typeof (payload as { text?: unknown }).text === "string") {
    const text = (payload as { text: string }).text;
    return text.length <= MAX_MESSAGE_TEXT_LENGTH ? text : undefined;
  }
  return undefined;
}

/**
 * Distance-vector route advertisement (spec §22), exchanged directly
 * between neighbors like IDENTITY_REQUEST/RESPONSE — never flooded, since
 * it only ever concerns the two nodes on that link. `cost: null` withdraws
 * a destination (its route via the sender no longer exists), matching the
 * shape of a normal advertisement so the same handler processes both.
 */
interface RouteAnnouncePayload {
  routes: Array<{ destination: string; cost: number | null }>;
}

/** Proactive broadcast of a locally-offered service (spec §35) — flooded like CONTENT_QUERY, delivered to and re-forwarded by every relay along the way, so the whole mesh eventually learns of it without needing to ask. */
interface ServiceAnnouncePayload {
  announcement: ServiceAnnouncement;
}

/** "Who offers serviceId?" — broadcast fallback for a service this node hasn't already learned of via SERVICE_ANNOUNCE (spec §35), mirrors CONTENT_QUERY. */
interface ServiceQueryPayload {
  serviceId: string;
}

/** Actual invocation ("CALL service://ai", spec §37) of a specific known provider's service — unicast, unlike the two broadcast discovery packets above. */
interface ServiceRequestPayload {
  serviceId: string;
  payload: unknown;
}

/**
 * Serves two distinct replies with one packet type, matching spec §49's
 * minimal 4-type service protocol: a reply to SERVICE_QUERY carries
 * `queryId` + `announcement` (mirrors CONTENT_FOUND); a reply to
 * SERVICE_REQUEST carries `requestId` + exactly one of `result`/`error`
 * (mirrors CONTENT_COMPLETE, but without chunking — a service call/result
 * is assumed to fit in one packet, unlike arbitrary-size content).
 */
interface ServiceResponsePayload {
  serviceId: string;
  queryId?: string;
  announcement?: ServiceAnnouncement;
  requestId?: string;
  result?: unknown;
  error?: string;
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
  readonly contentStore: ContentStore;
  /** Content known to exist elsewhere in the mesh via catalog sync (spec §33-34, milestone 13) but not fetched locally. */
  readonly remoteCatalog: RemoteCatalog;
  /** Per-node-id trust state (spec §54): SEEN/VERIFIED are earned automatically, TRUSTED/ADMIN are operator-assigned. */
  readonly trust: TrustManager;
  /** Known node id -> encryption key bindings (spec §52), propagated peer-to-peer like remoteCatalog. Deliberately never holds this node's own entry — see `ownAnnouncement`. */
  readonly peerDirectory: PeerDirectory;
  /** This node's X25519 key pair, used only for end-to-end encrypted private messages. */
  readonly encryptionIdentity: EncryptionIdentity;
  /**
   * This node's own self-signed identity announcement. Kept as a dedicated
   * field rather than the first entry ever inserted into `peerDirectory`
   * (as it briefly was) — that map is bounded and FIFO-evicting, and being
   * first in meant it was always the *first* thing evicted once the
   * directory filled up, silently breaking both `sendPrivateMessage()`
   * (piggybacks this) and `handleIdentityRequest()` (advertises it to new
   * peers). Special-cased at the two call sites that need it instead,
   * mirroring how `routingTable` never stores a route to this node itself.
   */
  private readonly ownAnnouncement: IdentityAnnouncement;
  /** Best known {nextHop, cost} per destination (spec §22), learned via ROUTE_ANNOUNCE. Unicast sends prefer a known route; flooding remains the fallback/bootstrap and is still used for broadcasts. */
  readonly routingTable: RoutingTable;
  /** Services known to exist elsewhere in the mesh (spec §35), via SERVICE_ANNOUNCE or a SERVICE_QUERY reply — analogous to remoteCatalog for content. */
  readonly services: ServiceDirectory;
  /** Local-only history of 1:1 private chat messages sent/received via `sendPrivateMessage()` (spec §56 "private messages") — never signed or propagated, purely for a thin HTTP client (`web-ui.ts`'s `/api/messages`) to poll. */
  readonly messageHistory: MessageHistory;

  private readonly defaultTtl: number;
  private readonly contentRequestTimeoutMs: number;
  private readonly contentProviderTimeoutMs: number;
  private readonly minTrustToRelay?: TrustLevel;
  private readonly seenCache = new SeenCache();
  private readonly requesterAssembler: ChunkAssembler;
  private readonly relayAssembler: ChunkAssembler;
  private readonly transports: Transport[] = [];
  private readonly peerTransport = new Map<string, Transport>();
  private readonly pendingContentRequests = new Map<string, PendingContentEntry>();
  private readonly pendingDeliveries: PendingDeliveryQueue;
  private readonly rateLimiter: RateLimiter;
  private readonly relayPolicy: RelayPolicy;
  /** Services this node itself offers (spec §35), registered via `registerService()` — never network-fed, so unlike `services` this needs no bound. */
  private readonly localServices = new Map<string, { announcement: ServiceAnnouncement; handler: ServiceHandler }>();
  /** In-flight `callService()` invocations awaiting their SERVICE_RESPONSE, keyed by the SERVICE_REQUEST packet's own id. */
  private readonly pendingServiceCalls = new Map<
    string,
    { providerId: string; resolve: (result: unknown) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }
  >();
  /** In-flight `callService()` invocations currently awaiting a *local* handler (`withServiceTimeout()`) — tracked separately from `pendingServiceCalls` (which only ever holds remote, network-bound calls) so `stop()` can reject these too instead of leaving them alive past shutdown, found by review. */
  private readonly pendingLocalServiceCalls = new Set<{ reject: (err: Error) => void }>();
  private started = false;

  constructor(options: NomadNodeOptions = {}) {
    super();
    this.identity = options.identity ?? Identity.generate();
    this.displayName = options.displayName ?? `NODE-${this.identity.nodeId.slice(0, 8)}`;
    this.defaultTtl = options.defaultTtl ?? 8;
    this.contentRequestTimeoutMs = options.contentRequestTimeoutMs ?? 3000;
    this.contentProviderTimeoutMs = options.contentProviderTimeoutMs ?? 1200;
    this.minTrustToRelay = options.minTrustToRelay;
    this.pendingDeliveries = new PendingDeliveryQueue({
      ttlMs: options.storeAndForwardTtlMs,
      maxSize: options.maxPendingDeliveries,
    });
    this.trust = new TrustManager({ maxSize: options.maxTrustEntries });
    // Same trust-weighted eviction as remoteCatalog/peerDirectory/routingTable/services below, with
    // one addition: this node's own published content must outrank anything network-sourced, since
    // this node's own id is never recorded in its own trust table (see OWN_CONTENT_TRUST_RANK).
    this.contentStore = new ContentStore({
      maxSize: options.maxContentStoreEntries,
      trustRank: (publisherId) => (publisherId === this.nodeId ? OWN_CONTENT_TRUST_RANK : trustRank(this.trust.get(publisherId))),
    });
    // A full catalog/directory evicts the least-trusted entry first, not just the oldest — the
    // same defense TrustManager already applies to itself (spec §57, docs/security.md).
    this.remoteCatalog = new RemoteCatalog({
      maxSize: options.maxRemoteCatalogEntries,
      trustRank: (publisherId) => trustRank(this.trust.get(publisherId)),
    });
    this.rateLimiter = new RateLimiter({
      maxPacketsPerWindow: options.maxPacketsPerWindow,
      windowMs: options.rateLimitWindowMs,
    });
    this.relayPolicy = new RelayPolicy(options.relayPolicy);
    this.encryptionIdentity = options.encryptionIdentity ?? EncryptionIdentity.generate();
    this.peerDirectory = new PeerDirectory({
      maxSize: options.maxPeerDirectoryEntries,
      trustRank: (nodeId) => trustRank(this.trust.get(nodeId)),
    });
    this.ownAnnouncement = signIdentityAnnouncement(this.identity, this.encryptionIdentity);
    // Same trust-aware eviction as remoteCatalog/peerDirectory above — a route's only claim to
    // trust is the trust level of the peer that announced it (routes carry no signature of their
    // own, unlike content/identity/service claims), so eviction must be weighted by that instead
    // of falling back to plain FIFO.
    this.routingTable = new RoutingTable({
      maxSize: options.maxRoutingTableEntries,
      maxCost: options.maxRouteCost,
      trustRank: (nextHop) => trustRank(this.trust.get(nextHop)),
    });
    const assemblerOptions = { maxEntries: options.maxChunkAssemblyEntries, maxChunksPerEntry: options.maxChunksPerContent };
    this.requesterAssembler = new ChunkAssembler(assemblerOptions);
    this.relayAssembler = new ChunkAssembler(assemblerOptions);
    this.services = new ServiceDirectory({
      maxSize: options.maxServiceDirectoryEntries,
      trustRank: (providerId) => trustRank(this.trust.get(providerId)),
    });
    this.messageHistory = new MessageHistory({
      maxPeers: options.maxMessageHistoryPeers,
      maxMessagesPerPeer: options.maxMessagesPerPeer,
      trustRank: (peer) => trustRank(this.trust.get(peer)),
    });
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
      void this.startIdentitySync(peerId);
      const isNewDirectRoute = this.routingTable.offer(peerId, peerId, 1);
      void this.announceRoutes(peerId);
      // A brand-new direct neighbor is news to every *other* already-connected peer too — without this,
      // only peerId itself (via the full-table announceRoutes above) ever hears about it, and nobody else
      // discovers this link exists until some unrelated future update happens to carry it along.
      if (isNewDirectRoute) {
        for (const peer of this.peers.list()) {
          if (peer.id === peerId) continue;
          void this.announceRoutes(peer.id, [peerId]);
        }
      }
    });
    transport.onPeerDisconnected((peerId) => {
      this.peers.remove(peerId);
      this.peerTransport.delete(peerId);
      this.rateLimiter.reset(peerId);
      this.emit("peer:disconnected", peerId);
      const withdrawn = this.routingTable.removeRoutesVia(peerId);
      if (withdrawn.length > 0) this.broadcastWithdrawal(withdrawn, peerId);
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
    // Otherwise each in-flight callService() invocation (past the discovery stage) would keep its
    // promise, closures and setTimeout alive for up to its own full timeoutMs after the node — and
    // its transports — have already stopped, since no more SERVICE_RESPONSE can ever arrive to
    // settle it. Known gap this doesn't cover: a call still inside discoverService() (i.e. not yet
    // in pendingServiceCalls) has the same unaddressed leak shape as the pre-existing
    // waitForPeerKey()/pendingContentRequests waiters — out of scope here, see docs/security.md.
    for (const pending of this.pendingServiceCalls.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("node stopped while the service call was still in flight"));
    }
    this.pendingServiceCalls.clear();
    // Same reasoning as pendingServiceCalls just above, for a locally-served callService() instead
    // of a remote one — found missing by review. Each entry's own reject() (withServiceTimeout())
    // clears its underlying setTimeout too, so this also prevents the timer itself from outliving
    // stop() by up to the rest of timeoutMs.
    for (const pending of this.pendingLocalServiceCalls) {
      pending.reject(new Error("node stopped while the service call was still in flight"));
    }
    this.pendingLocalServiceCalls.clear();
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
   *
   * `options.ttlMs`, if given, sets the content's expiry (spec §24) —
   * signed alongside the rest of the metadata so no relay can tamper with
   * it later. Omitted means the content never expires. Note that an
   * extremely small `ttlMs` can in principle race `putVerified()`'s own
   * expiry check below (both read `Date.now()`, moments apart) — pick a
   * value that comfortably outlives a single synchronous call if the
   * content actually needs to be servable at all after publishing.
   *
   * `options.announce`, if true, additionally floods a `CONTENT_ANNOUNCE`
   * (metadata only, see `ContentAnnouncePayload`) so already-connected
   * peers learn of this content immediately instead of waiting for a pull
   * query or the next catalog sync — for content where that latency
   * matters (an emergency bulletin, a new chat message), not the default
   * for routine publishing. `options.priority` sets that announce's
   * priority (default `Priority.CONTENT`, unchanged from before this
   * option existed); ignored if `announce` is not set.
   */
  publishContent(name: string, mimeType: string, data: Buffer, options: { ttlMs?: number; announce?: boolean; priority?: Priority } = {}): ContentMetadata {
    const contentId = computeContentId(data);
    const size = data.length;
    const publisherId = this.nodeId;
    const expiresAt = options.ttlMs !== undefined ? Date.now() + options.ttlMs : undefined;
    const signature = this.identity
      .sign(contentSigningPayload({ contentId, name, mimeType, size, publisherId, expiresAt }))
      .toString("hex");
    const metadata: ContentMetadata = { contentId, name, mimeType, size, createdAt: Date.now(), publisherId, signature, expiresAt };
    if (!this.contentStore.putVerified(metadata, data)) {
      throw new Error("internal error: freshly signed content failed its own verification (bad signature, or ttlMs too small to survive publishing)");
    }
    if (options.announce) {
      const packet = this.originate<ContentAnnouncePayload>(
        MessageType.CONTENT_ANNOUNCE,
        { metadata },
        { priority: options.priority ?? Priority.CONTENT },
      );
      void this.floodExcept(packet);
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
   * Everything this node can currently tell a user about services (spec
   * §35, §59 "Services" count): those registered locally plus those known
   * to exist elsewhere via SERVICE_ANNOUNCE/SERVICE_QUERY (`services`).
   * Unlike `listKnownContent()`, a distinct provider of the same
   * `serviceId` is a distinct entry here (mirrors `ServiceDirectory`'s own
   * (serviceId, providerId) keying) — the same service offered by two
   * different nodes is genuinely two independent offerings, not a
   * duplicate to collapse.
   */
  listKnownServices(): ServiceAnnouncement[] {
    const merged = new Map<string, ServiceAnnouncement>();
    for (const announcement of this.services.list()) merged.set(`${announcement.serviceId} ${announcement.providerId}`, announcement);
    for (const { announcement } of this.localServices.values()) {
      merged.set(`${announcement.serviceId} ${announcement.providerId}`, announcement);
    }
    return Array.from(merged.values());
  }

  /** Whether this node is currently willing to relay traffic for others (spec §51/§58) — `relayPolicy` itself is private, so read-only surfaces like the web UI (spec §59) go through this instead of reaching in directly. Never reflects whether this node answers requests addressed to itself or serves its own content, only whether it forwards other peers' traffic (see `relayGateFor()`). */
  canRelayNow(): boolean {
    return this.relayPolicy.canRelayNow();
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
        entry = { contentId, queried: false, candidates: [], waiters: [] };
        this.pendingContentRequests.set(contentId, entry);
      }
      const activeEntry = entry;

      const waiter: ContentWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          activeEntry.waiters = activeEntry.waiters.filter((w) => w !== waiter);
          if (activeEntry.waiters.length === 0) {
            if (activeEntry.providerTimer) clearTimeout(activeEntry.providerTimer);
            this.pendingContentRequests.delete(contentId);
          }
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

  /**
   * Sends an end-to-end encrypted message (spec §52, §56 "private
   * messages"), as opposed to `sendData()` — which stays deliberately
   * plaintext, since most of what this codebase's own test suite uses it
   * for is exercising routing/relay mechanics, not privacy. A relay
   * forwards the ciphertext without being able to read it; only
   * `destination` can decrypt it. Throws if `destination`'s encryption key
   * isn't known yet — call `waitForPeerKey()` first if it might not be.
   *
   * If `payload` looks like a chat message (a plain `{ text: string }`, the
   * shape the mobile app's chat UI sends via `/api/messages`), it's also
   * recorded into `messageHistory` — `payload` is otherwise unconstrained
   * (this method has other callers/tests that pass arbitrary shapes), so
   * anything else is sent normally but simply isn't added to the chat log.
   */
  sendPrivateMessage(destination: string, payload: unknown): string {
    const peerKey = this.peerDirectory.getKey(destination);
    if (!peerKey) {
      throw new Error(`cannot send private message: encryption key for ${destination} is not yet known`);
    }
    const sharedKey = this.encryptionIdentity.sharedKeyWith(peerKey);
    const encryptedPayload = encryptForPeer(sharedKey, Buffer.from(JSON.stringify(payload)));
    const packet = this.originate<PrivateMessagePayload>(
      MessageType.PRIVATE_MESSAGE,
      { ...encryptedPayload, senderAnnouncement: this.ownAnnouncement },
      { destination, priority: Priority.MESSAGING },
    );
    void this.floodExcept(packet);
    const text = extractChatText(payload);
    if (text !== undefined) this.messageHistory.record(destination, "sent", text);
    return packet.id;
  }

  /** Resolves once `nodeId`'s encryption key is known (immediately, if already is), or rejects after `timeoutMs`. */
  waitForPeerKey(nodeId: string, options: { timeoutMs?: number } = {}): Promise<string> {
    const known = this.peerDirectory.getKey(nodeId);
    if (known) return Promise.resolve(known);

    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.contentRequestTimeoutMs;
      const timer = setTimeout(() => {
        this.off("identity:synced", handler);
        reject(new Error(`timed out waiting for ${nodeId}'s encryption key`));
      }, timeoutMs);
      const handler = (nodeIds: string[]): void => {
        if (!nodeIds.includes(nodeId)) return;
        clearTimeout(timer);
        this.off("identity:synced", handler);
        const key = this.peerDirectory.getKey(nodeId);
        if (key) resolve(key);
      };
      this.on("identity:synced", handler);
    });
  }

  /**
   * Registers a locally-provided service (spec §35, e.g. `service://translation`)
   * and floods a SERVICE_ANNOUNCE so the mesh learns of it proactively,
   * without waiting to be asked via SERVICE_QUERY. `handler` is invoked for
   * every SERVICE_REQUEST this node receives for `serviceId` — see
   * `ServiceHandler` (service.ts). Registering the same `serviceId` again
   * replaces both the handler and the announcement (re-signed with a fresh
   * `createdAt`, so it also supersedes the previous one in any peer's
   * `ServiceDirectory`).
   */
  registerService(
    serviceId: string,
    version: string,
    capabilities: string[],
    handler: ServiceHandler,
    options: { resourceRequirements?: string; availability?: boolean } = {},
  ): ServiceAnnouncement {
    const announcement = this.signOwnServiceAnnouncement(
      serviceId,
      version,
      capabilities,
      options.resourceRequirements,
      options.availability ?? true,
    );
    this.localServices.set(serviceId, { announcement, handler });
    void this.floodExcept(
      this.originate<ServiceAnnouncePayload>(MessageType.SERVICE_ANNOUNCE, { announcement }, { priority: Priority.SERVICE }),
    );
    return announcement;
  }

  /**
   * Updates the availability of an already-registered local service and
   * re-announces it (spec §35 "availability") — e.g. a node temporarily
   * pulling its AI service out of rotation because it's overloaded, without
   * having to unregister and re-register the handler itself. Throws if
   * `serviceId` was never registered on this node.
   */
  setServiceAvailability(serviceId: string, availability: boolean): ServiceAnnouncement {
    const local = this.localServices.get(serviceId);
    if (!local) throw new Error(`service ${serviceId} is not registered on this node`);
    const { version, capabilities, resourceRequirements } = local.announcement;
    const announcement = this.signOwnServiceAnnouncement(serviceId, version, capabilities, resourceRequirements, availability);
    local.announcement = announcement;
    void this.floodExcept(
      this.originate<ServiceAnnouncePayload>(MessageType.SERVICE_ANNOUNCE, { announcement }, { priority: Priority.SERVICE }),
    );
    return announcement;
  }

  private signOwnServiceAnnouncement(
    serviceId: string,
    version: string,
    capabilities: string[],
    resourceRequirements: string | undefined,
    availability: boolean,
  ): ServiceAnnouncement {
    const providerId = this.nodeId;
    const createdAt = Date.now();
    const signature = this.identity
      .sign(serviceSigningPayload({ serviceId, version, capabilities, providerId, resourceRequirements, availability, createdAt }))
      .toString("hex");
    return { serviceId, version, capabilities, providerId, resourceRequirements, availability, createdAt, signature };
  }

  /**
   * Resolves once a provider for `serviceId` is known — immediately from a
   * local registration or an already-recorded announcement, otherwise after
   * flooding a SERVICE_QUERY and waiting for the first SERVICE_RESPONSE
   * (spec §35). Rejects after `timeoutMs` if nobody answers.
   */
  discoverService(serviceId: string, options: { timeoutMs?: number } = {}): Promise<ServiceAnnouncement> {
    // Only a genuinely available local registration short-circuits discovery — an unavailable one
    // (setServiceAvailability(id, false)) must fall through to the same providersFor()/query path
    // a remote caller would take, or a call could get "discovered" onto a provider that will just
    // turn around and refuse it, instead of finding another one that's actually available.
    const local = this.localServices.get(serviceId);
    if (local && local.announcement.availability) return Promise.resolve(local.announcement);
    const known = this.services.providersFor(serviceId)[0];
    if (known) return Promise.resolve(known);

    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.contentRequestTimeoutMs;
      const timer = setTimeout(() => {
        this.off("service:announced", handler);
        reject(new Error(`no provider found for service ${serviceId} within the mesh`));
      }, timeoutMs);
      const handler = (announcedServiceId: string): void => {
        if (announcedServiceId !== serviceId) return;
        const provider = this.services.providersFor(serviceId)[0];
        if (!provider) return; // an announcement fired for this serviceId, but not one that's actually available yet
        clearTimeout(timer);
        this.off("service:announced", handler);
        resolve(provider);
      };
      this.on("service:announced", handler);

      const query = this.originate<ServiceQueryPayload>(MessageType.SERVICE_QUERY, { serviceId }, { priority: Priority.SERVICE });
      void this.floodExcept(query);
    });
  }

  /**
   * Invokes `serviceId` (spec §36-37, e.g. `CALL service://ai`) — served
   * in-process with no network round trip at all if this node registered
   * the service itself, otherwise discovers a provider (as `discoverService()`
   * would) and sends it a SERVICE_REQUEST, resolving with the provider's
   * result or rejecting with its declared error / a timeout.
   */
  async callService(serviceId: string, payload: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? this.contentRequestTimeoutMs;
    const local = this.localServices.get(serviceId);
    if (local && local.announcement.availability) {
      return this.withServiceTimeout(Promise.resolve(local.handler(payload, this.nodeId)), serviceId, timeoutMs);
    }
    const provider = await this.discoverService(serviceId, { timeoutMs });
    return this.invokeService(provider.providerId, serviceId, payload, timeoutMs);
  }

  /**
   * Bounds a locally-served `callService()` call to `timeoutMs`, the same
   * guarantee the remote-invocation path (`invokeService()`) already has —
   * found missing by review: a locally-registered handler that hangs (a
   * live HTTP proxy like `AiGateway`'s, stalled on a wedged backend) used
   * to leave the caller's promise pending forever, silently ignoring
   * `options.timeoutMs`, purely because the provider happened to be local
   * rather than remote.
   *
   * Deliberately does NOT delegate to the shared `raceTimeout()`
   * (`async-timeout.ts`): that helper keeps its timer internal, so nothing
   * outside it can `clearTimeout()` early, and `stop()` needs exactly that.
   * Managing the timer here directly mirrors the pattern `pendingServiceCalls`/
   * `stop()` already use for the remote path (explicit `clearTimeout()`
   * on every exit, not just a race that settles promptly but leaves the
   * loser's timer ticking). This call is registered in
   * `pendingLocalServiceCalls` for its duration so `stop()` can reject (and
   * this then clears its own timer) immediately instead of leaving it to
   * time out on its own well after the node has already shut down — the
   * same guarantee `pendingServiceCalls`/`invokeService()` already give the
   * remote-invocation path. Rejecting doesn't cancel the underlying handler
   * call itself (there's no general cancellation protocol for an arbitrary
   * `ServiceHandler`) — just stops making the caller wait for it.
   */
  private withServiceTimeout<T>(result: Promise<T>, serviceId: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry = {
        reject: (err: Error) => {
          clearTimeout(timer);
          this.pendingLocalServiceCalls.delete(entry);
          reject(err);
        },
      };
      const timer = setTimeout(() => entry.reject(new Error(`local service call to ${serviceId} timed out`)), timeoutMs);
      this.pendingLocalServiceCalls.add(entry);
      result.then(
        (value) => {
          clearTimeout(timer);
          this.pendingLocalServiceCalls.delete(entry);
          resolve(value);
        },
        (err: unknown) => entry.reject(err as Error),
      );
    });
  }

  private invokeService(providerId: string, serviceId: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = this.originate<ServiceRequestPayload>(
        MessageType.SERVICE_REQUEST,
        { serviceId, payload },
        { destination: providerId, priority: Priority.SERVICE },
      );
      const timer = setTimeout(() => {
        this.pendingServiceCalls.delete(request.id);
        reject(new Error(`service call to ${providerId} for ${serviceId} timed out`));
      }, timeoutMs);
      this.pendingServiceCalls.set(request.id, { providerId, resolve, reject, timeout: timer });
      void this.floodExcept(request);
    });
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
    const isUnicastElsewhere = packet.destination !== undefined && packet.destination !== this.nodeId;

    if (isUnicastElsewhere) {
      const route = this.routingTable.bestRoute(packet.destination!);
      if (route && route.nextHop !== exceptPeerId) {
        if (await this.sendToPeer(route.nextHop, packet)) return true;
        // The routed next hop just failed (e.g. dropped mid-send) — fall through to flooding
        // rather than queuing immediately, since other peers may still be able to relay it.
      }
    }

    const targets = this.peers.list().filter((p) => p.id !== exceptPeerId);
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

  /**
   * Announces this node's known identity directory (node id -> encryption
   * key bindings, spec §52) to a newly connected peer — same pattern as
   * `startCatalogSync`, and for the same reason: propagates transitively
   * across the mesh as nodes connect in sequence, without ever needing a
   * network-wide flood for what's fundamentally point-to-point information.
   */
  private async startIdentitySync(peerId: string): Promise<void> {
    const knownNodeIds = [this.nodeId, ...this.peerDirectory.list().map((a) => a.nodeId)];
    const request = this.originate<IdentityRequestPayload>(
      MessageType.IDENTITY_REQUEST,
      { knownNodeIds },
      { destination: peerId, priority: Priority.CONTROL },
    );
    await this.sendToPeer(peerId, request);
  }

  /**
   * Sends `peerId` this node's full distance vector (spec §22), split-horizon
   * filtered — routes that go via `peerId` itself are omitted, since
   * advertising a peer's own best path back to it can never help and is how
   * naive distance-vector protocols form 2-node routing loops. This always
   * includes an implicit route to this node itself at cost 0, so `peerId`
   * learns how to reach us — direct, sent like every other sync exchange,
   * never flooded.
   */
  private async announceRoutes(peerId: string, destinations?: string[]): Promise<void> {
    const filter = destinations === undefined ? undefined : new Set(destinations);
    const known = this.routingTable
      .list()
      .filter((route) => route.nextHop !== peerId && route.destination !== peerId)
      .filter((route) => filter === undefined || filter.has(route.destination))
      .map((route) => ({ destination: route.destination, cost: route.cost }));
    const routes = filter === undefined || filter.has(this.nodeId)
      ? [{ destination: this.nodeId, cost: 0 }, ...known]
      : known;
    if (routes.length === 0) return;

    const announcement = this.originate<RouteAnnouncePayload>(
      MessageType.ROUTE_ANNOUNCE,
      { routes },
      { destination: peerId, priority: Priority.CONTROL },
    );
    await this.sendToPeer(peerId, announcement);
  }

  /** Tells every remaining peer (except the one that just disconnected) that `destinations` are no longer reachable via us. */
  private broadcastWithdrawal(destinations: string[], exceptPeerId: string): void {
    for (const peer of this.peers.list()) {
      if (peer.id === exceptPeerId) continue;
      const routes = destinations.map((destination) => ({ destination, cost: null }));
      const announcement = this.originate<RouteAnnouncePayload>(
        MessageType.ROUTE_ANNOUNCE,
        { routes },
        { destination: peer.id, priority: Priority.CONTROL },
      );
      void this.sendToPeer(peer.id, announcement);
    }
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

      case MessageType.PEER_LIST: {
        // decodePacket() never validates payload shape (only the envelope) — a raw PEER_LIST with a
        // non-array or null payload, or a non-object entry inside it, used to crash the process here
        // (`for...of` on a non-iterable, or `entry.id` on `null`); every field is checked before use.
        const list = Array.isArray(packet.payload)
          ? (packet.payload as unknown[]).filter(
              (entry): entry is { id: string; address?: PeerAddress } =>
                typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string",
            )
          : [];
        for (const entry of list) {
          if (entry.id !== this.nodeId) this.peers.upsert(entry.id, entry.address);
        }
        this.emit("peer-list", list);
        break;
      }

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

      case MessageType.CONTENT_NOT_FOUND:
        this.handleContentNotFound(packet as Packet<ContentNotFoundPayload>);
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

      case MessageType.CONTENT_ANNOUNCE:
        this.handleContentAnnounce(packet as Packet<ContentAnnouncePayload>);
        break;

      case MessageType.SYNC_REQUEST:
        this.handleSyncRequest(packet as Packet<SyncRequestPayload>, fromPeerId);
        break;

      case MessageType.SYNC_RESPONSE:
        this.handleSyncResponse(packet as Packet<SyncResponsePayload>);
        break;

      case MessageType.IDENTITY_REQUEST:
        this.handleIdentityRequest(packet as Packet<IdentityRequestPayload>, fromPeerId);
        break;

      case MessageType.IDENTITY_RESPONSE:
        this.handleIdentityResponse(packet as Packet<IdentityResponsePayload>);
        break;

      case MessageType.PRIVATE_MESSAGE:
        this.handlePrivateMessage(packet as Packet<PrivateMessagePayload>);
        break;

      case MessageType.ROUTE_ANNOUNCE:
        this.handleRouteAnnounce(packet as Packet<RouteAnnouncePayload>, fromPeerId);
        break;

      case MessageType.SERVICE_ANNOUNCE:
        this.handleServiceAnnounce(packet as Packet<ServiceAnnouncePayload>);
        break;

      case MessageType.SERVICE_QUERY:
        this.handleServiceQuery(packet as Packet<ServiceQueryPayload>);
        break;

      case MessageType.SERVICE_REQUEST:
        this.handleServiceRequest(packet as Packet<ServiceRequestPayload>);
        break;

      case MessageType.SERVICE_RESPONSE:
        this.handleServiceResponse(packet as Packet<ServiceResponsePayload>);
        break;

      default:
        break;
    }
  }

  private handleContentQuery(packet: Packet<ContentQueryPayload>): void {
    // decodePacket() never validates payload shape — a raw CONTENT_QUERY with no `payload` (or a
    // non-string contentId) used to crash the process here; every CONTENT_* handler below follows
    // the same `packet.payload?.field` + typeof guard already used by SYNC_*/IDENTITY_*/SERVICE_*.
    const contentId = packet.payload?.contentId;
    if (typeof contentId !== "string") return;
    const stored = this.contentStore.get(contentId);
    if (!stored) return; // We don't have it; decideForward already keeps the flood going.
    const response = this.originate<ContentFoundPayload>(
      MessageType.CONTENT_FOUND,
      { queryId: packet.id, contentId, metadata: stored.metadata },
      { destination: packet.source, priority: Priority.CONTENT },
    );
    void this.floodExcept(response);
  }

  private handleContentFound(packet: Packet<ContentFoundPayload>): void {
    const contentId = packet.payload?.contentId;
    if (typeof contentId !== "string") return;
    const entry = this.pendingContentRequests.get(contentId);
    if (!entry) return; // not waiting on this
    if (entry.activeProvider === packet.source) return; // already trying (or already gave up on) exactly this one
    if (entry.activeProvider && entry.providerTimer) {
      // Actively trying someone else with a live retry timer running — remember this one as a
      // fallback candidate rather than requesting from it immediately.
      if (!entry.candidates.includes(packet.source) && entry.candidates.length < MAX_CONTENT_CANDIDATES) {
        entry.candidates.push(packet.source);
      }
      return;
    }
    // Either nobody's been tried yet, or every known candidate was already exhausted and the retry
    // timer isn't running any more — this reply is immediately usable either way.
    this.requestFromProvider(entry, packet.source);
  }

  /**
   * The provider we're actively waiting on just told us explicitly it no
   * longer has this content (CONTENT_NOT_FOUND) — fail over to the next
   * candidate immediately rather than waiting for `providerTimer` to expire
   * on a request that will never get a CONTENT_CHUNK/COMPLETE. A reply from
   * anyone other than the currently-active provider is ignored: it can only
   * be stale (about a provider we've already moved on from) or forged, and
   * either way must never interrupt whichever attempt is genuinely in
   * flight — same trust boundary as handleContentChunk/handleContentComplete.
   */
  private handleContentNotFound(packet: Packet<ContentNotFoundPayload>): void {
    const contentId = packet.payload?.contentId;
    if (typeof contentId !== "string") return;
    const entry = this.pendingContentRequests.get(contentId);
    if (!entry) return; // not waiting on this
    if (packet.source !== entry.activeProvider) return;
    if (entry.providerTimer) clearTimeout(entry.providerTimer);
    this.retryNextProvider(entry.contentId);
  }

  /** Sends CONTENT_REQUEST to `providerId` and arms the retry timer that falls through to the next known candidate if it stays silent. */
  private requestFromProvider(entry: PendingContentEntry, providerId: string): void {
    entry.activeProvider = providerId;
    const request = this.originate<ContentQueryPayload>(
      MessageType.CONTENT_REQUEST,
      { contentId: entry.contentId },
      { destination: providerId, priority: Priority.CONTENT },
    );
    void this.floodExcept(request);

    if (entry.providerTimer) clearTimeout(entry.providerTimer);
    entry.providerTimer = setTimeout(() => this.retryNextProvider(entry.contentId), this.contentProviderTimeoutMs);
  }

  /**
   * Fires when the active provider has been silent for `contentProviderTimeoutMs` without
   * completing the transfer. A peer that replied CONTENT_FOUND a moment ago isn't guaranteed to
   * still be reachable in an unreliable mesh (spec §90-92) — rather than burning the caller's
   * whole `getContent()` timeout on one unresponsive provider, move on to the next candidate that
   * already offered this content. Discards whatever the abandoned provider sent so far: mixing its
   * (possibly wrong/incomplete) chunks with the next attempt's would corrupt the reassembly.
   */
  private retryNextProvider(contentId: string): void {
    const entry = this.pendingContentRequests.get(contentId);
    if (!entry) return;
    entry.providerTimer = undefined; // this firing already consumed it — a late CONTENT_FOUND arriving now must be tried immediately, not just queued
    if (entry.candidates.length === 0) return; // nothing left to try right now — the outer per-waiter timeout is the backstop
    this.requesterAssembler.discard(contentId);
    const next = entry.candidates.shift()!;
    this.requestFromProvider(entry, next);
  }

  private handleContentRequest(packet: Packet<ContentQueryPayload>): void {
    const contentId = packet.payload?.contentId;
    if (typeof contentId !== "string") return;
    const stored = this.contentStore.get(contentId);
    if (!stored) {
      // We advertised this a moment ago via CONTENT_FOUND (or the requester assumed we still had
      // it) but don't any more — evicted, or expired (spec §24) in the meantime. Say so explicitly
      // rather than staying silent, so the requester can move on to its next candidate right away
      // instead of waiting out contentProviderTimeoutMs on a request we'll never answer.
      const notFound = this.originate<ContentNotFoundPayload>(
        MessageType.CONTENT_NOT_FOUND,
        { contentId },
        { destination: packet.source, priority: Priority.CONTENT },
      );
      void this.floodExcept(notFound);
      return;
    }
    const chunks = this.contentStore.chunksFor(contentId);
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const chunkPacket = this.originate<ContentChunkPayload>(
        MessageType.CONTENT_CHUNK,
        { contentId, chunkIndex, totalChunks: chunks.length, data: chunk.toString("base64") },
        { destination: packet.source, priority: Priority.CONTENT },
      );
      void this.floodExcept(chunkPacket);
    }
    const completePacket = this.originate<ContentCompletePayload>(
      MessageType.CONTENT_COMPLETE,
      { contentId, metadata: stored.metadata },
      { destination: packet.source, priority: Priority.CONTENT },
    );
    void this.floodExcept(completePacket);
  }

  private handleContentChunk(packet: Packet<ContentChunkPayload>): void {
    const contentId = packet.payload?.contentId;
    const data = packet.payload?.data;
    // contentId/data must be strings before anything below touches them (Buffer.from(data, ...)
    // throws on a non-string); chunkIndex/totalChunks are passed through as-is — addChunk()
    // (content.ts) already validates them defensively regardless of type.
    if (typeof contentId !== "string" || typeof data !== "string") return;
    const { chunkIndex, totalChunks } = packet.payload;
    const entry = this.pendingContentRequests.get(contentId);
    // A stale chunk from a provider we've since abandoned (retryNextProvider already discarded
    // its partial data) — accepting it now would just corrupt the current attempt again.
    if (entry && packet.source !== entry.activeProvider) return;
    if (entry) {
      // Real progress from the active provider — it isn't silent, just possibly slow. Give it a
      // fresh window instead of abandoning an in-progress transfer mid-flight (contentProviderTimeoutMs
      // measures time since the *last* chunk, not a hard deadline on the whole transfer).
      if (entry.providerTimer) clearTimeout(entry.providerTimer);
      entry.providerTimer = setTimeout(() => this.retryNextProvider(contentId), this.contentProviderTimeoutMs);
    }
    this.requesterAssembler.addChunk(contentId, chunkIndex, totalChunks, Buffer.from(data, "base64"));
  }

  private handleContentComplete(packet: Packet<ContentCompletePayload>): void {
    const contentId = packet.payload?.contentId;
    const metadata = packet.payload?.metadata;
    // metadata is handed to tryComplete()/putVerified() below, both of which dereference its
    // fields directly (they trust decodePacket() already validated the shape, which it never
    // does) — must be at least a non-null object here, or those throw on an undefined/primitive
    // metadata before ever reaching their own signature check.
    if (typeof contentId !== "string" || !metadata || typeof metadata !== "object") return;
    const entry = this.pendingContentRequests.get(contentId);
    // Same reasoning as handleContentChunk: a late COMPLETE from an abandoned provider must never
    // be allowed to reject a retry that's currently in progress with a different, active one.
    if (entry && packet.source !== entry.activeProvider) return;
    if (entry?.providerTimer) clearTimeout(entry.providerTimer);
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
            ? `content signature invalid, untrusted publisher, or already expired: ${contentId}`
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

  /**
   * Passive/opportunistic caching (spec §27, §91-92): a relay reassembles content it forwards and
   * caches it too. Reached for a packet addressed to some *other* node — never validated by
   * handleContentChunk/handleContentComplete, since those only run when this node is itself the
   * destination — so the same defensive payload guards apply here independently.
   */
  private observeRelayedContent(packet: Packet): void {
    if (packet.type === MessageType.CONTENT_CHUNK) {
      // Cast, not Partial<...> — the fields below are read defensively regardless of what the
      // static type claims (decodePacket() never validated any of this), and addChunk() itself
      // re-validates chunkIndex/totalChunks at runtime no matter their declared type.
      const payload = packet.payload as ContentChunkPayload | undefined;
      if (!payload || typeof payload.contentId !== "string" || typeof payload.data !== "string") return;
      const { contentId, data } = payload;
      if (this.contentStore.has(contentId)) return;
      this.relayAssembler.addChunk(contentId, payload.chunkIndex, payload.totalChunks, Buffer.from(data, "base64"));
    } else if (packet.type === MessageType.CONTENT_COMPLETE) {
      const payload = packet.payload as ContentCompletePayload | undefined;
      const contentId = payload?.contentId;
      const metadata = payload?.metadata;
      if (typeof contentId !== "string" || !metadata || typeof metadata !== "object") return;
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
    const known = new Set(Array.isArray(packet.payload?.knownContentIds) ? packet.payload.knownContentIds : []);
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
   * Shared trust-boundary check for one piece of untrusted catalog metadata
   * (spec §55) — a SYNC_RESPONSE entry and a CONTENT_ANNOUNCE are the same
   * kind of claim ("this content exists, signed by X") arriving by two
   * different paths (a peer's catalog reply vs. an unsolicited broadcast),
   * so both funnel through this one check rather than keeping two
   * near-identical copies that could silently drift apart. Records into
   * `remoteCatalog` and marks the publisher verified as a side effect;
   * returns the metadata if accepted, `undefined` otherwise (never throws
   * — `metadata` is untrusted network input, validated defensively).
   */
  private acceptCatalogEntry(metadata: ContentMetadata | null | undefined): ContentMetadata | undefined {
    if (!metadata || typeof metadata.contentId !== "string") return undefined; // malformed — never trust it
    if (this.contentStore.has(metadata.contentId)) return undefined; // we already hold the actual bytes
    if (!verifyContentSignature(metadata)) return undefined; // unsigned or forged claim — never trust it
    if (metadata.expiresAt !== undefined && metadata.expiresAt <= Date.now()) return undefined; // dead on arrival (spec §24) — not worth recording
    this.remoteCatalog.record(metadata);
    if (metadata.publisherId) this.trust.markVerified(metadata.publisherId);
    return metadata;
  }

  /**
   * Records a proactively-announced piece of content (spec §25, push
   * counterpart to CONTENT_QUERY) — existence/metadata only, the actual
   * bytes still have to be fetched through the normal CONTENT_QUERY ->
   * CONTENT_COMPLETE cycle if/when wanted.
   */
  private handleContentAnnounce(packet: Packet<ContentAnnouncePayload>): void {
    const accepted = this.acceptCatalogEntry(packet.payload?.metadata);
    if (accepted) this.emit("content:announced", accepted);
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
    const entries = Array.isArray(packet.payload?.entries) ? packet.payload.entries : [];
    const accepted: ContentMetadata[] = [];
    for (const metadata of entries) {
      const result = this.acceptCatalogEntry(metadata);
      if (result) accepted.push(result);
    }
    if (accepted.length > 0) this.emit("catalog-sync", accepted);
  }

  /** Replies with directory entries the requester doesn't already know about (spec §52) — mirrors handleSyncRequest for content. */
  private handleIdentityRequest(packet: Packet<IdentityRequestPayload>, fromPeerId: string): void {
    const known = new Set(Array.isArray(packet.payload?.knownNodeIds) ? packet.payload.knownNodeIds : []);
    const newAnnouncements = this.peerDirectory.list().filter((a) => !known.has(a.nodeId));
    if (!known.has(this.nodeId)) newAnnouncements.push(this.ownAnnouncement);
    if (newAnnouncements.length === 0) return;

    const response = this.originate<IdentityResponsePayload>(
      MessageType.IDENTITY_RESPONSE,
      { announcements: newAnnouncements },
      { destination: packet.source, priority: Priority.CONTROL },
    );
    void this.sendToPeer(fromPeerId, response);
  }

  /**
   * Records what a peer's identity directory reply announced. Each entry
   * is a self-signed `IdentityAnnouncement` (spec §52, §55's pattern
   * applied to identity) — a relay cannot forge "node X's encryption key
   * is Y" for a node id it doesn't control the Ed25519 private key for, so
   * this is safe to trust and re-share exactly like catalog sync.
   */
  private handleIdentityResponse(packet: Packet<IdentityResponsePayload>): void {
    const announcements = Array.isArray(packet.payload?.announcements) ? packet.payload.announcements : [];
    const accepted: string[] = [];
    for (const announcement of announcements) {
      if (!announcement || announcement.nodeId === this.nodeId) continue; // malformed, or a claim about ourselves — never record either
      if (!verifyIdentityAnnouncement(announcement)) continue; // unsigned or forged claim — never trust it
      if (this.peerDirectory.record(announcement)) {
        this.trust.markVerified(announcement.nodeId);
        accepted.push(announcement.nodeId);
      }
    }
    if (accepted.length > 0) this.emit("identity:synced", accepted);
  }

  /**
   * Applies a neighbor's distance-vector advertisement (spec §22):
   * `fromPeerId` is always exactly 1 hop away, so every entry it advertises
   * costs `entry.cost + 1` via `fromPeerId` from here. A route this node
   * adopts or withdraws as a result is re-advertised (split horizon
   * applied per recipient by `announceRoutes`/`broadcastWithdrawal`) so the
   * update propagates outward — the same triggered-update pattern
   * distance-vector protocols like RIP use, without waiting on a periodic
   * refresh this prototype doesn't run.
   */
  private handleRouteAnnounce(packet: Packet<RouteAnnouncePayload>, fromPeerId: string): void {
    const routes = (Array.isArray(packet.payload?.routes) ? packet.payload.routes : []).slice(0, MAX_ROUTES_PER_ANNOUNCE);
    const changed: string[] = [];
    const withdrawn: string[] = [];
    for (const entry of routes) {
      if (!entry || typeof entry.destination !== "string") continue; // malformed entry — never trust it
      if (entry.destination === this.nodeId) continue; // never need a route to ourselves
      if (entry.cost === null) {
        if (this.routingTable.withdraw(entry.destination, fromPeerId)) withdrawn.push(entry.destination);
        continue;
      }
      if (typeof entry.cost !== "number") continue; // malformed cost — never trust it
      if (this.routingTable.offer(entry.destination, fromPeerId, entry.cost + 1)) changed.push(entry.destination);
    }

    if (changed.length > 0) {
      this.emit("routing:updated", changed);
      for (const peer of this.peers.list()) {
        if (peer.id === fromPeerId) continue;
        void this.announceRoutes(peer.id, changed);
      }
    }
    if (withdrawn.length > 0) this.broadcastWithdrawal(withdrawn, fromPeerId);
  }

  /**
   * Decrypts a PRIVATE_MESSAGE addressed to us (spec §52, §56 "private
   * messages: end-to-end encrypted"). Requires already knowing the
   * sender's encryption key (via identity sync) — if we don't, or if
   * decryption/authentication fails (wrong key, tampered ciphertext), the
   * message is rejected rather than silently dropped, so a caller waiting
   * on it can tell the difference between "never arrived" and "arrived but
   * couldn't be trusted".
   */
  private handlePrivateMessage(packet: Packet<PrivateMessagePayload>): void {
    const senderAnnouncement = packet.payload?.senderAnnouncement;
    if (
      senderAnnouncement &&
      senderAnnouncement.nodeId === packet.source &&
      verifyIdentityAnnouncement(senderAnnouncement) &&
      this.peerDirectory.record(senderAnnouncement)
    ) {
      this.emit("identity:synced", [senderAnnouncement.nodeId]);
    }

    const senderKey = this.peerDirectory.getKey(packet.source);
    if (!senderKey) {
      this.emit("private-message:failed", packet.source, "sender's encryption key is not yet known");
      return;
    }
    try {
      const sharedKey = this.encryptionIdentity.sharedKeyWith(senderKey);
      const payload: unknown = JSON.parse(decryptFromPeer(sharedKey, packet.payload).toString("utf8"));
      const text = extractChatText(payload);
      if (text !== undefined) this.messageHistory.record(packet.source, "received", text);
      this.emit("private-message", { ...packet, payload });
    } catch (err) {
      this.emit("private-message:failed", packet.source, (err as Error).message);
    }
  }

  /** Records a (verified) SERVICE_ANNOUNCE broadcast — see `ServiceDirectory.record()` for why a later announcement for the same (serviceId, providerId) wins, unlike content's catalog. */
  private handleServiceAnnounce(packet: Packet<ServiceAnnouncePayload>): void {
    this.recordServiceAnnouncement(packet.payload?.announcement);
  }

  /** Shared by handleServiceAnnounce and handleServiceResponse's query-reply branch — both carry the same self-verifying announcement shape. */
  private recordServiceAnnouncement(announcement: ServiceAnnouncement | undefined): void {
    if (!announcement || typeof announcement.serviceId !== "string" || typeof announcement.providerId !== "string") return;
    // A valid signature only proves the claimed providerId produced this exact JSON, never that its
    // shape is sane — a peer that controls its own (trivially generated) keypair can self-sign a
    // `capabilities` of any type. Left unchecked, that reaches every consumer of services.list()/
    // listKnownServices(), including WebUiServer's /api/services -> the browser's `.map()` over it.
    if (!Array.isArray(announcement.capabilities)) return;
    if (!verifyServiceAnnouncement(announcement)) return; // unsigned or forged claim — never trust it
    this.services.record(announcement);
    this.trust.markVerified(announcement.providerId);
    this.emit("service:announced", announcement.serviceId);
  }

  /** Replies SERVICE_RESPONSE (with this node's own announcement) for every locally-registered, currently-available service matching `serviceId` (spec §35). */
  private handleServiceQuery(packet: Packet<ServiceQueryPayload>): void {
    const local = this.localServices.get(packet.payload?.serviceId);
    if (!local || !local.announcement.availability) return;
    const response = this.originate<ServiceResponsePayload>(
      MessageType.SERVICE_RESPONSE,
      { serviceId: local.announcement.serviceId, queryId: packet.id, announcement: local.announcement },
      { destination: packet.source, priority: Priority.SERVICE },
    );
    void this.floodExcept(response);
  }

  /**
   * Invokes the local handler for a SERVICE_REQUEST (spec §36-37) and
   * replies with its result — or with `error` if the service isn't
   * registered/available here, or if the handler itself throws/rejects.
   * Either way a reply is always sent, so `callService()` on the other end
   * never hangs waiting on a provider that simply couldn't serve it.
   */
  private handleServiceRequest(packet: Packet<ServiceRequestPayload>): void {
    // decodePacket() (packet.ts) validates the packet envelope but never its payload shape, so a
    // malformed SERVICE_REQUEST (e.g. missing `payload` entirely) reaches here with
    // packet.payload possibly undefined — every access below stays behind `?.`/a resolved local
    // `serviceId` so that can never throw and crash the process.
    const serviceId = packet.payload?.serviceId;
    const local = typeof serviceId === "string" ? this.localServices.get(serviceId) : undefined;
    const respond = (result: unknown, error: string | undefined): void => {
      const response = this.originate<ServiceResponsePayload>(
        MessageType.SERVICE_RESPONSE,
        { serviceId: serviceId ?? "", requestId: packet.id, result, error },
        { destination: packet.source, priority: Priority.SERVICE },
      );
      void this.floodExcept(response);
    };
    if (!local || !local.announcement.availability) {
      respond(undefined, `service ${serviceId} is not available on this node`);
      return;
    }
    Promise.resolve()
      .then(() => local.handler(packet.payload.payload, packet.source))
      .then((result) => respond(result, undefined))
      .catch((err) => respond(undefined, err instanceof Error ? err.message : "service handler failed"));
  }

  /**
   * Handles both roles SERVICE_RESPONSE can carry (spec §49's minimal
   * 4-type service protocol): a discovery reply (`announcement` present,
   * recorded the same way a SERVICE_ANNOUNCE would be) and/or a call result
   * (`requestId` present, resolving the matching `callService()` promise).
   * The `requestId` branch is gated on `packet.source` matching the
   * provider that specific pending call was actually sent to — the same
   * trust boundary `handleContentChunk`/`handleContentComplete` apply to
   * content transfers, so a reply claiming a `requestId` it was never
   * asked to answer can't hijack an in-flight call.
   */
  private handleServiceResponse(packet: Packet<ServiceResponsePayload>): void {
    if (packet.payload?.announcement) this.recordServiceAnnouncement(packet.payload.announcement);

    const requestId = packet.payload?.requestId;
    if (requestId === undefined) return;
    const pending = this.pendingServiceCalls.get(requestId);
    if (!pending || packet.source !== pending.providerId) return;
    this.pendingServiceCalls.delete(requestId);
    clearTimeout(pending.timeout);
    if (packet.payload.error !== undefined) pending.reject(new Error(packet.payload.error));
    else pending.resolve(packet.payload.result);
  }
}
