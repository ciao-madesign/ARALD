/**
 * Scenario 4 — Deserto di Atacama (Cile): distanze di decine di chilometri su un
 * deserto aperto ad alta quota, un fuoristrada come data mule, e la regione radio
 * a 915-928 MHz (piano AU915: niente duty-cycle, ma dwell time di 400 ms).
 *
 * Costruito nel formato del futuro ARALD Network Design Tool, come lo Scenario 3:
 * dispositivi su latitudine/longitudine, altezza dal suolo per tipo, territorio
 * interrogabile, BLE/Wi-Fi a link budget.
 *
 * COORDINATE E QUOTE APPROSSIMATIVE, ricostruite da conoscenza generale e NON
 * verificate su cartografia in questo ambiente. Il terreno è SINTETICO: salar
 * piatto a ~2300 m che sale verso l'altopiano andino (~4200 m) a est, la cresta
 * della Cordillera de la Sal tra San Pedro e la Valle de la Luna, i coni del
 * Licancabur e del Láscar, e un rilievo panoramico ipotetico per il Fixed Relay.
 * Anche il profilo regolatorio AU915 per il Cile NON è verificato sulla normativa.
 */
import type { Message, NodeSpec, Waypoint } from "./model.js";
import { AU915, EU868_G3, KIND_DEFAULTS, type NodeKind } from "./model.js";
import { TERRAIN_ENVIRONMENTS } from "./network-config.js";
import type { Scenario } from "./scenario.js";
import { type GeoPoint, type LocalFrame, syntheticLandscape, toLocal } from "./terrain.js";

const H = 3600;

export const ATACAMA_FRAME: LocalFrame = { lat0: -23.2, lon0: -68.0 };

export const ATACAMA_PLACES = {
  sanPedro: { lat: -22.911, lon: -68.2 },
  valleLuna: { lat: -22.925, lon: -68.285 },
  toconao: { lat: -23.187, lon: -68.005 },
  chaxa: { lat: -23.29, lon: -68.18 },
  socaire: { lat: -23.59, lon: -67.89 },
  miscanti: { lat: -23.73, lon: -67.77 },
  mirador: { lat: -23.42, lon: -67.94 },   // rilievo panoramico ipotetico sopra il salar
} satisfies Record<string, GeoPoint>;

/** Altopiano che sale da ovest (salar, ~2300 m) a est (~4200 m), con raccordo dolce. */
function plateau(x: number): number {
  const west = toLocal(ATACAMA_FRAME, { lat: -23.2, lon: -68.05 }).x;
  const east = toLocal(ATACAMA_FRAME, { lat: -23.2, lon: -67.75 }).x;
  const f = Math.max(0, Math.min(1, (x - west) / (east - west)));
  return 2300 + 1900 * f * f * (3 - 2 * f);
}

export const ATACAMA_TERRAIN = syntheticLandscape("Atacama (sintetico)", ATACAMA_FRAME, {
  baseElevation: (x) => plateau(x),
  cones: [
    { name: "Licancabur", center: { lat: -22.83, lon: -67.88 }, radiusM: 7000, summitM: 2400, shape: 1.3 },
    { name: "Láscar", center: { lat: -23.37, lon: -67.73 }, radiusM: 6000, summitM: 1700, shape: 1.3 },
    { name: "Mirador (ipotetico)", center: ATACAMA_PLACES.mirador, radiusM: 3000, summitM: 400, shape: 1.2 },
  ],
  ridges: [
    { name: "Cordillera de la Sal", from: { lat: -22.8, lon: -68.25 }, to: { lat: -23.15, lon: -68.3 }, heightM: 350, halfWidthM: 2500 },
  ],
  settlements: [
    { name: "San Pedro de Atacama", center: ATACAMA_PLACES.sanPedro, radiusM: 700, cover: "urban" },
    { name: "Toconao", center: ATACAMA_PLACES.toconao, radiusM: 400, cover: "urban" },
    { name: "Socaire", center: ATACAMA_PLACES.socaire, radiusM: 300, cover: "urban" },
  ],
  defaultLandCover: "open",
});

function wp(g: GeoPoint, t: number, kind: NodeKind, dxM = 0, dyM = 0): Waypoint {
  const { x, y } = toLocal(ATACAMA_FRAME, g);
  return { x: x + dxM, y: y + dyM, z: ATACAMA_TERRAIN.elevationAt(x + dxM, y + dyM) + KIND_DEFAULTS[kind].heightAglM, t };
}

function phoneOf(path: Waypoint[]): Waypoint[] {
  return path.map((w) => ({ ...w, x: w.x + 3, y: w.y + 2 }));
}

export type Variant = "static" | "vehicle" | "andes-relay" | "relay-vehicle" | "portable-vehicle";

export const VARIANTS: Record<Variant, string> = {
  static: "fuoristrada fermo a San Pedro",
  vehicle: "fuoristrada (C4) San Pedro → Toconao → Socaire → Laguna Miscanti e ritorno (data mule)",
  "andes-relay": "ARALD Fixed Relay sul rilievo panoramico sopra il salar, fuoristrada fermo",
  "relay-vehicle": "Fixed Relay e fuoristrada in servizio",
  "portable-vehicle": "come 'vehicle', ma il Portable viaggia sul fuoristrada invece di restare a Toconao",
};

export const EVENT_T = 0.5 * H;

export function buildNodes(variant: Variant): NodeSpec[] {
  const P = ATACAMA_PLACES;
  const drive = variant !== "static" && variant !== "andes-relay";
  // Tour in fuoristrada: ~60 km/h su pista, soste brevi nei villaggi.
  const route = (kind: NodeKind, d = 0): Waypoint[] => drive
    ? [
      wp(P.sanPedro, 0, kind, 40 + d, 0), wp(P.toconao, 0.75 * H, kind, 60 + d, 0), wp(P.socaire, 1.58 * H, kind, 40 + d, 0),
      wp(P.miscanti, 2.08 * H, kind, 20 + d, 0), wp(P.miscanti, 2.33 * H, kind, 20 + d, 0),
      wp(P.socaire, 2.83 * H, kind, 40 + d, 0), wp(P.toconao, 3.67 * H, kind, 60 + d, 0), wp(P.sanPedro, 4.42 * H, kind, 40 + d, 0),
    ]
    : [wp(P.sanPedro, 0, kind, 40 + d, 0)];
  const c4 = route("card");
  const portable = variant === "portable-vehicle" ? route("portable", 2) : [wp(P.toconao, 0, "portable")];
  const c1 = [wp(P.valleLuna, 0, "card")];
  const c2 = [wp(P.chaxa, 0, "card")];
  const c3 = [wp(P.socaire, 0, "card")];
  const c5 = [wp(P.miscanti, 0, "card")];
  const nodes: NodeSpec[] = [
    { id: "BOX", kind: "box", path: [wp(P.sanPedro, 0, "box")] },
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
  if (variant === "andes-relay" || variant === "relay-vehicle") nodes.push({ id: "FR", kind: "relay", path: [wp(P.mirador, 0, "relay")] });
  // La quota segue il terreno lungo le traiettorie (nodePosition in model.ts).
  for (const n of nodes) n.heightAglM = KIND_DEFAULTS[n.kind].heightAglM;
  return nodes;
}

export const ENVIRONMENTS = {
  favorevole: { ...TERRAIN_ENVIRONMENTS.favorevole, terrain: ATACAMA_TERRAIN },
  tipico: { ...TERRAIN_ENVIRONMENTS.tipico, terrain: ATACAMA_TERRAIN },
  severo: { ...TERRAIN_ENVIRONMENTS.severo, terrain: ATACAMA_TERRAIN },
};

/** Stessi 5 file benchmark; l'SOS del gruppo alla Laguna Miscanti punta al Portable e al Box. */
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

export const atacama: Scenario = {
  id: "atacama",
  title: "Scenario 4 — Deserto di Atacama (distanze lunghe, fuoristrada come data mule, banda 915-928 MHz)",
  variants: VARIANTS,
  environments: ENVIRONMENTS,
  buildNodes: (variant) => buildNodes(variant as Variant),
  messages: benchmarkMessages,
  eventT: EVENT_T,
  linkPairs: [["BOX", "C1"], ["BOX", "C2"], ["BOX", "PORT"], ["BOX", "C3"], ["PORT", "C2"], ["PORT", "C3"], ["C3", "C5"], ["PORT", "C5"], ["FR", "BOX"], ["FR", "PORT"], ["FR", "C3"], ["FR", "C5"]],
  linkSnapshotVariant: "andes-relay",
  connectivityPair: ["C5", "BOX"],
  shortRangeModel: "budget",
  regulatoryProfiles: [["AU915 30 dBm EIRP, dwell 400 ms", AU915], ["EU868 g3 (confronto)", EU868_G3]],
};
