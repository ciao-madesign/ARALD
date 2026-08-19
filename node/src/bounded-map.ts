export interface BoundedFifoMapOptions {
  maxSize?: number;
}

/**
 * A `Map` that silently evicts its oldest entry (insertion order) once a
 * *new* key would push it past `maxSize` (spec §57 resource limits) — the
 * FIFO eviction-on-capacity pattern shared by every bounded store in this
 * codebase fed by untrusted network input (`SeenCache`, `RemoteCatalog`,
 * `PeerDirectory`, `RoutingTable`, `PendingDeliveryQueue`). Extracted so a
 * future change to the eviction strategy (e.g. trust-aware eviction) has
 * one place to change instead of five near-identical reimplementations.
 *
 * Deliberately minimal — just enough `Map` surface for those five callers,
 * not a general-purpose collection. Updating an *existing* key never
 * evicts anything, matching every caller's own "immutable once recorded"
 * or "refresh in place" semantics.
 */
export class BoundedFifoMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxSize: number;

  constructor(options: BoundedFifoMapOptions = {}) {
    this.maxSize = options.maxSize ?? Infinity;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /**
   * Inserts or overwrites `key`. If `key` is new and the map is already at
   * capacity, the oldest entry is evicted first. Returns the evicted key,
   * if any. A `maxSize` of 0 refuses to hold anything at all — there's no
   * "oldest entry" to evict on the very first insert into an empty map, so
   * that edge case needs its own guard rather than falling out of the
   * general eviction check below.
   */
  set(key: K, value: V): K | undefined {
    if (this.maxSize <= 0) return key;
    let evicted: K | undefined;
    if (!this.map.has(key) && this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
        evicted = oldestKey;
      }
    }
    this.map.set(key, value);
    return evicted;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  get size(): number {
    return this.map.size;
  }
}
