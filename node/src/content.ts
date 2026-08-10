import { createHash } from "node:crypto";

/** Content metadata (spec §24). Signature/publisher/expiry fields are not yet implemented — see docs/security.md. */
export interface ContentMetadata {
  contentId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
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

  /** Stores content only if it actually hashes to the claimed content id (spec §55 integrity check). */
  putVerified(metadata: ContentMetadata, data: Buffer): boolean {
    if (computeContentId(data) !== metadata.contentId) return false;
    this.items.set(metadata.contentId, { metadata, data });
    return true;
  }

  get(contentId: string): StoredContent | undefined {
    return this.items.get(contentId);
  }

  has(contentId: string): boolean {
    return this.items.has(contentId);
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

/**
 * Reassembles chunked content (spec §26) from `CONTENT_CHUNK` packets and
 * verifies the final hash against the announced content id. Used both by
 * the node actually requesting content, and by relay nodes that
 * opportunistically cache content as they forward it (spec §27, milestone
 * "second/third objective" §91-92).
 */
export class ChunkAssembler {
  private readonly entries = new Map<string, AssemblyEntry>();

  addChunk(contentId: string, chunkIndex: number, totalChunks: number, data: Buffer): void {
    let entry = this.entries.get(contentId);
    if (!entry) {
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
