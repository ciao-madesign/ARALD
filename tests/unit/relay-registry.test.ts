import { describe, expect, it, vi } from "vitest";
import {
  RelayRegistry,
  extractRelayRegistration,
  extractRelayTelemetry,
  extractRelayCommand,
  MAX_RELAY_OPERATOR_LENGTH,
  type RelayStaticFields,
  type RelayTelemetryPayload,
} from "../../node/src/relay-registry.js";

function validFields(overrides: Partial<RelayStaticFields> = {}): RelayStaticFields {
  return { relayId: "relay-a", type: "fixed", lat: 45.4642, lon: 9.19, radio: { ble: true, lora: false }, operator: "Soccorso Alpino", installedAt: 1000, ...overrides };
}

describe("extractRelayRegistration", () => {
  it("accepts a well-formed registration, including one with only the required fields", () => {
    const fields = validFields();
    expect(extractRelayRegistration(fields)).toEqual(fields);
    expect(extractRelayRegistration({ relayId: "relay-b", type: "mobile", lat: 1, lon: 1 })).toEqual({
      relayId: "relay-b",
      type: "mobile",
      lat: 1,
      lon: 1,
      radio: undefined,
      operator: undefined,
      installedAt: undefined,
    });
  });

  it("rejects a non-object payload without throwing", () => {
    expect(extractRelayRegistration(undefined)).toBeUndefined();
    expect(extractRelayRegistration(null)).toBeUndefined();
    expect(extractRelayRegistration("nope")).toBeUndefined();
    expect(extractRelayRegistration(42)).toBeUndefined();
  });

  it("rejects a missing, empty, or over-long relayId", () => {
    const { relayId: _relayId, ...withoutRelayId } = validFields();
    expect(extractRelayRegistration(withoutRelayId)).toBeUndefined();
    expect(extractRelayRegistration(validFields({ relayId: "" }))).toBeUndefined();
    expect(extractRelayRegistration(validFields({ relayId: "x".repeat(201) }))).toBeUndefined();
    expect(extractRelayRegistration(validFields({ relayId: "x".repeat(200) }))).toBeDefined(); // exactly at the limit
  });

  it("rejects a type that isn't exactly 'fixed' or 'mobile'", () => {
    expect(extractRelayRegistration(validFields({ type: "portable" as unknown as "fixed" }))).toBeUndefined();
    expect(extractRelayRegistration({ ...validFields(), type: undefined })).toBeUndefined();
  });

  it("rejects an out-of-range or non-finite lat/lon", () => {
    expect(extractRelayRegistration(validFields({ lat: 90.0001 }))).toBeUndefined();
    expect(extractRelayRegistration(validFields({ lat: Number.NaN }))).toBeUndefined();
    expect(extractRelayRegistration(validFields({ lon: 180.0001 }))).toBeUndefined();
    expect(extractRelayRegistration(validFields({ lat: 90, lon: 180 }))).toBeDefined(); // exactly at the limits
  });

  it("rejects a malformed radio object but allows it to be omitted entirely", () => {
    expect(extractRelayRegistration({ ...validFields(), radio: "yes" as unknown as object })).toBeUndefined();
    expect(extractRelayRegistration({ ...validFields(), radio: { ble: "yes" as unknown as boolean } })).toBeUndefined();
    const { radio: _radio, ...withoutRadio } = validFields();
    expect(extractRelayRegistration(withoutRadio)?.radio).toBeUndefined();
  });

  it("rejects an operator that's empty, non-string, or over MAX_RELAY_OPERATOR_LENGTH, but allows it to be omitted", () => {
    expect(extractRelayRegistration(validFields({ operator: "" }))).toBeUndefined();
    expect(extractRelayRegistration(validFields({ operator: "x".repeat(MAX_RELAY_OPERATOR_LENGTH + 1) }))).toBeUndefined();
    expect(extractRelayRegistration(validFields({ operator: "x".repeat(MAX_RELAY_OPERATOR_LENGTH) }))).toBeDefined();
    const { operator: _operator, ...withoutOperator } = validFields();
    expect(extractRelayRegistration(withoutOperator)?.operator).toBeUndefined();
  });

  it("rejects a non-finite installedAt but allows it to be omitted", () => {
    expect(extractRelayRegistration(validFields({ installedAt: Number.NaN }))).toBeUndefined();
    expect(extractRelayRegistration(validFields({ installedAt: "yesterday" as unknown as number }))).toBeUndefined();
    const { installedAt: _installedAt, ...withoutInstalledAt } = validFields();
    expect(extractRelayRegistration(withoutInstalledAt)?.installedAt).toBeUndefined();
  });

  it("ignores extra fields on the payload", () => {
    const fields = validFields();
    expect(extractRelayRegistration({ ...fields, extra: "field" })).toEqual(fields);
  });
});

describe("RelayRegistry", () => {
  it("upsert()/get() round-trip, applying defaults for omitted radio/installedAt", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(500);
      const registry = new RelayRegistry();
      registry.upsert({ relayId: "relay-a", type: "fixed", lat: 45, lon: 9 });
      expect(registry.get("relay-a")).toEqual({
        relayId: "relay-a",
        type: "fixed",
        lat: 45,
        lon: 9,
        radio: { ble: false, lora: false },
        operator: undefined,
        installedAt: 500, // defaulted to "now" at registration time
        online: false,
        lastSeenAt: undefined,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("get() returns undefined for a relay never registered", () => {
    const registry = new RelayRegistry();
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("re-registering an existing relay updates its static fields without resetting online/lastSeenAt", () => {
    const registry = new RelayRegistry();
    registry.upsert(validFields({ relayId: "relay-a", lat: 45, lon: 9 }));
    registry.markOnline("relay-a", 1234);

    registry.upsert(validFields({ relayId: "relay-a", lat: 46, lon: 10 })); // moved
    const entry = registry.get("relay-a");
    expect(entry).toMatchObject({ lat: 46, lon: 10, online: true, lastSeenAt: 1234 });
  });

  it("markOnline()/markOffline() are no-ops for a relayId that isn't registered", () => {
    const registry = new RelayRegistry();
    registry.markOnline("never-registered", 1);
    registry.markOffline("never-registered", 1);
    expect(registry.get("never-registered")).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("markOnline() sets online: true and updates lastSeenAt", () => {
    const registry = new RelayRegistry();
    registry.upsert(validFields({ relayId: "relay-a" }));
    registry.markOnline("relay-a", 100);
    expect(registry.get("relay-a")).toMatchObject({ online: true, lastSeenAt: 100 });
  });

  it("markOffline() sets online: false but still advances lastSeenAt — the disconnect moment is itself real, recent contact", () => {
    const registry = new RelayRegistry();
    registry.upsert(validFields({ relayId: "relay-a" }));
    registry.markOnline("relay-a", 100);
    registry.markOffline("relay-a", 200);
    expect(registry.get("relay-a")).toMatchObject({ online: false, lastSeenAt: 200 });
  });

  it("list() reflects only relays actually registered, and never expires an entry with the passage of time", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const registry = new RelayRegistry();
      expect(registry.list()).toEqual([]);
      registry.upsert(validFields({ relayId: "relay-a" }));
      registry.upsert(validFields({ relayId: "relay-b" }));

      vi.setSystemTime(1000 * 60 * 60 * 24 * 365); // a full year later — a physical installation doesn't go stale
      expect(registry.list().map((r) => r.relayId).sort()).toEqual(["relay-a", "relay-b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest relay (plain FIFO) once maxRelays is exceeded", () => {
    const registry = new RelayRegistry({ maxRelays: 2 });
    registry.upsert(validFields({ relayId: "a" }));
    registry.upsert(validFields({ relayId: "b" }));
    registry.upsert(validFields({ relayId: "c" })); // pushes out "a"

    expect(registry.get("a")).toBeUndefined();
    expect(registry.get("b")).toBeDefined();
    expect(registry.get("c")).toBeDefined();
  });

  it("re-registering an existing relay never evicts another relay, even at capacity", () => {
    const registry = new RelayRegistry({ maxRelays: 2 });
    registry.upsert(validFields({ relayId: "a", lat: 1, lon: 1 }));
    registry.upsert(validFields({ relayId: "b", lat: 2, lon: 2 }));
    registry.upsert(validFields({ relayId: "a", lat: 3, lon: 3 })); // update, not a new key

    expect(registry.get("a")).toMatchObject({ lat: 3, lon: 3 });
    expect(registry.get("b")).toBeDefined();
  });

  it("re-registering an existing relay never discards previously recorded telemetry (found by review — upsert() used to rebuild the entry from fields alone)", () => {
    const registry = new RelayRegistry();
    registry.upsert(validFields({ relayId: "relay-a" }));
    registry.recordTelemetry("relay-a", { type: "relay-telemetry", batteryPercent: 77, timestamp: 500 });
    expect(registry.get("relay-a")).toMatchObject({ batteryPercent: 77, lastTelemetryAt: 500 });

    // An ordinary re-registration, e.g. the operator correcting the operator label — must not wipe
    // the telemetry already on file.
    registry.upsert(validFields({ relayId: "relay-a", operator: "Corrected Name" }));
    expect(registry.get("relay-a")).toMatchObject({ operator: "Corrected Name", batteryPercent: 77, lastTelemetryAt: 500 });
  });

  describe("recordTelemetry()", () => {
    it("is a no-op for a relayId that isn't already registered — never creates a new entry", () => {
      const registry = new RelayRegistry();
      registry.recordTelemetry("never-registered", { type: "relay-telemetry", batteryPercent: 50, timestamp: 1 });
      expect(registry.get("never-registered")).toBeUndefined();
      expect(registry.list()).toEqual([]);
    });

    it("updates batteryPercent/lastTelemetryAt on an already-registered relay", () => {
      const registry = new RelayRegistry();
      registry.upsert(validFields({ relayId: "relay-a" }));
      registry.recordTelemetry("relay-a", { type: "relay-telemetry", batteryPercent: 72, timestamp: 100 });
      expect(registry.get("relay-a")).toMatchObject({ batteryPercent: 72, lastTelemetryAt: 100 });
    });

    it("ignores a report no newer than the currently recorded one — same anti-out-of-order guard as LocationRegistry.record()", () => {
      const registry = new RelayRegistry();
      registry.upsert(validFields({ relayId: "relay-a" }));
      registry.recordTelemetry("relay-a", { type: "relay-telemetry", batteryPercent: 50, timestamp: 100 });
      registry.recordTelemetry("relay-a", { type: "relay-telemetry", batteryPercent: 10, timestamp: 100 }); // same timestamp
      registry.recordTelemetry("relay-a", { type: "relay-telemetry", batteryPercent: 5, timestamp: 50 }); // older
      expect(registry.get("relay-a")).toMatchObject({ batteryPercent: 50, lastTelemetryAt: 100 });

      registry.recordTelemetry("relay-a", { type: "relay-telemetry", batteryPercent: 40, timestamp: 200 }); // genuinely newer
      expect(registry.get("relay-a")).toMatchObject({ batteryPercent: 40, lastTelemetryAt: 200 });
    });

    it("clamps a future-dated timestamp to Date.now() — a fabricated far-future report can't permanently poison the slot", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1000);
        const registry = new RelayRegistry();
        registry.upsert(validFields({ relayId: "relay-a" }));
        registry.recordTelemetry("relay-a", { type: "relay-telemetry", batteryPercent: 99, timestamp: 999_999_999 });
        expect(registry.get("relay-a")).toMatchObject({ batteryPercent: 99, lastTelemetryAt: 1000 });

        vi.setSystemTime(2000);
        registry.recordTelemetry("relay-a", { type: "relay-telemetry", batteryPercent: 42, timestamp: 2000 });
        expect(registry.get("relay-a")).toMatchObject({ batteryPercent: 42, lastTelemetryAt: 2000 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("never overwrites online/lastSeenAt or the static fields — only the telemetry fields change", () => {
      const registry = new RelayRegistry();
      registry.upsert(validFields({ relayId: "relay-a", operator: "Soccorso Alpino" }));
      registry.markOnline("relay-a", 5);
      registry.recordTelemetry("relay-a", { type: "relay-telemetry", batteryPercent: 60, timestamp: 10 });
      expect(registry.get("relay-a")).toMatchObject({ operator: "Soccorso Alpino", online: true, lastSeenAt: 5, batteryPercent: 60 });
    });
  });
});

function validTelemetry(overrides: Partial<RelayTelemetryPayload> = {}): RelayTelemetryPayload {
  return { type: "relay-telemetry", batteryPercent: 55, timestamp: 1000, ...overrides };
}

describe("extractRelayTelemetry", () => {
  it("accepts a well-formed telemetry payload", () => {
    expect(extractRelayTelemetry(validTelemetry())).toEqual(validTelemetry());
  });

  it("rejects a non-object payload without throwing", () => {
    expect(extractRelayTelemetry(undefined)).toBeUndefined();
    expect(extractRelayTelemetry(null)).toBeUndefined();
    expect(extractRelayTelemetry("nope")).toBeUndefined();
    expect(extractRelayTelemetry(42)).toBeUndefined();
  });

  it("rejects a wrong/missing type discriminator", () => {
    expect(extractRelayTelemetry({ ...validTelemetry(), type: "location-report" })).toBeUndefined();
    const { type: _type, ...withoutType } = validTelemetry();
    expect(extractRelayTelemetry(withoutType)).toBeUndefined();
  });

  it("rejects an out-of-range or non-finite batteryPercent", () => {
    expect(extractRelayTelemetry(validTelemetry({ batteryPercent: -0.001 }))).toBeUndefined();
    expect(extractRelayTelemetry(validTelemetry({ batteryPercent: 100.001 }))).toBeUndefined();
    expect(extractRelayTelemetry(validTelemetry({ batteryPercent: Number.NaN }))).toBeUndefined();
    expect(extractRelayTelemetry({ ...validTelemetry(), batteryPercent: "50" as unknown as number })).toBeUndefined();
    expect(extractRelayTelemetry(validTelemetry({ batteryPercent: 0 }))).toBeDefined(); // exactly at the lower limit
    expect(extractRelayTelemetry(validTelemetry({ batteryPercent: 100 }))).toBeDefined(); // exactly at the upper limit
  });

  it("rejects a missing/non-finite timestamp", () => {
    expect(extractRelayTelemetry({ ...validTelemetry(), timestamp: undefined })).toBeUndefined();
    expect(extractRelayTelemetry(validTelemetry({ timestamp: Number.NaN }))).toBeUndefined();
  });

  it("ignores extra fields on the payload", () => {
    expect(extractRelayTelemetry({ ...validTelemetry(), extra: "field" })).toEqual(validTelemetry());
  });
});

describe("extractRelayCommand", () => {
  it("accepts a well-formed reboot command", () => {
    const command = { type: "relay-command" as const, command: "reboot" as const, timestamp: 1000 };
    expect(extractRelayCommand(command)).toEqual(command);
  });

  it("rejects a non-object payload without throwing", () => {
    expect(extractRelayCommand(undefined)).toBeUndefined();
    expect(extractRelayCommand(null)).toBeUndefined();
    expect(extractRelayCommand("nope")).toBeUndefined();
    expect(extractRelayCommand(42)).toBeUndefined();
  });

  it("rejects a wrong/missing type discriminator", () => {
    expect(extractRelayCommand({ type: "relay-telemetry", command: "reboot", timestamp: 1 })).toBeUndefined();
    expect(extractRelayCommand({ command: "reboot", timestamp: 1 })).toBeUndefined();
  });

  it("rejects any command other than exactly 'reboot' — forward-compatible rejection, not a crash on an unrecognized future value", () => {
    expect(extractRelayCommand({ type: "relay-command", command: "shutdown", timestamp: 1 })).toBeUndefined();
    expect(extractRelayCommand({ type: "relay-command", command: "", timestamp: 1 })).toBeUndefined();
    expect(extractRelayCommand({ type: "relay-command", timestamp: 1 })).toBeUndefined();
  });

  it("rejects a missing/non-finite timestamp", () => {
    expect(extractRelayCommand({ type: "relay-command", command: "reboot", timestamp: undefined })).toBeUndefined();
    expect(extractRelayCommand({ type: "relay-command", command: "reboot", timestamp: Number.NaN })).toBeUndefined();
  });
});
