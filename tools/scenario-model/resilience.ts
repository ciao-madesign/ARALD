/**
 * Test Network Resilience (Failure Simulation) — docs/network-design-tool.md §A.
 *
 * Risponde a: "cosa succede alla rete se questo nodo (questi nodi, questa area) smette di
 * funzionare?". Il nodo guasto resta nel risultato ma con stato "failed"; il modello ricalcola
 * connessioni, copertura residua, nodi isolati o tagliati fuori dall'infrastruttura,
 * percorsi alternativi, percorsi opportunistici e dipendenze critiche.
 *
 * Due livelli, entrambi senza stato e senza alcun riferimento a mappe, colori o Markdown:
 *
 * 1. **Nucleo sul grafo** (`createResilienceContext`): lavora su un grafo di link già calcolati
 *    (archi), su aloni di copertura già calcolati (celle) e, opzionalmente, su una sequenza di
 *    istantanee nel tempo per i percorsi opportunistici. Non sa nulla di radio: si testa con reti
 *    scritte a mano.
 * 2. **Adattatore radio** (`prepareResilience`): costruisce quegli ingredienti dal modello
 *    (`bestLink`, `coverageGrid`, `snapshotLinks`). Il costo è pagato una volta sola: ogni
 *    guasto successivo è un'operazione sul grafo e su maschere di bit, quindi interattiva.
 *
 * Definizioni (tutte derivate dal modello, nessuna inventata dall'interfaccia):
 * - **Infrastruttura** (sink): i nodi dei tipi `sinkKinds` (default Box e Portable), cioè dove
 *   vivono i servizi. Un nodo è **connesso** se ha un percorso istantaneo (multi-hop, qualunque
 *   tecnologia) verso un sink attivo.
 * - **Connettività diretta**: il percorso esiste nello stesso istante.
 * - **Connettività opportunistica**: non esiste un percorso simultaneo, ma esiste una sequenza
 *   di contatti nel tempo con ordine crescente (store-carry-forward): `A →t1 X →t2 sink`, t1<t2.
 *   Richiede i percorsi nel tempo dei nodi mobili (`window`).
 * - **Copertura radio**: frazione delle celle di terra dell'area di analisi raggiunte dall'alone
 *   LoRa di almeno un nodo attivo. **Copertura connessa**: lo stesso, ma contando solo i nodi
 *   che sono connessi a un'infrastruttura (un'alone di una Card isolata non serve a nessuno).
 */
import { coverageGrid, qualityFromRate } from "./assess.js";
import {
  KIND_DEFAULTS, type Medium, type ModelParams, type NodeKind, type NodeSpec, type Point3,
  bestLink, nodePosition, snapshotLinks,
} from "./model.js";
import { type GeoPoint, type LocalFrame, toLocal } from "./terrain.js";

// ---------------------------------------------------------------- tipi del nucleo

/** Arco del grafo: un link possibile tra due dispositivi. Le coordinate servono solo per le aree-ostacolo. */
export interface ResilienceEdge {
  a: string;
  b: string;
  tech: Medium;
  rateBps: number;
  /** Posizione locale (m) dei due estremi nell'istante dell'arco; se assente l'arco non è mai toccato da un'area-ostacolo. */
  ax?: number;
  ay?: number;
  bx?: number;
  by?: number;
}

export interface ResilienceNodeSpec {
  id: string;
  kind: NodeKind;
  /** Spento fin dall'inizio (es. `NodeSpec.offFrom <= atS`): non conta come attivo né come sink. */
  inactive?: boolean;
}

/** Aloni LoRa precalcolati, una maschera di celle per nodo. Le celle sono in ordine riga-per-riga da nord a sud, da ovest a est. */
export interface ResilienceCoverage {
  cols: number;
  rows: number;
  cellM: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** 1 = cella di terra (conta per la percentuale), 0 = mare/acqua. */
  land: Uint8Array;
  /** Per ogni nodo con LoRa: 1 dove l'alone del nodo raggiunge la cella. */
  halos: Record<string, Uint8Array>;
}

export interface ResilienceTimeline {
  fromS: number;
  steps: { t: number; edges: ResilienceEdge[] }[];
}

/** Rivaluta un arco con una perdita aggiuntiva (area-ostacolo): true se il link esiste ancora. */
export type EdgeReevaluator = (edge: ResilienceEdge, t: number, extraLossDb: number) => boolean;

export interface ResilienceGraphSpec {
  nodes: ResilienceNodeSpec[];
  /** Grafo istantaneo di riferimento (analisi diretta). */
  edges: ResilienceEdge[];
  /** Istante (s) del guasto: a cui si riferisce `edges` e da cui parte l'analisi opportunistica (`timeline`). */
  atS?: number;
  sinkKinds?: NodeKind[];
  /** Tipi di nodo su cui si calcola il punteggio (default: tutti tranne gli smartphone, che sono clienti). */
  scoreKinds?: NodeKind[];
  coverage?: ResilienceCoverage;
  timeline?: ResilienceTimeline;
  /** Posizioni locali dei nodi all'istante `atS`: servono per i guasti d'area. */
  positions?: Record<string, { x: number; y: number }>;
  frame?: LocalFrame;
  reevaluate?: EdgeReevaluator;
}

// ---------------------------------------------------------------- guasti

type Pt = GeoPoint | { x: number; y: number };

export type AreaShape =
  | { kind: "circle"; center: Pt; radiusM: number }
  | { kind: "polygon"; points: Pt[] };

/**
 * Area di guasto. `failNodes` (default true): i nodi la cui posizione cade dentro l'area si
 * spengono, come per un terremoto o un incendio. `blockLossDb` (default 0): perdita aggiuntiva
 * (dB) per ogni link il cui segmento attraversa l'area, in qualunque istante, come per una frana
 * o un fronte di fumo: 40 dB o più equivalgono a "impossibile attraversare".
 */
export interface FailureArea {
  shape: AreaShape;
  failNodes?: boolean;
  blockLossDb?: number;
}

export interface FailureSpec {
  nodes?: string[];
  areas?: FailureArea[];
}

export type NodeStatus = "failed" | "connected" | "recoverable" | "cut-off" | "isolated";

export interface Dependency {
  id: string;
  kind: NodeKind;
  /** Nodi non-smartphone che perdono ogni percorso verso l'infrastruttura se questo nodo si spegne. */
  dependents: string[];
  /** Smartphone che dipendono anch'essi da questo nodo (informativo: la loro dipendenza dalla propria Card è normale). */
  phoneDependents: string[];
  /** Frazione di copertura connessa persa se questo nodo si spegne (0-1). */
  coverageLoss: number;
}

export interface RecoverableNode {
  id: string;
  /** Secondi dall'istante del guasto (`atS`) a cui il nodo raggiunge un'infrastruttura; 0 = già al momento del guasto. */
  arrivalS: number;
  /** true se il nodo era connesso prima del guasto (perdita causata dal guasto), false se lo era già non. */
  newlyCutOff: boolean;
}

export interface FailureReport {
  failed: string[];
  states: Record<string, NodeStatus>;
  nodes: { total: number; activeBefore: number; activeAfter: number };
  connections: { before: number; after: number };
  fragments: { before: number; after: number };
  /** Nodi attivi senza alcun link. */
  isolated: string[];
  /** Nodi che erano connessi a un'infrastruttura e ora non lo sono (perdita causata dal guasto). */
  cutOff: string[];
  /** Nodi non connessi direttamente che hanno però un percorso opportunistico. Vuoto senza `timeline`. */
  recoverable: RecoverableNode[];
  /** Nodi ancora connessi ma con un percorso più lungo (o più corto) verso l'infrastruttura. */
  rerouted: { id: string; hopsBefore: number; hopsAfter: number }[];
  /** Frazioni 0-1 delle celle di terra; assenti se non c'è un'analisi di copertura. */
  coverage: { connectedBefore: number; connectedAfter: number; radioBefore: number; radioAfter: number } | null;
  /** Celle coperte (connesse) prima e non più dopo: l'area rimasta scoperta, per la mappa. */
  lostCells: number[];
  /** Dipendenze critiche nella rete residua: nodi che, se si spegnessero ora, taglierebbero fuori altri nodi. */
  dependencies: Dependency[];
  /** true se è stata fatta l'analisi opportunistica (`timeline` presente). */
  opportunistic: boolean;
}

// ---------------------------------------------------------------- punteggio

export interface ResilienceWeights {
  coverage: number;
  directConnectivity: number;
  reachability: number;
  redundancy: number;
  coverageUnderFailure: number;
  opportunisticRecovery: number;
}

/** Pesi uguali. Una componente non calcolabile (es. senza mobilità) è esclusa e gli altri pesi si ri-normalizzano. */
export const DEFAULT_WEIGHTS: ResilienceWeights = { coverage: 1, directConnectivity: 1, reachability: 1, redundancy: 1, coverageUnderFailure: 1, opportunisticRecovery: 1 };

export interface ScoreComponent {
  key: keyof ResilienceWeights;
  /** Valore 0-1; null se la componente non è calcolabile e viene esclusa. */
  value: number | null;
  weight: number;
}

export interface SingleFailureEntry {
  id: string;
  kind: NodeKind;
  /** Nodi non-smartphone tagliati fuori dall'infrastruttura. */
  cutOff: string[];
  phoneCutOff: string[];
  /** Tra i tagliati fuori, quelli con un percorso opportunistico. */
  recoverable: string[];
  /** Perdita di copertura connessa (0-1), in punti percentuali assoluti. */
  coverageLoss: number;
  critical: boolean;
}

export interface ResilienceScore {
  /** 0-100. */
  score: number;
  components: ScoreComponent[];
  /** Nodi la cui perdita taglia fuori altri nodi non-smartphone. */
  criticalNodes: string[];
  /** Nodi non-smartphone che un guasto singolo taglia fuori ma che un percorso opportunistico recupera. */
  recoverableGaps: string[];
  /** Il guasto singolo con più nodi non-smartphone tagliati fuori. */
  worstSingleFailure: { id: string; cutOff: number } | null;
  singleFailures: SingleFailureEntry[];
}

// ---------------------------------------------------------------- grafo

class UnionFind {
  private readonly parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x: number): number {
    while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; }
    return x;
  }
  union(a: number, b: number): void { this.parent[this.find(a)] = this.find(b); }
}

interface State {
  active: Set<string>;
  edges: ResilienceEdge[];
  degree: Map<string, number>;
  /** Nodi attivi con un percorso verso un sink attivo (i sink stessi inclusi). */
  connected: Set<string>;
  /** Distanza in salti dal sink attivo più vicino, per i nodi connessi. */
  hops: Map<string, number>;
  fragments: number;
}

interface ResolvedArea {
  circle?: { cx: number; cy: number; r: number };
  polygon?: { x: number; y: number }[];
  lossDb: number;
  failNodes: boolean;
}

const DEFAULT_SINKS: NodeKind[] = ["box", "portable"];

export interface ResilienceContext {
  readonly spec: ResilienceGraphSpec;
  readonly sinkKinds: NodeKind[];
  readonly scoreKinds: NodeKind[];
  readonly kindOf: Map<string, NodeKind>;
  readonly index: Map<string, number>;
  readonly baseline: State;
}

export function createResilienceContext(spec: ResilienceGraphSpec): ResilienceContext {
  const ids = new Set<string>();
  for (const n of spec.nodes) {
    if (ids.has(n.id)) throw new Error(`Nodo duplicato: ${n.id}`);
    ids.add(n.id);
  }
  for (const e of spec.edges) {
    if (!ids.has(e.a) || !ids.has(e.b)) throw new Error(`Arco verso un nodo sconosciuto: ${e.a}–${e.b}`);
  }
  const ctx = {
    spec,
    sinkKinds: spec.sinkKinds ?? DEFAULT_SINKS,
    scoreKinds: spec.scoreKinds ?? (["box", "portable", "card", "relay"] as NodeKind[]),
    kindOf: new Map(spec.nodes.map((n) => [n.id, n.kind])),
    index: new Map(spec.nodes.map((n, i) => [n.id, i])),
    baseline: undefined as unknown as State,
  };
  (ctx as { baseline: State }).baseline = computeState(ctx as ResilienceContext, new Set(), []);
  return ctx as ResilienceContext;
}

function isSink(ctx: ResilienceContext, id: string): boolean {
  return ctx.sinkKinds.includes(ctx.kindOf.get(id)!);
}

/** Stato del grafo con i nodi `failed` spenti e le `areas` che disturbano i link che le attraversano. */
function computeState(ctx: ResilienceContext, failed: ReadonlySet<string>, areas: ResolvedArea[]): State {
  const active = new Set(ctx.spec.nodes.filter((n) => !n.inactive && !failed.has(n.id)).map((n) => n.id));
  const edges = filterEdges(ctx, ctx.spec.edges, ctx.spec.atS ?? 0, active, areas);
  return stateFromEdges(ctx, active, edges);
}

function stateFromEdges(ctx: ResilienceContext, active: Set<string>, edges: ResilienceEdge[]): State {
  const uf = new UnionFind(ctx.spec.nodes.length);
  const degree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of active) { degree.set(id, 0); adj.set(id, []); }
  for (const e of edges) {
    uf.union(ctx.index.get(e.a)!, ctx.index.get(e.b)!);
    degree.set(e.a, degree.get(e.a)! + 1);
    degree.set(e.b, degree.get(e.b)! + 1);
    adj.get(e.a)!.push(e.b);
    adj.get(e.b)!.push(e.a);
  }
  const roots = new Set<number>();
  for (const id of active) roots.add(uf.find(ctx.index.get(id)!));
  // Salti dal sink più vicino (BFS multi-sorgente): chi viene raggiunto è connesso.
  const hops = new Map<string, number>();
  const queue: string[] = [];
  for (const id of active) if (isSink(ctx, id)) { hops.set(id, 0); queue.push(id); }
  for (let h = 0; h < queue.length; h++) {
    const cur = queue[h];
    for (const nb of adj.get(cur)!) if (!hops.has(nb)) { hops.set(nb, hops.get(cur)! + 1); queue.push(nb); }
  }
  return { active, edges, degree, connected: new Set(hops.keys()), hops, fragments: roots.size };
}

// ---------------------------------------------------------------- geometria delle aree

function toLocalPt(ctx: ResilienceContext, p: Pt): { x: number; y: number } {
  if ("lat" in p) {
    if (!ctx.spec.frame) throw new Error("Un'area in coordinate geografiche richiede `frame` nel contesto di resilienza");
    return toLocal(ctx.spec.frame, p);
  }
  return p;
}

function resolveAreas(ctx: ResilienceContext, areas: FailureArea[] | undefined): ResolvedArea[] {
  return (areas ?? []).map((a) => {
    const lossDb = a.blockLossDb ?? 0;
    const failNodes = a.failNodes ?? true;
    if (a.shape.kind === "circle") {
      const c = toLocalPt(ctx, a.shape.center);
      return { circle: { cx: c.x, cy: c.y, r: a.shape.radiusM }, lossDb, failNodes };
    }
    if (a.shape.points.length < 3) throw new Error("Un poligono d'area richiede almeno 3 punti");
    return { polygon: a.shape.points.map((p) => toLocalPt(ctx, p)), lossDb, failNodes };
  });
}

function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function pointInArea(area: ResolvedArea, x: number, y: number): boolean {
  if (area.circle) return Math.hypot(x - area.circle.cx, y - area.circle.cy) <= area.circle.r;
  return pointInPolygon(x, y, area.polygon!);
}

function segmentsCross(p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, p4: { x: number; y: number }): boolean {
  const d = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // Tocco o allineamento: un estremo di un segmento giace sull'altro.
  const on = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, dd: number) =>
    dd === 0 && Math.min(a.x, b.x) <= c.x && c.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= c.y && c.y <= Math.max(a.y, b.y);
  return on(p3, p4, p1, d1) || on(p3, p4, p2, d2) || on(p1, p2, p3, d3) || on(p1, p2, p4, d4);
}

/** Il segmento A–B attraversa (o tocca) l'area. */
function segmentTouchesArea(area: ResolvedArea, ax: number, ay: number, bx: number, by: number): boolean {
  if (area.circle) {
    const { cx, cy, r } = area.circle;
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const f = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - ax) * vx + (cy - ay) * vy) / len2));
    return Math.hypot(cx - (ax + f * vx), cy - (ay + f * vy)) <= r;
  }
  const poly = area.polygon!;
  if (pointInPolygon(ax, ay, poly) || pointInPolygon(bx, by, poly)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segmentsCross({ x: ax, y: ay }, { x: bx, y: by }, poly[i], poly[j])) return true;
  }
  return false;
}

/** Archi tra nodi attivi; quelli che attraversano un'area-ostacolo vengono rivalutati con la perdita aggiuntiva. */
function filterEdges(ctx: ResilienceContext, edges: ResilienceEdge[], t: number, active: Set<string>, areas: ResolvedArea[]): ResilienceEdge[] {
  const blocking = areas.filter((a) => a.lossDb > 0);
  const out: ResilienceEdge[] = [];
  for (const e of edges) {
    if (!active.has(e.a) || !active.has(e.b)) continue;
    if (blocking.length > 0 && e.ax !== undefined && e.ay !== undefined && e.bx !== undefined && e.by !== undefined) {
      let loss = 0;
      for (const a of blocking) if (segmentTouchesArea(a, e.ax, e.ay, e.bx, e.by)) loss += a.lossDb;
      if (loss > 0) {
        const survives = ctx.spec.reevaluate ? ctx.spec.reevaluate(e, t, loss) : false; // senza modello radio: attraversamento impossibile
        if (!survives) continue;
      }
    }
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------- copertura

function coverageFractions(ctx: ResilienceContext, state: State): { connected: Uint8Array; radio: Uint8Array; connectedFrac: number; radioFrac: number } | null {
  const cov = ctx.spec.coverage;
  if (!cov) return null;
  const n = cov.land.length;
  const connected = new Uint8Array(n);
  const radio = new Uint8Array(n);
  for (const id of state.active) {
    const halo = cov.halos[id];
    if (!halo) continue;
    const isConn = state.connected.has(id);
    for (let i = 0; i < n; i++) {
      if (halo[i] && cov.land[i]) { radio[i] = 1; if (isConn) connected[i] = 1; }
    }
  }
  let land = 0;
  let c = 0;
  let r = 0;
  for (let i = 0; i < n; i++) { land += cov.land[i]; c += connected[i]; r += radio[i]; }
  return { connected, radio, connectedFrac: land ? c / land : 0, radioFrac: land ? r / land : 0 };
}

// ---------------------------------------------------------------- percorsi opportunistici

/**
 * Per ogni nodo di partenza: l'istante più precoce (s dall'inizio della finestra) in cui un messaggio
 * può raggiungere un'infrastruttura attiva con una sequenza di contatti in ordine temporale. In ogni
 * istantanea un messaggio attraversa tutta la componente connessa a cui appartiene chi lo porta
 * (multi-hop simultaneo); tra un'istantanea e l'altra resta nel nodo che lo trasporta.
 */
function opportunisticArrivals(ctx: ResilienceContext, failed: ReadonlySet<string>, areas: ResolvedArea[], sources: string[]): Map<string, number> {
  const tl = ctx.spec.timeline;
  const result = new Map<string, number>();
  if (!tl || sources.length === 0) return result;
  // Il guasto avviene all'istante `atS`: i contatti precedenti non possono trasportare messaggi che non esistono ancora.
  const startT = Math.max(tl.fromS, ctx.spec.atS ?? tl.fromS);
  const active = new Set(ctx.spec.nodes.filter((n) => !n.inactive && !failed.has(n.id)).map((n) => n.id));
  const reached = new Map<string, Set<string>>(sources.map((s) => [s, new Set([s])]));
  const pending = new Set(sources);
  for (const step of tl.steps) {
    if (pending.size === 0) break;
    if (step.t < startT) continue;
    const edges = filterEdges(ctx, step.edges, step.t, active, areas);
    const uf = new UnionFind(ctx.spec.nodes.length);
    for (const e of edges) uf.union(ctx.index.get(e.a)!, ctx.index.get(e.b)!);
    const members = new Map<number, string[]>();
    for (const id of active) {
      const r = uf.find(ctx.index.get(id)!);
      const list = members.get(r);
      if (list) list.push(id); else members.set(r, [id]);
    }
    for (const src of [...pending]) {
      const mine = reached.get(src)!;
      for (const comp of members.values()) {
        if (!comp.some((id) => mine.has(id))) continue;
        for (const id of comp) mine.add(id);
      }
      if ([...mine].some((id) => isSink(ctx, id))) {
        result.set(src, step.t - startT);
        pending.delete(src);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------- dipendenze critiche

function dependenciesOf(ctx: ResilienceContext, failed: ReadonlySet<string>, areas: ResolvedArea[], state: State): Dependency[] {
  const base = coverageFractions(ctx, state);
  const out: Dependency[] = [];
  for (const id of state.active) {
    const next = new Set(failed);
    next.add(id);
    const st = computeState(ctx, next, areas);
    const lost = [...state.connected].filter((x) => x !== id && !st.connected.has(x));
    const dependents = lost.filter((x) => ctx.kindOf.get(x) !== "phone");
    const phoneDependents = lost.filter((x) => ctx.kindOf.get(x) === "phone");
    const cov = coverageFractions(ctx, st);
    const coverageLoss = base && cov ? Math.max(0, base.connectedFrac - cov.connectedFrac) : 0;
    // Solo i nodi da cui dipendono altri nodi di rete: uno smartphone che dipende dalla propria Card è normale.
    if (dependents.length > 0) out.push({ id, kind: ctx.kindOf.get(id)!, dependents, phoneDependents, coverageLoss });
  }
  return out.sort((a, b) => b.dependents.length - a.dependents.length || b.coverageLoss - a.coverageLoss || b.phoneDependents.length - a.phoneDependents.length || a.id.localeCompare(b.id));
}

/** Dipendenze critiche della rete integra: i single point of failure. */
export function criticalDependencies(ctx: ResilienceContext): Dependency[] {
  return dependenciesOf(ctx, new Set(), [], ctx.baseline);
}

// ---------------------------------------------------------------- guasto

function resolveFailed(ctx: ResilienceContext, spec: FailureSpec, areas: ResolvedArea[]): Set<string> {
  const failed = new Set<string>();
  for (const id of spec.nodes ?? []) {
    if (!ctx.index.has(id)) throw new Error(`Nodo sconosciuto nel guasto: ${id}`);
    failed.add(id);
  }
  for (const a of areas) {
    if (!a.failNodes) continue;
    if (!ctx.spec.positions) throw new Error("Un guasto d'area che spegne nodi richiede `positions` nel contesto di resilienza");
    for (const [id, p] of Object.entries(ctx.spec.positions)) if (pointInArea(a, p.x, p.y)) failed.add(id);
  }
  return failed;
}

/** Ricalcola la rete con i guasti indicati e la confronta con la rete integra. `dependencies: false` salta la tabella delle dipendenze residue (costosa, inutile nei cicli interni). */
export function evaluateFailure(ctx: ResilienceContext, spec: FailureSpec, opts: { dependencies?: boolean } = {}): FailureReport {
  const areas = resolveAreas(ctx, spec.areas);
  const failed = resolveFailed(ctx, spec, areas);
  const before = ctx.baseline;
  const after = computeState(ctx, failed, areas);

  const states: Record<string, NodeStatus> = {};
  const notConnectedAfter: string[] = [];
  for (const n of ctx.spec.nodes) {
    if (failed.has(n.id)) { states[n.id] = "failed"; continue; }
    if (n.inactive) { states[n.id] = "failed"; continue; }
    if (after.connected.has(n.id)) states[n.id] = "connected";
    else { notConnectedAfter.push(n.id); states[n.id] = after.degree.get(n.id) === 0 ? "isolated" : "cut-off"; }
  }
  const cutOff = notConnectedAfter.filter((id) => before.connected.has(id));
  const isolated = notConnectedAfter.filter((id) => after.degree.get(id) === 0);

  const arrivals = opportunisticArrivals(ctx, failed, areas, notConnectedAfter);
  const recoverable: RecoverableNode[] = [];
  for (const [id, arrivalS] of arrivals) {
    states[id] = "recoverable";
    recoverable.push({ id, arrivalS, newlyCutOff: before.connected.has(id) });
  }
  recoverable.sort((a, b) => a.arrivalS - b.arrivalS || a.id.localeCompare(b.id));

  const rerouted: FailureReport["rerouted"] = [];
  for (const id of after.connected) {
    const hb = before.hops.get(id);
    const ha = after.hops.get(id)!;
    if (hb !== undefined && hb !== ha && !failed.has(id)) rerouted.push({ id, hopsBefore: hb, hopsAfter: ha });
  }

  const covB = coverageFractions(ctx, before);
  const covA = coverageFractions(ctx, after);
  const lostCells: number[] = [];
  if (covB && covA) for (let i = 0; i < covB.connected.length; i++) if (covB.connected[i] && !covA.connected[i]) lostCells.push(i);

  return {
    failed: [...failed],
    states,
    nodes: { total: ctx.spec.nodes.length, activeBefore: before.active.size, activeAfter: after.active.size },
    connections: { before: before.edges.length, after: after.edges.length },
    fragments: { before: before.fragments, after: after.fragments },
    isolated,
    cutOff,
    recoverable,
    rerouted: rerouted.sort((a, b) => a.id.localeCompare(b.id)),
    coverage: covB && covA ? { connectedBefore: covB.connectedFrac, connectedAfter: covA.connectedFrac, radioBefore: covB.radioFrac, radioAfter: covA.radioFrac } : null,
    lostCells,
    dependencies: opts.dependencies === false ? [] : dependenciesOf(ctx, failed, areas, after),
    opportunistic: ctx.spec.timeline !== undefined,
  };
}

// ---------------------------------------------------------------- punteggio e classifica dei guasti singoli

/** Guasto singolo di ogni nodo non-smartphone attivo, ordinato per danno. */
export function rankSingleFailures(ctx: ResilienceContext): SingleFailureEntry[] {
  const out: SingleFailureEntry[] = [];
  for (const n of ctx.spec.nodes) {
    if (n.inactive || n.kind === "phone") continue;
    const rep = evaluateFailure(ctx, { nodes: [n.id] }, { dependencies: false });
    const cutOff = rep.cutOff.filter((id) => ctx.kindOf.get(id) !== "phone");
    const phoneCutOff = rep.cutOff.filter((id) => ctx.kindOf.get(id) === "phone");
    const recoverable = rep.recoverable.filter((r) => r.newlyCutOff && ctx.kindOf.get(r.id) !== "phone").map((r) => r.id);
    const coverageLoss = rep.coverage ? Math.max(0, rep.coverage.connectedBefore - rep.coverage.connectedAfter) : 0;
    out.push({ id: n.id, kind: n.kind, cutOff, phoneCutOff, recoverable, coverageLoss, critical: cutOff.length > 0 });
  }
  return out.sort((a, b) => b.cutOff.length - a.cutOff.length || b.coverageLoss - a.coverageLoss || b.phoneCutOff.length - a.phoneCutOff.length || a.id.localeCompare(b.id));
}

/**
 * Resilience Score 0-100: media pesata di componenti 0-1, tutte calcolate dal modello.
 * - `coverage`: copertura connessa della rete integra (frazione dell'area di analisi).
 * - `directConnectivity`: frazione dei nodi di rete (non sink, non smartphone) con un percorso diretto verso l'infrastruttura.
 * - `reachability`: frazione dei nodi di rete che raggiungono un'infrastruttura direttamente o, entro la finestra,
 *   in modo opportunistico (un corriere, un'imbarcazione). Esclusa senza analisi temporale. Misura ciò che la rete
 *   rende possibile anche quando la connettività diretta è assente.
 * - `redundancy`: tra i nodi connessi, quelli che restano connessi dopo qualunque guasto singolo di un altro nodo.
 * - `coverageUnderFailure`: copertura connessa MEDIA dopo un guasto singolo, in valore assoluto (frazione dell'area):
 *   "se un nodo a caso si guasta, in media la rete copre X% dell'area". È assoluta di proposito: una rete già
 *   inutilizzabile non "conserva" nulla e non deve ricevere punti per aver perso poco.
 * - `opportunisticRecovery`: tra i nodi che un guasto singolo taglia fuori, quelli recuperabili con un percorso opportunistico.
 *   Esclusa se non c'è un'analisi temporale o se nessun guasto singolo taglia fuori nessuno.
 * Una componente non calcolabile è esclusa e i pesi si ri-normalizzano.
 */
export function resilienceScore(ctx: ResilienceContext, weights: ResilienceWeights = DEFAULT_WEIGHTS): ResilienceScore {
  const scoring = ctx.spec.nodes.filter((n) => !n.inactive && ctx.scoreKinds.includes(n.kind) && !isSink(ctx, n.id));
  const baselineConnected = scoring.filter((n) => ctx.baseline.connected.has(n.id));
  const single = rankSingleFailures(ctx);

  const covBase = coverageFractions(ctx, ctx.baseline);
  const nonRedundant = new Set<string>();
  let cutTotal = 0;
  let recTotal = 0;
  const recoverableGaps = new Set<string>();
  for (const f of single) {
    for (const id of f.cutOff) if (id !== f.id) nonRedundant.add(id);
    cutTotal += f.cutOff.filter((id) => scoring.some((s) => s.id === id)).length;
    const rec = f.recoverable.filter((id) => scoring.some((s) => s.id === id));
    recTotal += rec.length;
    for (const id of rec) recoverableGaps.add(id);
  }

  // Raggiungibilità di base: connessi direttamente, più quelli che raggiungono un'infrastruttura nella finestra.
  let reachable: number | null = null;
  if (ctx.spec.timeline && scoring.length > 0) {
    const notConnected = scoring.filter((n) => !ctx.baseline.connected.has(n.id)).map((n) => n.id);
    const arrivals = opportunisticArrivals(ctx, new Set(), [], notConnected);
    reachable = (baselineConnected.length + arrivals.size) / scoring.length;
  }

  const components: ScoreComponent[] = [
    { key: "coverage", value: covBase ? covBase.connectedFrac : null, weight: weights.coverage },
    { key: "directConnectivity", value: scoring.length > 0 ? baselineConnected.length / scoring.length : null, weight: weights.directConnectivity },
    { key: "reachability", value: reachable, weight: weights.reachability },
    {
      key: "redundancy",
      value: scoring.length > 0 ? (baselineConnected.length > 0 ? baselineConnected.filter((n) => !nonRedundant.has(n.id)).length / baselineConnected.length : 0) : null,
      weight: weights.redundancy,
    },
    {
      key: "coverageUnderFailure",
      value: covBase ? (single.length > 0 ? single.reduce((s, f) => s + Math.max(0, covBase.connectedFrac - f.coverageLoss), 0) / single.length : covBase.connectedFrac) : null,
      weight: weights.coverageUnderFailure,
    },
    { key: "opportunisticRecovery", value: ctx.spec.timeline && cutTotal > 0 ? recTotal / cutTotal : null, weight: weights.opportunisticRecovery },
  ];
  const used = components.filter((c) => c.value !== null && c.weight > 0);
  const wSum = used.reduce((s, c) => s + c.weight, 0);
  const score = wSum > 0 ? (100 * used.reduce((s, c) => s + c.weight * c.value!, 0)) / wSum : 0;
  const worst = single.length > 0 && single[0].cutOff.length > 0 ? { id: single[0].id, cutOff: single[0].cutOff.length } : null;
  return {
    score,
    components,
    criticalNodes: single.filter((f) => f.critical).map((f) => f.id),
    recoverableGaps: [...recoverableGaps].sort(),
    worstSingleFailure: worst,
    singleFailures: single,
  };
}

// ---------------------------------------------------------------- adattatore radio

export interface ResilienceOptions {
  params: ModelParams;
  nodes: NodeSpec[];
  /** Istante (s) dell'analisi diretta e degli aloni di copertura. Default 0. */
  atS?: number;
  /**
   * Finestra per i percorsi opportunistici: si considerano i contatti da `max(fromS, atS)` in poi.
   * Se assente si ricava dai percorsi dei nodi (da `atS` all'ultimo waypoint, passo 60 s); se nessun nodo
   * si muove, c'è un'unica istantanea: nessuna mobilità significa nessun percorso opportunistico, e
   * raggiungibilità e recupero valgono ciò che vale la connettività diretta (così le reti sono confrontabili).
   * `false` disattiva del tutto l'analisi temporale: le componenti che la richiedono sono escluse dal punteggio.
   */
  window?: { fromS: number; toS: number; stepS: number } | false;
  /** Area di analisi per la copertura (coordinate locali, m). Default: riquadro dei nodi con margine. */
  area?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Lato (m) delle celle di copertura. Default: ~50 celle sul lato lungo, multiplo di 250 m, almeno 250 m. */
  cellM?: number;
  /** Disattiva il calcolo della copertura (più veloce se serve solo la connettività). */
  skipCoverage?: boolean;
  sinkKinds?: NodeKind[];
  scoreKinds?: NodeKind[];
  frame?: LocalFrame;
  /** Perdita aggiuntiva (dB) su ogni link, costante o in funzione del tempo (es. una perturbazione). */
  extraLossDb?: number | ((tS: number) => number);
}

function edgeFrom(a: NodeSpec, pa: Point3, b: NodeSpec, pb: Point3, link: { medium: Medium; rateBps?: number }): ResilienceEdge {
  return { a: a.id, b: b.id, tech: link.medium, rateBps: link.rateBps ?? 0, ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y };
}

/** Archi del grafo istantaneo a un istante: ogni coppia con almeno una tecnologia possibile. */
function edgesAt(nodes: NodeSpec[], t: number, p: ModelParams, extraLossDb: number): ResilienceEdge[] {
  const terrain = p.env.terrain;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return snapshotLinks(nodes, t, p, extraLossDb).map((l) => {
    const a = byId.get(l.a)!;
    const b = byId.get(l.b)!;
    return edgeFrom(a, nodePosition(a, t, terrain), b, nodePosition(b, t, terrain), l.link);
  });
}

/** Costruisce il contesto di resilienza dal modello radio. Il costo è qui, una volta sola. */
/** Tetto agli istanti analizzati: ognuno costa un calcolo O(N²) dei collegamenti. */
const MAX_TIMELINE_STEPS = 20000;

export function prepareResilience(opts: ResilienceOptions): ResilienceContext {
  const { params: p, nodes } = opts;
  const atS = opts.atS ?? 0;
  const extraAt = (t: number): number => (typeof opts.extraLossDb === "function" ? opts.extraLossDb(t) : opts.extraLossDb ?? 0);
  const terrain = p.env.terrain;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const positions: Record<string, { x: number; y: number }> = {};
  const pos3 = new Map<string, Point3>();
  for (const n of nodes) {
    const q = nodePosition(n, atS, terrain);
    positions[n.id] = { x: q.x, y: q.y };
    pos3.set(n.id, q);
  }

  const reevaluate: EdgeReevaluator = (e, t, loss) => {
    const a = byId.get(e.a)!;
    const b = byId.get(e.b)!;
    return bestLink(a, nodePosition(a, t, terrain), b, nodePosition(b, t, terrain), p, extraAt(t) + loss) !== null;
  };

  let coverage: ResilienceCoverage | undefined;
  if (!opts.skipCoverage) {
    const xs = [...pos3.values()].map((q) => q.x);
    const ys = [...pos3.values()].map((q) => q.y);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
    const cellM = opts.cellM ?? Math.max(250, Math.ceil(span / 50 / 250) * 250);
    const margin = 6 * cellM;
    const bbox = opts.area ?? { minX: Math.min(...xs) - margin, maxX: Math.max(...xs) + margin, minY: Math.min(...ys) - margin, maxY: Math.max(...ys) + margin };
    const halos: Record<string, Uint8Array> = {};
    let land: Uint8Array | undefined;
    let cols = 0;
    let rows = 0;
    for (const n of nodes) {
      if (!KIND_DEFAULTS[n.kind].caps.lora) continue;
      const g = coverageGrid(n, pos3.get(n.id)!, "lora", p, bbox, cellM);
      cols = g.cols;
      rows = g.rows;
      halos[n.id] = Uint8Array.from(g.cells, (c) => (c.possible ? 1 : 0));
      if (!land) land = Uint8Array.from(g.cells, (c) => (terrain ? (terrain.landCoverAt(c.x, c.y) !== "sea" ? 1 : 0) : 1));
    }
    if (land) coverage = { cols, rows, cellM, bbox, land, halos };
  }

  let timeline: ResilienceTimeline | undefined;
  const lastWaypoint = Math.max(atS, ...nodes.flatMap((n) => n.path.map((w) => w.t)));
  const window = opts.window === false ? undefined : opts.window ?? { fromS: atS, toS: lastWaypoint, stepS: 60 };
  if (window) {
    const { fromS, toS, stepS } = window;
    if (![fromS, toS, stepS].every(Number.isFinite) || !(stepS > 0) || toS < fromS) throw new Error("Finestra opportunistica non valida");
    if ((toS - fromS) / stepS > MAX_TIMELINE_STEPS) throw new Error(`Finestra opportunistica troppo fine: più di ${MAX_TIMELINE_STEPS} istanti (aumenta il passo o riduci la finestra)`);
    const steps: { t: number; edges: ResilienceEdge[] }[] = [];
    for (let t = fromS; t <= toS + 1e-9; t += stepS) steps.push({ t, edges: edgesAt(nodes, t, p, extraAt(t)) });
    timeline = { fromS, steps };
  }

  return createResilienceContext({
    nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, inactive: n.offFrom !== undefined && n.offFrom <= atS })),
    edges: edgesAt(nodes, atS, p, extraAt(atS)),
    atS,
    sinkKinds: opts.sinkKinds,
    scoreKinds: opts.scoreKinds,
    coverage,
    timeline,
    positions,
    frame: opts.frame,
    reevaluate,
  });
}

/** Qualità 0-1 di un arco, per colorare i collegamenti nella mappa della rete residua. */
export function edgeQuality(e: ResilienceEdge): number {
  return qualityFromRate(e.rateBps);
}

/** Archi della rete con i guasti applicati (per disegnare i link rimasti). */
export function residualEdges(ctx: ResilienceContext, spec: FailureSpec): ResilienceEdge[] {
  const areas = resolveAreas(ctx, spec.areas);
  return computeState(ctx, resolveFailed(ctx, spec, areas), areas).edges;
}
