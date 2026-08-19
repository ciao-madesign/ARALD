import { BoundedFifoMap } from "./bounded-map.js";
import type { ContentMetadata } from "./content.js";

export interface RemoteCatalogOptions {
  /** Bounds memory: an existing entry is evicted once the catalog is full to make room for a new one (spec §57 resource limits) — see `trustRank`. */
  maxSize?: number;
  /**
   * Ranks a publisher's trust for eviction purposes (higher survives
   * longer) — pass `(publisherId) => trustRank(trustManager.get(publisherId))`
   * (trust.ts) so a full catalog evicts the entry from the least-trusted
   * publisher first, instead of always the oldest. Omit for plain FIFO
   * eviction.
   */
  trustRank?: (publisherId: string) => number;
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
 * content bytes. This class doesn't track trust itself — it only optionally
 * *consults* it (via `trustRank`) to decide what to evict when full.
 */
export class RemoteCatalog {
  private readonly entries: BoundedFifoMap<string, ContentMetadata>;

  constructor(options: RemoteCatalogOptions = {}) {
    const trustRank = options.trustRank;
    this.entries = new BoundedFifoMap({
      maxSize: options.maxSize ?? DEFAULT_MAX_SIZE,
      evictionScore: trustRank ? (_contentId, metadata) => trustRank(metadata.publisherId ?? "") : undefined,
    });
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
    // Uses this class's own (expiry-aware) has(), not the raw map's — otherwise an already-expired
    // entry nobody has purged yet would block a fresh re-announcement of the same content id from
    // ever being recorded, silently keeping the stale entry around forever.
    if (this.has(metadata.contentId)) return;
    this.entries.set(metadata.contentId, metadata);
  }

  has(contentId: string): boolean {
    return this.get(contentId) !== undefined;
  }

  /** Looks up `contentId`, transparently evicting and treating it as absent once its publisher-signed expiry has passed (spec §24, mirrors `ContentStore`). */
  get(contentId: string): ContentMetadata | undefined {
    const metadata = this.entries.get(contentId);
    if (!metadata) return undefined;
    if (metadata.expiresAt !== undefined && metadata.expiresAt <= Date.now()) {
      this.entries.delete(contentId);
      return undefined;
    }
    return metadata;
  }

  /** Expired entries are purged as encountered, never listed — an expired claim is stale info, not something worth re-advertising to the next peer. */
  list(): ContentMetadata[] {
    this.purgeExpired();
    return Array.from(this.entries.values());
  }

  get size(): number {
    this.purgeExpired();
    return this.entries.size;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [contentId, metadata] of this.entries) {
      if (metadata.expiresAt !== undefined && metadata.expiresAt <= now) this.entries.delete(contentId);
    }
  }
}
