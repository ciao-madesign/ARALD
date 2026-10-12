/**
 * Prepara (e tiene in cache) le tessere del terreno del mondo per un'area o una configurazione. Serve la rete.
 *
 *   npm run map-tiles -- --config tools/scenario-model/examples/eolie-resilienza-reale.json
 *   npm run map-tiles -- --bbox 44.2,6.6,44.7,7.3
 *
 * Opzioni: --margin-km (default 30, solo con --config), --cache-dir, --max-new (tessere nuove per volta, default 800),
 * --concurrency (default 4), --cap-gb (tetto della cache, default 1.5).
 */
import { readFileSync } from "node:fs";
import { tilesForGeoBox } from "../scenario-model/geo-tile.js";
import { parseNetworkConfig } from "../scenario-model/network-config.js";
import { TerrariumSampler } from "./terrarium.js";
import { DEFAULT_CACHE_CAP_BYTES, DirTileStore, defaultCacheDir, enforceCap, tilePath } from "./tile-cache.js";
import { ensureTiles, networkTerrariumFetcher } from "./tile-builder.js";
import { WorldCoverSource } from "./worldcover-source.js";
import { DEFAULT_MARGIN_M, configWarnings, requiredTiles } from "./world.js";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--") || v.trim() === "") fail(`--${name} richiede un valore`);
  return v;
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min && v <= max ? v : fail(`--${name}: numero tra ${min} e ${max}`);
}

const configPath = arg("config");
const bboxArg = arg("bbox");
if ((configPath === undefined) === (bboxArg === undefined)) fail("Serve una sola tra --config <file.json> e --bbox sud,ovest,nord,est");
const dir = arg("cache-dir") ?? defaultCacheDir();
const marginM = num("margin-km", DEFAULT_MARGIN_M / 1000, 0, 500) * 1000;
const maxNew = Math.floor(num("max-new", 800, 1, 100_000));
const concurrency = Math.floor(num("concurrency", 4, 1, 16));
const capBytes = num("cap-gb", DEFAULT_CACHE_CAP_BYTES / 1e9, 0.05, 1000) * 1e9;

let tiles;
if (configPath) {
  let cfg;
  try { cfg = parseNetworkConfig(JSON.parse(readFileSync(configPath, "utf8"))); } catch (e) { fail(`Configurazione non valida: ${(e as Error).message}`); }
  for (const w of configWarnings(cfg, marginM)) console.log(`Attenzione: ${w}`);
  tiles = requiredTiles(cfg, marginM);
} else {
  const v = bboxArg!.split(",").map(Number);
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) fail("--bbox: sud,ovest,nord,est (quattro numeri)");
  try { tiles = tilesForGeoBox({ south: v[0], west: v[1], north: v[2], east: v[3] }); } catch (e) { fail((e as Error).message); }
}

const store = new DirTileStore(dir);
console.log(`Cache: ${dir}. Tessere necessarie: ${tiles.length} (da 0,25°, ~27 km di lato).`);
const t0 = Date.now();
try {
  const res = await ensureTiles(tiles, store, { terrarium: new TerrariumSampler(networkTerrariumFetcher()), cover: new WorldCoverSource() }, {
    concurrency, maxNew,
    onProgress: (done, total) => { if (done === total || done % 5 === 0) console.log(`  costruite ${done}/${total}`); },
  });
  const removed = enforceCap(dir, capBytes, new Set(tiles.map((t) => tilePath(dir, t))));
  console.log(`Fatto in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${res.built} nuove, ${res.cached} già in cache${removed ? `, ${removed} vecchie eliminate per il tetto` : ""}.`);
} catch (e) {
  fail(`Errore: ${(e as Error).message}`);
}
