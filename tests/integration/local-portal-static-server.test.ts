import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { StaticPortalServer } from "../../local-portal/static-server.js";

/**
 * Sends a request with the exact, unnormalized `rawPath` on the wire —
 * unlike `fetch()`, which (per its URL-parsing spec) collapses `..`
 * segments client-side before the request ever leaves the process, so
 * `fetch(base + "/../../etc/passwd")` never actually exercises a server's
 * own traversal guard (found by review: an earlier version of the
 * path-traversal test below used `fetch()` and passed even with the guard
 * deleted entirely, testing nothing).
 */
function rawGet(port: number, rawPath: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * `local-portal/` is the "il portale vive sul Box" piece
 * (`docs/emergency-portal.md`): a static file server for `mobile/www/`,
 * pre-configured to point the dashboard's setup screen at the node's own
 * `WebUiServer` address. Exercised against a small synthetic fixture
 * directory (not the real `mobile/www/`) so these tests stay correct even
 * if that app's real markup changes — a separate smoke test below covers
 * that it actually serves the real directory.
 */
describe("StaticPortalServer", () => {
  let root: string;
  let server: StaticPortalServer | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "local-portal-test-"));
    await writeFile(path.join(root, "index.html"), "<!doctype html>\n<html>\n<head>\n<title>t</title>\n</head>\n<body>hi</body>\n</html>\n");
    await writeFile(path.join(root, "app.js"), "console.log('app');");
    await mkdir(path.join(root, "fonts"));
    await writeFile(path.join(root, "fonts", "a.woff2"), Buffer.from([1, 2, 3]));
  });

  afterEach(async () => {
    if (server) await server.stop();
    server = undefined;
    await rm(root, { recursive: true, force: true });
  });

  function baseUrl(): string {
    return `http://127.0.0.1:${server!.port}`;
  }

  it("serves index.html at / with the gateway URL bootstrap script injected right after <head>", async () => {
    server = new StaticPortalServer({ rootDir: root, gatewayUrl: "http://192.168.1.50:8080", port: 0 });
    await server.start();

    const res = await fetch(`${baseUrl()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('localStorage.setItem("nomadnet.gatewayUrl","http://192.168.1.50:8080")');
    // Injected right after <head>, before the page's own content — never replacing it.
    expect(body.indexOf("<head>")).toBeLessThan(body.indexOf("nomadnet.gatewayUrl"));
    expect(body).toContain("<title>t</title>");
  });

  it("serves a non-HTML asset verbatim, with the right content-type, no injection", async () => {
    server = new StaticPortalServer({ rootDir: root, gatewayUrl: "http://box.local:8080", port: 0 });
    await server.start();

    const res = await fetch(`${baseUrl()}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toBe("console.log('app');");
  });

  it("serves a font with the right content-type", async () => {
    server = new StaticPortalServer({ rootDir: root, gatewayUrl: "http://box.local:8080", port: 0 });
    await server.start();

    const res = await fetch(`${baseUrl()}/fonts/a.woff2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
  });

  it("returns 404 for a file that doesn't exist", async () => {
    server = new StaticPortalServer({ rootDir: root, gatewayUrl: "http://box.local:8080", port: 0 });
    await server.start();

    const res = await fetch(`${baseUrl()}/does-not-exist.js`);
    expect(res.status).toBe(404);
  });

  it("returns 404 rather than escaping rootDir via a path-traversal request", async () => {
    // A real secret this guards: mobile/www/ sits next to this repo's own source files — without the
    // guard, a request for /../../../../etc/passwd (or, worse, /../../../CLAUDE.md) would happily
    // read and serve a file this server was never meant to expose on the LAN. Uses rawGet(), not
    // fetch(): fetch() normalizes ".." out of the URL before sending the request, which would make
    // this test pass even with the guard deleted — see rawGet()'s own doc comment.
    server = new StaticPortalServer({ rootDir: root, gatewayUrl: "http://box.local:8080", port: 0 });
    await server.start();

    for (const rawPath of ["/../../../../etc/passwd", "/%2e%2e/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2f..%2fetc/passwd"]) {
      const res = await rawGet(server.port, rawPath);
      expect(res.status).toBe(404);
    }
  });

  it("rejects a non-GET/HEAD method", async () => {
    server = new StaticPortalServer({ rootDir: root, gatewayUrl: "http://box.local:8080", port: 0 });
    await server.start();

    const res = await fetch(`${baseUrl()}/app.js`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("still injects the bootstrap script when <head> carries attributes or different casing (regression: a literal string match used to silently no-op here)", async () => {
    await writeFile(path.join(root, "index.html"), '<!doctype html>\n<html>\n<HEAD lang="it">\n<title>t</title>\n</head>\n<body>hi</body>\n</html>\n');
    server = new StaticPortalServer({ rootDir: root, gatewayUrl: "http://192.168.1.50:8080", port: 0 });
    await server.start();

    const body = await (await fetch(`${baseUrl()}/`)).text();
    expect(body).toContain('localStorage.setItem("nomadnet.gatewayUrl","http://192.168.1.50:8080")');
  });

  it("never overrides a gatewayUrl the browser already saved (guarded client-side by the injected script, not the server)", async () => {
    // The server always injects the same "if not already set" guard — this test documents that
    // contract rather than re-testing app.js's own localStorage read, which lives in a different file.
    server = new StaticPortalServer({ rootDir: root, gatewayUrl: "http://box.local:8080", port: 0 });
    await server.start();
    const body = await (await fetch(`${baseUrl()}/`)).text();
    expect(body).toContain("if(!localStorage.getItem(\"nomadnet.gatewayUrl\"))");
  });
});

describe("StaticPortalServer against the real mobile/www/ directory", () => {
  let server: StaticPortalServer | undefined;

  afterEach(async () => {
    if (server) await server.stop();
    server = undefined;
  });

  it("serves the real dashboard's index.html, app.js and mapview.js", async () => {
    const rootDir = path.join(import.meta.dirname, "..", "..", "mobile", "www");
    server = new StaticPortalServer({ rootDir, gatewayUrl: "http://192.168.1.50:8080", port: 0 });
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;

    const index = await (await fetch(`${base}/`)).text();
    // Asserts the specific injected snippet, not just that the string "nomadnet.gatewayUrl" appears
    // somewhere — the latter would still pass even if injectGatewayUrl() silently no-op'd (found by
    // review), since that would leave the real file's own content untouched but unrelated to this
    // assertion either way; this checks the actual bootstrap this server is responsible for adding.
    expect(index).toContain('localStorage.setItem("nomadnet.gatewayUrl","http://192.168.1.50:8080")');
    expect(index).toContain("app.js");

    expect((await fetch(`${base}/app.js`)).status).toBe(200);
    expect((await fetch(`${base}/mapview.js`)).status).toBe(200);
    expect((await fetch(`${base}/styles.css`)).status).toBe(200);
  });
});
