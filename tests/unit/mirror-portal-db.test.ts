import { describe, expect, it } from "vitest";
import { asRecord, assembleSnapshot, eventTimestamp, rankByEventTimestamp } from "../../mirror-portal/lib/db.js";

describe("mirror-portal/lib/db", () => {
  describe("asRecord", () => {
    it("passes through a plain object", () => {
      expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    });

    it("regression: normalizes SQL/jsonb null, an array, and a bare scalar to {} instead of crashing downstream", () => {
      // Real bug found by review: every format.ts helper and app/page.tsx access `data.field`
      // directly — a jsonb column can hold the JSON literal `null` (or, from a future/different
      // writer, an array or bare string) even under a NOT NULL constraint, which would throw
      // "Cannot read properties of null" mid-render, outside the try/catch that only wrapped the
      // query itself.
      expect(asRecord(null)).toEqual({});
      expect(asRecord(undefined)).toEqual({});
      expect(asRecord([1, 2, 3])).toEqual({});
      expect(asRecord("not an object")).toEqual({});
      expect(asRecord(42)).toEqual({});
    });
  });

  describe("eventTimestamp", () => {
    it("reads a finite numeric timestamp", () => {
      expect(eventTimestamp({ timestamp: 1700000000000 })).toBe(1700000000000);
    });
    it("defaults to 0 for a missing or non-finite timestamp, never throwing or picking synced_at instead", () => {
      expect(eventTimestamp({})).toBe(0);
      expect(eventTimestamp({ timestamp: "not a number" })).toBe(0);
      expect(eventTimestamp({ timestamp: Number.NaN })).toBe(0);
    });
  });

  describe("rankByEventTimestamp", () => {
    it("orders by data.timestamp descending, not by insertion order", () => {
      const rows = [
        { id: "a", data: { timestamp: 100 } },
        { id: "b", data: { timestamp: 300 } },
        { id: "c", data: { timestamp: 200 } },
      ];
      expect(rankByEventTimestamp(rows).map((r) => r.id)).toEqual(["b", "c", "a"]);
    });

    it("regression: ranks by the event's own timestamp, not by how recently a row was re-synced", () => {
      // The bug this guards: postgres-sync.ts's ON CONFLICT ... DO UPDATE bumps synced_at on every
      // re-sync of an already-known row — ordering "most recent" by synced_at would let a routine
      // beacon re-synced a moment later outrank a genuinely more urgent/recent real-world SOS. Here,
      // "urgent" has the highest data.timestamp (the real event time) despite being listed first —
      // rankByEventTimestamp never sees synced_at at all, so this can't regress silently.
      const rows = [
        { id: "just-re-synced-but-older-event", data: { timestamp: 100 } },
        { id: "urgent-and-most-recent-event", data: { timestamp: 999 } },
      ];
      expect(rankByEventTimestamp(rows).map((r) => r.id)).toEqual(["urgent-and-most-recent-event", "just-re-synced-but-older-event"]);
    });

    it("caps at the top 50 by event time when more rows are given", () => {
      const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, data: { timestamp: i } }));
      const ranked = rankByEventTimestamp(rows);
      expect(ranked).toHaveLength(50);
      expect(ranked[0].id).toBe(59); // highest timestamp first
      expect(ranked[49].id).toBe(10); // the 50th-highest, ids 0-9 dropped
    });
  });

  describe("assembleSnapshot", () => {
    it("returns all four sections with no errors when every query succeeds", async () => {
      const snapshot = assembleSnapshot({
        nodes: await settled(Promise.resolve([{ nodeUrl: "n", nodeId: "N1", data: {}, syncedAt: new Date() }])),
        relays: await settled(Promise.resolve([])),
        beacons: await settled(Promise.resolve([])),
        drops: await settled(Promise.resolve([])),
      });

      expect(snapshot.nodes).toHaveLength(1);
      expect(snapshot.errors).toEqual([]);
    });

    it("regression: one rejected section reports its own error without blanking the sections that succeeded", async () => {
      // Real bug found by review: a plain Promise.all across all four queries used to reject the
      // whole snapshot the moment any single one failed — hiding live SOS/relay/drop data an
      // operator could otherwise have used during an active incident.
      const relayFailure = new Error("relays table unreachable");
      const snapshot = assembleSnapshot({
        nodes: await settled(Promise.resolve([{ nodeUrl: "n", nodeId: "N1", data: {}, syncedAt: new Date() }])),
        relays: await settled(Promise.reject(relayFailure)),
        beacons: await settled(Promise.resolve([{ beaconContentId: "B1", nodeUrl: "n", data: {}, syncedAt: new Date() }])),
        drops: await settled(Promise.resolve([])),
      });

      expect(snapshot.nodes).toHaveLength(1);
      expect(snapshot.beacons).toHaveLength(1);
      expect(snapshot.relays).toEqual([]);
      expect(snapshot.errors).toEqual([{ section: "relays", message: "relays table unreachable" }]);
    });

    it("reports one error per failed section when multiple fail independently", async () => {
      const snapshot = assembleSnapshot({
        nodes: await settled(Promise.reject(new Error("nodes down"))),
        relays: await settled(Promise.reject(new Error("relays down"))),
        beacons: await settled(Promise.resolve([])),
        drops: await settled(Promise.resolve([])),
      });

      expect(snapshot.errors).toEqual([
        { section: "nodes", message: "nodes down" },
        { section: "relays", message: "relays down" },
      ]);
    });
  });
});

function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value): PromiseSettledResult<T> => ({ status: "fulfilled", value }),
    (reason): PromiseSettledResult<T> => ({ status: "rejected", reason }),
  );
}
