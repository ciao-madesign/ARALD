import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessLink, coverageGrid, qualityFromRate, qualityLabel } from "../../tools/scenario-model/assess.js";
import * as S3 from "../../tools/scenario-model/eolie.js";
import * as S4 from "../../tools/scenario-model/atacama.js";
import {
  ARALD_QUEUE_TTL_S, AU915, BUDGET_SHORT_RANGE, DEFAULT_PHY, LEGACY_QUEUE_TTL_S, loraDutyLimitedAppBps, loraFrameBytesFor, loraRawAppBps, loraTimeOnAir, EU868_G1, EU868_G3, type Environment, type ModelParams, type NodeSpec,
  evaluateBle, evaluateLora, nodePosition, positionAt, simulate,
} from "../../tools/scenario-model/model.js";
import { TERRAIN_ENVIRONMENTS, assessNetwork, parseNetworkConfig, placeDevices } from "../../tools/scenario-model/network-config.js";
import {
  CLUTTER_DEPTH_M, FLAT_TERRAIN, type Terrain, knifeEdgeLossDb, syntheticIslands, terrainLinkLossDb, terrainProfileLoss, toGeo, toLocal,
} from "../../tools/scenario-model/terrain.js";

const H = 3600;
const params = (terrain: Terrain, reg = EU868_G1, env: keyof typeof TERRAIN_ENVIRONMENTS = "tipico"): ModelParams => ({
  env: { ...TERRAIN_ENVIRONMENTS[env], terrain } as Environment, reg, phy: DEFAULT_PHY, shortRange: BUDGET_SHORT_RANGE,
  loraFrameBytes: 222, loraFrameOverheadBytes: 22, protocolOverhead: 1.45, channelEfficiency: 0.5, maxSf: 12,
});
const node = (id: string, kind: NodeSpec["kind"], x: number, z: number, y = 0): [NodeSpec, { x: number; y: number; z: number }] =>
  [{ id, kind, path: [{ x, y, z, t: 0 }] }, { x, y, z }];

/** Una collina a cono alta `h` centrata in (cx, 0): per i test d'ombra. */
function hill(cx: number, h: number, r: number): Terrain {
  return {
    name: "collina",
    elevationAt: (x, y) => { const d = Math.hypot(x - cx, y); return d < r ? h * (1 - d / r) : 0; },
    landCoverAt: () => "open",
  };
}

describe("terrain: geografia e diffrazione", () => {
  it("toLocal/toGeo sono l'uno l'inverso dell'altro", () => {
    const frame = { lat0: 38.6, lon0: 15.05 };
    const g = { lat: 38.8, lon: 15.237 };
    const back = toGeo(frame, toLocal(frame, g));
    expect(back.lat).toBeCloseTo(g.lat, 9);
    expect(back.lon).toBeCloseTo(g.lon, 9);
  });

  it("knife-edge: 6 dB con l'ostacolo tangente alla linea di vista (ν = 0), nulla sotto ν = −0,78", () => {
    expect(knifeEdgeLossDb(0)).toBeCloseTo(6.03, 1);
    expect(knifeEdgeLossDb(-1)).toBe(0);
    expect(knifeEdgeLossDb(2)).toBeGreaterThan(knifeEdgeLossDb(1));
  });

  it("terreno piatto con antenne alte: nessuna diffrazione; una collina in mezzo la introduce", () => {
    // Antenne a 2 m su 3 km avrebbero già qualche dB: suolo e curvatura invadono la zona di Fresnel.
    const a = { x: 0, y: 0, z: 60 };
    const b = { x: 3000, y: 0, z: 60 };
    expect(terrainProfileLoss(FLAT_TERRAIN, a, b, 868e6).lossDb).toBe(0);
    const blocked = terrainProfileLoss(hill(1500, 260, 600), a, b, 868e6);
    expect(blocked.lineOfSight).toBe(false);
    expect(blocked.lossDb).toBeGreaterThan(20);
    expect(blocked.obstacleAtM).toBeCloseTo(1500, -2);
  });

  it("la curvatura terrestre oscura due antenne basse a 40 km sul mare, non due antenne in quota", () => {
    const low = terrainProfileLoss(FLAT_TERRAIN, { x: 0, y: 0, z: 3 }, { x: 40_000, y: 0, z: 3 }, 868e6);
    const high = terrainProfileLoss(FLAT_TERRAIN, { x: 0, y: 0, z: 400 }, { x: 40_000, y: 0, z: 400 }, 868e6);
    expect(low.lineOfSight).toBe(false);
    expect(low.lossDb).toBeGreaterThan(10);
    expect(high.lossDb).toBe(0);
  });

  it("il clutter pesa per intero solo oltre CLUTTER_DEPTH_M (regressione: telefono accanto alla Card in città)", () => {
    const city: Terrain = { name: "città", elevationAt: () => 0, landCoverAt: () => "urban-dense" };
    const a = { x: 0, y: 0, z: 1 };
    const near = terrainLinkLossDb(city, a, { x: 4, y: 0, z: 1 }, 2.44e9);
    const farB = { x: CLUTTER_DEPTH_M * 2, y: 0, z: 1 };
    const far = terrainLinkLossDb(city, a, farB, 2.44e9) - terrainProfileLoss(city, a, farB, 2.44e9).lossDb;
    expect(near).toBeLessThan(1);
    expect(far).toBeCloseTo(40, 6); // 20 dB di clutter urbano denso a 2,4 GHz per estremo
  });

  it("syntheticIslands: mare a quota 0, cima alla quota dichiarata, insediamenti con la propria classe", () => {
    const frame = { lat0: 0, lon0: 0 };
    const t = syntheticIslands("t", frame, [{ name: "i", center: { lat: 0, lon: 0 }, radiusM: 1000, summitM: 500 }], [{ name: "s", center: { lat: 0, lon: 0 }, radiusM: 50, cover: "urban" }]);
    expect(t.elevationAt(0, 0)).toBe(500);
    expect(t.elevationAt(5000, 0)).toBe(0);
    expect(t.landCoverAt(0, 0)).toBe("urban");
    expect(t.landCoverAt(500, 0)).toBe("open");
    expect(t.landCoverAt(5000, 0)).toBe("sea");
  });
});

describe("assess: interrogazione per il tool", () => {
  it("qualità: scala logaritmica 0-1 monotona, con etichette", () => {
    expect(qualityFromRate(0)).toBe(0);
    expect(qualityFromRate(10)).toBe(0);
    expect(qualityFromRate(30e6)).toBe(1);
    expect(qualityFromRate(1e3)).toBeLessThan(qualityFromRate(1e6));
    expect(qualityLabel(0)).toBe("Assente");
    expect(qualityLabel(0.9)).toBe("Ottima");
  });

  it("BLE a link budget: la velocità scende con la distanza fino a sparire", () => {
    const p = params(FLAT_TERRAIN);
    const [a, pa] = node("A", "phone", 0, 1.2);
    const rates = [5, 30, 60, 150, 1000].map((d) => {
      const [b, pb] = node("B", "phone", d, 1.2);
      return evaluateBle(a, pa, b, pb, p).link?.rateBps ?? 0;
    });
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeLessThanOrEqual(rates[i - 1]);
    expect(rates[0]).toBeGreaterThan(0);
    expect(rates[rates.length - 1]).toBe(0);
  });

  it("assessLink: tre tecnologie valutate, Wi-Fi non applicabile tra due Card, best = la più veloce", () => {
    const p = params(FLAT_TERRAIN);
    const [c1, p1] = node("C1", "card", 0, 1.2);
    const [c2, p2] = node("C2", "card", 10, 1.2);
    const r = assessLink(c1, p1, c2, p2, p);
    expect(r.perTechnology.map((t) => t.technology)).toEqual(["wifi", "ble", "lora"]);
    expect(r.perTechnology[0].applicable).toBe(false);
    expect(r.best?.technology).toBe("ble");
    expect(r.perTechnology[2].sustainedBps).toBeLessThan(r.perTechnology[2].rateBps); // LoRa: duty-cycle
  });

  it("assessLink è simmetrico (stesso risultato invertendo i dispositivi)", () => {
    const p = params(hill(2000, 150, 800), EU868_G3);
    const [box, pb] = node("BOX", "box", 0, 4);
    const [card, pc] = node("C", "card", 4500, 1.2);
    const ab = assessLink(box, pb, card, pc, p);
    const ba = assessLink(card, pc, box, pb, p);
    expect(ab.best?.mode).toBe(ba.best?.mode);
    expect(ab.perTechnology[2].rssiDbm).toBeCloseTo(ba.perTechnology[2].rssiDbm!, 6);
  });

  it("memo del terreno e uscita anticipata non cambiano il risultato rispetto al calcolo diretto", () => {
    const terrain = hill(2000, 150, 800);
    const p = params(terrain, EU868_G3);
    const [box, pb] = node("BOX", "box", 0, 4);
    const [card, pc] = node("C", "card", 4500, 1.2);
    const first = evaluateLora(box, pb, card, pc, p);
    const second = evaluateLora(box, pb, card, pc, p);
    expect(second).toEqual(first);
    // RSSI = quello senza territorio meno la perdita del territorio calcolata direttamente
    const flat = evaluateLora(box, pb, card, pc, params(FLAT_TERRAIN, EU868_G3));
    expect(first.rssiDbm!).toBeCloseTo(flat.rssiDbm! - terrainLinkLossDb(terrain, pb, pc, 868e6) + terrainLinkLossDb(FLAT_TERRAIN, pb, pc, 868e6), 6);
  });

  it("un RSSI calcolato senza profilo del terreno è marcato come limite superiore (regressione)", () => {
    const p = params(hill(2000, 150, 800), EU868_G1);
    const [box, pb] = node("BOX", "box", 0, 4);
    const [far, pf] = node("C", "card", 200_000, 1.2); // irraggiungibile già senza territorio
    const [near, pn] = node("N", "card", 4500, 1.2);
    const lf = assessLink(box, pb, far, pf, p).perTechnology[2];
    expect(lf.possible).toBe(false);
    expect(lf.rssiIsUpperBound).toBe(true);
    expect(assessLink(box, pb, near, pn, p).perTechnology[2].rssiIsUpperBound).toBe(false);
  });

  it("coverageGrid: l'alone segue il terreno — dietro una collina non c'è copertura, davanti sì", () => {
    const terrain = hill(1500, 300, 500);
    const p = params(terrain, EU868_G1);
    const [box, pb] = node("BOX", "box", 0, 4);
    const g = coverageGrid(box, pb, "lora", p, { minX: -4000, maxX: 4000, minY: -250, maxY: 250 }, 500);
    const at = (x: number) => g.cells.find((c) => Math.abs(c.x - x) < 1)!;
    // stessa distanza (2,75 km), lato opposto: davanti coperto, dietro la collina no
    expect(at(-2750).possible).toBe(true);
    expect(at(2750).possible).toBe(false);
  });
});

describe("network-config: configurazione salvabile", () => {
  const example = JSON.parse(readFileSync("tools/scenario-model/examples/eolie.json", "utf8"));

  it("l'esempio Eolie è valido e i dispositivi prendono la quota dal territorio", () => {
    const cfg = parseNetworkConfig(example);
    const nodes = placeDevices(cfg, S3.EOLIE_TERRAIN);
    const fr = nodes.find((n) => n.id === "FR")!;
    expect(fr.path[0].z).toBeGreaterThan(400); // vetta di Panarea + palo
  });

  it("rifiuta nomi di ambiente/profilo che sono proprietà ereditate dell'oggetto (regressione: crash con \"constructor\")", () => {
    expect(() => parseNetworkConfig({ ...example, environment: "constructor" })).toThrow(/environment/);
    expect(() => parseNetworkConfig({ ...example, regulatory: "toString" })).toThrow(/regulatory/);
    expect(() => parseNetworkConfig({ ...example, environment: "__proto__" })).toThrow(/environment/);
  });

  it("rifiuta versione errata, tipo sconosciuto, id duplicato, coordinate fuori scala", () => {
    expect(() => parseNetworkConfig({ ...example, version: 2 })).toThrow(/versione/);
    expect(() => parseNetworkConfig({ ...example, devices: [{ id: "X", kind: "drone", lat: 0, lon: 0 }] })).toThrow(/kind/);
    expect(() => parseNetworkConfig({ ...example, devices: [example.devices[0], example.devices[0]] })).toThrow(/duplicato/);
    expect(() => parseNetworkConfig({ ...example, devices: [{ id: "X", kind: "box", lat: 200, lon: 0 }] })).toThrow(/lat/);
    expect(() => parseNetworkConfig(null)).toThrow();
  });

  it("assessNetwork sull'esempio: il relay di Panarea vede Lipari, ma non il versante di Stromboli (cono del vulcano)", () => {
    const links = assessNetwork(parseNetworkConfig(example), S3.EOLIE_TERRAIN);
    const has = (a: string, b: string) => links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    expect(has("BOX", "FR")).toBe(true);
    expect(has("FR", "PORT")).toBe(false);
    expect(has("FR", "C5")).toBe(false);
    expect(has("PORT", "C5")).toBe(true);
    for (let i = 1; i < links.length; i++) expect(links[i].best!.quality).toBeLessThanOrEqual(links[i - 1].best!.quality);
  });
});

describe("Scenario 3 (Eolie)", () => {
  const run = (variant: S3.Variant, extra: Partial<Parameters<typeof simulate>[0]> = {}) =>
    simulate({
      nodes: S3.buildNodes(variant), messages: S3.benchmarkMessages(),
      params: { ...params(S3.EOLIE_TERRAIN), env: S3.ENVIRONMENTS.tipico }, horizonS: 6 * H, stepS: 10, policy: "custody", ...extra,
    }).deliveries.find((d) => d.messageId === "F1")!;

  it("senza aliscafo l'SOS da Stromboli arriva al Portable ma mai al Box di Lipari", () => {
    const f1 = run("static");
    expect(f1.deliveredAtByDest.PORT).not.toBeNull();
    expect(f1.deliveredAtByDest.BOX).toBeNull();
  });

  it("aliscafo come data mule: con la coda precedente l'SOS scadeva prima del rientro, con quella attuale arriva", () => {
    expect(run("hydrofoil", { relayCarryTtlS: LEGACY_QUEUE_TTL_S }).deliveredAtByDest.BOX).toBeNull();
    expect(run("hydrofoil", { relayCarryTtlS: ARALD_QUEUE_TTL_S }).deliveredAtByDest.BOX).not.toBeNull();
  });

  it("il Fixed Relay su Panarea accorcia l'attesa del mulo: l'SOS arriva prima", () => {
    const withRelay = run("relay-hydrofoil", { relayCarryTtlS: ARALD_QUEUE_TTL_S }).deliveredAtByDest.BOX!;
    const without = run("hydrofoil", { relayCarryTtlS: ARALD_QUEUE_TTL_S }).deliveredAtByDest.BOX!;
    expect(withRelay).toBeLessThan(without);
    expect(run("relay-hydrofoil", { relayCarryTtlS: LEGACY_QUEUE_TTL_S }).deliveredAtByDest.BOX).not.toBeNull();
  });

  it("lungo una traiettoria in salita la quota segue il terreno, non la retta tra i waypoint (regressione)", () => {
    const c5 = S3.buildNodes("static").find((n) => n.id === "C5")!;
    for (const t of [0, 0.1 * H, 0.2 * H, 0.3 * H, S3.EVENT_T]) {
      const p = nodePosition(c5, t, S3.EOLIE_TERRAIN);
      expect(p.z - S3.EOLIE_TERRAIN.elevationAt(p.x, p.y)).toBeCloseTo(1.2, 6);
    }
    // senza territorio si torna all'interpolazione dei waypoint
    expect(nodePosition(c5, 0.2 * H)).toEqual(positionAt(c5.path, 0.2 * H));
  });
});

describe("profili regolatori per regione: dwell time (AU915)", () => {
  const p = (reg = AU915): ModelParams => params(FLAT_TERRAIN, reg);

  it("senza dwell time il frame resta pieno a ogni SF (risultati europei invariati)", () => {
    for (const sf of [7, 9, 12] as const) expect(loraFrameBytesFor(sf, p(EU868_G3))).toBe(222);
  });

  it("con dwell 400 ms il frame si accorcia agli SF lenti e SF11/SF12 diventano inutilizzabili", () => {
    expect(loraFrameBytesFor(7, p())).toBe(222);
    const f8 = loraFrameBytesFor(8, p());
    const f10 = loraFrameBytesFor(10, p());
    expect(f8).toBeLessThan(222);
    expect(f10).toBeLessThan(f8);
    expect(f10).toBeGreaterThan(22); // almeno un byte utile oltre al framing ARALD
    expect(loraTimeOnAir(f10, 10)).toBeLessThanOrEqual(0.4);
    expect(loraTimeOnAir(f10 + 1, 10)).toBeGreaterThan(0.4);
    expect(loraFrameBytesFor(11, p())).toBe(0);
    expect(loraFrameBytesFor(12, p())).toBe(0);
    expect(loraRawAppBps(11, p())).toBe(0);
  });

  it("un frame non più grande dell'intestazione ARALD rende LoRa inutilizzabile (nessuna divisione per zero)", () => {
    const tiny = { ...p(EU868_G3), loraFrameBytes: 22 };
    expect(loraFrameBytesFor(7, tiny)).toBe(0);
    expect(loraRawAppBps(7, tiny)).toBe(0);
    const [a, pa] = node("A", "card", 0, 1.2);
    const [b, pb] = node("B", "card", 100, 1.2);
    expect(evaluateLora(a, pa, b, pb, tiny).link).toBeNull();
  });

  it("nessun duty-cycle in AU915: velocità sostenuta = istantanea", () => {
    expect(loraDutyLimitedAppBps(7, p())).toBeCloseTo(loraRawAppBps(7, p()), 9);
  });

  it("un link che chiude solo a SF11 in Europa non esiste con le regole AU915", () => {
    const [a, pa] = node("A", "box", 0, 4);
    for (let d = 5000; d < 200_000; d += 1000) {
      const [b, pb] = node("B", "card", d, 1.2);
      const eu = evaluateLora(a, pa, b, pb, p(EU868_G3)).link;
      if (eu?.sf === 11) {
        expect(evaluateLora(a, pa, b, pb, p()).link).toBeNull();
        return;
      }
    }
    throw new Error("nessuna distanza con SF11 in EU868 g3: test da rivedere");
  });

  it("la configurazione salvata accetta au915 e l'esempio Atacama è valido", () => {
    const cfg = parseNetworkConfig(JSON.parse(readFileSync("tools/scenario-model/examples/atacama.json", "utf8")));
    expect(cfg.regulatory).toBe("au915");
    const links = assessNetwork(cfg, S4.ATACAMA_TERRAIN);
    expect(links.every((l) => l.best!.technology !== "lora" || !["SF11", "SF12"].includes(l.best!.mode!))).toBe(true);
  });
});

describe("terreno sintetico generico e Scenario 4 (Atacama)", () => {
  const ARALD = ARALD_QUEUE_TTL_S;
  const run = (variant: S4.Variant, reg = AU915, extra: Partial<Parameters<typeof simulate>[0]> = {}, env: keyof typeof S4.ENVIRONMENTS = "tipico") =>
    simulate({
      nodes: S4.buildNodes(variant), messages: S4.benchmarkMessages(),
      params: { ...params(S4.ATACAMA_TERRAIN, reg), env: S4.ENVIRONMENTS[env] }, horizonS: 6 * H, stepS: 10, policy: "custody", ...extra,
    }).deliveries;

  it("syntheticLandscape: altopiano che sale verso est, cresta e coni sopra la base", () => {
    const t = S4.ATACAMA_TERRAIN;
    const at = (g: { lat: number; lon: number }) => { const q = toLocal(S4.ATACAMA_FRAME, g); return t.elevationAt(q.x, q.y); };
    expect(at(S4.ATACAMA_PLACES.miscanti)).toBeGreaterThan(at(S4.ATACAMA_PLACES.toconao) + 1000);
    expect(at({ lat: -22.83, lon: -67.88 })).toBeGreaterThan(5000); // Licancabur
    expect(at({ lat: -22.97, lon: -68.275 })).toBeGreaterThan(at(S4.ATACAMA_PLACES.sanPedro) + 250); // Cordillera de la Sal
  });

  it("la Cordillera de la Sal oscura la Valle de la Luna dal Box di San Pedro (~9 km)", () => {
    const nodes = S4.buildNodes("static");
    const box = nodes.find((n) => n.id === "BOX")!;
    const c1 = nodes.find((n) => n.id === "C1")!;
    const pb = nodePosition(box, 0, S4.ATACAMA_TERRAIN);
    const pc = nodePosition(c1, 0, S4.ATACAMA_TERRAIN);
    expect(terrainProfileLoss(S4.ATACAMA_TERRAIN, pb, pc, 920e6).lineOfSight).toBe(false);
    expect(assessLink(box, pb, c1, pc, { ...params(S4.ATACAMA_TERRAIN), env: S4.ENVIRONMENTS.favorevole }).best).toBeNull();
  });

  it("senza fuoristrada l'SOS dalla Laguna Miscanti non arriva a nessuna infrastruttura", () => {
    const f1 = run("static", AU915, { relayCarryTtlS: ARALD }).find((d) => d.messageId === "F1")!;
    expect(f1.deliveredAtByDest.PORT).toBeNull();
    expect(f1.deliveredAtByDest.BOX).toBeNull();
  });

  it("fuoristrada come data mule: l'SOS arriva con la coda attuale; le foto solo con coda DTN", () => {
    const arald = run("vehicle", AU915, { relayCarryTtlS: ARALD });
    const dtn = run("vehicle");
    expect(arald.find((d) => d.messageId === "F1")!.deliveredAtByDest.BOX).not.toBeNull();
    expect(arald.find((d) => d.messageId === "F3")!.deliveredAt).toBeNull();
    expect(dtn.find((d) => d.messageId === "F3")!.deliveredAt).not.toBeNull();
  });

  it("con il Fixed Relay, in condizioni favorevoli l'SOS arriva in pochi minuti con le regole EU (SF11) ma non con AU915", () => {
    const eu = run("andes-relay", EU868_G3, { relayCarryTtlS: ARALD }, "favorevole").find((d) => d.messageId === "F1")!;
    const au = run("andes-relay", AU915, { relayCarryTtlS: ARALD }, "favorevole").find((d) => d.messageId === "F1")!;
    expect(eu.deliveredAtByDest.BOX).not.toBeNull();
    expect(eu.deliveredAtByDest.BOX!).toBeLessThan(10 * 60);
    expect(au.deliveredAtByDest.BOX).toBeNull();
  });
});
