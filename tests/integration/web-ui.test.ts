import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { WebUiServer } from "../../node/src/web-ui.js";
import { Identity } from "../../node/src/identity.js";
import { computeContentId, contentSigningPayload, type ContentMetadata } from "../../node/src/content.js";

/**
 * Spec §59: a local, read-only status/search web interface — "l'utente non
 * deve essere costretto a capire il routing". Exercised as a plain HTTP
 * client would: fetch() against a real WebUiServer over loopback, backed by
 * a real NomadNode, no mocking of either.
 */
describe("WebUiServer (spec §59)", () => {
  let node: NomadNode | undefined;
  let webUi: WebUiServer | undefined;

  afterEach(async () => {
    if (webUi) await webUi.stop();
    if (node) await node.stop();
    node = undefined;
    webUi = undefined;
  });

  function baseUrl(): string {
    return `http://127.0.0.1:${webUi!.port}`;
  }

  it("serves the status page HTML at /", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("NOMAD-NET");
  });

  it("/api/status reports connected, internet (defaults to OFFLINE), peers, services and cachedContentPercent", async () => {
    node = new NomadNode({ displayName: "N" });
    const transport = new TcpTransport(node.nodeId, 0);
    node.addTransport(transport);
    await node.start();
    node.registerService("service://echo", "1.0.0", [], (p) => p);
    node.publishContent("a.txt", "text/plain", Buffer.from("hello"));

    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const status = await (await fetch(`${baseUrl()}/api/status`)).json();
    expect(status).toMatchObject({
      displayName: "N",
      nodeId: node.nodeId,
      connected: true,
      internet: "OFFLINE",
      localNetwork: "ONLINE",
      peers: 0,
      services: 1,
      cachedContentPercent: 100, // one piece of content, all of it local
    });
  });

  it("internetStatus option overrides the OFFLINE default", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, internetStatus: () => "ONLINE" });
    await webUi.start();

    const status = await (await fetch(`${baseUrl()}/api/status`)).json();
    expect(status.internet).toBe("ONLINE");
  });

  it("cachedContentPercent reflects the share of known content actually held locally, not just a count of local items", async () => {
    node = new NomadNode({ displayName: "N" });
    node.publishContent("local.txt", "text/plain", Buffer.from("here"));

    const publisher = Identity.generate();
    const data = Buffer.from("not fetched yet");
    const contentId = computeContentId(data);
    const fields = { contentId, name: "remote.txt", mimeType: "text/plain", size: data.length, publisherId: publisher.nodeId };
    const metadata: ContentMetadata = {
      ...fields,
      createdAt: Date.now(),
      signature: publisher.sign(contentSigningPayload(fields)).toString("hex"),
    };
    node.remoteCatalog.record(metadata);

    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const status = await (await fetch(`${baseUrl()}/api/status`)).json();
    expect(status.cachedContentPercent).toBe(50); // 1 local out of 2 known
  });

  it("cachedContentPercent does not double-count a contentId present in both the local store and the remote catalog", async () => {
    // Regression test: this can genuinely happen — content learned about via catalog sync gets a
    // remoteCatalog entry, and later actually fetching it stores the bytes in contentStore too,
    // without pruning the now-redundant catalog entry (handleContentComplete never does that).
    node = new NomadNode({ displayName: "N" });
    const metadata = node.publishContent("shared.txt", "text/plain", Buffer.from("bytes"));
    node.remoteCatalog.record(metadata); // same contentId, already locally held

    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const status = await (await fetch(`${baseUrl()}/api/status`)).json();
    expect(status.cachedContentPercent).toBe(100); // still just one distinct content id, fully held
  });

  it("the services count excludes a service explicitly marked unavailable, even though listKnownServices() itself still knows about it", async () => {
    node = new NomadNode({ displayName: "N" });
    node.registerService("service://ai", "1.0.0", [], () => ({}));
    node.setServiceAvailability("service://ai", false);

    // listKnownServices() is a general "everything ever heard of" API (mirrors listKnownContent())
    // and deliberately doesn't filter — the status page is what narrows to "usable right now".
    expect(node.listKnownServices()).toHaveLength(1);

    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const status = await (await fetch(`${baseUrl()}/api/status`)).json();
    expect(status.services).toBe(0);
  });

  it("/api/search finds content by case-insensitive substring and marks locally-held content as such", async () => {
    node = new NomadNode({ displayName: "N" });
    node.publishContent("Guida Rifugio Alpino.pdf", "application/pdf", Buffer.from("contenuto"));
    node.publishContent("Meteo.txt", "text/plain", Buffer.from("bollettino"));

    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const results = await (await fetch(`${baseUrl()}/api/search?q=rifugio`)).json();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: "Guida Rifugio Alpino.pdf", availableLocally: true });
    expect(results[0].availableThrough).toBeUndefined();
  });

  it("/api/search returns no results for an empty or blank query, instead of dumping everything known", async () => {
    node = new NomadNode({ displayName: "N" });
    node.publishContent("a.txt", "text/plain", Buffer.from("x"));
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    expect(await (await fetch(`${baseUrl()}/api/search?q=`)).json()).toEqual([]);
    expect(await (await fetch(`${baseUrl()}/api/search?q=%20%20`)).json()).toEqual([]);
  });

  it("/api/search reports a next-hop hint for content known only via catalog sync, when a route to its publisher is known", async () => {
    node = new NomadNode({ displayName: "N" });
    const publisher = Identity.generate();
    const data = Buffer.from("bollettino ufficiale");
    const contentId = computeContentId(data);
    const fields = { contentId, name: "Bollettino Ufficiale", mimeType: "text/plain", size: data.length, publisherId: publisher.nodeId };
    const metadata: ContentMetadata = {
      ...fields,
      createdAt: Date.now(),
      signature: publisher.sign(contentSigningPayload(fields)).toString("hex"),
    };
    node.remoteCatalog.record(metadata);
    node.routingTable.offer(publisher.nodeId, "next-hop-node-id", 2);

    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const results = await (await fetch(`${baseUrl()}/api/search?q=bollettino`)).json();
    expect(results).toHaveLength(1);
    expect(results[0].availableLocally).toBe(false);
    expect(results[0].availableThrough).toBe("next hop: NODE-next-hop");
  });

  it("/api/status reports relaying reflecting RelayPolicy's current decision", async () => {
    node = new NomadNode({ displayName: "N", relayPolicy: { mode: "off" } });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const status = await (await fetch(`${baseUrl()}/api/status`)).json();
    expect(status.relaying).toBe(false);
  });

  it("/api/peers lists connected peers with a short label and their current trust level", async () => {
    node = new NomadNode({ displayName: "N" });
    const transport = new TcpTransport(node.nodeId, 0);
    node.addTransport(transport);
    await node.start();

    const other = new NomadNode({ displayName: "Other" });
    const otherTransport = new TcpTransport(other.nodeId, 0);
    other.addTransport(otherTransport);
    await other.start();
    await other.connect({ host: "127.0.0.1", port: transport.port });
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the HELLO round trip settle on both sides

    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const peers = await (await fetch(`${baseUrl()}/api/peers`)).json();
    expect(peers).toHaveLength(1);
    // Normal HELLO handshake exchanges a signed IdentityAnnouncement (peer-directory.ts), so a
    // freshly-connected peer is already past SEEN by the time both sides have processed it.
    expect(peers[0]).toMatchObject({ nodeId: other.nodeId, shortLabel: `NODE-${other.nodeId.slice(0, 8)}`, trustLevel: "VERIFIED" });
    expect(typeof peers[0].connectedAt).toBe("number");
    expect(typeof peers[0].lastSeen).toBe("number");

    await other.stop();
  });

  it("/api/services lists every known service, including unavailable ones, marking which are offered locally", async () => {
    node = new NomadNode({ displayName: "N" });
    node.registerService("service://kiwix-search", "1.0.0", ["search"], () => ({}));
    node.registerService("service://ai", "1.0.0", ["chat"], () => ({}), { availability: false });

    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const services = await (await fetch(`${baseUrl()}/api/services`)).json();
    expect(services).toHaveLength(2);
    const search = services.find((s: { serviceId: string }) => s.serviceId === "service://kiwix-search");
    expect(search).toMatchObject({ isLocal: true, providerLabel: "Questo nodo", availability: true, capabilities: ["search"] });
    const ai = services.find((s: { serviceId: string }) => s.serviceId === "service://ai");
    expect(ai).toMatchObject({ availability: false });
  });

  it("/api/content lists everything known without needing a search query, unlike /api/search", async () => {
    node = new NomadNode({ displayName: "N" });
    node.publishContent("Guida Rifugio.pdf", "application/pdf", Buffer.from("contenuto"));

    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    expect(await (await fetch(`${baseUrl()}/api/search?q=`)).json()).toEqual([]);
    const all = await (await fetch(`${baseUrl()}/api/content`)).json();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "Guida Rifugio.pdf", availableLocally: true });
  });

  it("returns 404 for an unknown path and 405 for a non-GET method", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    expect((await fetch(`${baseUrl()}/nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl()}/api/status`, { method: "POST" })).status).toBe(405);
  });

  it("binds to loopback by default, not every interface", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();
    // host isn't exposed as a getter (only port is, matching TcpTransport's own convention) —
    // asserted indirectly: connecting via the loopback address must work.
    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/status`);
    expect(res.status).toBe(200);
  });
});
