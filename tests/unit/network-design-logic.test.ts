import { describe, expect, it } from "vitest";
import {
  addDevice, fitView, fmtDistance, fmtRate, haloCellM, moveDevice, nextDeviceId, qualityColor, removeDevice,
  screenToWorld, viewBounds, worldToScreen, zoomAt,
} from "../../tools/network-design/logic.js";
import { type NetworkConfig, parseNetworkConfig } from "../../tools/scenario-model/network-config.js";
import { toLocal } from "../../tools/scenario-model/terrain.js";
import { TERRAINS } from "../../tools/scenario-model/terrains.js";

const cfg = (): NetworkConfig => parseNetworkConfig({
  version: 1, name: "t", frame: { lat0: 44, lon0: 7 }, environment: "tipico", regulatory: "g3",
  devices: [
    { id: "BOX", kind: "box", lat: 44, lon: 7 },
    { id: "C1", kind: "card", lat: 44.01, lon: 7.01, route: [{ tS: 0, lat: 44.01, lon: 7.01 }, { tS: 60, lat: 44.02, lon: 7.01 }] },
  ],
});

describe("pagina del tool: vista sulla mappa", () => {
  const v = { cx: 1000, cy: -500, mPerPx: 10, w: 800, h: 600 };

  it("mondo ↔ schermo sono inversi, con y verso l'alto sul mondo", () => {
    const s = worldToScreen(v, 1200, -300);
    expect(s).toEqual({ x: 420, y: 280 });
    const w = screenToWorld(v, s.x, s.y);
    expect(w.x).toBeCloseTo(1200);
    expect(w.y).toBeCloseTo(-300);
  });

  it("lo zoom attorno a un punto lo lascia fermo e rispetta i limiti", () => {
    const before = screenToWorld(v, 200, 150);
    const z = zoomAt(v, 200, 150, 0.5);
    const after = screenToWorld(z, 200, 150);
    expect(z.mPerPx).toBeCloseTo(5);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomAt(v, 0, 0, 1e-9).mPerPx).toBe(1);
    expect(zoomAt(v, 0, 0, 1e9).mPerPx).toBe(2000);
  });

  it("inquadra tutti i punti, anche se sono un punto solo o nessuno", () => {
    const f = fitView([{ x: 0, y: 0 }, { x: 10000, y: 4000 }], 1000, 600);
    const b = viewBounds(f);
    expect(b.minX).toBeLessThan(0);
    expect(b.maxX).toBeGreaterThan(10000);
    expect(b.minY).toBeLessThan(0);
    expect(b.maxY).toBeGreaterThan(4000);
    expect(Number.isFinite(fitView([{ x: 5, y: 5 }], 1000, 600).mPerPx)).toBe(true);
    expect(Number.isFinite(fitView([], 1000, 600).mPerPx)).toBe(true);
  });

  it("vista degenerata: schermo di dimensione zero o punti identici non producono NaN", () => {
    const f = fitView([{ x: 3, y: 3 }, { x: 3, y: 3 }], 0, 0);
    expect(Number.isFinite(f.mPerPx)).toBe(true);
    expect(Number.isFinite(f.cx)).toBe(true);
    const z = zoomAt({ cx: 0, cy: 0, mPerPx: 10, w: 0, h: 0 }, 0, 0, 2);
    expect(Number.isFinite(z.cx) && Number.isFinite(z.cy)).toBe(true);
  });

  it("la cella dell'alone è multipla di 50 m e almeno 50", () => {
    expect(haloCellM({ ...v, mPerPx: 1 })).toBe(50);
    expect(haloCellM({ ...v, mPerPx: 100 }) % 50).toBe(0);
    expect(haloCellM({ ...v, mPerPx: 100 })).toBeGreaterThan(50);
  });
});

describe("pagina del tool: testi e colori", () => {
  it("colori dallo spettro rosso al verde, con qualità fuori scala limitata", () => {
    expect(qualityColor(0)).toContain("hsl(0 ");
    expect(qualityColor(1)).toContain("hsl(120 ");
    expect(qualityColor(-3)).toBe(qualityColor(0));
    expect(qualityColor(7)).toBe(qualityColor(1));
  });

  it("distanze e velocità leggibili, virgola decimale", () => {
    expect(fmtDistance(850)).toBe("850 m");
    expect(fmtDistance(3200)).toBe("3,2 km");
    expect(fmtRate(549)).toBe("549 bps");
    expect(fmtRate(3200)).toBe("3,2 kbps");
    expect(fmtRate(2_500_000)).toBe("2,5 Mbps");
  });
});

describe("pagina del tool: modifica della configurazione", () => {
  it("identificativi liberi per tipo", () => {
    expect(nextDeviceId([], "box")).toBe("BOX");
    expect(nextDeviceId([{ id: "BOX" }], "box")).toBe("BOX2");
    expect(nextDeviceId([{ id: "C1" }, { id: "C2" }], "card")).toBe("C3");
    expect(nextDeviceId([{ id: "C2" }], "card")).toBe("C1");
    expect(nextDeviceId([], "relay")).toBe("FR");
  });

  it("aggiunge un dispositivo alla posizione indicata senza toccare l'originale", () => {
    const c = cfg();
    const { cfg: next, id } = addDevice(c, "relay", 2000, 3000);
    expect(id).toBe("FR");
    expect(c.devices).toHaveLength(2);
    const d = next.devices.find((q) => q.id === id)!;
    const p = toLocal(next.frame, d);
    expect(p.x).toBeCloseTo(2000, 3);
    expect(p.y).toBeCloseTo(3000, 3);
  });

  it("sposta un dispositivo; il percorso di un mobile si sposta dello stesso scarto", () => {
    const c = cfg();
    const before = toLocal(c.frame, c.devices[1]);
    const moved = moveDevice(c, "C1", before.x + 500, before.y - 200);
    const d = moved.devices[1];
    const p = toLocal(c.frame, d);
    expect(p.x).toBeCloseTo(before.x + 500, 3);
    expect(p.y).toBeCloseTo(before.y - 200, 3);
    const r1 = toLocal(c.frame, c.devices[1].route![1]);
    const r2 = toLocal(c.frame, d.route![1]);
    expect(r2.x - r1.x).toBeCloseTo(500, 3);
    expect(r2.y - r1.y).toBeCloseTo(-200, 3);
    expect(d.route![1].tS).toBe(60);
    expect(moved.devices[0]).toEqual(c.devices[0]);
  });

  it("un mobile il cui (lat, lon) fisso differisce dalla partenza del percorso si sposta rispetto alla partenza", () => {
    const c = cfg();
    c.devices[1] = { ...c.devices[1], lat: 44.05, lon: 7.05 }; // (lat, lon) lontano da route[0]
    const start = toLocal(c.frame, c.devices[1].route![0]);
    const moved = moveDevice(c, "C1", start.x + 100, start.y + 100);
    const r0 = toLocal(c.frame, moved.devices[1].route![0]);
    expect(r0.x).toBeCloseTo(start.x + 100, 3);
    expect(r0.y).toBeCloseTo(start.y + 100, 3);
    // la posizione fissa segue dello stesso scarto, non salta sul cursore
    const was = toLocal(c.frame, c.devices[1]);
    const now = toLocal(c.frame, moved.devices[1]);
    expect(now.x - was.x).toBeCloseTo(100, 3);
    expect(now.y - was.y).toBeCloseTo(100, 3);
  });

  it("id: dopo una rimozione non si riusa un id ancora presente, e prefissi simili non collidono", () => {
    expect(nextDeviceId([{ id: "C1" }, { id: "C3" }], "card")).toBe("C2");
    expect(nextDeviceId([{ id: "C" }, { id: "FR2" }, { id: "BOX2" }], "card")).toBe("C1");
    expect(nextDeviceId([{ id: "FR" }, { id: "FR2" }], "relay")).toBe("FR3");
  });

  it("una configurazione con troppi dispositivi è rifiutata", () => {
    const many = { version: 1, name: "t", frame: { lat0: 44, lon0: 7 }, environment: "tipico", regulatory: "g3", devices: Array.from({ length: 101 }, (_, i) => ({ id: `C${i}`, kind: "card", lat: 44, lon: 7 })) };
    expect(() => parseNetworkConfig(many)).toThrow(/più di 100/);
    expect(() => parseNetworkConfig({ ...many, devices: many.devices.slice(0, 100) })).not.toThrow();
  });

  it("rimuove un dispositivo; un id inesistente non cambia nulla", () => {
    const c = cfg();
    expect(removeDevice(c, "C1").devices.map((d) => d.id)).toEqual(["BOX"]);
    expect(removeDevice(c, "ZZZ").devices).toHaveLength(2);
  });

  it("il risultato è sempre una configurazione valida per il motore", () => {
    const { cfg: next } = addDevice(moveDevice(cfg(), "BOX", 100, 100), "phone", 0, 0);
    expect(() => parseNetworkConfig(JSON.parse(JSON.stringify(next)))).not.toThrow();
  });
});

describe("territori condivisi", () => {
  it("i dataset sintetici noti sono disponibili per nome", () => {
    expect(Object.keys(TERRAINS).sort()).toEqual(["atacama-sintetico", "eolie-sintetico", "kampala-sintetico"]);
  });
});
