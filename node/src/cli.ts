import { readFileSync } from "node:fs";
import { autoDetect } from "@serialport/bindings-cpp";
import { SerialPortStream } from "@serialport/stream";
import { NomadNode } from "./node.js";
import type { Transport } from "./transport.js";
import { TcpTransport } from "./transports/tcp.js";
import { LoraSerialTransport } from "./transports/lora-serial.js";
import { LoraSerialSx1262Transport } from "./transports/lora-serial-sx1262.js";
import { WebUiServer, generateNetworkPassword } from "./web-ui.js";
import { MbtilesReader } from "./map-tiles.js";
import { TrustLevel } from "./trust.js";
import {
  MAX_EXTERNAL_DELIVERY_DESTINATION_ID_LENGTH,
  MAX_EXTERNAL_DELIVERY_LABEL_LENGTH,
  type ExternalDeliveryAllowlist,
  type ExternalDeliveryDestination,
} from "./external-delivery.js";

/**
 * Loads `--external-delivery-destinations`' JSON file into an
 * `ExternalDeliveryAllowlist` — the admin's single source of truth for
 * "Consegna esterna differita" (`docs/service-catalog.md`): each entry's
 * `url`/`password` never leave this process (`node.publishExternalDeliveryDirectory()`
 * projects only `{destinationId, label, publicKeyHex, requiresPassword}`
 * out to the mesh-wide public directory). Same non-fatal posture as
 * `--map-file` immediately below in `main()`: a missing or malformed file
 * only disables this role for this run (logged, never `process.exit()`) —
 * a node offering ordinary mesh services has no reason to refuse to start
 * just because an optional admin file wasn't ready yet.
 */
function loadExternalDeliveryAllowlist(path: string): ExternalDeliveryAllowlist | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`--external-delivery-destinations: could not read ${path} — ${(err as Error).message}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`--external-delivery-destinations: malformed JSON in ${path} — ${(err as Error).message}`);
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    console.error(`--external-delivery-destinations: ${path} must contain a JSON array`);
    return undefined;
  }
  const allowlist: ExternalDeliveryAllowlist = new Map();
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") {
      console.error(`--external-delivery-destinations: skipping a non-object entry in ${path}`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.destinationId !== "string" ||
      entry.destinationId.length === 0 ||
      entry.destinationId.length > MAX_EXTERNAL_DELIVERY_DESTINATION_ID_LENGTH
    ) {
      console.error(`--external-delivery-destinations: skipping an entry with an invalid "destinationId" in ${path}`);
      continue;
    }
    if (typeof entry.label !== "string" || entry.label.length === 0 || entry.label.length > MAX_EXTERNAL_DELIVERY_LABEL_LENGTH) {
      console.error(`--external-delivery-destinations: skipping "${entry.destinationId}" — invalid "label" in ${path}`);
      continue;
    }
    if (typeof entry.publicKeyHex !== "string" || entry.publicKeyHex.length === 0) {
      console.error(`--external-delivery-destinations: skipping "${entry.destinationId}" — invalid "publicKeyHex" in ${path}`);
      continue;
    }
    if (typeof entry.url !== "string" || entry.url.length === 0) {
      console.error(`--external-delivery-destinations: skipping "${entry.destinationId}" — invalid "url" in ${path}`);
      continue;
    }
    if (entry.password !== undefined && (typeof entry.password !== "string" || entry.password.length === 0)) {
      console.error(`--external-delivery-destinations: skipping "${entry.destinationId}" — invalid "password" in ${path}`);
      continue;
    }
    const destination: ExternalDeliveryDestination = {
      destinationId: entry.destinationId,
      label: entry.label,
      publicKeyHex: entry.publicKeyHex,
      url: entry.url,
      password: entry.password as string | undefined,
    };
    allowlist.set(destination.destinationId, destination);
  }
  return allowlist;
}

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

/** Same `Number()` + explicit range check + `process.exit(1)` pattern already used inline for `--battery-percent` above, factored out since the LoRa flags below need it four times. `undefined` when the flag itself is absent — lets `--lora-frequency-hz`/etc. fall through to `LoraSerialTransportOptions`'s own defaults instead of this file re-declaring them (`--lora-baud-rate`'s caller applies its own `?? 115200` on top, since a serial baud rate isn't one of that options object's fields). */
function parsePositiveNumberFlag(flagName: string, rawValue: string | undefined): number | undefined {
  if (rawValue === undefined) return undefined;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${flagName} must be a positive number, got: ${rawValue}`);
    process.exit(1);
  }
  return value;
}

/** Same shape as `parsePositiveNumberFlag()`, additionally requiring an integer within `[min, max]` — used for `--lora-spreading-factor` (SX127x supports 6-12, `sx127x-registers.ts`). */
function parseRangedIntFlag(flagName: string, rawValue: string | undefined, min: number, max: number): number | undefined {
  if (rawValue === undefined) return undefined;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.error(`--${flagName} must be an integer in [${min}, ${max}], got: ${rawValue}`);
    process.exit(1);
  }
  return value;
}

/** `LoraSerialTransportOptions.codingRateDenominator` is typed as exactly `5 | 6 | 7 | 8` (the four coding rates `RegModemConfig1` supports) — validated against that literal set, not just "a number in range", so an invalid value is rejected here rather than silently reaching `buildModemConfig1Byte()` (`sx127x-registers.ts`, which does not itself validate). */
function parseCodingRateDenominatorFlag(rawValue: string | undefined): 5 | 6 | 7 | 8 | undefined {
  if (rawValue === undefined) return undefined;
  const value = Number(rawValue);
  if (value !== 5 && value !== 6 && value !== 7 && value !== 8) {
    console.error(`--lora-coding-rate-denominator must be one of 5, 6, 7, 8, got: ${rawValue}`);
    process.exit(1);
  }
  return value;
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

  // Opt-in — nothing about "Consegna esterna differita" (docs/service-catalog.md) activates unless
  // an operator explicitly points at a prepared destinations file, same posture as --map-file below.
  const externalDeliveryAllowlist = args["external-delivery-destinations"]
    ? loadExternalDeliveryAllowlist(args["external-delivery-destinations"])
    : undefined;
  const maxExternalDeliveryEntries = parsePositiveNumberFlag("max-external-delivery-entries", args["max-external-delivery-entries"]);
  const maxExternalDeliveryBytes = parsePositiveNumberFlag("max-external-delivery-bytes", args["max-external-delivery-bytes"]);
  const externalDeliveryTtlMs = parsePositiveNumberFlag("external-delivery-ttl-ms", args["external-delivery-ttl-ms"]);
  const maxExternalDeliveryPayloadBytes = parsePositiveNumberFlag(
    "max-external-delivery-payload-bytes",
    args["max-external-delivery-payload-bytes"],
  );

  const node = new NomadNode({
    displayName,
    relayPolicy: batteryPercent !== undefined ? { getResourceState: () => ({ batteryPercent }) } : undefined,
    externalDeliveryAllowlist,
    maxExternalDeliveryEntries,
    maxExternalDeliveryBytes,
    externalDeliveryTtlMs,
    maxExternalDeliveryPayloadBytes,
  });
  node.addTransport(new TcpTransport(node.nodeId, port));

  // Opt-in, off by default — wires either node/src/transports/lora-serial.ts (voce #61, SX127x) or
  // node/src/transports/lora-serial-sx1262.ts (SX1262, ARALD's standardized chip across Box/Portable/
  // Card as of docs/compliance.md's 9 settembre 2026 update — see that file's own doc comment for why
  // it's not an adaptation of the SX127x one) onto an actual serial device via
  // @serialport/bindings-cpp (autoDetect() picks the right native binding for the current OS).
  // `--lora-chip` selects which (default "sx127x", for continuity with every existing deployment —
  // an operator moving to SX1262 opts in explicitly). Everything below this flag is still unverified
  // against a real chip in this environment (no hardware available here) — this only makes either
  // driver *reachable* from the CLI, the same honest boundary already declared for both drivers
  // themselves.
  //
  // `!== undefined` (not a truthy check) plus an explicit empty-string rejection — found by review:
  // `--lora-serial-port ""` (e.g. an unset shell variable interpolated into the flag) would otherwise
  // silently skip this entire block, starting the node over TCP alone with no error at all, exactly
  // the opposite of this feature's own stated intent ("un operatore che chiede esplicitamente un
  // profilo LoRa reale merita un fallimento immediato e chiaro").
  let loraStatusLine: string | undefined;
  if (args["lora-serial-port"] !== undefined) {
    const serialPortPath = args["lora-serial-port"];
    if (serialPortPath === "") {
      console.error("--lora-serial-port was given an empty value");
      process.exit(1);
    }
    const loraChip = args["lora-chip"] ?? "sx127x";
    if (loraChip !== "sx127x" && loraChip !== "sx1262") {
      console.error(`--lora-chip must be "sx127x" or "sx1262", got: ${loraChip}`);
      process.exit(1);
    }
    const baudRate = parsePositiveNumberFlag("lora-baud-rate", args["lora-baud-rate"]) ?? 115200;
    const frequencyHz = parsePositiveNumberFlag("lora-frequency-hz", args["lora-frequency-hz"]);
    const bandwidthHz = parsePositiveNumberFlag("lora-bandwidth-hz", args["lora-bandwidth-hz"]);
    // SX1262 supports spreading factor 5 (sx126x-commands.ts), one wider than SX127x's floor of 6.
    const spreadingFactor = parseRangedIntFlag(
      "lora-spreading-factor",
      args["lora-spreading-factor"],
      loraChip === "sx1262" ? 5 : 6,
      12,
    );
    const codingRateDenominator = parseCodingRateDenominatorFlag(args["lora-coding-rate-denominator"]);

    const stream = new SerialPortStream({ binding: autoDetect(), path: serialPortPath, baudRate });
    let loraTransport: Transport;
    if (loraChip === "sx1262") {
      // -9..14 dBm — the same always-safe range buildSetTxParamsCommand() (sx126x-commands.ts) clamps
      // to regardless; validated here too so an out-of-range value fails loudly at the CLI rather than
      // silently getting clamped without the operator noticing.
      const txPowerDbm = parseRangedIntFlag("lora-tx-power-dbm", args["lora-tx-power-dbm"], -9, 14);
      loraTransport = new LoraSerialSx1262Transport(node.nodeId, stream, {
        frequencyHz,
        bandwidthHz,
        spreadingFactor,
        codingRateDenominator,
        txPowerDbm,
      });
    } else {
      loraTransport = new LoraSerialTransport(node.nodeId, stream, {
        frequencyHz,
        bandwidthHz,
        spreadingFactor,
        codingRateDenominator,
      });
    }
    node.addTransport(loraTransport);
    // Logged only after `node.start()` below actually succeeds (see that line) — found by review:
    // printing this here, before the chip handshake `node.start()` performs, reads as a success
    // message immediately followed by a fatal crash whenever the chip doesn't respond, unlike every
    // other status line in this file (all printed only once their underlying action has completed).
    loraStatusLine = `LoRa (seriale reale, ${loraChip.toUpperCase()}): ${serialPortPath} @ ${baudRate} baud`;
  }

  await node.start();
  if (loraStatusLine) console.log(loraStatusLine);

  // Explicit call, never automatic (see NomadNode.publishExternalDeliveryDirectory()'s own doc
  // comment — same "opt-in action on top of opt-in config" shape as registerAsLocationRegistry()/
  // registerAsRelayRegistry() below) — only reached at all when the file above actually loaded.
  if (externalDeliveryAllowlist) {
    node.publishExternalDeliveryDirectory();
    console.log(`Consegna esterna differita: ${externalDeliveryAllowlist.size} destinazioni pubblicate (content://external-delivery-directory)`);
  }

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
  //
  // `!== undefined` (not a truthy check) plus an explicit empty-string rejection — same fix already
  // applied to --lora-serial-port and (see below) --report-relay-telemetry-interval-ms, flagged as
  // still outstanding here by the review that made those two fixes (docs/security.md voce #67):
  // `--trust-admin ""` (e.g. an unset shell variable interpolated into the flag in a provisioning
  // script) would otherwise silently skip this whole block — combined with --allow-remote-reboot,
  // this relay would then never accept a legitimate reboot command, with no diagnostic pointing at
  // the cause.
  if (args["trust-admin"] !== undefined) {
    if (args["trust-admin"] === "") {
      console.error("--trust-admin was given an empty value");
      process.exit(1);
    }
    node.trust.set(args["trust-admin"], TrustLevel.ADMIN);
    console.log(`Trusted as ADMIN (can send this relay commands, e.g. reboot): ${args["trust-admin"]}`);
  }

  // Periodically reports this relay's own battery level (see --battery-percent above) to whichever
  // node advertises service://relay-registry — a no-op error (logged, not fatal) until a registry is
  // actually discovered, e.g. right after this relay starts up before it has connected to anything.
  let telemetryInterval: NodeJS.Timeout | undefined;
  // `!== undefined`, not a truthy check — found by a second review round, the exact same
  // empty-string-silently-skips-the-block pattern just fixed for --lora-serial-port above. Unlike that
  // flag (a path, not validatable as "a number"), an empty string here flows straight into
  // parsePositiveNumberFlag() below and is rejected there on its own (`Number("") === 0`, which fails
  // the `value <= 0` check) — no separate empty-string branch needed for a numeric flag.
  if (args["report-relay-telemetry-interval-ms"] !== undefined) {
    // Reuses parsePositiveNumberFlag() (added below for the --lora-* flags) for the validation itself
    // instead of the separate inline check this block had before — found by review: the two were an
    // identical "positive finite number, else error and exit(1)" rule kept in two places, easy to
    // update one and miss the other. Re-parsed via Number() right after — cheap, and avoids the type
    // system seeing a possible `undefined` here that can't actually happen (the flag is present, per
    // the `if` above, and the helper already exits the process before ever returning on any invalid value).
    parsePositiveNumberFlag("report-relay-telemetry-interval-ms", args["report-relay-telemetry-interval-ms"]);
    const intervalMs = Number(args["report-relay-telemetry-interval-ms"]);
    telemetryInterval = setInterval(() => {
      node.reportRelayTelemetry().catch((err) => console.error(`Relay telemetry report failed: ${(err as Error).message}`));
    }, intervalMs);
    console.log(`Reporting relay telemetry every ${intervalMs}ms`);
  }

  // Same non-owning-timer shape as --report-relay-telemetry-interval-ms immediately above (NomadNode
  // itself owns no setInterval — see CLAUDE.md's own convention) — drives attemptExternalDeliveries()
  // (external-delivery.ts) to retry the queue toward whichever external destinations are reachable
  // right now. A no-op call (attemptExternalDeliveries() itself) when externalDeliveryAllowlist wasn't
  // configured, so this flag is harmless (if pointless) to pass on a node not offering the role.
  let externalDeliveryInterval: NodeJS.Timeout | undefined;
  if (args["external-delivery-poll-interval-ms"] !== undefined) {
    // Same validate-then-reparse shape as --report-relay-telemetry-interval-ms above, for the same
    // reason (see that block's own comment): parsePositiveNumberFlag()'s return type is `number |
    // undefined`, and setInterval() needs a plain `number` — re-parsing via Number() right after is
    // cheap and avoids a non-null assertion, since the helper itself already exits the process before
    // ever returning on an invalid value.
    parsePositiveNumberFlag("external-delivery-poll-interval-ms", args["external-delivery-poll-interval-ms"]);
    const intervalMs = Number(args["external-delivery-poll-interval-ms"]);
    externalDeliveryInterval = setInterval(() => {
      node.attemptExternalDeliveries().catch((err) => console.error(`External delivery attempt failed: ${(err as Error).message}`));
    }, intervalMs);
    console.log(`Attempting external delivery every ${intervalMs}ms`);
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
      if (externalDeliveryInterval) clearInterval(externalDeliveryInterval);
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
