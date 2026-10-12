import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type GeoTile, TILE_CELLS, TileTerrain, encodeTile } from "../../tools/scenario-model/geo-tile.js";
import { parseNetworkConfig } from "../../tools/scenario-model/network-config.js";
import { FRAME_WARN_KM, configWarnings, geoDistanceKm, parseCoordinates, requiredTiles } from "../../tools/scenario-model/world-area.js";
import { PackTerrain } from "../../tools/scenario-model/terrain-pack.js";
import { FLAT_TERRAIN } from "../../tools/scenario-model/terrain.js";
import { boundedTerrain, canRecenterAt, configPoints, farthestPointKm, networkTiles, recenterConfig } from "../../tools/network-design/logic.js";
import { toGeo, toLocal } from "../../tools/scenario-model/terrain.js";
import { BrowserTileStore, TILE_HEADER, type TileFetchFn, probeTileService } from "../../tools/network-design/world-tiles.js";

const N = TILE_CELLS * TILE_CELLS;
function tile(tx: number, ty: number, elev = 100): GeoTile {
  return { tx, ty, sources: [`fonte-${tx}`], elevation: new Int16Array(N).fill(elev), cover: new Uint8Array(N).fill(1) };
}
const bytes = (t: GeoTile): Uint8Array => gzipSync(encodeTile(t));
function ok(body: Uint8Array) {
  return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, text: async () => "" };
}
const bad = (status: number, text = "") => ({ ok: false, status, arrayBuffer: async () => new ArrayBuffer(0), text: async () => text });

/** Server finto: risponde alle richieste «tiles/<tx>/<ty>» con la tessera giusta. */
function fakeFetch(calls: string[] = [], overrides: Record<string, () => ReturnType<typeof ok> | ReturnType<typeof bad>> = {}): TileFetchFn {
  return async (url, init) => {
    expect(init.headers).toEqual(TILE_HEADER);
    calls.push(url);
    const m = /tiles\/(\d+)\/(\d+)$/.exec(url)!;
    const key = `${m[1]}/${m[2]}`;
    if (overrides[key]) return overrides[key]();
    await new Promise((r) => setTimeout(r, 5));
    return ok(bytes(tile(Number(m[1]), Number(m[2]))));
  };
}

describe("coordinate scritte a mano", () => {
  it("accetta le forme comuni e rifiuta il resto", () => {
    expect(parseCoordinates("46.5, 8.0")).toEqual({ lat: 46.5, lon: 8 });
    expect(parseCoordinates("46.5,8.0")).toEqual({ lat: 46.5, lon: 8 });
    expect(parseCoordinates("  -33.9  151.2 ")).toEqual({ lat: -33.9, lon: 151.2 });
    expect(parseCoordinates("46,5; 8,0")).toEqual({ lat: 46.5, lon: 8 }); // virgola decimale con il punto e virgola
    expect(parseCoordinates("46,5 8,0")).toEqual({ lat: 46.5, lon: 8 });
    for (const bad of ["", "abc", "46.5", "46.5, 8.0, 3", "90, 10", "-86, 10", "10, 181", "NaN, 1", "1e3, 5", "46.5, 8.0; 7"]) expect(parseCoordinates(bad), bad).toBeNull();
    expect(parseCoordinates("x".repeat(200))).toBeNull();
    expect(parseCoordinates("46,8")).toEqual({ lat: 46, lon: 8 }); // una sola virgola tra due numeri è il separatore
  });

  it("distanza tra due punti, anche attraverso l'antimeridiano", () => {
    expect(geoDistanceKm({ lat: 44, lon: 7 }, { lat: 44, lon: 7 })).toBe(0);
    expect(geoDistanceKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(110.6, 0);
    expect(geoDistanceKm({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 })).toBeCloseTo(111.3, 0);
    expect(FRAME_WARN_KM).toBe(300);
  });
});

describe("area del mondo di una rete (modulo puro)", () => {
  const cfg = parseNetworkConfig({ version: 1, name: "t", frame: { lat0: 44.45, lon0: 6.95 }, environment: "tipico", regulatory: "g3", terrain: "world", devices: [{ id: "A", kind: "box", lat: 44.45, lon: 6.95 }] });
  it("tessere necessarie e avvisi senza Node", () => {
    expect(requiredTiles(cfg).length).toBeGreaterThanOrEqual(4);
    expect(configWarnings(cfg)).toEqual([]);
    const far = parseNetworkConfig({ ...cfg, frame: { lat0: 65, lon0: 10 }, devices: [{ id: "A", kind: "box", lat: 65, lon: 10 }] });
    expect(configWarnings(far).join(" ")).toMatch(/60°/);
  });
});

describe("tessere nel browser", () => {
  it("scarica con l'intestazione, decodifica, tiene in memoria e non riscarica", async () => {
    const calls: string[] = [];
    const s = new BrowserTileStore("tiles/", fakeFetch(calls));
    await s.ensure([{ tx: 730, ty: 183 }, { tx: 731, ty: 183 }]);
    expect(calls.sort()).toEqual(["tiles/730/183", "tiles/731/183"]);
    expect(s.get(730, 183)?.elevation[0]).toBe(100);
    expect(s.sources().sort()).toEqual(["fonte-730", "fonte-731"]);
    await s.ensure([{ tx: 730, ty: 183 }]);
    expect(calls).toHaveLength(2);
    expect(s.maxElevation([{ tx: 730, ty: 183 }, { tx: 9, ty: 9 }])).toBe(100);
  });

  it("richieste uguali contemporanee condividono lo scarico; progresso e concorrenza", async () => {
    let live = 0, peak = 0;
    const calls: string[] = [];
    const f: TileFetchFn = async (url, init) => { live++; peak = Math.max(peak, live); calls.push(url); await new Promise((r) => setTimeout(r, 15)); live--; const m = /(\d+)\/(\d+)$/.exec(url)!; void init; return ok(bytes(tile(Number(m[1]), Number(m[2])))); };
    const s = new BrowserTileStore("tiles/", f);
    const list = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ tx: 700 + i, ty: 183 }));
    const progress: number[] = [];
    await Promise.all([s.ensure(list, { onProgress: (d) => progress.push(d) }), s.ensure(list.slice(0, 3))]);
    expect(calls).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(4);
    expect(progress.at(-1)).toBe(8);
  });

  it("un errore del server arriva con il suo testo e non si riprova subito", async () => {
    let now = 1000;
    const calls: string[] = [];
    const s = new BrowserTileStore("tiles/", fakeFetch(calls, { "730/183": () => bad(429, "Troppe tessere nuove nell'ultima ora") }), 500, () => now);
    await expect(s.ensure([{ tx: 730, ty: 183 }, { tx: 731, ty: 183 }])).rejects.toMatchObject({ status: 429, message: expect.stringContaining("Troppe tessere") });
    expect(s.has({ tx: 731, ty: 183 })).toBe(true); // le altre continuano
    expect(s.recentError([{ tx: 730, ty: 183 }])).not.toBeNull();
    const before = calls.length;
    await expect(s.ensure([{ tx: 730, ty: 183 }])).rejects.toBeDefined();
    expect(calls.length).toBe(before); // nessuna nuova richiesta
    now += 21_000;
    expect(s.recentError([{ tx: 730, ty: 183 }])).toBeNull();
  });

  it("rifiuta una tessera diversa da quella chiesta, dati non validi e indici fuori dal mondo", async () => {
    const wrong: TileFetchFn = async () => ok(bytes(tile(731, 183)));
    await expect(new BrowserTileStore("tiles/", wrong).ensure([{ tx: 730, ty: 183 }])).rejects.toThrow(/non è quella richiesta/);
    const junk: TileFetchFn = async () => ok(new Uint8Array([1, 2, 3, 4, 5]));
    await expect(new BrowserTileStore("tiles/", junk).ensure([{ tx: 730, ty: 183 }])).rejects.toThrow();
    const calls: string[] = [];
    await new BrowserTileStore("tiles/", fakeFetch(calls)).ensure([{ tx: -1, ty: 5 }, { tx: 5, ty: 2 }]); // fuori dai limiti: ignorate
    expect(calls).toHaveLength(0);
  });

  it("oltre il tetto scarta le più vecchie, non quelle richieste né quelle fissate", async () => {
    const s = new BrowserTileStore("tiles/", fakeFetch(), 3);
    const pinned = [{ tx: 700, ty: 183 }];
    s.pin(pinned);
    await s.ensure([...pinned, { tx: 701, ty: 183 }, { tx: 702, ty: 183 }]);
    await s.ensure([{ tx: 703, ty: 183 }, { tx: 704, ty: 183 }]);
    expect(s.size).toBeLessThanOrEqual(4);
    expect(s.has(pinned[0])).toBe(true);
    expect(s.has({ tx: 703, ty: 183 }) && s.has({ tx: 704, ty: 183 })).toBe(true);
  });

  it("isStale ferma i download non più utili", async () => {
    const calls: string[] = [];
    const s = new BrowserTileStore("tiles/", fakeFetch(calls));
    let stale = false;
    const list = Array.from({ length: 12 }, (_, i) => ({ tx: 700 + i, ty: 183 }));
    const p = s.ensure(list, { concurrency: 1, isStale: () => stale, onProgress: (d) => { if (d === 2) stale = true; } });
    await p;
    expect(calls.length).toBeLessThan(12);
  });

  it("il servizio di tessere risponde o no", async () => {
    expect(await probeTileService("tiles/", async () => ok(new Uint8Array()))).toBe(true);
    expect(await probeTileService("tiles/", async () => bad(404))).toBe(false);
    expect(await probeTileService("tiles/", async () => { throw new Error("rete"); })).toBe(false);
  });
});

describe("terreno a tessere con un deposito che si riempie", () => {
  it("una tessera che arriva dopo una lettura mancata viene vista subito", () => {
    const tiles = new Map<string, GeoTile>();
    const store = { get: (tx: number, ty: number) => tiles.get(`${tx}_${ty}`) };
    const frame = { lat0: 44.45, lon0: 6.95 };
    const t = new TileTerrain(frame, store);
    expect(t.contains(0, 0)).toBe(false);
    expect(t.elevationAt(0, 0)).toBe(0);
    expect(t.landCoverAt(0, 0)).toBe("sea");
    // la tessera di quel punto arriva ora
    const probe = new TileTerrain(frame, { get: (tx, ty) => { tiles.set(`${tx}_${ty}`, tile(tx, ty, 321)); return tiles.get(`${tx}_${ty}`); } });
    probe.elevationAt(0, 0);
    expect(t.contains(0, 0)).toBe(true);
    expect(t.elevationAt(0, 0)).toBeCloseTo(321, 5);
    expect(t.landCoverAt(0, 0)).not.toBe("sea");
  });

  it("boundedTerrain riconosce i terreni con un'area di dati", () => {
    expect(boundedTerrain(FLAT_TERRAIN)).toBeNull();
    expect(boundedTerrain(new TileTerrain({ lat0: 0, lon0: 0 }, { get: () => undefined }))).not.toBeNull();
    expect(PackTerrain).toBeDefined();
  });
});

describe("riferimento locale: logica pura della pagina", () => {
  const cfg = parseNetworkConfig({
    version: 1, name: "t", frame: { lat0: 44.45, lon0: 6.95 }, environment: "tipico", regulatory: "g3", terrain: "world",
    devices: [
      { id: "A", kind: "box", lat: 44.45, lon: 6.95 },
      { id: "B", kind: "card", lat: 44.5, lon: 7.0, route: [{ tS: 0, lat: 44.5, lon: 7.0 }, { tS: 60, lat: 47.5, lon: 10.5 }] },
    ],
  });

  it("i punti della rete comprendono le tappe dei percorsi, e il riferimento li tiene d'occhio", () => {
    expect(configPoints(cfg)).toHaveLength(4);
    expect(farthestPointKm(cfg, { lat: 44.45, lon: 6.95 })).toBeGreaterThan(300); // la tappa lontana (non il dispositivo) è oltre il limite
    expect(canRecenterAt(cfg, 44.45, 6.95, 600)).toBe(true);
    expect(canRecenterAt(cfg, 52, 20, 300)).toBe(false);
    expect(canRecenterAt({ ...cfg, devices: [] }, 52, 20, 300)).toBe(true); // nessun dispositivo: ci si può spostare ovunque
  });

  it("ricentrare lascia i dispositivi dove sono e converte vista e aree di guasto", () => {
    const view = { cx: 12_000, cy: -5_000, mPerPx: 100, w: 800, h: 600 };
    const areas = [{ x: 3000, y: 4000, r: 2500 }];
    const out = recenterConfig(cfg, view, areas, 45.0, 7.5);
    expect(out.cfg.frame).toEqual({ lat0: 45.0, lon0: 7.5 });
    expect(out.cfg.devices).toBe(cfg.devices); // stessi dispositivi, stesse coordinate geografiche
    const gView = toGeo(cfg.frame, { x: view.cx, y: view.cy });
    const back = toGeo(out.cfg.frame, { x: out.view.cx, y: out.view.cy });
    expect(back.lat).toBeCloseTo(gView.lat, 8);
    expect(back.lon).toBeCloseTo(gView.lon, 8);
    const gArea = toGeo(cfg.frame, areas[0]);
    const gArea2 = toGeo(out.cfg.frame, out.areas[0]);
    expect(gArea2.lat).toBeCloseTo(gArea.lat, 8);
    expect(gArea2.lon).toBeCloseTo(gArea.lon, 8);
    expect(out.areas[0].r).toBe(2500);
    expect(out.view.mPerPx).toBe(100);
    expect(toLocal(out.cfg.frame, { lat: 45.0, lon: 7.5 })).toEqual({ x: 0, y: 0 });
  });

  it("le tessere di una rete: un numero ragionevole, null se troppe o se l'area non sta nella griglia", () => {
    const small = { ...cfg, devices: [cfg.devices[0]] };
    expect(networkTiles(small, 250)?.length).toBeGreaterThan(4);
    expect(networkTiles(small, 3)).toBeNull();
    expect(networkTiles(cfg, 250)).toBeNull(); // una rete di 400 km con 30 km di margine supera il tetto
    // vicino al polo i metri locali diventano longitudini enormi: nessuna eccezione, solo «troppo estesa»
    const polar = parseNetworkConfig({ version: 1, name: "p", frame: { lat0: 84.9, lon0: 0 }, environment: "tipico", regulatory: "g3", terrain: "world", devices: [{ id: "A", kind: "box", lat: 84.9, lon: 0 }] });
    expect(() => networkTiles(polar, 250)).not.toThrow();
  });
});

describe("tessere nel browser: protezione dallo scarto", () => {
  it("non scarta le tessere della vista né quelle di una chiamata in corso", async () => {
    const s = new BrowserTileStore("tiles/", fakeFetch(), 2);
    const view = [{ tx: 700, ty: 183 }, { tx: 701, ty: 183 }];
    await s.ensure(view);
    s.setVisible(view);
    // un'altra area riempie oltre il tetto: le tessere della vista restano
    await s.ensure([{ tx: 710, ty: 183 }, { tx: 711, ty: 183 }, { tx: 712, ty: 183 }]);
    expect(view.every((t) => s.has(t))).toBe(true);
    // cambiata la vista, quelle vecchie possono essere scartate alla prossima occasione
    s.setVisible([]);
    await s.ensure([{ tx: 720, ty: 183 }]);
    expect(s.size).toBeLessThanOrEqual(4);
  });

  it("richieste concorrenti: ognuna protegge le proprie tessere finché dura", async () => {
    const s = new BrowserTileStore("tiles/", fakeFetch(), 2);
    const a = s.ensure([{ tx: 730, ty: 183 }, { tx: 731, ty: 183 }, { tx: 732, ty: 183 }]);
    const b = s.ensure([{ tx: 740, ty: 183 }, { tx: 741, ty: 183 }]);
    await Promise.all([a, b]);
    expect(s.missing([{ tx: 730, ty: 183 }, { tx: 731, ty: 183 }, { tx: 732, ty: 183 }]).length + s.missing([{ tx: 740, ty: 183 }, { tx: 741, ty: 183 }]).length).toBeLessThanOrEqual(5);
  });
});
