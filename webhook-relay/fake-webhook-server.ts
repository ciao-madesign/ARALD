import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyTooLargeError, LoopbackHttpServer, readRequestBody, sendJson } from "../node/src/loopback-http-server.js";

export interface FakeWebhookServerOptions {
  port?: number;
  host?: string;
}

export interface ReceivedWebhookRequest {
  /** The request path — `cli.ts`'s `--fake-webhook` gives each destination its own path (`/<destinationId>`) on the same fake server, so a test/demo with several destinations can tell their deliveries apart without needing one fake server per destination. */
  path: string;
  authorizationHeader: string | undefined;
  body: unknown;
}

/**
 * Stands in for whichever real external webhook a destination is actually
 * configured against (Slack, Telegram, a coordination API, an upload
 * endpoint) — same role as `whatsapp-relay/fake-whatsapp-cloud-server.ts`/
 * `email-relay/fake-smtp-server.ts`, just generic since this relay itself is
 * generic: accepts any POST to any path and records it, rather than
 * emulating one specific real API's request/response shape.
 */
export class FakeWebhookServer {
  private readonly httpServer: LoopbackHttpServer;
  private readonly received: ReceivedWebhookRequest[] = [];
  private nextFailureStatus: number | undefined;

  constructor(options: FakeWebhookServerOptions = {}) {
    this.httpServer = new LoopbackHttpServer((req, res) => void this.route(req, res), { port: options.port, host: options.host });
  }

  get port(): number {
    return this.httpServer.port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Every request received so far, oldest first — a copy, never the live internal array. */
  get requests(): readonly ReceivedWebhookRequest[] {
    return [...this.received];
  }

  /** Makes the *next* request fail with the given HTTP status instead of 200, regardless of whether it would otherwise succeed — resets itself after being consumed once. */
  setNextFailure(status: number): void {
    this.nextFailureStatus = status;
  }

  async start(): Promise<void> {
    await this.httpServer.start();
  }

  async stop(): Promise<void> {
    await this.httpServer.stop();
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRequestBody(req, 2_000_000);
    } catch (err) {
      if (res.writableEnded || res.destroyed) return;
      if (err instanceof BodyTooLargeError) sendJson(res, 413, { error: "request body too large" });
      else sendJson(res, 400, { error: "failed to read request body" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "malformed JSON body" });
      return;
    }

    if (this.nextFailureStatus !== undefined) {
      const status = this.nextFailureStatus;
      this.nextFailureStatus = undefined;
      sendJson(res, status, { error: "simulated webhook failure" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    this.received.push({ path: url.pathname, authorizationHeader: req.headers.authorization, body: parsed });
    sendJson(res, 200, { ok: true });
  }
}
