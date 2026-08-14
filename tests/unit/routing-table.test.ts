import { describe, expect, it } from "vitest";
import { RoutingTable } from "../../node/src/routing-table.js";

describe("RoutingTable", () => {
  it("adopts a route to a new destination", () => {
    const table = new RoutingTable();
    expect(table.offer("C", "B", 2)).toBe(true);
    expect(table.bestRoute("C")).toEqual({ nextHop: "B", cost: 2 });
    expect(table.has("C")).toBe(true);
    expect(table.size).toBe(1);
  });

  it("ignores a worse route from a different next hop", () => {
    const table = new RoutingTable();
    table.offer("C", "B", 2);
    expect(table.offer("C", "D", 3)).toBe(false);
    expect(table.bestRoute("C")).toEqual({ nextHop: "B", cost: 2 });
  });

  it("adopts a strictly better route from a different next hop", () => {
    const table = new RoutingTable();
    table.offer("C", "B", 3);
    expect(table.offer("C", "D", 2)).toBe(true);
    expect(table.bestRoute("C")).toEqual({ nextHop: "D", cost: 2 });
  });

  it("always reflects a fresh update from the same next hop, even if the cost got worse", () => {
    const table = new RoutingTable();
    table.offer("C", "B", 2);
    expect(table.offer("C", "B", 5)).toBe(true);
    expect(table.bestRoute("C")).toEqual({ nextHop: "B", cost: 5 });
  });

  it("is a no-op when the offered route is identical to the one already held", () => {
    const table = new RoutingTable();
    table.offer("C", "B", 2);
    expect(table.offer("C", "B", 2)).toBe(false);
  });

  it("rejects non-positive, non-finite, or over-cap costs", () => {
    const table = new RoutingTable({ maxCost: 10 });
    expect(table.offer("C", "B", 0)).toBe(false);
    expect(table.offer("C", "B", -1)).toBe(false);
    expect(table.offer("C", "B", Infinity)).toBe(false);
    expect(table.offer("C", "B", 11)).toBe(false);
    expect(table.has("C")).toBe(false);
  });

  it("rejects a direct-link claim (destination === nextHop) at any cost other than 1", () => {
    const table = new RoutingTable();
    expect(table.offer("B", "B", 2)).toBe(false);
    expect(table.offer("B", "B", 1)).toBe(true);
    expect(table.bestRoute("B")).toEqual({ nextHop: "B", cost: 1 });
  });

  it("withdraw removes a route only if it currently goes via the given next hop", () => {
    const table = new RoutingTable();
    table.offer("C", "B", 2);
    expect(table.withdraw("C", "D")).toBe(false); // stale withdrawal, route isn't via D
    expect(table.has("C")).toBe(true);
    expect(table.withdraw("C", "B")).toBe(true);
    expect(table.has("C")).toBe(false);
  });

  it("withdraw on an unknown destination is a no-op", () => {
    const table = new RoutingTable();
    expect(table.withdraw("nope", "B")).toBe(false);
  });

  it("removeRoutesVia clears every route through a given peer and leaves others intact", () => {
    const table = new RoutingTable();
    table.offer("B", "B", 1);
    table.offer("C", "B", 2);
    table.offer("D", "E", 1);

    const removed = table.removeRoutesVia("B");
    expect(removed.sort()).toEqual(["B", "C"]);
    expect(table.has("B")).toBe(false);
    expect(table.has("C")).toBe(false);
    expect(table.has("D")).toBe(true);
  });

  it("list() enumerates every current route", () => {
    const table = new RoutingTable();
    table.offer("B", "B", 1);
    table.offer("C", "B", 2);
    const list = table.list();
    expect(list).toHaveLength(2);
    expect(list.sort((a, b) => a.destination.localeCompare(b.destination))).toEqual([
      { destination: "B", nextHop: "B", cost: 1 },
      { destination: "C", nextHop: "B", cost: 2 },
    ]);
  });

  it("evicts the oldest entry once maxSize is exceeded, for a brand-new destination", () => {
    const table = new RoutingTable({ maxSize: 2 });
    table.offer("A", "A", 1);
    table.offer("B", "B", 1);
    table.offer("C", "C", 1);

    expect(table.size).toBe(2);
    expect(table.has("A")).toBe(false);
    expect(table.has("C")).toBe(true);
  });
});
