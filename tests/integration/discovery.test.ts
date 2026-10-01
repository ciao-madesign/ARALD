import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { WebUiServer } from "../../node/src/web-ui.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { DiscoveryService } from "../../discovery-service/server.js";
import { postDiscoveryRegistration, signDiscoveryRegistration } from "../../node/src/discovery-client.js";

/**
 * "Internet come trasporto opzionale tra nodi mesh lontani" (`docs/next-steps.md`) — esercita
 * `NomadNode.registerWithDiscoveryService()`/`connectToDiscoveredPeer()`/`getDiscoveryDirectory()`
 * contro un `DiscoveryService` reale, e gli endpoint `web-ui.ts` che li espongono al telefono.
 * `tests/unit/discovery-client.test.ts` copre la firma/verifica pura; `tests/integration/discovery-service.test.ts`
 * copre il server HTTP del servizio in isolamento — questo file copre l'integrazione end-to-end.
 */
describe("Internet come trasporto opzionale — NomadNode + DiscoveryService", () => {
  const TOKEN = "K7XM-2QRT";
  let discovery: DiscoveryService | undefined;
  let nodeA: NomadNode | undefined;
  let nodeB: NomadNode | undefined;
  let webUiB: WebUiServer | undefined;

  afterEach(async () => {
    if (webUiB) await webUiB.stop();
    if (nodeB) await nodeB.stop();
    if (nodeA) await nodeA.stop();
    if (discovery) await discovery.stop();
    discovery = undefined;
    nodeA = undefined;
    nodeB = undefined;
    webUiB = undefined;
  });

  it("registerWithDiscoveryService() è un no-op silenzioso se non configurato", async () => {
    nodeA = new NomadNode({ displayName: "A" });
    await expect(nodeA.registerWithDiscoveryService()).resolves.toBeUndefined();
  });

  it("connectToDiscoveredPeer() lancia se nessun servizio di discovery è configurato", async () => {
    nodeA = new NomadNode({ displayName: "A" });
    await expect(nodeA.connectToDiscoveredPeer("qualunque")).rejects.toThrow(/no discovery service configured/);
  });

  it("registerWithDiscoveryService() pubblica un indirizzo reale, cercabile via connectToDiscoveredPeer() da un altro nodo", async () => {
    discovery = new DiscoveryService({ port: 0 });
    await discovery.start();
    const discoveryServiceUrl = `http://127.0.0.1:${discovery.port}`;

    // nodeA si registra con un indirizzo dichiarato — qui corrisponde davvero al proprio TcpTransport,
    // così la successiva connessione reale di nodeB possa effettivamente riuscire.
    nodeA = new NomadNode({ displayName: "A" });
    const transportA = new TcpTransport(nodeA.nodeId, 0);
    nodeA.addTransport(transportA);
    await nodeA.start();
    await postDiscoveryRegistration(discoveryServiceUrl, signDiscoveryRegistration(nodeA.identity, `127.0.0.1:${transportA.port}`, undefined, Date.now()));

    nodeB = new NomadNode({ displayName: "B", discoveryServiceUrl });
    const transportB = new TcpTransport(nodeB.nodeId, 0);
    nodeB.addTransport(transportB);
    await nodeB.start();

    const peerId = await nodeB.connectToDiscoveredPeer(nodeA.nodeId);
    expect(peerId).toBe(nodeA.nodeId);
    expect(nodeB.peers.has(nodeA.nodeId)).toBe(true);
  });

  it("connectToDiscoveredPeer() lancia se il servizio non conosce il nodeId richiesto", async () => {
    discovery = new DiscoveryService({ port: 0 });
    await discovery.start();
    nodeB = new NomadNode({ displayName: "B", discoveryServiceUrl: `http://127.0.0.1:${discovery.port}` });
    await expect(nodeB.connectToDiscoveredPeer("mai-registrato")).rejects.toThrow(/does not know nodeId/);
  });

  it("getDiscoveryDirectory() restituisce [] se nessun servizio è configurato", async () => {
    nodeB = new NomadNode({ displayName: "B" });
    expect(await nodeB.getDiscoveryDirectory()).toEqual([]);
  });

  it("getDiscoveryDirectory() legge davvero la rubrica pubblica dal servizio configurato", async () => {
    discovery = new DiscoveryService({ port: 0 });
    await discovery.start();
    const discoveryServiceUrl = `http://127.0.0.1:${discovery.port}`;

    nodeA = new NomadNode({ displayName: "A", discoveryServiceUrl, discoveryPublicAddress: "203.0.113.5:9000", discoveryPublicLabel: "Rifugio Test" });
    await nodeA.registerWithDiscoveryService();

    nodeB = new NomadNode({ displayName: "B", discoveryServiceUrl });
    const directory = await nodeB.getDiscoveryDirectory();
    expect(directory).toEqual([{ nodeId: nodeA.nodeId, label: "Rifugio Test", verified: false }]);
  });

  describe("web-ui.ts: GET /api/discovery-directory, POST /api/discover-peer", () => {
    it("GET /api/discovery-directory restituisce [] quando il gateway non ha un servizio di discovery configurato", async () => {
      nodeB = new NomadNode({ displayName: "B" });
      webUiB = new WebUiServer(nodeB, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
      await webUiB.start();

      const res = await fetch(`http://127.0.0.1:${webUiB.port}/api/discovery-directory`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("GET /api/discovery-directory inoltra la rubrica reale del servizio configurato, senza richiedere la password di rete (sempre pubblico)", async () => {
      discovery = new DiscoveryService({ port: 0 });
      await discovery.start();
      const discoveryServiceUrl = `http://127.0.0.1:${discovery.port}`;
      nodeA = new NomadNode({ displayName: "A", discoveryServiceUrl, discoveryPublicAddress: "203.0.113.5:9000", discoveryPublicLabel: "Rifugio Test" });
      await nodeA.registerWithDiscoveryService();

      nodeB = new NomadNode({ displayName: "B", discoveryServiceUrl });
      webUiB = new WebUiServer(nodeB, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
      await webUiB.start();

      const res = await fetch(`http://127.0.0.1:${webUiB.port}/api/discovery-directory`); // nessun header Authorization
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ nodeId: nodeA.nodeId, label: "Rifugio Test", verified: false }]);
    });

    it("GET /api/discovery-directory risponde 502 se il servizio configurato è irraggiungibile", async () => {
      nodeB = new NomadNode({ displayName: "B", discoveryServiceUrl: "http://127.0.0.1:1" }); // porta privilegiata, nessun server in ascolto
      webUiB = new WebUiServer(nodeB, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
      await webUiB.start();

      const res = await fetch(`http://127.0.0.1:${webUiB.port}/api/discovery-directory`);
      expect(res.status).toBe(502);
    });

    it("POST /api/discover-peer 404 quando allowServiceCalls è spento, anche con un servizio di discovery configurato", async () => {
      discovery = new DiscoveryService({ port: 0 });
      await discovery.start();
      nodeB = new NomadNode({ displayName: "B", discoveryServiceUrl: `http://127.0.0.1:${discovery.port}` });
      webUiB = new WebUiServer(nodeB, { port: 0, networkPassword: TOKEN });
      await webUiB.start();

      const res = await fetch(`http://127.0.0.1:${webUiB.port}/api/discover-peer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ nodeId: "x" }),
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/discover-peer richiede la password di rete", async () => {
      discovery = new DiscoveryService({ port: 0 });
      await discovery.start();
      nodeB = new NomadNode({ displayName: "B", discoveryServiceUrl: `http://127.0.0.1:${discovery.port}` });
      webUiB = new WebUiServer(nodeB, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
      await webUiB.start();

      const res = await fetch(`http://127.0.0.1:${webUiB.port}/api/discover-peer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: "x" }),
      });
      expect(res.status).toBe(401);
    });

    it("POST /api/discover-peer rifiuta un body senza 'nodeId'", async () => {
      nodeB = new NomadNode({ displayName: "B" });
      webUiB = new WebUiServer(nodeB, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
      await webUiB.start();

      const res = await fetch(`http://127.0.0.1:${webUiB.port}/api/discover-peer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("POST /api/discover-peer risponde 404 se il gateway non ha un servizio di discovery configurato", async () => {
      nodeB = new NomadNode({ displayName: "B" });
      webUiB = new WebUiServer(nodeB, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
      await webUiB.start();

      const res = await fetch(`http://127.0.0.1:${webUiB.port}/api/discover-peer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ nodeId: "x" }),
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/discover-peer risolve e si connette davvero a un peer registrato, end-to-end", async () => {
      discovery = new DiscoveryService({ port: 0 });
      await discovery.start();
      const discoveryServiceUrl = `http://127.0.0.1:${discovery.port}`;

      nodeA = new NomadNode({ displayName: "A" });
      const transportA = new TcpTransport(nodeA.nodeId, 0);
      nodeA.addTransport(transportA);
      await nodeA.start();
      await postDiscoveryRegistration(discoveryServiceUrl, signDiscoveryRegistration(nodeA.identity, `127.0.0.1:${transportA.port}`, undefined, Date.now()));

      nodeB = new NomadNode({ displayName: "B", discoveryServiceUrl });
      const transportB = new TcpTransport(nodeB.nodeId, 0);
      nodeB.addTransport(transportB);
      await nodeB.start();
      webUiB = new WebUiServer(nodeB, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
      await webUiB.start();

      const res = await fetch(`http://127.0.0.1:${webUiB.port}/api/discover-peer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ nodeId: nodeA.nodeId }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ peerId: nodeA.nodeId });
      expect(nodeB.peers.has(nodeA.nodeId)).toBe(true);
    });
  });
});
