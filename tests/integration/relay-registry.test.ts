import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { WebUiServer } from "../../node/src/web-ui.js";
import type { Transport, PeerAddress, PacketHandler, PeerConnectedHandler, PeerDisconnectedHandler } from "../../node/src/transport.js";

/**
 * Minimal `Transport` stub that never actually connects anything — its
 * `fireConnected()`/`fireDisconnected()` let a test simulate exactly one
 * transport-level connect/disconnect event, without a real socket/medium.
 * Used below to prove `NomadNode` correctly reference-counts a peer
 * reachable via more than one transport at once (found by review).
 */
class FakeTransport implements Transport {
  readonly id: string;
  private connectedHandler: PeerConnectedHandler | undefined;
  private disconnectedHandler: PeerDisconnectedHandler | undefined;
  constructor(id: string) {
    this.id = id;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async connect(_address: PeerAddress): Promise<string> {
    throw new Error("FakeTransport.connect() is not used by these tests");
  }
  async send(): Promise<void> {}
  onPacket(_handler: PacketHandler): void {}
  onPeerConnected(handler: PeerConnectedHandler): void {
    this.connectedHandler = handler;
  }
  onPeerDisconnected(handler: PeerDisconnectedHandler): void {
    this.disconnectedHandler = handler;
  }
  fireConnected(peerId: string): void {
    this.connectedHandler?.(peerId, undefined);
  }
  fireDisconnected(peerId: string): void {
    this.disconnectedHandler?.(peerId);
  }
}

/**
 * The Relay Registry (`node/src/relay-registry.ts`, `docs/beacon.md` "Fixed
 * Relay e Registro dei relay"). Unit-level payload validation/eviction is
 * covered in `tests/unit/relay-registry.test.ts` — this file exercises the
 * real online/offline derivation from `NomadNode`'s own peer connectivity
 * (`addTransport()`'s `peer:connected`/`peer:disconnected` wiring), and the
 * HTTP read/write surface (`web-ui.ts`'s `GET`/`POST /api/relays`).
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

describe("RelayRegistry online/offline derivation from real mesh connectivity", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("marks a registered relay online on connect and offline on disconnect", async () => {
    const hub = makeNode("Hub");
    const relay = makeNode("Relay");
    nodes.push(hub.node, relay.node);
    await Promise.all([hub, relay].map(({ node }) => node.start()));

    hub.node.registerRelay({ relayId: relay.node.nodeId, type: "fixed", lat: 45, lon: 9 });
    expect(hub.node.relayRegistry.get(relay.node.nodeId)).toMatchObject({ online: false });

    await hub.node.connect({ host: "127.0.0.1", port: relay.transport.port });
    await waitFor(() => hub.node.relayRegistry.get(relay.node.nodeId)?.online === true);

    await relay.node.stop();
    nodes.splice(nodes.indexOf(relay.node), 1);
    await waitFor(() => hub.node.relayRegistry.get(relay.node.nodeId)?.online === false);
    expect(hub.node.relayRegistry.get(relay.node.nodeId)?.lastSeenAt).toBeDefined();
  });

  it("registerRelay() marks the relay online immediately if it's already a connected peer, without waiting for the next connect event", async () => {
    const hub = makeNode("Hub");
    const relay = makeNode("Relay");
    nodes.push(hub.node, relay.node);
    await Promise.all([hub, relay].map(({ node }) => node.start()));
    await hub.node.connect({ host: "127.0.0.1", port: relay.transport.port });
    await waitFor(() => hub.node.peers.has(relay.node.nodeId));

    const entry = hub.node.registerRelay({ relayId: relay.node.nodeId, type: "mobile", lat: 45, lon: 9 });
    expect(entry.online).toBe(true);
  });

  it("connecting/disconnecting an ordinary (non-relay) peer never touches the registry", async () => {
    const hub = makeNode("Hub");
    const other = makeNode("Other");
    nodes.push(hub.node, other.node);
    await Promise.all([hub, other].map(({ node }) => node.start()));

    await hub.node.connect({ host: "127.0.0.1", port: other.transport.port });
    await waitFor(() => hub.node.peers.has(other.node.nodeId));
    expect(hub.node.relayRegistry.list()).toEqual([]); // no-op, never registered
  });

  it("stays online while at least one of several transports connected to the same relay is still up, and only goes offline once the last one drops", async () => {
    // Regression: found by review — addTransport() previously called relayRegistry.markOffline()
    // unconditionally on any single transport's disconnect event, with no reference counting across
    // multiple transports connected to the same peer id (peers/peerTransport are last-write-wins).
    // A relay simultaneously reachable via two transports (e.g. TCP and a simulated radio,
    // tests/integration/mixed-transport.test.ts shows this is a real supported shape) would have been
    // wrongly marked offline the instant either single link dropped.
    const hub = makeNode("Hub");
    nodes.push(hub.node);
    await hub.node.start();
    const t1 = new FakeTransport("fake-1");
    const t2 = new FakeTransport("fake-2");
    hub.node.addTransport(t1);
    hub.node.addTransport(t2);

    hub.node.registerRelay({ relayId: "relay-x", type: "fixed", lat: 45, lon: 9 });
    t1.fireConnected("relay-x");
    t2.fireConnected("relay-x");
    expect(hub.node.relayRegistry.get("relay-x")?.online).toBe(true);

    t1.fireDisconnected("relay-x"); // one of two links drops
    expect(hub.node.relayRegistry.get("relay-x")?.online).toBe(true); // still reachable via t2

    t2.fireDisconnected("relay-x"); // the last remaining link drops
    expect(hub.node.relayRegistry.get("relay-x")?.online).toBe(false);
  });

  it("registerRelay() does not trust NomadNode.peers alone to decide a relay is already online — an unauthenticated PEER_LIST entry must not be enough", async () => {
    // Regression: found by review — handlePacket()'s PEER_LIST case calls peers.upsert() for every
    // entry an already-connected peer claims, unauthenticated (packet.source/payload entries are
    // never verified). Checking peers.has() here would let a peer merely *naming* a relay's real
    // nodeId in a PEER_LIST make registerRelay() mark it online with no real connection behind it —
    // and since no genuine peer:connected/peer:disconnected ever fires for it, nothing would ever
    // correct that back to offline. peerTransport (set only by real transport-level events) doesn't
    // have this hole.
    const hub = makeNode("Hub");
    nodes.push(hub.node);
    await hub.node.start();

    hub.node.peers.upsert("relay-x", undefined); // simulates what an unauthenticated PEER_LIST entry produces
    expect(hub.node.peers.has("relay-x")).toBe(true); // confirms the setup actually exercises the gap

    const entry = hub.node.registerRelay({ relayId: "relay-x", type: "fixed", lat: 45, lon: 9 });
    expect(entry.online).toBe(false);
    expect(hub.node.relayRegistry.get("relay-x")?.online).toBe(false);
  });
});

describe("WebUiServer relay registry endpoints", () => {
  const TOKEN = "K7XM-2QRT";
  let node: NomadNode | undefined;
  let webUi: WebUiServer | undefined;

  afterEach(async () => {
    if (webUi) await webUi.stop();
    if (node) await node.stop();
    node = undefined;
    webUi = undefined;
  });

  it("constructing with exposeRelayRegistry but no networkPassword throws immediately", () => {
    const n = new NomadNode({ displayName: "N" });
    expect(() => new WebUiServer(n, { port: 0, exposeRelayRegistry: true })).toThrow(/networkPassword/);
  });

  it("GET and POST /api/relays 404 when exposeRelayRegistry is off, even with allowServiceCalls/networkPassword set", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    await webUi.start();

    const getRes = await fetch(`http://127.0.0.1:${webUi.port}/api/relays`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(getRes.status).toBe(404);

    const postRes = await fetch(`http://127.0.0.1:${webUi.port}/api/relays`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ relayId: "r1", type: "fixed", lat: 45, lon: 9 }),
    });
    expect(postRes.status).toBe(404);
  });

  it("GET /api/relays requires the network password and lists registered relays", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, exposeRelayRegistry: true, networkPassword: TOKEN });
    await webUi.start();

    const noAuth = await fetch(`http://127.0.0.1:${webUi.port}/api/relays`);
    expect(noAuth.status).toBe(401);

    const empty = await fetch(`http://127.0.0.1:${webUi.port}/api/relays`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await empty.json()).toEqual([]);

    node.registerRelay({ relayId: "r1", type: "fixed", lat: 45.1, lon: 9.1 });
    const withOne = await fetch(`http://127.0.0.1:${webUi.port}/api/relays`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await withOne.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ relayId: "r1", type: "fixed", lat: 45.1, lon: 9.1, online: false });
  });

  it("POST /api/relays requires the network password", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, exposeRelayRegistry: true, networkPassword: TOKEN });
    await webUi.start();

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/relays`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relayId: "r1", type: "fixed", lat: 45, lon: 9 }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/relays rejects a malformed body with 400, without registering anything", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, exposeRelayRegistry: true, networkPassword: TOKEN });
    await webUi.start();

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/relays`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ relayId: "r1", type: "spaceship", lat: 45, lon: 9 }),
    });
    expect(res.status).toBe(400);
    expect(node.relayRegistry.list()).toEqual([]);
  });

  it("POST /api/relays end-to-end: registers a relay, then GET reflects it", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, exposeRelayRegistry: true, networkPassword: TOKEN });
    await webUi.start();

    const postRes = await fetch(`http://127.0.0.1:${webUi.port}/api/relays`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ relayId: "r1", type: "fixed", lat: 45.1, lon: 9.1, radio: { ble: true, lora: true }, operator: "Soccorso Alpino" }),
    });
    expect(postRes.status).toBe(200);
    const posted = await postRes.json();
    expect(posted).toMatchObject({ relayId: "r1", type: "fixed", radio: { ble: true, lora: true }, operator: "Soccorso Alpino" });

    const getRes = await fetch(`http://127.0.0.1:${webUi.port}/api/relays`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await getRes.json()).toEqual([posted]);
  });

  it("exposeRelayRegistry alone (allowServiceCalls off) still gets CORS headers on its endpoint", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, exposeRelayRegistry: true, networkPassword: TOKEN });
    await webUi.start();

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/relays`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await fetch(`http://127.0.0.1:${webUi.port}/api/relays`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
  });
});
