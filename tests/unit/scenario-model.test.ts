import { describe, expect, it } from "vitest";
import {
  DEFAULT_PHY, DEFAULT_SHORT_RANGE, EU868_G1, EU868_G3, type ModelParams, type NodeSpec,
  effectiveEirpDbm, loraLink, loraTimeOnAir, pathLossDb, positionAt, simulate,
} from "../../tools/scenario-model/model.js";
import { ENVIRONMENTS, benchmarkMessages, buildNodes } from "../../tools/scenario-model/valle-maira.js";

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

  it("data mule in condizioni severe: la coda relay attuale (TTL) perde l'SOS, una coda DTN lo consegna", () => {
    const base = { nodes: buildNodes("ferry"), messages: benchmarkMessages(), params: params("severo"), horizonS: 10 * H, stepS: 10, policy: "custody" as const };
    const withTtl = simulate({ ...base, relayCarryTtlS: (prio) => (prio === 0 ? 0.5 * H : 300) });
    const dtn = simulate({ ...base });
    expect(withTtl.deliveries.find((d) => d.messageId === "F1")!.deliveredAt).toBeNull();
    expect(dtn.deliveries.find((d) => d.messageId === "F1")!.deliveredAt).not.toBeNull();
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
