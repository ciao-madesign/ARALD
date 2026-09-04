import { describe, expect, it } from "vitest";
import { Drops, extractDropPayload, MAX_DROP_LABEL_LENGTH, type Drop, type DropPayload } from "../../node/src/drops.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";

function validPayload(overrides: Partial<DropPayload> = {}): DropPayload {
  return { text: "Frana sul sentiero", lat: 45.0, lon: 7.0, kind: "info", timestamp: Date.now(), ...overrides };
}

function drop(overrides: Partial<Drop> = {}): Drop {
  return { dropId: "id-1", author: "node-a", observedAt: Date.now(), ...validPayload(), ...overrides };
}

describe("extractDropPayload", () => {
  it("accepts a well-formed payload without a label", () => {
    const payload = validPayload();
    expect(extractDropPayload(payload)).toEqual(payload);
  });

  it("accepts a well-formed payload with a label", () => {
    const payload = validPayload({ label: "Pericolo" });
    expect(extractDropPayload(payload)).toEqual(payload);
  });

  it("rejects a missing/non-string/empty/oversized text, same bound as MAX_MESSAGE_TEXT_LENGTH everywhere else", () => {
    expect(extractDropPayload({ ...validPayload(), text: undefined })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), text: 123 })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), text: "" })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1) })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH) })).toBeDefined(); // exactly at the limit
  });

  it("rejects lat/lon out of range, non-number, or non-finite — same bounds as shareLocation()/location-registry.ts", () => {
    expect(extractDropPayload({ ...validPayload(), lat: 90.0001 })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), lat: -90.0001 })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), lon: 180.0001 })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), lon: -180.0001 })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), lat: "45" })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), lat: Number.NaN })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), lon: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), lat: 90, lon: 180 })).toBeDefined(); // exactly at the limits
    expect(extractDropPayload({ ...validPayload(), lat: -90, lon: -180 })).toBeDefined();
  });

  it("rejects a missing/non-string/empty/oversized label, but tolerates a fully absent one", () => {
    expect(extractDropPayload({ ...validPayload(), label: 123 })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), label: "" })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), label: "x".repeat(MAX_DROP_LABEL_LENGTH + 1) })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), label: "x".repeat(MAX_DROP_LABEL_LENGTH) })).toBeDefined(); // exactly at the limit
    expect(extractDropPayload(validPayload())).toBeDefined(); // no label field at all
  });

  it("rejects a missing/invalid kind, but accepts each of the three valid values", () => {
    expect(extractDropPayload({ ...validPayload(), kind: undefined })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), kind: true })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), kind: 1 })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), kind: "urgent" })).toBeUndefined(); // the old two-level name, no longer valid
    expect(extractDropPayload({ ...validPayload(), kind: "info" })).toBeDefined();
    expect(extractDropPayload({ ...validPayload(), kind: "hazard" })).toBeDefined();
    expect(extractDropPayload({ ...validPayload(), kind: "emergency" })).toBeDefined();
  });

  it("rejects a missing/non-number/non-finite timestamp", () => {
    expect(extractDropPayload({ ...validPayload(), timestamp: undefined })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), timestamp: "12345" })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), timestamp: Number.NaN })).toBeUndefined();
    expect(extractDropPayload({ ...validPayload(), timestamp: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("rejects a payload that isn't even an object, without throwing", () => {
    expect(extractDropPayload(undefined)).toBeUndefined();
    expect(extractDropPayload(null)).toBeUndefined();
    expect(extractDropPayload("drop")).toBeUndefined();
    expect(extractDropPayload(42)).toBeUndefined();
    expect(extractDropPayload(["drop"])).toBeUndefined();
  });
});

describe("Drops", () => {
  it("records and lists drops, newest first", () => {
    const drops = new Drops();
    drops.record(drop({ dropId: "1", timestamp: 100, text: "primo" }));
    drops.record(drop({ dropId: "2", timestamp: 300, text: "terzo" }));
    drops.record(drop({ dropId: "3", timestamp: 200, text: "secondo" }));

    expect(drops.list().map((d) => d.text)).toEqual(["terzo", "secondo", "primo"]);
  });

  it("list() returns an empty array when nothing has been recorded, never undefined/throwing", () => {
    expect(new Drops().list()).toEqual([]);
  });

  it("ignores a second record() for the same dropId — no duplicate entry", () => {
    // Realistic case: the same drop learned twice (once via CONTENT_ANNOUNCE, once via a racing
    // catalog sync) must not appear twice.
    const drops = new Drops();
    drops.record(drop({ dropId: "same-id", text: "hello" }));
    drops.record(drop({ dropId: "same-id", text: "hello" }));

    expect(drops.list()).toHaveLength(1);
  });

  it("a second record() for an already-known dropId never overwrites — the first receivedFrom/observedAt wins (regression, docs/security.md — mirrors the identical fix already applied to EmergencyBeacons.record())", () => {
    // Realistic case: the same drop is delivered twice via two different relay paths (e.g. once
    // directly via CONTENT_ANNOUNCE, once again via a racing catalog sync from a different peer) —
    // whichever delivery happens to be recorded *first* must keep credit for "who relayed this to me",
    // not whichever arrives last.
    const drops = new Drops();
    drops.record(drop({ dropId: "same-id", receivedFrom: "relay-a", observedAt: 100 }));
    drops.record(drop({ dropId: "same-id", receivedFrom: "relay-b", observedAt: 200 }));

    const stored = drops.list()[0];
    expect(stored.receivedFrom).toBe("relay-a");
    expect(stored.observedAt).toBe(100);
  });

  it("treats an expired drop as absent from list(), and evicts it lazily rather than on a timer", () => {
    const drops = new Drops();
    drops.record(drop({ dropId: "expired", expiresAt: Date.now() - 1000 }));
    drops.record(drop({ dropId: "live", expiresAt: Date.now() + 100000 }));

    const listed = drops.list();
    expect(listed.map((d) => d.dropId)).toEqual(["live"]);
  });

  it("treats a drop with no expiresAt as never expiring", () => {
    const drops = new Drops();
    drops.record(drop({ dropId: "forever", expiresAt: undefined }));
    expect(drops.list().map((d) => d.dropId)).toEqual(["forever"]);
  });

  it("evicts the oldest drop (plain FIFO) once maxDrops is exceeded, with no trustRank given", () => {
    const drops = new Drops({ maxDrops: 2 });
    drops.record(drop({ dropId: "1", timestamp: 1 }));
    drops.record(drop({ dropId: "2", timestamp: 2 }));
    drops.record(drop({ dropId: "3", timestamp: 3 })); // pushes out "1", the oldest

    const ids = drops.list().map((d) => d.dropId);
    expect(ids).toContain("2");
    expect(ids).toContain("3");
    expect(ids).not.toContain("1");
  });

  it("evicts by the trust of a drop's author instead of insertion order, when given a trustRank", () => {
    const trustScores: Record<string, number> = { "trusted-author": 10, "sketchy-author": 1 };
    const drops = new Drops({ maxDrops: 2, trustRank: (author) => trustScores[author] ?? 0 });
    drops.record(drop({ dropId: "1", author: "trusted-author", timestamp: 1 })); // oldest but most trusted — must survive
    drops.record(drop({ dropId: "2", author: "sketchy-author", timestamp: 2 }));
    drops.record(drop({ dropId: "3", author: "sketchy-author", timestamp: 3 })); // evicts "2" (lowest trust), not "1" (oldest)

    const ids = drops.list().map((d) => d.dropId);
    expect(ids).toContain("1");
    expect(ids).toContain("3");
    expect(ids).not.toContain("2");
  });
});
