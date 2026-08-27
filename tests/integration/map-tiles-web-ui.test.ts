import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { WebUiServer, MAX_MAP_TILE_REQUESTS_PER_WINDOW } from "../../node/src/web-ui.js";
import { MbtilesReader } from "../../node/src/map-tiles.js";

// Same createRequire() workaround as node/src/map-tiles.ts itself — this project's pinned Vite
// predates node:sqlite being in its list of known Node builtins, so a plain static import breaks
// Vitest's module resolution for the whole test file.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

const FAKE_PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 42, 42]);

function buildFixtureMbtiles(filePath: string): void {
  const db = new DatabaseSync(filePath);
  try {
    db.exec("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)");
    db.exec("CREATE TABLE metadata (name TEXT, value TEXT)");
    const insertTile = db.prepare("INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)");
    const tmsY = 2 ** 10 - 1 - 300; // z=10, XYZ y=300
    insertTile.run(10, 512, tmsY, FAKE_PNG_BYTES);
    const insertMeta = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
    for (const [name, value] of Object.entries({ name: "Fixture Region", format: "png", minzoom: "8", maxzoom: "14", attribution: "© Fixture" })) {
      insertMeta.run(name, value);
    }
  } finally {
    db.close();
  }
}

/**
 * `GET /api/map-info`/`GET /api/map-tiles/:z/:x/:y` (`node/src/web-ui.ts`,
 * `WebUiOptions.mapTiles`) — exercised as a plain HTTP client would, over a
 * real `WebUiServer`/`NomadNode`/`MbtilesReader`, no mocking. Same
 * dedicated-file convention `location-registry.test.ts` already uses for
 * its own `WebUiServer` feature rather than growing the already-large
 * `web-ui.test.ts` further.
 */
describe("WebUiServer map tiles (docs/next-steps.md)", () => {
  let dir: string;
  let filePath: string;
  let node: NomadNode | undefined;
  let webUi: WebUiServer | undefined;
  let mapTiles: MbtilesReader | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "nomad-net-map-web-ui-"));
    filePath = path.join(dir, "region.mbtiles");
    buildFixtureMbtiles(filePath);
  });

  afterEach(async () => {
    if (webUi) await webUi.stop();
    if (node) await node.stop();
    mapTiles?.close();
    rmSync(dir, { recursive: true, force: true });
    node = undefined;
    webUi = undefined;
    mapTiles = undefined;
  });

  function baseUrl(): string {
    return `http://127.0.0.1:${webUi!.port}`;
  }

  it("GET /api/map-info and GET /api/map-tiles/:z/:x/:y both 404 when mapTiles isn't configured", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    expect((await fetch(`${baseUrl()}/api/map-info`)).status).toBe(404);
    expect((await fetch(`${baseUrl()}/api/map-tiles/10/512/300`)).status).toBe(404);
  });

  it("GET /api/map-info returns the parsed MBTiles metadata, unauthenticated", async () => {
    node = new NomadNode({ displayName: "N" });
    mapTiles = new MbtilesReader(filePath);
    webUi = new WebUiServer(node, { port: 0, mapTiles });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/map-info`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Fixture Region",
      format: "png",
      contentType: "image/png",
      minzoom: 8,
      maxzoom: 14,
      bounds: undefined,
      attribution: "© Fixture",
    });
  });

  it("GET /api/map-tiles/:z/:x/:y returns the exact tile bytes with the right Content-Type and a long-lived Cache-Control", async () => {
    node = new NomadNode({ displayName: "N" });
    mapTiles = new MbtilesReader(filePath);
    webUi = new WebUiServer(node, { port: 0, mapTiles });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/map-tiles/10/512/300`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(FAKE_PNG_BYTES);
  });

  it("GET /api/map-tiles/:z/:x/:y 404s for a tile the file simply doesn't have", async () => {
    node = new NomadNode({ displayName: "N" });
    mapTiles = new MbtilesReader(filePath);
    webUi = new WebUiServer(node, { port: 0, mapTiles });
    await webUi.start();

    expect((await fetch(`${baseUrl()}/api/map-tiles/10/999/999`)).status).toBe(404);
  });

  it.each([
    "abc/512/300",
    "10/abc/300",
    "10/512/abc",
    "-1/512/300",
    "10/-1/300",
    "10/512",
    "10/512/300/extra",
    "10/512/", // trailing slash — Number("") is 0, not NaN, so this must not silently become y=0
    "10//300",
    "/512/300",
  ])(
    "GET /api/map-tiles/%s 404s on a malformed path instead of crashing",
    async (suffix) => {
      node = new NomadNode({ displayName: "N" });
      mapTiles = new MbtilesReader(filePath);
      webUi = new WebUiServer(node, { port: 0, mapTiles });
      await webUi.start();

      const res = await fetch(`${baseUrl()}/api/map-tiles/${suffix}`);
      expect(res.status).toBe(404);
    },
  );

  it.each([
    ["5/512/300", "z below the file's declared minzoom (8)"],
    ["20/512/300", "z above the file's declared maxzoom (14), even though well under the absolute z<=30 cap"],
    ["10/2000/300", "x >= 2**z at a valid zoom (2**10 = 1024)"],
    ["10/512/2000", "y >= 2**z at a valid zoom"],
  ])("GET /api/map-tiles/%s 404s without ever touching the database — %s", async (suffix) => {
    node = new NomadNode({ displayName: "N" });
    mapTiles = new MbtilesReader(filePath);
    webUi = new WebUiServer(node, { port: 0, mapTiles });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/map-tiles/${suffix}`);
    expect(res.status).toBe(404);
  });

  it(
    "rate-limits GET /api/map-tiles/:z/:x/:y per source IP once MAX_MAP_TILE_REQUESTS_PER_WINDOW is exceeded, protecting the synchronous node:sqlite query behind it",
    async () => {
      node = new NomadNode({ displayName: "N" });
      mapTiles = new MbtilesReader(filePath);
      webUi = new WebUiServer(node, { port: 0, mapTiles });
      await webUi.start();

      for (let i = 0; i < MAX_MAP_TILE_REQUESTS_PER_WINDOW; i++) {
        const res = await fetch(`${baseUrl()}/api/map-tiles/10/512/300`);
        expect(res.status).toBe(200);
      }
      const limited = await fetch(`${baseUrl()}/api/map-tiles/10/512/300`);
      expect(limited.status).toBe(429);
      expect((await limited.json()).error).toMatch(/too many/i);
    },
    30000,
  );

  it("mapTiles alone (no allowServiceCalls/exposeLocationRegistry) still gets CORS headers on its endpoints", async () => {
    node = new NomadNode({ displayName: "N" });
    mapTiles = new MbtilesReader(filePath);
    webUi = new WebUiServer(node, { port: 0, mapTiles });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/map-info`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await fetch(`${baseUrl()}/api/map-tiles/10/512/300`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
  });

  it("without mapTiles configured, no CORS headers are sent and OPTIONS 404s (unchanged pre-existing behavior)", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0 });
    await webUi.start();

    const res = await fetch(`${baseUrl()}/api/content`);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await fetch(`${baseUrl()}/api/map-tiles/10/512/300`, { method: "OPTIONS" });
    expect(preflight.status).toBe(404);
  });
});
