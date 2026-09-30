import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptionIdentity } from "../../node/src/encryption.js";
import { attemptExternalDeliveryPost, sealExternalDelivery, type QueuedExternalDelivery } from "../../node/src/external-delivery.js";
import { Priority } from "../../node/src/packet.js";
import { FakeWebhookServer } from "../../webhook-relay/fake-webhook-server.js";
import { EXTERNAL_DELIVERY_PATH, WebhookRelayServer, type WebhookRelayDestinationConfig } from "../../webhook-relay/server.js";
import { postToWebhook } from "../../webhook-relay/webhook-client.js";

/**
 * The "destination" side of "consegna esterna differita"
 * (`node/src/external-delivery.ts`) for the generic webhook example
 * (`docs/next-steps.md`, `docs/service-catalog.md`): a post/check-in/upload
 * forwarded as JSON to an operator-configured webhook. Exercises the real
 * `sealExternalDelivery()`/`attemptExternalDeliveryPost()` the Box itself
 * would use — this relay is tested exactly as the Box would actually talk to
 * it, not through a simplified stand-in.
 *
 * `isPubliclyRoutableUrl()` is mocked open here, same technique and same
 * reasoning `whatsapp-relay.test.ts`/`email-relay.test.ts` already document:
 * every server in this file is deliberately loopback (127.0.0.1) — not
 * re-tested here, since it isn't new code introduced by this relay.
 */
vi.mock("../../node/src/url-safety.js", () => ({ isPubliclyRoutableUrl: vi.fn(async () => true) }));

const DESTINATION_ID = "coordinamento-cnsas";
const AUTH_TOKEN = "fake-fixed-token";

function makeQueuedDelivery(url: string, plaintext: Buffer, destinationPublicKeyHex: string): QueuedExternalDelivery {
  const sealed = sealExternalDelivery(destinationPublicKeyHex, plaintext);
  return {
    packetId: "pkt-1",
    destinationId: DESTINATION_ID,
    url,
    senderEphemeralPublicKey: sealed.senderEphemeralPublicKey,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    authTag: sealed.authTag,
    submittedAt: Date.now(),
    priority: Priority.NORMAL,
    sizeBytes: sealed.ciphertext.length,
    expiresAt: Date.now() + 60_000,
  };
}

describe("WebhookRelayServer (consegna esterna differita — destinazione webhook generica)", () => {
  let fakeWebhook: FakeWebhookServer;
  let relay: WebhookRelayServer;
  let destinationIdentity: EncryptionIdentity;
  let deliveryUrl: string;

  beforeEach(async () => {
    fakeWebhook = new FakeWebhookServer();
    await fakeWebhook.start();

    destinationIdentity = EncryptionIdentity.generate();
    const destinations = new Map<string, WebhookRelayDestinationConfig>([
      [DESTINATION_ID, { identity: destinationIdentity, webhookUrl: `${fakeWebhook.baseUrl}/${DESTINATION_ID}`, authToken: AUTH_TOKEN }],
    ]);
    relay = new WebhookRelayServer({ destinations });
    await relay.start();
    deliveryUrl = `http://127.0.0.1:${relay.port}${EXTERNAL_DELIVERY_PATH}`;
  });

  afterEach(async () => {
    await relay.stop();
    await fakeWebhook.stop();
  });

  it("delivers a sealed text message end-to-end as {text: ...}, with the configured auth token", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("Arrivato al rifugio, tutto ok."), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(true);
    expect(fakeWebhook.requests).toEqual([
      { path: `/${DESTINATION_ID}`, authorizationHeader: `Bearer ${AUTH_TOKEN}`, body: { text: "Arrivato al rifugio, tutto ok." } },
    ]);
  });

  it("delivers sealed binary bytes end-to-end as {dataBase64: ...}, not misread as text", async () => {
    // Invalid UTF-8 byte sequence (a lone continuation byte) — the only signal this relay has for
    // "this is a file, not text" given the mesh side never sends filename/MIME metadata.
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    const entry = makeQueuedDelivery(deliveryUrl, binary, destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(true);
    expect(fakeWebhook.requests).toEqual([{ path: `/${DESTINATION_ID}`, authorizationHeader: `Bearer ${AUTH_TOKEN}`, body: { dataBase64: binary.toString("base64") } }]);
  });

  it("omits the Authorization header entirely when the destination has no authToken configured", async () => {
    const destinations = new Map<string, WebhookRelayDestinationConfig>([
      [DESTINATION_ID, { identity: destinationIdentity, webhookUrl: `${fakeWebhook.baseUrl}/no-auth` }],
    ]);
    const noAuthRelay = new WebhookRelayServer({ destinations });
    await noAuthRelay.start();
    try {
      const url = `http://127.0.0.1:${noAuthRelay.port}${EXTERNAL_DELIVERY_PATH}`;
      const entry = makeQueuedDelivery(url, Buffer.from("nessun token"), destinationIdentity.publicKeyHex);

      expect(await attemptExternalDeliveryPost(entry)).toBe(true);
      expect(fakeWebhook.requests).toEqual([{ path: "/no-auth", authorizationHeader: undefined, body: { text: "nessun token" } }]);
    } finally {
      await noAuthRelay.stop();
    }
  });

  it("returns 404 for an unknown destinationId, without crashing or contacting the webhook", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("hello"), destinationIdentity.publicKeyHex);
    entry.destinationId = "not-a-real-destination";

    const res = await fetch(deliveryUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) });

    expect(res.status).toBe(404);
    expect(fakeWebhook.requests).toHaveLength(0);
  });

  it("returns 400 for a malformed JSON body instead of crashing, and keeps serving afterwards", async () => {
    const malformed = await fetch(deliveryUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not valid json" });
    expect(malformed.status).toBe(400);

    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("still works"), destinationIdentity.publicKeyHex);
    expect(await attemptExternalDeliveryPost(entry)).toBe(true);
  });

  it("returns 400 for a payload missing required fields, without touching the webhook", async () => {
    const res = await fetch(deliveryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationId: DESTINATION_ID }),
    });

    expect(res.status).toBe(400);
    expect(fakeWebhook.requests).toHaveLength(0);
  });

  it("returns 400 when the payload was sealed for a different destination (can't decrypt), without crashing", async () => {
    const wrongIdentity = EncryptionIdentity.generate();
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("intercepted?"), wrongIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false); // attemptExternalDeliveryPost() only treats a 2xx as success
    expect(fakeWebhook.requests).toHaveLength(0);
  });

  it("deduplicates a retried identical submission — the webhook is called only once", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("solo una volta"), destinationIdentity.publicKeyHex);

    expect(await attemptExternalDeliveryPost(entry)).toBe(true);
    expect(await attemptExternalDeliveryPost(entry)).toBe(true); // same sealed bytes — simulates the Box retrying after losing the first response

    expect(fakeWebhook.requests).toHaveLength(1);
  });

  it("deduplicates two genuinely concurrent identical submissions, not just sequential retries — regression test for a race where the dedup entry was only recorded after awaiting the webhook POST", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("in volo insieme"), destinationIdentity.publicKeyHex);

    const [first, second] = await Promise.all([attemptExternalDeliveryPost(entry), attemptExternalDeliveryPost(entry)]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(fakeWebhook.requests).toHaveLength(1);
  });

  it("returns 502 (not a crash) when the webhook rejects the request, leaving the delivery retriable", async () => {
    fakeWebhook.setNextFailure(500);
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("this one fails"), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false);
  });

  it("allows a genuine retry after a real failure to succeed — the dedup entry is rolled back, not a permanent no-op", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("first attempt fails, retry should work"), destinationIdentity.publicKeyHex);
    fakeWebhook.setNextFailure(503);

    expect(await attemptExternalDeliveryPost(entry)).toBe(false);
    expect(await attemptExternalDeliveryPost(entry)).toBe(true);

    expect(fakeWebhook.requests).toHaveLength(1);
  });

  it("rejects an empty message instead of POSTing an empty body to the webhook", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.alloc(0), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false);
    expect(fakeWebhook.requests).toHaveLength(0);
  });

  it("rejects a plaintext larger than the configured webhook payload limit, without contacting the webhook", async () => {
    const tooLong = Buffer.alloc(1_000_001, 0x61); // > MAX_WEBHOOK_PAYLOAD_BYTES (1_000_000)
    const entry = makeQueuedDelivery(deliveryUrl, tooLong, destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false);
    expect(fakeWebhook.requests).toHaveLength(0);
  });
});

describe("postToWebhook (webhook-relay/webhook-client.ts, against FakeWebhookServer)", () => {
  let fakeWebhook: FakeWebhookServer;

  beforeEach(async () => {
    fakeWebhook = new FakeWebhookServer();
    await fakeWebhook.start();
  });

  afterEach(async () => {
    await fakeWebhook.stop();
  });

  it("sends the given JSON body with a Bearer token when authToken is set", async () => {
    await postToWebhook({ webhookUrl: `${fakeWebhook.baseUrl}/hook`, authToken: "tok-123" }, { text: "ciao" });

    expect(fakeWebhook.requests).toEqual([{ path: "/hook", authorizationHeader: "Bearer tok-123", body: { text: "ciao" } }]);
  });

  it("throws a clear error when the webhook rejects the request, instead of a generic fetch failure", async () => {
    fakeWebhook.setNextFailure(401);

    await expect(postToWebhook({ webhookUrl: `${fakeWebhook.baseUrl}/hook` }, { text: "ciao" })).rejects.toThrow(/HTTP 401/);
  });

  it("throws when the endpoint is unreachable, instead of hanging", async () => {
    const unreachableUrl = `${fakeWebhook.baseUrl}/hook`;
    await fakeWebhook.stop();

    await expect(postToWebhook({ webhookUrl: unreachableUrl }, { text: "ciao" })).rejects.toThrow();

    // afterEach will call stop() again on an already-stopped server — LoopbackHttpServer.stop() is
    // a documented no-op when `this.server` is undefined, so this is safe.
  });
});
