import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { NewsGateway, type NewsHeadline } from "../../gateway/nomad/news-gateway.js";

/**
 * `service://emergency-news` (spec's "P0", `docs/next-steps.md` Opzione I —
 * the last piece of the "Nomad News evoluto" proposal, built on top of
 * `CONTENT_ANNOUNCE` (#34)). A headline `NewsGateway`'s `isEmergencyHeadline`
 * classifier flags is published with `{ announce: true, priority:
 * Priority.EMERGENCY }` so it reaches already-connected peers immediately —
 * see `tests/integration/content-announce.test.ts` for the underlying
 * mechanism itself, already covered generically. This file only exercises
 * what's new here: the classifier (default + override), which headlines get
 * announced vs. not, `emergencyHeadlines`/`service://emergency-news`.
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
  category?: string;
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
      ${h.category ? `<category>${xmlEscape(h.category)}</category>` : ""}
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

const normale: TestHeadline = { id: "1", title: "Nuovo sentiero inaugurato", summary: "Dettagli.", url: "https://example.test/1", publishedAt: "2026-01-01T00:00:00.000Z", category: "escursionismo" };
const emergenza: TestHeadline = { id: "2", title: "Frana sulla strada del rifugio", summary: "Dettagli.", url: "https://example.test/2", publishedAt: "2026-01-02T00:00:00.000Z", category: "Allerta Meteo" };
const senzaCategoria: TestHeadline = { id: "3", title: "Notizia senza categoria", summary: "Dettagli.", url: "https://example.test/3", publishedAt: "2026-01-03T00:00:00.000Z" };

describe("NewsGateway emergency headlines (service://emergency-news)", () => {
  let server: Server | undefined;
  let gatewayNode: ReturnType<typeof makeNode> | undefined;
  let gateway: NewsGateway | undefined;

  afterEach(async () => {
    gateway?.stopAutoSync();
    gateway?.stopDigestAutoRefresh();
    if (server) await stopTestNewsServer(server);
    if (gatewayNode) await gatewayNode.node.stop();
    server = undefined;
    gatewayNode = undefined;
    gateway = undefined;
  });

  it("the default classifier flags a headline whose category contains an emergency keyword, case-insensitively", async () => {
    const started = await startTestNewsServer(() => [normale, emergenza, senzaCategoria]);
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);

    await gateway.syncNews();
    expect(gateway.emergencyHeadlines.map((h) => h.id)).toEqual([emergenza.id]);
    expect(gateway.headlines.map((h) => h.id)).toEqual([normale.id, emergenza.id, senzaCategoria.id]); // service://news still sees everything
  });

  it("a custom isEmergencyHeadline predicate overrides the default classifier entirely", async () => {
    const started = await startTestNewsServer(() => [normale, emergenza]);
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    // Deliberately the inverse of the default: flags "escursionismo", not "allerta meteo" — proves
    // the option genuinely replaces defaultIsEmergencyHeadline rather than being ORed with it.
    gateway = new NewsGateway(gatewayNode.node, started.url, { isEmergencyHeadline: (h) => h.category === "escursionismo" });

    await gateway.syncNews();
    expect(gateway.emergencyHeadlines.map((h) => h.id)).toEqual([normale.id]);
  });

  it("service://emergency-news answers with only the emergency subset; service://news is unaffected", async () => {
    const started = await startTestNewsServer(() => [normale, emergenza]);
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);
    await gateway.syncNews();
    gateway.registerNewsService();
    gateway.registerEmergencyNewsService();

    const emergencyResult = (await gatewayNode.node.callService("service://emergency-news", {})) as { headlines: NewsHeadline[] };
    expect(emergencyResult.headlines.map((h) => h.id)).toEqual([emergenza.id]);

    const newsResult = (await gatewayNode.node.callService("service://news", {})) as { headlines: NewsHeadline[] };
    expect(newsResult.headlines.map((h) => h.id)).toEqual([normale.id, emergenza.id]);
  });

  it("service://emergency-news answers with an empty list before any sync, or when nothing currently qualifies", async () => {
    const started = await startTestNewsServer(() => [normale]);
    server = started.server;
    gatewayNode = makeNode("gateway");
    await gatewayNode.node.start();
    gateway = new NewsGateway(gatewayNode.node, started.url);
    gateway.registerEmergencyNewsService();

    const beforeSync = (await gatewayNode.node.callService("service://emergency-news", {})) as { headlines: NewsHeadline[] };
    expect(beforeSync.headlines).toEqual([]);

    await gateway.syncNews(); // only a non-emergency headline
    const afterSync = (await gatewayNode.node.callService("service://emergency-news", {})) as { headlines: NewsHeadline[] };
    expect(afterSync.headlines).toEqual([]);
  });

  it("an emergency headline reaches an already-connected node two hops away immediately, via CONTENT_ANNOUNCE", async () => {
    let items = [normale];
    const started = await startTestNewsServer(() => items);
    server = started.server;

    const gw = makeNode("gateway");
    const relay = makeNode("relay");
    const far = makeNode("far");
    gatewayNode = gw;
    await Promise.all([gw, relay, far].map(({ node }) => node.start()));
    await gw.node.connect({ host: "127.0.0.1", port: relay.transport.port });
    await relay.node.connect({ host: "127.0.0.1", port: far.transport.port });

    gateway = new NewsGateway(gw.node, started.url);
    await gateway.syncNews(); // the ordinary headline — nothing to announce yet

    items = [normale, emergenza];
    await gateway.syncNews();

    const emergencyMetadata = gw.node.contentStore.list().find((m) => m.name === emergenza.title);
    expect(emergencyMetadata).toBeDefined();
    await waitFor(() => far.node.remoteCatalog.has(emergencyMetadata!.contentId));
    // The ordinary headline from the same sync never got a proactive broadcast — only discoverable
    // the normal way (pull), proving the classifier — not "every new headline" — decides.
    const normaleMetadata = gw.node.contentStore.list().find((m) => m.name === normale.title)!;
    expect(far.node.remoteCatalog.has(normaleMetadata.contentId)).toBe(false);

    await Promise.all([relay.node.stop(), far.node.stop()]);
  });

  it("re-syncing an unchanged emergency headline does not re-announce it", async () => {
    // Regression: announcing is gated on isChanged, not just isEmergency — otherwise every
    // startAutoSync() tick would re-flood the mesh at EMERGENCY priority for a bulletin nobody's
    // waiting on anymore, even though the content itself never changed. content:announced (node.ts)
    // fires once per accepted CONTENT_ANNOUNCE received — counting it directly proves whether a
    // second one was actually sent, rather than inferring it from remoteCatalog state alone (which
    // would look identical whether or not a redundant announce arrived).
    const items = [emergenza];
    const started = await startTestNewsServer(() => items);
    server = started.server;

    const gw = makeNode("gateway");
    const far = makeNode("far");
    gatewayNode = gw;
    await Promise.all([gw, far].map(({ node }) => node.start()));
    await gw.node.connect({ host: "127.0.0.1", port: far.transport.port });

    gateway = new NewsGateway(gw.node, started.url);
    let announceCount = 0;
    far.node.on("content:announced", () => announceCount++);

    await gateway.syncNews(); // first sync — genuinely new, announced
    const metadata = gw.node.contentStore.list().find((m) => m.name === emergenza.title)!;
    await waitFor(() => far.node.remoteCatalog.has(metadata.contentId));
    expect(announceCount).toBe(1);

    const secondSyncChanged = await gateway.syncNews(); // second sync — same item, unchanged
    expect(secondSyncChanged).toEqual([]); // syncNews()'s own contract, what the announce decision is gated on
    await new Promise((resolve) => setTimeout(resolve, 200)); // time for a re-announce to have arrived, if there were one
    expect(announceCount).toBe(1); // still just the one from the first sync

    await far.node.stop();
  });

  it("caps how many CONTENT_ANNOUNCE floods a single sync originates for emergency headlines, without hiding the rest from service://emergency-news", async () => {
    // Regression: found by review — without a cap, a single sync with many new/rotated-id items
    // tagged as emergency would flood the mesh at EMERGENCY priority once per item, completely
    // unthrottled (rate-limit.ts only gates packets received from a connected peer, never ones this
    // node originates itself). MAX_EMERGENCY_ANNOUNCES_PER_SYNC (5, news-gateway.ts) bounds that —
    // this sync has 8 emergency-tagged items, more than the cap.
    const emergencyItems: TestHeadline[] = Array.from({ length: 8 }, (_, i) => ({
      id: `em-${i}`,
      title: `Bollettino ${i}`,
      summary: "Dettagli.",
      url: `https://example.test/em-${i}`,
      publishedAt: "2026-01-01T00:00:00.000Z",
      category: "Allerta Meteo",
    }));
    const started = await startTestNewsServer(() => emergencyItems);
    server = started.server;

    const gw = makeNode("gateway");
    const far = makeNode("far");
    gatewayNode = gw;
    await Promise.all([gw, far].map(({ node }) => node.start()));
    await gw.node.connect({ host: "127.0.0.1", port: far.transport.port });

    let announceCount = 0;
    far.node.on("content:announced", () => announceCount++);

    gateway = new NewsGateway(gw.node, started.url);
    const changed = await gateway.syncNews();

    expect(changed).toHaveLength(8); // every item is still classified/tracked as changed/emergency...
    expect(gateway.emergencyHeadlines).toHaveLength(8); // ...and still listed by service://emergency-news...
    await new Promise((resolve) => setTimeout(resolve, 200)); // time for any further announces to arrive
    expect(announceCount).toBe(5); // ...but only the first 5 were proactively broadcast

    await far.node.stop();
  });

  it("does not re-announce an old, unchanged emergency headline after enough unrelated routine headlines evict its entry from publishedById (regression: found by a follow-up review round)", async () => {
    // The announce decision used to be gated on isChanged (publishedById.get(id) !== contentId) —
    // publishedById is a plain FIFO shared by *every* tracked headline (bounded at
    // MAX_TRACKED_HEADLINES, 4096, news-gateway.ts), not just emergency ones. A large enough burst
    // of unrelated *routine* headlines during ordinary long-running operation (no restart needed)
    // can evict an old, still-unchanged emergency headline's entry there — making isChanged true
    // again on its next appearance and re-announcing it mesh-wide at emergency priority for content
    // that never actually changed. This reproduces that exact scenario.
    let currentBatch: TestHeadline[] = [emergenza];
    const started = await startTestNewsServer(() => currentBatch);
    server = started.server;

    const gw = makeNode("gateway");
    const far = makeNode("far");
    gatewayNode = gw;
    await Promise.all([gw, far].map(({ node }) => node.start()));
    await gw.node.connect({ host: "127.0.0.1", port: far.transport.port });

    let announceCount = 0;
    far.node.on("content:announced", () => announceCount++);

    gateway = new NewsGateway(gw.node, started.url);
    await gateway.syncNews(); // emergenza is new -> announces once
    const metadata = gw.node.contentStore.list().find((m) => m.name === emergenza.title)!;
    await waitFor(() => far.node.remoteCatalog.has(metadata.contentId));
    expect(announceCount).toBe(1);

    // Flood > MAX_TRACKED_HEADLINES (4096) distinct *routine* headlines, in batches — none of these
    // match the emergency classifier, so none of them should ever announce, but by the end
    // publishedById's FIFO has necessarily evicted emergenza's own entry (inserted before any of
    // these, and never refreshed in place since re-set() on an existing key doesn't move it).
    const BATCHES = 5;
    const PER_BATCH = 1000; // 5 * 1000 = 5000 > 4096
    for (let batchIndex = 0; batchIndex < BATCHES; batchIndex++) {
      currentBatch = Array.from({ length: PER_BATCH }, (_, i) => {
        const id = `routine-batch${batchIndex}-${i}`;
        return { id, title: id, summary: "s", url: "https://example.test/" + id, publishedAt: "2026-01-01T00:00:00.000Z", category: "escursionismo" };
      });
      await gateway.syncNews();
    }
    expect(BATCHES * PER_BATCH).toBeGreaterThan(4096); // sanity: this really did exceed publishedById's cap
    await new Promise((resolve) => setTimeout(resolve, 200)); // time for any of these to have wrongly announced
    expect(announceCount).toBe(1); // still just emergenza's own first announce — no routine headline ever announces

    // Re-sync the *same, unchanged* emergency headline alone — publishedById no longer remembers it
    // (evicted above), so the old isChanged-only gate would see it as "new" and re-announce it.
    currentBatch = [emergenza];
    await gateway.syncNews();
    await new Promise((resolve) => setTimeout(resolve, 200)); // time for a second broadcast to have arrived, if there were one

    expect(announceCount).toBe(1); // still just the first one
    await far.node.stop();
  });

  it("still re-announces an emergency headline whose id was already announced once, when its content genuinely changes", async () => {
    // Guards the specific comparison announcedEmergencyById's dedup relies on: it must compare by
    // *content id*, not merely by id presence — found missing test coverage in a follow-up review
    // round, since the sibling "does not re-announce ... unchanged" test only exercises the
    // unchanged-content path. A plausible-looking simplification (checking .has(id) instead of
    // .get(id) === contentId) would pass every other test in this file but silently stop
    // re-announcing an escalating bulletin's updated version — exactly what this test would catch.
    let currentSummary = "Prima versione del bollettino.";
    const started = await startTestNewsServer(() => [{ ...emergenza, summary: currentSummary }]);
    server = started.server;

    const gw = makeNode("gateway");
    const far = makeNode("far");
    gatewayNode = gw;
    await Promise.all([gw, far].map(({ node }) => node.start()));
    await gw.node.connect({ host: "127.0.0.1", port: far.transport.port });

    let announceCount = 0;
    far.node.on("content:announced", () => announceCount++);

    gateway = new NewsGateway(gw.node, started.url);
    await gateway.syncNews(); // first version — new, announces
    const firstMetadata = gw.node.contentStore.list().find((m) => m.name === emergenza.title)!;
    await waitFor(() => far.node.remoteCatalog.has(firstMetadata.contentId));
    expect(announceCount).toBe(1);

    // Same id, genuinely different content (a new articleContentId embedded in the headline bytes,
    // since the article body's summary changed) — a real "the bulletin got updated" scenario, not a
    // no-op resync.
    currentSummary = "Aggiornamento: evacuazione immediata richiesta.";
    const changed = await gateway.syncNews();
    expect(changed.map((h) => h.id)).toEqual([emergenza.id]); // syncNews() itself agrees this changed

    const secondMetadata = gw.node.contentStore.list().find((m) => m.name === emergenza.title && m.contentId !== firstMetadata.contentId);
    expect(secondMetadata).toBeDefined(); // a genuinely new content id was published for the updated headline
    await waitFor(() => far.node.remoteCatalog.has(secondMetadata!.contentId));
    expect(announceCount).toBe(2); // the updated version reached already-connected peers too, not just the first

    await far.node.stop();
  });
});
