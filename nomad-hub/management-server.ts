import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { LoopbackHttpServer, sendJson } from "../node/src/loopback-http-server.js";
import { BoundedFifoMap } from "../node/src/bounded-map.js";
import { DockerApiError, DockerClient, type DockerContainerSummary } from "./docker-client.js";

const DEFAULT_ACTION_RATE_LIMIT_WINDOW_MS = 10_000;
const DEFAULT_MAX_ACTIONS_PER_WINDOW = 20; // generous for a human tapping buttons, bounds a runaway script/bug — see checkActionRateLimit()'s doc comment
const MAX_TRACKED_RATE_LIMIT_IPS = 4096; // same bound web-ui.ts's own per-IP rate limit (map tiles) uses
const MAX_LOG_TAIL = 1000;
const DEFAULT_LOG_TAIL = 200;

interface RateWindow {
  windowStart: number;
  count: number;
}

export interface ManagementServerOptions {
  port?: number;
  host?: string;
  /** Never the mesh's own network password (`node/src/web-ui.ts`'s `networkPassword`) — a guest paired to the mesh must not be able to touch Docker. See this file's own class doc comment. */
  managementPassword: string;
  /** When set, every endpoint here only ever sees/acts on containers whose name starts with this prefix — an operator-chosen guardrail against managing the whole Docker daemon when only a subset (e.g. this NOMAD Hub's own containers) should be reachable. Applied uniformly in `listManagedContainers()`, the single choke point every handler below goes through — never just at the listing endpoint. */
  containerNamePrefix?: string;
  /** Overrides for `checkActionRateLimit()`'s window — same reason every gateway in `gateway/nomad/` exposes its own rate-limit constants as options (tests need a window shorter than the production default to run in reasonable time). */
  actionRateLimitWindowMs?: number;
  maxActionsPerWindow?: number;
}

/**
 * HTTP server for the "NOMAD Management API" (`docs/deployment.md`, "Il
 * NOMAD Hub come sistema portatile") — administers the Docker containers a
 * NOMAD Hub host runs, via `DockerClient`. Deliberately **not** part of
 * `node/src/`/`gateway/nomad/`: this never touches the mesh (`NomadNode`)
 * at all, so it can't be reached by a mesh guest the way `service://...`
 * calls or `WebUiServer` endpoints can — see `nomad-hub/`'s own top-level
 * doc comment (`cli.ts`) for the full boundary reasoning.
 *
 * Auth/CORS/rate-limit shape all deliberately mirror `node/src/web-ui.ts`'s
 * established conventions (`isAuthorized()`'s Bearer-token constant-time
 * compare, the unconditional CORS/preflight handling, `checkMapTileRateLimit()`'s
 * per-IP `BoundedFifoMap` window) — same patterns, new password, new
 * server, so a reader already familiar with `web-ui.ts` recognizes this
 * immediately rather than having to learn a second convention for the
 * same problem.
 *
 * The management password is **never** served over HTTP by this class
 * (unlike the mesh's `GET /api/pairing`, deliberately unauthenticated for
 * a lower-stakes secret) — `cli.ts` only ever prints it to the console at
 * startup. Whoever started this process already has physical/SSH access
 * to the host; there's no pairing-style chicken-and-egg problem to solve
 * over the network here, so there's no reason to open one.
 */
export class ManagementServer {
  private readonly httpServer: LoopbackHttpServer;
  private readonly actionRateLimitState = new BoundedFifoMap<string, RateWindow>({ maxSize: MAX_TRACKED_RATE_LIMIT_IPS });
  private readonly actionRateLimitWindowMs: number;
  private readonly maxActionsPerWindow: number;

  constructor(
    private readonly docker: DockerClient,
    private readonly options: ManagementServerOptions,
  ) {
    if (!options.managementPassword) throw new Error("ManagementServer richiede una managementPassword non vuota");
    this.actionRateLimitWindowMs = options.actionRateLimitWindowMs ?? DEFAULT_ACTION_RATE_LIMIT_WINDOW_MS;
    this.maxActionsPerWindow = options.maxActionsPerWindow ?? DEFAULT_MAX_ACTIONS_PER_WINDOW;
    this.httpServer = new LoopbackHttpServer((req, res) => void this.handleRequest(req, res), { port: options.port, host: options.host });
  }

  get port(): number {
    return this.httpServer.port;
  }

  async start(): Promise<void> {
    await this.httpServer.start();
  }

  async stop(): Promise<void> {
    await this.httpServer.stop();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Unconditional, same reasoning web-ui.ts's own handleRequest() documents for its CORS header:
    // the mobile Control UI page (mobile/www/hub-control.html) is a different origin from this
    // server, so its fetch()es need this to not be blocked by the browser/WebView's own CORS
    // enforcement — every endpoint here requires the management password anyway, so there's no
    // "should this endpoint be reachable cross-origin" judgment call to make per-route.
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }

    if (!this.isAuthorized(req)) {
      sendJson(res, 401, { error: "missing or invalid management password" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/hub/status") {
      await this.handleStatus(res);
      return;
    }

    const actionMatch = /^\/api\/hub\/containers\/([^/]+)\/(start|stop|restart)$/.exec(url.pathname);
    if (req.method === "POST" && actionMatch) {
      const id = decodeContainerId(actionMatch[1]);
      if (id === undefined) {
        sendJson(res, 400, { error: "malformed container id in URL" });
        return;
      }
      await this.handleAction(req, res, id, actionMatch[2] as "start" | "stop" | "restart");
      return;
    }

    const logsMatch = /^\/api\/hub\/containers\/([^/]+)\/logs$/.exec(url.pathname);
    if (req.method === "GET" && logsMatch) {
      const id = decodeContainerId(logsMatch[1]);
      if (id === undefined) {
        sendJson(res, 400, { error: "malformed container id in URL" });
        return;
      }
      await this.handleLogs(res, id, url.searchParams.get("tail"));
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  /** `GET /api/hub/status` — every managed container's current state/health. */
  private async handleStatus(res: ServerResponse): Promise<void> {
    try {
      const containers = await this.listManagedContainers();
      sendJson(res, 200, { containers });
    } catch (err) {
      sendJson(res, 502, { error: dockerUnreachableMessage(err) });
    }
  }

  /**
   * `POST /api/hub/containers/:id/{start,stop,restart}` — `:id` is
   * resolved against `listManagedContainers()` before ever reaching
   * `DockerClient` (matched by Docker's own id or by name): a container
   * outside `containerNamePrefix` is invisible here even if its real id/name
   * is guessed, and the id `DockerClient` actually calls Docker with always
   * came from Docker's own listing, never straight from this request —
   * closes off any path-injection concern about a crafted `:id` reaching
   * the Docker Engine API unchanged (`CLAUDE.md`: a request's own fields are
   * never trusted as-is).
   */
  private async handleAction(req: IncomingMessage, res: ServerResponse, id: string, verb: "start" | "stop" | "restart"): Promise<void> {
    if (!this.checkActionRateLimit(req)) {
      sendJson(res, 429, { error: "troppe azioni di controllo in poco tempo, riprova tra qualche secondo" });
      return;
    }

    let target: DockerContainerSummary | undefined;
    try {
      target = (await this.listManagedContainers()).find((c) => c.id === id || c.name === id);
    } catch (err) {
      sendJson(res, 502, { error: dockerUnreachableMessage(err) });
      return;
    }
    if (!target) {
      sendJson(res, 404, { error: `nessun container gestito con id/nome ${JSON.stringify(id)}` });
      return;
    }

    try {
      if (verb === "start") await this.docker.startContainer(target.id);
      else if (verb === "stop") await this.docker.stopContainer(target.id);
      else await this.docker.restartContainer(target.id);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      const statusCode = err instanceof DockerApiError ? err.statusCode : 502;
      sendJson(res, statusCode, { error: (err as Error).message });
    }
  }

  /** `GET /api/hub/containers/:id/logs?tail=N` — same `:id` resolution as `handleAction()`. Not rate-limited (unlike the control actions) — a read has no side effect worth bounding beyond `tail`'s own cap. */
  private async handleLogs(res: ServerResponse, id: string, rawTail: string | null): Promise<void> {
    const tail = parseTail(rawTail);

    let target: DockerContainerSummary | undefined;
    try {
      target = (await this.listManagedContainers()).find((c) => c.id === id || c.name === id);
    } catch (err) {
      sendJson(res, 502, { error: dockerUnreachableMessage(err) });
      return;
    }
    if (!target) {
      sendJson(res, 404, { error: `nessun container gestito con id/nome ${JSON.stringify(id)}` });
      return;
    }

    try {
      const logs = await this.docker.getContainerLogs(target.id, tail);
      sendJson(res, 200, { logs });
    } catch (err) {
      const statusCode = err instanceof DockerApiError ? err.statusCode : 502;
      sendJson(res, statusCode, { error: (err as Error).message });
    }
  }

  /** Every container Docker reports, filtered by `containerNamePrefix` when set — the single choke point `handleStatus()`/`handleAction()`/`handleLogs()` all go through, so the prefix guardrail applies uniformly rather than only to the list view. */
  private async listManagedContainers(): Promise<DockerContainerSummary[]> {
    const all = await this.docker.listContainers();
    if (!this.options.containerNamePrefix) return all;
    return all.filter((c) => c.name.startsWith(this.options.containerNamePrefix!));
  }

  /**
   * Bounds control actions (start/stop/restart) per source IP — not a
   * defense against an attacker without the password (auth already blocks
   * that), but insurance against a buggy client or script cycling
   * containers faster than any legitimate operator interaction would, the
   * same spirit `web-ui.ts`'s `checkMapTileRateLimit()` documents for its
   * own per-IP window (no trust-weighted eviction needed here either — a
   * source IP isn't a mesh identity an attacker can mint for free).
   */
  private checkActionRateLimit(req: IncomingMessage): boolean {
    const key = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const entry = this.actionRateLimitState.get(key);
    if (!entry || now - entry.windowStart >= this.actionRateLimitWindowMs) {
      this.actionRateLimitState.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (entry.count >= this.maxActionsPerWindow) return false;
    entry.count++;
    return true;
  }

  /** Same Bearer-token, constant-time-compare shape as `web-ui.ts`'s `isAuthorized()` — see this class's own doc comment for why it isn't imported/shared instead. */
  private isAuthorized(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    const provided = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    return provided !== undefined && timingSafeStringEqual(provided, this.options.managementPassword);
  }
}

/**
 * `decodeURIComponent()` throws `URIError` on a malformed escape sequence
 * (e.g. a lone `%`) — found by review: `handleRequest()` is invoked as
 * `(req, res) => void this.handleRequest(req, res)`, so an uncaught
 * synchronous throw inside it becomes an unhandled promise rejection,
 * which crashes the whole process under Node's default
 * `--unhandled-rejections=throw` (reproduced live against a real
 * `ManagementServer` while fixing this). Returns `undefined` on a
 * malformed segment instead of throwing, same defensive posture
 * `CLAUDE.md` requires for every network-facing input in this codebase —
 * `fake-flatnotes-server.ts`'s own note-path handler has the identical
 * try/catch for the identical reason.
 */
function decodeContainerId(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function dockerUnreachableMessage(err: unknown): string {
  return `Docker non raggiungibile: ${(err as Error).message}`;
}

/** Missing/non-numeric/non-positive falls back to `DEFAULT_LOG_TAIL` rather than propagating `NaN`/negative into the Docker API call; anything above `MAX_LOG_TAIL` is clamped. */
function parseTail(raw: string | null): number {
  if (raw === null) return DEFAULT_LOG_TAIL;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LOG_TAIL;
  return Math.min(parsed, MAX_LOG_TAIL);
}

/** Same reasoning as `web-ui.ts`'s own `timingSafeStringEqual()` — a naive `===` would leak how many leading bytes matched through response timing. */
function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Same alphabet/reasoning as web-ui.ts's NETWORK_PASSWORD_ALPHABET — Crockford's Base32 (32 symbols,
// so `randomBytes()[i] % 32` is free of modulo bias), chosen independently here rather than imported
// so nomad-hub/ has zero dependency on node/src/web-ui.ts (only the two generic infra modules,
// loopback-http-server.ts and bounded-map.ts) — reinforcing that this is not a mesh service.
const MANAGEMENT_PASSWORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Generates a short, typeable management password (e.g. `K7XM-2QRT`) — same shape as `web-ui.ts`'s `generateNetworkPassword()`, a separate secret for a separate system (see this file's class doc comment on why they must never be the same password). */
export function generateManagementPassword(): string {
  const bytes = randomBytes(8);
  let chars = "";
  for (let i = 0; i < bytes.length; i++) chars += MANAGEMENT_PASSWORD_ALPHABET[bytes[i] % MANAGEMENT_PASSWORD_ALPHABET.length];
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}
