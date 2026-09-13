import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptionIdentity } from "../../node/src/encryption.js";
import { attemptExternalDeliveryPost, sealExternalDelivery, type QueuedExternalDelivery } from "../../node/src/external-delivery.js";
import { Priority } from "../../node/src/packet.js";
import { FakeWhatsAppCloudServer } from "../../whatsapp-relay/fake-whatsapp-cloud-server.js";
import { EXTERNAL_DELIVERY_PATH, WhatsAppRelayServer, type WhatsAppRelayDestinationConfig } from "../../whatsapp-relay/server.js";
import { sendWhatsAppText } from "../../whatsapp-relay/whatsapp-client.js";

/**
 * The "destination" side of "consegna esterna differita"
 * (`node/src/external-delivery.ts`) for a concrete example service
 * (`docs/service-catalog.md`): a short text message relayed to a fixed
 * WhatsApp contact. Exercises the real `sealExternalDelivery()`/
 * `attemptExternalDeliveryPost()` the Box itself would use — this relay is
 * tested exactly as the Box would actually talk to it, not through a
 * simplified stand-in.
 *
 * `isPubliclyRoutableUrl()` is mocked open here, same technique and same
 * reasoning `tests/integration/external-delivery.test.ts` already documents:
 * every server in this file is deliberately loopback (127.0.0.1), the exact
 * address class that guard exists to reject in production. The guard itself
 * is already covered end to end elsewhere (`tests/unit/url-safety.test.ts`,
 * plus a dedicated unmocked test in `external-delivery.test.ts`) — not
 * re-tested here, since it isn't new code introduced by this relay.
 */
vi.mock("../../node/src/url-safety.js", () => ({ isPubliclyRoutableUrl: vi.fn(async () => true) }));

const DESTINATION_ID = "mario-whatsapp";
const ACCESS_TOKEN = "fake-access-token";

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

describe("WhatsAppRelayServer (consegna esterna differita — destinazione WhatsApp)", () => {
  let fakeWhatsApp: FakeWhatsAppCloudServer;
  let relay: WhatsAppRelayServer;
  let destinationIdentity: EncryptionIdentity;
  let deliveryUrl: string;

  beforeEach(async () => {
    fakeWhatsApp = new FakeWhatsAppCloudServer({ expectedAccessToken: ACCESS_TOKEN });
    await fakeWhatsApp.start();

    destinationIdentity = EncryptionIdentity.generate();
    const destinations = new Map<string, WhatsAppRelayDestinationConfig>([[DESTINATION_ID, { identity: destinationIdentity, toNumber: "391234567890" }]]);
    relay = new WhatsAppRelayServer({
      destinations,
      whatsapp: { baseUrl: fakeWhatsApp.baseUrl, phoneNumberId: "123456", accessToken: ACCESS_TOKEN },
    });
    await relay.start();
    deliveryUrl = `http://127.0.0.1:${relay.port}${EXTERNAL_DELIVERY_PATH}`;
  });

  afterEach(async () => {
    await relay.stop();
    await fakeWhatsApp.stop();
  });

  it("delivers a sealed text end-to-end: the Box's own attemptExternalDeliveryPost() succeeds, and WhatsApp receives the plaintext", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("Arrivato al rifugio, tutto ok."), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(true);
    expect(fakeWhatsApp.messages).toEqual([{ phoneNumberId: "123456", to: "391234567890", text: "Arrivato al rifugio, tutto ok." }]);
  });

  it("returns 404 for an unknown destinationId, without crashing or contacting WhatsApp", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("hello"), destinationIdentity.publicKeyHex);
    entry.destinationId = "not-a-real-destination";

    const res = await fetch(deliveryUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) });

    expect(res.status).toBe(404);
    expect(fakeWhatsApp.messages).toHaveLength(0);
  });

  it("returns 400 for a malformed JSON body instead of crashing, and keeps serving afterwards", async () => {
    const malformed = await fetch(deliveryUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not valid json" });
    expect(malformed.status).toBe(400);

    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("still works"), destinationIdentity.publicKeyHex);
    expect(await attemptExternalDeliveryPost(entry)).toBe(true);
  });

  it("returns 400 for a payload missing required fields, without touching WhatsApp", async () => {
    const res = await fetch(deliveryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationId: DESTINATION_ID }),
    });

    expect(res.status).toBe(400);
    expect(fakeWhatsApp.messages).toHaveLength(0);
  });

  it("returns 400 when the payload was sealed for a different destination (can't decrypt), without crashing", async () => {
    const wrongIdentity = EncryptionIdentity.generate();
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("intercepted?"), wrongIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false); // attemptExternalDeliveryPost() only treats a 2xx as success
    expect(fakeWhatsApp.messages).toHaveLength(0);
  });

  it("deduplicates a retried identical submission — WhatsApp receives the message only once", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("solo una volta"), destinationIdentity.publicKeyHex);

    expect(await attemptExternalDeliveryPost(entry)).toBe(true);
    expect(await attemptExternalDeliveryPost(entry)).toBe(true); // same sealed bytes — simulates the Box retrying after losing the first response

    expect(fakeWhatsApp.messages).toHaveLength(1);
  });

  it("deduplicates two genuinely concurrent identical submissions, not just sequential retries — regression test for a race where the dedup entry was only recorded after awaiting the WhatsApp send", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("in volo insieme"), destinationIdentity.publicKeyHex);

    // Two in-flight requests for the exact same sealed delivery, started together rather than one
    // after the other — the scenario the old code got wrong: the Box's own timeout firing and
    // retrying while the first attempt was still awaiting a slow WhatsApp Cloud API response.
    const [first, second] = await Promise.all([attemptExternalDeliveryPost(entry), attemptExternalDeliveryPost(entry)]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(fakeWhatsApp.messages).toHaveLength(1);
  });

  it("returns 502 (not a crash) when the WhatsApp Cloud API rejects the send, leaving the delivery retriable", async () => {
    fakeWhatsApp.setNextFailure("Recipient phone number not in allowed list");
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("this one fails"), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false);
  });

  it("rejects an empty message instead of sending WhatsApp an empty text", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.alloc(0), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false);
    expect(fakeWhatsApp.messages).toHaveLength(0);
  });

  it("rejects a plaintext larger than the configured WhatsApp text limit, without contacting WhatsApp", async () => {
    const tooLong = Buffer.from("x".repeat(5000)); // > MAX_WHATSAPP_TEXT_BYTES (4096)
    const entry = makeQueuedDelivery(deliveryUrl, tooLong, destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false);
    expect(fakeWhatsApp.messages).toHaveLength(0);
  });
});

describe("sendWhatsAppText (whatsapp-relay/whatsapp-client.ts, against FakeWhatsAppCloudServer)", () => {
  let fakeWhatsApp: FakeWhatsAppCloudServer;

  beforeEach(async () => {
    fakeWhatsApp = new FakeWhatsAppCloudServer({ expectedAccessToken: ACCESS_TOKEN });
    await fakeWhatsApp.start();
  });

  afterEach(async () => {
    await fakeWhatsApp.stop();
  });

  it("sends a text message and returns the message id from a well-formed response", async () => {
    const result = await sendWhatsAppText({ baseUrl: fakeWhatsApp.baseUrl, phoneNumberId: "999", accessToken: ACCESS_TOKEN }, "391112223334", "ciao");

    expect(result.messageId).toMatch(/^wamid\.FAKE\d+$/);
    expect(fakeWhatsApp.messages).toEqual([{ phoneNumberId: "999", to: "391112223334", text: "ciao" }]);
  });

  it("throws a clear error when the access token is wrong, instead of a generic HTTP failure", async () => {
    await expect(sendWhatsAppText({ baseUrl: fakeWhatsApp.baseUrl, phoneNumberId: "999", accessToken: "wrong-token" }, "391112223334", "ciao")).rejects.toThrow(
      /Invalid OAuth access token/,
    );
  });

  it("throws when the backend is unreachable, instead of hanging", async () => {
    const unreachableUrl = fakeWhatsApp.baseUrl;
    await fakeWhatsApp.stop();

    await expect(sendWhatsAppText({ baseUrl: unreachableUrl, phoneNumberId: "999", accessToken: ACCESS_TOKEN }, "391112223334", "ciao")).rejects.toThrow();

    // afterEach will call stop() again on an already-stopped server — LoopbackHttpServer.stop() is
    // a documented no-op when `this.server` is undefined, so this is safe.
  });
});
