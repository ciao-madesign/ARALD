import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BoundedFifoMap } from "../node/src/bounded-map.js";
import { EncryptionIdentity } from "../node/src/encryption.js";
import { extractExternalDeliveryPayload, unsealExternalDelivery } from "../node/src/external-delivery.js";
import { BodyTooLargeError, LoopbackHttpServer, readRequestBody, sendJson } from "../node/src/loopback-http-server.js";
import { sendEmail, type SmtpConfig } from "./smtp-client.js";

/**
 * The "destination" side of ARALD's "consegna esterna differita"
 * (`node/src/external-delivery.ts`, `docs/service-catalog.md`), a second
 * concrete example alongside `whatsapp-relay/`: relaying a short text
 * message as a plain-text email to one fixed address. Same posture as
 * `whatsapp-relay/server.ts` — this process is deliberately **outside the
 * mesh entirely**, the Box only ever POSTs an opaque E2E-sealed blob to it,
 * never anything it could read. Text only for v1 (no attachment) — an
 * explicit scope decision, matching `whatsapp-relay/`'s own shape exactly
 * rather than inventing a structured envelope up front.
 *
 * One `destinationId` maps to exactly one email address, chosen once by
 * whoever runs this relay — same "mai un indirizzo tecnico" requirement as
 * every other destination type, unchanged here.
 */

export const EXTERNAL_DELIVERY_PATH = "/deliver";
/** Defensive cap on what this relay will ever attempt to send — not a claim about any real mail server's actual limit (typically far larger), same conservative-default posture as `whatsapp-relay/whatsapp-client.ts`'s `MAX_WHATSAPP_TEXT_BYTES`. */
export const MAX_EMAIL_TEXT_BYTES = 4096;
const MAX_CIPHERTEXT_HEX_LENGTH = MAX_EMAIL_TEXT_BYTES * 2; // AES-GCM ciphertext is plaintext-length; hex doubles bytes.
const MAX_BODY_BYTES = 16_384; // generous margin over the largest legal body (bounded ciphertext + fixed-length hex fields + JSON overhead).
const DEFAULT_MAX_RECENTLY_DELIVERED = 500;

export interface EmailRelayDestinationConfig {
  /** Built once (`keypair.ts`), not re-derived from hex on every request — same reasoning as `whatsapp-relay/server.ts`'s identical field. */
  identity: EncryptionIdentity;
  toAddress: string;
  subject: string;
}

export interface EmailRelayServerOptions {
  port?: number;
  host?: string;
  destinations: Map<string, EmailRelayDestinationConfig>;
  smtp: SmtpConfig;
  fromAddress: string;
  /** How many recently-delivered submissions to remember, to skip a duplicate email send if the Box retries a delivery whose response it never received — see `recentlyDelivered`'s own doc comment. */
  maxRecentlyDeliveredEntries?: number;
}

export class EmailRelayServer {
  private readonly httpServer: LoopbackHttpServer;
  private readonly destinations: Map<string, EmailRelayDestinationConfig>;
  private readonly smtp: SmtpConfig;
  private readonly fromAddress: string;
  /**
   * Same reasoning as `whatsapp-relay/server.ts`'s identical field:
   * `ExternalDeliveryQueue` only removes an entry from the Box's queue after
   * a 2xx response, so a lost response after a successful send would
   * otherwise cause a Box retry to send the same email twice.
   * `nonce`/`ciphertext`/`authTag` together are a stable idempotency key
   * across such retries (`sealExternalDelivery()` seals once, at submission
   * time — a retry resends the identical sealed bytes).
   */
  private readonly recentlyDelivered: BoundedFifoMap<string, true>;

  constructor(options: EmailRelayServerOptions) {
    this.destinations = options.destinations;
    this.smtp = options.smtp;
    this.fromAddress = options.fromAddress;
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

    // `plaintext.length > MAX_EMAIL_TEXT_BYTES` can't happen here: AES-256-GCM ciphertext is exactly
    // as long as its plaintext, and `extractExternalDeliveryPayload()` above already rejected
    // anything whose ciphertext exceeds `MAX_CIPHERTEXT_HEX_LENGTH`. An empty message, though, is a
    // legal shape (zero-length ciphertext) — reject it here rather than sending an empty email.
    if (plaintext.length === 0) {
      sendJson(res, 400, { error: "message text out of bounds" });
      return;
    }
    const bodyText = plaintext.toString("utf8");

    // Reserved *before* the await, not after a successful send — same race `whatsapp-relay/server.ts`
    // closes for the identical reason: two overlapping requests for the same retried delivery must
    // never both pass the `has()` check above. Rolled back on failure so a genuine retry after a
    // real failure isn't a permanent "deduped" no-op.
    this.recentlyDelivered.set(dedupKey, true);
    try {
      await sendEmail(this.smtp, { fromAddress: this.fromAddress, toAddress: destination.toAddress, subject: destination.subject, bodyText });
    } catch {
      this.recentlyDelivered.delete(dedupKey);
      // Best-effort, no ack — same posture as `attemptExternalDeliveryPost()` on the Box side: leave
      // it to the Box's own retry loop, never retry in a tight loop here.
      sendJson(res, 502, { error: "email delivery failed" });
      return;
    }

    sendJson(res, 200, { ok: true });
  }
}
