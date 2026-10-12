/**
 * Uso del suolo sulla griglia geografica del mondo a tessere: conta i pixel ESA WorldCover (10 m o una
 * sintesi a risoluzione ridotta) per cella e li classifica con le stesse soglie dei pacchetti
 * (`resample.ts`, `classifyCell`).
 */
import { CELL_DEG, TILE_CELLS, type TileIndex } from "../scenario-model/geo-tile.js";
import { classifyCell, worldCoverGroup } from "./resample.js";

export class GeoCoverAccumulator {
  /** Per cella: totale, alberi, costruito, acqua. */
  readonly counts = new Uint32Array(TILE_CELLS * TILE_CELLS * 4);

  constructor(readonly tile: TileIndex) {}

  /**
   * Aggiunge una striscia di pixel: `lons[j]` è la longitudine del centro della colonna j, `lats[i]` la latitudine
   * del centro della riga i. Colonna e riga di cella dipendono solo da longitudine e latitudine (griglia geografica).
   */
  addStrip(codes: ArrayLike<number>, width: number, height: number, lons: ArrayLike<number>, lats: ArrayLike<number>): void {
    const colOf = new Int32Array(width);
    for (let j = 0; j < width; j++) {
      const c = Math.floor((lons[j] + 180) / CELL_DEG) - this.tile.tx * TILE_CELLS;
      colOf[j] = c >= 0 && c < TILE_CELLS ? c : -1;
    }
    for (let i = 0; i < height; i++) {
      const r = Math.floor((90 - lats[i]) / CELL_DEG) - this.tile.ty * TILE_CELLS;
      if (r < 0 || r >= TILE_CELLS) continue;
      for (let j = 0; j < width; j++) {
        const c = colOf[j];
        if (c < 0) continue;
        const k = (r * TILE_CELLS + c) * 4;
        this.counts[k]++;
        const g = worldCoverGroup(codes[i * width + j]);
        if (g === 1) this.counts[k + 1]++;
        else if (g === 2) this.counts[k + 2]++;
        else if (g === 3) this.counts[k + 3]++;
      }
    }
  }

  /** Celle senza alcun pixel (fuori dai dati) risultano acqua, come nei pacchetti. */
  toClasses(): Uint8Array {
    const n = TILE_CELLS * TILE_CELLS;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = classifyCell({ total: this.counts[4 * i], trees: this.counts[4 * i + 1], built: this.counts[4 * i + 2], water: this.counts[4 * i + 3] });
    return out;
  }
}
