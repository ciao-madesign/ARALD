import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { WebUiServer } from "../../node/src/web-ui.js";

/**
 * GET/POST /api/drops (`node/src/web-ui.ts`, bacheca "drop" —
 * docs/next-steps.md, concept credited to BitChat's mesh-local
 * `BoardManager`, Unlicense/public domain). Same dedicated-file convention
 * `map-tiles-web-ui.test.ts`/`location-registry.test.ts` already use for a
 * `WebUiServer` feature, instead of growing the already-large
 * `web-ui.test.ts` further. GET is unauthenticated (public mesh content,
 * same tier as `/api/channels`); POST is gated behind the network password
 * like every other write this class exposes.
 */
describe("WebUiServer /api/drops", () => {
  const TOKEN = "test-pairing-token-0123456789abcdef";
  const nodes: NomadNode[] = [];
  const webUis: WebUiServer[] = [];

  afterEach(async () => {
    await Promise.all(webUis.map((w) => w.stop()));
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
    webUis.length = 0;
  });

  function makeGateway(displayName: string): { node: NomadNode; webUi: WebUiServer } {
    const node = new NomadNode({ displayName });
    const webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    nodes.push(node);
    webUis.push(webUi);
    return { node, webUi };
  }

  function authedFetch(webUi: WebUiServer, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${webUi.port}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${TOKEN}` },
    });
  }

  it("GET /api/drops needs no auth at all, even when allowServiceCalls/networkPassword are set", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);
    a.node.publishDrop({ text: "Frana sul sentiero", lat: 45, lon: 7, kind: "info" });

    const res = await fetch(`http://127.0.0.1:${a.webUi.port}/api/drops`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        dropId: expect.any(String),
        author: a.node.nodeId,
        text: "Frana sul sentiero",
        lat: 45,
        lon: 7,
        label: undefined,
        kind: "info",
        timestamp: expect.any(Number),
        expiresAt: expect.any(Number),
        observedAt: expect.any(Number),
      },
    ]);
  });

  it("GET /api/drops is an empty array before any drop has ever been published", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);
    expect(await (await fetch(`http://127.0.0.1:${a.webUi.port}/api/drops`)).json()).toEqual([]);
  });

  it("GET /api/drops stays reachable (200) even when allowServiceCalls is off, unlike POST", async () => {
    const node = new NomadNode({ displayName: "N" });
    const webUi = new WebUiServer(node, { port: 0 });
    nodes.push(node);
    webUis.push(webUi);
    await Promise.all([node.start(), webUi.start()]);
    node.publishDrop({ text: "ciao", lat: 0, lon: 0, kind: "info" });

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/drops`);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it("POST /api/drops 404s when allowServiceCalls is off, same as every other write endpoint", async () => {
    const node = new NomadNode({ displayName: "N" });
    const webUi = new WebUiServer(node, { port: 0 });
    nodes.push(node);
    webUis.push(webUi);
    await Promise.all([node.start(), webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/drops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "ciao", lat: 0, lon: 0 }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/drops without a valid Authorization header is a 401, and publishes nothing", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const noAuth = await fetch(`http://127.0.0.1:${a.webUi.port}/api/drops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "ciao", lat: 0, lon: 0 }),
    });
    expect(noAuth.status).toBe(401);

    const wrongPassword = await fetch(`http://127.0.0.1:${a.webUi.port}/api/drops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-password" },
      body: JSON.stringify({ text: "ciao", lat: 0, lon: 0 }),
    });
    expect(wrongPassword.status).toBe(401);

    expect(a.node.drops.list()).toEqual([]);
  });

  it("POST /api/drops with no 'kind' defaults to 'info'", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const res = await authedFetch(a.webUi, "/api/drops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "ciao", lat: 0, lon: 0 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).drop.kind).toBe("info");
  });

  it("POST /api/drops with a correct password publishes the drop and returns it", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const res = await authedFetch(a.webUi, "/api/drops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Frana sul sentiero", lat: 45, lon: 7, label: "Pericolo", kind: "emergency" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drop).toEqual({
      dropId: expect.any(String),
      author: a.node.nodeId,
      text: "Frana sul sentiero",
      lat: 45,
      lon: 7,
      label: "Pericolo",
      kind: "emergency",
      timestamp: expect.any(Number),
      expiresAt: expect.any(Number),
      observedAt: expect.any(Number),
    });
    expect(a.node.drops.list()).toHaveLength(1);
  });

  it("POST /api/drops publishes a 'hazard' drop the same way, distinct from 'emergency'", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const res = await authedFetch(a.webUi, "/api/drops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "crepaccio sul sentiero", lat: 45, lon: 7, kind: "hazard" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).drop.kind).toBe("hazard");
  });

  it("POST /api/drops rejects a missing/empty text, non-number lat/lon, non-string label, invalid kind, or non-number expiresInMs with 400", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    async function post(body: unknown): Promise<number> {
      const res = await authedFetch(a.webUi, "/api/drops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.status;
    }

    expect(await post({ lat: 0, lon: 0 })).toBe(400); // missing text
    expect(await post({ text: "", lat: 0, lon: 0 })).toBe(400); // empty text
    expect(await post({ text: "ciao", lat: "0", lon: 0 })).toBe(400); // non-number lat
    expect(await post({ text: "ciao", lat: 0, lon: "0" })).toBe(400); // non-number lon
    expect(await post({ text: "ciao", lat: 0, lon: 0, label: 123 })).toBe(400); // non-string label
    expect(await post({ text: "ciao", lat: 0, lon: 0, kind: "yes" })).toBe(400); // invalid kind
    expect(await post({ text: "ciao", lat: 0, lon: 0, kind: true })).toBe(400); // non-string kind
    expect(await post({ text: "ciao", lat: 0, lon: 0, kind: "urgent" })).toBe(400); // the old two-level name, no longer valid
    expect(await post({ text: "ciao", lat: 0, lon: 0, expiresInMs: "1000" })).toBe(400); // non-number expiresInMs
    // Deeper validation (lat/lon out of range, oversized text/label) is publishDrop()'s own job —
    // proven by publishDrop()'s own tests (tests/integration/drops.test.ts) — this only needs one
    // representative case to show it's actually wired through as a 400, not silently swallowed.
    expect(await post({ text: "ciao", lat: 91, lon: 0 })).toBe(400);
    // A non-positive expiresInMs is publishDrop()'s own job to reject (400, not a crash or a silent
    // internal error) — tests/integration/drops.test.ts covers that it also doesn't burn the
    // elevated-drop rate-limit budget, which needs direct NomadNode access to prove.
    expect(await post({ text: "ciao", lat: 0, lon: 0, expiresInMs: -1 })).toBe(400);

    expect(a.node.drops.list()).toEqual([]);
  });

  it("POST /api/drops with a malformed JSON body is a 400", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const res = await authedFetch(a.webUi, "/api/drops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/drops returns 429 (not 400) once the elevated-drop rate limit is exhausted, and stops publishing", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    async function postElevated(): Promise<Response> {
      return authedFetch(a.webUi, "/api/drops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "urgente", lat: 0, lon: 0, kind: "emergency" }),
      });
    }

    // MAX_ELEVATED_DROPS_PER_WINDOW (node.ts) is 3 — not exported, so hardcoded here, same convention
    // tests/integration/public-channels.test.ts's own burst test already uses for a sibling constant.
    for (let i = 0; i < 3; i++) expect((await postElevated()).status).toBe(200);

    const limited = await postElevated();
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatch(/too many high-priority drops/);
    expect(a.node.drops.list()).toHaveLength(3);
  });

  describe("idempotencyKey / createdAt (coda dei drop sul telefono, voce #150)", () => {
    const post = (webUi: WebUiServer, body: Record<string, unknown>): Promise<Response> =>
      authedFetch(webUi, "/api/drops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat: 45, lon: 7, ...body }) });

    it("lo stesso idempotencyKey pubblica un solo drop: il ritentativo riceve lo stesso drop, marcato duplicate", async () => {
      const a = makeGateway("A");
      await Promise.all([a.node.start(), a.webUi.start()]);

      const first = await post(a.webUi, { text: "frana", kind: "info", idempotencyKey: "k-1" });
      const retry = await post(a.webUi, { text: "frana", kind: "info", idempotencyKey: "k-1" });
      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      const firstBody = await first.json();
      const retryBody = await retry.json();
      expect(firstBody.duplicate).toBeUndefined();
      expect(retryBody.duplicate).toBe(true);
      expect(retryBody.drop.dropId).toBe(firstBody.drop.dropId);
      expect(a.node.drops.list()).toHaveLength(1);
    });

    it("richieste identiche inviate in parallelo con la stessa chiave non pubblicano più di un drop", async () => {
      const a = makeGateway("A");
      await Promise.all([a.node.start(), a.webUi.start()]);
      const results = await Promise.all([1, 2, 3, 4].map(() => post(a.webUi, { text: "parallelo", kind: "info", idempotencyKey: "k-par" })));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(a.node.drops.list()).toHaveLength(1);
    });

    it("chiavi diverse pubblicano drop diversi, e senza chiave nulla cambia", async () => {
      const a = makeGateway("A");
      await Promise.all([a.node.start(), a.webUi.start()]);
      await post(a.webUi, { text: "uno", kind: "info", idempotencyKey: "k-a" });
      await post(a.webUi, { text: "due", kind: "info", idempotencyKey: "k-b" });
      await post(a.webUi, { text: "tre", kind: "info" });
      await post(a.webUi, { text: "tre bis", kind: "info" });
      expect(a.node.drops.list()).toHaveLength(4);
    });

    it("un rifiuto (429) non consuma la chiave: il ritentativo può ancora pubblicare", async () => {
      const a = makeGateway("A");
      await Promise.all([a.node.start(), a.webUi.start()]);
      for (let i = 0; i < 3; i++) expect((await post(a.webUi, { text: "e" + i, kind: "emergency" })).status).toBe(200);
      const limited = await post(a.webUi, { text: "bloccato", kind: "emergency", idempotencyKey: "k-429" });
      expect(limited.status).toBe(429);
      const ok = await post(a.webUi, { text: "bloccato", kind: "info", idempotencyKey: "k-429" });
      expect(ok.status).toBe(200);
      expect((await ok.json()).duplicate).toBeUndefined();
    });

    it("idempotencyKey non valido (vuoto, troppo lungo, non stringa) è un 400 e non pubblica", async () => {
      const a = makeGateway("A");
      await Promise.all([a.node.start(), a.webUi.start()]);
      for (const bad of ["", "k".repeat(101), 5, {}]) {
        expect((await post(a.webUi, { text: "x", kind: "info", idempotencyKey: bad })).status).toBe(400);
      }
      expect(a.node.drops.list()).toHaveLength(0);
    });

    it("createdAt diventa il timestamp del drop (l'ora in cui è stato scritto), non quella di pubblicazione", async () => {
      const a = makeGateway("A");
      await Promise.all([a.node.start(), a.webUi.start()]);
      const written = Date.now() - 3 * 60 * 60 * 1000;
      const res = await post(a.webUi, { text: "scritto tre ore fa", kind: "info", createdAt: written });
      expect(res.status).toBe(200);
      expect((await res.json()).drop.timestamp).toBe(written);
    });

    it("createdAt nel futuro o oltre 24 ore fa è riportato nei limiti, mai accettato così com'è", async () => {
      const a = makeGateway("A");
      await Promise.all([a.node.start(), a.webUi.start()]);
      const before = Date.now();
      const future = await (await post(a.webUi, { text: "futuro", kind: "info", createdAt: before + 10 * 24 * 3600 * 1000 })).json();
      expect(future.drop.timestamp).toBeGreaterThanOrEqual(before);
      expect(future.drop.timestamp).toBeLessThanOrEqual(Date.now());
      const ancient = await (await post(a.webUi, { text: "antico", kind: "info", createdAt: 0 })).json();
      expect(ancient.drop.timestamp).toBeGreaterThanOrEqual(before - 24 * 3600 * 1000 - 1000);
      expect(ancient.drop.timestamp).toBeLessThan(before - 23 * 3600 * 1000);
    });

    it("la stessa chiave con un contenuto diverso è un 409: mai 'già pubblicato' per una segnalazione scartata", async () => {
      const a = makeGateway("A");
      await Promise.all([a.node.start(), a.webUi.start()]);
      expect((await post(a.webUi, { text: "originale", kind: "info", idempotencyKey: "k-x" })).status).toBe(200);
      const clash = await post(a.webUi, { text: "altro testo", kind: "info", idempotencyKey: "k-x" });
      expect(clash.status).toBe(409);
      expect(a.node.drops.list()).toHaveLength(1);
      // lo stesso contenuto con la stessa chiave resta un normale duplicato
      expect((await (await post(a.webUi, { text: "originale", kind: "info", idempotencyKey: "k-x" })).json()).duplicate).toBe(true);
    });

    it("un createdAt non finito (1e999 → Infinity) è un 400 che NON consuma il budget dei drop elevati", async () => {
      const a = makeGateway("A");
      await Promise.all([a.node.start(), a.webUi.start()]);
      const raw = (kind: string) =>
        authedFetch(a.webUi, "/api/drops", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: `{"text":"x","lat":1,"lon":2,"kind":"${kind}","createdAt":1e999}`,
        });
      for (let i = 0; i < 5; i++) expect((await raw("emergency")).status).toBe(400);
      for (let i = 0; i < 3; i++) expect((await post(a.webUi, { text: "vero " + i, kind: "emergency" })).status).toBe(200);
    });

    it("createdAt non numerico è un 400; NaN dal nodo stesso è un errore", async () => {
      const a = makeGateway("A");
      await Promise.all([a.node.start(), a.webUi.start()]);
      expect((await post(a.webUi, { text: "x", kind: "info", createdAt: "ieri" })).status).toBe(400);
      expect(() => a.node.publishDrop({ text: "x", lat: 1, lon: 2, kind: "info", createdAt: Number.NaN })).toThrow(/createdAt/);
    });
  });
});
