import { describe, expect, it } from "vitest";
import { BoundedFifoMap } from "../../node/src/bounded-map.js";

describe("BoundedFifoMap", () => {
  it("stores and retrieves values like a Map", () => {
    const map = new BoundedFifoMap<string, number>();
    map.set("a", 1);
    expect(map.get("a")).toBe(1);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("evicts the oldest entry once a new key would exceed maxSize", () => {
    const map = new BoundedFifoMap<string, number>({ maxSize: 2 });
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    expect(map.size).toBe(2);
    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(true);
  });

  it("returns the evicted key from set(), or undefined when nothing was evicted", () => {
    const map = new BoundedFifoMap<string, number>({ maxSize: 1 });
    expect(map.set("a", 1)).toBeUndefined();
    expect(map.set("b", 2)).toBe("a");
  });

  it("evicts by evictionScore instead of insertion order, when given one", () => {
    // Higher score = more valuable = survives longer. "b" is oldest but scores highest.
    const scores: Record<string, number> = { a: 1, b: 10, c: 1 };
    const map = new BoundedFifoMap<string, number>({ maxSize: 2, evictionScore: (key) => scores[key] });
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3); // must evict the lowest-scoring entry (a or c, tied) — not "a" just for being oldest

    expect(map.size).toBe(2);
    expect(map.has("b")).toBe(true); // highest score always survives
    expect(map.has("a")).toBe(false); // tied with "c" at the lowest score, but inserted first
    expect(map.has("c")).toBe(true);
  });

  it("breaks evictionScore ties in favor of evicting the entry inserted earlier", () => {
    const map = new BoundedFifoMap<string, number>({ maxSize: 2, evictionScore: () => 0 }); // every entry ties
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    expect(map.has("a")).toBe(false); // oldest among the tied entries
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(true);
  });

  it("evaluates evictionScore fresh at eviction time, not cached from insertion", () => {
    const scores: Record<string, number> = { a: 100, b: 1 };
    const map = new BoundedFifoMap<string, number>({ maxSize: 2, evictionScore: (key) => scores[key] });
    map.set("a", 1); // inserted while high-scoring
    map.set("b", 2);
    scores.a = 0; // "a"'s score drops after insertion — must be re-read, not assumed unchanged

    map.set("c", 3);
    expect(map.has("a")).toBe(false); // now the lowest score, evicted despite being high-scoring at insert time
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(true);
  });

  it("still evicts (falling back to FIFO) when every entry's evictionScore ties at Infinity", () => {
    // Infinity is the eviction search's own starting sentinel — if every real score also comes back
    // Infinity, a naive "strictly lower than the best so far" scan never finds a candidate. Without
    // a fallback this would silently break the maxSize guarantee instead of evicting something.
    const map = new BoundedFifoMap<string, number>({ maxSize: 2, evictionScore: () => Infinity });
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    expect(map.size).toBe(2);
    expect(map.has("a")).toBe(false); // oldest, evicted by the FIFO fallback
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(true);
  });

  it("holds nothing at all with maxSize 0 — the very first insert has no prior entry to evict", () => {
    const map = new BoundedFifoMap<string, number>({ maxSize: 0 });
    expect(map.set("a", 1)).toBe("a");
    expect(map.size).toBe(0);
    expect(map.has("a")).toBe(false);
  });

  it("never evicts anything when overwriting an existing key, even at capacity", () => {
    const map = new BoundedFifoMap<string, number>({ maxSize: 2 });
    map.set("a", 1);
    map.set("b", 2);
    expect(map.set("a", 99)).toBeUndefined();

    expect(map.size).toBe(2);
    expect(map.get("a")).toBe(99);
    expect(map.get("b")).toBe(2);
  });

  it("delete() removes a key and reports whether it existed", () => {
    const map = new BoundedFifoMap<string, number>();
    map.set("a", 1);
    expect(map.delete("a")).toBe(true);
    expect(map.delete("a")).toBe(false);
    expect(map.has("a")).toBe(false);
  });

  it("keys()/values()/entries() and direct for-of iteration all reflect insertion order", () => {
    const map = new BoundedFifoMap<string, number>();
    map.set("a", 1);
    map.set("b", 2);

    expect(Array.from(map.keys())).toEqual(["a", "b"]);
    expect(Array.from(map.values())).toEqual([1, 2]);
    expect(Array.from(map.entries())).toEqual([
      ["a", 1],
      ["b", 2],
    ]);

    const viaForOf: Array<[string, number]> = [];
    for (const entry of map) viaForOf.push(entry);
    expect(viaForOf).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("is unbounded by default (no maxSize option)", () => {
    const map = new BoundedFifoMap<number, number>();
    for (let i = 0; i < 10_000; i++) map.set(i, i);
    expect(map.size).toBe(10_000);
    expect(map.has(0)).toBe(true);
  });

  it("deleting the current key during a for-of loop is safe, like the underlying Map guarantees", () => {
    const map = new BoundedFifoMap<string, number>();
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    const seen: string[] = [];
    for (const [key] of map) {
      seen.push(key);
      map.delete(key);
    }

    expect(seen).toEqual(["a", "b", "c"]);
    expect(map.size).toBe(0);
  });
});
