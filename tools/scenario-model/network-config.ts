/**
 * Configurazione salvabile di una rete ARALD (docs/network-design-tool.md §9):
 * dispositivi posizionati su coordinate geografiche reali, ambiente e profilo
 * radio. È il formato che il futuro tool salverà/riaprirà, e che il motore
 * valuta con `assessNetwork()` per produrre il pannello connessioni (§7).
 *
 * JSON di esempio: tools/scenario-model/examples/eolie.json.
 */
import { type LinkAssessment, assessLink } from "./assess.js";
import {
  BUDGET_SHORT_RANGE, DEFAULT_PHY, EU868_G1, EU868_G3, KIND_DEFAULTS, type Environment, type ModelParams,
  type NodeKind, type NodeSpec, type Point3,
} from "./model.js";
import { type LocalFrame, type Terrain, toLocal } from "./terrain.js";

export const NETWORK_CONFIG_VERSION = 1;

export interface DeviceConfig {
  id: string;
  kind: NodeKind;
  lat: number;
  lon: number;
  /** Altezza dell'antenna dal suolo (m); se assente, quella tipica del tipo di dispositivo. */
  heightAglM?: number;
  label?: string;
}

export type EnvironmentName = "favorevole" | "tipico" | "severo";
export type RegulatoryName = "g1" | "g3";

export interface NetworkConfig {
  version: typeof NETWORK_CONFIG_VERSION;
  name: string;
  /** Origine del sistema di coordinate locali (di solito il centro dell'area). */
  frame: LocalFrame;
  environment: EnvironmentName;
  regulatory: RegulatoryName;
  /**
   * Identificativo del dataset di territorio (es. "eolie-sintetico"); assente = terreno
   * piatto. Il tool reale lo sostituirà con il riferimento al DEM/uso del suolo usato.
   */
  terrain?: string;
  devices: DeviceConfig[];
}

/**
 * Ambienti generici per un territorio esplicito (terrain.ts): rilievi, curvatura
 * terrestre e uso del suolo sono già nel profilo, quindi l'esponente resta vicino
 * allo spazio libero e la condizione descrive solo variabilità e disturbo.
 * Ipotesi di modello, non misure.
 */
export const TERRAIN_ENVIRONMENTS: Record<EnvironmentName, Omit<Environment, "terrain">> = {
  favorevole: { name: "favorevole", pathLossExponent: 2.0, fadeMarginDb: 8, obstructionDb: {}, obstructionScale: 1, interferenceDb: 0 },
  tipico: { name: "tipico", pathLossExponent: 2.2, fadeMarginDb: 10, obstructionDb: {}, obstructionScale: 1, interferenceDb: 2 },
  severo: { name: "severo", pathLossExponent: 2.5, fadeMarginDb: 12, obstructionDb: {}, obstructionScale: 1, interferenceDb: 5 },
};

export const REGULATORY: Record<RegulatoryName, typeof EU868_G1> = { g1: EU868_G1, g3: EU868_G3 };

const KINDS = Object.keys(KIND_DEFAULTS) as NodeKind[];

function fail(msg: string): never {
  throw new Error(`Configurazione di rete non valida: ${msg}`);
}

function finite(v: unknown, what: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) fail(`${what} deve essere un numero tra ${min} e ${max}`);
  return v;
}

/** Valida un oggetto (es. JSON.parse di un file salvato) e lo restituisce tipizzato. */
export function parseNetworkConfig(raw: unknown): NetworkConfig {
  if (typeof raw !== "object" || raw === null) fail("non è un oggetto");
  const o = raw as Record<string, unknown>;
  if (o.version !== NETWORK_CONFIG_VERSION) fail(`versione ${String(o.version)} non supportata (attesa ${NETWORK_CONFIG_VERSION})`);
  if (typeof o.name !== "string") fail("name mancante");
  const frame = o.frame as Record<string, unknown> | undefined;
  if (typeof frame !== "object" || frame === null) fail("frame mancante");
  const lat0 = finite(frame.lat0, "frame.lat0", -85, 85);
  const lon0 = finite(frame.lon0, "frame.lon0", -180, 180);
  // Object.hasOwn, non `in`: "constructor"/"toString" passerebbero altrimenti la validazione
  // e farebbero crashare il motore più avanti (trovato dalla revisione).
  if (!(typeof o.environment === "string" && Object.hasOwn(TERRAIN_ENVIRONMENTS, o.environment))) fail("environment deve essere favorevole, tipico o severo");
  if (!(typeof o.regulatory === "string" && Object.hasOwn(REGULATORY, o.regulatory))) fail("regulatory deve essere g1 o g3");
  if (!Array.isArray(o.devices)) fail("devices deve essere un elenco");
  const ids = new Set<string>();
  const devices = o.devices.map((d, i): DeviceConfig => {
    if (typeof d !== "object" || d === null) fail(`devices[${i}] non è un oggetto`);
    const dd = d as Record<string, unknown>;
    if (typeof dd.id !== "string" || dd.id === "") fail(`devices[${i}].id mancante`);
    if (ids.has(dd.id)) fail(`id duplicato: ${dd.id}`);
    ids.add(dd.id);
    if (!(typeof dd.kind === "string" && (KINDS as string[]).includes(dd.kind))) fail(`devices[${i}].kind deve essere uno tra ${KINDS.join(", ")}`);
    return {
      id: dd.id,
      kind: dd.kind as NodeKind,
      lat: finite(dd.lat, `devices[${i}].lat`, -85, 85),
      lon: finite(dd.lon, `devices[${i}].lon`, -180, 180),
      heightAglM: dd.heightAglM === undefined ? undefined : finite(dd.heightAglM, `devices[${i}].heightAglM`, 0, 500),
      label: typeof dd.label === "string" ? dd.label : undefined,
    };
  });
  if (o.terrain !== undefined && typeof o.terrain !== "string") fail("terrain deve essere una stringa");
  return {
    version: NETWORK_CONFIG_VERSION, name: o.name, frame: { lat0, lon0 },
    environment: o.environment as EnvironmentName, regulatory: o.regulatory as RegulatoryName,
    terrain: o.terrain as string | undefined, devices,
  };
}

/** Posizione locale dell'antenna: quota del suolo dal territorio + altezza dal suolo. */
export function devicePosition(cfg: NetworkConfig, d: DeviceConfig, terrain: Terrain): Point3 {
  const { x, y } = toLocal(cfg.frame, d);
  return { x, y, z: terrain.elevationAt(x, y) + (d.heightAglM ?? KIND_DEFAULTS[d.kind].heightAglM) };
}

/** Dispositivi fermi (traiettoria di un solo punto) pronti per il motore. */
export function placeDevices(cfg: NetworkConfig, terrain: Terrain): NodeSpec[] {
  return cfg.devices.map((d) => ({
    id: d.id, kind: d.kind, heightAglM: d.heightAglM ?? KIND_DEFAULTS[d.kind].heightAglM, path: [{ ...devicePosition(cfg, d, terrain), t: 0 }],
  }));
}

export function paramsForConfig(cfg: NetworkConfig, terrain: Terrain): ModelParams {
  return {
    env: { ...TERRAIN_ENVIRONMENTS[cfg.environment], terrain },
    reg: REGULATORY[cfg.regulatory], phy: DEFAULT_PHY, shortRange: BUDGET_SHORT_RANGE,
    loraFrameBytes: 222, loraFrameOverheadBytes: 22, protocolOverhead: 1.45, channelEfficiency: 0.5, maxSf: 12,
  };
}

/**
 * Valuta ogni coppia di dispositivi della configurazione (§5): restituisce solo le
 * coppie con almeno una tecnologia possibile, ordinate per qualità decrescente.
 */
export function assessNetwork(cfg: NetworkConfig, terrain: Terrain): LinkAssessment[] {
  const p = paramsForConfig(cfg, terrain);
  const nodes = placeDevices(cfg, terrain);
  const out: LinkAssessment[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const r = assessLink(nodes[i], nodes[i].path[0], nodes[j], nodes[j].path[0], p);
      if (r.best) out.push(r);
    }
  }
  return out.sort((x, y) => y.best!.quality - x.best!.quality);
}
