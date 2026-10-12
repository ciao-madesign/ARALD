/**
 * Terreno del mondo per una configurazione (solo Node): quali tessere servono e il terreno che le legge dalla cache.
 * Il riferimento `"terrain": "world"` di una configurazione usa questo terreno; le tessere si preparano con
 * `npm run map-tiles` (serve la rete) e poi l'analisi legge dalla cache, anche offline.
 */
import { areaWarnings, type TileIndex, TileTerrain, tilesForLocalBounds } from "../scenario-model/geo-tile.js";
import type { NetworkConfig } from "../scenario-model/network-config.js";
import { toGeo, toLocal } from "../scenario-model/terrain.js";
import { DirTileStore, defaultCacheDir } from "./tile-cache.js";

export const WORLD_TERRAIN = "world";
/** Margine attorno ai dispositivi: gli aloni LoRa arrivano a decine di km. */
export const DEFAULT_MARGIN_M = 30_000;

/** Riquadro in metri locali dei dispositivi e dei punti dei loro percorsi. */
export function configBounds(cfg: NetworkConfig): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts = cfg.devices.flatMap((d) => [d, ...(d.route ?? [])]).map((p) => toLocal(cfg.frame, p));
  if (pts.length === 0) pts.push({ x: 0, y: 0 });
  return { minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)) };
}

export function requiredTiles(cfg: NetworkConfig, marginM = DEFAULT_MARGIN_M): TileIndex[] {
  return tilesForLocalBounds(cfg.frame, configBounds(cfg), marginM);
}

/** Avvisi sulla qualità dei dati per l'area di una configurazione (latitudine, distanza dal centro del riferimento). */
export function configWarnings(cfg: NetworkConfig, marginM = DEFAULT_MARGIN_M): string[] {
  const b = configBounds(cfg);
  const sw = toGeo(cfg.frame, { x: b.minX - marginM, y: b.minY - marginM });
  const ne = toGeo(cfg.frame, { x: b.maxX + marginM, y: b.maxY + marginM });
  return areaWarnings({ south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon }, cfg.frame);
}

export interface WorldTerrain { terrain: TileTerrain; store: DirTileStore; missing: TileIndex[] }

/** Terreno del mondo dalla cache; `missing` sono le tessere necessarie che non ci sono ancora. */
export function loadWorldTerrain(cfg: NetworkConfig, dir: string = defaultCacheDir(), marginM = DEFAULT_MARGIN_M): WorldTerrain {
  const store = new DirTileStore(dir);
  return { terrain: new TileTerrain(cfg.frame, store), store, missing: requiredTiles(cfg, marginM).filter((t) => !store.isValid(t)) };
}
