import { createHash } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { BoundedFifoMap } from "./bounded-map.js";
import { Identity } from "./identity.js";
import { Priority, priorityRank } from "./packet.js";

/**
 * How the bytes actually stored/transferred for a piece of content relate to its logical/original
 * form — "ARALD Content Compression & Optimization" (`docs/next-steps.md`, `docs/security.md`).
 * Only one value today (lossless generic compression); media-specific lossy transforms/profiles
 * are V2 per the proposal, not built here.
 */
export type ContentEncoding = "zstd";

/**
 * Content metadata (spec §24). `publisherId`/`signature` (spec §55) are
 * present once content has gone through `NomadNode.publishContent()`, which
 * signs it — left undefined for content stored directly via `put()`
 * (a local/trusted path, e.g. test fixtures).
 */
export interface ContentMetadata {
  contentId: string;
  name: string;
  mimeType: string;
  /** Byte length of the content actually stored/transferred/chunked — the *compressed* length when `encoding` is set, identical to the logical length otherwise. Unchanged in meaning from before this field existed: `chunksFor()`/`chunkCountForSize()` always operated on this exact byte count. */
  size: number;
  createdAt: number;
  /** Node id of the original publisher (spec §55). */
  publisherId?: string;
  /** Ed25519 signature (hex), by publisherId, over `contentSigningPayload()` (spec §55). */
  signature?: string;
  /**
   * Absolute epoch ms after which this content is no longer valid/servable
   * (spec §24 "expiry") — undefined means it never expires. Covered by the
   * publisher's signature (see `SignableContentFields`) so a relay can't
   * tamper with it to keep stale content alive past its intended lifetime,
   * or cut a legitimate one short.
   */
  expiresAt?: number;
  /**
   * Set only when the stored bytes went through `compressForTransfer()` and it actually helped —
   * `undefined` (never the literal string, see `contentSigningPayload()`) means "stored exactly as
   * given," the universal case for every piece of content published before this field existed.
   * This *is* the "manifest" the compression proposal asked for — nothing more is needed, since
   * zstd's own framing carries everything else required to decompress.
   */
  encoding?: ContentEncoding;
  /** Logical/decompressed byte length — present only when `encoding` is set; informational (lets a UI show the saving) and used by `decodeStoredContent()`'s caller contract, never required by zstd itself to decompress. */
  originalSize?: number;
  /**
   * The `Priority` this content was announced/published at (`NomadNode.publishContent()`'s own
   * `options.priority`) — `undefined` means never set, the universal case for every piece of
   * content published before this field existed and for anything stored via `ContentStore.put()`
   * (the local/test-only path, never network-facing). This is a *content-level* urgency tag,
   * distinct from a packet's own `priority` field (which only ever affects transport-level send
   * scheduling, spec §50, and is never persisted once a transfer completes) — added specifically so
   * `ContentStore`'s eviction can tell an Emergency Beacon sighting or an `"emergency"` Drop apart
   * from routine content, which it could not before (docs/next-steps.md, "Priorità immediata" —
   * `ContentStore`'s eviction was trust-only, so a low-trust throwaway Beacon identity's SOS content
   * was the first eviction candidate in a busy relay, independent of docs/security.md voce #120's
   * fix — that one only ever covered unicast `PendingDeliveryQueue` traffic, never this broadcast
   * path). Signed (`SignableContentFields` below) so a relay can't tamper with it to either demote a
   * genuine SOS or falsely inflate routine content's eviction survival.
   */
  priority?: Priority;
}

/** The fields a publisher's signature actually commits to — everything a relay could otherwise tamper with while keeping the same bytes. */
export type SignableContentFields = Pick<
  ContentMetadata,
  "contentId" | "name" | "mimeType" | "size" | "publisherId" | "expiresAt" | "encoding" | "originalSize" | "priority"
>;

/**
 * Canonical bytes a publisher signs (spec §55). Deliberately covers more
 * than just the content id: signing only the id would let a relay swap
 * `name`/`mimeType`/`size` on genuinely-signed content (e.g. relabeling a
 * harmless file as something else) while the signature still "verified".
 * JSON-encoded with explicit field order so the signed representation is
 * unambiguous regardless of what characters appear in `name`/`mimeType`.
 *
 * `encoding`/`originalSize`/`priority` are included the same way `expiresAt` always has been:
 * assigned directly from `fields`, so `JSON.stringify` drops the key entirely when the value is
 * `undefined` (the case for every piece of content that never went through compression, or was
 * never given a priority) — byte-for-byte the exact same signing payload as before each of these
 * fields existed. Content that sets one of them signs a payload that includes it, which an older
 * node's `contentSigningPayload()` (not yet aware of the field) would compute differently — its
 * `verifyContentSignature()` would then correctly fail closed rather than accept bytes it has no
 * way to interpret, instead of ever serving compressed bytes as if they were the real content
 * (`docs/next-steps.md`'s own flagged risk, "serve a un piano di compatibilità esplicito") or
 * trusting a priority tag it can't actually verify was part of what was signed.
 */
export function contentSigningPayload(fields: SignableContentFields): Buffer {
  return Buffer.from(
    JSON.stringify({
      contentId: fields.contentId,
      name: fields.name,
      mimeType: fields.mimeType,
      size: fields.size,
      publisherId: fields.publisherId,
      expiresAt: fields.expiresAt,
      encoding: fields.encoding,
      originalSize: fields.originalSize,
      priority: fields.priority,
    }),
  );
}

/**
 * Below this, zstd's own frame overhead (header/checksum, a few dozen bytes) can only ever grow
 * the input, never shrink it — most `publishContent()` callers in this codebase are small
 * control-plane JSON blobs (a Drop, a beacon sighting, a directory entry), so skipping the attempt
 * outright avoids spending CPU on every one of those for a result `compressForTransfer()` would
 * have discarded anyway (see its own "keep whichever is smaller" rule below).
 */
const MIN_COMPRESSIBLE_SIZE = 512;

/**
 * "ARALD Content Compression & Optimization" (`docs/next-steps.md`, `docs/security.md`): tries
 * lossless Zstd (native `node:zlib`, no new dependency — Node 22.15+, already this project's
 * floor everywhere, `docs/next-steps.md`'s own verified finding) and keeps the result only if it
 * actually shrank the content; otherwise returns the original bytes untouched with `encoding` left
 * `undefined`. Automatic and unconditional by design — every `NomadNode.publishContent()` call
 * benefits with zero change to any of its call sites, and the "keep whichever is smaller" rule
 * means a payload compression doesn't help (already-compressed media, short control messages) is
 * never made worse.
 *
 * Must be called **before** signing/hashing (`NomadNode.publishContent()` does, immediately) and,
 * for any future encrypted/private content built on this same shape, before encryption too —
 * compressing ciphertext never works (encryption output is already high-entropy), and comressing
 * *then* encrypting is the only order that lets a later encrypted transport still benefit. Content
 * published through this module is never encrypted today (`content.ts` is the Open/signed path —
 * see `node.ts`'s Open-vs-Private split in `CLAUDE.md`), so this ordering is currently academic but
 * load-bearing for that future case: a confidentiality note worth logging for whoever builds it —
 * AES-256-GCM doesn't hide plaintext length, so the *compressed* size remains visible in the
 * ciphertext, a known side channel (CRIME/BREACH's family) for low-entropy/guessable content, even
 * though the threat model here (a specific file sent once to a specific recipient, not a repeated
 * request with attacker-injectable content) is far weaker than the TLS case that named it.
 */
export function compressForTransfer(data: Buffer): { data: Buffer; encoding?: ContentEncoding; originalSize?: number } {
  if (data.length < MIN_COMPRESSIBLE_SIZE) return { data };
  const compressed = zstdCompressSync(data);
  if (compressed.length >= data.length) return { data }; // didn't help — never store/sign a "compressed" form that's actually bigger
  return { data: compressed, encoding: "zstd", originalSize: data.length };
}

/**
 * Independent ceiling on how large a `encoding: "zstd"` claim may ever decompress to — never
 * derived from `metadata.originalSize` itself, since that's a signed-but-attacker-controlled field
 * for any self-signed identity (nothing stops a forged metadata/data pair from claiming a tiny
 * `originalSize` while actually being a "zip bomb": a small frame engineered to decompress to
 * gigabytes). Matches the reconstructable-content ceiling this project already accepts elsewhere
 * (`DEFAULT_MAX_CHUNKS_PER_ENTRY * CHUNK_SIZE`, `ChunkAssembler`, below) — content this large was
 * never actually reachable through this codebase before compression existed either.
 */
const MAX_DECOMPRESSED_CONTENT_BYTES = 256 * 1024 * 1024;

/**
 * Reverses `compressForTransfer()` — the one place `encoding` is ever interpreted. Bounded against
 * two distinct ways a forged `encoding: "zstd"` claim could otherwise crash or exhaust this process
 * (found by `code-review`, reproduced directly against `NomadNode.ingestSignedContent()`): data
 * that isn't actually a valid zstd frame at all (`zstdDecompressSync` throws — a single malformed
 * packet must never crash the process, spec §57/CLAUDE.md "Convenzioni consolidate"), and data that
 * *is* valid zstd but decompresses to something enormous (the "zip bomb" `MAX_DECOMPRESSED_CONTENT_BYTES`
 * guards against, via `maxOutputLength` — Node aborts the decompression itself once the cap would be
 * exceeded, rather than allocating past it first). Throws a plain `Error` on either failure; the one
 * caller that must never let that throw reach a peer or a crash is `ContentStore.putVerified()`
 * below, which treats it exactly like a hash mismatch — content that merely *claims* to decode never
 * enters the store, is never cached, relayed, or announced further. `NomadNode.getContent()`'s two
 * resolution paths only ever read already-stored entries, so by the time either calls this, the
 * decode has already succeeded once at `putVerified()` time and is expected to succeed identically
 * again (zstd decompression is deterministic) — this is intentionally not special-cased away for
 * that redundancy, same "redundant, harmless" posture `putVerified()`'s own hash re-check documents
 * elsewhere in this file.
 */
export function decodeStoredContent(metadata: Pick<ContentMetadata, "encoding" | "originalSize">, data: Buffer): Buffer {
  if (metadata.encoding !== "zstd") return data;
  const maxOutputLength = Math.min(metadata.originalSize ?? MAX_DECOMPRESSED_CONTENT_BYTES, MAX_DECOMPRESSED_CONTENT_BYTES);
  try {
    return zstdDecompressSync(data, { maxOutputLength });
  } catch {
    throw new Error("content claims zstd encoding but failed to decompress (corrupt, forged, or exceeds the decompressed-size ceiling)");
  }
}

/**
 * True only if publisherId/signature are present and the signature
 * actually verifies over the full signable metadata (spec §55) — this is
 * the trust boundary for any `ContentMetadata` learned from the network,
 * whether attached to actual bytes (`ContentStore.putVerified`) or to a
 * catalog-only sync entry (`NomadNode.handleSyncResponse`). Both call
 * paths must use this, not just the content-bytes path — a claim of
 * existence is still a claim that needs verifying.
 */
export function verifyContentSignature(metadata: ContentMetadata): boolean {
  if (!metadata.publisherId || !metadata.signature) return false;
  try {
    return Identity.verifyWithNodeId(
      metadata.publisherId,
      contentSigningPayload(metadata),
      Buffer.from(metadata.signature, "hex"),
    );
  } catch {
    // Malformed node id / signature hex, or a key that doesn't parse as Ed25519 — never trust it.
    return false;
  }
}

export interface StoredContent {
  metadata: ContentMetadata;
  data: Buffer;
}

/** Chunk size for content transfer (spec §26). Deliberately small so tests exercise multi-chunk reassembly. */
export const CHUNK_SIZE = 4096;

export function computeContentId(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * How many chunks `chunksFor()` splits a `size`-byte item into — exposed so a requester
 * (`NomadNode`, "ARALD Data Plane" multi-source retrieval, docs/next-steps.md) can compute this
 * from a `ContentMetadata.size` learned via `CONTENT_FOUND`, before ever holding the bytes
 * locally, instead of duplicating `chunksFor()`'s own loop boundary logic. Mirrors `chunksFor()`'s
 * zero-byte special case exactly: an empty item is still one (empty) chunk, never zero.
 */
export function chunkCountForSize(size: number): number {
  return size <= 0 ? 1 : Math.ceil(size / CHUNK_SIZE);
}

export interface ContentStoreOptions {
  /**
   * Bounds memory: an existing entry is evicted once the store is full to
   * make room for a new one (spec §57 resource limits) — see `trustRank`.
   * Deliberately much smaller than the default for metadata-only stores
   * like `RemoteCatalog`/`ServiceDirectory` (4096): unlike those, an entry
   * here carries actual payload bytes, not a few hundred bytes of metadata.
   */
  maxSize?: number;
  /**
   * Ranks a publisher's trust for eviction purposes (higher survives
   * longer) — pass `(publisherId) => trustRank(trustManager.get(publisherId))`
   * (trust.ts) so a full store evicts the least-trusted publisher's content
   * first, instead of always the oldest. Omit for plain FIFO eviction.
   *
   * When given, also activates priority-aware eviction (`docs/next-steps.md`, "Priorità
   * immediata" — `docs/security.md` voce #124): an entry's `ContentMetadata.priority` (defaulting
   * to `Priority.CONTENT` when unset, the same default `NomadNode.publishContent()` already
   * applies to an announce's packet priority) is weighed *before* trust, not instead of it — see
   * `pickEvictionScore()` below for the exact combination, and `MAX_UNVETTED_ELEVATED_ENTRIES`
   * for the budget that keeps this self-declared field from becoming a free trust-bypass for an
   * unlimited flood of throwaway identities (found by `code-review`). A `trustRank`-only store
   * (every entry at the same priority, the case before this existed) behaves identically to
   * before: trust alone still breaks every tie.
   */
  trustRank?: (publisherId: string) => number;
}

const DEFAULT_MAX_SIZE = 256;

/**
 * Combines content priority and publisher trust into a single eviction score — priority dominates
 * (an `"emergency"` Drop or Beacon sighting always outranks routine content for survival,
 * regardless of either publisher's trust), trust breaks ties within the same priority tier exactly
 * as it did before priority-awareness existed. `PRIORITY_TIER_SPREAD` only needs to exceed the
 * largest possible `trustRank` spread (`OWN_CONTENT_TRUST_RANK` in node.ts, `trustRank(ADMIN) + 1`
 * = 5) to guarantee tiers never overlap; 10 leaves a comfortable margin without needing to import
 * node.ts's own constant here (content.ts has no dependency on node.ts).
 */
const PRIORITY_TIER_SPREAD = 10;

/**
 * Caps how many *distinct, never-vetted* publishers may simultaneously benefit from priority
 * crossing a trust tier (`isUnvettedTrust()` below) — found necessary by `code-review`: unlike
 * `encoding`/`originalSize`, a self-declared `priority` has real adversarial value once it governs
 * eviction, since signing costs nothing. Without this cap, an attacker could self-sign arbitrary
 * content as `Priority.EMERGENCY` and evict an entire store's worth of legitimate, highly-trusted
 * content for free — exactly the "resists a flood of throwaway identities" guarantee this file's
 * own integration tests (`tests/integration/trust-aware-eviction.test.ts`) exist to protect. This
 * caps the budget by *entry*, not by publisher (`code-review` found a first version of this that
 * capped distinct publishers instead — a single throwaway identity could still flood an unbounded
 * number of *its own* distinct content ids, each one freely protected, since nothing limited volume
 * per publisher): at most `MAX_UNVETTED_ELEVATED_ENTRIES` unvetted+elevated entries are ever
 * protected at once, full stop, regardless of whether they come from one identity or a thousand.
 * Entries from a publisher this node already considers operator-vetted (`isUnvettedTrust()` returns
 * false — including this node's own content, always `OWN_CONTENT_TRUST_RANK` in node.ts) are exempt
 * from the cap entirely: it only ever targets identities whose standing here cost nothing but a
 * signature, the one case cheap to fabricate in bulk.
 */
const MAX_UNVETTED_ELEVATED_ENTRIES = 8;

/**
 * The highest `trustRank()` value that still counts as "cheap to fabricate, never actually vetted by
 * an operator" for `MAX_UNVETTED_ELEVATED_ENTRIES`'s purposes — deliberately **not** just
 * `TrustLevel.UNKNOWN`(0). Found by `code-review`, two rounds after the budget itself first shipped:
 * a threshold of "only UNKNOWN" never actually engaged against the realistic attack, because
 * `NomadNode` promotes a publisher past UNKNOWN automatically and for free in two separate, cheap
 * ways — merely connecting marks it `SEEN`(1) (`addTransport()`'s `onPeerConnected`, keyed on
 * `packet.source`, never cryptographically authenticated — CLAUDE.md "Binding crittografico"), and
 * any syntactically-valid self-signature marks it `VERIFIED`(2) (`acceptCatalogEntry()`/the
 * relay-caching path in node.ts, both call `trust.markVerified()`). A throwaway identity reaches
 * either for the cost of one TCP connection or one prior accepted signature — exactly as cheap as
 * fabricating the identity itself — so a cap that exempted them would never actually engage for a
 * directly-connected attacker publishing its own content, reopening the same "free trust-bypass"
 * hole this budget exists to close. `TrustLevel.TRUSTED`(3)/`ADMIN`(4) are different in kind, not
 * just degree: both require a real operator decision (spec §54; `trust.ts`'s own doc comment: "merely
 * having a valid signature only ever earns automatic VERIFIED status, never higher") — the same
 * distinction this codebase already treats as the meaningful trust boundary everywhere else trust
 * drives a security decision. Expressed as a raw number (2 = `trustRank(TrustLevel.VERIFIED)`)
 * instead of importing `trust.ts` — content.ts stays trust-vocabulary-agnostic, the same boundary the
 * injected `trustRank` callback itself already crosses; this mirrors trust.ts's own RANK table
 * rather than depending on it directly.
 */
const UNVETTED_TRUST_CEILING = 2;

function isUnvettedTrust(rank: number): boolean {
  return rank <= UNVETTED_TRUST_CEILING;
}

/** Local content catalogue + cache (spec §27-29). A node's own published content and anything it has cached share this store. */
export class ContentStore {
  private readonly items: BoundedFifoMap<string, StoredContent>;
  private readonly trustRankFn?: (publisherId: string) => number;
  /**
   * Content ids of the entries currently occupying the `MAX_UNVETTED_ELEVATED_ENTRIES` budget,
   * recomputed fresh (`refreshUnvettedElevatedSnapshot()`) immediately before every `items.set()`
   * call so every entry's score within that one eviction decision — existing entries and the one
   * being inserted alike — is judged against the *same* view. Recomputing from scratch each time
   * (an O(maxSize) scan, trivially cheap at this store's bounded size) avoids having to keep a
   * running count in sync with eviction/lazy-expiry, which would be its own source of bugs.
   *
   * Deliberately the *most recent* `MAX_UNVETTED_ELEVATED_ENTRIES` qualifying entries (iteration
   * order == survival/insertion order, so the tail of the filtered list is the newest), not the
   * earliest-admitted ones — `code-review` found that protecting whoever got there first instead
   * would permanently lock the budget to the first handful of unvetted senders a relay ever saw,
   * leaving every later arrival — including a perfectly genuine SOS, exactly the case this exists
   * to protect — admitted for exactly one round and then evicted on the very next insertion, no
   * better off than before this feature existed. Favoring recency instead means a fresh legitimate
   * sighting always gets a real shot at protection by displacing the stalest already-protected
   * entry, and an attacker gains nothing by camping on old entries instead of sending new ones.
   */
  private unvettedElevatedContentIds: ReadonlySet<string> = new Set();

  constructor(options: ContentStoreOptions = {}) {
    this.trustRankFn = options.trustRank;
    this.items = new BoundedFifoMap({
      maxSize: options.maxSize ?? DEFAULT_MAX_SIZE,
      evictionScore: this.trustRankFn ? (contentId, item) => this.pickEvictionScore(contentId, item) : undefined,
    });
  }

  private refreshUnvettedElevatedSnapshot(): void {
    const trustRank = this.trustRankFn;
    if (!trustRank) return;
    const defaultUrgency = priorityRank(Priority.CONTENT);
    const qualifying: string[] = [];
    for (const [contentId, item] of this.items) {
      const publisherId = item.metadata.publisherId;
      if (!publisherId) continue;
      const urgency = priorityRank(item.metadata.priority ?? Priority.CONTENT);
      if (urgency < defaultUrgency && isUnvettedTrust(trustRank(publisherId))) qualifying.push(contentId);
    }
    this.unvettedElevatedContentIds = new Set(qualifying.slice(-MAX_UNVETTED_ELEVATED_ENTRIES));
  }

  private pickEvictionScore(contentId: string, item: StoredContent): number {
    const trustRank = this.trustRankFn!;
    const publisherId = item.metadata.publisherId ?? "";
    const live = trustRank(publisherId);
    const requestedUrgency = priorityRank(item.metadata.priority ?? Priority.CONTENT);
    const defaultUrgency = priorityRank(Priority.CONTENT);
    const isElevated = requestedUrgency < defaultUrgency;
    // A never-vetted publisher's entry only gets to cross a trust tier while it's one of the
    // (at most MAX_UNVETTED_ELEVATED_ENTRIES) most recent qualifying entries currently in the store
    // — past that, it's scored exactly as if no priority had been set at all, same as every entry
    // before this feature existed.
    const withinBudget = this.unvettedElevatedContentIds.has(contentId);
    const effectiveUrgency = isElevated && isUnvettedTrust(live) && !withinBudget ? defaultUrgency : requestedUrgency;
    return -effectiveUrgency * PRIORITY_TIER_SPREAD + live;
  }

  put(name: string, mimeType: string, data: Buffer, options: { ttlMs?: number } = {}): ContentMetadata {
    const metadata: ContentMetadata = {
      contentId: computeContentId(data),
      name,
      mimeType,
      size: data.length,
      createdAt: Date.now(),
      expiresAt: options.ttlMs !== undefined ? Date.now() + options.ttlMs : undefined,
    };
    this.refreshUnvettedElevatedSnapshot();
    this.items.set(metadata.contentId, { metadata, data });
    return metadata;
  }

  /**
   * Stores content received from the mesh (a relay caching passively, or a
   * requester completing a transfer) only if it passes both integrity
   * checks from spec §55 — the bytes actually hash to the claimed content
   * id, AND the metadata carries a valid publisher signature over that id —
   * and has not already expired (spec §24 "expiry"): there is no value in
   * caching content that's already dead on arrival, and a relay that let it
   * through anyway would just be helping it linger past its own publisher's
   * intent. This is the trust boundary for anything not authored locally by
   * this node — see docs/security.md.
   *
   * A fourth check, added alongside "ARALD Content Compression & Optimization": a signature being
   * valid only proves the publisher really signed `encoding: "zstd"` over these exact bytes, never
   * that those bytes genuinely decompress — a self-signed identity can sign anything about its own
   * content. Rejecting here, at the one gate every untrusted entry point funnels through (mesh
   * CONTENT_COMPLETE/CONTENT_ANNOUNCE, `POST /api/ingest-signed-content`, catalog-verified direct
   * stores), means a forged/corrupt "zstd" claim is never cached, relayed, or announced further —
   * found by `code-review`, reproduced as a real unauthenticated remote crash before this fix
   * (`decodeStoredContent()`'s own doc comment has the full detail).
   */
  putVerified(metadata: ContentMetadata, data: Buffer): boolean {
    if (computeContentId(data) !== metadata.contentId) return false;
    if (!verifyContentSignature(metadata)) return false;
    if (metadata.expiresAt !== undefined && metadata.expiresAt <= Date.now()) return false;
    if (metadata.encoding !== undefined) {
      try {
        decodeStoredContent(metadata, data);
      } catch {
        return false; // claims an encoding it doesn't actually honor — never trust it
      }
    }
    this.refreshUnvettedElevatedSnapshot();
    this.items.set(metadata.contentId, { metadata, data });
    return true;
  }

  get(contentId: string): StoredContent | undefined {
    return this.readLive(contentId);
  }

  has(contentId: string): boolean {
    return this.readLive(contentId) !== undefined;
  }

  /** Metadata for everything actually stored locally (bytes included) — the basis of this node's half of a catalog sync (spec §33). Expired entries are purged first, never listed. */
  list(): ContentMetadata[] {
    this.purgeExpired();
    return Array.from(this.items.values(), (item) => item.metadata);
  }

  chunksFor(contentId: string): Buffer[] {
    const item = this.readLive(contentId);
    if (!item) return [];
    if (item.data.length === 0) return [Buffer.alloc(0)];
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < item.data.length; offset += CHUNK_SIZE) {
      chunks.push(item.data.subarray(offset, offset + CHUNK_SIZE));
    }
    return chunks;
  }

  get size(): number {
    this.purgeExpired();
    return this.items.size;
  }

  /** Looks up `contentId`, transparently evicting and treating it as absent if its expiry has passed (spec §24). */
  private readLive(contentId: string): StoredContent | undefined {
    const item = this.items.get(contentId);
    if (!item) return undefined;
    if (item.metadata.expiresAt !== undefined && item.metadata.expiresAt <= Date.now()) {
      this.items.delete(contentId);
      return undefined;
    }
    return item;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [contentId, item] of this.items) {
      if (item.metadata.expiresAt !== undefined && item.metadata.expiresAt <= now) this.items.delete(contentId);
    }
  }
}

interface AssemblyEntry {
  chunks: Map<number, Buffer>;
  totalChunks: number;
}

export interface ChunkAssemblerOptions {
  /** Max distinct content ids being assembled concurrently (spec §57 resource limits). */
  maxEntries?: number;
  /** Max chunks a single content id may claim; also caps `chunkIndex`. Bounds the largest content this node will attempt to reassemble (`maxChunksPerEntry * CHUNK_SIZE` bytes). */
  maxChunksPerEntry?: number;
}

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_CHUNKS_PER_ENTRY = 65536; // 65536 * CHUNK_SIZE (4096B) = 256MB reconstructable content

/**
 * Reassembles chunked content (spec §26) from `CONTENT_CHUNK` packets and
 * verifies the final hash against the announced content id. Used both by
 * the node actually requesting content, and by relay nodes that
 * opportunistically cache content as they forward it (spec §27, milestone
 * "second/third objective" §91-92).
 *
 * Fed directly by untrusted network input — `handleContentChunk` accepts
 * chunks for *any* content id a peer sends, whether or not this node ever
 * asked for it (spec §27's opportunistic relay caching depends on that).
 * Both dimensions of memory use are bounded like every other network-fed
 * store in this codebase (spec §57): the number of distinct content ids
 * tracked at once (FIFO eviction, matching `SeenCache`/`RemoteCatalog`/etc.)
 * and the size any single one can claim (a `totalChunks`/`chunkIndex` claim
 * outside `maxChunksPerEntry` is rejected outright, before anything is
 * stored) — otherwise a single connected peer could flood fabricated chunks
 * for content ids nobody requested and grow this map without bound.
 */
export class ChunkAssembler {
  private readonly entries = new Map<string, AssemblyEntry>();
  private readonly maxEntries: number;
  private readonly maxChunksPerEntry: number;

  constructor(options: ChunkAssemblerOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxChunksPerEntry = options.maxChunksPerEntry ?? DEFAULT_MAX_CHUNKS_PER_ENTRY;
  }

  /**
   * Returns whether the chunk was actually accepted/stored — `false` for a malformed/out-of-bounds
   * claim (spec §57). Added for "ARALD Data Plane" multi-source retrieval (`node.ts`'s
   * `PendingContentEntry.receivedChunks`, docs/next-steps.md): a caller tracking its own separate
   * "which chunks have genuinely arrived" bookkeeping must gate it on this, not call it
   * unconditionally — otherwise a chunk this method silently rejected could still inflate that
   * caller's own tracking without bound, reopening exactly the resource-exhaustion risk this
   * method's own validation exists to close.
   */
  addChunk(contentId: string, chunkIndex: number, totalChunks: number, data: Buffer): boolean {
    if (
      !Number.isInteger(totalChunks) ||
      totalChunks <= 0 ||
      totalChunks > this.maxChunksPerEntry ||
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= totalChunks
    ) {
      return false; // malformed or out-of-bounds claim — never trust it (spec §57)
    }

    let entry = this.entries.get(contentId);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey !== undefined) this.entries.delete(oldestKey);
      }
      entry = { chunks: new Map(), totalChunks };
      this.entries.set(contentId, entry);
    }
    entry.chunks.set(chunkIndex, data);
    return true;
  }

  /** Returns the reassembled+verified buffer once all chunks are present and the hash matches, otherwise undefined. */
  tryComplete(contentId: string, metadata: ContentMetadata): Buffer | undefined {
    const entry = this.entries.get(contentId);
    if (!entry || entry.chunks.size < entry.totalChunks) return undefined;

    const parts: Buffer[] = [];
    for (let i = 0; i < entry.totalChunks; i++) {
      const chunk = entry.chunks.get(i);
      if (!chunk) return undefined;
      parts.push(chunk);
    }
    this.entries.delete(contentId);

    const data = Buffer.concat(parts);
    return computeContentId(data) === metadata.contentId ? data : undefined;
  }

  discard(contentId: string): void {
    this.entries.delete(contentId);
  }
}
