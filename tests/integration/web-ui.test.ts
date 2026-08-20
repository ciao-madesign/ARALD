import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { WebUiServer } from "../../node/src/web-ui.js";
import { Identity } from "../../node/src/identity.js";
import { computeContentId, contentSigningPayload, type ContentMetadata } from "../../node/src/content.js";

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

/**
 * POST /api/call (docs/next-steps.md Opzione H, "mobile client"): the one
 * write endpoint on an otherwise strictly read-only interface, so it gets
 * its own describe block with a heavier focus on the gate around it.
 */
describe("WebUiServer POST /api/call", () => {
  let node: NomadNode | undefined;
  let webUi: WebUiServer | undefined;
  const TOKEN = "test-pairing-token-0123456789abcdef";

  afterEach(async () => {
    if (webUi) await webUi.stop();
    if (node) await node.stop();
    node = undefined;
    webUi = undefined;
  });

  function baseUrl(): string {
    return `http://127.0.0.1:${webUi!.port}`;
  }

  it("constructing with allowServiceCalls but no pairingToken throws immediately", () => {
    node = new NomadNode({ displayName: "N" });
    expect(() => new WebUiServer(node!, { port: 0, allowServiceCalls: true })).toThrow(/pairingToken/);
    node = undefined; // never started, nothing for afterEach to stop
  });

  it("is a 404 (not a 401) when allowServiceCalls was never enabled — the endpoint doesn't exist", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceId: "service://echo", payload: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("carries no CORS header at all when allowServiceCalls is off, unchanged from before this feature existed", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/status`);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("adds Access-Control-Allow-Origin to every response once allowServiceCalls is on, so a mobile client on a different origin can read it", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, pairingToken: TOKEN });
    await webUi.start();

    const status = await fetch(`${baseUrl()}/api/status`);
    expect(status.headers.get("access-control-allow-origin")).toBe("*");
    const notFound = await fetch(`${baseUrl()}/nope`);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers an OPTIONS preflight for the CORS-sensitive POST /api/call once allowServiceCalls is on", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, pairingToken: TOKEN });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toMatch(/authorization/i);
  });

  it("an OPTIONS request 404s when allowServiceCalls is off", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, { method: "OPTIONS" });
    expect(res.status).toBe(404);
  });

  it("invokes a registered service and returns its result, given a valid pairing token", async () => {
    node = new NomadNode({ displayName: "N" });
    node.registerService("service://echo", "1.0.0", [], (payload) => ({ echoed: payload }));
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, pairingToken: TOKEN });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ serviceId: "service://echo", payload: { x: 1 } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { echoed: { x: 1 } } });
  });

  it("rejects a missing Authorization header with 401, never reaching the service", async () => {
    node = new NomadNode({ displayName: "N" });
    let called = false;
    node.registerService("service://echo", "1.0.0", [], () => {
      called = true;
      return {};
    });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, pairingToken: TOKEN });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceId: "service://echo", payload: {} }),
    });
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  it("rejects a wrong pairing token with 401", async () => {
    node = new NomadNode({ displayName: "N" });
    node.registerService("service://echo", "1.0.0", [], () => ({}));
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, pairingToken: TOKEN });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify({ serviceId: "service://echo", payload: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a non-string serviceId with 400 instead of forwarding it to callService()", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, pairingToken: TOKEN });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ serviceId: 42, payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a serviceId this node has never heard of with 404, instead of letting callService() flood a SERVICE_QUERY for it", async () => {
    // Regression test: an arbitrary/unknown serviceId reaching callService() would fall into
    // discoverService()'s SERVICE_QUERY flood — a single authenticated HTTP request turning into
    // mesh-wide traffic, unlike every other endpoint on this class. Restricted to services already
    // known+available, the same set /api/services already shows the caller.
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, pairingToken: TOKEN });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ serviceId: "service://never-registered", payload: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a serviceId that's known but marked unavailable, the same bar /api/status's own services count uses", async () => {
    node = new NomadNode({ displayName: "N" });
    node.registerService("service://ai", "1.0.0", ["chat"], () => ({}), { availability: false });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, pairingToken: TOKEN });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ serviceId: "service://ai", payload: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 502 with the service's own error message when the call fails, instead of hanging or crashing", async () => {
    node = new NomadNode({ displayName: "N" });
    node.registerService("service://broken", "1.0.0", [], () => {
      throw new Error("modello non disponibile");
    });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, pairingToken: TOKEN });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ serviceId: "service://broken", payload: {} }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/modello non disponibile/);
  });

  it("responds 400 to a malformed JSON body instead of crashing", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, pairingToken: TOKEN });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("honors a small requested timeoutMs against a remote service that never resolves, rejecting quickly rather than waiting out the default", async () => {
    // A *locally*-registered service would take callService()'s in-process fast path (node.ts),
    // which never applies any timeout at all — this has to be a genuinely remote call (two nodes)
    // to actually exercise invokeService()'s setTimeout, the thing this test is about. Registered
    // *after* connecting and waited-for below, so the SERVICE_ANNOUNCE flood has already reached
    // the caller by the time /api/call is hit — matching isKnownAvailableService()'s requirement
    // and the real mobile flow (the phone only ever calls something /api/services already listed).
    const provider = new NomadNode({ displayName: "provider" });
    const providerTransport = new TcpTransport(provider.nodeId, 0);
    provider.addTransport(providerTransport);
    await provider.start();

    node = new NomadNode({ displayName: "caller" });
    const callerTransport = new TcpTransport(node.nodeId, 0);
    node.addTransport(callerTransport);
    await node.start();
    await node.connect({ host: "127.0.0.1", port: providerTransport.port });
    await waitFor(() => provider.peers.has(node!.nodeId));

    provider.registerService("service://slow", "1.0.0", [], () => new Promise(() => {})); // never resolves
    await waitFor(() => node!.services.providersFor("service://slow").length > 0);

    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, pairingToken: TOKEN });
    await webUi.start();

    const startedAt = Date.now();
    const res = await fetch(`${baseUrl()}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ serviceId: "service://slow", payload: {}, timeoutMs: 200 }),
    });
    expect(res.status).toBe(502);
    // Whichever timer wins the race — the endpoint's own callWithHardTimeout() or node.ts's
    // internal invokeService() setTimeout, both set to ~200ms — either message confirms a timeout,
    // not some other failure.
    expect((await res.json()).error).toMatch(/timed out|timeout|did not complete/i);
    // Well under DEFAULT_CALL_TIMEOUT_MS (5000ms) — proves the requested value was actually used,
    // not silently ignored in favor of the default. The upper *cap* on an excessive request is
    // covered separately (and fast) by resolveCallTimeoutMs()'s own unit tests.
    expect(Date.now() - startedAt).toBeLessThan(3000);

    await provider.stop();
  });
});
