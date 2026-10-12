/**
 * Aggiorna la copia del Network Design Tool ospitata dal Mirror Portal (`mirror-portal/design-tool/`):
 *
 *   npm run design-tool:mirror-sync        (dalla radice del repository)
 *
 * Costruisce la pagina (`tools/network-design/build.mjs`), la adatta al portale (`lib/design-tool-page.ts`) e copia
 * il catalogo e i pacchetti di terreno. La copia è committata perché Vercel costruisce solo `mirror-portal/`; un test
 * (`tests/unit/mirror-portal-design-tool.test.ts`) fallisce se la copia non è allineata alla pagina.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_TOOL_DATA_FILE, prepareDesignToolHtml } from "../lib/design-tool-page.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dest = join(here, "..", "design-tool");

execFileSync("node", [join(root, "tools", "network-design", "build.mjs")], { stdio: "inherit" });
const dist = join(root, "tools", "network-design", "dist");

rmSync(dest, { recursive: true, force: true });
mkdirSync(join(dest, "data"), { recursive: true });
writeFileSync(join(dest, "index.html"), prepareDesignToolHtml(readFileSync(join(dist, "index.html"), "utf8")));
let n = 0;
for (const f of readdirSync(join(dist, "data"))) {
  if (!DESIGN_TOOL_DATA_FILE.test(f)) continue;
  cpSync(join(dist, "data", f), join(dest, "data", f));
  n++;
}
console.log(`Copia aggiornata in mirror-portal/design-tool/: pagina + ${n} file di dati.`);
