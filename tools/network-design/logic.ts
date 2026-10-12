/**
 * Logica pura della pagina del Network Design Tool (nessun DOM): trasformazioni della vista
 * sulla mappa, colori di qualità, modifica di una `NetworkConfig`. Il motore resta in
 * `tools/scenario-model/`: qui non c'è nessun calcolo radio.
 */
import type { NodeKind } from "../scenario-model/model.js";
import { PackTerrain } from "../scenario-model/terrain-pack.js";
import { type DeviceConfig, type NetworkConfig } from "../scenario-model/network-config.js";
import { type LandCover, type LocalFrame, type Terrain, toGeo, toLocal } from "../scenario-model/terrain.js";

// ---------------------------------------------------------------- vista

/** Finestra sulla mappa: centro in metri locali, metri per pixel, dimensioni in pixel. */
export interface View { cx: number; cy: number; mPerPx: number; w: number; h: number }

export const MIN_M_PER_PX = 1;
export const MAX_M_PER_PX = 2000;

export function worldToScreen(v: View, x: number, y: number): { x: number; y: number } {
  return { x: v.w / 2 + (x - v.cx) / v.mPerPx, y: v.h / 2 - (y - v.cy) / v.mPerPx };
}

export function screenToWorld(v: View, sx: number, sy: number): { x: number; y: number } {
  return { x: v.cx + (sx - v.w / 2) * v.mPerPx, y: v.cy - (sy - v.h / 2) * v.mPerPx };
}

/** Vista che contiene tutti i punti, con un margine (frazione della dimensione). */
export function fitView(points: { x: number; y: number }[], w: number, h: number, margin = 0.15, minSpanM = 2000): View {
  if (points.length === 0) return { cx: 0, cy: 0, mPerPx: Math.max(MIN_M_PER_PX, minSpanM / Math.max(1, Math.min(w, h))), w, h };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const spanX = Math.max(Math.max(...xs) - Math.min(...xs), minSpanM);
  const spanY = Math.max(Math.max(...ys) - Math.min(...ys), minSpanM);
  const mPerPx = Math.min(MAX_M_PER_PX, Math.max(MIN_M_PER_PX, Math.max(spanX / (w * (1 - 2 * margin)), spanY / (h * (1 - 2 * margin)))));
  return { cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2, mPerPx, w, h };
}

/** Zoom attorno a un punto dello schermo: il punto del mondo sotto il cursore resta fermo. */
export function zoomAt(v: View, sx: number, sy: number, factor: number): View {
  const before = screenToWorld(v, sx, sy);
  const mPerPx = Math.min(MAX_M_PER_PX, Math.max(MIN_M_PER_PX, v.mPerPx * factor));
  const next = { ...v, mPerPx };
  const after = screenToWorld(next, sx, sy);
  return { ...next, cx: v.cx + (before.x - after.x), cy: v.cy + (before.y - after.y) };
}

/** Riquadro del mondo visibile. */
export function viewBounds(v: View): { minX: number; minY: number; maxX: number; maxY: number } {
  const a = screenToWorld(v, 0, v.h);
  const b = screenToWorld(v, v.w, 0);
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}

/** Lato (m) delle celle di un alone per la vista: circa `cols` colonne, multiplo di 50 m, almeno 50. */
export function haloCellM(v: View, cols = 60): number {
  return Math.max(50, Math.round((v.w * v.mPerPx) / cols / 50) * 50);
}

// ---------------------------------------------------------------- colori

/** Qualità 0-1 → colore dallo spettro rosso → giallo → verde (docs/network-design-tool.md §6). */
export function qualityColor(q: number, lightness = 45): string {
  const hue = Math.round(120 * Math.min(1, Math.max(0, q)));
  return `hsl(${hue} 72% ${lightness}%)`;
}

// ---------------------------------------------------------------- modifica della configurazione

export const KIND_LABEL: Record<NodeKind, string> = {
  box: "ARALD Box",
  portable: "ARALD Portable",
  relay: "Fixed Relay",
  card: "ARALD Card",
  phone: "Smartphone",
};

const ID_PREFIX: Record<NodeKind, string> = { box: "BOX", portable: "PORT", relay: "FR", card: "C", phone: "P" };

/** Identificativo libero per un nuovo dispositivo di un tipo (BOX, BOX2, C1, C2, …). */
export function nextDeviceId(devices: { id: string }[], kind: NodeKind): string {
  const taken = new Set(devices.map((d) => d.id));
  const prefix = ID_PREFIX[kind];
  if (kind !== "card" && kind !== "phone" && !taken.has(prefix)) return prefix;
  for (let i = kind === "card" || kind === "phone" ? 1 : 2; ; i++) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

function replaceDevice(cfg: NetworkConfig, id: string, f: (d: DeviceConfig) => DeviceConfig): NetworkConfig {
  return { ...cfg, devices: cfg.devices.map((d) => (d.id === id ? f(d) : d)) };
}

/**
 * Sposta un dispositivo in (x, y) locali. La posizione di riferimento è quella mostrata sulla mappa:
 * per un mobile la partenza del percorso, non il suo (lat, lon) fisso. Posizione e percorso si
 * spostano dello stesso scarto, così restano coerenti tra loro.
 */
export function moveDevice(cfg: NetworkConfig, id: string, x: number, y: number): NetworkConfig {
  return replaceDevice(cfg, id, (d) => {
    const base = toLocal(cfg.frame, d.route ? d.route[0] : d);
    const dx = x - base.x;
    const dy = y - base.y;
    const shift = (p: { lat: number; lon: number }): { lat: number; lon: number } => {
      const q = toLocal(cfg.frame, p);
      return toGeo(cfg.frame, { x: q.x + dx, y: q.y + dy });
    };
    const next: DeviceConfig = { ...d, ...shift(d) };
    if (d.route) next.route = d.route.map((r) => ({ tS: r.tS, ...shift(r) }));
    return next;
  });
}

export function addDevice(cfg: NetworkConfig, kind: NodeKind, x: number, y: number): { cfg: NetworkConfig; id: string } {
  const id = nextDeviceId(cfg.devices, kind);
  const g = toGeo(cfg.frame, { x, y });
  return { cfg: { ...cfg, devices: [...cfg.devices, { id, kind, lat: g.lat, lon: g.lon }] }, id };
}

/** Modifica alcuni campi di un dispositivo senza toccare l'originale (le configurazioni sono immutabili, lo storico le conserva). */
export function updateDevice(cfg: NetworkConfig, id: string, patch: Partial<Pick<DeviceConfig, "label" | "heightAglM" | "kind">>): NetworkConfig {
  return replaceDevice(cfg, id, (d) => {
    const next: DeviceConfig = { ...d, ...patch };
    // un campo vuoto si toglie (non si salva `undefined` come valore esplicito)
    if (next.label === undefined || next.label === "") delete next.label;
    if (next.heightAglM === undefined) delete next.heightAglM;
    return next;
  });
}

/** Imposta (o toglie, con `undefined`) il percorso di un dispositivo; la posizione fissa segue la partenza. */
export function setDeviceRoute(cfg: NetworkConfig, id: string, route: DeviceConfig["route"] | undefined): NetworkConfig {
  return replaceDevice(cfg, id, (d) => {
    const next: DeviceConfig = { ...d };
    if (route === undefined) { delete next.route; return next; }
    next.route = route;
    next.lat = route[0].lat;
    next.lon = route[0].lon;
    return next;
  });
}

/** Copia di un dispositivo (nuovo identificativo, spostata di dx, dy metri; il percorso si sposta con lei). */
export function duplicateDevice(cfg: NetworkConfig, id: string, dx: number, dy: number): { cfg: NetworkConfig; id: string } | null {
  const src = cfg.devices.find((d) => d.id === id);
  if (!src) return null;
  const nid = nextDeviceId(cfg.devices, src.kind);
  // coordinate sempre dentro i limiti accettati da parseNetworkConfig (±85° di latitudine, ±180° di longitudine)
  const shift = (p: { lat: number; lon: number }): { lat: number; lon: number } => {
    const q = toLocal(cfg.frame, p);
    const g = toGeo(cfg.frame, { x: q.x + dx, y: q.y + dy });
    return { lat: Math.max(-85, Math.min(85, g.lat)), lon: Math.max(-180, Math.min(180, g.lon)) };
  };
  const copy: DeviceConfig = { ...src, id: nid, ...shift(src) };
  // "X (copia)", mai "X (copia) (copia)", e il nome resta nel limite di 200 caratteri
  if (src.label) copy.label = `${src.label.replace(/( \(copia\))+$/, "").slice(0, 180)} (copia)`;
  if (src.route) copy.route = src.route.map((r) => ({ tS: r.tS, ...shift(r) }));
  return { cfg: { ...cfg, devices: [...cfg.devices, copy] }, id: nid };
}

export function removeDevice(cfg: NetworkConfig, id: string): NetworkConfig {
  return { ...cfg, devices: cfg.devices.filter((d) => d.id !== id) };
}

export function deviceLocal(frame: LocalFrame, d: { lat: number; lon: number }): { x: number; y: number } {
  return toLocal(frame, d);
}

/** Testo di una distanza: "850 m" o "3,2 km". */
export function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1).replace(".", ",")} km` : `${Math.round(m)} m`;
}

/** Testo di una velocità in bit/s. */
export function fmtRate(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1).replace(".", ",")} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(bps >= 1e4 ? 0 : 1).replace(".", ",")} kbps`;
  return `${bps.toFixed(0)} bps`;
}

// ---------------------------------------------------------------- terreno sotto un punto

export interface GroundInfo {
  /** Quota del suolo (m s.l.m.). */
  elevationM: number;
  cover: LandCover;
  /** false se il punto è fuori dall'area dei dati reali (quota 0 e «mare» sono allora solo un valore di ripiego). */
  inside: boolean;
}

export const COVER_LABEL: Record<LandCover, string> = { sea: "acqua", open: "aperto", forest: "bosco", urban: "abitato", "urban-dense": "abitato denso" };

/** Cosa c'è sotto un punto (x, y locali): per un terreno senza limiti noti (sintetico) `inside` è sempre vero. */
export function groundAt(terrain: Terrain, x: number, y: number): GroundInfo {
  const inside = terrain instanceof PackTerrain ? terrain.contains(x, y) : true;
  return { elevationM: terrain.elevationAt(x, y), cover: terrain.landCoverAt(x, y), inside };
}

/** Avvisi leggibili per la posizione di un dispositivo; vuoto se tutto regolare. */
export function groundWarnings(g: GroundInfo, kind: NodeKind, mobile: boolean): string[] {
  const out: string[] = [];
  if (!g.inside) out.push("Fuori dall'area dei dati reali: quota e suolo non sono noti, i risultati che lo riguardano non sono affidabili.");
  else if (g.cover === "sea" && !mobile) out.push(kind === "relay" || kind === "box" || kind === "portable" ? "Il punto è in acqua: controlla la posizione (un dispositivo fisso in mare è raro)." : "Il punto è in acqua.");
  return out;
}

/** Identificativi dei dispositivi la cui posizione (o un punto del percorso) cade fuori dall'area dei dati reali; vuoto per un terreno senza limiti noti. */
export function devicesOutside(terrain: Terrain, cfg: NetworkConfig): string[] {
  if (!(terrain instanceof PackTerrain)) return [];
  return cfg.devices.filter((d) => [d, ...(d.route ?? [])].some((q) => { const p = toLocal(cfg.frame, q); return !terrain.contains(p.x, p.y); })).map((d) => d.id);
}
