import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { WebUiServer } from "../../node/src/web-ui.js";

/**
 * `GET /api/pairing` mostra la password di rete e il QR solo a chi è sulla macchina del nodo (docs/security.md voce #144).
 * I test girano da loopback: `machineAddresses` iniettato senza loopback fa sembrare «remota» la richiesta.
 */
describe("WebUiServer: password e QR di pairing solo dalla macchina del nodo", () => {
  const PASSWORD = "K7XM-2QRT";
  let node: NomadNode | undefined;
  let webUi: WebUiServer | undefined;

  afterEach(async () => {
    await webUi?.stop();
    await node?.stop();
    webUi = undefined;
    node = undefined;
  });

  async function start(options: Record<string, unknown> = {}): Promise<string> {
    node = new NomadNode({ displayName: "Box" });
    await node.start();
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: PASSWORD, networkName: "Rifugio", publicHost: "192.168.1.50", ...options });
    await webUi.start();
    return `http://127.0.0.1:${webUi.port}`;
  }
  const REMOTE = { machineAddresses: () => new Set(["192.168.1.50"]) }; // la macchina non ha loopback: la richiesta da 127.0.0.1 è «remota»

  it("dalla macchina stessa: nome, password e QR come prima", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/pairing`);
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.networkPassword).toBe(PASSWORD);
    expect(info.networkName).toBe("Rifugio");
    expect(info.qrDataUri).toMatch(/^data:image\/svg\+xml/);
  });

  it("da un altro dispositivo: 403, e la password non compare in nessuna risposta", async () => {
    const base = await start(REMOTE);
    const res = await fetch(`${base}/api/pairing`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ reason: "local-only" });
    expect(body).not.toContain(PASSWORD);
    for (const path of ["/api/status", "/api/peers", "/api/services", "/api/content", "/api/drops", "/", "/welcome"]) {
      const r = await fetch(`${base}${path}`);
      expect(await r.text(), path).not.toContain(PASSWORD);
    }
  });

  it("anche con intestazioni che fingono un'origine locale (X-Forwarded-For, Host, Origin): resta 403", async () => {
    const base = await start(REMOTE);
    const res = await fetch(`${base}/api/pairing`, { headers: { "X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1", Forwarded: "for=127.0.0.1", Origin: "http://localhost" } });
    expect(res.status).toBe(403);
  });

  it("con pairingOnLan torna il comportamento di prima (password visibile a ogni dispositivo)", async () => {
    const base = await start({ ...REMOTE, pairingOnLan: true });
    const res = await fetch(`${base}/api/pairing`);
    expect(res.status).toBe(200);
    expect((await res.json()).networkPassword).toBe(PASSWORD);
  });

  it("pairing non abilitato: 404 anche da remoto (nessuna differenza nota a chi guarda da fuori, tranne l'esistenza)", async () => {
    node = new NomadNode({ displayName: "Box" });
    await node.start();
    webUi = new WebUiServer(node, { port: 0, ...REMOTE });
    await webUi.start();
    expect((await fetch(`http://127.0.0.1:${webUi.port}/api/pairing`)).status).toBe(404);
  });

  it("le pagine hanno l'avviso per chi non è sulla macchina (dashboard e benvenuto) e gestiscono il 403", async () => {
    const base = await start(REMOTE);
    const dash = await (await fetch(`${base}/`)).text();
    expect(dash).toContain('id="pairing-remote-note"');
    expect(dash).toContain("res.status === 403");
    const welcome = await (await fetch(`${base}/welcome`)).text();
    expect(welcome).toContain('id="welcome-pairing-remote"');
    expect(welcome).toContain("res.status === 403");
  });

  it("l'esenzione dal limite ai tentativi segue lo stesso elenco della macchina", async () => {
    const base = await start({ ...REMOTE, exposeRelayRegistry: true, authThrottle: { maxFailures: 2 } });
    for (let i = 0; i < 2; i++) expect((await fetch(`${base}/api/relays`, { headers: { Authorization: `Bearer no${i}` } })).status).toBe(401);
    expect((await fetch(`${base}/api/relays`, { headers: { Authorization: `Bearer ${PASSWORD}` } })).status).toBe(429); // da «remoto» il limite vale
  });

  it("da locale ma cross-site (Origin estraneo, Sec-Fetch-Site, Host non locale): 403 e nessun CORS", async () => {
    const base = await start();
    const ok = await fetch(`${base}/api/pairing`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    const evilOrigin = await fetch(`${base}/api/pairing`, { headers: { Origin: "https://evil.example" } });
    expect(evilOrigin.status).toBe(403);
    expect(await evilOrigin.text()).not.toContain(PASSWORD);
    const crossSite = await fetch(`${base}/api/pairing`, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    const sameOrigin = await fetch(`${base}/api/pairing`, { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(sameOrigin.status).toBe(200);
  });

  it("DNS rebinding: Host con un nome di dominio qualunque è rifiutato", async () => {
    const base = await start();
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(`${base}/api/pairing`, { headers: { Host: `rebind.evil.example:${webUi!.port}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on("error", reject);
      r.end();
    });
    expect(status).toBe(403);
  });
});
