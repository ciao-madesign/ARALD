/**
 * Dataset di territorio noti al motore, referenziati per nome da una configurazione salvata
 * (`NetworkConfig.terrain`). Condiviso da CLI e pagina del tool: nessuna dipendenza da Node.
 */
import { ATACAMA_TERRAIN } from "./atacama.js";
import { EOLIE_TERRAIN } from "./eolie.js";
import { KAMPALA_TERRAIN } from "./kampala.js";
import type { Terrain } from "./terrain.js";

export const TERRAINS: Record<string, Terrain> = {
  "eolie-sintetico": EOLIE_TERRAIN,
  "atacama-sintetico": ATACAMA_TERRAIN,
  "kampala-sintetico": KAMPALA_TERRAIN,
};
