import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { BodyTooLargeError, LoopbackHttpServer, readRequestBody, sendJson } from "./loopback-http-server.js";
import type { NomadNode } from "./node.js";
import type { ContentMetadata } from "./content.js";
import { MAX_MESSAGE_TEXT_LENGTH, type StoredMessage } from "./message-history.js";
import type { TrustLevel } from "./trust.js";
import { encodeQr, qrToSvg } from "./qrcode.js";
import { raceTimeout } from "./async-timeout.js";

export interface WebUiOptions {
  /** Port to listen on; 0 (default) lets the OS assign one — useful in tests, mirrors TcpTransport's own `port` convention. */
  port?: number;
  /**
   * Deliberately bound to loopback only by default (spec §59 describes a
   * local status/search page, not a public one) — this prototype has no
   * authentication on the read-only endpoints below, so binding wider than
   * localhost without one would expose this node's peer list, known
   * content, and search to anyone who can reach the port. Set this to your
   * LAN address (e.g. the machine's Wi-Fi IP) only when a mobile client on
   * the same network needs to reach it — see `allowServiceCalls` for the
   * one endpoint that additionally requires a pairing token regardless of
   * `host`.
   */
  host?: string;
  /**
   * Self-declared, the same way `RelayPolicy`'s battery/charging state is
   * (relay-policy.ts) — this prototype has no real Internet connectivity
   * probe, and spec §60's whole point is "Internet: OFFLINE / Nomad-Net:
   * ONLINE" as the experience to demonstrate, not something to detect.
   * Defaults to always reporting OFFLINE.
   */
  internetStatus?: () => "ONLINE" | "OFFLINE";
  /**
   * Enables `POST /api/call` (spec §36-37 `CALL service://...`) — the one
   * write/action endpoint this otherwise strictly read-only interface
   * exposes, built for the mobile client (`docs/next-steps.md` Opzione H)
   * to invoke a service like `service://ai` from a phone. Off by default;
   * when true, `networkPassword` is required (the constructor throws
   * otherwise) — there is no scenario where this should be enabled without
   * one, since it lets any caller who has the password invoke any
   * registered service with any payload, a materially bigger risk than the
   * read-only endpoints below it.
   */
  allowServiceCalls?: boolean;
  /**
   * A human-friendly label for this node's mobile pairing "network" — the
   * same role a Wi-Fi router's SSID plays, so a person setting up the
   * mobile app (`docs/next-steps.md` Opzione H) thinks in terms of "join
   * this network" rather than "enter this IP address". Purely cosmetic,
   * never used to route or authenticate anything — served back by
   * `/api/status` and `/api/pairing` (both only when `allowServiceCalls` is
   * true) so the mobile app can show "Connesso a: <networkName>" instead
   * of the raw address once paired. Defaults to `node.displayName` if
   * `allowServiceCalls` is true and this isn't given.
   */
  networkName?: string;
  /**
   * Required when `allowServiceCalls` is true — the "Wi-Fi password"
   * equivalent for pairing a mobile client. Every `POST /api/call` request
   * must carry this exact value as `Authorization: Bearer <password>`
   * (compared in constant time via `node:crypto.timingSafeEqual` to avoid
   * a timing side-channel); a mismatched or missing one gets `401`.
   * `generateNetworkPassword()` below produces one in a short, typeable
   * format (e.g. `K7XM-2QRT`) — deliberately not a long hex string, the
   * same reasoning a Wi-Fi router's default WPA key is short and
   * human-typeable rather than cryptographically maximal. Also served back
   * by `/api/pairing` (unauthenticated — reading the password can't
   * itself require the password) so a human standing at this node's own
   * screen can read it off and relay it verbally, the same way a Wi-Fi
   * password is often shared out loud or off a router sticker rather than
   * only ever read from a terminal — see `docs/security.md` for what that
   * implies about who can read it.
   */
  networkPassword?: string;
  /**
   * The address (host, no port) a phone on the same network should use to reach this node — the
   * "one-time address" a human types once into the mobile app (`mobile/README.md`), and what the
   * QR code on `/api/pairing`/the dashboard's "Collega un telefono" panel encodes alongside
   * `networkName`/`networkPassword` so scanning it needs zero typing at all. Only meaningful
   * together with `allowServiceCalls`. When omitted and `host` is a wildcard/loopback address
   * (`0.0.0.0`, `127.0.0.1`, `localhost`, `::`, or simply not given), this is auto-detected via
   * `node:os.networkInterfaces()` (first non-internal IPv4 address found) — a best-effort guess
   * that can pick the wrong interface on a multi-NIC machine (VPNs, Docker bridges, ...), which is
   * exactly why this option exists to override it explicitly. No QR/`address` field is served at
   * all when neither resolves to anything (e.g. no network interface found) — degrades to the
   * existing text-only pairing panel rather than emitting a guess that might be wrong.
   */
  publicHost?: string;
}

const WILDCARD_OR_LOOPBACK_HOSTS = new Set(["0.0.0.0", "127.0.0.1", "localhost", "::", "::1"]);

/**
 * The exact paths iOS/macOS, Android, Windows, and Firefox/Linux each
 * request automatically right after joining a Wi-Fi network, to decide
 * whether to show their own "Sign in to network" popup — well-known,
 * externally-defined by each OS, not something this project controls:
 *   - Apple: `/hotspot-detect.html`, `/library/test/success.html`
 *     (expects a specific "Success" HTML page)
 *   - Android/ChromeOS: `/generate_204`, `/gen_204` (expects HTTP 204, empty body)
 *   - Windows: `/connecttest.txt` (expects "Microsoft Connect Test"), `/ncsi.txt` (expects "Microsoft NCSI")
 *   - Firefox/Linux (NetworkManager): `/success.txt` (expects "success\n")
 * This node answers every one of them with the same 302 to `/` (see the
 * call site) — different from what each OS expects as "already online",
 * which is exactly what makes each of them conclude there's a captive
 * portal and open a browser on their own. Not guaranteed on every
 * OS/version (this project doesn't control that behavior) — the manual
 * QR/network-name+password pairing flow (`docs/guida-hardware-rifugio.md`)
 * always remains available as a fallback regardless.
 */
const CAPTIVE_PORTAL_PROBE_PATHS = new Set([
  "/hotspot-detect.html",
  "/library/test/success.html",
  "/generate_204",
  "/gen_204",
  "/connecttest.txt",
  "/ncsi.txt",
  "/success.txt",
]);

/** Best-effort LAN IPv4 address for this machine — see `WebUiOptions.publicHost`'s doc comment for why this is a fallback, not the primary source of truth. */
function detectLanIPv4(): string | undefined {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return undefined;
}

interface StatusPayload {
  displayName: string;
  nodeId: string;
  connected: boolean;
  internet: "ONLINE" | "OFFLINE";
  localNetwork: "ONLINE" | "OFFLINE";
  peers: number;
  services: number;
  /** Of everything this node currently knows *exists* (locally cached + known elsewhere via catalog sync), the share it actually holds bytes for. 0 when nothing is known at all yet, rather than a vacuous 100%. */
  cachedContentPercent: number;
  /** `NomadNode.canRelayNow()` — whether this node is currently willing to forward other peers' traffic (spec §51/§58), not whether it answers requests addressed to itself. */
  relaying: boolean;
  /** This node's mobile-pairing "network name" (`WebUiOptions.networkName`) — present only when `allowServiceCalls` is on, since that's the only time the concept of a pairing network exists at all. */
  networkName?: string;
}

interface PairingInfo {
  networkName: string;
  networkPassword: string;
  /** `host:port` a phone should connect to — present only when a public host could be resolved (explicit `publicHost` or auto-detected LAN IPv4), see `WebUiOptions.publicHost`. */
  address?: string;
  /** `data:image/svg+xml;base64,...` — a scannable QR encoding `nomadnet://pair?h=<address>&n=<networkName>&p=<networkPassword>`, so the mobile app never needs any of the three typed manually. Present only when `address` is known and the pairing URI fits the encoder's capacity (`node/src/qrcode.ts`, ~272 bytes) — omitted, not an empty string, when either isn't true, so the client can tell "not offered" apart from "would be an empty image". */
  qrDataUri?: string;
}

const PAIRING_URI_PREFIX = "nomadnet://pair?";

/** `nomadnet://pair?h=<host:port>&n=<networkName>&p=<networkPassword>` — parsed back by the mobile app's QR scanner (`mobile/www/app.js`, `parsePairingUri()`), never interpreted by the OS (no intent filter registered, this scheme is only ever read by our own camera-scanning code, not "opened"). */
function buildPairingUri(address: string, networkName: string, networkPassword: string): string {
  const params = new URLSearchParams({ h: address, n: networkName, p: networkPassword });
  return PAIRING_URI_PREFIX + params.toString();
}

interface PeerEntry {
  nodeId: string;
  shortLabel: string;
  trustLevel: TrustLevel;
  connectedAt: number;
  lastSeen: number;
  /** Whether this peer's encryption key is already known (`peerDirectory`) — `sendPrivateMessage()`/the chat UI's "message" action needs this; identity sync can lag a moment behind the connection itself. */
  canMessage: boolean;
}

interface ServiceEntry {
  serviceId: string;
  version: string;
  capabilities: string[];
  providerId: string;
  providerLabel: string;
  /** True when this node itself is the provider — the client renders this distinctly from a remote provider. */
  isLocal: boolean;
  availability: boolean;
}

interface ContentEntry {
  contentId: string;
  name: string;
  mimeType: string;
  size: number;
  availableLocally: boolean;
  /**
   * Best-effort routing hint for content this node knows about but doesn't
   * hold — deliberately NOT a full path like spec §59's mockup
   * (`NODE-B -> NODE-C -> NOMAD`): this prototype's distance-vector routing
   * (routing-table.ts, spec §22) only ever knows the best *next hop* toward
   * a destination, never the full multi-hop path, so showing one would be
   * fabricated. `undefined` when no route is known yet either.
   */
  availableThrough?: string;
}

interface GroupSummary {
  groupId: string;
  name: string;
  members: string[];
  createdBy: string;
  createdAt: number;
}

/** `GroupInfo` minus `key` — the group's symmetric key never leaves this node over HTTP, even to an authenticated caller (the mobile app never needs it directly; the server does the encrypting/decrypting on its behalf). */
function toGroupSummary(info: { groupId: string; name: string; members: string[]; createdBy: string; createdAt: number }): GroupSummary {
  return { groupId: info.groupId, name: info.name, members: info.members, createdBy: info.createdBy, createdAt: info.createdAt };
}

interface ChannelSummary {
  channel: string;
  messageCount: number;
  /** `timestamp` of the most recent message this node has learned for `channel` — lets a client sort/highlight by recent activity without fetching every channel's full history. */
  lastActivity: number;
}

/** Every public channel this node currently has at least one message for (spec's content-centric design has no channel-creation step, so "known channels" only ever means "channels this node has actually learned a message in") — public/no-auth, same tier as `/api/content`, since channel messages are explicitly not private (spec §56 only calls out 1:1 private messages, not public channels). */
function buildChannelList(node: NomadNode): ChannelSummary[] {
  return node.publicChannels.list().map((channel) => {
    const messages = node.publicChannels.get(channel);
    return { channel, messageCount: messages.length, lastActivity: messages[messages.length - 1].timestamp };
  });
}

function buildStatus(node: NomadNode, internetStatus: () => "ONLINE" | "OFFLINE", networkName: string | undefined): StatusPayload {
  // Uses listKnownContent()'s own dedup-by-contentId (contentStore.size + remoteCatalog.size would
  // double-count anything present in both — e.g. learned via catalog sync and later actually
  // fetched, where handleContentComplete() stores the bytes but never prunes the now-redundant
  // remoteCatalog entry).
  const known = node.listKnownContent();
  const localCount = known.filter((metadata) => node.contentStore.has(metadata.contentId)).length;
  const cachedContentPercent = known.length === 0 ? 0 : Math.round((localCount / known.length) * 100);

  return {
    displayName: node.displayName,
    nodeId: node.nodeId,
    connected: node.status === "ONLINE",
    internet: internetStatus(),
    localNetwork: node.status === "ONLINE" ? "ONLINE" : "OFFLINE",
    peers: node.peers.size,
    // listKnownServices() itself deliberately includes unavailable entries (general "everything
    // ever heard of" knowledge, mirrors listKnownContent()) — the status page's "Services" count
    // means "usable right now", so it filters here rather than narrowing the shared API's contract.
    services: node.listKnownServices().filter((announcement) => announcement.availability).length,
    cachedContentPercent,
    relaying: node.canRelayNow(),
    networkName,
  };
}

function shortNodeLabel(nodeId: string): string {
  return `NODE-${nodeId.slice(0, 8)}`;
}

function buildPeers(node: NomadNode): PeerEntry[] {
  return node.peers.list().map((peer) => ({
    nodeId: peer.id,
    shortLabel: shortNodeLabel(peer.id),
    trustLevel: node.trust.get(peer.id),
    connectedAt: peer.connectedAt,
    lastSeen: peer.lastSeen,
    canMessage: node.peerDirectory.has(peer.id),
  }));
}

function buildServices(node: NomadNode): ServiceEntry[] {
  return node.listKnownServices().map((announcement) => ({
    serviceId: announcement.serviceId,
    version: announcement.version,
    capabilities: announcement.capabilities,
    providerId: announcement.providerId,
    providerLabel: announcement.providerId === node.nodeId ? "Questo nodo" : shortNodeLabel(announcement.providerId),
    isLocal: announcement.providerId === node.nodeId,
    availability: announcement.availability,
  }));
}

function contentEntryFor(node: NomadNode, metadata: ContentMetadata): ContentEntry {
  const availableLocally = node.contentStore.has(metadata.contentId);
  let availableThrough: string | undefined;
  if (!availableLocally && metadata.publisherId) {
    const route = node.routingTable.bestRoute(metadata.publisherId);
    if (route) availableThrough = `next hop: ${shortNodeLabel(route.nextHop)}`;
  }
  return {
    contentId: metadata.contentId,
    name: metadata.name,
    mimeType: metadata.mimeType,
    size: metadata.size,
    availableLocally,
    availableThrough,
  };
}

/** Everything this node knows about (spec §59 "browse", not just search) — same shape `buildSearchResults()` filters down to a query match. */
function buildContentList(node: NomadNode): ContentEntry[] {
  return node.listKnownContent().map((metadata) => contentEntryFor(node, metadata));
}

function buildSearchResults(node: NomadNode, query: string): ContentEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  return node
    .listKnownContent()
    .filter((metadata) => metadata.name.toLowerCase().includes(needle))
    .map((metadata) => contentEntryFor(node, metadata));
}

const PAGE_HTML = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>NOMAD-NET</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f6f5; --card: #ffffff; --border: #d9dfdc; --ink: #16211e; --muted: #5c6b66;
    --accent: #1f7a68; --accent-soft: #e2f1ed;
    --good: #1f7a4a; --good-soft: #e3f3e8;
    --warn: #a8631a; --warn-soft: #faeee0;
    --off: #8a938f; --off-soft: #ecefed;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101614; --card: #182220; --border: #2b3733; --ink: #e7ece9; --muted: #93a19b;
      --accent: #4fbfa2; --accent-soft: #163a32;
      --good: #4fbf7c; --good-soft: #163a24;
      --warn: #e0a352; --warn-soft: #3a2c14;
      --off: #6b7671; --off-soft: #202a26;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--ink);
    max-width: 64em; margin: 0 auto; padding: 1.5em 1em 3em;
    line-height: 1.45;
  }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 0.5em; margin-bottom: 1.2em; }
  h1 { margin: 0; font-size: 1.4em; letter-spacing: 0.02em; }
  h2 { margin: 0 0 0.7em; font-size: 1em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  #node-label { font-size: 0.85em; color: var(--muted); }
  .pill { display: inline-flex; align-items: center; gap: 0.4em; padding: 0.25em 0.7em; border-radius: 999px; font-size: 0.82em; font-weight: 600; }
  .pill.good { background: var(--good-soft); color: var(--good); }
  .pill.warn { background: var(--warn-soft); color: var(--warn); }
  .pill.off { background: var(--off-soft); color: var(--off); }
  .dot { width: 0.55em; height: 0.55em; border-radius: 50%; background: currentColor; flex: none; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5em, 1fr)); gap: 0.7em; margin-bottom: 1.4em; }
  .stat { background: var(--card); border: 1px solid var(--border); border-radius: 0.6em; padding: 0.8em 1em; }
  .stat .v { font-size: 1.5em; font-weight: 700; }
  .stat .l { font-size: 0.78em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 1em; margin-bottom: 1em; }
  @media (max-width: 44em) { .panels { grid-template-columns: 1fr; } }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 0.6em; padding: 1em; }
  .panel ul { list-style: none; margin: 0; padding: 0; }
  .panel li { padding: 0.55em 0; border-top: 1px solid var(--border); }
  .panel li:first-child { border-top: none; padding-top: 0; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 0.6em; }
  .row-title { display: flex; align-items: center; gap: 0.5em; min-width: 0; }
  .row-title span.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .muted { color: var(--muted); font-size: 0.85em; }
  .tags { display: flex; gap: 0.3em; flex-wrap: wrap; margin-top: 0.3em; }
  .tag { font-size: 0.72em; background: var(--bg); border: 1px solid var(--border); border-radius: 0.3em; padding: 0.05em 0.4em; color: var(--muted); }
  .empty { color: var(--muted); font-style: italic; padding: 0.4em 0; }
  #search-input { width: 100%; font: inherit; padding: 0.55em 0.7em; border-radius: 0.5em; border: 1px solid var(--border); background: var(--bg); color: var(--ink); margin-bottom: 0.8em; }
  #content-panel { margin-bottom: 1em; }
  #pairing-panel { margin-bottom: 1em; border-color: var(--accent); }
  #pairing-panel .pairing-body { display: flex; gap: 1.4em; flex-wrap: wrap; align-items: flex-start; }
  #pairing-panel .pairing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(11em, 1fr)); gap: 1em; flex: 1; min-width: 12em; }
  #pairing-panel .k { font-size: 0.78em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 0.25em; }
  #pairing-panel .v { font-size: 1.35em; font-weight: 700; font-family: ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.02em; }
  #pairing-panel p { margin: 0.8em 0 0; font-size: 0.85em; color: var(--muted); }
  #pairing-qr { width: 9em; height: 9em; border-radius: 0.5em; background: #fff; padding: 0.5em; flex: none; }
</style>
</head>
<body>
<header>
  <div>
    <h1>NOMAD-NET</h1>
    <div id="node-label" class="mono"></div>
  </div>
  <span id="connected-pill" class="pill off"><span class="dot"></span><span>...</span></span>
</header>

<div id="stats" class="stats"></div>

<section class="panel" id="pairing-panel" hidden>
  <h2>Collega un telefono</h2>
  <div class="pairing-body">
    <img id="pairing-qr" alt="QR di pairing" hidden>
    <div class="pairing-grid">
      <div>
        <div class="k">Nome rete</div>
        <div class="v" id="pairing-name"></div>
      </div>
      <div>
        <div class="k">Password</div>
        <div class="v mono" id="pairing-password"></div>
      </div>
    </div>
  </div>
  <p>Apri l'app Nomad-Net sul telefono, sulla stessa rete Wi-Fi, e inquadra il QR — oppure inserisci questi dati a mano.</p>
</section>

<div class="panels">
  <section class="panel">
    <h2>Vicini connessi</h2>
    <ul id="peers"></ul>
  </section>
  <section class="panel">
    <h2>Servizi conosciuti</h2>
    <ul id="services"></ul>
  </section>
</div>

<section class="panel" id="content-panel">
  <h2>Contenuti</h2>
  <form id="search-form">
    <input id="search-input" type="text" placeholder="Cerca per nome..." autocomplete="off">
  </form>
  <ul id="content"></ul>
</section>

<script>
function timeAgo(ms) {
  var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "adesso";
  var m = Math.round(s / 60);
  if (m < 60) return "da " + m + " min";
  var h = Math.round(m / 60);
  if (h < 24) return "da " + h + " h";
  return "da " + Math.round(h / 24) + " g";
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

var TRUST_LABELS = {
  UNKNOWN: "Sconosciuto",
  SEEN: "Visto",
  VERIFIED: "Verificato",
  TRUSTED: "Fidato",
  ADMIN: "Admin",
};

function el(tag, props, children) {
  var e = document.createElement(tag);
  if (props) for (var k in props) { if (k === "className") e.className = props[k]; else if (k === "textContent") e.textContent = props[k]; }
  if (children) for (var i = 0; i < children.length; i++) e.append(children[i]);
  return e;
}

function renderEmptyIfNeeded(list, items, message) {
  list.textContent = "";
  if (items.length === 0) {
    list.append(el("li", null, [el("div", { className: "empty", textContent: message })]));
    return true;
  }
  return false;
}

function renderStats(s) {
  var stats = document.getElementById("stats");
  stats.textContent = "";
  var entries = [
    ["Vicini", String(s.peers)],
    ["Servizi attivi", String(s.services)],
    ["Contenuto in cache", s.cachedContentPercent + "%"],
    ["Relay", s.relaying ? "attivo" : "fermo"],
    ["Internet", s.internet === "ONLINE" ? "online" : "offline"],
    ["Rete Nomad-Net", s.localNetwork === "ONLINE" ? "online" : "offline"],
  ];
  for (var i = 0; i < entries.length; i++) {
    stats.append(el("div", { className: "stat" }, [
      el("div", { className: "v", textContent: entries[i][1] }),
      el("div", { className: "l", textContent: entries[i][0] }),
    ]));
  }

  var pill = document.getElementById("connected-pill");
  pill.className = "pill " + (s.connected ? "good" : "off");
  pill.querySelector("span:last-child").textContent = s.connected ? "Connesso" : "Non connesso";

  document.getElementById("node-label").textContent = s.displayName + " · " + s.nodeId.slice(0, 12) + "...";
}

function renderPeers(peers) {
  var list = document.getElementById("peers");
  if (renderEmptyIfNeeded(list, peers, "Nessun vicino connesso al momento.")) return;
  for (var i = 0; i < peers.length; i++) {
    var p = peers[i];
    list.append(el("li", null, [
      el("div", { className: "row" }, [
        el("div", { className: "row-title" }, [el("span", { className: "name mono", textContent: p.shortLabel })]),
        el("span", { className: "muted", textContent: timeAgo(p.connectedAt) }),
      ]),
      el("div", { className: "tags" }, [el("span", { className: "tag", textContent: TRUST_LABELS[p.trustLevel] || p.trustLevel })]),
    ]));
  }
}

function renderServices(services) {
  var list = document.getElementById("services");
  if (renderEmptyIfNeeded(list, services, "Nessun servizio conosciuto.")) return;
  for (var i = 0; i < services.length; i++) {
    var svc = services[i];
    var pill = el("span", { className: "pill " + (svc.availability ? "good" : "off"), textContent: svc.availability ? "disponibile" : "non disponibile" });
    list.append(el("li", null, [
      el("div", { className: "row" }, [
        el("div", { className: "row-title" }, [el("span", { className: "name mono", textContent: svc.serviceId })]),
        pill,
      ]),
      el("div", { className: "muted", textContent: (svc.isLocal ? "Offerto da questo nodo" : "Offerto da " + svc.providerLabel) + " · v" + svc.version }),
      el("div", { className: "tags" }, (Array.isArray(svc.capabilities) ? svc.capabilities : []).map(function (c) { return el("span", { className: "tag", textContent: String(c) }); })),
    ]));
  }
}

function renderContent(entries, emptyMessage) {
  var list = document.getElementById("content");
  if (renderEmptyIfNeeded(list, entries, emptyMessage)) return;
  for (var i = 0; i < entries.length; i++) {
    var c = entries[i];
    var pill = el("span", { className: "pill " + (c.availableLocally ? "good" : "warn"), textContent: c.availableLocally ? "in cache" : "remoto" });
    list.append(el("li", null, [
      el("div", { className: "row" }, [
        el("div", { className: "row-title" }, [el("span", { className: "name", textContent: c.name })]),
        pill,
      ]),
      el("div", { className: "muted", textContent: c.mimeType + " · " + formatBytes(c.size) + (c.availableThrough ? " · " + c.availableThrough : "") }),
    ]));
  }
}

async function fetchJson(path) {
  var res = await fetch(path);
  return res.json();
}

async function refreshStatus() {
  renderStats(await fetchJson("/api/status"));
}

async function refreshPeers() {
  renderPeers(await fetchJson("/api/peers"));
}

async function refreshServices() {
  renderServices(await fetchJson("/api/services"));
}

// Bumped on every refreshContent() call and captured per-call, so a response for a since-superseded
// query (e.g. the periodic 5s poll firing while a debounced keystroke fetch is still in flight, or
// two keystrokes racing each other) can never overwrite a newer render — only the response matching
// the *latest* request is ever applied.
var contentRequestId = 0;

async function refreshContent() {
  var requestId = ++contentRequestId;
  var q = document.getElementById("search-input").value.trim();
  var entries, emptyMessage;
  if (q.length === 0) {
    entries = await fetchJson("/api/content");
    emptyMessage = "Nessun contenuto conosciuto ancora.";
  } else {
    entries = await fetchJson("/api/search?q=" + encodeURIComponent(q));
    emptyMessage = "Nessun risultato per \\"" + q + "\\".";
  }
  if (requestId !== contentRequestId) return; // superseded by a newer request while this one was in flight
  renderContent(entries, emptyMessage);
}

var searchDebounce;
document.getElementById("search-input").addEventListener("input", function () {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(refreshContent, 250);
});
document.getElementById("search-form").addEventListener("submit", function (event) {
  event.preventDefault();
  clearTimeout(searchDebounce);
  refreshContent();
});

function refreshAll() {
  refreshStatus();
  refreshPeers();
  refreshServices();
  refreshContent();
}

// Fetched once, not on the 5s poll — the network name/password never change for the lifetime of
// this server process (cli.ts generates a fresh one only on restart), so there's nothing to refresh.
async function loadPairingInfo() {
  var res = await fetch("/api/pairing");
  if (!res.ok) return; // pairing not enabled on this node — panel stays hidden
  var info = await res.json();
  document.getElementById("pairing-name").textContent = info.networkName;
  document.getElementById("pairing-password").textContent = info.networkPassword;
  var qr = document.getElementById("pairing-qr");
  if (info.qrDataUri) {
    qr.src = info.qrDataUri; // data: URI set via .src, never innerHTML — see mobile app's own textContent-only discipline
    qr.hidden = false;
  }
  document.getElementById("pairing-panel").hidden = false;
}

refreshAll();
loadPairingInfo();
setInterval(refreshAll, 5000);
</script>
</body>
</html>
`;

/**
 * Local status/search web interface (spec §59): "l'utente non deve essere
 * costretto a capire il routing" — a human-readable dashboard over data
 * this node already tracks (peers, known services, cached-content ratio)
 * plus content browsing/search. Loopback-bound by default (see
 * `WebUiOptions`) and, for every endpoint except one, strictly read-only —
 * this is a status page, not a general admin API. The one exception is
 * `POST /api/call` (`handleCall()` below), added for the mobile client
 * (`docs/next-steps.md` Opzione H) so a phone can invoke a service like
 * `service://ai`: off unless `allowServiceCalls` is explicitly set, and
 * gated by its own network password even when it is, regardless of
 * whether `host` is loopback or a LAN address — see `docs/security.md`.
 * `GET /api/pairing` (`handlePairing()` below) shows that same network
 * name/password back for a human to read, deliberately without requiring
 * the password itself.
 */
export class WebUiServer {
  private readonly node: NomadNode;
  private readonly internetStatus: () => "ONLINE" | "OFFLINE";
  private readonly allowServiceCalls: boolean;
  private readonly networkName: string | undefined;
  private readonly networkPassword: string | undefined;
  private readonly publicHost: string | undefined;
  private cachedPairingInfo: PairingInfo | undefined;
  private readonly httpServer: LoopbackHttpServer;

  constructor(node: NomadNode, options: WebUiOptions = {}) {
    this.node = node;
    this.internetStatus = options.internetStatus ?? (() => "OFFLINE");
    this.allowServiceCalls = options.allowServiceCalls ?? false;
    if (this.allowServiceCalls && !options.networkPassword) {
      throw new Error("WebUiServer: allowServiceCalls requires a networkPassword");
    }
    this.networkName = this.allowServiceCalls ? (options.networkName ?? node.displayName) : undefined;
    this.networkPassword = options.networkPassword;
    const boundHost = options.host ?? "127.0.0.1";
    this.publicHost = options.publicHost ?? (WILDCARD_OR_LOOPBACK_HOSTS.has(boundHost) ? detectLanIPv4() : boundHost);
    this.httpServer = new LoopbackHttpServer((req, res) => this.handleRequest(req, res), {
      port: options.port,
      host: options.host,
    });
  }

  /** Actual bound port once started (useful when constructed with port 0, e.g. in tests); the requested port before that. */
  get port(): number {
    return this.httpServer.port;
  }

  async start(): Promise<void> {
    await this.httpServer.start();
  }

  async stop(): Promise<void> {
    await this.httpServer.stop();
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // A mobile client (docs/next-steps.md Opzione H) is a separate origin from this server (a
    // Capacitor WebView, not a page this server itself served), so its fetch()es are cross-origin
    // and blocked by the browser/WebView's own CORS enforcement unless this response explicitly
    // allows it — tied to allowServiceCalls specifically, the same flag that already opts a
    // deployment into "an external client is expected to talk to this", rather than a separate
    // toggle. Applied uniformly up front (every response, including 404s) instead of sprinkled
    // through each branch below.
    if (this.allowServiceCalls) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }

    if (req.method === "OPTIONS") {
      // A cross-origin POST with a custom `Authorization` header and a JSON Content-Type is a
      // "non-simple" request, so a real browser/WebView sends this preflight before the actual
      // POST /api/call — only relevant (and only answered) when that endpoint is actually reachable.
      if (this.allowServiceCalls) {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "600",
        });
      } else {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end();
      return;
    }

    if (req.method === "POST") {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/call") {
        void this.handleCall(req, res);
        return;
      }
      if (url.pathname === "/api/messages") {
        void this.handleSendMessage(req, res);
        return;
      }
      if (url.pathname === "/api/channel-messages") {
        void this.handleSendChannelMessage(req, res);
        return;
      }
      if (url.pathname === "/api/groups") {
        void this.handleCreateGroup(req, res);
        return;
      }
      if (url.pathname === "/api/group-messages") {
        void this.handleSendGroupMessage(req, res);
        return;
      }
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    // req.method is provably GET or HEAD by this point — both earlier branches (POST, everything
    // else) already returned — so req.url can be trusted directly, no fallback-to-"/" ternary needed.
    const url = new URL(req.url ?? "/", "http://localhost");

    // Captive-portal auto-redirect: once this node's own Wi-Fi access point resolves every DNS name
    // to itself (dnsmasq wildcard config, docs/guida-hardware-rifugio.md — outside this npm
    // workspace, OS-level setup), a phone that just joined the network still requests these exact
    // well-known paths, on whatever hostname each OS itself picked (never this node's real address —
    // matched on `url.pathname` alone, never `Host`, for exactly that reason) to decide whether to
    // show its own "Sign in to network" popup. Answering with anything other than what each OS
    // expects as "already online" (Apple/Android/Windows/Firefox each expect different exact
    // content — see CAPTIVE_PORTAL_PROBE_PATHS's own doc comment) makes it conclude there's a
    // captive portal and open a browser on its own, pointed at Location — this node's own dashboard.
    // GET only: every OS's real probe is a GET; matching HEAD too would just be surface no real
    // client exercises. Always active, no new WebUiOptions flag: a fixed redirect on a handful of
    // paths no other route uses has no security implication worth gating (unlike allowServiceCalls).
    if (req.method === "GET" && CAPTIVE_PORTAL_PROBE_PATHS.has(url.pathname)) {
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(PAGE_HTML) });
      res.end(PAGE_HTML);
      return;
    }

    if (url.pathname === "/api/status") {
      sendJson(res, 200, buildStatus(this.node, this.internetStatus, this.networkName));
      return;
    }

    if (url.pathname === "/api/pairing") {
      this.handlePairing(res);
      return;
    }

    if (url.pathname === "/api/peers") {
      sendJson(res, 200, buildPeers(this.node));
      return;
    }

    if (url.pathname === "/api/services") {
      sendJson(res, 200, buildServices(this.node));
      return;
    }

    if (url.pathname === "/api/content") {
      sendJson(res, 200, buildContentList(this.node));
      return;
    }

    if (url.pathname === "/api/search") {
      sendJson(res, 200, buildSearchResults(this.node, url.searchParams.get("q") ?? ""));
      return;
    }

    if (url.pathname === "/api/messages") {
      this.handleGetMessages(req, res, url);
      return;
    }

    if (url.pathname === "/api/channels") {
      sendJson(res, 200, buildChannelList(this.node));
      return;
    }

    if (url.pathname === "/api/channel-messages") {
      this.handleGetChannelMessages(res, url);
      return;
    }

    if (url.pathname === "/api/groups") {
      this.handleGetGroups(req, res);
      return;
    }

    if (url.pathname === "/api/group-messages") {
      this.handleGetGroupMessages(req, res, url);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }

  /**
   * `GET /api/pairing` — the "network name" and "network password" a human
   * standing at this node's own screen can read off and relay to whoever
   * is setting up the mobile app, the same way a Wi-Fi password is often
   * shared out loud or read off a router sticker rather than only ever
   * available to whoever has terminal access to the machine (`cli.ts`
   * still prints both to the console too). Deliberately unauthenticated —
   * requiring the password to read the password would be circular — so
   * this is exactly as exposed as every other read-only endpoint on this
   * class: anyone who can reach this LAN-bound server can read it, not
   * just the intended human. See `docs/security.md` for that tradeoff
   * spelled out. 404s when pairing isn't enabled, same posture as
   * `handleCall()` below.
   *
   * Also includes `address`/`qrDataUri` when a public host could be
   * resolved (`WebUiOptions.publicHost`, explicit or auto-detected) — the
   * QR encodes the full pairing URI (address + name + password) so the
   * mobile app's camera scanner never needs any of the three typed
   * manually, not even the one-time address. Silently omitted (not an
   * error) when no public host is known, or when the pairing URI happens
   * to exceed the QR encoder's capacity (`node/src/qrcode.ts`, an
   * operator-chosen `--network-name` would have to be extremely long) —
   * the text fields above still work either way, this is additive.
   */
  private handlePairing(res: ServerResponse): void {
    // Checks `=== undefined` rather than falsiness for networkName specifically — the constructor
    // only ever leaves it undefined when allowServiceCalls is false (see constructor), so an
    // operator-chosen empty-string display name would otherwise be misread as "pairing not
    // configured" and make this 404 even though handleCall() (whose guard doesn't touch
    // networkName at all) is fully working, an inconsistency between the two endpoints' notion of
    // "is pairing enabled".
    if (!this.allowServiceCalls || this.networkName === undefined || !this.networkPassword) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    // Memoized — networkName/networkPassword/publicHost/port are all fixed for the server's
    // lifetime once start() resolves (see the class doc comment), so recomputing this on every
    // request would just redo the same QR encode (8-mask trial + Reed-Solomon over every block)
    // for an answer that can never change, the one endpoint here plausible enough to be hit
    // repeatedly (a phone re-checking pairing info, a script polling it) to make that worth caching.
    if (!this.cachedPairingInfo) {
      const info: PairingInfo = { networkName: this.networkName, networkPassword: this.networkPassword };
      if (this.publicHost) {
        const address = `${this.publicHost}:${this.port}`;
        info.address = address;
        const uri = buildPairingUri(address, this.networkName, this.networkPassword);
        const qr = encodeQr(uri);
        if (qr) {
          const svg = qrToSvg(qr, { moduleSize: 6, margin: 4 });
          info.qrDataUri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
        }
      }
      this.cachedPairingInfo = info;
    }
    sendJson(res, 200, this.cachedPairingInfo);
  }

  /**
   * `POST /api/call` — invokes `NomadNode.callService()` on behalf of the
   * caller (spec §36-37 `CALL service://...`). Not reachable at all unless
   * `allowServiceCalls` was set at construction; when it wasn't, this
   * returns a plain `404` rather than a `403`/`401`, so the endpoint's mere
   * existence isn't revealed to a caller who doesn't already know the
   * network password — same "don't confirm what you're guarding" posture
   * as refusing to distinguish "wrong password" from "no password" below.
   */
  private async handleCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowServiceCalls || !this.networkPassword) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (!this.isAuthorized(req, this.networkPassword)) {
      sendJson(res, 401, { error: "missing or invalid network password" });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRequestBody(req, MAX_CALL_BODY_BYTES, MAX_CALL_BODY_READ_MS);
    } catch (err) {
      if (res.writableEnded || res.destroyed) return; // connection already gone — nothing to answer
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: "request body too large" });
      } else if (err instanceof Error && err.message.includes("timed out")) {
        sendJson(res, 408, { error: "timed out waiting for the request body" });
      } else {
        sendJson(res, 400, { error: "failed to read request body" });
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "malformed JSON body" });
      return;
    }

    const body = parsed as { serviceId?: unknown; payload?: unknown; timeoutMs?: unknown } | null;
    const serviceId = body?.serviceId;
    if (typeof serviceId !== "string" || serviceId.length === 0) {
      sendJson(res, 400, { error: "'serviceId' must be a non-empty string" });
      return;
    }
    // Restricted to services this node already knows about and considers available — the same
    // set /api/services already shows the caller — rather than letting an arbitrary serviceId fall
    // through into callService()'s discoverService() path. Without this, any string here (up to
    // MAX_CALL_BODY_BYTES) would flood a SERVICE_QUERY to the whole mesh on every miss (spec §21
    // controlled flooding, re-flooded further by every peer that doesn't recognize it either) — a
    // single authenticated HTTP request turning into mesh-wide traffic, unlike every other endpoint
    // on this class, which only ever reads this node's own local state.
    if (!isKnownAvailableService(this.node, serviceId)) {
      sendJson(res, 404, { error: `unknown or unavailable service: ${serviceId}` });
      return;
    }
    const timeoutMs = resolveCallTimeoutMs(body?.timeoutMs);

    try {
      // callService() applies timeoutMs independently to discovery *and* invocation (node.ts), so
      // its own worst case is up to 2x timeoutMs — wrapped here so this endpoint never holds the
      // HTTP connection open longer than the single timeoutMs it advertises, regardless. The
      // underlying call isn't cancelled if it loses this race; it just finishes in the background.
      const result = await raceTimeout(
        this.node.callService(serviceId, body?.payload, { timeoutMs }),
        timeoutMs,
        `service call did not complete within ${timeoutMs}ms`,
      );
      sendJson(res, 200, { result });
    } catch (err) {
      // Same convention as every other service-call error path in this codebase (node.ts's
      // handleServiceRequest, the gateway handlers): forward only err.message, never a stack trace.
      sendJson(res, 502, { error: (err as Error).message });
    }
  }

  /**
   * `GET /api/messages?peer=<nodeId>` — the 1:1 conversation history with
   * `peer` (`node.messageHistory`), oldest first. Unlike `/api/peers`,
   * `/api/services`, `/api/content` (always readable, no sensitive data),
   * this requires the same network-password auth as `POST /api/call` —
   * message text is "Private messages" (spec §56), not public mesh state,
   * so it gets the one gate this class otherwise reserves for writes.
   */
  private handleGetMessages(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!this.allowServiceCalls || !this.networkPassword) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (!this.isAuthorized(req, this.networkPassword)) {
      sendJson(res, 401, { error: "missing or invalid network password" });
      return;
    }
    const peer = url.searchParams.get("peer");
    if (!peer) {
      sendJson(res, 400, { error: "'peer' query parameter is required" });
      return;
    }
    const messages: StoredMessage[] = this.node.messageHistory.get(peer);
    sendJson(res, 200, { messages });
  }

  /**
   * `POST /api/messages` — sends a 1:1 encrypted chat message (body
   * `{ to, text }`) via `NomadNode.sendPrivateMessage()`. Same auth as
   * `POST /api/call`; a 404 when `to`'s encryption key isn't known yet
   * mirrors `handleCall()`'s "unknown or unavailable service" — "can't
   * reach this recipient (yet)" is the same class of condition.
   */
  private async handleSendMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowServiceCalls || !this.networkPassword) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (!this.isAuthorized(req, this.networkPassword)) {
      sendJson(res, 401, { error: "missing or invalid network password" });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRequestBody(req, MAX_MESSAGE_BODY_BYTES, MAX_CALL_BODY_READ_MS);
    } catch (err) {
      if (res.writableEnded || res.destroyed) return; // connection already gone — nothing to answer
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: "request body too large" });
      } else if (err instanceof Error && err.message.includes("timed out")) {
        sendJson(res, 408, { error: "timed out waiting for the request body" });
      } else {
        sendJson(res, 400, { error: "failed to read request body" });
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "malformed JSON body" });
      return;
    }

    const body = parsed as { to?: unknown; text?: unknown } | null;
    const to = body?.to;
    if (typeof to !== "string" || to.length === 0) {
      sendJson(res, 400, { error: "'to' must be a non-empty string" });
      return;
    }
    const text = body?.text;
    if (typeof text !== "string" || text.length === 0) {
      sendJson(res, 400, { error: "'text' must be a non-empty string" });
      return;
    }
    if (text.length > MAX_MESSAGE_TEXT_LENGTH) {
      sendJson(res, 400, { error: `'text' must be at most ${MAX_MESSAGE_TEXT_LENGTH} characters` });
      return;
    }

    try {
      const id = this.node.sendPrivateMessage(to, { text });
      sendJson(res, 200, { id });
    } catch (err) {
      // sendPrivateMessage()'s only synchronous throw today is the "encryption key not yet
      // known" case (node.ts) — mapped to 404, same as handleCall()'s "unknown or unavailable
      // service". Anything else falls back to handleCall()'s own 502 convention for unexpected
      // downstream failures, so a future second throw reason in sendPrivateMessage() doesn't
      // silently become a misleading 404.
      const message = (err as Error).message;
      sendJson(res, message.includes("encryption key") ? 404 : 502, { error: message });
    }
  }

  /**
   * `GET /api/channel-messages?channel=<name>` — the message history for a
   * public channel (`node.publicChannels`), oldest first. Unlike
   * `/api/messages` (1:1 private chat), this is unauthenticated, same tier
   * as `/api/peers`/`/api/services`/`/api/content` — a public channel's
   * whole point is that its contents are public mesh state, not "Private
   * messages" (spec §56), so there is nothing here to gate on read.
   */
  private handleGetChannelMessages(res: ServerResponse, url: URL): void {
    const channel = url.searchParams.get("channel");
    if (!channel) {
      sendJson(res, 400, { error: "'channel' query parameter is required" });
      return;
    }
    sendJson(res, 200, { messages: this.node.publicChannels.get(channel.toLowerCase()) });
  }

  /**
   * `POST /api/channel-messages` — publishes a message to a public channel
   * (body `{ channel, text }`) via `NomadNode.publishChannelMessage()`.
   * Same auth as `POST /api/call`/`POST /api/messages` — reading a public
   * channel needs no password, but *posting* to one is still an action
   * gated behind pairing, same as every other write this class exposes.
   */
  private async handleSendChannelMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowServiceCalls || !this.networkPassword) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (!this.isAuthorized(req, this.networkPassword)) {
      sendJson(res, 401, { error: "missing or invalid network password" });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRequestBody(req, MAX_MESSAGE_BODY_BYTES, MAX_CALL_BODY_READ_MS);
    } catch (err) {
      if (res.writableEnded || res.destroyed) return; // connection already gone — nothing to answer
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: "request body too large" });
      } else if (err instanceof Error && err.message.includes("timed out")) {
        sendJson(res, 408, { error: "timed out waiting for the request body" });
      } else {
        sendJson(res, 400, { error: "failed to read request body" });
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "malformed JSON body" });
      return;
    }

    const body = parsed as { channel?: unknown; text?: unknown } | null;
    const channel = body?.channel;
    if (typeof channel !== "string" || channel.length === 0) {
      sendJson(res, 400, { error: "'channel' must be a non-empty string" });
      return;
    }
    const text = body?.text;
    if (typeof text !== "string" || text.length === 0) {
      sendJson(res, 400, { error: "'text' must be a non-empty string" });
      return;
    }

    try {
      const message = this.node.publishChannelMessage(channel, text);
      sendJson(res, 200, { message });
    } catch (err) {
      // publishChannelMessage()'s own validation throws (invalid channel name, text length) — the
      // caller's input was rejected, not a downstream failure, so 400 rather than handleCall()'s
      // 502 convention for unexpected service failures.
      sendJson(res, 400, { error: (err as Error).message });
    }
  }

  /**
   * `GET /api/groups` — the encrypted groups this node is a member of
   * (`node.groups`), never including the group key itself
   * (`toGroupSummary()`). Same auth tier as `/api/messages` — unlike a
   * public channel, a group's name/membership is private information
   * (spec §56), not public mesh state.
   */
  private handleGetGroups(req: IncomingMessage, res: ServerResponse): void {
    if (!this.allowServiceCalls || !this.networkPassword) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (!this.isAuthorized(req, this.networkPassword)) {
      sendJson(res, 401, { error: "missing or invalid network password" });
      return;
    }
    sendJson(res, 200, this.node.groups.listGroups().map(toGroupSummary));
  }

  /**
   * `GET /api/group-messages?groupId=...` — the decrypted message history
   * for a group this node is a member of (`node.groups`), oldest first.
   * Same auth as `GET /api/groups`. An unknown `groupId` (never joined, or
   * a typo) returns an empty list rather than a 404 — mirrors
   * `handleGetChannelMessages()`'s own "unknown channel" behavior, not
   * something worth distinguishing from "no messages yet".
   */
  private handleGetGroupMessages(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!this.allowServiceCalls || !this.networkPassword) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (!this.isAuthorized(req, this.networkPassword)) {
      sendJson(res, 401, { error: "missing or invalid network password" });
      return;
    }
    const groupId = url.searchParams.get("groupId");
    if (!groupId) {
      sendJson(res, 400, { error: "'groupId' query parameter is required" });
      return;
    }
    sendJson(res, 200, { messages: this.node.groups.getMessages(groupId) });
  }

  /**
   * `POST /api/groups` — creates a new encrypted group (body
   * `{ name, members: string[] }`) via `NomadNode.createGroup()`. Same auth
   * as `POST /api/messages`. A 404 when a member's encryption key isn't
   * known yet mirrors `handleSendMessage()`'s identical mapping; a 400 for
   * `createGroup()`'s own input validation (empty name, no members).
   */
  private async handleCreateGroup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowServiceCalls || !this.networkPassword) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (!this.isAuthorized(req, this.networkPassword)) {
      sendJson(res, 401, { error: "missing or invalid network password" });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRequestBody(req, MAX_MESSAGE_BODY_BYTES, MAX_CALL_BODY_READ_MS);
    } catch (err) {
      if (res.writableEnded || res.destroyed) return; // connection already gone — nothing to answer
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: "request body too large" });
      } else if (err instanceof Error && err.message.includes("timed out")) {
        sendJson(res, 408, { error: "timed out waiting for the request body" });
      } else {
        sendJson(res, 400, { error: "failed to read request body" });
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "malformed JSON body" });
      return;
    }

    const body = parsed as { name?: unknown; members?: unknown } | null;
    const name = body?.name;
    if (typeof name !== "string" || name.length === 0) {
      sendJson(res, 400, { error: "'name' must be a non-empty string" });
      return;
    }
    const members = body?.members;
    if (!Array.isArray(members) || !members.every((m) => typeof m === "string")) {
      sendJson(res, 400, { error: "'members' must be an array of node id strings" });
      return;
    }

    try {
      const info = this.node.createGroup(name, members);
      sendJson(res, 200, { group: toGroupSummary(info) });
    } catch (err) {
      // createGroup()'s own throws are either input validation (bad name/no members, 400) or an
      // unreachable member's encryption key not being known yet — the same "can't reach this
      // recipient (yet)" condition handleSendMessage() already maps to 404.
      const message = (err as Error).message;
      sendJson(res, message.includes("encryption key") ? 404 : 400, { error: message });
    }
  }

  /**
   * `POST /api/group-messages` — sends a message to a group this node is
   * already a member of (body `{ groupId, text }`) via
   * `NomadNode.sendGroupMessage()`. Same auth as `POST /api/groups`; a 404
   * for an unknown `groupId` (not a member), a 400 for an invalid `text`.
   */
  private async handleSendGroupMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowServiceCalls || !this.networkPassword) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (!this.isAuthorized(req, this.networkPassword)) {
      sendJson(res, 401, { error: "missing or invalid network password" });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRequestBody(req, MAX_MESSAGE_BODY_BYTES, MAX_CALL_BODY_READ_MS);
    } catch (err) {
      if (res.writableEnded || res.destroyed) return; // connection already gone — nothing to answer
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: "request body too large" });
      } else if (err instanceof Error && err.message.includes("timed out")) {
        sendJson(res, 408, { error: "timed out waiting for the request body" });
      } else {
        sendJson(res, 400, { error: "failed to read request body" });
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "malformed JSON body" });
      return;
    }

    const body = parsed as { groupId?: unknown; text?: unknown } | null;
    const groupId = body?.groupId;
    if (typeof groupId !== "string" || groupId.length === 0) {
      sendJson(res, 400, { error: "'groupId' must be a non-empty string" });
      return;
    }
    const text = body?.text;
    if (typeof text !== "string" || text.length === 0) {
      sendJson(res, 400, { error: "'text' must be a non-empty string" });
      return;
    }

    try {
      const message = this.node.sendGroupMessage(groupId, text);
      sendJson(res, 200, { message });
    } catch (err) {
      // sendGroupMessage()'s own throws are either "not a known group" (404, not a member) or
      // text-length validation (400) — same split as handleCreateGroup() above.
      const message = (err as Error).message;
      sendJson(res, message.includes("not a known group") ? 404 : 400, { error: message });
    }
  }

  /**
   * Shared Bearer-token check for every endpoint gated behind the network
   * password (`handleCall`, `handleGetMessages`, `handleSendMessage`) —
   * callers must first confirm `expectedPassword` is set (the `!this.allowServiceCalls
   * || !this.networkPassword` guard each of them already has) so TypeScript
   * narrows it to `string` here.
   */
  private isAuthorized(req: IncomingMessage, expectedPassword: string): boolean {
    const authHeader = req.headers.authorization;
    const provided = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    return provided !== undefined && timingSafeStringEqual(provided, expectedPassword);
  }
}

/** Mirrors the definition `/api/status`'s own `services` count already uses ("known to this node and currently marked available") — the same bar `POST /api/call` requires a `serviceId` to clear before `callService()` is ever invoked. */
function isKnownAvailableService(node: NomadNode, serviceId: string): boolean {
  return node.listKnownServices().some((announcement) => announcement.serviceId === serviceId && announcement.availability);
}

const MAX_CALL_BODY_BYTES = 262_144; // generous for a service call payload, nowhere near CHUNK_SIZE
const MAX_CALL_BODY_READ_MS = 10_000; // bounds how long a slow/trickling body is tolerated (loopback-http-server.ts), well under Node's own 300s default
const MAX_MESSAGE_BODY_BYTES = 65_536; // a chat message's JSON body is tiny compared to a service call's
const DEFAULT_CALL_TIMEOUT_MS = 5000;
const MAX_CALL_TIMEOUT_MS = 15000; // caps how long a single POST /api/call can hold a connection open

/** Pure so it's unit-testable without actually waiting out a timeout (see tests/unit/web-ui.test.ts) — a positive number is honored up to `MAX_CALL_TIMEOUT_MS`; anything else (missing, non-number, zero, negative) falls back to `DEFAULT_CALL_TIMEOUT_MS`. Exported for that reason, not because callers outside this module have any other use for it. */
export function resolveCallTimeoutMs(requestedTimeoutMs: unknown): number {
  const requested = typeof requestedTimeoutMs === "number" && requestedTimeoutMs > 0 ? requestedTimeoutMs : DEFAULT_CALL_TIMEOUT_MS;
  return Math.min(requested, MAX_CALL_TIMEOUT_MS);
}

/** Constant-time string comparison for the network password — a naive `===` would leak how many leading bytes matched through response timing. Different lengths are rejected before the timing-safe compare, since `timingSafeEqual` requires equal-length buffers and leaking the password's length is an accepted, far smaller risk than leaking its bytes. */
function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Crockford's Base32 alphabet: digits 0-9 plus the 22 letters left after excluding I, L, O, U —
// not 0/O/1/I/L as a naive reading might suggest. Excluding I/L/O (rather than also dropping 0/1)
// is what makes this work out to exactly 32 symbols (36 alphanumerics minus 4), which is what makes
// `randomBytes()[i] % NETWORK_PASSWORD_ALPHABET.length` free of modulo bias (256 divides evenly by
// 32); a 0/O/1/I/L-style exclusion removes 5 characters, leaving 31, which does NOT divide 256
// evenly and re-introduces exactly the bias this alphabet exists to avoid. The digits 0 and 1 stay
// in — with O and I gone, neither is visually confusable with anything else in the set anymore.
const NETWORK_PASSWORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generates a short, typeable network password (e.g. `K7XM-2QRT`) — the
 * same spirit as a Wi-Fi router's default WPA key printed on its sticker:
 * easy to read off a screen and type on a phone once, not a maximally
 * strong secret. 8 symbols from a 32-symbol alphabet (`NETWORK_PASSWORD_ALPHABET`,
 * chosen so 256 divides evenly into 32 — no modulo bias from
 * `randomBytes()`) is exactly 40 bits of entropy, comfortably enough for a
 * LAN-local pairing secret that a network operator regenerates per node
 * restart (`cli.ts`), not for defending against a sustained remote
 * attacker with unlimited guesses.
 */
export function generateNetworkPassword(): string {
  const bytes = randomBytes(8);
  let chars = "";
  for (let i = 0; i < bytes.length; i++) chars += NETWORK_PASSWORD_ALPHABET[bytes[i] % NETWORK_PASSWORD_ALPHABET.length];
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}
