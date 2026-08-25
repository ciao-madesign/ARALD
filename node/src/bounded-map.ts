export interface BoundedFifoMapOptions<K, V> {
  maxSize?: number;
  /**
   * Ranks an entry for eviction purposes — the entry with the *lowest*
   * score is evicted first (ties broken in favor of evicting whichever was
   * inserted earlier). Omit for plain FIFO eviction (oldest entry first),
   * the default every caller used before this option existed. Evaluated
   * fresh at eviction time, not cached at insert time, so it reflects each
   * entry's *current* state (e.g. `PeerDirectory`/`RemoteCatalog` rank by
   * the live trust level of the node id behind an entry, which can change
   * after the entry was recorded).
   */
  evictionScore?: (key: K, value: V) => number;
}

/**
 * A `Map` that silently evicts one entry once a *new* key would push it
 * past `maxSize` (spec §57 resource limits) — the bounded-eviction pattern
 * shared by every bounded store in this codebase fed by untrusted network
 * input (`SeenCache`, `RemoteCatalog`, `PeerDirectory`, `RoutingTable`,
 * `PendingDeliveryQueue`). Extracted so a change to the eviction strategy
 * has one place to change instead of five near-identical
 * reimplementations — which is exactly what `evictionScore` is for: it
 * generalizes plain FIFO into "evict whichever entry matters least right
 * now" without each caller needing its own eviction-scanning code.
 *
 * Deliberately minimal — just enough `Map` surface for its callers, not a
 * general-purpose collection. Updating an *existing* key never evicts
 * anything, matching every caller's own "immutable once recorded" or
 * "refresh in place" semantics.
 */
export class BoundedFifoMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxSize: number;
  private readonly evictionScore?: (key: K, value: V) => number;

  constructor(options: BoundedFifoMapOptions<K, V> = {}) {
    this.maxSize = options.maxSize ?? Infinity;
    this.evictionScore = options.evictionScore;
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
   * capacity, one entry is evicted first — chosen by `evictionScore` if
   * given, otherwise the oldest. Returns the evicted key, if any. A
   * `maxSize` of 0 refuses to hold anything at all — there's no entry to
   * evict on the very first insert into an empty map, so that edge case
   * needs its own guard rather than falling out of the eviction check below.
   */
  set(key: K, value: V): K | undefined {
    if (this.maxSize <= 0) return key;
    let evicted: K | undefined;
    if (!this.map.has(key) && this.map.size >= this.maxSize) {
      const victim = this.pickEvictionCandidate();
      if (victim !== undefined) {
        this.map.delete(victim);
        evicted = victim;
      }
    }
    this.map.set(key, value);
    return evicted;
  }

  private pickEvictionCandidate(): K | undefined {
    if (!this.evictionScore) return this.map.keys().next().value; // plain FIFO: oldest entry
    let bestKey: K | undefined;
    let bestScore = Infinity;
    for (const [key, value] of this.map) {
      const score = this.evictionScore(key, value);
      if (score < bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    // bestKey stays undefined only if every entry scored exactly Infinity (the search's own
    // starting sentinel, so nothing was ever strictly lower) — an evictionScore is never expected
    // to return Infinity, but falling back to plain FIFO here instead of "nothing to evict" keeps
    // the size bound an unconditional guarantee regardless of what a caller's score function does.
    return bestKey ?? this.map.keys().next().value;
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

/**
 * Appends `item` to `array` in place, then trims from the front until it's
 * no longer than `maxLength` — the "keep the N most recent" bounding
 * pattern used by every per-key message list in this codebase
 * (`MessageHistory.record()`, `PublicChannels.record()`). Extracted so
 * that identical logic has one place to change, same reasoning
 * `BoundedFifoMap` itself was extracted for (`CLAUDE.md`, "rimossa
 * duplicazione 5x").
 *
 * A negative `maxLength` never even reaches the trimming loop (found by
 * review): `array.length > maxLength` stays true once the array is empty
 * (`0 > -1`), and `Array.prototype.shift()` on an empty array is a silent
 * no-op — without this guard the loop never terminates, freezing the event
 * loop. Mirrors `BoundedFifoMap.set()`'s own `maxSize <= 0` guard (refuses
 * to hold anything at all) so `maxLength <= 0` behaves identically here:
 * `item` is never even pushed.
 */
export function pushBounded<T>(array: T[], item: T, maxLength: number): void {
  if (maxLength <= 0) return;
  array.push(item);
  while (array.length > maxLength) array.shift();
}
