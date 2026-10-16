import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { TileService } from "../tools/map-data/tile-service.js";
import { DesignToolRoutes } from "./design-tool.js";
import { StaticPortalServer } from "./static-server.js";

/**
 * Local copy of `nomad-hub/cli.ts`'s own `parseArgs()` — duplicated rather
 * than imported so `local-portal/` has zero coupling to `nomad-hub/`
 * (which administers Docker, a genuinely unrelated system) or
 * `gateway/local-services/` (same reasoning `nomad-hub/cli.ts`'s own copy of this
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
        "       [--no-design-tool] [--no-design-tool-tiles] [--tile-cache <dir>] [--cap-gb 1.5] [--max-new-per-hour 400]\n" +
        "--gateway-url must be an address reachable from whoever's browser opens this page — the Box's own LAN IP, never 127.0.0.1.",
    );
    process.exitCode = 1;
    return;
  }

  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mobile", "www");
  const port = args.port ? Number(args.port) : 8090;
  const host = args.host; // undefined -> StaticPortalServer/LoopbackHttpServer default to loopback-only

  // Network Design Tool sotto /strumento-rete/ (dietro la password di rete del nodo): serve la pagina costruita
  // (`npm run design-tool:build`, già fatto da `npm run portal:local`); le tessere del mondo si scaricano da Internet solo
  // se il Box ne ha, e si possono spegnere con --no-design-tool-tiles.
  const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "network-design", "dist");
  let designTool: DesignToolRoutes | undefined;
  if (args["no-design-tool"] !== "true") {
    if (existsSync(path.join(distDir, "index.html"))) {
      const tiles = args["no-design-tool-tiles"] === "true"
        ? undefined
        : new TileService({ dir: args["tile-cache"], capBytes: args["cap-gb"] ? Number(args["cap-gb"]) * 1e9 : undefined, maxNewPerHour: args["max-new-per-hour"] ? Number(args["max-new-per-hour"]) : undefined });
      designTool = new DesignToolRoutes({ distDir, gatewayUrl, tiles });
    } else {
      console.warn("Strumento di progettazione non attivo: manca tools/network-design/dist/ (esegui «npm run design-tool:build»).");
    }
  }

  const server = new StaticPortalServer({ rootDir, gatewayUrl, port, host, designTool });
  await server.start();

  console.log(`Local ARALD portal listening on http://${host ?? "127.0.0.1"}:${server.port}`);
  console.log(`Dashboard pre-configured to pair with the node's WebUiServer at ${gatewayUrl}`);
  if (designTool) console.log(`Strumento di progettazione della rete: /strumento-rete/ (accesso con la password di rete del nodo${args["no-design-tool-tiles"] === "true" ? "; terreno del mondo spento" : "; terreno del mondo se il Box ha Internet"}).`);
  if (!host) {
    console.log("Bound to loopback only — pass --host <box-lan-ip-or-0.0.0.0> to make it reachable from other devices on the LAN.");
  }
}

main().catch((err) => {
  console.error("local-portal failed to start:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
