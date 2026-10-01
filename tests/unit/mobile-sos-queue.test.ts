import { describe, expect, it, vi } from "vitest";
import { PENDING_SOS_STORAGE_KEY, claimSosSuccess, clearPendingSos, isPendingSosExpired, loadPendingSos, raceFirstSuccess, savePendingSos } from "../../mobile/www/sos-queue.js";

class FakeStorage {
  #map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
}

function validPacket(expiresAt = Date.now() + 60_000) {
  return {
    version: 1,
    id: "pkt-1",
    type: "CONTENT_ANNOUNCE",
    source: "node-a",
    ttl: 8,
    timestamp: Date.now(),
    priority: 0,
    payload: { metadata: { contentId: "c1", name: "emergency-beacon", mimeType: "application/json", size: 10, publisherId: "node-a", signature: "ab", createdAt: Date.now(), expiresAt }, data: "e30=" },
  };
}

describe("mobile/www/sos-queue (coda SOS persistente, su ogni canale disponibile)", () => {
  it("loadPendingSos() restituisce null quando non c'è nulla in coda", () => {
    expect(loadPendingSos(new FakeStorage())).toBeNull();
  });

  it("savePendingSos()/loadPendingSos() fanno un round-trip fedele, con un queuedAt aggiunto", () => {
    const storage = new FakeStorage();
    const packet = validPacket();
    savePendingSos({ packet, message: "aiuto", lat: 45.1, lon: 9.1 }, storage);

    const loaded = loadPendingSos(storage);
    expect(loaded).not.toBeNull();
    expect(loaded!.packet).toEqual(packet);
    expect(loaded!.message).toBe("aiuto");
    expect(loaded!.lat).toBe(45.1);
    expect(loaded!.lon).toBe(9.1);
    expect(typeof loaded!.queuedAt).toBe("number");
  });

  it("message/lat/lon sono facoltativi, come già lo erano per ble-sos.js's buildEmergencyBeaconPacket()", () => {
    const storage = new FakeStorage();
    savePendingSos({ packet: validPacket() }, storage);

    const loaded = loadPendingSos(storage);
    expect(loaded).not.toBeNull();
    expect(loaded!.message).toBeUndefined();
    expect(loaded!.lat).toBeUndefined();
    expect(loaded!.lon).toBeUndefined();
  });

  it("clearPendingSos() rimuove la voce — un load successivo torna a null", () => {
    const storage = new FakeStorage();
    savePendingSos({ packet: validPacket() }, storage);
    clearPendingSos(storage);
    expect(loadPendingSos(storage)).toBeNull();
  });

  it("un secondo savePendingSos() sostituisce il primo — un solo slot, mai una lista", () => {
    const storage = new FakeStorage();
    savePendingSos({ packet: validPacket() }, storage);
    const second = validPacket();
    second.id = "pkt-2";
    savePendingSos({ packet: second }, storage);

    expect(loadPendingSos(storage)!.packet.id).toBe("pkt-2");
  });

  it("JSON malformato viene trattato come assente e ripulito da storage, mai un errore per il chiamante", () => {
    const storage = new FakeStorage();
    storage.setItem(PENDING_SOS_STORAGE_KEY, "{ non valido");

    expect(loadPendingSos(storage)).toBeNull();
    expect(storage.getItem(PENDING_SOS_STORAGE_KEY)).toBeNull();
  });

  it("una voce JSON valida ma di forma inattesa (manca payload.metadata.expiresAt) viene trattata come assente e ripulita", () => {
    const storage = new FakeStorage();
    storage.setItem(PENDING_SOS_STORAGE_KEY, JSON.stringify({ queuedAt: Date.now(), packet: { payload: { metadata: {} } } }));

    expect(loadPendingSos(storage)).toBeNull();
    expect(storage.getItem(PENDING_SOS_STORAGE_KEY)).toBeNull();
  });

  it("una voce con payload.metadata.expiresAt valido ma id/type/source dell'involucro mancanti viene comunque trattata come assente (trovato dalla revisione: senza questo, seenCache.markSeen(undefined) e una trasmissione di un pacchetto senza id sarebbero passati inosservati)", () => {
    const storage = new FakeStorage();
    const broken = validPacket();
    delete (broken as { id?: string }).id;
    storage.setItem(PENDING_SOS_STORAGE_KEY, JSON.stringify({ queuedAt: Date.now(), packet: broken }));

    expect(loadPendingSos(storage)).toBeNull();
    expect(storage.getItem(PENDING_SOS_STORAGE_KEY)).toBeNull();
  });

  it("un `message` di forma inattesa (non stringa) viene trattato come assente e ripulito, come ogni altro campo malformato", () => {
    const storage = new FakeStorage();
    storage.setItem(PENDING_SOS_STORAGE_KEY, JSON.stringify({ queuedAt: Date.now(), packet: validPacket(), message: 42 }));

    expect(loadPendingSos(storage)).toBeNull();
  });

  it("un array o una stringa al posto di un oggetto vengono trattati come assenti, mai come 'oggetto con campi mancanti' (stessa guardia di node/src/portable-config.ts)", () => {
    const storage = new FakeStorage();
    storage.setItem(PENDING_SOS_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadPendingSos(storage)).toBeNull();
  });

  it("un SOS già scaduto (expiresAt nel passato) viene trattato come assente e ripulito — stessa scadenza pigra di content.ts/RemoteCatalog lato Node", () => {
    const storage = new FakeStorage();
    savePendingSos({ packet: validPacket(Date.now() - 1000) }, storage);

    expect(loadPendingSos(storage)).toBeNull();
    expect(storage.getItem(PENDING_SOS_STORAGE_KEY)).toBeNull();
  });

  it("isPendingSosExpired() è una funzione pura indipendente, utilizzabile senza passare da storage", () => {
    const entry = { queuedAt: Date.now(), packet: validPacket(1000) };
    expect(isPendingSosExpired(entry, 500)).toBe(false);
    expect(isPendingSosExpired(entry, 1000)).toBe(true); // confine incluso — expiresAt <= now
    expect(isPendingSosExpired(entry, 1500)).toBe(true);
  });

  it("uno storage assente (nessun localStorage disponibile) non lancia mai — load torna null, save/clear sono no-op silenziosi", () => {
    expect(loadPendingSos(undefined)).toBeNull();
    expect(() => savePendingSos({ packet: validPacket() }, undefined)).not.toThrow();
    expect(() => clearPendingSos(undefined)).not.toThrow();
  });

  describe("claimSosSuccess() — arbitro condiviso tra i canali (voce #107)", () => {
    it("il primo chiamante per il packetId in coda vince: rimuove la voce e restituisce true", () => {
      const storage = new FakeStorage();
      const packet = validPacket();
      savePendingSos({ packet }, storage);

      expect(claimSosSuccess(packet.id, storage)).toBe(true);
      expect(loadPendingSos(storage)).toBeNull();
    });

    it("una seconda chiamata per lo stesso packetId, dopo che il primo canale ha già vinto, restituisce false (mai un doppio report)", () => {
      const storage = new FakeStorage();
      const packet = validPacket();
      savePendingSos({ packet }, storage);

      expect(claimSosSuccess(packet.id, storage)).toBe(true);
      expect(claimSosSuccess(packet.id, storage)).toBe(false);
    });

    it("restituisce false se la coda è vuota (nessun SOS in attesa a cui attribuire il successo)", () => {
      const storage = new FakeStorage();
      expect(claimSosSuccess("qualunque-id", storage)).toBe(false);
    });

    it("restituisce false se il packetId non corrisponde a quello attualmente in coda (un SOS più recente lo ha nel frattempo sostituito) — e non tocca quella voce più recente", () => {
      const storage = new FakeStorage();
      const oldPacket = validPacket();
      savePendingSos({ packet: oldPacket }, storage);
      const newPacket = validPacket();
      newPacket.id = "pkt-newer";
      savePendingSos({ packet: newPacket }, storage);

      expect(claimSosSuccess(oldPacket.id, storage)).toBe(false);
      expect(loadPendingSos(storage)!.packet.id).toBe("pkt-newer"); // la voce più recente resta intatta
    });
  });

  describe("raceFirstSuccess() — corsa tra i canali (voce #107)", () => {
    it("risolve a true non appena una promise si risolve a true, senza attendere le altre", async () => {
      let slowResolved = false;
      const fast = Promise.resolve(true);
      const slow = new Promise<boolean>((resolve) => setTimeout(() => {
        slowResolved = true;
        resolve(true);
      }, 50));

      const result = await raceFirstSuccess([slow, fast]);
      expect(result).toBe(true);
      expect(slowResolved).toBe(false); // non ha aspettato la promise lenta
    });

    it("risolve a false solo dopo che TUTTE le promise si sono risolte a false", async () => {
      vi.useFakeTimers();
      let secondResolved = false;
      const first = Promise.resolve(false);
      const second = new Promise<boolean>((resolve) =>
        setTimeout(() => {
          secondResolved = true;
          resolve(false);
        }, 50),
      );

      const resultPromise = raceFirstSuccess([first, second]);
      await vi.advanceTimersByTimeAsync(10);
      expect(secondResolved).toBe(false); // la seconda non si è ancora risolta — niente risultato ancora

      await vi.advanceTimersByTimeAsync(50);
      expect(await resultPromise).toBe(false);
      expect(secondResolved).toBe(true);
      vi.useRealTimers();
    });

    it("una promise che rifiuta conta come fallimento, mai come eccezione propagata al chiamante", async () => {
      const result = await raceFirstSuccess([Promise.reject(new Error("canale non disponibile")), Promise.resolve(false)]);
      expect(result).toBe(false);
    });

    it("un rifiuto non impedisce a un'altra promise di vincere la corsa se risolve a true", async () => {
      const result = await raceFirstSuccess([Promise.reject(new Error("canale non disponibile")), Promise.resolve(true)]);
      expect(result).toBe(true);
    });

    it("una lista vuota risolve subito a false (nessun canale da far correre)", async () => {
      expect(await raceFirstSuccess([])).toBe(false);
    });
  });
});
