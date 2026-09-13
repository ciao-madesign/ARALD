import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BoundedFifoMap } from "../node/src/bounded-map.js";
import { EncryptionIdentity } from "../node/src/encryption.js";
import { extractExternalDeliveryPayload, unsealExternalDelivery } from "../node/src/external-delivery.js";
import { BodyTooLargeError, LoopbackHttpServer, readRequestBody, sendJson } from "../node/src/loopback-http-server.js";
import { MAX_WHATSAPP_TEXT_BYTES, sendWhatsAppText, type WhatsAppCloudConfig } from "./whatsapp-client.js";

/**
 * The "destination" side of ARALD's "consegna esterna differita"
 * (`node/src/external-delivery.ts`, `docs/service-catalog.md`), concretely
 * for one external service: relaying a short text message to a fixed
 * WhatsApp contact. This process is deliberately **outside the mesh
 * entirely** — it's what an operator (a family member, an NGO desk, CNSAS)
 * runs on their own always-connected server; the ARALD Box only ever POSTs
 * an opaque E2E-sealed blob to it (`attemptExternalDeliveryPost()`), never
 * anything it could read.
 *
 * One `destinationId` maps to exactly one WhatsApp contact, chosen once by
 * whoever runs this relay — the *sender* on the mesh side only ever picks a
 * friendly label ("WhatsApp: Mario Rossi") from the Box's public directory,
 * never a phone number (`docs/service-catalog.md`'s "mai un indirizzo
 * tecnico" requirement, unchanged by this destination type).
 */

export const EXTERNAL_DELIVERY_PATH = "/deliver";
const MAX_CIPHERTEXT_HEX_LENGTH = MAX_WHATSAPP_TEXT_BYTES * 2; // AES-GCM ciphertext is plaintext-length; hex doubles bytes.
const MAX_BODY_BYTES = 16_384; // generous margin over the largest legal body (bounded ciphertext + fixed-length hex fields + JSON overhead).
const DEFAULT_MAX_RECENTLY_DELIVERED = 500;

export interface WhatsAppRelayDestinationConfig {
  /** Built once (`keypair.ts`), not re-derived from hex on every request — reconstructing a JWK key object is real (if small) work, and every Box retry of the same delivery would otherwise redo it for nothing. */
  identity: EncryptionIdentity;
  /** E.164 phone number, digits only (no leading `+`) — WhatsApp Cloud API's own convention. */
  toNumber: string;
}

export interface WhatsAppRelayServerOptions {
  port?: number;
  host?: string;
  destinations: Map<string, WhatsAppRelayDestinationConfig>;
  whatsapp: WhatsAppCloudConfig;
  /** How many recently-delivered submissions to remember, to skip a duplicate WhatsApp send if the Box retries a delivery whose response it never received (network drop *after* a successful send) — see the doc comment on `recentlyDelivered` below for why this is possible at all. */
  maxRecentlyDeliveredEntries?: number;
}

export class WhatsAppRelayServer {
  private readonly httpServer: LoopbackHttpServer;
  private readonly destinations: Map<string, WhatsAppRelayDestinationConfig>;
  private readonly whatsapp: WhatsAppCloudConfig;
  /**
   * `ExternalDeliveryQueue` only removes an entry from the Box's queue after
   * a 2xx response — if this relay sends the WhatsApp message successfully
   * but the response never makes it back (the destination's own network
   * drops, not the mesh's), the Box will retry the *exact same* sealed bytes
   * next round (`sealExternalDelivery()` runs once at submission time, not
   * per retry — `node/src/external-delivery.ts`). `nonce`/`ciphertext`/
   * `authTag` together are therefore a stable idempotency key across
   * retries of one logical delivery, cheap to remember here to avoid a
   * WhatsApp recipient seeing the same message twice — a duplicate is a far
   * more visible failure mode for a chat message than for a file.
   */
  private readonly recentlyDelivered: BoundedFifoMap<string, true>;

  constructor(options: WhatsAppRelayServerOptions) {
    this.destinations = options.destinations;
    this.whatsapp = options.whatsapp;
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

    // `plaintext.length > MAX_WHATSAPP_TEXT_BYTES` can't happen here: AES-256-GCM ciphertext is
    // exactly as long as its plaintext, and `extractExternalDeliveryPayload()` above already
    // rejected anything whose ciphertext exceeds `MAX_CIPHERTEXT_HEX_LENGTH` before this point was
    // ever reached. An empty message, though, is a legal `extractExternalDeliveryPayload()` shape
    // (zero-length ciphertext) — reject it here rather than sending WhatsApp an empty text.
    if (plaintext.length === 0) {
      sendJson(res, 400, { error: "message text out of bounds" });
      return;
    }
    const text = plaintext.toString("utf8");

    // Reserved *before* the await, not after a successful send — found by code review: two
    // overlapping requests for the same retried delivery (the Box's own timeout firing while the
    // first attempt is still in flight against a slow WhatsApp Cloud API) would otherwise both pass
    // the `has()` check above and both actually send the WhatsApp message, defeating the point of
    // this cache. Rolled back on failure so a genuine retry after a real failure isn't a permanent
    // "deduped" no-op.
    this.recentlyDelivered.set(dedupKey, true);
    try {
      await sendWhatsAppText(this.whatsapp, destination.toNumber, text);
    } catch {
      this.recentlyDelivered.delete(dedupKey);
      // Best-effort, no ack — same posture as `attemptExternalDeliveryPost()` on the Box side: leave
      // it to the Box's own retry loop, never retry in a tight loop here.
      sendJson(res, 502, { error: "WhatsApp delivery failed" });
      return;
    }

    sendJson(res, 200, { ok: true });
  }
}
