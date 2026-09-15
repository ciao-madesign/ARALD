import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { WebUiServer } from "../../node/src/web-ui.js";
import { Identity } from "../../node/src/identity.js";
import { nodeAppendSigningPayload, type SignableNodeAppendFields } from "../../node/src/node-appends.js";

/**
 * `POST /api/ingest-node-append` (`node/src/web-ui.ts`) — "Pezzo 2" del
 * canale di comando Box↔specchio (docs/emergency-portal.md, docs/security.md
 * voce #82). Same dedicated-file convention as
 * `ingest-signed-content-web-ui.test.ts` (Pezzo 1). Gated behind
 * `allowRemoteNodeAppendIngest` + network password, independent from
 * `allowRemoteContentIngest`.
 */
describe("WebUiServer POST /api/ingest-node-append", () => {
  const TOKEN = "test-pairing-token-0123456789abcdef";
  const nodes: NomadNode[] = [];
  const webUis: WebUiServer[] = [];

  afterEach(async () => {
    await Promise.all(webUis.map((w) => w.stop()));
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
    webUis.length = 0;
  });

  function makeGateway(allowRemoteNodeAppendIngest = true): { node: NomadNode; webUi: WebUiServer } {
    const node = new NomadNode({ displayName: "Box" });
    const webUi = new WebUiServer(node, { port: 0, allowRemoteNodeAppendIngest, networkPassword: TOKEN });
    nodes.push(node);
    webUis.push(webUi);
    return { node, webUi };
  }

  function authedFetch(webUi: WebUiServer, body: unknown, token = TOKEN): Promise<Response> {
    return fetch(`http://127.0.0.1:${webUi.port}/api/ingest-node-append`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  function signedAppend(identity: Identity, node: NomadNode, overrides: Partial<SignableNodeAppendFields> = {}) {
    const fields: SignableNodeAppendFields = {
      text: "comunicazione dall'operatore",
      kind: "info",
      timestamp: Date.now(),
      expiresAt: Date.now() + 100000,
      targetNodeId: node.nodeId,
      publisherId: identity.nodeId,
      ...overrides,
    };
    const signature = identity.sign(nodeAppendSigningPayload(fields)).toString("hex");
    return { ...fields, signature };
  }

  it("404s when allowRemoteNodeAppendIngest is off, same posture as every other opt-in endpoint", async () => {
    const { node, webUi } = makeGateway(false);
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();

    const res = await authedFetch(webUi, signedAppend(operator, node));
    expect(res.status).toBe(404);
  });

  it("401s without a valid Authorization header, and ingests nothing", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();
    const submission = signedAppend(operator, node);

    const noAuth = await fetch(`http://127.0.0.1:${webUi.port}/api/ingest-node-append`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission),
    });
    expect(noAuth.status).toBe(401);

    const wrongPassword = await authedFetch(webUi, submission, "not-the-password");
    expect(wrongPassword.status).toBe(401);

    expect(node.nodeAppends.list()).toEqual([]);
  });

  it("accepts a validly signed submission from an identity that is NOT the Box's own", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();
    const submission = signedAppend(operator, node);

    const res = await authedFetch(webUi, submission);

    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(true);
    const recorded = node.nodeAppends.list();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].author).toBe(operator.nodeId);
    expect(recorded[0].author).not.toBe(node.nodeId);
  });

  it("responds 422 (never 200/500) for a submission whose signature doesn't verify — never trusts the caller", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();
    const submission = signedAppend(operator, node);

    const res = await authedFetch(webUi, { ...submission, text: "testo manomesso dopo la firma" });

    expect(res.status).toBe(422);
    expect(node.nodeAppends.list()).toEqual([]);
  });

  it("responds 422 for a submission signed for a different target node", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();
    const submission = signedAppend(operator, node, { targetNodeId: "some-other-box-id" });

    const res = await authedFetch(webUi, submission);

    expect(res.status).toBe(422);
  });

  it("rejects a request body that isn't even a JSON object with 400, never a crash", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);

    expect((await authedFetch(webUi, [])).status).toBe(400);
    expect((await authedFetch(webUi, "just a string")).status).toBe(400);
    expect((await authedFetch(webUi, 42)).status).toBe(400);
    expect((await authedFetch(webUi, null)).status).toBe(400);
  });

  it("a shape-malformed but object-shaped body 422s (rejected by ingestSignedNodeAppend, not 400) — the HTTP layer only checks 'is this an object'", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);

    const res = await authedFetch(webUi, { text: "manca tutto il resto" });
    expect(res.status).toBe(422);
  });

  it("a malformed JSON body is a 400", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/ingest-node-append`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("429s (not 422) once a single operator identity exceeds the per-identity packet budget", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();

    const statuses: number[] = [];
    for (let i = 0; i < 210; i++) {
      const submission = signedAppend(operator, node, { text: `nota ${i}` });
      const res = await authedFetch(webUi, submission);
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
    expect(statuses).not.toContain(500);
  });

  it("allowRemoteNodeAppendIngest requires a networkPassword at construction time", () => {
    const node = new NomadNode({ displayName: "N" });
    nodes.push(node);
    expect(() => new WebUiServer(node, { port: 0, allowRemoteNodeAppendIngest: true })).toThrow(/allowRemoteNodeAppendIngest requires a networkPassword/);
  });

  it("is independent from allowRemoteContentIngest — enabling one doesn't enable the other", async () => {
    const node = new NomadNode({ displayName: "Box" });
    const webUi = new WebUiServer(node, { port: 0, allowRemoteContentIngest: true, allowRemoteNodeAppendIngest: false, networkPassword: TOKEN });
    nodes.push(node);
    webUis.push(webUi);
    await Promise.all([node.start(), webUi.start()]);

    const operator = Identity.generate();
    const res = await authedFetch(webUi, signedAppend(operator, node));
    expect(res.status).toBe(404); // node-append ingest still off, even though content ingest is on
  });
});
