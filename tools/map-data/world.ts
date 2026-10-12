/**
 * Terreno del mondo per una configurazione (solo Node): il terreno che legge le tessere dalla cache su disco.
 * Il riferimento `"terrain": "world"` di una configurazione usa questo terreno; le tessere si preparano con
 * `npm run map-tiles` (serve la rete) e poi l'analisi legge dalla cache, anche offline. Quali tessere servono
 * e gli avvisi sono in `scenario-model/world-area.ts` (puro, condiviso con la pagina).
 */
import { type TileIndex, TileTerrain } from "../scenario-model/geo-tile.js";
import type { NetworkConfig } from "../scenario-model/network-config.js";
import { DEFAULT_MARGIN_M, requiredTiles } from "../scenario-model/world-area.js";
import { DirTileStore, defaultCacheDir } from "./tile-cache.js";

export { DEFAULT_MARGIN_M, WORLD_TERRAIN, configBounds, configWarnings, requiredTiles } from "../scenario-model/world-area.js";

export interface WorldTerrain { terrain: TileTerrain; store: DirTileStore; missing: TileIndex[] }

/** Terreno del mondo dalla cache; `missing` sono le tessere necessarie che non ci sono ancora. */
export function loadWorldTerrain(cfg: NetworkConfig, dir: string = defaultCacheDir(), marginM = DEFAULT_MARGIN_M): WorldTerrain {
  const store = new DirTileStore(dir);
  return { terrain: new TileTerrain(cfg.frame, store), store, missing: requiredTiles(cfg, marginM).filter((t) => !store.isValid(t)) };
}
