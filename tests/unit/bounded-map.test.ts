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
