/**
 * Logica pura della pagina del Network Design Tool (nessun DOM): trasformazioni della vista
 * sulla mappa, colori di qualità, modifica di una `NetworkConfig`. Il motore resta in
 * `tools/scenario-model/`: qui non c'è nessun calcolo radio.
 */
import type { NodeKind } from "../scenario-model/model.js";
import { type DeviceConfig, type NetworkConfig } from "../scenario-model/network-config.js";
import { type LocalFrame, toGeo, toLocal } from "../scenario-model/terrain.js";

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
