import { NomadNode } from "./node.js";
import { TcpTransport } from "./transports/tcp.js";
import { WebUiServer, generateNetworkPassword } from "./web-ui.js";
import { MbtilesReader } from "./map-tiles.js";

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
  const port = Number(args.port ?? 9001);
  const displayName = args.id ?? `NODE-${port}`;

  const node = new NomadNode({ displayName });
  node.addTransport(new TcpTransport(node.nodeId, port));
  await node.start();

  console.log("Nomad-Net Node");
  console.log(`Display name: ${displayName}`);
  console.log(`Node ID: ${node.nodeId}`);
  console.log(`Listening on port: ${port}`);
  console.log(`Status: ${node.status}`);

  if (args.connect) {
    const [host, portStr] = args.connect.split(":");
    try {
      const peerId = await node.connect({ host, port: Number(portStr) });
      console.log(`Connected to peer ${peerId} at ${args.connect}`);
    } catch (err) {
      console.error(`Failed to connect to ${args.connect}:`, (err as Error).message);
    }
  }

  node.on("data", (packet) => {
    console.log(`[DATA] from ${packet.source}: ${JSON.stringify(packet.payload)}`);
  });
  node.on("peer:connected", (peerId: string) => console.log(`[PEER] connected: ${peerId}`));
  node.on("peer:disconnected", (peerId: string) => console.log(`[PEER] disconnected: ${peerId}`));

  // Never automatic — only a node an operator explicitly designates as a location registry
  // (docs/next-steps.md Opzione J "tracciamento posizione") registers service://location-registry,
  // so other nodes' shareLocation() can discover it. See registerAsLocationRegistry()'s own doc
  // comment in node.ts for why reading the collected reports back also needs --expose-location-registry
  // below (a separate opt-in) — registering this service alone doesn't expose anything over HTTP.
  if (args["register-as-location-registry"] === "true") {
    node.registerAsLocationRegistry();
    console.log("Registered as a location registry (service://location-registry)");
  }

  // Off by default (spec §59 web interface) — only started when explicitly requested, since it
  // opens a second listening socket even though it's loopback-bound by default (web-ui.ts).
  let webUi: WebUiServer | undefined;
  // Declared outside the block below so shutdown() can close() it — node:sqlite's DatabaseSync
  // holds an open file handle until then, same reasoning any other opened resource in this file
  // (webUi's socket, the node's transports) already gets a matching shutdown-time close.
  let mapTiles: MbtilesReader | undefined;
  if (args["web-port"]) {
    const allowServiceCalls = args["allow-service-calls"] === "true";
    const exposeLocationRegistry = args["expose-location-registry"] === "true";
    // A dedicated location-registry node (docs/next-steps.md Opzione J) needs the same
    // networkName/networkPassword pairing mechanism as any other mobile-facing node — just handed
    // out separately to trusted operators only, never to guests, which is exactly what makes it a
    // *different* node's password rather than a new access-control mechanism of its own.
    const needsNetworkPassword = allowServiceCalls || exposeLocationRegistry;
    // Generated fresh every run, printed/shown once, never persisted — the mobile client (Opzione H,
    // docs/next-steps.md) is expected to be paired by re-entering this each time the node restarts,
    // the same "out of band, by the operator" trust model as a Wi-Fi router's own password.
    const networkName = needsNetworkPassword ? (args["network-name"] ?? displayName) : undefined;
    const networkPassword = needsNetworkPassword ? (args["network-password"] ?? generateNetworkPassword()) : undefined;

    // Opt-in, same posture as --expose-location-registry — nothing about offline map tiles is
    // offered unless an operator explicitly points at a prepared MBTiles file
    // (docs/next-steps.md). No network-password gate needed here: unlike the location registry,
    // map tiles aren't personal data (see WebUiOptions.mapTiles's own doc comment) — reading and
    // opening the file happens once, up front, so a bad/missing file is reported here and the node
    // simply starts without the feature, same non-fatal posture already used for NewsGateway.
    if (args["map-file"]) {
      try {
        mapTiles = new MbtilesReader(args["map-file"]);
        console.log(
          `Map tiles loaded: "${mapTiles.metadata.name}" (${mapTiles.metadata.format}, zoom ${mapTiles.metadata.minzoom ?? "?"}-${mapTiles.metadata.maxzoom ?? "?"})`,
        );
      } catch (err) {
        console.error(`Map tiles not loaded — ${(err as Error).message}`);
      }
    }

    webUi = new WebUiServer(node, {
      port: Number(args["web-port"]),
      host: args["web-host"],
      allowServiceCalls,
      exposeLocationRegistry,
      networkName,
      networkPassword,
      publicHost: args["public-host"],
      mapTiles,
    });
    await webUi.start();
    const webHost = args["web-host"] ?? "127.0.0.1";
    console.log(`Web UI: http://${webHost}:${webUi.port}`);
    if (needsNetworkPassword) {
      console.log(`Mobile network name: ${networkName}`);
      console.log(`Mobile network password: ${networkPassword}`);
      // handlePairing() (web-ui.ts) only serves /api/pairing (and thus the QR panel) when
      // allowServiceCalls is on — an exposeLocationRegistry-only node still has networkName/
      // networkPassword above for a human to relay verbally/by hand, just no QR shortcut for it.
      if (allowServiceCalls) {
        console.log(`(anche visibili, con QR da inquadrare, sulla pagina web sopra, sezione "Collega un telefono")`);
      }
      if (!args["web-host"]) {
        console.log(`Note: --web-host wasn't set, so the Web UI is still loopback-only — a phone on the same Wi-Fi can't reach it yet.`);
      }
    }
    if (exposeLocationRegistry) {
      console.log(`Location registry read endpoint exposed: GET /api/location-registry (stessa password di rete)`);
    }
    if (mapTiles) {
      console.log(`Map tiles exposed: GET /api/map-info, GET /api/map-tiles/:z/:x/:y (non autenticati — non dati sensibili)`);
    }
  }

  const shutdown = async (): Promise<void> => {
    if (webUi) await webUi.stop();
    mapTiles?.close();
    await node.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
