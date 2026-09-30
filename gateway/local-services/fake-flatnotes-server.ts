import type { IncomingMessage, ServerResponse } from "node:http";
import { LoopbackHttpServer, sendJson, readRequestBody, BodyTooLargeError } from "../../node/src/loopback-http-server.js";
import { INVALID_TITLE_CHARS } from "./flatnotes-gateway.js";

/**
 * Stands in for a real Flatnotes instance. Models the real endpoints
 * `FlatnotesGateway` actually calls — `GET /api/notes/{title}`,
 * `POST /api/notes`, `GET /api/search?term=&sort=&order=&limit=` — using
 * the real path/parameter/response shapes confirmed against `dullage/flatnotes`'
 * own source (`server/main.py`, `server/notes/models.py`, `server/helpers.py`,
 * accessed via `raw.githubusercontent.com` on the `develop` branch, 30
 * September 2026 — no live instance reachable to verify against instead,
 * `demo.flatnotes.io` blocked by this session's network egress policy).
 * Notes are addressed by **title**, not a separate "path" — Flatnotes
 * itself derives the on-disk filename from the title, but that's an
 * internal detail the real HTTP API never exposes, so this fake doesn't
 * model it either. Started and torn down entirely within a test/demo
 * process — no Docker, no real Flatnotes.
 */
export interface FakeFlatnote {
  title: string;
  content: string;
  /** Defaults to the current time if omitted — real Flatnotes reports this as `lastModified` (camelCase over the wire, `CustomBaseModel`'s alias generator). */
  lastModified?: number;
}

export interface FakeFlatnotesServerOptions {
  /** Port to listen on; 0 (default) lets the OS assign one, same convention as the rest of `gateway/local-services/`. */
  port?: number;
  host?: string;
  /** Simulated per-request delay in ms — same purpose as `FakeKiwixServer`'s `latencyMs`. */
  latencyMs?: number;
}

export class FakeFlatnotesServer {
  private readonly notes = new Map<string, FakeFlatnote>();
  /** A title that matches search but 404s when fetched — same purpose as `FakeKiwixServer`'s lack of an equivalent isn't needed there (no separate list step); here it simulates a note deleted between search and `service://flatnotes-fetch`. */
  private readonly brokenTitles = new Set<string>();
  private readonly latencyMs: number;
  private readonly httpServer: LoopbackHttpServer;

  constructor(options: FakeFlatnotesServerOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.httpServer = new LoopbackHttpServer((req, res) => this.handleRequest(req, res), {
      port: options.port,
      host: options.host,
    });
  }

  get port(): number {
    return this.httpServer.port;
  }

  /** Seeds (or replaces) one note — call before `start()`, or any time after, to simulate Flatnotes' own catalog changing underneath the gateway. */
  addNote(note: FakeFlatnote): void {
    this.notes.set(note.title, note);
  }

  /** Registers a title that appears in search results but 404s on `GET /api/notes/{title}` — see `brokenTitles`' own comment. */
  addBrokenTitle(title: string): void {
    this.brokenTitles.add(title);
  }

  async start(): Promise<void> {
    await this.httpServer.start();
  }

  async stop(): Promise<void> {
    await this.httpServer.stop();
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const respond = (): void => void this.route(req, res);
    if (this.latencyMs > 0) setTimeout(respond, this.latencyMs);
    else respond();
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/search") {
      const term = (url.searchParams.get("term") ?? "").trim().toLowerCase();
      const matchedTitles = term.length === 0 ? [] : Array.from(this.notes.values()).filter((n) => n.title.toLowerCase().includes(term) || n.content.toLowerCase().includes(term));
      const brokenMatches = term.length === 0 ? [] : Array.from(this.brokenTitles).filter((t) => t.toLowerCase().includes(term));
      const results = [
        ...matchedTitles.map((n) => ({ title: n.title, lastModified: n.lastModified ?? Date.now() / 1000 })),
        ...brokenMatches.map((t) => ({ title: t, lastModified: Date.now() / 1000 })),
      ];
      sendJson(res, 200, results);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/notes") {
      let body: unknown;
      try {
        const raw = await readRequestBody(req, 1_000_000);
        body = JSON.parse(raw.toString("utf8"));
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          sendJson(res, 413, { error: "body too large" });
        } else {
          sendJson(res, 400, { error: "malformed JSON body" });
        }
        return;
      }
      const { title, content } = (body ?? {}) as { title?: unknown; content?: unknown };
      if (typeof title !== "string" || title.length === 0) {
        sendJson(res, 400, { error: "'title' is required" });
        return;
      }
      // Real Flatnotes rejects these characters (server/helpers.py's is_valid_filename — notes are
      // literal files on disk) — modeled here so a gateway bug that forwards an invalid title (e.g.
      // an ISO timestamp containing ':') is caught by this fake instead of only against a real
      // instance nobody has reached in this environment. Imports FlatnotesGateway's own
      // INVALID_TITLE_CHARS rather than a second copy of the same regex, so the two can't silently
      // drift apart (found by code-review, 30 September 2026).
      if (INVALID_TITLE_CHARS.test(title)) {
        sendJson(res, 422, { error: `title cannot include any of the following characters: <>:"/\\|?*` });
        return;
      }
      if (this.notes.has(title)) {
        sendJson(res, 409, { error: `a note titled '${title}' already exists` });
        return;
      }
      const note: FakeFlatnote = { title, content: typeof content === "string" ? content : "", lastModified: Date.now() / 1000 };
      this.notes.set(title, note);
      sendJson(res, 201, note);
      return;
    }

    const noteMatch = /^\/api\/notes\/(.+)$/.exec(url.pathname);
    if (req.method === "GET" && noteMatch) {
      let title: string;
      try {
        title = decodeURIComponent(noteMatch[1]);
      } catch {
        sendJson(res, 400, { error: "malformed note title" });
        return;
      }
      if (this.brokenTitles.has(title)) {
        sendJson(res, 404, { error: `no note titled ${title}` });
        return;
      }
      const note = this.notes.get(title);
      if (!note) {
        sendJson(res, 404, { error: `no note titled ${title}` });
        return;
      }
      sendJson(res, 200, note);
      return;
    }

    if (req.method !== "GET" && req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }
}
