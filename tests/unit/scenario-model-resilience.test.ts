import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EOLIE_TERRAIN } from "../../tools/scenario-model/eolie.js";
import { paramsForConfig, parseNetworkConfig, placeDevices } from "../../tools/scenario-model/network-config.js";
import {
  type ResilienceCoverage, type ResilienceEdge, type ResilienceGraphSpec, type ResilienceNodeSpec,
  createResilienceContext, criticalDependencies, evaluateFailure, prepareResilience, rankSingleFailures, residualEdges, resilienceScore,
} from "../../tools/scenario-model/resilience.js";
import { formatFailureReport, formatScore, formatSingleFailures } from "../../tools/scenario-model/resilience-report.js";

const node = (id: string, kind: ResilienceNodeSpec["kind"], inactive?: boolean): ResilienceNodeSpec => ({ id, kind, inactive });
const edge = (a: string, b: string, extra: Partial<ResilienceEdge> = {}): ResilienceEdge => ({ a, b, tech: "lora", rateBps: 3000, ...extra });

/** Copertura sintetica: `n` celle di terra, ogni nodo copre le celle indicate. */
function coverage(n: number, halos: Record<string, number[]>): ResilienceCoverage {
  const out: Record<string, Uint8Array> = {};
  for (const [id, cells] of Object.entries(halos)) { const m = new Uint8Array(n); for (const c of cells) m[c] = 1; out[id] = m; }
  return { cols: n, rows: 1, cellM: 1000, bbox: { minX: 0, minY: 0, maxX: n * 1000, maxY: 1000 }, land: new Uint8Array(n).fill(1), halos: out };
}
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe("resilienza: l'esempio della specifica (un Box e tre Card)", () => {
  const spec: ResilienceGraphSpec = {
    nodes: [node("BOX", "box"), node("CA", "card"), node("CB", "card"), node("CC", "card")],
    edges: [edge("BOX", "CA"), edge("BOX", "CB"), edge("BOX", "CC")],
    coverage: coverage(12, { BOX: range(0, 7), CA: [8, 9], CB: [10], CC: [11] }),
  };
  const ctx = createResilienceContext(spec);

  it("spegnendo il Box: nodi 4→3, connessioni 3→0, nodi isolati, copertura connessa crolla, dipendenza critica = Box", () => {
    const r = evaluateFailure(ctx, { nodes: ["BOX"] });
    expect(r.nodes).toEqual({ total: 4, activeBefore: 4, activeAfter: 3 });
    expect(r.connections).toEqual({ before: 3, after: 0 });
    expect(r.fragments).toEqual({ before: 1, after: 3 });
    expect(r.isolated.sort()).toEqual(["CA", "CB", "CC"]);
    expect(r.cutOff.sort()).toEqual(["CA", "CB", "CC"]);
    expect(r.states).toMatchObject({ BOX: "failed", CA: "isolated", CB: "isolated", CC: "isolated" });
    expect(r.coverage).toEqual({ connectedBefore: 1, connectedAfter: 0, radioBefore: 1, radioAfter: 4 / 12 });
    expect(r.lostCells).toEqual(range(0, 11));
    expect(r.opportunistic).toBe(false);
    expect(r.recoverable).toEqual([]);
    const deps = criticalDependencies(ctx);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ id: "BOX", dependents: ["CA", "CB", "CC"], coverageLoss: 1 });
  });

  it("il nodo guasto resta nel risultato con stato failed; senza guasti nulla cambia", () => {
    const r = evaluateFailure(ctx, {});
    expect(r.failed).toEqual([]);
    expect(r.cutOff).toEqual([]);
    expect(r.connections.before).toBe(r.connections.after);
    expect(Object.values(r.states).every((s) => s === "connected")).toBe(true);
    expect(JSON.parse(JSON.stringify(evaluateFailure(ctx, { nodes: ["BOX"] }))).states.BOX).toBe("failed");
  });

  it("un nodo sconosciuto o duplicato è un errore, non un risultato silenzioso", () => {
    expect(() => evaluateFailure(ctx, { nodes: ["NOPE"] })).toThrow(/sconosciuto/);
    expect(() => createResilienceContext({ nodes: [node("A", "box"), node("A", "card")], edges: [] })).toThrow(/duplicato/);
    expect(() => createResilienceContext({ nodes: [node("A", "box")], edges: [edge("A", "B")] })).toThrow(/sconosciuto/);
  });
});

describe("resilienza: percorsi alternativi, punti critici, smartphone", () => {
  it("con due infrastrutture una Card collegata a entrambe sopravvive al guasto di una; il suo percorso può cambiare", () => {
    const ctx = createResilienceContext({
      nodes: [node("BOX", "box"), node("PORT", "portable"), node("R", "relay"), node("C1", "card")],
      edges: [edge("BOX", "R"), edge("R", "C1"), edge("PORT", "C1")],
    });
    const r = evaluateFailure(ctx, { nodes: ["BOX"] });
    expect(r.cutOff).toEqual([]);
    expect(r.states).toMatchObject({ R: "connected", C1: "connected" });
    // R era a 1 salto dal Box e ora è a 2 dal Portable (via C1); C1 resta a 1 salto
    expect(r.rerouted).toEqual([{ id: "R", hopsBefore: 1, hopsAfter: 2 }]);
    expect(criticalDependencies(ctx).some((d) => d.dependents.length > 0)).toBe(false);
  });

  it("in una catena Box–R–C1–C2 ogni nodo è critico per quelli oltre: R più di C1", () => {
    const ctx = createResilienceContext({
      nodes: [node("BOX", "box"), node("R", "relay"), node("C1", "card"), node("C2", "card")],
      edges: [edge("BOX", "R"), edge("R", "C1"), edge("C1", "C2")],
    });
    const deps = criticalDependencies(ctx);
    expect(deps.map((d) => d.id)).toEqual(["BOX", "R", "C1"]);
    expect(deps[1].dependents).toEqual(["C1", "C2"]);
    expect(deps[2].dependents).toEqual(["C2"]);
    const rank = rankSingleFailures(ctx);
    expect(rank.map((f) => f.id)).toEqual(["BOX", "R", "C1", "C2"]);
    expect(rank.find((f) => f.id === "C2")!.critical).toBe(false);
  });

  it("gli smartphone che dipendono dalla propria Card non rendono critica la Card", () => {
    const ctx = createResilienceContext({
      nodes: [node("BOX", "box"), node("C1", "card"), node("S1", "phone")],
      edges: [edge("BOX", "C1"), { a: "C1", b: "S1", tech: "ble", rateBps: 1e6 }],
    });
    const r = evaluateFailure(ctx, { nodes: ["C1"] });
    expect(r.cutOff).toEqual(["S1"]);
    expect(criticalDependencies(ctx).some((d) => d.id === "C1")).toBe(false); // la Card non è critica per i suoi smartphone (il Box sì, per la Card)
    expect(rankSingleFailures(ctx).find((f) => f.id === "C1")).toMatchObject({ critical: false, phoneCutOff: ["S1"] });
    // se la Card serve anche un'altra Card, resta critica e l'elenco degli smartphone è informativo
    const ctx2 = createResilienceContext({
      nodes: [node("BOX", "box"), node("C1", "card"), node("C2", "card"), node("S1", "phone")],
      edges: [edge("BOX", "C1"), edge("C1", "C2"), { a: "C1", b: "S1", tech: "ble", rateBps: 1e6 }],
    });
    expect(criticalDependencies(ctx2).find((d) => d.id === "C1")).toMatchObject({ dependents: ["C2"], phoneDependents: ["S1"] });
  });

  it("senza alcuna infrastruttura attiva nessun nodo è connesso", () => {
    const ctx = createResilienceContext({ nodes: [node("BOX", "box", true), node("C1", "card")], edges: [] });
    expect(evaluateFailure(ctx, {}).states.C1).toBe("isolated");
    expect(evaluateFailure(ctx, {}).states.BOX).toBe("failed");
  });
});

describe("resilienza: connettività opportunistica", () => {
  // BOX isolato dal resto; un portatore MULE incontra C1 e più tardi il Box
  const nodes = [node("BOX", "box"), node("C1", "card"), node("MULE", "card")];
  const timeline = (order: "c1-then-box" | "box-then-c1") => ({
    fromS: 0,
    steps: [
      { t: 0, edges: [edge("MULE", order === "c1-then-box" ? "C1" : "BOX")] },
      { t: 60, edges: [] },
      { t: 120, edges: [edge("MULE", order === "c1-then-box" ? "BOX" : "C1")] },
    ],
  });

  it("direttamente C1 è tagliata fuori, ma un portatore che incontra prima C1 e poi il Box la recupera", () => {
    const ctx = createResilienceContext({ nodes, edges: [edge("MULE", "C1")], timeline: timeline("c1-then-box") });
    const r = evaluateFailure(ctx, {});
    expect(r.states.C1).toBe("recoverable");
    expect(r.recoverable.find((x) => x.id === "C1")).toEqual({ id: "C1", arrivalS: 120, newlyCutOff: false });
    expect(r.opportunistic).toBe(true);
  });

  it("l'ordine dei contatti conta: se il portatore incontra il Box PRIMA di C1, C1 non è recuperabile", () => {
    const ctx = createResilienceContext({ nodes, edges: [edge("MULE", "BOX")], timeline: timeline("box-then-c1") });
    const r = evaluateFailure(ctx, {});
    expect(r.recoverable.map((x) => x.id)).not.toContain("C1");
    expect(r.states.C1).toBe("isolated");
  });

  it("spegnendo il portatore il gap non è più recuperabile", () => {
    const ctx = createResilienceContext({ nodes, edges: [edge("MULE", "C1")], timeline: timeline("c1-then-box") });
    const r = evaluateFailure(ctx, { nodes: ["MULE"] });
    expect(r.recoverable).toEqual([]);
    expect(r.states.C1).toBe("isolated");
  });

  it("i contatti precedenti al guasto non contano: la finestra parte da atS e gli arrivi si misurano da lì (regressione)", () => {
    const ctx = createResilienceContext({
      nodes: [node("BOX", "box"), node("PORT", "portable"), node("C1", "card"), node("MULE", "card")],
      edges: [edge("BOX", "C1")],
      atS: 100,
      timeline: {
        fromS: 0,
        steps: [
          { t: 0, edges: [edge("MULE", "C1")] },     // prima del guasto: C1 incontra il portatore
          { t: 50, edges: [edge("MULE", "PORT")] },  // prima del guasto: il portatore incontra il Port
          { t: 150, edges: [edge("MULE", "C1")] },
          { t: 200, edges: [edge("MULE", "PORT")] },
        ],
      },
    });
    const rec = evaluateFailure(ctx, { nodes: ["BOX"] }).recoverable.find((x) => x.id === "C1");
    expect(rec).toEqual({ id: "C1", arrivalS: 100, newlyCutOff: true }); // 200 − atS; senza la regola sarebbe 50
  });

  it("un nodo connesso prima del guasto e recuperabile dopo è segnato come perdita causata dal guasto (newlyCutOff)", () => {
    const ctx = createResilienceContext({
      nodes: [node("BOX", "box"), node("PORT", "portable"), node("C1", "card"), node("MULE", "card")],
      edges: [edge("PORT", "C1")],
      timeline: { fromS: 0, steps: [{ t: 0, edges: [edge("PORT", "C1")] }, { t: 300, edges: [edge("MULE", "C1")] }, { t: 600, edges: [edge("MULE", "BOX")] }] },
    });
    const r = evaluateFailure(ctx, { nodes: ["PORT"] });
    expect(r.cutOff).toEqual(["C1"]);
    expect(r.recoverable.find((x) => x.id === "C1")).toEqual({ id: "C1", arrivalS: 600, newlyCutOff: true });
  });
});

describe("resilienza: guasti d'area e ostacoli", () => {
  const frame = { lat0: 0, lon0: 0 };
  const positions = { BOX: { x: 0, y: 0 }, R: { x: 3000, y: 0 }, C1: { x: 6000, y: 0 }, C2: { x: 6000, y: 4000 } };
  const spec = (extra: Partial<ResilienceGraphSpec> = {}): ResilienceGraphSpec => ({
    nodes: [node("BOX", "box"), node("R", "relay"), node("C1", "card"), node("C2", "card")],
    edges: [
      edge("BOX", "R", { ax: 0, ay: 0, bx: 3000, by: 0 }),
      edge("R", "C1", { ax: 3000, ay: 0, bx: 6000, by: 0 }),
      edge("R", "C2", { ax: 3000, ay: 0, bx: 6000, by: 4000 }),
    ],
    positions, frame, ...extra,
  });

  it("un'area circolare spegne i nodi che contiene (coordinate locali)", () => {
    const r = evaluateFailure(createResilienceContext(spec()), { areas: [{ shape: { kind: "circle", center: { x: 3000, y: 0 }, radiusM: 500 } }] });
    expect(r.failed).toEqual(["R"]);
    expect(r.cutOff.sort()).toEqual(["C1", "C2"]);
  });

  it("un'area poligonale e una circolare in coordinate geografiche", () => {
    const ctx = createResilienceContext(spec());
    const poly = evaluateFailure(ctx, { areas: [{ shape: { kind: "polygon", points: [{ x: 5000, y: -500 }, { x: 7000, y: -500 }, { x: 7000, y: 500 }, { x: 5000, y: 500 }] } }] });
    expect(poly.failed).toEqual(["C1"]);
    const m = 111_320; // metri per grado di longitudine all'equatore
    const geo = evaluateFailure(ctx, { areas: [{ shape: { kind: "circle", center: { lat: 0, lon: 6000 / m }, radiusM: 300 } }] });
    expect(geo.failed).toEqual(["C1"]);
  });

  it("senza frame un'area geografica è un errore; un poligono con meno di 3 punti anche", () => {
    const ctx = createResilienceContext(spec({ frame: undefined }));
    expect(() => evaluateFailure(ctx, { areas: [{ shape: { kind: "circle", center: { lat: 0, lon: 0 }, radiusM: 1 } }] })).toThrow(/frame/);
    expect(() => evaluateFailure(createResilienceContext(spec()), { areas: [{ shape: { kind: "polygon", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }] })).toThrow(/3 punti/);
  });

  it("un'area-ostacolo senza spegnere nodi taglia i link che la attraversano e solo quelli", () => {
    const ctx = createResilienceContext(spec());
    const block = { shape: { kind: "circle" as const, center: { x: 1500, y: 0 }, radiusM: 200 }, failNodes: false, blockLossDb: 80 };
    const edges = residualEdges(ctx, { areas: [block] });
    expect(edges.map((e) => `${e.a}-${e.b}`).sort()).toEqual(["R-C1", "R-C2"]);
    const r = evaluateFailure(ctx, { areas: [block] });
    expect(r.failed).toEqual([]);
    expect(r.cutOff.sort()).toEqual(["C1", "C2", "R"]);
  });

  it("con il modello radio un ostacolo attenua e solo se la perdita supera il margine il link cade", () => {
    // il modello dice che il link sopravvive solo con perdite aggiuntive sotto i 30 dB
    const ctx = createResilienceContext(spec({ reevaluate: (_e, _t, loss) => loss < 30 }));
    const area = (db: number) => ({ shape: { kind: "circle" as const, center: { x: 1500, y: 0 }, radiusM: 200 }, failNodes: false, blockLossDb: db });
    expect(residualEdges(ctx, { areas: [area(20)] })).toHaveLength(3);
    expect(residualEdges(ctx, { areas: [area(40)] })).toHaveLength(2);
    expect(residualEdges(ctx, { areas: [{ ...area(0) }] })).toHaveLength(3);
  });

  it("un ostacolo poligonale con un vertice esattamente sul link lo interrompe (tocco)", () => {
    const ctx = createResilienceContext(spec());
    // triangolo sopra il link BOX–R (y=0) con un solo vertice che tocca la retta
    const tri = { shape: { kind: "polygon" as const, points: [{ x: 1500, y: 0 }, { x: 1700, y: 300 }, { x: 1300, y: 300 }] }, failNodes: false, blockLossDb: 80 };
    expect(residualEdges(ctx, { areas: [tri] }).map((e) => `${e.a}-${e.b}`)).not.toContain("BOX-R");
  });

  it("un ostacolo allineato a un lato del poligono non lascia passare il link", () => {
    const ctx = createResilienceContext(spec());
    // lato del rettangolo collineare con il link BOX–R, lungo y=0
    const rect = { shape: { kind: "polygon" as const, points: [{ x: 1000, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: -300 }, { x: 1000, y: -300 }] }, failNodes: false, blockLossDb: 80 };
    expect(residualEdges(ctx, { areas: [rect] }).map((e) => `${e.a}-${e.b}`)).not.toContain("BOX-R");
  });

  it("guasto multiplo: nodi esplicitati più area, senza duplicati", () => {
    const ctx = createResilienceContext(spec());
    const r = evaluateFailure(ctx, { nodes: ["R", "C1"], areas: [{ shape: { kind: "circle", center: { x: 3000, y: 0 }, radiusM: 100 } }] });
    expect(r.failed.sort()).toEqual(["C1", "R"]);
  });
});

describe("Resilience Score: definito dal modello", () => {
  it("rete ridondante (Card collegate a due infrastrutture): punteggio massimo", () => {
    const ctx = createResilienceContext({
      nodes: [node("BOX", "box"), node("PORT", "portable"), node("C1", "card"), node("C2", "card")],
      edges: [edge("BOX", "C1"), edge("PORT", "C1"), edge("BOX", "C2"), edge("PORT", "C2")],
    });
    const s = resilienceScore(ctx);
    expect(s.score).toBeCloseTo(100, 9);
    expect(s.criticalNodes).toEqual([]);
    expect(s.worstSingleFailure).toBeNull();
    // senza copertura né mobilità le componenti non calcolabili sono escluse
    expect(s.components.filter((c) => c.value === null).map((c) => c.key).sort()).toEqual(["coverage", "coverageUnderFailure", "opportunisticRecovery", "reachability"]);
  });

  it("catena Box–R–C1 con copertura: valori esatti delle quattro componenti e punteggio 60", () => {
    const ctx = createResilienceContext({
      nodes: [node("BOX", "box"), node("R", "relay"), node("C1", "card")],
      edges: [edge("BOX", "R"), edge("R", "C1")],
      coverage: coverage(10, { BOX: range(0, 4), R: [5, 6], C1: range(7, 9) }),
    });
    const s = resilienceScore(ctx);
    const v = Object.fromEntries(s.components.map((c) => [c.key, c.value]));
    expect(v.coverage).toBe(1);
    expect(v.directConnectivity).toBe(1);
    expect(v.redundancy).toBe(0); // guasto del Box taglia fuori R e C1
    // perdita di copertura connessa: Box → 1.0, R → 0.5, C1 → 0.3 (e il Box stesso 0.0 se non dipendesse da nessuno); ritenzione media
    expect(v.coverageUnderFailure).toBeCloseTo((0 + 0.5 + 0.7) / 3, 9);
    expect(v.opportunisticRecovery).toBeNull();
    expect(s.score).toBeCloseTo((100 * (1 + 1 + 0 + 0.4)) / 4, 9);
    expect(s.criticalNodes).toEqual(["BOX", "R"]);
    expect(s.worstSingleFailure).toEqual({ id: "BOX", cutOff: 2 });
  });

  it("una rete inutilizzabile non riceve punti per aver 'conservato' poco: la copertura sotto guasto è assoluta", () => {
    const dead = createResilienceContext({
      nodes: [node("BOX", "box", true), node("C1", "card"), node("C2", "card")],
      edges: [edge("C1", "C2")],
      coverage: coverage(10, { C1: range(0, 4), C2: range(5, 9) }),
    });
    const s = resilienceScore(dead);
    const v = Object.fromEntries(s.components.map((c) => [c.key, c.value]));
    expect(v.coverage).toBe(0);
    expect(v.coverageUnderFailure).toBe(0);
    expect(v.directConnectivity).toBe(0);
    expect(s.score).toBe(0);
  });

  it("copertura sotto guasto = media assoluta della copertura connessa residua dopo ogni guasto singolo", () => {
    const ctx = createResilienceContext({
      nodes: [node("BOX", "box"), node("PORT", "portable"), node("C1", "card")],
      edges: [edge("BOX", "C1"), edge("PORT", "C1")],
      coverage: coverage(10, { BOX: range(0, 3), PORT: range(4, 7), C1: [8, 9] }),
    });
    const v = resilienceScore(ctx).components.find((c) => c.key === "coverageUnderFailure")!.value!;
    // nessun guasto taglia fuori nessuno; perde solo l'alone del nodo spento: BOX −0.4, PORT −0.4, C1 −0.2 → medie 0.6, 0.6, 0.8
    expect(v).toBeCloseTo((0.6 + 0.6 + 0.8) / 3, 9);
  });

  it("i pesi sono parametri: azzerare una componente la esclude, e tutti a zero dà 0", () => {
    const ctx = createResilienceContext({
      nodes: [node("BOX", "box"), node("R", "relay"), node("C1", "card")],
      edges: [edge("BOX", "R"), edge("R", "C1")],
    });
    expect(resilienceScore(ctx).score).toBeCloseTo(50, 9); // diretta 1, ridondanza 0
    expect(resilienceScore(ctx, { coverage: 1, directConnectivity: 0, reachability: 1, redundancy: 1, coverageUnderFailure: 1, opportunisticRecovery: 1 }).score).toBe(0);
    expect(resilienceScore(ctx, { coverage: 0, directConnectivity: 0, reachability: 0, redundancy: 0, coverageUnderFailure: 0, opportunisticRecovery: 0 }).score).toBe(0);
  });

  it("il recupero opportunistico alza il punteggio rispetto alla stessa rete senza mobilità (servono due infrastrutture: con una sola non c'è nulla da raggiungere)", () => {
    const nodes = [node("BOX", "box"), node("PORT", "portable"), node("C1", "card"), node("MULE", "card")];
    const edges = [edge("BOX", "C1")];
    const without = resilienceScore(createResilienceContext({ nodes, edges }));
    const withMule = resilienceScore(createResilienceContext({
      nodes, edges,
      timeline: { fromS: 0, steps: [{ t: 0, edges: [edge("BOX", "C1")] }, { t: 60, edges: [edge("MULE", "C1")] }, { t: 120, edges: [edge("MULE", "PORT")] }] },
    }));
    expect(withMule.components.find((c) => c.key === "opportunisticRecovery")!.value).toBe(1);
    expect(withMule.recoverableGaps).toContain("C1");
    expect(withMule.score).toBeGreaterThan(without.score);
  });

  it("con una sola infrastruttura il suo guasto non è recuperabile: nessun sink da raggiungere", () => {
    const ctx = createResilienceContext({
      nodes: [node("BOX", "box"), node("C1", "card"), node("MULE", "card")],
      edges: [edge("BOX", "C1")],
      timeline: { fromS: 0, steps: [{ t: 0, edges: [edge("BOX", "C1")] }, { t: 60, edges: [edge("MULE", "C1")] }, { t: 120, edges: [edge("MULE", "BOX")] }] },
    });
    expect(evaluateFailure(ctx, { nodes: ["BOX"] }).recoverable).toEqual([]);
  });
});

describe("raggiungibilità di base e perdite nel tempo", () => {
  it("un corriere rende raggiungibile un nodo non connesso direttamente: la raggiungibilità supera la connettività diretta", () => {
    const nodes = [node("PORT", "portable"), node("C1", "card"), node("C2", "card"), node("MULE", "card")];
    const edges = [edge("MULE", "C1")];
    const noMule = resilienceScore(createResilienceContext({ nodes, edges, timeline: { fromS: 0, steps: [{ t: 0, edges }] } }));
    const mule = resilienceScore(createResilienceContext({
      nodes, edges,
      timeline: { fromS: 0, steps: [{ t: 0, edges }, { t: 60, edges: [edge("MULE", "PORT")] }, { t: 120, edges: [edge("MULE", "C2")] }] },
    }));
    const get = (s: ReturnType<typeof resilienceScore>, k: string) => s.components.find((c) => c.key === k)!.value!;
    expect(get(mule, "directConnectivity")).toBe(0);
    expect(get(noMule, "reachability")).toBe(0);
    // C1 e MULE raggiungono il Port (il portatore lo incontra dopo C1); C2 lo incontra solo dopo: non può più recapitare
    expect(get(mule, "reachability")).toBeCloseTo(2 / 3, 9);
    expect(mule.score).toBeGreaterThan(noMule.score);
  });

  it("senza analisi temporale la raggiungibilità non è calcolabile ed è esclusa", () => {
    const s = resilienceScore(createResilienceContext({ nodes: [node("PORT", "portable"), node("C1", "card")], edges: [edge("PORT", "C1")] }));
    expect(s.components.find((c) => c.key === "reachability")!.value).toBeNull();
  });
});

describe("resilienza sul modello radio (esempio Eolie con aliscafo)", () => {
  const cfg = parseNetworkConfig(JSON.parse(readFileSync("tools/scenario-model/examples/eolie-resilienza.json", "utf8")));
  const nodes = placeDevices(cfg, EOLIE_TERRAIN);
  const p = paramsForConfig(cfg, EOLIE_TERRAIN);
  const window = { fromS: 0, toS: 12600, stepS: 60 };
  const ctx = prepareResilience({ params: p, nodes, window, frame: cfg.frame });

  it("rete integra: Box, relay di Panarea e Portable sono i punti critici", () => {
    const deps = criticalDependencies(ctx);
    expect(deps.map((d) => d.id).sort()).toEqual(["BOX", "FR", "PORT"]);
    expect(deps.find((d) => d.id === "FR")!.dependents.sort()).toEqual(["C2", "C3"]);
    expect(deps.find((d) => d.id === "PORT")!.dependents).toEqual(["C5"]);
    expect(deps.some((d) => d.id === "C4")).toBe(false);
  });

  it("spegnendo il Portable, C5 è tagliata fuori direttamente ma recuperabile dall'aliscafo; senza aliscafo no", () => {
    const r = evaluateFailure(ctx, { nodes: ["PORT"] });
    expect(r.cutOff).toEqual(["C5"]);
    expect(r.states.C5).toBe("recoverable");
    const rec = r.recoverable.find((x) => x.id === "C5")!;
    expect(rec.newlyCutOff).toBe(true);
    expect(rec.arrivalS).toBeGreaterThan(5400); // l'aliscafo arriva a Stromboli dopo le 1h30
    expect(rec.arrivalS).toBeLessThan(7200);
    const both = evaluateFailure(ctx, { nodes: ["PORT", "C4"] });
    expect(both.recoverable.find((x) => x.id === "C5")).toBeUndefined();
    expect(both.states.C5).toBe("isolated");
  });

  it("una perdita aggiuntiva nel tempo (perturbazione) può impedire il recupero, senza toccare il grafo diretto all'istante del guasto", () => {
    const storm = prepareResilience({ params: p, nodes, window, frame: cfg.frame, extraLossDb: (tS) => (tS >= 1800 ? 80 : 0) });
    expect(criticalDependencies(storm).map((d) => d.id).sort()).toEqual(["BOX", "FR", "PORT"]); // istante 0: nessun effetto
    const r = evaluateFailure(storm, { nodes: ["PORT"] });
    expect(r.cutOff).toEqual(["C5"]);
    expect(r.recoverable).toEqual([]); // dopo le 0h30 nessun link regge più: l'aliscafo non può trasportare nulla
    // con una perdita costante lieve il recupero resta
    const mild = prepareResilience({ params: p, nodes, window, frame: cfg.frame, extraLossDb: () => 1 });
    expect(evaluateFailure(mild, { nodes: ["PORT"] }).recoverable.map((x) => x.id)).toContain("C5");
  });

  it("window: false disattiva l'analisi temporale; senza finestra e senza nodi mobili vale come rete statica", () => {
    const direct = prepareResilience({ params: p, nodes, frame: cfg.frame, window: false });
    const r = evaluateFailure(direct, { nodes: ["PORT"] });
    expect(r.opportunistic).toBe(false);
    expect(r.recoverable).toEqual([]);
    expect(r.states.C5).toBe("isolated");
    expect(r.cutOff).toEqual(["C5"]);
  });

  it("senza finestra la si ricava dai percorsi dei nodi: l'aliscafo viene considerato da solo", () => {
    const auto = prepareResilience({ params: p, nodes, frame: cfg.frame });
    expect(auto.spec.timeline!.steps.length).toBeGreaterThan(100);
    expect(evaluateFailure(auto, { nodes: ["PORT"] }).recoverable.map((x) => x.id)).toContain("C5");
  });

  it("senza nodi mobili la rete è statica: raggiungibilità = connettività diretta, recupero 0% (confrontabile con una rete con un portatore)", () => {
    const fixed = nodes.filter((n) => n.id !== "C4");
    const ctxStatic = prepareResilience({ params: p, nodes: fixed, frame: cfg.frame });
    expect(ctxStatic.spec.timeline!.steps).toHaveLength(1);
    const s = resilienceScore(ctxStatic);
    const v = Object.fromEntries(s.components.map((c) => [c.key, c.value]));
    expect(v.reachability).toBe(v.directConnectivity);
    expect(v.opportunisticRecovery).toBe(0);
    expect(s.recoverableGaps).toEqual([]);
    // con l'aliscafo la stessa rete vale di più: l'aliscafo non può che aiutare, non penalizzare
    expect(resilienceScore(ctx).score).toBeGreaterThan(s.score);
  });

  it("guasto d'area attorno a Panarea: spegne relay e Card dell'isola, la copertura connessa scende", () => {
    const r = evaluateFailure(ctx, { areas: [{ shape: { kind: "circle", center: { lat: 38.636, lon: 15.066 }, radiusM: 3000 } }] });
    expect(r.failed.sort()).toEqual(["C3", "FR"]);
    expect(r.cutOff).toEqual(["C2"]);
    expect(r.coverage!.connectedAfter).toBeLessThan(r.coverage!.connectedBefore * 0.5);
    expect(r.lostCells.length).toBeGreaterThan(0);
  });

  it("un ostacolo sulla tratta Lipari–Panarea (60 dB) taglia il relay dal Box senza spegnere nodi", () => {
    const area = { shape: { kind: "circle" as const, center: { lat: 38.55, lon: 15.0 }, radiusM: 1500 }, failNodes: false, blockLossDb: 60 };
    const edges = residualEdges(ctx, { areas: [area] });
    expect(edges.some((e) => (e.a === "BOX" && e.b === "FR") || (e.a === "FR" && e.b === "BOX"))).toBe(false);
    expect(residualEdges(ctx, {}).some((e) => (e.a === "BOX" && e.b === "FR") || (e.a === "FR" && e.b === "BOX"))).toBe(true);
  });

  it("punteggio completo con tutte le componenti, stabile e riproducibile", () => {
    const a = resilienceScore(ctx);
    const b = resilienceScore(ctx);
    expect(a).toEqual(b);
    expect(a.components.every((c) => c.value !== null)).toBe(true);
    expect(a.score).toBeGreaterThan(0);
    expect(a.score).toBeLessThan(100);
    expect(a.recoverableGaps).toContain("C5");
  });

  it("il formattatore produce tabelle senza lanciare, con i nomi dei nodi", () => {
    const text = [...formatFailureReport(evaluateFailure(ctx, { nodes: ["PORT"] })), ...formatScore(resilienceScore(ctx)), ...formatSingleFailures(rankSingleFailures(ctx))].join("\n");
    expect(text).toContain("PORT");
    expect(text).toContain("Resilience Score");
    expect(text).toContain("C5");
  });
});

describe("finestra opportunistica: validazione", () => {
  const cfg = parseNetworkConfig(JSON.parse(readFileSync("tools/scenario-model/examples/eolie-resilienza.json", "utf8")));
  const nodes = placeDevices(cfg, EOLIE_TERRAIN);
  const params = paramsForConfig(cfg, EOLIE_TERRAIN);
  const prep = (window: { fromS: number; toS: number; stepS: number }) => () => prepareResilience({ params, nodes, atS: 0, window, frame: cfg.frame, skipCoverage: true });

  it("rifiuta valori non finiti, passi non positivi, finestre invertite", () => {
    expect(prep({ fromS: NaN, toS: 100, stepS: 60 })).toThrow(/non valida/);
    expect(prep({ fromS: 0, toS: NaN, stepS: 60 })).toThrow(/non valida/);
    expect(prep({ fromS: 0, toS: 100, stepS: 0 })).toThrow(/non valida/);
    expect(prep({ fromS: 100, toS: 0, stepS: 60 })).toThrow(/non valida/);
  });

  it("rifiuta una finestra con troppi istanti", () => {
    expect(prep({ fromS: 0, toS: 100_000, stepS: 1 })).toThrow(/troppo fine/);
  });
});

describe("guasti singoli: la tabella delle dipendenze non è calcolata nei cicli interni", () => {
  it("evaluateFailure con dependencies:false restituisce lo stesso resto del report", () => {
    const ctx = createResilienceContext({ nodes: [node("BOX", "box"), node("R", "relay"), node("C", "card")], edges: [edge("BOX", "R"), edge("R", "C")] });
    const full = evaluateFailure(ctx, { nodes: ["R"] });
    const lean = evaluateFailure(ctx, { nodes: ["R"] }, { dependencies: false });
    expect(lean.dependencies).toEqual([]);
    expect({ ...lean, dependencies: full.dependencies }).toEqual(full);
  });
});

describe("configurazione: percorsi dei dispositivi mobili", () => {
  const base = JSON.parse(readFileSync("tools/scenario-model/examples/eolie-resilienza.json", "utf8"));
  const withRoute = (route: unknown) => ({ ...base, devices: base.devices.map((d: { id: string }) => (d.id === "C4" ? { ...d, route } : d)) });

  it("accetta un percorso valido e lo trasforma in waypoint con quota sul terreno", () => {
    const cfg = parseNetworkConfig(base);
    const c4 = placeDevices(cfg, EOLIE_TERRAIN).find((n) => n.id === "C4")!;
    expect(c4.path).toHaveLength(11);
    expect(c4.path[0].t).toBe(0);
    expect(c4.path[10].t).toBe(12600);
    expect(c4.path.every((w) => w.z >= 3)).toBe(true);
  });

  it("rifiuta un percorso con più di 10000 punti", () => {
    const many = Array.from({ length: 10001 }, (_, i) => ({ tS: i, lat: 38.4, lon: 14.9 }));
    expect(() => parseNetworkConfig(withRoute(many))).toThrow(/10000/);
  });

  it("rifiuta un percorso con meno di 2 punti, istanti non crescenti o numeri non validi", () => {
    expect(() => parseNetworkConfig(withRoute([{ tS: 0, lat: 38.4, lon: 14.9 }]))).toThrow(/2 punti/);
    expect(() => parseNetworkConfig(withRoute([{ tS: 10, lat: 38.4, lon: 14.9 }, { tS: 10, lat: 38.5, lon: 15 }]))).toThrow(/crescenti/);
    expect(() => parseNetworkConfig(withRoute([{ tS: 0, lat: 38.4, lon: 14.9 }, { tS: 5, lat: "x", lon: 15 }]))).toThrow(/lat/);
    expect(() => parseNetworkConfig(withRoute("no"))).toThrow(/route/);
  });
});
