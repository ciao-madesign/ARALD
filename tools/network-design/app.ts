/**
 * Pagina del ARALD Network Design Tool (browser). Solo interfaccia: ogni numero viene dal
 * motore di `tools/scenario-model/` (assessNetwork, coverageGrid, prepareResilience, ...).
 * Docs: docs/network-design-tool.md, docs/network-resilience.md.
 */
import { type CoverageGrid, type LinkAssessment, coverageGrid, qualityLabel } from "../scenario-model/assess.js";
import { KIND_DEFAULTS, type Medium, type ModelParams, type NodeKind, type NodeSpec } from "../scenario-model/model.js";
import { type NetworkConfig, assessNetwork, paramsForConfig, parseNetworkConfig, placeDevices } from "../scenario-model/network-config.js";
import { type FailureReport, type ResilienceContext, type ResilienceScore, evaluateFailure, prepareResilience, resilienceScore } from "../scenario-model/resilience.js";
import { FLAT_TERRAIN, type LandCover, type Terrain, toLocal } from "../scenario-model/terrain.js";
import { TERRAINS } from "../scenario-model/terrains.js";
import atacama from "../scenario-model/examples/atacama.json";
import eolie from "../scenario-model/examples/eolie.json";
import eolieResilienza from "../scenario-model/examples/eolie-resilienza.json";
import kampala from "../scenario-model/examples/kampala.json";
import {
  KIND_LABEL, type View, addDevice, fitView, fmtDistance, fmtRate, haloCellM, moveDevice, qualityColor, removeDevice,
  screenToWorld, viewBounds, worldToScreen, zoomAt,
} from "./logic.js";

// ---------------------------------------------------------------- esempi

const BLANK: unknown = { version: 1, name: "Nuova rete (terreno piatto)", frame: { lat0: 44.4, lon0: 7.0 }, environment: "tipico", regulatory: "g3", devices: [] };
const PRESETS: { id: string; label: string; raw: unknown }[] = [
  { id: "eolie-resilienza", label: "Eolie con aliscafo (esempio di resilienza)", raw: eolieResilienza },
  { id: "eolie", label: "Isole Eolie", raw: eolie },
  { id: "atacama", label: "Deserto di Atacama", raw: atacama },
  { id: "kampala", label: "Kampala", raw: kampala },
  { id: "blank", label: "Rete vuota su terreno piatto", raw: BLANK },
];

// ---------------------------------------------------------------- stato

type Tool = "select" | "add" | "area";
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

// calcoli in cache, invalidati quando cambia la rete
let nodes: NodeSpec[] = [];
let params: ModelParams;
let links: LinkAssessment[] = [];
let resCtx: ResilienceContext | null = null;
let resScore: ResilienceScore | null = null;
let resBusy = false;
let resError = "";
let report: FailureReport | null = null;
let haloGrid: { key: string; grid: CoverageGrid; bbox: { minX: number; minY: number; maxX: number; maxY: number }; mPerPx: number } | null = null;
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
function readPalette(): void {
  const cs = getComputedStyle(document.documentElement);
  const names = ["bg", "surface", "fg", "muted", "line", "accent", "good", "warn", "bad", "land-sea", "land-open", "land-forest", "land-urban", "land-urban-dense"];
  palette = Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(`--${n}`).trim()]));
  themeKey = `${document.documentElement.dataset.theme ?? ""}|${palette.bg}`;
}

// ---------------------------------------------------------------- caricamento di una configurazione

function loadConfig(raw: unknown): void {
  const next = parseNetworkConfig(raw);
  const t = next.terrain === undefined ? FLAT_TERRAIN : Object.hasOwn(TERRAINS, next.terrain) ? TERRAINS[next.terrain] : undefined;
  if (!t) throw new Error(`Territorio sconosciuto: ${next.terrain}`);
  // Atomico: se il calcolo fallisce si torna alla rete precedente, mai a metà.
  const prev = cfg ? { cfg, terrain } : null;
  try {
    cfg = next;
    terrain = t;
    recompute();
  } catch (e) {
    if (prev) { cfg = prev.cfg; terrain = prev.terrain; recompute(); }
    throw e;
  }
  selected = next.devices.find((d) => d.kind === "box")?.id ?? next.devices[0]?.id ?? null;
  failed.clear();
  areas = [];
  haloGrid = null;
  $<HTMLSelectElement>("env").value = cfg.environment;
  $<HTMLSelectElement>("reg").value = cfg.regulatory;
  view = fitView(nodes.flatMap((n) => n.path.map((w) => ({ x: w.x, y: w.y }))), view.w, view.h, 0.18, 6000);
  bg = null;
  refreshAll();
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
      haloGrid = { key, grid: coverageGrid(n, pos, halo, params, bbox, cellM), bbox, mPerPx: view.mPerPx };
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

function renderBackground(fine: boolean): void {
  const block = fine ? 6 : 12;
  const ox = view.w * BG_PAD;
  const oy = view.h * BG_PAD;
  const c = document.createElement("canvas");
  c.width = Math.ceil(view.w * (1 + 2 * BG_PAD));
  c.height = Math.ceil(view.h * (1 + 2 * BG_PAD));
  const bc = c.getContext("2d")!;
  const d = view.mPerPx * block;
  for (let sy = 0; sy < c.height; sy += block) {
    for (let sx = 0; sx < c.width; sx += block) {
      const p = screenToWorld(view, sx + block / 2 - ox, sy + block / 2 - oy);
      const cover = terrain.landCoverAt(p.x, p.y);
      const e = terrain.elevationAt(p.x, p.y);
      bc.fillStyle = palette[COVER_KEY[cover]] || palette["land-open"];
      bc.fillRect(sx, sy, block, block);
      if (cover !== "sea") {
        // ombreggiatura: pendenza verso nord-ovest più chiara, opposta più scura
        const slope = (terrain.elevationAt(p.x + d, p.y - d) - e) / d;
        const shade = Math.max(-0.35, Math.min(0.35, slope * 1.2));
        if (Math.abs(shade) > 0.02) {
          bc.fillStyle = shade > 0 ? `rgba(0,0,0,${shade * 0.45})` : `rgba(255,255,255,${-shade * 0.45})`;
          bc.fillRect(sx, sy, block, block);
        }
      }
    }
  }
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

function drawCells(cells: { x: number; y: number }[], cellM: number, color: (i: number) => string): void {
  const s = Math.max(1, cellM / view.mPerPx);
  cells.forEach((c, i) => {
    const p = worldToScreen(view, c.x, c.y);
    g.fillStyle = color(i);
    g.fillRect(p.x - s / 2, p.y - s / 2, s + 0.6, s + 0.6);
  });
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
    const cells = haloGrid.grid.cells.filter((c) => c.possible);
    drawCells(cells, haloGrid.grid.cellM, (i) => { g.globalAlpha = 0.5; return qualityColor(cells[i].quality, 50); });
    g.globalAlpha = 1;
  }

  // celle di copertura perse con il guasto
  if (report && resCtx?.spec.coverage && report.lostCells.length > 0) {
    const cv = resCtx.spec.coverage;
    const cells = report.lostCells.map((i) => ({ x: cv.bbox.minX + ((i % cv.cols) + 0.5) * cv.cellM, y: cv.bbox.maxY - (Math.floor(i / cv.cols) + 0.5) * cv.cellM }));
    g.globalAlpha = 0.45;
    drawCells(cells, cv.cellM, () => palette.bad);
    g.globalAlpha = 1;
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
  $("status").textContent = t;
}

function renderPanel(): void {
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

function panelNetwork(): HTMLElement {
  const box = h("div", { class: "stack" });
  const n = cfg.devices.find((d) => d.id === selected);
  if (n) {
    const kind = n.kind;
    const form = h("div", { class: "card stack-s" });
    form.append(h("div", { class: "row" }, h("strong", { class: "mono" }, n.id), h("span", { class: "muted" }, KIND_LABEL[kind])));
    const label = h("input", { type: "text", id: "dev-label", value: n.label ?? "", "aria-label": "Nome del dispositivo", placeholder: "Nome (facoltativo)" });
    label.addEventListener("change", () => { n.label = label.value || undefined; });
    const agl = h("input", { type: "number", id: "dev-agl", min: "0", max: "200", step: "0.5", value: String(n.heightAglM ?? KIND_DEFAULTS[kind].heightAglM), "aria-label": "Altezza antenna in metri" });
    agl.addEventListener("change", () => { const v = Number(agl.value); if (Number.isFinite(v) && v >= 0 && v <= 200) { n.heightAglM = v; recompute(); refreshAll(); } });
    form.append(h("label", { class: "field" }, "Nome", label), h("label", { class: "field" }, "Altezza antenna (m)", agl));
    if (n.route) form.append(h("p", { class: "hint" }, "Dispositivo mobile: è mostrato alla partenza, il suo percorso è tratteggiato."));
    const rm = h("button", { type: "button", class: "btn danger" }, "Rimuovi dispositivo");
    rm.addEventListener("click", () => { cfg = removeDevice(cfg, n.id); failed.delete(n.id); selected = null; recompute(); refreshAll(); });
    form.append(rm);
    box.append(form);
  } else {
    box.append(h("p", { class: "hint" }, cfg.devices.length === 0 ? "Rete vuota. Scegli “Aggiungi”, un tipo di dispositivo, e fai clic sulla mappa." : "Fai clic su un dispositivo per vederne i dettagli, trascinalo per spostarlo."));
  }

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

function renderToolbar(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === tool)));
  document.querySelectorAll<HTMLButtonElement>("[data-halo]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.halo === halo)));
  $("add-kind-wrap").hidden = tool !== "add";
  $("area-wrap").hidden = tool !== "area";
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

type Drag = { kind: "pan"; lastX: number; lastY: number } | { kind: "dev"; id: string; moved: boolean; startX: number; startY: number; offX: number; offY: number };
let drag: Drag | null = null;

canvas.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0 || !ev.isPrimary) return; // solo il tasto principale / un dito
  canvas.setPointerCapture(ev.pointerId);
  const r = canvas.getBoundingClientRect();
  const sx = ev.clientX - r.left;
  const sy = ev.clientY - r.top;
  const id = hit(sx, sy);
  if (tool === "add") {
    const w = screenToWorld(view, sx, sy);
    const res = addDevice(cfg, addKind, w.x, w.y);
    cfg = res.cfg;
    selected = res.id;
    recompute();
    refreshAll();
    return;
  }
  if (tool === "area") {
    const w = screenToWorld(view, sx, sy);
    areas.push({ x: w.x, y: w.y, r: areaRadiusM });
    if (tab !== "resilienza") setTab("resilienza"); else failureChanged();
    return;
  }
  if (id) {
    selected = id;
    const at = posOf(id)!;
    const pw = screenToWorld(view, sx, sy);
    drag = { kind: "dev", id, moved: false, startX: sx, startY: sy, offX: at.x - pw.x, offY: at.y - pw.y };
    renderPanel();
    scheduleHalo();
    draw();
  } else {
    drag = { kind: "pan", lastX: sx, lastY: sy };
    canvas.style.cursor = "grabbing";
  }
});

canvas.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const r = canvas.getBoundingClientRect();
  const sx = ev.clientX - r.left;
  const sy = ev.clientY - r.top;
  if (drag.kind === "pan") {
    view = { ...view, cx: view.cx - (sx - drag.lastX) * view.mPerPx, cy: view.cy + (sy - drag.lastY) * view.mPerPx };
    drag.lastX = sx;
    drag.lastY = sy;
    draw();
  } else if (tab === "rete") {
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
    if (d.moved && tab === "rete") { recompute(); refreshAll(); }
    else if (!d.moved && tab === "resilienza") {
      if (failed.has(d.id)) failed.delete(d.id); else failed.add(d.id);
      failureChanged();
    }
  } else { scheduleHalo(); }
  void ev;
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("lostpointercapture", () => { drag = null; });

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
  const tag = (ev.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if ((ev.key === "Delete" || ev.key === "Backspace") && selected && tab === "rete") {
    cfg = removeDevice(cfg, selected);
    selected = null;
    recompute();
    refreshAll();
  }
});

// ---------------------------------------------------------------- controlli

function setTab(t: Tab): void {
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
  for (const p of PRESETS) scenario.append(h("option", { value: p.id }, p.label));
  scenario.addEventListener("change", () => {
    const p = PRESETS.find((q) => q.id === scenario.value);
    if (p) loadConfig(p.raw);
  });
  $<HTMLSelectElement>("env").addEventListener("change", (e) => { cfg = { ...cfg, environment: (e.target as HTMLSelectElement).value as NetworkConfig["environment"] }; recompute(); refreshAll(); });
  $<HTMLSelectElement>("reg").addEventListener("change", (e) => { cfg = { ...cfg, regulatory: (e.target as HTMLSelectElement).value as NetworkConfig["regulatory"] }; recompute(); refreshAll(); });
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.addEventListener("click", () => { tool = b.dataset.tool as Tool; renderToolbar(); }));
  document.querySelectorAll<HTMLButtonElement>("[data-halo]").forEach((b) => b.addEventListener("click", () => { halo = b.dataset.halo as Halo; haloGrid = null; renderToolbar(); scheduleHalo(); renderStatus(); draw(); }));
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab as Tab)));
  const kind = $<HTMLSelectElement>("add-kind");
  for (const k of ["card", "relay", "box", "portable", "phone"] as NodeKind[]) kind.append(h("option", { value: k }, KIND_LABEL[k]));
  kind.addEventListener("change", () => { addKind = kind.value as NodeKind; });
  const rad = $<HTMLInputElement>("area-radius");
  rad.addEventListener("input", () => { const v = Number(rad.value); if (v > 0) areaRadiusM = v * 1000; $("area-radius-v").textContent = `${rad.value} km`; });
  $("fit").addEventListener("click", () => { view = fitView(nodes.flatMap((n) => n.path.map((w) => ({ x: w.x, y: w.y }))), view.w, view.h, 0.18, 6000); bg = null; scheduleHalo(); draw(); });

  // configurazione salvabile: testo, non file scaricato (nell'anteprima il download è bloccato)
  const modal = $("modal");
  const text = $<HTMLTextAreaElement>("cfg-text");
  const msg = $("cfg-msg");
  $("cfg-open").addEventListener("click", () => { text.value = JSON.stringify(cfg, null, 2); msg.textContent = ""; modal.hidden = false; text.focus(); });
  $("cfg-close").addEventListener("click", () => { modal.hidden = true; });
  $("cfg-apply").addEventListener("click", () => {
    try { loadConfig(JSON.parse(text.value)); msg.textContent = ""; modal.hidden = true; }
    catch (e) { msg.textContent = `Configurazione non valida: ${(e as Error).message}`; }
  });
  $("cfg-copy").addEventListener("click", () => {
    navigator.clipboard.writeText(text.value).then(() => { msg.textContent = "Copiato."; }, () => { text.select(); msg.textContent = "Copia non consentita qui: il testo è selezionato, usa Ctrl+C."; });
  });
  $<HTMLInputElement>("cfg-file").addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    f.text().then((t) => { text.value = t; msg.textContent = "File letto: premi “Applica”."; }, () => { msg.textContent = "File non leggibile."; });
  });

  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onTheme = (): void => { readPalette(); bg = null; draw(); };
  mq.addEventListener("change", onTheme);
  new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  new ResizeObserver(resize).observe($("map-wrap"));
}

// ---------------------------------------------------------------- avvio

readPalette();
setupControls();
resize();
loadConfig(PRESETS[0].raw);
