import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Identity } from "../../node/src/identity.js";
import { signDiscoveryRegistration } from "../../node/src/discovery-client.js";
import { DiscoveryService } from "../../discovery-service/server.js";

/**
 * `discovery-service/server.ts` — l'"elenco telefonico" condiviso per "Internet come trasporto
 * opzionale tra nodi mesh lontani" (`docs/next-steps.md`). Esercita il server HTTP reale con `fetch()`
 * reale (nessun mock — a differenza di `whatsapp-relay.test.ts`, qui non c'è alcuna guardia SSRF da
 * aggirare: un loopback è un indirizzo di test perfettamente legittimo anche per questo servizio).
 */
describe("DiscoveryService", () => {
  let service: DiscoveryService;
  let baseUrl: string;
  const ADMIN_PASSWORD = "admin-secret";

  beforeEach(async () => {
    service = new DiscoveryService({ port: 0, adminPassword: ADMIN_PASSWORD });
    await service.start();
    baseUrl = `http://127.0.0.1:${service.port}`;
  });

  afterEach(async () => {
    await service.stop();
  });

  it("registra un indirizzo e lo rende cercabile per nodeId", async () => {
    const identity = Identity.generate();
    const registration = signDiscoveryRegistration(identity, "203.0.113.5:9000", undefined, Date.now());

    const registerRes = await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(registration) });
    expect(registerRes.status).toBe(200);

    const lookupRes = await fetch(`${baseUrl}/lookup/${identity.nodeId}`);
    expect(lookupRes.status).toBe(200);
    expect(await lookupRes.json()).toEqual({ address: "203.0.113.5:9000" });
  });

  it("lookup di un nodeId mai registrato risponde 404", async () => {
    const res = await fetch(`${baseUrl}/lookup/${Identity.generate().nodeId}`);
    expect(res.status).toBe(404);
  });

  it("rifiuta una registrazione con firma non valida (manomessa dopo la firma)", async () => {
    const identity = Identity.generate();
    const registration = signDiscoveryRegistration(identity, "203.0.113.5:9000", undefined, Date.now());
    const tampered = { ...registration, address: "198.51.100.1:9000" };

    const res = await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tampered) });
    expect(res.status).toBe(401);

    expect((await fetch(`${baseUrl}/lookup/${identity.nodeId}`)).status).toBe(404);
  });

  it("rifiuta un corpo malformato (campi mancanti/di forma inattesa) senza mai lanciare lato server", async () => {
    const res = await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeId: 42 }) });
    expect(res.status).toBe(400);
  });

  it("rifiuta un address di forma non plausibile (non 'host:port')", async () => {
    const identity = Identity.generate();
    const registration = signDiscoveryRegistration(identity, "indirizzo-senza-porta", undefined, Date.now());
    const res = await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(registration) });
    expect(res.status).toBe(400);
  });

  it("anti-replay: una seconda registrazione con timestamp non più recente viene rifiutata, la prima resta valida", async () => {
    const identity = Identity.generate();
    const now = Date.now();
    const first = signDiscoveryRegistration(identity, "203.0.113.5:9000", undefined, now);
    await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(first) });

    const replay = signDiscoveryRegistration(identity, "198.51.100.1:9000", undefined, now - 1000);
    const res = await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(replay) });
    expect(res.status).toBe(409);

    const lookupRes = await fetch(`${baseUrl}/lookup/${identity.nodeId}`);
    expect(await lookupRes.json()).toEqual({ address: "203.0.113.5:9000" }); // l'indirizzo originale, non quello del replay
  });

  it("una registrazione più recente con lo stesso nodeId aggiorna correttamente l'indirizzo", async () => {
    const identity = Identity.generate();
    const now = Date.now();
    await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signDiscoveryRegistration(identity, "203.0.113.5:9000", undefined, now)) });
    await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signDiscoveryRegistration(identity, "198.51.100.1:9000", undefined, now + 1000)) });

    const lookupRes = await fetch(`${baseUrl}/lookup/${identity.nodeId}`);
    expect(await lookupRes.json()).toEqual({ address: "198.51.100.1:9000" });
  });

  it("la rubrica pubblica elenca solo le voci con un label, mai l'indirizzo", async () => {
    const withLabel = Identity.generate();
    const withoutLabel = Identity.generate();
    const now = Date.now();
    await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signDiscoveryRegistration(withLabel, "203.0.113.5:9000", "Rifugio Test", now)) });
    await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signDiscoveryRegistration(withoutLabel, "198.51.100.1:9000", undefined, now)) });

    const directoryRes = await fetch(`${baseUrl}/directory`);
    const directory = await directoryRes.json();
    expect(directory).toEqual([{ nodeId: withLabel.nodeId, label: "Rifugio Test", verified: false }]);
  });

  describe("verifica admin", () => {
    it("senza password admin configurata, /admin/verify risponde sempre 404", async () => {
      const unadminnedService = new DiscoveryService({ port: 0 });
      await unadminnedService.start();
      try {
        const res = await fetch(`http://127.0.0.1:${unadminnedService.port}/admin/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeId: "x", verified: true }) });
        expect(res.status).toBe(404);
      } finally {
        await unadminnedService.stop();
      }
    });

    it("richiede la password admin corretta (401 su password mancante o errata)", async () => {
      const noAuthRes = await fetch(`${baseUrl}/admin/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeId: "x", verified: true }) });
      expect(noAuthRes.status).toBe(401);

      const wrongAuthRes = await fetch(`${baseUrl}/admin/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
        body: JSON.stringify({ nodeId: "x", verified: true }),
      });
      expect(wrongAuthRes.status).toBe(401);

      // Stessa lunghezza della password reale ("admin-secret", 12 caratteri) — a differenza del caso
      // sopra, questo esercita davvero il confronto byte-per-byte di timingSafeEqual() invece del solo
      // controllo di lunghezza che lo precede (trovato dalla revisione: il confronto era originariamente
      // un `!==` su stringhe, un canale laterale di temporizzazione per chi può interrogare questo
      // servizio ripetutamente via Internet).
      const sameLengthWrongAuthRes = await fetch(`${baseUrl}/admin/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer xdmin-secret" },
        body: JSON.stringify({ nodeId: "x", verified: true }),
      });
      expect(sameLengthWrongAuthRes.status).toBe(401);
    });

    it("marca una voce come verificata, visibile nella rubrica pubblica", async () => {
      const identity = Identity.generate();
      await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signDiscoveryRegistration(identity, "203.0.113.5:9000", "CNSAS Test", Date.now())) });

      const verifyRes = await fetch(`${baseUrl}/admin/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_PASSWORD}` },
        body: JSON.stringify({ nodeId: identity.nodeId, verified: true }),
      });
      expect(verifyRes.status).toBe(200);

      const directory = await (await fetch(`${baseUrl}/directory`)).json();
      expect(directory).toEqual([{ nodeId: identity.nodeId, label: "CNSAS Test", verified: true }]);
    });

    it("cambiare il label di una voce verificata azzera la verifica (la spunta certifica quello specifico label)", async () => {
      const identity = Identity.generate();
      const now = Date.now();
      await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signDiscoveryRegistration(identity, "203.0.113.5:9000", "CNSAS Test", now)) });
      await fetch(`${baseUrl}/admin/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_PASSWORD}` },
        body: JSON.stringify({ nodeId: identity.nodeId, verified: true }),
      });

      await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signDiscoveryRegistration(identity, "203.0.113.5:9000", "Nome diverso", now + 1000)) });

      const directory = await (await fetch(`${baseUrl}/directory`)).json();
      expect(directory).toEqual([{ nodeId: identity.nodeId, label: "Nome diverso", verified: false }]);
    });

    it("re-registrare con lo stesso label mantiene la verifica (solo un cambio di indirizzo, non di identità dichiarata)", async () => {
      const identity = Identity.generate();
      const now = Date.now();
      await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signDiscoveryRegistration(identity, "203.0.113.5:9000", "CNSAS Test", now)) });
      await fetch(`${baseUrl}/admin/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_PASSWORD}` },
        body: JSON.stringify({ nodeId: identity.nodeId, verified: true }),
      });

      await fetch(`${baseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signDiscoveryRegistration(identity, "198.51.100.1:9000", "CNSAS Test", now + 1000)) });

      const directory = await (await fetch(`${baseUrl}/directory`)).json();
      expect(directory).toEqual([{ nodeId: identity.nodeId, label: "CNSAS Test", verified: true }]);
    });

    it("verify su un nodeId mai registrato risponde 404", async () => {
      const res = await fetch(`${baseUrl}/admin/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_PASSWORD}` },
        body: JSON.stringify({ nodeId: "mai-registrato", verified: true }),
      });
      expect(res.status).toBe(404);
    });
  });

  it("un nodeId che si registra senza mai raggiungere il limite di dimensione resta comunque sano (bound difensivo presente — maxRegistrations)", async () => {
    const small = new DiscoveryService({ port: 0, maxRegistrations: 2 });
    await small.start();
    try {
      const smallBaseUrl = `http://127.0.0.1:${small.port}`;
      const ids = [Identity.generate(), Identity.generate(), Identity.generate()];
      for (const id of ids) {
        await fetch(`${smallBaseUrl}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signDiscoveryRegistration(id, "203.0.113.5:9000", undefined, Date.now())) });
      }
      // Il primo nodeId registrato deve essere stato sfrattato (FIFO, maxRegistrations: 2) per fare
      // spazio al terzo — verifica che l'eviction esista davvero, non solo che non lanci.
      expect((await fetch(`${smallBaseUrl}/lookup/${ids[0].nodeId}`)).status).toBe(404);
      expect((await fetch(`${smallBaseUrl}/lookup/${ids[2].nodeId}`)).status).toBe(200);
    } finally {
      await small.stop();
    }
  });
});
