import { describe, expect, it } from "vitest";
import { Editor } from "../../tools/network-design/editor.js";
import { History } from "../../tools/network-design/history.js";
import { duplicateDevice, nextDeviceId, setDeviceRoute, updateDevice } from "../../tools/network-design/logic.js";
import { MAX_ROUTE_POINTS, SPEED_PRESETS, buildRoute, fmtClock, routeLengthM, routePoints, routeToDraft, sameRoute } from "../../tools/network-design/route.js";
import { type NetworkConfig, parseNetworkConfig } from "../../tools/scenario-model/network-config.js";
import { toLocal } from "../../tools/scenario-model/terrain.js";

const frame = { lat0: 44, lon0: 7 };
const cfg = (): NetworkConfig => parseNetworkConfig({
  version: 1, name: "t", frame, environment: "tipico", regulatory: "g3",
  devices: [
    { id: "BOX", kind: "box", lat: 44, lon: 7, label: "Base" },
    { id: "C1", kind: "card", lat: 44.01, lon: 7.01, heightAglM: 2, route: [{ tS: 0, lat: 44.01, lon: 7.01 }, { tS: 600, lat: 44.02, lon: 7.01 }] },
  ],
});

describe("storico annulla/ripeti", () => {
  it("annulla e ripete nell'ordine, e una nuova modifica elimina il ramo ripetibile", () => {
    const h = new History<string>();
    let cur = "a";
    h.push(cur); cur = "b";
    h.push(cur); cur = "c";
    expect(h.canUndo).toBe(true);
    cur = h.undo(cur); expect(cur).toBe("b");
    cur = h.undo(cur); expect(cur).toBe("a");
    expect(h.canUndo).toBe(false);
    expect(h.undo(cur)).toBe("a"); // senza passato non cambia
    cur = h.redo(cur); expect(cur).toBe("b");
    expect(h.canRedo).toBe(true);
    h.push(cur); cur = "d"; // nuova modifica: il ramo "c" si perde
    expect(h.canRedo).toBe(false);
    expect(h.redo(cur)).toBe("d");
    cur = h.undo(cur); expect(cur).toBe("b");
  });

  it("rispetta il limite eliminando gli stati più vecchi, ignora uno stato uguale all'ultimo, si azzera", () => {
    const h = new History<number>(3);
    for (let i = 0; i < 10; i++) h.push(i);
    expect(h.size.undo).toBe(3);
    let cur = 10;
    cur = h.undo(cur); cur = h.undo(cur); cur = h.undo(cur);
    expect(cur).toBe(7); // i più vecchi sono stati scartati
    const g = new History<object>();
    const x = {};
    g.push(x); g.push(x);
    expect(g.size.undo).toBe(1);
    g.reset();
    expect(g.canUndo || g.canRedo).toBe(false);
    expect(() => new History(0)).toThrow(/limite/);
  });
});

describe("modifica dei dispositivi (immutabile)", () => {
  it("updateDevice non tocca l'originale e toglie i campi vuoti", () => {
    const c = cfg();
    const n = updateDevice(c, "BOX", { label: "Nuovo", heightAglM: 7 });
    expect(c.devices[0].label).toBe("Base");
    expect(c.devices[0].heightAglM).toBeUndefined();
    expect(n.devices[0]).toMatchObject({ label: "Nuovo", heightAglM: 7 });
    expect("label" in updateDevice(c, "BOX", { label: "" }).devices[0]).toBe(false);
    expect(updateDevice(c, "C1", { kind: "phone" }).devices[1].kind).toBe("phone");
    expect(updateDevice(c, "ZZZ", { label: "x" }).devices).toEqual(c.devices);
    expect(n.devices[1]).toBe(c.devices[1]); // gli altri dispositivi sono gli stessi oggetti
  });

  it("setDeviceRoute imposta il percorso e porta la posizione fissa alla partenza; con undefined lo toglie", () => {
    const c = cfg();
    const route = [{ tS: 0, lat: 44.5, lon: 7.5 }, { tS: 100, lat: 44.6, lon: 7.5 }];
    const n = setDeviceRoute(c, "BOX", route);
    expect(n.devices[0]).toMatchObject({ lat: 44.5, lon: 7.5, route });
    expect(c.devices[0].route).toBeUndefined();
    const m = setDeviceRoute(n, "BOX", undefined);
    expect("route" in m.devices[0]).toBe(false);
    expect(() => parseNetworkConfig(JSON.parse(JSON.stringify(n)))).not.toThrow();
  });

  it("duplicateDevice: nuovo id libero, spostamento, copia del percorso spostato, nome con (copia)", () => {
    const c = cfg();
    const r = duplicateDevice(c, "C1", 500, -300)!;
    expect(r.id).toBe("C2");
    expect(r.cfg.devices).toHaveLength(3);
    const a = toLocal(frame, c.devices[1]);
    const b = toLocal(frame, r.cfg.devices[2]);
    expect(b.x - a.x).toBeCloseTo(500, 3);
    expect(b.y - a.y).toBeCloseTo(-300, 3);
    const ra = toLocal(frame, c.devices[1].route![1]);
    const rb = toLocal(frame, r.cfg.devices[2].route![1]);
    expect(rb.x - ra.x).toBeCloseTo(500, 3);
    expect(r.cfg.devices[2].heightAglM).toBe(2);
    expect(duplicateDevice(c, "BOX", 10, 10)!.cfg.devices[2].label).toBe("Base (copia)");
    expect(duplicateDevice(c, "ZZZ", 1, 1)).toBeNull();
    expect(c.devices).toHaveLength(2);
    expect(nextDeviceId(r.cfg.devices, "card")).toBe("C3");
  });
});

describe("percorsi dei dispositivi mobili", () => {
  const start = { x: 0, y: 0 };
  const draft = (over = {}) => ({ start, stops: [{ x: 3600, y: 0, pauseMin: 0 }], speedKmh: 3.6, startDelayMin: 0, ...over });

  it("tempo = distanza / velocità; la sosta e l'attesa alla partenza aggiungono punti", () => {
    const p = routePoints(draft()); // 3600 m a 3,6 km/h = 1 m/s → 3600 s
    expect(p).toEqual([{ x: 0, y: 0, tS: 0 }, { x: 3600, y: 0, tS: 3600 }]);
    const q = routePoints(draft({ startDelayMin: 10, stops: [{ x: 3600, y: 0, pauseMin: 5 }, { x: 3600, y: 3600, pauseMin: 0 }] }));
    expect(q.map((r) => [r.x, r.y, r.tS])).toEqual([[0, 0, 0], [0, 0, 600], [3600, 0, 4200], [3600, 0, 4500], [3600, 3600, 8100]]);
    expect(routeLengthM(draft({ stops: [{ x: 3600, y: 0, pauseMin: 0 }, { x: 3600, y: 3600, pauseMin: 0 }] }))).toBeCloseTo(7200);
  });

  it("rifiuta velocità nulla o negativa, nessuna tappa, valori non numerici, percorsi troppo lunghi", () => {
    expect(() => routePoints(draft({ speedKmh: 0 }))).toThrow(/velocità/);
    expect(() => routePoints(draft({ speedKmh: -5 }))).toThrow(/velocità/);
    expect(() => routePoints(draft({ speedKmh: NaN }))).toThrow(/velocità/);
    expect(() => routePoints(draft({ stops: [] }))).toThrow(/almeno una tappa/);
    expect(() => routePoints(draft({ startDelayMin: -1 }))).toThrow(/partenza/);
    expect(() => routePoints(draft({ stops: [{ x: NaN, y: 0, pauseMin: 0 }] }))).toThrow(/coordinate/);
    expect(() => routePoints(draft({ stops: [{ x: 1, y: 0, pauseMin: -2 }] }))).toThrow(/sosta/);
    const many = Array.from({ length: MAX_ROUTE_POINTS + 1 }, (_, i) => ({ x: i, y: 0, pauseMin: 0 }));
    expect(() => routePoints(draft({ stops: many }))).toThrow(/troppo lungo/);
    expect(() => routePoints(draft({ speedKmh: 0.001 }))).toThrow(/troppo lungo nel tempo/);
  });

  it("due tappe nello stesso punto non producono istanti uguali: il percorso è valido per il motore", () => {
    const route = buildRoute(draft({ stops: [{ x: 0, y: 0, pauseMin: 0 }, { x: 0, y: 0, pauseMin: 0 }, { x: 100, y: 0, pauseMin: 0 }] }), frame);
    for (let i = 1; i < route.length; i++) expect(route[i].tS).toBeGreaterThan(route[i - 1].tS);
    const c = setDeviceRoute(cfg(), "BOX", route);
    expect(() => parseNetworkConfig(JSON.parse(JSON.stringify(c)))).not.toThrow();
  });

  it("dal percorso alla bozza e ritorno: stesse tappe, soste, attesa e velocità", () => {
    const d = draft({ speedKmh: 25, startDelayMin: 15, stops: [{ x: 8000, y: 0, pauseMin: 20 }, { x: 8000, y: 6000, pauseMin: 0 }] });
    const route = buildRoute(d, frame);
    const back = routeToDraft(route, frame);
    expect(back.stops).toHaveLength(2);
    expect(back.stops[0].pauseMin).toBeCloseTo(20, 1);
    expect(back.startDelayMin).toBeCloseTo(15, 1);
    expect(back.speedKmh).toBeCloseTo(25, 0);
    expect(back.stops[1].x).toBeCloseTo(8000, 0);
    expect(back.stops[1].y).toBeCloseTo(6000, 0);
    // un percorso senza movimento usa la velocità di ripiego, senza dividere per zero
    const still = routeToDraft([{ tS: 0, lat: 44, lon: 7 }, { tS: 60, lat: 44, lon: 7 }], frame, 9);
    expect(still.speedKmh).toBe(9);
  });

  it("orari leggibili e velocità predefinite sensate", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(45 * 60)).toBe("0:45");
    expect(fmtClock(725 * 60)).toBe("12:05");
    expect(SPEED_PRESETS.every((s) => s.kmh > 0)).toBe(true);
  });
});

describe("regole di modifica: un trascinamento è un solo passo, e non si registra se la rete è cambiata altrove", () => {
  type S = { n: number };
  const a: S = { n: 0 };
  const mk = (n: number): S => ({ n });

  it("commit registra, annulla e ripeti ripristinano; senza cambiamento non registra", () => {
    const e = new Editor<S>();
    expect(e.commit(a, a)).toBe(a);
    expect(e.canUndo).toBe(false);
    const b = e.commit(a, mk(1));
    expect(e.canUndo).toBe(true);
    expect(e.undo(b)).toBe(a);
    expect(e.canRedo).toBe(true);
    expect(e.redo(a).n).toBe(1);
    expect(new Editor<S>().undo(a)).toBe(a); // senza storico non cambia nulla
  });

  it("un trascinamento con molti movimenti è un solo passo annullabile", () => {
    const e = new Editor<S>();
    const tok = e.beginMove(a);
    let cur = a;
    for (let i = 1; i <= 50; i++) cur = mk(i); // 50 movimenti, ognuno una nuova rete
    expect(e.endMove(tok, cur)).toBe(true);
    expect(e.undo(cur)).toBe(a); // un solo annulla riporta alla posizione di partenza
    expect(e.canUndo).toBe(false);
  });

  it("un trascinamento senza spostamento non registra nulla", () => {
    const e = new Editor<S>();
    const tok = e.beginMove(a);
    expect(e.endMove(tok, a)).toBe(false);
    expect(e.canUndo).toBe(false);
  });

  it("annulla, altra modifica o cambio di scenario durante il trascinamento: il trascinamento non vale più e non registra", () => {
    const e = new Editor<S>();
    const b = e.commit(a, mk(1));
    // annulla durante il trascinamento
    let tok = e.beginMove(b);
    const afterUndo = e.undo(b);
    expect(e.isCurrent(tok)).toBe(false);
    expect(e.endMove(tok, mk(99))).toBe(false);
    expect(afterUndo).toBe(a);
    // altra modifica durante il trascinamento
    tok = e.beginMove(afterUndo);
    const c = e.commit(afterUndo, mk(2));
    expect(e.isCurrent(tok)).toBe(false);
    expect(e.endMove(tok, mk(3))).toBe(false);
    expect(e.undo(c)).toBe(afterUndo); // lo storico contiene solo la modifica vera
    // cambio di scenario durante il trascinamento: niente dello scenario vecchio entra nel nuovo storico
    tok = e.beginMove(a);
    e.reset();
    expect(e.isCurrent(tok)).toBe(false);
    expect(e.endMove(tok, mk(5))).toBe(false);
    expect(e.canUndo || e.canRedo).toBe(false);
  });

  it("un trascinamento concluso (anche per puntatore perso) si può annullare una volta e poi ripetere", () => {
    const e = new Editor<S>();
    const tok = e.beginMove(a);
    const moved = mk(7);
    e.endMove(tok, moved);
    expect(e.undo(moved)).toBe(a);
    expect(e.redo(a)).toBe(moved);
  });
});

describe("percorsi: nessun passo se non cambia nulla; nomi delle copie", () => {
  it("sameRoute tollera arrotondamenti minimi e rileva ogni differenza vera", () => {
    const r = [{ tS: 0, lat: 44, lon: 7 }, { tS: 100, lat: 44.01, lon: 7.01 }];
    expect(sameRoute(r, r.map((p) => ({ ...p })))).toBe(true);
    expect(sameRoute(r, [{ tS: 0.01, lat: 44, lon: 7 }, { tS: 100.02, lat: 44.01, lon: 7.01 }])).toBe(true);
    expect(sameRoute(r, [{ tS: 0, lat: 44, lon: 7 }, { tS: 101, lat: 44.01, lon: 7.01 }])).toBe(false);
    expect(sameRoute(r, [{ tS: 0, lat: 44, lon: 7 }, { tS: 100, lat: 44.0101, lon: 7.01 }])).toBe(false);
    expect(sameRoute(r, r.slice(0, 1))).toBe(false);
    expect(sameRoute(undefined, r)).toBe(false);
    expect(sameRoute(undefined, undefined)).toBe(true);
  });

  it("modificare e confermare un percorso senza cambiarlo restituisce lo stesso percorso (velocità non arrotondata)", () => {
    const d = { start: { x: 0, y: 0 }, stops: [{ x: 7300, y: 0, pauseMin: 12 }, { x: 7300, y: 5100, pauseMin: 0 }], speedKmh: 27.37, startDelayMin: 4 };
    const route = buildRoute(d, frame);
    expect(sameRoute(route, buildRoute(routeToDraft(route, frame), frame))).toBe(true);
  });

  it("duplicare una copia non accumula (copia) e il nome resta nel limite", () => {
    let c = cfg();
    for (let i = 0; i < 5; i++) c = duplicateDevice(c, i === 0 ? "BOX" : c.devices[c.devices.length - 1].id, 10, 10)!.cfg;
    expect(c.devices[c.devices.length - 1].label).toBe("Base (copia)");
    const longLabel = "x".repeat(200);
    const d = duplicateDevice(updateDevice(c, "BOX", { label: longLabel }), "BOX", 1, 1)!.cfg.devices.at(-1)!;
    expect(d.label!.length).toBeLessThanOrEqual(200);
  });

  it("una copia vicino ai limiti restituisce coordinate che la configurazione accetta", () => {
    const c = parseNetworkConfig({ version: 1, name: "t", frame: { lat0: 84.99, lon0: 179.99 }, environment: "tipico", regulatory: "g3", devices: [{ id: "A", kind: "card", lat: 84.99, lon: 179.99, route: [{ tS: 0, lat: 84.99, lon: 179.99 }, { tS: 10, lat: 84.99, lon: 179.995 }] }] });
    const r = duplicateDevice(c, "A", 2_000_000, 2_000_000)!;
    expect(() => parseNetworkConfig(JSON.parse(JSON.stringify(r.cfg)))).not.toThrow();
  });
});
