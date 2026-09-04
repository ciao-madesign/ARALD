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

  it("still returns status/drops/node-appends when /api/relays returns an unexpected 500", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") {
        return new Response(JSON.stringify({ nodeId: "N1", displayName: "N", connected: true, peers: 0, relaying: false }), { status: 200 });
      }
      if (path === "/api/drops") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/node-appends") return new Response(JSON.stringify([]), { status: 200 });
      if (path === "/api/relays") return new Response("internal error", { status: 500 });
      if (path === "/api/emergency-beacons") return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`unexpected path ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchNodeSnapshot({ nodeUrl: "http://node.example", networkPassword: "pw" });

    expect(snapshot.status).toEqual({ nodeId: "N1", displayName: "N", connected: true, peers: 0, relaying: false });
    expect(snapshot.drops).toEqual([]);
    expect(snapshot.nodeAppends).toEqual([]);
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
});
