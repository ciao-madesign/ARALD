import type { NomadNode } from "../../node/src/node.js";
import { BoundedFifoMap } from "../../node/src/bounded-map.js";
import { parseFeed, MAX_FEED_BYTES } from "./rss-feed.js";

/**
 * One news headline — deliberately lean: title and metadata only, never the
 * article body. Originally this also carried `summary` inline (one blob per
 * news item, "titolo+riassunto insieme"); now split into two tiers
 * (`docs/next-steps.md` Opzione I, pezzo 2), the same "small metadata always
 * synced, larger body fetched on demand" shape the proposal asked for,
 * motivated by efficiency on narrow-band links (BLE, spec §46-47) — a
 * catalog sync no longer has to move every article's full text just to let
 * a node discover that the headline exists. Every field below comes from a
 * parsed `FeedItem`/`ParsedFeed` (`rss-feed.ts`): see `syncNews()`.
 */
export interface NewsHeadline {
  id: string;
  title: string;
  url: string;
  /** Normalized to ISO 8601 by `rss-feed.ts`'s `toIso()` — never the feed's raw native date format (RFC 822 for RSS). */
  publishedAt: string;
  /** The feed's own name (RSS `<channel><title>`/Atom `<feed><title>`), e.g. "Wikinotizie" — empty string if the feed doesn't declare one. */
  source: string;
  /** First `<category>` the feed gave this item, if any. */
  category?: string;
  /** RSS `<language>`/Atom `xml:lang`, feed-wide (not per item) — carried on every headline from the same sync for convenience, so a consumer never has to look elsewhere for it. */
  language?: string;
  /** Atom `<updated>` only, when distinct from `publishedAt` — always undefined for an RSS-sourced headline (RSS 2.0 has no equivalent field). */
  updatedAt?: string;
  /**
   * Content id of this item's separately-published body (`NewsArticleBody`,
   * `application/json`) — the second tier, published alongside the headline
   * but never eagerly held by a consumer the way `service://news`'s
   * headline list is: fetch it explicitly via `NomadNode.getContent()` only
   * once a user actually wants to read the full text. Since a content id is
   * the hash of its bytes (spec §24), this reference itself is stable even
   * though the article body it points to is immutable — a later edit to
   * the article publishes new bytes and a new id (same accepted limitation
   * `KiwixGateway.syncCatalog()`'s doc comment already describes for its
   * own re-published content).
   */
  articleContentId: string;
}

/** The body a `NewsHeadline.articleContentId` points to — kept as its own small, explicit shape (not just a bare string) so a future richer article tier (full text vs. today's feed-provided summary, spec §46-47's narrow-band framing) can extend it without changing `NewsHeadline`'s own shape again. */
export interface NewsArticleBody {
  /** RSS `<description>` or Atom `<summary>`/`<content>`, verbatim from `FeedItem.summary` (`rss-feed.ts`) — empty string if the feed omitted it for this item. */
  summary: string;
}

/** Same bound `RemoteCatalog`/`PeerDirectory` default to (`node/src/catalog.ts`) — `publishedById` is the one piece of this gateway's own state a hostile/misbehaving `--news-url` backend could otherwise grow forever by rotating headline ids on every `startAutoSync()` tick (`docs/security.md`). */
const MAX_TRACKED_HEADLINES = 4096;

/**
 * Fetches `url` and reads its body as text, aborting as soon as more than
 * `maxBytes` have arrived rather than buffering an unbounded response in
 * full first — `res.text()` alone would download the entire body before
 * `parseFeed()`'s own `MAX_FEED_BYTES` check ever got a chance to reject
 * it, so a hostile/misbehaving `--news-url` backend (spec §57) could still
 * force this node to hold an arbitrarily large response in memory (found
 * by review; empirically confirmed before this fix existed). Mirrors
 * `node/src/loopback-http-server.ts`'s `readRequestBody()`/`BodyTooLargeError`
 * pattern, applied to an outbound fetch instead of an inbound request.
 * Falls back to buffering the whole response only if the runtime doesn't
 * expose a streaming body (`res.body` undefined) — not expected under
 * Node's `fetch()`, kept only as a defensive fallback.
 */
async function fetchTextBounded(url: string, maxBytes: number): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`news feed fetch failed (HTTP ${res.status})`);
  if (!res.body) {
    // Not expected from Node's fetch() for a normal response with a body — kept only as a
    // defensive fallback (e.g. a future runtime/polyfill difference). Still bounded: this can only
    // ever buffer whatever the backend actually sent, then reject it after the fact, rather than
    // silently accepting an unbounded body the way an unchecked res.text() would (found by review:
    // this branch originally had no size check at all, reintroducing the exact vulnerability the
    // streaming path below exists to close).
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`news feed response exceeded ${maxBytes} bytes`);
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`news feed response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/**
 * Ingests a real RSS/Atom news feed (`rss-feed.ts`) directly — unlike
 * `KiwixGateway`/`AiGateway`, this is **not** a translation layer in front
 * of a Project NOMAD HTTP API. It originally was one (a fictional NOMAD
 * `GET /api/news` JSON endpoint that never represented anything real); that
 * mini-API is gone, replaced by parsing an actual feed, because RSS/Atom is
 * the real protocol most news sources speak and a hand-rolled parser makes
 * this gateway testable against something genuine rather than an invented
 * contract nothing implements (`docs/next-steps.md` Opzione I). Still no
 * fake/mocked backend shipped, unlike `KiwixGateway`/`AiGateway`'s
 * `fake-nomad-server.ts`/`fake-ollama-server.ts` — an explicit choice made
 * with the user (`docs/security.md`), and this gateway still can't be
 * exercised against a real feed in this sandboxed session (its own outbound
 * network policy blocks arbitrary internet hosts, confirmed directly — see
 * `docs/security.md`); tests exercise `rss-feed.ts` and `syncNews()`
 * against a test-local HTTP server serving hand-written XML fixtures.
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
    /** URL of an RSS or Atom feed, e.g. `http://127.0.0.1:PORT/feed.xml`. No default/fake fallback — see the class doc comment. */
    private readonly feedUrl: string,
  ) {}

  /** The most recent successful sync's headlines — what `service://news` currently answers with. Empty before the first successful `syncNews()`. */
  get headlines(): readonly NewsHeadline[] {
    return this.cachedHeadlines;
  }

  /**
   * Fetches `feedUrl`, parses it as RSS or Atom (`rss-feed.ts`), and
   * publishes each item as **two** separate contents (`application/json`) —
   * the two-tier split described on `NewsHeadline`/`NewsArticleBody`: the
   * article body first (so the headline can embed its real content id),
   * then the headline itself, which is what gets tracked/returned/cached
   * below and what `service://news` actually answers with. Refreshes the
   * in-memory cache `service://news` serves from. Callable repeatedly —
   * returns only the headlines that are new or changed since this
   * instance's own last sync (a change to either tier changes the
   * headline's own content id, since it embeds `articleContentId` — no
   * separate change tracking needed for the article tier), mirroring
   * `KiwixGateway.syncCatalog()`'s contract exactly (including its same
   * accepted limitation: an edited headline is published under a brand new
   * content id, and the previous version's bytes aren't explicitly deleted
   * — see that class's doc comment for the full reasoning and the
   * resulting size-bound tradeoff, unchanged here. `publishedById` itself
   * tracks up to `MAX_TRACKED_HEADLINES` (4096) distinct headline ids,
   * independently of how many of their published content ids
   * `node.contentStore` still actually holds bytes for — a long-running
   * `startAutoSync()` past `maxContentStoreEntries` distinct published
   * entries can evict this node's own older headlines/articles from
   * `contentStore` while `publishedById` still "remembers" them as already
   * published and never re-publishes/re-caches them; each item now costs
   * two `contentStore` entries instead of one, so `maxContentStoreEntries`
   * needs to account for that — see `cli.ts`'s `--max-content-entries`).
   *
   * The response is validated defensively before anything is applied (same
   * posture as `packet.payload?.field` checks elsewhere in this codebase
   * for network-sourced data, `CLAUDE.md`) — `parseFeed()` returning
   * `undefined` (not RSS/Atom at all, oversized, or containing at least one
   * item missing a required field) rejects the whole sync and leaves
   * `publishedById`/`cachedHeadlines` completely untouched, rather than
   * partially applying whichever items happened to parse — and, since that
   * check runs before either tier of any item is published, a superseded
   * sync never publishes anything at all, not even article bodies.
   *
   * If a newer `syncNews()` call has already started (and possibly already
   * committed) by the time this one's response arrives, this call's result
   * is discarded — see `syncGeneration`.
   */
  async syncNews(): Promise<NewsHeadline[]> {
    const generation = ++this.syncGeneration;
    const xml = await fetchTextBounded(this.feedUrl, MAX_FEED_BYTES);
    const parsed = parseFeed(xml);
    if (!parsed) {
      throw new Error("news feed returned malformed or unrecognized RSS/Atom XML");
    }

    if (generation !== this.syncGeneration) {
      // Superseded by a newer syncNews() call started while this fetch was in flight — that
      // newer call is authoritative, so this stale response reports nothing new. Checked before
      // any publishContent() call (either tier), so a superseded sync never writes anything.
      return [];
    }

    const headlines: NewsHeadline[] = [];
    const changed: NewsHeadline[] = [];
    for (const item of parsed.items) {
      // Unconditional, every tick, for every item — publishedById's dedup check below only applies
      // to the headline tier, not this one: an unchanged article is re-signed and re-published just
      // as often as before this two-tier split (only the headline used to pay this cost; now both
      // tiers do). Not a correctness issue — publishContent() is idempotent over the same bytes,
      // content-addressing means no unbounded growth — but it doubles the signing/serialization work
      // this loop does on a hot periodic path (startAutoSync()) whenever most items are unchanged.
      const article: NewsArticleBody = { summary: item.summary };
      const articleMetadata = this.node.publishContent(`${item.title} (articolo)`, "application/json", Buffer.from(JSON.stringify(article), "utf8"));

      const headline: NewsHeadline = {
        id: item.id,
        title: item.title,
        url: item.link,
        publishedAt: item.publishedAt,
        source: parsed.source,
        category: item.category,
        language: parsed.language,
        updatedAt: item.updatedAt,
        articleContentId: articleMetadata.contentId,
      };
      const headlineMetadata = this.node.publishContent(headline.title, "application/json", Buffer.from(JSON.stringify(headline), "utf8"));
      headlines.push(headline);
      if (this.publishedById.get(headline.id) !== headlineMetadata.contentId) {
        this.publishedById.set(headline.id, headlineMetadata.contentId);
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
