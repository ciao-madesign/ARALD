import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { WebUiServer } from "../../node/src/web-ui.js";
import { Identity } from "../../node/src/identity.js";
import { computeContentId, contentSigningPayload, type ContentMetadata } from "../../node/src/content.js";
import { DROP_CONTENT_NAME, type DropPayload } from "../../node/src/drops.js";

/**
 * `POST /api/ingest-signed-content` (`node/src/web-ui.ts`) — "Pezzo 1" del
 * canale di comando Box↔specchio (docs/emergency-portal.md, docs/security.md
 * voce #81). Same dedicated-file convention as `drops-web-ui.test.ts`. Gated
 * behind `allowRemoteContentIngest` + network password, same shape as
 * `/api/drops`/`/api/relays`; the two failure modes worth distinguishing —
 * "this caller isn't allowed to try" (401/404) vs. "this specific submission
 * doesn't verify" (422) — matter to `arald-backend`'s command poller, which
 * treats them differently (retry vs. mark-failed).
 */
describe("WebUiServer POST /api/ingest-signed-content", () => {
  const TOKEN = "test-pairing-token-0123456789abcdef";
  const nodes: NomadNode[] = [];
  const webUis: WebUiServer[] = [];

  afterEach(async () => {
    await Promise.all(webUis.map((w) => w.stop()));
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
    webUis.length = 0;
  });

  function makeGateway(allowRemoteContentIngest = true): { node: NomadNode; webUi: WebUiServer } {
    const node = new NomadNode({ displayName: "Box" });
    const webUi = new WebUiServer(node, { port: 0, allowRemoteContentIngest, networkPassword: TOKEN });
    nodes.push(node);
    webUis.push(webUi);
    return { node, webUi };
  }

  function authedFetch(webUi: WebUiServer, body: unknown, token = TOKEN): Promise<Response> {
    return fetch(`http://127.0.0.1:${webUi.port}/api/ingest-signed-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  function signedBulletin(identity: Identity): { metadata: ContentMetadata; data: string } {
    const bytes = Buffer.from("comunicazione dall'operatore", "utf8");
    const contentId = computeContentId(bytes);
    const size = bytes.length;
    const publisherId = identity.nodeId;
    const signature = identity.sign(contentSigningPayload({ contentId, name: "bulletin", mimeType: "text/plain", size, publisherId })).toString("hex");
    return {
      metadata: { contentId, name: "bulletin", mimeType: "text/plain", size, createdAt: Date.now(), publisherId, signature },
      data: bytes.toString("base64"),
    };
  }

  it("404s when allowRemoteContentIngest is off, same posture as every other opt-in endpoint", async () => {
    const { webUi } = makeGateway(false);
    await Promise.all([nodes[0].start(), webUi.start()]);
    const operator = Identity.generate();

    const res = await authedFetch(webUi, signedBulletin(operator));
    expect(res.status).toBe(404);
  });

  it("401s without a valid Authorization header, and ingests nothing", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();
    const { metadata, data } = signedBulletin(operator);

    const noAuth = await fetch(`http://127.0.0.1:${webUi.port}/api/ingest-signed-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metadata, data }),
    });
    expect(noAuth.status).toBe(401);

    const wrongPassword = await authedFetch(webUi, { metadata, data }, "not-the-password");
    expect(wrongPassword.status).toBe(401);

    expect(node.contentStore.has(metadata.contentId)).toBe(false);
  });

  it("accepts a validly signed submission from an identity that is NOT the Box's own", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();
    const { metadata, data } = signedBulletin(operator);

    const res = await authedFetch(webUi, { metadata, data });

    expect(res.status).toBe(200);
    expect((await res.json()).contentId).toBe(metadata.contentId);
    expect(node.contentStore.get(metadata.contentId)?.data.toString("utf8")).toBe("comunicazione dall'operatore");
    expect(metadata.publisherId).not.toBe(node.nodeId);
  });

  it("responds 422 (never 200/500) for a submission whose signature doesn't verify — never trusts the caller", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();
    const { metadata } = signedBulletin(operator);
    const tampered = Buffer.from("dati completamente diversi", "utf8").toString("base64");

    const res = await authedFetch(webUi, { metadata, data: tampered });

    expect(res.status).toBe(422);
    expect(node.contentStore.has(metadata.contentId)).toBe(false);
  });

  it("rejects a missing/malformed 'metadata' or non-base64-shaped 'data' with 400, never a crash", async () => {
    const { webUi } = makeGateway();
    await Promise.all([nodes[0].start(), webUi.start()]);

    expect((await authedFetch(webUi, {})).status).toBe(400);
    expect((await authedFetch(webUi, { metadata: { contentId: "x" } })).status).toBe(400); // missing required fields
    expect((await authedFetch(webUi, { metadata: "not-an-object", data: "AA==" })).status).toBe(400);
    const operator = Identity.generate();
    const { metadata } = signedBulletin(operator);
    expect((await authedFetch(webUi, { metadata })).status).toBe(400); // data missing entirely
    expect((await authedFetch(webUi, { metadata, data: 123 })).status).toBe(400); // data not a string
  });

  it("a malformed JSON body is a 400", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/ingest-signed-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("an ingested drop is recorded end-to-end with the operator, not the Box, as author", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();

    const payload: DropPayload = { text: "sentiero franato", lat: 45.5, lon: 7.5, kind: "hazard", timestamp: Date.now() };
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    const contentId = computeContentId(bytes);
    const size = bytes.length;
    const signature = operator
      .sign(contentSigningPayload({ contentId, name: DROP_CONTENT_NAME, mimeType: "application/json", size, publisherId: operator.nodeId }))
      .toString("hex");
    const metadata: ContentMetadata = {
      contentId,
      name: DROP_CONTENT_NAME,
      mimeType: "application/json",
      size,
      createdAt: Date.now(),
      publisherId: operator.nodeId,
      signature,
    };

    const res = await authedFetch(webUi, { metadata, data: bytes.toString("base64") });
    expect(res.status).toBe(200);

    // considerDrop() runs its own async fetch internally — poll instead of asserting synchronously.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (node.drops.list().length === 1) return resolve();
        if (Date.now() - start > 2000) return reject(new Error("timed out waiting for the drop to be recorded"));
        setTimeout(check, 15);
      };
      check();
    });
    const recorded = node.drops.list()[0];
    expect(recorded.text).toBe("sentiero franato");
    expect(recorded.author).toBe(operator.nodeId);
    expect(recorded.author).not.toBe(node.nodeId);
  });

  /**
   * Regression per la revisione (`docs/security.md` voce #81, punto 1): prima di questo fix
   * `POST /api/ingest-signed-content` non aveva alcun rate limiting — a differenza di un pacchetto
   * arrivato da un vero peer mesh, sempre gated da `this.rateLimiter.allow(fromPeerId)`. Verifica
   * anche che l'esito sia 429 (rimandabile), non 422 (terminale) — la distinzione che
   * `arald-backend`'s command poller usa per decidere se ritentare.
   */
  it("429s (not 422) once a single operator identity exceeds the per-identity packet budget", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();

    const statuses: number[] = [];
    for (let i = 0; i < 210; i++) {
      const bytes = Buffer.from(`bollettino ${i}`, "utf8");
      const contentId = computeContentId(bytes);
      const size = bytes.length;
      const signature = operator
        .sign(contentSigningPayload({ contentId, name: `bulletin-${i}`, mimeType: "text/plain", size, publisherId: operator.nodeId }))
        .toString("hex");
      const metadata: ContentMetadata = { contentId, name: `bulletin-${i}`, mimeType: "text/plain", size, createdAt: Date.now(), publisherId: operator.nodeId, signature };
      const res = await authedFetch(webUi, { metadata, data: bytes.toString("base64") });
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
    expect(statuses).not.toContain(500);
  });

  /**
   * Regression per la revisione (`docs/security.md` voce #81, punto 2): il campo `priority`
   * del body HTTP (non firmato) non deve mai poter far annunciare un drop "info" a
   * `Priority.EMERGENCY` — la priorità reale è sempre derivata dal `kind` firmato.
   */
  it("ignores the HTTP body's unsigned 'priority' for a Drop — the announced priority is always derived from the signed kind", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();

    const payload: DropPayload = { text: "tutto tranquillo", lat: 45.5, lon: 7.5, kind: "info", timestamp: Date.now() };
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    const contentId = computeContentId(bytes);
    const size = bytes.length;
    const signature = operator
      .sign(contentSigningPayload({ contentId, name: DROP_CONTENT_NAME, mimeType: "application/json", size, publisherId: operator.nodeId }))
      .toString("hex");
    const metadata: ContentMetadata = { contentId, name: DROP_CONTENT_NAME, mimeType: "application/json", size, createdAt: Date.now(), publisherId: operator.nodeId, signature };

    // priority: 0 = Priority.EMERGENCY in the (unsigned) request body, but the signed payload's kind is "info".
    const res = await authedFetch(webUi, { metadata, data: bytes.toString("base64"), priority: 0 });
    expect(res.status).toBe(200);

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (node.drops.list().length === 1) return resolve();
        if (Date.now() - start > 2000) return reject(new Error("timed out waiting for the drop to be recorded"));
        setTimeout(check, 15);
      };
      check();
    });
    expect(node.drops.list()[0].kind).toBe("info"); // never upgraded by the caller-supplied priority
  });

  it("allowRemoteContentIngest requires a networkPassword at construction time", () => {
    const node = new NomadNode({ displayName: "N" });
    nodes.push(node);
    expect(() => new WebUiServer(node, { port: 0, allowRemoteContentIngest: true })).toThrow(/allowRemoteContentIngest requires a networkPassword/);
  });
});
