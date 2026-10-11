/**
 * Terreno reale per il motore: un "pacchetto" è una griglia regolare in metri locali (quota in m e
 * classe d'uso del suolo) preparata da dati aperti (SRTM per la quota, ESA WorldCover per il suolo)
 * dallo script `tools/map-data/build-pack.mts`. `PackTerrain` implementa la stessa interfaccia
 * `Terrain` dei territori sintetici, quindi il motore non cambia. Nessuna dipendenza da Node:
 * funziona uguale nella pagina del tool (docs/real-maps.md).
 *
 * Formato binario (prima della compressione gzip, applicata a parte): "ARTP", u32 lunghezza
 * dell'intestazione, intestazione JSON, quota int16 (differenze orizzontali, riga per riga),
 * classi u8. Una cella contiene un valore al centro; il bordo nord-ovest della griglia è (minX, maxY).
 */
import { type LandCover, type LocalFrame, type Terrain, toLocal } from "./terrain.js";

export const PACK_VERSION = 1;
/** Tetto alle celle di un pacchetto (un file non fidato non deve poter allocare senza limite). */
export const MAX_PACK_CELLS = 40_000_000;
/** Identificativo valido di un pacchetto (nome di file e riferimento "pack:<id>"): una sola definizione per script e caricatore. */
export const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Classi d'uso del suolo memorizzate, per indice. */
export const COVER_CLASSES: readonly LandCover[] = ["sea", "open", "forest", "urban", "urban-dense"];

export interface PackHeader {
  version: typeof PACK_VERSION;
  id: string;
  name: string;
  /** Origine delle coordinate locali del pacchetto (il centro dell'area). */
  frame: LocalFrame;
  cellM: number;
  cols: number;
  rows: number;
  /** x del bordo ovest e y del bordo nord della griglia, in metri locali del pacchetto. */
  minX: number;
  maxY: number;
  /** Provenienza dei dati e attribuzione richiesta dalle licenze. */
  sources: string[];
  attribution: string;
  /** Vedi `Terrain.clutterHeightRelief`. */
  clutterHeightRelief?: boolean;
}

export interface TerrainPack {
  header: PackHeader;
  /** Quota (m s.l.m.), righe da nord a sud, colonne da ovest a est. */
  elevation: Int16Array;
  /** Indice in `COVER_CLASSES`. */
  cover: Uint8Array;
}

const MAGIC = [0x41, 0x52, 0x54, 0x50]; // "ARTP"

export function encodePack(pack: TerrainPack): Uint8Array {
  const { header, elevation, cover } = pack;
  const n = header.cols * header.rows;
  if (elevation.length !== n || cover.length !== n) throw new Error("Pacchetto incoerente: la dimensione dei dati non corrisponde alla griglia");
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + head.length + 2 * n + n);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, head.length, true);
  out.set(head, 8);
  const view = new DataView(out.buffer);
  let off = 8 + head.length;
  for (let r = 0; r < header.rows; r++) {
    let prev = 0;
    for (let c = 0; c < header.cols; c++) {
      const v = elevation[r * header.cols + c];
      view.setInt16(off, (v - prev) << 16 >> 16, true); // differenza con avvolgimento a 16 bit
      prev = v;
      off += 2;
    }
  }
  out.set(cover, off);
  return out;
}

function finite(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Legge e valida un pacchetto (input non fidato: un file scaricato o scelto dall'utente). */
export function decodePack(bytes: Uint8Array): TerrainPack {
  if (bytes.length < 8 || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error("Non è un pacchetto di terreno ARALD");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headLen = view.getUint32(4, true);
  if (headLen > 1_000_000 || 8 + headLen > bytes.length) throw new Error("Intestazione del pacchetto non valida");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headLen)));
  } catch {
    throw new Error("Intestazione del pacchetto non leggibile");
  }
  const h = raw as Partial<PackHeader> | null;
  if (typeof h !== "object" || h === null || h.version !== PACK_VERSION) throw new Error("Versione del pacchetto non supportata");
  const frame = h.frame as Partial<LocalFrame> | undefined;
  if (!(typeof h.id === "string" && typeof h.name === "string" && frame && finite(frame.lat0) && finite(frame.lon0) && Math.abs(frame.lat0) <= 85 && Math.abs(frame.lon0) <= 180)) throw new Error("Pacchetto: identificativo o origine non validi");
  if (!(finite(h.cellM) && h.cellM > 0 && Number.isInteger(h.cols) && Number.isInteger(h.rows) && (h.cols as number) > 0 && (h.rows as number) > 0 && finite(h.minX) && finite(h.maxY))) throw new Error("Pacchetto: griglia non valida");
  const cols = h.cols as number;
  const rows = h.rows as number;
  const n = cols * rows;
  if (n > MAX_PACK_CELLS) throw new Error(`Pacchetto troppo grande (${n} celle, massimo ${MAX_PACK_CELLS})`);
  if (bytes.length !== 8 + headLen + 3 * n) throw new Error("Pacchetto troncato o con dati in eccesso");
  const header: PackHeader = {
    version: PACK_VERSION, id: h.id, name: h.name, frame: { lat0: frame.lat0 as number, lon0: frame.lon0 as number },
    cellM: h.cellM, cols, rows, minX: h.minX as number, maxY: h.maxY as number,
    sources: Array.isArray(h.sources) ? h.sources.filter((s): s is string => typeof s === "string") : [],
    attribution: typeof h.attribution === "string" ? h.attribution : "",
    clutterHeightRelief: h.clutterHeightRelief === true ? true : undefined,
  };
  const elevation = new Int16Array(n);
  let off = 8 + headLen;
  for (let r = 0; r < rows; r++) {
    let prev = 0;
    for (let c = 0; c < cols; c++) {
      prev = (prev + view.getInt16(off, true)) << 16 >> 16;
      elevation[r * cols + c] = prev;
      off += 2;
    }
  }
  const cover = bytes.slice(off, off + n);
  for (let i = 0; i < n; i++) if (cover[i] >= COVER_CLASSES.length) throw new Error("Pacchetto: classe di suolo sconosciuta");
  return { header, elevation, cover };
}

/**
 * Territorio reale da un pacchetto. `offset` è la posizione, nelle coordinate locali del motore,
 * dell'origine del pacchetto: serve quando la configurazione usa un'origine diversa
 * (`packOffset()`); per una configurazione con la stessa origine è zero.
 */
export class PackTerrain implements Terrain {
  readonly name: string;
  readonly clutterHeightRelief: boolean | undefined;
  readonly pack: TerrainPack;
  private readonly ox: number;
  private readonly oy: number;

  constructor(pack: TerrainPack, offset: { x: number; y: number } = { x: 0, y: 0 }) {
    this.pack = pack;
    this.name = pack.header.name;
    this.clutterHeightRelief = pack.header.clutterHeightRelief;
    this.ox = offset.x;
    this.oy = offset.y;
  }

  /** Riquadro coperto, nelle coordinate locali del motore. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    const h = this.pack.header;
    return { minX: h.minX + this.ox, maxX: h.minX + h.cols * h.cellM + this.ox, maxY: h.maxY + this.oy, minY: h.maxY - h.rows * h.cellM + this.oy };
  }

  contains(x: number, y: number): boolean {
    const b = this.bounds();
    return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
  }

  /**
   * Quota con interpolazione bilineare tra i centri delle celle; 0 fuori dal pacchetto (una parete
   * brusca: chi usa il terreno deve verificare con `contains()` che dispositivi e percorsi stiano dentro,
   * come fa il CLI).
   */
  elevationAt(x: number, y: number): number {
    const h = this.pack.header;
    const fx = (x - this.ox - h.minX) / h.cellM - 0.5;
    const fy = (h.maxY - (y - this.oy)) / h.cellM - 0.5;
    if (!(fx >= -0.5 && fy >= -0.5 && fx <= h.cols - 0.5 && fy <= h.rows - 0.5)) return 0;
    const x0 = Math.min(h.cols - 1, Math.max(0, Math.floor(fx)));
    const y0 = Math.min(h.rows - 1, Math.max(0, Math.floor(fy)));
    const x1 = Math.min(h.cols - 1, x0 + 1);
    const y1 = Math.min(h.rows - 1, y0 + 1);
    const tx = Math.min(1, Math.max(0, fx - x0));
    const ty = Math.min(1, Math.max(0, fy - y0));
    const e = this.pack.elevation;
    const top = e[y0 * h.cols + x0] * (1 - tx) + e[y0 * h.cols + x1] * tx;
    const bottom = e[y1 * h.cols + x0] * (1 - tx) + e[y1 * h.cols + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  }

  /** Classe d'uso del suolo della cella che contiene il punto; mare fuori dal pacchetto. */
  landCoverAt(x: number, y: number): LandCover {
    const h = this.pack.header;
    const c = Math.floor((x - this.ox - h.minX) / h.cellM);
    const r = Math.floor((h.maxY - (y - this.oy)) / h.cellM);
    if (!(c >= 0 && r >= 0 && c < h.cols && r < h.rows)) return "sea"; // fuori dal riquadro, o coordinata non numerica
    return COVER_CLASSES[this.pack.cover[r * h.cols + c]];
  }
}

/** Spostamento da applicare a un `PackTerrain` usato con un'origine (`frame`) diversa da quella del pacchetto. */
export function packOffset(pack: TerrainPack, frame: LocalFrame): { x: number; y: number } {
  return toLocal(frame, { lat: pack.header.frame.lat0, lon: pack.header.frame.lon0 });
}
