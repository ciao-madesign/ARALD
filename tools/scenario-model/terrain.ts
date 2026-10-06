/**
 * Terreno e geografia per il motore di propagazione — il punto in cui il futuro
 * ARALD Network Design Tool (docs/network-design-tool.md) collegherà dati reali.
 *
 * Il motore non sa da dove arrivano altitudine e uso del suolo: chiede solo un
 * oggetto `Terrain`. Oggi gli scenari usano terreni sintetici (`syntheticIslands`),
 * perché in questo ambiente non c'è accesso a un DEM reale; il tool potrà
 * passare un `Terrain` costruito da un DEM (es. SRTM/Copernicus) e da una carta
 * d'uso del suolo (es. CORINE Land Cover) senza toccare nient'altro.
 */
import type { Point3 } from "./model.js";

// ---------------------------------------------------------------- coordinate

export interface GeoPoint { lat: number; lon: number }

/**
 * Sistema locale in metri (x = est, y = nord) attorno a un'origine geografica.
 * Proiezione equirettangolare: errore trascurabile entro ~100 km, sufficiente
 * per la scala di una rete ARALD.
 */
export interface LocalFrame { lat0: number; lon0: number }

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON_EQUATOR = 111_320;

export function toLocal(frame: LocalFrame, g: GeoPoint): { x: number; y: number } {
  return {
    x: (g.lon - frame.lon0) * M_PER_DEG_LON_EQUATOR * Math.cos((frame.lat0 * Math.PI) / 180),
    y: (g.lat - frame.lat0) * M_PER_DEG_LAT,
  };
}

export function toGeo(frame: LocalFrame, p: { x: number; y: number }): GeoPoint {
  return {
    lat: frame.lat0 + p.y / M_PER_DEG_LAT,
    lon: frame.lon0 + p.x / (M_PER_DEG_LON_EQUATOR * Math.cos((frame.lat0 * Math.PI) / 180)),
  };
}

// ---------------------------------------------------------------- terreno

/** Classi d'uso del suolo rilevanti per la propagazione (estendibili). */
export type LandCover = "sea" | "urban-dense" | "urban" | "forest" | "open";

export interface Terrain {
  name: string;
  /** Quota del suolo (m s.l.m.) in coordinate locali; 0 sul mare. */
  elevationAt(x: number, y: number): number;
  landCoverAt(x: number, y: number): LandCover;
}

/**
 * Perdita di "clutter" per l'estremo di un link che si trova in una data classe
 * di suolo, con antenna bassa (dispositivo a pochi metri dal suolo). Ipotesi di
 * modello, ordini di grandezza da letteratura generale sulla propagazione, NON
 * verificati in questo ambiente. Sub-GHz (LoRa 868 MHz) e 2,4 GHz (BLE/Wi-Fi).
 */
export const CLUTTER_LOSS_DB: Record<LandCover, { subGhz: number; ghz24: number }> = {
  sea: { subGhz: 0, ghz24: 0 },
  open: { subGhz: 1, ghz24: 2 },
  forest: { subGhz: 6, ghz24: 12 },
  urban: { subGhz: 8, ghz24: 12 },
  "urban-dense": { subGhz: 15, ghz24: 20 },
};

export function clutterLossDb(cover: LandCover, freqHz: number): number {
  return freqHz < 1e9 ? CLUTTER_LOSS_DB[cover].subGhz : CLUTTER_LOSS_DB[cover].ghz24;
}

// ---------------------------------------------------------------- diffrazione

const EARTH_RADIUS_M = 6_371_000;
const SPEED_OF_LIGHT = 299_792_458;

/** Perdita knife-edge J(ν) (ITU-R P.526, approssimazione per ν > −0,78; 0 sotto). */
export function knifeEdgeLossDb(nu: number): number {
  if (nu <= -0.78) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((nu - 0.1) ** 2 + 1) + nu - 0.1);
}

export interface ProfileResult {
  /** Perdita di diffrazione (dB) dovuta al terreno e alla curvatura terrestre. */
  lossDb: number;
  /** Parametro ν dell'ostacolo dominante (> 0 = linea di vista ostruita). */
  worstNu: number;
  /** Distanza (m) dell'ostacolo dominante dal primo estremo, se c'è. */
  obstacleAtM: number | null;
  /** true se la linea di vista geometrica (non la zona di Fresnel) è libera. */
  lineOfSight: boolean;
}

/**
 * Profilo del terreno tra due antenne (z = quota assoluta dell'antenna, m s.l.m.)
 * con curvatura terrestre a raggio equivalente k·R (k = 4/3, atmosfera standard).
 * Metodo: un solo ostacolo dominante (il campione con ν massimo), perdita
 * knife-edge su quello. È il primo passo di Deygout; ostacoli multipli in serie
 * sono sottostimati — limite dichiarato in docs/scenario-simulation.md.
 */
export function terrainProfileLoss(terrain: Terrain, a: Point3, b: Point3, freqHz: number, opts: { stepM?: number; kFactor?: number } = {}): ProfileResult {
  const stepM = opts.stepM ?? 100;
  const k = opts.kFactor ?? 4 / 3;
  const dTotal = Math.hypot(b.x - a.x, b.y - a.y);
  if (dTotal < 1) return { lossDb: 0, worstNu: -Infinity, obstacleAtM: null, lineOfSight: true };
  const lambda = SPEED_OF_LIGHT / freqHz;
  // Al più 300 campioni: su 40 km un passo di ~130 m, sufficiente per rilievi di centinaia di metri.
  const n = Math.min(300, Math.max(2, Math.ceil(dTotal / stepM)));
  let worstNu = -Infinity;
  let obstacleAtM: number | null = null;
  let lineOfSight = true;
  for (let i = 1; i < n; i++) {
    const f = i / n;
    const d1 = f * dTotal;
    const d2 = dTotal - d1;
    const ground = terrain.elevationAt(a.x + f * (b.x - a.x), a.y + f * (b.y - a.y));
    const bulge = (d1 * d2) / (2 * k * EARTH_RADIUS_M);
    const los = a.z + f * (b.z - a.z);
    const h = ground + bulge - los; // > 0: il terreno sporge sopra la linea di vista
    if (h > 0) lineOfSight = false;
    const nu = h * Math.sqrt((2 * dTotal) / (lambda * d1 * d2));
    if (nu > worstNu) { worstNu = nu; obstacleAtM = d1; }
  }
  return { lossDb: knifeEdgeLossDb(worstNu), worstNu, obstacleAtM: worstNu > -0.78 ? obstacleAtM : null, lineOfSight };
}

/**
 * Profondità (m) oltre la quale il clutter attorno a un estremo pesa per intero: il
 * clutter rappresenta gli edifici/la vegetazione che il percorso attraversa vicino al
 * terminale, quindi su un link di pochi metri (telefono accanto alla propria Card)
 * è quasi nullo. Ipotesi di modello.
 */
export const CLUTTER_DEPTH_M = 200;

/** Perdita totale dovuta al territorio per un link: diffrazione + clutter ai due estremi. */
export function terrainLinkLossDb(terrain: Terrain, a: Point3, b: Point3, freqHz: number): number {
  const scale = Math.min(1, Math.hypot(b.x - a.x, b.y - a.y) / CLUTTER_DEPTH_M);
  return terrainProfileLoss(terrain, a, b, freqHz).lossDb
    + scale * (clutterLossDb(terrain.landCoverAt(a.x, a.y), freqHz) + clutterLossDb(terrain.landCoverAt(b.x, b.y), freqHz));
}

/** Terreno piatto a quota 0, tutto "open": il caso neutro quando non si conosce il territorio. */
export const FLAT_TERRAIN: Terrain = { name: "piatto", elevationAt: () => 0, landCoverAt: () => "open" };

// ---------------------------------------------------------------- terreno sintetico

export interface SyntheticIsland {
  name: string;
  center: GeoPoint;
  /** Raggio della linea di costa (m). */
  radiusM: number;
  /** Quota della cima (m). */
  summitM: number;
  /** Esponente di forma: 1 = cono, 2 = più concavo (coste basse, cima ripida). */
  shape?: number;
}

export interface SyntheticSettlement {
  name: string;
  center: GeoPoint;
  radiusM: number;
  cover: LandCover;
}

/**
 * Terreno sintetico fatto di isole a cono su mare a quota 0 e di insediamenti
 * circolari. Una stand-in per un DEM reale: le forme sono approssimative,
 * NON rilevate.
 */
export function syntheticIslands(name: string, frame: LocalFrame, islands: SyntheticIsland[], settlements: SyntheticSettlement[], defaultLandCover: LandCover = "open"): Terrain {
  const isl = islands.map((i) => ({ ...i, c: toLocal(frame, i.center) }));
  const set = settlements.map((s) => ({ ...s, c: toLocal(frame, s.center) }));
  return {
    name,
    elevationAt(x, y) {
      let h = 0;
      for (const i of isl) {
        const d = Math.hypot(x - i.c.x, y - i.c.y);
        if (d < i.radiusM) h = Math.max(h, i.summitM * (1 - d / i.radiusM) ** (i.shape ?? 2));
      }
      return h;
    },
    landCoverAt(x, y) {
      for (const s of set) if (Math.hypot(x - s.c.x, y - s.c.y) <= s.radiusM) return s.cover;
      for (const i of isl) if (Math.hypot(x - i.c.x, y - i.c.y) < i.radiusM) return defaultLandCover;
      return "sea";
    },
  };
}

// ---------------------------------------------------------------- paesaggio sintetico generico

/** Rilievo conico (vulcano, collina): quota aggiunta a distanza `d` dal centro. */
export function coneElevation(d: number, radiusM: number, heightM: number, shape = 1.5): number {
  return d < radiusM ? heightM * (1 - d / radiusM) ** shape : 0;
}

/** Distanza di un punto da un segmento (m). */
export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const f = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - (ax + f * vx), py - (ay + f * vy));
}

export interface SyntheticRidge {
  name: string;
  from: GeoPoint;
  to: GeoPoint;
  /** Altezza della cresta sopra la quota di base (m). */
  heightM: number;
  /** Semi-larghezza alla base (m): a questa distanza dalla linea di cresta il rilievo è nullo. */
  halfWidthM: number;
}

export interface SyntheticLandscape {
  /** Quota di base in coordinate locali (es. un altopiano che sale verso est). */
  baseElevation: (x: number, y: number) => number;
  cones?: SyntheticIsland[];
  ridges?: SyntheticRidge[];
  settlements?: SyntheticSettlement[];
  defaultLandCover?: LandCover;
}

/**
 * Terreno sintetico generico: quota di base + coni + creste lineari (profilo a cono
 * trasversale), insediamenti circolari. Stand-in per un DEM reale, forme NON rilevate.
 */
export function syntheticLandscape(name: string, frame: LocalFrame, l: SyntheticLandscape): Terrain {
  const cones = (l.cones ?? []).map((c) => ({ ...c, c: toLocal(frame, c.center) }));
  const ridges = (l.ridges ?? []).map((r) => ({ ...r, a: toLocal(frame, r.from), b: toLocal(frame, r.to) }));
  const settlements = (l.settlements ?? []).map((s) => ({ ...s, c: toLocal(frame, s.center) }));
  return {
    name,
    elevationAt(x, y) {
      let extra = 0;
      for (const c of cones) extra = Math.max(extra, coneElevation(Math.hypot(x - c.c.x, y - c.c.y), c.radiusM, c.summitM, c.shape));
      for (const r of ridges) extra = Math.max(extra, coneElevation(distanceToSegment(x, y, r.a.x, r.a.y, r.b.x, r.b.y), r.halfWidthM, r.heightM, 1));
      return l.baseElevation(x, y) + extra;
    },
    landCoverAt(x, y) {
      for (const s of settlements) if (Math.hypot(x - s.c.x, y - s.c.y) <= s.radiusM) return s.cover;
      return l.defaultLandCover ?? "open";
    },
  };
}
