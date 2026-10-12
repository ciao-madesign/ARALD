import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeoCoverAccumulator } from "../../tools/map-data/geo-cover.js";
import { decodePng } from "../../tools/map-data/png.js";
import { TERRARIUM_ZOOM, TerrariumSampler, decodeTerrarium, mercatorPixel, terrariumUrl } from "../../tools/map-data/terrarium.js";
import { type BuildDeps, buildTile, ensureTiles, networkTerrariumFetcher } from "../../tools/map-data/tile-builder.js";
import { DEFAULT_CACHE_CAP_BYTES, DirTileStore, defaultCacheDir, enforceCap, listCache, tilePath } from "../../tools/map-data/tile-cache.js";
import { DEFAULT_MARGIN_M, configBounds, configWarnings, loadWorldTerrain, requiredTiles } from "../../tools/map-data/world.js";
import {
  CELL_DEG, type GeoTile, TILES_X, TILES_Y, TILE_CELLS, TileTerrain, areaWarnings, decodeTile, encodeTile, tileBounds, tileKey, tileOf, tilesForGeoBox, tilesForLocalBounds, validTile,
} from "../../tools/scenario-model/geo-tile.js";
import { parseNetworkConfig } from "../../tools/scenario-model/network-config.js";

const N = TILE_CELLS * TILE_CELLS;
function tile(tx: number, ty: number, elev: (r: number, c: number) => number = () => 100, cover: (r: number, c: number) => number = () => 1): GeoTile {
  const elevation = new Int16Array(N);
  const cov = new Uint8Array(N);
  for (let r = 0; r < TILE_CELLS; r++) for (let c = 0; c < TILE_CELLS; c++) { elevation[r * TILE_CELLS + c] = elev(r, c); cov[r * TILE_CELLS + c] = cover(r, c); }
  return { tx, ty, sources: ["test"], elevation, cover: cov };
}
class MemStore { constructor(readonly tiles: Map<string, GeoTile>) {} get(tx: number, ty: number): GeoTile | undefined { return this.tiles.get(`${tx}_${ty}`); } }
const tmp = () => mkdtempSync(join(tmpdir(), "arald-tiles-"));

describe("griglia del mondo: indici e limiti", () => {
  it("la tessera di un punto, i suoi limiti e il giro di longitudine", () => {
    const t = tileOf(44.49, 6.93);
    const b = tileBounds(t);
    expect(b.south).toBeLessThanOrEqual(44.49); expect(b.north).toBeGreaterThan(44.49);
    expect(b.west).toBeLessThanOrEqual(6.93); expect(b.east).toBeGreaterThan(6.93);
    expect(b.north - b.south).toBeCloseTo(0.25, 10);
    expect(tileOf(10, 190)).toEqual(tileOf(10, -170)); // la longitudine si riporta in [-180, 180)
    expect(tileOf(0, 0)).toEqual({ tx: TILES_X / 2, ty: TILES_Y / 2 });
    expect(CELL_DEG * 1024).toBe(1); // 2^-10: esatta
  });

  it("tessere valide solo dentro i limiti di latitudine e di indice", () => {
    expect(validTile({ tx: 0, ty: 100 })).toBe(true);
    expect(validTile({ tx: -1, ty: 100 })).toBe(false);
    expect(validTile({ tx: TILES_X, ty: 100 })).toBe(false);
    expect(validTile({ tx: 0, ty: 0 })).toBe(false); // polo nord
    expect(validTile({ tx: 0, ty: TILES_Y - 1 })).toBe(false);
    expect(validTile({ tx: 1.5, ty: 100 })).toBe(false);
    expect(tileKey({ tx: 3, ty: 4 })).toBe("3_4");
  });

  it("tessere di un riquadro, senza dimenticarne ai bordi né includerne fuori limite", () => {
    const one = tilesForGeoBox({ south: 44.01, west: 7.01, north: 44.2, east: 7.2 });
    expect(one).toHaveLength(1);
    const four = tilesForGeoBox({ south: 44.2, west: 7.2, north: 44.3, east: 7.3 });
    expect(four).toHaveLength(4);
    expect(tilesForGeoBox({ south: 84, west: 0, north: 89, east: 0.1 }).every(validTile)).toBe(true);
    expect(() => tilesForGeoBox({ south: 5, west: 0, north: 1, east: 1 })).toThrow(/non valido/);
    const frame = { lat0: 44.45, lon0: 6.95 };
    expect(tilesForLocalBounds(frame, { minX: -100, maxX: 100, minY: -100, maxY: 100 }, 0).length).toBeGreaterThanOrEqual(1);
    expect(tilesForLocalBounds(frame, { minX: -100, maxX: 100, minY: -100, maxY: 100 }, 30_000).length).toBeGreaterThan(4);
  });
});

describe("formato della tessera", () => {
  it("scrittura e lettura restituiscono gli stessi dati, anche con salti di quota a 16 bit", () => {
    const t = tile(720, 100, (r, c) => (c % 2 ? 32767 : 0) + (r === 3 ? -5 : 0), (r, c) => (r + c) % 5);
    const back = decodeTile(encodeTile(t));
    expect(back.tx).toBe(720); expect(back.ty).toBe(100); expect(back.sources).toEqual(["test"]);
    expect([...back.elevation]).toEqual([...t.elevation]);
    expect([...back.cover]).toEqual([...t.cover]);
  });

  it("rifiuta tessere incoerenti o non fidate", () => {
    const good = encodeTile(tile(720, 100));
    expect(() => decodeTile(new Uint8Array([1, 2, 3]))).toThrow(/Non è una tessera/);
    expect(() => decodeTile(good.slice(0, good.length - 1))).toThrow(/troncata/);
    const bad = good.slice(); bad[bad.length - 1] = 9;
    expect(() => decodeTile(bad)).toThrow(/classe/);
    expect(() => encodeTile({ ...tile(720, 100), elevation: new Int16Array(10) })).toThrow(/incoerente/);
    const enc = (h: object) => { const head = new TextEncoder().encode(JSON.stringify(h)); const o = new Uint8Array(8 + head.length + 3 * N); o.set([0x41, 0x52, 0x54, 0x47]); new DataView(o.buffer).setUint32(4, head.length, true); o.set(head, 8); return o; };
    expect(() => decodeTile(enc({ version: 1, tx: 5, ty: 0 }))).toThrow(/Indice/);
    expect(() => decodeTile(enc({ version: 2, tx: 5, ty: 100 }))).toThrow(/Versione/);
    expect(() => decodeTile(enc({ version: 1, tx: "5", ty: 100 }))).toThrow(/Indice/);
    expect(decodeTile(enc({ version: 1, tx: 5, ty: 100, sources: [1, "a"] })).sources).toEqual(["a"]);
  });
});

describe("TileTerrain", () => {
  const frame = { lat0: 44.12, lon0: 7.12 };
  const tx = tileOf(frame.lat0, frame.lon0);
  it("quota e suolo dalla cella che contiene il punto; il terreno è continuo a cavallo di due tessere", () => {
    // rampa ovest-est continua su due tessere affiancate: quota = 1000 * (longitudine - 7)
    const ramp = (t: { tx: number }) => (_r: number, c: number) => Math.round(1000 * ((-180 + (t.tx * TILE_CELLS + c + 0.5) * CELL_DEG) - 7));
    const store = new MemStore(new Map([[tileKey(tx), tile(tx.tx, tx.ty, ramp(tx))], [tileKey({ tx: tx.tx + 1, ty: tx.ty }), tile(tx.tx + 1, tx.ty, ramp({ tx: tx.tx + 1 }))]]));
    const t = new TileTerrain(frame, store);
    const east = tileBounds({ tx: tx.tx, ty: tx.ty }).east; // bordo tra le due tessere
    const xAt = (lon: number) => (lon - frame.lon0) * 111_320 * Math.cos((frame.lat0 * Math.PI) / 180);
    const e0 = t.elevationAt(xAt(east - 0.0005), 0);
    const e1 = t.elevationAt(xAt(east), 0);
    const e2 = t.elevationAt(xAt(east + 0.0005), 0);
    expect(e0).toBeLessThan(e1); expect(e1).toBeLessThan(e2);
    expect(Math.abs(e1 - 1000 * (east - 7))).toBeLessThan(1.5);
    expect(t.missingTiles()).toEqual([]);
    expect(t.landCoverAt(0, 0)).toBe("open");
    expect(t.contains(0, 0)).toBe(true);
  });

  it("una tessera mancante dà quota 0 e mare, ed è registrata; i valori non numerici non rompono nulla", () => {
    const t = new TileTerrain(frame, new MemStore(new Map()));
    expect(t.elevationAt(0, 0)).toBe(0);
    expect(t.landCoverAt(0, 0)).toBe("sea");
    expect(t.contains(0, 0)).toBe(false);
    expect(t.missingTiles().map(tileKey)).toContain(tileKey(tx));
    t.clearMissing();
    expect(t.missingTiles()).toEqual([]);
    expect(t.elevationAt(NaN, 0)).toBe(0);
    expect(t.landCoverAt(0, NaN)).toBe("sea");
    expect(t.elevationAt(0, 1e12)).toBe(0); // latitudine impossibile
  });

  it("ai bordi di una tessera si usano i campioni disponibili, senza buchi", () => {
    const store = new MemStore(new Map([[tileKey(tx), tile(tx.tx, tx.ty, () => 500)]]));
    const t = new TileTerrain(frame, store);
    const b = tileBounds(tx);
    const xEdge = ((b.east - 1e-6) - frame.lon0) * 111_320 * Math.cos((frame.lat0 * Math.PI) / 180);
    expect(t.elevationAt(xEdge, 0)).toBeCloseTo(500, 3); // il vicino manca: vale la cella che c'è
    expect(t.missingTiles().length).toBeGreaterThan(0);
  });

  it("avvisi sulla qualità: oltre 60° di latitudine, oltre 85° e area troppo larga", () => {
    const f = { lat0: 45, lon0: 7 };
    expect(areaWarnings({ south: 44, west: 6, north: 46, east: 8 }, f)).toEqual([]);
    expect(areaWarnings({ south: 59, west: 6, north: 62, east: 8 }, f).join(" ")).toMatch(/60°/);
    expect(areaWarnings({ south: 80, west: 6, north: 86, east: 8 }, f).join(" ")).toMatch(/85°/);
    expect(areaWarnings({ south: 40, west: 0, north: 48, east: 20 }, f).join(" ")).toMatch(/300 km/);
  });
});

function png(width: number, height: number, channels: 3 | 4, pixel: (x: number, y: number, c: number) => number, filter: number): Uint8Array {
  const stride = width * channels;
  const img = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) img[y * stride + x * channels + c] = pixel(x, y, c) & 255;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const cur = img[y * stride + i];
      const a = i >= channels ? img[y * stride + i - channels] : 0;
      const b = y > 0 ? img[(y - 1) * stride + i] : 0;
      const cc = i >= channels && y > 0 ? img[(y - 1) * stride + i - channels] : 0;
      let pred = 0;
      if (filter === 1) pred = a; else if (filter === 2) pred = b; else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - cc; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
      raw[y * (stride + 1) + 1 + i] = (cur - pred) & 255;
    }
  }
  const z = deflateSync(raw);
  const chunk = (type: string, data: Uint8Array) => { const o = new Uint8Array(12 + data.length); new DataView(o.buffer).setUint32(0, data.length); o.set(new TextEncoder().encode(type), 4); o.set(data, 8); return o; };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, width); dv.setUint32(4, height); ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 6;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe("PNG e quote Terrarium", () => {
  it("decodifica RGB e RGBA con tutti e cinque i filtri", () => {
    const px = (x: number, y: number, c: number) => x * 7 + y * 13 + c * 29 + (x * y) % 11;
    for (const filter of [0, 1, 2, 3, 4]) for (const ch of [3, 4] as const) {
      const d = decodePng(png(9, 7, ch, px, filter));
      expect(d.width).toBe(9); expect(d.height).toBe(7); expect(d.channels).toBe(ch);
      for (let y = 0; y < 7; y++) for (let x = 0; x < 9; x++) for (let c = 0; c < ch; c++) expect(d.data[(y * 9 + x) * ch + c]).toBe(px(x, y, c) & 255);
    }
  });

  it("rifiuta PNG non validi, non supportati o troncati", () => {
    expect(() => decodePng(new Uint8Array(40))).toThrow(/Non è un PNG/);
    const good = png(4, 4, 3, () => 1, 0);
    expect(() => decodePng(good.slice(0, 40))).toThrow();
    const gray = good.slice(); gray[8 + 8 + 9] = 0; // tipo di colore: scala di grigi
    expect(() => decodePng(gray)).toThrow(/non supportato/);
    const huge = good.slice(); new DataView(huge.buffer).setUint32(16, 100_000);
    expect(() => decodePng(huge)).toThrow(/dimensioni/);
  });

  it("la quota Terrarium è R·256 + G + B/256 − 32768", () => {
    const side = 256;
    const f = decodeTerrarium(png(side, side, 3, (x, _y, c) => (x === 1 ? [131, 232, 128][c] : [128, 0, 0][c]), 0));
    expect(f[0]).toBe(0);
    expect(f[1]).toBe(3 * 256 + 232 + 0.5 - 0); // 131*256+232+0.5-32768 = 1000.5
    expect(f[1]).toBeCloseTo(1000.5, 6);
    expect(() => decodeTerrarium(png(8, 8, 3, () => 0, 0))).toThrow(/256/);
  });

  it("proiezione di Mercatore e indirizzi", () => {
    const o = mercatorPixel(0, 0, 0);
    expect(o.px).toBeCloseTo(128, 6); expect(o.py).toBeCloseTo(128, 6);
    const z = mercatorPixel(0, 0, TERRARIUM_ZOOM);
    expect(z.px).toBeCloseTo(131072, 4); expect(z.py).toBeCloseTo(131072, 4);
    expect(mercatorPixel(10, 190, 3).px).toBeCloseTo(mercatorPixel(10, -170, 3).px, 6);
    expect(Number.isFinite(mercatorPixel(90, 0, 5).py)).toBe(true);
    expect(terrariumUrl(10, 545, 373)).toBe("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/545/373.png");
  });

  it("il campionatore interpola tra pixel e tra tessere, e restituisce null dove manca il dato", async () => {
    // quota = pixel x globale (rampa) su un mondo di 2×2 tessere a zoom 1
    const fetchTile = vi.fn(async (_z: number, x: number, y: number) => (x === 1 && y === 1 ? null : Float32Array.from({ length: 256 * 256 }, (_, i) => x * 256 + (i % 256))));
    const s = new TerrariumSampler(fetchTile, 1);
    await s.prepare({ south: -10, west: -10, north: 10, east: 10 });
    const v = s.sample(5, -0.3); // vicino al confine tra le tessere 0 e 1 in x
    expect(v).not.toBeNull();
    const a = mercatorPixel(5, -0.3, 1);
    expect(v!).toBeCloseTo(a.px - 0.5, 0);
    expect(s.sample(-40, 100)).toBeNull(); // tessera (1,1) assente
    expect(fetchTile.mock.calls.length).toBeLessThanOrEqual(4);
    const again = fetchTile.mock.calls.length;
    await s.prepare({ south: -10, west: -10, north: 10, east: 10 });
    expect(fetchTile.mock.calls.length).toBe(again); // già in cache
  });
});

describe("uso del suolo sulla griglia geografica", () => {
  it("assegna i pixel alla cella giusta, ignora quelli fuori dalla tessera, acqua se vuota", () => {
    const t = { tx: 720, ty: 100 };
    const b = tileBounds(t);
    const acc = new GeoCoverAccumulator(t);
    const lon = (c: number) => b.west + (c + 0.5) * CELL_DEG;
    const lat = (r: number) => b.north - (r + 0.5) * CELL_DEG;
    acc.addStrip([50, 10], 2, 1, [lon(0), lon(1)], [lat(0)]); // costruito, alberi
    acc.addStrip([30], 1, 1, [lon(0)], [lat(1)]); // prato
    acc.addStrip([10], 1, 1, [b.west - 1], [lat(0)]); // fuori (ovest)
    acc.addStrip([10], 1, 1, [lon(0)], [b.north + 1]); // fuori (nord)
    const cls = acc.toClasses();
    expect(cls[0]).toBe(4); // abitato denso
    expect(cls[1]).toBe(2); // bosco
    expect(cls[TILE_CELLS]).toBe(1); // aperto
    expect(cls[5]).toBe(0); // nessun pixel: acqua
  });
});

describe("cache su disco", () => {
  it("scrive e rilegge tessere, ignora file illeggibili o nel posto sbagliato", () => {
    const dir = tmp();
    const s = new DirTileStore(dir);
    const t = tile(720, 100, (r, c) => r + c);
    expect(s.has(t)).toBe(false);
    s.put(t);
    expect(s.has(t)).toBe(true);
    const fresh = new DirTileStore(dir).get(720, 100)!;
    expect([...fresh.elevation]).toEqual([...t.elevation]);
    expect(new DirTileStore(dir).get(721, 100)).toBeUndefined();
    writeFileSync(tilePath(dir, { tx: 722, ty: 100 }), "non gzip");
    expect(new DirTileStore(dir).get(722, 100)).toBeUndefined();
    mkdirSync(join(dir, "101"), { recursive: true });
    writeFileSync(join(dir, "101", "723.tile.gz"), readFileSync(tilePath(dir, { tx: 720, ty: 100 }))); // tessera 720,100 salvata come 723,101
    expect(new DirTileStore(dir).get(723, 101)).toBeUndefined();
    expect(() => tilePath(dir, { tx: 0, ty: 0 })).toThrow(/non valida/);
    expect(new DirTileStore(dir).get(0, 0)).toBeUndefined();
  });

  it("il tetto elimina le tessere meno recenti, protegge quelle richieste e non fa nulla sotto il tetto", () => {
    const dir = tmp();
    const s = new DirTileStore(dir);
    const tiles = [720, 721, 722, 723].map((x) => tile(x, 100, (r, c) => ((r * 31 + c * 17 + x) % 2000)));
    tiles.forEach((t, i) => { s.put(t); const when = new Date(2026, 0, 1 + i); utimesSync(tilePath(dir, t), when, when); });
    const total = listCache(dir).reduce((n, f) => n + f.bytes, 0);
    expect(enforceCap(dir, total)).toBe(0);
    const protect = new Set([tilePath(dir, tiles[0])]); // la più vecchia è protetta
    const removed = enforceCap(dir, total / 2, protect);
    expect(removed).toBeGreaterThan(0);
    expect(existsSync(tilePath(dir, tiles[0]))).toBe(true);
    expect(existsSync(tilePath(dir, tiles[1]))).toBe(false); // la più vecchia non protetta se n'è andata per prima
    expect(DEFAULT_CACHE_CAP_BYTES).toBe(1_500_000_000);
  });

  it("cartella predefinita: ARALD_TILE_CACHE, poi la cache dell'utente", () => {
    expect(defaultCacheDir({ ARALD_TILE_CACHE: "/x/y" } as NodeJS.ProcessEnv, "/home/u")).toBe("/x/y");
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/c" } as NodeJS.ProcessEnv, "/home/u")).toBe(join("/c", "arald-design-tool", "tiles"));
    expect(defaultCacheDir({} as NodeJS.ProcessEnv, "/home/u")).toBe(join("/home/u", ".cache", "arald-design-tool", "tiles"));
  });
});

describe("costruzione delle tessere (fonti simulate)", () => {
  const sampler = (f: (lat: number, lon: number) => number | null): TerrariumSampler => {
    const s = new TerrariumSampler(async () => null);
    s.prepare = async () => undefined;
    s.sample = (lat, lon) => f(lat, lon);
    return s;
  };
  const cover = (found: boolean, code = 30) => ({
    async fill(t: { tx: number; ty: number }, acc: GeoCoverAccumulator) {
      if (!found) return { found: false, sources: [] };
      const b = tileBounds(t);
      const lons = Array.from({ length: TILE_CELLS }, (_, c) => b.west + (c + 0.5) * CELL_DEG);
      const lats = Array.from({ length: TILE_CELLS }, (_, r) => b.north - (r + 0.5) * CELL_DEG);
      acc.addStrip(new Array(N).fill(code), TILE_CELLS, TILE_CELLS, lons, lats);
      return { found: true, sources: ["x"] };
    },
  });

  it("quota campionata, fondali portati a 0, suolo dalla fonte, attribuzioni nei dati", async () => {
    const deps: BuildDeps = { terrarium: sampler((lat) => (lat > 44.1 ? 850.4 : -300)), cover: cover(true, 10) };
    const t = await buildTile({ tx: 748, ty: 183 }, deps); // 44,0°–44,25° N, 7,0°–7,25° E: la soglia a 44,1° cade dentro
    expect(t.elevation[0]).toBe(850); // prima riga: a nord della soglia
    expect(t.elevation[(TILE_CELLS - 1) * TILE_CELLS]).toBe(0); // ultima riga: fondale portato a 0
    expect(Math.min(...t.elevation)).toBe(0);
    expect(Math.max(...t.elevation)).toBe(850);
    expect(new Set(t.cover)).toEqual(new Set([2])); // alberi → bosco
    expect(t.sources.join(" ")).toMatch(/Terrarium/);
    expect(t.sources.join(" ")).toMatch(/WorldCover/);
  });

  it("senza uso del suolo è mare solo se non c'è terra: con terra emersa è un errore, mai una tessera piatta", async () => {
    const sea = await buildTile({ tx: 720, ty: 100 }, { terrarium: sampler(() => -50), cover: cover(false) });
    expect(new Set(sea.cover)).toEqual(new Set([0]));
    expect(sea.sources.join(" ")).not.toMatch(/WorldCover/);
    await expect(buildTile({ tx: 720, ty: 100 }, { terrarium: sampler(() => 300), cover: cover(false) })).rejects.toThrow(/terra emersa/);
    await expect(buildTile({ tx: 0, ty: 0 }, { terrarium: sampler(() => 0), cover: cover(true) })).rejects.toThrow(/non valida/);
  });

  it("quote assenti dove il suolo dice che c'è terra (rete bloccata) è un errore, non una tessera piatta", async () => {
    await expect(buildTile({ tx: 748, ty: 183 }, { terrarium: sampler(() => null), cover: cover(true, 30) })).rejects.toThrow(/mancano le quote/);
    // mare aperto davvero (suolo = acqua): nessun dato di quota è normale
    const sea = await buildTile({ tx: 748, ty: 183 }, { terrarium: sampler(() => null), cover: cover(true, 80) });
    expect(Math.max(...sea.elevation)).toBe(0);
  });

  it("ensureTiles costruisce solo le mancanti, rispetta il tetto e non lascia tessere a metà se una fallisce", async () => {
    const dir = tmp();
    const store = new DirTileStore(dir);
    let calls = 0;
    const deps: BuildDeps = { terrarium: sampler(() => { calls++; return 10; }), cover: cover(true) };
    const list = [720, 721, 722].map((tx) => ({ tx, ty: 100 }));
    store.put(tile(720, 100));
    const progress: number[] = [];
    const r = await ensureTiles(list, store, deps, { concurrency: 2, onProgress: (d) => progress.push(d) });
    expect(r).toEqual({ cached: 1, built: 2 });
    expect(progress).toEqual([1, 2]);
    await expect(ensureTiles([{ tx: 730, ty: 100 }, { tx: 731, ty: 100 }], store, deps, { maxNew: 1 })).rejects.toThrow(/massimo 1/);
    expect(store.has({ tx: 730, ty: 100 })).toBe(false);
    const failing: BuildDeps = { terrarium: sampler((lat) => { if (lat < tileBounds({ tx: 741, ty: 100 }).north - 0.1) throw new Error("rete caduta"); return 1; }), cover: cover(true) };
    await expect(ensureTiles([{ tx: 741, ty: 100 }], store, failing)).rejects.toThrow(/rete caduta/);
    expect(store.has({ tx: 741, ty: 100 })).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });
});

describe("scarico di una tessera Terrarium", () => {
  afterEach(() => vi.unstubAllGlobals());
  const okPng = png(256, 256, 3, (_x, _y, c) => [128, 0, 0][c], 0);
  const resp = (status: number, body?: Uint8Array) => ({ status, ok: status >= 200 && status < 300, arrayBuffer: async () => body!.buffer.slice(body!.byteOffset, body!.byteOffset + body!.byteLength) });

  it("riprova dopo un errore e propaga ogni risposta non valida, 404 e 403 compresi", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      let n = 0;
      vi.stubGlobal("fetch", vi.fn(async () => (++n < 3 ? resp(503) : resp(200, okPng))));
      const p = networkTerrariumFetcher()(10, 1, 2);
      await vi.runAllTimersAsync();
      expect((await p)![0]).toBe(0);
      expect(n).toBe(3);
      for (const status of [404, 403, 500]) {
        vi.stubGlobal("fetch", vi.fn(async () => resp(status)));
        const q = networkTerrariumFetcher()(10, 1, 2);
        const assertion = expect(q).rejects.toThrow(new RegExp(String(status)));
        await vi.runAllTimersAsync();
        await assertion;
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("WorldCover: solo un 404 con la firma di S3 vale «nessun dato»; 403 o 404 di un proxy sono errori", async () => {
    const r = (status: number, server?: string) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(server ? { server } : {}), arrayBuffer: async () => new ArrayBuffer(1) });
    const { probeWorldCover } = await import("../../tools/map-data/worldcover-source.js");
    expect(await probeWorldCover("u", (async () => r(404, "AmazonS3")) as unknown as typeof fetch)).toBe(false);
    expect(await probeWorldCover("u", (async () => r(206)) as unknown as typeof fetch)).toBe(true);
    await expect(probeWorldCover("u", (async () => r(404)) as unknown as typeof fetch)).rejects.toThrow(/404/);
    await expect(probeWorldCover("u", (async () => r(403, "AmazonS3")) as unknown as typeof fetch)).rejects.toThrow(/403/);
  });
});

describe("regressioni della revisione sulle tessere del mondo", () => {
  it("tilesForGeoBox a cavallo dell'antimeridiano prende entrambi i lati senza duplicati", () => {
    const t = tilesForGeoBox({ south: 10, west: 179.6, north: 10.1, east: 180.4 });
    const xs = new Set(t.map((x) => x.tx));
    expect(xs.has(TILES_X - 1)).toBe(true);
    expect(xs.has(0)).toBe(true);
    expect(new Set(t.map((x) => `${x.tx}_${x.ty}`)).size).toBe(t.length);
    expect(() => tilesForGeoBox({ south: 0, west: -180, north: 1, east: 180 })).toThrow(/largo/);
  });

  it("il campionatore Terrarium carica le tessere dei due lati dell'antimeridiano e rifiuta una tessera non caricata", async () => {
    const seen: string[] = [];
    const sampler = new TerrariumSampler(async (z, x, y) => { seen.push(`${x}/${y}`); return new Float32Array(256 * 256).fill(7); });
    await sampler.prepare({ south: 10, west: 179.99, north: 10.01, east: -179.99 });
    const xs = new Set(seen.map((k) => Number(k.split("/")[0])));
    expect(xs.has(0)).toBe(true);
    expect(xs.has(2 ** TERRARIUM_ZOOM - 1)).toBe(true);
    expect(sampler.sample(10, 179.999)).toBeCloseTo(7, 5);
    const lazy = new TerrariumSampler(async () => null);
    expect(() => lazy.sample(10, 10)).toThrow(/non caricata/);
  });

  it("un file corrotto non è valido: viene eliminato e ricordato come assente", () => {
    const dir = tmp();
    const store = new DirTileStore(dir);
    store.put(tile(730, 183));
    const fresh = new DirTileStore(dir);
    expect(fresh.isValid({ tx: 730, ty: 183 })).toBe(true);
    writeFileSync(tilePath(dir, { tx: 730, ty: 183 }), "non e' gzip");
    const other = new DirTileStore(dir);
    expect(other.has({ tx: 730, ty: 183 })).toBe(true);
    expect(other.isValid({ tx: 730, ty: 183 })).toBe(false);
    expect(other.has({ tx: 730, ty: 183 })).toBe(false);
    expect(other.get(730, 183)).toBeUndefined();
  });

  it("listCache ignora i file spariti e toglie i .part vecchi", () => {
    const dir = tmp();
    const store = new DirTileStore(dir);
    store.put(tile(730, 183));
    const part = tilePath(dir, { tx: 731, ty: 183 }) + ".1.part";
    writeFileSync(part, "x");
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(part, old, old);
    expect(listCache(dir)).toHaveLength(1);
    expect(existsSync(part)).toBe(false);
  });

  it("ensureTiles: dopo un errore nessun'altra tessera viene scritta", async () => {
    const dir = tmp();
    const store = new DirTileStore(dir);
    const tiles = [0, 1, 2, 3, 4, 5].map((i) => ({ tx: 730 + i, ty: 183 }));
    let calls = 0;
    const terrarium = new TerrariumSampler(async () => null);
    terrarium.prepare = async () => { calls++; if (calls === 1) throw new Error("rete"); await new Promise((r) => setTimeout(r, 30)); };
    terrarium.sample = () => 10;
    const deps: BuildDeps = { terrarium, cover: { async fill() { return { found: false, sources: [] }; } } };
    await expect(ensureTiles(tiles, store, deps, { concurrency: 3 })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 150));
    expect(tiles.filter((t) => store.has(t))).toHaveLength(0);
  });
});

describe("terreno del mondo per una configurazione", () => {
  const cfg = parseNetworkConfig({
    version: 1, name: "t", frame: { lat0: 44.45, lon0: 6.95 }, environment: "tipico", regulatory: "g3", terrain: "world",
    devices: [{ id: "A", kind: "box", lat: 44.45, lon: 6.95 }, { id: "B", kind: "card", lat: 44.5, lon: 7.0, route: [{ tS: 0, lat: 44.5, lon: 7.0 }, { tS: 60, lat: 44.6, lon: 7.1 }] }],
  });

  it("il riquadro comprende i dispositivi e i punti dei percorsi; le tessere crescono con il margine", () => {
    const b = configBounds(cfg);
    expect(b.maxY).toBeGreaterThan(10_000); // 44,6° è ~16 km a nord dell'origine
    expect(requiredTiles(cfg, 0).length).toBeGreaterThanOrEqual(1);
    expect(requiredTiles(cfg, DEFAULT_MARGIN_M).length).toBeGreaterThan(requiredTiles(cfg, 0).length);
    expect(configBounds({ ...cfg, devices: [] }).minX).toBe(0);
  });

  it("loadWorldTerrain elenca le tessere mancanti e funziona appena ci sono", () => {
    const dir = tmp();
    const w = loadWorldTerrain(cfg, dir, 0);
    expect(w.missing.length).toBe(requiredTiles(cfg, 0).length);
    for (const t of requiredTiles(cfg, 0)) w.store.put(tile(t.tx, t.ty, () => 1234));
    const w2 = loadWorldTerrain(cfg, dir, 0);
    expect(w2.missing).toEqual([]);
    expect(w2.terrain).toBeInstanceOf(TileTerrain);
    expect(w2.terrain.elevationAt(0, 0)).toBeCloseTo(1234, 3);
  });

  it("avvisi per un'area ad alta latitudine o molto larga", () => {
    expect(configWarnings(cfg)).toEqual([]);
    const north = parseNetworkConfig({ version: 1, name: "t", frame: { lat0: 68, lon0: 20 }, environment: "tipico", regulatory: "g3", devices: [{ id: "A", kind: "box", lat: 68, lon: 20 }] });
    expect(configWarnings(north).join(" ")).toMatch(/60°/);
  });

  it("il CLI con terreno «world»: errore chiaro senza tessere, risultati con le tessere in cache", () => {
    const dir = tmp();
    const cfgFile = join(dir, "cfg.json");
    writeFileSync(cfgFile, JSON.stringify({ ...cfg, devices: cfg.devices.map((d) => ({ id: d.id, kind: d.kind, lat: d.lat, lon: d.lon })) }));
    const cache = join(dir, "cache");
    const run = (): { code: number; out: string } => {
      try { return { code: 0, out: execFileSync("npx", ["tsx", "tools/scenario-model/cli.ts", "--config", cfgFile], { env: { ...process.env, ARALD_TILE_CACHE: cache }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
      catch (e) { const x = e as { status: number; stderr: string }; return { code: x.status, out: x.stderr }; }
    };
    const missing = run();
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/Mancano \d+ tessere/);
    expect(missing.out).toMatch(/npm run map-tiles/);
    const store = new DirTileStore(cache);
    for (const t of requiredTiles({ ...cfg, devices: cfg.devices.map((d) => ({ ...d, route: undefined })) })) store.put(tile(t.tx, t.ty, () => 800));
    const ok = run();
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/Mondo \(tessere/);
  }, 120_000);
});
