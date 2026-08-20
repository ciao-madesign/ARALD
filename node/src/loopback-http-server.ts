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
