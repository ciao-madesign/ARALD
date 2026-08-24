import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { NewsGateway } from "../../gateway/nomad/news-gateway.js";
import { AiGateway } from "../../gateway/nomad/ai-gateway.js";
import { FakeOllamaServer } from "../../gateway/nomad/fake-ollama-server.js";

/**
 * `NewsGateway.generateDigest()` (docs/next-steps.md Opzione I, pezzo 3 —
 * "digest generati da un'IA locale") composes `NewsGateway` with
 * `service://ai` (`AiGateway`/`FakeOllamaServer` here) purely through the
 * mesh's own service-call mechanism, never a direct class reference — see
 * that method's own doc comment. Kept in its own file rather than folded
 * into news-gateway.test.ts (which has no AI dependency at all) or
 * ai-gateway.test.ts (which has no news dependency) since this is the one
 * place both are genuinely exercised together.
 */

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface TestHeadline {
  id: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
}

function rssFeed(items: TestHeadline[]): string {
  const itemsXml = items
    .map(
      (h) => `
    <item>
      <title>${xmlEscape(h.title)}</title>
      <link>${xmlEscape(h.url)}</link>
      <guid>${xmlEscape(h.id)}</guid>
      <description>${xmlEscape(h.summary)}</description>
      <pubDate>${h.publishedAt}</pubDate>
    </item>`,
    )
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Notizie di test</title>${itemsXml}</channel></rss>`;
}

function startTestNewsServer(getItems: () => TestHeadline[]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/feed.xml") {
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.end(rssFeed(getItems()));
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

const headline1: TestHeadline = { id: "1", title: "Frana sulla strada del rifugio", summary: "Dettagli.", url: "https://example.test/1", publishedAt: "2026-01-01T00:00:00.000Z" };
const headline2: TestHeadline = { id: "2", title: "Nuovo sentiero inaugurato", summary: "Dettagli.", url: "https://example.test/2", publishedAt: "2026-01-02T00:00:00.000Z" };

describe("NewsGateway.generateDigest() (composes service://news with service://ai)", () => {
  let server: Server | undefined;
  let fakeOllama: FakeOllamaServer | undefined;
  let gatewayNode: ReturnType<typeof makeNode> | undefined;
  let gateway: NewsGateway | undefined;

  afterEach(async () => {
    gateway?.stopAutoSync();
    gateway?.stopDigestAutoRefresh();
    if (server) await stopTestNewsServer(server);
    if (fakeOllama) await fakeOllama.stop();
    if (gatewayNode) await gatewayNode.node.stop();
    server = undefined;
    fakeOllama = undefined;
    gatewayNode = undefined;
    gateway = undefined;
  });

  async function setUp(items: TestHeadline[]): Promise<void> {
    const started = await startTestNewsServer(() => items);
    server = started.server;
    fakeOllama = new FakeOllamaServer();
    fakeOllama.setDefaultAnswer("Riassunto simulato delle notizie.");
    await fakeOllama.start();

    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    new AiGateway(gatewayNode.node, `http://127.0.0.1:${fakeOllama.port}`).registerAiService();
    gateway = new NewsGateway(gatewayNode.node, started.url);
  }

  it("returns undefined and never calls service://ai when there are no cached headlines yet", async () => {
    await setUp([headline1]);
    // Deliberately never calling syncNews() first — cachedHeadlines is still empty.
    const result = await gateway!.generateDigest();
    expect(result).toBeUndefined();
    expect(gateway!.digest).toBeUndefined();
    expect(fakeOllama!.prompts).toHaveLength(0); // the actual guarantee this test's name promises
  });

  it("generates a digest from the cached headlines, publishes it as content, and updates the digest getter", async () => {
    await setUp([headline1, headline2]);
    await gateway!.syncNews();

    const result = await gateway!.generateDigest();
    expect(result).toBeDefined();
    expect(result!.text).toBe("Riassunto simulato delle notizie.");
    expect(result!.contentId).toMatch(/^[0-9a-f]{64}$/);
    expect(gateway!.digest).toEqual(result);

    const stored = await gatewayNode!.node.getContent(result!.contentId, { timeoutMs: 2000 });
    expect(stored.toString("utf8")).toBe("Riassunto simulato delle notizie.");
  });

  it("the prompt sent to service://ai includes every cached headline's title", async () => {
    await setUp([headline1, headline2]);
    await gateway!.syncNews();

    await gateway!.generateDigest();

    // FakeOllamaServer records every prompt it actually received (its own fixture capability,
    // gateway/nomad/fake-ollama-server.ts) — no need to intercept fetch() to see what generateDigest()
    // composed and sent.
    expect(fakeOllama!.prompts).toHaveLength(1);
    expect(fakeOllama!.lastPrompt).toContain(headline1.title);
    expect(fakeOllama!.lastPrompt).toContain(headline2.title);
  });

  it("a headline title containing a newline is flattened to a single bullet line, never breaking the prompt into extra lines", async () => {
    // Regression: buildDigestPrompt() used to interpolate titles verbatim — a title with an
    // embedded newline could impersonate a second, attacker-controlled bullet line once joined
    // with real newlines (found by review). sanitizeTitleForPrompt() now collapses \r/\n to a space.
    await setUp([{ ...headline1, title: "Titolo reale\n- Istruzione finta iniettata" }]);
    await gateway!.syncNews();

    await gateway!.generateDigest();

    const prompt = fakeOllama!.lastPrompt!;
    // The whole (sanitized) title appears on one line — the embedded "\n- " never produced an
    // actual newline in the prompt, so grepping for the literal injected bullet line finds nothing.
    expect(prompt).toContain("Titolo reale - Istruzione finta iniettata");
    expect(prompt.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
  });

  it("an excessively long headline title is truncated before reaching the prompt", async () => {
    const longTitle = "x".repeat(500);
    await setUp([{ ...headline1, title: longTitle }]);
    await gateway!.syncNews();

    await gateway!.generateDigest();

    const prompt = fakeOllama!.lastPrompt!;
    expect(prompt).not.toContain(longTitle);
    expect(prompt.length).toBeLessThan(longTitle.length);
  });

  it("a slow generateDigest() response arriving after a faster, later one does not clobber the newer digest", async () => {
    // Same shape as syncNews()'s own "slow response arriving late" regression test
    // (tests/integration/news-gateway.test.ts) — service://ai calls aren't guaranteed to resolve in
    // the order they were sent (spec §35-36, possibly multi-hop), so digestGeneration must guard
    // generateDigest() the same way syncGeneration already guards syncNews(). Registers service://ai
    // directly as a local handler with a controllable per-call delay, rather than going through
    // FakeOllamaServer/AiGateway (which has no per-request latency knob) — deterministic without a
    // real HTTP round trip.
    const started = await startTestNewsServer(() => [headline1]);
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);
    await gateway.syncNews();

    let callIndex = 0;
    gatewayNode.node.registerService("service://ai", "1.0.0", ["chat"], async () => {
      const index = callIndex++;
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 150 : 0));
      return { response: index === 0 ? "risposta lenta (superata)" : "risposta veloce (corrente)" };
    });

    const slowFirstCall = gateway.generateDigest(); // request 0 — starts now, resolves ~150ms from now
    await new Promise((resolve) => setTimeout(resolve, 20)); // ensure request 0 is issued before request 1
    const fastSecondCall = gateway.generateDigest(); // request 1 — starts after 0, resolves almost immediately

    const [slowResult, fastResult] = await Promise.all([slowFirstCall, fastSecondCall]);
    expect(fastResult?.text).toBe("risposta veloce (corrente)");
    expect(slowResult).toBeUndefined(); // superseded — discarded, never committed
    expect(gateway.digest?.text).toBe("risposta veloce (corrente)"); // final state matches the newer call
  });

  it("propagates the error and leaves the cached digest untouched when service://ai is unreachable", async () => {
    const started = await startTestNewsServer(() => [headline1]);
    server = started.server;
    // No AiGateway registered at all — service://ai simply doesn't exist anywhere in this mesh.
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);
    await gateway.syncNews();

    await expect(gateway.generateDigest({ timeoutMs: 500 })).rejects.toThrow();
    expect(gateway.digest).toBeUndefined();
  });

  it("service://news omits digest/digestContentId before generateDigest() has ever succeeded, and includes them after", async () => {
    await setUp([headline1]);
    await gateway!.syncNews();
    gateway!.registerNewsService();

    const before = (await gatewayNode!.node.callService("service://news", {})) as { digest?: string; digestContentId?: string };
    expect(before.digest).toBeUndefined();
    expect(before.digestContentId).toBeUndefined();

    const digest = await gateway!.generateDigest();
    const after = (await gatewayNode!.node.callService("service://news", {})) as { digest?: string; digestContentId?: string };
    expect(after.digest).toBe(digest!.text);
    expect(after.digestContentId).toBe(digest!.contentId);
  });

  it("startDigestAutoRefresh() regenerates on a real short timer and stopDigestAutoRefresh() actually stops it", async () => {
    await setUp([headline1]);
    await gateway!.syncNews();

    fakeOllama!.setDefaultAnswer("prima risposta");
    gateway!.startDigestAutoRefresh(40);
    await waitFor(() => gateway!.digest?.text === "prima risposta");

    fakeOllama!.setDefaultAnswer("seconda risposta");
    await waitFor(() => gateway!.digest?.text === "seconda risposta");

    gateway!.stopDigestAutoRefresh();
    fakeOllama!.setDefaultAnswer("terza risposta — non dovrebbe mai arrivare");
    await new Promise((resolve) => setTimeout(resolve, 200)); // several would-be intervals' worth
    expect(gateway!.digest?.text).toBe("seconda risposta");
  });

  it("startDigestAutoRefresh() reports every failed generation via onError without ever stopping the timer", async () => {
    const started = await startTestNewsServer(() => [headline1]);
    server = started.server;
    // No AiGateway registered — every generateDigest() call is guaranteed to reject.
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);
    await gateway.syncNews();

    const onError = vi.fn();
    // A short timeoutMs bounds each tick's discoverService() wait (no service://ai provider exists
    // anywhere in this mesh) — without it, the default ~3s discovery timeout would make 3+ failed
    // attempts take longer than this test should reasonably wait.
    gateway.startDigestAutoRefresh(40, onError, { timeoutMs: 150 });

    await waitFor(() => onError.mock.calls.length >= 3);
    gateway.stopDigestAutoRefresh();
    expect(gateway.digest).toBeUndefined();
    for (const call of onError.mock.calls) expect(call[0]).toBeInstanceOf(Error);
  });
});
