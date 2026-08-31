import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MbtilesReader } from "../../node/src/map-tiles.js";

// Same createRequire() workaround as map-tiles.ts itself — see that file's own comment for why a
// plain static `import ... from "node:sqlite"` breaks under this project's pinned Vite version.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

const FAKE_PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

interface FixtureOptions {
  /** Rows to insert, given in XYZ ("Google") convention like the rest of this codebase — converted to MBTiles' own TMS row order when writing, exercising the exact inverse of the flip `getTile()` performs. */
  tiles?: Array<{ z: number; x: number; y: number; data: Buffer }>;
  metadata?: Record<string, string> | null; // null = omit the metadata table entirely
  skipTilesTable?: boolean;
}

function buildFixtureMbtiles(filePath: string, options: FixtureOptions = {}): void {
  const db = new DatabaseSync(filePath);
  try {
    if (!options.skipTilesTable) {
      db.exec("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)");
      const insert = db.prepare("INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)");
      for (const tile of options.tiles ?? []) {
        const tmsY = 2 ** tile.z - 1 - tile.y;
        insert.run(tile.z, tile.x, tmsY, tile.data);
      }
    }
    if (options.metadata !== null) {
      db.exec("CREATE TABLE metadata (name TEXT, value TEXT)");
      const insert = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
      const defaults = { name: "Test Region", format: "png", minzoom: "8", maxzoom: "14", bounds: "9.0,45.0,10.0,46.0", attribution: "© Test" };
      for (const [name, value] of Object.entries({ ...defaults, ...options.metadata })) {
        insert.run(name, value);
      }
    }
  } finally {
    db.close();
  }
}

describe("MbtilesReader", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "nomad-net-map-tiles-"));
    filePath = path.join(dir, "region.mbtiles");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads back a known tile's exact bytes", () => {
    buildFixtureMbtiles(filePath, { tiles: [{ z: 10, x: 512, y: 300, data: FAKE_PNG_BYTES }] });
    const reader = new MbtilesReader(filePath);
    try {
      expect(reader.getTile(10, 512, 300)).toEqual(FAKE_PNG_BYTES);
    } finally {
      reader.close();
    }
  });

  it("returns undefined for a tile that doesn't exist (out of range or simply a gap)", () => {
    buildFixtureMbtiles(filePath, { tiles: [{ z: 10, x: 512, y: 300, data: FAKE_PNG_BYTES }] });
    const reader = new MbtilesReader(filePath);
    try {
      expect(reader.getTile(10, 999, 999)).toBeUndefined();
      expect(reader.getTile(11, 512, 300)).toBeUndefined(); // right x/y, wrong zoom
    } finally {
      reader.close();
    }
  });

  it("converts between XYZ and MBTiles' own TMS row order correctly, not just by coincidence", () => {
    // z=5 has 32 rows (0..31). Inserted at XYZ y=21 (helper flips to TMS internally) — reading back
    // at XYZ y=21 must hit it, and reading at the *unflipped* TMS index (10) must NOT, proving the
    // flip is actually applied rather than everything happening to line up (e.g. an off-by-nothing
    // bug that never flips at all would still pass a naive "insert and read back the same y" test).
    buildFixtureMbtiles(filePath, { tiles: [{ z: 5, x: 7, y: 21, data: FAKE_PNG_BYTES }] });
    const reader = new MbtilesReader(filePath);
    try {
      expect(reader.getTile(5, 7, 21)).toEqual(FAKE_PNG_BYTES);
      expect(reader.getTile(5, 7, 10)).toBeUndefined();
    } finally {
      reader.close();
    }
  });

  it("parses metadata (name/format/contentType/minzoom/maxzoom/bounds/attribution)", () => {
    buildFixtureMbtiles(filePath, {});
    const reader = new MbtilesReader(filePath);
    try {
      expect(reader.metadata).toEqual({
        name: "Test Region",
        format: "png",
        contentType: "image/png",
        minzoom: 8,
        maxzoom: 14,
        bounds: [9.0, 45.0, 10.0, 46.0],
        attribution: "© Test",
      });
    } finally {
      reader.close();
    }
  });

  it("falls back to the file's basename when the metadata table has no 'name' key", () => {
    buildFixtureMbtiles(filePath, { metadata: { name: "" } });
    const reader = new MbtilesReader(filePath);
    try {
      expect(reader.metadata.name).toBe("region.mbtiles");
    } finally {
      reader.close();
    }
  });

  it("leaves minzoom/maxzoom/bounds undefined rather than crashing when they're missing or malformed", () => {
    buildFixtureMbtiles(filePath, { metadata: { minzoom: "not-a-number", maxzoom: "", bounds: "1,2,3" /* only 3 parts */ } });
    const reader = new MbtilesReader(filePath);
    try {
      expect(reader.metadata.minzoom).toBeUndefined();
      expect(reader.metadata.maxzoom).toBeUndefined();
      expect(reader.metadata.bounds).toBeUndefined();
    } finally {
      reader.close();
    }
  });

  it("rejects bounds with an empty component instead of silently treating it as 0 (Number('') === 0, not NaN)", () => {
    buildFixtureMbtiles(filePath, { metadata: { bounds: "9.0,,10.0,46.0" } });
    const reader = new MbtilesReader(filePath);
    try {
      expect(reader.metadata.bounds).toBeUndefined();
    } finally {
      reader.close();
    }
  });

  it.each(["jpg", "jpeg", "webp"])("recognizes the %s raster format", (format) => {
    buildFixtureMbtiles(filePath, { metadata: { format } });
    const reader = new MbtilesReader(filePath);
    try {
      expect(reader.metadata.format).toBe(format);
      expect(reader.metadata.contentType).toMatch(/^image\//);
    } finally {
      reader.close();
    }
  });

  it("rejects a vector tile format (pbf) at open time — mapview.js can only draw raster tiles", () => {
    buildFixtureMbtiles(filePath, { metadata: { format: "pbf" } });
    expect(() => new MbtilesReader(filePath)).toThrow(/format/i);
  });

  it("rejects a file with no metadata table at all, without crashing the process", () => {
    buildFixtureMbtiles(filePath, { metadata: null });
    expect(() => new MbtilesReader(filePath)).toThrow();
  });

  it("rejects a file with no tiles table at all, without crashing the process", () => {
    buildFixtureMbtiles(filePath, { skipTilesTable: true });
    expect(() => new MbtilesReader(filePath)).toThrow();
  });

  it("rejects a missing file path", () => {
    expect(() => new MbtilesReader(path.join(dir, "does-not-exist.mbtiles"))).toThrow();
  });

  it("rejects a file that isn't a SQLite database at all", () => {
    writeFileSync(filePath, "not a sqlite file, just plain text");
    expect(() => new MbtilesReader(filePath)).toThrow();
  });

  it("close() can be called without throwing", () => {
    buildFixtureMbtiles(filePath, {});
    const reader = new MbtilesReader(filePath);
    expect(() => reader.close()).not.toThrow();
  });
});
