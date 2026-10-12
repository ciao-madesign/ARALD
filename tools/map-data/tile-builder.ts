/**
 * Costruzione delle tessere del mondo da dati aperti: quote Terrarium (campionate sulla griglia geografica) e uso del
 * suolo WorldCover. Le fonti sono iniettabili (test senza rete). Una tessera non si scrive mai a metà o «piatta» per un
 * errore di rete: ogni errore interrompe quella tessera.
 */
import { CELL_DEG, TILE_CELLS, type GeoTile, type TileIndex, tileBounds, tileKey, validTile } from "../scenario-model/geo-tile.js";
import { GeoCoverAccumulator } from "./geo-cover.js";
import type { CoverSource } from "./worldcover-source.js";
import { type TerrariumFetcher, TerrariumSampler, decodeTerrarium, terrariumUrl } from "./terrarium.js";
import type { DirTileStore } from "./tile-cache.js";

export const TERRARIUM_SOURCE = "Quote: Terrarium (AWS Terrain Tiles; SRTM e altre fonti aperte)";
export const WORLDCOVER_SOURCE = "Uso del suolo: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium, CC BY 4.0";
/** Sopra questa quota massima una tessera ha terra emersa: senza WorldCover sarebbe un errore, non mare. */
const LAND_ELEVATION_M = 20;
const CELLS = TILE_CELLS * TILE_CELLS;

export interface BuildDeps {
  terrarium: TerrariumSampler;
  cover: CoverSource;
}

export async function buildTile(t: TileIndex, deps: BuildDeps): Promise<GeoTile> {
  if (!validTile(t)) throw new Error(`Tessera non valida: ${tileKey(t)}`);
  const b = tileBounds(t);
  await deps.terrarium.prepare({ south: b.south - CELL_DEG, west: b.west - CELL_DEG, north: b.north + CELL_DEG, east: b.east + CELL_DEG });
  const elevation = new Int16Array(TILE_CELLS * TILE_CELLS);
  let maxElev = 0;
  let noData = 0;
  for (let r = 0; r < TILE_CELLS; r++) {
    const lat = b.north - (r + 0.5) * CELL_DEG;
    for (let c = 0; c < TILE_CELLS; c++) {
      const v = deps.terrarium.sample(lat, b.west + (c + 0.5) * CELL_DEG);
      if (v === null) noData++;
      // i valori negativi (fondali marini) diventano 0: il livello del mare è la quota minima
      const e = v === null ? 0 : Math.max(0, Math.min(32767, Math.round(v)));
      elevation[r * TILE_CELLS + c] = e;
      if (e > maxElev) maxElev = e;
    }
  }
  const acc = new GeoCoverAccumulator(t);
  const fill = await deps.cover.fill(t, acc);
  if (!fill.found && maxElev > LAND_ELEVATION_M) throw new Error(`Tessera ${tileKey(t)}: ha terra emersa (fino a ${maxElev} m) ma l'uso del suolo non è disponibile: controlla la rete o riprova`);
  const cover = acc.toClasses();
  // Quote assenti (403/404 della fonte: anche un blocco di rete dà questa risposta) dove il suolo dice che c'è terra:
  // sarebbe una tessera di terra piatta a quota 0, un errore da non scrivere.
  let land = 0;
  for (const k of cover) if (k !== 0) land++;
  if (noData > CELLS / 2 && land > CELLS * 0.02) throw new Error(`Tessera ${tileKey(t)}: mancano le quote per un'area con terra (${Math.round((100 * noData) / CELLS)}% senza dato): controlla la rete o riprova`);
  return { tx: t.tx, ty: t.ty, sources: [TERRARIUM_SOURCE, ...(fill.found ? [WORLDCOVER_SOURCE] : [])], elevation, cover };
}

export interface EnsureOptions {
  concurrency?: number;
  /** Tetto alle tessere nuove da costruire in una chiamata (oltre: errore prima di cominciare). */
  maxNew?: number;
  onProgress?: (done: number, total: number, tile: TileIndex) => void;
}

export interface EnsureResult { cached: number; built: number }

/** Fa in modo che tutte le tessere siano nel deposito: costruisce solo quelle che mancano, poche alla volta. */
export async function ensureTiles(tiles: TileIndex[], store: DirTileStore, deps: BuildDeps, opts: EnsureOptions = {}): Promise<EnsureResult> {
  const missing = tiles.filter((t) => !store.isValid(t));
  const maxNew = opts.maxNew ?? 800;
  if (missing.length > maxNew) throw new Error(`Servono ${missing.length} tessere nuove (massimo ${maxNew} per volta): riduci l'area o alza il tetto`);
  let done = 0;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const queue = [...missing];
  let aborted = false; // un errore ferma tutti i lavoratori: nessuna tessera viene scritta dopo che la chiamata ha fallito
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let t = queue.shift(); t && !aborted; t = queue.shift()) {
      try {
        const built = await buildTile(t, deps);
        if (aborted) return;
        store.put(built);
      } catch (e) {
        aborted = true;
        throw e;
      }
      opts.onProgress?.(++done, missing.length, t);
    }
  });
  await Promise.all(workers);
  return { cached: tiles.length - missing.length, built: missing.length };
}

// ---------------------------------------------------------------- fonti reali

/**
 * Scarico di una tessera Terrarium con nuovi tentativi. La fonte serve OGNI tessera valida (anche oceani e poli, risposta
 * 200): una risposta diversa, 404 e 403 compresi, è un errore (rete, proxy, fonte cambiata) e non «nessun dato».
 */
export function networkTerrariumFetcher(userAgent = "arald-network-design-tool (research prototype)", fetchFn: typeof fetch = fetch): TerrariumFetcher {
  return async (z, x, y) => {
    const url = terrariumUrl(z, x, y);
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetchFn(url, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`Terrarium: risposta ${r.status} per ${url}`);
        return decodeTerrarium(new Uint8Array(await r.arrayBuffer()));
      } catch (e) {
        last = e;
        if (attempt < 2) await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  };
}
