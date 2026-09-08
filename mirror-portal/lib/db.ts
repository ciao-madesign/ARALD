import { Pool } from "pg";

/**
 * Read-only access to the `arald_portal` Postgres schema
 * (`docs/emergency-portal.md`) — the mirror this page renders. Written to
 * exclusively by `arald-backend/sync.ts` running on an ARALD Box; this
 * module never writes anything back, matching the "Box → specchio, mai il
 * contrario" direction the architecture correction settled on.
 *
 * A module-level singleton `Pool`, the standard pattern for a Next.js
 * serverless function on Vercel's Node.js runtime (a fresh module
 * evaluation per cold start, reused across warm invocations of the same
 * instance) — never one `Pool` per request, which would exhaust Neon's
 * connection limit under any real traffic.
 */

let pool: Pool | undefined;

function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL non impostata su questo progetto Vercel (Project Settings -> Environment Variables).");
  }
  // Same timeouts as arald-backend/sync.ts's own Pool, same reasoning: a request that hangs forever
  // on a stalled connection to Neon is worse here than elsewhere — it would tie up a serverless
  // function invocation (and its Vercel execution-time billing) indefinitely instead of failing fast
  // into the error state this page already renders.
  pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000, query_timeout: 15_000, statement_timeout: 15_000, max: 5 });
  return pool;
}

export interface NodeStatusRow {
  nodeUrl: string;
  nodeId: string;
  data: Record<string, unknown>;
  syncedAt: Date;
}

export interface RelayRow {
  relayId: string;
  nodeUrl: string;
  data: Record<string, unknown>;
  syncedAt: Date;
}

export interface BeaconRow {
  beaconContentId: string;
  nodeUrl: string;
  data: Record<string, unknown>;
  syncedAt: Date;
}

export interface DropRow {
  dropId: string;
  nodeUrl: string;
  data: Record<string, unknown>;
  syncedAt: Date;
}

export interface MirrorSectionError {
  section: "config" | "nodes" | "relays" | "beacons" | "drops";
  message: string;
}

export interface MirrorSnapshot {
  nodes: NodeStatusRow[];
  relays: RelayRow[];
  beacons: BeaconRow[];
  drops: DropRow[];
  /** One entry per section that failed to load — the page renders the sections that *did* succeed normally and shows this message only where data is actually missing, instead of one failing query blanking the whole mirror (found by review: a `Promise.all` across all four queries used to do exactly that). */
  errors: MirrorSectionError[];
}

/**
 * Normalizes a jsonb `data` column to a plain object, defensively — a jsonb
 * column has no schema of its own even under `NOT NULL` (that constraint
 * only rules out SQL `NULL`, never the JSON scalar `null`, an empty array,
 * or a bare string/number written by some future/different version of the
 * sync script or a stray manual `INSERT`). Every consumer of a snapshot row
 * (`lib/format.ts`, `app/page.tsx`) assumes `data` is a safe-to-index
 * object; this is the single place that guarantee is actually enforced,
 * rather than scattering the same `typeof`/`null` check across every
 * caller (found by review: `nodeDisplayName(null, ...)` etc. would
 * otherwise throw mid-render, outside the try/catch that only wrapped the
 * query itself).
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * One row per distinct `node_url`, its most recent status snapshot only —
 * `node_status_snapshots` is append-only (a point-in-time status has no
 * natural id to upsert against, `postgres-sync.ts`'s own doc comment), so
 * without `DISTINCT ON` this would show every historical snapshot ever
 * synced instead of "what does each node look like right now".
 */
async function queryLatestNodeStatus(db: Pool): Promise<NodeStatusRow[]> {
  const res = await db.query(
    `SELECT DISTINCT ON (node_url) node_url, node_id, data, synced_at
     FROM node_status_snapshots
     ORDER BY node_url, synced_at DESC`,
  );
  return res.rows.map((r) => ({ nodeUrl: r.node_url, nodeId: r.node_id, data: asRecord(r.data), syncedAt: r.synced_at }));
}

async function queryRelays(db: Pool): Promise<RelayRow[]> {
  const res = await db.query(`SELECT relay_id, node_url, data, synced_at FROM relays ORDER BY synced_at DESC`);
  return res.rows.map((r) => ({ relayId: r.relay_id, nodeUrl: r.node_url, data: asRecord(r.data), syncedAt: r.synced_at }));
}

// This page shows "the 50 most recent" beacons/drops, but ranking that by `synced_at` alone breaks
// once a table holds more than SQL_FETCH_CAP rows: postgres-sync.ts bumps synced_at on *every*
// re-sync of an already-known row (its ON CONFLICT ... DO UPDATE), so in a mass-incident scenario
// with many concurrently-active SOS/drops, a single sync tick can reorder which ones look "most
// recent" with no relation to when the real-world event actually happened (found by review). The
// fix ranks by each row's own event time instead (`data.timestamp`, the field the mesh itself
// attaches — `EmergencyBeaconPayload.timestamp`/`DropPayload.timestamp`) — computed in application
// code, deliberately not a SQL-level `(data->>'timestamp')::bigint` cast, which would throw a real
// database error on a row written by some future/different sync-script version whose `timestamp`
// isn't numeric-looking text. SQL_FETCH_CAP bounds the query itself (never an unbounded table scan)
// while still comfortably covering RECENT_LIST_LIMIT after the safer application-level sort.
const SQL_FETCH_CAP = 500;
const RECENT_LIST_LIMIT = 50;

export function eventTimestamp(data: Record<string, unknown>): number {
  return asFiniteNumber(data.timestamp) ?? 0;
}

/** Newest-event-first, capped at `RECENT_LIST_LIMIT` — the actual ranking logic `queryRecentBeacons()`/`queryRecentDrops()` apply after their SQL fetch, pulled out on its own so it's testable with plain objects and no `pg.Pool` at all. */
export function rankByEventTimestamp<T extends { data: Record<string, unknown> }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => eventTimestamp(b.data) - eventTimestamp(a.data)).slice(0, RECENT_LIST_LIMIT);
}

async function queryRecentBeacons(db: Pool): Promise<BeaconRow[]> {
  const res = await db.query(
    `SELECT beacon_content_id, node_url, data, synced_at FROM emergency_beacons ORDER BY synced_at DESC LIMIT $1`,
    [SQL_FETCH_CAP],
  );
  const rows = res.rows.map((r) => ({ beaconContentId: r.beacon_content_id, nodeUrl: r.node_url, data: asRecord(r.data), syncedAt: r.synced_at }));
  return rankByEventTimestamp(rows);
}

async function queryRecentDrops(db: Pool): Promise<DropRow[]> {
  const res = await db.query(`SELECT drop_id, node_url, data, synced_at FROM drops ORDER BY synced_at DESC LIMIT $1`, [SQL_FETCH_CAP]);
  const rows = res.rows.map((r) => ({ dropId: r.drop_id, nodeUrl: r.node_url, data: asRecord(r.data), syncedAt: r.synced_at }));
  return rankByEventTimestamp(rows);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Each of the four sections is fetched independently (`Promise.allSettled`,
 * not `Promise.all`) and degrades on its own — one table being temporarily
 * unreachable/misconfigured shows an error only for *that* section, never
 * blanks sections that loaded fine (found by review). A missing/invalid
 * `DATABASE_URL` is caught once upfront instead: every section would fail
 * with the exact same message, so there is nothing to gain from reporting
 * it four times.
 */
function unwrapSection<T>(result: PromiseSettledResult<T[]>, section: MirrorSectionError["section"], errors: MirrorSectionError[]): T[] {
  if (result.status === "fulfilled") return result.value;
  errors.push({ section, message: errorMessage(result.reason) });
  return [];
}

/**
 * Assembles a `MirrorSnapshot` from the four already-settled query results —
 * pulled out of `getMirrorSnapshot()` as its own pure function so the
 * per-section resilience behavior (one rejected promise producing an error
 * for *only* that section, never blanking the others) is directly testable
 * with plain `Promise.resolve()`/`Promise.reject()` results, no `pg.Pool`
 * or real database involved.
 */
export function assembleSnapshot(results: {
  nodes: PromiseSettledResult<NodeStatusRow[]>;
  relays: PromiseSettledResult<RelayRow[]>;
  beacons: PromiseSettledResult<BeaconRow[]>;
  drops: PromiseSettledResult<DropRow[]>;
}): MirrorSnapshot {
  const errors: MirrorSectionError[] = [];
  return {
    nodes: unwrapSection(results.nodes, "nodes", errors),
    relays: unwrapSection(results.relays, "relays", errors),
    beacons: unwrapSection(results.beacons, "beacons", errors),
    drops: unwrapSection(results.drops, "drops", errors),
    errors,
  };
}

export async function getMirrorSnapshot(): Promise<MirrorSnapshot> {
  let db: Pool;
  try {
    db = getPool();
  } catch (err) {
    return { nodes: [], relays: [], beacons: [], drops: [], errors: [{ section: "config", message: errorMessage(err) }] };
  }

  const [nodes, relays, beacons, drops] = await Promise.allSettled([
    queryLatestNodeStatus(db),
    queryRelays(db),
    queryRecentBeacons(db),
    queryRecentDrops(db),
  ]);

  return assembleSnapshot({ nodes, relays, beacons, drops });
}
