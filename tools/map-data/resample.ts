/**
 * Dal dato grezzo (tessere SRTM e pixel WorldCover) alla griglia in metri locali di un pacchetto.
 * Solo logica pura e testabile; lo scarico e la lettura dei file sono in `build-pack.mts`.
 */
import type { LocalFrame } from "../scenario-model/terrain.js";
import { toGeo, toLocal } from "../scenario-model/terrain.js";
import { HGT_VOID, type HgtTile } from "./sources.js";

export interface GridSpec {
  frame: LocalFrame;
  cellM: number;
  cols: number;
  rows: number;
  /** Bordo ovest (x) e nord (y) della griglia, in metri locali. */
  minX: number;
  maxY: number;
}

/** Griglia centrata sull'origine, con lati arrotondati per eccesso a un numero intero di celle. */
export function gridSpecFor(frame: LocalFrame, widthM: number, heightM: number, cellM: number): GridSpec {
  const cols = Math.max(1, Math.ceil(widthM / cellM));
  const rows = Math.max(1, Math.ceil(heightM / cellM));
  return { frame, cellM, cols, rows, minX: (-cols * cellM) / 2, maxY: (rows * cellM) / 2 };
}

/** Riquadro geografico di una griglia, per sapere quali tessere scaricare. */
export function gridGeoBox(g: GridSpec): { south: number; north: number; west: number; east: number } {
  const sw = toGeo(g.frame, { x: g.minX, y: g.maxY - g.rows * g.cellM });
  const ne = toGeo(g.frame, { x: g.minX + g.cols * g.cellM, y: g.maxY });
  return { south: sw.lat, north: ne.lat, west: sw.lon, east: ne.lon };
}

/** Centro della cella (colonna c, riga r) in metri locali. */
export function cellCenter(g: GridSpec, c: number, r: number): { x: number; y: number } {
  return { x: g.minX + (c + 0.5) * g.cellM, y: g.maxY - (r + 0.5) * g.cellM };
}

/**
 * Quota con interpolazione bilineare dalle tessere SRTM; null se la tessera manca o i quattro campioni sono vuoti.
 * Una coordinata esattamente intera sta sul bordo di due tessere (le tessere condividono la riga/colonna di
 * bordo): se quella a nord/est manca si prova la tessera a sud/ovest, così non si apre una striscia a quota 0.
 */
export function sampleHgt(tiles: Map<string, HgtTile>, lat: number, lon: number): number | null {
  const lats = Number.isInteger(lat) ? [lat, lat - 1] : [Math.floor(lat)];
  const lons = Number.isInteger(lon) ? [lon, lon - 1] : [Math.floor(lon)];
  for (const tLat of lats) {
    for (const tLon of lons) {
      const tile = tiles.get(`${tLat},${tLon}`);
      if (tile) return sampleTile(tile, tLat, tLon, lat, lon);
    }
  }
  return null;
}

function sampleTile(tile: HgtTile, tLat: number, tLon: number, lat: number, lon: number): number | null {
  const n = tile.size - 1;
  const fx = Math.min(n, Math.max(0, (lon - tLon) * n));
  const fy = Math.min(n, Math.max(0, (tLat + 1 - lat) * n));
  const x0 = Math.min(n - 1, Math.floor(fx));
  const y0 = Math.min(n - 1, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const corners: [number, number][] = [
    [tile.data[y0 * tile.size + x0], (1 - tx) * (1 - ty)],
    [tile.data[y0 * tile.size + x0 + 1], tx * (1 - ty)],
    [tile.data[(y0 + 1) * tile.size + x0], (1 - tx) * ty],
    [tile.data[(y0 + 1) * tile.size + x0 + 1], tx * ty],
  ];
  let sum = 0;
  let weight = 0;
  for (const [v, w] of corners) {
    if (v === HGT_VOID) continue;
    sum += v * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : null;
}

/**
 * Quota di ogni cella: media di 3×3 campioni distribuiti nella cella (non il solo punto centrale,
 * per non dipendere da dove cade il campione). Dove manca il dato (tessera assente) 0 m. I valori
 * negativi (le tessere SRTM aperte includono i fondali marini) sono portati a 0: il livello del mare è
 * la quota minima, quindi le poche terre sotto il livello del mare (polder, delta) risultano appiattite.
 */
export function buildElevationGrid(g: GridSpec, tiles: Map<string, HgtTile>): Int16Array {
  const out = new Int16Array(g.cols * g.rows);
  const d = g.cellM / 3;
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const { x, y } = cellCenter(g, c, r);
      let sum = 0;
      let count = 0;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const p = toGeo(g.frame, { x: x + i * d, y: y + j * d });
          const v = sampleHgt(tiles, p.lat, p.lon);
          if (v !== null) { sum += Math.max(0, v); count++; }
        }
      }
      out[r * g.cols + c] = count > 0 ? Math.max(-32767, Math.min(32767, Math.round(sum / count))) : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------- uso del suolo

export type CoverGroup = 0 | 1 | 2 | 3; // 0 = altro, 1 = alberi, 2 = costruito, 3 = acqua

/**
 * Codici ESA WorldCover → gruppo (10 alberi, 95 mangrovie; 50 costruito; 80 acqua; 0 = nessun dato,
 * cioè mare aperto, trattato come acqua; il resto aperto).
 */
export function worldCoverGroup(code: number): CoverGroup {
  if (code === 10 || code === 95) return 1;
  if (code === 50) return 2;
  if (code === 80 || code === 0) return 3;
  return 0;
}

/**
 * Classe della cella (indice in `COVER_CLASSES`: 0 mare/acqua, 1 aperto, 2 bosco, 3 abitato, 4 abitato denso)
 * dalle frazioni di pixel. Le soglie sono una scelta di progetto (non una misura): acqua se è la metà o più;
 * costruito denso dalla metà, abitato dal 15%; bosco dalla metà; altrimenti aperto. Nessun pixel = mare.
 */
export function classifyCell(counts: { total: number; trees: number; built: number; water: number }): number {
  const { total, trees, built, water } = counts;
  if (total <= 0) return 0;
  if (water / total >= 0.5) return 0;
  if (built / total >= 0.5) return 4;
  if (built / total >= 0.15) return 3;
  if (trees / total >= 0.5) return 2;
  return 1;
}

/** Accumulatore dei pixel WorldCover per cella: conteggi di tutti, alberi, costruito, acqua. */
export class CoverAccumulator {
  readonly counts: Uint32Array;
  constructor(readonly grid: GridSpec) {
    this.counts = new Uint32Array(grid.cols * grid.rows * 4);
  }

  /**
   * Aggiunge una striscia di pixel (`codes`, righe per colonne). `lons[j]` è la longitudine del centro
   * della colonna j, `lats[i]` la latitudine del centro della riga i. Colonna e riga di cella dipendono
   * da longitudine e latitudine separatamente (la proiezione locale è equirettangolare), quindi si
   * calcolano una volta per colonna e per riga.
   */
  addStrip(codes: ArrayLike<number>, width: number, height: number, lons: ArrayLike<number>, lats: ArrayLike<number>): void {
    const g = this.grid;
    const colOf = new Int32Array(width);
    for (let j = 0; j < width; j++) {
      const x = toLocal(g.frame, { lat: g.frame.lat0, lon: lons[j] }).x;
      const c = Math.floor((x - g.minX) / g.cellM);
      colOf[j] = c >= 0 && c < g.cols ? c : -1;
    }
    for (let i = 0; i < height; i++) {
      const y = toLocal(g.frame, { lat: lats[i], lon: g.frame.lon0 }).y;
      const r = Math.floor((g.maxY - y) / g.cellM);
      if (r < 0 || r >= g.rows) continue;
      for (let j = 0; j < width; j++) {
        const c = colOf[j];
        if (c < 0) continue;
        const k = (r * g.cols + c) * 4;
        this.counts[k]++;
        const grp = worldCoverGroup(codes[i * width + j]);
        if (grp === 1) this.counts[k + 1]++;
        else if (grp === 2) this.counts[k + 2]++;
        else if (grp === 3) this.counts[k + 3]++;
      }
    }
  }

  toClasses(): Uint8Array {
    const n = this.grid.cols * this.grid.rows;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = classifyCell({ total: this.counts[4 * i], trees: this.counts[4 * i + 1], built: this.counts[4 * i + 2], water: this.counts[4 * i + 3] });
    return out;
  }
}
