import type { NomadNode } from "../../node/src/node.js";
import { BoundedFifoMap } from "../../node/src/bounded-map.js";

/** One news headline, as returned by NOMAD's news backend (`GET /api/news`). */
export interface NewsHeadline {
  id: string;
  title: string;
  summary: string;
  url: string;
  /** ISO 8601 — kept as the backend's own string, never reparsed/reformatted here. */
  publishedAt: string;
}

/** Same bound `RemoteCatalog`/`PeerDirectory` default to (`node/src/catalog.ts`) — `publishedById` is the one piece of this gateway's own state a hostile/misbehaving `--news-url` backend could otherwise grow forever by rotating headline ids on every `startAutoSync()` tick (`docs/security.md`). */
const MAX_TRACKED_HEADLINES = 4096;

function isNewsHeadline(value: unknown): value is NewsHeadline {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.publishedAt === "string"
  );
}

/**
 * Translates Nomad-Net's abstract APIs (spec §37) into HTTP calls against a
 * Project NOMAD instance's news service — a third NOMAD sub-service
 * alongside Kiwix (`kiwix-gateway.ts`) and Ollama (`ai-gateway.ts`,
 * `docs/reuse-vs-new.md`). Deliberately has **no** fake/mocked backend of
 * its own, unlike those two (`fake-nomad-server.ts`/`fake-ollama-server.ts`)
 * — an explicit choice made with the user rather than an oversight
 * (`docs/security.md`). NOMAD's own news feature is envisioned as *it*
 * pulling from the open internet (the one NOMAD sub-service whose upstream
 * genuinely could be "the real internet" rather than something needing
 * Docker/local infrastructure) and re-serving what it has to mesh nodes —
 * this gateway still can't be exercised against a real backend in this
 * sandboxed session (its own outbound network policy blocks arbitrary
 * internet hosts, confirmed directly — see `docs/security.md`), the same
 * "written to spec, can't verify end-to-end here" boundary as Kiwix/Ollama
 * without Docker, just for a different reason.
 *
 * Hybrid of both existing gateways' patterns, because news genuinely needs
 * both halves:
 * - Like `KiwixGateway.syncCatalog()`: each headline is published via
 *   `publishContent()` so it's discoverable/retrievable through the
 *   existing CONTENT_QUERY cycle and propagates through the mesh via
 *   store-and-forward/catalog sync even to nodes that never reach this
 *   gateway directly — the whole point of "aggiornato ogni volta che si
 *   può" (per the user) being periodic background sync, not an on-demand
 *   fetch each time someone wants news.
 * - Like `AiGateway.registerAiService()`: also reachable as
 *   `service://news`, so the mobile app's "quick link" UX works exactly
 *   like every other service. Unlike `service://ai`/`service://kiwix-search`
 *   though, `service://news`'s handler never blocks on a live HTTP call —
 *   it serves whatever `syncNews()` last cached, since a real news backend
 *   is exactly the kind of thing that can be slow or briefly unreachable,
 *   and a request for "the news" shouldn't hang on it when a recent
 *   snapshot is already sitting in memory.
 */
export class NewsGateway {
  /** headline id -> contentId last published for it, so a re-sync that returns an unchanged headline doesn't re-report it — same dedup shape as `KiwixGateway.publishedByPath`, but bounded (see `MAX_TRACKED_HEADLINES`) since this one gateway can now refresh itself unattended via `startAutoSync()`. */
  private readonly publishedById = new BoundedFifoMap<string, string>({ maxSize: MAX_TRACKED_HEADLINES });
  /** Snapshot from the most recent successful `syncNews()` — what `service://news` actually answers with, never a live call per invocation. */
  private cachedHeadlines: NewsHeadline[] = [];
  private syncTimer: NodeJS.Timeout | undefined;
  /**
   * Bumped at the start of every `syncNews()` call, so a call that started
   * earlier but resolves later (a slow request overtaken by a faster one
   * `startAutoSync()` kicked off on a subsequent tick) can tell it's been
   * superseded and must not clobber state a newer call already committed —
   * the network doesn't guarantee responses arrive in request order.
   */
  private syncGeneration = 0;

  constructor(
    private readonly node: NomadNode,
    /** Base URL of the NOMAD news HTTP API, e.g. `http://127.0.0.1:PORT`. No default/fake fallback — see the class doc comment. */
    private readonly baseUrl: string,
  ) {}

  /** The most recent successful sync's headlines — what `service://news` currently answers with. Empty before the first successful `syncNews()`. */
  get headlines(): readonly NewsHeadline[] {
    return this.cachedHeadlines;
  }

  /**
   * Fetches NOMAD's current headline list, publishes each one via
   * `publishContent()` (as `application/json`, so a caller gets the
   * structured headline back rather than having to parse prose), and
   * refreshes the in-memory cache `service://news` serves from. Callable
   * repeatedly — returns only the headlines that are new or changed since
   * this instance's own last sync, mirroring `KiwixGateway.syncCatalog()`'s
   * contract exactly (including its same accepted limitation: an edited
   * headline is published under a brand new content id, the previous
   * version's bytes are never evicted from `node.contentStore` — see that
   * class's doc comment for the full reasoning, unchanged here).
   *
   * The response body is validated defensively before anything is applied
   * (same posture as `packet.payload?.field` checks elsewhere in this
   * codebase for network-sourced data, `CLAUDE.md`) — a non-array or
   * malformed-entry response throws and leaves `publishedById`/
   * `cachedHeadlines` completely untouched, rather than partially applying
   * whichever entries happened to parse before a later one didn't.
   *
   * If a newer `syncNews()` call has already started (and possibly already
   * committed) by the time this one's response arrives, this call's result
   * is discarded — see `syncGeneration`.
   */
  async syncNews(): Promise<NewsHeadline[]> {
    const generation = ++this.syncGeneration;
    const res = await fetch(`${this.baseUrl}/api/news`);
    if (!res.ok) {
      throw new Error(`NOMAD news backend failed (HTTP ${res.status})`);
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body) || !body.every(isNewsHeadline)) {
      throw new Error("NOMAD news backend returned a malformed headline list");
    }
    const headlines = body;

    if (generation !== this.syncGeneration) {
      // Superseded by a newer syncNews() call started while this fetch was in flight — that
      // newer call is authoritative, so this stale response reports nothing new.
      return [];
    }

    const changed: NewsHeadline[] = [];
    for (const headline of headlines) {
      const metadata = this.node.publishContent(headline.title, "application/json", Buffer.from(JSON.stringify(headline), "utf8"));
      if (this.publishedById.get(headline.id) !== metadata.contentId) {
        this.publishedById.set(headline.id, metadata.contentId);
        changed.push(headline);
      }
    }
    this.cachedHeadlines = headlines;
    return changed;
  }

  /**
   * Starts calling `syncNews()` on a timer (spec's delay-tolerant "update
   * whenever reachable" ethos — the user's own framing for this feature).
   * A failed sync (backend momentarily unreachable, exactly as `docs/security.md`
   * expects for a real internet-facing dependency) is reported to `onError`
   * if given and never stops the timer from trying again next interval —
   * the same "tolerate a flaky upstream" posture `KiwixGateway`'s own doc
   * comment describes for NOMAD generally (spec §4, "non è dichiarato
   * stabile"). Calling this again replaces any previously running timer
   * rather than stacking a second one.
   */
  startAutoSync(intervalMs: number, onError?: (err: unknown) => void): void {
    this.stopAutoSync();
    this.syncTimer = setInterval(() => {
      this.syncNews().catch((err: unknown) => onError?.(err));
    }, intervalMs);
  }

  /** Stops the timer started by `startAutoSync()`, if one is running. Safe to call even if none is. */
  stopAutoSync(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = undefined;
  }

  /**
   * Registers `service://news` — takes no input, always answers instantly
   * from the cache `syncNews()`/`startAutoSync()` maintain (see the class
   * doc comment for why this never proxies live like
   * `service://ai`/`service://kiwix-search` do). Answers `{ headlines: [] }`
   * rather than an error if no sync has completed yet — an honest "the mesh
   * hasn't learned anything yet", not a failure.
   */
  registerNewsService(): void {
    this.node.registerService("service://news", "1.0.0", ["headlines"], async () => {
      return { headlines: this.cachedHeadlines };
    });
  }
}
