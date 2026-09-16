import { afterEach, describe, expect, it } from "vitest";
import { NomadNode, type NomadNodeOptions } from "../../node/src/node.js";
import { WebUiServer } from "../../node/src/web-ui.js";
import { EncryptionIdentity } from "../../node/src/encryption.js";
import { sealExternalDelivery, type ExternalDeliveryAllowlist } from "../../node/src/external-delivery.js";

/**
 * `POST /api/ingest-external-delivery` (`node/src/web-ui.ts`) — "Pezzo 3"
 * del canale di comando Box↔specchio (docs/emergency-portal.md,
 * docs/security.md voce #84). Same dedicated-file convention as
 * `ingest-relay-command-web-ui.test.ts` (Pezzo 4). Gated behind
 * `allowRemoteExternalDeliveryIngest` + network password, independent
 * dagli altri tre flag di ingest. A differenza degli altri tre, non c'è
 * alcuna firma da verificare — solo la forma del payload e
 * `destinationId` contro l'allowlist privata del Box.
 */
describe("WebUiServer POST /api/ingest-external-delivery", () => {
  const TOKEN = "test-pairing-token-0123456789abcdef";
  const nodes: NomadNode[] = [];
  const webUis: WebUiServer[] = [];

  afterEach(async () => {
    await Promise.all(webUis.map((w) => w.stop()));
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
    webUis.length = 0;
  });

  function makeGateway(
    destination: EncryptionIdentity,
    options: { allowRemoteExternalDeliveryIngest?: boolean; nodeOptions?: Partial<NomadNodeOptions> } = {},
  ): { node: NomadNode; webUi: WebUiServer; destinationId: string } {
    const destinationId = "hq-1";
    const allowlist: ExternalDeliveryAllowlist = new Map([[destinationId, { destinationId, label: "Headquarter", publicKeyHex: destination.publicKeyHex, url: "http://127.0.0.1:1/unused" }]]);
    const node = new NomadNode({ displayName: "Box", externalDeliveryAllowlist: allowlist, ...options.nodeOptions });
    const webUi = new WebUiServer(node, {
      port: 0,
      allowRemoteExternalDeliveryIngest: options.allowRemoteExternalDeliveryIngest ?? true,
      networkPassword: TOKEN,
    });
    nodes.push(node);
    webUis.push(webUi);
    return { node, webUi, destinationId };
  }

  function authedFetch(webUi: WebUiServer, body: unknown, token = TOKEN): Promise<Response> {
    return fetch(`http://127.0.0.1:${webUi.port}/api/ingest-external-delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  function submissionFor(destinationId: string, destination: EncryptionIdentity, text = "report dal campo"): unknown {
    const sealed = sealExternalDelivery(destination.publicKeyHex, Buffer.from(text));
    return { destinationId, ...sealed, submittedAt: Date.now() };
  }

  it("404s when allowRemoteExternalDeliveryIngest is off, same posture as every other opt-in endpoint", async () => {
    const destination = EncryptionIdentity.generate();
    const { node, webUi, destinationId } = makeGateway(destination, { allowRemoteExternalDeliveryIngest: false });
    await Promise.all([node.start(), webUi.start()]);

    const res = await authedFetch(webUi, submissionFor(destinationId, destination));
    expect(res.status).toBe(404);
  });

  it("401s without a valid Authorization header, and queues nothing", async () => {
    const destination = EncryptionIdentity.generate();
    const { node, webUi, destinationId } = makeGateway(destination);
    await Promise.all([node.start(), webUi.start()]);
    const submission = submissionFor(destinationId, destination);

    const noAuth = await fetch(`http://127.0.0.1:${webUi.port}/api/ingest-external-delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission),
    });
    expect(noAuth.status).toBe(401);

    const wrongPassword = await authedFetch(webUi, submission, "not-the-password");
    expect(wrongPassword.status).toBe(401);

    expect(node.externalDeliveryQueue.size).toBe(0);
  });

  it("accepts a valid password-less submission and queues it", async () => {
    const destination = EncryptionIdentity.generate();
    const { node, webUi, destinationId } = makeGateway(destination);
    await Promise.all([node.start(), webUi.start()]);

    const res = await authedFetch(webUi, submissionFor(destinationId, destination));

    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(true);
    expect(node.externalDeliveryQueue.size).toBe(1);
  });

  it("responds 422 (never 200/500) for an unknown destinationId — never trusts the caller", async () => {
    const destination = EncryptionIdentity.generate();
    const { node, webUi } = makeGateway(destination);
    await Promise.all([node.start(), webUi.start()]);

    const res = await authedFetch(webUi, submissionFor("unknown-destination", destination));

    expect(res.status).toBe(422);
    expect(node.externalDeliveryQueue.size).toBe(0);
  });

  it("rejects a request body that isn't even a JSON object with 400, never a crash", async () => {
    const destination = EncryptionIdentity.generate();
    const { node, webUi } = makeGateway(destination);
    await Promise.all([node.start(), webUi.start()]);

    expect((await authedFetch(webUi, [])).status).toBe(400);
    expect((await authedFetch(webUi, "just a string")).status).toBe(400);
    expect((await authedFetch(webUi, 42)).status).toBe(400);
    expect((await authedFetch(webUi, null)).status).toBe(400);
  });

  it("a shape-malformed but object-shaped body 422s, not 400 — the HTTP layer only checks 'is this an object'", async () => {
    const destination = EncryptionIdentity.generate();
    const { node, webUi } = makeGateway(destination);
    await Promise.all([node.start(), webUi.start()]);

    const res = await authedFetch(webUi, { destinationId: "hq-1" });
    expect(res.status).toBe(422);
  });

  it("a malformed JSON body is a 400", async () => {
    const destination = EncryptionIdentity.generate();
    const { node, webUi } = makeGateway(destination);
    await Promise.all([node.start(), webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/ingest-external-delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("429s (not 422/500) once ingestRateLimiter's own per-destination budget is exhausted", async () => {
    const destination = EncryptionIdentity.generate();
    const { node, webUi, destinationId } = makeGateway(destination, { nodeOptions: { maxPacketsPerWindow: 2, rateLimitWindowMs: 60_000 } });
    await Promise.all([node.start(), webUi.start()]);

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await authedFetch(webUi, submissionFor(destinationId, destination, `dati ${i}`));
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
    expect(statuses).not.toContain(500);
  });

  it("allowRemoteExternalDeliveryIngest requires a networkPassword at construction time", () => {
    const node = new NomadNode({ displayName: "N" });
    nodes.push(node);
    expect(() => new WebUiServer(node, { port: 0, allowRemoteExternalDeliveryIngest: true })).toThrow(/allowRemoteExternalDeliveryIngest requires a networkPassword/);
  });

  it("is independent from the other three ingest flags — enabling one doesn't enable this one", async () => {
    const destination = EncryptionIdentity.generate();
    const destinationId = "hq-1";
    const allowlist: ExternalDeliveryAllowlist = new Map([[destinationId, { destinationId, label: "Headquarter", publicKeyHex: destination.publicKeyHex, url: "http://127.0.0.1:1/unused" }]]);
    const node = new NomadNode({ displayName: "Box", externalDeliveryAllowlist: allowlist });
    const webUi = new WebUiServer(node, {
      port: 0,
      allowRemoteContentIngest: true,
      allowRemoteNodeAppendIngest: true,
      allowRemoteRelayCommandIngest: true,
      allowRemoteExternalDeliveryIngest: false,
      networkPassword: TOKEN,
    });
    nodes.push(node);
    webUis.push(webUi);
    await Promise.all([node.start(), webUi.start()]);

    const res = await authedFetch(webUi, submissionFor(destinationId, destination));
    expect(res.status).toBe(404); // external-delivery ingest still off, even though the other three are on
  });
});
