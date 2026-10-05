import { createHash } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { BoundedFifoMap } from "./bounded-map.js";
import { Identity } from "./identity.js";

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
}

/** The fields a publisher's signature actually commits to — everything a relay could otherwise tamper with while keeping the same bytes. */
export type SignableContentFields = Pick<
  ContentMetadata,
  "contentId" | "name" | "mimeType" | "size" | "publisherId" | "expiresAt" | "encoding" | "originalSize"
>;

/**
 * Canonical bytes a publisher signs (spec §55). Deliberately covers more
 * than just the content id: signing only the id would let a relay swap
 * `name`/`mimeType`/`size` on genuinely-signed content (e.g. relabeling a
 * harmless file as something else) while the signature still "verified".
 * JSON-encoded with explicit field order so the signed representation is
 * unambiguous regardless of what characters appear in `name`/`mimeType`.
 *
 * `encoding`/`originalSize` are included the same way `expiresAt` always has been: assigned
 * directly from `fields`, so `JSON.stringify` drops the key entirely when the value is
 * `undefined` (the case for every piece of content that never went through compression) —
 * byte-for-byte the exact same signing payload as before this pair of fields existed. Content that
 * *is* compressed signs a payload that includes them, which an older node's `contentSigningPayload()`
 * (not yet aware of the fields) would compute differently — its `verifyContentSignature()` would
 * then correctly fail closed rather than accept bytes it has no way to interpret, instead of ever
 * serving compressed bytes as if they were the real content (`docs/next-steps.md`'s own flagged
 * risk, "serve a un piano di compatibilità esplicito").
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
   */
  trustRank?: (publisherId: string) => number;
}

const DEFAULT_MAX_SIZE = 256;

/** Local content catalogue + cache (spec §27-29). A node's own published content and anything it has cached share this store. */
export class ContentStore {
  private readonly items: BoundedFifoMap<string, StoredContent>;

  constructor(options: ContentStoreOptions = {}) {
    const trustRank = options.trustRank;
    this.items = new BoundedFifoMap({
      maxSize: options.maxSize ?? DEFAULT_MAX_SIZE,
      evictionScore: trustRank ? (_contentId, item) => trustRank(item.metadata.publisherId ?? "") : undefined,
    });
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
