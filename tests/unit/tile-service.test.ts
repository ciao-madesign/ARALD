import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { gzipSync as gz } from "node:zlib";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { TerrariumSampler } from "../../tools/map-data/terrarium.js";
import type { BuildDeps } from "../../tools/map-data/tile-builder.js";
import { TileService, TileServiceError } from "../../tools/map-data/tile-service.js";
import { tilePath } from "../../tools/map-data/tile-cache.js";
import { decodeTile } from "../../tools/scenario-model/geo-tile.js";
import { TILE_HEADER as SERVER_TILE_HEADER, createStaticServer, sameOriginTileRequest } from "../../tools/network-design/serve-lib.mjs";
import { BrowserTileStore, TILE_HEADER as PAGE_TILE_HEADER } from "../../tools/network-design/world-tiles.js";
import { DirTileStore } from "../../tools/map-data/tile-cache.js";
import { MAX_TILES_PER_BOX, tilesForGeoBox, validTile } from "../../tools/scenario-model/geo-tile.js";

function fakeDeps(opts: { fail?: boolean; delayMs?: number; counter?: { n: number } } = {}): BuildDeps {
  const terrarium = new TerrariumSampler(async () => null);
  terrarium.prepare = async () => {
    if (opts.counter) opts.counter.n++;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.fail) throw new Error("rete assente");
  };
  terrarium.sample = () => 120;
  return { terrarium, cover: { async fill() { return { found: false, sources: [] }; } } };
}
const dir = () => mkdtempSync(join(tmpdir(), "arald-tsvc-"));
// tessera in Valle Maira (terra a ~120 m, il suolo manca ma sotto i 20 m non serve: usiamo il mare a quota 0)
const T = { tx: 730, ty: 183 };
const seaDeps = (o = {}): BuildDeps => { const d = fakeDeps(o); d.terrarium.sample = () => 0; return d; };

describe("servizio di tessere", () => {
  it("costruisce una tessera una volta sola e poi la serve dalla cache", async () => {
    const counter = { n: 0 };
    const s = new TileService({ dir: dir(), deps: seaDeps({ counter }) });
    const a = await s.get(T.tx, T.ty);
    expect(a.cached).toBe(false);
    expect(decodeTile(gunzipSync(a.data)).tx).toBe(T.tx);
    const b = await s.get(T.tx, T.ty);
    expect(b.cached).toBe(true);
    expect(counter.n).toBe(1);
    expect(s.status().tiles).toBe(1);
  });

  it("richieste identiche contemporanee condividono una sola costruzione", async () => {
    const counter = { n: 0 };
    const s = new TileService({ dir: dir(), deps: seaDeps({ counter, delayMs: 30 }) });
    await Promise.all([s.get(T.tx, T.ty), s.get(T.tx, T.ty), s.get(T.tx, T.ty)]);
    expect(counter.n).toBe(1);
  });

  it("indici non validi o fuori dal mondo: 404; errore delle fonti: 502 e niente file", async () => {
    const s = new TileService({ dir: dir(), deps: seaDeps({ fail: true }) });
    for (const [x, y] of [[-1, 5], [1440, 5], [5, 720], [5, 2], [1.5, 100], [Number.NaN, 1]]) {
      await expect(s.get(x, y)).rejects.toMatchObject({ status: 404 });
    }
    await expect(s.get(T.tx, T.ty)).rejects.toMatchObject({ status: 502 });
    expect(s.status().tiles).toBe(0);
  });

  it("tetto di tessere nuove all'ora: 429 con il tempo di attesa, poi di nuovo possibile", async () => {
    let t = 1_000_000;
    const s = new TileService({ dir: dir(), deps: seaDeps(), maxNewPerHour: 2, now: () => t });
    await s.get(730, 183);
    await s.get(731, 183);
    const err = await s.get(732, 183).catch((e) => e);
    expect(err).toBeInstanceOf(TileServiceError);
    expect(err.status).toBe(429);
    expect(err.retryAfterS).toBeGreaterThan(0);
    expect((await s.get(730, 183)).cached).toBe(true); // dalla cache non costa nulla
    t += 3_600_001;
    await expect(s.get(732, 183)).resolves.toBeDefined();
  });

  it("coda troppo lunga: 429", async () => {
    const s = new TileService({ dir: dir(), deps: seaDeps({ delayMs: 60 }), concurrency: 1, maxQueue: 1, maxNewPerHour: 100 });
    const results = await Promise.allSettled([730, 731, 732, 733].map((x) => s.get(x, 183)));
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(2);
    expect(results.some((r) => r.status === "rejected" && (r.reason as TileServiceError).status === 429)).toBe(true);
  });

  it("il tetto della cache elimina le tessere meno recenti, mai quelle appena servite", async () => {
    let t = 0;
    const s = new TileService({ dir: dir(), deps: seaDeps(), capBytes: 1, now: () => (t += 60_000) });
    await s.get(730, 183);
    await s.get(731, 183);
    expect(s.status().tiles).toBeLessThanOrEqual(2);
    const again = await s.get(731, 183);
    expect(decodeTile(gunzipSync(again.data)).tx).toBe(731);
  });
});

describe("servizio di tessere: regressioni della revisione", () => {
  it("un fallimento libera il posto, non consuma il tetto orario e si può riprovare", async () => {
    let fail = true;
    const d = seaDeps();
    const prepare = d.terrarium.prepare.bind(d.terrarium);
    d.terrarium.prepare = async (b) => { if (fail) throw new Error("rete assente"); return prepare(b); };
    const s = new TileService({ dir: dir(), deps: d, concurrency: 1, maxNewPerHour: 1 });
    await expect(s.get(730, 183)).rejects.toMatchObject({ status: 502 });
    await expect(s.get(731, 183)).rejects.toMatchObject({ status: 502 });
    fail = false;
    await expect(s.get(730, 183)).resolves.toBeDefined(); // il tetto di 1 non è stato consumato dai fallimenti
    await expect(s.get(731, 183)).rejects.toMatchObject({ status: 429 });
  });

  it("richieste identiche condividono anche l'errore e il posto in elenco viene ripulito", async () => {
    const s = new TileService({ dir: dir(), deps: seaDeps({ fail: true, delayMs: 20 }) });
    const r = await Promise.allSettled([s.get(730, 183), s.get(730, 183)]);
    expect(r.every((x) => x.status === "rejected" && (x.reason as TileServiceError).status === 502)).toBe(true);
    await expect(s.get(730, 183)).rejects.toMatchObject({ status: 502 }); // non resta una promessa vecchia in sospeso
  });

  it("le costruzioni contemporanee non superano il limite", async () => {
    let now = 0, peak = 0;
    const d = seaDeps();
    d.terrarium.prepare = async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 25)); now--; };
    const s = new TileService({ dir: dir(), deps: d, concurrency: 2, maxQueue: 20 });
    await Promise.all([730, 731, 732, 733, 734].map((x) => s.get(x, 183)));
    expect(peak).toBe(2);
  });

  it("la coda piena dà 429 con Retry-After e dopo la coda funziona ancora", async () => {
    const s = new TileService({ dir: dir(), deps: seaDeps({ delayMs: 30 }), concurrency: 1, maxQueue: 0, maxNewPerHour: 100 });
    const [a, b] = await Promise.allSettled([s.get(730, 183), s.get(731, 183)]);
    expect(a.status).toBe("fulfilled");
    expect(b.status === "rejected" && (b.reason as TileServiceError).retryAfterS).toBe(5);
    await expect(s.get(731, 183)).resolves.toBeDefined();
  });

  it("una tessera tempo scaduto libera il posto: 502", async () => {
    const s = new TileService({ dir: dir(), deps: seaDeps({ delayMs: 500 }), buildTimeoutMs: 40, concurrency: 1 });
    await expect(s.get(730, 183)).rejects.toMatchObject({ status: 502 });
    expect(s.status().tiles).toBe(0);
  });

  it("un file corrotto in cache viene eliminato e ricostruito", async () => {
    const d = dir();
    const s = new TileService({ dir: d, deps: seaDeps() });
    await s.get(730, 183);
    writeFileSync(tilePath(d, { tx: 730, ty: 183 }), "non e' gzip");
    const fresh = new TileService({ dir: d, deps: seaDeps() }); // un altro processo: nulla è ancora verificato
    const r = await fresh.get(730, 183);
    expect(r.cached).toBe(false);
    expect(decodeTile(gunzipSync(r.data)).tx).toBe(730);
  });

  it("il tetto elimina le tessere vecchie ma risparmia quella appena servita, anche con raffiche", async () => {
    let t = 1_000_000;
    const d = dir();
    const s = new TileService({ dir: d, deps: seaDeps(), capBytes: 1, now: () => t });
    await s.get(730, 183);
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(tilePath(d, { tx: 730, ty: 183 }), old, old);
    t += 11 * 60_000; // la prima non è più «servita da poco»
    await s.get(731, 183); // costruita subito dopo: la verifica del tetto parte ora
    expect(existsSync(tilePath(d, { tx: 730, ty: 183 }))).toBe(false);
    expect(existsSync(tilePath(d, { tx: 731, ty: 183 }))).toBe(true);
  });

  it("lo stato non rifà la scansione del disco a ogni chiamata", async () => {
    let t = 0;
    const s = new TileService({ dir: dir(), deps: seaDeps(), now: () => t });
    expect(s.status().tiles).toBe(0);
    await s.get(730, 183);
    expect(s.status().tiles).toBe(0); // risposta in cache entro 5 s
    t += 6000;
    expect(s.status().tiles).toBe(1);
  });
});

describe("servizio di tessere: revisione finale", () => {
  it("una costruzione scaduta tiene il posto finché il lavoro non finisce: la concorrenza non supera il limite", async () => {
    let live = 0, peak = 0;
    const d = seaDeps();
    d.terrarium.prepare = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 120)); live--; };
    const s = new TileService({ dir: dir(), deps: d, concurrency: 1, buildTimeoutMs: 40, maxQueue: 5 });
    const first = await s.get(730, 183).catch((e) => e);
    expect(first).toMatchObject({ status: 502 }); // scaduto dopo 40 ms mentre il lavoro sotto dura 120
    await s.get(731, 183).catch(() => undefined); // parte solo dopo la fine del primo lavoro
    expect(peak).toBe(1);
  });

  it("un errore immediato nella creazione delle fonti libera il posto", async () => {
    let n = 0;
    const s = new TileService({ dir: dir(), concurrency: 1, deps: () => { if (n++ === 0) throw new Error("fonti non configurate"); return seaDeps(); } });
    await expect(s.get(730, 183)).rejects.toMatchObject({ status: 502 });
    await expect(s.get(731, 183)).resolves.toBeDefined();
  });

  it("un file danneggiato dopo la prima verifica viene eliminato e ricostruito alla richiesta successiva", async () => {
    const d = dir();
    const s = new TileService({ dir: d, deps: seaDeps() });
    await s.get(730, 183);
    expect((await s.get(730, 183)).cached).toBe(true);
    writeFileSync(tilePath(d, { tx: 730, ty: 183 }), "non e' gzip");
    const r = await s.get(730, 183);
    expect(r.cached).toBe(false);
    expect(decodeTile(gunzipSync(r.data)).tx).toBe(730);
    writeFileSync(tilePath(d, { tx: 730, ty: 183 }), Buffer.alloc(2_500_000, 1)); // dimensione impossibile
    expect((await s.get(730, 183)).cached).toBe(false);
  });

  it("un file della cache che si espande a dismisura non viene decompresso", () => {
    const d = dir();
    const store = new DirTileStore(d);
    const bomb = gz(Buffer.alloc(30_000_000));
    expect(bomb.length).toBeLessThan(100_000);
    mkdirSync(join(d, "183"), { recursive: true });
    writeFileSync(tilePath(d, { tx: 730, ty: 183 }), bomb);
    expect(store.get(730, 183)).toBeUndefined();
    expect(store.isValid({ tx: 730, ty: 183 })).toBe(false);
  });

  it("l'area di una tessera sta tutta entro ±85°; un riquadro enorme viene rifiutato prima di essere elencato", () => {
    expect(validTile({ tx: 0, ty: 19 })).toBe(false); // 85,0°-85,25° nord
    expect(validTile({ tx: 0, ty: 20 })).toBe(true);
    expect(validTile({ tx: 0, ty: 699 })).toBe(true);
    expect(validTile({ tx: 0, ty: 700 })).toBe(false);
    expect(() => tilesForGeoBox({ south: -80, west: -179, north: 80, east: 179 })).toThrow(/troppo esteso/);
    expect(MAX_TILES_PER_BOX).toBe(20_000);
  });

  it("catena completa: BrowserTileStore → server HTTP → TileService → tessera ARTG vera, con un solo nome per l'intestazione", async () => {
    expect(Object.keys(PAGE_TILE_HEADER).map((k) => k.toLowerCase())).toEqual([SERVER_TILE_HEADER]);
    const server = createStaticServer(dir(), new TileService({ dir: dir(), deps: seaDeps() }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const store = new BrowserTileStore(`http://127.0.0.1:${port}/tiles/`, (u, init) => fetch(u, init));
      await store.ensure([{ tx: 730, ty: 183 }, { tx: 731, ty: 183 }]);
      expect(store.get(730, 183)?.tx).toBe(730);
      expect(store.get(731, 183)?.elevation.length).toBe(256 * 256);
      // fuori dal mondo: il 404 del server arriva come errore leggibile
      await expect(new BrowserTileStore(`http://127.0.0.1:${port}/tiles/`, (u, init) => fetch(u, init)).ensure([{ tx: 5, ty: 19 }])).resolves.toBeUndefined(); // già scartata dal controllo di validità del browser
    } finally {
      server.close();
    }
  });
});

describe("server locale: percorso /tiles", () => {
  const servers: { close(): void }[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });

  async function start(tiles?: TileService) {
    const server = createStaticServer(dir(), tiles);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers }));
      });
      req.on("error", reject);
      req.end();
    });
    return { port, get };
  }
  const ok = { "x-arald-tool": "1" };

  it("serve la tessera con l'intestazione della pagina, rifiuta le richieste da altri siti", async () => {
    const { port, get } = await start(new TileService({ dir: dir(), deps: seaDeps() }));
    const r = await get(`/tiles/${T.tx}/${T.ty}`, ok);
    expect(r.status).toBe(200);
    expect(r.headers["x-tile-cache"]).toBe("built");
    expect(decodeTile(gunzipSync(r.body)).ty).toBe(T.ty);
    expect((await get(`/tiles/${T.tx}/${T.ty}`, ok)).headers["x-tile-cache"]).toBe("hit");
    expect((await get(`/tiles/${T.tx}/${T.ty}`)).status).toBe(403); // senza intestazione (un <img> di un altro sito)
    expect((await get(`/tiles/${T.tx}/${T.ty}`, { ...ok, origin: "http://evil.example" })).status).toBe(403);
    expect((await get(`/tiles/${T.tx}/${T.ty}`, { ...ok, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get(`/tiles/${T.tx}/${T.ty}`, { ...ok, origin: `http://127.0.0.1:${port}` })).status).toBe(200);
  });

  it("stato, errori mappati e servizio spento", async () => {
    const { get } = await start(new TileService({ dir: dir(), deps: seaDeps(), maxNewPerHour: 0 }));
    const st = JSON.parse((await get("/tiles/status", ok)).body.toString());
    expect(st.maxNewPerHour).toBe(0);
    const limited = await get(`/tiles/${T.tx}/${T.ty}`, ok);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await get("/tiles/5/2", ok)).status).toBe(404);
    expect((await get("/tiles/abc/2", ok)).status).toBe(404); // non è un percorso di tessere: cade nei file statici
    const off = await start();
    expect((await off.get(`/tiles/${T.tx}/${T.ty}`, ok)).status).toBe(404);
  });

  it("nessuna intestazione CORS, OPTIONS rifiutato, Origin «null», stato senza intestazione, HEAD e percorsi strani", async () => {
    const { port, get } = await start(new TileService({ dir: dir(), deps: seaDeps() }));
    const r = await get(`/tiles/${T.tx}/${T.ty}`, ok);
    expect(Object.keys(r.headers).some((k) => k.startsWith("access-control-"))).toBe(false);
    const opt = await new Promise<number>((res, rej) => {
      const q = httpRequest({ host: "127.0.0.1", port, method: "OPTIONS", path: `/tiles/${T.tx}/${T.ty}`, headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example", "access-control-request-headers": "x-arald-tool" } }, (x) => { x.resume(); res(x.statusCode!); });
      q.on("error", rej); q.end();
    });
    expect(opt).toBe(405);
    expect((await get(`/tiles/${T.tx}/${T.ty}`, { ...ok, origin: "null" })).status).toBe(403);
    expect((await get("/tiles/status")).status).toBe(403);
    expect((await get(`/tiles/${T.tx}/${T.ty}?x=1`, ok)).status).toBe(200);
    expect((await get("/tiles/status/x", ok)).status).not.toBe(200); // non è un percorso del servizio
  });

  it("un errore imprevisto non rivela dettagli", async () => {
    const boom = { get: async () => { throw Object.assign(new Error("ENOENT /home/segreto/file"), { status: 418 }); }, status: () => ({}) };
    const { get } = await start(boom as unknown as TileService);
    const r = await get(`/tiles/${T.tx}/${T.ty}`, ok);
    expect(r.status).toBe(500);
    expect(r.body.toString()).not.toContain("segreto");
  });

  it("sameOriginTileRequest", () => {
    expect(sameOriginTileRequest({ "x-arald-tool": "1", host: "h" })).toBe(true);
    expect(sameOriginTileRequest({ host: "h" })).toBe(false);
    expect(sameOriginTileRequest({ "x-arald-tool": "1", host: "h", origin: "http://h", "sec-fetch-site": "same-origin" })).toBe(true);
    expect(sameOriginTileRequest({ "x-arald-tool": "1", host: "h", origin: "http://x" })).toBe(false);
  });
});
