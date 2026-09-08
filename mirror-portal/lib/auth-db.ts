import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "./db";

/**
 * Access to the multi-tenant tables (`organizations`/`nodes`/`users`/`audit_logs`)
 * added alongside the four mirror tables `lib/db.ts` already reads. Same
 * split as elsewhere in this repository: this module trusts its inputs
 * (already validated by `lib/admin-validation.ts` at the HTTP boundary in
 * `app/api/admin/*`, same relationship as `arald-backend/node-client.ts`
 * validating vs. `postgres-sync.ts` trusting).
 *
 * Every query here is parameterized (never string-concatenated SQL), same
 * discipline as `postgres-sync.ts`.
 */

export interface Organization {
  id: string;
  name: string;
  createdAt: Date;
}

export type UserRole = "admin" | "operatore";

export interface AppUser {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  organizationId: string | null;
  createdAt: Date;
}

/** `AppUser` without `passwordHash` — the shape ever sent to a browser (`app/admin/`). */
export type PublicAppUser = Omit<AppUser, "passwordHash">;

export interface NodeAssignment {
  nodeUrl: string;
  organizationId: string;
  organizationName: string;
  displayName: string | null;
  registeredAt: Date;
}

export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`Un utente con l'email ${email} esiste già.`);
    this.name = "DuplicateEmailError";
  }
}

export class UnknownOrganizationError extends Error {
  constructor() {
    super("L'organizzazione indicata non esiste.");
    this.name = "UnknownOrganizationError";
  }
}

// Postgres error codes — see https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";

function isPgErrorWithCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === code;
}

/** The slice of `pg.Pool` this module actually needs — lets tests pass a fake pool without a real Postgres connection (same reason `arald-backend/postgres-sync.ts` takes a minimal `SyncClient` interface instead of importing `pg`'s own types directly). */
export interface ConnectablePool {
  connect(): Promise<PoolClient>;
}

/**
 * Runs `fn` inside a single Postgres transaction on one checked-out client —
 * used by every write below that must keep its mutation and its
 * `audit_logs` entry atomic (found by review: writing them as two separate
 * pool.query() calls let a transient failure between the two either lose
 * the audit trail for a mutation that actually succeeded, or leave an Admin
 * believing a create failed and resubmitting it, when it hadn't).
 *
 * On any failure inside the transaction (the query itself, or the ROLLBACK
 * that follows it), the client is released *with* the error
 * (`client.release(err)`) rather than a plain `client.release()` — found by
 * a second review pass: releasing plainly tells node-postgres the
 * connection is healthy and safe to hand to the next, unrelated caller, but
 * a connection that just failed mid-transaction (especially if the ROLLBACK
 * itself also failed, e.g. a dropped socket) may still be in an aborted-
 * transaction state; releasing with an error makes the pool discard it and
 * open a fresh one instead of risking "current transaction is aborted"
 * errors on a completely unrelated later query.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>, pool: ConnectablePool = getPool()): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    client.release();
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Nothing more useful to do if the rollback itself fails — the original err (and the
      // release(err) below) are what matter.
    });
    client.release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

async function insertAuditLog(
  client: PoolClient,
  params: { actorUserId: string | null; actorEmail: string | null; action: string; details?: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, actor_email, action, details) VALUES ($1, $2, $3, $4)`,
    [params.actorUserId, params.actorEmail, params.action, params.details ? JSON.stringify(params.details) : null],
  );
}

export async function findUserByEmail(email: string): Promise<AppUser | undefined> {
  const db = getPool();
  const res = await db.query(
    `SELECT id, email, password_hash, role, organization_id, created_at FROM users WHERE email = $1`,
    [email],
  );
  const row = res.rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    organizationId: row.organization_id,
    createdAt: row.created_at,
  };
}

export async function listOrganizations(): Promise<Organization[]> {
  const db = getPool();
  const res = await db.query(`SELECT id, name, created_at FROM organizations ORDER BY name`);
  return res.rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
}

export async function createOrganization(
  params: { name: string; actorUserId: string; actorEmail: string },
  pool: ConnectablePool = getPool(),
): Promise<Organization> {
  return withTransaction(async (client) => {
    const id = randomUUID();
    const res = await client.query(
      `INSERT INTO organizations (id, name) VALUES ($1, $2) RETURNING id, name, created_at`,
      [id, params.name],
    );
    const row = res.rows[0];
    const organization: Organization = { id: row.id, name: row.name, createdAt: row.created_at };
    await insertAuditLog(client, {
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      action: "organization_created",
      details: { organizationId: organization.id, name: organization.name },
    });
    return organization;
  }, pool);
}

export async function listUsers(): Promise<PublicAppUser[]> {
  const db = getPool();
  const res = await db.query(`SELECT id, email, role, organization_id, created_at FROM users ORDER BY created_at DESC`);
  return res.rows.map((r) => ({ id: r.id, email: r.email, role: r.role, organizationId: r.organization_id, createdAt: r.created_at }));
}

/**
 * Creates an operator account. `organizationId` is forced to `null` for an
 * `admin` role regardless of what the caller passed — an Admin belongs to no
 * single organization by design (`lib/db.ts`'s `organizationFilterClause()`),
 * so silently ignoring a stray `organizationId` here is safer than accepting
 * one that would then never actually be used for anything, which could
 * mislead whoever reads it back from the `users` table later.
 *
 * `actorUserId` is `null` only for the one-shot bootstrap script
 * (`scripts/create-admin.ts`) creating the very first Admin — there is no
 * logged-in operator to attribute that creation to yet, so it attributes
 * itself (`actorEmail` is the new admin's own email, same convention the
 * original non-transactional version already used).
 */
export async function createUser(
  params: {
    email: string;
    passwordHash: string;
    role: UserRole;
    organizationId: string | null;
    actorUserId: string | null;
    actorEmail: string;
  },
  pool: ConnectablePool = getPool(),
): Promise<PublicAppUser> {
  return withTransaction(async (client) => {
    const id = randomUUID();
    const organizationId = params.role === "admin" ? null : params.organizationId;
    let row: { id: string; email: string; role: UserRole; organization_id: string | null; created_at: Date };
    try {
      const res = await client.query(
        `INSERT INTO users (id, email, password_hash, role, organization_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, role, organization_id, created_at`,
        [id, params.email, params.passwordHash, params.role, organizationId],
      );
      row = res.rows[0];
    } catch (err) {
      if (isPgErrorWithCode(err, PG_UNIQUE_VIOLATION)) throw new DuplicateEmailError(params.email);
      if (isPgErrorWithCode(err, PG_FOREIGN_KEY_VIOLATION)) throw new UnknownOrganizationError();
      throw err;
    }
    const user: PublicAppUser = { id: row.id, email: row.email, role: row.role, organizationId: row.organization_id, createdAt: row.created_at };
    await insertAuditLog(client, {
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      action: "user_created",
      details: { userId: user.id, email: user.email, role: user.role, organizationId: user.organizationId },
    });
    return user;
  }, pool);
}

export async function listAssignedNodes(): Promise<NodeAssignment[]> {
  const db = getPool();
  const res = await db.query(
    `SELECT n.node_url, n.organization_id, o.name AS organization_name, n.display_name, n.registered_at
     FROM nodes n
     JOIN organizations o ON o.id = n.organization_id
     ORDER BY n.registered_at DESC`,
  );
  return res.rows.map((r) => ({
    nodeUrl: r.node_url,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    displayName: r.display_name,
    registeredAt: r.registered_at,
  }));
}

/**
 * `node_url` values seen in any of the four mirror tables but not yet present
 * in `nodes` — exactly what an Admin needs to see in order to assign them to
 * an organization (`app/admin/`). A `UNION` (not `UNION ALL`) across the four
 * tables de-duplicates a node_url that appears in more than one of them.
 */
export async function listUnassignedNodeUrls(): Promise<string[]> {
  const db = getPool();
  const res = await db.query(`
    SELECT DISTINCT node_url FROM (
      SELECT node_url FROM relays
      UNION SELECT node_url FROM emergency_beacons
      UNION SELECT node_url FROM drops
      UNION SELECT node_url FROM node_status_snapshots
    ) all_known_nodes
    WHERE node_url NOT IN (SELECT node_url FROM nodes)
    ORDER BY node_url
  `);
  return res.rows.map((r) => r.node_url);
}

/**
 * Assigns (or re-assigns) a node to an organization — an upsert, so
 * re-running it with a new organizationId moves the node rather than
 * erroring on the existing row. The audit log entry records
 * `previousOrganizationId` (read inside the same transaction, before the
 * upsert) whenever this call actually moves a node from one organization to
 * another — found by review: without it, a reassignment (accidental or
 * malicious) left no trace anywhere of which organization lost visibility
 * into that node's data, only which one gained it.
 *
 * The preliminary `SELECT` uses `FOR UPDATE` — found by a second review
 * pass: without it, two concurrent reassignments of the *same* node both
 * read the pre-change organization under READ COMMITTED (Postgres's
 * default) before either has written, so the second transaction (once
 * unblocked by the row lock the upsert itself takes) would still record the
 * *original* organization as `previousOrganizationId` instead of the one
 * the first transaction just moved it to — silently losing a step of the
 * reassignment history. `FOR UPDATE` makes the second transaction's SELECT
 * itself block on the first transaction's commit and then re-read the
 * now-current value, closing that window. Locking a row that doesn't exist
 * yet (a node's first-ever assignment) is a no-op, never an error.
 */
export async function assignNode(
  params: {
    nodeUrl: string;
    organizationId: string;
    displayName?: string;
    actorUserId: string;
    actorEmail: string;
  },
  pool: ConnectablePool = getPool(),
): Promise<void> {
  return withTransaction(async (client) => {
    const existing = await client.query(`SELECT organization_id FROM nodes WHERE node_url = $1 FOR UPDATE`, [params.nodeUrl]);
    const previousOrganizationId: string | null = existing.rows[0]?.organization_id ?? null;

    try {
      await client.query(
        `INSERT INTO nodes (node_url, organization_id, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (node_url) DO UPDATE SET organization_id = EXCLUDED.organization_id, display_name = EXCLUDED.display_name`,
        [params.nodeUrl, params.organizationId, params.displayName ?? null],
      );
    } catch (err) {
      if (isPgErrorWithCode(err, PG_FOREIGN_KEY_VIOLATION)) throw new UnknownOrganizationError();
      throw err;
    }

    await insertAuditLog(client, {
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      action: "node_assigned",
      details: { nodeUrl: params.nodeUrl, organizationId: params.organizationId, previousOrganizationId, displayName: params.displayName ?? null },
    });
  }, pool);
}

export async function logAudit(params: {
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, actor_email, action, details) VALUES ($1, $2, $3, $4)`,
    [params.actorUserId ?? null, params.actorEmail ?? null, params.action, params.details ? JSON.stringify(params.details) : null],
  );
}

/**
 * Counts `login_failure` audit entries for `email` in the last
 * `windowSeconds` — the brute-force guard `auth.ts`'s `authorize()` checks
 * before ever touching `verifyPassword()` (found by review: nothing
 * previously throttled repeated password guesses against a known operator
 * email, only logged them after the fact). Reuses `audit_logs`, already
 * written on every failed login, instead of a new table/in-memory counter —
 * the latter wouldn't even work reliably across Vercel's separate
 * serverless function instances, while a Postgres-backed count does.
 * `make_interval(secs => $2)` keeps the window itself a bound parameter
 * rather than string-built SQL.
 */
export async function countRecentLoginFailures(email: string, windowSeconds: number): Promise<number> {
  const db = getPool();
  const res = await db.query(
    `SELECT count(*)::int AS count FROM audit_logs
     WHERE actor_email = $1 AND action = 'login_failure' AND created_at > now() - make_interval(secs => $2)`,
    [email, windowSeconds],
  );
  return res.rows[0]?.count ?? 0;
}

export async function listRecentAuditLogs(limit = 50): Promise<AuditLogEntry[]> {
  const db = getPool();
  const res = await db.query(
    `SELECT id, actor_user_id, actor_email, action, details, created_at FROM audit_logs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    actorUserId: r.actor_user_id,
    actorEmail: r.actor_email,
    action: r.action,
    details: r.details ?? null,
    createdAt: r.created_at,
  }));
}
