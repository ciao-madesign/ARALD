/**
 * Catalogo dei pacchetti di terreno disponibili (`tools/network-design/data/index.json`): serve alla
 * pagina per sapere quali aree esistono, dove, e quanto pesano, senza scaricarle. Neutro rispetto
 * a Node e browser; il catalogo è input non fidato (un file servito o scelto dall'utente).
 */
import { MAX_PACK_CELLS, PACK_ID_PATTERN, type PackHeader } from "./terrain-pack.js";

export const CATALOG_VERSION = 1;
export const MAX_CATALOG_PACKS = 500;

export interface PackCatalogEntry {
  id: string;
  name: string;
  /** Nome del file nella stessa cartella del catalogo: sempre `<id>.pack.gz`. */
  file: string;
  bytes: number;
  /** Riquadro geografico coperto (gradi). */
  bbox: { south: number; west: number; north: number; east: number };
  frame: { lat0: number; lon0: number };
  cellM: number;
  cols: number;
  rows: number;
  attribution: string;
}

export interface PackCatalog {
  version: typeof CATALOG_VERSION;
  packs: PackCatalogEntry[];
}

function num(x: unknown, min: number, max: number): number | null {
  return typeof x === "number" && Number.isFinite(x) && x >= min && x <= max ? x : null;
}

/** Valida un catalogo; una voce non valida è un errore (non si scarta in silenzio). */
export function parseCatalog(raw: unknown): PackCatalog {
  const o = raw as { version?: unknown; packs?: unknown } | null;
  if (typeof o !== "object" || o === null || o.version !== CATALOG_VERSION) throw new Error("Catalogo dei pacchetti: versione non supportata");
  if (!Array.isArray(o.packs) || o.packs.length > MAX_CATALOG_PACKS) throw new Error("Catalogo dei pacchetti: elenco mancante o troppo lungo");
  const seen = new Set<string>();
  const packs = o.packs.map((p: unknown, i): PackCatalogEntry => {
    const e = p as Partial<PackCatalogEntry> | null;
    const where = `Catalogo dei pacchetti, voce ${i}`;
    if (typeof e !== "object" || e === null) throw new Error(`${where}: non è un oggetto`);
    if (typeof e.id !== "string" || !PACK_ID_PATTERN.test(e.id)) throw new Error(`${where}: identificativo non valido`);
    if (seen.has(e.id)) throw new Error(`${where}: identificativo duplicato (${e.id})`);
    seen.add(e.id);
    if (e.file !== `${e.id}.pack.gz`) throw new Error(`${where}: il file deve chiamarsi ${e.id}.pack.gz`);
    if (typeof e.name !== "string" || e.name === "" || e.name.length > 200) throw new Error(`${where}: nome non valido`);
    const bytes = num(e.bytes, 1, 2_000_000_000);
    const b = e.bbox;
    const south = num(b?.south, -90, 90);
    const north = num(b?.north, -90, 90);
    const west = num(b?.west, -180, 180);
    const east = num(b?.east, -180, 180);
    const lat0 = num(e.frame?.lat0, -85, 85);
    const lon0 = num(e.frame?.lon0, -180, 180);
    const cellM = num(e.cellM, 1, 100_000);
    const cols = num(e.cols, 1, 1e6);
    const rows = num(e.rows, 1, 1e6);
    if (bytes === null || south === null || north === null || west === null || east === null || south >= north || west >= east) throw new Error(`${where}: dimensioni o riquadro non validi`);
    if (lat0 === null || lon0 === null || cellM === null || cols === null || rows === null || !Number.isInteger(cols) || !Number.isInteger(rows)) throw new Error(`${where}: origine o griglia non valide`);
    if (cols * rows > MAX_PACK_CELLS) throw new Error(`${where}: griglia troppo grande (${cols * rows} celle, massimo ${MAX_PACK_CELLS})`);
    if (lat0 < south || lat0 > north || lon0 < west || lon0 > east) throw new Error(`${where}: l'origine non è dentro il riquadro`);
    // l'attribuzione è richiesta dalle licenze dei dati: una voce senza testo non è valida
    if (typeof e.attribution !== "string" || e.attribution.trim() === "" || e.attribution.length > 1000) throw new Error(`${where}: attribuzione mancante o troppo lunga`);
    return { id: e.id, name: e.name, file: e.file, bytes, bbox: { south, west, north, east }, frame: { lat0, lon0 }, cellM, cols, rows, attribution: e.attribution };
  });
  return { version: CATALOG_VERSION, packs };
}

/** Voce di catalogo per un pacchetto già scritto (`bytes` = dimensione del file compresso). */
export function catalogEntryFor(header: PackHeader, bbox: PackCatalogEntry["bbox"], bytes: number): PackCatalogEntry {
  return {
    id: header.id, name: header.name, file: `${header.id}.pack.gz`, bytes, bbox,
    frame: { lat0: header.frame.lat0, lon0: header.frame.lon0 }, cellM: header.cellM, cols: header.cols, rows: header.rows, attribution: header.attribution,
  };
}
