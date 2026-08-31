import type { IncomingMessage, ServerResponse } from "node:http";
import { LoopbackHttpServer, sendJson, readRequestBody, BodyTooLargeError } from "../../node/src/loopback-http-server.js";

/**
 * Stands in for a real FlatNotes instance (Project NOMAD component, spec
 * §4/`docs/SPECIFICATION.md:102`) for this slice — same reasoning as
 * `FakeNomadServer` for Kiwix: no Docker, no real FlatNotes reachable from
 * this sandbox, so this models only the shape `FlatnotesGateway` actually
 * needs (list notes, fetch one, search, create one) rather than a faithful
 * reimplementation of FlatNotes' real API.
 *
 * Started and torn down entirely within a test/demo process, same lifecycle
 * as `FakeNomadServer`/`FakeOllamaServer`.
 */
export interface FakeFlatnote {
  path: string;
  title: string;
  content: string;
}

export interface FakeFlatnotesServerOptions {
  /** Port to listen on; 0 (default) lets the OS assign one, same convention as every other fake server here. */
  port?: number;
  host?: string;
  /** Simulated per-request delay in ms — same purpose as `FakeNomadServer`'s `latencyMs`. */
  latencyMs?: number;
}

let nextAutoPath = 1;

/** Derives a URL-safe path from a title, same idea a real FlatNotes deployment would use (slugify the title) — falls back to a counter-based name when the title has no usable characters. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : `nota-${nextAutoPath++}`;
}

export class FakeFlatnotesServer {
  private readonly notes = new Map<string, FakeFlatnote>();
  /** Same purpose as `FakeNomadServer.brokenListings`: an entry visible in the list but 404ing when actually fetched. */
  private readonly brokenListings: Array<{ path: string; title: string }> = [];
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

  /** Seeds (or replaces) one note — call before `start()`, or any time after, to simulate FlatNotes' own catalog changing underneath the gateway. */
  addNote(note: FakeFlatnote): void {
    this.notes.set(note.path, note);
  }

  addBrokenListing(entry: { path: string; title: string }): void {
    this.brokenListings.push(entry);
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

    if (req.method === "GET" && url.pathname === "/api/notes") {
      const listed = Array.from(this.notes.values(), (n) => ({ path: n.path, title: n.title }));
      sendJson(res, 200, [...listed, ...this.brokenListings]);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/search") {
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const results =
        query.length === 0
          ? []
          : Array.from(this.notes.values())
              .filter((n) => n.title.toLowerCase().includes(query) || n.content.toLowerCase().includes(query))
              .map((n) => ({ path: n.path, title: n.title }));
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
      if (typeof title !== "string" || typeof content !== "string" || title.length === 0) {
        sendJson(res, 400, { error: "'title' and 'content' are required strings" });
        return;
      }
      let path = slugify(title);
      // A real FlatNotes deployment would reject or dedupe a colliding slug — this fake mirrors
      // that by appending a counter instead of silently overwriting an existing note.
      while (this.notes.has(path)) path = `${slugify(title)}-${nextAutoPath++}`;
      const note: FakeFlatnote = { path, title, content };
      this.notes.set(path, note);
      sendJson(res, 201, note);
      return;
    }

    const noteMatch = /^\/api\/notes\/(.+)$/.exec(url.pathname);
    if (req.method === "GET" && noteMatch) {
      let path: string;
      try {
        path = decodeURIComponent(noteMatch[1]);
      } catch {
        sendJson(res, 400, { error: "malformed note path" });
        return;
      }
      const note = this.notes.get(path);
      if (!note) {
        sendJson(res, 404, { error: `no note at path ${path}` });
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
