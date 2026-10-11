import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { findPackDir, loadPackTerrain } from "../../tools/map-data/load.js";
import { CoverAccumulator, buildElevationGrid, cellCenter, classifyCell, gridGeoBox, gridSpecFor, sampleHgt, worldCoverGroup } from "../../tools/map-data/resample.js";
import { HGT_VOID, type HgtTile, parseHgt, skadiName, skadiTilesFor, skadiUrl, worldCoverCorner, worldCoverName, worldCoverTilesFor, worldCoverUrl } from "../../tools/map-data/sources.js";
import { assessLink } from "../../tools/scenario-model/assess.js";
import { assessNetwork, paramsForConfig, parseNetworkConfig, placeDevices } from "../../tools/scenario-model/network-config.js";
import { COVER_CLASSES, MAX_PACK_CELLS, PACK_VERSION, PackTerrain, type TerrainPack, decodePack, encodePack, packOffset } from "../../tools/scenario-model/terrain-pack.js";
import { terrainProfileLoss, toGeo, toLocal } from "../../tools/scenario-model/terrain.js";
import { readFileSync } from "node:fs";

function smallPack(elev: number[], cols: number, rows: number, cover?: number[]): TerrainPack {
  return {
    header: { version: PACK_VERSION, id: "t", name: "Prova", frame: { lat0: 44, lon0: 7 }, cellM: 100, cols, rows, minX: (-cols * 100) / 2, maxY: (rows * 100) / 2, sources: ["test"], attribution: "x" },
    elevation: Int16Array.from(elev),
    cover: Uint8Array.from(cover ?? elev.map(() => 1)),
  };
}

describe("pacchetto di terreno: formato", () => {
  it("scrittura e lettura restituiscono gli stessi dati, anche con salti di quota a 16 bit", () => {
    const p = smallPack([0, 32767, -32768, 5, 1000, 999, 0, 0, 12, 13, 14, 15], 4, 3, [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1]);
    const q = decodePack(encodePack(p));
    expect(q.header).toMatchObject({ id: "t", cols: 4, rows: 3, cellM: 100, sources: ["test"] });
    expect([...q.elevation]).toEqual([...p.elevation]);
    expect([...q.cover]).toEqual([...p.cover]);
  });

  it("rifiuta dati incoerenti o non fidati con un messaggio chiaro", () => {
    const good = encodePack(smallPack([1, 2, 3, 4], 2, 2));
    expect(() => decodePack(new Uint8Array([1, 2, 3]))).toThrow(/Non è un pacchetto/);
    const badMagic = good.slice();
    badMagic[0] = 0;
    expect(() => decodePack(badMagic)).toThrow(/Non è un pacchetto/);
    expect(() => decodePack(good.slice(0, good.length - 1))).toThrow(/troncato/);
    expect(() => decodePack(new Uint8Array([...good, 0]))).toThrow(/troncato|eccesso/);
    const badClass = good.slice();
    badClass[badClass.length - 1] = COVER_CLASSES.length;
    expect(() => decodePack(badClass)).toThrow(/classe/);
    expect(() => encodePack({ ...smallPack([1, 2, 3, 4], 2, 2), elevation: new Int16Array(3) })).toThrow(/incoerente/);
  });

  it("rifiuta un'intestazione con numeri non validi o una griglia oltre il tetto", () => {
    const enc = (h: Record<string, unknown>, n = 4): Uint8Array => {
      const head = new TextEncoder().encode(JSON.stringify(h));
      const out = new Uint8Array(8 + head.length + 3 * n);
      out.set([0x41, 0x52, 0x54, 0x50], 0);
      new DataView(out.buffer).setUint32(4, head.length, true);
      out.set(head, 8);
      return out;
    };
    const base = { version: 1, id: "t", name: "t", frame: { lat0: 44, lon0: 7 }, cellM: 100, cols: 2, rows: 2, minX: 0, maxY: 0 };
    expect(() => decodePack(enc(base))).not.toThrow();
    expect(() => decodePack(enc({ ...base, version: 2 }))).toThrow(/Versione/);
    expect(() => decodePack(enc({ ...base, cellM: 0 }))).toThrow(/griglia/);
    expect(() => decodePack(enc({ ...base, cols: 1.5 }))).toThrow(/griglia/);
    expect(() => decodePack(enc({ ...base, frame: { lat0: 99, lon0: 7 } }))).toThrow(/origine/);
    expect(() => decodePack(enc({ ...base, cols: MAX_PACK_CELLS, rows: 2 }))).toThrow(/troppo grande/);
    expect(() => decodePack(enc({ ...base, minX: null }))).toThrow(/griglia/); // JSON non rappresenta NaN: arriva null
    expect(() => decodePack(enc({ ...base, maxY: "0" }))).toThrow(/griglia/);
    const { frame: _frame, ...noFrame } = base;
    expect(() => decodePack(enc(noFrame))).toThrow(/origine/);
    expect(() => decodePack(enc({ ...base, id: 5 }))).toThrow(/origine|identificativo/);
  });
});

describe("PackTerrain", () => {
  // 3 colonne × 2 righe da 100 m, centrata: x in [-150,150], y in [-100,100]
  const pack = smallPack([0, 100, 200, 300, 400, 500], 3, 2, [0, 1, 2, 3, 4, 1]);
  const t = new PackTerrain(pack);

  it("la quota vale il dato al centro di ogni cella e interpola tra i centri", () => {
    expect(t.elevationAt(-100, 50)).toBeCloseTo(0); // centro della cella (colonna 0, riga 0)
    expect(t.elevationAt(0, 50)).toBeCloseTo(100);
    expect(t.elevationAt(-50, 50)).toBeCloseTo(50);
    expect(t.elevationAt(0, 0)).toBeCloseTo(250); // a metà tra le due righe: (100 + 400) / 2
    expect(t.elevationAt(100, -50)).toBeCloseTo(500);
  });

  it("fuori dal riquadro la quota è 0 e il suolo è mare; sul bordo si usa la cella più vicina", () => {
    expect(t.elevationAt(1000, 0)).toBe(0);
    expect(t.elevationAt(0, -1000)).toBe(0);
    expect(t.landCoverAt(1000, 0)).toBe("sea");
    expect(t.contains(0, 0)).toBe(true);
    expect(t.contains(151, 0)).toBe(false);
    expect(t.elevationAt(-149, 99)).toBeCloseTo(0, 0); // dentro, ai margini: valore finito, non NaN
    expect(Number.isFinite(t.elevationAt(Number.NaN, 0))).toBe(true);
    expect(t.landCoverAt(Number.NaN, 0)).toBe("sea"); // mai una classe non valida
    expect(t.landCoverAt(0, Number.NaN)).toBe("sea");
  });

  it("la classe d'uso del suolo è quella della cella che contiene il punto", () => {
    expect(t.landCoverAt(-100, 50)).toBe("sea");
    expect(t.landCoverAt(0, 50)).toBe("open");
    expect(t.landCoverAt(100, 50)).toBe("forest");
    expect(t.landCoverAt(-100, -50)).toBe("urban");
    expect(t.landCoverAt(0, -50)).toBe("urban-dense");
  });

  it("con un'origine diversa dalla configurazione il terreno si sposta di conseguenza", () => {
    const cfgFrame = { lat0: 44.01, lon0: 7 }; // un centesimo di grado più a nord
    const off = packOffset(pack, cfgFrame);
    expect(off.x).toBeCloseTo(0, 6);
    expect(off.y).toBeLessThan(-1000);
    const shifted = new PackTerrain(pack, off);
    expect(shifted.elevationAt(0 + off.x, 50 + off.y)).toBeCloseTo(t.elevationAt(0, 50));
    expect(shifted.bounds().maxY).toBeCloseTo(100 + off.y);
    const geo = toGeo(cfgFrame, { x: 0, y: off.y });
    expect(geo.lat).toBeCloseTo(44, 6);
  });
});

describe("fonti dei dati", () => {
  it("nomi e indirizzi delle tessere, anche a sud e a ovest", () => {
    expect(skadiName(44, 7)).toBe("N44E007");
    expect(skadiName(-1, -70)).toBe("S01W070");
    expect(skadiUrl(44, 7)).toBe("https://elevation-tiles-prod.s3.amazonaws.com/skadi/N44/N44E007.hgt.gz");
    expect(worldCoverCorner(44.4, 6.95)).toEqual({ lat: 42, lon: 6 });
    expect(worldCoverCorner(-0.5, -0.5)).toEqual({ lat: -3, lon: -3 });
    expect(worldCoverName(-3, -3)).toBe("S03W003");
    expect(worldCoverUrl(42, 6)).toContain("ESA_WorldCover_10m_2021_v200_N42E006_Map.tif");
  });

  it("le tessere che coprono un riquadro, senza dimenticarne ai bordi", () => {
    expect(skadiTilesFor({ south: 43.9, north: 44.2, west: 6.63, east: 7.27 })).toHaveLength(4);
    expect(skadiTilesFor({ south: 44.27, north: 44.63, west: 6.63, east: 7.27 })).toHaveLength(2);
    expect(skadiTilesFor({ south: 44.1, north: 44.9, west: 7.1, east: 7.9 })).toEqual([{ lat: 44, lon: 7 }]);
    expect(worldCoverTilesFor({ south: 38.3, north: 38.9, west: 14.6, east: 15.5 })).toEqual([{ lat: 36, lon: 12 }, { lat: 36, lon: 15 }]);
  });

  it("legge un file HGT (big-endian) e rifiuta dimensioni impossibili", () => {
    const bytes = new Uint8Array(2 * 2 * 2);
    new DataView(bytes.buffer).setInt16(0, 300, false);
    new DataView(bytes.buffer).setInt16(2, -5, false);
    const t = parseHgt(44, 7, bytes);
    expect(t.size).toBe(2);
    expect([...t.data]).toEqual([300, -5, 0, 0]);
    expect(() => parseHgt(44, 7, new Uint8Array(6))).toThrow(/non valido/);
    expect(() => parseHgt(44, 7, new Uint8Array(3))).toThrow(/non valido/);
  });
});

describe("ricampionamento", () => {
  // tessera 3×3 che copre lat 44..45, lon 7..8: quota = 100 * colonna (cresce verso est)
  const tile: HgtTile = { lat: 44, lon: 7, size: 3, data: Int16Array.from([0, 100, 200, 0, 100, 200, 0, 100, 200]) };
  const tiles = new Map([["44,7", tile]]);

  it("interpolazione bilineare, bordi e dati mancanti", () => {
    expect(sampleHgt(tiles, 44.5, 7.5)).toBeCloseTo(100);
    expect(sampleHgt(tiles, 44.5, 7.25)).toBeCloseTo(50);
    expect(sampleHgt(tiles, 44.999999, 7.999999)).toBeCloseTo(200, 1);
    expect(sampleHgt(tiles, 43.5, 7.5)).toBeNull(); // tessera assente
    // coordinata esattamente sul bordo di tessera: se quella a nord/est manca si usa quella a sud/ovest
    expect(sampleHgt(tiles, 45, 7.5)).toBeCloseTo(100); // bordo nord della tessera 44,7 (la 45,7 manca)
    expect(sampleHgt(tiles, 44.5, 8)).toBeCloseTo(200); // bordo est (la 44,8 manca)
    expect(sampleHgt(tiles, 45, 8)).toBeCloseTo(200); // angolo nord-est
    expect(sampleHgt(tiles, 44, 7.5)).toBeCloseTo(100); // bordo sud: è la tessera stessa
    const holes: HgtTile = { ...tile, data: Int16Array.from([HGT_VOID, HGT_VOID, HGT_VOID, HGT_VOID, HGT_VOID, HGT_VOID, HGT_VOID, HGT_VOID, HGT_VOID]) };
    expect(sampleHgt(new Map([["44,7", holes]]), 44.5, 7.5)).toBeNull();
    const oneHole: HgtTile = { ...tile, data: Int16Array.from([HGT_VOID, 100, 200, 0, 100, 200, 0, 100, 200]) };
    expect(sampleHgt(new Map([["44,7", oneHole]]), 44.75, 7.25)).toBeCloseTo(200 / 3, 5); // media dei tre campioni validi, ripesata
  });

  it("la griglia è centrata, copre almeno l'area chiesta e il riquadro geografico la contiene", () => {
    const g = gridSpecFor({ lat0: 44.5, lon0: 7.5 }, 1050, 520, 100);
    expect(g.cols).toBe(11);
    expect(g.rows).toBe(6);
    expect(g.minX).toBeCloseTo(-550);
    expect(g.maxY).toBeCloseTo(300);
    const c = cellCenter(g, 0, 0);
    expect(c.x).toBeCloseTo(-500);
    expect(c.y).toBeCloseTo(250);
    const box = gridGeoBox(g);
    expect(box.south).toBeLessThan(44.5);
    expect(box.north).toBeGreaterThan(44.5);
    expect(box.east).toBeGreaterThan(7.5);
  });

  it("la quota di cella è la media, i fondali (negativi) diventano 0 e la tessera assente vale 0", () => {
    const g = gridSpecFor({ lat0: 44.5, lon0: 7.5 }, 200, 200, 100);
    // versante ripido (10000 m per colonna, solo per distinguere le celle): a 7,5° vale 10000
    const steep: HgtTile = { ...tile, data: Int16Array.from([0, 10000, 20000, 0, 10000, 20000, 0, 10000, 20000]) };
    const e = buildElevationGrid(g, new Map([["44,7", steep]]));
    expect(e[0]).toBeLessThan(e[1]); // la cella ovest è sotto, quella est sopra
    expect(Math.abs((e[0] + e[1]) / 2 - 10000)).toBeLessThanOrEqual(2);
    const deep: HgtTile = { ...tile, data: new Int16Array(9).fill(-500) };
    expect([...buildElevationGrid(g, new Map([["44,7", deep]]))]).toEqual([0, 0, 0, 0]);
    expect([...buildElevationGrid(g, new Map())]).toEqual([0, 0, 0, 0]);
  });

  it("classi d'uso del suolo: soglie, acqua prima del costruito, nessun dato = mare", () => {
    expect(classifyCell({ total: 0, trees: 0, built: 0, water: 0 })).toBe(0);
    expect(classifyCell({ total: 100, trees: 0, built: 0, water: 50 })).toBe(0);
    expect(classifyCell({ total: 100, trees: 0, built: 0, water: 49 })).toBe(1);
    expect(classifyCell({ total: 100, trees: 0, built: 50, water: 0 })).toBe(4);
    expect(classifyCell({ total: 100, trees: 0, built: 15, water: 0 })).toBe(3);
    expect(classifyCell({ total: 100, trees: 0, built: 14, water: 0 })).toBe(1);
    expect(classifyCell({ total: 100, trees: 50, built: 0, water: 0 })).toBe(2);
    expect(classifyCell({ total: 100, trees: 49, built: 0, water: 0 })).toBe(1);
    expect(classifyCell({ total: 100, trees: 60, built: 60, water: 60 })).toBe(0);
    expect([10, 95, 50, 80, 0, 30, 40, 70].map(worldCoverGroup)).toEqual([1, 1, 2, 3, 3, 0, 0, 0]);
  });

  it("l'accumulatore assegna i pixel alla cella giusta, ignora quelli fuori griglia", () => {
    const g = gridSpecFor({ lat0: 44.5, lon0: 7.5 }, 200, 200, 100); // 2×2 celle
    const at = (x: number, y: number) => toGeo(g.frame, { x, y });
    const pts = [at(-50, 50), at(50, 50), at(-50, -50), at(50, -50), at(5000, 5000)];
    // la latitudine è una per riga: una striscia per riga
    const acc2 = new CoverAccumulator(g);
    acc2.addStrip([80, 50], 2, 1, [pts[0].lon, pts[1].lon], [pts[0].lat]); // riga nord
    acc2.addStrip([10, 30], 2, 1, [pts[2].lon, pts[3].lon], [pts[2].lat]); // riga sud
    acc2.addStrip([10], 1, 1, [pts[4].lon], [pts[4].lat]); // fuori griglia
    expect([...acc2.toClasses()]).toEqual([0, 4, 2, 1]); // acqua, abitato denso, bosco, aperto
    expect(acc2.counts[0]).toBe(1);
  });
});

describe("pacchetti pronti (Valle Maira, Eolie)", () => {
  it("l'identificativo di un riferimento è controllato prima di toccare il disco", () => {
    const f = { lat0: 44, lon0: 7 };
    expect(() => loadPackTerrain("pack:../../etc/passwd", f)).toThrow(/non valido/);
    expect(() => loadPackTerrain("pack:", f)).toThrow(/non valido/);
    expect(() => loadPackTerrain("pack:UPPER", f)).toThrow(/non valido/);
    expect(() => loadPackTerrain("pack:non-esiste", f)).toThrow(/non trovato/);
  });

  it("un file che non è un pacchetto dà un errore chiaro", () => {
    const dir = mkdtempSync(join(tmpdir(), "arald-pack-"));
    writeFileSync(join(dir, "rotto.pack.gz"), gzipSync(Buffer.from("non un pacchetto")));
    expect(() => loadPackTerrain("pack:rotto", { lat0: 0, lon0: 0 }, dir)).toThrow(/Non è un pacchetto/);
  });

  it("Eolie: Stromboli e il resto delle isole hanno le quote vere, il mare è a 0", () => {
    const t = loadPackTerrain("pack:eolie", { lat0: 38.6, lon0: 15.05 });
    const c = toLocal({ lat0: 38.6, lon0: 15.05 }, { lat: 38.7892, lon: 15.2131 }); // cima dello Stromboli, ~924 m
    let max = 0;
    for (let dx = -400; dx <= 400; dx += 50) for (let dy = -400; dy <= 400; dy += 50) max = Math.max(max, t.elevationAt(c.x + dx, c.y + dy));
    expect(max).toBeGreaterThan(800);
    expect(max).toBeLessThan(1000);
    expect(t.elevationAt(20000, -20000)).toBe(0); // mare aperto
    expect(t.landCoverAt(20000, -20000)).toBe("sea");
    expect(t.clutterHeightRelief).toBe(true);
    expect(t.pack.header.attribution).toMatch(/WorldCover/);
  });

  it("Valle Maira: quote alpine tra 700 e 3400 m e suolo vario", () => {
    const t = loadPackTerrain("pack:valle-maira", { lat0: 44.45, lon0: 6.95 });
    const h = t.pack.header;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of t.pack.elevation) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    expect(lo).toBeGreaterThan(500);
    expect(hi).toBeGreaterThan(3000);
    expect(hi).toBeLessThan(3500);
    expect(new Set(t.pack.cover).size).toBeGreaterThanOrEqual(3);
    expect(h.cols * h.cellM).toBeGreaterThanOrEqual(50_000);
  });

  it("l'esempio sul terreno reale della Valle Maira si valuta: il Box vede le Card vicine, non quelle oltre la cresta", () => {
    const cfg = parseNetworkConfig(JSON.parse(readFileSync("tools/scenario-model/examples/valle-maira-reale.json", "utf8")));
    const t = loadPackTerrain(cfg.terrain as string, cfg.frame);
    const links = assessNetwork(cfg, t);
    const has = (a: string, b: string): boolean => links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    expect(has("BOX", "C2")).toBe(true);
    expect(has("BOX", "C5")).toBe(false);
  });

  it("Eolie: l'ostacolo tra il Box di Lipari e il ripetitore di Panarea è un rilievo vicino al Box, più alto della retta delle antenne", () => {
    const cfg = parseNetworkConfig(JSON.parse(readFileSync("tools/scenario-model/examples/eolie-resilienza-reale.json", "utf8")));
    const t = loadPackTerrain(cfg.terrain as string, cfg.frame);
    const nodes = placeDevices(cfg, t);
    const box = nodes.find((n) => n.id === "BOX")!.path[0];
    const fr = nodes.find((n) => n.id === "FR")!.path[0];
    const prof = terrainProfileLoss(t, box, fr, 868e6);
    expect(prof.lineOfSight).toBe(false);
    expect(prof.lossDb).toBeGreaterThan(10);
    const L = Math.hypot(fr.x - box.x, fr.y - box.y);
    expect(prof.obstacleAtM).toBeLessThan(0.2 * L); // vicino al Box, non a metà tratta
    const f = prof.obstacleAtM / L;
    const ground = t.elevationAt(box.x + f * (fr.x - box.x), box.y + f * (fr.y - box.y));
    const line = box.z + f * (fr.z - box.z);
    expect(ground).toBeGreaterThan(line); // il suolo supera la retta tra le antenne
    // e le antenne stanno dove devono: il Box su suolo basso di Lipari, il ripetitore in quota
    expect(box.z - t.elevationAt(box.x, box.y)).toBeCloseTo(4, 5);
    expect(t.elevationAt(box.x, box.y)).toBeLessThan(60);
    expect(t.elevationAt(fr.x, fr.y)).toBeGreaterThan(150);
    const p = paramsForConfig(cfg, t);
    expect(assessLink(nodes.find((n) => n.id === "BOX")!, box, nodes.find((n) => n.id === "FR")!, fr, p).best).toBeNull();
  });

  it("l'esempio delle Eolie sul terreno reale: il Box in porto a Lipari non vede il ripetitore di Panarea (collina davanti)", () => {
    const cfg = parseNetworkConfig(JSON.parse(readFileSync("tools/scenario-model/examples/eolie-resilienza-reale.json", "utf8")));
    const t = loadPackTerrain(cfg.terrain as string, cfg.frame);
    const links = assessNetwork(cfg, t);
    expect(links.some((l) => (l.a === "BOX" && l.b === "FR") || (l.a === "FR" && l.b === "BOX"))).toBe(false);
    expect(links.some((l) => (l.a === "FR" && l.b === "C3") || (l.a === "C3" && l.b === "FR"))).toBe(true);
  });

  it("la cartella dei pacchetti si trova anche da una sottocartella del repository", () => {
    const fromRoot = findPackDir();
    expect(existsSync(join(fromRoot, "eolie.pack.gz"))).toBe(true);
    expect(findPackDir(join(process.cwd(), "tools", "scenario-model", "examples"))).toBe(fromRoot);
    const nowhere = mkdtempSync(join(tmpdir(), "arald-nowhere-"));
    expect(existsSync(findPackDir(nowhere))).toBe(false); // nessuna cartella: percorso atteso, l'errore chiaro lo dà loadPackTerrain
  });
});
