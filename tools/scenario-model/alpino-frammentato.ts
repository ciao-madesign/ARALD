/**
 * Scenario 2 — Alpino frammentato: due valli parallele separate da una cresta
 * (~2700-2800 m) attraversabile da un solo colle, più un vallone laterale
 * chiuso da uno sperone. Geometria SINTETICA ispirata alle Alpi Cozie, non un
 * luogo rilevato: coordinate locali in metri con origine al Box (fondovalle A,
 * ~1600 m). Le perdite di terreno sono ipotesi di modello, non misure.
 *
 * A differenza dello Scenario 1 (perdite fisse per coppia di nodi), qui il
 * terreno è descritto per zone (valle A, vallone laterale, colle, valle B):
 * chi valica la cresta cambia zona e quindi cambia i propri link.
 */
import type { Environment, Message, NodeSpec, Point3, Waypoint } from "./model.js";
import type { Scenario } from "./scenario.js";

const H = 3600;

export const PLACES = {
  boxA: { x: 0, y: 0, z: 1600 },                 // borgo di fondovalle, valle A
  laterale: { x: 1200, y: -3200, z: 2250 },      // vallone laterale (dietro lo sperone)
  verso_laterale: { x: 600, y: -1500, z: 1900 },
  alpe: { x: 2500, y: 800, z: 2100 },            // alpeggio a metà salita, valle A
  colle: { x: 4000, y: 1000, z: 2750 },          // unico passaggio tra le due valli
  rifugioB: { x: 7500, y: 300, z: 2050 },        // rifugio in valle B (Portable del gestore)
  infortunio: { x: 6800, y: -1500, z: 2450 },    // conca in quota, valle B
} satisfies Record<string, Point3>;

type Zone = "A" | "Alat" | "colle" | "B";

/** Zona di un punto: il colle è la fascia alta sulla cresta, che vede entrambe le valli. */
export function zoneOf(p: Point3): Zone {
  if (p.x >= 3600 && p.x <= 4400 && p.z >= 2550) return "colle";
  if (p.x > 4000) return "B";
  if (p.y < -2000) return "Alat";
  return "A";
}

/** Perdita di terreno tra zone (dB, condizione tipica) — ipotesi di modello. */
const ZONE_LOSS: Record<string, number> = {
  "A|A": 0, "Alat|Alat": 0, "colle|colle": 0, "B|B": 0,
  "A|Alat": 25,   // sperone che chiude il vallone laterale
  "A|colle": 6,   // dal fondovalle il colle è visibile solo in parte
  "A|B": 40,      // cresta principale
  "Alat|colle": 20,
  "Alat|B": 50,
  "B|colle": 4,
};

export function terrainLossDb(pa: Point3, pb: Point3): number {
  const za = zoneOf(pa);
  const zb = zoneOf(pb);
  return ZONE_LOSS[`${za}|${zb}`] ?? ZONE_LOSS[`${zb}|${za}`] ?? 0;
}

function at(p: Point3, t: number, dx = 0, dy = 0): Waypoint {
  return { x: p.x + dx, y: p.y + dy, z: p.z, t };
}

function phoneOf(path: Waypoint[]): Waypoint[] {
  return path.map((w) => ({ ...w, x: w.x + 3, y: w.y + 2 }));
}

export type Variant = "static" | "col-card" | "fixed-relay" | "crossing" | "storm" | "box-failure";

export const VARIANTS: Record<Variant, string> = {
  static: "nessun ponte sul colle: tre isole radio (valle A, vallone laterale, valle B)",
  "col-card": "C3 sale al colle e ci resta: una persona con la Card fa da ponte tra le valli",
  "fixed-relay": "ARALD Fixed Relay installato al colle (13° dispositivo), C3 resta all'alpe",
  crossing: "nessun ponte; C4 raggiunge l'infortunato e poi rivalica fino al Box (data mule)",
  storm: "come 'fixed-relay', con una perturbazione (+12 dB su ogni link LoRa) dalle 4h alle 7h",
  "box-failure": "come 'fixed-relay', ma il Box va offline a 3h54 (prima dell'evento)",
};

export const EVENT_T = 4 * H;

const hasFixedRelay = (v: Variant) => v === "fixed-relay" || v === "storm" || v === "box-failure";

export function buildNodes(variant: Variant): NodeSpec[] {
  const P = PLACES;
  const box: Waypoint[] = [at(P.boxA, 0)];
  const portable: Waypoint[] = [at(P.rifugioB, 0)];
  const c1: Waypoint[] = [at(P.boxA, 0, 15, 10)];
  const c2: Waypoint[] = [at(P.boxA, 0, 20, -10), at(P.verso_laterale, 1 * H), at(P.laterale, 2 * H)];
  const c3: Waypoint[] = [at(P.boxA, 0, 30, 5), at(P.alpe, 1.5 * H)];
  if (variant === "col-card") c3.push(at(P.alpe, 1.75 * H), at(P.colle, 3 * H));
  let c4: Waypoint[] = [at(P.boxA, 0, -10, 20), at(P.alpe, 1.5 * H, 20, 0), at(P.colle, 2.75 * H, 10, 0), at(P.rifugioB, 3.75 * H, -20, 20)];
  const c5: Waypoint[] = [at(P.boxA, 0, -20, 15), at(P.alpe, 1.5 * H, 30, 0), at(P.colle, 2.75 * H, 20, 0), at(P.infortunio, 3.75 * H)];
  if (variant === "crossing") {
    // C4 parte dal rifugio alle 4h, raggiunge l'infortunato (4h45), resta 15 min, rivalica: colle 6h15, alpe 7h, Box 8h.
    c4 = [...c4, at(P.rifugioB, 4 * H, -20, 20), at(P.infortunio, 4.75 * H, 10, 0), at(P.infortunio, 5 * H, 10, 0), at(P.colle, 6.25 * H, 10, 0), at(P.alpe, 7 * H, 20, 0), at(P.boxA, 8 * H, -10, 20)];
  }

  const nodes: NodeSpec[] = [
    { id: "BOX", kind: "box", path: box, offFrom: variant === "box-failure" ? 3.9 * H : undefined },
    { id: "PORT", kind: "portable", path: portable },
    { id: "C1", kind: "card", path: c1 },
    { id: "C2", kind: "card", path: c2 },
    { id: "C3", kind: "card", path: c3 },
    { id: "C4", kind: "card", path: c4 },
    { id: "C5", kind: "card", path: c5 },
    { id: "S1", kind: "phone", path: phoneOf(c1) },
    { id: "S2", kind: "phone", path: phoneOf(c2) },
    { id: "S3", kind: "phone", path: phoneOf(c3) },
    { id: "S4", kind: "phone", path: phoneOf(c4) },
    { id: "S5", kind: "phone", path: phoneOf(c5) },
  ];
  if (hasFixedRelay(variant)) nodes.push({ id: "FR", kind: "relay", path: [at(P.colle, 0, 10, 10)] });
  return nodes;
}

export const ENVIRONMENTS: Record<"favorevole" | "tipico" | "severo", Environment> = {
  favorevole: { name: "favorevole", pathLossExponent: 2.2, fadeMarginDb: 8, obstructionDb: {}, obstructionFn: terrainLossDb, obstructionScale: 0.5, interferenceDb: 0 },
  tipico: { name: "tipico", pathLossExponent: 2.6, fadeMarginDb: 10, obstructionDb: {}, obstructionFn: terrainLossDb, obstructionScale: 1, interferenceDb: 2 },
  severo: { name: "severo", pathLossExponent: 3.0, fadeMarginDb: 12, obstructionDb: {}, obstructionFn: terrainLossDb, obstructionScale: 1.4, interferenceDb: 5 },
};

/** Stessi 5 file benchmark dello Scenario 1; l'SOS punta a entrambe le infrastrutture. */
export function benchmarkMessages(): Message[] {
  const KB = 1024;
  const MB = 1024 * KB;
  return [
    { id: "F1", label: "SOS + coordinate (1 KB)", sizeBytes: 1 * KB, priority: 0, source: "C5", destination: ["PORT", "BOX"], createdAt: EVENT_T },
    { id: "F5", label: "GPS + audio 10 s (150 KB)", sizeBytes: 150 * KB, priority: 1, source: "S5", destination: "BOX", createdAt: EVENT_T },
    { id: "F2", label: "Articolo Wiki (200 KB → ~70 KB compresso)", sizeBytes: 70 * KB, priority: 3, source: "BOX", destination: "S5", createdAt: EVENT_T },
    { id: "F4", label: "Rapporto 5 pag. + 3 JPEG (5 MB)", sizeBytes: 5 * MB, priority: 3, source: "S5", destination: "BOX", createdAt: EVENT_T },
    { id: "F3", label: "8 JPEG (12 MB)", sizeBytes: 12 * MB, priority: 5, source: "S5", destination: "BOX", createdAt: EVENT_T },
  ];
}

export const alpinoFrammentato: Scenario = {
  id: "alpino-frammentato",
  title: "Scenario 2 — alpino frammentato (due valli separate da una cresta)",
  variants: VARIANTS,
  environments: ENVIRONMENTS,
  buildNodes: (variant) => buildNodes(variant as Variant),
  messages: benchmarkMessages,
  eventT: EVENT_T,
  extraLossDb: (variant) => (variant === "storm" ? (t) => (t >= 4 * H && t < 7 * H ? 12 : 0) : undefined),
  linkPairs: [["BOX", "C3"], ["BOX", "C2"], ["BOX", "FR"], ["C3", "FR"], ["FR", "PORT"], ["FR", "C5"], ["PORT", "C5"], ["BOX", "PORT"], ["BOX", "C5"], ["C3", "C5"]],
  linkSnapshotVariant: "fixed-relay",
  connectivityPair: ["C5", "BOX"],
};
