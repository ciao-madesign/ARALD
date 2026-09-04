import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { WebUiServer } from "../../node/src/web-ui.js";

/**
 * GET/POST /api/node-append(s) (`node/src/web-ui.ts`, "Directed Content
 * Delivery + Node Append" — `docs/beacon.md`). Same dedicated-file
 * convention `drops-web-ui.test.ts`/`location-registry.test.ts` already use
 * for a `WebUiServer` feature. `GET /api/node-appends` (plural) is
 * unauthenticated and offered on every node like `GET /api/drops` — it
 * reads what landed on *this* node. `POST /api/node-append` (singular)
 * originates mesh traffic on behalf of the caller, gated behind the network
 * password like every other write this class exposes.
 */
describe("WebUiServer /api/node-append(s)", () => {
  const TOKEN = "test-pairing-token-0123456789abcdef";
  const nodes: NomadNode[] = [];
  const webUis: WebUiServer[] = [];

  afterEach(async () => {
    await Promise.all(webUis.map((w) => w.stop()));
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
    webUis.length = 0;
  });

  function makeGateway(displayName: string): { node: NomadNode; transport: TcpTransport; webUi: WebUiServer } {
    const node = new NomadNode({ displayName });
    const transport = new TcpTransport(node.nodeId, 0);
    node.addTransport(transport);
    const webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    nodes.push(node);
    webUis.push(webUi);
    return { node, transport, webUi };
  }

  function authedFetch(webUi: WebUiServer, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${webUi.port}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${TOKEN}` },
    });
  }

  it("GET /api/node-appends needs no auth at all, even when allowServiceCalls/networkPassword are set", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${a.webUi.port}/api/node-appends`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("GET /api/node-appends stays reachable (200) even when allowServiceCalls is off, unlike POST", async () => {
    const node = new NomadNode({ displayName: "N" });
    const webUi = new WebUiServer(node, { port: 0 });
    nodes.push(node);
    webUis.push(webUi);
    await Promise.all([node.start(), webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/node-appends`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("POST /api/node-append 404s when allowServiceCalls is off, same as every other write endpoint", async () => {
    const node = new NomadNode({ displayName: "N" });
    const webUi = new WebUiServer(node, { port: 0 });
    nodes.push(node);
    webUis.push(webUi);
    await Promise.all([node.start(), webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/node-append`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetNodeId: "some-node", text: "ciao" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/node-append without a valid Authorization header is a 401", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const noAuth = await fetch(`http://127.0.0.1:${a.webUi.port}/api/node-append`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetNodeId: "some-node", text: "ciao" }),
    });
    expect(noAuth.status).toBe(401);

    const wrongPassword = await fetch(`http://127.0.0.1:${a.webUi.port}/api/node-append`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-password" },
      body: JSON.stringify({ targetNodeId: "some-node", text: "ciao" }),
    });
    expect(wrongPassword.status).toBe(401);
  });

  it("POST /api/node-append rejects a missing/empty targetNodeId, missing/empty text, non-string label, invalid kind, or non-number expiresInMs with 400", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    async function post(body: unknown): Promise<number> {
      const res = await authedFetch(a.webUi, "/api/node-append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.status;
    }

    expect(await post({ text: "ciao" })).toBe(400); // missing targetNodeId
    expect(await post({ targetNodeId: "", text: "ciao" })).toBe(400); // empty targetNodeId
    expect(await post({ targetNodeId: "node-x" })).toBe(400); // missing text
    expect(await post({ targetNodeId: "node-x", text: "" })).toBe(400); // empty text
    expect(await post({ targetNodeId: "node-x", text: "ciao", label: 123 })).toBe(400); // non-string label
    expect(await post({ targetNodeId: "node-x", text: "ciao", kind: "urgent" })).toBe(400); // invalid kind
    expect(await post({ targetNodeId: "node-x", text: "ciao", expiresInMs: "1000" })).toBe(400); // non-number expiresInMs
  });

  it("POST /api/node-append with a malformed JSON body is a 400", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const res = await authedFetch(a.webUi, "/api/node-append", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/node-append with an unknown target's encryption key is a 400 (client error, not a server failure)", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const res = await authedFetch(a.webUi, "/api/node-append", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetNodeId: "never-connected-node-id", text: "ciao" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/encryption key/);
  });

  it("POST /api/node-append end-to-end: delivers to a real connected target, defaulting kind to 'info'", async () => {
    const a = makeGateway("A");
    const b = makeGateway("B");
    await Promise.all([a.node.start(), a.webUi.start(), b.node.start(), b.webUi.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await Promise.all([a.node.waitForPeerKey(b.node.nodeId), b.node.waitForPeerKey(a.node.nodeId)]);

    const res = await authedFetch(a.webUi, "/api/node-append", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetNodeId: b.node.nodeId, text: "Sentiero 4 chiuso per frana.", label: "Info" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });

    let landed: unknown;
    for (let i = 0; i < 50 && !landed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const list = b.node.nodeAppends.list();
      if (list.length > 0) landed = list[0];
    }
    expect(landed).toMatchObject({ text: "Sentiero 4 chiuso per frana.", label: "Info", kind: "info", author: a.node.nodeId });
  });

  it("POST /api/node-append returns 429 (not 400) once the elevated rate limit is exhausted", async () => {
    const a = makeGateway("A");
    const b = makeGateway("B");
    await Promise.all([a.node.start(), a.webUi.start(), b.node.start(), b.webUi.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await Promise.all([a.node.waitForPeerKey(b.node.nodeId), b.node.waitForPeerKey(a.node.nodeId)]);

    async function postElevated(): Promise<Response> {
      return authedFetch(a.webUi, "/api/node-append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetNodeId: b.node.nodeId, text: "emergenza", kind: "emergency" }),
      });
    }

    // MAX_ELEVATED_NODE_APPENDS_PER_WINDOW (node.ts) is 3 — not exported, so hardcoded here, same
    // convention tests/integration/drops-web-ui.test.ts's own burst test already uses.
    for (let i = 0; i < 3; i++) expect((await postElevated()).status).toBe(200);

    const limited = await postElevated();
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatch(/too many high-priority node appends/);
  });
});
