import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DESIGN_TOOL_DATA_BASE, DESIGN_TOOL_DATA_FILE, designToolCsp, prepareDesignToolHtml } from "../../mirror-portal/lib/design-tool-page.js";

describe("Network Design Tool nel Mirror Portal: pagina", () => {
  const page = `<!doctype html>
<html lang="it">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARALD Network Design Tool</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&display=swap">
<style>body{}</style>
<header class="top">
  <h1>ARALD Network Design Tool</h1>
</header>`;

  it("toglie i font esterni, mette il <base> e il collegamento al portale", () => {
    const out = prepareDesignToolHtml(page);
    expect(out).not.toMatch(/fonts\.g(oogleapis|static)\.com/);
    expect(out).toContain(`<meta name="arald-data-base" content="${DESIGN_TOOL_DATA_BASE}">`);
    expect(out).not.toContain("<base");
    expect(out.indexOf("arald-data-base")).toBeGreaterThan(out.indexOf("<meta name=\"viewport\""));
    expect(out).toContain('<meta name="arald-tiles" content="off">');
    expect(out).toContain('href="/" title="Torna al portale"');
    expect(out).toContain("<h1>ARALD Network Design Tool</h1>");
    expect(out).not.toContain("$1");
  });

  it("lancia se il modello della pagina cambia e manca un'ancora", () => {
    expect(() => prepareDesignToolHtml(page.replace(/<link rel="stylesheet"[^>]*>\n/, ""))).toThrow(/foglio di stile/);
    expect(() => prepareDesignToolHtml(page.replace("<h1>", "<h2>").replace("</h1>", "</h2>"))).toThrow(/titolo/);
    expect(() => prepareDesignToolHtml(page.replace(/<meta name="viewport"[^>]*>\n/, ""))).toThrow(/viewport/);
  });

  it("la politica dei contenuti ammette gli script in linea solo per impronta e nulla di esterno", () => {
    const html = "<html><script>var a=1;</script><p>x</p><script>var b=2;</script></html>";
    const csp = designToolCsp(html);
    expect(csp.match(/'sha256-[A-Za-z0-9+/=]+'/g)).toHaveLength(2);
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https?:|\*/);
    // cambiando una virgola dello script cambia l'impronta: uno script modificato dopo la sincronizzazione non gira
    expect(designToolCsp(html.replace("a=1", "a=2"))).not.toBe(csp);
  });

  it("rifiuta gestori in linea, script esterni e pagine senza script", () => {
    expect(() => designToolCsp('<button onclick="x()">a</button><script>1</script>')).toThrow(/gestori/);
    expect(() => designToolCsp('<script src="https://evil.example/x.js"></script>')).toThrow(/esterni/);
    expect(() => designToolCsp("<p>niente</p>")).toThrow(/nessuno script/);
  });

  it("la pagina vera: nessun gestore in linea e una sola impronta, nessun '#' o url(#) che un <base> avrebbe rotto", () => {
    const real = readFileSync("mirror-portal/design-tool/index.html", "utf8");
    expect(() => designToolCsp(real)).not.toThrow();
    expect(designToolCsp(real).match(/'sha256-/g)).toHaveLength(1);
  });
});

describe("Network Design Tool nel Mirror Portal: file dati", () => {
  it("ammette solo il catalogo e i pacchetti con nome semplice, mai un percorso", () => {
    for (const ok of ["index.json", "eolie.pack.gz", "valle-maira.pack.gz", "a1.pack.gz"]) expect(DESIGN_TOOL_DATA_FILE.test(ok), ok).toBe(true);
    for (const bad of ["", "../index.json", "..%2findex.json", "/etc/passwd", "a/b.pack.gz", "a\\b.pack.gz", "INDEX.JSON", "x.pack", "x.pack.gz.txt", "-x.pack.gz", ".pack.gz", "x".repeat(70) + ".pack.gz", "index.json\n", "index.json\0"]) {
      expect(DESIGN_TOOL_DATA_FILE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("la copia ospitata dal portale è allineata alla pagina e ai pacchetti: se fallisce, esegui npm run design-tool:mirror-sync", () => {
    execFileSync("node", ["tools/network-design/build.mjs"], { stdio: "pipe" });
    const fresh = prepareDesignToolHtml(readFileSync("tools/network-design/dist/index.html", "utf8"));
    expect(readFileSync("mirror-portal/design-tool/index.html", "utf8") === fresh).toBe(true);
    const wanted = readdirSync("tools/network-design/dist/data").filter((f) => DESIGN_TOOL_DATA_FILE.test(f)).sort();
    expect(readdirSync("mirror-portal/design-tool/data").sort()).toEqual(wanted);
    for (const f of wanted) {
      expect(readFileSync(`mirror-portal/design-tool/data/${f}`).equals(readFileSync(`tools/network-design/dist/data/${f}`)), f).toBe(true);
    }
  }, 60_000);
});
