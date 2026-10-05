/**
 * Modello parametrico teorico di efficienza della rete ARALD — grafo dinamico
 * G(t) = (V, E(t)) con link budget radio, mobilità dei nodi e store-and-forward
 * opportunistico. Nessun `NomadNode` reale: è un modello analitico/agent-based a
 * passo di tempo discreto, pensato per confrontare scenari e ordini di grandezza,
 * non per produrre misure. Ogni parametro radio di default è un'ipotesi
 * dichiarata (vedi docs/scenario-simulation.md), mai un valore misurato.
 *
 * Nessuna dipendenza esterna: solo TypeScript puro.
 */
import { type Terrain, terrainLinkLossDb } from "./terrain.js";

// ---------------------------------------------------------------- geometria

export interface Point3 { x: number; y: number; z: number } // metri, sistema locale (x=est, y=nord, z=quota)

/** Waypoint di una traiettoria: posizione raggiunta al tempo `t` (secondi). */
export interface Waypoint extends Point3 { t: number }

export function distance3(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Posizione al tempo t per interpolazione lineare tra waypoint (fermo prima del primo/dopo l'ultimo). */
export function positionAt(path: Waypoint[], t: number): Point3 {
  if (path.length === 0) throw new Error("traiettoria vuota");
  if (t <= path[0].t) return path[0];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (t <= b.t) {
      const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y), z: a.z + f * (b.z - a.z) };
    }
  }
  return path[path.length - 1];
}

// ---------------------------------------------------------------- radio LoRa

export type SpreadingFactor = 7 | 8 | 9 | 10 | 11 | 12;
export const SPREADING_FACTORS: SpreadingFactor[] = [7, 8, 9, 10, 11, 12];

/**
 * Sensibilità SX1262 a 125 kHz per SF (dBm). Valori tipici da datasheet
 * Semtech ricostruiti da conoscenza, NON verificati in questo ambiente.
 */
export const SX1262_SENSITIVITY_125K: Record<SpreadingFactor, number> = {
  7: -124, 8: -127, 9: -129.5, 10: -132, 11: -134.5, 12: -137,
};

export interface LoraPhy {
  bandwidthHz: number;      // 125000
  codingRateDenom: number;  // 5 => CR 4/5
  preambleSymbols: number;  // 8
  explicitHeader: boolean;
  crc: boolean;
}

export const DEFAULT_PHY: LoraPhy = { bandwidthHz: 125_000, codingRateDenom: 5, preambleSymbols: 8, explicitHeader: true, crc: true };

/** Time-on-air LoRa (secondi) — formula pubblica Semtech (AN1200.13 / datasheet SX126x). */
export function loraTimeOnAir(payloadBytes: number, sf: SpreadingFactor, phy: LoraPhy = DEFAULT_PHY): number {
  const tSym = (2 ** sf) / phy.bandwidthHz;
  const de = tSym > 0.016 ? 1 : 0; // low data rate optimize obbligatorio sopra 16 ms/simbolo
  const ih = phy.explicitHeader ? 0 : 1;
  const crc = phy.crc ? 1 : 0;
  const cr = phy.codingRateDenom - 4;
  const num = 8 * payloadBytes - 4 * sf + 28 + 16 * crc - 20 * ih;
  const nPayload = 8 + Math.max(Math.ceil(num / (4 * (sf - 2 * de))) * (cr + 4), 0);
  return (phy.preambleSymbols + 4.25 + nPayload) * tSym;
}

/** Perdita di percorso log-distance a 868 MHz: FSPL(1 m) + 10·n·log10(d). */
export function pathLossDb(distanceM: number, exponent: number, freqHz = 868e6): number {
  const d = Math.max(distanceM, 1);
  const fspl1m = 20 * Math.log10(freqHz) + 20 * Math.log10(4 * Math.PI / 299_792_458);
  return fspl1m + 10 * exponent * Math.log10(d);
}

/** Profilo regolatorio EU868 (EN 300 220-2): sotto-banda scelta = potenza max e duty-cycle. */
export interface RegulatoryProfile {
  name: string;
  maxErpDbm: number;  // ERP massimo consentito nella sotto-banda (EIRP = ERP + 2,15 dB)
  dutyCycle: number;  // frazione (0.01 = 1%)
}

export const EU868_G1: RegulatoryProfile = { name: "EU868 g1 (868,0-868,6 MHz) 14 dBm ERP / 1%", maxErpDbm: 14, dutyCycle: 0.01 };
export const EU868_G3: RegulatoryProfile = { name: "EU868 g3 (869,4-869,65 MHz) 27 dBm ERP / 10%", maxErpDbm: 27, dutyCycle: 0.10 };

/** EIRP effettiva del trasmettitore: limitata sia dall'hardware (potenza + antenna) sia dalla norma. */
export function effectiveEirpDbm(txDbm: number, antennaDbi: number, reg: RegulatoryProfile): number {
  return Math.min(txDbm + antennaDbi, reg.maxErpDbm + 2.15);
}

// ---------------------------------------------------------------- nodi e ambiente

export type NodeKind = "box" | "portable" | "card" | "phone" | "relay";

export interface RadioCaps { lora: boolean; ble: boolean; wifi: boolean }

export interface KindRadioProfile {
  caps: RadioCaps;
  /** LoRa: potenza hardware massima (SX1262 +22 dBm, senza PA esterno) e guadagno d'antenna. */
  txDbm: number;
  antennaDbi: number;
  /** Perdita dovuta al corpo di chi porta il dispositivo (tutte le tecnologie). */
  bodyLossDb: number;
  /** BLE: potenza di trasmissione (dBm, antenna integrata ~0 dBi). */
  bleTxDbm: number;
  /** Wi-Fi 2,4 GHz: EIRP (dBm; limite UE 20 dBm). */
  wifiEirpDbm: number;
  /** Altezza tipica dell'antenna dal suolo (m), usata quando l'utente non la specifica. */
  heightAglM: number;
}

/**
 * Caratteristiche intrinseche di ogni tipo di dispositivo (docs/network-design-tool.md §2:
 * mai reinserite dall'utente nella prima versione del tool). Valori di progetto/ipotesi,
 * NON misurati su hardware ARALD.
 */
export const KIND_DEFAULTS: Record<NodeKind, KindRadioProfile> = {
  box:      { caps: { lora: true,  ble: true, wifi: true  }, txDbm: 22, antennaDbi: 3,  bodyLossDb: 0, bleTxDbm: 8, wifiEirpDbm: 20, heightAglM: 4 },
  portable: { caps: { lora: true,  ble: true, wifi: true  }, txDbm: 22, antennaDbi: 0,  bodyLossDb: 2, bleTxDbm: 8, wifiEirpDbm: 20, heightAglM: 1.5 },
  card:     { caps: { lora: true,  ble: true, wifi: false }, txDbm: 22, antennaDbi: -3, bodyLossDb: 4, bleTxDbm: 4, wifiEirpDbm: 0,  heightAglM: 1.2 },
  phone:    { caps: { lora: false, ble: true, wifi: true  }, txDbm: 0,  antennaDbi: 0,  bodyLossDb: 0, bleTxDbm: 4, wifiEirpDbm: 15, heightAglM: 1.2 },
  // ARALD Fixed Relay (docs/beacon.md): palo/supporto fisso in quota, antenna esterna, nessun corpo.
  relay:    { caps: { lora: true,  ble: true, wifi: false }, txDbm: 22, antennaDbi: 3,  bodyLossDb: 0, bleTxDbm: 4, wifiEirpDbm: 0,  heightAglM: 6 },
};

export interface NodeSpec {
  id: string;
  kind: NodeKind;
  path: Waypoint[];
  /**
   * Altezza dell'antenna dal suolo (m). Se presente e l'ambiente ha un `Terrain`, la quota
   * del nodo segue il terreno lungo la traiettoria (suolo + questa altezza) invece di
   * interpolare in linea retta la z dei waypoint, che su un pendio farebbe "galleggiare"
   * il nodo sopra il terreno (trovato dalla revisione).
   */
  heightAglM?: number;
  /** Istante (s) da cui il nodo è spento/assente — robustezza. */
  offFrom?: number;
}

/** Condizione ambientale: esponente di path loss + margine di fading. */
export interface Environment {
  name: string;
  pathLossExponent: number;
  fadeMarginDb: number;
  /** Perdita aggiuntiva per coppia (creste, pareti) — chiave "A|B" ordinata. */
  obstructionDb: Record<string, number>;
  /**
   * Alternativa a `obstructionDb` per nodi che si spostano attraverso il terreno
   * (es. chi valica una cresta): perdita in funzione delle posizioni, sommata a
   * quella per coppia.
   */
  obstructionFn?: (pa: Point3, pb: Point3) => number;
  /** Moltiplicatore applicato alle ostruzioni (favorevole < 1, severo > 1). */
  obstructionScale: number;
  interferenceDb: number;
  /**
   * Territorio reale o sintetico (terrain.ts): se presente, ogni link aggiunge la
   * diffrazione sul profilo del terreno (con curvatura terrestre) e il clutter
   * d'uso del suolo ai due estremi, alla frequenza della tecnologia. Le posizioni
   * dei nodi (z) sono allora quote assolute dell'antenna.
   */
  terrain?: Terrain;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export interface ShortRangeParams {
  /**
   * "fixed" (Scenari 1-2): portata e velocità BLE/Wi-Fi costanti.
   * "budget": link budget a 2,4 GHz come per LoRa, velocità a gradini in funzione
   * del segnale ricevuto — portata e velocità dipendono da distanza e territorio.
   */
  model?: "fixed" | "budget";
  bleRangeM: number;
  bleBps: number;   // throughput applicativo effettivo (solo "fixed")
  wifiRangeM: number;
  wifiBps: number;
}

export const DEFAULT_SHORT_RANGE: ShortRangeParams = { model: "fixed", bleRangeM: 30, bleBps: 200_000, wifiRangeM: 80, wifiBps: 8_000_000 };
export const BUDGET_SHORT_RANGE: ShortRangeParams = { ...DEFAULT_SHORT_RANGE, model: "budget" };

/**
 * Gradini di velocità applicativa in funzione dell'RSSI (al netto del margine di fading).
 * BLE: 2M PHY, 1M PHY, Coded PHY S2/S8. Wi-Fi 802.11n 2,4 GHz 20 MHz 1 flusso
 * (MCS7…MCS0) più 802.11b 1 Mbps, throughput applicativo ≈ 55% del PHY.
 * Soglie e velocità sono ipotesi tipiche, NON verificate su dispositivi ARALD.
 */
export const BLE_RATE_STEPS: { minRssiDbm: number; bps: number; label: string }[] = [
  { minRssiDbm: -80, bps: 1_000_000, label: "2M PHY" },
  { minRssiDbm: -92, bps: 300_000, label: "1M PHY" },
  { minRssiDbm: -97, bps: 120_000, label: "Coded S2" },
  { minRssiDbm: -101, bps: 40_000, label: "Coded S8" },
];
export const WIFI_RATE_STEPS: { minRssiDbm: number; bps: number; label: string }[] = [
  { minRssiDbm: -64, bps: 36_000_000, label: "MCS7" },
  { minRssiDbm: -66, bps: 32_000_000, label: "MCS6" },
  { minRssiDbm: -70, bps: 28_000_000, label: "MCS5" },
  { minRssiDbm: -74, bps: 21_000_000, label: "MCS4" },
  { minRssiDbm: -77, bps: 14_000_000, label: "MCS3" },
  { minRssiDbm: -79, bps: 11_000_000, label: "MCS2" },
  { minRssiDbm: -81, bps: 7_000_000, label: "MCS1" },
  { minRssiDbm: -82, bps: 3_500_000, label: "MCS0" },
  { minRssiDbm: -90, bps: 600_000, label: "802.11b 1 Mbps" },
];

export type Medium = "wifi" | "ble" | "lora";

export interface LinkState {
  medium: Medium;
  /** Solo LoRa: SF scelto (il più veloce che chiude il link). */
  sf?: SpreadingFactor;
  /** RSSI stimato (direzione più debole) e margine residuo sopra la soglia usata. */
  rssiDbm?: number;
  marginDb?: number;
  /** Velocità applicativa istantanea stimata (bit/s). Per LoRa: a canale libero, senza duty-cycle. */
  rateBps?: number;
  /** Nome del gradino/modo radio usato (es. "SF9", "1M PHY", "MCS4"). */
  mode?: string;
}

/** Valutazione di una tecnologia su una coppia di nodi, anche quando il link non chiude. */
export interface RadioEvaluation {
  medium: Medium;
  /** false se uno dei due dispositivi non ha questa tecnologia (o il Wi-Fi non coinvolge un access point). */
  applicable: boolean;
  /**
   * RSSI stimato. Quando il link è impossibile già senza territorio, il profilo del
   * terreno non viene calcolato e questo è solo un limite superiore.
   */
  rssiDbm: number | null;
  /** true se `rssiDbm` è solo un limite superiore (profilo del terreno non calcolato). */
  rssiIsUpperBound: boolean;
  link: LinkState | null;
}

export interface ModelParams {
  env: Environment;
  reg: RegulatoryProfile;
  phy: LoraPhy;
  shortRange: ShortRangeParams;
  /** Byte LoRa per frame (payload fisico) e quanti di questi sono overhead di framing ARALD. */
  loraFrameBytes: number;
  loraFrameOverheadBytes: number;
  /** Fattore di overhead del protocollo applicativo (base64 nei CONTENT_CHUNK JSON, envelope, firme). */
  protocolOverhead: number;
  /** Frazione massima dell'airtime del canale condiviso utilizzabile (contesa/collisioni). */
  channelEfficiency: number;
  /** SF massimo ammesso (limitarlo è una scelta di progetto: SF12 = portata ma airtime enorme). */
  maxSf: SpreadingFactor;
}

const LORA_FREQ_HZ = 868e6;
const ISM24_FREQ_HZ = 2.44e9;

/** Perdite comuni a ogni tecnologia, territorio escluso: percorso, ostruzioni dello scenario, interferenza, evento. */
function baseLossDb(a: NodeSpec, pa: Point3, b: NodeSpec, pb: Point3, p: ModelParams, freqHz: number, extraLossDb: number): number {
  const obstruction = ((p.env.obstructionDb[pairKey(a.id, b.id)] ?? 0) + (p.env.obstructionFn?.(pa, pb) ?? 0)) * p.env.obstructionScale;
  return pathLossDb(distance3(pa, pb), p.env.pathLossExponent, freqHz) + obstruction + p.env.interferenceDb + extraLossDb;
}

/**
 * RSSI della direzione più debole, territorio incluso. Il profilo del terreno è il
 * calcolo costoso: se il link non chiuderebbe nemmeno senza territorio (che può solo
 * aggiungere perdita) lo si salta e si restituisce quel valore come limite superiore.
 */
function rssiWithTerrain(rssiNoTerrain: number, bestThresholdDbm: number, pa: Point3, pb: Point3, p: ModelParams, freqHz: number): { rssi: number; upperBound: boolean } {
  if (!p.env.terrain) return { rssi: rssiNoTerrain, upperBound: false };
  if (rssiNoTerrain - p.env.fadeMarginDb < bestThresholdDbm) return { rssi: rssiNoTerrain, upperBound: true };
  return { rssi: rssiNoTerrain - cachedTerrainLossDb(p.env.terrain, pa, pb, freqHz), upperBound: false };
}

/** Memo del profilo di terreno: i nodi fermi ripetono le stesse coppie a ogni passo della simulazione. */
const terrainCache = new WeakMap<Terrain, Map<string, number>>();
function cachedTerrainLossDb(terrain: Terrain, pa: Point3, pb: Point3, freqHz: number): number {
  let m = terrainCache.get(terrain);
  if (!m) { m = new Map(); terrainCache.set(terrain, m); }
  if (m.size > 200_000) m.clear();
  const k = (q: Point3) => `${q.x.toFixed(1)},${q.y.toFixed(1)},${q.z.toFixed(1)}`;
  // Il link budget è simmetrico: stessa chiave per (a,b) e (b,a).
  const [k1, k2] = [k(pa), k(pb)].sort();
  const key = `${k1}|${k2}|${freqHz}`;
  let v = m.get(key);
  if (v === undefined) { v = terrainLinkLossDb(terrain, pa, pb, freqHz); m.set(key, v); }
  return v;
}

/** LoRa: SF più veloce che chiude il budget (logica ADR). */
export function evaluateLora(a: NodeSpec, pa: Point3, b: NodeSpec, pb: Point3, p: ModelParams, extraLossDb = 0): RadioEvaluation {
  const da = KIND_DEFAULTS[a.kind];
  const db = KIND_DEFAULTS[b.kind];
  if (!da.caps.lora || !db.caps.lora) return { medium: "lora", applicable: false, rssiDbm: null, rssiIsUpperBound: false, link: null };
  // Il link utile è bidirezionale (dati in un verso, risposte/ACK nell'altro): vale la direzione più
  // debole. Ogni direzione = EIRP del trasmettitore + guadagno d'antenna del ricevitore.
  const eirpA = effectiveEirpDbm(da.txDbm, da.antennaDbi, p.reg);
  const eirpB = effectiveEirpDbm(db.txDbm, db.antennaDbi, p.reg);
  const weakest = Math.min(eirpA + db.antennaDbi, eirpB + da.antennaDbi);
  const bestSens = SX1262_SENSITIVITY_125K[p.maxSf];
  const { rssi, upperBound } = rssiWithTerrain(weakest - da.bodyLossDb - db.bodyLossDb - baseLossDb(a, pa, b, pb, p, LORA_FREQ_HZ, extraLossDb), bestSens, pa, pb, p, LORA_FREQ_HZ);
  for (const sf of SPREADING_FACTORS) {
    if (sf > p.maxSf) break;
    const margin = rssi - p.env.fadeMarginDb - SX1262_SENSITIVITY_125K[sf];
    if (margin >= 0) {
      return { medium: "lora", applicable: true, rssiDbm: rssi, rssiIsUpperBound: upperBound, link: { medium: "lora", sf, rssiDbm: rssi, marginDb: margin, rateBps: loraRawAppBps(sf, p), mode: `SF${sf}` } };
    }
  }
  return { medium: "lora", applicable: true, rssiDbm: rssi, rssiIsUpperBound: upperBound, link: null };
}

function stepLink(medium: Medium, rssi: number, p: ModelParams, steps: { minRssiDbm: number; bps: number; label: string }[]): LinkState | null {
  for (const s of steps) {
    const margin = rssi - p.env.fadeMarginDb - s.minRssiDbm;
    if (margin >= 0) return { medium, rssiDbm: rssi, marginDb: margin, rateBps: s.bps, mode: s.label };
  }
  return null;
}

/** BLE: portata fissa ("fixed") oppure link budget a 2,4 GHz con gradini di PHY ("budget"). */
export function evaluateBle(a: NodeSpec, pa: Point3, b: NodeSpec, pb: Point3, p: ModelParams, extraLossDb = 0): RadioEvaluation {
  const da = KIND_DEFAULTS[a.kind];
  const db = KIND_DEFAULTS[b.kind];
  if (!da.caps.ble || !db.caps.ble) return { medium: "ble", applicable: false, rssiDbm: null, rssiIsUpperBound: false, link: null };
  if (p.shortRange.model !== "budget") {
    const ok = distance3(pa, pb) <= p.shortRange.bleRangeM;
    return { medium: "ble", applicable: true, rssiDbm: null, rssiIsUpperBound: false, link: ok ? { medium: "ble", rateBps: p.shortRange.bleBps, mode: "fisso" } : null };
  }
  const { rssi, upperBound } = rssiWithTerrain(Math.min(da.bleTxDbm, db.bleTxDbm) - da.bodyLossDb - db.bodyLossDb - baseLossDb(a, pa, b, pb, p, ISM24_FREQ_HZ, extraLossDb),
    BLE_RATE_STEPS[BLE_RATE_STEPS.length - 1].minRssiDbm, pa, pb, p, ISM24_FREQ_HZ);
  return { medium: "ble", applicable: true, rssiDbm: rssi, rssiIsUpperBound: upperBound, link: stepLink("ble", rssi, p, BLE_RATE_STEPS) };
}

/** Wi-Fi: solo verso/da un access point (Box/Portable); portata fissa o link budget a 2,4 GHz. */
export function evaluateWifi(a: NodeSpec, pa: Point3, b: NodeSpec, pb: Point3, p: ModelParams, extraLossDb = 0): RadioEvaluation {
  const da = KIND_DEFAULTS[a.kind];
  const db = KIND_DEFAULTS[b.kind];
  const apInvolved = a.kind === "box" || a.kind === "portable" || b.kind === "box" || b.kind === "portable";
  if (!da.caps.wifi || !db.caps.wifi || !apInvolved) return { medium: "wifi", applicable: false, rssiDbm: null, rssiIsUpperBound: false, link: null };
  if (p.shortRange.model !== "budget") {
    const ok = distance3(pa, pb) <= p.shortRange.wifiRangeM;
    return { medium: "wifi", applicable: true, rssiDbm: null, rssiIsUpperBound: false, link: ok ? { medium: "wifi", rateBps: p.shortRange.wifiBps, mode: "fisso" } : null };
  }
  const { rssi, upperBound } = rssiWithTerrain(Math.min(da.wifiEirpDbm, db.wifiEirpDbm) - da.bodyLossDb - db.bodyLossDb - baseLossDb(a, pa, b, pb, p, ISM24_FREQ_HZ, extraLossDb),
    WIFI_RATE_STEPS[WIFI_RATE_STEPS.length - 1].minRssiDbm, pa, pb, p, ISM24_FREQ_HZ);
  return { medium: "wifi", applicable: true, rssiDbm: rssi, rssiIsUpperBound: upperBound, link: stepLink("wifi", rssi, p, WIFI_RATE_STEPS) };
}

/** Link LoRa diretto tra due nodi: SF più veloce che chiude il budget, altrimenti null. */
export function loraLink(a: NodeSpec, pa: Point3, b: NodeSpec, pb: Point3, p: ModelParams, extraLossDb = 0): LinkState | null {
  return evaluateLora(a, pa, b, pb, p, extraLossDb).link;
}

/**
 * Miglior mezzo disponibile tra due nodi a un istante: quello con la velocità
 * istantanea più alta tra quelli che chiudono il link (in pratica Wi-Fi > BLE > LoRa).
 */
export function bestLink(a: NodeSpec, pa: Point3, b: NodeSpec, pb: Point3, p: ModelParams, extraLossDb = 0): LinkState | null {
  let best: LinkState | null = null;
  for (const ev of [evaluateWifi, evaluateBle, evaluateLora]) {
    const l = ev(a, pa, b, pb, p, extraLossDb).link;
    if (l && (best === null || (l.rateBps ?? 0) > (best.rateBps ?? 0))) best = l;
  }
  return best;
}

/** Byte applicativi trasferibili in un frame LoRa. */
export function loraAppBytesPerFrame(p: ModelParams): number {
  return (p.loraFrameBytes - p.loraFrameOverheadBytes) / p.protocolOverhead;
}

/** Throughput applicativo LoRa a canale libero, senza duty-cycle (bit/s). */
export function loraRawAppBps(sf: SpreadingFactor, p: ModelParams): number {
  return (8 * loraAppBytesPerFrame(p)) / loraTimeOnAir(p.loraFrameBytes, sf, p.phy);
}

/** Throughput applicativo LoRa sostenuto con il duty-cycle legale (bit/s). */
export function loraDutyLimitedAppBps(sf: SpreadingFactor, p: ModelParams): number {
  return loraRawAppBps(sf, p) * p.reg.dutyCycle;
}

// ---------------------------------------------------------------- dati e simulazione

export interface Message {
  id: string;
  label: string;
  sizeBytes: number;
  priority: number; // più basso = più urgente (come Priority in packet.ts: 0 = EMERGENCY)
  source: string;
  /**
   * Una o più destinazioni. Con più destinazioni (es. "qualunque infrastruttura": Box o
   * Portable) il messaggio si considera consegnato quando le ha raggiunte tutte; ogni
   * destinazione raggiunta continua a inoltrare verso le altre.
   */
  destination: string | string[];
  createdAt: number;
}

export function destinationsOf(m: Message): string[] {
  return Array.isArray(m.destination) ? m.destination : [m.destination];
}

export interface SimOptions {
  nodes: NodeSpec[];
  messages: Message[];
  params: ModelParams;
  horizonS: number;
  stepS: number;
  /**
   * "epidemic": ogni nodo replica verso ogni vicino (flooding + store-and-forward,
   * caso peggiore per l'airtime). "custody": come `floodExcept()` in node.ts —
   * se esiste un percorso istantaneo inoltra a un solo next hop, altrimenti
   * consegna a tutti i vicini (che poi trattengono e ri-inoltrano).
   */
  policy: "epidemic" | "custody";
  /**
   * Per quanto (s) un nodo intermedio trattiene una copia mentre è isolato
   * dalla destinazione (nessun percorso istantaneo), in funzione della priorità.
   * Modella `PendingDeliveryQueue` (store-and-forward.ts: 5 min ordinario,
   * 30 min EMERGENCY). Assente = nessuna scadenza (DTN "carry" puro).
   * L'origine non scade mai (il contenuto resta nel suo store).
   */
  relayCarryTtlS?: (priority: number) => number;
  /** Perdita LoRa aggiuntiva in funzione del tempo, uguale per tutti i link (es. una perturbazione). */
  extraLossDb?: (t: number) => number;
  /**
   * Costo di un percorso per la policy "custody". "hops" = numero di salti, come
   * `routing-table.ts` oggi (default). "airtime" = tempo di trasmissione di un frame
   * su ogni link (uno SF lento costa molto più di uno veloce) — un'alternativa da valutare.
   */
  routingMetric?: "hops" | "airtime";
}

export interface DeliveryResult {
  messageId: string;
  deliveredAt: number | null; // secondi dalla generazione a tutte le destinazioni, null = non entro l'orizzonte
  /** Secondi dalla generazione per ciascuna destinazione (null = non raggiunta). */
  deliveredAtByDest: Record<string, number | null>;
  bytesAtDestination: number; // massimo tra le destinazioni
  loraAirtimeS: number;       // airtime LoRa totale consumato da questo messaggio (tutte le copie)
}

export interface SimResult {
  deliveries: DeliveryResult[];
  /** Per coppia richiesta: frazione del tempo con percorso simultaneo (connettività istantanea). */
  instantConnectivity: Record<string, number>;
  /** Snapshot dei link a istanti scelti, per tabelle. */
  linkSnapshots: { t: number; links: { a: string; b: string; link: LinkState }[] }[];
}

/** Posizione di un nodo al tempo t, con la quota che segue il territorio quando è noto (`heightAglM`). */
export function nodePosition(n: NodeSpec, t: number, terrain?: Terrain): Point3 {
  const p = positionAt(n.path, t);
  if (!terrain || n.heightAglM === undefined) return p;
  return { x: p.x, y: p.y, z: terrain.elevationAt(p.x, p.y) + n.heightAglM };
}

function isOn(n: NodeSpec, t: number): boolean {
  return n.offFrom === undefined || t < n.offFrom;
}

/** Costo di un link per la metrica "airtime": secondi di trasmissione per un frame equivalente. */
function linkAirtimeCost(link: LinkState, p: ModelParams): number {
  if (link.medium === "lora") return loraTimeOnAir(p.loraFrameBytes, link.sf!, p.phy);
  const bps = link.rateBps ?? (link.medium === "wifi" ? p.shortRange.wifiBps : p.shortRange.bleBps);
  return (8 * p.loraFrameBytes) / bps;
}

/**
 * Comportamento della coda dei relay (`PendingDeliveryQueue`, node/src/store-and-forward.ts)
 * da passare a `SimOptions.relayCarryTtlS`. Attuale (dal 5 ottobre 2026, docs/security.md
 * voce #120): `Priority.EMERGENCY` non scade mai, il resto dopo 5 minuti.
 */
export const ARALD_QUEUE_TTL_S = (priority: number): number => (priority === 0 ? Infinity : 300);
/** Comportamento precedente alla voce #120 (SOS scartato dopo 30 minuti), tenuto per confronto e per i test storici. */
export const LEGACY_QUEUE_TTL_S = (priority: number): number => (priority === 0 ? 1800 : 300);

/** Dijkstra multi-sorgente (grafo piccolo: selezione lineare del minimo è sufficiente). */
function dijkstra(adj: Map<string, { nb: string; link: LinkState }[]>, from: string[], cost: (l: LinkState) => number): Map<string, number> {
  const dist = new Map<string, number>(from.map((r) => [r, 0]));
  const done = new Set<string>();
  for (;;) {
    let cur: string | undefined;
    for (const [n, d] of dist) if (!done.has(n) && (cur === undefined || d < dist.get(cur)!)) cur = n;
    if (cur === undefined) return dist;
    done.add(cur);
    for (const { nb, link } of adj.get(cur) ?? []) {
      const nd = dist.get(cur)! + cost(link);
      if (nd < (dist.get(nb) ?? Infinity)) dist.set(nb, nd);
    }
  }
}

/** Distanza in hop da un insieme di nodi (BFS multi-sorgente). */
function bfsHops(adj: Map<string, string[]>, from: string | string[]): Map<string, number> {
  const roots = Array.isArray(from) ? from : [from];
  const dist = new Map<string, number>(roots.map((r) => [r, 0]));
  const queue = [...roots];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur) ?? []) {
      if (!dist.has(nb)) { dist.set(nb, dist.get(cur)! + 1); queue.push(nb); }
    }
  }
  return dist;
}

export function snapshotLinks(nodes: NodeSpec[], t: number, p: ModelParams, extraLossDb = 0): { a: string; b: string; link: LinkState }[] {
  const out: { a: string; b: string; link: LinkState }[] = [];
  const pos = nodes.map((n) => nodePosition(n, t, p.env.terrain));
  for (let i = 0; i < nodes.length; i++) {
    if (!isOn(nodes[i], t)) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      if (!isOn(nodes[j], t)) continue;
      const link = bestLink(nodes[i], pos[i], nodes[j], pos[j], p, extraLossDb);
      if (link) out.push({ a: nodes[i].id, b: nodes[j].id, link });
    }
  }
  return out;
}

/**
 * Simulazione a passo discreto. Ad ogni passo: calcola E(t), poi ogni nodo
 * con dati in coda li trasferisce ai vicini secondo la policy, rispettando
 * (1) il budget di duty-cycle per nodo (token bucket, finestra 1 h),
 * (2) l'airtime del canale LoRa condiviso (unico dominio di collisione, conservativo),
 * (3) l'ordine di priorità dei messaggi. Granularità a byte (chunk progressivi:
 * un nodo può inoltrare solo la parte di messaggio che possiede già).
 */
export function simulate(opts: SimOptions): SimResult {
  const { nodes, messages, params: p, horizonS, stepS } = opts;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // held[node][msg] = byte posseduti (prefisso contiguo)
  const held = new Map<string, Map<string, number>>();
  for (const n of nodes) held.set(n.id, new Map());
  const isolatedSince = new Map<string, number>(); // "nodo|msg" -> istante da cui il relay non ha percorso
  const dropped = new Set<string>();               // "nodo|msg" scartati dalla coda (SeenCache: mai riaccettati)
  const delivered = new Map<string, number>();             // msg -> istante in cui ha raggiunto tutte le destinazioni
  const reachedAt = new Map<string, Map<string, number>>(); // msg -> destinazione -> istante
  for (const m of messages) reachedAt.set(m.id, new Map());
  const airtime = new Map<string, number>(messages.map((m) => [m.id, 0]));
  // Token bucket duty-cycle: capacità = duty × 3600 s, ricarica = duty s/s. Parte pieno.
  const bucketCap = p.reg.dutyCycle * 3600;
  const bucket = new Map(nodes.map((n) => [n.id, bucketCap]));
  const channelCreditCap = stepS * p.channelEfficiency + 2 * loraTimeOnAir(p.loraFrameBytes, 12, p.phy);
  let channelCredit = 0;
  const instantCount: Record<string, number> = {};
  const pairs = [...new Set(messages.flatMap((m) => destinationsOf(m).map((d) => `${m.source}->${d}`)))];
  for (const k of pairs) instantCount[k] = 0;
  const linkSnapshots: SimResult["linkSnapshots"] = [];
  let steps = 0;

  const sorted = [...messages].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

  for (let t = 0; t <= horizonS; t += stepS) {
    steps++;
    for (const m of messages) {
      if (m.createdAt <= t && t < m.createdAt + stepS && isOn(byId.get(m.source)!, t)) held.get(m.source)!.set(m.id, m.sizeBytes);
    }
    for (const n of nodes) bucket.set(n.id, Math.min(bucketCap, bucket.get(n.id)! + p.reg.dutyCycle * stepS));

    const links = snapshotLinks(nodes, t, p, opts.extraLossDb?.(t) ?? 0);
    if (t % 1800 === 0) linkSnapshots.push({ t, links });
    const adj = new Map<string, { nb: string; link: LinkState }[]>();
    const plainAdj = new Map<string, string[]>();
    for (const n of nodes) { adj.set(n.id, []); plainAdj.set(n.id, []); }
    for (const l of links) {
      adj.get(l.a)!.push({ nb: l.b, link: l.link });
      adj.get(l.b)!.push({ nb: l.a, link: l.link });
      plainAdj.get(l.a)!.push(l.b);
      plainAdj.get(l.b)!.push(l.a);
    }
    for (const k of pairs) {
      const [s, d] = k.split("->");
      if (bfsHops(plainAdj, s).has(d)) instantCount[k]++;
    }
    const hopsToDest = new Map<string, Map<string, number>>();
    const hopsFor = (dests: string[]) => {
      const key = [...dests].sort().join(",");
      if (!hopsToDest.has(key)) hopsToDest.set(key, bfsHops(plainAdj, dests));
      return hopsToDest.get(key)!;
    };
    const metric = opts.routingMetric ?? "hops";
    const costToDest = new Map<string, Map<string, number>>();
    const costFor = (dests: string[]) => {
      if (metric === "hops") return hopsFor(dests);
      const key = [...dests].sort().join(",");
      if (!costToDest.has(key)) costToDest.set(key, dijkstra(adj, dests, (l) => linkAirtimeCost(l, p)));
      return costToDest.get(key)!;
    };

    // Credito del canale condiviso riportato tra un passo e l'altro: un frame lungo (SF12 ≈ 8 s)
    // può occupare più di un passo, altrimenti non passerebbe mai.
    channelCredit = Math.min(channelCreditCap, channelCredit + stepS * p.channelEfficiency);
    // Capacità per-step dei link corti (half-duplex semplificato: una sola direzione alla volta).
    const shortBudget = new Map<string, number>();
    const startHeld = new Map([...held].map(([k, v]) => [k, new Map(v)])); // trasferimenti basati sullo stato a inizio passo

    // Priorità stretta per mittente sul LoRa (come priority-queue.ts): se un messaggio più urgente
    // è rimasto bloccato per mancanza di budget, uno meno urgente non può "rubargli" l'airtime.
    const loraBlocked = new Set<string>();
    for (const m of sorted) {
      if (m.createdAt > t || delivered.has(m.id)) continue;
      const reached = reachedAt.get(m.id)!;
      const pending = destinationsOf(m).filter((d) => !reached.has(d) && isOn(byId.get(d)!, t));
      if (pending.length === 0) continue; // destinazioni rimaste tutte spente: niente da fare ora
      const reach = hopsFor(pending);
      const cost = opts.policy === "custody" ? costFor(pending) : null;
      for (const sender of nodes) {
        if (!isOn(sender, t)) continue;
        const have = startHeld.get(sender.id)!.get(m.id) ?? 0;
        if (have === 0) continue;
        let candidates = adj.get(sender.id)!;
        if (cost) {
          const dSender = cost.get(sender.id);
          if (dSender !== undefined) {
            // Destinazione raggiungibile ora: un solo next hop (routing-table.ts) lungo un percorso
            // di costo minimo; a parità di costo, quello col mezzo più veloce.
            const rank = (l: LinkState) => (l.medium === "wifi" ? 0 : l.medium === "ble" ? 1 : 1 + l.sf!);
            const edge = (l: LinkState) => (metric === "hops" ? 1 : linkAirtimeCost(l, p));
            const best = candidates
              .filter((c) => (cost.get(c.nb) ?? Infinity) < dSender)
              .sort((x, y) => edge(x.link) + cost.get(x.nb)! - (edge(y.link) + cost.get(y.nb)!) || rank(x.link) - rank(y.link))[0];
            candidates = best ? [best] : [];
          }
        }
        // Origine e destinazioni già raggiunte custodiscono il messaggio nel proprio store: niente TTL.
        if (sender.id !== m.source && !reached.has(sender.id) && opts.relayCarryTtlS) {
          // Come floodExcept(): finché esiste un percorso il relay inoltra subito (code del transport,
          // nessuna scadenza). Solo quando resta isolato dalla destinazione la copia finisce in
          // PendingDeliveryQueue, che la scarta dopo il TTL (scadenza pigra) — e SeenCache impedisce
          // di riceverla di nuovo.
          const key = `${sender.id}|${m.id}`;
          if (reach.has(sender.id)) {
            isolatedSince.delete(key);
          } else {
            const since = isolatedSince.get(key) ?? t;
            isolatedSince.set(key, since);
            if (t - since > opts.relayCarryTtlS(m.priority)) {
              held.get(sender.id)!.delete(m.id);
              dropped.add(key);
              continue;
            }
          }
        }
        for (const { nb, link } of candidates) {
          if (delivered.has(m.id)) break;
          if (dropped.has(`${nb}|${m.id}`)) continue;
          const recvHeld = held.get(nb)!.get(m.id) ?? 0;
          if (recvHeld >= have) continue;
          let want = have - recvHeld;
          if (link.medium === "lora") {
            if (loraBlocked.has(sender.id)) continue;
            const frameApp = loraAppBytesPerFrame(p);
            const toa = loraTimeOnAir(p.loraFrameBytes, link.sf!, p.phy);
            const budgetS = Math.min(bucket.get(sender.id)!, channelCredit);
            const frames = Math.min(Math.floor(budgetS / toa), Math.ceil(want / frameApp));
            if (frames <= 0) { loraBlocked.add(sender.id); continue; }
            const bytes = Math.min(want, frames * frameApp);
            bucket.set(sender.id, bucket.get(sender.id)! - frames * toa);
            channelCredit -= frames * toa;
            airtime.set(m.id, airtime.get(m.id)! + frames * toa);
            want = bytes;
          } else {
            const key = pairKey(sender.id, nb);
            const bps = link.rateBps ?? (link.medium === "wifi" ? p.shortRange.wifiBps : p.shortRange.bleBps);
            const left = shortBudget.get(key) ?? (bps / 8) * stepS;
            const bytes = Math.min(want, left);
            if (bytes <= 0) continue;
            shortBudget.set(key, left - bytes);
            want = bytes;
          }
          const newHeld = recvHeld + want;
          held.get(nb)!.set(m.id, newHeld);
          if (pending.includes(nb) && newHeld >= m.sizeBytes - 1e-6 && !reached.has(nb)) {
            reached.set(nb, t + stepS);
            if (destinationsOf(m).every((d) => reached.has(d))) delivered.set(m.id, t + stepS);
          }
        }
      }
    }
  }

  return {
    deliveries: messages.map((m) => ({
      messageId: m.id,
      deliveredAt: delivered.has(m.id) ? delivered.get(m.id)! - m.createdAt : null,
      deliveredAtByDest: Object.fromEntries(destinationsOf(m).map((d) => {
        const at = reachedAt.get(m.id)!.get(d);
        return [d, at === undefined ? null : at - m.createdAt];
      })),
      bytesAtDestination: Math.min(Math.max(...destinationsOf(m).map((d) => held.get(d)!.get(m.id) ?? 0)), m.sizeBytes),
      loraAirtimeS: airtime.get(m.id)!,
    })),
    instantConnectivity: Object.fromEntries(pairs.map((k) => [k, instantCount[k] / steps])),
    linkSnapshots,
  };
}
