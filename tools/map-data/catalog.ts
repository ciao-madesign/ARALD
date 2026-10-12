/**
 * Costruzione del catalogo `index.json` a partire dai pacchetti presenti in una cartella (solo Node).
 * Il catalogo è un riassunto dei pacchetti: se non coincide con essi, un test lo segnala.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { type PackCatalog, CATALOG_VERSION, catalogEntryFor } from "../scenario-model/pack-catalog.js";
import { decodePack } from "../scenario-model/terrain-pack.js";
import { toGeo } from "../scenario-model/terrain.js";

export function buildCatalog(dir: string): PackCatalog {
  const files = readdirSync(dir).filter((f) => f.endsWith(".pack.gz")).sort();
  const packs = files.map((f) => {
    const { header } = decodePack(gunzipSync(readFileSync(join(dir, f))));
    if (f !== `${header.id}.pack.gz`) throw new Error(`Il file ${f} contiene il pacchetto "${header.id}": il nome deve coincidere con l'identificativo`);
    const sw = toGeo(header.frame, { x: header.minX, y: header.maxY - header.rows * header.cellM });
    const ne = toGeo(header.frame, { x: header.minX + header.cols * header.cellM, y: header.maxY });
    return catalogEntryFor(header, { south: round(sw.lat), west: round(sw.lon), north: round(ne.lat), east: round(ne.lon) }, statSync(join(dir, f)).size);
  });
  return { version: CATALOG_VERSION, packs };
}

const round = (x: number): number => Math.round(x * 1e4) / 1e4;

export function writeCatalog(dir: string): PackCatalog {
  const catalog = buildCatalog(dir);
  writeFileSync(join(dir, "index.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}
