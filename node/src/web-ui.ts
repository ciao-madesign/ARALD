import type { IncomingMessage, ServerResponse } from "node:http";
import { LoopbackHttpServer, sendJson } from "./loopback-http-server.js";
import type { NomadNode } from "./node.js";

export interface WebUiOptions {
  /** Port to listen on; 0 (default) lets the OS assign one — useful in tests, mirrors TcpTransport's own `port` convention. */
  port?: number;
  /**
   * Deliberately bound to loopback only by default (spec §59 describes a
   * local status/search page, not a public one) — this prototype has no
   * authentication on these endpoints, so binding wider than localhost
   * without adding one would expose this node's peer list, known content,
   * and search to anyone who can reach the port.
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
}

interface SearchResultEntry {
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
  };
}

function shortNodeLabel(nodeId: string): string {
  return `NODE-${nodeId.slice(0, 8)}`;
}

function buildSearchResults(node: NomadNode, query: string): SearchResultEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  return node
    .listKnownContent()
    .filter((metadata) => metadata.name.toLowerCase().includes(needle))
    .map((metadata) => {
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
    });
}

const PAGE_HTML = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>NOMAD-NET</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: monospace, monospace; max-width: 40em; margin: 2em auto; padding: 0 1em; }
  h1 { margin-bottom: 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.2em 1em; }
  dt { font-weight: bold; }
  #search-form { margin-top: 1.5em; display: flex; gap: 0.5em; }
  #search-input { flex: 1; font-family: inherit; padding: 0.3em; }
  li { margin-bottom: 0.6em; }
  .muted { color: #666; }
</style>
</head>
<body>
<h1>NOMAD-NET</h1>
<dl id="status"></dl>
<form id="search-form">
  <input id="search-input" type="text" placeholder="Search" autocomplete="off">
  <button type="submit">Search</button>
</form>
<ul id="results"></ul>
<script>
function renderStatus(s) {
  const dl = document.getElementById("status");
  dl.textContent = "";
  const rows = [
    ["Connected", s.connected ? "sì" : "no"],
    ["Internet", s.internet],
    ["Local network", s.localNetwork],
    ["Peers", String(s.peers)],
    ["Services", String(s.services)],
    ["Cached content", s.cachedContentPercent + "%"],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  }
}

function renderResults(entries) {
  const ul = document.getElementById("results");
  ul.textContent = "";
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Nessun risultato.";
    ul.append(li);
    return;
  }
  for (const entry of entries) {
    const li = document.createElement("li");
    const title = document.createElement("div");
    title.textContent = entry.name + " (" + entry.mimeType + ", " + entry.size + " byte)";
    li.append(title);
    const meta = document.createElement("div");
    meta.className = "muted";
    meta.textContent = entry.availableLocally
      ? "Disponibile localmente"
      : entry.availableThrough
        ? "Disponibile tramite: " + entry.availableThrough
        : "Conosciuto nella mesh, nessuna rotta nota ancora";
    li.append(meta);
    ul.append(li);
  }
}

async function refreshStatus() {
  const res = await fetch("/api/status");
  renderStatus(await res.json());
}

document.getElementById("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const q = document.getElementById("search-input").value;
  const res = await fetch("/api/search?q=" + encodeURIComponent(q));
  renderResults(await res.json());
});

refreshStatus();
setInterval(refreshStatus, 5000);
</script>
</body>
</html>
`;

/**
 * Local status/search web interface (spec §59): "l'utente non deve essere
 * costretto a capire il routing" — a human-readable dashboard over data
 * this node already tracks (peers, known services, cached-content ratio)
 * plus a simple content search, without exposing any control/write
 * capability. Deliberately read-only and loopback-bound by default (see
 * `WebUiOptions`) — this is a status page, not an admin API.
 */
export class WebUiServer {
  private readonly node: NomadNode;
  private readonly internetStatus: () => "ONLINE" | "OFFLINE";
  private readonly httpServer: LoopbackHttpServer;

  constructor(node: NomadNode, options: WebUiOptions = {}) {
    this.node = node;
    this.internetStatus = options.internetStatus ?? (() => "OFFLINE");
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
    const url = new URL(req.method === "GET" || req.method === "HEAD" ? (req.url ?? "/") : "/", "http://localhost");

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(PAGE_HTML) });
      res.end(PAGE_HTML);
      return;
    }

    if (url.pathname === "/api/status") {
      sendJson(res, 200, buildStatus(this.node, this.internetStatus));
      return;
    }

    if (url.pathname === "/api/search") {
      sendJson(res, 200, buildSearchResults(this.node, url.searchParams.get("q") ?? ""));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}
