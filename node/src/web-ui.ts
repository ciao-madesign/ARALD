import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { BodyTooLargeError, LoopbackHttpServer, readRequestBody, sendJson } from "./loopback-http-server.js";
import type { NomadNode } from "./node.js";
import type { ContentMetadata } from "./content.js";
import type { TrustLevel } from "./trust.js";

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
   * when true, `pairingToken` is required (the constructor throws
   * otherwise) — there is no scenario where this should be enabled without
   * one, since it lets any caller who has the token invoke any registered
   * service with any payload, a materially bigger risk than the read-only
   * endpoints below it.
   */
  allowServiceCalls?: boolean;
  /**
   * Required when `allowServiceCalls` is true. Every `POST /api/call`
   * request must carry this exact value as `Authorization: Bearer
   * <token>` (compared in constant time via `node:crypto.timingSafeEqual`
   * to avoid a timing side-channel); a mismatched or missing token gets
   * `401`. Generate one with `crypto.randomBytes(16).toString("hex")` (see
   * `cli.ts`'s `--allow-service-calls`) and hand it to the mobile app once,
   * out of band — this is a pairing secret, not something this class ever
   * serves back over HTTP itself.
   */
  pairingToken?: string;
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
}

interface PeerEntry {
  nodeId: string;
  shortLabel: string;
  trustLevel: TrustLevel;
  connectedAt: number;
  lastSeen: number;
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

function buildStatus(node: NomadNode, internetStatus: () => "ONLINE" | "OFFLINE"): StatusPayload {
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

refreshAll();
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
 * gated by its own pairing token even when it is, regardless of whether
 * `host` is loopback or a LAN address — see `docs/security.md`.
 */
export class WebUiServer {
  private readonly node: NomadNode;
  private readonly internetStatus: () => "ONLINE" | "OFFLINE";
  private readonly allowServiceCalls: boolean;
  private readonly pairingToken: string | undefined;
  private readonly httpServer: LoopbackHttpServer;

  constructor(node: NomadNode, options: WebUiOptions = {}) {
    this.node = node;
    this.internetStatus = options.internetStatus ?? (() => "OFFLINE");
    this.allowServiceCalls = options.allowServiceCalls ?? false;
    if (this.allowServiceCalls && !options.pairingToken) {
      throw new Error("WebUiServer: allowServiceCalls requires a pairingToken");
    }
    this.pairingToken = options.pairingToken;
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
    if (req.method === "POST") {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/call") {
        void this.handleCall(req, res);
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

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(PAGE_HTML) });
      res.end(PAGE_HTML);
      return;
    }

    if (url.pathname === "/api/status") {
      sendJson(res, 200, buildStatus(this.node, this.internetStatus));
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

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }

  /**
   * `POST /api/call` — invokes `NomadNode.callService()` on behalf of the
   * caller (spec §36-37 `CALL service://...`). Not reachable at all unless
   * `allowServiceCalls` was set at construction; when it wasn't, this
   * returns a plain `404` rather than a `403`/`401`, so the endpoint's mere
   * existence isn't revealed to a caller who doesn't already know the
   * pairing token — same "don't confirm what you're guarding" posture as
   * refusing to distinguish "wrong token" from "no token" below.
   */
  private async handleCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowServiceCalls || !this.pairingToken) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    const authHeader = req.headers.authorization;
    const provided = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (!provided || !tokensMatch(provided, this.pairingToken)) {
      sendJson(res, 401, { error: "missing or invalid pairing token" });
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
      const result = await callWithHardTimeout(this.node.callService(serviceId, body?.payload, { timeoutMs }), timeoutMs);
      sendJson(res, 200, { result });
    } catch (err) {
      // Same convention as every other service-call error path in this codebase (node.ts's
      // handleServiceRequest, the gateway handlers): forward only err.message, never a stack trace.
      sendJson(res, 502, { error: (err as Error).message });
    }
  }
}

/** Mirrors the definition `/api/status`'s own `services` count already uses ("known to this node and currently marked available") — the same bar `POST /api/call` requires a `serviceId` to clear before `callService()` is ever invoked. */
function isKnownAvailableService(node: NomadNode, serviceId: string): boolean {
  return node.listKnownServices().some((announcement) => announcement.serviceId === serviceId && announcement.availability);
}

/**
 * Bounds the *total* wall-clock time this endpoint waits for `promise` to
 * `timeoutMs`, independent of how many internal timeouts the promise's own
 * producer applies. Does not cancel the underlying operation — `promise`
 * keeps running and may still resolve or reject later, harmlessly, after
 * this has already settled the race (no `AbortController` plumbed through
 * `NomadNode.callService()` today to actually stop it).
 */
function callWithHardTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`service call did not complete within ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const MAX_CALL_BODY_BYTES = 262_144; // generous for a service call payload, nowhere near CHUNK_SIZE
const MAX_CALL_BODY_READ_MS = 10_000; // bounds how long a slow/trickling body is tolerated (loopback-http-server.ts), well under Node's own 300s default
const DEFAULT_CALL_TIMEOUT_MS = 5000;
const MAX_CALL_TIMEOUT_MS = 15000; // caps how long a single POST /api/call can hold a connection open

/** Pure so it's unit-testable without actually waiting out a timeout (see tests/unit/web-ui.test.ts) — a positive number is honored up to `MAX_CALL_TIMEOUT_MS`; anything else (missing, non-number, zero, negative) falls back to `DEFAULT_CALL_TIMEOUT_MS`. Exported for that reason, not because callers outside this module have any other use for it. */
export function resolveCallTimeoutMs(requestedTimeoutMs: unknown): number {
  const requested = typeof requestedTimeoutMs === "number" && requestedTimeoutMs > 0 ? requestedTimeoutMs : DEFAULT_CALL_TIMEOUT_MS;
  return Math.min(requested, MAX_CALL_TIMEOUT_MS);
}

/** Constant-time pairing-token comparison — a naive `===` would leak how many leading bytes matched through response timing. Different lengths are rejected before the timing-safe compare, since `timingSafeEqual` requires equal-length buffers and leaking the token's length is an accepted, far smaller risk than leaking its bytes. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
