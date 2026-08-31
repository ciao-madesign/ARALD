import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { FakeFlatnotesServer } from "../../gateway/nomad/fake-flatnotes-server.js";
import { FlatnotesGateway } from "../../gateway/nomad/flatnotes-gateway.js";
import { computeContentId } from "../../node/src/content.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";

/**
 * `service://flatnotes-search`/`service://flatnotes-create` (`FlatnotesGateway`)
 * — FlatNotes is a real Project NOMAD component (spec §4,
 * `docs/SPECIFICATION.md:102`), mocked the same way Kiwix/Ollama are (no
 * Docker, no real instance reachable from this sandbox): `FakeFlatnotesServer`
 * stands in. Mirrors `nomad-gateway.test.ts`'s structure for the read/sync
 * side, plus dedicated coverage for the write path (`registerCreateService()`)
 * that no earlier gateway needed.
 */

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

describe("FlatNotes gateway (mocked, no Docker/real FlatNotes)", () => {
  let fakeFlatnotes: FakeFlatnotesServer | undefined;
  let gateway: ReturnType<typeof makeNode> | undefined;
  let requester: ReturnType<typeof makeNode> | undefined;

  afterEach(async () => {
    await Promise.all([gateway?.node.stop(), requester?.node.stop(), fakeFlatnotes?.stop()].filter(Boolean));
    fakeFlatnotes = undefined;
    gateway = undefined;
    requester = undefined;
  });

  it("publishes FlatNotes' catalog so a remote node retrieves a real note through the standard content-centric protocol", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addNote({ path: "benvenuto", title: "Benvenuto", content: "Questo e' un quaderno condiviso." });
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    const published = await flatnotesGateway.syncCatalog();
    expect(published).toHaveLength(1);

    const expectedContentId = computeContentId(Buffer.from("Questo e' un quaderno condiviso.", "utf8"));
    expect(published[0]).toEqual({ path: "benvenuto", contentId: expectedContentId });

    expect(requester.node.contentStore.has(expectedContentId)).toBe(false);
    const data = await requester.node.getContent(expectedContentId);
    expect(data.toString("utf8")).toBe("Questo e' un quaderno condiviso.");
  });

  it("syncCatalog() tolerates a note FlatNotes lists but fails to actually serve", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addNote({ path: "ok", title: "OK", content: "questa esiste davvero" });
    fakeFlatnotes.addBrokenListing({ path: "sparita", title: "Sparita" });
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    await gateway.node.start();
    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);

    const published = await flatnotesGateway.syncCatalog();
    expect(published.map((p) => p.path)).toEqual(["ok"]);
  });

  it("syncCatalog() only reports new or changed entries on a second call, not everything again", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addNote({ path: "a", title: "A", content: "prima nota" });
    fakeFlatnotes.addNote({ path: "b", title: "B", content: "seconda nota" });
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    await gateway.node.start();
    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);

    const first = await flatnotesGateway.syncCatalog();
    expect(first.map((p) => p.path).sort()).toEqual(["a", "b"]);

    const second = await flatnotesGateway.syncCatalog();
    expect(second).toEqual([]);

    fakeFlatnotes.addNote({ path: "a", title: "A", content: "prima nota, aggiornata" });
    const third = await flatnotesGateway.syncCatalog();
    expect(third.map((p) => p.path)).toEqual(["a"]);
    expect(third[0].contentId).not.toBe(first.find((p) => p.path === "a")!.contentId);
  });

  it("service://flatnotes-search proxies live to FlatNotes on every call, reflecting a catalog change between two calls rather than a cached snapshot", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addNote({ path: "meteo", title: "Bollettino meteo", content: "sereno" });
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    flatnotesGateway.registerSearchService();

    const firstResult = (await requester.node.callService("service://flatnotes-search", { q: "meteo" }, { timeoutMs: 2000 })) as {
      results: Array<{ path: string; title: string }>;
    };
    expect(firstResult.results).toEqual([{ path: "meteo", title: "Bollettino meteo" }]);

    fakeFlatnotes.addNote({ path: "valanghe", title: "Rischio valanghe", content: "moderato" });
    const secondResult = (await requester.node.callService("service://flatnotes-search", { q: "rischio" }, { timeoutMs: 2000 })) as {
      results: Array<{ path: string; title: string }>;
    };
    expect(secondResult.results).toEqual([{ path: "valanghe", title: "Rischio valanghe" }]);
  });

  it("service://flatnotes-search rejects the caller with a clear error when FlatNotes is unreachable, instead of hanging or crashing", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    await fakeFlatnotes.start();
    const unreachableUrl = `http://127.0.0.1:${fakeFlatnotes.port}`;
    await fakeFlatnotes.stop();
    fakeFlatnotes = undefined;

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const flatnotesGateway = new FlatnotesGateway(gateway.node, unreachableUrl);
    flatnotesGateway.registerSearchService();

    await expect(
      requester.node.callService("service://flatnotes-search", { q: "qualsiasi" }, { timeoutMs: 2000 }),
    ).rejects.toThrow();
  });

  it("service://flatnotes-create writes a note to FlatNotes and immediately publishes it as retrievable content", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    flatnotesGateway.registerCreateService();

    const result = (await requester.node.callService(
      "service://flatnotes-create",
      { title: "Passaggio del 30 agosto", content: "Bel sentiero, poca acqua all'ultima fontana." },
      { timeoutMs: 2000 },
    )) as { path: string; contentId: string };

    expect(result.path).toBe("passaggio-del-30-agosto");
    const bytes = await requester.node.getContent(result.contentId);
    expect(bytes.toString("utf8")).toBe("Bel sentiero, poca acqua all'ultima fontana.");

    // Actually landed on the (fake) FlatNotes backend, not just published locally.
    const backendRes = await fetch(`http://127.0.0.1:${fakeFlatnotes.port}/api/notes/${result.path}`);
    expect(backendRes.ok).toBe(true);
    expect(await backendRes.json()).toMatchObject({ title: "Passaggio del 30 agosto" });
  });

  it("service://flatnotes-create defaults the title when omitted", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    await fakeFlatnotes.start();
    gateway = makeNode("gateway");
    await gateway.node.start();
    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    flatnotesGateway.registerCreateService();

    const result = (await gateway.node.callService("service://flatnotes-create", { content: "solo testo, nessun titolo" })) as {
      path: string;
      contentId: string;
    };
    const bytes = await gateway.node.getContent(result.contentId);
    expect(bytes.toString("utf8")).toBe("solo testo, nessun titolo");
  });

  it("rejects a malformed create payload before ever attempting a write: missing content, empty content, content over the length cap, title over its own cap", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    await fakeFlatnotes.start();
    gateway = makeNode("gateway");
    await gateway.node.start();
    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    flatnotesGateway.registerCreateService();

    await expect(gateway.node.callService("service://flatnotes-create", {})).rejects.toThrow(/content/);
    await expect(gateway.node.callService("service://flatnotes-create", { content: "" })).rejects.toThrow(/content/);
    await expect(
      gateway.node.callService("service://flatnotes-create", { content: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1) }),
    ).rejects.toThrow(/content/);
    await expect(
      gateway.node.callService("service://flatnotes-create", { title: "x".repeat(200), content: "testo valido" }),
    ).rejects.toThrow(/title/);
    await expect(gateway.node.callService("service://flatnotes-create", null)).rejects.toThrow(/payload mancante/);

    // None of the rejected attempts above should have reached the (fake) backend.
    const listRes = await fetch(`http://127.0.0.1:${fakeFlatnotes.port}/api/notes`);
    expect(await listRes.json()).toEqual([]);
  });

  it("rate limit: rejects the (N+1)th create request from the same caller within the window", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    await fakeFlatnotes.start();
    gateway = makeNode("gateway");
    await gateway.node.start();
    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`, {
      maxRequestsPerPeerPerWindow: 2,
      maxRequestsPerWindow: 1000,
      windowMs: 60_000,
    });
    flatnotesGateway.registerCreateService();

    for (let i = 0; i < 2; i++) {
      await expect(
        gateway.node.callService("service://flatnotes-create", { content: `nota numero ${i}` }),
      ).resolves.toBeDefined();
    }
    await expect(gateway.node.callService("service://flatnotes-create", { content: "nota di troppo" })).rejects.toThrow(
      /limite di richieste per questo nodo/,
    );
  });

  it("rate limit: a global cap across every caller combined still applies even when no single caller exceeds their own per-peer budget", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    await fakeFlatnotes.start();
    gateway = makeNode("gateway");
    const callerA = makeNode("callerA");
    const callerB = makeNode("callerB");
    await Promise.all([gateway.node.start(), callerA.node.start(), callerB.node.start()]);
    await callerA.node.connect({ host: "127.0.0.1", port: gateway.transport.port });
    await callerB.node.connect({ host: "127.0.0.1", port: gateway.transport.port });
    await waitFor(() => gateway!.node.peers.has(callerA.node.nodeId) && gateway!.node.peers.has(callerB.node.nodeId));

    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`, {
      maxRequestsPerPeerPerWindow: 100,
      maxRequestsPerWindow: 3,
      windowMs: 60_000,
    });
    flatnotesGateway.registerCreateService();
    await waitFor(() => callerA.node.services.providersFor("service://flatnotes-create").length > 0);
    await waitFor(() => callerB.node.services.providersFor("service://flatnotes-create").length > 0);

    await expect(callerA.node.callService("service://flatnotes-create", { content: "1" }, { timeoutMs: 2000 })).resolves.toBeDefined();
    await expect(callerA.node.callService("service://flatnotes-create", { content: "2" }, { timeoutMs: 2000 })).resolves.toBeDefined();
    await expect(callerB.node.callService("service://flatnotes-create", { content: "3" }, { timeoutMs: 2000 })).resolves.toBeDefined();
    await expect(callerB.node.callService("service://flatnotes-create", { content: "4" }, { timeoutMs: 2000 })).rejects.toThrow(
      /limite di richieste della mesh/,
    );

    await Promise.all([callerA.node.stop(), callerB.node.stop()]);
  });

  it("rate limit: requests rejected on validation grounds don't consume the budget — only requests that reach a real write do", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    await fakeFlatnotes.start();
    gateway = makeNode("gateway");
    await gateway.node.start();
    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`, {
      maxRequestsPerPeerPerWindow: 1,
      maxRequestsPerWindow: 1,
      windowMs: 60_000,
    });
    flatnotesGateway.registerCreateService();

    for (let i = 0; i < 5; i++) {
      await expect(gateway.node.callService("service://flatnotes-create", { content: "" })).rejects.toThrow();
    }

    await expect(gateway.node.callService("service://flatnotes-create", { content: "prima nota valida" })).resolves.toBeDefined();
  });

  it("publishedByPath stays bounded even after syncing far more distinct note paths than its cap", async () => {
    // Regression: found by review — unlike KiwixGateway's identically-named field (whose growth is
    // capped by a finite operator-owned NOMAD catalog), this gateway's publishedByPath is also fed
    // by service://flatnotes-create, which any mesh peer within its rate-limit budget can call
    // indefinitely with distinct content. Proof it's actually bounded (same technique as
    // news-gateway.test.ts's "publishedById stays bounded..."): sync one note, then sync well past
    // MAX_TRACKED_NOTE_PATHS (4096, flatnotes-gateway.ts) more distinct paths, then re-sync with
    // nothing changed — if publishedByPath were unbounded, the very first note would still be
    // recognized as unchanged and omitted from the result; since it's FIFO-bounded, its entry has
    // necessarily been evicted, so it comes back as "changed" again.
    const TOTAL_NEW_PATHS = 4200; // > MAX_TRACKED_NOTE_PATHS (4096)
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addNote({ path: "prima-nota", title: "Prima nota", content: "contenuto originale" });
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    await gateway.node.start();
    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);

    const first = await flatnotesGateway.syncCatalog();
    expect(first.map((p) => p.path)).toEqual(["prima-nota"]);

    for (let i = 0; i < TOTAL_NEW_PATHS; i++) {
      fakeFlatnotes.addNote({ path: `nota-${i}`, title: `Nota ${i}`, content: `contenuto ${i}` });
    }
    const second = await flatnotesGateway.syncCatalog();
    expect(second).toHaveLength(TOTAL_NEW_PATHS); // "prima-nota" unchanged, correctly not re-reported yet

    // Nothing changed at FlatNotes since the second sync — if publishedByPath had grown unbounded
    // (the bug this test guards against), it would still remember every path including "prima-nota",
    // and this third sync would report zero changes. The guaranteed property is boundedness, not an
    // exact eviction count: a full re-sync past the cap can cascade into re-reporting more than just
    // the truly-evicted entries (see MAX_TRACKED_NOTE_PATHS's doc comment for why), so this only
    // asserts the smoking gun — "prima-nota" (inserted before the cap-busting batch, so the first
    // entry any bounded FIFO would evict) comes back as "changed", proving its entry didn't survive.
    const third = await flatnotesGateway.syncCatalog();
    expect(third.map((p) => p.path)).toContain("prima-nota");
  }, 30000);
});
