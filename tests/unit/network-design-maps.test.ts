import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { buildCatalog } from "../../tools/map-data/catalog.js";
import { PACK_DIR as _unused } from "../../tools/map-data/load.js";
import { COVER_LABEL, devicesOutside, groundAt, groundWarnings } from "../../tools/network-design/logic.js";
import { PackLibrary, gunzip } from "../../tools/network-design/packs.js";
import { allowedHost, createStaticServer, resolveRequestPath } from "../../tools/network-design/serve-lib.mjs";
import { type PackCatalog, catalogEntryFor, parseCatalog } from "../../tools/scenario-model/pack-catalog.js";
import { type NetworkConfig, parseNetworkConfig } from "../../tools/scenario-model/network-config.js";
import { PACK_VERSION, PackTerrain, type TerrainPack, encodePack } from "../../tools/scenario-model/terrain-pack.js";
import { FLAT_TERRAIN } from "../../tools/scenario-model/terrain.js";
void _unused;

function pack(id = "prova"): TerrainPack {
  return {
    header: { version: PACK_VERSION, id, name: "Prova", frame: { lat0: 44, lon0: 7 }, cellM: 100, cols: 4, rows: 4, minX: -200, maxY: 200, sources: [], attribution: "© test" },
    elevation: Int16Array.from([0, 100, 200, 300, 0, 100, 200, 300, 0, 100, 200, 300, 0, 100, 200, 300]),
    cover: Uint8Array.from([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]),
  };
}
const goodEntry = (id = "prova", bytes = 100) => ({ ...catalogEntryFor(pack(id).header, { south: 43.9, west: 6.9, north: 44.1, east: 7.1 }, bytes) });
const catalog = (...packs: unknown[]) => ({ version: 1, packs });

describe("catalogo dei pacchetti", () => {
  it("accetta un catalogo valido e lo restituisce tipizzato", () => {
    const c = parseCatalog(catalog(goodEntry("a"), goodEntry("b")));
    expect(c.packs.map((p) => p.id)).toEqual(["a", "b"]);
    expect(c.packs[0].file).toBe("a.pack.gz");
  });

  it("rifiuta versione sbagliata, voci non valide, duplicati, file che non coincide con l'id, riquadri impossibili", () => {
    expect(() => parseCatalog(null)).toThrow(/versione/);
    expect(() => parseCatalog({ version: 2, packs: [] })).toThrow(/versione/);
    expect(() => parseCatalog({ version: 1 })).toThrow(/elenco/);
    expect(() => parseCatalog(catalog(5))).toThrow(/non è un oggetto/);
    expect(() => parseCatalog(catalog(goodEntry("a"), goodEntry("a")))).toThrow(/duplicato/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), id: "../a", file: "../a.pack.gz" }))).toThrow(/identificativo/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), file: "altro.pack.gz" }))).toThrow(/deve chiamarsi/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), file: "http://x/a.pack.gz" }))).toThrow(/deve chiamarsi/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), bbox: { south: 45, west: 6, north: 44, east: 7 } }))).toThrow(/riquadro/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), bytes: 0 }))).toThrow(/dimensioni/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), bbox: { south: null, west: 6, north: 44, east: 7 } }))).toThrow(/riquadro/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), cols: 1.5 }))).toThrow(/griglia/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), name: "" }))).toThrow(/nome/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), cols: 1e6, rows: 1e6 }))).toThrow(/troppo grande/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), frame: { lat0: 10, lon0: 7 } }))).toThrow(/origine non è dentro/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), attribution: undefined }))).toThrow(/attribuzione/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), attribution: "  " }))).toThrow(/attribuzione/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), attribution: 5 }))).toThrow(/attribuzione/);
    expect(() => parseCatalog(catalog({ ...goodEntry("__proto__"), id: "__proto__", file: "__proto__.pack.gz" }))).toThrow(/identificativo/);
  });

  it("il catalogo pubblicato corrisponde ai pacchetti presenti (nessuna deriva)", () => {
    const dir = join(process.cwd(), "tools", "network-design", "data");
    const fromPacks = buildCatalog(dir);
    const published = parseCatalog(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
    expect(published).toEqual(fromPacks);
    expect(published.packs.map((p) => p.id)).toEqual(expect.arrayContaining(["eolie", "valle-maira"]));
  });

  it("un file che non porta il nome del suo pacchetto è un errore", () => {
    const dir = mkdtempSync(join(tmpdir(), "arald-cat-"));
    writeFileSync(join(dir, "altro.pack.gz"), gzipSync(encodePack(pack("prova"))));
    expect(() => buildCatalog(dir)).toThrow(/deve coincidere/);
  });
});

describe("caricamento dei pacchetti nella pagina", () => {
  const raw = gzipSync(encodePack(pack("prova")));
  const makeFetch = (overrides: Record<string, () => { ok: boolean; status: number; bytes?: Uint8Array }> = {}) => {
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      const name = url.replace(/^data\//, "");
      const o = overrides[name];
      const r = o ? o() : name === "index.json" ? { ok: true, status: 200, bytes: new TextEncoder().encode(JSON.stringify(catalog(goodEntry("prova", raw.length)))) } : name === "prova.pack.gz" ? { ok: true, status: 200, bytes: raw } : { ok: false, status: 404 };
      const bytes = r.bytes ?? new Uint8Array();
      return { ok: r.ok, status: r.status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    };
    return { fetchFn, calls };
  };

  it("gunzip restituisce i byte originali e si ferma oltre il tetto", async () => {
    const data = new Uint8Array(5000).fill(7);
    expect([...(await gunzip(gzipSync(data)))]).toEqual([...data]);
    await expect(gunzip(gzipSync(data), 1000)).rejects.toThrow(/troppo grande/);
    await expect(gunzip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });

  it("scarica una volta il catalogo e una volta ogni pacchetto, e restituisce dati validi", async () => {
    const { fetchFn, calls } = makeFetch();
    const lib = new PackLibrary("data/", fetchFn);
    const [a, b] = await Promise.all([lib.load("prova"), lib.load("prova")]);
    expect(a).toBe(b);
    expect(a.header.id).toBe("prova");
    expect([...a.elevation]).toEqual([...pack().elevation]);
    await lib.load("prova");
    expect(calls.filter((c) => c === "data/index.json")).toHaveLength(1);
    expect(calls.filter((c) => c === "data/prova.pack.gz")).toHaveLength(1);
  });

  it("un catalogo in base64 (solo testo) funziona come quello binario, e un testo non valido dà un errore chiaro", async () => {
    const b64 = new TextEncoder().encode(raw.toString("base64"));
    const entry = { ...goodEntry("prova", b64.length), file: "prova.pack.gz.b64.txt" };
    const mk = (text: Uint8Array) => makeFetch({ "index.json": () => ({ ok: true, status: 200, bytes: new TextEncoder().encode(JSON.stringify(catalog(entry))) }), "prova.pack.gz.b64.txt": () => ({ ok: true, status: 200, bytes: text }) });
    const p = await new PackLibrary("data/", mk(b64).fetchFn).load("prova");
    expect(p.header.id).toBe("prova");
    await expect(new PackLibrary("data/", mk(new TextEncoder().encode("###non base64###")).fetchFn).load("prova")).rejects.toThrow(/base64/);
    await expect(new PackLibrary("data/", mk(new TextEncoder().encode("abc")).fetchFn).load("prova")).rejects.toThrow(/base64/);
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), file: "a.pack.gz.b64.txt" }))).not.toThrow();
    expect(() => parseCatalog(catalog({ ...goodEntry("a"), file: "b.pack.gz.b64.txt" }))).toThrow(/deve chiamarsi/);
  });

  it("un server che ha già decompresso il file (Content-Encoding) non rompe il caricamento", async () => {
    const plain = encodePack(pack("prova"));
    const { fetchFn } = makeFetch({ "prova.pack.gz": () => ({ ok: true, status: 200, bytes: plain }) });
    const p = await new PackLibrary("data/", fetchFn).load("prova");
    expect(p.header.id).toBe("prova");
  });

  it("area sconosciuta, catalogo irraggiungibile o non valido, file di dimensione diversa, pacchetto di un'altra area: errori chiari e ritentabili", async () => {
    const { fetchFn } = makeFetch();
    await expect(new PackLibrary("data/", fetchFn).load("mancante")).rejects.toThrow(/sconosciuta/);
    let fail = true;
    const flaky = makeFetch({ "index.json": () => (fail ? { ok: false, status: 503 } : { ok: true, status: 200, bytes: new TextEncoder().encode(JSON.stringify(catalog(goodEntry("prova", raw.length)))) }) });
    const lib = new PackLibrary("data/", flaky.fetchFn);
    await expect(lib.catalog()).rejects.toThrow(/503/);
    fail = false;
    await expect(lib.catalog()).resolves.toBeTruthy(); // un errore non resta in cache
    const bad = makeFetch({ "index.json": () => ({ ok: true, status: 200, bytes: new TextEncoder().encode("{}") }) });
    await expect(new PackLibrary("data/", bad.fetchFn).catalog()).rejects.toThrow(/versione/);
    const truncated = makeFetch({ "prova.pack.gz": () => ({ ok: true, status: 200, bytes: raw.subarray(0, raw.length - 5) }) });
    await expect(new PackLibrary("data/", truncated.fetchFn).load("prova")).rejects.toThrow();
    const other = gzipSync(encodePack(pack("altra")));
    const wrongPack = makeFetch({ "index.json": () => ({ ok: true, status: 200, bytes: new TextEncoder().encode(JSON.stringify(catalog(goodEntry("prova", other.length)))) }), "prova.pack.gz": () => ({ ok: true, status: 200, bytes: other }) });
    await expect(new PackLibrary("data/", wrongPack.fetchFn).load("prova")).rejects.toThrow(/non corrisponde al catalogo/);
    const wrongGrid = makeFetch({ "index.json": () => ({ ok: true, status: 200, bytes: new TextEncoder().encode(JSON.stringify(catalog({ ...goodEntry("prova", raw.length), cols: 9 }))) }) });
    await expect(new PackLibrary("data/", wrongGrid.fetchFn).load("prova")).rejects.toThrow(/non corrisponde al catalogo/);
    const notGzip = makeFetch({ "index.json": () => ({ ok: true, status: 200, bytes: new TextEncoder().encode(JSON.stringify(catalog(goodEntry("prova", 4)))) }), "prova.pack.gz": () => ({ ok: true, status: 200, bytes: new Uint8Array([1, 2, 3, 4]) }) });
    await expect(new PackLibrary("data/", notGzip.fetchFn).load("prova")).rejects.toThrow();
    const missing = makeFetch({ "prova.pack.gz": () => ({ ok: false, status: 404 }) });
    const lib2 = new PackLibrary("data/", missing.fetchFn);
    await expect(lib2.load("prova")).rejects.toThrow(/non raggiungibile/);
    await expect(lib2.load("prova")).rejects.toThrow(/non raggiungibile/); // ritenta, non resta in cache
  });
});

describe("terreno sotto i dispositivi", () => {
  const terrain = new PackTerrain(pack());
  const cfg = (devices: object[]): NetworkConfig => parseNetworkConfig({ version: 1, name: "t", frame: { lat0: 44, lon0: 7 }, environment: "tipico", regulatory: "g3", terrain: "pack:prova", devices });
  it("quota, suolo e posizione dentro/fuori l'area", () => {
    const inside = groundAt(terrain, 50, 0); // centro della colonna 2: quota 200, bosco
    expect(inside.elevationM).toBeCloseTo(200);
    expect(inside.cover).toBe("forest");
    expect(inside.inside).toBe(true);
    expect(groundAt(terrain, 5000, 0).inside).toBe(false);
    expect(groundAt(FLAT_TERRAIN, 5000, 0).inside).toBe(true); // un terreno senza limiti noti non è mai «fuori»
    expect(COVER_LABEL.sea).toBe("acqua");
  });

  it("avvisi: fuori dai dati sempre, in acqua solo per un dispositivo fisso", () => {
    expect(groundWarnings({ elevationM: 0, cover: "sea", inside: false }, "card", false)[0]).toMatch(/Fuori dall'area/);
    expect(groundWarnings({ elevationM: 0, cover: "sea", inside: true }, "box", false)[0]).toMatch(/in acqua/);
    expect(groundWarnings({ elevationM: 0, cover: "sea", inside: true }, "card", false)).toHaveLength(1);
    expect(groundWarnings({ elevationM: 0, cover: "sea", inside: true }, "card", true)).toEqual([]); // una barca è in acqua
    expect(groundWarnings({ elevationM: 800, cover: "forest", inside: true }, "box", false)).toEqual([]);
  });

  it("dispositivi fuori dall'area: contano anche i punti del percorso", () => {
    const c = cfg([
      { id: "A", kind: "card", lat: 44, lon: 7 },
      { id: "B", kind: "card", lat: 45, lon: 7 },
      { id: "C", kind: "card", lat: 44, lon: 7, route: [{ tS: 0, lat: 44, lon: 7 }, { tS: 60, lat: 44, lon: 8 }] },
    ]);
    expect(devicesOutside(terrain, c)).toEqual(["B", "C"]);
    expect(devicesOutside(FLAT_TERRAIN, c)).toEqual([]);
  });
});

describe("server locale della pagina", () => {
  const root = mkdtempSync(join(tmpdir(), "arald-serve-"));
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "index.html"), "<h1>ok</h1>");
  writeFileSync(join(root, "data", "a.pack.gz"), Buffer.from([1, 2, 3]));
  writeFileSync(join(root, "data", "index.json"), "{}");
  writeFileSync(join(tmpdir(), "arald-serve-segreto.txt"), "segreto");

  it("risolve i percorsi dentro la cartella e rifiuta quelli che ne escono", () => {
    expect(resolveRequestPath(root, "/")).toBe(join(root, "index.html"));
    expect(resolveRequestPath(root, "/data/a.pack.gz?x=1")).toBe(join(root, "data", "a.pack.gz"));
    expect(resolveRequestPath(root, "/../etc/passwd")).toBeNull();
    expect(resolveRequestPath(root, "/%2e%2e/etc/passwd")).toBeNull();
    expect(resolveRequestPath(root, "/data/..%2f..%2fx")).toBeNull();
    expect(resolveRequestPath(root, "/..%5csecret")).toBeNull();
    expect(resolveRequestPath(root, "/a%00b")).toBeNull();
    expect(resolveRequestPath(root, "/%E0%A4%A")).toBeNull(); // percent-encoding non valido
    expect(resolveRequestPath(root, "/data/../index.html")).toBe(join(root, "index.html")); // resta dentro
  });

  const server = createStaticServer(root);
  const ready = new Promise<number>((res) => server.listen(0, "127.0.0.1", () => res((server.address() as { port: number }).port)));
  afterAll(() => new Promise<void>((res) => server.close(() => res())));

  it("rifiuta un Host diverso dal server locale (DNS rebinding) e i collegamenti simbolici che escono dalla cartella", async () => {
    const port = await ready;
    expect(allowedHost(`127.0.0.1:${port}`, port)).toBe(true);
    expect(allowedHost(`localhost:${port}`, port)).toBe(true);
    expect(allowedHost("evil.example:" + port, port)).toBe(false);
    expect(allowedHost("127.0.0.1", port)).toBe(false);
    expect(allowedHost(undefined, port)).toBe(false);
    const status = (host: string, path = "/") => new Promise<number>((resolve, reject) => {
      const rq = httpRequest({ host: "127.0.0.1", port, path, headers: { Host: host } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
      rq.on("error", reject);
      rq.end();
    });
    expect(await status(`127.0.0.1:${port}`)).toBe(200);
    expect(await status(`evil.example:${port}`)).toBe(403);
    symlinkSync(join(tmpdir(), "arald-serve-segreto.txt"), join(root, "scappa.txt"));
    expect(await status(`127.0.0.1:${port}`, "/scappa.txt")).toBe(403);
    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
  });

  it("serve pagina, catalogo e pacchetti con il tipo giusto; 404, 405 e indirizzi non validi", async () => {
    const port = await ready;
    const get = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toBe("<h1>ok</h1>");
    expect((await get("/data/index.json")).headers.get("content-type")).toMatch(/application\/json/);
    const gz = await get("/data/a.pack.gz");
    expect(gz.headers.get("content-type")).toBe("application/gzip");
    expect(gz.headers.get("content-encoding")).toBeNull(); // niente decompressione automatica: la fa la pagina
    expect([...new Uint8Array(await gz.arrayBuffer())]).toEqual([1, 2, 3]);
    expect((await get("/non-esiste")).status).toBe(404);
    expect((await get("/", { method: "POST" })).status).toBe(405);
    // il client fetch normalizza "/%2e%2e/" prima di inviare: l'indirizzo grezzo va spedito con node:http
    const raw = await new Promise<number>((resolve, reject) => {
      const rq = httpRequest({ host: "127.0.0.1", port, path: "/%2e%2e/arald-serve-segreto.txt" }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
      rq.on("error", reject);
      rq.end();
    });
    expect(raw).toBe(400);
    const head = await get("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});
