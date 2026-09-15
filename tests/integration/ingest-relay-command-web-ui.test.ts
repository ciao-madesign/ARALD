import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { WebUiServer } from "../../node/src/web-ui.js";
import { Identity } from "../../node/src/identity.js";
import { relayCommandSigningPayload, type SignableRelayCommandFields } from "../../node/src/relay-registry.js";

/**
 * `POST /api/ingest-relay-command` (`node/src/web-ui.ts`) — "Pezzo 4" del
 * canale di comando Box↔specchio (docs/emergency-portal.md, docs/security.md
 * voce #83). Same dedicated-file convention as
 * `ingest-node-append-web-ui.test.ts` (Pezzo 2). Gated behind
 * `allowRemoteRelayCommandIngest` + network password, independent dagli
 * altri due flag di ingest.
 */
describe("WebUiServer POST /api/ingest-relay-command", () => {
  const TOKEN = "test-pairing-token-0123456789abcdef";
  const nodes: NomadNode[] = [];
  const webUis: WebUiServer[] = [];

  afterEach(async () => {
    await Promise.all(webUis.map((w) => w.stop()));
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
    webUis.length = 0;
  });

  function makeGateway(allowRemoteRelayCommandIngest = true): { node: NomadNode; webUi: WebUiServer } {
    const node = new NomadNode({ displayName: "Box" });
    const webUi = new WebUiServer(node, { port: 0, allowRemoteRelayCommandIngest, networkPassword: TOKEN });
    nodes.push(node);
    webUis.push(webUi);
    return { node, webUi };
  }

  function authedFetch(webUi: WebUiServer, body: unknown, token = TOKEN): Promise<Response> {
    return fetch(`http://127.0.0.1:${webUi.port}/api/ingest-relay-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  function signedCommand(identity: Identity, node: NomadNode, overrides: Partial<SignableRelayCommandFields> = {}) {
    const fields: SignableRelayCommandFields = {
      command: "reboot",
      timestamp: Date.now(),
      targetNodeId: node.nodeId,
      publisherId: identity.nodeId,
      ...overrides,
    };
    const signature = identity.sign(relayCommandSigningPayload(fields)).toString("hex");
    return { ...fields, signature };
  }

  it("404s when allowRemoteRelayCommandIngest is off, same posture as every other opt-in endpoint", async () => {
    const { node, webUi } = makeGateway(false);
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();

    const res = await authedFetch(webUi, signedCommand(operator, node));
    expect(res.status).toBe(404);
  });

  it("401s without a valid Authorization header, and requests nothing", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();
    const submission = signedCommand(operator, node);
    const requested: string[] = [];
    node.on("relay:reboot-requested", (senderId: string) => requested.push(senderId));

    const noAuth = await fetch(`http://127.0.0.1:${webUi.port}/api/ingest-relay-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission),
    });
    expect(noAuth.status).toBe(401);

    const wrongPassword = await authedFetch(webUi, submission, "not-the-password");
    expect(wrongPassword.status).toBe(401);

    expect(requested).toEqual([]);
  });

  it("accepts a validly signed submission from an identity that is NOT the Box's own, and never checks its trust", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();
    const submission = signedCommand(operator, node);
    const requested: string[] = [];
    node.on("relay:reboot-requested", (senderId: string) => requested.push(senderId));

    const res = await authedFetch(webUi, submission);

    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(true);
    expect(requested).toEqual([operator.nodeId]);
  });

  it("responds 422 (never 200/500) for a submission whose signature doesn't verify — never trusts the caller", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();
    const submission = signedCommand(operator, node);

    const res = await authedFetch(webUi, { ...submission, timestamp: submission.timestamp + 1 });

    expect(res.status).toBe(422);
  });

  it("responds 422 for a submission signed for a different target node", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);
    const operator = Identity.generate();
    const submission = signedCommand(operator, node, { targetNodeId: "some-other-box-id" });

    const res = await authedFetch(webUi, submission);

    expect(res.status).toBe(422);
  });

  it("rejects a request body that isn't even a JSON object with 400, never a crash", async () => {
    const { webUi } = makeGateway();
    await Promise.all([nodes[0].start(), webUi.start()]);

    expect((await authedFetch(webUi, [])).status).toBe(400);
    expect((await authedFetch(webUi, "just a string")).status).toBe(400);
    expect((await authedFetch(webUi, 42)).status).toBe(400);
    expect((await authedFetch(webUi, null)).status).toBe(400);
  });

  it("a shape-malformed but object-shaped body 422s, not 400 — the HTTP layer only checks 'is this an object'", async () => {
    const { webUi } = makeGateway();
    await Promise.all([nodes[0].start(), webUi.start()]);

    const res = await authedFetch(webUi, { command: "reboot" });
    expect(res.status).toBe(422);
  });

  it("a malformed JSON body is a 400", async () => {
    const { webUi } = makeGateway();
    await Promise.all([nodes[0].start(), webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/ingest-relay-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("429s (not 422/500) once the node-wide relay-command budget is exhausted", async () => {
    const { node, webUi } = makeGateway();
    await Promise.all([node.start(), webUi.start()]);

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const operator = Identity.generate(); // a different identity each time
      const submission = signedCommand(operator, node);
      const res = await authedFetch(webUi, submission);
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
    expect(statuses).not.toContain(500);
  });

  it("allowRemoteRelayCommandIngest requires a networkPassword at construction time", () => {
    const node = new NomadNode({ displayName: "N" });
    nodes.push(node);
    expect(() => new WebUiServer(node, { port: 0, allowRemoteRelayCommandIngest: true })).toThrow(/allowRemoteRelayCommandIngest requires a networkPassword/);
  });

  it("is independent from the other two ingest flags — enabling one doesn't enable this one", async () => {
    const node = new NomadNode({ displayName: "Box" });
    const webUi = new WebUiServer(node, {
      port: 0,
      allowRemoteContentIngest: true,
      allowRemoteNodeAppendIngest: true,
      allowRemoteRelayCommandIngest: false,
      networkPassword: TOKEN,
    });
    nodes.push(node);
    webUis.push(webUi);
    await Promise.all([node.start(), webUi.start()]);

    const operator = Identity.generate();
    const res = await authedFetch(webUi, signedCommand(operator, node));
    expect(res.status).toBe(404); // relay-command ingest still off, even though the other two are on
  });
});
