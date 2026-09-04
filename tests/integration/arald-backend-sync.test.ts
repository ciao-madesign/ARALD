import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { WebUiServer } from "../../node/src/web-ui.js";
import { fetchNodeSnapshot } from "../../arald-backend/node-client.js";
import { syncSnapshotToPostgres, type SyncClient } from "../../arald-backend/postgres-sync.js";

/**
 * End-to-end test of the first "ARALD Backend" piece
 * (`docs/emergency-portal.md`, "Prossimo passo"): a real `NomadNode` +
 * `WebUiServer` over loopback, `fetchNodeSnapshot()` reading it exactly as
 * a browser/future ARALD Box would, then `syncSnapshotToPostgres()` against
 * a fake Postgres client (no live database needed for the automated
 * suite — the real Neon instance created for this proposal was verified
 * manually once, see `docs/emergency-portal.md`).
 */
describe("arald-backend sync (docs/emergency-portal.md)", () => {
  let node: NomadNode | undefined;
  let webUi: WebUiServer | undefined;

  afterEach(async () => {
    if (webUi) await webUi.stop();
    if (node) await node.stop();
    node = undefined;
    webUi = undefined;
  });

  function baseUrl(): string {
    return `http://127.0.0.1:${webUi!.port}`;
  }

  function fakeClient(): SyncClient & { calls: number } {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async query() {
        calls++;
        return undefined;
      },
    };
  }

  it("syncs relays, an emergency beacon, a drop and a node append into the database", async () => {
    node = new NomadNode({ displayName: "Rifugio Test" });
    await node.start();
    webUi = new WebUiServer(node, {
      port: 0,
      exposeRelayRegistry: true,
      exposeEmergencyBeacons: true,
      networkPassword: "s3cret-test-password",
    });
    await webUi.start();

    node.registerRelay({ relayId: "RELAY-1", type: "fixed", lat: 45.8, lon: 7.6 });
    node.sendEmergencyBeacon({ message: "aiuto", lat: 45.8, lon: 7.6 });
    node.publishDrop({ text: "sentiero chiuso", lat: 45.8, lon: 7.6, kind: "hazard" });
    node.nodeAppends.record({
      appendId: "APPEND-1",
      type: "node-append",
      text: "messaggio per il relay",
      kind: "info",
      timestamp: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });

    const snapshot = await fetchNodeSnapshot({ nodeUrl: baseUrl(), networkPassword: "s3cret-test-password" });

    expect(snapshot.skipped).toEqual([]);
    expect(snapshot.status).toMatchObject({ nodeId: node.nodeId, connected: true });
    expect(snapshot.relays).toEqual([{ relayId: "RELAY-1", type: "fixed", lat: 45.8, lon: 7.6, online: false }]);
    expect(snapshot.emergencyBeacons).toHaveLength(1);
    expect(snapshot.emergencyBeacons[0]).toMatchObject({ deviceId: node.nodeId, message: "aiuto" });
    expect(snapshot.drops).toHaveLength(1);
    expect(snapshot.drops[0]).toMatchObject({ text: "sentiero chiuso", kind: "hazard" });
    expect(snapshot.nodeAppends).toEqual([{ appendId: "APPEND-1", text: "messaggio per il relay", kind: "info", timestamp: expect.any(Number) }]);

    const client = fakeClient();
    const summary = await syncSnapshotToPostgres(client, baseUrl(), snapshot);
    expect(summary).toEqual({ relays: 1, emergencyBeacons: 1, drops: 1, nodeAppends: 1, statusSnapshot: true });
    expect(client.calls).toBe(5); // one upsert per relay/beacon/drop/append + one status insert
  });

  it("skips /api/relays and /api/emergency-beacons (and reports why) when no network password is given", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, exposeRelayRegistry: true, exposeEmergencyBeacons: true, networkPassword: "pw" });
    await webUi.start();

    const snapshot = await fetchNodeSnapshot({ nodeUrl: baseUrl() });

    expect(snapshot.relays).toEqual([]);
    expect(snapshot.emergencyBeacons).toEqual([]);
    expect(snapshot.skipped).toEqual([
      "/api/relays (no network password provided)",
      "/api/emergency-beacons (no network password provided)",
    ]);
  });

  it("skips /api/relays and /api/emergency-beacons with a distinct reason when the password is wrong", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, exposeRelayRegistry: true, exposeEmergencyBeacons: true, networkPassword: "correct" });
    await webUi.start();

    const snapshot = await fetchNodeSnapshot({ nodeUrl: baseUrl(), networkPassword: "wrong" });

    expect(snapshot.skipped).toEqual(["/api/relays (wrong network password)", "/api/emergency-beacons (wrong network password)"]);
  });

  it("skips /api/relays and /api/emergency-beacons as 'not exposed' on a node that never turned them on", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const snapshot = await fetchNodeSnapshot({ nodeUrl: baseUrl(), networkPassword: "irrelevant" });

    expect(snapshot.skipped).toEqual(["/api/relays (not exposed by this node)", "/api/emergency-beacons (not exposed by this node)"]);
    expect(snapshot.drops).toEqual([]);
    expect(snapshot.nodeAppends).toEqual([]);
  });

  it("throws when the node is unreachable, rather than syncing an empty snapshot silently", async () => {
    await expect(fetchNodeSnapshot({ nodeUrl: "http://127.0.0.1:1" })).rejects.toThrow();
  });
});
