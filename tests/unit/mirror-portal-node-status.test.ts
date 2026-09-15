import { describe, expect, it } from "vitest";
import { summarizeFleet } from "../../mirror-portal/lib/node-status.js";
import type { BeaconRow, DropRow, NodeStatusRow, RelayRow } from "../../mirror-portal/lib/db.js";

/**
 * `mirror-portal/lib/node-status.ts` (docs/security.md voce #80 — "Pezzo 0"
 * del canale di comando): rigrupppa dati già presenti in `MirrorSnapshot`
 * (nessuna nuova query) per il pannello "Nodi" della Home. Le proprietà da
 * verificare qui: il match batteria/relay-online è honest-or-nothing (mai
 * un abbinamento ambiguo indovinato), i servizi non-locali sono esclusi, e
 * gli "avvisi" combinano drop hazard/emergency + ogni beacon (sempre SOS),
 * ordinati dal più recente.
 */
function node(nodeUrl: string, data: Record<string, unknown>): NodeStatusRow {
  return { nodeUrl, nodeId: (data.nodeId as string) ?? "N1", data, syncedAt: new Date() };
}

describe("mirror-portal lib/node-status summarizeFleet", () => {
  it("reads connection/peers fields defensively, degrading missing/malformed ones to undefined", () => {
    const rows = summarizeFleet([node("http://a", { displayName: "A", connected: true, internet: "OFFLINE", peers: 3 })], [], [], []);
    expect(rows[0]).toMatchObject({ displayName: "A", connected: true, internet: "OFFLINE", localNetwork: undefined, peers: 3 });
  });

  it("falls back to the node id when displayName is missing", () => {
    const rows = summarizeFleet([node("http://a", { nodeId: "N1", connected: false })], [], [], []);
    expect(rows[0].displayName).toBe("N1");
  });

  it("matches battery/online only from a single 'fixed' relay whose relayId is this node's own nodeId", () => {
    const relays: RelayRow[] = [{ relayId: "N1", nodeUrl: "http://a", data: { type: "fixed", online: true, batteryPercent: 61 }, syncedAt: new Date() }];
    const rows = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], relays, [], []);
    expect(rows[0].batteryPercent).toBe(61);
    expect(rows[0].relayOnline).toBe(true);
  });

  it("leaves battery/online undefined for a 'mobile' relay whose relayId matches (never a Card mistaken for the Box itself)", () => {
    const relays: RelayRow[] = [{ relayId: "N1", nodeUrl: "http://a", data: { type: "mobile", online: true, batteryPercent: 61 }, syncedAt: new Date() }];
    const rows = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], relays, [], []);
    expect(rows[0].batteryPercent).toBeUndefined();
    expect(rows[0].relayOnline).toBeUndefined();
  });

  it("leaves battery/online undefined when two 'fixed' relay rows share the same relayId (ambiguous, never guessed)", () => {
    // Should never happen given relay_id is the Postgres primary key, but the function stays
    // honest about it rather than picking arbitrarily if it somehow did.
    const relays: RelayRow[] = [
      { relayId: "N1", nodeUrl: "http://a", data: { type: "fixed", online: true, batteryPercent: 61 }, syncedAt: new Date() },
      { relayId: "N1", nodeUrl: "http://b", data: { type: "fixed", online: false, batteryPercent: 12 }, syncedAt: new Date() },
    ];
    const rows = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], relays, [], []);
    expect(rows[0].batteryPercent).toBeUndefined();
    expect(rows[0].relayOnline).toBeUndefined();
  });

  it("never matches a relay with a different relayId, even when synced from the same nodeUrl", () => {
    // Regression: an earlier version matched on `nodeUrl` alone, which would have wrongly
    // attributed a companion relay's battery to this Box just because both rows came from the
    // same synced endpoint (found by review).
    const relays: RelayRow[] = [{ relayId: "OTHER-DEVICE", nodeUrl: "http://a", data: { type: "fixed", online: true, batteryPercent: 61 }, syncedAt: new Date() }];
    const rows = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], relays, [], []);
    expect(rows[0].batteryPercent).toBeUndefined();
  });

  it("matches a relay by relayId even when it was synced from a different Box's endpoint (a shared/centralized relay registry)", () => {
    // Regression: RelayRegistry can live on any single node an operator chose to expose it on
    // (docs/beacon.md) — a fleet commonly registers several Boxes' own self-entries on one shared
    // registry node, so the relay row for Box A can be synced from Box B's /api/relays. An earlier
    // `nodeUrl`-based match would never find this (found by review).
    const relays: RelayRow[] = [{ relayId: "N1", nodeUrl: "http://registry-host", data: { type: "fixed", online: true, batteryPercent: 61 }, syncedAt: new Date() }];
    const rows = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], relays, [], []);
    expect(rows[0].batteryPercent).toBe(61);
    expect(rows[0].relayOnline).toBe(true);
  });

  it("keeps only isLocal services, dropping gossiped/remote entries and malformed ones", () => {
    const rows = summarizeFleet(
      [
        node("http://a", {
          connected: true,
          services: [
            { serviceId: "ai", version: "1", availability: true, isLocal: true },
            { serviceId: "kiwix-search", version: "1", availability: false, isLocal: true },
            { serviceId: "remote-svc", version: "1", availability: true, isLocal: false },
            { serviceId: "broken" },
            "not-an-object",
          ],
        }),
      ],
      [],
      [],
      [],
    );
    expect(rows[0].services).toEqual([
      { serviceId: "ai", version: "1", availability: true },
      { serviceId: "kiwix-search", version: "1", availability: false },
    ]);
  });

  it("treats a missing/non-array services field as an empty list, never throwing", () => {
    const rows = summarizeFleet([node("http://a", { connected: true })], [], [], []);
    expect(rows[0].services).toEqual([]);
  });

  it("combines hazard/emergency drops and every beacon into alerts, excluding info drops, newest first", () => {
    const drops: DropRow[] = [
      { dropId: "d1", nodeUrl: "http://a", data: { text: "frana", kind: "hazard", timestamp: 1000 }, syncedAt: new Date() },
      { dropId: "d2", nodeUrl: "http://a", data: { text: "notizia", kind: "info", timestamp: 3000 }, syncedAt: new Date() },
      { dropId: "d3", nodeUrl: "http://a", data: { text: "urgente", kind: "emergency", timestamp: 2000 }, syncedAt: new Date() },
    ];
    const beacons: BeaconRow[] = [{ beaconContentId: "b1", nodeUrl: "http://a", data: { message: "aiuto", timestamp: 4000 }, syncedAt: new Date() }];
    const rows = summarizeFleet([node("http://a", { connected: true })], [], drops, beacons);
    expect(rows[0].alerts).toEqual([
      { kind: "sos", text: "aiuto", timestamp: 4000 },
      { kind: "emergency", text: "urgente", timestamp: 2000 },
      { kind: "hazard", text: "frana", timestamp: 1000 },
    ]);
  });

  it("never attributes an alert from one nodeUrl to a different node", () => {
    const drops: DropRow[] = [{ dropId: "d1", nodeUrl: "http://other", data: { text: "frana", kind: "hazard", timestamp: 1000 }, syncedAt: new Date() }];
    const rows = summarizeFleet([node("http://a", { connected: true })], [], drops, []);
    expect(rows[0].alerts).toEqual([]);
  });

  it("gives a beacon with no message a placeholder text, mirroring beaconMessage()", () => {
    const beacons: BeaconRow[] = [{ beaconContentId: "b1", nodeUrl: "http://a", data: { timestamp: 1000 }, syncedAt: new Date() }];
    const rows = summarizeFleet([node("http://a", { connected: true })], [], [], beacons);
    expect(rows[0].alerts).toEqual([{ kind: "sos", text: "(nessun messaggio)", timestamp: 1000 }]);
  });
});
