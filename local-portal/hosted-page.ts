/**
 * Adattamenti della pagina del Network Design Tool quando la serve un portale (Local Portal, docs/security.md voce #140):
 * politica dei contenuti con gli script in linea ammessi per impronta, niente font da CDN, un collegamento di ritorno.
 * Funzioni pure (solo `node:crypto`). Il Mirror Portal ne ha una copia propria in `mirror-portal/lib/design-tool-page.ts`
 * (Vercel costruisce solo quella cartella): un test confronta le due politiche dei contenuti perché non divergano.
 */
import { createHash } from "node:crypto";

function replaceOnce(html: string, pattern: RegExp, replacement: string, what: string): string {
  const m = pattern.exec(html);
  if (!m) throw new Error(`Pagina del tool: ancora non trovata (${what}): il modello della pagina è cambiato, aggiorna local-portal/hosted-page.ts`);
  return html.slice(0, m.index) + replacement + html.slice(m.index + m[0].length);
}

/** Toglie i riferimenti a Google Fonts (un portale in LAN non deve fare richieste a CDN esterne; la pagina ripiega sui caratteri di sistema). */
export function removeExternalFonts(html: string): string {
  let out = html;
  out = replaceOnce(out, /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\n?/, "", "preconnect fonts.googleapis");
  out = replaceOnce(out, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\n?/, "", "preconnect fonts.gstatic");
  out = replaceOnce(out, /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^"]*">\n?/, "", "foglio di stile dei font");
  if (/fonts\.g(oogleapis|static)\.com/.test(out)) throw new Error("Pagina del tool: restano riferimenti a Google Fonts");
  return out;
}

/** Aggiunge, prima del titolo, un collegamento per tornare al portale. */
export function insertBackLink(html: string, href: string, label: string): string {
  const safeHref = href.replace(/[^A-Za-z0-9/_.-]/g, "");
  const safeLabel = label.replace(/[<>&"]/g, "");
  return replaceOnce(html, /<h1>ARALD Network Design Tool<\/h1>/, `<a class="btn small-btn" href="${safeHref}" title="Torna al portale">← ${safeLabel}</a>\n  <h1>ARALD Network Design Tool</h1>`, "titolo");
}

/**
 * Politica di sicurezza dei contenuti della pagina. Gli script in linea (il bundle è un file unico) sono ammessi solo per
 * impronta (`sha256`) e la pagina non può avere gestori in linea (`onclick=`…); gli stili in linea restano ammessi (la pagina
 * li usa in attributi `style=`). Nient'altro che se stessa: nessuna richiesta verso l'esterno.
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

/** Nomi dei file dati ammessi sotto `data/`: il catalogo e i pacchetti di terreno, mai un percorso. */
export const HOSTED_DATA_FILE = /^(index\.json|[a-z0-9][a-z0-9-]{0,63}\.pack\.gz)$/;
