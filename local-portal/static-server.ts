import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LoopbackHttpServer, sendBinary } from "../node/src/loopback-http-server.js";

/**
 * The "portale vive sul Box" piece (`docs/emergency-portal.md`, "Correzione
 * dell'utente... il portale deve vivere sul Box"): serves the existing
 * `mobile/www/` dashboard — map, SOS, HAZARD/drops, relays, node appends,
 * messages — as a plain website reachable over the local network, so an
 * operator on the same LAN as the ARALD Box (or a PC+Portable) gets the
 * full dashboard by pointing any browser at it, no app install and no
 * pairing screen to configure by hand.
 *
 * Deliberately a *second*, separate small server (same pattern as
 * `nomad-hub/`'s `ManagementServer` being its own process, never a route
 * bolted onto `WebUiServer`) rather than a change to `node/src/web-ui.ts`:
 * `WebUiServer` is scoped to "local status/search interface" (spec §59)
 * and lives in the `node` npm workspace, which has zero dependency on
 * `mobile/www/`'s static assets today — keeping that true avoids coupling
 * the mesh runtime to a sibling directory's file layout.
 *
 * Only ever serves static files that already ship in this repository
 * (`mobile/www/`) — it holds no mesh data, no secrets, and no dynamic
 * content of its own, so unlike `WebUiServer` there is nothing here for an
 * unauthenticated LAN visitor to read that isn't already public in this
 * repo's source. The one thing it *does* inject — the WebUiServer address
 * this dashboard should pair with — is operational convenience, not a
 * secret: the network password gating the mesh's own data is still typed
 * once by the operator into the app's existing setup screen, exactly as it
 * always has been.
 */
export interface StaticPortalOptions {
  /** Absolute path to the directory of static files to serve (normally `mobile/www/`). */
  rootDir: string;
  /**
   * The node's own `WebUiServer` address (e.g. `http://192.168.1.50:8080`)
   * — injected into `index.html` so the app's setup screen starts with the
   * address already filled in and skips straight to asking for the
   * network password, the same "returning user" shortcut the app already
   * gives once an address has ever been saved (`addressFieldNeeded()`,
   * `mobile/www/app.js`). Must be reachable from whatever device's browser
   * loads this page — usually the Box's LAN IP, never `127.0.0.1` (that
   * would resolve to the *viewing* device, not the Box, for anyone but
   * someone browsing from the Box itself).
   */
  gatewayUrl: string;
  /** Port to listen on; 0 lets the OS assign one (tests). */
  port?: number;
  /**
   * Bound to loopback by default, same posture as `WebUiServer.host` and
   * `nomad-hub`'s `--host` — this only becomes reachable from other
   * devices on the LAN (the entire point of this server) once a real Box
   * deployment passes its own LAN-facing `--host` explicitly.
   */
  host?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Same JSON-in-`<script>` escaping every framework's SSR hydration script needs: `JSON.stringify` alone doesn't stop a `</script>` inside the string from closing the tag early and injecting whatever follows as raw markup. Not reachable with today's only caller (an operator-supplied `--gateway-url` flag, not network input), but cheap insurance against this file ever gaining one that is. */
function jsonForInlineScript(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Injects a small bootstrap `<script>` right after `<head>` that pre-seeds
 * `localStorage`'s `nomadnet.gatewayUrl` key — the exact key
 * `mobile/www/app.js` itself reads at startup — only if the browser
 * doesn't already have one saved, so a device that later re-pairs to a
 * different gateway on purpose (`app.js`'s "change address" flow) is never
 * fought back to this default on its next visit.
 */
function injectGatewayUrl(html: string, gatewayUrl: string): string {
  const bootstrap = `<script>try{if(!localStorage.getItem("nomadnet.gatewayUrl"))localStorage.setItem("nomadnet.gatewayUrl",${jsonForInlineScript(gatewayUrl)});}catch(e){}</script>`;
  // Matches <head>, <head lang="it">, <HEAD>, etc. (found by review: a literal `html.replace("<head>",
  // ...)` silently no-ops — no error, no log — the moment the real file's <head> tag ever gains an
  // attribute or different casing, quietly turning off the one thing this server exists to do). Falls
  // back to prepending the script when no <head> tag is found at all, so the pre-fill is never lost
  // outright even against unexpectedly malformed HTML — worse to degrade to "still pairs, just via
  // the manual screen" than to silently do nothing.
  const headTag = /<head[^>]*>/i;
  return headTag.test(html) ? html.replace(headTag, (match) => `${match}\n${bootstrap}`) : `${bootstrap}\n${html}`;
}

export class StaticPortalServer {
  private readonly loopback: LoopbackHttpServer;
  private readonly rootDir: string;
  private readonly gatewayUrl: string;

  constructor(options: StaticPortalOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.gatewayUrl = options.gatewayUrl;
    this.loopback = new LoopbackHttpServer((req, res) => void this.handleRequest(req, res), { port: options.port, host: options.host });
  }

  get port(): number {
    return this.loopback.port;
  }

  async start(): Promise<void> {
    await this.loopback.start();
  }

  async stop(): Promise<void> {
    await this.loopback.stop();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://placeholder").pathname);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }
    if (pathname === "/") pathname = "/index.html";

    const resolved = path.join(this.rootDir, pathname);
    const relative = path.relative(this.rootDir, resolved);
    // Path-traversal guard: a request for e.g. /../../../etc/passwd resolves outside rootDir, where
    // path.relative() starts with ".." (or, on a different drive on Windows, is itself absolute) —
    // reject both rather than trusting path.join()'s normalization to have kept us inside rootDir.
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    let data: Buffer;
    try {
      data = await readFile(resolved);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    if (path.basename(resolved) === "index.html") {
      data = Buffer.from(injectGatewayUrl(data.toString("utf8"), this.gatewayUrl), "utf8");
    }

    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": contentTypeFor(resolved), "Content-Length": data.length });
      res.end();
      return;
    }
    sendBinary(res, 200, contentTypeFor(resolved), data);
  }
}
