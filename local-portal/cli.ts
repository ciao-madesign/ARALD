import path from "node:path";
import { fileURLToPath } from "node:url";
import { StaticPortalServer } from "./static-server.js";

/**
 * Local copy of `nomad-hub/cli.ts`'s own `parseArgs()` — duplicated rather
 * than imported so `local-portal/` has zero coupling to `nomad-hub/`
 * (which administers Docker, a genuinely unrelated system) or
 * `gateway/nomad/` (same reasoning `nomad-hub/cli.ts`'s own copy of this
 * function already documents).
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
  const gatewayUrl = args["gateway-url"];

  if (!gatewayUrl) {
    console.error(
      "Usage: tsx local-portal/cli.ts --gateway-url http://<box-lan-ip>:<web-ui-port> [--port 8090] [--host 0.0.0.0]\n" +
        "--gateway-url must be an address reachable from whoever's browser opens this page — the Box's own LAN IP, never 127.0.0.1.",
    );
    process.exitCode = 1;
    return;
  }

  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mobile", "www");
  const port = args.port ? Number(args.port) : 8090;
  const host = args.host; // undefined -> StaticPortalServer/LoopbackHttpServer default to loopback-only

  const server = new StaticPortalServer({ rootDir, gatewayUrl, port, host });
  await server.start();

  console.log(`Local ARALD portal listening on http://${host ?? "127.0.0.1"}:${server.port}`);
  console.log(`Dashboard pre-configured to pair with the node's WebUiServer at ${gatewayUrl}`);
  if (!host) {
    console.log("Bound to loopback only — pass --host <box-lan-ip-or-0.0.0.0> to make it reachable from other devices on the LAN.");
  }
}

main().catch((err) => {
  console.error("local-portal failed to start:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
