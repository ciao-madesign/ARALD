import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { buildEmergencyBeaconPacket, MAX_SOS_MESSAGE_LENGTH } from "../../mobile/www/ble-sos.js";
import { loadOrCreateIdentity } from "../../mobile/www/ble-identity.js";
import { verifyContentSignature, computeContentId } from "../../node/src/content.js";
import { extractEmergencyBeaconPayload } from "../../node/src/emergency-beacon.js";

beforeAll(() => {
  const require = createRequire(import.meta.url);
  (globalThis as unknown as { nacl: unknown }).nacl = require("../../mobile/www/vendor/nacl.js");
});

class FakeStorage {
  #map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
}

function identity() {
  return loadOrCreateIdentity(new FakeStorage());
}

describe("mobile/www/ble-sos (phone-originated SOS packet construction)", () => {
  it("builds a CONTENT_ANNOUNCE packet at Priority.EMERGENCY, ttl=8, source=identity.nodeId", () => {
    const id = identity();
    const packet = buildEmergencyBeaconPacket({ message: "aiuto" }, id);
    expect(packet.type).toBe("CONTENT_ANNOUNCE");
    expect(packet.priority).toBe(0);
    expect(packet.ttl).toBe(8);
    expect(packet.source).toBe(id.nodeId);
    expect(typeof packet.id).toBe("string");
  });

  it("the metadata passes verifyContentSignature() for real — the core interop claim of this piece", () => {
    const packet = buildEmergencyBeaconPacket({ message: "gamba rotta" }, identity());
    expect(verifyContentSignature(packet.payload.metadata)).toBe(true);
  });

  it("the inline data's contentId matches computeContentId() of the actual bytes", () => {
    const packet = buildEmergencyBeaconPacket({ message: "test" }, identity());
    const bytes = Buffer.from(packet.payload.data, "base64");
    expect(packet.payload.metadata.contentId).toBe(computeContentId(bytes));
  });

  it("the decoded data passes extractEmergencyBeaconPayload() with the right message/lat/lon", () => {
    const packet = buildEmergencyBeaconPacket({ message: "valanga, siamo bloccati", lat: 46.5, lon: 11.3 }, identity());
    const bytes = Buffer.from(packet.payload.data, "base64");
    const parsed = JSON.parse(bytes.toString("utf8"));
    const extracted = extractEmergencyBeaconPayload(parsed);
    expect(extracted).toBeDefined();
    expect(extracted!.message).toBe("valanga, siamo bloccati");
    expect(extracted!.lat).toBe(46.5);
    expect(extracted!.lon).toBe(11.3);
  });

  it("a message right at MAX_SOS_MESSAGE_LENGTH is accepted end-to-end (matches the mesh-wide MAX_BEACON_MESSAGE_LENGTH, not silently dropped)", () => {
    const message = "x".repeat(MAX_SOS_MESSAGE_LENGTH);
    const packet = buildEmergencyBeaconPacket({ message }, identity());
    expect(verifyContentSignature(packet.payload.metadata)).toBe(true);
    const bytes = Buffer.from(packet.payload.data, "base64");
    const extracted = extractEmergencyBeaconPayload(JSON.parse(bytes.toString("utf8")));
    expect(extracted?.message).toBe(message);
  });

  it("rejects a message longer than MAX_SOS_MESSAGE_LENGTH", () => {
    expect(() => buildEmergencyBeaconPacket({ message: "x".repeat(MAX_SOS_MESSAGE_LENGTH + 1) }, identity())).toThrow();
  });

  it("rejects an empty message", () => {
    expect(() => buildEmergencyBeaconPacket({ message: "" }, identity())).toThrow();
  });

  it("rejects out-of-range lat/lon", () => {
    expect(() => buildEmergencyBeaconPacket({ lat: 91 }, identity())).toThrow();
    expect(() => buildEmergencyBeaconPacket({ lon: -181 }, identity())).toThrow();
    expect(() => buildEmergencyBeaconPacket({ lat: Number.NaN }, identity())).toThrow();
  });

  it("rejects a non-positive ttlMs", () => {
    expect(() => buildEmergencyBeaconPacket({ ttlMs: 0 }, identity())).toThrow();
    expect(() => buildEmergencyBeaconPacket({ ttlMs: -1 }, identity())).toThrow();
  });

  it("works with no fields at all (message/lat/lon all optional)", () => {
    const packet = buildEmergencyBeaconPacket({}, identity());
    expect(verifyContentSignature(packet.payload.metadata)).toBe(true);
  });

  it("defaults to a 24h expiry when ttlMs is not given, and caps a longer one at 72h — a phone-originated SOS's content never lives forever by omission, same as a Card-originated one", () => {
    const now = Date.now();
    const defaultPacket = buildEmergencyBeaconPacket({}, identity());
    const defaultExpiresAt = defaultPacket.payload.metadata.expiresAt as number;
    expect(defaultExpiresAt).toBeGreaterThan(now + 23 * 60 * 60 * 1000);
    expect(defaultExpiresAt).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000 + 1000);

    const cappedPacket = buildEmergencyBeaconPacket({ ttlMs: 1000 * 60 * 60 * 24 * 365 }, identity());
    const cappedExpiresAt = cappedPacket.payload.metadata.expiresAt as number;
    expect(cappedExpiresAt).toBeLessThanOrEqual(now + 72 * 60 * 60 * 1000 + 1000);
  });

  it("has no senderAnnouncement field — explicitly out of scope for this piece", () => {
    const packet = buildEmergencyBeaconPacket({ message: "test" }, identity());
    expect((packet.payload as Record<string, unknown>).senderAnnouncement).toBeUndefined();
  });

  it("two calls produce different packet ids (never reused across separate SOS presses)", () => {
    const id = identity();
    const a = buildEmergencyBeaconPacket({ message: "a" }, id);
    const b = buildEmergencyBeaconPacket({ message: "b" }, id);
    expect(a.id).not.toBe(b.id);
  });
});
