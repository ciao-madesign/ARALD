/**
 * Lettura dei pacchetti di terreno da disco (solo Node). Nella pagina del tool i pacchetti si
 * leggono con `decodePack` dopo la decompressione del browser.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { PACK_ID_PATTERN, type TerrainPack, PackTerrain, decodePack, packOffset } from "../scenario-model/terrain-pack.js";
import type { LocalFrame } from "../scenario-model/terrain.js";

/**
 * Cartella dei pacchetti pronti: la prima `tools/network-design/data` che si trova risalendo da `start`
 * (default la cartella corrente), così CLI e test funzionano da qualunque sottocartella del repository.
 */
export function findPackDir(start: string = process.cwd()): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "tools", "network-design", "data");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(start, "tools", "network-design", "data");
}

export const PACK_PREFIX = "pack:";

export function loadPackFile(path: string): TerrainPack {
  return decodePack(gunzipSync(readFileSync(path)));
}

/**
 * Terreno reale per il riferimento "pack:<id>" di una configurazione. L'identificativo viene da un
 * file di configurazione (input non fidato): niente separatori di percorso, solo `[a-z0-9-]`.
 */
export function loadPackTerrain(ref: string, frame: LocalFrame, dir: string = findPackDir()): PackTerrain {
  const id = ref.startsWith(PACK_PREFIX) ? ref.slice(PACK_PREFIX.length) : ref;
  if (!PACK_ID_PATTERN.test(id)) throw new Error(`Identificativo di pacchetto non valido: ${JSON.stringify(id)}`);
  const file = join(dir, `${id}.pack.gz`);
  if (!existsSync(file)) throw new Error(`Pacchetto di terreno non trovato: ${id} (si prepara con npm run map-data, vedi docs/real-maps.md)`);
  const pack = loadPackFile(file);
  return new PackTerrain(pack, packOffset(pack, frame));
}
