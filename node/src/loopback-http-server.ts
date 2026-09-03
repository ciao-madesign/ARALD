import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface LoopbackHttpServerOptions {
  /** Port to listen on; 0 (default) lets the OS assign one — useful in tests. */
  port?: number;
  host?: string;
}

/** Writes a JSON response with the right `Content-Type`/`Content-Length` headers — the other half of the small-HTTP-server boilerplate `LoopbackHttpServer` covers, shared for the same reason (this exact 5-line body showed up identically in `WebUiServer`, `FakeNomadServer`, and `FakeOllamaServer`). */
export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

/** `sendJson()`'s counterpart for a raw byte response (`node/src/map-tiles.ts`'s map tiles, the first non-JSON response body this project has ever served) — same `Content-Length` discipline, just a caller-supplied `Content-Type` instead of always `application/json`. */
export function sendBinary(res: ServerResponse, statusCode: number, contentType: string, body: Buffer): void {
  res.writeHead(statusCode, { "Content-Type": contentType, "Content-Length": body.length });
  res.end(body);
}

/** Distinguishes "the body was too big" from every other stream failure (client disconnect, socket reset) — a caller of `readRequestBody()` needs to tell them apart to answer with the right status code instead of always claiming 413. */
export class BodyTooLargeError extends Error {}

/**
 * Reads and concatenates a request body, rejecting with `BodyTooLargeError`
 * once it exceeds `maxBytes` instead of buffering an unbounded amount from
 * a hostile or broken client — any other stream failure rejects with the
 * original error unchanged. Shared for the same reason `sendJson()` is:
 * this exact body-reading loop (with the same `BodyTooLargeError` split)
 * showed up first in `gateway/nomad/fake-ollama-server.ts` (voce #10, for
 * `POST /api/generate`) and then again in `WebUiServer` (for `POST
 * /api/call`, spec §59 mobile pairing).
 *
 * `timeoutMs`, when given, bounds the *overall* wait for the body to finish
 * arriving — not per-chunk idle time — so a client trickling data one byte
 * at a time while staying under `maxBytes` can't hold the connection (and
 * its socket/memory) open for Node's own default `http.Server` request
 * timeout (300s), far longer than any caller of this function actually
 * intends to wait. Optional and off by default so existing callers that
 * never needed this bound (e.g. `FakeOllamaServer`, a test/demo server the
 * mobile-pairing threat model doesn't apply to) are unaffected.
 */
export function readRequestBody(req: IncomingMessage, maxBytes: number, timeoutMs?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => {
            settled = true;
            req.destroy();
            reject(new Error(`timed out after ${timeoutMs}ms waiting for the request body`));
          }, timeoutMs)
        : undefined;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        if (timer) clearTimeout(timer);
        req.destroy();
        reject(new BodyTooLargeError("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/**
 * Shared `start()`/`stop()`/`port`-getter boilerplate for a small,
 * local-only HTTP server — used by `WebUiServer` (spec §59) and, in
 * `gateway/nomad/`, `FakeNomadServer` (test/demo infrastructure standing
 * in for a real Project NOMAD instance). Extracted after this exact
 * ~30-line bootstrap sequence (listen, resolve the actually-bound port,
 * close-as-a-promise) showed up twice — same reasoning `bounded-map.ts`
 * documents for its own extraction, just for a newer, smaller pattern
 * with only two callers so far rather than five.
 */
export class LoopbackHttpServer {
  private readonly host: string;
  private readonly requestedPort: number;
  private server: Server | undefined;
  private boundPort: number | undefined;

  constructor(
    private readonly handler: (req: IncomingMessage, res: ServerResponse) => void,
    options: LoopbackHttpServerOptions = {},
  ) {
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0;
  }

  /** Actual bound port once started (useful when constructed with port 0, e.g. in tests); the requested port before that. */
  get port(): number {
    return this.boundPort ?? this.requestedPort;
  }

  async start(): Promise<void> {
    this.server = createServer(this.handler);
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.requestedPort, this.host, () => {
        const address = this.server!.address();
        this.boundPort = typeof address === "object" && address !== null ? address.port : this.requestedPort;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
