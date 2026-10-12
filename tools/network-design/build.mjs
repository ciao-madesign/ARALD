/**
 * Costruisce la pagina in un unico file HTML autosufficiente: tools/network-design/dist/index.html.
 * Uso: npm run design-tool:build. Il motore (tools/scenario-model/) gira nel browser, nessun server.
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const result = await build({
  entryPoints: [join(here, "app.ts")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  minify: true,
  loader: { ".json": "json" },
  legalComments: "none",
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = readFileSync(join(here, "index.template.html"), "utf8").replace("/*__BUNDLE__*/", () => js);
mkdirSync(join(here, "dist"), { recursive: true });
// index.html: pagina autonoma (si apre con un doppio clic); l'intestazione implicita raccoglie title/link/style.
const standalone = `<!doctype html>\n<html lang="it">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${html}\n</html>\n`;
writeFileSync(join(here, "dist", "index.html"), standalone);
// artifact.html: lo stesso contenuto senza doctype/html/meta, per essere pubblicato come Artifact (che aggiunge il proprio scheletro).
writeFileSync(join(here, "dist", "artifact.html"), html);
// mappe reali: catalogo e pacchetti accanto alla pagina (dist/data/), da cui la pagina li scarica
const dataSrc = join(here, "data");
const dataDest = join(here, "dist", "data");
rmSync(dataDest, { recursive: true, force: true });
if (existsSync(dataSrc)) {
  mkdirSync(dataDest, { recursive: true });
  for (const f of readdirSync(dataSrc)) if (f === "index.json" || f.endsWith(".pack.gz")) cpSync(join(dataSrc, f), join(dataDest, f));
}
// Variante solo testo per la pubblicazione come Artifact (che non serve file .gz): stessi pacchetti in base64
// e un catalogo che li indica; si pubblica come data/ accanto a artifact.html.
const artifactData = join(here, "dist", "artifact-data");
rmSync(artifactData, { recursive: true, force: true });
if (existsSync(join(dataDest, "index.json"))) {
  mkdirSync(artifactData, { recursive: true });
  const index = JSON.parse(readFileSync(join(dataDest, "index.json"), "utf8"));
  for (const p of index.packs) {
    const text = readFileSync(join(dataDest, p.file)).toString("base64");
    p.file = `${p.file}.b64.txt`;
    p.bytes = Buffer.byteLength(text);
    writeFileSync(join(artifactData, p.file), text);
  }
  writeFileSync(join(artifactData, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
}
console.log(`tools/network-design/dist/index.html + artifact.html (${(html.length / 1024).toFixed(0)} KB)`);
