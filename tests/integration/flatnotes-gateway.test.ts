import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { FakeFlatnotesServer } from "../../gateway/nomad/fake-flatnotes-server.js";
import { FlatnotesGateway } from "../../gateway/nomad/flatnotes-gateway.js";
import { computeContentId } from "../../node/src/content.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";

/**
 * Spec §4, §37: ARALD treats Flatnotes (a real, bare Flatnotes instance —
 * not Project NOMAD's own unverified API surface, see `FlatnotesGateway`'s
 * own doc comment for why this changed 30 September 2026) as a local
 * "shared notebook" service provider. No Docker, no real Flatnotes instance
 * — `FakeFlatnotesServer` stands in, modeling the confirmed real endpoints
 * (`/api/notes/{title}`, `/api/notes`, `/api/search?term=`).
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

describe("Flatnotes gateway (mocked, no Docker/real Flatnotes)", () => {
  let fakeFlatnotes: FakeFlatnotesServer | undefined;
  let gateway: ReturnType<typeof makeNode> | undefined;
  let requester: ReturnType<typeof makeNode> | undefined;

  afterEach(async () => {
    await Promise.all([gateway?.node.stop(), requester?.node.stop(), fakeFlatnotes?.stop()].filter(Boolean));
    fakeFlatnotes = undefined;
    gateway = undefined;
    requester = undefined;
  });

  it("fetchNote() fetches one real note from Flatnotes so a remote node retrieves it through the standard content-centric protocol", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addNote({ title: "Benvenuto", content: "Questo e' un quaderno condiviso." });
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    const published = await flatnotesGateway.fetchNote("Benvenuto");

    const expectedContentId = computeContentId(Buffer.from("Questo e' un quaderno condiviso.", "utf8"));
    expect(published).toEqual({ title: "Benvenuto", contentId: expectedContentId });

    expect(requester.node.contentStore.has(expectedContentId)).toBe(false);
    const data = await requester.node.getContent(expectedContentId);
    expect(data.toString("utf8")).toBe("Questo e' un quaderno condiviso.");
  });

  it("fetchNote() throws a clear error for a title Flatnotes doesn't have, instead of publishing garbage", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    await fakeFlatnotes.start();
    gateway = makeNode("gateway");
    await gateway.node.start();
    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);

    await expect(flatnotesGateway.fetchNote("non esiste")).rejects.toThrow(/HTTP 404/);
  });

  it("fetchNote() republishing the same unchanged title is a cheap no-op downstream (same contentId, content addressing)", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addNote({ title: "Regole", content: "silenzio dopo le 22" });
    await fakeFlatnotes.start();
    gateway = makeNode("gateway");
    await gateway.node.start();
    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);

    const first = await flatnotesGateway.fetchNote("Regole");
    const second = await flatnotesGateway.fetchNote("Regole");
    expect(second.contentId).toBe(first.contentId);
  });

  it("service://flatnotes-search proxies live to Flatnotes' real /api/search on every call, reflecting a catalog change between two calls rather than a cached snapshot", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addNote({ title: "Bollettino meteo", content: "sereno" });
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    flatnotesGateway.registerSearchService();

    const firstResult = (await requester.node.callService("service://flatnotes-search", { q: "meteo" }, { timeoutMs: 2000 })) as {
      results: Array<{ title: string }>;
    };
    expect(firstResult.results).toEqual([{ title: "Bollettino meteo" }]);

    fakeFlatnotes.addNote({ title: "Rischio valanghe", content: "moderato" });
    const secondResult = (await requester.node.callService("service://flatnotes-search", { q: "rischio" }, { timeoutMs: 2000 })) as {
      results: Array<{ title: string }>;
    };
    expect(secondResult.results).toEqual([{ title: "Rischio valanghe" }]);
  });

  it("service://flatnotes-search skips a malformed (null) result entry instead of failing the whole call (regression, same defensive pattern as KiwixGateway)", async () => {
    let rawServer: Server | undefined;
    try {
      rawServer = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([null, { title: "Roma" }]));
      });
      await new Promise<void>((resolve) => rawServer!.listen(0, "127.0.0.1", resolve));
      const address = rawServer.address();
      const rawPort = typeof address === "object" && address ? address.port : 0;

      gateway = makeNode("gateway");
      requester = makeNode("requester");
      await Promise.all([gateway.node.start(), requester.node.start()]);
      await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

      const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${rawPort}`);
      flatnotesGateway.registerSearchService();

      const result = (await requester.node.callService("service://flatnotes-search", { q: "roma" }, { timeoutMs: 2000 })) as {
        results: Array<{ title: string }>;
      };
      expect(result.results).toEqual([{ title: "Roma" }]);
    } finally {
      if (rawServer) await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
    }
  });

  it("service://flatnotes-search rejects the caller with a clear error when Flatnotes is unreachable, instead of hanging or crashing", async () => {
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

  it("service://flatnotes-fetch publishes the requested note and returns a contentId immediately retrievable via the normal content-centric protocol", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addNote({ title: "Torino", content: "citta' piemontese" });
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    flatnotesGateway.registerFetchService();

    const result = (await requester.node.callService("service://flatnotes-fetch", { title: "Torino" }, { timeoutMs: 2000 })) as {
      title: string;
      contentId: string;
    };
    expect(result.title).toBe("Torino");

    const data = await requester.node.getContent(result.contentId);
    expect(data.toString("utf8")).toBe("citta' piemontese");
  });

  it("service://flatnotes-fetch rejects with a clear error for a title Flatnotes doesn't have, instead of hanging or crashing", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    flatnotesGateway.registerFetchService();

    await expect(
      requester.node.callService("service://flatnotes-fetch", { title: "non esiste" }, { timeoutMs: 2000 }),
    ).rejects.toThrow();
  });

  it("service://flatnotes-fetch rejects a non-string/empty 'title' instead of forwarding it to Flatnotes", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    flatnotesGateway.registerFetchService();

    await expect(
      requester.node.callService("service://flatnotes-fetch", { title: 12345 }, { timeoutMs: 2000 }),
    ).rejects.toThrow(/title/);
    await expect(
      requester.node.callService("service://flatnotes-fetch", { title: "" }, { timeoutMs: 2000 }),
    ).rejects.toThrow(/title/);
  });

  it("end-to-end: service://flatnotes-search discovers a title, service://flatnotes-fetch turns it into retrievable content — the intended usage pattern", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addNote({ title: "Venezia", content: "citta' sull'acqua" });
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    flatnotesGateway.registerSearchService();
    flatnotesGateway.registerFetchService();

    const searchResult = (await requester.node.callService("service://flatnotes-search", { q: "venezia" }, { timeoutMs: 2000 })) as {
      results: Array<{ title: string }>;
    };
    expect(searchResult.results).toEqual([{ title: "Venezia" }]);

    const foundTitle = searchResult.results[0].title;
    const fetchResult = (await requester.node.callService("service://flatnotes-fetch", { title: foundTitle }, { timeoutMs: 2000 })) as {
      contentId: string;
    };
    const data = await requester.node.getContent(fetchResult.contentId);
    expect(data.toString("utf8")).toBe("citta' sull'acqua");
  });

  it("service://flatnotes-fetch rejects cleanly when a title found by a prior search has since been deleted, instead of hanging or crashing (search-then-404 race)", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addBrokenTitle("Sparita");
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    requester = makeNode("requester");
    await Promise.all([gateway.node.start(), requester.node.start()]);
    await requester.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    flatnotesGateway.registerSearchService();
    flatnotesGateway.registerFetchService();

    // Flatnotes' search index isn't guaranteed to stay in lockstep with a note being deleted
    // in between — same tolerance KiwixGateway needs for its own search-then-fetch cycle.
    const searchResult = (await requester.node.callService("service://flatnotes-search", { q: "sparita" }, { timeoutMs: 2000 })) as {
      results: Array<{ title: string }>;
    };
    expect(searchResult.results).toEqual([{ title: "Sparita" }]);

    await expect(
      requester.node.callService("service://flatnotes-fetch", { title: "Sparita" }, { timeoutMs: 2000 }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("service://flatnotes-create writes a note to Flatnotes and immediately publishes it as retrievable content", async () => {
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
    )) as { title: string; contentId: string };

    expect(result.title).toBe("Passaggio del 30 agosto");
    const bytes = await requester.node.getContent(result.contentId);
    expect(bytes.toString("utf8")).toBe("Bel sentiero, poca acqua all'ultima fontana.");

    // Actually landed on the (fake) Flatnotes backend, not just published locally.
    const backendRes = await fetch(`http://127.0.0.1:${fakeFlatnotes.port}/api/notes/${encodeURIComponent(result.title)}`);
    expect(backendRes.ok).toBe(true);
    expect(await backendRes.json()).toMatchObject({ title: "Passaggio del 30 agosto" });
  });

  it("service://flatnotes-create defaults the title when omitted, using a filesystem-safe timestamp (regression: the old ISO-timestamp default contained ':', rejected by real Flatnotes)", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    await fakeFlatnotes.start();
    gateway = makeNode("gateway");
    await gateway.node.start();
    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    flatnotesGateway.registerCreateService();

    // Before the fix, this would reject with "FlatNotes note creation failed (HTTP 422)" — the fake
    // server now enforces the same invalid-filename-character check real Flatnotes does.
    const result = (await gateway.node.callService("service://flatnotes-create", { content: "solo testo, nessun titolo" })) as {
      title: string;
      contentId: string;
    };
    expect(result.title).not.toMatch(/[<>:"/\\|?*]/);
    const bytes = await gateway.node.getContent(result.contentId);
    expect(bytes.toString("utf8")).toBe("solo testo, nessun titolo");
  });

  it("rejects an explicit title containing a character real Flatnotes forbids, instead of surfacing a confusing backend HTTP error", async () => {
    fakeFlatnotes = new FakeFlatnotesServer();
    await fakeFlatnotes.start();
    gateway = makeNode("gateway");
    await gateway.node.start();
    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);
    flatnotesGateway.registerCreateService();

    await expect(
      gateway.node.callService("service://flatnotes-create", { title: "note: con due punti", content: "testo valido" }),
    ).rejects.toThrow(/title.*cannot include/);
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

    // None of the rejected attempts above should have reached the (fake) backend — checked via
    // service://flatnotes-search with a term that would match anything actually written, since real
    // Flatnotes has no bulk-listing endpoint to check against directly (same reasoning as
    // FlatnotesGateway's own doc comment on why syncCatalog() was removed).
    const searchRes = await fetch(`http://127.0.0.1:${fakeFlatnotes.port}/api/search?term=a`);
    expect(await searchRes.json()).toEqual([]);
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

  it("fetchNote() stays correct across many distinct titles in a row — no shared per-title bookkeeping to go stale (regression, code-review: the old publishedByTitle map was dead write-only state after syncCatalog() was removed, deleted rather than kept as an unused liability)", async () => {
    const TOTAL_TITLES = 200;
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addNote({ title: "Prima nota", content: "contenuto originale" });
    await fakeFlatnotes.start();

    gateway = makeNode("gateway");
    await gateway.node.start();
    const flatnotesGateway = new FlatnotesGateway(gateway.node, `http://127.0.0.1:${fakeFlatnotes.port}`);

    const first = await flatnotesGateway.fetchNote("Prima nota");

    for (let i = 0; i < TOTAL_TITLES; i++) {
      fakeFlatnotes.addNote({ title: `Nota ${i}`, content: `contenuto ${i}` });
      const fetched = await flatnotesGateway.fetchNote(`Nota ${i}`);
      expect(fetched.title).toBe(`Nota ${i}`);
    }

    // Re-fetching the very first title still works identically after fetching 200 others in between —
    // content addressing alone (ContentStore, already bounded/tested generically elsewhere) is what
    // guarantees this, not any gateway-local state.
    const refetched = await flatnotesGateway.fetchNote("Prima nota");
    expect(refetched.contentId).toBe(first.contentId);
  });
});
