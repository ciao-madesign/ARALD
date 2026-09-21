import { describe, expect, it } from "vitest";
import { buildAttentionFeed, summarizeFleet, type NodeFleetStatus } from "../../mirror-portal/lib/node-status.js";
import type { BeaconRow, DestinationRow, DropRow, NodeStatusRow, RelayRow } from "../../mirror-portal/lib/db.js";

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

  /**
   * `isFixedRelay` (Pezzo 4, `docs/security.md` voce #83) — il segnale su cui `page.tsx` decide se
   * mostrare `RemoteRelayCommandForm` (mai per una Card/Mobile Relay, richiesta esplicita
   * dell'utente). Stesso match `relayId === nodeId` + `type === "fixed"` già usato per
   * batteria/online sopra, ma un campo booleano indipendente: `batteryPercent`/`relayOnline`
   * possono essere `undefined` anche per un fixed relay genuino (es. `online` mancante dalla sua
   * stessa telemetria) senza che questo significhi "non è un fixed relay".
   */
  it("isFixedRelay is true only for a single matching 'fixed' relay entry, independent of whether battery/online are themselves present", () => {
    const relays: RelayRow[] = [{ relayId: "N1", nodeUrl: "http://a", data: { type: "fixed" }, syncedAt: new Date() }];
    const rows = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], relays, [], []);
    expect(rows[0].isFixedRelay).toBe(true);
    expect(rows[0].batteryPercent).toBeUndefined(); // no batteryPercent in data, yet still a fixed relay
  });

  it("isFixedRelay is false for a 'mobile' relay, no relay entry at all, or an ambiguous double-match", () => {
    const noRelay = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], [], [], []);
    expect(noRelay[0].isFixedRelay).toBe(false);

    const mobile: RelayRow[] = [{ relayId: "N1", nodeUrl: "http://a", data: { type: "mobile" }, syncedAt: new Date() }];
    const mobileRows = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], mobile, [], []);
    expect(mobileRows[0].isFixedRelay).toBe(false);

    const ambiguous: RelayRow[] = [
      { relayId: "N1", nodeUrl: "http://a", data: { type: "fixed" }, syncedAt: new Date() },
      { relayId: "N1", nodeUrl: "http://b", data: { type: "fixed" }, syncedAt: new Date() },
    ];
    const ambiguousRows = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], ambiguous, [], []);
    expect(ambiguousRows[0].isFixedRelay).toBe(false);
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

  /**
   * `externalDeliveryDestinations` — "Pezzo 3" del canale di comando (`docs/security.md` voce #84).
   * Stesso match `boxNodeId === nodeId` (identità reale, mai `nodeUrl`) già usato per
   * `isFixedRelay`/battery sopra — una singola directory sincronizzata da un Box può contenere
   * destinazioni propagate via mesh da un *altro* Box (`ExternalDeliveryDirectory`'s own doc
   * comment), quindi il match deve restare sull'identità, non sull'endpoint di sync. Scope v1
   * (deciso esplicitamente con l'utente): solo destinazioni senza password.
   */
  function destination(boxNodeId: string, data: Record<string, unknown>): DestinationRow {
    return { destinationId: (data.destinationId as string) ?? "HQ", boxNodeId, nodeUrl: "http://a", data, syncedAt: new Date() };
  }

  it("includes only this exact Box's own password-less destinations, matched by boxNodeId === nodeId", () => {
    const destinations: DestinationRow[] = [
      destination("N1", { destinationId: "HQ", label: "Headquarter", requiresPassword: false }),
      destination("OTHER-BOX", { destinationId: "ONG", label: "Centro Operativo", requiresPassword: false }), // propagated from a different Box — must not appear here
    ];
    const rows = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], [], [], [], destinations);
    expect(rows[0].externalDeliveryDestinations).toEqual([{ destinationId: "HQ", label: "Headquarter" }]);
  });

  it("excludes a password-protected destination entirely — v1 scope, never offered even as a hidden option", () => {
    const destinations: DestinationRow[] = [destination("N1", { destinationId: "ONG", label: "Centro Operativo", requiresPassword: true })];
    const rows = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], [], [], [], destinations);
    expect(rows[0].externalDeliveryDestinations).toEqual([]);
  });

  it("falls back to destinationId as the label when data.label is missing/malformed", () => {
    const destinations: DestinationRow[] = [destination("N1", { destinationId: "HQ", requiresPassword: false })];
    const rows = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], [], [], [], destinations);
    expect(rows[0].externalDeliveryDestinations).toEqual([{ destinationId: "HQ", label: "HQ" }]);
  });

  it("defaults to an empty list when no destinations argument is given at all", () => {
    const rows = summarizeFleet([node("http://a", { nodeId: "N1", connected: true })], [], [], []);
    expect(rows[0].externalDeliveryDestinations).toEqual([]);
  });

  it("carries the node status row's own syncedAt through, for buildAttentionFeed() below", () => {
    const at = new Date("2026-09-21T10:00:00Z");
    const rows = summarizeFleet([{ nodeUrl: "http://a", nodeId: "N1", data: { connected: true }, syncedAt: at }], [], [], []);
    expect(rows[0].syncedAt).toBe(at);
  });
});

/**
 * `buildAttentionFeed()` (Fase 5 dell'audit UX/UI, docs/next-steps.md — risolve P2 #10: "nessuna
 * vista aggregata"): appiattisce `NodeFleetStatus.alerts` di ogni nodo della flotta + un'entry
 * "offline" sintetica per ogni nodo con `connected: false`, ordinato per severità (SOS, poi
 * emergency/hazard, poi offline) e, a parità di severità, dal più recente.
 */
describe("mirror-portal lib/node-status buildAttentionFeed", () => {
  function fleetStatus(overrides: Partial<NodeFleetStatus>): NodeFleetStatus {
    return {
      nodeUrl: "http://a",
      nodeId: "N1",
      displayName: "Box A",
      connected: true,
      services: [],
      isFixedRelay: false,
      alerts: [],
      externalDeliveryDestinations: [],
      syncedAt: new Date(),
      ...overrides,
    };
  }

  it("orders SOS before emergency, emergency before hazard, hazard before offline", () => {
    const fleet = [
      fleetStatus({
        displayName: "Box A",
        alerts: [
          { kind: "hazard", text: "frana", timestamp: 1000 },
          { kind: "sos", text: "aiuto", timestamp: 2000 },
          { kind: "emergency", text: "valanga", timestamp: 500 },
        ],
      }),
      fleetStatus({ displayName: "Box B", connected: false, syncedAt: new Date(3000) }),
    ];
    const feed = buildAttentionFeed(fleet);
    expect(feed.map((i) => i.kind)).toEqual(["sos", "emergency", "hazard", "offline"]);
  });

  it("within the same severity, orders the most recent first", () => {
    const fleet = [
      fleetStatus({
        alerts: [
          { kind: "sos", text: "vecchio", timestamp: 1000 },
          { kind: "sos", text: "nuovo", timestamp: 5000 },
        ],
      }),
    ];
    const feed = buildAttentionFeed(fleet);
    expect(feed.map((i) => i.text)).toEqual(["nuovo", "vecchio"]);
  });

  it("uses syncedAt as the offline entry's since, and an empty text (no message to show)", () => {
    const at = new Date(4242);
    const fleet = [fleetStatus({ displayName: "Box C", connected: false, syncedAt: at })];
    const feed = buildAttentionFeed(fleet);
    expect(feed).toEqual([{ kind: "offline", nodeDisplayName: "Box C", text: "", since: 4242 }]);
  });

  it("produces nothing for a fleet with no alerts and every node connected", () => {
    expect(buildAttentionFeed([fleetStatus({})])).toEqual([]);
  });

  it("carries the originating node's own displayName onto each item, across multiple nodes", () => {
    const fleet = [
      fleetStatus({ displayName: "Rifugio Nord", alerts: [{ kind: "sos", text: "aiuto", timestamp: 1 }] }),
      fleetStatus({ displayName: "Rifugio Sud", alerts: [{ kind: "hazard", text: "frana", timestamp: 1 }] }),
    ];
    const feed = buildAttentionFeed(fleet);
    expect(feed.map((i) => i.nodeDisplayName)).toEqual(["Rifugio Nord", "Rifugio Sud"]);
  });
});
