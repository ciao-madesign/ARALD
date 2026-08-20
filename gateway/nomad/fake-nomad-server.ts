import type { IncomingMessage, ServerResponse } from "node:http";
import { LoopbackHttpServer } from "../../node/src/loopback-http-server.js";

/**
 * Stands in for a real Project NOMAD instance (spec §4) for this slice —
 * specifically the one HTTP surface `KiwixGateway` actually calls, a
 * read-only Kiwix-style article server (spec's own choice of "the simplest
 * candidate", `docs/next-steps.md` Option B). Not a Kiwix API clone: real
 * Kiwix serves OPDS/ZIM-backed endpoints this prototype has no need to
 * replicate exactly — only the shape that matters for proving the gateway
 * pattern (list articles, fetch one, search) is modeled, deliberately
 * narrow rather than a faithful reimplementation of an API "not declared
 * stable" (spec §4) to begin with.
 *
 * Started and torn down entirely within a test/demo process — there is no
 * Docker, no real Kiwix, nothing external. See `docs/next-steps.md` Option
 * B for why this exists instead of the real thing.
 */
export interface FakeNomadArticle {
  path: string;
  title: string;
  mimeType: string;
  body: string;
}

export interface FakeNomadServerOptions {
  /** Port to listen on; 0 (default) lets the OS assign one, same convention as TcpTransport/WebUiServer. */
  port?: number;
  host?: string;
  /** Simulated per-request delay in ms, so tests can exercise the gateway's async plumbing under something other than instant loopback response. */
  latencyMs?: number;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

export class FakeNomadServer {
  private readonly articles = new Map<string, FakeNomadArticle>();
  /** Entries that appear in `/api/articles`' listing but 404 when actually fetched — simulates NOMAD's own admitted instability (spec §4: "non è dichiarato stabile"), e.g. an article removed between a client listing the catalog and fetching a specific entry from it. */
  private readonly brokenListings: Array<{ path: string; title: string; mimeType: string }> = [];
  private readonly latencyMs: number;
  private readonly httpServer: LoopbackHttpServer;

  constructor(options: FakeNomadServerOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.httpServer = new LoopbackHttpServer((req, res) => this.handleRequest(req, res), {
      port: options.port,
      host: options.host,
    });
  }

  get port(): number {
    return this.httpServer.port;
  }

  /** Seeds (or replaces) one article — call before `start()`, or any time after, to simulate NOMAD's own catalog changing underneath the gateway. */
  addArticle(article: FakeNomadArticle): void {
    this.articles.set(article.path, article);
  }

  /** Adds an entry that shows up in `/api/articles` but 404s on `/api/articles/:path` — see `brokenListings`. */
  addBrokenListing(entry: { path: string; title: string; mimeType: string }): void {
    this.brokenListings.push(entry);
  }

  async start(): Promise<void> {
    await this.httpServer.start();
  }

  async stop(): Promise<void> {
    await this.httpServer.stop();
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const respond = (): void => this.route(req, res);
    if (this.latencyMs > 0) setTimeout(respond, this.latencyMs);
    else respond();
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/articles") {
      const listed = Array.from(this.articles.values(), (a) => ({ path: a.path, title: a.title, mimeType: a.mimeType }));
      sendJson(res, 200, [...listed, ...this.brokenListings]);
      return;
    }

    const articleMatch = /^\/api\/articles\/(.+)$/.exec(url.pathname);
    if (articleMatch) {
      let path: string;
      try {
        path = decodeURIComponent(articleMatch[1]);
      } catch {
        // Malformed percent-encoding (e.g. a lone "%") — decodeURIComponent throws on this, and an
        // uncaught throw inside a request listener takes down the whole process, not just this one
        // request. Same defensive posture the rest of the codebase requires for anything
        // network-facing, even though this server only ever exists inside a test/demo process.
        sendJson(res, 400, { error: "malformed article path" });
        return;
      }
      const article = this.articles.get(path);
      if (!article) {
        sendJson(res, 404, { error: `no article at path ${path}` });
        return;
      }
      sendJson(res, 200, article);
      return;
    }

    if (url.pathname === "/api/search") {
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const results =
        query.length === 0
          ? []
          : Array.from(this.articles.values())
              .filter((a) => a.title.toLowerCase().includes(query) || a.body.toLowerCase().includes(query))
              .map((a) => ({ path: a.path, title: a.title }));
      sendJson(res, 200, results);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }
}
