import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { StaticPortalServer } from "../../local-portal/static-server.js";
import { DesignToolRoutes, ipLimiterKey } from "../../local-portal/design-tool.js";
import { TerrariumSampler } from "../../tools/map-data/terrarium.js";
import type { BuildDeps } from "../../tools/map-data/tile-builder.js";
import { TileService } from "../../tools/map-data/tile-service.js";
import { decodeTile } from "../../tools/scenario-model/geo-tile.js";
import { designToolCsp } from "../../local-portal/hosted-page.js";
import { designToolCsp as mirrorCsp } from "../../mirror-portal/lib/design-tool-page.js";
import { BrowserTileStore } from "../../tools/network-design/world-tiles.js";
import { NomadNode } from "../../node/src/node.js";
import { WebUiServer } from "../../node/src/web-ui.js";

const PAGE = `<!doctype html>
<html lang="it">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARALD Network Design Tool</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&display=swap">
<style>body{}</style>
<header class="top">
  <h1>ARALD Network Design Tool</h1>
</header>
<script>var tool=1;</script>`;

function seaDeps(): BuildDeps {
  const terrarium = new TerrariumSampler(async () => null);
  terrarium.prepare = async () => undefined;
  terrarium.sample = () => 0;
  return { terrarium, cover: { async fill() { return { found: false, sources: [] }; } } };
}

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
function req(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, path: urlPath, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

describe("Network Design Tool nel Local Portal", () => {
  let tmp: string;
  let gateway: Server;
  let gatewayMode: "normal" | "no-password" | "down";
  let gatewayPort: number;
  let portal: StaticPortalServer;
  let routes: DesignToolRoutes;
  let now: number;
  let tiles: TileService;
  let gatewayHits = 0;

  async function startGateway(): Promise<void> {
    gateway = createServer((rq, rs) => {
      if (gatewayMode === "down") { rq.socket.destroy(); return; }
      if (rq.url?.startsWith("/api/messages")) {
        gatewayHits++;
        if (gatewayMode === "no-password") { rs.writeHead(404).end(); return; }
        const ok = rq.headers.authorization === "Bearer segreta";
        rs.writeHead(ok ? 400 : 401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: ok ? "'peer' query parameter is required" : "missing or invalid network password" }));
        return;
      }
      rs.writeHead(404).end();
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
    gatewayPort = (gateway.address() as { port: number }).port;
  }

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "local-portal-tool-"));
    await mkdir(path.join(tmp, "www"), { recursive: true });
    await writeFile(path.join(tmp, "www", "index.html"), "<!doctype html><html><head></head><body>dashboard</body></html>");
    await mkdir(path.join(tmp, "dist", "data"), { recursive: true });
    await writeFile(path.join(tmp, "dist", "index.html"), PAGE);
    await writeFile(path.join(tmp, "dist", "data", "index.json"), '{"packs":[]}');
    await writeFile(path.join(tmp, "dist", "data", "eolie.pack.gz"), Buffer.from([0x1f, 0x8b, 1, 2, 3]));
    await writeFile(path.join(tmp, "dist", "segreto.txt"), "non si serve");
    gatewayMode = "normal";
    gatewayHits = 0;
    await startGateway();
    now = 1_000_000;
    tiles = new TileService({ dir: path.join(tmp, "tiles"), deps: seaDeps() });
    routes = new DesignToolRoutes({ distDir: path.join(tmp, "dist"), gatewayUrl: `http://127.0.0.1:${gatewayPort}`, tiles, now: () => now });
    portal = new StaticPortalServer({ rootDir: path.join(tmp, "www"), gatewayUrl: `http://127.0.0.1:${gatewayPort}`, port: 0, designTool: routes });
    await portal.start();
  });

  afterEach(async () => {
    await portal.stop();
    await new Promise<void>((r) => gateway.close(() => r()));
    await rm(tmp, { recursive: true, force: true });
  });

  async function login(password = "segreta"): Promise<string> {
    const r = await req(portal.port, "POST", "/strumento-rete/accesso", { "content-type": "application/x-www-form-urlencoded" }, `password=${encodeURIComponent(password)}`);
    expect(r.status).toBe(303);
    const cookie = String(r.headers["set-cookie"]).split(";")[0];
    return cookie;
  }

  it("senza sessione la pagina, i dati e le tessere sono chiusi; il portale ordinario resta com'è", async () => {
    expect((await req(portal.port, "GET", "/strumento-rete")).status).toBe(302);
    const page = await req(portal.port, "GET", "/strumento-rete/");
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe("/strumento-rete/accesso");
    expect((await req(portal.port, "GET", "/strumento-rete/data/index.json")).status).toBe(401);
    expect((await req(portal.port, "GET", "/strumento-rete/tiles/status", { "x-arald-tool": "1" })).status).toBe(401);
    expect((await req(portal.port, "GET", "/strumento-rete/tiles/730/183", { "x-arald-tool": "1" })).status).toBe(401);
    const home = await req(portal.port, "GET", "/");
    expect(home.status).toBe(200);
    expect(home.body.toString()).toContain("dashboard");
    expect((await req(portal.port, "POST", "/index.html")).status).toBe(405); // il resto del portale resta solo GET/HEAD
  });

  it("la password sbagliata non dà sessione; quella giusta dà un cookie HttpOnly SameSite=Strict solo sotto /strumento-rete", async () => {
    const bad = await req(portal.port, "POST", "/strumento-rete/accesso", {}, "password=nope");
    expect(bad.status).toBe(401);
    expect(bad.headers["set-cookie"]).toBeUndefined();
    expect(bad.body.toString()).toContain("Password di rete non valida");
    const ok = await req(portal.port, "POST", "/strumento-rete/accesso", {}, "password=segreta");
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe("/strumento-rete/");
    const cookie = String(ok.headers["set-cookie"]);
    expect(cookie).toMatch(/^arald_design_tool=[0-9a-f]{64};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/strumento-rete");
    expect(cookie).not.toContain("segreta");
  });

  it("con la sessione: pagina con politica a impronte, senza font esterni e con il ritorno alla dashboard; dati con lista chiusa", async () => {
    const cookie = await login();
    const page = await req(portal.port, "GET", "/strumento-rete/", { cookie });
    expect(page.status).toBe(200);
    const html = page.body.toString();
    expect(html).not.toMatch(/fonts\.g(oogleapis|static)\.com/);
    expect(html).toContain('href="/" title="Torna al portale"');
    expect(String(page.headers["content-security-policy"])).toBe(designToolCsp(html));
    expect(String(page.headers["content-security-policy"])).toContain("'sha256-");
    expect(page.headers["cache-control"]).toBe("private, no-store");
    const idx = await req(portal.port, "GET", "/strumento-rete/data/index.json", { cookie });
    expect(idx.status).toBe(200);
    expect(idx.body.toString()).toBe('{"packs":[]}');
    expect((await req(portal.port, "GET", "/strumento-rete/data/eolie.pack.gz", { cookie })).headers["content-type"]).toBe("application/gzip");
    for (const bad of ["segreto.txt", "..%2fsegreto.txt", "%2e%2e%2findex.html", "INDEX.JSON", "x.pack.gz"]) {
      expect((await req(portal.port, "GET", `/strumento-rete/data/${bad}`, { cookie })).status, bad).toBe(404);
    }
    expect((await req(portal.port, "HEAD", "/strumento-rete/", { cookie })).body.length).toBe(0);
  });

  it("un cookie inventato o scaduto non vale", async () => {
    const cookie = await login();
    expect((await req(portal.port, "GET", "/strumento-rete/", { cookie: `arald_design_tool=${"a".repeat(64)}` })).status).toBe(302);
    expect((await req(portal.port, "GET", "/strumento-rete/", { cookie: "arald_design_tool=corto" })).status).toBe(302);
    expect((await req(portal.port, "GET", "/strumento-rete/", { cookie })).status).toBe(200);
    now += 8 * 3_600_000 + 1;
    expect((await req(portal.port, "GET", "/strumento-rete/", { cookie })).status).toBe(302);
  });

  it("le tessere: serve la pagina con l'intestazione, rifiuta richieste da altri siti, e BrowserTileStore funziona sull'intera catena", async () => {
    const cookie = await login();
    const ok = await req(portal.port, "GET", "/strumento-rete/tiles/730/183", { cookie, "x-arald-tool": "1" });
    expect(ok.status).toBe(200);
    expect(decodeTile(gunzipSync(ok.body)).tx).toBe(730);
    expect((await req(portal.port, "GET", "/strumento-rete/tiles/730/183", { cookie })).status).toBe(403);
    expect((await req(portal.port, "GET", "/strumento-rete/tiles/730/183", { cookie, "x-arald-tool": "1", origin: "http://evil.example" })).status).toBe(403);
    expect((await req(portal.port, "GET", "/strumento-rete/tiles/5/2", { cookie, "x-arald-tool": "1" })).status).toBe(404);
    expect(JSON.parse((await req(portal.port, "GET", "/strumento-rete/tiles/status", { cookie, "x-arald-tool": "1" })).body.toString()).maxNewPerHour).toBe(400);
    // la pagina vera: scarica con l'indirizzo relativo `tiles/` risolto sotto /strumento-rete/
    const store = new BrowserTileStore(`http://127.0.0.1:${portal.port}/strumento-rete/tiles/`, (u, init) => fetch(u, { headers: { ...init.headers, cookie } }));
    await store.ensure([{ tx: 731, ty: 183 }]);
    expect(store.get(731, 183)?.tx).toBe(731);
  });

  it("senza servizio di tessere: 404 (solo pacchetti)", async () => {
    const noTiles = new DesignToolRoutes({ distDir: path.join(tmp, "dist"), gatewayUrl: `http://127.0.0.1:${gatewayPort}`, now: () => now });
    const p2 = new StaticPortalServer({ rootDir: path.join(tmp, "www"), gatewayUrl: "http://x", port: 0, designTool: noTiles });
    await p2.start();
    try {
      const r = await req(p2.port, "POST", "/strumento-rete/accesso", {}, "password=segreta");
      const cookie = String(r.headers["set-cookie"]).split(";")[0];
      expect((await req(p2.port, "GET", "/strumento-rete/tiles/status", { cookie, "x-arald-tool": "1" })).status).toBe(404);
    } finally {
      await p2.stop();
    }
  });

  it("l'accesso resta chiuso se il nodo non risponde o non ha una password di rete", async () => {
    gatewayMode = "no-password";
    const a = await req(portal.port, "POST", "/strumento-rete/accesso", {}, "password=segreta");
    expect(a.status).toBe(503);
    expect(a.headers["set-cookie"]).toBeUndefined();
    gatewayMode = "down";
    const b = await req(portal.port, "POST", "/strumento-rete/accesso", {}, "password=segreta");
    expect(b.status).toBe(503);
    expect(b.headers["set-cookie"]).toBeUndefined();
  });

  it("tentativi limitati per indirizzo: dopo cinque anche la password giusta aspetta; poi la finestra scade; un accesso riuscito non pesa", async () => {
    for (let i = 0; i < 5; i++) expect((await req(portal.port, "POST", "/strumento-rete/accesso", {}, `password=no${i}`)).status).toBe(401);
    const locked = await req(portal.port, "POST", "/strumento-rete/accesso", {}, "password=segreta");
    expect(locked.status).toBe(429);
    expect(locked.headers["retry-after"]).toBeDefined();
    expect(locked.headers["set-cookie"]).toBeUndefined();
    now += 600_001;
    for (let i = 0; i < 8; i++) expect((await req(portal.port, "POST", "/strumento-rete/accesso", {}, "password=segreta")).status).toBe(303); // gli accessi riusciti non consumano il limite
  });

  it("tentativi in parallelo: il limite vale anche per il lotto in volo e il nodo non viene inondato", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => req(portal.port, "POST", "/strumento-rete/accesso", {}, `password=tentativo${i}`)));
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(15);
    expect(gatewayHits).toBeLessThanOrEqual(5);
  });

  it("nessun blocco globale: i tentativi sbagliati di un indirizzo non chiudono l'accesso degli altri (la chiave è per indirizzo)", () => {
    expect(ipLimiterKey("192.168.1.20")).toBe("192.168.1.20");
    expect(ipLimiterKey("::ffff:192.168.1.20")).toBe("192.168.1.20");
    expect(ipLimiterKey("fe80:0:0:1:aaaa:bbbb:cccc:dddd")).toBe(ipLimiterKey("fe80:0:0:1:1:2:3:4")); // stesso /64
    expect(ipLimiterKey("fe80::5")).toBe(ipLimiterKey("fe80:0:0:0:9:8:7:6")); // «::» espanso: stesso /64
    expect(ipLimiterKey("fe80:0:0:2:aaaa:bbbb:cccc:dddd")).not.toBe(ipLimiterKey("fe80:0:0:1:aaaa:bbbb:cccc:dddd"));
    expect(ipLimiterKey(undefined)).toBe("?");
  });

  it("password con caratteri non ASCII o senza senso: respinta senza interpellare il nodo", async () => {
    const before = gatewayHits;
    for (const pw of ["pässword", "a\r\nX-Evil: 1", ""]) {
      expect((await req(portal.port, "POST", "/strumento-rete/accesso", {}, `password=${encodeURIComponent(pw)}`)).status).toBe(401);
    }
    expect(gatewayHits).toBe(before);
  });

  it("login CSRF: Sec-Fetch-Site diverso da same-origin è rifiutato", async () => {
    expect((await req(portal.port, "POST", "/strumento-rete/accesso", { "sec-fetch-site": "cross-site" }, "password=segreta")).status).toBe(403);
    expect((await req(portal.port, "POST", "/strumento-rete/accesso", { "sec-fetch-site": "same-origin" }, "password=segreta")).status).toBe(303);
  });

  it("percorsi strani non aggirano l'accesso", async () => {
    for (const p of ["//strumento-rete/", "/STRUMENTO-RETE/", "/strumento-rete/%2e%2e/index.html", "/strumento-rete/./", "/strumento-rete//data/index.json", "/strumento-rete/data/%2e%2e%2fsegreto.txt"]) {
      const r = await req(portal.port, "GET", p);
      // o chiuso (401/302/404), o è la dashboard ordinaria (pubblica nel portale): mai la pagina dello strumento
      expect(r.status === 401 || r.status === 302 || r.status === 404 || (r.status === 200 && r.body.toString().includes("dashboard")), `${p} → ${r.status}`).toBe(true);
      expect(r.body.toString()).not.toContain("tool=1");
      expect(r.body.toString()).not.toContain("non si serve");
    }
  });

  it("l'accesso rifiuta un'origine diversa, un corpo enorme e un metodo non previsto", async () => {
    expect((await req(portal.port, "POST", "/strumento-rete/accesso", { origin: "http://evil.example" }, "password=segreta")).status).toBe(403);
    // un corpo oltre il limite fa chiudere la connessione (stesso comportamento di readRequestBody() ovunque nel progetto)
    await expect(req(portal.port, "POST", "/strumento-rete/accesso", {}, "password=" + "x".repeat(10_000))).rejects.toThrow();
    expect((await req(portal.port, "PUT", "/strumento-rete/accesso")).status).toBe(405);
    expect((await req(portal.port, "DELETE", "/strumento-rete/")).status).toBe(405);
  });

  it("la pagina non costruita dà un messaggio chiaro, non un errore muto", async () => {
    await rm(path.join(tmp, "dist", "index.html"));
    const cookie = await login();
    const r = await req(portal.port, "GET", "/strumento-rete/", { cookie });
    expect(r.status).toBe(503);
    expect(r.body.toString()).toContain("design-tool:build");
  });

  it("la politica dei contenuti è la stessa del Mirror Portal", () => {
    expect(designToolCsp(PAGE)).toBe(mirrorCsp(PAGE));
  });

  it("contratto con il vero nodo: WebUiServer risponde 400 alla password giusta, 401 alla sbagliata, 404 senza password di rete", async () => {
    const node = new NomadNode({ displayName: "Rifugio Test" });
    await node.start();
    const withPw = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: "pw-vera" });
    await withPw.start();
    const noPw = new WebUiServer(node, { port: 0 });
    await noPw.start();
    try {
      const mk = (gw: WebUiServer): DesignToolRoutes => new DesignToolRoutes({ distDir: path.join(tmp, "dist"), gatewayUrl: `http://127.0.0.1:${gw.port}`, now: () => now });
      const post = async (gw: WebUiServer, password: string): Promise<number> => {
        const p = new StaticPortalServer({ rootDir: path.join(tmp, "www"), gatewayUrl: "http://x", port: 0, designTool: mk(gw) });
        await p.start();
        try { return (await req(p.port, "POST", "/strumento-rete/accesso", {}, `password=${password}`)).status; } finally { await p.stop(); }
      };
      expect(await post(withPw, "pw-vera")).toBe(303);
      expect(await post(withPw, "sbagliata")).toBe(401);
      expect(await post(noPw, "qualunque")).toBe(503); // nodo senza password di rete: accesso chiuso
    } finally {
      await withPw.stop();
      await noPw.stop();
      await node.stop();
    }
  });
});
