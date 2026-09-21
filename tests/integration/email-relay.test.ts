import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptionIdentity } from "../../node/src/encryption.js";
import { attemptExternalDeliveryPost, sealExternalDelivery, type QueuedExternalDelivery } from "../../node/src/external-delivery.js";
import { Priority } from "../../node/src/packet.js";
import { FakeSmtpServer } from "../../email-relay/fake-smtp-server.js";
import { EXTERNAL_DELIVERY_PATH, EmailRelayServer, type EmailRelayDestinationConfig } from "../../email-relay/server.js";
import { sendEmail } from "../../email-relay/smtp-client.js";

/**
 * The "destination" side of "consegna esterna differita"
 * (`node/src/external-delivery.ts`) for a second concrete example
 * (`docs/service-catalog.md`, alongside `whatsapp-relay/`): a short text
 * message relayed as a plain-text email to a fixed address. Exercises the
 * real `sealExternalDelivery()`/`attemptExternalDeliveryPost()` the Box
 * itself would use — this relay is tested exactly as the Box would
 * actually talk to it, not through a simplified stand-in.
 *
 * `isPubliclyRoutableUrl()` is mocked open here, same technique and same
 * reasoning `whatsapp-relay.test.ts`/`external-delivery.test.ts` already
 * document: every server in this file is deliberately loopback
 * (127.0.0.1), the exact address class that guard exists to reject in
 * production — not re-tested here, since it isn't new code introduced by
 * this relay.
 */
vi.mock("../../node/src/url-safety.js", () => ({ isPubliclyRoutableUrl: vi.fn(async () => true) }));

const DESTINATION_ID = "hq-report";
const SMTP_USERNAME = "relay@example.org";
const SMTP_PASSWORD = "fake-app-password";
const FROM_ADDRESS = "relay@example.org";
const TO_ADDRESS = "sede@organizzazione.org";

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

describe("EmailRelayServer (consegna esterna differita — destinazione email)", () => {
  let fakeSmtp: FakeSmtpServer;
  let relay: EmailRelayServer;
  let destinationIdentity: EncryptionIdentity;
  let deliveryUrl: string;

  beforeEach(async () => {
    fakeSmtp = new FakeSmtpServer({ expectedUsername: SMTP_USERNAME, expectedPassword: SMTP_PASSWORD });
    await fakeSmtp.start();

    destinationIdentity = EncryptionIdentity.generate();
    const destinations = new Map<string, EmailRelayDestinationConfig>([
      [DESTINATION_ID, { identity: destinationIdentity, toAddress: TO_ADDRESS, subject: "Message via ARALD mesh" }],
    ]);
    relay = new EmailRelayServer({
      destinations,
      smtp: { host: "127.0.0.1", port: fakeSmtp.port, username: SMTP_USERNAME, password: SMTP_PASSWORD, rejectUnauthorized: false },
      fromAddress: FROM_ADDRESS,
    });
    await relay.start();
    deliveryUrl = `http://127.0.0.1:${relay.port}${EXTERNAL_DELIVERY_PATH}`;
  });

  afterEach(async () => {
    await relay.stop();
    await fakeSmtp.stop();
  });

  it("delivers a sealed text end-to-end: the Box's own attemptExternalDeliveryPost() succeeds, and the SMTP server receives the plaintext", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("Arrivato al rifugio, tutto ok."), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(true);
    expect(fakeSmtp.emails).toEqual([
      { fromAddress: FROM_ADDRESS, toAddress: TO_ADDRESS, subject: "Message via ARALD mesh", bodyText: "Arrivato al rifugio, tutto ok." },
    ]);
  });

  it("round-trips a body whose lines start with a dot, exercising dot-stuffing/de-stuffing symmetrically", async () => {
    const body = "Report:\n.uno\n..due\nfine.";
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from(body), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(true);
    expect(fakeSmtp.emails[0].bodyText).toBe("Report:\r\n.uno\r\n..due\r\nfine.");
  });

  it("returns 404 for an unknown destinationId, without crashing or contacting the SMTP server", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("hello"), destinationIdentity.publicKeyHex);
    entry.destinationId = "not-a-real-destination";

    const res = await fetch(deliveryUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) });

    expect(res.status).toBe(404);
    expect(fakeSmtp.emails).toHaveLength(0);
  });

  it("returns 400 for a malformed JSON body instead of crashing, and keeps serving afterwards", async () => {
    const malformed = await fetch(deliveryUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not valid json" });
    expect(malformed.status).toBe(400);

    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("still works"), destinationIdentity.publicKeyHex);
    expect(await attemptExternalDeliveryPost(entry)).toBe(true);
  });

  it("returns 400 for a payload missing required fields, without touching the SMTP server", async () => {
    const res = await fetch(deliveryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationId: DESTINATION_ID }),
    });

    expect(res.status).toBe(400);
    expect(fakeSmtp.emails).toHaveLength(0);
  });

  it("returns 400 when the payload was sealed for a different destination (can't decrypt), without crashing", async () => {
    const wrongIdentity = EncryptionIdentity.generate();
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("intercepted?"), wrongIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false); // attemptExternalDeliveryPost() only treats a 2xx as success
    expect(fakeSmtp.emails).toHaveLength(0);
  });

  it("deduplicates a retried identical submission — the email is sent only once", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("solo una volta"), destinationIdentity.publicKeyHex);

    expect(await attemptExternalDeliveryPost(entry)).toBe(true);
    expect(await attemptExternalDeliveryPost(entry)).toBe(true); // same sealed bytes — simulates the Box retrying after losing the first response

    expect(fakeSmtp.emails).toHaveLength(1);
  });

  it("deduplicates two genuinely concurrent identical submissions, not just sequential retries", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("in volo insieme"), destinationIdentity.publicKeyHex);

    const [first, second] = await Promise.all([attemptExternalDeliveryPost(entry), attemptExternalDeliveryPost(entry)]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(fakeSmtp.emails).toHaveLength(1);
  });

  it("returns 502 (not a crash) when the SMTP server rejects the message, leaving the delivery retriable", async () => {
    fakeSmtp.failNextMessage(550, "Mailbox unavailable");
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("this one fails"), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false);
  });

  it("returns 502 when SMTP authentication fails, instead of crashing", async () => {
    fakeSmtp.failNextAuth();
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("auth will fail"), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false);
  });

  it("rejects an empty message instead of sending an empty email", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.alloc(0), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false);
    expect(fakeSmtp.emails).toHaveLength(0);
  });

  it("does not insert a spurious blank line before the DATA terminator when the body already ends in a newline", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("hello world\n"), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(true);
    expect(fakeSmtp.emails[0].bodyText).toBe("hello world");
  });

  it("quoted-printable-encodes non-ASCII characters and declares it in the headers, instead of sending raw 8-bit bytes", async () => {
    const entry = makeQueuedDelivery(deliveryUrl, Buffer.from("Città raggiunta, tutto ok."), destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(true);
    expect(fakeSmtp.emails[0].bodyText).toBe("Citt=C3=A0 raggiunta, tutto ok.");
    expect(fakeSmtp.lastHeaderBlock?.toLowerCase()).toContain("content-transfer-encoding: quoted-printable");
  });

  it("rejects a plaintext larger than the configured email text limit, without contacting the SMTP server", async () => {
    const tooLong = Buffer.from("x".repeat(5000)); // > MAX_EMAIL_TEXT_BYTES (4096)
    const entry = makeQueuedDelivery(deliveryUrl, tooLong, destinationIdentity.publicKeyHex);

    const delivered = await attemptExternalDeliveryPost(entry);

    expect(delivered).toBe(false);
    expect(fakeSmtp.emails).toHaveLength(0);
  });
});

describe("sendEmail (email-relay/smtp-client.ts, against FakeSmtpServer)", () => {
  let fakeSmtp: FakeSmtpServer;

  beforeEach(async () => {
    fakeSmtp = new FakeSmtpServer({ expectedUsername: SMTP_USERNAME, expectedPassword: SMTP_PASSWORD });
    await fakeSmtp.start();
  });

  afterEach(async () => {
    await fakeSmtp.stop();
  });

  it("sends a plain-text email with the expected envelope and headers", async () => {
    await sendEmail(
      { host: "127.0.0.1", port: fakeSmtp.port, username: SMTP_USERNAME, password: SMTP_PASSWORD, rejectUnauthorized: false },
      { fromAddress: FROM_ADDRESS, toAddress: TO_ADDRESS, subject: "Ciao", bodyText: "Un messaggio di prova." },
    );

    expect(fakeSmtp.emails).toEqual([{ fromAddress: FROM_ADDRESS, toAddress: TO_ADDRESS, subject: "Ciao", bodyText: "Un messaggio di prova." }]);
  });

  it("throws a clear error when the credentials are wrong, instead of a generic failure", async () => {
    await expect(
      sendEmail(
        { host: "127.0.0.1", port: fakeSmtp.port, username: SMTP_USERNAME, password: "wrong-password", rejectUnauthorized: false },
        { fromAddress: FROM_ADDRESS, toAddress: TO_ADDRESS, subject: "Ciao", bodyText: "test" },
      ),
    ).rejects.toThrow(/AUTH PLAIN/);
  });

  it("throws when the server is unreachable, instead of hanging", async () => {
    const unreachablePort = fakeSmtp.port;
    await fakeSmtp.stop();

    await expect(
      sendEmail(
        { host: "127.0.0.1", port: unreachablePort, username: SMTP_USERNAME, password: SMTP_PASSWORD, rejectUnauthorized: false },
        { fromAddress: FROM_ADDRESS, toAddress: TO_ADDRESS, subject: "Ciao", bodyText: "test" },
      ),
    ).rejects.toThrow();

    // afterEach will call stop() again on an already-stopped server — a no-op (mirrors
    // LoopbackHttpServer.stop()'s own documented no-op for the same situation).
  });

  it("does not destroy an otherwise-healthy connection when a mid-transaction reply is slower than connectTimeoutMs", async () => {
    // Regression for the connect-phase idle timer staying armed after secureConnect: a short
    // connectTimeoutMs used to also cap every later idle gap in the transaction, not just the
    // initial connect. Delaying the AUTH reply past connectTimeoutMs (but well within
    // commandTimeoutMs) reproduces that — before the fix, this send would fail.
    fakeSmtp.delayNextResponseMs(300);

    await expect(
      sendEmail(
        { host: "127.0.0.1", port: fakeSmtp.port, username: SMTP_USERNAME, password: SMTP_PASSWORD, rejectUnauthorized: false, connectTimeoutMs: 100, commandTimeoutMs: 5000 },
        { fromAddress: FROM_ADDRESS, toAddress: TO_ADDRESS, subject: "Ciao", bodyText: "slow but alive" },
      ),
    ).resolves.toBeUndefined();

    expect(fakeSmtp.emails).toEqual([{ fromAddress: FROM_ADDRESS, toAddress: TO_ADDRESS, subject: "Ciao", bodyText: "slow but alive" }]);
  });

  it("rejects an address containing a line break, refusing to send an SMTP command injection", async () => {
    await expect(
      sendEmail(
        { host: "127.0.0.1", port: fakeSmtp.port, username: SMTP_USERNAME, password: SMTP_PASSWORD, rejectUnauthorized: false },
        { fromAddress: FROM_ADDRESS, toAddress: "victim@example.org>\r\nRCPT TO:<attacker@evil.org", subject: "Ciao", bodyText: "test" },
      ),
    ).rejects.toThrow(/line break/);
    expect(fakeSmtp.emails).toHaveLength(0);
  });
});
