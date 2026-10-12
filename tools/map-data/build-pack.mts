/**
 * Prepara un pacchetto di terreno reale per un'area (docs/real-maps.md).
 *
 *   npm run map-data -- --id valle-maira --name "Alta Valle Maira" --lat 44.46 --lon 6.95 --width-km 60 --height-km 50
 *
 * Scarica (con cache in tools/map-data/.cache) le tessere SRTM e WorldCover che coprono l'area,
 * le ricampiona su una griglia in metri locali e scrive `<out>/<id>.pack.gz`
 * (default tools/network-design/data/). Serve la rete; le tessere vengono riusate se già scaricate.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { fromFile } from "geotiff";
import { MAX_PACK_CELLS, PACK_ID_PATTERN, PACK_VERSION, type PackHeader, encodePack } from "../scenario-model/terrain-pack.js";
import { toGeo } from "../scenario-model/terrain.js";
import { writeCatalog } from "./catalog.js";
import { CoverAccumulator, buildElevationGrid, gridGeoBox, gridSpecFor } from "./resample.js";
import { ATTRIBUTION, type HgtTile, parseHgt, skadiName, skadiTilesFor, skadiUrl, worldCoverName, worldCoverTilesFor, worldCoverUrl } from "./sources.js";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(here, ".cache");

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && (v === undefined || v.startsWith("--") || v.trim() === "")) fail(`--${name} richiede un valore`);
  if (v !== undefined) return v;
  if (fallback !== undefined) return fallback;
  return fail(`Manca --${name}`);
}

function num(name: string, fallback?: string): number {
  const v = Number(arg(name, fallback));
  return Number.isFinite(v) ? v : fail(`--${name} deve essere un numero`);
}

/** Scarica un file nella cache se manca; restituisce il percorso, o null se la fonte non ha quel file (404: mare aperto). */
async function cached(url: string, file: string): Promise<string | null> {
  const dest = join(CACHE, file);
  if (existsSync(dest)) return dest;
  mkdirSync(CACHE, { recursive: true });
  const res = await fetch(url);
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok || !res.body) throw new Error(`Scarico fallito (${res.status}) per ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  renameSync(tmp, dest);
  return dest;
}

const id = arg("id");
if (!PACK_ID_PATTERN.test(id)) fail("--id: solo lettere minuscole, cifre e trattini (al massimo 64 caratteri)");
const name = arg("name", id);
const lat = num("lat");
const lon = num("lon");
const widthM = num("width-km") * 1000;
const heightM = num("height-km") * 1000;
const cellM = num("cell-m", "100");
if (!(widthM > 0 && heightM > 0 && cellM >= 10) || Math.abs(lat) > 80 || Math.abs(lon) > 180) fail("Parametri fuori intervallo (area positiva, cella ≥ 10 m, latitudine entro 80°, longitudine entro 180°)");
// Con antenne a quota nota (palo, tetto, torre) il disturbo del suolo (alberi, case) dipende dall'altezza
// dell'antenna sul suolo: attivo di default per i terreni reali (vedi Terrain.clutterHeightRelief).
const clutterRelief = arg("clutter-relief", "true") !== "false";
const out = resolve(arg("out", join(here, "..", "network-design", "data")));

const frame = { lat0: lat, lon0: lon };
const grid = gridSpecFor(frame, widthM, heightM, cellM);
if (grid.cols * grid.rows > MAX_PACK_CELLS) fail(`Griglia troppo grande: ${grid.cols}×${grid.rows} celle (massimo ${MAX_PACK_CELLS}); aumenta --cell-m o riduci l'area`);
const box = gridGeoBox(grid);
if (box.west < -180 || box.east > 180) fail("L'area attraversa l'antimeridiano o il limite ±180°: non supportato");
console.log(`Area ${name}: ${grid.cols}×${grid.rows} celle da ${cellM} m, lat ${box.south.toFixed(3)}…${box.north.toFixed(3)}, lon ${box.west.toFixed(3)}…${box.east.toFixed(3)}`);

// ---- quote
const tiles = new Map<string, HgtTile>();
const sources: string[] = [];
for (const t of skadiTilesFor(box)) {
  const file = await cached(skadiUrl(t.lat, t.lon), `${skadiName(t.lat, t.lon)}.hgt.gz`);
  if (!file) { console.log(`  SRTM ${skadiName(t.lat, t.lon)}: assente (mare aperto, quota 0)`); continue; }
  tiles.set(`${t.lat},${t.lon}`, parseHgt(t.lat, t.lon, gunzipSync(readFileSync(file))));
  sources.push(`SRTM ${skadiName(t.lat, t.lon)}`);
  console.log(`  SRTM ${skadiName(t.lat, t.lon)}: ok`);
}
// Una tessera assente di solito è mare aperto, ma lo stesso errore (403/404) lo dà anche un accesso negato
// (rete, proxy, limiti): senza nessuna tessera di quota non si scrive un pacchetto piatto e tutto mare.
if (tiles.size === 0 && !process.argv.includes("--allow-sea")) fail("Nessuna tessera di quota scaricata: controlla rete e proxy (o usa --allow-sea se l'area è davvero solo mare aperto)");
const elevation = buildElevationGrid(grid, tiles);

// ---- uso del suolo
const acc = new CoverAccumulator(grid);
const STRIP = 1024;
for (const t of worldCoverTilesFor(box)) {
  const file = await cached(worldCoverUrl(t.lat, t.lon), `WC_${worldCoverName(t.lat, t.lon)}.tif`);
  if (!file) { console.log(`  WorldCover ${worldCoverName(t.lat, t.lon)}: assente (mare aperto)`); continue; }
  const tiff = await fromFile(file);
  const img = await tiff.getImage();
  const [ox, oy] = img.getOrigin();
  const [rx, ry] = img.getResolution();
  const W = img.getWidth();
  const H = img.getHeight();
  const x0 = Math.max(0, Math.floor((box.west - ox) / rx));
  const x1 = Math.min(W, Math.ceil((box.east - ox) / rx));
  const y0 = Math.max(0, Math.floor((box.north - oy) / ry));
  const y1 = Math.min(H, Math.ceil((box.south - oy) / ry));
  if (x1 <= x0 || y1 <= y0) continue;
  const lons = new Float64Array(x1 - x0);
  for (let j = 0; j < lons.length; j++) lons[j] = ox + (x0 + j + 0.5) * rx;
  for (let ys = y0; ys < y1; ys += STRIP) {
    const ye = Math.min(y1, ys + STRIP);
    const lats = new Float64Array(ye - ys);
    for (let i = 0; i < lats.length; i++) lats[i] = oy + (ys + i + 0.5) * ry;
    const raster = (await img.readRasters({ window: [x0, ys, x1, ye], samples: [0] })) as unknown as ArrayLike<number>[];
    acc.addStrip(raster[0], x1 - x0, ye - ys, lons, lats);
  }
  sources.push(`WorldCover ${worldCoverName(t.lat, t.lon)}`);
  console.log(`  WorldCover ${worldCoverName(t.lat, t.lon)}: ok (${x1 - x0}×${y1 - y0} pixel)`);
}
const cover = acc.toClasses();

// ---- scrittura
const header: PackHeader = { version: PACK_VERSION, id, name, frame, cellM, cols: grid.cols, rows: grid.rows, minX: grid.minX, maxY: grid.maxY, sources, attribution: ATTRIBUTION, clutterHeightRelief: clutterRelief ? true : undefined };
const bytes = gzipSync(encodePack({ header, elevation, cover }), { level: 9 });
mkdirSync(out, { recursive: true });
const dest = join(out, `${id}.pack.gz`);
writeFileSync(dest, bytes);
writeCatalog(out);

let lo = Infinity;
let hi = -Infinity;
for (const v of elevation) { if (v < lo) lo = v; if (v > hi) hi = v; }
const share = [0, 1, 2, 3, 4].map((k) => `${["acqua", "aperto", "bosco", "abitato", "abitato denso"][k]} ${((100 * cover.reduce((n, c) => n + (c === k ? 1 : 0), 0)) / cover.length).toFixed(1)}%`);
console.log(`Quota ${lo}…${hi} m. Suolo: ${share.join(", ")}.`);
console.log(`Scritto ${dest} (${(bytes.length / 1024).toFixed(0)} KB). Centro: ${JSON.stringify(toGeo(frame, { x: 0, y: 0 }))}`);
