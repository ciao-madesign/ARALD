import type { ContentMetadata } from "./content.js";

export interface RemoteCatalogOptions {
  /** Bounds memory: oldest entry is evicted once the catalog is full (spec §57 resource limits). */
  maxSize?: number;
}

const DEFAULT_MAX_SIZE = 4096;

/**
 * Content this node has learned *exists* somewhere in the mesh, via a
 * catalog exchange with a peer (spec §33-34, milestone 13 "partition
 * synchronization"), without having fetched the actual bytes itself.
 *
 * This is deliberately metadata-only: knowing a piece of content exists
 * (and where) is what lets two previously-separate mesh segments reconcile
 * cheaply when they reconnect, without re-flooding all their data at each
 * other (spec §33 — "non devono trasferire tutto... prima devono
 * confrontare cataloghi"). Actual retrieval still goes through
 * `NomadNode.getContent()`, which floods a `CONTENT_QUERY` for the specific
 * id only once the bytes are actually needed.
 *
 * `record()` does **not** verify the publisher signature itself — a peer's
 * `SYNC_RESPONSE` is untrusted network input, and the caller
 * (`NomadNode.handleSyncResponse`) must call
 * `verifyContentSignature()` (content.ts) before recording anything here,
 * the same trust boundary `ContentStore.putVerified()` applies to actual
 * content bytes. This class only handles storage/eviction, not trust.
 */
export class RemoteCatalog {
  private readonly entries = new Map<string, ContentMetadata>();
  private readonly maxSize: number;

  constructor(options: RemoteCatalogOptions = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  }

  /**
   * Records a piece of content this node has learned about but does not
   * hold. A content id is the hash of its bytes (spec §24), so it's
   * immutable by construction: once a validly-signed claim for a given
   * content id is recorded, any later claim for the same id necessarily
   * describes the exact same bytes, and there is nothing to "refresh" —
   * the first one recorded is kept, full stop. (An earlier version of this
   * method preferred whichever entry had the newer `createdAt`, but that
   * field isn't covered by the publisher's signature — see
   * `contentSigningPayload()` in content.ts — so a relay could tamper with
   * only `createdAt` to permanently pin its own copy as "freshest". No
   * such comparison is needed at all once content is treated as immutable.)
   *
   * Known tradeoff: if two different publishers independently sign
   * different `name`/`mimeType` labels for bytes that happen to hash to
   * the same content id (metadata isn't part of the hash), whichever claim
   * is recorded first wins and the other is silently not kept — a minor
   * information-loss edge case, not a trust issue (both claims, if
   * recorded, would have passed signature verification).
   */
  record(metadata: ContentMetadata): void {
    if (this.entries.has(metadata.contentId)) return;
    if (this.entries.size >= this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(metadata.contentId, metadata);
  }

  has(contentId: string): boolean {
    return this.entries.has(contentId);
  }

  get(contentId: string): ContentMetadata | undefined {
    return this.entries.get(contentId);
  }

  list(): ContentMetadata[] {
    return Array.from(this.entries.values());
  }

  get size(): number {
    return this.entries.size;
  }
}
