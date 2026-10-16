import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { WebUiServer } from "../../node/src/web-ui.js";

/**
 * Limite ai tentativi sulla password di rete (docs/security.md voce #141) contro un vero `WebUiServer`. I test girano da
 * loopback, che per default è esente: `exemptLocal: false` lo toglie per poter provare il limite.
 */
describe("WebUiServer: limite ai tentativi sulla password di rete", () => {
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
    webUi = new WebUiServer(node, { port: 0, exposeRelayRegistry: true, networkPassword: "K7XM-2QRT", authThrottle: { maxFailures: 3, windowMs: 60_000, exemptLocal: false }, ...options });
    await webUi.start();
    return `http://127.0.0.1:${webUi.port}`;
  }
  const relays = (base: string, pw?: string) => fetch(`${base}/api/relays`, pw ? { headers: { Authorization: `Bearer ${pw}` } } : {});

  it("dopo i tentativi sbagliati anche la password giusta aspetta (429 con Retry-After); le richieste pubbliche restano aperte", async () => {
    const base = await start();
    for (let i = 0; i < 3; i++) expect((await relays(base, `sbagliata${i}`)).status).toBe(401);
    const locked = await relays(base, "K7XM-2QRT");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    // una richiesta senza intestazione (le pagine pubbliche) non è toccata
    expect((await fetch(`${base}/api/status`)).status).toBe(200);
    expect((await fetch(`${base}/api/peers`)).status).toBe(200);
  });

  it("un indirizzo bloccato non blocca gli endpoint pubblici, nemmeno con un'intestazione Authorization nella richiesta", async () => {
    const base = await start();
    for (let i = 0; i < 3; i++) await relays(base, `x${i}`);
    expect((await relays(base, "K7XM-2QRT")).status).toBe(429);
    for (const path of ["/api/status", "/api/peers", "/api/content", "/api/drops"]) {
      expect((await fetch(`${base}${path}`, { headers: { Authorization: "Bearer K7XM-2QRT" } })).status, path).toBe(200);
    }
  });

  it("l'assenza di intestazione non conta come tentativo; un accesso riuscito azzera il conteggio", async () => {
    const base = await start();
    for (let i = 0; i < 6; i++) expect((await relays(base)).status).toBe(401); // nessuna intestazione: mai bloccato
    expect((await relays(base, "no1")).status).toBe(401);
    expect((await relays(base, "no2")).status).toBe(401);
    expect((await relays(base, "K7XM-2QRT")).status).toBe(200); // riuscito: azzera
    expect((await relays(base, "no3")).status).toBe(401);
    expect((await relays(base, "no4")).status).toBe(401);
    expect((await relays(base, "K7XM-2QRT")).status).toBe(200); // ancora sotto il limite
  });

  it("vale su ogni endpoint protetto (stesso conteggio) e non cambia le risposte quando non si sbaglia", async () => {
    const base = await start({ allowServiceCalls: true });
    expect((await fetch(`${base}/api/messages?peer=x`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(`${base}/api/messages?peer=x`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await relays(base, "nope")).status).toBe(401); // il conteggio è per indirizzo, non per endpoint: terzo errore
    expect((await fetch(`${base}/api/messages?peer=x`, { headers: { Authorization: "Bearer K7XM-2QRT" } })).status).toBe(429);
  });

  it("la macchina stessa è esente per default (il Local Portal verifica a nome degli ospiti)", async () => {
    const base = await start({ authThrottle: { maxFailures: 2 } });
    for (let i = 0; i < 10; i++) expect((await relays(base, `x${i}`)).status).toBe(401);
    expect((await relays(base, "K7XM-2QRT")).status).toBe(200);
  });

  it("authThrottle: false lo spegne", async () => {
    const base = await start({ authThrottle: false });
    for (let i = 0; i < 25; i++) expect((await relays(base, `x${i}`)).status).toBe(401);
    expect((await relays(base, "K7XM-2QRT")).status).toBe(200);
  });

  it("senza opzioni è attivo (10 tentativi), ma da loopback non limita", async () => {
    const base = await start({ authThrottle: undefined });
    for (let i = 0; i < 12; i++) expect((await relays(base, `x${i}`)).status).toBe(401);
    expect((await relays(base, "K7XM-2QRT")).status).toBe(200);
  });
});
