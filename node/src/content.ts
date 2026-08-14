import { createHash } from "node:crypto";
import { Identity } from "./identity.js";

/**
 * Content metadata (spec §24). `publisherId`/`signature` (spec §55) are
 * present once content has gone through `NomadNode.publishContent()`, which
 * signs it — left undefined for content stored directly via `put()`
 * (a local/trusted path, e.g. test fixtures). Expiry is still not
 * implemented — see docs/security.md.
 */
export interface ContentMetadata {
  contentId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  /** Node id of the original publisher (spec §55). */
  publisherId?: string;
  /** Ed25519 signature (hex), by publisherId, over `contentSigningPayload()` (spec §55). */
  signature?: string;
}

/** The fields a publisher's signature actually commits to — everything a relay could otherwise tamper with while keeping the same bytes. */
export type SignableContentFields = Pick<ContentMetadata, "contentId" | "name" | "mimeType" | "size" | "publisherId">;

/**
 * Canonical bytes a publisher signs (spec §55). Deliberately covers more
 * than just the content id: signing only the id would let a relay swap
 * `name`/`mimeType`/`size` on genuinely-signed content (e.g. relabeling a
 * harmless file as something else) while the signature still "verified".
 * JSON-encoded with explicit field order so the signed representation is
 * unambiguous regardless of what characters appear in `name`/`mimeType`.
 */
export function contentSigningPayload(fields: SignableContentFields): Buffer {
  return Buffer.from(
    JSON.stringify({
      contentId: fields.contentId,
      name: fields.name,
      mimeType: fields.mimeType,
      size: fields.size,
      publisherId: fields.publisherId,
    }),
  );
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

/** Local content catalogue + cache (spec §27-29). A node's own published content and anything it has cached share this store. */
export class ContentStore {
  private readonly items = new Map<string, StoredContent>();

  put(name: string, mimeType: string, data: Buffer): ContentMetadata {
    const metadata: ContentMetadata = {
      contentId: computeContentId(data),
      name,
      mimeType,
      size: data.length,
      createdAt: Date.now(),
    };
    this.items.set(metadata.contentId, { metadata, data });
    return metadata;
  }

  /**
   * Stores content received from the mesh (a relay caching passively, or a
   * requester completing a transfer) only if it passes both integrity
   * checks from spec §55: the bytes actually hash to the claimed content
   * id, AND the metadata carries a valid publisher signature over that id.
   * This is the trust boundary for anything not authored locally by this
   * node — see docs/security.md.
   */
  putVerified(metadata: ContentMetadata, data: Buffer): boolean {
    if (computeContentId(data) !== metadata.contentId) return false;
    if (!verifyContentSignature(metadata)) return false;
    this.items.set(metadata.contentId, { metadata, data });
    return true;
  }

  get(contentId: string): StoredContent | undefined {
    return this.items.get(contentId);
  }

  has(contentId: string): boolean {
    return this.items.has(contentId);
  }

  /** Metadata for everything actually stored locally (bytes included) — the basis of this node's half of a catalog sync (spec §33). */
  list(): ContentMetadata[] {
    return Array.from(this.items.values(), (item) => item.metadata);
  }

  chunksFor(contentId: string): Buffer[] {
    const item = this.items.get(contentId);
    if (!item) return [];
    if (item.data.length === 0) return [Buffer.alloc(0)];
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < item.data.length; offset += CHUNK_SIZE) {
      chunks.push(item.data.subarray(offset, offset + CHUNK_SIZE));
    }
    return chunks;
  }

  get size(): number {
    return this.items.size;
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

  addChunk(contentId: string, chunkIndex: number, totalChunks: number, data: Buffer): void {
    if (
      !Number.isInteger(totalChunks) ||
      totalChunks <= 0 ||
      totalChunks > this.maxChunksPerEntry ||
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= totalChunks
    ) {
      return; // malformed or out-of-bounds claim — never trust it (spec §57)
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
