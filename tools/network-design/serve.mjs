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
const server = createStaticServer(join(here, "dist"));
server.listen(port, "127.0.0.1", () => {
  console.log(`ARALD Network Design Tool: http://127.0.0.1:${server.address().port}/  (Ctrl+C per fermare)`);
});
