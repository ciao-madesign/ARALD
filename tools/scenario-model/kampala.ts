/**
 * Scenario 5 — Kampala (Uganda): missione umanitaria in una grande città densa,
 * costruita su colline. Il contrario degli scenari alpini e del deserto: distanze
 * brevi (3-8 km) ma ostruzione continua, centri urbani densi, tanti telefoni,
 * spostamenti lenti nel traffico (motocicli "boda-boda") e blackout elettrici.
 *
 * Costruito nel formato del futuro ARALD Network Design Tool, come gli Scenari 3-4:
 * dispositivi su latitudine/longitudine, altezza dal suolo per tipo, territorio
 * interrogabile, BLE/Wi-Fi a link budget. Novità: le antenne sul tetto vedono meno
 * clutter di quelle a terra (`clutterHeightRelief`), che in città decide dove
 * mettere il Box.
 *
 * COORDINATE E QUOTE APPROSSIMATIVE, ricostruite da conoscenza generale e NON
 * verificate su cartografia in questo ambiente. Il terreno è SINTETICO: lago
 * Vittoria a ~1135 m a sud, una pianura che sale a ~1195 m, sette-otto colline di
 * 50-100 m, un centro densissimo e una corona urbana. Anche il profilo regolatorio
 * (EU868, g1/g3) per l'Uganda NON è verificato sulla normativa locale.
 */
import type { Message, NodeSpec, Waypoint } from "./model.js";
import { KIND_DEFAULTS, type NodeKind } from "./model.js";
import { TERRAIN_ENVIRONMENTS } from "./network-config.js";
import type { Scenario } from "./scenario.js";
import { type GeoPoint, type LocalFrame, type PropagationName, type PropagationPreset, syntheticLandscape, toLocal } from "./terrain.js";

const H = 3600;

export const KAMPALA_FRAME: LocalFrame = { lat0: 0.32, lon0: 32.58 };

export const KAMPALA_PLACES = {
  kololo: { lat: 0.327, lon: 32.593 },        // sede dell'ONG, tetto di un edificio di 3 piani
  cbd: { lat: 0.3165, lon: 32.581 },           // centro d'affari (Nakasero)
  kawempe: { lat: 0.37, lon: 32.558 },         // clinica nel quartiere denso di Kawempe
  makerere: { lat: 0.334, lon: 32.5665 },
  namirembe: { lat: 0.3045, lon: 32.5575 },
  naguru: { lat: 0.333, lon: 32.613 },         // collina con un traliccio per il Fixed Relay
  bweyogerere: { lat: 0.35, lon: 32.65 },      // periferia est, sulla strada per Jinja
} satisfies Record<string, GeoPoint>;

/**
 * Condizioni di propagazione urbane, portate dal territorio (`Terrain.propagation`).
 * L'esponente di path loss è calibrato sul modello Okumura-Hata per città grandi a 868 MHz
 * (antenna del Box a 12 m, terminale a 1,5 m, 0,5-6 km) nella classe "abitato" (`urban`):
 * con esponente 3,0 il modello resta entro 5 dB da Hata (scarto da 0 a −4 dB; test in
 * `scenario-model-tool.test.ts`). NON è calibrato per le zone "abitato denso": lì il
 * modello è 8-12 dB più pessimista di Hata (15 dB di clutter contro 8), ipotesi non verificata.
 * Un esponente più alto conterebbe due volte l'effetto della città, già nel clutter agli
 * estremi. Interferenza maggiore che all'aperto (altri dispositivi ISM, gateway LoRaWAN):
 * ipotesi, non misure.
 */
const URBAN: Record<PropagationName, PropagationPreset> = {
  favorevole: { pathLossExponent: 2.6, fadeMarginDb: 8, interferenceDb: 2 },
  tipico: { pathLossExponent: 3.0, fadeMarginDb: 10, interferenceDb: 4 },
  severo: { pathLossExponent: 3.4, fadeMarginDb: 12, interferenceDb: 6 },
};

/** Lago a sud (quota 1135 m), pianura che sale a ~1195 m verso nord. */
function baseElevation(_x: number, y: number): number {
  return 1135 + Math.min(60, Math.max(0, y + 6000) * 0.01);
}

export const KAMPALA_TERRAIN = syntheticLandscape("Kampala (sintetico)", KAMPALA_FRAME, {
  baseElevation,
  cones: [
    { name: "Namirembe", center: { lat: 0.3045, lon: 32.5575 }, radiusM: 1500, summitM: 90 },
    { name: "Makerere", center: { lat: 0.334, lon: 32.5665 }, radiusM: 1400, summitM: 70 },
    { name: "Kololo", center: { lat: 0.33, lon: 32.596 }, radiusM: 1300, summitM: 70 },
    { name: "Naguru", center: KAMPALA_PLACES.naguru, radiusM: 1500, summitM: 90 },
    { name: "Nakasero", center: { lat: 0.319, lon: 32.579 }, radiusM: 1000, summitM: 60 },
    { name: "Kibuli", center: { lat: 0.295, lon: 32.595 }, radiusM: 1300, summitM: 80 },
    { name: "Muyenga", center: { lat: 0.297, lon: 32.615 }, radiusM: 1500, summitM: 100 },
  ],
  settlements: [
    { name: "Centro d'affari", center: KAMPALA_PLACES.cbd, radiusM: 1400, cover: "urban-dense" },
    { name: "Kawempe", center: KAMPALA_PLACES.kawempe, radiusM: 1200, cover: "urban-dense" },
    { name: "Katwe/Kisenyi", center: { lat: 0.3, lon: 32.57 }, radiusM: 1200, cover: "urban-dense" },
    { name: "Corona urbana", center: { lat: 0.325, lon: 32.585 }, radiusM: 9000, cover: "urban" },
  ],
  defaultLandCover: "forest",
  clutterHeightRelief: true,
  propagation: URBAN,
});

/** Altezze di installazione specifiche di questo scenario (m dal suolo). */
const HEIGHTS: Partial<Record<string, number>> = { BOX: 12, FR: 25, PORT: 6 };

function wp(g: GeoPoint, t: number, aglM: number, dxM = 0, dyM = 0): Waypoint {
  const { x, y } = toLocal(KAMPALA_FRAME, g);
  return { x: x + dxM, y: y + dyM, z: KAMPALA_TERRAIN.elevationAt(x + dxM, y + dyM) + aglM, t };
}

function phoneOf(path: Waypoint[]): Waypoint[] {
  return path.map((w) => ({ ...w, x: w.x + 3, y: w.y + 2 }));
}

export type Variant = "static" | "boda" | "naguru-relay" | "relay-boda" | "box-ground" | "relay-blackout";

export const VARIANTS: Record<Variant, string> = {
  static: "motocicli fermi, nessun relay: il Box sul tetto, il resto a terra",
  boda: "il corriere C4 in boda-boda: centro → Bweyogerere → Kawempe → Kololo (data mule nel traffico)",
  "naguru-relay": "ARALD Fixed Relay su un traliccio di 25 m a Naguru, corriere fermo",
  "relay-boda": "Fixed Relay a Naguru e corriere in servizio",
  "box-ground": "come 'naguru-relay', ma il Box è a terra (1,5 m) invece che sul tetto",
  "relay-blackout": "come 'relay-boda', ma il Box resta senza corrente a 0h15 (blackout, nessun UPS)",
};

export const EVENT_T = 0.5 * H;

export function buildNodes(variant: Variant): NodeSpec[] {
  const P = KAMPALA_PLACES;
  const relay = variant === "naguru-relay" || variant === "relay-boda" || variant === "box-ground" || variant === "relay-blackout";
  const rides = variant === "boda" || variant === "relay-boda" || variant === "relay-blackout";
  // Boda-boda nel traffico: ~15-20 km/h medi, soste di 10-15 minuti dove incontra un dispositivo.
  const c4: Waypoint[] = rides
    ? [
      wp(P.cbd, 0, 1.2, 40, 0), wp(P.cbd, 0.75 * H, 1.2, 40, 0),
      wp(P.naguru, 1.0 * H, 1.2), wp(P.bweyogerere, 1.45 * H, 1.2, 30, 0), wp(P.bweyogerere, 1.7 * H, 1.2, 30, 0),
      wp(P.naguru, 2.15 * H, 1.2), wp(P.kawempe, 2.5 * H, 1.2, 30, 0), wp(P.kawempe, 2.67 * H, 1.2, 30, 0),
      wp(P.kololo, 3.1 * H, 1.2, 20, 0),
    ]
    : [wp(P.cbd, 0, 1.2, 40, 0)];
  const c1 = [wp(P.cbd, 0, 1.2)];
  const c2 = [wp(P.makerere, 0, 1.2)];
  const c3 = [wp(P.namirembe, 0, 1.2)];
  const c5 = [wp(P.bweyogerere, 0, 1.2)];
  const nodes: NodeSpec[] = [
    { id: "BOX", kind: "box", path: [wp(P.kololo, 0, variant === "box-ground" ? 1.5 : HEIGHTS.BOX!)], offFrom: variant === "relay-blackout" ? 0.25 * H : undefined },
    { id: "PORT", kind: "portable", path: [wp(P.kawempe, 0, HEIGHTS.PORT!)] },
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
  if (relay) nodes.push({ id: "FR", kind: "relay", path: [wp(P.naguru, 0, HEIGHTS.FR!)] });
  // La quota segue il terreno lungo le traiettorie (nodePosition in model.ts).
  for (const n of nodes) {
    n.heightAglM = n.id === "BOX" && variant === "box-ground" ? 1.5 : HEIGHTS[n.id] ?? KIND_DEFAULTS[n.kind as NodeKind].heightAglM;
  }
  return nodes;
}

export const ENVIRONMENTS = {
  favorevole: { ...TERRAIN_ENVIRONMENTS.favorevole, ...URBAN.favorevole, terrain: KAMPALA_TERRAIN },
  tipico: { ...TERRAIN_ENVIRONMENTS.tipico, ...URBAN.tipico, terrain: KAMPALA_TERRAIN },
  severo: { ...TERRAIN_ENVIRONMENTS.severo, ...URBAN.severo, terrain: KAMPALA_TERRAIN },
};

/** Stessi 5 file benchmark; l'SOS dell'operatore a Bweyogerere punta alla clinica (Portable) e alla sede (Box). */
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

export const kampala: Scenario = {
  id: "kampala",
  title: "Scenario 5 — Kampala (città densa su colline, blackout, corriere in boda-boda)",
  variants: VARIANTS,
  environments: ENVIRONMENTS,
  buildNodes: (variant) => buildNodes(variant as Variant),
  messages: benchmarkMessages,
  eventT: EVENT_T,
  linkPairs: [["BOX", "C1"], ["BOX", "C2"], ["BOX", "C3"], ["BOX", "PORT"], ["BOX", "C5"], ["C1", "C2"], ["PORT", "C2"], ["FR", "BOX"], ["FR", "PORT"], ["FR", "C1"], ["FR", "C5"]],
  linkSnapshotVariant: "naguru-relay",
  connectivityPair: ["C5", "BOX"],
  coverageCellM: 250,
  shortRangeModel: "budget",
};
