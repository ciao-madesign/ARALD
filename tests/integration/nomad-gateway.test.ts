import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { FakeNomadServer } from "../../gateway/nomad/fake-nomad-server.js";
import { KiwixGateway } from "../../gateway/nomad/kiwix-gateway.js";
import { computeContentId } from "../../node/src/content.js";

/**
 * Spec §4, §37, `docs/next-steps.md` Option B: Nomad-Net treats Project
 * NOMAD as a local service provider, translating `content://...`/
 * `service://...` requests into NOMAD's own HTTP API. No Docker, no real
 * Project NOMAD instance — `FakeNomadServer` stands in for one, and the
 * acceptance criterion this mirrors almost verbatim from next-steps.md: "a
 * NomadNode with this gateway active answers a CONTENT_QUERY for a real
 * Kiwix article with the same CONTENT_FOUND -> CONTENT_REQUEST ->
 * CONTENT_CHUNK* -> CONTENT_COMPLETE cycle already covered by existing
 * tests, serving real data instead of content published via
 * publishContent() [directly, by hand] ".
 */

function makeNode(displayName: string): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

describe("NOMAD gateway (mocked, no Docker/real Project NOMAD)", () => {
  let fakeNomad: FakeNomadServer | undefined;
  let gateway: ReturnType<typeof makeNode> | undefined;
  let requester: ReturnType<typeof makeNode> | undefined;

  afterEach(async () => {
    await Promise.all([gateway?.node.stop(), requester?.node.stop(), fakeNomad?.stop()].filter(Boolean));
    fakeNomad = undefined;
    gateway = undefined;
    requester = undefined;
  });

  it("publishes NOMAD's catalog so a remote node retrieves a real article through the standard content-centric protocol", async () => {
    fakeNomad = new FakeNomadServer();
    fakeNomad.addArticle({
      path: "wiki/italia",
      title: "Italia",
      mimeType: "text/plain",
      body: "L'Italia e' una repubblica parlamentare in Europa meridionale.",
    });
    await fakeNomad.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const kiwixGateway = new KiwixGateway(gateway.node, `http://127.0.0.1:${fakeNomad.port}`);
    const published = await kiwixGateway.syncCatalog();
    expect(published).toHaveLength(1);

    const expectedContentId = computeContentId(
      Buffer.from("L'Italia e' una repubblica parlamentare in Europa meridionale.", "utf8"),
    );
    expect(published[0]).toEqual({ path: "wiki/italia", contentId: expectedContentId });

    // The requester never saw this content before and doesn't know the gateway holds it — the
    // same "A doesn't know C has it" shape as content-retrieval.test.ts, just with C's content
    // genuinely sourced from an HTTP call to (fake) NOMAD instead of publishContent() by hand.
    expect(requester.node.contentStore.has(expectedContentId)).toBe(false);
    const data = await requester.node.getContent(expectedContentId);
    expect(data.toString("utf8")).toBe("L'Italia e' una repubblica parlamentare in Europa meridionale.");
  });

  it("syncCatalog() tolerates an article NOMAD lists but fails to actually serve (spec §4: NOMAD 'non è dichiarato stabile')", async () => {
    fakeNomad = new FakeNomadServer();
    fakeNomad.addArticle({ path: "wiki/ok", title: "OK", mimeType: "text/plain", body: "questo esiste davvero" });
    fakeNomad.addBrokenListing({ path: "wiki/gone", title: "Gone", mimeType: "text/plain" });
    await fakeNomad.start();

    gateway = makeNode("gateway");
    await gateway.node.start();
    const kiwixGateway = new KiwixGateway(gateway.node, `http://127.0.0.1:${fakeNomad.port}`);

    const published = await kiwixGateway.syncCatalog();
    expect(published.map((p) => p.path)).toEqual(["wiki/ok"]);
  });

  it("syncCatalog() only reports new or changed entries on a second call, not everything again", async () => {
    fakeNomad = new FakeNomadServer();
    fakeNomad.addArticle({ path: "wiki/roma", title: "Roma", mimeType: "text/plain", body: "capitale d'Italia" });
    fakeNomad.addArticle({ path: "wiki/milano", title: "Milano", mimeType: "text/plain", body: "citta' del nord" });
    await fakeNomad.start();

    gateway = makeNode("gateway");
    await gateway.node.start();
    const kiwixGateway = new KiwixGateway(gateway.node, `http://127.0.0.1:${fakeNomad.port}`);

    const first = await kiwixGateway.syncCatalog();
    expect(first.map((p) => p.path).sort()).toEqual(["wiki/milano", "wiki/roma"]);

    // Nothing changed at NOMAD between the two syncs: a re-sync still has to fetch every article
    // (content addressing means there's no way to know in advance whether one changed), but should
    // report zero *new* entries this time rather than the same two again.
    const second = await kiwixGateway.syncCatalog();
    expect(second).toEqual([]);

    // Edit an existing article's body in place (same path, new content) and add a brand new one —
    // the third sync should report exactly those two, with a different contentId than before for
    // the edited one, and leave the untouched article out entirely.
    fakeNomad.addArticle({ path: "wiki/roma", title: "Roma", mimeType: "text/plain", body: "capitale d'Italia, aggiornato" });
    fakeNomad.addArticle({ path: "wiki/torino", title: "Torino", mimeType: "text/plain", body: "citta' piemontese" });
    const third = await kiwixGateway.syncCatalog();
    expect(third.map((p) => p.path).sort()).toEqual(["wiki/roma", "wiki/torino"]);
    expect(third.find((p) => p.path === "wiki/roma")!.contentId).not.toBe(first.find((p) => p.path === "wiki/roma")!.contentId);
  });

  it("service://kiwix-search proxies live to NOMAD on every call, reflecting a catalog change between two calls rather than a cached snapshot", async () => {
    fakeNomad = new FakeNomadServer();
    fakeNomad.addArticle({ path: "wiki/meteo", title: "Bollettino meteo", mimeType: "text/plain", body: "sereno" });
    await fakeNomad.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const kiwixGateway = new KiwixGateway(gateway.node, `http://127.0.0.1:${fakeNomad.port}`);
    kiwixGateway.registerSearchService();

    const firstResult = (await requester.node.callService("service://kiwix-search", { q: "meteo" }, { timeoutMs: 2000 })) as {
      results: Array<{ path: string; title: string }>;
    };
    expect(firstResult.results).toEqual([{ path: "wiki/meteo", title: "Bollettino meteo" }]);

    // Added to NOMAD *after* the first search — a cached/snapshotted service would still only
    // know about "meteo", proving each call genuinely proxies live rather than serving a snapshot
    // taken once at registerSearchService() time.
    fakeNomad.addArticle({ path: "wiki/valanghe", title: "Rischio valanghe", mimeType: "text/plain", body: "moderato" });
    const secondResult = (await requester.node.callService("service://kiwix-search", { q: "rischio" }, { timeoutMs: 2000 })) as {
      results: Array<{ path: string; title: string }>;
    };
    expect(secondResult.results).toEqual([{ path: "wiki/valanghe", title: "Rischio valanghe" }]);
  });

  it("service://kiwix-search rejects the caller with a clear error when NOMAD is unreachable, instead of hanging or crashing", async () => {
    fakeNomad = new FakeNomadServer();
    await fakeNomad.start();
    const unreachableUrl = `http://127.0.0.1:${fakeNomad.port}`;
    await fakeNomad.stop(); // now genuinely unreachable — nothing listens on that port any more
    fakeNomad = undefined; // already stopped; afterEach shouldn't stop it again

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const kiwixGateway = new KiwixGateway(gateway.node, unreachableUrl);
    kiwixGateway.registerSearchService();

    await expect(
      requester.node.callService("service://kiwix-search", { q: "qualsiasi" }, { timeoutMs: 2000 }),
    ).rejects.toThrow();
  });
});
