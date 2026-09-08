import { NomadNode } from "./node.js";
import { TcpTransport } from "./transports/tcp.js";
import { WebUiServer, generateNetworkPassword } from "./web-ui.js";
import { MbtilesReader } from "./map-tiles.js";
import { TrustLevel } from "./trust.js";

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

  // Self-declared battery level (spec §51 — no real hardware sensors in this prototype), same value
  // both RelayPolicy's own "battery-above" mode and reportRelayTelemetry() read via
  // relayPolicy.getCurrentResourceState(). Omit --battery-percent entirely to leave it unknown
  // (relayPolicy default, reportRelayTelemetry() then throws a clear error instead of reporting
  // garbage — see that method's own doc comment).
  let batteryPercent: number | undefined;
  if (args["battery-percent"] !== undefined) {
    batteryPercent = Number(args["battery-percent"]);
    if (!Number.isFinite(batteryPercent) || batteryPercent < 0 || batteryPercent > 100) {
      console.error(`--battery-percent must be a number in [0, 100], got: ${args["battery-percent"]}`);
      process.exit(1);
    }
  }

  const node = new NomadNode({
    displayName,
    relayPolicy: batteryPercent !== undefined ? { getResourceState: () => ({ batteryPercent }) } : undefined,
  });
  node.addTransport(new TcpTransport(node.nodeId, port));
  await node.start();

  console.log("ARALD Node");
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

  // Same opt-in shape as --register-as-location-registry, for reportRelayTelemetry() instead of
  // shareLocation() (docs/beacon.md, "Fixed Relay e Registro dei relay").
  if (args["register-as-relay-registry"] === "true") {
    node.registerAsRelayRegistry();
    console.log("Registered as a relay registry (service://relay-registry)");
  }

  // The one specific node id (typically the Emergency Node this relay reports to) allowed to send
  // this relay a command (node.ts's minTrustForRelayCommand, default TrustLevel.ADMIN — the
  // strictest gate in this codebase). Never assigned automatically by ordinary protocol activity,
  // unlike SEEN/VERIFIED — an operator provisioning this relay must set it explicitly, out-of-band,
  // the same "provisioned once, by whoever sets up the mesh" model already used for
  // --report-relay-telemetry-interval-ms's counterpart on the Emergency Node side.
  if (args["trust-admin"]) {
    node.trust.set(args["trust-admin"], TrustLevel.ADMIN);
    console.log(`Trusted as ADMIN (can send this relay commands, e.g. reboot): ${args["trust-admin"]}`);
  }

  // Periodically reports this relay's own battery level (see --battery-percent above) to whichever
  // node advertises service://relay-registry — a no-op error (logged, not fatal) until a registry is
  // actually discovered, e.g. right after this relay starts up before it has connected to anything.
  let telemetryInterval: NodeJS.Timeout | undefined;
  if (args["report-relay-telemetry-interval-ms"]) {
    const intervalMs = Number(args["report-relay-telemetry-interval-ms"]);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      console.error(`--report-relay-telemetry-interval-ms must be a positive number, got: ${args["report-relay-telemetry-interval-ms"]}`);
      process.exit(1);
    }
    telemetryInterval = setInterval(() => {
      node.reportRelayTelemetry().catch((err) => console.error(`Relay telemetry report failed: ${(err as Error).message}`));
    }, intervalMs);
    console.log(`Reporting relay telemetry every ${intervalMs}ms`);
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
    // Opt-in, same shape as --expose-location-registry — gates both GET and POST /api/relays
    // (docs/beacon.md "Fixed Relay e Registro dei relay"), see WebUiOptions.exposeRelayRegistry's
    // own doc comment for why writing isn't split off onto allowServiceCalls the way
    // --expose-location-registry's own write side (POST /api/location-report) is.
    const exposeRelayRegistry = args["expose-relay-registry"] === "true";
    // Opt-in, same shape as --expose-relay-registry — gates GET /api/emergency-beacons
    // (docs/beacon.md, the Emergency Node view), see WebUiOptions.exposeEmergencyBeacons's own doc
    // comment for why there is no write side to gate: a SOS only ever arrives from the mesh.
    const exposeEmergencyBeacons = args["expose-emergency-beacons"] === "true";
    // A dedicated location-registry node (docs/next-steps.md Opzione J) needs the same
    // networkName/networkPassword pairing mechanism as any other mobile-facing node — just handed
    // out separately to trusted operators only, never to guests, which is exactly what makes it a
    // *different* node's password rather than a new access-control mechanism of its own. Same
    // reasoning extends to a relay-registry/Emergency Node.
    const needsNetworkPassword = allowServiceCalls || exposeLocationRegistry || exposeRelayRegistry || exposeEmergencyBeacons;
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
      exposeRelayRegistry,
      exposeEmergencyBeacons,
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
    if (exposeRelayRegistry) {
      console.log(`Relay registry exposed: GET/POST /api/relays (stessa password di rete)`);
      console.log(`Relay remote-reboot command exposed: POST /api/relay-command (stessa password di rete)`);
    }
    if (exposeEmergencyBeacons) {
      console.log(`Emergency beacon sightings exposed: GET /api/emergency-beacons (stessa password di rete)`);
    }
    if (mapTiles) {
      console.log(`Map tiles exposed: GET /api/map-info, GET /api/map-tiles/:z/:x/:y (non autenticati — non dati sensibili)`);
    }
  }

  // Idempotency guard (found by review): with --allow-remote-reboot below, more than one accepted
  // relay command (allowed within MAX_RELAY_COMMANDS_PER_WINDOW) — or a reboot command racing an
  // ordinary SIGINT/SIGTERM — would otherwise each independently call the body below, overlapping
  // clearInterval/webUi.stop()/node.stop() calls before the first invocation's process.exit(0) has
  // actually run. A plain boolean is enough: shutdown() is only ever called from synchronous event
  // handlers (never awaited by its own callers), so there's no interleaving between the check and
  // the flag being set.
  //
  // The flag is reset on failure (found by a second review): without the catch/reset below, a
  // thrown error partway through (e.g. webUi.stop() failing) would leave shuttingDown permanently
  // true, silently swallowed by void shutdown()'s missing .catch — every later SIGINT/SIGTERM/reboot
  // command would then hit the early return and do nothing, leaving the process stuck with only
  // SIGKILL left as an escape hatch. Resetting lets a repeated Ctrl-C (or a second remote reboot
  // command) try again, the same retry behavior a naive, unguarded shutdown() had before this fix —
  // which in turn requires every step in the retried sequence to itself be safe to repeat.
  // LoopbackHttpServer.stop() (webUi) already guards itself (`if (!this.server) return`), but
  // node:sqlite's DatabaseSync.close() (mapTiles) does not — it throws on an already-closed
  // database (found by a third review) — so mapTiles is nulled out right after a successful close,
  // making a retry's `mapTiles?.close()` the safe no-op it needs to be, rather than a second,
  // permanent throw that would make every later retry fail at the exact same line forever.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (telemetryInterval) clearInterval(telemetryInterval);
      if (webUi) await webUi.stop();
      if (mapTiles) {
        mapTiles.close();
        mapTiles = undefined;
      }
      await node.stop();
      process.exit(0);
    } catch (err) {
      console.error("Shutdown failed, will retry on the next signal/command:", err);
      shuttingDown = false;
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Opt-in on top of the trust gate itself (node.ts's minTrustForRelayCommand) — deliberately a
  // *second*, independent switch: even a correctly-configured --trust-admin should not, by itself,
  // make this specific process exit on command unless the operator running it has also explicitly
  // decided that's the right consequence here (e.g. because it's running under a supervisor —
  // systemd, pm2, a Docker restart policy — that will bring it back up). Reuses shutdown() above for
  // a clean exit (closes webUi/mapTiles/transports) rather than a bare process.exit() — the same
  // "reboot" a SIGTERM would already trigger, just initiated remotely instead of locally.
  if (args["allow-remote-reboot"] === "true") {
    node.on("relay:reboot-requested", (senderId: string) => {
      console.log(`[RELAY] reboot requested by ${senderId} — shutting down for the process supervisor to restart`);
      void shutdown();
    });
    console.log("Remote reboot enabled — only a node trusted at TrustLevel.ADMIN (see --trust-admin) can trigger it");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
