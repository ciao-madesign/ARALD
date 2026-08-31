import { basename } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite";

// `import ... from "node:sqlite"` resolves fine under plain tsc/tsx/node (verified directly against
// this project's Node 22.22.2), but this project's pinned Vite (5.4.21, vitest.config.ts) predates
// `node:sqlite` being added to Vite's list of known Node builtins — a static `import` of it makes
// Vite try to resolve "sqlite" as an npm package instead of a builtin and fail the whole test file.
// `createRequire()` is a runtime call Vite's static import analysis never touches, sidestepping the
// issue entirely without needing to alter the shared vitest config for one still-experimental
// builtin. Only the type import above (erased at compile time, never reaches Vite at all) still
// looks like an ordinary `node:sqlite` reference.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

/**
 * Raster tile formats this reader understands well enough to serve over
 * HTTP with a correct `Content-Type` — vector tile formats (e.g.
 * `pbf`/`mvt`) are explicitly out of scope: `mobile/www/mapview.js` is a
 * hand-written raster tile viewer (no vector rendering stack), so a file
 * whose `metadata.format` isn't one of these is rejected at open time
 * rather than served with a wrong/missing `Content-Type` and a viewer that
 * can never actually draw it.
 */
const RASTER_FORMAT_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export interface MbtilesMetadata {
  name: string;
  format: string;
  contentType: string;
  minzoom?: number;
  maxzoom?: number;
  /** `[minLon, minLat, maxLon, maxLat]`, WGS84 — parsed from the standard MBTiles `bounds` metadata key when present and well-formed; `undefined` otherwise (a client can still browse, just without a starting viewport hint). */
  bounds?: [number, number, number, number];
  attribution?: string;
}

/**
 * Read-only reader for a local MBTiles file (https://github.com/mapbox/mbtiles-spec)
 * — an operator-provided SQLite database of pre-rendered raster map tiles,
 * this project's choice for offline topographic maps (`docs/next-steps.md`:
 * tile *rendering* precision is OpenTopoMap's own responsibility, not
 * ours — see that discussion for why MBTiles+raster was chosen over a
 * vector-tile stack this project would have to style itself).
 *
 * Lives in `node/src/`, not `gateway/nomad/`: this is a purely local file
 * the operator supplies, never mesh-fed data nor an adapter to an external
 * NOMAD/internet backend — same reasoning already applied to
 * `location-registry.ts`/`groups.ts`. `web-ui.ts` (the only caller) cannot
 * import from `gateway/nomad/` at all regardless (one-way dependency
 * documented in `CLAUDE.md`).
 *
 * Uses Node's built-in `node:sqlite` (`DatabaseSync`) — no new external
 * dependency, consistent with this project's "hand-write it or use the
 * standard library instead of adding a package" convention (`rss-feed.ts`,
 * `qrcode.ts`). Still experimental in this Node version (prints an
 * `ExperimentalWarning` once, the first time the module is touched) but
 * fully functional; a future Node version dropping the flag/warning needs
 * no code change here.
 *
 * Tiles are served directly from this file on every request — never
 * published into `ContentStore`/the mesh. A single region can easily hold
 * tens of thousands of tiles, which would either force
 * `--max-content-entries` absurdly high or evict everything else out of a
 * store sized for ordinary content. The tradeoff, accepted deliberately:
 * tiles are reachable only by a client that can talk HTTP directly to
 * *this* gateway (`web-ui.ts`, same reach as `/api/pairing`/the dashboard),
 * not propagated mesh-wide the way Kiwix articles are.
 */
export class MbtilesReader {
  private readonly db: DatabaseSyncType;
  private readonly getTileStatement: StatementSync;
  readonly metadata: MbtilesMetadata;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath, { readOnly: true });
    try {
      this.getTileStatement = this.db.prepare(
        "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
      );
      // Fails fast with a clear error if `tiles` doesn't exist / doesn't have these columns,
      // rather than only failing lazily on the first real getTile() call much later.
      this.db.prepare("SELECT tile_data FROM tiles LIMIT 0").all();
      this.metadata = readMetadata(this.db, filePath);
    } catch (err) {
      this.db.close();
      throw new Error(`not a valid MBTiles file (${filePath}): ${(err as Error).message}`);
    }
  }

  /**
   * `undefined` when no tile exists at this address (outside the file's
   * covered area/zoom range, or simply a gap) — never a thrown error, same
   * "unknown = absent" posture used everywhere else content might not be
   * present. MBTiles stores rows in TMS order (row 0 = the *southernmost*
   * row), the opposite of the XYZ/"Google" convention this reader's caller
   * (`web-ui.ts`) and `mapview.js` use (row 0 = the *northernmost* row) —
   * flipped here once, at the only place tile coordinates cross between
   * the two conventions.
   */
  getTile(z: number, x: number, y: number): Buffer | undefined {
    const tmsY = 2 ** z - 1 - y;
    const row = this.getTileStatement.get(z, x, tmsY) as { tile_data: Uint8Array } | undefined;
    return row ? Buffer.from(row.tile_data) : undefined;
  }

  close(): void {
    this.db.close();
  }
}

function parseFiniteInt(raw: string | undefined): number | undefined {
  // `Number("")` is `0`, not `NaN` — an empty metadata value must not silently become zoom level 0.
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

function parseBounds(raw: string | undefined): [number, number, number, number] | undefined {
  if (raw === undefined) return undefined;
  const pieces = raw.split(",").map((part) => part.trim());
  if (pieces.length !== 4 || pieces.some((p) => p === "")) return undefined; // Number("") is 0, not NaN — reject empty components explicitly
  const parts = pieces.map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  return parts as [number, number, number, number];
}

/**
 * Reads the standard MBTiles `metadata` table (a plain key/value table, one
 * row per key — `name`, `format`, `bounds`, `minzoom`, `maxzoom`,
 * `attribution` are the well-known ones this cares about) defensively:
 * an operator-provided file, but still not fully trusted — a truncated or
 * hand-edited `metadata` table must never crash the node, same discipline
 * applied to every other input this project doesn't fully control.
 */
function readMetadata(db: DatabaseSyncType, filePath: string): MbtilesMetadata {
  const rows = db.prepare("SELECT name, value FROM metadata").all() as Array<{ name: unknown; value: unknown }>;
  const raw = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.name === "string" && typeof row.value === "string") raw.set(row.name, row.value);
  }

  const format = (raw.get("format") ?? "").toLowerCase();
  const contentType = RASTER_FORMAT_CONTENT_TYPES[format];
  if (!contentType) {
    throw new Error(
      `unsupported or missing tile format ${JSON.stringify(raw.get("format"))} — only png/jpg/jpeg/webp raster tiles are supported`,
    );
  }

  return {
    name: raw.get("name") || basename(filePath),
    format,
    contentType,
    minzoom: parseFiniteInt(raw.get("minzoom")),
    maxzoom: parseFiniteInt(raw.get("maxzoom")),
    bounds: parseBounds(raw.get("bounds")),
    attribution: raw.get("attribution"),
  };
}
