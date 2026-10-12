/**
 * Rigenera `tools/network-design/data/index.json` dai pacchetti presenti (nessuna rete).
 *   npm run map-data:index
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCatalog } from "./catalog.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "network-design", "data");
const c = writeCatalog(dir);
console.log(`${c.packs.length} pacchetti in ${join(dir, "index.json")}: ${c.packs.map((p) => p.id).join(", ")}`);
