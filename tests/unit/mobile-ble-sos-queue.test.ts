import { describe, expect, it } from "vitest";
import { PENDING_SOS_STORAGE_KEY, clearPendingSos, isPendingSosExpired, loadPendingSos, savePendingSos } from "../../mobile/www/ble-sos-queue.js";

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

describe("mobile/www/ble-sos-queue (coda SOS persistente)", () => {
  it("loadPendingSos() restituisce null quando non c'è nulla in coda", () => {
    expect(loadPendingSos(new FakeStorage())).toBeNull();
  });

  it("savePendingSos()/loadPendingSos() fanno un round-trip fedele, con un queuedAt aggiunto", () => {
    const storage = new FakeStorage();
    const packet = validPacket();
    savePendingSos(packet, storage);

    const loaded = loadPendingSos(storage);
    expect(loaded).not.toBeNull();
    expect(loaded!.packet).toEqual(packet);
    expect(typeof loaded!.queuedAt).toBe("number");
  });

  it("clearPendingSos() rimuove la voce — un load successivo torna a null", () => {
    const storage = new FakeStorage();
    savePendingSos(validPacket(), storage);
    clearPendingSos(storage);
    expect(loadPendingSos(storage)).toBeNull();
  });

  it("un secondo savePendingSos() sostituisce il primo — un solo slot, mai una lista", () => {
    const storage = new FakeStorage();
    savePendingSos(validPacket(), storage);
    const second = validPacket();
    second.id = "pkt-2";
    savePendingSos(second, storage);

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

  it("un array o una stringa al posto di un oggetto vengono trattati come assenti, mai come 'oggetto con campi mancanti' (stessa guardia di node/src/portable-config.ts)", () => {
    const storage = new FakeStorage();
    storage.setItem(PENDING_SOS_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadPendingSos(storage)).toBeNull();
  });

  it("un SOS già scaduto (expiresAt nel passato) viene trattato come assente e ripulito — stessa scadenza pigra di content.ts/RemoteCatalog lato Node", () => {
    const storage = new FakeStorage();
    savePendingSos(validPacket(Date.now() - 1000), storage);

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
    expect(() => savePendingSos(validPacket(), undefined)).not.toThrow();
    expect(() => clearPendingSos(undefined)).not.toThrow();
  });
});
