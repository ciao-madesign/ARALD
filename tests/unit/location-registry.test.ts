import { describe, expect, it, vi } from "vitest";
import { LocationRegistry, extractLocationReport, type LocationReportPayload } from "../../node/src/location-registry.js";

function validReport(overrides: Partial<LocationReportPayload> = {}): LocationReportPayload {
  return { type: "location-report", lat: 45.4642, lon: 9.19, accuracy: 12, timestamp: Date.now(), ...overrides };
}

describe("extractLocationReport", () => {
  it("accepts a well-formed report, including one without accuracy", () => {
    const report = validReport();
    expect(extractLocationReport(report)).toEqual(report);
    const { accuracy: _accuracy, ...withoutAccuracy } = report;
    expect(extractLocationReport(withoutAccuracy)).toEqual({ ...withoutAccuracy, accuracy: undefined });
  });

  it("rejects a non-object payload without throwing", () => {
    expect(extractLocationReport(undefined)).toBeUndefined();
    expect(extractLocationReport(null)).toBeUndefined();
    expect(extractLocationReport("nope")).toBeUndefined();
    expect(extractLocationReport(42)).toBeUndefined();
  });

  it("rejects a wrong or missing type discriminator — this is what tells it apart from a plain chat message or a group invite", () => {
    expect(extractLocationReport({ ...validReport(), type: "chat" })).toBeUndefined();
    const { type: _type, ...withoutType } = validReport();
    expect(extractLocationReport(withoutType)).toBeUndefined();
  });

  it("rejects an out-of-range or non-finite lat", () => {
    expect(extractLocationReport(validReport({ lat: 90.0001 }))).toBeUndefined();
    expect(extractLocationReport(validReport({ lat: -90.0001 }))).toBeUndefined();
    expect(extractLocationReport(validReport({ lat: Number.NaN }))).toBeUndefined();
    expect(extractLocationReport(validReport({ lat: Number.POSITIVE_INFINITY }))).toBeUndefined();
    expect(extractLocationReport(validReport({ lat: "45" as unknown as number }))).toBeUndefined();
    expect(extractLocationReport(validReport({ lat: 90 }))).toBeDefined(); // exactly at the limit
    expect(extractLocationReport(validReport({ lat: -90 }))).toBeDefined();
  });

  it("rejects an out-of-range or non-finite lon", () => {
    expect(extractLocationReport(validReport({ lon: 180.0001 }))).toBeUndefined();
    expect(extractLocationReport(validReport({ lon: -180.0001 }))).toBeUndefined();
    expect(extractLocationReport(validReport({ lon: Number.NaN }))).toBeUndefined();
    expect(extractLocationReport(validReport({ lon: 180 }))).toBeDefined();
    expect(extractLocationReport(validReport({ lon: -180 }))).toBeDefined();
  });

  it("rejects a negative or non-numeric accuracy, but allows it to be omitted entirely", () => {
    expect(extractLocationReport(validReport({ accuracy: -1 }))).toBeUndefined();
    expect(extractLocationReport(validReport({ accuracy: Number.NaN }))).toBeUndefined();
    expect(extractLocationReport(validReport({ accuracy: "12" as unknown as number }))).toBeUndefined();
    expect(extractLocationReport(validReport({ accuracy: 0 }))).toBeDefined(); // zero is a valid (if unusual) accuracy
  });

  it("rejects a missing or non-finite timestamp", () => {
    expect(extractLocationReport(validReport({ timestamp: "yesterday" as unknown as number }))).toBeUndefined();
    expect(extractLocationReport(validReport({ timestamp: Number.NaN }))).toBeUndefined();
  });

  it("ignores extra fields on the payload", () => {
    const report = validReport();
    expect(extractLocationReport({ ...report, extra: "field" })).toEqual(report);
  });
});

describe("LocationRegistry", () => {
  it("record()/get() round-trip", () => {
    const registry = new LocationRegistry();
    registry.record("node-a", validReport({ lat: 45.5, lon: 9.2, timestamp: 100 }));
    expect(registry.get("node-a")).toEqual({ reporterId: "node-a", lat: 45.5, lon: 9.2, accuracy: 12, timestamp: 100 });
  });

  it("get() returns undefined for a reporter never recorded", () => {
    const registry = new LocationRegistry();
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("a second record() from the same reporter overwrites the previous report — never accumulates a history", () => {
    const registry = new LocationRegistry();
    registry.record("node-a", validReport({ lat: 45.0, lon: 9.0, timestamp: 100 }));
    registry.record("node-a", validReport({ lat: 46.0, lon: 10.0, timestamp: 200 }));

    expect(registry.get("node-a")).toEqual({ reporterId: "node-a", lat: 46.0, lon: 10.0, accuracy: 12, timestamp: 200 });
    expect(registry.list()).toHaveLength(1);
  });

  it("list() reflects only reporters actually recorded", () => {
    const registry = new LocationRegistry();
    expect(registry.list()).toEqual([]);
    registry.record("node-a", validReport({ timestamp: 1 }));
    registry.record("node-b", validReport({ timestamp: 2 }));
    expect(registry.list().map((r) => r.reporterId).sort()).toEqual(["node-a", "node-b"]);
  });

  it("ignores a record() with a timestamp older than or equal to the one already on file — a delayed, out-of-order store-and-forward delivery never regresses an already-recorded newer report", () => {
    // Regression: found by review — a report queued by store-and-forward (no route yet) can be
    // relayed and arrive after a later report the same sender already delivered via a faster path.
    // Without this guard the stale delivery would silently overwrite the newer, already-stored one.
    const registry = new LocationRegistry();
    registry.record("node-a", validReport({ lat: 46.0, lon: 10.0, timestamp: 200 }));
    registry.record("node-a", validReport({ lat: 1.0, lon: 1.0, timestamp: 100 })); // older — must be ignored
    expect(registry.get("node-a")).toMatchObject({ lat: 46.0, lon: 10.0, timestamp: 200 });

    registry.record("node-a", validReport({ lat: 2.0, lon: 2.0, timestamp: 200 })); // same timestamp — also ignored
    expect(registry.get("node-a")).toMatchObject({ lat: 46.0, lon: 10.0, timestamp: 200 });

    registry.record("node-a", validReport({ lat: 47.0, lon: 11.0, timestamp: 201 })); // genuinely newer — accepted
    expect(registry.get("node-a")).toMatchObject({ lat: 47.0, lon: 11.0, timestamp: 201 });
  });

  it("clamps a fabricated far-future timestamp to now, instead of letting it permanently poison the reporter's slot", () => {
    // Regression: found by review — the ordering guard above (record() rejects anything not newer
    // than what's on file) means a single report bearing a fake far-future timestamp would otherwise
    // never be beaten by any honest future record(), and isExpired()'s Date.now() - timestamp would
    // stay negative forever, so maxReportAgeMs could never reclaim it either — permanently stuck.
    // Fake timers used deliberately (not real Date.now() calls back to back) so the two record()
    // calls below land at deterministically distinct millisecond values — real-clock timing made this
    // flaky (found while verifying the fix): two synchronous statements can share the same
    // millisecond, at which point the clamped timestamps tie and the second call is correctly (but
    // then untestably) rejected by the ordering guard itself rather than by what this test means to
    // exercise.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const registry = new LocationRegistry({ maxReportAgeMs: 1000 });
      const farFuture = 1000 + 1000 * 60 * 60 * 24 * 365; // a year past "now"
      registry.record("node-a", validReport({ lat: 1, lon: 1, timestamp: farFuture }));
      expect(registry.get("node-a")?.timestamp).toBe(1000); // clamped to "now" at record time, not stored as-is

      vi.setSystemTime(2000); // time genuinely advances
      registry.record("node-a", validReport({ lat: 2, lon: 2, timestamp: 2000 }));
      expect(registry.get("node-a")).toMatchObject({ lat: 2, lon: 2, timestamp: 2000 }); // the poisoned slot is not stuck
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest reporter (plain FIFO) once maxReports is exceeded, with no trustRank given", () => {
    const registry = new LocationRegistry({ maxReports: 2 });
    registry.record("a", validReport());
    registry.record("b", validReport());
    registry.record("c", validReport()); // pushes out "a"

    expect(registry.get("a")).toBeUndefined();
    expect(registry.get("b")).toBeDefined();
    expect(registry.get("c")).toBeDefined();
  });

  it("evicts by the trust of the reporter, when given a trustRank", () => {
    const trustScores: Record<string, number> = { "trusted-reporter": 10, "sketchy-reporter": 1 };
    const registry = new LocationRegistry({ maxReports: 2, trustRank: (reporterId) => trustScores[reporterId] ?? 0 });
    registry.record("trusted-reporter", validReport()); // must survive despite being oldest
    registry.record("sketchy-reporter", validReport());
    registry.record("another-sketchy", validReport()); // evicts sketchy-reporter (lowest score), not trusted-reporter

    expect(registry.get("trusted-reporter")).toBeDefined();
    expect(registry.get("sketchy-reporter")).toBeUndefined();
    expect(registry.get("another-sketchy")).toBeDefined();
  });

  it("updating an existing reporter's report never evicts another reporter, even at capacity", () => {
    const registry = new LocationRegistry({ maxReports: 2 });
    registry.record("a", validReport({ timestamp: 1 }));
    registry.record("b", validReport({ timestamp: 1 }));
    registry.record("a", validReport({ lat: 1, timestamp: Date.now() })); // genuinely newer than "1" — a real update, not ignored

    expect(registry.get("a")).toMatchObject({ lat: 1 }); // proves the update was actually applied, not just a no-op that happened to pass
    expect(registry.get("a")).toBeDefined();
    expect(registry.get("b")).toBeDefined();
  });

  it("get() and list() treat a report older than maxReportAgeMs as absent, and lazily evict it — never a background sweep timer", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const registry = new LocationRegistry({ maxReportAgeMs: 1000 });
      registry.record("a", validReport({ timestamp: Date.now() }));
      expect(registry.get("a")).toBeDefined();

      vi.setSystemTime(1001);
      expect(registry.get("a")).toBeUndefined();
      expect(registry.list()).toEqual([]);

      // A fresh record() for the same reporter after expiry is a normal write, not blocked by the
      // now-evicted stale entry.
      registry.record("a", validReport({ timestamp: Date.now() }));
      expect(registry.get("a")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never expires a report when maxReportAgeMs is omitted", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const registry = new LocationRegistry();
      registry.record("a", validReport({ timestamp: Date.now() }));
      vi.setSystemTime(1000 * 60 * 60 * 24 * 365); // a full year later
      expect(registry.get("a")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
