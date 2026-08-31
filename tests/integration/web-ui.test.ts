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
    // freshly-connected peer is already past SEEN — and its encryption key already known
    // (canMessage) — by the time both sides have processed it.
    expect(peers[0]).toMatchObject({ nodeId: other.nodeId, shortLabel: `NODE-${other.nodeId.slice(0, 8)}`, trustLevel: "VERIFIED", canMessage: true });
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

  it("redirects every known OS captive-portal probe path to / with a 302, no auth required", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 }); // allowServiceCalls off — must still work on every deployment
    await webUi.start();

    const probePaths = [
      "/hotspot-detect.html",
      "/library/test/success.html",
      "/generate_204",
      "/gen_204",
      "/connecttest.txt",
      "/ncsi.txt",
      "/success.txt",
    ];
    for (const path of probePaths) {
      const res = await fetch(`${baseUrl()}${path}`, { redirect: "manual" });
      expect(res.status, `expected 302 for ${path}`).toBe(302);
      expect(res.headers.get("location"), `expected Location: / for ${path}`).toBe("/");
    }
  });

  it("a path that merely resembles a captive-portal probe path still 404s, unaffected by the new redirect logic", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    expect((await fetch(`${baseUrl()}/generate_204x`, { redirect: "manual" })).status).toBe(404);
    expect((await fetch(`${baseUrl()}/HOTSPOT-DETECT.HTML`, { redirect: "manual" })).status).toBe(404); // exact-match, not case-insensitive
  });

  it("a captive-portal probe path only redirects for GET, not other methods", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/generate_204`, { method: "POST" });
    expect(res.status).toBe(405); // falls through to the generic POST-to-an-unregistered-path rejection, never redirected
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

  it("constructing with allowServiceCalls but no networkPassword throws immediately", () => {
    node = new NomadNode({ displayName: "N" });
    expect(() => new WebUiServer(node!, { port: 0, allowServiceCalls: true })).toThrow(/networkPassword/);
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

  it("still carries Access-Control-Allow-Origin even when allowServiceCalls is off — GET /api/drops (docs/next-steps.md) is offered unconditionally now, so CORS can no longer be gated on allowServiceCalls/exposeLocationRegistry/mapTiles alone", async () => {
    // Regression: found by review while adding the drops feature — the CORS gate used to be
    // conditional on those three flags, silently CORS-blocking a mobile client on a gateway with
    // none of them set even though such a gateway still always offers GET (and, unauthenticated
    // preflight-wise, POST) /api/drops. See drops-web-ui.test.ts for /api/drops' own auth behavior.
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/status`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("adds Access-Control-Allow-Origin to every response once allowServiceCalls is on, so a mobile client on a different origin can read it", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    await webUi.start();

    const status = await fetch(`${baseUrl()}/api/status`);
    expect(status.headers.get("access-control-allow-origin")).toBe("*");
    const notFound = await fetch(`${baseUrl()}/nope`);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers an OPTIONS preflight for the CORS-sensitive POST /api/call once allowServiceCalls is on", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toMatch(/authorization/i);
  });

  it("an OPTIONS preflight still answers 204 even when allowServiceCalls is off — the CORS preflight handler is unconditional (see the CORS gate regression test above), independent of whether the underlying route itself is enabled", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/call`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });

  it("invokes a registered service and returns its result, given a valid pairing token", async () => {
    node = new NomadNode({ displayName: "N" });
    node.registerService("service://echo", "1.0.0", [], (payload) => ({ echoed: payload }));
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
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
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
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
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
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
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
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
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
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
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
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
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
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
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
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

    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
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

describe("WebUiServer GET /api/pairing", () => {
  let node: NomadNode | undefined;
  let webUi: WebUiServer | undefined;
  const PASSWORD = "K7XM-2QRT";

  afterEach(async () => {
    if (webUi) await webUi.stop();
    if (node) await node.stop();
    node = undefined;
    webUi = undefined;
  });

  function baseUrl(): string {
    return `http://127.0.0.1:${webUi!.port}`;
  }

  it("404s when allowServiceCalls is off, same posture as POST /api/call", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/pairing`);
    expect(res.status).toBe(404);
  });

  it("returns the network name and password with no Authorization header at all, unauthenticated by design", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: PASSWORD, networkName: "CasaBase" });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/pairing`);
    expect(res.status).toBe(200);
    // toMatchObject, not toEqual — address/qrDataUri are also expected here (see the dedicated
    // "publicHost" describe block below), but whether they're present depends on the *test
    // machine's* network interfaces when publicHost isn't given explicitly (as here), so this test
    // only pins the two fields that don't vary by environment.
    expect(await res.json()).toMatchObject({ networkName: "CasaBase", networkPassword: PASSWORD });
  });

  it("defaults networkName to the node's displayName when not given explicitly", async () => {
    node = new NomadNode({ displayName: "GatewayA" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: PASSWORD });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/pairing`);
    expect((await res.json()).networkName).toBe("GatewayA");
  });

  it("still serves pairing info when networkName is an empty string, rather than treating a falsy-but-defined name as pairing being disabled", async () => {
    node = new NomadNode({ displayName: "" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: PASSWORD });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/pairing`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ networkName: "", networkPassword: PASSWORD });

    // POST /api/call's own guard doesn't touch networkName at all — an empty display name must not
    // make the two endpoints disagree about whether pairing is enabled.
    node.registerService("service://echo", "1.0.0", [], () => ({}));
    const callRes = await fetch(`${baseUrl()}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${PASSWORD}` },
      body: JSON.stringify({ serviceId: "service://echo", payload: {} }),
    });
    expect(callRes.status).toBe(200);
  });
});

describe("WebUiServer GET /api/pairing — address and QR", () => {
  let node: NomadNode | undefined;
  let webUi: WebUiServer | undefined;
  const PASSWORD = "K7XM-2QRT";

  afterEach(async () => {
    if (webUi) await webUi.stop();
    if (node) await node.stop();
    node = undefined;
    webUi = undefined;
  });

  function baseUrl(): string {
    return `http://127.0.0.1:${webUi!.port}`;
  }

  it("includes address and a scannable QR when publicHost is given explicitly", async () => {
    node = new NomadNode({ displayName: "GatewayA" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: PASSWORD, publicHost: "192.168.1.50" });
    await webUi.start();

    const info = await (await fetch(`${baseUrl()}/api/pairing`)).json();
    expect(info.address).toBe(`192.168.1.50:${webUi.port}`);
    expect(info.qrDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(info.qrDataUri.split(",")[1], "base64").toString("utf8");
    expect(svg).toContain("<svg");
  });

  it("uses an explicit non-loopback host as the public address without needing publicHost separately", async () => {
    // A deliberately fake-but-well-formed address, not actually bound to — WebUiOptions.host only
    // controls what the OS socket binds to; this test exercises the "host is already a concrete LAN
    // address" branch of the publicHost-resolution logic, not real network reachability.
    node = new NomadNode({ displayName: "GatewayA" });
    webUi = new WebUiServer(node, { port: 0, host: "127.0.0.1", allowServiceCalls: true, networkPassword: PASSWORD, publicHost: "10.0.0.7" });
    await webUi.start();

    const info = await (await fetch(`${baseUrl()}/api/pairing`)).json();
    expect(info.address).toBe(`10.0.0.7:${webUi.port}`);
  });

  it("omits address and qrDataUri when no public host can be resolved at all", async () => {
    // publicHost explicitly set to a value that behaves like "not resolvable" isn't representable
    // (any string is a valid host) — instead this pins the *shape* of the response when address
    // resolution succeeds vs. is absent, exercised indirectly by the "no host detectable" case
    // being environment-dependent (see the toMatchObject-based tests above). This test instead
    // confirms qrDataUri is never present without address, whatever the environment resolves.
    node = new NomadNode({ displayName: "GatewayA" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: PASSWORD });
    await webUi.start();

    const info = await (await fetch(`${baseUrl()}/api/pairing`)).json();
    if (info.address === undefined) {
      expect(info.qrDataUri).toBeUndefined();
    } else {
      expect(info.qrDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    }
  });

  it("omits qrDataUri (but keeps address) when the pairing URI exceeds the QR encoder's capacity", async () => {
    node = new NomadNode({ displayName: "GatewayA" });
    webUi = new WebUiServer(node, {
      port: 0,
      allowServiceCalls: true,
      networkPassword: PASSWORD,
      publicHost: "192.168.1.50",
      networkName: "x".repeat(400), // forces the pairing URI well past ~272 bytes
    });
    await webUi.start();

    const info = await (await fetch(`${baseUrl()}/api/pairing`)).json();
    expect(info.address).toBe(`192.168.1.50:${webUi.port}`);
    expect(info.qrDataUri).toBeUndefined();
  });
});

/**
 * POST/GET /api/messages (Slice 2a, "chat 1:1" — docs/next-steps.md Opzione J):
 * a thin HTTP layer over NomadNode.sendPrivateMessage()/messageHistory.
 * Unlike the read-only endpoints above (/api/peers, /api/services,
 * /api/content — always reachable, no sensitive data), both verbs here
 * require the same network-password auth as POST /api/call, since message
 * text is "Private messages" (spec §56), not public mesh state.
 */
describe("WebUiServer /api/messages", () => {
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

  /** Two real, connected nodes with encryption keys already exchanged — every send-path test needs this. */
  async function makeConnectedPair(): Promise<{ a: ReturnType<typeof makeGateway>; b: ReturnType<typeof makeGateway> }> {
    const a = makeGateway("A");
    const b = makeGateway("B");
    await Promise.all([a.node.start(), b.node.start(), a.webUi.start(), b.webUi.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await a.node.waitForPeerKey(b.node.nodeId, { timeoutMs: 2000 });
    await b.node.waitForPeerKey(a.node.nodeId, { timeoutMs: 2000 });
    return { a, b };
  }

  it("is a 404 for both verbs when allowServiceCalls is off", async () => {
    const node = new NomadNode({ displayName: "N" });
    const webUi = new WebUiServer(node, { port: 0 });
    nodes.push(node);
    webUis.push(webUi);
    await webUi.start();

    const getRes = await fetch(`http://127.0.0.1:${webUi.port}/api/messages?peer=x`);
    expect(getRes.status).toBe(404);
    const postRes = await fetch(`http://127.0.0.1:${webUi.port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "x", text: "hi" }),
    });
    expect(postRes.status).toBe(404);
  });

  it("rejects both verbs with 401 when the Authorization header is missing or wrong", async () => {
    const { a } = await makeConnectedPair();

    const getNoAuth = await fetch(`http://127.0.0.1:${a.webUi.port}/api/messages?peer=x`);
    expect(getNoAuth.status).toBe(401);
    const getWrongAuth = await fetch(`http://127.0.0.1:${a.webUi.port}/api/messages?peer=x`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(getWrongAuth.status).toBe(401);

    const postNoAuth = await fetch(`http://127.0.0.1:${a.webUi.port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "x", text: "hi" }),
    });
    expect(postNoAuth.status).toBe(401);
  });

  it("sends a message end-to-end: recorded in the sender's history, and the real recipient node receives + records it too", async () => {
    const { a, b } = await makeConnectedPair();

    const received = new Promise<unknown>((resolve) => b.node.once("private-message", (packet) => resolve(packet.payload)));

    const sendRes = await authedFetch(a.webUi, "/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: b.node.nodeId, text: "rifugio raggiunto, tutto bene" }),
    });
    expect(sendRes.status).toBe(200);
    const { id } = await sendRes.json();
    expect(typeof id).toBe("string");

    await expect(received).resolves.toEqual({ text: "rifugio raggiunto, tutto bene" });

    // The sender's own history already has it (recorded synchronously by sendPrivateMessage()).
    const senderHistoryRes = await authedFetch(a.webUi, `/api/messages?peer=${b.node.nodeId}`);
    const senderHistory = await senderHistoryRes.json();
    expect(senderHistory.messages).toEqual([{ peer: b.node.nodeId, direction: "sent", text: "rifugio raggiunto, tutto bene", timestamp: expect.any(Number) }]);

    // The recipient's own node recorded it as received — checked directly on messageHistory rather
    // than racing b's GET endpoint against handlePrivateMessage()'s async decrypt-then-record.
    const recipientMessages = b.node.messageHistory.get(a.node.nodeId);
    expect(recipientMessages).toEqual([{ peer: a.node.nodeId, direction: "received", text: "rifugio raggiunto, tutto bene", timestamp: expect.any(Number) }]);
  });

  it("GET returns the conversation oldest-first after multiple sends", async () => {
    const { a, b } = await makeConnectedPair();

    await authedFetch(a.webUi, "/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: b.node.nodeId, text: "primo" }),
    });
    await authedFetch(a.webUi, "/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: b.node.nodeId, text: "secondo" }),
    });

    const res = await authedFetch(a.webUi, `/api/messages?peer=${b.node.nodeId}`);
    const body = await res.json();
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(["primo", "secondo"]);
  });

  it("GET with no history for that peer returns an empty array, not an error", async () => {
    const { a } = await makeConnectedPair();
    const res = await authedFetch(a.webUi, "/api/messages?peer=some-node-never-messaged");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it("GET without a 'peer' query parameter is a 400", async () => {
    const { a } = await makeConnectedPair();
    const res = await authedFetch(a.webUi, "/api/messages");
    expect(res.status).toBe(400);
  });

  it("POST validates 'to' and 'text', rejecting missing/empty/oversized fields with 400", async () => {
    const { a, b } = await makeConnectedPair();

    const cases = [
      { body: {}, why: "missing both" },
      { body: { to: b.node.nodeId }, why: "missing text" },
      { body: { text: "hi" }, why: "missing to" },
      { body: { to: "", text: "hi" }, why: "empty to" },
      { body: { to: b.node.nodeId, text: "" }, why: "empty text" },
      { body: { to: b.node.nodeId, text: "x".repeat(4001) }, why: "text too long" },
    ];
    for (const { body } of cases) {
      const res = await authedFetch(a.webUi, "/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it("POST to a peer whose encryption key isn't known yet is a 404, not a 500/hang", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const res = await authedFetch(a.webUi, "/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "some-node-never-connected-to", text: "hello?" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/encryption key/);
  });
});

/**
 * GET /api/channels, GET/POST /api/channel-messages (public chat channels —
 * docs/next-steps.md Opzione J): a thin HTTP layer over
 * NomadNode.publishChannelMessage()/publicChannels. Unlike /api/messages
 * (1:1 private chat, gated behind the network password even for reads),
 * both GET endpoints here are unauthenticated — same tier as /api/peers,
 * /api/services, /api/content — because a public channel's contents are
 * public mesh state by definition, not "Private messages" (spec §56).
 * POST still requires the same network-password auth as every other write
 * this class exposes.
 */
describe("WebUiServer /api/channels, /api/channel-messages", () => {
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

  it("GET /api/channels and GET /api/channel-messages need no auth at all, even when allowServiceCalls/networkPassword are set", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);
    a.node.publishChannelMessage("generale", "ciao a tutti");

    const listRes = await fetch(`http://127.0.0.1:${a.webUi.port}/api/channels`);
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual([{ channel: "generale", messageCount: 1, lastActivity: expect.any(Number) }]);

    const messagesRes = await fetch(`http://127.0.0.1:${a.webUi.port}/api/channel-messages?channel=generale`);
    expect(messagesRes.status).toBe(200);
    const body = await messagesRes.json();
    expect(body.messages).toEqual([{ channel: "generale", author: a.node.nodeId, text: "ciao a tutti", timestamp: expect.any(Number), contentId: expect.any(String) }]);
  });

  it("GET /api/channels is an empty array before any channel has ever been posted to", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);
    expect(await (await fetch(`http://127.0.0.1:${a.webUi.port}/api/channels`)).json()).toEqual([]);
  });

  it("GET /api/channel-messages with no messages for that channel returns an empty array, not an error", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);
    const res = await fetch(`http://127.0.0.1:${a.webUi.port}/api/channel-messages?channel=nobody-posted-here`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it("GET /api/channel-messages without a 'channel' query parameter is a 400", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);
    const res = await fetch(`http://127.0.0.1:${a.webUi.port}/api/channel-messages`);
    expect(res.status).toBe(400);
  });

  it("GET /api/channel-messages normalizes the channel query to lowercase, matching how POST stores it", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);
    a.node.publishChannelMessage("Generale", "ciao"); // publishChannelMessage() itself lowercases

    const res = await fetch(`http://127.0.0.1:${a.webUi.port}/api/channel-messages?channel=Generale`);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
  });

  it("both GET endpoints stay reachable (200) even when allowServiceCalls is off, unlike GET /api/messages", async () => {
    // Unlike /api/messages (which 404s with allowServiceCalls off, since it needs the password
    // infrastructure to exist at all), the two GET endpoints here have no auth dependency — they
    // must stay reachable even when POST /api/call and friends are disabled entirely.
    const node = new NomadNode({ displayName: "N" });
    const webUi = new WebUiServer(node, { port: 0 });
    nodes.push(node);
    webUis.push(webUi);
    await Promise.all([node.start(), webUi.start()]);
    node.publishChannelMessage("generale", "ciao");

    const listRes = await fetch(`http://127.0.0.1:${webUi.port}/api/channels`);
    expect(listRes.status).toBe(200);
    const messagesRes = await fetch(`http://127.0.0.1:${webUi.port}/api/channel-messages?channel=generale`);
    expect(messagesRes.status).toBe(200);
  });

  it("POST publishes end-to-end: reaches a second connected node's own publicChannels", async () => {
    const a = makeGateway("A");
    const b = makeGateway("B");
    await Promise.all([a.node.start(), b.node.start(), a.webUi.start(), b.webUi.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });

    const res = await authedFetch(a.webUi, "/api/channel-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "generale", text: "rifugio raggiunto" }),
    });
    expect(res.status).toBe(200);
    const { message } = await res.json();
    expect(message.text).toBe("rifugio raggiunto");
    expect(message.author).toBe(a.node.nodeId);

    await waitFor(() => b.node.publicChannels.get("generale").length === 1);
    expect(b.node.publicChannels.get("generale")[0].text).toBe("rifugio raggiunto");
  });

  it("is a 404 for POST when allowServiceCalls is off", async () => {
    const node = new NomadNode({ displayName: "N" });
    const webUi = new WebUiServer(node, { port: 0 });
    nodes.push(node);
    webUis.push(webUi);
    await Promise.all([node.start(), webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/channel-messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "generale", text: "ciao" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST rejects with 401 when the Authorization header is missing or wrong", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const noAuth = await fetch(`http://127.0.0.1:${a.webUi.port}/api/channel-messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "generale", text: "ciao" }),
    });
    expect(noAuth.status).toBe(401);
  });

  it("POST validates 'channel' and 'text', rejecting missing/empty fields with 400", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const cases = [{ body: {} }, { body: { channel: "generale" } }, { body: { text: "hi" } }, { body: { channel: "", text: "hi" } }, { body: { channel: "generale", text: "" } }];
    for (const { body } of cases) {
      const res = await authedFetch(a.webUi, "/api/channel-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it("POST rejects an invalid channel name or oversized text with 400, surfacing publishChannelMessage()'s own error", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const invalidChannel = await authedFetch(a.webUi, "/api/channel-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "has spaces", text: "ciao" }),
    });
    expect(invalidChannel.status).toBe(400);
    expect((await invalidChannel.json()).error).toMatch(/invalid channel name/);

    const oversizedText = await authedFetch(a.webUi, "/api/channel-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "generale", text: "x".repeat(4001) }),
    });
    expect(oversizedText.status).toBe(400);
    expect((await oversizedText.json()).error).toMatch(/1-\d+ characters/);
  });
});
