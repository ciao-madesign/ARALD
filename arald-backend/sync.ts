import { Pool } from "pg";
import { fetchNodeSnapshot } from "./node-client.js";
import { syncSnapshotToPostgres } from "./postgres-sync.js";

/**
 * One-shot sync: reads one already-running ARALD node's local mesh state
 * (relays/SOS/drops/node-appends/status) over HTTP and writes it into the
 * shared `arald_portal` Postgres schema (`docs/emergency-portal.md`).
 *
 * Deliberately the smallest possible first piece of the proposed "ARALD
 * Backend" — no server, no scheduling, no auth of its own, no write path
 * back into the mesh. A real future ARALD Box would run something shaped
 * like this on a timer against several nodes at once; this script proves
 * the one node -> one sync -> one database step works before any of that
 * is built.
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const nodeUrl = args["node-url"];
  const databaseUrl = args["database-url"] ?? process.env.DATABASE_URL;
  const networkPassword = args["network-password"] ?? process.env.ARALD_NETWORK_PASSWORD;

  if (!nodeUrl || !databaseUrl) {
    console.error(
      "Usage: tsx arald-backend/sync.ts --node-url http://host:port --database-url postgres://... [--network-password ...]\n" +
        "(--database-url can also come from $DATABASE_URL, --network-password from $ARALD_NETWORK_PASSWORD)",
    );
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
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
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("arald-backend sync failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
