/** Confronta il terreno a tessere (cache) con un pacchetto locale sullo stesso punto: `ARALD_TILE_CACHE=<cartella> npx tsx tools/map-data/compare-pack.mts`. Cifre della documentazione: misurate con la rete, non riproducibili senza. */
import { loadPackTerrain } from "./load.js";
import { DirTileStore } from "./tile-cache.js";
import { TileTerrain } from "../scenario-model/geo-tile.js";
const frame = { lat0: 44.45, lon0: 6.95 };
const pack = loadPackTerrain("pack:valle-maira", frame);
const store = new DirTileStore(process.env.ARALD_TILE_CACHE!);
const tt = new TileTerrain(frame, store);
let n = 0, sumAbs = 0, sumBias = 0, sumSq = 0, coverSame = 0, p = 0, maxAbs = 0;
const diffs: number[] = [];
const cls = { pack: new Map<string, number>(), tile: new Map<string, number>() };
for (let x = -24000; x <= 24000; x += 250) for (let y = -18000; y <= 18000; y += 250) {
  if (!pack.contains(x, y) || !tt.contains(x, y)) continue;
  const a = pack.elevationAt(x, y), b = tt.elevationAt(x, y);
  const d = b - a; n++; sumAbs += Math.abs(d); sumBias += d; sumSq += d * d; maxAbs = Math.max(maxAbs, Math.abs(d)); diffs.push(d);
  const ca = pack.landCoverAt(x, y), cb = tt.landCoverAt(x, y);
  if (ca === cb) coverSame++;
  cls.pack.set(ca, (cls.pack.get(ca) ?? 0) + 1); cls.tile.set(cb, (cls.tile.get(cb) ?? 0) + 1);
}
diffs.sort((a, b) => a - b);
console.log("punti", n, "| errore medio assoluto", (sumAbs / n).toFixed(1), "m | bias", (sumBias / n).toFixed(1), "m | rms", Math.sqrt(sumSq / n).toFixed(1), "m | max", maxAbs.toFixed(0), "m | mediana", diffs[Math.floor(n/2)].toFixed(1), "| p5", diffs[Math.floor(n*0.05)].toFixed(0), "p95", diffs[Math.floor(n*0.95)].toFixed(0));
console.log("suolo uguale:", ((100 * coverSame) / n).toFixed(1), "%");
console.log("pacchetto:", [...cls.pack].map(([k, v]) => `${k} ${(100 * v / n).toFixed(1)}%`).join(", "));
console.log("tessere:  ", [...cls.tile].map(([k, v]) => `${k} ${(100 * v / n).toFixed(1)}%`).join(", "));
