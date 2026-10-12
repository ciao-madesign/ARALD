/**
 * Pagina del ARALD Network Design Tool (browser). Solo interfaccia: ogni numero viene dal
 * motore di `tools/scenario-model/` (assessNetwork, coverageGrid, prepareResilience, ...).
 * Docs: docs/network-design-tool.md, docs/network-resilience.md.
 */
import { type CoverageGrid, type LinkAssessment, coverageGrid, qualityLabel } from "../scenario-model/assess.js";
import { KIND_DEFAULTS, type Medium, type ModelParams, type NodeKind, type NodeSpec } from "../scenario-model/model.js";
import { type NetworkConfig, assessNetwork, paramsForConfig, parseNetworkConfig, placeDevices } from "../scenario-model/network-config.js";
import { type FailureReport, type ResilienceContext, type ResilienceScore, evaluateFailure, prepareResilience, resilienceScore } from "../scenario-model/resilience.js";
import { PACK_ID_PATTERN, PackTerrain, packOffset } from "../scenario-model/terrain-pack.js";
import { FLAT_TERRAIN, type LandCover, type Terrain, toGeo, toLocal } from "../scenario-model/terrain.js";
import { TERRAINS } from "../scenario-model/terrains.js";
import atacama from "../scenario-model/examples/atacama.json";
import eolie from "../scenario-model/examples/eolie.json";
import eolieResilienza from "../scenario-model/examples/eolie-resilienza.json";
import eolieReale from "../scenario-model/examples/eolie-resilienza-reale.json";
import kampala from "../scenario-model/examples/kampala.json";
import valleMairaReale from "../scenario-model/examples/valle-maira-reale.json";
import {
  COVER_LABEL, KIND_LABEL, type View, addDevice, devicesOutside, duplicateDevice, fitView, fmtDistance, fmtRate, groundAt, groundWarnings, haloCellM, moveDevice,
  qualityColor, removeDevice, screenToWorld, setDeviceRoute, updateDevice, viewBounds, worldToScreen, zoomAt,
} from "./logic.js";
import { Editor, type MoveToken } from "./editor.js";
import { type RouteDraft, SPEED_PRESETS, buildRoute, fmtClock, routeLengthM, routeToDraft, sameRoute, stopTimes } from "./route.js";
import { PackLibrary } from "./packs.js";

// ---------------------------------------------------------------- esempi

const BLANK: unknown = { version: 1, name: "Nuova rete (terreno piatto)", frame: { lat0: 44.4, lon0: 7.0 }, environment: "tipico", regulatory: "g3", devices: [] };
const PRESETS: { id: string; label: string; raw: unknown; real?: boolean }[] = [
  { id: "eolie-reale", label: "Eolie con aliscafo — terreno reale", raw: eolieReale, real: true },
  { id: "valle-maira-reale", label: "Alta Valle Maira — terreno reale", raw: valleMairaReale, real: true },
  { id: "eolie-resilienza", label: "Eolie con aliscafo — terreno sintetico", raw: eolieResilienza },
  { id: "eolie", label: "Isole Eolie — terreno sintetico", raw: eolie },
  { id: "atacama", label: "Deserto di Atacama — sintetico", raw: atacama },
  { id: "kampala", label: "Kampala — sintetico", raw: kampala },
  { id: "blank", label: "Rete vuota su terreno piatto", raw: BLANK },
];

// ---------------------------------------------------------------- stato

type Tool = "select" | "add" | "area" | "route";
type Tab = "rete" | "resilienza";
type Halo = Medium | "none";
interface FailArea { x: number; y: number; r: number }

let cfg: NetworkConfig;
let terrain: Terrain;
let view: View = { cx: 0, cy: 0, mPerPx: 100, w: 800, h: 600 };
let selected: string | null = null;
let tool: Tool = "select";
let addKind: NodeKind = "card";
let tab: Tab = "rete";
let halo: Halo = "lora";
const failed = new Set<string>();
let areas: FailArea[] = [];
let areaRadiusM = 3000;
const PALETTE_KINDS: NodeKind[] = ["box", "portable", "relay", "card", "phone"];
const DRAG_MIME = "application/x-arald-kind";
const editor = new Editor<NetworkConfig>(100);
/** Percorso in corso di disegno per un dispositivo (le tappe si aggiungono con clic sulla mappa). */
let routeDraft: { id: string; draft: RouteDraft; error: string } | null = null;

// mappe reali: biblioteca dei pacchetti (assente se la pagina è aperta senza server, o il catalogo non si scarica)
let library: PackLibrary | null = null;
let libraryNote = "";
let terrainMaxM = 0; // quota massima del terreno reale, per la scala di colore
let loadToken = 0;
let baseNotice = ""; // avviso permanente (mappe reali non disponibili); i messaggi di caricamento lo sostituiscono per un po'
let currentPreset = "";

// calcoli in cache, invalidati quando cambia la rete
let nodes: NodeSpec[] = [];
let params: ModelParams;
let links: LinkAssessment[] = [];
let resCtx: ResilienceContext | null = null;
let resScore: ResilienceScore | null = null;
let resBusy = false;
let resError = "";
let report: FailureReport | null = null;
let haloGrid: { key: string; grid: CoverageGrid; bbox: { minX: number; minY: number; maxX: number; maxY: number }; mPerPx: number; cells: { x: number; y: number; quality: number }[] } | null = null;
let haloToken = 0;
let haloBusy = false;

// ---------------------------------------------------------------- utilità DOM

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const k of kids) el.append(k);
  return el;
}
const pct = (x: number): string => `${Math.round(100 * x)}%`;
const TECH_LABEL: Record<Medium, string> = { lora: "LoRa", ble: "BLE", wifi: "Wi-Fi" };

// ---------------------------------------------------------------- tavolozza (da variabili CSS, segue il tema)

interface Palette { [k: string]: string }
let palette: Palette = {};
let themeKey = "";
const paletteRgb: Record<string, [number, number, number]> = {};

/** Colore CSS ("#rgb", "#rrggbb" o "rgb(r, g, b)") in componenti 0-255; grigio se non si riconosce. */
function parseRgb(css: string): [number, number, number] {
  const t = css.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if (hex) {
    const h6 = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    const n = parseInt(h6, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(t);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [128, 128, 128];
}

function readPalette(): void {
  const cs = getComputedStyle(document.documentElement);
  const names = ["bg", "surface", "fg", "muted", "line", "accent", "good", "warn", "bad", "land-sea", "land-open", "land-forest", "land-urban", "land-urban-dense", "land-high", "nodata"];
  palette = Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(`--${n}`).trim()]));
  for (const n of names) paletteRgb[n] = parseRgb(palette[n]);
  themeKey = `${document.documentElement.dataset.theme ?? ""}|${palette.bg}`;
}

// ---------------------------------------------------------------- caricamento di una configurazione

/** Terreno di una configurazione: sintetico, piatto, o reale da un pacchetto ("pack:<id>", scaricato se serve). */
async function resolveTerrain(c: NetworkConfig): Promise<Terrain> {
  if (c.terrain === undefined) return FLAT_TERRAIN;
  if (c.terrain.startsWith("pack:")) {
    const id = c.terrain.slice("pack:".length);
    if (!PACK_ID_PATTERN.test(id)) throw new Error(`Riferimento di terreno non valido: ${JSON.stringify(c.terrain)}`);
    if (!library) throw new Error(`Le mappe reali non sono disponibili: ${libraryNote || "nessun catalogo caricato"}`);
    const pack = await library.load(id);
    return new PackTerrain(pack, packOffset(pack, c.frame));
  }
  if (Object.hasOwn(TERRAINS, c.terrain)) return TERRAINS[c.terrain];
  throw new Error(`Territorio sconosciuto: ${c.terrain}`);
}

/**
 * Carica una configurazione (anche con terreno da scaricare). Restituisce "applied" se la rete è stata
 * applicata, "superseded" se nel frattempo è partito un altro caricamento (nessun effetto, nessun errore
 * da mostrare); un errore del caricamento corrente viene rilanciato.
 */
async function loadConfig(raw: unknown): Promise<"applied" | "superseded"> {
  const next = parseNetworkConfig(raw);
  const token = ++loadToken;
  const needsDownload = next.terrain?.startsWith("pack:") === true;
  setNotice(needsDownload ? "Carico la mappa…" : baseNotice);
  let t: Terrain;
  try {
    t = await resolveTerrain(next);
  } catch (e) {
    if (token !== loadToken) return "superseded";
    setNotice(baseNotice);
    throw e;
  }
  if (token !== loadToken) return "superseded"; // nel frattempo ne è stata scelta un'altra
  setNotice(baseNotice);
  applyConfig(next, t);
  return "applied";
}

/** Applica una configurazione con il suo terreno. Atomico: se il calcolo fallisce si torna alla rete precedente. */
function applyConfig(next: NetworkConfig, t: Terrain): void {
  const prev = cfg ? { cfg, terrain } : null;
  try {
    cfg = next;
    terrain = t;
    recompute();
  } catch (e) {
    if (prev) { cfg = prev.cfg; terrain = prev.terrain; recompute(); }
    throw e;
  }
  editor.reset();
  routeDraft = null;
  if (tool === "route") tool = "select";
  terrainMaxM = 0;
  if (terrain instanceof PackTerrain) for (const v of terrain.pack.elevation) if (v > terrainMaxM) terrainMaxM = v;
  selected = next.devices.find((d) => d.kind === "box")?.id ?? next.devices[0]?.id ?? null;
  failed.clear();
  areas = [];
  haloGrid = null;
  $<HTMLSelectElement>("env").value = cfg.environment;
  $<HTMLSelectElement>("reg").value = cfg.regulatory;
  view = fitView(nodes.flatMap((n) => n.path.map((w) => ({ x: w.x, y: w.y }))), view.w, view.h, 0.18, 6000);
  bg = null;
  renderAttribution();
  refreshAll();
}

/** Messaggio di stato sotto l'intestazione (caricamenti, mappe reali non disponibili). */
function setNotice(text: string): void {
  const el = $("notice");
  el.textContent = text;
  el.hidden = text === "";
}

function renderAttribution(): void {
  const el = $("attribution");
  if (terrain instanceof PackTerrain) {
    el.textContent = `Terreno reale: ${terrain.name}. ${terrain.pack.header.attribution}`;
    el.title = el.textContent;
  } else {
    el.textContent = "Terreno sintetico di esempio, non rilevato.";
    el.title = "";
  }
}

/** Ricalcola ciò che dipende dalla rete (collegamenti); la resilienza viene rifatta solo se serve. */
function recompute(): void {
  nodes = placeDevices(cfg, terrain);
  params = paramsForConfig(cfg, terrain);
  links = assessNetwork(cfg, terrain);
  // niente riferimenti a dispositivi che non esistono più (rimossi o sostituiti)
  const ids = new Set(cfg.devices.map((d) => d.id));
  for (const id of [...failed]) if (!ids.has(id)) failed.delete(id);
  if (selected && !ids.has(selected)) selected = null;
  resCtx = null;
  resScore = null;
  report = null;
  resError = "";
  haloGrid = null;
}

/**
 * Applica una modifica alla rete registrando lo stato precedente per annulla/ripeti. Una modifica che arriva
 * mentre si disegna un percorso (copia, rimozione, ambiente…) lo interrompe: la bozza non descriverebbe più la rete.
 */
function commit(next: NetworkConfig): void {
  if (next === cfg) return;
  if (routeDraft) { routeDraft = null; if (tool === "route") tool = "select"; }
  cfg = editor.commit(cfg, next);
  recompute();
  refreshAll();
}

/** Dopo un annulla/ripeti: la bozza di percorso non vale più, e i selettori seguono la rete ripristinata. */
function afterHistory(): void {
  routeDraft = null;
  if (tool === "route") tool = "select";
  $<HTMLSelectElement>("env").value = cfg.environment;
  $<HTMLSelectElement>("reg").value = cfg.regulatory;
  recompute();
  refreshAll();
}

function undo(): void {
  if (!cfg || !editor.canUndo) return;
  cfg = editor.undo(cfg);
  afterHistory();
}

function redo(): void {
  if (!cfg || !editor.canRedo) return;
  cfg = editor.redo(cfg);
  afterHistory();
}

function placeDevice(kind: NodeKind, x: number, y: number): void {
  const res = addDevice(cfg, kind, x, y);
  selected = res.id;
  commit(res.cfg);
}

function deleteSelected(): void {
  if (!selected) return;
  failed.delete(selected);
  const id = selected;
  selected = null;
  commit(removeDevice(cfg, id));
}

function selectDevice(id: string | null): void {
  if (routeDraft && routeDraft.id !== id) cancelRoute();
  selected = id;
  renderPanel();
  scheduleHalo();
  draw();
}

// ---- percorsi: disegno di un percorso per un dispositivo

function startRoute(id: string): void {
  const dev = cfg.devices.find((d) => d.id === id);
  const at = posOf(id);
  if (!dev || !at) return;
  const draft: RouteDraft = dev.route ? routeToDraft(dev.route, cfg.frame) : { start: { x: at.x, y: at.y }, stops: [], speedKmh: SPEED_PRESETS[0].kmh, startDelayMin: 0 };
  routeDraft = { id, draft, error: "" };
  tool = "route";
  renderToolbar();
  renderPanel();
  draw();
}

function cancelRoute(): void {
  routeDraft = null;
  if (tool === "route") tool = "select";
  renderToolbar();
  renderPanel();
  draw();
}

function finishRoute(): void {
  if (!routeDraft) return;
  const { id, draft } = routeDraft;
  let route: ReturnType<typeof buildRoute>;
  try {
    route = buildRoute(draft, cfg.frame);
  } catch (e) {
    routeDraft.error = (e as Error).message;
    renderPanel();
    return;
  }
  const dev = cfg.devices.find((d) => d.id === id);
  routeDraft = null;
  if (tool === "route") tool = "select";
  if (!dev) { refreshAll(); return; } // il dispositivo non esiste più
  if (sameRoute(dev.route, route)) { refreshAll(); return; } // "Fine" senza cambiare nulla: nessun passo nello storico
  commit(setDeviceRoute(cfg, id, route));
}

function addRouteStop(x: number, y: number): void {
  if (!routeDraft) return;
  routeDraft.draft.stops.push({ x, y, pauseMin: 0 });
  routeDraft.error = "";
  renderPanel();
  draw();
}

function posOf(id: string): { x: number; y: number } | null {
  const n = nodes.find((q) => q.id === id);
  return n ? { x: n.path[0].x, y: n.path[0].y } : null;
}

// ---------------------------------------------------------------- resilienza

function ensureResilience(): void {
  if (resCtx || resBusy) return;
  resBusy = true;
  resError = "";
  renderPanel();
  setTimeout(() => {
    try {
      resCtx = prepareResilience({ params, nodes, atS: 0, frame: cfg.frame });
      resScore = resilienceScore(resCtx);
      evaluateCurrentFailure();
    } catch (e) {
      resError = (e as Error).message;
    }
    resBusy = false;
    renderPanel();
    draw();
  }, 20);
}

function evaluateCurrentFailure(): void {
  if (!resCtx || (failed.size === 0 && areas.length === 0)) { report = null; return; }
  try {
    report = evaluateFailure(resCtx, {
      nodes: [...failed],
      areas: areas.map((a) => ({ shape: { kind: "circle" as const, center: { x: a.x, y: a.y }, radiusM: a.r } })),
    });
  } catch (e) {
    report = null;
    resError = (e as Error).message;
  }
}

function failureChanged(): void {
  if (tab === "resilienza") {
    if (resCtx) evaluateCurrentFailure();
    else ensureResilience();
  }
  renderPanel();
  draw();
}

// ---------------------------------------------------------------- alone di copertura

/** Identifica ciò da cui dipende l'alone, esclusa la vista (l'alone LoRa copre un riquadro più largo dello schermo). */
function haloKey(): string {
  const n = nodes.find((q) => q.id === selected);
  if (!n || halo === "none") return "";
  return [selected, halo, n.path[0].x.toFixed(0), n.path[0].y.toFixed(0), n.heightAglM ?? "", cfg.environment, cfg.regulatory, cfg.devices.length, view.w, view.h].join("|");
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };
function contains(outer: Box, inner: Box): boolean {
  return outer.minX <= inner.minX && outer.minY <= inner.minY && outer.maxX >= inner.maxX && outer.maxY >= inner.maxY;
}

/** L'alone calcolato vale ancora per la vista attuale (stessa scala, schermo dentro il riquadro calcolato). */
function haloValid(): boolean {
  if (!haloGrid || haloGrid.key !== haloKey()) return false;
  if (haloGrid.mPerPx !== view.mPerPx) return false;
  return halo !== "lora" || contains(haloGrid.bbox, viewBounds(view));
}

function scheduleHalo(): void {
  const key = haloKey();
  if (!key) { haloGrid = null; return; }
  if (haloValid()) return;
  const token = ++haloToken;
  haloBusy = true;
  setTimeout(() => {
    if (token !== haloToken) return;
    const n = nodes.find((q) => q.id === selected);
    if (!n || halo === "none") { haloBusy = false; return; }
    const pos = n.path[0];
    const vb = viewBounds(view);
    let bbox: Box;
    let cellM: number;
    if (halo === "lora") {
      // riquadro un quarto più largo dello schermo per lato: durante un trascinamento l'alone non sparisce
      const px = 0.25 * (vb.maxX - vb.minX);
      const py = 0.25 * (vb.maxY - vb.minY);
      bbox = { minX: vb.minX - px, maxX: vb.maxX + px, minY: vb.minY - py, maxY: vb.maxY + py };
      cellM = haloCellM(view);
    } else {
      // BLE e Wi-Fi hanno poche decine/centinaia di metri di portata: riquadro attorno al dispositivo,
      // celle non più piccole di ~3 pixel e al massimo ~3600 celle
      const reach = halo === "wifi" ? 400 : 600;
      bbox = { minX: pos.x - reach, maxX: pos.x + reach, minY: pos.y - reach, maxY: pos.y + reach };
      cellM = Math.max(10, Math.ceil((view.mPerPx * 3) / 10) * 10);
      while ((2 * reach / cellM) ** 2 > 3600) cellM += 10;
    }
    if (!KIND_DEFAULTS[n.kind].caps[halo]) {
      haloGrid = null;
    } else {
      const grid = coverageGrid(n, pos, halo, params, bbox, cellM);
      const real = terrain instanceof PackTerrain ? terrain : null;
      // celle raggiunte, senza quelle fuori dall'area dei dati (là non c'è terreno: l'alone non avrebbe senso)
      const cells = grid.cells.filter((c) => c.possible && (!real || real.contains(c.x, c.y)));
      haloGrid = { key, grid, bbox, mPerPx: view.mPerPx, cells };
    }
    haloBusy = false;
    if (token === haloToken) { draw(); renderStatus(); }
  }, 30);
}

// ---------------------------------------------------------------- disegno

const canvas = $<HTMLCanvasElement>("map");
const g = canvas.getContext("2d")!;
let bg: { canvas: HTMLCanvasElement; view: View; theme: string; fine: boolean } | null = null;
let bgTimer = 0;
let dpr = 1;

const COVER_KEY: Record<LandCover, string> = { sea: "land-sea", open: "land-open", forest: "land-forest", urban: "land-urban", "urban-dense": "land-urban-dense" };

const BG_PAD = 0.25; // lo sfondo è un quarto più largo dello schermo per lato: durante un trascinamento non restano bordi vuoti

// luce da nord-ovest, un po' alta sull'orizzonte
const LIGHT = (() => { const l = [-0.5, 0.6, 0.62]; const n = Math.hypot(l[0], l[1], l[2]); return l.map((v) => v / n); })();

function mix(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Sfondo: un solo passaggio sui blocchi di pixel, con una sola lettura della quota per blocco (reticolo di
 * quote, le pendenze si leggono dai vicini) e scrittura diretta dei pixel. Su terreno reale: suolo + tinta
 * per quota + rilievo ombreggiato; fuori dall'area dei dati una tinta neutra a scacchi, mai il mare.
 */
function renderBackground(fine: boolean): void {
  const real = terrain instanceof PackTerrain ? terrain : null;
  const block = fine ? (real ? 3 : 6) : 10;
  const ox = view.w * BG_PAD;
  const oy = view.h * BG_PAD;
  const W = Math.ceil(view.w * (1 + 2 * BG_PAD));
  const H = Math.ceil(view.h * (1 + 2 * BG_PAD));
  const nx = Math.ceil(W / block);
  const ny = Math.ceil(H / block);
  const stride = nx + 2;
  const d = view.mPerPx * block; // distanza tra due blocchi vicini, in metri
  const wx = (i: number): number => view.cx + (i * block + block / 2 - ox - view.w / 2) * view.mPerPx;
  const wy = (j: number): number => view.cy - (j * block + block / 2 - oy - view.h / 2) * view.mPerPx;
  const E = new Float32Array(stride * (ny + 2));
  for (let j = -1; j <= ny; j++) for (let i = -1; i <= nx; i++) E[(j + 1) * stride + i + 1] = terrain.elevationAt(wx(i), wy(j));

  const img = new ImageData(W, H);
  const px = img.data;
  const high = paletteRgb["land-high"];
  const nodata = paletteRgb["nodata"];
  const nodataAlt = mix(nodata, paletteRgb["bg"], 0.35);
  const k = 0.9; // esagerazione verticale (le pendenze alpine sono già ripide)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = wx(i);
      const y = wy(j);
      let rgb: readonly number[];
      if (real && !real.contains(x, y)) {
        rgb = ((i + j) & 1) === 0 ? nodata : nodataAlt;
      } else {
        const cover = terrain.landCoverAt(x, y);
        rgb = paletteRgb[COVER_KEY[cover]] ?? paletteRgb["land-open"];
        if (cover !== "sea") {
          const c = (j + 1) * stride + i + 1;
          const e = E[c];
          let lightening = 0; // > 0 schiarisce verso il bianco, < 0 scurisce verso il nero
          if (real) {
            if (terrainMaxM > 0) rgb = mix(rgb, high, 0.38 * Math.min(1, Math.max(0, e) / terrainMaxM) ** 1.4);
            const dzdx = (E[c + 1] - E[c - 1]) / (2 * d);
            const dzdy = (E[c - stride] - E[c + stride]) / (2 * d); // nord meno sud
            const len = Math.hypot(k * dzdx, k * dzdy, 1);
            const shade = (-k * dzdx * LIGHT[0] - k * dzdy * LIGHT[1] + LIGHT[2]) / len - LIGHT[2];
            if (shade > 0.01) lightening = Math.min(0.3, shade * 0.9);
            else if (shade < -0.01) lightening = -Math.min(0.42, -shade * 1.1);
          } else {
            // ombreggiatura: pendenza verso nord-ovest più chiara, opposta più scura
            const slope = (E[c + stride + 1] - e) / d;
            const shade = Math.max(-0.35, Math.min(0.35, slope * 1.2));
            if (Math.abs(shade) > 0.02) lightening = -shade * 0.45;
          }
          if (lightening > 0) rgb = mix(rgb, [255, 255, 255], lightening);
          else if (lightening < 0) rgb = mix(rgb, [0, 0, 0], -lightening);
        }
      }
      const r = Math.round(rgb[0]);
      const gg = Math.round(rgb[1]);
      const bl = Math.round(rgb[2]);
      const y1 = Math.min(H, (j + 1) * block);
      const x1 = Math.min(W, (i + 1) * block);
      for (let yy = j * block; yy < y1; yy++) {
        let o = (yy * W + i * block) * 4;
        for (let xx = i * block; xx < x1; xx++) { px[o] = r; px[o + 1] = gg; px[o + 2] = bl; px[o + 3] = 255; o += 4; }
      }
    }
  }
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  c.getContext("2d")!.putImageData(img, 0, 0);
  bg = { canvas: c, view: { ...view }, theme: themeKey, fine };
}

function drawBackground(): void {
  const fresh = bg && bg.theme === themeKey && bg.view.mPerPx === view.mPerPx && bg.view.w === view.w && bg.view.h === view.h;
  if (!fresh) renderBackground(false);
  if (bg) {
    const o = worldToScreen(view, bg.view.cx, bg.view.cy);
    g.fillStyle = palette["land-sea"];
    g.fillRect(0, 0, view.w, view.h);
    g.drawImage(bg.canvas, o.x - bg.canvas.width / 2, o.y - bg.canvas.height / 2);
  }
  if (!bg?.fine || bg.view.cx !== view.cx || bg.view.cy !== view.cy) {
    clearTimeout(bgTimer);
    bgTimer = window.setTimeout(() => { renderBackground(true); draw(); }, 140);
  }
}

let cellLayer: HTMLCanvasElement | null = null;

/**
 * Disegna uno strato di celle colorate con trasparenza uniforme: le celle vanno prima su un livello
 * opaco (riusato tra un disegno e l'altro) e poi il livello viene composto una volta, così i bordi tra
 * celle vicine non si sovrappongono (con una trasparenza per cella apparirebbe un reticolo).
 */
function drawCells(cells: { x: number; y: number }[], cellM: number, color: (i: number) => string, alpha: number): void {
  if (!cellLayer) cellLayer = document.createElement("canvas");
  const w = Math.ceil(view.w * dpr);
  const hh = Math.ceil(view.h * dpr);
  if (cellLayer.width !== w || cellLayer.height !== hh) { cellLayer.width = w; cellLayer.height = hh; }
  const lc = cellLayer.getContext("2d")!;
  lc.setTransform(dpr, 0, 0, dpr, 0, 0);
  lc.clearRect(0, 0, view.w, view.h);
  const s = Math.max(1, cellM / view.mPerPx);
  cells.forEach((c, i) => {
    const p = worldToScreen(view, c.x, c.y);
    if (p.x < -s || p.y < -s || p.x > view.w + s || p.y > view.h + s) return;
    lc.fillStyle = color(i);
    lc.fillRect(Math.floor(p.x - s / 2), Math.floor(p.y - s / 2), Math.ceil(s) + 1, Math.ceil(s) + 1);
  });
  g.globalAlpha = alpha;
  g.drawImage(cellLayer, 0, 0, view.w, view.h);
  g.globalAlpha = 1;
}

function drawKindGlyph(kind: NodeKind, x: number, y: number, r: number): void {
  g.beginPath();
  if (kind === "box") g.rect(x - r, y - r, 2 * r, 2 * r);
  else if (kind === "portable") g.roundRect(x - r, y - r, 2 * r, 2 * r, r * 0.55);
  else if (kind === "relay") { g.moveTo(x, y - r * 1.15); g.lineTo(x + r * 1.05, y + r * 0.85); g.lineTo(x - r * 1.05, y + r * 0.85); g.closePath(); }
  else if (kind === "phone") { g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); }
  else g.arc(x, y, r * 0.85, 0, Math.PI * 2);
}

function draw(): void {
  if (!cfg) return;
  if (!palette.bg) readPalette();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground();

  const hidden = new Set(report?.failed ?? [...failed]);

  // alone (un dispositivo spento non copre nulla)
  if (haloGrid && haloValid() && halo !== "none" && !(selected && hidden.has(selected))) {
    const cells = haloGrid.cells;
    drawCells(cells, haloGrid.grid.cellM, (i) => qualityColor(cells[i].quality, 50), 0.5);
  }

  // contorno dell'area dei dati reali
  if (terrain instanceof PackTerrain) {
    const b = terrain.bounds();
    const a1 = worldToScreen(view, b.minX, b.maxY);
    const a2 = worldToScreen(view, b.maxX, b.minY);
    g.setLineDash([8, 5]);
    g.strokeStyle = palette.muted;
    g.lineWidth = 1.5;
    g.strokeRect(a1.x, a1.y, a2.x - a1.x, a2.y - a1.y);
    g.setLineDash([]);
  }

  // celle di copertura perse con il guasto
  if (report && resCtx?.spec.coverage && report.lostCells.length > 0) {
    const cv = resCtx.spec.coverage;
    const cells = report.lostCells.map((i) => ({ x: cv.bbox.minX + ((i % cv.cols) + 0.5) * cv.cellM, y: cv.bbox.maxY - (Math.floor(i / cv.cols) + 0.5) * cv.cellM }));
    drawCells(cells, cv.cellM, () => palette.bad, 0.45);
  }

  // percorsi dei dispositivi mobili
  for (const d of cfg.devices) {
    if (!d.route) continue;
    g.beginPath();
    d.route.forEach((r, i) => {
      const w = toLocal(cfg.frame, r);
      const q = worldToScreen(view, w.x, w.y);
      if (i === 0) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y);
    });
    g.setLineDash([2, 5]);
    g.strokeStyle = palette.muted;
    g.lineWidth = 1.5;
    g.stroke();
    g.setLineDash([]);
  }

  // percorso in corso di disegno
  if (routeDraft) {
    const d = routeDraft.draft;
    const pts = [d.start, ...d.stops].map((q) => worldToScreen(view, q.x, q.y));
    g.beginPath();
    pts.forEach((q, i) => (i === 0 ? g.moveTo(q.x, q.y) : g.lineTo(q.x, q.y)));
    g.strokeStyle = palette.accent;
    g.lineWidth = 3;
    g.stroke();
    g.font = "600 10px 'IBM Plex Mono', ui-monospace, monospace";
    g.textAlign = "center";
    g.textBaseline = "middle";
    d.stops.forEach((stop, i) => {
      const q = pts[i + 1];
      g.beginPath();
      g.arc(q.x, q.y, 8, 0, Math.PI * 2);
      g.fillStyle = palette.accent;
      g.fill();
      if (stop.pauseMin > 0) { g.lineWidth = 2; g.strokeStyle = palette.surface; g.stroke(); }
      g.fillStyle = palette.surface;
      g.fillText(String(i + 1), q.x, q.y + 0.5);
    });
    g.textAlign = "start";
  }

  // collegamenti
  for (const l of links) {
    const a = posOf(l.a);
    const b = posOf(l.b);
    if (!a || !b || !l.best) continue;
    const pa = worldToScreen(view, a.x, a.y);
    const pb = worldToScreen(view, b.x, b.y);
    const dead = hidden.has(l.a) || hidden.has(l.b);
    g.beginPath();
    g.moveTo(pa.x, pa.y);
    g.lineTo(pb.x, pb.y);
    if (dead) { g.setLineDash([3, 5]); g.strokeStyle = palette.muted; g.globalAlpha = 0.35; g.lineWidth = 1; }
    else {
      g.setLineDash(l.best.technology === "lora" ? [] : l.best.technology === "wifi" ? [8, 4] : [2, 4]);
      g.strokeStyle = qualityColor(l.best.quality, 42);
      g.lineWidth = 1.5 + 2.5 * l.best.quality;
    }
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
  }

  // aree di guasto
  for (const a of areas) {
    const p = worldToScreen(view, a.x, a.y);
    g.beginPath();
    g.arc(p.x, p.y, a.r / view.mPerPx, 0, Math.PI * 2);
    g.fillStyle = palette.bad;
    g.globalAlpha = 0.16;
    g.fill();
    g.globalAlpha = 1;
    g.setLineDash([6, 4]);
    g.strokeStyle = palette.bad;
    g.lineWidth = 2;
    g.stroke();
    g.setLineDash([]);
  }

  // dispositivi
  for (const n of nodes) {
    const p = worldToScreen(view, n.path[0].x, n.path[0].y);
    const st = report?.states[n.id];
    const isFailed = hidden.has(n.id);
    const isSel = n.id === selected;
    const r = n.kind === "box" || n.kind === "relay" || n.kind === "portable" ? 9 : 7;
    if (st === "cut-off" || st === "isolated" || st === "recoverable") {
      g.beginPath();
      g.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
      g.lineWidth = 3;
      g.strokeStyle = st === "recoverable" ? palette.warn : palette.bad;
      g.setLineDash(st === "isolated" ? [3, 3] : []);
      g.stroke();
      g.setLineDash([]);
    }
    if (isSel) {
      g.beginPath();
      g.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      g.lineWidth = 2;
      g.strokeStyle = palette.accent;
      g.stroke();
    }
    drawKindGlyph(n.kind, p.x, p.y, r);
    g.fillStyle = isFailed ? palette.muted : palette.surface;
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = isFailed ? palette.muted : palette.fg;
    g.stroke();
    if (isFailed) {
      g.beginPath();
      g.moveTo(p.x - r, p.y - r); g.lineTo(p.x + r, p.y + r);
      g.moveTo(p.x + r, p.y - r); g.lineTo(p.x - r, p.y + r);
      g.strokeStyle = palette.bad;
      g.lineWidth = 2.5;
      g.stroke();
    }
  }
  for (const n of nodes) {
    const p = worldToScreen(view, n.path[0].x, n.path[0].y);
    const isFailed = hidden.has(n.id);
    const r = n.kind === "box" || n.kind === "relay" || n.kind === "portable" ? 9 : 7;
    {
    g.font = "600 11px 'IBM Plex Mono', ui-monospace, monospace";
    g.textBaseline = "middle";
    const tx = p.x + r + 7;
    const w = g.measureText(n.id).width;
    g.fillStyle = palette.surface;
    g.globalAlpha = 0.82;
    g.fillRect(tx - 3, p.y - 8, w + 6, 16);
    g.globalAlpha = 1;
    g.fillStyle = isFailed ? palette.muted : palette.fg;
    g.fillText(n.id, tx, p.y);
    }
  }

  // scala
  const target = 80 * view.mPerPx;
  const pow = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= target * 0.6) ?? pow;
  const px = step / view.mPerPx;
  g.fillStyle = palette.fg;
  g.fillRect(14, view.h - 20, px, 3);
  g.font = "500 11px 'IBM Plex Mono', ui-monospace, monospace";
  g.textBaseline = "alphabetic";
  g.fillStyle = palette.surface;
  g.globalAlpha = 0.85;
  g.fillRect(12, view.h - 40, 78, 16);
  g.globalAlpha = 1;
  g.fillStyle = palette.fg;
  g.fillText(fmtDistance(step), 16, view.h - 28);
}

// ---------------------------------------------------------------- pannello

function renderStatus(): void {
  const n = nodes.find((q) => q.id === selected);
  let t = `${cfg.devices.length} dispositivi · ${links.length} collegamenti`;
  if (halo !== "none" && n) {
    if (!KIND_DEFAULTS[n.kind].caps[halo]) t = `${selected} non ha ${TECH_LABEL[halo]}: nessun alone`;
    else if (haloBusy) t = `Calcolo dell'alone ${TECH_LABEL[halo]} di ${selected}…`;
    else t = `Alone ${TECH_LABEL[halo]} di ${selected}`;
  } else if (halo !== "none" && !n) t += " · seleziona un dispositivo per vedere il suo alone";
  if (tool === "add") t = `Aggiungi ${KIND_LABEL[addKind]}: fai clic sulla mappa (Esc per finire)`;
  else if (tool === "route" && routeDraft) t = `Percorso di ${routeDraft.id}: fai clic sulla mappa per aggiungere tappe (Invio = fine, Esc = annulla)`;
  else if (tool === "area") t = "Area di guasto: fai clic sulla mappa";
  $("status").textContent = t;
}

function renderPanel(): void {
  if (!cfg) return;
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  const root = $("panel-body");
  root.replaceChildren(tab === "rete" ? panelNetwork() : panelResilience());
  renderStatus();
}

function badge(q: number): HTMLElement {
  const b = h("span", { class: "q" }, qualityLabel(q));
  b.style.setProperty("--qc", qualityColor(q, 42));
  return b;
}

function deviceChips(): HTMLElement {
  const wrap = h("div", { class: "stack-s" }, h("h3", {}, "Dispositivi"));
  const chips = h("div", { class: "chips" });
  for (const d of cfg.devices) {
    const b = h("button", { type: "button", class: "chip", "aria-pressed": String(d.id === selected), title: d.label ?? KIND_LABEL[d.kind] }, d.id);
    b.addEventListener("click", () => selectDevice(d.id));
    chips.append(b);
  }
  if (cfg.devices.length === 0) chips.append(h("span", { class: "hint" }, "Nessuno: scegli un tipo da “Aggiungi” e fai clic sulla mappa, o trascinalo."));
  wrap.append(chips);
  return wrap;
}

function numberField(label: string, id: string, value: number, attrs: Record<string, string>, onChange: (v: number) => void): HTMLElement {
  // il valore mostrato è arrotondato a due decimali, quello della bozza resta esatto finché non lo modifichi
  const shown = String(Math.round(value * 100) / 100);
  const input = h("input", { type: "number", id, value: shown, "aria-label": label, ...attrs });
  input.addEventListener("change", () => { const v = Number(input.value); if (Number.isFinite(v)) onChange(v); else input.value = shown; });
  return h("label", { class: "field" }, label, input);
}

function routeEditor(): HTMLElement {
  const rd = routeDraft!;
  const d = rd.draft;
  const box = h("div", { class: "stack-s" });
  box.append(h("p", { class: "hint" }, "Fai clic sulla mappa per aggiungere le tappe. Invio termina, Esc annulla."));
  const preset = h("select", { id: "route-preset", "aria-label": "Mezzo di trasporto" });
  for (const sp of SPEED_PRESETS) preset.append(h("option", { value: String(sp.kmh) }, `${sp.label} (${sp.kmh} km/h)`));
  preset.append(h("option", { value: "custom" }, "Altra velocità"));
  preset.value = SPEED_PRESETS.some((sp) => sp.kmh === d.speedKmh) ? String(d.speedKmh) : "custom";
  preset.addEventListener("change", () => { if (preset.value !== "custom") { d.speedKmh = Number(preset.value); renderPanel(); draw(); } });
  box.append(h("label", { class: "field" }, "Mezzo", preset));
  box.append(numberField("Velocità (km/h)", "route-speed", d.speedKmh, { min: "0.1", max: "1000", step: "0.1" }, (v) => { d.speedKmh = v; renderPanel(); }));
  box.append(numberField("Parte dopo (minuti)", "route-delay", d.startDelayMin, { min: "0", max: "100000", step: "1" }, (v) => { d.startDelayMin = v; renderPanel(); }));
  if (d.stops.length > 0) {
    const times = stopTimes(d);
    const table = h("table", { class: "wp" });
    table.append(h("thead", {}, h("tr", {}, ...["Tappa", "Arrivo", "Sosta (min)", ""].map((t) => h("th", {}, t)))));
    const body = h("tbody");
    d.stops.forEach((stop, i) => {
      const pause = h("input", { type: "number", min: "0", max: "100000", step: "1", value: String(stop.pauseMin), "aria-label": `Sosta alla tappa ${i + 1} in minuti` });
      pause.addEventListener("change", () => { const v = Number(pause.value); stop.pauseMin = Number.isFinite(v) && v >= 0 ? v : 0; renderPanel(); draw(); });
      const rm = h("button", { type: "button", class: "btn small-btn", "aria-label": `Togli la tappa ${i + 1}` }, "×");
      rm.addEventListener("click", () => { d.stops.splice(i, 1); renderPanel(); draw(); });
      body.append(h("tr", {}, h("td", { class: "mono" }, String(i + 1)), h("td", { class: "mono" }, fmtClock(times[i].arriveS)), h("td", {}, pause), h("td", {}, rm)));
    });
    table.append(body);
    box.append(h("div", { class: "scroll" }, table));
    box.append(h("p", { class: "hint" }, `Lunghezza ${fmtDistance(routeLengthM(d))} · fine alle ${fmtClock(times[times.length - 1].departS)} dalla partenza (orari ipotetici, stima a velocità costante).`));
  }
  if (rd.error) box.append(h("p", { class: "error", role: "alert" }, rd.error));
  const ok = h("button", { type: "button", class: "btn", id: "route-done" }, "Fine");
  ok.disabled = d.stops.length === 0;
  ok.addEventListener("click", finishRoute);
  const cancel = h("button", { type: "button", class: "btn", id: "route-cancel" }, "Annulla");
  cancel.addEventListener("click", cancelRoute);
  box.append(h("div", { class: "row wrap" }, ok, cancel));
  return box;
}

function routeSection(id: string): HTMLElement {
  const dev = cfg.devices.find((d) => d.id === id)!;
  const box = h("div", { class: "stack-s" }, h("h3", {}, "Percorso"));
  if (routeDraft && routeDraft.id === id) { box.append(routeEditor()); return box; }
  if (dev.route) {
    const d = routeToDraft(dev.route, cfg.frame);
    box.append(h("p", { class: "ground" }, `Mobile: ${d.stops.length} tappe, ${fmtDistance(routeLengthM(d))}, ${fmtClock(dev.route[dev.route.length - 1].tS)} ore in tutto.`));
    const edit = h("button", { type: "button", class: "btn", id: "route-edit" }, "Modifica percorso");
    edit.addEventListener("click", () => startRoute(id));
    const rm = h("button", { type: "button", class: "btn", id: "route-remove" }, "Rendi fisso");
    rm.addEventListener("click", () => commit(setDeviceRoute(cfg, id, undefined)));
    box.append(h("div", { class: "row wrap" }, edit, rm));
  } else {
    box.append(h("p", { class: "hint" }, "Fisso. Disegna un percorso per farne un dispositivo mobile (barca, auto, escursionista): serve alla resilienza, per i collegamenti opportunistici."));
    const draw1 = h("button", { type: "button", class: "btn", id: "route-draw" }, "Disegna percorso");
    draw1.addEventListener("click", () => startRoute(id));
    box.append(draw1);
  }
  return box;
}

function panelNetwork(): HTMLElement {
  const box = h("div", { class: "stack" });
  box.append(deviceChips());
  const n = cfg.devices.find((d) => d.id === selected);
  if (n) {
    const kind = n.kind;
    const form = h("div", { class: "card stack-s" });
    form.append(h("div", { class: "row" }, h("strong", { class: "mono" }, n.id), h("span", { class: "muted" }, KIND_LABEL[kind])));
    if (routeDraft && routeDraft.id === n.id) {
      // mentre si disegna il percorso il resto della scheda è nascosto: una modifica lo interromperebbe
      form.append(routeSection(n.id));
      box.append(form);
      return finishPanelNetwork(box);
    }
    const kindSel = h("select", { id: "dev-kind", "aria-label": "Tipo di dispositivo" });
    for (const k of PALETTE_KINDS) kindSel.append(h("option", { value: k }, KIND_LABEL[k]));
    kindSel.value = kind;
    kindSel.addEventListener("change", () => commit(updateDevice(cfg, n.id, { kind: kindSel.value as NodeKind })));
    form.append(h("label", { class: "field" }, "Tipo", kindSel));
    const label = h("input", { type: "text", id: "dev-label", value: n.label ?? "", "aria-label": "Nome del dispositivo", placeholder: "Nome (facoltativo)", maxlength: "200" });
    label.addEventListener("change", () => commit(updateDevice(cfg, n.id, { label: label.value.trim() || undefined })));
    const agl = h("input", { type: "number", id: "dev-agl", min: "0", max: "200", step: "0.5", value: String(n.heightAglM ?? KIND_DEFAULTS[kind].heightAglM), "aria-label": "Altezza antenna in metri" });
    agl.addEventListener("change", () => { const v = Number(agl.value); if (Number.isFinite(v) && v >= 0 && v <= 200) commit(updateDevice(cfg, n.id, { heightAglM: v })); else agl.value = String(n.heightAglM ?? KIND_DEFAULTS[kind].heightAglM); });
    form.append(h("label", { class: "field" }, "Nome", label), h("label", { class: "field" }, "Altezza antenna (m)", agl));
    const at = posOf(n.id);
    if (at) {
      const gr = groundAt(terrain, at.x, at.y);
      const ant = nodes.find((q) => q.id === n.id)?.path[0].z;
      const real = terrain instanceof PackTerrain;
      if (gr.inside) form.append(h("p", { class: "ground" }, real ? `Suolo: ${COVER_LABEL[gr.cover]}, quota ${Math.round(gr.elevationM)} m` : `Suolo: ${COVER_LABEL[gr.cover]}`, ant !== undefined && real ? ` · antenna a ${Math.round(ant)} m s.l.m.` : ""));
      for (const w of groundWarnings(gr, kind, n.route !== undefined)) form.append(h("p", { class: "warn-note", role: "note" }, w));
    }
    form.append(routeSection(n.id));
    const dup = h("button", { type: "button", class: "btn", id: "dev-dup" }, "Duplica");
    dup.addEventListener("click", () => {
      const r = duplicateDevice(cfg, n.id, 40 * view.mPerPx, -40 * view.mPerPx);
      if (r) { selected = r.id; commit(r.cfg); }
    });
    const rm = h("button", { type: "button", class: "btn danger", id: "dev-remove" }, "Rimuovi");
    rm.addEventListener("click", deleteSelected);
    form.append(h("div", { class: "row wrap" }, dup, rm));
    box.append(form);
  } else {
    box.append(h("p", { class: "hint" }, "Fai clic su un dispositivo per vederne i dettagli, trascinalo per spostarlo."));
  }

  return finishPanelNetwork(box);
}

/** Parte comune della scheda «Rete»: avviso fuori area, tabella dei collegamenti, legenda. */
function finishPanelNetwork(box: HTMLElement): HTMLElement {
  const outside = devicesOutside(terrain, cfg);
  if (outside.length > 0) box.append(h("p", { class: "warn-note", role: "note" }, `Fuori dall'area dei dati reali: ${outside.join(", ")}. I risultati che li riguardano non sono affidabili (quota 0, nessun suolo).`));
  const rows = links.filter((l) => !selected || l.a === selected || l.b === selected);
  box.append(h("h3", {}, selected ? `Collegamenti di ${selected}` : "Collegamenti"));
  if (rows.length === 0) box.append(h("p", { class: "hint" }, "Nessun collegamento possibile."));
  else {
    const table = h("table", { class: "tbl" });
    table.append(h("thead", {}, h("tr", {}, ...["Collegamento", "Tecnologia", "Distanza", "Velocità", "Qualità"].map((t) => h("th", {}, t)))));
    const body = h("tbody");
    for (const l of rows.slice(0, 40)) {
      const b = l.best!;
      body.append(h("tr", {},
        h("td", { class: "mono" }, `${l.a} → ${l.b}`),
        h("td", {}, `${TECH_LABEL[b.technology]} ${b.mode ?? ""}`),
        h("td", { class: "num" }, fmtDistance(l.distanceM)),
        h("td", { class: "num" }, fmtRate(b.rateBps)),
        h("td", {}, badge(b.quality)),
      ));
    }
    table.append(body);
    box.append(h("div", { class: "scroll" }, table));
    if (rows.length > 40) box.append(h("p", { class: "hint" }, `…e altri ${rows.length - 40} collegamenti.`));
  }
  box.append(legend());
  return box;
}

function legend(): HTMLElement {
  const wrap = h("div", { class: "card stack-s" }, h("h3", {}, "Legenda"));
  const bar = h("div", { class: "qbar" });
  bar.style.background = `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((q) => qualityColor(q, 45)).join(", ")})`;
  wrap.append(bar, h("div", { class: "qbar-l" }, h("span", {}, "debole"), h("span", {}, "ottima")));
  const sw = (dash: string, text: string): HTMLElement => {
    const s = h("div", { class: "row small" });
    const line = h("span", { class: "swatch" });
    line.style.borderTop = `3px ${dash} var(--fg)`;
    s.append(line, text);
    return s;
  };
  wrap.append(sw("solid", "LoRa"), sw("dashed", "Wi-Fi"), sw("dotted", "BLE"));
  const kinds: NodeKind[] = ["box", "portable", "relay", "card", "phone"];
  wrap.append(h("p", { class: "hint" }, `Forme: ${kinds.map((k) => KIND_LABEL[k]).join(" · ")} (quadrato, quadrato arrotondato, triangolo, cerchio, rombo).`));
  wrap.append(h("p", { class: "hint" }, "Il colore e lo spessore dei collegamenti seguono la velocità stimata, su scala logaritmica."));
  return wrap;
}

const COMPONENT_LABEL: Record<string, string> = {
  coverage: "Copertura connessa",
  directConnectivity: "Connettività diretta",
  reachability: "Raggiungibilità dell'infrastruttura",
  redundancy: "Percorsi ridondanti",
  coverageUnderFailure: "Copertura dopo un guasto",
  opportunisticRecovery: "Recupero opportunistico",
};

function panelResilience(): HTMLElement {
  const box = h("div", { class: "stack" });
  if (resBusy) { box.append(h("p", { class: "hint" }, "Calcolo della resilienza…")); return box; }
  if (resError) box.append(h("p", { class: "error", role: "alert" }, `Errore: ${resError}`));
  if (!resScore || !resCtx) {
    if (!resError) box.append(h("p", { class: "hint" }, "Nessun risultato."));
    return box;
  }
  const s = resScore;
  const head = h("div", { class: "card score" });
  head.append(h("div", { class: "score-n" }, String(Math.round(s.score)), h("span", {}, " / 100")), h("div", { class: "muted small" }, "Resilience Score della rete integra"));
  box.append(head);
  const comps = h("div", { class: "stack-s" });
  for (const c of s.components) {
    const row = h("div", { class: "comp" }, h("span", {}, COMPONENT_LABEL[c.key] ?? c.key), h("span", { class: "num" }, c.value === null ? "n.d." : pct(c.value)));
    const bar = h("div", { class: "bar" });
    const fill = h("div", { class: "bar-f" });
    fill.style.width = c.value === null ? "0%" : pct(c.value);
    bar.append(fill);
    comps.append(row, bar);
  }
  box.append(h("div", { class: "card stack-s" }, comps));
  box.append(h("p", { class: "small" }, `Nodi critici: ${s.criticalNodes.length ? s.criticalNodes.join(", ") : "nessuno"}. Guasti recuperabili in modo opportunistico: ${s.recoverableGaps.length ? s.recoverableGaps.join(", ") : "nessuno"}.`));

  box.append(h("h3", {}, "Simula un guasto"));
  box.append(h("p", { class: "hint" }, "Fai clic su un dispositivo della mappa per spegnerlo. Con lo strumento “Area di guasto” fai clic sulla mappa per spegnere tutto in un cerchio."));
  const ctl = h("div", { class: "row wrap" });
  const reset = h("button", { type: "button", class: "btn" }, "Ripristina tutto");
  reset.addEventListener("click", () => { failed.clear(); areas = []; failureChanged(); });
  ctl.append(reset);
  box.append(ctl);

  if (report) box.append(reportView(report));
  else box.append(h("p", { class: "hint" }, "Nessun guasto in corso."));

  box.append(h("h3", {}, "Guasti singoli, dal più dannoso"));
  const table = h("table", { class: "tbl" });
  table.append(h("thead", {}, h("tr", {}, ...["Nodo", "Tagliati fuori", "Recuperabili", ""].map((t) => h("th", {}, t)))));
  const body = h("tbody");
  for (const f of s.singleFailures) {
    const b = h("button", { type: "button", class: "btn small-btn" }, "Simula");
    b.addEventListener("click", () => { failed.clear(); areas = []; failed.add(f.id); failureChanged(); });
    body.append(h("tr", {},
      h("td", { class: "mono" }, f.id),
      h("td", {}, f.cutOff.length ? f.cutOff.join(", ") : "—"),
      h("td", {}, f.recoverable.length ? f.recoverable.join(", ") : "—"),
      h("td", {}, b),
    ));
  }
  table.append(body);
  box.append(h("div", { class: "scroll" }, table));
  box.append(h("p", { class: "hint" }, "Il punteggio è una proposta di definizione (pesi uguali, non tarati su dati reali). Dettagli in docs/network-resilience.md."));
  return box;
}

function reportView(r: FailureReport): HTMLElement {
  const box = h("div", { class: "card stack-s" });
  box.append(h("strong", {}, r.failed.length ? `Guasto: ${r.failed.join(", ")}` : "Area di guasto: nessun dispositivo dentro"));
  const li = (label: string, value: string, tone = ""): HTMLElement => h("div", { class: `kv ${tone}` }, h("span", {}, label), h("span", { class: "num" }, value));
  box.append(
    li("Nodi attivi", `${r.nodes.activeBefore} → ${r.nodes.activeAfter}`),
    li("Connessioni", `${r.connections.before} → ${r.connections.after}`),
    li("Frammenti di rete", `${r.fragments.before} → ${r.fragments.after}`),
  );
  if (r.coverage) box.append(li("Copertura connessa", `${pct(r.coverage.connectedBefore)} → ${pct(r.coverage.connectedAfter)}`, r.coverage.connectedAfter < r.coverage.connectedBefore ? "bad" : ""));
  box.append(li("Tagliati fuori", r.cutOff.length ? r.cutOff.join(", ") : "nessuno", r.cutOff.length ? "bad" : ""));
  if (r.opportunistic) {
    box.append(li("Recuperabili (opportunistico)", r.recoverable.length ? r.recoverable.map((x) => `${x.id} (${fmtWait(x.arrivalS)})`).join(", ") : "nessuno", r.recoverable.length ? "warn" : ""));
    const lost = r.cutOff.filter((id) => !r.recoverable.some((x) => x.id === id));
    box.append(li("Senza alcun percorso", lost.length ? lost.join(", ") : "nessuno", lost.length ? "bad" : ""));
  }
  if (r.isolated.length) box.append(li("Isolati", r.isolated.join(", "), "bad"));
  if (r.dependencies.length) box.append(li("Dipendenze critiche rimaste", r.dependencies.map((d) => d.id).join(", ")));
  box.append(h("p", { class: "hint" }, "Sulla mappa: anello rosso = tagliato fuori, giallo = recuperabile, tratteggiato = isolato, rosso trasparente = copertura persa."));
  return box;
}

function fmtWait(s: number): string {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1).replace(".", ",")} h`;
}

// ---------------------------------------------------------------- barra degli strumenti

/** Piccola icona (SVG) della forma di un tipo di dispositivo, la stessa che si vede sulla mappa. */
function glyph(kind: NodeKind): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const el = (tag: string, attrs: Record<string, string>): SVGElement => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  if (kind === "box") svg.append(el("rect", { x: "2.5", y: "2.5", width: "11", height: "11" }));
  else if (kind === "portable") svg.append(el("rect", { x: "2.5", y: "2.5", width: "11", height: "11", rx: "4" }));
  else if (kind === "relay") svg.append(el("polygon", { points: "8,2 14,13.5 2,13.5" }));
  else if (kind === "phone") svg.append(el("polygon", { points: "8,2 14,8 8,14 2,8" }));
  else svg.append(el("circle", { cx: "8", cy: "8", r: "5.5" }));
  return svg;
}

function renderToolbar(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === tool)));
  document.querySelectorAll<HTMLButtonElement>("[data-halo]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.halo === halo)));
  document.querySelectorAll<HTMLButtonElement>("#palette [data-kind]").forEach((b) => b.setAttribute("aria-pressed", String(tool === "add" && b.dataset.kind === addKind)));
  $("area-wrap").hidden = tool !== "area";
  $<HTMLButtonElement>("undo").disabled = !editor.canUndo;
  $<HTMLButtonElement>("redo").disabled = !editor.canRedo;
  canvas.style.cursor = tool === "select" ? "grab" : "crosshair";
}

function refreshAll(): void {
  renderToolbar();
  if (tab === "resilienza") ensureResilience();
  renderPanel();
  scheduleHalo();
  draw();
}

// ---------------------------------------------------------------- interazione con la mappa

function hit(sx: number, sy: number): string | null {
  let best: string | null = null;
  let bd = 18;
  for (const n of nodes) {
    const p = worldToScreen(view, n.path[0].x, n.path[0].y);
    const d = Math.hypot(p.x - sx, p.y - sy);
    if (d < bd) { bd = d; best = n.id; }
  }
  return best;
}

type Drag =
  | { kind: "pan"; lastX: number; lastY: number; startX: number; startY: number; moved: boolean; clickAdds: boolean }
  | { kind: "dev"; id: string; moved: boolean; startX: number; startY: number; offX: number; offY: number; token: MoveToken<NetworkConfig> };
let drag: Drag | null = null;

canvas.addEventListener("pointerdown", (ev) => {
  if (!cfg || ev.button !== 0 || !ev.isPrimary) return; // solo il tasto principale / un dito
  canvas.setPointerCapture(ev.pointerId);
  const r = canvas.getBoundingClientRect();
  const sx = ev.clientX - r.left;
  const sy = ev.clientY - r.top;
  const id = hit(sx, sy);
  if (tool === "add") {
    const w = screenToWorld(view, sx, sy);
    placeDevice(addKind, w.x, w.y);
    return;
  }
  if (tool === "route") {
    // un clic aggiunge una tappa, un trascinamento sposta la mappa
    drag = { kind: "pan", lastX: sx, lastY: sy, startX: sx, startY: sy, moved: false, clickAdds: true };
    return;
  }
  if (tool === "area") {
    const w = screenToWorld(view, sx, sy);
    areas.push({ x: w.x, y: w.y, r: areaRadiusM });
    if (tab !== "resilienza") setTab("resilienza"); else failureChanged();
    return;
  }
  if (id) {
    const at = posOf(id)!;
    const pw = screenToWorld(view, sx, sy);
    drag = { kind: "dev", id, moved: false, startX: sx, startY: sy, offX: at.x - pw.x, offY: at.y - pw.y, token: editor.beginMove(cfg) };
    selectDevice(id);
  } else {
    drag = { kind: "pan", lastX: sx, lastY: sy, startX: sx, startY: sy, moved: false, clickAdds: false };
    canvas.style.cursor = "grabbing";
  }
});

canvas.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const r = canvas.getBoundingClientRect();
  const sx = ev.clientX - r.left;
  const sy = ev.clientY - r.top;
  if (drag.kind === "pan") {
    if (!drag.moved && Math.hypot(sx - drag.startX, sy - drag.startY) < 4) return;
    drag.moved = true;
    view = { ...view, cx: view.cx - (sx - drag.lastX) * view.mPerPx, cy: view.cy + (sy - drag.lastY) * view.mPerPx };
    drag.lastX = sx;
    drag.lastY = sy;
    draw();
  } else if (tab === "rete") {
    if (!editor.isCurrent(drag.token)) { drag = null; return; } // la rete è cambiata per un'altra via: il trascinamento non vale più
    if (!drag.moved && Math.hypot(sx - drag.startX, sy - drag.startY) < 4) return;
    drag.moved = true;
    const w = screenToWorld(view, sx, sy);
    cfg = moveDevice(cfg, drag.id, w.x + drag.offX, w.y + drag.offY);
    nodes = placeDevices(cfg, terrain);
    draw();
  }
});

function endDrag(ev: PointerEvent): void {
  const d = drag;
  drag = null;
  canvas.style.cursor = tool === "select" ? "grab" : "crosshair";
  if (!d) return;
  if (d.kind === "dev") {
    if (d.moved && tab === "rete") {
      // un trascinamento è un solo passo; se nel frattempo è cambiato altro non si registra nulla (e la rete è già quella nuova)
      editor.endMove(d.token, cfg);
      recompute();
      refreshAll();
    }
    else if (!d.moved && tab === "resilienza") {
      if (failed.has(d.id)) failed.delete(d.id); else failed.add(d.id);
      failureChanged();
    }
  } else if (d.clickAdds && !d.moved) {
    const r = canvas.getBoundingClientRect();
    const w = screenToWorld(view, ev.clientX - r.left, ev.clientY - r.top);
    addRouteStop(w.x, w.y);
  } else { scheduleHalo(); }
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
// il puntatore può andare perso senza pointerup (finestra che perde il fuoco): si conclude il trascinamento come un rilascio
canvas.addEventListener("lostpointercapture", (ev) => { if (drag) endDrag(ev); });

canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  if (ev.deltaY === 0) return; // scorrimento orizzontale: nessuno zoom
  const r = canvas.getBoundingClientRect();
  const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
  view = zoomAt(view, ev.clientX - r.left, ev.clientY - r.top, Math.exp(Math.max(-300, Math.min(300, dy)) * 0.0016));
  draw();
  clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(scheduleHalo, 250);
}, { passive: false });
let zoomTimer = 0;

window.addEventListener("keydown", (ev) => {
  const el = ev.target as HTMLElement;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return;
  if (!cfg || !$("modal").hidden) return; // con la finestra della configurazione aperta le scorciatoie non toccano la rete
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === "z") { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
  if (mod && ev.key.toLowerCase() === "y") { ev.preventDefault(); redo(); return; }
  if (ev.key === "Escape") {
    if (routeDraft) cancelRoute();
    else if (tool !== "select") { tool = "select"; renderToolbar(); renderStatus(); }
    return;
  }
  // Invio, Canc e Backspace su un pulsante o un collegamento servono al pulsante: qui solo con la mappa o la pagina in primo piano
  if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return;
  if (ev.key === "Enter" && routeDraft) { ev.preventDefault(); finishRoute(); return; }
  if ((ev.key === "Delete" || ev.key === "Backspace") && selected && tab === "rete") deleteSelected();
});

// ---------------------------------------------------------------- controlli

function setTab(t: Tab): void {
  if (routeDraft) cancelRoute();
  if (t !== "rete" && tool === "add") tool = "select";
  tab = t;
  if (t === "resilienza") ensureResilience();
  renderPanel();
  renderToolbar();
  draw();
}

function resize(): void {
  const wrap = $("map-wrap");
  const w = Math.max(200, Math.floor(wrap.clientWidth));
  const hh = Math.max(200, Math.floor(wrap.clientHeight));
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(hh * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${hh}px`;
  view = { ...view, w, h: hh };
  bg = null;
  draw();
  scheduleHalo();
}

function setupControls(): void {
  const scenario = $<HTMLSelectElement>("scenario");
  for (const p of PRESETS) {
    const o = h("option", { value: p.id }, p.label);
    if (p.real && !library) o.disabled = true;
    scenario.append(o);
  }
  scenario.addEventListener("change", () => {
    const p = PRESETS.find((q) => q.id === scenario.value);
    if (!p) return;
    loadConfig(p.raw).then((r) => { if (r === "applied") currentPreset = p.id; }, (e: Error) => {
      scenario.value = currentPreset; // torna alla rete che c'è davvero
      setNotice(`Non riesco a caricare "${p.label}": ${e.message}`);
    });
  });
  $<HTMLSelectElement>("env").addEventListener("change", (e) => { if (!cfg) return; commit({ ...cfg, environment: (e.target as HTMLSelectElement).value as NetworkConfig["environment"] }); });
  $<HTMLSelectElement>("reg").addEventListener("change", (e) => { if (!cfg) return; commit({ ...cfg, regulatory: (e.target as HTMLSelectElement).value as NetworkConfig["regulatory"] }); });
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.addEventListener("click", () => { if (routeDraft) cancelRoute(); tool = b.dataset.tool as Tool; renderToolbar(); renderStatus(); }));
  document.querySelectorAll<HTMLButtonElement>("[data-halo]").forEach((b) => b.addEventListener("click", () => { halo = b.dataset.halo as Halo; haloGrid = null; renderToolbar(); scheduleHalo(); renderStatus(); draw(); }));
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab as Tab)));
  // tavolozza: clic poi clic sulla mappa (anche da telefono), oppure trascinamento sulla mappa
  const pal = $("palette");
  for (const k of PALETTE_KINDS) {
    const b = h("button", { type: "button", class: "btn pal", draggable: "true", "data-kind": k, "aria-pressed": "false", title: `${KIND_LABEL[k]}: fai clic qui e poi sulla mappa, oppure trascinalo sulla mappa` }, glyph(k), KIND_LABEL[k]);
    b.addEventListener("click", () => {
      if (!cfg) return;
      if (tool === "add" && addKind === k) tool = "select"; else { addKind = k; tool = "add"; }
      if (routeDraft) cancelRoute();
      renderToolbar();
      renderStatus();
    });
    b.addEventListener("dragstart", (ev) => { ev.dataTransfer?.setData(DRAG_MIME, k); ev.dataTransfer?.setData("text/plain", k); if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy"; });
    pal.append(b);
  }
  canvas.addEventListener("dragover", (ev) => { if (cfg && ev.dataTransfer?.types.includes(DRAG_MIME)) { ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; } });
  canvas.addEventListener("drop", (ev) => {
    const k = ev.dataTransfer?.getData(DRAG_MIME);
    if (!cfg || !k || !PALETTE_KINDS.includes(k as NodeKind)) return;
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    const w = screenToWorld(view, ev.clientX - r.left, ev.clientY - r.top);
    if (routeDraft) cancelRoute();
    placeDevice(k as NodeKind, w.x, w.y);
  });
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  const rad = $<HTMLInputElement>("area-radius");
  rad.addEventListener("input", () => { const v = Number(rad.value); if (v > 0) areaRadiusM = v * 1000; $("area-radius-v").textContent = `${rad.value} km`; });
  $("fit").addEventListener("click", () => { if (!cfg) return; view = fitView(nodes.flatMap((n) => n.path.map((w) => ({ x: w.x, y: w.y }))), view.w, view.h, 0.18, 6000); bg = null; scheduleHalo(); draw(); });

  // configurazione salvabile: testo, non file scaricato (nell'anteprima il download è bloccato)
  const modal = $("modal");
  const text = $<HTMLTextAreaElement>("cfg-text");
  const msg = $("cfg-msg");
  $("cfg-open").addEventListener("click", () => { text.value = JSON.stringify(cfg, null, 2); msg.textContent = ""; modal.hidden = false; text.focus(); });
  $("cfg-close").addEventListener("click", () => { modal.hidden = true; });
  $("cfg-apply").addEventListener("click", () => {
    let raw: unknown;
    try { raw = JSON.parse(text.value); } catch (e) { msg.textContent = `Configurazione non valida: ${(e as Error).message}`; return; }
    msg.textContent = "Carico…";
    loadConfig(raw).then((r) => {
      if (r === "applied") { msg.textContent = ""; modal.hidden = true; scenario.value = ""; currentPreset = ""; }
      else msg.textContent = "Nel frattempo è stato scelto un altro scenario: la configurazione non è stata applicata. Premi di nuovo Applica.";
    }, (e: Error) => { msg.textContent = `Configurazione non valida: ${e.message}`; });
  });
  $("cfg-copy").addEventListener("click", () => {
    navigator.clipboard.writeText(text.value).then(() => { msg.textContent = "Copiato."; }, () => { text.select(); msg.textContent = "Copia non consentita qui: il testo è selezionato, usa Ctrl+C."; });
  });
  $<HTMLInputElement>("cfg-file").addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    f.text().then((t) => { text.value = t; msg.textContent = "File letto: premi “Applica”."; }, () => { msg.textContent = "File non leggibile."; });
  });

  const info = $("cursor-info");
  canvas.addEventListener("pointermove", (ev) => {
    if (!cfg || drag) return;
    const r = canvas.getBoundingClientRect();
    const w = screenToWorld(view, ev.clientX - r.left, ev.clientY - r.top);
    const geo = toGeo(cfg.frame, w);
    const gr = groundAt(terrain, w.x, w.y);
    const real = terrain instanceof PackTerrain;
    info.textContent = `${geo.lat.toFixed(4)}°, ${geo.lon.toFixed(4)}°` + (real ? (gr.inside ? ` · ${Math.round(gr.elevationM)} m · ${COVER_LABEL[gr.cover]}` : " · fuori dai dati") : "");
  });
  canvas.addEventListener("pointerleave", () => { info.textContent = ""; });

  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onTheme = (): void => { readPalette(); bg = null; draw(); };
  mq.addEventListener("change", onTheme);
  new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  new ResizeObserver(resize).observe($("map-wrap"));
}

// ---------------------------------------------------------------- avvio

readPalette();

/** Cerca il catalogo delle mappe reali accanto alla pagina (cartella data/). Fallisce senza server (file://) o se manca. */
async function initLibrary(): Promise<void> {
  const lib = new PackLibrary("data/");
  try {
    await lib.catalog();
    library = lib;
  } catch (e) {
    library = null;
    libraryNote = location.protocol === "file:"
      ? "la pagina è aperta da file: apri la pagina con npm run design-tool:serve"
      : (e as Error).message;
  }
}

async function start(): Promise<void> {
  await initLibrary();
  if (!library) baseNotice = `Mappe reali non disponibili: ${libraryNote}. Restano gli esempi con terreno sintetico.`;
  setNotice(baseNotice);
  setupControls();
  resize();
  const first = library ? PRESETS[0] : PRESETS.find((p) => !p.real)!;
  try {
    await loadConfig(first.raw);
    currentPreset = first.id;
  } catch (e) {
    // la rete di partenza non si carica (es. area non scaricabile): si parte da una rete vuota, che funziona sempre
    setNotice(`Non riesco a caricare "${first.label}": ${(e as Error).message}. Parto da una rete vuota.`);
    const blank = PRESETS.find((p) => p.id === "blank")!;
    try { await loadConfig(blank.raw); currentPreset = blank.id; } catch { /* resta senza rete: ogni gestore controlla che esista */ }
  }
  $<HTMLSelectElement>("scenario").value = currentPreset;
}

void start();
