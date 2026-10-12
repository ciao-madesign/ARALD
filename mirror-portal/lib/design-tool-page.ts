import { createHash } from "node:crypto";

/**
 * Pagina del Network Design Tool ospitata dal Mirror Portal dietro il login degli operatori
 * (docs/real-maps.md, docs/security.md voce #139). Funzioni pure (solo `node:crypto`, nessuna dipendenza da Next), così il
 * test della radice le prova direttamente.
 *
 * La pagina è quella di `tools/network-design/` costruita come file unico (`dist/index.html`); qui la si adatta al
 * portale: niente font da Google Fonts (il portale non ha dipendenze da CDN esterne); un `<meta name="arald-data-base">`
 * perché la pagina trovi catalogo e pacchetti sotto `/strumento-rete/data/` (niente `<base>`: renderebbe assoluti anche i
 * link `#…` e i riferimenti SVG); un `<meta name="arald-tiles" content="off">` che dice di non cercare il servizio di
 * tessere (qui non c'è: il terreno del mondo è solo in locale); un collegamento per tornare al portale.
 * Ogni ancora attesa deve esistere: se il modello della pagina cambia e una manca, si lancia invece di servire una
 * pagina a metà.
 */

/** Indirizzo sotto cui il portale serve il tool (pagina e `data/`). */
export const DESIGN_TOOL_BASE = "/strumento-rete/";

/** Nomi dei file dati ammessi sotto `data/`: il catalogo e i pacchetti di terreno, mai un percorso. */
export const DESIGN_TOOL_DATA_FILE = /^(index\.json|[a-z0-9][a-z0-9-]{0,63}\.pack\.gz)$/;

/** Dove la pagina cerca il catalogo e i pacchetti (il meta `arald-data-base`). */
export const DESIGN_TOOL_DATA_BASE = `${DESIGN_TOOL_BASE}data/`;

/**
 * Politica di sicurezza dei contenuti della pagina. Gli script in linea (il bundle è un file unico) sono ammessi solo
 * per impronta (`sha256`) e la pagina non può avere gestori in linea (`onclick=`…); gli stili in linea restano ammessi
 * (la pagina li usa in attributi `style=`). Nient'altro che se stessa: nessuna richiesta verso l'esterno.
 */
export function designToolCsp(html: string): string {
  if (/<[^>]+\son[a-z]+\s*=/i.test(html)) throw new Error("Pagina del tool: gestori di eventi in linea (on…=) non ammessi dalla politica dei contenuti");
  const hashes: string[] = [];
  for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(m[0].slice(0, m[0].indexOf(">")))) throw new Error("Pagina del tool: script esterni non ammessi");
    hashes.push(`'sha256-${createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
  }
  if (hashes.length === 0) throw new Error("Pagina del tool: nessuno script in linea trovato");
  return `default-src 'none'; script-src ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
}

function replaceOnce(html: string, pattern: RegExp, replacement: string | ((match: string) => string), what: string): string {
  const m = pattern.exec(html);
  if (!m) throw new Error(`Pagina del tool: ancora non trovata (${what}): il modello della pagina è cambiato, aggiorna lib/design-tool-page.ts`);
  const text = typeof replacement === "function" ? replacement(m[0]) : replacement;
  return html.slice(0, m.index) + text + html.slice(m.index + m[0].length);
}

/** Adatta `tools/network-design/dist/index.html` al portale (vedi il commento del file). */
export function prepareDesignToolHtml(html: string): string {
  let out = html;
  // font: il portale non carica nulla da CDN esterne (la pagina ripiega sui caratteri di sistema)
  out = replaceOnce(out, /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\n?/, "", "preconnect fonts.googleapis");
  out = replaceOnce(out, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\n?/, "", "preconnect fonts.gstatic");
  out = replaceOnce(out, /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^"]*">\n?/, "", "foglio di stile dei font");
  out = replaceOnce(out, /<meta name="viewport"[^>]*>/, (meta) => `${meta}\n<meta name="arald-data-base" content="${DESIGN_TOOL_DATA_BASE}">\n<meta name="arald-tiles" content="off">`, "meta viewport");
  out = replaceOnce(
    out,
    /<h1>ARALD Network Design Tool<\/h1>/,
    '<a class="btn small-btn" href="/" title="Torna al portale">← Specchio Emergency Portal</a>\n  <h1>ARALD Network Design Tool</h1>',
    "titolo",
  );
  if (/fonts\.g(oogleapis|static)\.com/.test(out)) throw new Error("Pagina del tool: restano riferimenti a Google Fonts");
  return out;
}
