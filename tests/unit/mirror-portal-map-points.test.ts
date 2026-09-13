import { describe, expect, it } from "vitest";
import { toMapPoints } from "../../mirror-portal/lib/map-points.js";
import type { MirrorSnapshot } from "../../mirror-portal/lib/db.js";

/**
 * `mirror-portal/lib/map-points.ts` (docs/security.md voce #75): turns a `MirrorSnapshot` into the
 * flat list of pins `mappa/LeafletMap.tsx` actually draws. The one architectural rule this enforces —
 * nodes never produce a pin, only beacons/drops/relays do, since only those carry real `{lat, lon}` in
 * this codebase today — is exactly the thing to regress-test here, alongside the defensive coordinate
 * filtering (a row with a missing/non-finite coordinate must never reach Leaflet as a fabricated pin).
 */
function emptySnapshot(): MirrorSnapshot {
  return { nodes: [], relays: [], beacons: [], drops: [], errors: [] };
}

describe("mirror-portal mappa/page.tsx toMapPoints", () => {
  it("never produces a point for a node, even one whose data happens to carry lat/lon-shaped keys", () => {
    const snapshot: MirrorSnapshot = {
      ...emptySnapshot(),
      nodes: [{ nodeUrl: "http://n", nodeId: "n1", data: { lat: 45.8, lon: 7.2 }, syncedAt: new Date() }],
    };
    expect(toMapPoints(snapshot)).toHaveLength(0);
  });

  it("skips a beacon/drop/relay with a missing or non-finite coordinate instead of fabricating a pin", () => {
    const snapshot: MirrorSnapshot = {
      ...emptySnapshot(),
      beacons: [{ beaconContentId: "b1", nodeUrl: "http://n", data: { message: "aiuto", lat: 45.8 }, syncedAt: new Date() }],
      drops: [{ dropId: "d1", nodeUrl: "http://n", data: { text: "x", lat: Number.NaN, lon: 7.2 }, syncedAt: new Date() }],
      relays: [{ relayId: "r1", nodeUrl: "http://n", data: { online: true }, syncedAt: new Date() }],
    };
    expect(toMapPoints(snapshot)).toHaveLength(0);
  });

  it("maps a beacon to a sos point", () => {
    const snapshot: MirrorSnapshot = {
      ...emptySnapshot(),
      beacons: [{ beaconContentId: "b1", nodeUrl: "http://n", data: { message: "Ferito", lat: 45.8331, lon: 7.2065 }, syncedAt: new Date() }],
    };
    const points = toMapPoints(snapshot);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ kind: "sos", lat: 45.8331, lon: 7.2065, title: "Ferito" });
  });

  it("maps a drop's kind to the matching point kind (hazard/info/emergency), never a fabricated severity", () => {
    const snapshot: MirrorSnapshot = {
      ...emptySnapshot(),
      drops: [
        { dropId: "d1", nodeUrl: "http://n", data: { text: "frana", kind: "hazard", lat: 1, lon: 2 }, syncedAt: new Date() },
        { dropId: "d2", nodeUrl: "http://n", data: { text: "avviso", kind: "info", lat: 1, lon: 2 }, syncedAt: new Date() },
        { dropId: "d3", nodeUrl: "http://n", data: { text: "urgente", kind: "emergency", lat: 1, lon: 2 }, syncedAt: new Date() },
        { dropId: "d4", nodeUrl: "http://n", data: { text: "sconosciuto", kind: "not-a-real-kind", lat: 1, lon: 2 }, syncedAt: new Date() },
      ],
    };
    const kinds = toMapPoints(snapshot).map((p) => p.kind);
    expect(kinds).toEqual(["hazard", "info", "emergency", "info"]); // an unrecognized kind degrades to info, same as dropKind() itself
  });

  it("maps a relay's online flag to relay-on/relay-off", () => {
    const snapshot: MirrorSnapshot = {
      ...emptySnapshot(),
      relays: [
        { relayId: "r1", nodeUrl: "http://n", data: { online: true, lat: 1, lon: 2 }, syncedAt: new Date() },
        { relayId: "r2", nodeUrl: "http://n", data: { online: false, lat: 1, lon: 2 }, syncedAt: new Date() },
      ],
    };
    const kinds = toMapPoints(snapshot).map((p) => p.kind);
    expect(kinds).toEqual(["relay-on", "relay-off"]);
  });
});
