/**
 * Percorsi dei dispositivi mobili: dalla bozza disegnata sulla mappa (tappe, soste, velocità, partenza)
 * al `route` della configurazione (istanti in secondi, coordinate geografiche), e ritorno. Solo calcolo,
 * nessuna interfaccia. Il motore usa il percorso per i contatti opportunistici (docs/network-resilience.md).
 */
import type { DeviceConfig } from "../scenario-model/network-config.js";
import { type LocalFrame, toGeo, toLocal } from "../scenario-model/terrain.js";

export interface RouteStop { x: number; y: number; /** Sosta alla tappa, in minuti. */ pauseMin: number }

export interface RouteDraft {
  /** Punto di partenza (la posizione del dispositivo), in metri locali. */
  start: { x: number; y: number };
  /** Tappe dopo la partenza, nell'ordine. */
  stops: RouteStop[];
  speedKmh: number;
  /** Il dispositivo resta alla partenza per questi minuti prima di muoversi. */
  startDelayMin: number;
}

/** Velocità tipiche per scegliere in fretta (ipotesi, km/h). */
export const SPEED_PRESETS: { label: string; kmh: number }[] = [
  { label: "A piedi", kmh: 4 },
  { label: "Bicicletta", kmh: 15 },
  { label: "Auto o fuoristrada", kmh: 40 },
  { label: "Barca", kmh: 25 },
  { label: "Aliscafo", kmh: 60 },
  { label: "Elicottero", kmh: 150 },
];

export const MAX_ROUTE_SECONDS = 1e7; // il limite di parseNetworkConfig per un istante
export const MAX_ROUTE_POINTS = 10000;
const MIN_STEP_S = 1;

export interface RoutePoint { x: number; y: number; tS: number }

/** Punti del percorso (metri locali e istanti): partenza, attesa, tappe e soste. */
export function routePoints(d: RouteDraft): RoutePoint[] {
  if (!(d.speedKmh > 0) || !Number.isFinite(d.speedKmh)) throw new Error("La velocità deve essere maggiore di zero");
  if (d.stops.length === 0) throw new Error("Servono almeno una tappa dopo la partenza");
  if (!(d.startDelayMin >= 0) || !Number.isFinite(d.startDelayMin)) throw new Error("La partenza non può essere negativa");
  const ms = d.speedKmh / 3.6;
  const out: RoutePoint[] = [{ x: d.start.x, y: d.start.y, tS: 0 }];
  let t = 0;
  if (d.startDelayMin > 0) { t = d.startDelayMin * 60; out.push({ x: d.start.x, y: d.start.y, tS: t }); }
  let prev = d.start;
  for (const s of d.stops) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) throw new Error("Tappa con coordinate non valide");
    if (!(s.pauseMin >= 0) || !Number.isFinite(s.pauseMin)) throw new Error("La sosta non può essere negativa");
    t += Math.max(MIN_STEP_S, Math.hypot(s.x - prev.x, s.y - prev.y) / ms);
    out.push({ x: s.x, y: s.y, tS: t });
    if (s.pauseMin > 0) { t += s.pauseMin * 60; out.push({ x: s.x, y: s.y, tS: t }); }
    prev = s;
  }
  if (out.length > MAX_ROUTE_POINTS) throw new Error(`Percorso troppo lungo (oltre ${MAX_ROUTE_POINTS} punti)`);
  if (t > MAX_ROUTE_SECONDS) throw new Error("Percorso troppo lungo nel tempo (oltre le 2777 ore)");
  return out;
}

/** `route` della configurazione (coordinate geografiche, istanti arrotondati al decimo di secondo, strettamente crescenti). */
export function buildRoute(d: RouteDraft, frame: LocalFrame): NonNullable<DeviceConfig["route"]> {
  let last = -Infinity;
  return routePoints(d).map((p) => {
    const tS = Math.max(Math.round(p.tS * 10) / 10, last + 0.1);
    last = tS;
    const g = toGeo(frame, p);
    return { tS, lat: g.lat, lon: g.lon };
  });
}

/**
 * Bozza modificabile da un percorso già salvato: i punti consecutivi nello stesso posto diventano soste,
 * la velocità è la media sui tratti in movimento (se non c'è movimento, `fallbackKmh`).
 */
export function routeToDraft(route: NonNullable<DeviceConfig["route"]>, frame: LocalFrame, fallbackKmh = SPEED_PRESETS[0].kmh): RouteDraft {
  const pts = route.map((r) => ({ ...toLocal(frame, r), tS: r.tS }));
  const same = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => Math.hypot(a.x - b.x, a.y - b.y) < 0.5;
  const start = { x: pts[0].x, y: pts[0].y };
  let i = 1;
  let startDelayMin = 0;
  while (i < pts.length && same(pts[i], start)) { startDelayMin = Math.max(0, pts[i].tS / 60); i++; }
  const stops: RouteStop[] = [];
  let movedM = 0;
  let movingS = 0;
  let prev = pts[i - 1];
  for (; i < pts.length; i++) {
    const p = pts[i];
    const last = stops[stops.length - 1];
    if (last && same(last, p)) { last.pauseMin += (p.tS - prev.tS) / 60; prev = p; continue; }
    movedM += Math.hypot(p.x - prev.x, p.y - prev.y);
    movingS += p.tS - prev.tS;
    stops.push({ x: p.x, y: p.y, pauseMin: 0 });
    prev = p;
  }
  const speedKmh = movedM > 0 && movingS > 0 ? (movedM / movingS) * 3.6 : fallbackKmh;
  return { start, stops, speedKmh: speedKmh > 0 ? speedKmh : fallbackKmh, startDelayMin };
}

/** Orario di una tappa dalla partenza ("0:45", "12:05"), da un istante in secondi. */
export function fmtClock(tS: number): string {
  const total = Math.round(tS / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** Lunghezza totale del percorso in metri. */
export function routeLengthM(d: RouteDraft): number {
  let len = 0;
  let prev = d.start;
  for (const s of d.stops) { len += Math.hypot(s.x - prev.x, s.y - prev.y); prev = s; }
  return len;
}

/** Arrivo e partenza di ogni tappa, in secondi dall'inizio (stessa logica di `routePoints`, senza i controlli sui limiti). */
export function stopTimes(d: RouteDraft): { arriveS: number; departS: number }[] {
  const ms = d.speedKmh / 3.6;
  let t = Math.max(0, d.startDelayMin) * 60;
  let prev = d.start;
  return d.stops.map((s) => {
    t += Math.max(MIN_STEP_S, Math.hypot(s.x - prev.x, s.y - prev.y) / ms);
    const arriveS = t;
    t += Math.max(0, s.pauseMin) * 60;
    prev = s;
    return { arriveS, departS: t };
  });
}

/** Due percorsi uguali entro la tolleranza (decimo di secondo e ~1 cm)? Serve a non registrare un passo quando "Fine" non cambia nulla. */
export function sameRoute(a: DeviceConfig["route"], b: DeviceConfig["route"]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) => Math.abs(p.tS - b[i].tS) < 0.05 && Math.abs(p.lat - b[i].lat) < 1e-7 && Math.abs(p.lon - b[i].lon) < 1e-7);
}
