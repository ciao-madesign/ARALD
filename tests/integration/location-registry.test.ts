import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { WebUiServer } from "../../node/src/web-ui.js";
import { Identity } from "../../node/src/identity.js";

/**
 * Opportunistic location sharing (`NomadNode.shareLocation()`/
 * `registerAsLocationRegistry()`/`considerLocationReport()`, `node/src/location-registry.ts`,
 * docs/next-steps.md Opzione J). Unit-level payload validation/eviction is
 * covered in `tests/unit/location-registry.test.ts` — this file exercises
 * the real network path (discovery + `PRIVATE_MESSAGE` delivery) and the
 * HTTP read/write surface (`web-ui.ts`'s `GET /api/location-registry` /
 * `POST /api/location-report`).
 *
 * No dedicated case is added to `malformed-packet-robustness.test.ts`: a
 * `location-report`-shaped `PRIVATE_MESSAGE` payload goes through the exact
 * same decrypt-then-dispatch path as an ordinary chat message or a group
 * invite, already exercised there with garbage payloads (`PRIVATE_MESSAGE`
 * with no fields / a null `senderAnnouncement`) — `extractLocationReport()`'s
 * own defensive parsing is exhaustively covered at the unit level instead.
 */

function makeNode(displayName: string): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 15): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("Location sharing (shareLocation / registerAsLocationRegistry)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("shares a position with a discovered registry two hops away, and a second share overwrites rather than accumulates", async () => {
    const registry = makeNode("Registry");
    const relay = makeNode("Relay");
    const sender = makeNode("Sender"); // 2 hops from the registry, via relay
    nodes.push(registry.node, relay.node, sender.node);
    await Promise.all([registry, relay, sender].map(({ node }) => node.start()));

    // Same connection ordering as group-chat.test.ts: relay<->registry first (so relay already knows
    // the registry's key by the time it answers sender's own IDENTITY_REQUEST), then sender<->relay.
    await relay.node.connect({ host: "127.0.0.1", port: registry.transport.port });
    await Promise.all([relay.node.waitForPeerKey(registry.node.nodeId), registry.node.waitForPeerKey(relay.node.nodeId)]);
    await sender.node.connect({ host: "127.0.0.1", port: relay.transport.port });
    await Promise.all([sender.node.waitForPeerKey(relay.node.nodeId), relay.node.waitForPeerKey(sender.node.nodeId)]);
    await sender.node.waitForPeerKey(registry.node.nodeId); // learned transitively via relay's IDENTITY_RESPONSE

    registry.node.registerAsLocationRegistry();
    await waitFor(() => sender.node.services.providersFor("service://location-registry").length > 0);

    await sender.node.shareLocation({ lat: 45.5, lon: 9.2, accuracy: 15 });
    await waitFor(() => registry.node.locationRegistry.get(sender.node.nodeId) !== undefined);

    const first = registry.node.locationRegistry.get(sender.node.nodeId);
    expect(first).toMatchObject({ reporterId: sender.node.nodeId, lat: 45.5, lon: 9.2, accuracy: 15 });
    expect(registry.node.locationRegistry.list()).toHaveLength(1);

    const firstTimestamp = first!.timestamp;
    await sender.node.shareLocation({ lat: 46.0, lon: 10.0 }); // no accuracy this time
    await waitFor(() => registry.node.locationRegistry.get(sender.node.nodeId)?.lat === 46.0);

    const second = registry.node.locationRegistry.get(sender.node.nodeId);
    expect(second).toMatchObject({ reporterId: sender.node.nodeId, lat: 46.0, lon: 10.0, accuracy: undefined });
    expect(second!.timestamp).toBeGreaterThanOrEqual(firstTimestamp);
    expect(registry.node.locationRegistry.list()).toHaveLength(1); // still one entry, not two
  });

  it("shareLocation() rejects out-of-range lat/lon/accuracy locally, without discovering or sending anything", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();

    await expect(a.node.shareLocation({ lat: 91, lon: 0 })).rejects.toThrow(/'lat' must be/);
    await expect(a.node.shareLocation({ lat: 0, lon: 181 })).rejects.toThrow(/'lon' must be/);
    await expect(a.node.shareLocation({ lat: 0, lon: 0, accuracy: -1 })).rejects.toThrow(/'accuracy' must be/);
    await expect(a.node.shareLocation({ lat: Number.NaN, lon: 0 })).rejects.toThrow(/'lat' must be/);
  });

  it("shareLocation() rejects when no registry can be discovered within the timeout", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();

    await expect(a.node.shareLocation({ lat: 45, lon: 9 }, { timeoutMs: 150 })).rejects.toThrow(/no provider found/);
  });

  it("registerAsLocationRegistry()'s own service handler rejects a direct callService() instead of doing nothing silently", async () => {
    const registry = makeNode("Registry");
    nodes.push(registry.node);
    await registry.node.start();
    registry.node.registerAsLocationRegistry();

    await expect(registry.node.callService("service://location-registry", {})).rejects.toThrow(/discovery-only/);
  });

  it("a report addressed to a node that never registered as a location registry is still received and stored — write access has no separate gate", async () => {
    // By design (location-registry.ts's doc comment): any node can passively receive/store a report,
    // since handlePrivateMessage() only ever decrypts messages actually addressed to it — the real
    // access-control boundary is entirely on the read side, not here.
    const ordinary = makeNode("Ordinary"); // never calls registerAsLocationRegistry()
    const sender = makeNode("Sender");
    nodes.push(ordinary.node, sender.node);
    await Promise.all([ordinary, sender].map(({ node }) => node.start()));
    await sender.node.connect({ host: "127.0.0.1", port: ordinary.transport.port });
    await Promise.all([sender.node.waitForPeerKey(ordinary.node.nodeId), ordinary.node.waitForPeerKey(sender.node.nodeId)]);

    sender.node.sendPrivateMessage(ordinary.node.nodeId, { type: "location-report", lat: 45, lon: 9, timestamp: Date.now() });
    await waitFor(() => ordinary.node.locationRegistry.get(sender.node.nodeId) !== undefined);
    expect(ordinary.node.locationRegistry.get(sender.node.nodeId)).toMatchObject({ lat: 45, lon: 9 });
  });

  it("a malformed location-report payload is dropped defensively, never crashes and never gets recorded", async () => {
    const registry = makeNode("Registry");
    const sender = makeNode("Sender");
    nodes.push(registry.node, sender.node);
    await Promise.all([registry, sender].map(({ node }) => node.start()));
    await sender.node.connect({ host: "127.0.0.1", port: registry.transport.port });
    await Promise.all([sender.node.waitForPeerKey(registry.node.nodeId), registry.node.waitForPeerKey(sender.node.nodeId)]);

    sender.node.sendPrivateMessage(registry.node.nodeId, { type: "location-report", lat: 999, lon: 9, timestamp: Date.now() });
    // Prove the connection/node is still alive and processed the bad message, rather than the
    // absence just being "hasn't arrived yet" — a genuinely valid report right after it.
    sender.node.sendPrivateMessage(registry.node.nodeId, { type: "location-report", lat: 1, lon: 1, timestamp: Date.now() });
    await waitFor(() => registry.node.locationRegistry.get(sender.node.nodeId)?.lat === 1);

    expect(registry.node.locationRegistry.get(sender.node.nodeId)).toMatchObject({ lat: 1, lon: 1 });
  });
});

describe("WebUiServer location-registry endpoints", () => {
  const TOKEN = "K7XM-2QRT";
  let registryNode: NomadNode | undefined;
  let senderNode: NomadNode | undefined;
  let webUi: WebUiServer | undefined;
  let senderWebUi: WebUiServer | undefined;

  afterEach(async () => {
    if (webUi) await webUi.stop();
    if (senderWebUi) await senderWebUi.stop();
    if (registryNode) await registryNode.stop();
    if (senderNode) await senderNode.stop();
    registryNode = undefined;
    senderNode = undefined;
    webUi = undefined;
    senderWebUi = undefined;
  });

  it("constructing with exposeLocationRegistry but no networkPassword throws immediately", () => {
    const node = new NomadNode({ displayName: "N" });
    expect(() => new WebUiServer(node, { port: 0, exposeLocationRegistry: true })).toThrow(/networkPassword/);
  });

  it("GET /api/location-registry 404s when exposeLocationRegistry is off, even with allowServiceCalls/networkPassword set", async () => {
    registryNode = new NomadNode({ displayName: "R" });
    webUi = new WebUiServer(registryNode, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    await webUi.start();

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/location-registry`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("GET /api/location-registry requires the network password (works independently of allowServiceCalls) and lists known reports", async () => {
    registryNode = new NomadNode({ displayName: "R" });
    webUi = new WebUiServer(registryNode, { port: 0, exposeLocationRegistry: true, networkPassword: TOKEN });
    await webUi.start();

    const noAuth = await fetch(`http://127.0.0.1:${webUi.port}/api/location-registry`);
    expect(noAuth.status).toBe(401);

    const empty = await fetch(`http://127.0.0.1:${webUi.port}/api/location-registry`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await empty.json()).toEqual([]);

    const reporterId = Identity.generate().nodeId;
    registryNode.locationRegistry.record(reporterId, { type: "location-report", lat: 45.1, lon: 9.1, timestamp: 12345 });
    const withOne = await fetch(`http://127.0.0.1:${webUi.port}/api/location-registry`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await withOne.json()).toEqual([{ reporterId, lat: 45.1, lon: 9.1, accuracy: undefined, timestamp: 12345 }]);
  });

  it("exposeLocationRegistry alone (allowServiceCalls off) still gets CORS headers on its endpoint", async () => {
    registryNode = new NomadNode({ displayName: "R" });
    webUi = new WebUiServer(registryNode, { port: 0, exposeLocationRegistry: true, networkPassword: TOKEN });
    await webUi.start();

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/location-registry`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await fetch(`http://127.0.0.1:${webUi.port}/api/location-registry`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
  });

  it("POST /api/location-report 404s when allowServiceCalls is off", async () => {
    senderNode = new NomadNode({ displayName: "S" });
    senderWebUi = new WebUiServer(senderNode, { port: 0 });
    await senderWebUi.start();

    const res = await fetch(`http://127.0.0.1:${senderWebUi.port}/api/location-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: 45, lon: 9 }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/location-report validates lat/lon shape before ever calling shareLocation()", async () => {
    senderNode = new NomadNode({ displayName: "S" });
    senderWebUi = new WebUiServer(senderNode, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    await senderWebUi.start();

    const res = await fetch(`http://127.0.0.1:${senderWebUi.port}/api/location-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ lat: "not-a-number", lon: 9 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/location-report end-to-end: shares this node's position with a discovered registry, ignoring any client-supplied timestamp", async () => {
    registryNode = new NomadNode({ displayName: "R" });
    const registryTransport = new TcpTransport(registryNode.nodeId, 0);
    registryNode.addTransport(registryTransport);
    await registryNode.start();

    senderNode = new NomadNode({ displayName: "S" });
    const senderTransport = new TcpTransport(senderNode.nodeId, 0);
    senderNode.addTransport(senderTransport);
    await senderNode.start();
    await senderNode.connect({ host: "127.0.0.1", port: registryTransport.port });
    await Promise.all([senderNode.waitForPeerKey(registryNode.nodeId), registryNode.waitForPeerKey(senderNode.nodeId)]);
    // Registered only after the connection already exists — proves shareLocation() finds it via
    // discoverService()'s SERVICE_ANNOUNCE flood (see the other end-to-end test above for the
    // SERVICE_QUERY fallback path instead, exercised by never pre-announcing at all).
    registryNode.registerAsLocationRegistry();
    await waitFor(() => senderNode!.services.providersFor("service://location-registry").length > 0);

    senderWebUi = new WebUiServer(senderNode, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    await senderWebUi.start();

    const before = Date.now();
    const res = await fetch(`http://127.0.0.1:${senderWebUi.port}/api/location-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ lat: 45.4642, lon: 9.19, accuracy: 20, timestamp: 1 }), // forged low timestamp — must be ignored
    });
    expect(res.status).toBe(200);

    await waitFor(() => registryNode!.locationRegistry.get(senderNode!.nodeId) !== undefined);
    const stored = registryNode.locationRegistry.get(senderNode.nodeId)!;
    expect(stored).toMatchObject({ lat: 45.4642, lon: 9.19, accuracy: 20 });
    expect(stored.timestamp).toBeGreaterThanOrEqual(before); // server-stamped, not the forged "1"
  });
});
