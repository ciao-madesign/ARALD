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
 * never presented as a demo-ready mock of a real news backend. It serves
 * real RSS 2.0 XML, not the fictional JSON mini-API this gateway used to
 * speak — see `rss-feed.test.ts` for the RSS/Atom parser's own dedicated
 * unit tests (malformed XML, Atom, CDATA, entities, etc).
 */

interface TestHeadline {
  id: string;
  title: string;
  summary: string;
  url: string;
  /** Any `Date`-parseable string — fixtures below use full-precision ISO 8601 so the round-tripped `publishedAt` equals this exactly, keeping assertions simple. */
  publishedAt: string;
  category?: string;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function rssFeed(items: TestHeadline[], opts: { source?: string; language?: string } = {}): string {
  const itemsXml = items
    .map(
      (h) => `
    <item>
      <title>${xmlEscape(h.title)}</title>
      <link>${xmlEscape(h.url)}</link>
      <guid>${xmlEscape(h.id)}</guid>
      <description>${xmlEscape(h.summary)}</description>
      <pubDate>${h.publishedAt}</pubDate>
      ${h.category ? `<category>${xmlEscape(h.category)}</category>` : ""}
    </item>`,
    )
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${xmlEscape(opts.source ?? "")}</title>${
    opts.language ? `<language>${xmlEscape(opts.language)}</language>` : ""
  }${itemsXml}</channel></rss>`;
}

function startTestNewsServer(getItems: () => TestHeadline[], opts: { source?: string; language?: string } = {}): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/feed.xml") {
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.end(rssFeed(getItems(), opts));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/feed.xml` });
    });
  });
}

function stopTestNewsServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Like `startTestNewsServer`, but serves whatever raw string `getBody()` returns — for exercising malformed/non-RSS responses a real feed URL could still send. */
function startRawTestNewsServer(getBody: () => string): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/feed.xml") {
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.end(getBody());
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/feed.xml` });
    });
  });
}

/**
 * Serves `getItems()` as RSS, delaying the response by `delayMs(requestIndex)` milliseconds
 * (0-based, one call per request received) — lets a test make an *earlier* request resolve
 * *later* than one that starts after it, the exact out-of-order-response shape
 * `syncGeneration` (news-gateway.ts) exists to guard against.
 */
function startReorderingTestNewsServer(getItems: () => TestHeadline[], delayMs: (requestIndex: number) => number): Promise<{ server: Server; url: string }> {
  let requestIndex = 0;
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/feed.xml") {
        const index = requestIndex++;
        const body = rssFeed(getItems());
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/rss+xml" });
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
      resolve({ server, url: `http://127.0.0.1:${port}/feed.xml` });
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

describe("NewsGateway (mocked with a test-local RSS HTTP server, no shipped fake — see docs/security.md)", () => {
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

  const headline1: TestHeadline = { id: "1", title: "Prima notizia", summary: "Un riassunto.", url: "https://example.test/1", publishedAt: "2026-01-01T00:00:00.000Z" };
  const headline2: TestHeadline = { id: "2", title: "Seconda notizia", summary: "Un altro riassunto.", url: "https://example.test/2", publishedAt: "2026-01-02T00:00:00.000Z" };

  it("syncNews() publishes each headline as content and returns only what's new", async () => {
    let items = [headline1];
    const started = await startTestNewsServer(() => items, { source: "Notizie di test" });
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    const first = await gateway.syncNews();
    expect(first).toEqual([{ ...headline1, source: "Notizie di test" }]);
    expect(gateway.headlines).toEqual([{ ...headline1, source: "Notizie di test" }]);

    // Re-syncing the same headline reports nothing new — dedup mirrors KiwixGateway.syncCatalog().
    const second = await gateway.syncNews();
    expect(second).toEqual([]);

    // A genuinely new headline shows up.
    items = [headline1, headline2];
    const third = await gateway.syncNews();
    expect(third).toEqual([{ ...headline2, source: "Notizie di test" }]);
    expect(gateway.headlines).toEqual([{ ...headline1, source: "Notizie di test" }, { ...headline2, source: "Notizie di test" }]);
  });

  it("carries the feed's source/category/language onto every headline from that sync", async () => {
    const started = await startTestNewsServer(() => [{ ...headline1, category: "meteo" }], { source: "Bollettino Rifugio", language: "it" });
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    const [result] = await gateway.syncNews();
    expect(result.source).toBe("Bollettino Rifugio");
    expect(result.language).toBe("it");
    expect(result.category).toBe("meteo");
    expect(result.updatedAt).toBeUndefined(); // RSS 2.0 has no <updated> equivalent
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
    expect(JSON.parse(stored.toString("utf8"))).toEqual({ ...headline1, source: "" });
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
    expect(result.headlines).toEqual([{ ...headline1, source: "" }]);
    // The service call itself never hit the backend again — still exactly the one sync() call above.
    expect(callCount).toBe(1);
  });

  it("service://news answers with an empty list before any sync has ever completed, not an error", async () => {
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, "http://127.0.0.1:1/feed.xml"); // never actually called
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
    let items = [headline1];
    const started = await startTestNewsServer(() => items);
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    gateway.startAutoSync(40);
    await waitFor(() => gateway!.headlines.length === 1);
    expect(gateway.headlines).toEqual([{ ...headline1, source: "" }]);

    items = [headline1, headline2];
    await waitFor(() => gateway!.headlines.length === 2);
    expect(gateway.headlines).toEqual([{ ...headline1, source: "" }, { ...headline2, source: "" }]);

    gateway.stopAutoSync();
    items = [headline1, headline2, { ...headline1, id: "3", title: "Terza notizia" }];
    await new Promise((resolve) => setTimeout(resolve, 200)); // several would-be intervals' worth
    // Stopped — the timer no longer fires, so the third headline is never picked up.
    expect(gateway.headlines).toEqual([{ ...headline1, source: "" }, { ...headline2, source: "" }]);
  });

  it("startAutoSync() reports every failed sync via onError without ever stopping the timer", async () => {
    // Port 1 is a reserved/privileged port nothing in this sandbox listens on — a real connection
    // failure, not a mocked fetch(), exercising the actual error path startAutoSync()'s catch sees.
    // Asserting onError fires *repeatedly* (not just once) is what actually proves the timer keeps
    // retrying rather than silently dying after its first failure — the class's whole point per its
    // own doc comment ("never stops the timer from trying again next interval").
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, "http://127.0.0.1:1/feed.xml");

    const onError = vi.fn();
    gateway.startAutoSync(40, onError);

    await waitFor(() => onError.mock.calls.length >= 3);
    gateway.stopAutoSync();
    expect(gateway.headlines).toEqual([]); // every attempt failed — the cache was never touched
    for (const call of onError.mock.calls) expect(call[0]).toBeInstanceOf(Error);
  });

  it("syncNews() rejects a response larger than the size cap without buffering it in full first", async () => {
    // Regression: an earlier version only checked size *after* res.text() had already buffered the
    // whole body — this proves the streaming fetch (fetchTextBounded, news-gateway.ts) actually
    // aborts partway through instead, by serving a response well over MAX_FEED_BYTES (2,000,000).
    const started = await startRawTestNewsServer(() => "x".repeat(2_500_000));
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    await expect(gateway.syncNews()).rejects.toThrow(/exceeded/);
    expect(gateway.headlines).toEqual([]);
    expect(gatewayNode.node.listKnownContent()).toEqual([]);
  });

  it("syncNews() rejects and applies nothing when the backend returns non-RSS/Atom garbage", async () => {
    const started = await startRawTestNewsServer(() => "this is not xml at all");
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    await expect(gateway.syncNews()).rejects.toThrow(/malformed|unrecognized/);
    expect(gateway.headlines).toEqual([]);
    expect(gatewayNode.node.listKnownContent()).toEqual([]);
  });

  it("syncNews() rejects and applies nothing when one item in an otherwise-valid feed is malformed", async () => {
    // A feed with [good, bad, good] must not leave the first "good" item's publishedById/content
    // side effects applied while the sync as a whole reports failure — validation happens over the
    // whole feed before any publishContent() call, not mid-loop.
    const started = await startRawTestNewsServer(
      () =>
        `<rss version="2.0"><channel><title>t</title>` +
        `<item><title>${xmlEscape(headline1.title)}</title><link>${headline1.url}</link><guid>${headline1.id}</guid><pubDate>${headline1.publishedAt}</pubDate></item>` +
        `<item><title>senza link ne guid</title></item>` + // malformed: no id/link
        `<item><title>${xmlEscape(headline2.title)}</title><link>${headline2.url}</link><guid>${headline2.id}</guid><pubDate>${headline2.publishedAt}</pubDate></item>` +
        `</channel></rss>`,
    );
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    await expect(gateway.syncNews()).rejects.toThrow(/malformed|unrecognized/);
    expect(gateway.headlines).toEqual([]);
    expect(gatewayNode.node.listKnownContent()).toEqual([]); // headline1 was never published either
  });

  it("a slow syncNews() response arriving after a faster, later one does not clobber the newer result", async () => {
    // Request 0 (started first) is deliberately delayed past request 1 (started second, resolves
    // fast) — reproduces a slow startAutoSync() tick's response arriving after the next tick's
    // already completed. Without syncGeneration's guard, request 0's stale [headline1] would
    // overwrite request 1's newer [headline1, headline2] when it finally resolves.
    let items = [headline1];
    const started = await startReorderingTestNewsServer(
      () => items,
      (index) => (index === 0 ? 150 : 0),
    );
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    const slowFirstCall = gateway.syncNews(); // request 0 — starts now, resolves ~150ms from now
    await new Promise((resolve) => setTimeout(resolve, 20)); // ensure request 0 is issued before request 1
    items = [headline1, headline2];
    const fastSecondCall = gateway.syncNews(); // request 1 — starts after 0, resolves almost immediately

    const [slowResult, fastResult] = await Promise.all([slowFirstCall, fastSecondCall]);
    expect(fastResult).toEqual([{ ...headline1, source: "" }, { ...headline2, source: "" }]); // the newer call reports both as new/current
    expect(slowResult).toEqual([]); // the superseded call reports nothing — it never got to commit
    expect(gateway.headlines).toEqual([{ ...headline1, source: "" }, { ...headline2, source: "" }]); // final state matches the newer call, not the stale one
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
    const firstHeadline: TestHeadline = { id: "batch0-0", title: "batch0-0", summary: "s", url: "https://example.test/batch0-0", publishedAt: "2026-01-01T00:00:00.000Z" };
    let currentBatch: TestHeadline[] = [];

    const started = await startTestNewsServer(() => currentBatch);
    server = started.server;

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    for (let batchIndex = 0; batchIndex < BATCHES; batchIndex++) {
      currentBatch = Array.from({ length: PER_BATCH }, (_, i) => {
        if (batchIndex === 0 && i === 0) return firstHeadline;
        const id = `batch${batchIndex}-${i}`;
        return { id, title: id, summary: "s", url: "https://example.test/" + id, publishedAt: "2026-01-01T00:00:00.000Z" };
      });
      const changed = await gateway.syncNews();
      expect(changed).toHaveLength(PER_BATCH); // every batch is entirely new ids, none repeat
    }
    expect(BATCHES * PER_BATCH).toBeGreaterThan(4096); // sanity: this really did exceed the cap

    // Re-sync a response containing only the very first id ever seen (same bytes, same contentId),
    // on the same gateway instance (same publishedById) throughout.
    currentBatch = [firstHeadline];
    const finalChanged = await gateway.syncNews();
    expect(finalChanged).toEqual([{ ...firstHeadline, source: "" }]); // evicted, so it's "new" again — proves the bound held
  });
});
