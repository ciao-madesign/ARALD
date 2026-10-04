import { describe, expect, it } from "vitest";
import { ACTIVE_EMERGENCY_STORAGE_KEY, clearActiveEmergency, loadActiveEmergency, markActiveEmergencySent, saveActiveEmergency } from "../../mobile/www/emergency-state.js";

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

function queuedEntry(overrides: Record<string, unknown> = {}) {
  return { activatedAt: Date.now(), status: "queued" as const, message: "aiuto", lat: 45.1, lon: 9.1, ...overrides };
}

describe("mobile/www/emergency-state (Emergency State Screen, docs/ux-ui-design-system.md §8)", () => {
  it("loadActiveEmergency() restituisce null quando non c'è nessuna emergenza attiva", () => {
    expect(loadActiveEmergency(new FakeStorage())).toBeNull();
  });

  it("saveActiveEmergency()/loadActiveEmergency() fanno un round-trip fedele", () => {
    const storage = new FakeStorage();
    const entry = queuedEntry();
    saveActiveEmergency(entry, storage);

    expect(loadActiveEmergency(storage)).toEqual(entry);
  });

  it("message/lat/lon/channel/sentAt sono facoltativi", () => {
    const storage = new FakeStorage();
    saveActiveEmergency({ activatedAt: Date.now(), status: "queued" }, storage);

    const loaded = loadActiveEmergency(storage);
    expect(loaded).not.toBeNull();
    expect(loaded!.message).toBeUndefined();
    expect(loaded!.lat).toBeUndefined();
    expect(loaded!.lon).toBeUndefined();
    expect(loaded!.channel).toBeUndefined();
    expect(loaded!.sentAt).toBeUndefined();
  });

  it("clearActiveEmergency() rimuove la voce — un load successivo torna a null", () => {
    const storage = new FakeStorage();
    saveActiveEmergency(queuedEntry(), storage);
    clearActiveEmergency(storage);
    expect(loadActiveEmergency(storage)).toBeNull();
  });

  it("un secondo saveActiveEmergency() sostituisce il primo — un solo slot, mai una lista", () => {
    const storage = new FakeStorage();
    saveActiveEmergency(queuedEntry({ message: "prima emergenza" }), storage);
    saveActiveEmergency(queuedEntry({ message: "seconda emergenza" }), storage);

    expect(loadActiveEmergency(storage)!.message).toBe("seconda emergenza");
  });

  it("JSON malformato viene trattato come assente e ripulito da storage, mai un errore per il chiamante", () => {
    const storage = new FakeStorage();
    storage.setItem(ACTIVE_EMERGENCY_STORAGE_KEY, "{ non valido");

    expect(loadActiveEmergency(storage)).toBeNull();
    expect(storage.getItem(ACTIVE_EMERGENCY_STORAGE_KEY)).toBeNull();
  });

  it("una voce con status di valore inatteso viene trattata come assente e ripulita", () => {
    const storage = new FakeStorage();
    storage.setItem(ACTIVE_EMERGENCY_STORAGE_KEY, JSON.stringify({ activatedAt: Date.now(), status: "concluded" }));

    expect(loadActiveEmergency(storage)).toBeNull();
    expect(storage.getItem(ACTIVE_EMERGENCY_STORAGE_KEY)).toBeNull();
  });

  it("una voce con channel di valore inatteso viene trattata come assente e ripulita", () => {
    const storage = new FakeStorage();
    storage.setItem(ACTIVE_EMERGENCY_STORAGE_KEY, JSON.stringify({ activatedAt: Date.now(), status: "sent", channel: "satellite" }));

    expect(loadActiveEmergency(storage)).toBeNull();
  });

  it("un array o una stringa al posto di un oggetto vengono trattati come assenti, mai come 'oggetto con campi mancanti' (stessa guardia di sos-queue.js/node/src/portable-config.ts)", () => {
    const storage = new FakeStorage();
    storage.setItem(ACTIVE_EMERGENCY_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadActiveEmergency(storage)).toBeNull();
  });

  it("uno storage assente (nessun localStorage disponibile) non lancia mai — load torna null, save/clear sono no-op silenziosi", () => {
    expect(loadActiveEmergency(undefined)).toBeNull();
    expect(() => saveActiveEmergency(queuedEntry(), undefined)).not.toThrow();
    expect(() => clearActiveEmergency(undefined)).not.toThrow();
  });

  describe("markActiveEmergencySent()", () => {
    it("aggiorna una emergenza 'queued' a 'sent', aggiungendo channel e sentAt, preservando gli altri campi", () => {
      const storage = new FakeStorage();
      saveActiveEmergency(queuedEntry(), storage);

      const updated = markActiveEmergencySent("gateway", storage);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("sent");
      expect(updated!.channel).toBe("gateway");
      expect(typeof updated!.sentAt).toBe("number");
      expect(updated!.message).toBe("aiuto");
      expect(updated!.lat).toBe(45.1);

      expect(loadActiveEmergency(storage)).toEqual(updated);
    });

    it("restituisce null senza scrivere nulla se non c'è nessuna emergenza attiva", () => {
      const storage = new FakeStorage();
      expect(markActiveEmergencySent("gateway", storage)).toBeNull();
      expect(loadActiveEmergency(storage)).toBeNull();
    });

    it("non sovrascrive un'emergenza già 'sent' con un secondo canale arrivato dopo (il primo canale a riuscire è quello attribuito)", () => {
      const storage = new FakeStorage();
      saveActiveEmergency(queuedEntry(), storage);
      markActiveEmergencySent("bluetooth", storage);

      const second = markActiveEmergencySent("gateway", storage);
      expect(second).toBeNull();
      expect(loadActiveEmergency(storage)!.channel).toBe("bluetooth");
    });

    it("non resuscita un'emergenza già conclusa dall'utente (clearActiveEmergency chiamato nel frattempo da un canale in ritardo)", () => {
      const storage = new FakeStorage();
      saveActiveEmergency(queuedEntry(), storage);
      clearActiveEmergency(storage);

      expect(markActiveEmergencySent("bluetooth", storage)).toBeNull();
      expect(loadActiveEmergency(storage)).toBeNull();
    });
  });
});
