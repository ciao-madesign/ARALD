/**
 * Interfaccia di interrogazione del motore per il futuro ARALD Network Design
 * Tool (docs/network-design-tool.md §10): "dato il dispositivo A nella posizione
 * X e il dispositivo B nella posizione Y, considerando questo territorio, quale
 * connessione è possibile e quali sono le sue prestazioni stimate?".
 *
 * Tutto qui è deterministico e senza stato: nessuna simulazione temporale, nessun
 * riferimento a mappa, colori o Markdown. La visualizzazione (colore della linea,
 * alone di copertura) si costruisce da `quality` e dalle celle di `coverageGrid()`.
 */
import {
  KIND_DEFAULTS, type Medium, type ModelParams, type NodeKind, type NodeSpec, type Point3,
  distance3, evaluateBle, evaluateLora, evaluateWifi, loraDutyLimitedAppBps,
} from "./model.js";
import { terrainProfileLoss } from "./terrain.js";

/** Estremi della scala di qualità: 10 bit/s → 0, 30 Mbit/s → 1 (scala logaritmica). */
export const QUALITY_MIN_BPS = 10;
export const QUALITY_MAX_BPS = 30_000_000;

/**
 * Qualità normalizzata 0-1 da una velocità: scala logaritmica, perché le tecnologie
 * coprono sei ordini di grandezza (LoRa SF12 ~100 bit/s, Wi-Fi decine di Mbit/s).
 * Il tool la mappa sullo spettro rosso → giallo → verde (§6).
 */
export function qualityFromRate(bps: number): number {
  if (!(bps > 0)) return 0;
  const q = Math.log10(bps / QUALITY_MIN_BPS) / Math.log10(QUALITY_MAX_BPS / QUALITY_MIN_BPS);
  return Math.min(1, Math.max(0, q));
}

/** Etichetta testuale della qualità (pannello informativo, §7). */
export function qualityLabel(q: number): "Ottima" | "Buona" | "Discreta" | "Debole" | "Assente" {
  if (q <= 0) return "Assente";
  if (q >= 0.75) return "Ottima";
  if (q >= 0.55) return "Buona";
  if (q >= 0.35) return "Discreta";
  return "Debole";
}

export interface TechAssessment {
  technology: Medium;
  /** La tecnologia esiste su entrambi i dispositivi (e, per il Wi-Fi, c'è un access point). */
  applicable: boolean;
  possible: boolean;
  rssiDbm: number | null;
  /** true se `rssiDbm` è solo un limite superiore: il link non chiuderebbe nemmeno senza territorio, profilo non calcolato. */
  rssiIsUpperBound: boolean;
  marginDb: number | null;
  /** Modo radio scelto (es. "SF9", "1M PHY", "MCS4"). */
  mode: string | null;
  /** Velocità applicativa istantanea (bit/s). */
  rateBps: number;
  /**
   * Velocità sostenibile nel tempo (bit/s): per LoRa limitata dal duty-cycle legale,
   * per BLE/Wi-Fi uguale a quella istantanea.
   */
  sustainedBps: number;
  quality: number;
}

export interface LinkAssessment {
  a: string;
  b: string;
  distanceM: number;
  /** Linea di vista geometrica e perdita di diffrazione (a 868 MHz), se il territorio è noto. */
  terrain: { lineOfSight: boolean; diffractionLossDb: number } | null;
  perTechnology: TechAssessment[];
  /** Tecnologia con la velocità istantanea più alta tra quelle possibili, o null. */
  best: TechAssessment | null;
}

export function assessLink(a: NodeSpec, pa: Point3, b: NodeSpec, pb: Point3, p: ModelParams, extraLossDb = 0): LinkAssessment {
  const perTechnology = [evaluateWifi, evaluateBle, evaluateLora].map((ev): TechAssessment => {
    const r = ev(a, pa, b, pb, p, extraLossDb);
    const rate = r.link?.rateBps ?? 0;
    const sustained = r.link?.sf !== undefined ? loraDutyLimitedAppBps(r.link.sf, p) : rate;
    return {
      technology: r.medium,
      applicable: r.applicable,
      possible: r.link !== null,
      rssiDbm: r.rssiDbm,
      rssiIsUpperBound: r.rssiIsUpperBound,
      marginDb: r.link?.marginDb ?? null,
      mode: r.link?.mode ?? null,
      rateBps: rate,
      sustainedBps: sustained,
      quality: qualityFromRate(rate),
    };
  });
  const possible = perTechnology.filter((t) => t.possible).sort((x, y) => y.rateBps - x.rateBps);
  const prof = p.env.terrain ? terrainProfileLoss(p.env.terrain, pa, pb, 868e6) : null;
  return {
    a: a.id,
    b: b.id,
    distanceM: distance3(pa, pb),
    terrain: prof ? { lineOfSight: prof.lineOfSight, diffractionLossDb: prof.lossDb } : null,
    perTechnology,
    best: possible[0] ?? null,
  };
}

/**
 * Ricevitore di riferimento per disegnare l'alone di una tecnologia: con chi deve
 * potersi collegare un punto per dirsi "coperto". Scelte di default (modificabili):
 * LoRa → una Card (il dispositivo LoRa più debole), BLE e Wi-Fi → uno smartphone.
 */
export const COVERAGE_REFERENCE: Record<Medium, NodeKind> = { lora: "card", ble: "phone", wifi: "phone" };

export interface CoverageCell { x: number; y: number; possible: boolean; rateBps: number; quality: number }

export interface CoverageGrid {
  technology: Medium;
  reference: NodeKind;
  cellM: number;
  cols: number;
  rows: number;
  /** Righe da nord a sud, colonne da ovest a est; coordinate del centro cella. */
  cells: CoverageCell[];
}

/**
 * Alone di copertura di un dispositivo per una tecnologia (§4): per ogni cella di una
 * griglia si valuta il link verso un ricevitore di riferimento posto al suolo della
 * cella (quota dal territorio + altezza tipica del riferimento). Il risultato segue
 * il territorio: dietro un rilievo la cella resta scoperta anche se vicina.
 */
export function coverageGrid(
  device: NodeSpec, pos: Point3, technology: Medium, p: ModelParams,
  bbox: { minX: number; minY: number; maxX: number; maxY: number }, cellM: number,
  reference: NodeKind = COVERAGE_REFERENCE[technology],
): CoverageGrid {
  const ev = technology === "lora" ? evaluateLora : technology === "ble" ? evaluateBle : evaluateWifi;
  const cols = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) / cellM));
  const rows = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) / cellM));
  const ref: NodeSpec = { id: "__riferimento__", kind: reference, path: [] };
  const agl = KIND_DEFAULTS[reference].heightAglM;
  const cells: CoverageCell[] = [];
  for (let r = 0; r < rows; r++) {
    const y = bbox.maxY - (r + 0.5) * cellM;
    for (let c = 0; c < cols; c++) {
      const x = bbox.minX + (c + 0.5) * cellM;
      const ground = p.env.terrain?.elevationAt(x, y) ?? 0;
      const link = ev(device, pos, ref, { x, y, z: ground + agl }, p).link;
      const rate = link?.rateBps ?? 0;
      cells.push({ x, y, possible: link !== null, rateBps: rate, quality: qualityFromRate(rate) });
    }
  }
  return { technology, reference, cellM, cols, rows, cells };
}
