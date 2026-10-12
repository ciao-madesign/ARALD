/**
 * Avvia il server locale della pagina del tool: `npm run design-tool:serve [-- --port 8470]`.
 * Costruisce prima la pagina (vedi `design-tool:build`) e la serve su http://127.0.0.1:<porta>/.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "./serve-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf("--port");
const port = i >= 0 ? Number(process.argv[i + 1]) : 8470;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("--port: numero intero tra 0 e 65535");
  process.exit(1);
}
function option(name) {
  const k = process.argv.indexOf(`--${name}`);
  if (k < 0) return undefined;
  const v = process.argv[k + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`--${name} richiede un valore`);
    process.exit(1);
  }
  return v;
}
function number(name, fallback, min, max) {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    console.error(`--${name}: numero tra ${min} e ${max}`);
    process.exit(1);
  }
  return v;
}
// Tessere del mondo costruite al momento da Terrarium + WorldCover (solo da qui, mai dal browser); --no-tiles le spegne.
let tiles;
if (!process.argv.includes("--no-tiles")) {
  // import solo se servono: il servizio è TypeScript e richiede tsx (`npm run design-tool:serve`)
  let TileService;
  try {
    ({ TileService } = await import("../map-data/tile-service.js"));
  } catch {
    console.error("Servizio di tessere non caricabile (serve tsx: usa «npm run design-tool:serve», oppure --no-tiles).");
    process.exit(1);
  }
  tiles = new TileService({ dir: option("tile-cache"), capBytes: number("cap-gb", 1.5, 0.05, 1000) * 1e9, maxNewPerHour: Math.floor(number("max-new-per-hour", 400, 0, 100_000)) });
}
const server = createStaticServer(join(here, "dist"), tiles);
server.listen(port, "127.0.0.1", () => {
  console.log(`ARALD Network Design Tool: http://127.0.0.1:${server.address().port}/  (Ctrl+C per fermare)`);
  if (tiles) console.log(`Tessere del mondo: cache in ${tiles.dir} (tetto ${(tiles.capBytes / 1e9).toFixed(1)} GB), scaricate al bisogno dal server, non dal browser.`);
});
