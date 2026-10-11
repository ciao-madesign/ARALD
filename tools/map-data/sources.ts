/**
 * Fonti dei dati aperti per i pacchetti di terreno (docs/real-maps.md): nomi dei file, URL e lettura
 * del formato SRTM. Solo logica pura (nessuna rete qui): lo scarico è in `build-pack.mts`.
 */

/** Quote SRTM a 1 arcsecondo (~30 m), tessere di 1°×1° dai "terrain tiles" aperti su AWS. */
export const SKADI_BASE = "https://elevation-tiles-prod.s3.amazonaws.com/skadi";
/** Uso del suolo ESA WorldCover 2021 v200 (10 m), tessere di 3°×3° (GeoTIFF ottimizzati). */
export const WORLDCOVER_BASE = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map";

export const ATTRIBUTION =
  "Quote: SRTM (NASA/USGS), tramite AWS Terrain Tiles. Uso del suolo: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium, CC BY 4.0.";

function pad(n: number, w: number): string {
  return String(Math.abs(n)).padStart(w, "0");
}

/** Nome della tessera SRTM che ha per angolo sud-ovest (lat, lon) interi: "N44E007". */
export function skadiName(lat: number, lon: number): string {
  return `${lat >= 0 ? "N" : "S"}${pad(lat, 2)}${lon >= 0 ? "E" : "W"}${pad(lon, 3)}`;
}

export function skadiUrl(lat: number, lon: number): string {
  const name = skadiName(lat, lon);
  return `${SKADI_BASE}/${name.slice(0, 3)}/${name}.hgt.gz`;
}

/** Angolo sud-ovest (multiplo di 3°) della tessera WorldCover che contiene il punto. */
export function worldCoverCorner(lat: number, lon: number): { lat: number; lon: number } {
  return { lat: Math.floor(lat / 3) * 3, lon: Math.floor(lon / 3) * 3 };
}

export function worldCoverName(lat: number, lon: number): string {
  return `${lat >= 0 ? "N" : "S"}${pad(lat, 2)}${lon >= 0 ? "E" : "W"}${pad(lon, 3)}`;
}

export function worldCoverUrl(lat: number, lon: number): string {
  return `${WORLDCOVER_BASE}/ESA_WorldCover_10m_2021_v200_${worldCoverName(lat, lon)}_Map.tif`;
}

export interface HgtTile {
  /** Angolo sud-ovest, gradi interi. */
  lat: number;
  lon: number;
  /** Campioni per lato (3601 a 1 arcsecondo, 1201 a 3). */
  size: number;
  /** Righe da nord a sud, colonne da ovest a est; -32768 = dato mancante. */
  data: Int16Array;
}

/** Interpreta un file .hgt (int16 big-endian, quadrato). */
export function parseHgt(lat: number, lon: number, bytes: Uint8Array): HgtTile {
  const samples = bytes.length / 2;
  const size = Math.round(Math.sqrt(samples));
  if (!Number.isInteger(samples) || size * size !== samples || size < 2) throw new Error(`File HGT non valido: ${bytes.length} byte`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = new Int16Array(samples);
  for (let i = 0; i < samples; i++) data[i] = view.getInt16(2 * i, false);
  return { lat, lon, size, data };
}

export const HGT_VOID = -32768;

/** Tessere SRTM (angoli sud-ovest) che coprono un riquadro geografico. */
export function skadiTilesFor(box: { south: number; north: number; west: number; east: number }): { lat: number; lon: number }[] {
  const out: { lat: number; lon: number }[] = [];
  for (let la = Math.floor(box.south); la <= Math.floor(box.north); la++) for (let lo = Math.floor(box.west); lo <= Math.floor(box.east); lo++) out.push({ lat: la, lon: lo });
  return out;
}

/** Tessere WorldCover che coprono un riquadro geografico. */
export function worldCoverTilesFor(box: { south: number; north: number; west: number; east: number }): { lat: number; lon: number }[] {
  const a = worldCoverCorner(box.south, box.west);
  const b = worldCoverCorner(box.north, box.east);
  const out: { lat: number; lon: number }[] = [];
  for (let la = a.lat; la <= b.lat; la += 3) for (let lo = a.lon; lo <= b.lon; lo += 3) out.push({ lat: la, lon: lo });
  return out;
}
