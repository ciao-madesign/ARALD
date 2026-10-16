import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { ipLimiterKey } from "../node/src/auth-throttle.js";
import { readRequestBody, BodyTooLargeError } from "../node/src/loopback-http-server.js";
import { TileService } from "../tools/map-data/tile-service.js";
import { HOSTED_DATA_FILE, designToolCsp, insertBackLink, removeExternalFonts } from "./hosted-page.js";

/**
 * Network Design Tool nel Local Portal (docs/emergency-portal.md, «Quindicesimo pezzo»; docs/security.md voce #140): la
 * pagina di `tools/network-design/`, i suoi pacchetti di terreno e — se il Box ha Internet — il servizio di tessere del
 * mondo, serviti sotto `/strumento-rete/` dallo stesso server del portale.
 *
 * **Accesso**: come nel Mirror Portal è riservato agli operatori, ma il Local Portal non ha utenti: l'unica credenziale
 * che conosce chi gestisce la rete è la **password di rete** del nodo (`WebUiServer`, la stessa che si scrive nell'app).
 * Il portale non la conosce e non la salva: la verifica chiedendola al nodo (`GET <gateway>/api/messages` con
 * `Authorization: Bearer`, che risponde 401 a una password sbagliata e 400 — manca `peer` — a una giusta) e, se è giusta,
 * dà un cookie di sessione casuale (`HttpOnly`, `SameSite=Strict`, solo sotto `/strumento-rete`, in memoria, con scadenza).
 * Serve che il nodo abbia la password di rete **e** le chiamate ai servizi attive (`--allow-service-calls`: è il livello
 * dell'endpoint usato per la verifica). Se il nodo non risponde o non la offre, l'accesso resta chiuso (mai aperto per
 * difetto). I tentativi sono limitati per indirizzo (un tentativo conta subito, anche in parallelo): un LAN di rifugio
 * può avere ospiti, ma uno di loro non deve poter chiudere l'accesso agli altri, quindi nessun limite globale.
 * Limite noto: il `WebUiServer` del nodo, raggiungibile direttamente sul LAN, non limita da sé i tentativi sulla
 * password di rete (vale per tutti i suoi endpoint protetti, non solo per questo): usa una password lunga e casuale.
 *
 * Il tool non legge dati della mesh: la sessione protegge l'uso del Box (scarico di tessere da Internet, banda, disco).
 */
export const DESIGN_TOOL_PATH = "/strumento-rete";
const COOKIE_NAME = "arald_design_tool";
const LOGIN_BODY_MAX_BYTES = 2048;
const TILE_ROUTE = /^\/(\d{1,5})\/(\d{1,5})$/;

export interface DesignToolOptions {
  /** `tools/network-design/dist/` costruita con `npm run design-tool:build` (pagina `index.html` e cartella `data/`). */
  distDir: string;
  /** Indirizzo del `WebUiServer` del nodo, per verificare la password di rete. */
  gatewayUrl: string;
  /** Servizio di tessere del mondo; assente = solo i pacchetti. */
  tiles?: TileService;
  fetchFn?: typeof fetch;
  now?: () => number;
  sessionTtlMs?: number;
  maxSessions?: number;
  /** Tentativi di accesso ammessi per indirizzo nella finestra (default 5 in 10 minuti): un tentativo conta subito, e si scarta se la password è giusta. */
  maxLoginFailures?: number;
  loginWindowMs?: number;
  /** Verifiche contemporanee verso il nodo (default 4): oltre, 429. */
  maxConcurrentChecks?: number;
}

type PasswordCheck = "ok" | "wrong" | "unavailable";

export class DesignToolRoutes {
  private readonly o: Required<Omit<DesignToolOptions, "tiles">> & { tiles?: TileService };
  private readonly sessions = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; since: number }>();
  private checksInFlight = 0;

  constructor(options: DesignToolOptions) {
    this.o = {
      fetchFn: fetch,
      now: Date.now,
      sessionTtlMs: 8 * 3_600_000,
      maxSessions: 200,
      maxLoginFailures: 5,
      loginWindowMs: 600_000,
      maxConcurrentChecks: 4,
      ...options,
      gatewayUrl: options.gatewayUrl.replace(/\/+$/, ""),
      distDir: path.resolve(options.distDir),
    };
  }

  /** Vero se la richiesta è di questo modulo (la risposta è stata data o è in corso). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname !== DESIGN_TOOL_PATH && !pathname.startsWith(`${DESIGN_TOOL_PATH}/`)) return false;
    try {
      await this.route(req, res, pathname.slice(DESIGN_TOOL_PATH.length));
    } catch {
      if (!res.headersSent) text(res, 500, "Errore interno");
      else res.end();
    }
    return true;
  }

  private async route(req: IncomingMessage, res: ServerResponse, sub: string): Promise<void> {
    const head = req.method === "HEAD";
    if (sub === "" ) { redirect(res, `${DESIGN_TOOL_PATH}/`); return; }
    if (sub === "/accesso") {
      if (req.method === "POST") return this.login(req, res);
      if (req.method === "GET" || head) return loginPage(res, head);
      return methodNotAllowed(res, "GET, HEAD, POST");
    }
    if (req.method !== "GET" && !head) return methodNotAllowed(res, "GET, HEAD");

    if (sub === "/") {
      if (!this.hasSession(req)) { redirect(res, `${DESIGN_TOOL_PATH}/accesso`); return; }
      return this.page(res, head);
    }
    if (sub.startsWith("/data/")) {
      if (!this.hasSession(req)) return text(res, 401, "Accesso non autorizzato");
      return this.dataFile(res, sub.slice("/data/".length), head);
    }
    if (sub.startsWith("/tiles/")) {
      if (!this.hasSession(req)) return text(res, 401, "Accesso non autorizzato");
      return this.tiles(req, res, sub.slice("/tiles".length), head);
    }
    text(res, 404, "Non trovato");
  }

  // ------------------------------------------------------------ sessione

  private hasSession(req: IncomingMessage): boolean {
    const token = readCookie(req.headers.cookie, COOKIE_NAME);
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
    const exp = this.sessions.get(token);
    if (exp === undefined) return false;
    if (this.o.now() >= exp) { this.sessions.delete(token); return false; }
    return true;
  }

  private newSession(): string {
    const now = this.o.now();
    for (const [k, exp] of this.sessions) if (now >= exp) this.sessions.delete(k);
    while (this.sessions.size >= this.o.maxSessions) this.sessions.delete(this.sessions.keys().next().value as string);
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, now + this.o.sessionTtlMs);
    return token;
  }

  // ------------------------------------------------------------ accesso

  private async verifyPassword(password: string): Promise<PasswordCheck> {
    try {
      const r = await this.o.fetchFn(`${this.o.gatewayUrl}/api/messages`, { headers: { Authorization: `Bearer ${password}` }, signal: AbortSignal.timeout(5000) });
      await r.arrayBuffer().catch(() => undefined);
      if (r.status === 400) return "ok"; // password giusta, manca solo `peer`
      if (r.status === 401) return "wrong";
      return "unavailable"; // 404: il nodo non ha una password di rete; altro: nodo non raggiungibile o risposta imprevista
    } catch {
      return "unavailable";
    }
  }

  private locked(key: string): boolean {
    const f = this.failures.get(key);
    return f !== undefined && this.o.now() - f.since < this.o.loginWindowMs && f.count >= this.o.maxLoginFailures;
  }

  /** Conta il tentativo PRIMA di verificarlo: tentativi in parallelo non aggirano il limite. */
  private reserveAttempt(key: string): void {
    const now = this.o.now();
    const f = this.failures.get(key);
    if (!f || now - f.since >= this.o.loginWindowMs) {
      this.failures.delete(key);
      while (this.failures.size >= 1000) this.failures.delete(this.failures.keys().next().value as string); // si scarta il più vecchio, mai tutto
      this.failures.set(key, { count: 1, since: now });
    } else f.count++;
  }

  /** Un tentativo riuscito, o non verificabile per colpa del nodo, non pesa sull'operatore. */
  private releaseAttempt(key: string): void {
    const f = this.failures.get(key);
    if (!f) return;
    if (f.count <= 1) this.failures.delete(key);
    else f.count--;
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // login CSRF: dalla pagina stessa o da un client che non manda nessuna delle due intestazioni (curl, test)
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    if ((site !== undefined && site !== "same-origin") || (origin !== undefined && origin !== `http://${req.headers.host}`)) return text(res, 403, "Richiesta non consentita");
    const key = ipLimiterKey(req.socket.remoteAddress);
    if (this.locked(key)) { res.setHeader("Retry-After", String(Math.ceil(this.o.loginWindowMs / 1000))); return loginPage(res, false, "Troppi tentativi: riprova tra qualche minuto.", 429); }
    if (this.checksInFlight >= this.o.maxConcurrentChecks) { res.setHeader("Retry-After", "5"); return loginPage(res, false, "Troppe verifiche in corso: riprova tra poco.", 429); }
    this.reserveAttempt(key);
    let password = "";
    try {
      const body = (await readRequestBody(req, LOGIN_BODY_MAX_BYTES, 5000)).toString("utf8");
      password = new URLSearchParams(body).get("password") ?? "";
    } catch (e) {
      return text(res, e instanceof BodyTooLargeError ? 413 : 400, "Richiesta non valida");
    }
    // la password viaggia in un'intestazione HTTP, come nell'app: solo caratteri ASCII stampabili (altrimenti non è mai quella del nodo)
    if (!/^[\x20-\x7e]{1,200}$/.test(password)) return loginPage(res, false, "Password di rete non valida.", 401);
    this.checksInFlight++;
    let check: PasswordCheck;
    try {
      check = await this.verifyPassword(password);
    } finally {
      this.checksInFlight--;
    }
    if (check === "unavailable") {
      this.releaseAttempt(key);
      return loginPage(res, false, "Non riesco a verificare la password: il nodo non risponde, non ha una password di rete o non ha attive le chiamate ai servizi (--allow-service-calls). L'accesso resta chiuso.", 503);
    }
    if (check === "wrong") return loginPage(res, false, "Password di rete non valida.", 401);
    this.releaseAttempt(key);
    const token = this.newSession();
    res.writeHead(303, {
      Location: `${DESIGN_TOOL_PATH}/`,
      "Set-Cookie": `${COOKIE_NAME}=${token}; Path=${DESIGN_TOOL_PATH}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.o.sessionTtlMs / 1000)}`,
      "Cache-Control": "no-store",
    });
    res.end();
  }

  // ------------------------------------------------------------ contenuti

  private async page(res: ServerResponse, head: boolean): Promise<void> {
    let html: string;
    try {
      html = insertBackLink(removeExternalFonts(await readFile(path.join(this.o.distDir, "index.html"), "utf8")), "/", "Dashboard");
    } catch {
      return text(res, 503, "Strumento non disponibile: costruisci la pagina con «npm run design-tool:build».");
    }
    const body = Buffer.from(html, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      "Content-Security-Policy": designToolCsp(html),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    });
    res.end(head ? undefined : body);
  }

  private async dataFile(res: ServerResponse, name: string, head: boolean): Promise<void> {
    if (!HOSTED_DATA_FILE.test(name)) return text(res, 404, "Non trovato");
    let body: Buffer;
    try {
      body = await readFile(path.join(this.o.distDir, "data", name));
    } catch {
      return text(res, 404, "Non trovato");
    }
    res.writeHead(200, {
      "Content-Type": name.endsWith(".json") ? "application/json; charset=utf-8" : "application/gzip",
      "Content-Length": body.length,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(head ? undefined : body);
  }

  /** `/tiles/status` e `/tiles/<tx>/<ty>`: stesso contratto del server locale del tool (tools/network-design/serve-lib.mjs). */
  private async tiles(req: IncomingMessage, res: ServerResponse, sub: string, head: boolean): Promise<void> {
    if (!this.o.tiles) return text(res, 404, "Servizio di tessere non attivo");
    // la pagina aggiunge un'intestazione che un altro sito non può aggiungere (richiederebbe un permesso CORS che questo server non dà)
    const h = req.headers;
    if (h["x-arald-tool"] !== "1" || (h["sec-fetch-site"] !== undefined && h["sec-fetch-site"] !== "same-origin") || (h.origin !== undefined && h.origin !== `http://${h.host}`)) {
      return text(res, 403, "Richiesta di tessere non consentita");
    }
    try {
      if (sub === "/status") {
        const body = JSON.stringify(this.o.tiles.status());
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end(head ? undefined : body);
        return;
      }
      const m = TILE_ROUTE.exec(sub);
      if (!m) return text(res, 404, "Non trovato");
      const { data, cached } = await this.o.tiles.get(Number(m[1]), Number(m[2]));
      res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": data.length, "Cache-Control": "private, max-age=3600", "X-Tile-Cache": cached ? "hit" : "built", "X-Content-Type-Options": "nosniff" });
      res.end(head ? undefined : data);
    } catch (e) {
      const own = (e as { isTileServiceError?: boolean })?.isTileServiceError === true;
      const status = own ? (e as { status: number }).status : 500;
      const retry = own ? (e as { retryAfterS?: number }).retryAfterS : undefined;
      if (retry) res.setHeader("Retry-After", String(retry));
      text(res, status, own && status !== 500 ? String((e as Error).message) : "Errore interno");
    }
  }
}

// ---------------------------------------------------------------- utilità

/** Chiave del limite dei tentativi: la stessa del nodo (`node/src/auth-throttle.ts`), riesportata per i test. */
export { ipLimiterKey };

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(302, { Location: to, "Cache-Control": "no-store" });
  res.end();
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, { Allow: allow, "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method Not Allowed");
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

const LOGIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function loginPage(res: ServerResponse, head: boolean, message = "", status = 200): void {
  const msg = message ? `<p class="err" role="alert">${message.replace(/[<>&"]/g, "")}</p>` : "";
  const html = `<!doctype html>
<html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ARALD — Strumento di progettazione</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#eff2f6;color:#18202e}main{background:#fff;border:1px solid #d0d7e2;border-radius:8px;padding:20px 24px;width:min(380px,92vw)}h1{font-size:17px;margin:0 0 6px}p{margin:6px 0;color:#596579;font-size:13.5px}label{display:block;margin:12px 0 4px;font-size:13px}input{width:100%;box-sizing:border-box;padding:8px;font:inherit;border:1px solid #d0d7e2;border-radius:5px}button{margin-top:12px;padding:8px 14px;font:inherit;background:#2b47c9;color:#fff;border:0;border-radius:5px;cursor:pointer}.err{color:#cc3b3b}a{color:#2b47c9}</style>
<main><h1>Strumento di progettazione della rete</h1><p>Accesso per chi gestisce la rete: serve la password di rete di questo nodo (la stessa dell'app).</p>${msg}
<form method="post" action="${DESIGN_TOOL_PATH}/accesso"><label for="p">Password di rete</label><input id="p" name="password" type="password" autocomplete="current-password" maxlength="200" required><button type="submit">Accedi</button></form>
<p><a href="/">← Dashboard</a></p></main></html>
`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": LOGIN_CSP, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" });
  res.end(head ? undefined : html);
}
