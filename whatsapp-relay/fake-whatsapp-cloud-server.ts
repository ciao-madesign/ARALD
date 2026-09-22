import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyTooLargeError, LoopbackHttpServer, readRequestBody, sendJson } from "../node/src/loopback-http-server.js";

export interface FakeWhatsAppCloudServerOptions {
  port?: number;
  host?: string;
  /** The Bearer token a request must present in `Authorization` — a real Meta access token in production, anything the test picks here. */
  expectedAccessToken: string;
}

export interface ReceivedWhatsAppMessage {
  phoneNumberId: string;
  to: string;
  text: string;
}

/**
 * Stands in for Meta's WhatsApp Business Cloud API (`whatsapp-client.ts`) —
 * same role and shape as `gateway/nomad/fake-ollama-server.ts` for Ollama:
 * a small, deterministic double just faithful enough to prove
 * `whatsapp-client.ts`'s round trip end-to-end, never a real deployment
 * target. `setNextFailure()` lets a test simulate a rejected send (bad
 * token, invalid number) without needing a second server instance.
 */
export class FakeWhatsAppCloudServer {
  private readonly httpServer: LoopbackHttpServer;
  private readonly expectedAccessToken: string;
  private readonly received: ReceivedWhatsAppMessage[] = [];
  private nextFailureMessage: string | undefined;
  private nextMessageId = 1;

  constructor(options: FakeWhatsAppCloudServerOptions) {
    this.expectedAccessToken = options.expectedAccessToken;
    this.httpServer = new LoopbackHttpServer((req, res) => void this.route(req, res), { port: options.port, host: options.host });
  }

  get port(): number {
    return this.httpServer.port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Every message received so far, oldest first — a copy, never the live internal array. */
  get messages(): readonly ReceivedWhatsAppMessage[] {
    return [...this.received];
  }

  /** Makes the *next* request fail with a Meta-shaped error body, regardless of whether it would otherwise succeed — resets itself after being consumed once. */
  setNextFailure(message: string): void {
    this.nextFailureMessage = message;
  }

  async start(): Promise<void> {
    await this.httpServer.start();
  }

  async stop(): Promise<void> {
    await this.httpServer.stop();
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/([^/]+)\/messages$/.exec(url.pathname);
    if (req.method !== "POST" || !match) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const phoneNumberId = match[1];

    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${this.expectedAccessToken}`) {
      sendJson(res, 401, { error: { message: "Invalid OAuth access token" } });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRequestBody(req, 100_000);
    } catch (err) {
      if (res.writableEnded || res.destroyed) return;
      if (err instanceof BodyTooLargeError) sendJson(res, 413, { error: { message: "request body too large" } });
      else sendJson(res, 400, { error: { message: "failed to read request body" } });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: { message: "malformed JSON body" } });
      return;
    }

    const body = parsed as { messaging_product?: unknown; to?: unknown; type?: unknown; text?: { body?: unknown } } | null;
    if (body?.messaging_product !== "whatsapp" || typeof body?.to !== "string" || body?.type !== "text" || typeof body?.text?.body !== "string") {
      sendJson(res, 400, { error: { message: "malformed WhatsApp Cloud API request" } });
      return;
    }

    if (this.nextFailureMessage !== undefined) {
      const message = this.nextFailureMessage;
      this.nextFailureMessage = undefined;
      sendJson(res, 400, { error: { message } });
      return;
    }

    this.received.push({ phoneNumberId, to: body.to, text: body.text.body });
    const messageId = `wamid.FAKE${this.nextMessageId++}`;
    sendJson(res, 200, { messaging_product: "whatsapp", contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: messageId }] });
  }
}
