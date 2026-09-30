import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { FakeKiwixServer } from "../../gateway/nomad/fake-kiwix-server.js";
import { KiwixGateway } from "../../gateway/nomad/kiwix-gateway.js";
import { computeContentId } from "../../node/src/content.js";

/**
 * Spec §4, §37: ARALD treats Kiwix (a real, bare `kiwix-serve` instance —
 * not Project NOMAD's own unverified API surface, see `KiwixGateway`'s own
 * doc comment for why this changed 30 September 2026) as a local service
 * provider, translating `content://...`/`service://...` requests into
 * kiwix-serve's real HTTP API. No Docker, no real Kiwix instance —
 * `FakeKiwixServer` stands in for one, modeling the confirmed real
 * endpoints (`/content/{book}/{path}`, `/suggest?content=&term=`).
 */

const BOOK = "wiki";

function makeNode(displayName: string): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

describe("Kiwix gateway (mocked, no Docker/real kiwix-serve)", () => {
  let fakeKiwix: FakeKiwixServer | undefined;
  let gateway: ReturnType<typeof makeNode> | undefined;
  let requester: ReturnType<typeof makeNode> | undefined;

  afterEach(async () => {
    await Promise.all([gateway?.node.stop(), requester?.node.stop(), fakeKiwix?.stop()].filter(Boolean));
    fakeKiwix = undefined;
    gateway = undefined;
    requester = undefined;
  });

  it("publishArticle() fetches one real article from Kiwix so a remote node retrieves it through the standard content-centric protocol", async () => {
    fakeKiwix = new FakeKiwixServer({ book: BOOK });
    fakeKiwix.addArticle({
      path: "wiki/italia",
      title: "Italia",
      mimeType: "text/plain",
      body: "L'Italia e' una repubblica parlamentare in Europa meridionale.",
    });
    await fakeKiwix.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const kiwixGateway = new KiwixGateway(gateway.node, `http://127.0.0.1:${fakeKiwix.port}`, BOOK);
    const published = await kiwixGateway.publishArticle("wiki/italia");

    const expectedContentId = computeContentId(
      Buffer.from("L'Italia e' una repubblica parlamentare in Europa meridionale.", "utf8"),
    );
    expect(published).toEqual({ path: "wiki/italia", contentId: expectedContentId });

    // The requester never saw this content before and doesn't know the gateway holds it — the
    // same "A doesn't know C has it" shape as content-retrieval.test.ts, just with C's content
    // genuinely sourced from an HTTP call to (fake) Kiwix instead of publishContent() by hand.
    expect(requester.node.contentStore.has(expectedContentId)).toBe(false);
    const data = await requester.node.getContent(expectedContentId);
    expect(data.toString("utf8")).toBe("L'Italia e' una repubblica parlamentare in Europa meridionale.");
  });

  it("publishArticle() throws a clear error for a path Kiwix doesn't have, instead of publishing garbage", async () => {
    fakeKiwix = new FakeKiwixServer({ book: BOOK });
    await fakeKiwix.start();

    gateway = makeNode("gateway");
    await gateway.node.start();
    const kiwixGateway = new KiwixGateway(gateway.node, `http://127.0.0.1:${fakeKiwix.port}`, BOOK);

    await expect(kiwixGateway.publishArticle("wiki/does-not-exist")).rejects.toThrow();
  });

  it("publishArticle() republishing the same unchanged path is a cheap no-op downstream (same contentId, content addressing)", async () => {
    fakeKiwix = new FakeKiwixServer({ book: BOOK });
    fakeKiwix.addArticle({ path: "wiki/roma", title: "Roma", mimeType: "text/plain", body: "capitale d'Italia" });
    await fakeKiwix.start();

    gateway = makeNode("gateway");
    await gateway.node.start();
    const kiwixGateway = new KiwixGateway(gateway.node, `http://127.0.0.1:${fakeKiwix.port}`, BOOK);

    const first = await kiwixGateway.publishArticle("wiki/roma");
    const second = await kiwixGateway.publishArticle("wiki/roma");
    expect(second.contentId).toBe(first.contentId);

    // The body actually changed at Kiwix — content addressing means a different contentId comes
    // back, the same "edited article" shape the old syncCatalog() test covered.
    fakeKiwix.addArticle({ path: "wiki/roma", title: "Roma", mimeType: "text/plain", body: "capitale d'Italia, aggiornato" });
    const third = await kiwixGateway.publishArticle("wiki/roma");
    expect(third.contentId).not.toBe(first.contentId);
  });

  it("service://kiwix-search proxies live to Kiwix's real /suggest endpoint on every call, reflecting a catalog change between two calls rather than a cached snapshot", async () => {
    fakeKiwix = new FakeKiwixServer({ book: BOOK });
    fakeKiwix.addArticle({ path: "wiki/meteo", title: "Bollettino meteo", mimeType: "text/plain", body: "sereno" });
    await fakeKiwix.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const kiwixGateway = new KiwixGateway(gateway.node, `http://127.0.0.1:${fakeKiwix.port}`, BOOK);
    kiwixGateway.registerSearchService();

    const firstResult = (await requester.node.callService("service://kiwix-search", { q: "meteo" }, { timeoutMs: 2000 })) as {
      results: Array<{ path: string; title: string }>;
    };
    expect(firstResult.results).toEqual([{ path: "wiki/meteo", title: "Bollettino meteo" }]);

    // Added to Kiwix *after* the first search — a cached/snapshotted service would still only know
    // about "meteo", proving each call genuinely proxies live rather than serving a snapshot taken
    // once at registerSearchService() time.
    fakeKiwix.addArticle({ path: "wiki/valanghe", title: "Rischio valanghe", mimeType: "text/plain", body: "moderato" });
    const secondResult = (await requester.node.callService("service://kiwix-search", { q: "rischio" }, { timeoutMs: 2000 })) as {
      results: Array<{ path: string; title: string }>;
    };
    expect(secondResult.results).toEqual([{ path: "wiki/valanghe", title: "Rischio valanghe" }]);
  });

  it("publishArticle() percent-encodes a path containing '?'/'#' instead of letting fetch() misroute it as a query string/fragment (regression, code-review)", async () => {
    fakeKiwix = new FakeKiwixServer({ book: BOOK });
    const oddPath = "a/b?c#d";
    fakeKiwix.addArticle({ path: oddPath, title: "Odd", mimeType: "text/plain", body: "contenuto vero" });
    await fakeKiwix.start();

    gateway = makeNode("gateway");
    await gateway.node.start();
    const kiwixGateway = new KiwixGateway(gateway.node, `http://127.0.0.1:${fakeKiwix.port}`, BOOK);

    const published = await kiwixGateway.publishArticle(oddPath);
    const content = await gateway.node.getContent(published.contentId);
    expect(content.toString("utf8")).toBe("contenuto vero");
  });

  it("service://kiwix-search skips a malformed (null) suggestion entry instead of failing the whole call (regression, code-review)", async () => {
    let rawServer: Server | undefined;
    try {
      rawServer = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([null, { label: "Roma", value: "Roma", path: "wiki/roma" }]));
      });
      await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", resolve));
      const address = rawServer.address();
      const rawPort = typeof address === "object" && address ? address.port : 0;

      gateway = makeNode("gateway");
      requester = makeNode("requester");
      await Promise.all([gateway.node.start(), requester.node.start()]);
      await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

      const kiwixGateway = new KiwixGateway(gateway.node, `http://127.0.0.1:${rawPort}`, BOOK);
      kiwixGateway.registerSearchService();

      const result = (await requester.node.callService("service://kiwix-search", { q: "roma" }, { timeoutMs: 2000 })) as {
        results: Array<{ path: string; title: string }>;
      };
      expect(result.results).toEqual([{ path: "wiki/roma", title: "Roma" }]);
    } finally {
      if (rawServer) await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
    }
  });

  it("service://kiwix-search rejects the caller with a clear error when Kiwix is unreachable, instead of hanging or crashing", async () => {
    fakeKiwix = new FakeKiwixServer({ book: BOOK });
    await fakeKiwix.start();
    const unreachableUrl = `http://127.0.0.1:${fakeKiwix.port}`;
    await fakeKiwix.stop(); // now genuinely unreachable — nothing listens on that port any more
    fakeKiwix = undefined; // already stopped; afterEach shouldn't stop it again

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const kiwixGateway = new KiwixGateway(gateway.node, unreachableUrl, BOOK);
    kiwixGateway.registerSearchService();

    await expect(
      requester.node.callService("service://kiwix-search", { q: "qualsiasi" }, { timeoutMs: 2000 }),
    ).rejects.toThrow();
  });
});
