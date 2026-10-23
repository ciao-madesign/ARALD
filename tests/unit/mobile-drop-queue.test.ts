import { describe, expect, it } from "vitest";
import {
  CLAIM_TTL_MS,
  MAX_PENDING_DROPS,
  PENDING_DROPS_STORAGE_KEY,
  PENDING_DROP_MAX_AGE_MS,
  claimPendingDrop,
  classifyDropSendFailure,
  enqueuePendingDrop,
  flushPendingDrops,
  isPendingDropExpired,
  loadPendingDrops,
  releasePendingDrop,
  remainingLifetimeMs,
  removePendingDrop,
  shouldQueueOnSubmit,
} from "../../mobile/www/drop-queue.js";

class FakeStorage {
  #map = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("quota exceeded");
    this.#map.set(key, value);
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
}

const GW = "http://192.168.1.50:8090";
const drop = (overrides: Record<string, unknown> = {}) => ({ text: "Frana sul sentiero", lat: 45.1, lon: 9.1, kind: "hazard", gateway: GW, ...overrides });
const withStatus = (status: number) => Object.assign(new Error("x"), { status });
const texts = (list: Array<{ text: string }>) => list.map((e) => e.text);

describe("mobile/www/drop-queue (coda persistente dei drop in uscita)", () => {
  it("una coda vuota restituisce due liste vuote", () => {
    expect(loadPendingDrops(new FakeStorage())).toEqual({ pending: [], expired: [] });
  });

  it("enqueuePendingDrop()/loadPendingDrops() fanno un round-trip fedele, con queueId e queuedAt aggiunti", () => {
    const storage = new FakeStorage();
    const entry = enqueuePendingDrop(drop({ label: "Frana" }), storage, 1_000);
    expect(entry).not.toBeNull();
    expect(entry!.queueId.length).toBeGreaterThan(0);

    const { pending } = loadPendingDrops(storage, 1_500);
    expect(pending).toEqual([{ queueId: entry!.queueId, gateway: GW, text: "Frana sul sentiero", lat: 45.1, lon: 9.1, label: "Frana", kind: "hazard", queuedAt: 1_000 }]);
  });

  it("senza kind usa 'info' e senza label non salva un'etichetta vuota", () => {
    const storage = new FakeStorage();
    const entry = enqueuePendingDrop({ text: "ciao", lat: 1, lon: 2, label: "", kind: "", gateway: GW }, storage);
    expect(entry!.kind).toBe("info");
    expect(entry!.label).toBeUndefined();
  });

  it("mantiene l'ordine di arrivo (la più vecchia per prima) e ogni voce ha un queueId diverso", () => {
    const storage = new FakeStorage();
    const a = enqueuePendingDrop(drop({ text: "uno" }), storage, 1)!;
    const b = enqueuePendingDrop(drop({ text: "due" }), storage, 2)!;
    expect(texts(loadPendingDrops(storage, 3).pending)).toEqual(["uno", "due"]);
    expect(a.queueId).not.toBe(b.queueId);
  });

  it("rifiuta il nuovo drop quando la coda è piena, senza scartare nessuno di quelli già in coda", () => {
    const storage = new FakeStorage();
    for (let i = 0; i < MAX_PENDING_DROPS; i++) expect(enqueuePendingDrop(drop({ text: `d${i}` }), storage)).not.toBeNull();
    expect(enqueuePendingDrop(drop({ text: "uno di troppo" }), storage)).toBeNull();
    const { pending } = loadPendingDrops(storage);
    expect(pending).toHaveLength(MAX_PENDING_DROPS);
    expect(pending[0].text).toBe("d0");
    expect(texts(pending)).not.toContain("uno di troppo");
  });

  it("enqueuePendingDrop() non toglie MAI le voci scadute: restano finché loadPendingDrops() non le restituisce", () => {
    const storage = new FakeStorage();
    const old = enqueuePendingDrop(drop({ text: "vecchio" }), storage, 0)!;
    const fresh = enqueuePendingDrop(drop({ text: "nuovo" }), storage, PENDING_DROP_MAX_AGE_MS + 1)!;
    expect(fresh).not.toBeNull();
    // la voce scaduta è ancora nello storage, così il chiamante può segnarla "Scaduta" nelle attività
    const { pending, expired } = loadPendingDrops(storage, PENDING_DROP_MAX_AGE_MS + 2);
    expect(expired.map((e: { queueId: string }) => e.queueId)).toEqual([old.queueId]);
    expect(texts(pending)).toEqual(["nuovo"]);
  });

  it("le voci scadute contano per il limite finché non sono state restituite, poi liberano posto", () => {
    const storage = new FakeStorage();
    for (let i = 0; i < MAX_PENDING_DROPS; i++) enqueuePendingDrop(drop({ text: `v${i}` }), storage, 0);
    const later = PENDING_DROP_MAX_AGE_MS + 5;
    expect(enqueuePendingDrop(drop({ text: "nuovo" }), storage, later)).toBeNull();
    expect(loadPendingDrops(storage, later).expired).toHaveLength(MAX_PENDING_DROPS);
    expect(enqueuePendingDrop(drop({ text: "nuovo" }), storage, later)).not.toBeNull();
  });

  it("una voce scaduta è restituita in `expired` e tolta dallo storage, le altre restano", () => {
    const storage = new FakeStorage();
    const old = enqueuePendingDrop(drop({ text: "vecchio" }), storage, 0)!;
    enqueuePendingDrop(drop({ text: "nuovo" }), storage, PENDING_DROP_MAX_AGE_MS - 10)!;

    const { pending, expired } = loadPendingDrops(storage, PENDING_DROP_MAX_AGE_MS + 1);
    expect(expired.map((e: { queueId: string }) => e.queueId)).toEqual([old.queueId]);
    expect(texts(pending)).toEqual(["nuovo"]);
    expect(loadPendingDrops(storage, PENDING_DROP_MAX_AGE_MS + 2).expired).toEqual([]);
  });

  it("isPendingDropExpired()/remainingLifetimeMs() sono coerenti al confine esatto della scadenza", () => {
    const entry = { queuedAt: 1_000 } as never;
    const deadline = 1_000 + PENDING_DROP_MAX_AGE_MS;
    expect(isPendingDropExpired(entry, deadline - 1)).toBe(false);
    expect(remainingLifetimeMs(entry, deadline - 1)).toBe(1);
    expect(isPendingDropExpired(entry, deadline)).toBe(true);
    expect(remainingLifetimeMs(entry, deadline)).toBe(0);
  });

  it("la vita residua riportata al nodo non supera mai quella piena, nemmeno con queuedAt nel futuro", () => {
    const storage = new FakeStorage();
    const entry = enqueuePendingDrop(drop(), storage, 5_000)!;
    expect(remainingLifetimeMs(entry, 5_000)).toBe(PENDING_DROP_MAX_AGE_MS);
    expect(remainingLifetimeMs(entry, 5_000 + 3_600_000)).toBe(PENDING_DROP_MAX_AGE_MS - 3_600_000);
    expect(remainingLifetimeMs({ queuedAt: 10 * PENDING_DROP_MAX_AGE_MS } as never, 0)).toBe(PENDING_DROP_MAX_AGE_MS);
  });

  it("una voce con queuedAt nel futuro è riportata a 'adesso' (e quindi scade), non vive per sempre", () => {
    const storage = new FakeStorage();
    const future = 50 * PENDING_DROP_MAX_AGE_MS;
    storage.setItem(
      PENDING_DROPS_STORAGE_KEY,
      JSON.stringify([{ queueId: "q", gateway: GW, text: "x", lat: 1, lon: 2, kind: "info", queuedAt: future }]),
    );
    const now = 1_000;
    const { pending } = loadPendingDrops(storage, now);
    expect(pending[0].queuedAt).toBe(now);
    // persistito: dopo 24h dalla lettura risulta scaduta
    expect(loadPendingDrops(storage, now + PENDING_DROP_MAX_AGE_MS).expired).toHaveLength(1);
  });

  it("removePendingDrop() toglie solo la voce indicata", () => {
    const storage = new FakeStorage();
    const a = enqueuePendingDrop(drop({ text: "a" }), storage)!;
    const b = enqueuePendingDrop(drop({ text: "b" }), storage)!;
    removePendingDrop(a.queueId, storage);
    expect(loadPendingDrops(storage).pending.map((e: { queueId: string }) => e.queueId)).toEqual([b.queueId]);
    removePendingDrop("inesistente", storage);
    expect(loadPendingDrops(storage).pending).toHaveLength(1);
  });

  it("rimuovere l'ultima voce svuota del tutto la chiave nello storage", () => {
    const storage = new FakeStorage();
    const only = enqueuePendingDrop(drop(), storage)!;
    removePendingDrop(only.queueId, storage);
    expect(storage.getItem(PENDING_DROPS_STORAGE_KEY)).toBeNull();
  });

  it("rifiuta input non valido: testo vuoto, posizione mancante/fuori scala, etichetta lunga, tipo o Box mancanti", () => {
    const storage = new FakeStorage();
    expect(enqueuePendingDrop(drop({ text: "" }), storage)).toBeNull();
    expect(enqueuePendingDrop(drop({ lat: undefined }), storage)).toBeNull();
    expect(enqueuePendingDrop(drop({ lat: Number.NaN }), storage)).toBeNull();
    expect(enqueuePendingDrop(drop({ lon: Infinity }), storage)).toBeNull();
    expect(enqueuePendingDrop(drop({ lat: 91 }), storage)).toBeNull();
    expect(enqueuePendingDrop(drop({ lon: -181 }), storage)).toBeNull();
    expect(enqueuePendingDrop(drop({ label: "L".repeat(101) }), storage)).toBeNull();
    expect(enqueuePendingDrop(drop({ label: "L".repeat(100) }), storage)).not.toBeNull();
    expect(enqueuePendingDrop(drop({ text: "T".repeat(4001) }), storage)).toBeNull();
    expect(enqueuePendingDrop(drop({ text: "T".repeat(4000) }), storage)).not.toBeNull();
    expect(enqueuePendingDrop(drop({ kind: "urgentissimo" }), storage)).toBeNull();
    expect(enqueuePendingDrop(drop({ gateway: "" }), storage)).toBeNull();
    expect(enqueuePendingDrop(drop({ gateway: undefined }), storage)).toBeNull();
  });

  it("ignora e ripulisce JSON malformato, forma inattesa e voci manomesse, tenendo le valide", () => {
    const storage = new FakeStorage();
    storage.setItem(PENDING_DROPS_STORAGE_KEY, "{non è json");
    expect(loadPendingDrops(storage)).toEqual({ pending: [], expired: [] });

    storage.setItem(PENDING_DROPS_STORAGE_KEY, JSON.stringify({ non: "una lista" }));
    expect(loadPendingDrops(storage)).toEqual({ pending: [], expired: [] });

    const good = { queueId: "q1", gateway: GW, text: "ok", lat: 1, lon: 2, kind: "info", queuedAt: 10 };
    storage.setItem(
      PENDING_DROPS_STORAGE_KEY,
      JSON.stringify([
        null,
        42,
        "x",
        { ...good, queueId: "" },
        { ...good, gateway: undefined },
        { ...good, text: 5 },
        { ...good, lat: "1" },
        { ...good, lat: 200 },
        { ...good, kind: "boh" },
        { ...good, queuedAt: "ieri" },
        { ...good, sendingSince: "ora" },
        good,
      ]),
    );
    const { pending } = loadPendingDrops(storage, 20);
    expect(pending).toEqual([good]);
    expect(JSON.parse(storage.getItem(PENDING_DROPS_STORAGE_KEY)!)).toEqual([good]);
  });

  it("senza storage disponibile non lancia mai: coda vuota e accodamento rifiutato", () => {
    expect(loadPendingDrops(undefined as never)).toEqual({ pending: [], expired: [] });
    expect(enqueuePendingDrop(drop(), undefined as never)).toBeNull();
    expect(() => removePendingDrop("x", undefined as never)).not.toThrow();
    expect(claimPendingDrop("x", undefined as never)).toBe(false);
    expect(() => releasePendingDrop("x", undefined as never)).not.toThrow();
  });

  it("se lo storage non è scrivibile, enqueuePendingDrop() restituisce null invece di fingere di aver accodato", () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    expect(enqueuePendingDrop(drop(), storage)).toBeNull();
  });

  describe("claimPendingDrop()/releasePendingDrop()", () => {
    it("prende in carico una voce una sola volta finché la marca è fresca", () => {
      const storage = new FakeStorage();
      const e = enqueuePendingDrop(drop(), storage, 0)!;
      expect(claimPendingDrop(e.queueId, storage, 100)).toBe(true);
      expect(claimPendingDrop(e.queueId, storage, 100 + CLAIM_TTL_MS - 1)).toBe(false);
      // una pagina morta a metà invio non blocca la voce per sempre
      expect(claimPendingDrop(e.queueId, storage, 100 + CLAIM_TTL_MS)).toBe(true);
    });

    it("una voce già rimossa (pubblicata da un'altra pagina) non si può più prendere in carico", () => {
      const storage = new FakeStorage();
      const e = enqueuePendingDrop(drop(), storage)!;
      removePendingDrop(e.queueId, storage);
      expect(claimPendingDrop(e.queueId, storage)).toBe(false);
    });

    it("releasePendingDrop() la rende subito di nuovo disponibile", () => {
      const storage = new FakeStorage();
      const e = enqueuePendingDrop(drop(), storage, 0)!;
      expect(claimPendingDrop(e.queueId, storage, 10)).toBe(true);
      releasePendingDrop(e.queueId, storage);
      expect(claimPendingDrop(e.queueId, storage, 11)).toBe(true);
    });

    it("se non riesce a scrivere la marca, non dà il via libera", () => {
      const storage = new FakeStorage();
      const e = enqueuePendingDrop(drop(), storage)!;
      storage.failWrites = true;
      expect(claimPendingDrop(e.queueId, storage)).toBe(false);
    });
  });

  describe("classifyDropSendFailure() / shouldQueueOnSubmit()", () => {
    it("un errore senza status (rete caduta, Box spento, timeout) è da ritentare", () => {
      expect(classifyDropSendFailure(new TypeError("Load failed"))).toBe("retry");
      expect(classifyDropSendFailure(new Error("richiesta scaduta, controlla la connessione"))).toBe("retry");
      expect(classifyDropSendFailure(undefined)).toBe("retry");
      expect(classifyDropSendFailure(null)).toBe("retry");
    });

    it("408 e 5xx sono da ritentare, anche se il Box non c'è per nessuno", () => {
      for (const status of [408, 500, 502, 503]) expect(classifyDropSendFailure(withStatus(status))).toBe("retry");
    });

    it("429 (limite ad alta priorità del nodo) è 'throttled': riguarda quella voce, non le altre", () => {
      expect(classifyDropSendFailure(withStatus(429))).toBe("throttled");
    });

    it("401 chiede un nuovo pairing", () => {
      expect(classifyDropSendFailure(withStatus(401))).toBe("reauth");
    });

    it("solo 400/413 sono un rifiuto definitivo del nodo sul contenuto", () => {
      for (const status of [400, 413]) expect(classifyDropSendFailure(withStatus(status))).toBe("discard");
    });

    it("403/404/405/422 (portale captive, proxy, altro server) NON cancellano il testo dell'utente", () => {
      for (const status of [403, 404, 405, 422]) expect(classifyDropSendFailure(withStatus(status))).toBe("unsupported");
    });

    it("una risposta con status di successo ma non JSON (captive portal, proxy) si ritenta", () => {
      expect(classifyDropSendFailure(withStatus(200))).toBe("retry");
      expect(classifyDropSendFailure(withStatus(302))).toBe("retry");
    });

    it("all'invio diretto si accoda solo un problema transitorio", () => {
      expect(shouldQueueOnSubmit(new TypeError("Load failed"))).toBe(true);
      expect(shouldQueueOnSubmit(withStatus(503))).toBe(true);
      expect(shouldQueueOnSubmit(withStatus(429))).toBe(true);
      expect(shouldQueueOnSubmit(withStatus(401))).toBe(false);
      expect(shouldQueueOnSubmit(withStatus(400))).toBe(false);
      expect(shouldQueueOnSubmit(withStatus(404))).toBe(false);
    });
  });

  describe("flushPendingDrops()", () => {
    type Entry = { text: string; queueId: string };
    const setup = (specs: Array<{ text: string; gateway?: string; queuedAt?: number }>, now = 1_000) => {
      const storage = new FakeStorage();
      for (const s of specs) enqueuePendingDrop(drop({ text: s.text, gateway: s.gateway ?? GW }), storage, s.queuedAt ?? now);
      return storage;
    };
    const run = async (
      storage: FakeStorage,
      send: (entry: Entry, expiresInMs: number) => Promise<void>,
      now = 2_000,
    ) => {
      const log = { published: [] as string[], discarded: [] as string[], expired: [] as string[], reauth: 0 };
      const result = await flushPendingDrops(
        {
          gateway: GW,
          send,
          onPublished: (e: Entry) => log.published.push(e.text),
          onDiscarded: (e: Entry) => log.discarded.push(e.text),
          onExpired: (e: Entry) => log.expired.push(e.text),
          onReauth: () => {
            log.reauth += 1;
          },
        },
        storage,
        () => now,
      );
      return { result, log };
    };
    const left = (storage: FakeStorage) => texts(loadPendingDrops(storage, 2_000).pending);

    it("invia tutto in ordine, dalla più vecchia, con la vita residua", async () => {
      const storage = setup([{ text: "uno" }, { text: "due" }]);
      const sent: Array<[string, number]> = [];
      const { result, log } = await run(storage, async (e, ms) => {
        sent.push([e.text, ms]);
      });
      expect(sent.map(([t]) => t)).toEqual(["uno", "due"]);
      expect(sent[0][1]).toBe(PENDING_DROP_MAX_AGE_MS - 1_000);
      expect(log.published).toEqual(["uno", "due"]);
      expect(result).toMatchObject({ published: 2, stoppedBy: null });
      expect(left(storage)).toEqual([]);
    });

    it("si ferma al primo errore ritentabile (Box irraggiungibile) lasciando in coda le voci non inviate", async () => {
      const storage = setup([{ text: "uno" }, { text: "due" }, { text: "tre" }]);
      let calls = 0;
      const { result } = await run(storage, async () => {
        calls += 1;
        if (calls === 2) throw new TypeError("Load failed");
      });
      expect(calls).toBe(2);
      expect(result.stoppedBy).toBe("retry");
      expect(left(storage)).toEqual(["due", "tre"]);
    });

    it("una voce non inviata torna subito disponibile al giro dopo (marca di invio rilasciata)", async () => {
      const storage = setup([{ text: "uno" }]);
      await run(storage, async () => {
        throw new TypeError("Load failed");
      });
      const { log } = await run(storage, async () => {});
      expect(log.published).toEqual(["uno"]);
    });

    it("un 429 salta solo quella voce: i drop successivi non restano bloccati", async () => {
      const storage = setup([{ text: "emergenza" }, { text: "info-1" }, { text: "info-2" }]);
      const { result, log } = await run(storage, async (e) => {
        if (e.text === "emergenza") throw withStatus(429);
      });
      expect(log.published).toEqual(["info-1", "info-2"]);
      expect(result.stoppedBy).toBeNull();
      expect(left(storage)).toEqual(["emergenza"]);
    });

    it("un 401 ferma il giro, avvisa e NON cancella nulla", async () => {
      const storage = setup([{ text: "uno" }, { text: "due" }]);
      const { result, log } = await run(storage, async () => {
        throw withStatus(401);
      });
      expect(result.stoppedBy).toBe("reauth");
      expect(log.reauth).toBe(1);
      expect(left(storage)).toEqual(["uno", "due"]);
    });

    it("un rifiuto definitivo (400) toglie solo quella voce e prosegue", async () => {
      const storage = setup([{ text: "ok-1" }, { text: "cattivo" }, { text: "ok-2" }]);
      const { log } = await run(storage, async (e) => {
        if (e.text === "cattivo") throw withStatus(400);
      });
      expect(log.discarded).toEqual(["cattivo"]);
      expect(log.published).toEqual(["ok-1", "ok-2"]);
      expect(left(storage)).toEqual([]);
    });

    it("un 404 (intermediario) NON cancella il testo: la voce resta e si prosegue con le altre", async () => {
      const storage = setup([{ text: "uno" }, { text: "due" }]);
      const { log } = await run(storage, async (e) => {
        if (e.text === "uno") throw withStatus(404);
      });
      expect(log.discarded).toEqual([]);
      expect(log.published).toEqual(["due"]);
      expect(left(storage)).toEqual(["uno"]);
    });

    it("non invia mai le voci di un altro Box e non le tocca", async () => {
      const storage = setup([{ text: "mio" }, { text: "altrui", gateway: "http://altra-mesh:8090" }]);
      const sent: string[] = [];
      await run(storage, async (e) => {
        sent.push(e.text);
      });
      expect(sent).toEqual(["mio"]);
      expect(left(storage)).toEqual(["altrui"]);
    });

    it("segnala le voci scadute senza inviarle", async () => {
      const storage = setup([{ text: "vecchio", queuedAt: 0 }, { text: "nuovo", queuedAt: PENDING_DROP_MAX_AGE_MS }]);
      const sent: string[] = [];
      const { result, log } = await run(
        storage,
        async (e) => {
          sent.push(e.text);
        },
        PENDING_DROP_MAX_AGE_MS + 10,
      );
      expect(log.expired).toEqual(["vecchio"]);
      expect(result.expired).toBe(1);
      expect(sent).toEqual(["nuovo"]);
    });

    it("non reinvia una voce già presa in carico da un'altra pagina", async () => {
      const storage = setup([{ text: "uno" }]);
      const [entry] = loadPendingDrops(storage, 2_000).pending;
      claimPendingDrop(entry.queueId, storage, 1_999);
      const sent: string[] = [];
      await run(storage, async (e) => {
        sent.push(e.text);
      });
      expect(sent).toEqual([]);
      expect(left(storage)).toEqual(["uno"]);
    });

    it("senza storage non lancia e non fa nulla", async () => {
      const result = await flushPendingDrops({ gateway: GW, send: async () => {} }, undefined as never, () => 0);
      expect(result).toEqual({ published: 0, discarded: 0, expired: 0, stoppedBy: null });
    });
  });
});
