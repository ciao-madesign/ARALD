/**
 * Deposito su disco delle tessere del mondo (solo Node): una cartella `<ty>/<tx>.tile.gz`, lettura sincrona con una
 * piccola cache in memoria, scrittura atomica e tetto alla dimensione totale con eliminazione delle meno recenti.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { type GeoTile, type TileIndex, type TileStore, decodeTile, encodeTile, tileKey, validTile } from "../scenario-model/geo-tile.js";

/** Una tessera compressa pesa decine di KB; oltre questi limiti un file della cache non è una tessera (e non si decomprime). */
export const MAX_TILE_FILE_BYTES = 2_000_000;
export const MAX_TILE_RAW_BYTES = 1_000_000;

/** Tetto predefinito alla cache su disco (byte): 1,5 GB. */
export const DEFAULT_CACHE_CAP_BYTES = 1_500_000_000;

/** Cartella predefinita della cache: ARALD_TILE_CACHE, oppure `<cache utente>/arald-design-tool/tiles`. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.ARALD_TILE_CACHE) return env.ARALD_TILE_CACHE;
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "arald-design-tool", "tiles");
}

export function tilePath(dir: string, t: TileIndex): string {
  if (!validTile(t)) throw new Error(`Tessera non valida: ${tileKey(t)}`);
  return join(dir, String(t.ty), `${t.tx}.tile.gz`);
}

export class DirTileStore implements TileStore {
  private readonly mem = new Map<string, GeoTile>();
  // tessere illeggibili: ricordate finché non se ne scrive una, per non rileggere un file rotto a ogni campione
  private readonly misses = new Set<string>();

  constructor(readonly dir: string, private readonly maxInMemory = 300) {}

  /** Il file della tessera esiste (non dice se è integro: vedi `isValid`). */
  has(t: TileIndex): boolean {
    return validTile(t) && existsSync(tilePath(this.dir, t));
  }

  /** Esiste ed è leggibile; un file corrotto viene eliminato, così lo si ricostruisce invece di leggerci mare a quota 0. */
  isValid(t: TileIndex): boolean {
    if (!this.has(t)) return false;
    const key = `${t.tx}_${t.ty}`;
    this.misses.delete(key);
    this.mem.delete(key);
    if (this.get(t.tx, t.ty)) return true;
    rmSync(tilePath(this.dir, t), { force: true });
    return false;
  }

  /** Legge una tessera (dalla memoria o dal disco); una tessera illeggibile conta come assente, mai un errore a metà analisi. */
  get(tx: number, ty: number): GeoTile | undefined {
    const key = `${tx}_${ty}`;
    const hit = this.mem.get(key);
    if (hit) { this.mem.delete(key); this.mem.set(key, hit); return hit; }
    if (this.misses.has(key) || !validTile({ tx, ty })) return undefined;
    const path = tilePath(this.dir, { tx, ty });
    let tile: GeoTile;
    try {
      if (statSync(path).size > MAX_TILE_FILE_BYTES) throw new Error("file troppo grande per essere una tessera");
      tile = decodeTile(gunzipSync(readFileSync(path), { maxOutputLength: MAX_TILE_RAW_BYTES }));
    } catch {
      this.remember(key);
      return undefined;
    }
    if (tile.tx !== tx || tile.ty !== ty) { this.remember(key); return undefined; } // file nel posto sbagliato
    this.mem.set(key, tile);
    while (this.mem.size > this.maxInMemory) this.mem.delete(this.mem.keys().next().value as string);
    try { const now = new Date(); utimesSync(path, now, now); } catch { /* solo per l'ordine di eliminazione */ }
    return tile;
  }

  /** Scrive una tessera in modo atomico. */
  put(tile: GeoTile): void {
    const path = tilePath(this.dir, tile);
    mkdirSync(join(this.dir, String(tile.ty)), { recursive: true });
    const tmp = `${path}.${process.pid}.part`;
    writeFileSync(tmp, gzipSync(encodeTile(tile), { level: 6 }));
    renameSync(tmp, path);
    this.mem.set(`${tile.tx}_${tile.ty}`, tile);
    while (this.mem.size > this.maxInMemory) this.mem.delete(this.mem.keys().next().value as string);
    this.misses.delete(`${tile.tx}_${tile.ty}`);
  }

  private remember(key: string): void {
    if (this.misses.size > 5000) this.misses.clear();
    this.misses.add(key);
  }
}

/** File `.tile.gz` della cache con dimensione e istante dell'ultimo uso. */
export function listCache(dir: string): { path: string; bytes: number; mtimeMs: number }[] {
  const out: { path: string; bytes: number; mtimeMs: number }[] = [];
  if (!existsSync(dir)) return out;
  for (const row of readdirSync(dir)) {
    const sub = join(dir, row);
    let names: string[];
    try { names = readdirSync(sub); } catch { continue; }
    for (const f of names) {
      const isTile = f.endsWith(".tile.gz");
      if (!isTile && !f.endsWith(".part")) continue;
      let st;
      try { st = statSync(join(sub, f)); } catch { continue; } // eliminato nel frattempo da un altro processo
      if (!isTile) {
        if (Date.now() - st.mtimeMs > 3_600_000) rmSync(join(sub, f), { force: true }); // scrittura interrotta
        continue;
      }
      out.push({ path: join(sub, f), bytes: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/**
 * Tiene la cache sotto il tetto: oltre il tetto elimina le tessere meno recenti fino al 90% del tetto.
 * `protect` elenca tessere da non eliminare (quelle appena servite). Restituisce quante ne ha eliminate.
 */
export function enforceCap(dir: string, capBytes: number = DEFAULT_CACHE_CAP_BYTES, protect: ReadonlySet<string> = new Set()): number {
  const files = listCache(dir);
  let total = files.reduce((n, f) => n + f.bytes, 0);
  if (total <= capBytes) return 0;
  const target = capBytes * 0.9;
  let removed = 0;
  for (const f of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= target) break;
    if (protect.has(f.path)) continue;
    rmSync(f.path, { force: true });
    total -= f.bytes;
    removed++;
  }
  return removed;
}
