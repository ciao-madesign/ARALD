import type { NodeSnapshot } from "./node-client.js";

/**
 * The subset of `pg.Pool`/`pg.Client` this module actually needs — kept
 * minimal and structural (not `import type { Pool } from "pg"`) so a test
 * can pass a plain object that records calls instead of a real database
 * connection, same "inject the narrowest interface you use" pattern this
 * codebase already applies to `Transport`/`SyncClient`-shaped things
 * elsewhere. The real caller (`sync.ts`) passes an actual `pg.Pool`, which
 * satisfies this shape as-is.
 */
export interface SyncClient {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

export interface SyncSummary {
  relays: number;
  emergencyBeacons: number;
  drops: number;
  nodeAppends: number;
  statusSnapshot: boolean;
}

/**
 * Upserts one node's snapshot into the shared `arald_portal` schema
 * (`docs/emergency-portal.md`). Every table keys on the entity's own
 * natural id (`relayId`/`beaconContentId`/`dropId`/`appendId` — the same
 * ids the node itself uses, never a new one minted here) so re-running this
 * script against the same node is idempotent: a relay's `data`/`synced_at`
 * gets refreshed, never duplicated. `node_status_snapshots` is the one
 * append-only table (a point-in-time status has no natural identity to
 * upsert against) — this MVP does not prune old snapshots, a known,
 * documented limit (`docs/emergency-portal.md`, "Cosa sarebbe lavoro
 * nuovo") rather than a silent one.
 *
 * All values are passed as query parameters, never string-interpolated —
 * `nodeUrl`/relay-registered fields/drop text are all data from a node's
 * operator or the mesh, not something this script should ever trust enough
 * to build SQL out of directly.
 */
export async function syncSnapshotToPostgres(client: SyncClient, nodeUrl: string, snapshot: NodeSnapshot): Promise<SyncSummary> {
  // Promise.all within each table, not a sequential for-loop: rows in the same table target
  // different primary keys, so there is no ordering/consistency reason to make each one wait a
  // full round-trip to Neon for the previous one to finish — this matters more here than for a
  // local Postgres given the extra per-query latency of a remote serverless endpoint.
  await Promise.all(
    snapshot.relays.map((relay) =>
      client.query(
        `INSERT INTO relays (relay_id, node_url, data, synced_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (relay_id) DO UPDATE SET node_url = excluded.node_url, data = excluded.data, synced_at = excluded.synced_at`,
        [relay.relayId, nodeUrl, JSON.stringify(relay)],
      ),
    ),
  );

  await Promise.all(
    snapshot.emergencyBeacons.map((beacon) =>
      client.query(
        `INSERT INTO emergency_beacons (beacon_content_id, node_url, data, synced_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (beacon_content_id) DO UPDATE SET node_url = excluded.node_url, data = excluded.data, synced_at = excluded.synced_at`,
        [beacon.beaconContentId, nodeUrl, JSON.stringify(beacon)],
      ),
    ),
  );

  await Promise.all(
    snapshot.drops.map((drop) =>
      client.query(
        `INSERT INTO drops (drop_id, node_url, data, synced_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (drop_id) DO UPDATE SET node_url = excluded.node_url, data = excluded.data, synced_at = excluded.synced_at`,
        [drop.dropId, nodeUrl, JSON.stringify(drop)],
      ),
    ),
  );

  await Promise.all(
    snapshot.nodeAppends.map((append) =>
      client.query(
        `INSERT INTO node_appends (append_id, node_url, data, synced_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (append_id) DO UPDATE SET node_url = excluded.node_url, data = excluded.data, synced_at = excluded.synced_at`,
        [append.appendId, nodeUrl, JSON.stringify(append)],
      ),
    ),
  );

  let statusSnapshot = false;
  if (snapshot.status) {
    await client.query(`INSERT INTO node_status_snapshots (node_url, node_id, data, synced_at) VALUES ($1, $2, $3, now())`, [
      nodeUrl,
      snapshot.status.nodeId,
      JSON.stringify(snapshot.status),
    ]);
    statusSnapshot = true;
  }

  return {
    relays: snapshot.relays.length,
    emergencyBeacons: snapshot.emergencyBeacons.length,
    drops: snapshot.drops.length,
    nodeAppends: snapshot.nodeAppends.length,
    statusSnapshot,
  };
}
