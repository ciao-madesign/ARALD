import type { IncomingMessage, ServerResponse } from "node:http";
import { LoopbackHttpServer, sendJson } from "../../node/src/loopback-http-server.js";

/**
 * Stands in for a real `kiwix-serve` instance (replaces `FakeNomadServer`,
 * removed 30 September 2026 — see `KiwixGateway`'s doc comment for why).
 * Models the two real endpoints `KiwixGateway` actually calls —
 * `/content/{book}/{path}` and `/suggest?content={book}&term={q}` — using
 * the real path/parameter shapes confirmed against `kiwix-tools`' own
 * `docs/kiwix-serve.rst` this session. The `/suggest` **response** shape
 * emitted here (`{value, label, path}` per suggestion) is a best-effort
 * model, not a captured real example — see `KiwixGateway.registerSearchService()`'s
 * doc comment for the same caveat applied there. Started and torn down
 * entirely within a test/demo process — no Docker, no real Kiwix.
 */
export interface FakeKiwixArticle {
  path: string;
  title: string;
  mimeType: string;
  body: string;
}

export interface FakeKiwixServerOptions {
  /** Port to listen on; 0 (default) lets the OS assign one, same convention as the rest of `gateway/nomad/`. */
  port?: number;
  host?: string;
  /** ZIM book name this fake serves under — must match what `KiwixGateway` is constructed with. */
  book?: string;
  /** Simulated per-request delay in ms, so tests can exercise the gateway's async plumbing under something other than instant loopback response. */
  latencyMs?: number;
}

const DEFAULT_BOOK = "wiki";

export class FakeKiwixServer {
  private readonly articles = new Map<string, FakeKiwixArticle>();
  private readonly book: string;
  private readonly latencyMs: number;
  private readonly httpServer: LoopbackHttpServer;

  constructor(options: FakeKiwixServerOptions = {}) {
    this.book = options.book ?? DEFAULT_BOOK;
    this.latencyMs = options.latencyMs ?? 0;
    this.httpServer = new LoopbackHttpServer((req, res) => this.handleRequest(req, res), {
      port: options.port,
      host: options.host,
    });
  }

  get port(): number {
    return this.httpServer.port;
  }

  /** Seeds (or replaces) one article — call before `start()`, or any time after, to simulate the archive's content changing underneath the gateway. */
  addArticle(article: FakeKiwixArticle): void {
    this.articles.set(article.path, article);
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

    const contentMatch = new RegExp(`^/content/${escapeRegExp(this.book)}/(.+)$`).exec(url.pathname);
    if (contentMatch) {
      let path: string;
      try {
        path = decodeURIComponent(contentMatch[1]);
      } catch {
        // Malformed percent-encoding — same defensive posture already required everywhere else in
        // this codebase for anything network-facing (docs/security.md bug #19).
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("malformed article path");
        return;
      }
      const article = this.articles.get(path);
      if (!article) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`no article at path ${path}`);
        return;
      }
      res.writeHead(200, { "Content-Type": article.mimeType });
      res.end(article.body);
      return;
    }

    if (url.pathname === "/suggest") {
      const content = url.searchParams.get("content");
      const term = (url.searchParams.get("term") ?? "").trim().toLowerCase();
      if (content !== this.book) {
        sendJson(res, 200, []);
        return;
      }
      const suggestions =
        term.length === 0
          ? []
          : Array.from(this.articles.values())
              .filter((a) => a.title.toLowerCase().includes(term) || a.body.toLowerCase().includes(term))
              .map((a) => ({ value: a.title, label: a.title, path: a.path }));
      sendJson(res, 200, suggestions);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
