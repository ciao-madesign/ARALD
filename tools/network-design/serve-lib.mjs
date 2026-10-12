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

export function createStaticServer(root) {
  const server = createServer(async (req, res) => {
    if (!allowedHost(req.headers.host, server.address()?.port)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Host non consentito");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
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
