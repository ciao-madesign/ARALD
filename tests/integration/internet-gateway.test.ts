import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";

/**
 * `service://internet-fetch` (`InternetGateway`) — "Internet senza Internet",
 * discussione con l'utente 25 agosto 2026 (`docs/next-steps.md`). Il test
 * server locale gira per forza su loopback (127.0.0.1), che la guardia
 * anti-SSRF reale (`url-safety.ts`, testata a parte in
 * `tests/unit/url-safety.test.ts`) rifiuterebbe sempre — qui viene quindi
 * mockata a `true` per la maggior parte dei test (che verificano la logica
 * *propria* di `InternetGateway`: allowlist, validazione feed, rate limit,
 * pubblicazione), con UN test dedicato che non la mocka affatto, per provare
 * che la guardia reale è davvero collegata e non solo testata in isolamento.
 */

vi.mock("../../gateway/nomad/url-safety.js", () => ({ isPubliclyRoutableUrl: vi.fn(async () => true) }));

const { InternetGateway } = await import("../../gateway/nomad/internet-gateway.js");

const VALID_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title><item><title>Notizia</title><link>https://example.test/1</link><guid>1</guid><pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate></item></channel></rss>`;

function startTestServer(): Promise<{ server: Server; url: (path: string) => string; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/feed.xml") {
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.end(VALID_RSS);
        return;
      }
      if (url.pathname === "/not-a-feed.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("questo non è un feed, solo testo semplice");
        return;
      }
      if (url.pathname === "/institutional.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("comunicato ufficiale: il rifugio riapre il primo giugno");
        return;
      }
      if (url.pathname === "/huge.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("x".repeat(5_000_000));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port, url: (path: string) => `http://127.0.0.1:${port}${path}` });
    });
  });
}

function stopTestServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

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

describe("service://internet-fetch (InternetGateway)", () => {
  let server: Server | undefined;
  let gatewayNode: ReturnType<typeof makeNode> | undefined;
  let callerNode: ReturnType<typeof makeNode> | undefined;

  afterEach(async () => {
    if (server) await stopTestServer(server);
    server = undefined;
    await Promise.all([gatewayNode?.node.stop(), callerNode?.node.stop()].filter(Boolean));
    gatewayNode = undefined;
    callerNode = undefined;
  });

  it("kind: rss — fetches, validates as a real feed, publishes as content, and returns a retrievable reference", async () => {
    const started = await startTestServer();
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    const gateway = new InternetGateway(gatewayNode.node);
    gateway.registerInternetFetchService();

    const result = (await gatewayNode.node.callService("service://internet-fetch", { kind: "rss", url: started.url("/feed.xml") })) as {
      contentId: string;
      mimeType: string;
      size: number;
    };
    expect(result.mimeType).toBe("application/xml");
    const bytes = await gatewayNode.node.getContent(result.contentId);
    expect(bytes.toString("utf8")).toBe(VALID_RSS);
  });

  it("kind: rss — rejects content that doesn't actually parse as RSS/Atom, publishing nothing", async () => {
    const started = await startTestServer();
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    const gateway = new InternetGateway(gatewayNode.node);
    gateway.registerInternetFetchService();

    await expect(
      gatewayNode.node.callService("service://internet-fetch", { kind: "rss", url: started.url("/not-a-feed.txt") }),
    ).rejects.toThrow(/non è un feed/);
    expect(gatewayNode.node.listKnownContent()).toEqual([]);
  });

  it("kind: text — rejects a host not in the operator's allowlist", async () => {
    const started = await startTestServer();
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    const gateway = new InternetGateway(gatewayNode.node); // no allowedTextHosts given at all
    gateway.registerInternetFetchService();

    await expect(
      gatewayNode.node.callService("service://internet-fetch", { kind: "text", url: started.url("/institutional.txt") }),
    ).rejects.toThrow(/allowlist/);
  });

  it("kind: text — succeeds for a host the operator explicitly allowed", async () => {
    const started = await startTestServer();
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    const gateway = new InternetGateway(gatewayNode.node, { allowedTextHosts: ["127.0.0.1"] });
    gateway.registerInternetFetchService();

    const result = (await gatewayNode.node.callService("service://internet-fetch", { kind: "text", url: started.url("/institutional.txt") })) as {
      contentId: string;
      mimeType: string;
    };
    expect(result.mimeType).toBe("text/plain");
    const bytes = await gatewayNode.node.getContent(result.contentId);
    expect(bytes.toString("utf8")).toContain("rifugio riapre");
  });

  it("kind: text — the allowlist match is case-insensitive", async () => {
    const started = await startTestServer();
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    const gateway = new InternetGateway(gatewayNode.node, { allowedTextHosts: ["127.0.0.1".toUpperCase()] });
    gateway.registerInternetFetchService();

    await expect(
      gatewayNode.node.callService("service://internet-fetch", { kind: "text", url: started.url("/institutional.txt") }),
    ).resolves.toBeDefined();
  });

  it("kind: text — a response over maxResponseBytes is rejected without buffering it in full", async () => {
    const started = await startTestServer();
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    const gateway = new InternetGateway(gatewayNode.node, { allowedTextHosts: ["127.0.0.1"], maxResponseBytes: 1000 });
    gateway.registerInternetFetchService();

    await expect(
      gatewayNode.node.callService("service://internet-fetch", { kind: "text", url: started.url("/huge.txt") }),
    ).rejects.toThrow(/exceeded/);
    expect(gatewayNode.node.listKnownContent()).toEqual([]);
  });

  it("rejects a malformed payload before ever attempting a fetch: unknown kind, missing url, malformed url, non-http(s) scheme", async () => {
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    const gateway = new InternetGateway(gatewayNode.node, { allowedTextHosts: ["example.test"] });
    gateway.registerInternetFetchService();

    await expect(gatewayNode.node.callService("service://internet-fetch", { kind: "html", url: "http://example.test/" })).rejects.toThrow(
      /kind non supportato/,
    );
    await expect(gatewayNode.node.callService("service://internet-fetch", { kind: "rss" })).rejects.toThrow(/url mancante/);
    await expect(gatewayNode.node.callService("service://internet-fetch", { kind: "rss", url: "not a url" })).rejects.toThrow(/malformato/);
    await expect(gatewayNode.node.callService("service://internet-fetch", { kind: "rss", url: "ftp://example.test/" })).rejects.toThrow(
      /schema non supportato/,
    );
    await expect(gatewayNode.node.callService("service://internet-fetch", null)).rejects.toThrow(/payload mancante/);
  });

  it("rate limit: rejects the (N+1)th request from the same caller within the window", async () => {
    const started = await startTestServer();
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    const gateway = new InternetGateway(gatewayNode.node, { maxRequestsPerPeerPerWindow: 3, maxRequestsPerWindow: 1000, windowMs: 60_000 });
    gateway.registerInternetFetchService();

    for (let i = 0; i < 3; i++) {
      await expect(
        gatewayNode.node.callService("service://internet-fetch", { kind: "rss", url: started.url("/feed.xml") }),
      ).resolves.toBeDefined();
    }
    await expect(
      gatewayNode.node.callService("service://internet-fetch", { kind: "rss", url: started.url("/feed.xml") }),
    ).rejects.toThrow(/limite di richieste per questo nodo/);
  });

  it("rate limit: a global cap across every caller combined still applies even when no single caller exceeds their own per-peer budget", async () => {
    const started = await startTestServer();
    server = started.server;
    gatewayNode = makeNode("gateway");
    const callerA = makeNode("callerA");
    const callerB = makeNode("callerB");
    await Promise.all([gatewayNode.node.start(), callerA.node.start(), callerB.node.start()]);
    await callerA.node.connect({ host: "127.0.0.1", port: gatewayNode.transport.port });
    await callerB.node.connect({ host: "127.0.0.1", port: gatewayNode.transport.port });
    await waitFor(() => gatewayNode!.node.peers.has(callerA.node.nodeId) && gatewayNode!.node.peers.has(callerB.node.nodeId));

    const gateway = new InternetGateway(gatewayNode.node, { maxRequestsPerPeerPerWindow: 100, maxRequestsPerWindow: 3, windowMs: 60_000 });
    gateway.registerInternetFetchService();
    await waitFor(() => callerA.node.services.providersFor("service://internet-fetch").length > 0);
    await waitFor(() => callerB.node.services.providersFor("service://internet-fetch").length > 0);

    // 2 from A, 1 from B = 3, right at the global cap; none of them individually near the per-peer cap of 100.
    await expect(callerA.node.callService("service://internet-fetch", { kind: "rss", url: started.url("/feed.xml") }, { timeoutMs: 2000 })).resolves.toBeDefined();
    await expect(callerA.node.callService("service://internet-fetch", { kind: "rss", url: started.url("/feed.xml") }, { timeoutMs: 2000 })).resolves.toBeDefined();
    await expect(callerB.node.callService("service://internet-fetch", { kind: "rss", url: started.url("/feed.xml") }, { timeoutMs: 2000 })).resolves.toBeDefined();
    // The 4th, from either caller, blows the global budget even though neither caller is anywhere near 100.
    await expect(
      callerB.node.callService("service://internet-fetch", { kind: "rss", url: started.url("/feed.xml") }, { timeoutMs: 2000 }),
    ).rejects.toThrow(/limite di richieste della mesh/);

    await Promise.all([callerA.node.stop(), callerB.node.stop()]);
  });

  it("rate limit: requests rejected on structural/allowlist grounds don't consume the budget — only requests that reach a real fetch do", async () => {
    // Regression: found by review — the rate-limit budget used to be consumed before the SSRF/
    // allowlist checks ran, so a flood of guaranteed-to-fail requests (wrong kind, disallowed host)
    // could exhaust the global budget without a single real outbound fetch ever happening, denying
    // service to legitimate callers for the rest of the window. This proves a burst of doomed
    // requests — well over the tiny global cap below — never touches the budget at all, and a
    // request that actually reaches the network still succeeds afterward.
    const started = await startTestServer();
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    const gateway = new InternetGateway(gatewayNode.node, { maxRequestsPerPeerPerWindow: 1, maxRequestsPerWindow: 1, windowMs: 60_000 });
    gateway.registerInternetFetchService();

    // Every one of these fails on a free/structural check (bad kind, missing url, host not allowed)
    // — none of them should count against the budget of 1.
    for (let i = 0; i < 5; i++) {
      await expect(gatewayNode.node.callService("service://internet-fetch", { kind: "html", url: started.url("/feed.xml") })).rejects.toThrow();
    }
    for (let i = 0; i < 5; i++) {
      await expect(gatewayNode.node.callService("service://internet-fetch", { kind: "text", url: started.url("/institutional.txt") })).rejects.toThrow(
        /allowlist/,
      );
    }

    // The budget (1) is still fully available for a request that actually reaches a real fetch.
    await expect(gatewayNode.node.callService("service://internet-fetch", { kind: "rss", url: started.url("/feed.xml") })).resolves.toBeDefined();
  });
});

describe("service://internet-fetch — the real SSRF guard is actually wired in (no mock)", () => {
  let gatewayNode: ReturnType<typeof makeNode> | undefined;

  afterEach(async () => {
    await gatewayNode?.node.stop();
    gatewayNode = undefined;
  });

  it("rejects a request targeting a private IPv4 literal, without needing a real network fetch", async () => {
    vi.doUnmock("../../gateway/nomad/url-safety.js");
    vi.resetModules();
    const { InternetGateway: RealInternetGateway } = await import("../../gateway/nomad/internet-gateway.js");

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    const gateway = new RealInternetGateway(gatewayNode.node, { allowedTextHosts: ["10.1.2.3"] });
    gateway.registerInternetFetchService();

    await expect(
      gatewayNode.node.callService("service://internet-fetch", { kind: "text", url: "http://10.1.2.3/whatever" }),
    ).rejects.toThrow(/URL non consentito/);
  });

  it("consumes the rate-limit budget for a request the SSRF guard itself rejects, not just for one that reaches a real fetch", async () => {
    // Regression (second review round): checkRateLimit() used to run only after the SSRF guard, so
    // a flood of requests naming distinct hostnames could queue unbounded DNS lookups (the guard's
    // own real I/O cost for a non-IP-literal target) completely unbounded by either rate-limit
    // layer. Now the budget is consumed before the guard runs — this proves it, with a budget of 1:
    // the first request (rejected by the guard) exhausts it, so the second is rejected by the rate
    // limiter itself, never even reaching the guard a second time.
    vi.doUnmock("../../gateway/nomad/url-safety.js");
    vi.resetModules();
    const { InternetGateway: RealInternetGateway } = await import("../../gateway/nomad/internet-gateway.js");

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    const gateway = new RealInternetGateway(gatewayNode.node, { maxRequestsPerPeerPerWindow: 1, maxRequestsPerWindow: 100, windowMs: 60_000 });
    gateway.registerInternetFetchService();

    await expect(
      gatewayNode.node.callService("service://internet-fetch", { kind: "rss", url: "http://10.1.2.3/whatever" }),
    ).rejects.toThrow(/URL non consentito/);
    await expect(
      gatewayNode.node.callService("service://internet-fetch", { kind: "rss", url: "http://10.1.2.4/whatever" }),
    ).rejects.toThrow(/limite di richieste per questo nodo/);
  });
});
