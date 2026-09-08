import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { WebUiServer } from "../../node/src/web-ui.js";
import { TrustLevel } from "../../node/src/trust.js";

/**
 * `POST /api/relay-command` (`node/src/web-ui.ts`, "Fixed Relay e Registro
 * dei relay" — remote reboot). Same dedicated-file convention
 * `node-append-web-ui.test.ts` already uses for a `WebUiServer` write
 * endpoint. Gated the same way as `POST /api/relays`, on
 * `WebUiOptions.exposeRelayRegistry` + the node's own network password —
 * this is the *origin*-side authentication only; the target relay's own
 * `minTrustForRelayCommand` gate (default `TrustLevel.ADMIN`) is exercised
 * over the real network in `tests/integration/relay-telemetry-and-command.test.ts`,
 * not here.
 */
describe("WebUiServer POST /api/relay-command", () => {
  const TOKEN = "test-pairing-token-0123456789abcdef";
  const nodes: NomadNode[] = [];
  const webUis: WebUiServer[] = [];

  afterEach(async () => {
    await Promise.all(webUis.map((w) => w.stop()));
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
    webUis.length = 0;
  });

  function makeGateway(displayName: string, options: ConstructorParameters<typeof NomadNode>[0] = {}): { node: NomadNode; transport: TcpTransport; webUi: WebUiServer } {
    const node = new NomadNode({ displayName, ...options });
    const transport = new TcpTransport(node.nodeId, 0);
    node.addTransport(transport);
    const webUi = new WebUiServer(node, { port: 0, exposeRelayRegistry: true, networkPassword: TOKEN });
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

  it("404s when exposeRelayRegistry is off, same as GET/POST /api/relays", async () => {
    const node = new NomadNode({ displayName: "N" });
    const webUi = new WebUiServer(node, { port: 0 });
    nodes.push(node);
    webUis.push(webUi);
    await Promise.all([node.start(), webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/relay-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetNodeId: "some-node" }),
    });
    expect(res.status).toBe(404);
  });

  it("without a valid Authorization header is a 401", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const noAuth = await fetch(`http://127.0.0.1:${a.webUi.port}/api/relay-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetNodeId: "some-node" }),
    });
    expect(noAuth.status).toBe(401);

    const wrongPassword = await fetch(`http://127.0.0.1:${a.webUi.port}/api/relay-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-password" },
      body: JSON.stringify({ targetNodeId: "some-node" }),
    });
    expect(wrongPassword.status).toBe(401);
  });

  it("rejects a missing/empty targetNodeId, or a command other than 'reboot', with 400", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    async function post(body: unknown): Promise<number> {
      const res = await authedFetch(a.webUi, "/api/relay-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.status;
    }

    expect(await post({})).toBe(400); // missing targetNodeId
    expect(await post({ targetNodeId: "" })).toBe(400); // empty targetNodeId
    expect(await post({ targetNodeId: "node-x", command: "update-firmware" })).toBe(400); // not "reboot"
  });

  it("with a malformed JSON body is a 400", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const res = await authedFetch(a.webUi, "/api/relay-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("with an unknown target's encryption key is a 400 (client error, not a server failure)", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const res = await authedFetch(a.webUi, "/api/relay-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetNodeId: "never-connected-node-id" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/encryption key/);
  });

  it("end-to-end: sends a reboot command to a real connected target, defaulting command to 'reboot' when omitted, and the target's own ADMIN gate accepts it", async () => {
    const a = makeGateway("A");
    const b = makeGateway("B");
    await Promise.all([a.node.start(), a.webUi.start(), b.node.start(), b.webUi.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await Promise.all([a.node.waitForPeerKey(b.node.nodeId), b.node.waitForPeerKey(a.node.nodeId)]);
    b.node.trust.set(a.node.nodeId, TrustLevel.ADMIN); // the --trust-admin provisioning step

    const rebootRequested: string[] = [];
    b.node.on("relay:reboot-requested", (senderId: string) => rebootRequested.push(senderId));

    const res = await authedFetch(a.webUi, "/api/relay-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetNodeId: b.node.nodeId }), // command omitted
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });

    for (let i = 0; i < 50 && rebootRequested.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rebootRequested).toEqual([a.node.nodeId]);
  });

  it("returns 429 (not 400) once MAX_RELAY_COMMANDS_PER_WINDOW is exhausted — the origin's own rate limit, independent of the target's trust decision", async () => {
    const a = makeGateway("A");
    const b = makeGateway("B");
    await Promise.all([a.node.start(), a.webUi.start(), b.node.start(), b.webUi.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await Promise.all([a.node.waitForPeerKey(b.node.nodeId), b.node.waitForPeerKey(a.node.nodeId)]);
    // Deliberately never trust.set() to ADMIN on b — the origin's rate limit is exhausted before the
    // target ever gets a say, proving the two are independent gates.

    async function postCommand(): Promise<Response> {
      return authedFetch(a.webUi, "/api/relay-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetNodeId: b.node.nodeId }),
      });
    }

    // MAX_RELAY_COMMANDS_PER_WINDOW (node.ts) is 3 — not exported, hardcoded here, same convention
    // tests/integration/node-append-web-ui.test.ts's own burst test already uses.
    for (let i = 0; i < 3; i++) expect((await postCommand()).status).toBe(200);

    const limited = await postCommand();
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatch(/too many relay commands/);
  });

  it("GET /api/relays reflects telemetry fields once a registered relay reports them", async () => {
    const relay = new NomadNode({ displayName: "Relay", relayPolicy: { getResourceState: () => ({ batteryPercent: 88 }) } });
    const relayTransport = new TcpTransport(relay.nodeId, 0);
    relay.addTransport(relayTransport);
    nodes.push(relay);

    const a = makeGateway("A");
    a.node.registerAsRelayRegistry();
    await Promise.all([a.node.start(), a.webUi.start(), relay.start()]);
    a.node.registerRelay({ relayId: relay.nodeId, type: "fixed", lat: 45, lon: 9 });
    await relay.connect({ host: "127.0.0.1", port: a.transport.port });
    await Promise.all([relay.waitForPeerKey(a.node.nodeId), a.node.waitForPeerKey(relay.nodeId)]);

    await relay.reportRelayTelemetry();

    let entry: { batteryPercent?: number } | undefined;
    for (let i = 0; i < 50 && entry?.batteryPercent === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const res = await authedFetch(a.webUi, "/api/relays");
      const list = (await res.json()) as { relayId: string; batteryPercent?: number }[];
      entry = list.find((r) => r.relayId === relay.nodeId);
    }
    expect(entry?.batteryPercent).toBe(88);
  });
});
