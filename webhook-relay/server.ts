import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BoundedFifoMap } from "../node/src/bounded-map.js";
import { EncryptionIdentity } from "../node/src/encryption.js";
import { extractExternalDeliveryPayload, unsealExternalDelivery } from "../node/src/external-delivery.js";
import { BodyTooLargeError, LoopbackHttpServer, readRequestBody, sendJson } from "../node/src/loopback-http-server.js";
import { postToWebhook, type WebhookDestinationTarget } from "./webhook-client.js";

/**
 * The "destination" side of ARALD's "consegna esterna differita"
 * (`node/src/external-delivery.ts`, `docs/service-catalog.md`), generalized
 * beyond a single fixed external service — same posture as
 * `whatsapp-relay/server.ts`/`email-relay/server.ts`: this process is
 * deliberately **outside the mesh entirely**, the Box only ever POSTs an
 * opaque E2E-sealed blob to it, never anything it could read.
 *
 * Where `whatsapp-relay/`/`email-relay/` each hard-code one specific
 * external API, this one is deliberately generic (`docs/next-steps.md`,
 * confirmed with the user on 21 settembre 2026): every `destinationId` maps
 * to its own operator-configured `webhookUrl`/`authToken` pair, covering the
 * three remaining examples with a single implementation — a post to a
 * channel/bot (Slack/Telegram), a location check-in toward a coordination
 * service, an upload of a report/photo. Which of those it actually is
 * depends entirely on what the operator points `webhookUrl` at; this code
 * never needs to know.
 */

export const EXTERNAL_DELIVERY_PATH = "/deliver";
/** Mirrors `NomadNode`'s own `DEFAULT_MAX_EXTERNAL_DELIVERY_PAYLOAD_BYTES` (`node/src/node.ts`) — a report/photo can legitimately be far larger than a WhatsApp text or an email body, so this relay's own cap tracks the mesh-side default instead of reusing the much smaller text-message caps in `whatsapp-client.ts`/`smtp-client.ts`. */
export const MAX_WEBHOOK_PAYLOAD_BYTES = 1_000_000;
const MAX_CIPHERTEXT_HEX_LENGTH = MAX_WEBHOOK_PAYLOAD_BYTES * 2; // AES-GCM ciphertext is plaintext-length; hex doubles bytes.
const MAX_BODY_BYTES = MAX_CIPHERTEXT_HEX_LENGTH + 4096; // generous margin over the largest legal body (bounded ciphertext + fixed-length hex fields + JSON overhead).
const DEFAULT_MAX_RECENTLY_DELIVERED = 500;

export interface WebhookRelayDestinationConfig {
  /** Built once (`keypair.ts`), not re-derived from hex on every request — same reasoning as `whatsapp-relay/server.ts`'s identical field. */
  identity: EncryptionIdentity;
  webhookUrl: string;
  authToken?: string;
}

export interface WebhookRelayServerOptions {
  port?: number;
  host?: string;
  destinations: Map<string, WebhookRelayDestinationConfig>;
  /** How many recently-delivered submissions to remember, to skip a duplicate webhook POST if the Box retries a delivery whose response it never received — same reasoning as `whatsapp-relay/server.ts`'s identical field. */
  maxRecentlyDeliveredEntries?: number;
}

/**
 * Decides whether the decrypted bytes are text or an opaque file — the only
 * signal available, since the mesh side (`mobile/www/app.js`'s
 * `readFileAsBase64()`) sends raw bytes with no filename/MIME metadata at
 * all, wrapping a typed message in a `Blob` the exact same way it wraps an
 * attached file. `undefined` (treat as a file) for anything that isn't a
 * clean UTF-8 round trip — `TextDecoder`'s `fatal: true` rejects invalid byte
 * sequences instead of silently replacing them with U+FFFD, which would
 * otherwise corrupt a genuine binary file into looking like garbled "text".
 */
function decodeUtf8IfValid(buffer: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

export class WebhookRelayServer {
  private readonly httpServer: LoopbackHttpServer;
  private readonly destinations: Map<string, WebhookRelayDestinationConfig>;
  /**
   * Same reasoning as `whatsapp-relay/server.ts`'s identical field:
   * `ExternalDeliveryQueue` only removes an entry from the Box's queue after
   * a 2xx response, so a lost response after a successful send would
   * otherwise cause a Box retry to POST the same webhook twice.
   * `nonce`/`ciphertext`/`authTag` together are a stable idempotency key
   * across such retries (`sealExternalDelivery()` seals once, at submission
   * time — a retry resends the identical sealed bytes).
   */
  private readonly recentlyDelivered: BoundedFifoMap<string, true>;

  constructor(options: WebhookRelayServerOptions) {
    this.destinations = options.destinations;
    this.recentlyDelivered = new BoundedFifoMap({ maxSize: options.maxRecentlyDeliveredEntries ?? DEFAULT_MAX_RECENTLY_DELIVERED });
    this.httpServer = new LoopbackHttpServer((req, res) => void this.route(req, res), { port: options.port, host: options.host });
  }

  get port(): number {
    return this.httpServer.port;
  }

  async start(): Promise<void> {
    await this.httpServer.start();
  }

  async stop(): Promise<void> {
    await this.httpServer.stop();
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "POST" || url.pathname !== EXTERNAL_DELIVERY_PATH) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRequestBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (res.writableEnded || res.destroyed) return;
      if (err instanceof BodyTooLargeError) sendJson(res, 413, { error: "request body too large" });
      else sendJson(res, 400, { error: "failed to read request body" });
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "malformed JSON body" });
      return;
    }

    // Same defensive posture CLAUDE.md requires for a mesh packet payload, applied here to an HTTP
    // body instead: this relay never trusts the Box any more than the Box trusts the mesh.
    const payload = extractExternalDeliveryPayload(parsedBody, MAX_CIPHERTEXT_HEX_LENGTH);
    if (!payload) {
      sendJson(res, 400, { error: "malformed delivery payload" });
      return;
    }

    const destination = this.destinations.get(payload.destinationId);
    if (!destination) {
      sendJson(res, 404, { error: "unknown destination" });
      return;
    }

    const dedupKey = createHash("sha256").update(`${payload.nonce}:${payload.ciphertext}:${payload.authTag}`).digest("hex");
    if (this.recentlyDelivered.has(dedupKey)) {
      sendJson(res, 200, { ok: true, deduped: true });
      return;
    }

    let plaintext: Buffer;
    try {
      plaintext = unsealExternalDelivery(destination.identity, {
        senderEphemeralPublicKey: payload.senderEphemeralPublicKey,
        nonce: payload.nonce,
        ciphertext: payload.ciphertext,
        authTag: payload.authTag,
      });
    } catch {
      // Wrong key, or tampered/corrupted ciphertext (auth tag mismatch) — never crash the process
      // over a single bad delivery attempt.
      sendJson(res, 400, { error: "failed to decrypt payload" });
      return;
    }

    // `plaintext.length > MAX_WEBHOOK_PAYLOAD_BYTES` can't happen here: AES-256-GCM ciphertext is
    // exactly as long as its plaintext, and `extractExternalDeliveryPayload()` above already
    // rejected anything whose ciphertext exceeds `MAX_CIPHERTEXT_HEX_LENGTH` before this point was
    // ever reached. An empty message, though, is a legal `extractExternalDeliveryPayload()` shape
    // (zero-length ciphertext) — reject it here rather than POSTing the webhook an empty body.
    if (plaintext.length === 0) {
      sendJson(res, 400, { error: "message text out of bounds" });
      return;
    }

    // Mutually exclusive by convention (docs/next-steps.md decision #2, "testo o file"), not both at
    // once — see decodeUtf8IfValid()'s own doc comment for why this is the only signal available.
    const text = decodeUtf8IfValid(plaintext);
    const body = text !== undefined ? { text } : { dataBase64: plaintext.toString("base64") };
    const target: WebhookDestinationTarget = { webhookUrl: destination.webhookUrl, authToken: destination.authToken };

    // Reserved *before* the await, not after a successful send — same race `whatsapp-relay/server.ts`
    // closes for the identical reason: two overlapping requests for the same retried delivery must
    // never both pass the `has()` check above. Rolled back on failure so a genuine retry after a
    // real failure isn't a permanent "deduped" no-op.
    this.recentlyDelivered.set(dedupKey, true);
    try {
      await postToWebhook(target, body);
    } catch {
      this.recentlyDelivered.delete(dedupKey);
      // Best-effort, no ack — same posture as `attemptExternalDeliveryPost()` on the Box side: leave
      // it to the Box's own retry loop, never retry in a tight loop here.
      sendJson(res, 502, { error: "webhook delivery failed" });
      return;
    }

    sendJson(res, 200, { ok: true });
  }
}
