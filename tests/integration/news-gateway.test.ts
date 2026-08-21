import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { NewsGateway, type NewsHeadline } from "../../gateway/nomad/news-gateway.js";

/**
 * NewsGateway (spec §37, a third NOMAD sub-service alongside Kiwix/Ollama)
 * deliberately has no shipped fake server (docs/security.md) — unlike
 * ai-gateway.test.ts/nomad-gateway.test.ts, which reuse a product-like
 * FakeOllamaServer/FakeNomadServer class, this test stands up its own
 * minimal, test-local HTTP responder directly (`node:http`, no shared
 * abstraction) purely to exercise NewsGateway's own logic — never exported,
 * never presented as a demo-ready mock of a real news backend.
 */
function startTestNewsServer(getHeadlines: () => NewsHeadline[]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/news") {
        const body = JSON.stringify(getHeadlines());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopTestNewsServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Like `startTestNewsServer`, but serves whatever raw string `getBody()` returns — for exercising malformed/non-JSON-array responses a real backend could still send. */
function startRawTestNewsServer(getBody: () => string): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/news") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(getBody());
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Serves `getHeadlines()`, delaying the response by `delayMs(requestIndex)` milliseconds
 * (0-based, one call per request received) — lets a test make an *earlier* request resolve
 * *later* than one that starts after it, the exact out-of-order-response shape
 * `syncGeneration` (news-gateway.ts) exists to guard against.
 */
function startReorderingTestNewsServer(getHeadlines: () => NewsHeadline[], delayMs: (requestIndex: number) => number): Promise<{ server: Server; url: string }> {
  let requestIndex = 0;
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/news") {
        const index = requestIndex++;
        const body = JSON.stringify(getHeadlines());
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
        }, delayMs(index));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
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

function makeNode(displayName: string): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

describe("NewsGateway (mocked with a test-local HTTP server, no shipped fake — see docs/security.md)", () => {
  let server: Server | undefined;
  let gatewayNode: ReturnType<typeof makeNode> | undefined;
  let gateway: NewsGateway | undefined;

  afterEach(async () => {
    gateway?.stopAutoSync();
    if (server) await stopTestNewsServer(server);
    if (gatewayNode) await gatewayNode.node.stop();
    server = undefined;
    gatewayNode = undefined;
    gateway = undefined;
  });

  const headline1: NewsHeadline = { id: "1", title: "Prima notizia", summary: "Un riassunto.", url: "https://example.test/1", publishedAt: "2026-01-01T00:00:00Z" };
  const headline2: NewsHeadline = { id: "2", title: "Seconda notizia", summary: "Un altro riassunto.", url: "https://example.test/2", publishedAt: "2026-01-02T00:00:00Z" };

  it("syncNews() publishes each headline as content and returns only what's new", async () => {
    let headlines = [headline1];
    const started = await startTestNewsServer(() => headlines);
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    const first = await gateway.syncNews();
    expect(first).toEqual([headline1]);
    expect(gateway.headlines).toEqual([headline1]);

    // Re-syncing the same headline reports nothing new — dedup mirrors KiwixGateway.syncCatalog().
    const second = await gateway.syncNews();
    expect(second).toEqual([]);

    // A genuinely new headline shows up.
    headlines = [headline1, headline2];
    const third = await gateway.syncNews();
    expect(third).toEqual([headline2]);
    expect(gateway.headlines).toEqual([headline1, headline2]);
  });

  it("publishes each headline as retrievable content, discoverable via the normal CONTENT_QUERY cycle", async () => {
    const started = await startTestNewsServer(() => [headline1]);
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);
    await gateway.syncNews();

    const known = gatewayNode.node.listKnownContent();
    expect(known).toHaveLength(1);
    expect(known[0].name).toBe(headline1.title);
    expect(known[0].mimeType).toBe("application/json");

    const stored = await gatewayNode.node.getContent(known[0].contentId, { timeoutMs: 2000 });
    expect(JSON.parse(stored.toString("utf8"))).toEqual(headline1);
  });

  it("service://news answers instantly from the cache, never blocking on a live HTTP call per invocation", async () => {
    let callCount = 0;
    const started = await startTestNewsServer(() => {
      callCount++;
      return [headline1];
    });
    server = started.server;

    gatewayNode = makeNode("gateway");
    const caller = makeNode("caller");
    await Promise.all([gatewayNode.node.start(), caller.node.start()]);
    await caller.node.connect({ host: "127.0.0.1", port: gatewayNode.transport.port });

    gateway = new NewsGateway(gatewayNode.node, started.url);
    await gateway.syncNews();
    expect(callCount).toBe(1);
    gateway.registerNewsService();

    const result = (await caller.node.callService("service://news", {}, { timeoutMs: 2000 })) as { headlines: NewsHeadline[] };
    expect(result.headlines).toEqual([headline1]);
    // The service call itself never hit the backend again — still exactly the one sync() call above.
    expect(callCount).toBe(1);
  });

  it("service://news answers with an empty list before any sync has ever completed, not an error", async () => {
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, "http://127.0.0.1:1"); // never actually called
    gateway.registerNewsService();

    const result = (await gatewayNode.node.callService("service://news", {}, { timeoutMs: 2000 })) as { headlines: NewsHeadline[] };
    expect(result.headlines).toEqual([]);
  });

  it("syncNews() rejects with a clear error when the backend is unreachable, instead of hanging or crashing", async () => {
    const started = await startTestNewsServer(() => [headline1]);
    const unreachableUrl = started.url;
    await stopTestNewsServer(started.server);

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, unreachableUrl);

    await expect(gateway.syncNews()).rejects.toThrow();
  });

  it("startAutoSync() refreshes the cache on a real short timer and stopAutoSync() actually stops it", async () => {
    // A real interval, not vi.useFakeTimers() — this codebase's convention (see CLAUDE.md) is real
    // short delays + polling for async integration tests; faking timers alongside genuine socket
    // I/O to a real http.Server (fetch() here) is a known-fragile combination (confirmed directly:
    // the fetch() promise never settled within a faked timer advance in an earlier version of this
    // test), not worth fighting when a 40ms real interval is already fast enough for a test.
    let headlines = [headline1];
    const started = await startTestNewsServer(() => headlines);
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    gateway.startAutoSync(40);
    await waitFor(() => gateway!.headlines.length === 1);
    expect(gateway.headlines).toEqual([headline1]);

    headlines = [headline1, headline2];
    await waitFor(() => gateway!.headlines.length === 2);
    expect(gateway.headlines).toEqual([headline1, headline2]);

    gateway.stopAutoSync();
    headlines = [headline1, headline2, { ...headline1, id: "3", title: "Terza notizia" }];
    await new Promise((resolve) => setTimeout(resolve, 200)); // several would-be intervals' worth
    // Stopped — the timer no longer fires, so the third headline is never picked up.
    expect(gateway.headlines).toEqual([headline1, headline2]);
  });

  it("startAutoSync() reports every failed sync via onError without ever stopping the timer", async () => {
    // Port 1 is a reserved/privileged port nothing in this sandbox listens on — a real connection
    // failure, not a mocked fetch(), exercising the actual error path startAutoSync()'s catch sees.
    // Asserting onError fires *repeatedly* (not just once) is what actually proves the timer keeps
    // retrying rather than silently dying after its first failure — the class's whole point per its
    // own doc comment ("never stops the timer from trying again next interval").
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, "http://127.0.0.1:1");

    const onError = vi.fn();
    gateway.startAutoSync(40, onError);

    await waitFor(() => onError.mock.calls.length >= 3);
    gateway.stopAutoSync();
    expect(gateway.headlines).toEqual([]); // every attempt failed — the cache was never touched
    for (const call of onError.mock.calls) expect(call[0]).toBeInstanceOf(Error);
  });

  it("syncNews() rejects and applies nothing when the backend returns a non-array body", async () => {
    const started = await startRawTestNewsServer(() => JSON.stringify({ not: "an array" }));
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    await expect(gateway.syncNews()).rejects.toThrow(/malformed/);
    expect(gateway.headlines).toEqual([]);
    expect(gatewayNode.node.listKnownContent()).toEqual([]);
  });

  it("syncNews() rejects and applies nothing when one entry in an otherwise-valid array is malformed", async () => {
    // A backend that returns [good, bad, good] must not leave the first "good" entry's
    // publishedById/content side effects applied while the sync as a whole reports failure —
    // validation happens over the whole array before any publishContent() call, not mid-loop.
    const started = await startRawTestNewsServer(() => JSON.stringify([headline1, { id: "x" }, headline2]));
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    await expect(gateway.syncNews()).rejects.toThrow(/malformed/);
    expect(gateway.headlines).toEqual([]);
    expect(gatewayNode.node.listKnownContent()).toEqual([]); // headline1 was never published either
  });

  it("a slow syncNews() response arriving after a faster, later one does not clobber the newer result", async () => {
    // Request 0 (started first) is deliberately delayed past request 1 (started second, resolves
    // fast) — reproduces a slow startAutoSync() tick's response arriving after the next tick's
    // already completed. Without syncGeneration's guard, request 0's stale [headline1] would
    // overwrite request 1's newer [headline1, headline2] when it finally resolves.
    let headlines = [headline1];
    const started = await startReorderingTestNewsServer(
      () => headlines,
      (index) => (index === 0 ? 150 : 0),
    );
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    const slowFirstCall = gateway.syncNews(); // request 0 — starts now, resolves ~150ms from now
    await new Promise((resolve) => setTimeout(resolve, 20)); // ensure request 0 is issued before request 1
    headlines = [headline1, headline2];
    const fastSecondCall = gateway.syncNews(); // request 1 — starts after 0, resolves almost immediately

    const [slowResult, fastResult] = await Promise.all([slowFirstCall, fastSecondCall]);
    expect(fastResult).toEqual([headline1, headline2]); // the newer call reports both as new/current
    expect(slowResult).toEqual([]); // the superseded call reports nothing — it never got to commit
    expect(gateway.headlines).toEqual([headline1, headline2]); // final state matches the newer call, not the stale one
  });

  it("publishedById stays bounded even after syncing far more distinct headlines than its cap", async () => {
    // A misbehaving/hostile --news-url backend could otherwise grow this gateway's own bookkeeping
    // forever by rotating headline ids on every startAutoSync() tick. Proof it's actually bounded:
    // sync well past MAX_TRACKED_HEADLINES (4096, news-gateway.ts) worth of distinct ids, then
    // re-sync the very *first* id ever seen — if publishedById were a plain unbounded Map it would
    // still recognize that id and report it as unchanged; since it's FIFO-bounded, that first id
    // has necessarily been evicted by the time 4096 newer ones pushed it out, so it comes back as
    // "changed" again.
    const BATCHES = 5;
    const PER_BATCH = 1000; // 5 * 1000 = 5000 distinct ids, > the 4096 cap
    const firstHeadline: NewsHeadline = { id: "batch0-0", title: "batch0-0", summary: "s", url: "https://example.test/batch0-0", publishedAt: "2026-01-01T00:00:00Z" };
    let currentBatch: NewsHeadline[] = [];

    const started = await startTestNewsServer(() => currentBatch);
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    for (let batchIndex = 0; batchIndex < BATCHES; batchIndex++) {
      currentBatch = Array.from({ length: PER_BATCH }, (_, i) => {
        if (batchIndex === 0 && i === 0) return firstHeadline;
        const id = `batch${batchIndex}-${i}`;
        return { id, title: id, summary: "s", url: "https://example.test/" + id, publishedAt: "2026-01-01T00:00:00Z" };
      });
      const changed = await gateway.syncNews();
      expect(changed).toHaveLength(PER_BATCH); // every batch is entirely new ids, none repeat
    }
    expect(BATCHES * PER_BATCH).toBeGreaterThan(4096); // sanity: this really did exceed the cap

    // Re-sync a response containing only the very first id ever seen (same bytes, same contentId),
    // on the same gateway instance (same publishedById) throughout.
    currentBatch = [firstHeadline];
    const finalChanged = await gateway.syncNews();
    expect(finalChanged).toEqual([firstHeadline]); // evicted, so it's "new" again — proves the bound held
  });
});
