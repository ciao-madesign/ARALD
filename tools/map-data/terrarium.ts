/**
 * Quote dalle tessere aperte "Terrarium" (AWS terrain tiles: SRTM e altre fonti, proiezione Mercatore,
 * PNG 256×256 con la quota in R·256 + G + B/256 − 32768 metri). A zoom 10 un pixel è ≈ 153 m all'equatore
 * e ≈ 108 m a 45° di latitudine, la scala delle celle del mondo a tessere (`geo-tile.ts`).
 */
import { decodePng } from "./png.js";

export const TERRARIUM_BASE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
export const TERRARIUM_ZOOM = 10;
const SIDE = 256;
/** Il Mercatore non arriva ai poli. */
const MAX_MERCATOR_LAT = 85.0511;

export const terrariumUrl = (z: number, x: number, y: number): string => `${TERRARIUM_BASE}/${z}/${x}/${y}.png`;

/** Pixel globale (con parte frazionaria) di un punto geografico a un dato zoom. */
export function mercatorPixel(lat: number, lon: number, z: number): { px: number; py: number } {
  const n = 2 ** z * SIDE;
  const la = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat)) * (Math.PI / 180);
  return {
    px: ((((lon + 180) % 360) + 360) % 360 / 360) * n,
    py: ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n,
  };
}

/** Quote in metri da un PNG Terrarium. */
export function decodeTerrarium(png: Uint8Array): Float32Array {
  const d = decodePng(png);
  if (d.width !== SIDE || d.height !== SIDE) throw new Error(`Tessera Terrarium di ${d.width}×${d.height} invece di ${SIDE}×${SIDE}`);
  const out = new Float32Array(SIDE * SIDE);
  for (let i = 0; i < out.length; i++) out[i] = d.data[i * d.channels] * 256 + d.data[i * d.channels + 1] + d.data[i * d.channels + 2] / 256 - 32768;
  return out;
}

export type TerrariumFetcher = (z: number, x: number, y: number) => Promise<Float32Array | null>;

/** Campionatore di quota su un mosaico di tessere Terrarium, con una piccola cache delle tessere già decodificate. */
export class TerrariumSampler {
  private readonly cache = new Map<string, Float32Array | null>();
  private readonly pending = new Map<string, Promise<Float32Array | null>>();

  constructor(private readonly fetchTile: TerrariumFetcher, private readonly z = TERRARIUM_ZOOM, private readonly maxCached = 160) {}

  private get(x: number, y: number): Promise<Float32Array | null> {
    const key = `${x}/${y}`;
    if (this.cache.has(key)) {
      const v = this.cache.get(key)!;
      this.cache.delete(key); // riporta in fondo (più recente)
      this.cache.set(key, v);
      return Promise.resolve(v);
    }
    let p = this.pending.get(key);
    if (!p) {
      p = this.fetchTile(this.z, x, y).then((v) => {
        this.cache.set(key, v);
        while (this.cache.size > this.maxCached) this.cache.delete(this.cache.keys().next().value as string);
        return v;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  /**
   * Carica le tessere che coprono un riquadro (con un pixel di margine); da chiamare prima di `sample`.
   * Un riquadro a cavallo dell'antimeridiano (ovest a destra dell'est sui pixel) carica le tessere di entrambi i lati.
   */
  async prepare(box: { south: number; west: number; north: number; east: number }): Promise<void> {
    const a = mercatorPixel(box.north, box.west, this.z);
    const b = mercatorPixel(box.south, box.east, this.z);
    const tiles = 2 ** this.z;
    const last = tiles - 1;
    const x0 = Math.floor((a.px - 1) / SIDE);
    const x1 = Math.floor((b.px + 1) / SIDE);
    const count = Math.min(tiles, ((((x1 - x0) % tiles) + tiles) % tiles) + 1);
    const y0 = Math.max(0, Math.floor((a.py - 1) / SIDE));
    const y1 = Math.min(last, Math.floor((b.py + 1) / SIDE));
    const jobs: Promise<unknown>[] = [];
    for (let y = y0; y <= y1; y++) for (let i = 0; i < count; i++) jobs.push(this.get(((((x0 + i) % tiles) + tiles) % tiles), y));
    await Promise.all(jobs);
  }

  private at(px: number, py: number): number | null {
    const x = Math.floor(px / SIDE);
    const y = Math.floor(py / SIDE);
    const t = this.cache.get(`${x}/${y}`);
    if (t === undefined) throw new Error(`Tessera Terrarium ${this.z}/${x}/${y} non caricata (chiama prepare() prima di sample(), e tieni la cache abbastanza grande)`);
    if (t === null) return null;
    return t[(py - y * SIDE) * SIDE + (px - x * SIDE)];
  }

  /** Quota con interpolazione bilineare tra i pixel; null se una tessera manca (mare aperto o non caricata). */
  sample(lat: number, lon: number): number | null {
    const { px, py } = mercatorPixel(lat, lon, this.z);
    const fx = px - 0.5;
    const fy = py - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const n = 2 ** this.z * SIDE;
    let sum = 0;
    let weight = 0;
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
        if (w === 0) continue;
        const gx = ((x0 + dx) % n + n) % n;
        const gy = y0 + dy;
        if (gy < 0 || gy >= n) continue;
        const v = this.at(gx, gy);
        if (v === null) continue;
        sum += v * w;
        weight += w;
      }
    }
    return weight > 0 ? sum / weight : null;
  }
}
