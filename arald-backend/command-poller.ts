import type { Pool } from "pg";

/**
 * The Box→specchio half of the canale di comando (Pezzo 1/2/4,
 * `docs/emergency-portal.md`): polls `remote_commands` for entries queued
 * for THIS Box's own `node_url` and delivers each one to the node this
 * script already talks to (`node-client.ts`'s own `nodeUrl`) — the Box
 * pulls, the specchio never pushes, same "no public IP" reasoning as every
 * other Box↔specchio direction in this project. Runs alongside the
 * existing sync tick (`sync.ts`), not a separate process — one Box, one
 * script to operate.
 *
 * `remote_commands.kind` (always set explicitly on insert — see
 * `mirror-portal/app/api/commands/*`) picks the ingest endpoint and body
 * shape: `'drop'` posts `{metadata, data, priority}` to `POST
 * /api/ingest-signed-content` ("Pezzo 1"), `'node-append'`, `'relay-command'`,
 * and `'external-delivery'` each post the whole submission object (stored
 * as-is in `metadata`, `data` unused — none of the three has a separate
 * binary blob outside `metadata`, `external-delivery`'s own ciphertext
 * included) to `POST /api/ingest-node-append` / `POST /api/ingest-relay-command`
 * / `POST /api/ingest-external-delivery` respectively ("Pezzo 2"/"Pezzo
 * 4"/"Pezzo 3", `docs/security.md` voci #82/#83/#84).
 */

const FETCH_TIMEOUT_MS = 10_000;
const MAX_COMMANDS_PER_TICK = 20; // a burst of queued commands shouldn't monopolize one tick indefinitely
/**
 * A command still `pending` after this long since it was queued gives up and is marked `failed`
 * instead of being retried forever — found by review: `fetchPendingCommands()` always orders
 * oldest-first, so a command stuck in a "deferred" outcome for a reason that never actually clears
 * (the Box permanently disabled `--allow-remote-content-ingest`, or its network password rotated
 * and was never updated here) would otherwise sit at the front of the queue, retried every tick
 * forever, and — because of that same ordering — permanently starve every newer command behind it
 * from ever being attempted at all, while `remote_commands` grows without bound. 24h mirrors
 * `DEFAULT_DROP_TTL_MS` (`node/src/node.ts`) — a command that couldn't be delivered in that long is
 * treated the same way a Drop's own default lifetime treats a notice tied to a moment: no longer
 * worth carrying forward.
 */
const MAX_COMMAND_AGE_BEFORE_GIVING_UP_MS = 24 * 60 * 60 * 1000;

interface PendingCommand {
  id: string;
  /** `'drop'` or `'node-append'` — see this module's own doc comment for how each maps onto an endpoint/body shape. */
  kind: string;
  metadata: unknown;
  data: string;
  priority: number;
  createdAt: Date;
}

export interface CommandPollSummary {
  delivered: number;
  failed: number;
  /** Commands left `pending` because delivery itself couldn't even be attempted (network-level failure to reach the node) — retried on the next tick, never counted as `failed`. */
  deferred: number;
}

async function fetchPendingCommands(pool: Pool, nodeUrl: string): Promise<PendingCommand[]> {
  const res = await pool.query(
    `SELECT id, kind, metadata, data, priority, created_at FROM remote_commands WHERE node_url = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT $2`,
    [nodeUrl, MAX_COMMANDS_PER_TICK],
  );
  return res.rows.map((r) => ({ id: r.id, kind: r.kind, metadata: r.metadata, data: r.data, priority: r.priority, createdAt: new Date(r.created_at) }));
}

async function markDelivered(pool: Pool, id: string): Promise<void> {
  await pool.query(`UPDATE remote_commands SET status = 'delivered', delivered_at = now(), error = NULL WHERE id = $1`, [id]);
}

async function markFailed(pool: Pool, id: string, error: string): Promise<void> {
  await pool.query(`UPDATE remote_commands SET status = 'failed', error = $2 WHERE id = $1`, [id, error]);
}

/** The ingest endpoint path + request body for one command's `kind` — see this module's own top doc comment for the two shapes. */
function ingestRequest(command: PendingCommand): { path: string; body: unknown } {
  if (command.kind === "node-append") {
    return { path: "/api/ingest-node-append", body: command.metadata };
  }
  if (command.kind === "relay-command") {
    return { path: "/api/ingest-relay-command", body: command.metadata };
  }
  if (command.kind === "external-delivery") {
    return { path: "/api/ingest-external-delivery", body: command.metadata };
  }
  return { path: "/api/ingest-signed-content", body: { metadata: command.metadata, data: command.data, priority: command.priority } };
}

/**
 * Posts one already-signed command to the node's ingest endpoint. Never
 * throws for an HTTP-level response — only for a genuine transport
 * failure (connection refused, timeout), same "distinguish deferred from
 * failed" posture `node-client.ts`'s own `fetchJson()` applies one layer
 * up. Returns `undefined` for a transport failure (caller leaves the
 * command `pending`, retried next tick); otherwise the response status +
 * body, letting the caller decide delivered vs. permanently failed.
 */
async function postCommand(nodeUrl: string, networkPassword: string, command: PendingCommand): Promise<{ status: number; body: unknown } | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const { path, body: requestBody } = ingestRequest(command);
    const res = await fetch(`${nodeUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${networkPassword}` },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    let responseBody: unknown;
    try {
      responseBody = await res.json();
    } catch {
      responseBody = undefined;
    }
    return { status: res.status, body: responseBody };
  } catch {
    return undefined; // transport failure — leave pending, retry next tick
  } finally {
    clearTimeout(timer);
  }
}

/** `true` for a response status that describes a problem with the specific command's own submitted bytes — never fixed by retrying the exact same bytes again, unlike 401 (stale password)/404 (feature disabled right now)/5xx (transient). */
function isTerminallyRejected(status: number): boolean {
  return status === 422 || status === 400 || status === 413;
}

/**
 * One tick: fetches this Box's own pending commands and attempts each in
 * turn. A single command's outcome never affects the others — same
 * "degrade, don't crash" posture as `syncSnapshotToPostgres()`. `2xx` and
 * every status `isTerminallyRejected()` names (422 "signature didn't
 * verify", plus 400 "malformed body"/413 "body too large" — found by
 * review: these two describe the command's own stored bytes, which never
 * change on retry, so leaving them `deferred` retried them forever) are
 * *terminal* outcomes — delivered or failed, never retried — while every
 * other status (401 stale password, 404 feature not enabled on this Box,
 * 408 a one-off timeout, a transient 5xx, 429 the Box's own per-identity or
 * elevated-drop/elevated-node-append budget) is left `pending` for the next tick, since those
 * describe a problem with reaching/using the endpoint right now, not with
 * the specific command — *unless* the command has been sitting `pending`
 * for longer than `MAX_COMMAND_AGE_BEFORE_GIVING_UP_MS`, in which case it
 * too is given up on and marked `failed` (see that constant's own doc
 * comment for why: otherwise a permanently-broken-but-technically-
 * "transient" status would retry forever and starve every newer command
 * queued behind it, since `fetchPendingCommands()` always fetches
 * oldest-pending-first).
 */
export async function pollAndDeliverCommands(pool: Pool, nodeUrl: string, networkPassword: string | undefined): Promise<CommandPollSummary> {
  const summary: CommandPollSummary = { delivered: 0, failed: 0, deferred: 0 };
  if (!networkPassword) return summary; // this Box's own network password is required to reach the endpoint at all

  const pending = await fetchPendingCommands(pool, nodeUrl);
  for (const command of pending) {
    const result = await postCommand(nodeUrl, networkPassword, command);
    const age = Date.now() - command.createdAt.getTime();

    if (result && result.status >= 200 && result.status < 300) {
      await markDelivered(pool, command.id);
      summary.delivered++;
      continue;
    }
    if (result && isTerminallyRejected(result.status)) {
      const body = result.body as { error?: string } | undefined;
      await markFailed(pool, command.id, body?.error ?? `delivery rejected with status ${result.status}`);
      summary.failed++;
      continue;
    }
    // Transport failure (result undefined), or a status describing a transient problem (401/404/
    // 408/429/5xx) — normally deferred, unless this command has been stuck long enough to give up.
    if (age > MAX_COMMAND_AGE_BEFORE_GIVING_UP_MS) {
      const reason = result ? `gave up after ${Math.round(age / (60 * 60 * 1000))}h, last status ${result.status}` : `gave up after ${Math.round(age / (60 * 60 * 1000))}h, node unreachable`;
      await markFailed(pool, command.id, reason);
      summary.failed++;
    } else {
      summary.deferred++;
    }
  }
  return summary;
}
