/**
 * Tessere del mondo nel browser: le scarica dal server locale (`tiles/<tx>/<ty>`, mai dalle fonti esterne), le
 * decomprime e le tiene in memoria per `TileTerrain`, che le legge in modo sincrono. Il caricamento è a richiesta:
 * si chiede quello che serve (la rete, la vista) e ciò che manca resta «in caricamento» finché non arriva.
 * La rete è iniettabile per i test.
 */
import { type GeoTile, type TileIndex, type TileStore, decodeTile, tileKey, validTile } from "../scenario-model/geo-tile.js";
import { gunzip } from "./packs.js";

export interface TileResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
export type TileFetchFn = (url: string, init: { headers: Record<string, string> }) => Promise<TileResponse>;

/** Intestazione richiesta dal server locale (difesa contro richieste da altri siti, vedi serve-lib.mjs). */
export const TILE_HEADER = { "X-ARALD-Tool": "1" };
/** Tetto ai byte di una tessera decompressa: 8 + intestazione piccola + 3 byte per cella. */
const MAX_TILE_BYTES = 400_000;
/** Tessere decodificate tenute in memoria (~200 KB l'una); oltre, si scartano le più vecchie non richieste dalla chiamata. */
const DEFAULT_MAX_TILES = 500;
/** Dopo un errore su una tessera non si riprova per questo tempo (evita di martellare il server a ogni movimento). */
const RETRY_AFTER_MS = 20_000;

export class TileLoadError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class BrowserTileStore implements TileStore {
  private readonly tiles = new Map<string, GeoTile>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly failed = new Map<string, { at: number; error: TileLoadError }>();
  private pinned = new Set<string>();
  private visible = new Set<string>();
  private readonly activeKeeps = new Set<Set<string>>();

  constructor(
    private readonly baseUrl: string = "tiles/",
    private readonly fetchFn: TileFetchFn = (u, init) => fetch(u, init),
    private readonly maxTiles: number = DEFAULT_MAX_TILES,
    private readonly now: () => number = Date.now,
  ) {}

  get(tx: number, ty: number): GeoTile | undefined {
    return this.tiles.get(`${tx}_${ty}`);
  }

  has(t: TileIndex): boolean {
    return this.tiles.has(tileKey(t));
  }

  /** Tessere che non vanno mai scartate (quelle della rete in analisi: il calcolo le legge in modo sincrono). */
  pin(tiles: TileIndex[]): void {
    this.pinned = new Set(tiles.map(tileKey));
  }

  /** Tessere mostrate dalla vista adesso: non si scartano finché la vista non cambia. */
  setVisible(tiles: TileIndex[]): void {
    this.visible = new Set(tiles.map(tileKey));
  }

  get size(): number {
    return this.tiles.size;
  }

  /** Attribuzioni dei dati delle tessere caricate (senza ripetizioni). */
  sources(): string[] {
    const out = new Set<string>();
    for (const t of this.tiles.values()) for (const s of t.sources) out.add(s);
    return [...out];
  }

  /** Quota massima delle tessere indicate (per la scala di colore); 0 se nessuna è caricata. */
  maxElevation(tiles: TileIndex[]): number {
    let max = 0;
    for (const t of tiles) {
      const tile = this.tiles.get(tileKey(t));
      if (!tile) continue;
      for (const v of tile.elevation) if (v > max) max = v;
    }
    return max;
  }

  /** Le tessere che mancano e non sono in attesa di un nuovo tentativo dopo un errore. */
  missing(tiles: TileIndex[]): TileIndex[] {
    return tiles.filter((t) => validTile(t) && !this.tiles.has(tileKey(t)));
  }

  /** Il primo errore recente tra le tessere indicate, se ce n'è uno (per mostrarlo senza riprovare subito). */
  recentError(tiles: TileIndex[]): TileLoadError | null {
    const now = this.now();
    for (const t of tiles) {
      const f = this.failed.get(tileKey(t));
      if (f && now - f.at < RETRY_AFTER_MS) return f.error;
    }
    return null;
  }

  /**
   * Carica le tessere indicate (quattro alla volta), senza ripetere quelle già presenti o in corso. `onProgress` è
   * chiamata a ogni tessera arrivata. Se una fallisce le altre continuano; alla fine si lancia il primo errore.
   * Una tessera fallita da poco non si riprova subito (la chiamata la salta e rilancia l'errore ricordato).
   */
  async ensure(tiles: TileIndex[], opts: { onProgress?: (done: number, total: number) => void; concurrency?: number; isStale?: () => boolean } = {}): Promise<void> {
    const wanted = tiles.filter(validTile);
    const todo = wanted.filter((t) => !this.tiles.has(tileKey(t)));
    const total = todo.length;
    if (total === 0) return;
    let done = 0;
    let firstError: TileLoadError | null = null;
    const queue = [...todo];
    const keep = new Set(wanted.map(tileKey));
    this.activeKeeps.add(keep); // finché la chiamata è in corso, le sue tessere non si scartano
    const worker = async (): Promise<void> => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        if (opts.isStale?.()) return; // la richiesta non serve più (vista cambiata): si smette di scaricare
        try {
          await this.load(t);
        } catch (e) {
          firstError ??= e instanceof TileLoadError ? e : new TileLoadError((e as Error).message);
        }
        opts.onProgress?.(++done, total);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, total) }, worker));
    } finally {
      this.activeKeeps.delete(keep);
    }
    if (firstError) throw firstError;
  }

  private load(t: TileIndex): Promise<void> {
    const key = tileKey(t);
    const f = this.failed.get(key);
    if (f && this.now() - f.at < RETRY_AFTER_MS) return Promise.reject(f.error);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.fetchOne(t).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async fetchOne(t: TileIndex): Promise<void> {
    const key = tileKey(t);
    try {
      const r = await this.fetchFn(`${this.baseUrl}${t.tx}/${t.ty}`, { headers: TILE_HEADER });
      if (!r.ok) {
        let detail = "";
        try { detail = (await r.text()).slice(0, 300); } catch { /* il corpo non serve */ }
        throw new TileLoadError(detail || `Terreno non disponibile (risposta ${r.status})`, r.status);
      }
      const raw = new Uint8Array(await r.arrayBuffer());
      const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
      const tile = decodeTile(isGzip ? await gunzip(raw, MAX_TILE_BYTES) : raw);
      if (tile.tx !== t.tx || tile.ty !== t.ty) throw new TileLoadError(`La tessera ricevuta non è quella richiesta (${tile.tx}/${tile.ty} invece di ${t.tx}/${t.ty})`);
      this.tiles.set(key, tile);
      this.failed.delete(key);
      this.trim();
    } catch (e) {
      const error = e instanceof TileLoadError ? e : new TileLoadError(`Tessera ${key} non leggibile: ${(e as Error).message}`);
      this.failed.set(key, { at: this.now(), error });
      if (this.failed.size > 2000) this.failed.delete(this.failed.keys().next().value as string);
      throw error;
    }
  }

  /**
   * Quando si supera il tetto scarta le tessere meno recenti (per ordine di arrivo), mai quelle fissate (la rete), quelle
   * della vista e quelle richieste da una chiamata di `ensure` ancora in corso.
   */
  private trim(): void {
    if (this.tiles.size <= this.maxTiles) return;
    for (const k of this.tiles.keys()) {
      if (this.tiles.size <= this.maxTiles) break;
      if (this.pinned.has(k) || this.visible.has(k)) continue;
      let busy = false;
      for (const keep of this.activeKeeps) if (keep.has(k)) { busy = true; break; }
      if (!busy) this.tiles.delete(k);
    }
  }
}

/** Il servizio di tessere del server locale risponde? (falso aprendo la pagina da file: o con --no-tiles). */
export async function probeTileService(baseUrl = "tiles/", fetchFn: TileFetchFn = (u, init) => fetch(u, init)): Promise<boolean> {
  try {
    const r = await fetchFn(`${baseUrl}status`, { headers: TILE_HEADER });
    return r.ok;
  } catch {
    return false;
  }
}
