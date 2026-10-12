/**
 * Servizio di tessere del mondo per il server locale del tool (solo Node): dà alla pagina una tessera alla volta,
 * dalla cache su disco o costruendola al momento da Terrarium + WorldCover. Il browser non contatta mai le fonti.
 * Limiti ai download: poche costruzioni insieme, una coda corta, un tetto di tessere nuove all'ora e il tetto di
 * dimensione della cache (eliminazione delle meno recenti). Ogni limite risponde con un errore chiaro, mai in silenzio.
 */
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { type GeoTile, type TileIndex, validTile } from "../scenario-model/geo-tile.js";
import { TerrariumSampler } from "./terrarium.js";
import { type BuildDeps, buildTile, networkTerrariumFetcher } from "./tile-builder.js";
import { DEFAULT_CACHE_CAP_BYTES, DirTileStore, defaultCacheDir, enforceCap, listCache, tilePath } from "./tile-cache.js";
import { WorldCoverSource } from "./worldcover-source.js";

export class TileServiceError extends Error {
  /** Marca per riconoscere gli errori di questo servizio (il server HTTP mostra il messaggio solo di questi). */
  readonly isTileServiceError = true;
  constructor(readonly status: number, message: string, readonly retryAfterS?: number) {
    super(message);
  }
}

export interface TileServiceOptions {
  dir?: string;
  capBytes?: number;
  /** Costruzioni contemporanee (default 4). */
  concurrency?: number;
  /** Richieste di costruzione in attesa oltre quelle in corso (default 64): oltre, 429. */
  maxQueue?: number;
  /** Tessere nuove ammesse nell'ultima ora (default 400, ~27 mila km² di rete): oltre, 429 con il tempo di attesa. */
  maxNewPerHour?: number;
  /** Tempo massimo per costruire una tessera (default 180 s): oltre, 502 e il posto si libera. */
  buildTimeoutMs?: number;
  /** Fonti dei dati; di norma create al primo bisogno (rete reale). */
  deps?: BuildDeps | (() => BuildDeps);
  now?: () => number;
}

const HOUR_MS = 3_600_000;
const ENFORCE_EVERY_MS = 30_000;
const PROTECT_MS = 600_000; // una tessera servita da meno di 10 minuti non viene eliminata dal tetto
const STATUS_EVERY_MS = 5_000;
const MAX_FAILURES_PER_HOUR = 100;

export class TileService {
  readonly dir: string;
  readonly capBytes: number;
  private readonly store: DirTileStore;
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly maxNewPerHour: number;
  private readonly now: () => number;
  private depsOpt: BuildDeps | (() => BuildDeps) | undefined;
  private depsValue: BuildDeps | undefined;
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private readonly waiting: (() => void)[] = [];
  private running = 0;
  private inProgress = 0;
  private readonly builtAt: number[] = [];
  private readonly failedAt: number[] = [];
  private readonly buildTimeoutMs: number;
  private lastEnforce = 0;
  private builtSinceEnforce = false;
  private enforceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly recent = new Map<string, number>();
  // tessere già verificate (decodificate) in questo processo: le successive letture non rifanno la decodifica
  private readonly verified = new Set<string>();
  private statusCache: { at: number; value: ReturnType<TileService["status"]> } | undefined;

  constructor(opts: TileServiceOptions = {}) {
    this.dir = opts.dir ?? defaultCacheDir();
    this.capBytes = opts.capBytes ?? DEFAULT_CACHE_CAP_BYTES;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.maxQueue = Math.max(0, opts.maxQueue ?? 64);
    this.maxNewPerHour = Math.max(0, opts.maxNewPerHour ?? 400);
    this.now = opts.now ?? Date.now;
    this.buildTimeoutMs = opts.buildTimeoutMs ?? 180_000;
    this.depsOpt = opts.deps;
    this.store = new DirTileStore(this.dir);
  }

  private deps(): BuildDeps {
    if (!this.depsValue) {
      const d = this.depsOpt;
      this.depsValue = typeof d === "function" ? d() : d ?? { terrarium: new TerrariumSampler(networkTerrariumFetcher()), cover: new WorldCoverSource() };
    }
    return this.depsValue;
  }

  /** Una tessera in forma compressa (gzip del formato ARTG), dalla cache o costruita ora. */
  async get(tx: number, ty: number): Promise<{ data: Buffer; cached: boolean }> {
    const t: TileIndex = { tx, ty };
    if (!Number.isInteger(tx) || !Number.isInteger(ty) || !validTile(t)) throw new TileServiceError(404, "Tessera fuori dai limiti del mondo (latitudine oltre ±85° o indice non valido)");
    const key = `${tx}_${ty}`;
    if (this.verified.has(key) ? existsSync(tilePath(this.dir, t)) : this.store.isValid(t)) {
      try {
        const data = this.read(t);
        if (this.verified.size > 20_000) this.verified.clear();
        this.verified.add(key);
        return { data, cached: true };
      } catch {
        this.verified.delete(key); // sparita o illeggibile: si ricostruisce
      }
    }
    let p = this.inflight.get(key);
    if (!p) {
      p = this.build(t).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return { data: await p, cached: false };
  }

  private read(t: TileIndex): Buffer {
    const path = tilePath(this.dir, t);
    const data = readFileSync(path);
    try { const n = new Date(); utimesSync(path, n, n); } catch { /* solo per l'ordine di eliminazione */ }
    const now = this.now();
    this.recent.delete(path);
    this.recent.set(path, now);
    for (const [k, at] of this.recent) { if (now - at < PROTECT_MS) break; this.recent.delete(k); }
    return data;
  }

  private async build(t: TileIndex): Promise<Buffer> {
    const now = this.now();
    while (this.builtAt.length > 0 && now - this.builtAt[0] >= HOUR_MS) this.builtAt.shift();
    while (this.failedAt.length > 0 && now - this.failedAt[0] >= HOUR_MS) this.failedAt.shift();
    // il tetto conta le tessere costruite e quelle già in lavorazione; un fallimento non consuma il tetto, ma
    // troppi fallimenti di seguito fermano i tentativi (una fonte irraggiungibile non va martellata)
    if (this.builtAt.length + this.inProgress >= this.maxNewPerHour) {
      const wait = this.builtAt.length === 0 ? 3600 : Math.max(1, Math.ceil((this.builtAt[0] + HOUR_MS - now) / 1000));
      throw new TileServiceError(429, `Troppe tessere nuove nell'ultima ora (massimo ${this.maxNewPerHour}): riprova tra ${Math.ceil(wait / 60)} minuti o usa «npm run map-tiles»`, wait);
    }
    if (this.failedAt.length >= MAX_FAILURES_PER_HOUR) throw new TileServiceError(429, "Troppi tentativi falliti nell'ultima ora: le fonti di terreno non rispondono, riprova più tardi", 300);
    if (this.running >= this.concurrency && this.waiting.length >= this.maxQueue) throw new TileServiceError(429, "Troppe richieste in coda: riprova tra poco", 5);
    this.inProgress++;
    let built: GeoTile;
    try {
      await this.acquire();
      try {
        built = await this.withTimeout(buildTile(t, this.deps()));
        this.store.put(built);
      } catch (e) {
        this.failedAt.push(this.now());
        if (e instanceof TileServiceError) throw e;
        throw new TileServiceError(502, `Costruzione della tessera non riuscita (fonti non raggiungibili o dati assenti): ${(e as Error).message}`);
      } finally {
        this.release();
      }
    } finally {
      this.inProgress--;
    }
    this.builtAt.push(this.now());
    this.builtSinceEnforce = true;
    let data: Buffer;
    try {
      data = this.read(t); // subito, e protetta, prima che il tetto della cache possa eliminarla
    } catch (e) {
      throw new TileServiceError(500, `Lettura della cache locale non riuscita: ${(e as Error).message}`);
    }
    this.verified.add(`${t.tx}_${t.ty}`);
    this.maybeEnforce();
    return data;
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`tempo scaduto dopo ${Math.round(this.buildTimeoutMs / 1000)} s`)), this.buildTimeoutMs); });
    p.catch(() => undefined); // se vince il tempo, l'errore tardivo non resta senza gestore
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private acquire(): Promise<void> {
    if (this.running < this.concurrency) { this.running++; return Promise.resolve(); }
    return new Promise((res) => this.waiting.push(() => { this.running++; res(); }));
  }

  private release(): void {
    this.running--;
    this.waiting.shift()?.();
  }

  /**
   * Tiene la cache sotto il tetto: subito, oppure (se l'ultima verifica è recente) con un'unica verifica differita,
   * così il tetto è rispettato anche dopo l'ultima costruzione di una raffica.
   */
  private maybeEnforce(): void {
    if (!this.builtSinceEnforce) return;
    const wait = this.lastEnforce + ENFORCE_EVERY_MS - this.now();
    if (wait > 0) {
      if (!this.enforceTimer) {
        this.enforceTimer = setTimeout(() => { this.enforceTimer = undefined; this.maybeEnforce(); }, wait + 10);
        this.enforceTimer.unref?.();
      }
      return;
    }
    this.lastEnforce = this.now();
    this.builtSinceEnforce = false;
    try {
      enforceCap(this.dir, this.capBytes, new Set(this.recent.keys()));
      this.statusCache = undefined;
    } catch { /* la cache resta usabile */ }
  }

  /** Stato della cache; la scansione del disco si rifà al più ogni 5 s. */
  status(): { dir: string; tiles: number; bytes: number; capBytes: number; newLastHour: number; maxNewPerHour: number } {
    const now = this.now();
    if (!this.statusCache || now - this.statusCache.at >= STATUS_EVERY_MS) {
      const files = listCache(this.dir);
      this.statusCache = { at: now, value: { dir: this.dir, tiles: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), capBytes: this.capBytes, newLastHour: 0, maxNewPerHour: this.maxNewPerHour } };
    }
    return { ...this.statusCache.value, newLastHour: this.builtAt.filter((x) => now - x < HOUR_MS).length };
  }
}
