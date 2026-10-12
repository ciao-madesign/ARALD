/**
 * Area del mondo di una configurazione (puro, usato dal CLI, dal server e dalla pagina nel browser): quali tessere
 * servono per una rete, quali per una vista, e gli avvisi sulla qualità dei dati. Nessuna dipendenza da Node.
 */
import { areaWarnings, type TileIndex, tilesForLocalBounds } from "./geo-tile.js";
import type { NetworkConfig } from "./network-config.js";
import { type LocalFrame, toGeo, toLocal } from "./terrain.js";

export const WORLD_TERRAIN = "world";
/** Margine attorno ai dispositivi: gli aloni LoRa arrivano a decine di km. */
export const DEFAULT_MARGIN_M = 30_000;

/** Riquadro in metri locali dei dispositivi e dei punti dei loro percorsi. */
export function configBounds(cfg: NetworkConfig): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts = cfg.devices.flatMap((d) => [d, ...(d.route ?? [])]).map((p) => toLocal(cfg.frame, p));
  if (pts.length === 0) pts.push({ x: 0, y: 0 });
  return { minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)) };
}

export function requiredTiles(cfg: NetworkConfig, marginM = DEFAULT_MARGIN_M): TileIndex[] {
  return tilesForLocalBounds(cfg.frame, configBounds(cfg), marginM);
}

/** Avvisi sulla qualità dei dati per l'area di una configurazione (latitudine, distanza dal centro del riferimento). */
export function configWarnings(cfg: NetworkConfig, marginM = DEFAULT_MARGIN_M): string[] {
  const b = configBounds(cfg);
  const sw = toGeo(cfg.frame, { x: b.minX - marginM, y: b.minY - marginM });
  const ne = toGeo(cfg.frame, { x: b.maxX + marginM, y: b.maxY + marginM });
  return areaWarnings({ south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon }, cfg.frame);
}


/** Distanza (km) oltre la quale la proiezione locale sbaglia le distanze di qualche percento: si consiglia di ricentrare. */
export const FRAME_WARN_KM = 300;

/** Distanza approssimata (km) tra due punti geografici (equirettangolare locale, basta per un avviso). */
export function geoDistanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * 110.574;
  let dLon = b.lon - a.lon;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  return Math.hypot(dLat, dLon * 111.32 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180));
}

/**
 * Interpreta «lat, lon» scritte a mano: `46.5, 8.0`, `46.5 8.0`, `46,5; 8,0` (virgola decimale con il punto e virgola).
 * Una sola virgola tra due numeri è sempre il separatore (`46,8` = latitudine 46, longitudine 8); la virgola decimale
 * si usa con il punto e virgola o gli spazi. Restituisce null se non sono due numeri o se escono dai limiti (latitudine ±85°, longitudine ±180°).
 */
export function parseCoordinates(text: string): { lat: number; lon: number } | null {
  const t = text.trim();
  if (t === "" || t.length > 60) return null;
  let parts: string[];
  const dotted = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(t);
  if (dotted) parts = [dotted[1], dotted[2]];
  else parts = t.split(/\s*;\s*|\s+/).map((p) => p.replace(",", "."));
  if (parts.length !== 2 || !parts.every((p) => /^-?\d+(?:\.\d+)?$/.test(p))) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!(Math.abs(lat) <= 85 && Math.abs(lon) <= 180)) return null;
  return { lat, lon };
}
