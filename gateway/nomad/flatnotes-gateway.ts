import type { NomadNode } from "../../node/src/node.js";
import { BoundedFifoMap } from "../../node/src/bounded-map.js";
import { trustRank } from "../../node/src/trust.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";
import { mapWithConcurrency } from "./concurrency.js";

const DEFAULT_SYNC_CONCURRENCY = 8;

/** Same purpose/shape as `MAX_DROP_LABEL_LENGTH` in `node/src/drops.ts` — a note's title is short-form free text, not chat-message-length, but private to this file (no other gateway needs it). */
const MAX_NOTE_TITLE_LENGTH = 120;

/**
 * Bounds `publishedByPath` (spec §57) — unlike `KiwixGateway.publishedByPath`,
 * whose growth is capped by a finite operator-owned NOMAD catalog,
 * `FlatnotesGateway`'s twin is also fed by `service://flatnotes-create`
 * (any mesh peer within its rate-limit budget can keep adding distinct
 * notes indefinitely), so it needs the same explicit bound
 * `NewsGateway.publishedById` already has for the identical reason
 * (`docs/security.md`). Plain FIFO eviction (no trust weighting, unlike
 * peer-keyed structures — this map is keyed by note *path*, not by an
 * identity `trustRank()` could meaningfully rank).
 *
 * Accepted limitation (same class as `KiwixGateway.syncCatalog()`'s own
 * documented ContentStore-overflow tradeoff): a real FlatNotes catalog with
 * more than this many *distinct* note paths will, on a full `syncCatalog()`
 * re-sync, cascade into re-reporting more than just the truly-evicted
 * entries as "changed" — native `Map` iteration order isn't updated by a
 * no-op `get()`, so an unchanged entry evicted to make room for one
 * processed earlier in the same listing-order pass can itself still be
 * ahead of other not-yet-visited entries, which then also get "bumped" in
 * turn. Memory still never grows past `MAX_TRACKED_NOTE_PATHS` (the actual
 * guarantee this bound exists for) — only the "only report genuinely new/
 * changed entries" optimization degrades once a catalog exceeds it, the
 * same "an operator syncing at that scale needs to size accordingly"
 * posture `KiwixGateway`'s own doc comment already takes. Not just a
 * bigger returned array either: each spuriously re-reported entry also
 * re-runs a real `Identity.sign()` and a `ContentStore` write inside
 * `publishContent()`, so a cascading re-sync of a catalog well past this
 * cap costs real CPU, not only a less useful result.
 */
const MAX_TRACKED_NOTE_PATHS = 4096;

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
 * Translates Nomad-Net's abstract APIs (spec §37) into HTTP calls against a
 * FlatNotes instance (Project NOMAD component, spec §4/
 * `docs/SPECIFICATION.md:102`, `docs/reuse-vs-new.md`: "Esiste,
 * containerizzato → Consumato tramite gateway") — a real Docker+NOMAD
 * instance in production, `FakeFlatnotesServer` in this slice's tests/demo.
 * Same three-part shape `KiwixGateway` established, plus a write path
 * neither `KiwixGateway` nor `NewsGateway` needed:
 *
 * - `syncCatalog()` (`content://...`): mirrors `KiwixGateway.syncCatalog()`
 *   exactly — fetches FlatNotes' note list, publishes each one via
 *   `publishContent()` (mime type `text/markdown`, since FlatNotes stores
 *   notes as markdown), reports only new/changed entries on a re-sync. See
 *   that method's doc comment (same file's sibling) for the accepted
 *   "edited note accumulates a new content id, old one isn't deleted"
 *   limitation — identical here for the identical reason (content
 *   addressing has no notion of "this replaces that").
 * - `registerSearchService()` (`CALL service://...`): `service://flatnotes-search`,
 *   a live proxy to FlatNotes' own search endpoint, never cached — same
 *   shape as `service://kiwix-search`.
 * - `registerCreateService()` (`CALL service://...`, new — no existing
 *   gateway writes to NOMAD): `service://flatnotes-create`, a "shared
 *   notebook" a mesh node (e.g. a hiker's phone) can write to. Validates
 *   the payload defensively (`CLAUDE.md`: a service payload is exactly as
 *   untrusted as any network-sourced value), rate-limits per-caller and
 *   mesh-wide (same two-layer reasoning as `InternetGateway.checkRateLimit()` —
 *   `fromNodeId` isn't cryptographically authenticated, so a per-identity
 *   limit alone is trivially evaded by rotating fake source ids; the real
 *   cost here is a write to an external system, a more attractive abuse
 *   target than a read), then POSTs to FlatNotes and immediately publishes
 *   the resulting note as `content://` (reusing `syncCatalog()`'s own
 *   `publishedByPath` bookkeeping) so it's readable mesh-wide without
 *   waiting for the next sync.
 *
 * No SSRF guard needed here (unlike `InternetGateway`): the destination is
 * always this gateway's own fixed `baseUrl`, configured once by the
 * operator, never a caller-supplied URL.
 */
export class FlatnotesGateway {
  /** Same role as `KiwixGateway.publishedByPath` — last contentId published per note path, so `syncCatalog()`/`registerCreateService()` only report genuinely new/changed entries. Bounded (`MAX_TRACKED_NOTE_PATHS`) unlike Kiwix's twin — see that constant's doc comment for why. */
  private readonly publishedByPath = new BoundedFifoMap<string, string>({ maxSize: MAX_TRACKED_NOTE_PATHS });
  private readonly maxRequestsPerPeerPerWindow: number;
  private readonly maxRequestsPerWindow: number;
  private readonly windowMs: number;
  /** Same bounding/trust-weighted-eviction convention as `InternetGateway.rateLimitState` — keyed by the unauthenticated caller id. */
  private readonly rateLimitState: BoundedFifoMap<string, RateWindow>;
  private globalRateLimitState: RateWindow = { windowStart: 0, count: 0 };

  constructor(
    private readonly node: NomadNode,
    /** Base URL of the FlatNotes HTTP API, e.g. `http://127.0.0.1:PORT` (a `FakeFlatnotesServer` in tests, a real FlatNotes instance in production). */
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
   * Fetches FlatNotes' current note list and publishes each one locally —
   * see the class doc comment for the accepted "edited note accumulates a
   * new content id" limitation, and `KiwixGateway.syncCatalog()`'s own
   * (near-identical) doc comment for the full reasoning. Callable more than
   * once; no automatic polling built in (same as `KiwixGateway`).
   */
  async syncCatalog(): Promise<Array<{ path: string; contentId: string }>> {
    const listRes = await fetch(`${this.baseUrl}/api/notes`);
    if (!listRes.ok) {
      throw new Error(`FlatNotes gateway: failed to list notes (HTTP ${listRes.status})`);
    }
    const entries = (await listRes.json()) as Array<{ path: string; title: string }>;

    const results = await mapWithConcurrency(entries, DEFAULT_SYNC_CONCURRENCY, async (entry) => {
      const noteRes = await fetch(`${this.baseUrl}/api/notes/${encodeURIComponent(entry.path)}`);
      if (!noteRes.ok) {
        // FlatNotes, like NOMAD generally, isn't guaranteed stable between a listing and a fetch —
        // same tolerance KiwixGateway.syncCatalog() already has for exactly this situation.
        return undefined;
      }
      const note = (await noteRes.json()) as { path: string; title: string; content: string };
      return this.publishNote(note.path, note.title, note.content);
    });

    const published: Array<{ path: string; contentId: string }> = [];
    for (const result of results) {
      if (result) published.push(result);
    }
    return published;
  }

  /** Publishes one note and records it in `publishedByPath` — returns the published entry only if it's new or changed since the last publish of this same path, `undefined` otherwise (same "report only what actually changed" contract `syncCatalog()`'s return value has). Shared by `syncCatalog()` and `registerCreateService()` so a freshly-created note is immediately reflected the same way a synced one would be. */
  private publishNote(path: string, title: string, content: string): { path: string; contentId: string } | undefined {
    const metadata = this.node.publishContent(title, "text/markdown", Buffer.from(content, "utf8"));
    if (this.publishedByPath.get(path) === metadata.contentId) return undefined; // unchanged since the last publish of this path
    this.publishedByPath.set(path, metadata.contentId);
    return { path, contentId: metadata.contentId };
  }

  /** Registers `service://flatnotes-search` — live proxy to FlatNotes' search endpoint on every call, never cached. Same shape as `KiwixGateway.registerSearchService()`. */
  registerSearchService(): void {
    this.node.registerService("service://flatnotes-search", "1.0.0", ["search"], async (payload) => {
      const { q } = payload as { q?: unknown };
      if (typeof q !== "string") throw new Error("service://flatnotes-search requires a string 'q' field");

      const res = await fetch(`${this.baseUrl}/api/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`FlatNotes search failed (HTTP ${res.status})`);
      return { results: (await res.json()) as Array<{ path: string; title: string }> };
    });
  }

  /** Registers `service://flatnotes-create` — see the class doc comment for the full contract. Rejects (never resolves with an error payload) on any validation/rate-limit/write failure, same convention as every other service handler in this codebase. */
  registerCreateService(): void {
    this.node.registerService("service://flatnotes-create", "1.0.0", ["create"], async (payload, fromNodeId) => {
      return this.handleCreate(payload, fromNodeId);
    });
  }

  private async handleCreate(payload: unknown, fromNodeId: string): Promise<{ path: string; contentId: string }> {
    const { title, content } = validateCreateRequest(payload);

    this.checkRateLimit(fromNodeId);

    const res = await fetch(`${this.baseUrl}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
    });
    if (!res.ok) throw new Error(`FlatNotes note creation failed (HTTP ${res.status})`);
    const note = (await res.json()) as { path: string; title: string; content: string };

    const published = this.publishNote(note.path, note.title, note.content);
    // publishNote() only returns undefined for an *unchanged* path — a freshly created note always
    // has a path FlatNotes just minted, so this can only happen if FlatNotes echoed back exactly the
    // same path+content as something already synced, in which case reporting that existing entry is
    // still a correct answer to "here's your note".
    return published ?? { path: note.path, contentId: this.publishedByPath.get(note.path)! };
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

/** Validates a `flatnotes-create` request payload defensively — never trusts its shape. Throws with a message safe to surface to the caller as-is. */
function validateCreateRequest(payload: unknown): { title: string; content: string } {
  if (!payload || typeof payload !== "object") throw new Error("richiesta non valida: payload mancante");
  const { title, content } = payload as { title?: unknown; content?: unknown };

  if (typeof content !== "string" || content.length === 0 || content.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw new Error(`'content' must be a non-empty string of at most ${MAX_MESSAGE_TEXT_LENGTH} characters`);
  }

  if (title === undefined) {
    return { title: `Nota dalla mesh — ${new Date().toISOString()}`, content };
  }
  if (typeof title !== "string" || title.length === 0 || title.length > MAX_NOTE_TITLE_LENGTH) {
    throw new Error(`'title', if given, must be a non-empty string of at most ${MAX_NOTE_TITLE_LENGTH} characters`);
  }
  return { title, content };
}
