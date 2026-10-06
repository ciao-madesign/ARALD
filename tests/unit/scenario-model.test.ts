import { describe, expect, it } from "vitest";
import {
  ARALD_QUEUE_TTL_S, DEFAULT_PHY, DEFAULT_SHORT_RANGE, EU868_G1, EU868_G3, LEGACY_QUEUE_TTL_S, type ModelParams, type NodeSpec,
  effectiveEirpDbm, loraLink, loraTimeOnAir, pathLossDb, positionAt, simulate,
} from "../../tools/scenario-model/model.js";
import { ENVIRONMENTS, benchmarkMessages, buildNodes } from "../../tools/scenario-model/valle-maira.js";
import * as S2 from "../../tools/scenario-model/alpino-frammentato.js";

const params = (env: keyof typeof ENVIRONMENTS, reg = EU868_G1): ModelParams => ({
  env: ENVIRONMENTS[env], reg, phy: DEFAULT_PHY, shortRange: DEFAULT_SHORT_RANGE,
  loraFrameBytes: 222, loraFrameOverheadBytes: 22, protocolOverhead: 1.45, channelEfficiency: 0.5, maxSf: 12,
});

describe("scenario-model: fisica radio", () => {
  it("time-on-air coincide con il calcolatore Semtech (SF7/125 kHz/CR4/5, 20 B → 56,6 ms)", () => {
    expect(loraTimeOnAir(20, 7) * 1000).toBeCloseTo(56.58, 1);
  });

  it("attiva il low-data-rate-optimize a SF11/SF12 (simbolo > 16 ms)", () => {
    // SF12, 20 B, DE=1: 40,25 simboli × 32,768 ms = 1318,9 ms (stesso valore dei calcolatori di airtime pubblici)
    expect(loraTimeOnAir(20, 12) * 1000).toBeCloseTo(1318.9, 0);
  });

  it("path loss a esponente 2 = spazio libero (868 MHz, 1 km ≈ 91,2 dB)", () => {
    expect(pathLossDb(1000, 2)).toBeCloseTo(91.2, 0);
  });

  it("l'EIRP è limitata sia dalla norma (ERP + 2,15) sia dall'hardware SX1262 (+22 dBm + antenna)", () => {
    expect(effectiveEirpDbm(22, -3, EU868_G1)).toBeCloseTo(16.15, 2); // Card in g1: limite normativo
    expect(effectiveEirpDbm(22, -3, EU868_G3)).toBe(19);              // Card in g3: limite hardware
    expect(effectiveEirpDbm(22, 3, EU868_G3)).toBe(25);               // Box in g3: limite hardware
  });

  it("più EIRP consentita = SF più veloce (o link che chiude) a parità di geometria", () => {
    const a: NodeSpec = { id: "A", kind: "box", path: [{ x: 0, y: 0, z: 0, t: 0 }] };
    const b: NodeSpec = { id: "B", kind: "box", path: [{ x: 10000, y: 0, z: 0, t: 0 }] };
    const pa = positionAt(a.path, 0);
    const pb = positionAt(b.path, 0);
    const low = loraLink(a, pa, b, pb, params("tipico", EU868_G1));
    const high = loraLink(a, pa, b, pb, params("tipico", EU868_G3));
    expect(high).not.toBeNull();
    expect(low === null || low.sf! > high!.sf!).toBe(true);
  });

  it("positionAt interpola linearmente e resta fermo agli estremi", () => {
    const path = [{ x: 0, y: 0, z: 0, t: 0 }, { x: 100, y: 0, z: 10, t: 10 }];
    expect(positionAt(path, 5)).toEqual({ x: 50, y: 0, z: 5 });
    expect(positionAt(path, 99)).toEqual(path[1]);
    expect(positionAt(path, -1)).toEqual(path[0]);
  });
});

describe("scenario-model: simulazione Valle Maira", () => {
  const H = 3600;

  it("rientro del gruppo: ogni file arriva via Wi-Fi al Campo Base anche in condizioni severe", () => {
    const r = simulate({ nodes: buildNodes("return"), messages: benchmarkMessages(), params: params("severo"), horizonS: 10 * H, stepS: 10, policy: "custody" });
    for (const d of r.deliveries) expect(d.deliveredAt).not.toBeNull();
  });

  it("data mule in condizioni severe: la coda precedente (SOS scaduto dopo 30 min) perdeva l'SOS, una coda DTN lo consegna", () => {
    const base = { nodes: buildNodes("ferry"), messages: benchmarkMessages(), params: params("severo"), horizonS: 10 * H, stepS: 10, policy: "custody" as const };
    const legacy = simulate({ ...base, relayCarryTtlS: LEGACY_QUEUE_TTL_S });
    const dtn = simulate({ ...base });
    expect(legacy.deliveries.find((d) => d.messageId === "F1")!.deliveredAt).toBeNull();
    expect(dtn.deliveries.find((d) => d.messageId === "F1")!.deliveredAt).not.toBeNull();
  });

  it("data mule in condizioni severe con la coda attuale: l'SOS arriva, rapporto e foto (TTL 5 min) no", () => {
    const r = simulate({ nodes: buildNodes("ferry"), messages: benchmarkMessages(), params: params("severo"), horizonS: 10 * H, stepS: 10, policy: "custody", relayCarryTtlS: ARALD_QUEUE_TTL_S });
    expect(r.deliveries.find((d) => d.messageId === "F1")!.deliveredAt).not.toBeNull();
    expect(r.deliveries.find((d) => d.messageId === "F4")!.deliveredAt).toBeNull();
    expect(r.deliveries.find((d) => d.messageId === "F3")!.deliveredAt).toBeNull();
  });

  it("un link SF12 trasporta davvero dati (il frame da ~8 s supera il budget di canale di un singolo passo)", () => {
    const nodes: NodeSpec[] = [
      { id: "A", kind: "card", path: [{ x: 0, y: 0, z: 0, t: 0 }] },
      { id: "B", kind: "card", path: [{ x: 0, y: 0, z: 0, t: 0 }] },
    ];
    nodes[1].path = [{ x: 6000, y: 0, z: 0, t: 0 }];
    const p = { ...params("tipico"), maxSf: 12 as const };
    expect(loraLink(nodes[0], positionAt(nodes[0].path, 0), nodes[1], positionAt(nodes[1].path, 0), p)?.sf).toBe(12);
    const r = simulate({ nodes, messages: [{ id: "M", label: "", sizeBytes: 100, priority: 0, source: "A", destination: "B", createdAt: 0 }], params: p, horizonS: 120, stepS: 10, policy: "custody" });
    expect(r.deliveries[0].deliveredAt).not.toBeNull();
  });

  it("policy epidemic: un relay con percorso verso la destinazione non scarta la copia per TTL", () => {
    const nodes: NodeSpec[] = ["A", "R", "D"].map((id, i) => ({ id, kind: "card" as const, path: [{ x: i * 20, y: 0, z: 0, t: 0 }] }));
    const r = simulate({ nodes, messages: [{ id: "M", label: "", sizeBytes: 50_000, priority: 3, source: "A", destination: "D", createdAt: 0 }], params: params("tipico"), horizonS: 600, stepS: 10, policy: "epidemic", relayCarryTtlS: () => 0 });
    expect(r.deliveries[0].deliveredAt).not.toBeNull();
  });

  it("il duty-cycle limita davvero l'airtime: nessun nodo supera il budget dell'1% nell'orizzonte", () => {
    const r = simulate({ nodes: buildNodes("static"), messages: benchmarkMessages(), params: params("tipico"), horizonS: 6 * H, stepS: 10, policy: "custody" });
    const totalAir = r.deliveries.reduce((s, d) => s + d.loraAirtimeS, 0);
    // 7 nodi LoRa × (bucket iniziale 36 s + 1% di 6 h)
    expect(totalAir).toBeLessThanOrEqual(7 * (36 + 0.01 * 6 * H) + 1e-6);
    expect(totalAir).toBeGreaterThan(0);
  });

  it("perdita della Card intermedia C4 in condizioni tipiche isola C5 (punto singolo di guasto)", () => {
    const r = simulate({ nodes: buildNodes("card-failure"), messages: benchmarkMessages(), params: params("tipico"), horizonS: 10 * H, stepS: 10, policy: "custody" });
    expect(r.deliveries.find((d) => d.messageId === "F1")!.deliveredAt).toBeNull();
  });
});

describe("scenario-model: estensioni per lo Scenario 2", () => {
  const H = 3600;
  const card = (id: string, x: number): NodeSpec => ({ id, kind: "card", path: [{ x, y: 0, z: 0, t: 0 }] });

  it("il link budget è simmetrico: non dipende dall'ordine dei due nodi (regressione)", () => {
    const box: NodeSpec = { id: "B", kind: "box", path: [{ x: 0, y: 0, z: 0, t: 0 }] };
    const c: NodeSpec = { id: "C", kind: "card", path: [{ x: 4500, y: 0, z: 0, t: 0 }] };
    for (const reg of [EU868_G1, EU868_G3]) {
      const ab = loraLink(box, positionAt(box.path, 0), c, positionAt(c.path, 0), params("tipico", reg));
      const ba = loraLink(c, positionAt(c.path, 0), box, positionAt(box.path, 0), params("tipico", reg));
      expect(ab?.sf).toBe(ba?.sf);
      expect(ab?.rssiDbm).toBeCloseTo(ba?.rssiDbm ?? NaN, 6);
    }
  });

  it("più destinazioni: tempi per destinazione, consegnato solo quando le raggiunge tutte", () => {
    const nodes = [card("S", 0), card("D1", 20), card("D2", 40)];
    const r = simulate({ nodes, messages: [{ id: "M", label: "", sizeBytes: 100, priority: 0, source: "S", destination: ["D1", "D2"], createdAt: 0 }], params: params("tipico"), horizonS: 120, stepS: 10, policy: "custody" });
    const d = r.deliveries[0];
    expect(d.deliveredAtByDest.D1).not.toBeNull();
    expect(d.deliveredAtByDest.D2).not.toBeNull();
    expect(d.deliveredAtByDest.D2!).toBeGreaterThanOrEqual(d.deliveredAtByDest.D1!);
    expect(d.deliveredAt).toBe(d.deliveredAtByDest.D2);
  });

  it("una destinazione spenta non viene mai raggiunta, le altre sì", () => {
    const nodes = [card("S", 0), card("D1", 20), { ...card("D2", 40), offFrom: 0 }];
    const r = simulate({ nodes, messages: [{ id: "M", label: "", sizeBytes: 100, priority: 0, source: "S", destination: ["D1", "D2"], createdAt: 0 }], params: params("tipico"), horizonS: 120, stepS: 10, policy: "custody" });
    expect(r.deliveries[0].deliveredAtByDest.D1).not.toBeNull();
    expect(r.deliveries[0].deliveredAtByDest.D2).toBeNull();
    expect(r.deliveries[0].deliveredAt).toBeNull();
  });

  it("metrica airtime: preferisce due salti veloci a un salto diretto lento", () => {
    // S–D diretto a ~6 km (SF lento), S–R e R–D a ~3 km (SF veloce): R deve ricevere il messaggio solo con "airtime".
    const nodes = [card("S", 0), card("R", 3000), card("D", 6000)];
    const msg = [{ id: "M", label: "", sizeBytes: 20_000, priority: 0, source: "S", destination: "D", createdAt: 0 }];
    const p = params("tipico", EU868_G3);
    const direct = loraLink(nodes[0], positionAt(nodes[0].path, 0), nodes[2], positionAt(nodes[2].path, 0), p);
    const half = loraLink(nodes[0], positionAt(nodes[0].path, 0), nodes[1], positionAt(nodes[1].path, 0), p);
    expect(direct).not.toBeNull();
    expect(half!.sf!).toBeLessThan(direct!.sf!);
    const hops = simulate({ nodes, messages: msg, params: p, horizonS: 3 * H, stepS: 10, policy: "custody", routingMetric: "hops" });
    const air = simulate({ nodes, messages: msg, params: p, horizonS: 3 * H, stepS: 10, policy: "custody", routingMetric: "airtime" });
    expect(air.deliveries[0].deliveredAt).not.toBeNull();
    expect(hops.deliveries[0].deliveredAt === null || air.deliveries[0].deliveredAt! < hops.deliveries[0].deliveredAt!).toBe(true);
  });

  it("perdita aggiuntiva nel tempo (perturbazione) può spezzare un link", () => {
    const nodes = [card("S", 0), card("D", 3000)];
    const msg = [{ id: "M", label: "", sizeBytes: 100, priority: 0, source: "S", destination: "D", createdAt: 0 }];
    const ok = simulate({ nodes, messages: msg, params: params("tipico"), horizonS: 600, stepS: 10, policy: "custody" });
    const storm = simulate({ nodes, messages: msg, params: params("tipico"), horizonS: 600, stepS: 10, policy: "custody", extraLossDb: () => 40 });
    expect(ok.deliveries[0].deliveredAt).not.toBeNull();
    expect(storm.deliveries[0].deliveredAt).toBeNull();
  });
});

describe("scenario-model: Scenario 2 (alpino frammentato)", () => {
  const H = 3600;
  const p2 = (env: keyof typeof S2.ENVIRONMENTS, reg = EU868_G1): ModelParams => ({ ...params("tipico", reg), env: S2.ENVIRONMENTS[env] });
  const run = (variant: S2.Variant, env: keyof typeof S2.ENVIRONMENTS, extra: Partial<Parameters<typeof simulate>[0]> = {}) =>
    simulate({ nodes: S2.buildNodes(variant), messages: S2.benchmarkMessages(), params: p2(env), horizonS: 10 * H, stepS: 10, policy: "custody", ...extra });

  it("le zone di terreno: colle visibile da entrambe le valli, cresta tra le valli", () => {
    const P = S2.PLACES;
    expect(S2.zoneOf(P.colle)).toBe("colle");
    expect(S2.zoneOf(P.boxA)).toBe("A");
    expect(S2.zoneOf(P.rifugioB)).toBe("B");
    expect(S2.zoneOf(P.laterale)).toBe("Alat");
    expect(S2.terrainLossDb(P.boxA, P.rifugioB)).toBeGreaterThan(S2.terrainLossDb(P.colle, P.rifugioB));
  });

  it("senza ponte, in condizioni tipiche l'SOS raggiunge il Portable ma non il Box oltre la cresta", () => {
    const f1 = run("static", "tipico").deliveries.find((d) => d.messageId === "F1")!;
    expect(f1.deliveredAtByDest.PORT).not.toBeNull();
    expect(f1.deliveredAtByDest.BOX).toBeNull();
  });

  it("un Fixed Relay al colle porta l'SOS al Box in meno di un minuto (condizioni tipiche)", () => {
    const f1 = run("fixed-relay", "tipico").deliveries.find((d) => d.messageId === "F1")!;
    expect(f1.deliveredAtByDest.BOX).not.toBeNull();
    expect(f1.deliveredAtByDest.BOX!).toBeLessThan(60);
  });

  it("il data mule che rivalica: la coda precedente perdeva l'SOS al Box, quella attuale e la DTN lo consegnano", () => {
    const f1 = (extra = {}) => run("crossing", "tipico", extra).deliveries.find((d) => d.messageId === "F1")!;
    expect(f1({ relayCarryTtlS: LEGACY_QUEUE_TTL_S }).deliveredAtByDest.BOX).toBeNull();
    expect(f1({ relayCarryTtlS: ARALD_QUEUE_TTL_S }).deliveredAtByDest.BOX).not.toBeNull();
    expect(f1().deliveredAtByDest.BOX).not.toBeNull();
  });
});
