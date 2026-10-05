/**
 * Scenario 1 — Alpino remoto: alta Valle Maira (Chiappera / Piana di Stroppia /
 * Rifugio Stroppia / Bivacco Barenghi). Coordinate locali in metri con origine
 * al Rifugio Campo Base (~1650 m); posizioni e quote INDICATIVE, ricostruite
 * dalle distanze dell'analisi di partenza, non rilevate su cartografia.
 * Le perdite per ostruzione sono ipotesi di modello, non misure.
 */
import type { Environment, Message, NodeSpec, Point3, Waypoint } from "./model.js";
import { pairKey } from "./model.js";
import type { Scenario } from "./scenario.js";

const H = 3600;

export const PLACES = {
  campoBase: { x: 0, y: 0, z: 1650 },
  piana: { x: -900, y: -400, z: 1700 },        // Zona B — Piana di Stroppia
  pianaAlta: { x: -1500, y: -700, z: 1780 },   // Zona B — Portable
  sottoCascate: { x: -1900, y: -900, z: 1800 }, // Zona B/C — C3
  rifStroppia: { x: -3300, y: -1900, z: 2260 }, // Zona C — Rifugio Stroppia
  barenghi: { x: -4300, y: -3200, z: 2815 },    // Zona C — verso Bivacco Barenghi
} satisfies Record<string, Point3>;

function at(p: Point3, t: number, dx = 0, dy = 0): Waypoint {
  return { x: p.x + dx, y: p.y + dy, z: p.z, t };
}

/** Telefono che segue la propria Card a pochi metri (link BLE Card↔telefono). */
function phoneOf(path: Waypoint[]): Waypoint[] {
  return path.map((w) => ({ ...w, x: w.x + 3, y: w.y + 2 }));
}

export type Variant = "static" | "ferry" | "return" | "card-failure";

export const VARIANTS: Record<Variant, string> = {
  static: "gruppo fermo dopo l'arrivo (C5 verso Barenghi, C4 al rifugio)",
  ferry: "C3 sale fino a C5 (data mule) e rientra al Campo Base",
  return: "C5+S5 scendono al Campo Base (rientro del gruppo)",
  "card-failure": "come 'static', ma la Card C4 (rifugio) si spegne a 3h",
};

export const EVENT_T = 3.25 * H; // generazione dei file benchmark (3h15)

export function buildNodes(variant: Variant): NodeSpec[] {
  const P = PLACES;
  const box: Waypoint[] = [at(P.campoBase, 0)];
  const c1: Waypoint[] = [at(P.campoBase, 0, 15, 10)];
  const c2: Waypoint[] = [at(P.campoBase, 0, 20, -10), at(P.piana, 0.5 * H)];
  const portable: Waypoint[] = [at(P.campoBase, 0, 25, -12), at(P.pianaAlta, 0.75 * H)];
  let c3: Waypoint[] = [at(P.campoBase, 0, 30, 5), at(P.sottoCascate, 0.75 * H)];
  const c4: Waypoint[] = [at(P.campoBase, 0, -10, 20), at(P.sottoCascate, 0.75 * H, 30, 0), at(P.rifStroppia, 2 * H)];
  let c5: Waypoint[] = [at(P.campoBase, 0, -20, 15), at(P.sottoCascate, 0.75 * H, 40, 10), at(P.rifStroppia, 2 * H, 20, 0), at(P.barenghi, 3 * H)];

  if (variant === "ferry") {
    // C3 parte alle 3h30, arriva da C5 alle 5h, ci resta 10 min, rientra al Campo Base alle 7h.
    c3 = [...c3, at(P.sottoCascate, 3.5 * H), at(P.rifStroppia, 4.25 * H), at(P.barenghi, 5 * H, -10, 0), at(P.barenghi, 5.17 * H, -10, 0), at(P.rifStroppia, 5.9 * H), at(P.sottoCascate, 6.5 * H), at(P.campoBase, 7 * H, 30, 5)];
  }
  if (variant === "return") {
    // C5 riparte alle 3h30 e scende: rifugio 4h15, cascate 5h, Campo Base 5h30.
    c5 = [...c5, at(P.barenghi, 3.5 * H), at(P.rifStroppia, 4.25 * H, 20, 0), at(P.sottoCascate, 5 * H, 40, 10), at(P.campoBase, 5.5 * H, -20, 15)];
  }

  return [
    { id: "BOX", kind: "box", path: box },
    { id: "PORT", kind: "portable", path: portable },
    { id: "C1", kind: "card", path: c1 },
    { id: "C2", kind: "card", path: c2 },
    { id: "C3", kind: "card", path: c3 },
    { id: "C4", kind: "card", path: c4, offFrom: variant === "card-failure" ? 3 * H : undefined },
    { id: "C5", kind: "card", path: c5 },
    { id: "S1", kind: "phone", path: phoneOf(c1) },
    { id: "S2", kind: "phone", path: phoneOf(c2) },
    { id: "S3", kind: "phone", path: phoneOf(c3) },
    { id: "S4", kind: "phone", path: phoneOf(c4) },
    { id: "S5", kind: "phone", path: phoneOf(c5) },
  ];
}

/**
 * Ostruzioni ipotizzate (dB, condizione tipica): il gradino roccioso delle
 * Cascate di Stroppia separa il fondovalle dal vallone del rifugio, e il
 * vallone alto verso Barenghi è ulteriormente incassato.
 */
const OBSTRUCTION: Record<string, number> = {};
function obstruct(a: string[], b: string[], db: number) {
  for (const x of a) for (const y of b) OBSTRUCTION[pairKey(x, y)] = db;
}
obstruct(["BOX", "C1"], ["C4"], 15);
obstruct(["BOX", "C1"], ["C5"], 25);
obstruct(["C2"], ["C4"], 12);
obstruct(["C2"], ["C5"], 22);
obstruct(["PORT"], ["C4"], 8);
obstruct(["PORT"], ["C5"], 18);
obstruct(["C3"], ["C5"], 12);
obstruct(["C3"], ["C4"], 4);

export const ENVIRONMENTS: Record<"favorevole" | "tipico" | "severo", Environment> = {
  favorevole: { name: "favorevole", pathLossExponent: 2.2, fadeMarginDb: 8, obstructionDb: OBSTRUCTION, obstructionScale: 0.3, interferenceDb: 0 },
  tipico: { name: "tipico", pathLossExponent: 2.6, fadeMarginDb: 10, obstructionDb: OBSTRUCTION, obstructionScale: 1, interferenceDb: 2 },
  severo: { name: "severo", pathLossExponent: 3.0, fadeMarginDb: 12, obstructionDb: OBSTRUCTION, obstructionScale: 1.6, interferenceDb: 5 },
};

/**
 * I 5 file benchmark. Dimensioni "sul filo" dopo la compressione Zstd di ARALD
 * (voce #119): il testo comprime (~3×), JPEG/audio già compressi no.
 */
export function benchmarkMessages(): Message[] {
  const KB = 1024;
  const MB = 1024 * KB;
  return [
    { id: "F1", label: "SOS + coordinate (1 KB)", sizeBytes: 1 * KB, priority: 0, source: "C5", destination: "BOX", createdAt: EVENT_T },
    { id: "F5", label: "GPS + audio 10 s (150 KB)", sizeBytes: 150 * KB, priority: 1, source: "S5", destination: "BOX", createdAt: EVENT_T },
    { id: "F2", label: "Articolo Wiki (200 KB → ~70 KB compresso)", sizeBytes: 70 * KB, priority: 3, source: "BOX", destination: "S5", createdAt: EVENT_T },
    { id: "F4", label: "Rapporto 5 pag. + 3 JPEG (5 MB)", sizeBytes: 5 * MB, priority: 3, source: "S5", destination: "BOX", createdAt: EVENT_T },
    { id: "F3", label: "8 JPEG (12 MB)", sizeBytes: 12 * MB, priority: 5, source: "S5", destination: "BOX", createdAt: EVENT_T },
  ];
}

export const valleMaira: Scenario = {
  id: "valle-maira",
  title: "Scenario 1 — alta Valle Maira",
  variants: VARIANTS,
  environments: ENVIRONMENTS,
  buildNodes: (variant) => buildNodes(variant as Variant),
  messages: benchmarkMessages,
  eventT: EVENT_T,
  linkPairs: [["BOX", "C2"], ["BOX", "C3"], ["BOX", "C4"], ["BOX", "C5"], ["C2", "C3"], ["C3", "C4"], ["C4", "C5"], ["C3", "C5"], ["PORT", "C3"], ["PORT", "C4"], ["PORT", "C5"]],
  linkSnapshotVariant: "static",
  connectivityPair: ["C5", "BOX"],
};
