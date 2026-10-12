/**
 * Uso del suolo per le tessere del mondo da ESA WorldCover (GeoTIFF ottimizzati su S3, 3°×3°). Si leggono solo
 * le finestre che servono, con letture a intervalli di byte, e dal livello di sintesi (overview) più grossolano
 * il cui pixel è almeno la metà di una cella: ~750×750 pixel per tessera invece di 3000×3000 a 10 m.
 */
import { type GeoTIFF, type GeoTIFFImage, fromUrl } from "geotiff";
import { CELL_DEG, type TileIndex, tileBounds } from "../scenario-model/geo-tile.js";
import { GeoCoverAccumulator } from "./geo-cover.js";
import { worldCoverCorner, worldCoverName, worldCoverUrl } from "./sources.js";

export interface CoverFill {
  /** false se la fonte non ha dati per l'area (mare aperto: WorldCover non pubblica le tessere solo di mare). */
  found: boolean;
  sources: string[];
}

export interface CoverSource {
  fill(tile: TileIndex, acc: GeoCoverAccumulator): Promise<CoverFill>;
}

interface Handle { tiff: GeoTIFF; base: GeoTIFFImage; images: GeoTIFFImage[] }

const STRIP_ROWS = 1024;

/**
 * Sonda l'esistenza di un file senza scaricarlo. S3 risponde 404 («NoSuchKey», intestazione `Server: AmazonS3`) per le
 * tessere solo di mare, che WorldCover non pubblica: quella è l'unica risposta che vale «non c'è». Qualunque altra
 * risposta (403, 5xx, un 404 senza la firma di S3 come ne dà un proxy) è un errore, mai «mare».
 */
export async function probeWorldCover(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const r = await fetchFn(url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(30_000) });
  if (r.status === 404 && r.headers.get("server") === "AmazonS3") return false;
  if (!r.ok) throw new Error(`WorldCover: risposta ${r.status} per ${url}`);
  await r.arrayBuffer();
  return true;
}

export class WorldCoverSource implements CoverSource {
  private readonly handles = new Map<string, Promise<Handle | null>>();

  constructor(private readonly maxHandles = 6) {}

  private open(lat0: number, lon0: number): Promise<Handle | null> {
    const key = worldCoverName(lat0, lon0);
    let p = this.handles.get(key);
    if (!p) {
      p = (async (): Promise<Handle | null> => {
        const url = worldCoverUrl(lat0, lon0);
        if (!(await probeWorldCover(url))) return null;
        const tiff = await fromUrl(url);
        const n = await tiff.getImageCount();
        const images: GeoTIFFImage[] = [];
        for (let i = 0; i < n; i++) images.push(await tiff.getImage(i));
        return { tiff, base: images[0], images };
      })().catch((e) => { if (this.handles.get(key) === p) this.handles.delete(key); throw e; });
      this.handles.set(key, p);
      while (this.handles.size > this.maxHandles) this.handles.delete(this.handles.keys().next().value as string);
    }
    return p;
  }

  async fill(tile: TileIndex, acc: GeoCoverAccumulator): Promise<CoverFill> {
    const box = tileBounds(tile);
    const corner = worldCoverCorner(box.south, box.west);
    const h = await this.open(corner.lat, corner.lon);
    if (!h) return { found: false, sources: [] };
    const [ox, oy] = h.base.getOrigin();
    const [rx, ry] = h.base.getResolution();
    // livello più grossolano con pixel ≤ metà cella (in gradi); il livello 0 se nessuno basta
    let level = 0;
    for (let i = h.images.length - 1; i >= 0; i--) {
      const pxDeg = Math.abs(rx) * (h.base.getWidth() / h.images[i].getWidth());
      if (pxDeg <= CELL_DEG / 2) { level = i; break; }
    }
    const img = h.images[level];
    const sx = rx * (h.base.getWidth() / img.getWidth());
    const sy = ry * (h.base.getHeight() / img.getHeight());
    const x0 = Math.max(0, Math.floor((box.west - ox) / sx));
    const x1 = Math.min(img.getWidth(), Math.ceil((box.east - ox) / sx));
    const y0 = Math.max(0, Math.floor((box.north - oy) / sy));
    const y1 = Math.min(img.getHeight(), Math.ceil((box.south - oy) / sy));
    if (x1 <= x0 || y1 <= y0) return { found: false, sources: [] };
    const lons = new Float64Array(x1 - x0);
    for (let j = 0; j < lons.length; j++) lons[j] = ox + (x0 + j + 0.5) * sx;
    for (let ys = y0; ys < y1; ys += STRIP_ROWS) {
      const ye = Math.min(y1, ys + STRIP_ROWS);
      const lats = new Float64Array(ye - ys);
      for (let i = 0; i < lats.length; i++) lats[i] = oy + (ys + i + 0.5) * sy;
      const raster = (await img.readRasters({ window: [x0, ys, x1, ye], samples: [0] })) as unknown as ArrayLike<number>[];
      acc.addStrip(raster[0], x1 - x0, ye - ys, lons, lats);
    }
    return { found: true, sources: [`WorldCover ${worldCoverName(corner.lat, corner.lon)}`] };
  }
}
