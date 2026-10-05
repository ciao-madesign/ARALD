/**
 * Scenario 3 — Isole Eolie: rete tra isole su mare aperto (Lipari, Vulcano,
 * Salina, Panarea, Stromboli), con un aliscafo come "data mule".
 *
 * Primo scenario costruito come lo userà il futuro ARALD Network Design Tool
 * (docs/network-design-tool.md): dispositivi posizionati su latitudine/longitudine,
 * altezza dal suolo per tipo di dispositivo, terreno interrogato tramite
 * l'interfaccia `Terrain` (diffrazione sul profilo, curvatura terrestre, uso del
 * suolo), BLE/Wi-Fi con link budget (`model: "budget"`).
 *
 * COORDINATE APPROSSIMATIVE, ricostruite da conoscenza generale e NON verificate
 * su cartografia in questo ambiente. Il terreno è SINTETICO (isole a cono con la
 * quota di vetta indicativa di ciascuna isola): quando il tool userà un DEM reale,
 * basterà sostituire `EOLIE_TERRAIN`.
 */
import type { Message, NodeSpec, Waypoint } from "./model.js";
import { KIND_DEFAULTS, type NodeKind } from "./model.js";
import { TERRAIN_ENVIRONMENTS } from "./network-config.js";
import type { Scenario } from "./scenario.js";
import { type GeoPoint, type LocalFrame, syntheticIslands, toLocal } from "./terrain.js";

const H = 3600;

export const EOLIE_FRAME: LocalFrame = { lat0: 38.6, lon0: 15.05 };

export const EOLIE_TERRAIN = syntheticIslands(
  "Eolie (sintetico)",
  EOLIE_FRAME,
  [
    { name: "Lipari", center: { lat: 38.488, lon: 14.925 }, radiusM: 4300, summitM: 602 },
    { name: "Vulcano", center: { lat: 38.39, lon: 14.965 }, radiusM: 3500, summitM: 499 },
    { name: "Salina", center: { lat: 38.562, lon: 14.84 }, radiusM: 4300, summitM: 962 },
    { name: "Panarea", center: { lat: 38.636, lon: 15.066 }, radiusM: 1700, summitM: 421 },
    { name: "Stromboli", center: { lat: 38.792, lon: 15.212 }, radiusM: 2700, summitM: 924 },
  ],
  [
    { name: "Lipari centro", center: { lat: 38.466, lon: 14.955 }, radiusM: 600, cover: "urban-dense" },
    { name: "Vulcano Porto", center: { lat: 38.418, lon: 14.962 }, radiusM: 300, cover: "urban" },
    { name: "Santa Marina Salina", center: { lat: 38.561, lon: 14.879 }, radiusM: 300, cover: "urban" },
    { name: "San Pietro (Panarea)", center: { lat: 38.632, lon: 15.08 }, radiusM: 250, cover: "urban" },
    { name: "Stromboli paese", center: { lat: 38.8, lon: 15.237 }, radiusM: 400, cover: "urban" },
  ],
);

export const EOLIE_PLACES = {
  liparicentro: { lat: 38.4665, lon: 14.9545 },
  lipariPorto: { lat: 38.4705, lon: 14.9625 },   // molo (fuori dal centro denso)
  vulcanoPorto: { lat: 38.418, lon: 14.962 },
  santaMarina: { lat: 38.561, lon: 14.879 },
  sanPietro: { lat: 38.632, lon: 15.08 },
  panareaVetta: { lat: 38.636, lon: 15.066 },    // Punta del Corvo, ~420 m
  strombolPaese: { lat: 38.8, lon: 15.237 },
  strombolPendio: { lat: 38.797, lon: 15.222 },  // escursionista, ~350 m (terreno sintetico)
  mareLipariPanarea: { lat: 38.53, lon: 15.01 },
  panareaMolo: { lat: 38.629, lon: 15.085 },
  strombolScari: { lat: 38.797, lon: 15.243 },
} satisfies Record<string, GeoPoint>;

/** Waypoint su terreno: quota del suolo + altezza dell'antenna (per tipo o esplicita). */
function wp(g: GeoPoint, t: number, kind: NodeKind, aglM = KIND_DEFAULTS[kind].heightAglM, dxM = 0, dyM = 0): Waypoint {
  const { x, y } = toLocal(EOLIE_FRAME, g);
  return { x: x + dxM, y: y + dyM, z: EOLIE_TERRAIN.elevationAt(x + dxM, y + dyM) + aglM, t };
}

function phoneOf(path: Waypoint[]): Waypoint[] {
  return path.map((w) => ({ ...w, x: w.x + 3, y: w.y + 2 }));
}

export type Variant = "static" | "hydrofoil" | "panarea-relay" | "relay-hydrofoil" | "box-harbour";

export const VARIANTS: Record<Variant, string> = {
  static: "aliscafo fermo: C4 resta al porto di Lipari",
  hydrofoil: "C4 è a bordo dell'aliscafo Lipari → Panarea → Stromboli → Panarea → Lipari (data mule)",
  "panarea-relay": "ARALD Fixed Relay sulla vetta di Panarea (~420 m), aliscafo fermo",
  "relay-hydrofoil": "Fixed Relay a Panarea e aliscafo in servizio",
  "box-harbour": "come 'hydrofoil', ma il Box è sul molo di Lipari (dove attracca l'aliscafo) invece che nel centro abitato denso",
};

export const EVENT_T = 0.5 * H;

export function buildNodes(variant: Variant): NodeSpec[] {
  const P = EOLIE_PLACES;
  const boxAt = variant === "box-harbour" ? P.lipariPorto : P.liparicentro;
  const sail = variant === "hydrofoil" || variant === "relay-hydrofoil" || variant === "box-harbour";
  const boat = 3; // antenna a bordo, ~3 m sul mare
  const c4: Waypoint[] = sail
    ? [
      wp(P.lipariPorto, 0, "card", boat, 120, 0), wp(P.lipariPorto, 0.25 * H, "card", boat, 120, 0),
      wp(P.mareLipariPanarea, 0.6 * H, "card", boat), wp(P.panareaMolo, 1 * H, "card", boat), wp(P.panareaMolo, 1.08 * H, "card", boat),
      wp(P.strombolScari, 1.75 * H, "card", boat), wp(P.strombolScari, 2 * H, "card", boat),
      wp(P.panareaMolo, 2.67 * H, "card", boat), wp(P.panareaMolo, 2.75 * H, "card", boat),
      wp(P.mareLipariPanarea, 3.1 * H, "card", boat), wp(P.lipariPorto, 3.5 * H, "card", boat, 120, 0),
    ]
    : [wp(P.lipariPorto, 0, "card", boat, 120, 0)];
  const c5: Waypoint[] = [wp(P.strombolPaese, 0, "card", undefined, 30, 0), wp(P.strombolPendio, 0.45 * H, "card")];

  const c1 = [wp(P.vulcanoPorto, 0, "card")];
  const c2 = [wp(P.santaMarina, 0, "card")];
  const c3 = [wp(P.sanPietro, 0, "card")];
  const nodes: NodeSpec[] = [
    { id: "BOX", kind: "box", path: [wp(boxAt, 0, "box")] },
    { id: "PORT", kind: "portable", path: [wp(P.strombolPaese, 0, "portable")] },
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
  if (variant === "panarea-relay" || variant === "relay-hydrofoil") nodes.push({ id: "FR", kind: "relay", path: [wp(P.panareaVetta, 0, "relay")] });
  // La quota segue il terreno lungo le traiettorie (nodePosition in model.ts); a bordo, 3 m sul mare.
  for (const n of nodes) n.heightAglM = n.id === "C4" || n.id === "S4" ? boat : KIND_DEFAULTS[n.kind].heightAglM;
  return nodes;
}

export const ENVIRONMENTS = {
  favorevole: { ...TERRAIN_ENVIRONMENTS.favorevole, terrain: EOLIE_TERRAIN },
  tipico: { ...TERRAIN_ENVIRONMENTS.tipico, terrain: EOLIE_TERRAIN },
  severo: { ...TERRAIN_ENVIRONMENTS.severo, terrain: EOLIE_TERRAIN },
};

/** Stessi 5 file benchmark; l'SOS dell'escursionista a Stromboli punta al Portable (paese) e al Box (Lipari). */
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

export const eolie: Scenario = {
  id: "eolie",
  title: "Scenario 3 — Isole Eolie (rete tra isole, aliscafo come data mule)",
  variants: VARIANTS,
  environments: ENVIRONMENTS,
  buildNodes: (variant) => buildNodes(variant as Variant),
  messages: benchmarkMessages,
  eventT: EVENT_T,
  linkPairs: [["BOX", "C1"], ["BOX", "C2"], ["BOX", "C3"], ["BOX", "PORT"], ["BOX", "C5"], ["C2", "C3"], ["C3", "PORT"], ["C3", "C5"], ["PORT", "C5"], ["FR", "BOX"], ["FR", "PORT"], ["FR", "C5"]],
  linkSnapshotVariant: "panarea-relay",
  connectivityPair: ["C5", "BOX"],
  shortRangeModel: "budget",
};
