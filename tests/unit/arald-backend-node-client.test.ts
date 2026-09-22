import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNodeSnapshot } from "../../arald-backend/node-client.js";

/**
 * Regression test for a real bug found by code review: an unexpected
 * non-2xx status (e.g. a transient 500) on `/api/relays`/`/api/emergency-
 * beacons` used to make `fetchJson()` throw, which rejected the whole
 * `fetchNodeSnapshot()` call and silently discarded the status/drops/
 * node-appends data that had already been fetched successfully in the same
 * call — contradicting this module's own "degrade, don't crash" contract.
 */
describe("fetchNodeSnapshot (regression: partial endpoint failure)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const statusBody = {
    nodeId: "N1",
    displayName: "N",
    connected: true,
    internet: "OFFLINE",
    localNetwork: "ONLINE",
    peers: 0,
    relaying: false,
    services: 0,
    cachedContentPercent: 0,
  };

  it("still returns status/drops/node-appends when /api/relays returns an unexpected 500", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") return new Response(JSON.stringify(statusBody), { status: 200 });
      if (path === "/api/drops") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/node-appends") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/services") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/relays") return new Response("internal error", { status: 500 });
      if (path === "/api/emergency-beacons") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/external-delivery-destinations") return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`unexpected path ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchNodeSnapshot({ nodeUrl: "http://node.example", networkPassword: "pw" });

    expect(snapshot.status).toEqual({
      nodeId: "N1",
      displayName: "N",
      connected: true,
      internet: "OFFLINE",
      localNetwork: "ONLINE",
      peers: 0,
      relaying: false,
      servicesCount: 0,
      cachedContentPercent: 0,
    });
    expect(snapshot.drops).toEqual([]);
    expect(snapshot.nodeAppends).toEqual([]);
    expect(snapshot.services).toEqual([]);
    expect(snapshot.relays).toEqual([]);
    expect(snapshot.skipped).toEqual(["/api/relays (unexpected status 500)"]);
  });

  it("throws (nothing to sync) when /api/status itself returns an unexpected 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("internal error", { status: 500 })),
    );

    await expect(fetchNodeSnapshot({ nodeUrl: "http://node.example" })).rejects.toThrow(/500/);
  });

  it("throws when /api/status is missing the newer connectivity/services fields (voce #80)", async () => {
    // An old-shaped 200 response (pre-#80: no internet/localNetwork/services/cachedContentPercent)
    // must be treated the same as a malformed body, not silently accepted with those fields
    // undefined — a partial StatusRow would otherwise reach syncSnapshotToPostgres() and produce a
    // node_status_snapshots row this piece's own new UI can't render correctly.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ nodeId: "N1", displayName: "N", connected: true, peers: 0, relaying: false }), { status: 200 })),
    );

    await expect(fetchNodeSnapshot({ nodeUrl: "http://node.example" })).rejects.toThrow(/unrecognized shape/);
  });

  it("fetches and defensively extracts /api/services, dropping malformed entries", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") return new Response(JSON.stringify(statusBody), { status: 200 });
      if (path === "/api/drops") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/node-appends") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/services") {
        return new Response(
          JSON.stringify([
            { serviceId: "ai", version: "1", capabilities: ["prompt"], providerId: "N1", isLocal: true, availability: true },
            { serviceId: "broken" }, // missing required fields — dropped, not thrown
          ]),
          { status: 200 },
        );
      }
      if (path === "/api/external-delivery-destinations") return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`unexpected path ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchNodeSnapshot({ nodeUrl: "http://node.example" });

    expect(snapshot.services).toEqual([
      { serviceId: "ai", version: "1", capabilities: ["prompt"], providerId: "N1", isLocal: true, availability: true },
    ]);
    expect(snapshot.skipped).toContain("/api/relays (no network password provided)");
  });

  it("captures a relay's batteryPercent from /api/relays (regression: dropped entirely before voce #80's follow-up fix)", async () => {
    // Found by review: RelayRow/extractRelayRow only ever captured relayId/type/lat/lon/online,
    // even though GET /api/relays (node.relayRegistry.list()) also returns batteryPercent — so the
    // mirror-portal "batteria" feature this piece adds had nothing to read, no matter how the Box
    // was synced. A relay lacking telemetry (batteryPercent malformed/absent) must still sync, just
    // without that one field.
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") return new Response(JSON.stringify(statusBody), { status: 200 });
      if (path === "/api/drops") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/node-appends") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/services") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/emergency-beacons") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/relays") {
        return new Response(
          JSON.stringify([
            { relayId: "R1", type: "fixed", lat: 45.8, lon: 7.6, online: true, batteryPercent: 61 },
            { relayId: "R2", type: "fixed", lat: 45.8, lon: 7.6, online: false, batteryPercent: "not-a-number" },
          ]),
          { status: 200 },
        );
      }
      if (path === "/api/external-delivery-destinations") return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`unexpected path ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchNodeSnapshot({ nodeUrl: "http://node.example", networkPassword: "pw" });

    expect(snapshot.relays).toEqual([
      { relayId: "R1", type: "fixed", lat: 45.8, lon: 7.6, online: true, batteryPercent: 61 },
      { relayId: "R2", type: "fixed", lat: 45.8, lon: 7.6, online: false, batteryPercent: undefined },
    ]);
  });

  it("records a skip, never throws, when /api/services returns an unexpected status", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") return new Response(JSON.stringify(statusBody), { status: 200 });
      if (path === "/api/drops") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/node-appends") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/services") return new Response("internal error", { status: 503 });
      if (path === "/api/external-delivery-destinations") return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`unexpected path ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchNodeSnapshot({ nodeUrl: "http://node.example" });

    expect(snapshot.services).toEqual([]);
    expect(snapshot.skipped).toContain("/api/services (unexpected status 503)");
  });

  it("fetches and defensively extracts /api/external-delivery-destinations, dropping malformed entries (Pezzo 3, voce #84)", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") return new Response(JSON.stringify(statusBody), { status: 200 });
      if (path === "/api/drops") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/node-appends") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/services") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/external-delivery-destinations") {
        return new Response(
          JSON.stringify([
            { destinationId: "HQ", boxNodeId: "N1", label: "Headquarter", publicKeyHex: "aa".repeat(32), requiresPassword: false },
            { destinationId: "broken" }, // missing required fields — dropped, not thrown
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected path ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchNodeSnapshot({ nodeUrl: "http://node.example" });

    expect(snapshot.externalDeliveryDestinations).toEqual([
      { destinationId: "HQ", boxNodeId: "N1", label: "Headquarter", publicKeyHex: "aa".repeat(32), requiresPassword: false },
    ]);
  });

  it("records a skip, never throws, when /api/external-delivery-destinations returns an unexpected status", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") return new Response(JSON.stringify(statusBody), { status: 200 });
      if (path === "/api/drops") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/node-appends") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/services") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/external-delivery-destinations") return new Response("internal error", { status: 503 });
      throw new Error(`unexpected path ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchNodeSnapshot({ nodeUrl: "http://node.example" });

    expect(snapshot.externalDeliveryDestinations).toEqual([]);
    expect(snapshot.skipped).toContain("/api/external-delivery-destinations (unexpected status 503)");
  });
});
