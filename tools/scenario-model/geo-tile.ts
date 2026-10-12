/**
 * Terreno del mondo a tessere (docs/real-maps.md, "area ampia"). Il mondo è una griglia geografica regolare
 * di celle da 0,25°/256 (≈ 108,6 m in latitudine; in longitudine 108,6 m all'equatore, 77 m a 45°, 54 m a 60°),
 * divisa in tessere di 256×256 celle (0,25° di lato). Ogni tessera porta quota e classe d'uso del suolo.
 * `TileTerrain` implementa `Terrain` leggendo da un deposito di tessere già caricate: il motore, che chiede
 * quota e suolo in modo sincrono, non cambia. Chi chiama deve aver caricato prima le tessere che servono
 * (`tilesForLocalBounds`); quelle mancanti sono registrate e restituiscono quota 0 e «mare». Nessuna
 * dipendenza da Node.
 */
import { COVER_CLASSES } from "./terrain-pack.js";
import { type LandCover, type LocalFrame, type Terrain, toGeo } from "./terrain.js";

export const TILE_VERSION = 1;
export const TILE_CELLS = 256;
export const TILE_DEG = 0.25;
export const CELL_DEG = TILE_DEG / TILE_CELLS; // 2^-10: esatta in binario
export const TILES_X = 360 / TILE_DEG; // 1440
export const TILES_Y = 180 / TILE_DEG; // 720
/** Oltre questa latitudine le tessere non esistono (la proiezione e i dati peggiorano verso i poli). */
export const MAX_LAT = 85;
/** Latitudine oltre la quale le quote delle fonti aperte non sono più SRTM (meno precise). */
export const RELIABLE_LAT = 60;

export interface TileIndex { tx: number; ty: number }

export const tileKey = (t: TileIndex): string => `${t.tx}_${t.ty}`;

export function validTile(t: TileIndex): boolean {
  if (!Number.isInteger(t.tx) || !Number.isInteger(t.ty) || t.tx < 0 || t.tx >= TILES_X || t.ty < 0 || t.ty >= TILES_Y) return false;
  const north = 90 - t.ty * TILE_DEG;
  const south = north - TILE_DEG;
  return north <= MAX_LAT + TILE_DEG && south >= -MAX_LAT - TILE_DEG;
}

/** Tessera che contiene un punto geografico (latitudine limitata, longitudine riportata in [-180, 180)). */
export function tileOf(lat: number, lon: number): TileIndex {
  const gx = Math.floor((wrapLon(lon) + 180) / CELL_DEG);
  const gy = Math.floor((90 - lat) / CELL_DEG);
  return { tx: Math.floor(gx / TILE_CELLS), ty: Math.floor(gy / TILE_CELLS) };
}

function wrapLon(lon: number): number {
  const w = ((((lon + 180) % 360) + 360) % 360) - 180;
  return w;
}

/** Riquadro geografico di una tessera. */
export function tileBounds(t: TileIndex): { south: number; west: number; north: number; east: number } {
  const north = 90 - t.ty * TILE_DEG;
  const west = -180 + t.tx * TILE_DEG;
  return { south: north - TILE_DEG, west, north, east: west + TILE_DEG };
}

/** Tessere che coprono un riquadro geografico, escluse quelle fuori dai limiti di latitudine. */
export function tilesForGeoBox(box: { south: number; west: number; north: number; east: number }): TileIndex[] {
  if (!(box.south <= box.north && box.west <= box.east)) throw new Error("Riquadro geografico non valido");
  if (box.east - box.west >= 360) throw new Error("Riquadro geografico troppo largo");
  const ty0 = tileOf(Math.min(MAX_LAT, box.north), 0).ty;
  const ty1 = tileOf(Math.max(-MAX_LAT, box.south), 0).ty;
  // colonne contate senza avvolgere (un riquadro attorno a 180° ha longitudini oltre il limite), poi riportate in [0, TILES_X)
  const c0 = Math.floor((box.west + 180) / TILE_DEG);
  const c1 = Math.floor((box.east + 180) / TILE_DEG);
  const out: TileIndex[] = [];
  const seen = new Set<number>();
  for (let c = c0; c <= c1; c++) {
    const tx = ((c % TILES_X) + TILES_X) % TILES_X;
    if (seen.has(tx)) continue;
    seen.add(tx);
    for (let ty = ty0; ty <= ty1; ty++) if (validTile({ tx, ty })) out.push({ tx, ty });
  }
  return out;
}

/** Tessere per un riquadro in metri locali di una configurazione, con un margine in metri. */
export function tilesForLocalBounds(frame: LocalFrame, b: { minX: number; minY: number; maxX: number; maxY: number }, marginM = 0): TileIndex[] {
  const sw = toGeo(frame, { x: b.minX - marginM, y: b.minY - marginM });
  const ne = toGeo(frame, { x: b.maxX + marginM, y: b.maxY + marginM });
  return tilesForGeoBox({ south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon });
}

// ---------------------------------------------------------------- tessera

export interface GeoTile {
  tx: number;
  ty: number;
  /** Provenienza dei dati di questa tessera (testo libero, per l'attribuzione). */
  sources: string[];
  /** Quota (m s.l.m., mai negativa), righe da nord a sud, colonne da ovest a est. */
  elevation: Int16Array;
  /** Indice in `COVER_CLASSES`. */
  cover: Uint8Array;
}

const MAGIC = [0x41, 0x52, 0x54, 0x47]; // "ARTG"
const N = TILE_CELLS * TILE_CELLS;

export function encodeTile(t: GeoTile): Uint8Array {
  if (t.elevation.length !== N || t.cover.length !== N) throw new Error("Tessera incoerente: servono 256×256 celle");
  const head = new TextEncoder().encode(JSON.stringify({ version: TILE_VERSION, tx: t.tx, ty: t.ty, sources: t.sources }));
  const out = new Uint8Array(8 + head.length + 3 * N);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, head.length, true);
  out.set(head, 8);
  let off = 8 + head.length;
  for (let r = 0; r < TILE_CELLS; r++) {
    let prev = 0;
    for (let c = 0; c < TILE_CELLS; c++) {
      const v = t.elevation[r * TILE_CELLS + c];
      view.setInt16(off, ((v - prev) << 16) >> 16, true);
      prev = v;
      off += 2;
    }
  }
  out.set(t.cover, off);
  return out;
}

/** Legge e valida una tessera (input non fidato: un file di cache o una risposta del server). */
export function decodeTile(bytes: Uint8Array): GeoTile {
  if (bytes.length < 8 || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error("Non è una tessera di terreno ARALD");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headLen = view.getUint32(4, true);
  if (headLen > 100_000 || 8 + headLen > bytes.length) throw new Error("Intestazione della tessera non valida");
  if (bytes.length !== 8 + headLen + 3 * N) throw new Error("Tessera troncata o con dati in eccesso");
  let h: { version?: unknown; tx?: unknown; ty?: unknown; sources?: unknown };
  try {
    h = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headLen)));
  } catch {
    throw new Error("Intestazione della tessera non leggibile");
  }
  if (typeof h !== "object" || h === null || h.version !== TILE_VERSION) throw new Error("Versione della tessera non supportata");
  const tile = { tx: h.tx as number, ty: h.ty as number };
  if (typeof tile.tx !== "number" || typeof tile.ty !== "number" || !validTile(tile)) throw new Error("Indice di tessera non valido");
  const elevation = new Int16Array(N);
  let off = 8 + headLen;
  for (let r = 0; r < TILE_CELLS; r++) {
    let prev = 0;
    for (let c = 0; c < TILE_CELLS; c++) {
      prev = (prev + view.getInt16(off, true)) << 16 >> 16;
      elevation[r * TILE_CELLS + c] = prev;
      off += 2;
    }
  }
  const cover = bytes.slice(off, off + N);
  for (let i = 0; i < N; i++) if (cover[i] >= COVER_CLASSES.length) throw new Error("Tessera: classe di suolo sconosciuta");
  return { ...tile, sources: Array.isArray(h.sources) ? h.sources.filter((s): s is string => typeof s === "string").slice(0, 20) : [], elevation, cover };
}

// ---------------------------------------------------------------- terreno

/** Deposito di tessere già caricate: la lettura è sincrona, chi lo riempie lo fa prima (asincrono). */
export interface TileStore {
  get(tx: number, ty: number): GeoTile | undefined;
}

/** Terreno del mondo da un deposito di tessere. Riferimento locale: l'origine della configurazione (`frame`). */
export class TileTerrain implements Terrain {
  readonly name: string;
  /** Con antenne a quota nota il disturbo del suolo dipende dall'altezza (Terrain.clutterHeightRelief). */
  readonly clutterHeightRelief = true;
  private readonly missing = new Map<string, TileIndex>();
  private lastTx = -1;
  private lastTy = -1;
  private lastTile: GeoTile | undefined;

  constructor(private readonly frame: LocalFrame, private readonly store: TileStore, name = "Mondo (tessere SRTM + WorldCover)") {
    this.name = name;
  }

  /** Tessere chieste e non trovate dall'ultimo `clearMissing()`: da caricare prima di fidarsi dei risultati. */
  missingTiles(): TileIndex[] {
    return [...this.missing.values()];
  }

  clearMissing(): void {
    this.missing.clear();
  }

  private noteMissing(tx: number, ty: number): void {
    const k = `${tx}_${ty}`;
    if (this.missing.size < 5000 && !this.missing.has(k)) this.missing.set(k, { tx, ty });
  }

  /** Cella (indici globali) → tessera e posizione nella tessera; undefined se la tessera manca. */
  private cellAt(gx: number, gy: number): { tile: GeoTile; i: number } | undefined {
    const tx = Math.floor(gx / TILE_CELLS);
    const ty = Math.floor(gy / TILE_CELLS);
    if (ty < 0 || ty >= TILES_Y) return undefined;
    const wtx = ((tx % TILES_X) + TILES_X) % TILES_X;
    let tile: GeoTile | undefined;
    if (wtx === this.lastTx && ty === this.lastTy) tile = this.lastTile; // un profilo resta quasi sempre nella stessa tessera
    else {
      tile = this.store.get(wtx, ty);
      if (tile) { this.lastTx = wtx; this.lastTy = ty; this.lastTile = tile; } // una tessera mancante non si ricorda: potrebbe arrivare dopo
    }
    if (!tile) { this.noteMissing(wtx, ty); return undefined; }
    return { tile, i: (gy - ty * TILE_CELLS) * TILE_CELLS + (gx - tx * TILE_CELLS) };
  }

  /** Il punto sta in una tessera caricata? */
  contains(x: number, y: number): boolean {
    const g = toGeo(this.frame, { x, y });
    if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) return false;
    const t = tileOf(g.lat, g.lon);
    return validTile(t) && this.store.get(t.tx, t.ty) !== undefined;
  }

  /** Quota con interpolazione bilineare tra i centri delle celle (anche a cavallo di due tessere); 0 dove manca il dato. */
  elevationAt(x: number, y: number): number {
    const g = toGeo(this.frame, { x, y });
    if (!(Number.isFinite(g.lat) && Number.isFinite(g.lon)) || Math.abs(g.lat) > 90) return 0;
    const fx = (wrapLon(g.lon) + 180) / CELL_DEG - 0.5;
    const fy = (90 - g.lat) / CELL_DEG - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    let sum = 0;
    let weight = 0;
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
        if (w === 0) continue;
        const c = this.cellAt(x0 + dx, y0 + dy);
        if (!c) continue;
        sum += c.tile.elevation[c.i] * w;
        weight += w;
      }
    }
    return weight > 0 ? sum / weight : 0;
  }

  /** Classe d'uso del suolo della cella che contiene il punto; «mare» dove manca il dato. */
  landCoverAt(x: number, y: number): LandCover {
    const g = toGeo(this.frame, { x, y });
    if (!(Number.isFinite(g.lat) && Number.isFinite(g.lon)) || Math.abs(g.lat) > 90) return "sea";
    const c = this.cellAt(Math.floor((wrapLon(g.lon) + 180) / CELL_DEG), Math.floor((90 - g.lat) / CELL_DEG));
    return c ? COVER_CLASSES[c.tile.cover[c.i]] : "sea";
  }
}

/** Avvisi sulla qualità dei dati per un'area: latitudini poco affidabili e riferimento locale troppo lontano dal centro. */
export function areaWarnings(geoBox: { south: number; west: number; north: number; east: number }, frame: LocalFrame): string[] {
  const out: string[] = [];
  if (geoBox.north > RELIABLE_LAT || geoBox.south < -RELIABLE_LAT) out.push(`L'area va oltre i ${RELIABLE_LAT}° di latitudine: là le quote delle fonti aperte non vengono da SRTM e sono meno precise.`);
  if (Math.abs(geoBox.north) > MAX_LAT || Math.abs(geoBox.south) > MAX_LAT) out.push(`Oltre i ${MAX_LAT}° di latitudine non ci sono dati.`);
  const spanKm = Math.max(geoBox.north - geoBox.south, (geoBox.east - geoBox.west) * Math.cos((frame.lat0 * Math.PI) / 180)) * 110.57;
  if (spanKm > 300) out.push(`L'area è larga circa ${Math.round(spanKm)} km: oltre 300 km la proiezione locale sbaglia le distanze di qualche percento (ricentra la rete).`);
  return out;
}
