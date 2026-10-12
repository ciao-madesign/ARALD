/**
 * Server statico minimo per la pagina del tool (solo 127.0.0.1): serve la cartella `dist/` (pagina e
 * mappe in `dist/data/`). Un browser non carica i file dati da una pagina aperta con file://, per
 * questo serve. Nessuna dipendenza: node:http.
 */
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gz": "application/gzip",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Percorso di un file sotto `root` per un indirizzo di richiesta, o null se esce dalla cartella o non è valido. */
export function resolveRequestPath(root, urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  if (p.includes("\0") || p.includes("\\")) return null;
  if (p.endsWith("/")) p += "index.html";
  const full = resolve(join(root, p));
  const base = resolve(root);
  return full === base || full.startsWith(base + sep) ? full : null;
}

/** Politica di sicurezza dei contenuti: la pagina usa script e stile in linea e i caratteri di Google Fonts, nient'altro. */
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Vero se l'intestazione Host è quella del server locale: un sito che punta il proprio nome su 127.0.0.1 (DNS rebinding) non passa. */
export function allowedHost(host, port) {
  if (typeof host !== "string") return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

/**
 * Intestazione che la pagina aggiunge alle richieste di tessere: un altro sito non può aggiungerla senza passare da una
 * richiesta di verifica (preflight) CORS, e questo server non risponde mai a OPTIONS né manda intestazioni
 * `Access-Control-Allow-*`. NON aggiungere CORS o un gestore OPTIONS generico qui senza rivedere questa difesa.
 */
export const TILE_HEADER = "x-arald-tool";

/** Vero se la richiesta di tessere arriva dalla pagina stessa: intestazione presente e, se c'è, Origin uguale all'Host. */
export function sameOriginTileRequest(headers) {
  if (headers[TILE_HEADER] !== "1") return false;
  const site = headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return false;
  const origin = headers.origin;
  return origin === undefined || origin === `http://${headers.host}`;
}

const TILE_ROUTE = /^\/tiles\/(\d{1,5})\/(\d{1,5})$/;

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", ...extra }).end(text);
}

/**
 * Risponde a `/tiles/<tx>/<ty>` (tessera compressa) e `/tiles/status` (JSON) con il servizio di tessere. Restituisce
 * true se l'indirizzo era di questo tipo (la risposta è stata data o è in corso).
 */
async function handleTiles(tiles, req, res) {
  const path = (req.url ?? "").split("?")[0];
  if (path !== "/tiles/status" && !TILE_ROUTE.test(path)) return false;
  if (!sameOriginTileRequest(req.headers)) {
    sendText(res, 403, "Richiesta di tessere non consentita");
    return true;
  }
  if (!tiles) {
    sendText(res, 404, "Servizio di tessere non attivo");
    return true;
  }
  try {
    if (path === "/tiles/status") {
      const body = JSON.stringify(tiles.status());
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).end(req.method === "HEAD" ? undefined : body);
      return true;
    }
    const m = TILE_ROUTE.exec(path);
    const { data, cached } = await tiles.get(Number(m[1]), Number(m[2]));
    res.writeHead(200, {
      "Content-Type": "application/gzip", "Content-Length": data.length, "Cache-Control": "private, max-age=3600",
      "X-Tile-Cache": cached ? "hit" : "built", "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch (e) {
    // solo gli errori del servizio di tessere scelgono il codice e il testo; qualunque altro errore è un 500 senza dettagli
    const own = e?.isTileServiceError === true && Number.isInteger(e.status) && e.status >= 400 && e.status <= 599;
    sendText(res, own ? e.status : 500, own && e.status !== 500 ? String(e.message) : "Errore interno", own && e.retryAfterS ? { "Retry-After": String(e.retryAfterS) } : {});
  }
  return true;
}

/** `tiles` (opzionale): servizio con `get(tx, ty)` e `status()`, vedi tools/map-data/tile-service.ts. */
export function createStaticServer(root, tiles = undefined) {
  const server = createServer(async (req, res) => {
    if (!allowedHost(req.headers.host, server.address()?.port)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Host non consentito");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    if (await handleTiles(tiles, req, res)) return;
    const file = resolveRequestPath(root, req.url ?? "/");
    if (!file) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Indirizzo non valido");
      return;
    }
    try {
      // un collegamento simbolico dentro la cartella non deve poter portare fuori
      const real = await realpath(file);
      const realRoot = await realpath(root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Non consentito");
        return;
      }
      const body = await readFile(real);
      res.writeHead(200, {
        "Content-Security-Policy": CSP,
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Content-Length": body.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Non trovato");
    }
  });
  return server;
}
