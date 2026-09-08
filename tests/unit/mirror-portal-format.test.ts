import { describe, expect, it } from "vitest";
import {
  beaconMessage,
  dropKind,
  formatCoords,
  nodeDisplayName,
  relayOnline,
  relayType,
} from "../../mirror-portal/lib/format.js";

describe("mirror-portal/lib/format", () => {
  describe("nodeDisplayName", () => {
    it("uses displayName when present", () => {
      expect(nodeDisplayName({ displayName: "Rifugio Test" }, "N1")).toBe("Rifugio Test");
    });
    it("falls back to the raw node id when displayName is missing or not a string", () => {
      expect(nodeDisplayName({}, "N1")).toBe("N1");
      expect(nodeDisplayName({ displayName: 42 }, "N1")).toBe("N1");
    });
  });

  describe("formatCoords", () => {
    it("formats both coordinates to 4 decimals when both are present", () => {
      expect(formatCoords({ lat: 45.83, lon: 7.65 })).toBe("45.8300, 7.6500");
    });
    it("returns undefined when either coordinate is missing", () => {
      expect(formatCoords({ lat: 45.83 })).toBeUndefined();
      expect(formatCoords({ lon: 7.65 })).toBeUndefined();
      expect(formatCoords({})).toBeUndefined();
    });
    it("returns undefined rather than a misleading partial pair when a coordinate is non-finite", () => {
      expect(formatCoords({ lat: Number.NaN, lon: 7.65 })).toBeUndefined();
      expect(formatCoords({ lat: 45.83, lon: "7.65" })).toBeUndefined();
    });
  });

  describe("beaconMessage", () => {
    it("returns the message when present", () => {
      expect(beaconMessage({ message: "aiuto" })).toBe("aiuto");
    });
    it("labels the absence rather than fabricating placeholder content", () => {
      expect(beaconMessage({})).toBe("(nessun messaggio)");
    });
  });

  describe("dropKind", () => {
    it("passes through a recognized kind", () => {
      expect(dropKind({ kind: "hazard" })).toBe("hazard");
      expect(dropKind({ kind: "emergency" })).toBe("emergency");
      expect(dropKind({ kind: "info" })).toBe("info");
    });
    it("degrades an unrecognized or missing kind to info, never a fabricated severity", () => {
      expect(dropKind({ kind: "urgent" })).toBe("info");
      expect(dropKind({})).toBe("info");
    });
  });

  describe("relayType", () => {
    it("passes through mobile, defaults everything else to fixed", () => {
      expect(relayType({ type: "mobile" })).toBe("mobile");
      expect(relayType({ type: "fixed" })).toBe("fixed");
      expect(relayType({})).toBe("fixed");
      expect(relayType({ type: "satellite" })).toBe("fixed");
    });
  });

  describe("relayOnline", () => {
    it("is true only for a literal boolean true", () => {
      expect(relayOnline({ online: true })).toBe(true);
      expect(relayOnline({ online: false })).toBe(false);
      expect(relayOnline({})).toBe(false);
      expect(relayOnline({ online: "true" })).toBe(false);
    });
  });
});
