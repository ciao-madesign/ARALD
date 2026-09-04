import { describe, expect, it } from "vitest";
import {
  EmergencyBeacons,
  extractEmergencyBeaconPayload,
  MAX_BEACON_MESSAGE_LENGTH,
  type EmergencyBeaconPayload,
  type EmergencyBeaconSighting,
} from "../../node/src/emergency-beacon.js";

function validPayload(overrides: Partial<EmergencyBeaconPayload> = {}): EmergencyBeaconPayload {
  return { message: "gamba rotta, non posso camminare", lat: 45.0, lon: 7.0, timestamp: Date.now(), ...overrides };
}

function sighting(overrides: Partial<EmergencyBeaconSighting> = {}): EmergencyBeaconSighting {
  return { beaconContentId: "id-1", deviceId: "device-a", observedAt: Date.now(), ...validPayload(), ...overrides };
}

describe("extractEmergencyBeaconPayload", () => {
  it("accepts a well-formed payload with message/lat/lon", () => {
    const payload = validPayload();
    expect(extractEmergencyBeaconPayload(payload)).toEqual(payload);
  });

  it("accepts a payload with only a timestamp — message/lat/lon are all optional (the Card has no GPS of its own)", () => {
    const payload: EmergencyBeaconPayload = { timestamp: Date.now() };
    expect(extractEmergencyBeaconPayload(payload)).toEqual({ message: undefined, lat: undefined, lon: undefined, timestamp: payload.timestamp });
  });

  it("rejects a non-string/empty/oversized message, but tolerates a fully absent one", () => {
    expect(extractEmergencyBeaconPayload({ ...validPayload(), message: 123 })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), message: "" })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), message: "x".repeat(MAX_BEACON_MESSAGE_LENGTH + 1) })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), message: "x".repeat(MAX_BEACON_MESSAGE_LENGTH) })).toBeDefined(); // exactly at the limit
    const { message, ...withoutMessage } = validPayload();
    expect(extractEmergencyBeaconPayload(withoutMessage)).toBeDefined();
  });

  it("rejects lat/lon out of range, non-number, or non-finite when present, but tolerates them fully absent", () => {
    expect(extractEmergencyBeaconPayload({ ...validPayload(), lat: 90.0001 })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), lat: -90.0001 })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), lon: 180.0001 })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), lon: -180.0001 })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), lat: "45" })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), lat: Number.NaN })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), lon: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), lat: 90, lon: 180 })).toBeDefined(); // exactly at the limits
    const { lat, lon, ...withoutPosition } = validPayload();
    expect(extractEmergencyBeaconPayload(withoutPosition)).toBeDefined();
  });

  it("rejects a missing/non-number/non-finite timestamp", () => {
    expect(extractEmergencyBeaconPayload({ ...validPayload(), timestamp: undefined })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), timestamp: "12345" })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), timestamp: Number.NaN })).toBeUndefined();
    expect(extractEmergencyBeaconPayload({ ...validPayload(), timestamp: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("rejects a payload that isn't even an object, without throwing", () => {
    expect(extractEmergencyBeaconPayload(undefined)).toBeUndefined();
    expect(extractEmergencyBeaconPayload(null)).toBeUndefined();
    expect(extractEmergencyBeaconPayload("sos")).toBeUndefined();
    expect(extractEmergencyBeaconPayload(42)).toBeUndefined();
    expect(extractEmergencyBeaconPayload(["sos"])).toBeUndefined();
  });
});

describe("EmergencyBeacons", () => {
  it("records and lists sightings, newest first", () => {
    const beacons = new EmergencyBeacons();
    beacons.record(sighting({ beaconContentId: "1", observedAt: 100 }));
    beacons.record(sighting({ beaconContentId: "2", observedAt: 300 }));
    beacons.record(sighting({ beaconContentId: "3", observedAt: 200 }));

    expect(beacons.list().map((s) => s.beaconContentId)).toEqual(["2", "3", "1"]);
  });

  it("list() returns an empty array when nothing has been recorded, never undefined/throwing", () => {
    expect(new EmergencyBeacons().list()).toEqual([]);
  });

  it("ignores a second record() for the same beaconContentId — never overwrites the original sighting (receivedFrom/observedAt included)", () => {
    const beacons = new EmergencyBeacons();
    beacons.record(sighting({ beaconContentId: "same-id", observedAt: 100, receivedFrom: "relay-a" }));
    beacons.record(sighting({ beaconContentId: "same-id", observedAt: 999, receivedFrom: "relay-b" }));

    const listed = beacons.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].observedAt).toBe(100);
    expect(listed[0].receivedFrom).toBe("relay-a");
  });

  it("never expires a sighting on its own — no lazy expiry, unlike Drops/LocationRegistry", async () => {
    const beacons = new EmergencyBeacons();
    beacons.record(sighting({ beaconContentId: "old", observedAt: Date.now() - 365 * 24 * 60 * 60 * 1000 }));
    expect(beacons.list().map((s) => s.beaconContentId)).toContain("old");
  });

  it("evicts the oldest sighting (plain FIFO) once maxBeacons is exceeded — no trustRank, by design (a throwaway identity is the expected case here)", () => {
    const beacons = new EmergencyBeacons({ maxBeacons: 2 });
    beacons.record(sighting({ beaconContentId: "1", observedAt: 1 }));
    beacons.record(sighting({ beaconContentId: "2", observedAt: 2 }));
    beacons.record(sighting({ beaconContentId: "3", observedAt: 3 })); // pushes out "1", the oldest

    const ids = beacons.list().map((s) => s.beaconContentId);
    expect(ids).toContain("2");
    expect(ids).toContain("3");
    expect(ids).not.toContain("1");
  });
});
