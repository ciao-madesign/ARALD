import type { NomadNode } from "../../node/src/node.js";
import { BoundedFifoMap } from "../../node/src/bounded-map.js";
import { trustRank } from "../../node/src/trust.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";

/** Same purpose/shape as `MAX_DROP_LABEL_LENGTH` in `node/src/drops.ts` — a note's title is short-form free text, not chat-message-length, but private to this file (no other gateway needs it). */
const MAX_NOTE_TITLE_LENGTH = 120;

/**
 * Characters real Flatnotes rejects in a title (`server/helpers.py`'s
 * `is_valid_filename` — notes are literal files on disk). Validated here too
 * so a caller gets a clear ARALD-side error instead of a raw Flatnotes HTTP
 * failure. Exported so `fake-flatnotes-server.ts` enforces the identical
 * rule instead of a second, independently-maintained copy that could drift
 * from this one (found by `code-review`, 30 September 2026) — **not**
 * given the `g` flag: a global regex reused across multiple `.test()` calls
 * carries `lastIndex` state between them, silently alternating true/false
 * on the same input (see `validateCreateRequest()`'s doc comment for where
 * this project actually hit that pitfall while writing this file).
 */
export const INVALID_TITLE_CHARS = /[<>:"/\\|?*]/;

/** See `InternetGateway`'s identical constants (`internet-gateway.ts`) — same defaults, same two-layer reasoning, reused rather than re-derived. */
const MAX_TRACKED_RATE_LIMIT_PEERS = 4096;
const DEFAULT_MAX_REQUESTS_PER_PEER_PER_WINDOW = 10;
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 60;
const DEFAULT_WINDOW_MS = 60_000;

export interface FlatnotesGatewayOptions {
  maxRequestsPerPeerPerWindow?: number;
  maxRequestsPerWindow?: number;
  windowMs?: number;
}

interface RateWindow {
  windowStart: number;
  count: number;
}

/**
 * Translates ARALD's abstract APIs (spec §37) into HTTP calls against a
 * **real, bare Flatnotes instance** — not Project NOMAD's own (never
 * verified, never seen) API surface. Rewritten 30 September 2026 in the
 * same spirit as `KiwixGateway` (`docs/security.md` voce #97/#98): the
 * previous version of this class called invented endpoints (`GET /api/notes`
 * for a bulk listing, notes addressed by an invented `path` field) that
 * `FakeFlatnotesServer` modeled but that real Flatnotes doesn't expose —
 * verified against `dullage/flatnotes`'s own source on the `develop` branch
 * (`server/main.py`, `server/notes/models.py`, `server/helpers.py`,
 * `server/global_config.py`, fetched via `raw.githubusercontent.com`; no
 * live instance reachable to verify against instead — `demo.flatnotes.io`
 * is blocked by this session's network egress policy, so this is verified
 * against source, not a running server's own `/docs`/OpenAPI spec).
 *
 * **Real API actually used** (FastAPI backend, fields camelCase over the
 * wire via `CustomBaseModel`'s `alias_generator`, despite snake_case
 * Python internals):
 * - `GET /api/notes/{title}` → `Note {title, content?, lastModified}`
 * - `POST /api/notes` body `NoteCreate {title, content?}` → `Note`
 * - `GET /api/search?term=&sort=score|title|lastModified&order=asc|desc&limit=`
 *   → `SearchResult[] {title, lastModified, score?, titleHighlights?,
 *   contentHighlights?, tagMatches?}`
 *
 * **Notes are addressed by title, not "path"** — the previous version of
 * this class invented a `path` field that doesn't exist in the real API;
 * every reference to it below has been renamed to `title` accordingly.
 *
 * **Architectural change forced by what's real, not a stylistic rewrite**:
 * Flatnotes has **no endpoint that lists/enumerates every note** — confirmed
 * against the source above (only `/api/notes/{title}`, `POST /api/notes`,
 * `/api/search`, no bare `GET /api/notes`). The previous `syncCatalog()`
 * (fetch every note up front, publish each via `publishContent()`) has
 * therefore been **removed**, not adapted — same reasoning, same fate as
 * `KiwixGateway.syncCatalog()`. `registerFetchService()` (`service://flatnotes-fetch`)
 * is the mesh-exposed counterpart, mirroring `service://kiwix-fetch`
 * exactly: a caller with a `title` (typically from a prior
 * `service://flatnotes-search` result) turns it into retrievable content
 * with one call, deliberately not automatic (a search nobody follows up on
 * costs nothing).
 *
 * **Assumes the operator runs Flatnotes with `FLATNOTES_AUTH_TYPE=none`**
 * (`server/global_config.py`'s `AuthType` enum: `none`/`read_only`/
 * `password`/`totp`) — same unauthenticated-backend posture already taken
 * for kiwix-serve/Ollama. This gateway never sends an `Authorization`
 * header; against an instance configured for any other `AuthType` every
 * call here would fail with `401`.
 *
 * Three-part shape `KiwixGateway` established, plus a write path neither
 * `KiwixGateway` nor `NewsGateway` needed:
 *
 * - `registerSearchService()` (`CALL service://...`): `service://flatnotes-search`,
 *   a live proxy to Flatnotes' real `/api/search`, never cached.
 * - `registerFetchService()` (`CALL service://...`, new): `service://flatnotes-fetch`,
 *   see above.
 * - `registerCreateService()` (`CALL service://...`): `service://flatnotes-create`,
 *   a "shared notebook" a mesh node (e.g. a hiker's phone) can write to.
 *   Validates the payload defensively (`CLAUDE.md`: a service payload is
 *   exactly as untrusted as any network-sourced value), rate-limits
 *   per-caller and mesh-wide (same two-layer reasoning as
 *   `InternetGateway.checkRateLimit()` — `fromNodeId` isn't
 *   cryptographically authenticated, so a per-identity limit alone is
 *   trivially evaded by rotating fake source ids; the real cost here is a
 *   write to an external system, a more attractive abuse target than a
 *   read), then POSTs to Flatnotes and immediately publishes the resulting
 *   note as `content://` so it's readable mesh-wide without waiting for a
 *   `service://flatnotes-fetch` call.
 *
 * No SSRF guard needed here (unlike `InternetGateway`): the destination is
 * always this gateway's own fixed `baseUrl`, configured once by the
 * operator, never a caller-supplied URL.
 */
export class FlatnotesGateway {
  private readonly maxRequestsPerPeerPerWindow: number;
  private readonly maxRequestsPerWindow: number;
  private readonly windowMs: number;
  /** Same bounding/trust-weighted-eviction convention as `InternetGateway.rateLimitState` — keyed by the unauthenticated caller id. */
  private readonly rateLimitState: BoundedFifoMap<string, RateWindow>;
  private globalRateLimitState: RateWindow = { windowStart: 0, count: 0 };

  constructor(
    private readonly node: NomadNode,
    /** Base URL of a real Flatnotes instance, e.g. `http://127.0.0.1:PORT` (`FakeFlatnotesServer` in tests/demo). */
    private readonly baseUrl: string,
    options: FlatnotesGatewayOptions = {},
  ) {
    this.maxRequestsPerPeerPerWindow = options.maxRequestsPerPeerPerWindow ?? DEFAULT_MAX_REQUESTS_PER_PEER_PER_WINDOW;
    this.maxRequestsPerWindow = options.maxRequestsPerWindow ?? DEFAULT_MAX_REQUESTS_PER_WINDOW;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.rateLimitState = new BoundedFifoMap<string, RateWindow>({
      maxSize: MAX_TRACKED_RATE_LIMIT_PEERS,
      evictionScore: (peerId) => trustRank(this.node.trust.get(peerId)),
    });
  }

  /**
   * Fetches one note by title (real `GET /api/notes/{title}`) and publishes
   * it via `publishContent()` — mirrors `KiwixGateway.publishArticle()`
   * exactly. Safe to call repeatedly for the same title: content addressing
   * means an unchanged note republishes under the same `contentId` and is a
   * cheap no-op downstream.
   */
  async fetchNote(title: string): Promise<{ title: string; contentId: string }> {
    const res = await fetch(`${this.baseUrl}/api/notes/${encodeURIComponent(title)}`);
    if (!res.ok) {
      throw new Error(`FlatNotes: failed to fetch note '${title}' (HTTP ${res.status})`);
    }
    const note = (await res.json()) as { title?: unknown; content?: unknown };
    if (typeof note.title !== "string" || typeof note.content !== "string") {
      throw new Error(`FlatNotes: malformed note response for '${title}'`);
    }
    return this.publishNote(note.title, note.content);
  }

  private publishNote(title: string, content: string): { title: string; contentId: string } {
    const metadata = this.node.publishContent(title, "text/markdown", Buffer.from(content, "utf8"));
    return { title, contentId: metadata.contentId };
  }

  /**
   * Registers `service://flatnotes-search` — every call proxies live to
   * Flatnotes' real `/api/search?term=` endpoint, translating the result
   * back into ARALD's shape. Never caches, same reasoning as `KiwixGateway`:
   * a stale suggestion list is worse than a slow real one.
   */
  registerSearchService(): void {
    this.node.registerService("service://flatnotes-search", "1.0.0", ["search"], async (payload) => {
      const { q } = payload as { q?: unknown };
      if (typeof q !== "string") throw new Error("service://flatnotes-search requires a string 'q' field");

      const res = await fetch(`${this.baseUrl}/api/search?term=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`FlatNotes search failed (HTTP ${res.status})`);
      const raw = (await res.json()) as unknown;
      if (!Array.isArray(raw)) throw new Error("FlatNotes search returned a malformed response");

      // Skips (rather than throws on) any entry that isn't a plain object with a string title — a
      // single malformed result must not lose every other legitimate one in the same response, same
      // defensive posture as KiwixGateway.registerSearchService() (docs/security.md voce #97).
      const results = raw
        .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && typeof entry.title === "string")
        .map((e) => ({ title: e.title as string }));
      return { results };
    });
  }

  /**
   * Registers `service://flatnotes-fetch` — the mesh-callable counterpart to
   * `fetchNote()` (see this class's doc comment for the design this closes:
   * a caller who found a `title` via `service://flatnotes-search` turns it
   * into retrievable content). Synchronous from the caller's point of view:
   * the response only arrives once the note has actually been fetched from
   * Flatnotes and published locally.
   */
  registerFetchService(): void {
    this.node.registerService("service://flatnotes-fetch", "1.0.0", ["fetch"], async (payload) => {
      const { title } = payload as { title?: unknown };
      if (typeof title !== "string" || title.length === 0) {
        throw new Error("service://flatnotes-fetch requires a non-empty string 'title' field");
      }
      return this.fetchNote(title);
    });
  }

  /** Registers `service://flatnotes-create` — see the class doc comment for the full contract. Rejects (never resolves with an error payload) on any validation/rate-limit/write failure, same convention as every other service handler in this codebase. */
  registerCreateService(): void {
    this.node.registerService("service://flatnotes-create", "1.0.0", ["create"], async (payload, fromNodeId) => {
      return this.handleCreate(payload, fromNodeId);
    });
  }

  private async handleCreate(payload: unknown, fromNodeId: string): Promise<{ title: string; contentId: string }> {
    const { title, content } = validateCreateRequest(payload);

    this.checkRateLimit(fromNodeId);

    const res = await fetch(`${this.baseUrl}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
    });
    if (!res.ok) throw new Error(`FlatNotes note creation failed (HTTP ${res.status})`);
    const note = (await res.json()) as { title?: unknown; content?: unknown };
    if (typeof note.title !== "string" || typeof note.content !== "string") {
      throw new Error("FlatNotes: malformed response after note creation");
    }

    return this.publishNote(note.title, note.content);
  }

  /** Same two-layer reasoning as `InternetGateway.checkRateLimit()` — see that method's doc comment. */
  private checkRateLimit(peerId: string): void {
    const now = Date.now();

    if (now - this.globalRateLimitState.windowStart >= this.windowMs) {
      this.globalRateLimitState = { windowStart: now, count: 0 };
    }
    if (this.globalRateLimitState.count >= this.maxRequestsPerWindow) {
      throw new Error("service://flatnotes-create: limite di richieste della mesh raggiunto, riprova più tardi");
    }

    const entry = this.rateLimitState.get(peerId);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.rateLimitState.set(peerId, { windowStart: now, count: 1 });
    } else {
      if (entry.count >= this.maxRequestsPerPeerPerWindow) {
        throw new Error("service://flatnotes-create: limite di richieste per questo nodo raggiunto, riprova più tardi");
      }
      entry.count++;
    }

    this.globalRateLimitState.count++;
  }
}

/**
 * Validates a `flatnotes-create` request payload defensively — never trusts
 * its shape. Throws with a message safe to surface to the caller as-is.
 *
 * The auto-generated default title (when the caller omits one) used to be
 * `Nota dalla mesh — ${new Date().toISOString()}` — an ISO timestamp
 * contains `:`, one of the characters real Flatnotes rejects in a title
 * (`INVALID_TITLE_CHARS`, `server/helpers.py`'s `is_valid_filename`): every
 * mesh-originated note without an explicit title would have failed against
 * a real instance with a 422 this gateway didn't anticipate (found while
 * verifying the real API, not by the old `FakeFlatnotesServer`, which never
 * modeled this restriction). Fixed by sanitizing the timestamp instead of
 * guessing a different format is safe.
 */
function validateCreateRequest(payload: unknown): { title: string; content: string } {
  if (!payload || typeof payload !== "object") throw new Error("richiesta non valida: payload mancante");
  const { title, content } = payload as { title?: unknown; content?: unknown };

  if (typeof content !== "string" || content.length === 0 || content.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw new Error(`'content' must be a non-empty string of at most ${MAX_MESSAGE_TEXT_LENGTH} characters`);
  }

  if (title === undefined) {
    // A fresh /g regex literal here, not the shared module-level INVALID_TITLE_CHARS: a global regex
    // used with .test() elsewhere would carry lastIndex state between calls, silently alternating
    // true/false on the same input across successive validations (a real, easy-to-miss JS pitfall).
    const safeTimestamp = new Date().toISOString().replace(/[<>:"/\\|?*]/g, "-");
    return { title: `Nota dalla mesh - ${safeTimestamp}`, content };
  }
  if (typeof title !== "string" || title.length === 0 || title.length > MAX_NOTE_TITLE_LENGTH) {
    throw new Error(`'title', if given, must be a non-empty string of at most ${MAX_NOTE_TITLE_LENGTH} characters`);
  }
  if (INVALID_TITLE_CHARS.test(title)) {
    throw new Error(`'title' cannot include any of the following characters: <>:"/\\|?*`);
  }
  return { title, content };
}
