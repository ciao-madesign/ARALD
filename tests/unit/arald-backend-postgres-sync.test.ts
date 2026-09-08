import { describe, expect, it } from "vitest";
import { syncSnapshotToPostgres, type SyncClient } from "../../arald-backend/postgres-sync.js";
import type { NodeSnapshot } from "../../arald-backend/node-client.js";

function emptySnapshot(): NodeSnapshot {
  return { status: undefined, relays: [], emergencyBeacons: [], drops: [], nodeAppends: [], skipped: [] };
}

function fakeClient(): SyncClient & { calls: { text: string; params: unknown[] }[] } {
  const calls: { text: string; params: unknown[] }[] = [];
  return {
    calls,
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return undefined;
    },
  };
}

describe("syncSnapshotToPostgres", () => {
  it("issues no queries and reports zero counts for an empty snapshot", async () => {
    const client = fakeClient();
    const summary = await syncSnapshotToPostgres(client, "http://node.example", emptySnapshot());

    expect(client.calls).toHaveLength(0);
    expect(summary).toEqual({ relays: 0, emergencyBeacons: 0, drops: 0, nodeAppends: 0, statusSnapshot: false });
  });

  it("upserts one row per relay/beacon/drop/append, and inserts one status snapshot", async () => {
    const client = fakeClient();
    const snapshot: NodeSnapshot = {
      status: { nodeId: "N1", displayName: "Rifugio", connected: true, peers: 2, relaying: true },
      relays: [{ relayId: "R1", type: "fixed", lat: 45.1, lon: 9.2, online: true }],
      emergencyBeacons: [{ beaconContentId: "B1", deviceId: "D1", timestamp: 1000 }],
      drops: [{ dropId: "DR1", author: "A1", text: "attenzione", lat: 45.1, lon: 9.2, kind: "hazard", timestamp: 1500 }],
      nodeAppends: [{ appendId: "AP1", text: "ciao", kind: "info", timestamp: 2000 }],
      skipped: [],
    };

    const summary = await syncSnapshotToPostgres(client, "http://node.example", snapshot);

    expect(summary).toEqual({ relays: 1, emergencyBeacons: 1, drops: 1, nodeAppends: 1, statusSnapshot: true });
    expect(client.calls).toHaveLength(5);

    const relayCall = client.calls.find((c) => c.text.includes("INTO relays"));
    expect(relayCall?.text).toContain("ON CONFLICT (relay_id) DO UPDATE");
    expect(relayCall?.params[0]).toBe("R1");
    expect(relayCall?.params[1]).toBe("http://node.example");
    expect(JSON.parse(relayCall!.params[2] as string)).toMatchObject({ relayId: "R1", online: true });

    const statusCall = client.calls.find((c) => c.text.includes("INTO node_status_snapshots"));
    expect(statusCall?.text).not.toContain("ON CONFLICT");
    expect(statusCall?.params[1]).toBe("N1");
  });

  it("never inserts a status snapshot when the node's /api/status was unreachable/malformed", async () => {
    const client = fakeClient();
    const summary = await syncSnapshotToPostgres(client, "http://node.example", emptySnapshot());

    expect(summary.statusSnapshot).toBe(false);
    expect(client.calls.some((c) => c.text.includes("node_status_snapshots"))).toBe(false);
  });
});
