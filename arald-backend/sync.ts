import { Pool } from "pg";
import { fetchNodeSnapshot } from "./node-client.js";
import { syncSnapshotToPostgres } from "./postgres-sync.js";
import { runPeriodicSync } from "./periodic.js";

/**
 * Reads one already-running ARALD node's local mesh state
 * (relays/SOS/drops/node-appends/status) over HTTP and writes it into the
 * shared `arald_portal` Postgres schema (`docs/emergency-portal.md`) —
 * the "Box → specchio" half of the corrected architecture (the mirror is
 * never written to directly by anything but this sync, and never the
 * other way around for reads).
 *
 * Runs once and exits by default (the original scope, still useful for a
 * manual run or a one-off check); pass `--interval-ms` to run forever
 * instead, syncing on a timer until stopped with Ctrl-C/SIGTERM — the
 * shape a real Box would actually run continuously. A single failed tick
 * (node briefly unreachable, mirror briefly unreachable) never stops the
 * loop — see `periodic.ts`'s own doc comment.
 *
 * `DATABASE_URL` deliberately never has a default and is never logged —
 * same posture as `--management-password`/`--network-password` elsewhere
 * in this repository: a real credential, printed nowhere, read from the
 * environment or an explicit flag, never hardcoded.
 */

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = "true";
    }
  }
  return args;
}

async function syncOnce(pool: Pool, nodeUrl: string, networkPassword: string | undefined): Promise<void> {
  const snapshot = await fetchNodeSnapshot({ nodeUrl, networkPassword });
  const summary = await syncSnapshotToPostgres(pool, nodeUrl, snapshot);

  console.log(`Synced from ${nodeUrl}:`);
  console.log(`  relays:            ${summary.relays}`);
  console.log(`  emergency beacons: ${summary.emergencyBeacons}`);
  console.log(`  drops:             ${summary.drops}`);
  console.log(`  node appends:      ${summary.nodeAppends}`);
  console.log(`  status snapshot:   ${summary.statusSnapshot ? "recorded" : "skipped (node unreachable or malformed)"}`);
  if (snapshot.skipped.length > 0) {
    console.log("Skipped:");
    for (const reason of snapshot.skipped) console.log(`  - ${reason}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const nodeUrl = args["node-url"];
  const databaseUrl = args["database-url"] ?? process.env.DATABASE_URL;
  const networkPassword = args["network-password"] ?? process.env.ARALD_NETWORK_PASSWORD;
  const intervalMs = args["interval-ms"] ? Number(args["interval-ms"]) : undefined;

  if (!nodeUrl || !databaseUrl || (intervalMs !== undefined && (!Number.isFinite(intervalMs) || intervalMs <= 0))) {
    console.error(
      "Usage: tsx arald-backend/sync.ts --node-url http://host:port --database-url postgres://... [--network-password ...] [--interval-ms 60000]\n" +
        "(--database-url can also come from $DATABASE_URL, --network-password from $ARALD_NETWORK_PASSWORD)\n" +
        "Without --interval-ms, runs once and exits. With it, runs forever on that interval until stopped (Ctrl-C/SIGTERM).",
    );
    process.exitCode = 1;
    return;
  }

  // Explicit timeouts, not `pg`'s own no-timeout defaults: without these, a tick whose connection to
  // the mirror silently black-holes (packets dropped after the TCP handshake, no RST) can hang
  // forever — found by review, since runPeriodicSync() deliberately lets an in-flight tick finish
  // before honoring Ctrl-C/SIGTERM, an unreachable-forever tick would mean graceful shutdown never
  // completes at all, only a SIGKILL would. query_timeout is the client-side bound that actually
  // fires regardless of what the network/server do; statement_timeout is the same bound enforced
  // server-side too, for whichever half of a stalled round-trip the client-side timer might race.
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000, query_timeout: 15_000, statement_timeout: 15_000 });
  try {
    if (intervalMs === undefined) {
      await syncOnce(pool, nodeUrl, networkPassword);
      return;
    }

    const controller = new AbortController();
    const stop = (): void => {
      console.log("Stopping after the current sync finishes...");
      controller.abort();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    console.log(`Syncing from ${nodeUrl} every ${intervalMs}ms until stopped (Ctrl-C).`);
    await runPeriodicSync({
      intervalMs,
      signal: controller.signal,
      runOnce: () => syncOnce(pool, nodeUrl, networkPassword),
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("arald-backend sync failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
