import type { NomadNode } from "../../node/src/node.js";
import { BoundedFifoMap } from "../../node/src/bounded-map.js";
import { Priority } from "../../node/src/packet.js";
import { computeContentId } from "../../node/src/content.js";
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

/** A generated AI digest of the currently cached headlines (`generateDigest()`) — "digest generati da un'IA locale" from the original proposal (`docs/next-steps.md` Opzione I, pezzo 3). There is only ever one — the latest — never a history of past digests, same "just the current snapshot" shape `cachedHeadlines` itself has. */
export interface NewsDigest {
  text: string;
  /** Content id of `text`, published via `publishContent()` (`text/plain`) so the digest is independently discoverable/retrievable through the mesh, exactly like a headline or article body — the proposal's "content://news/digest/latest" framing, addressed here by content id rather than a stable path (see the architecture note in `docs/next-steps.md`). */
  contentId: string;
  generatedAt: number;
}

/** Same bound `RemoteCatalog`/`PeerDirectory` default to (`node/src/catalog.ts`) — `publishedById` is the one piece of this gateway's own state a hostile/misbehaving `--news-url` backend could otherwise grow forever by rotating headline ids on every `startAutoSync()` tick (`docs/security.md`). */
const MAX_TRACKED_HEADLINES = 4096;

/** Caps how many cached headlines feed into the AI digest prompt (`generateDigest()`) — keeps the prompt, and thus the service://ai request/response round trip (possibly multi-hop, spec §35-36, subject to the same per-packet size ceiling every packet is — see bug #9 in `docs/security.md`), bounded regardless of how many headlines a feed carries. */
const MAX_DIGEST_HEADLINES = 20;

/** Caps a single headline title's contribution to the digest prompt (`sanitizeTitleForPrompt()`) — `MAX_DIGEST_HEADLINES` alone only bounds the *count* of titles, not their length, so an otherwise-valid feed (`rss-feed.ts` has no per-title length cap of its own) could still make each of the 20 admitted titles enormous. */
const MAX_DIGEST_TITLE_CHARS = 200;

/** Caps how many EMERGENCY-priority `CONTENT_ANNOUNCE` floods a single `syncNews()` call can originate — see the comment at its own use site in `syncNews()` for why this is needed (rate-limit.ts only gates *received* packets, never ones this node originates itself). */
const MAX_EMERGENCY_ANNOUNCES_PER_SYNC = 5;

/**
 * Prepares a single (untrusted, feed-sourced) headline title for inclusion
 * in the digest prompt's bullet list: collapses any newline/carriage-return
 * into a space so a title can never break out of its own `- ` bullet line
 * and inject what looks like a second, attacker-controlled line into the
 * prompt `service://ai` receives (found by review — a title containing a
 * literal `\n` could otherwise impersonate a fresh instruction once joined
 * with real newlines), then truncates to `MAX_DIGEST_TITLE_CHARS`. This is
 * a structural mitigation, not a general defense against prompt injection
 * (out of scope for a small local/mocked digest feature) — it only
 * guarantees a title stays a single, bounded bullet line.
 */
function sanitizeTitleForPrompt(title: string): string {
  const singleLine = title.replace(/[\r\n]+/g, " ");
  return singleLine.length > MAX_DIGEST_TITLE_CHARS ? `${singleLine.slice(0, MAX_DIGEST_TITLE_CHARS)}…` : singleLine;
}

/** Builds the `service://ai` prompt for `generateDigest()` from a (already count-capped) list of headlines — sanitized titles only, never the article body, keeping the prompt itself small and mirroring `NewsHeadline`'s own "lean" framing. */
function buildDigestPrompt(headlines: readonly NewsHeadline[]): string {
  const bulletList = headlines.map((h) => `- ${sanitizeTitleForPrompt(h.title)}`).join("\n");
  return `Riassumi in breve, in italiano, le seguenti notizie:\n${bulletList}`;
}

/**
 * Default `isEmergencyHeadline` classifier (`NewsGatewayOptions`) — flags a
 * headline as an emergency bulletin (spec's "P0", `docs/next-steps.md`
 * Opzione I) when its RSS/Atom `<category>` contains one of these keywords,
 * case-insensitively. A guess, not a standard: no feed format defines what
 * "emergency" means, so this is a reasonable default for the rifugio
 * alpino/Protezione Civile use case the proposal itself names as the most
 * concrete one — an operator with a feed that tags emergencies differently
 * (or not by category at all) is expected to override it via
 * `NewsGatewayOptions.isEmergencyHeadline`, not fight this default.
 */
const DEFAULT_EMERGENCY_CATEGORY_KEYWORDS = ["emergenza", "allerta", "allarme", "protezione civile"];

function defaultIsEmergencyHeadline(headline: NewsHeadline): boolean {
  if (!headline.category) return false;
  const category = headline.category.toLowerCase();
  return DEFAULT_EMERGENCY_CATEGORY_KEYWORDS.some((keyword) => category.includes(keyword));
}

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
export interface NewsGatewayOptions {
  /**
   * Classifies a headline as an emergency bulletin (spec's "P0",
   * `docs/next-steps.md` Opzione I `service://emergency-news`) — such a
   * headline is published with `{ announce: true, priority: Priority.EMERGENCY }`
   * (`syncNews()`), so it reaches already-connected peers immediately via
   * `CONTENT_ANNOUNCE` instead of waiting for a pull query or catalog sync,
   * and is what `service://emergency-news` (`registerEmergencyNewsService()`)
   * answers with. Defaults to `defaultIsEmergencyHeadline` (a category
   * keyword match) — override when a feed doesn't use `<category>` for this
   * or uses different wording.
   */
  isEmergencyHeadline?: (headline: NewsHeadline) => boolean;
}

export class NewsGateway {
  /**
   * headline id -> contentId last published for it, so a re-sync that
   * returns an unchanged headline doesn't re-report it — same dedup shape
   * as `KiwixGateway.publishedByPath`, but bounded (see
   * `MAX_TRACKED_HEADLINES`) since this one gateway can now refresh itself
   * unattended via `startAutoSync()`.
   *
   * **Accepted limitation, found by review**: purely in-memory, like every
   * other piece of this instance's own state — a process restart empties
   * it, so the first `syncNews()` after a restart treats every headline
   * still in the feed as "changed", including one still tagged as an
   * emergency that every peer already learned about before the restart —
   * `syncNews()` re-announces it once at `Priority.EMERGENCY` as if it
   * were new. `MAX_EMERGENCY_ANNOUNCES_PER_SYNC` bounds how bad a single
   * restart (or a crash loop) can make this, but doesn't eliminate it — a
   * real fix would need `publishedById` (or at least the emergency subset
   * of it) persisted across restarts, which no other state in this class
   * has either; not attempted here.
   */
  private readonly publishedById = new BoundedFifoMap<string, string>({ maxSize: MAX_TRACKED_HEADLINES });
  /** Snapshot from the most recent successful `syncNews()` — what `service://news` actually answers with, never a live call per invocation. */
  private cachedHeadlines: NewsHeadline[] = [];
  /** Snapshot from the most recent successful `generateDigest()` — undefined until the first call succeeds. */
  private cachedDigest: NewsDigest | undefined;
  private syncTimer: NodeJS.Timeout | undefined;
  private digestTimer: NodeJS.Timeout | undefined;
  /**
   * Bumped at the start of every `syncNews()` call, so a call that started
   * earlier but resolves later (a slow request overtaken by a faster one
   * `startAutoSync()` kicked off on a subsequent tick) can tell it's been
   * superseded and must not clobber state a newer call already committed —
   * the network doesn't guarantee responses arrive in request order.
   */
  private syncGeneration = 0;
  /** Same purpose as `syncGeneration`, for `generateDigest()`/`startDigestAutoRefresh()` — a `service://ai` call can be multi-hop (spec §35-36) and is not guaranteed to resolve in the order it was sent, so a slow tick's stale response must not clobber a fresher digest a later tick already committed. */
  private digestGeneration = 0;
  private readonly isEmergencyHeadline: (headline: NewsHeadline) => boolean;

  constructor(
    private readonly node: NomadNode,
    /** URL of an RSS or Atom feed, e.g. `http://127.0.0.1:PORT/feed.xml`. No default/fake fallback — see the class doc comment. */
    private readonly feedUrl: string,
    options: NewsGatewayOptions = {},
  ) {
    this.isEmergencyHeadline = options.isEmergencyHeadline ?? defaultIsEmergencyHeadline;
  }

  /** The most recent successful sync's headlines — what `service://news` currently answers with. Empty before the first successful `syncNews()`. */
  get headlines(): readonly NewsHeadline[] {
    return this.cachedHeadlines;
  }

  /** The subset of `headlines` this instance's `isEmergencyHeadline` classifier flags as high-priority (spec's "P0") — what `service://emergency-news` answers with. Computed on read, not separately cached — `cachedHeadlines` is already the single source of truth, and the classifier is a pure function of a headline's own fields. */
  get emergencyHeadlines(): readonly NewsHeadline[] {
    return this.cachedHeadlines.filter((headline) => this.isEmergencyHeadline(headline));
  }

  /** The most recently generated AI digest (`generateDigest()`) — undefined until the first call succeeds. */
  get digest(): NewsDigest | undefined {
    return this.cachedDigest;
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
   *
   * A headline this instance's `isEmergencyHeadline` classifier flags —
   * and only when it's new/changed this sync, never a repeat of one
   * already known — is published with `{ announce: true, priority:
   * Priority.EMERGENCY }` (spec's "P0", `service://emergency-news`), so it
   * reaches already-connected peers immediately via `CONTENT_ANNOUNCE`
   * instead of waiting for a pull query or catalog sync. Only the headline
   * tier is announced this way — the article body still publishes
   * normally, fetched on demand once a reader actually wants the full
   * text, same as any other headline.
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
    // Caps how many EMERGENCY-priority CONTENT_ANNOUNCE floods this single syncNews() call can
    // originate (found by review) — rate-limit.ts only gates packets *received* from a connected
    // peer, never ones this node originates itself via floodExcept(), so without this cap a
    // hostile/misbehaving --news-url backend (already a documented threat elsewhere in this class,
    // e.g. publishedById's own bound) could tag every item in a feed of up to MAX_ITEMS_PER_FEED
    // (rss-feed.ts) as an emergency and/or rotate ids to make each sync look "all new", making this
    // node itself flood the mesh at its highest priority completely unthrottled. A legitimate feed
    // rarely has more than a handful of genuinely new P0 bulletins in one sync window — this bounds
    // the worst case, not the routine one. Only the proactive broadcast is capped: an emergency
    // headline beyond the cap is still published normally and still counted by `emergencyHeadlines`
    // (service://emergency-news still lists it) — a node just has to discover it the pull way.
    let emergencyAnnouncesThisSync = 0;
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
      const headlineBytes = Buffer.from(JSON.stringify(headline), "utf8");
      // Computed before publishing so isChanged is known ahead of the announce decision below —
      // an unchanged headline is still republished every tick (see the comment above this loop),
      // but must never be re-announced: CONTENT_ANNOUNCE at EMERGENCY priority is meant for "this
      // just happened", not a repeat broadcast of a bulletin every node already has. This does mean
      // computeContentId() runs twice per item every tick (once here, once again inside
      // publishContent() over the identical bytes) — accepted duplicate hashing (noted by review),
      // negligible cost for a small JSON blob; avoiding it would mean publishContent() accepting a
      // precomputed id or deciding announce options after the fact, out of scope here.
      const headlineContentId = computeContentId(headlineBytes);
      const isChanged = this.publishedById.get(headline.id) !== headlineContentId;
      const isEmergency = isChanged && this.isEmergencyHeadline(headline) && emergencyAnnouncesThisSync < MAX_EMERGENCY_ANNOUNCES_PER_SYNC;
      if (isEmergency) emergencyAnnouncesThisSync++;
      const headlineMetadata = this.node.publishContent(
        headline.title,
        "application/json",
        headlineBytes,
        isEmergency ? { announce: true, priority: Priority.EMERGENCY } : undefined,
      );
      // publishContent() (node.ts) computes its own contentId as computeContentId(data) over the
      // exact buffer passed in — headlineContentId above used the same function on the same
      // headlineBytes, so these are provably equal today, not just "by convention". This assertion
      // exists so a future change to how publishContent() derives its contentId (found by review:
      // nothing today ties the two computations together) fails loudly here instead of silently
      // leaving isChanged/isEmergency decided against a stale hash shape.
      if (headlineMetadata.contentId !== headlineContentId) {
        throw new Error("internal error: headline content id computed ahead of publishContent() diverged from the id it actually assigned");
      }
      headlines.push(headline);
      if (isChanged) {
        this.publishedById.set(headline.id, headlineMetadata.contentId);
        changed.push(headline);
      }
    }
    this.cachedHeadlines = headlines;
    return changed;
  }

  /**
   * Composes `NewsGateway` with the AI service already registered elsewhere
   * in the mesh (spec §37, `service://ai` — `AiGateway`/`FakeOllamaServer`
   * in this codebase, a real Ollama behind Project NOMAD in production) to
   * produce a short digest of the currently cached headlines — "digest
   * generati da un'IA locale" from the original proposal
   * (`docs/next-steps.md` Opzione I, pezzo 3). Deliberately loose coupling:
   * this method never imports `AiGateway` or knows which node actually
   * answers — it calls `service://ai` the same way any other caller in this
   * codebase does (`node.callService()`), the same "a weak node calls
   * service://ai without knowing who answers" pattern `ai-gateway.ts`'s own
   * doc comment describes; a node that also has `AiGateway` registered
   * locally (as `cli.ts`'s demo does) answers its own call without a
   * network round trip at all (`callService()`'s local-provider shortcut).
   *
   * Returns `undefined` (never throws) when there are no cached headlines
   * to summarize — nothing to compose a meaningful prompt from, and
   * generating one anyway would spend a live AI call on an empty result no
   * caller wants. Otherwise propagates whatever error `service://ai` itself
   * raises (no provider registered, backend unreachable, timeout) — this
   * method makes no attempt to hide that failure or fall back to a stale
   * digest, mirroring `syncNews()`'s own "let the caller decide" posture; a
   * caller wiring this into a periodic timer (`startDigestAutoRefresh()`
   * below, same shape as `startAutoSync()`) is expected to catch it the
   * same way `onError` already works for news sync failures.
   *
   * If a newer `generateDigest()` call has already started (and possibly
   * already committed) by the time this one's response arrives, this
   * call's result is discarded rather than clobbering the fresher one —
   * see `digestGeneration`, same protection `syncNews()` already has via
   * `syncGeneration` for the same "responses don't arrive in request
   * order" reason.
   */
  async generateDigest(options: { timeoutMs?: number } = {}): Promise<NewsDigest | undefined> {
    if (this.cachedHeadlines.length === 0) return undefined;
    const generation = ++this.digestGeneration;

    const prompt = buildDigestPrompt(this.cachedHeadlines.slice(0, MAX_DIGEST_HEADLINES));
    const result = await this.node.callService("service://ai", { prompt }, options);
    // callService() resolves with whatever the (untrusted, possibly remote) provider's
    // SERVICE_RESPONSE declared as `result` (node.ts's handleServiceResponse), never validated —
    // same defensive posture CLAUDE.md requires for any network-sourced value.
    const response = result && typeof result === "object" ? (result as { response?: unknown }).response : undefined;
    if (typeof response !== "string" || response.length === 0) {
      throw new Error("service://ai returned a malformed or empty response while generating the news digest");
    }

    if (generation !== this.digestGeneration) return undefined; // superseded — see digestGeneration

    const metadata = this.node.publishContent("Digest notizie", "text/plain", Buffer.from(response, "utf8"));
    const digest: NewsDigest = { text: response, contentId: metadata.contentId, generatedAt: Date.now() };
    this.cachedDigest = digest;
    return digest;
  }

  /**
   * Starts calling `generateDigest()` on its own timer, independent of
   * `startAutoSync()`'s feed-poll interval — regenerating a digest is a
   * live AI call (spec's "never caches" posture already applied to
   * `service://ai` itself), so an operator may reasonably want it refreshed
   * less often than the feed is polled. Same "tolerate a flaky
   * upstream, keep retrying next interval" posture as `startAutoSync()`.
   * `options.timeoutMs` is forwarded to every `generateDigest()` call this
   * timer makes (e.g. bounding how long a single tick waits on
   * `discoverService()` when no `service://ai` provider is reachable at
   * all, distinct from the interval between ticks). Calling this again
   * replaces any previously running timer rather than stacking a second one.
   */
  startDigestAutoRefresh(intervalMs: number, onError?: (err: unknown) => void, options: { timeoutMs?: number } = {}): void {
    this.stopDigestAutoRefresh();
    this.digestTimer = setInterval(() => {
      this.generateDigest(options).catch((err: unknown) => onError?.(err));
    }, intervalMs);
  }

  /** Stops the timer started by `startDigestAutoRefresh()`, if one is running. Safe to call even if none is. */
  stopDigestAutoRefresh(): void {
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.digestTimer = undefined;
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
   * hasn't learned anything yet", not a failure. `digest`/`digestContentId`
   * are omitted (not `null`/empty string) until `generateDigest()` has
   * succeeded at least once — same "absent, not a placeholder" convention.
   */
  registerNewsService(): void {
    this.node.registerService("service://news", "1.0.0", ["headlines"], async () => {
      return { headlines: this.cachedHeadlines, digest: this.cachedDigest?.text, digestContentId: this.cachedDigest?.contentId };
    });
  }

  /**
   * Registers `service://emergency-news` (spec's "P0", `docs/next-steps.md`
   * Opzione I) — a sub-case of `service://news` that answers with only
   * `emergencyHeadlines`, the subset of the cache `isEmergencyHeadline`
   * flags. Reuses the same "always instant, never a live call" posture as
   * `registerNewsService()` — a separate service rather than a field on
   * `service://news`'s own response (which already carries `digest`) so a
   * caller who only cares about emergencies (e.g. a dashboard widget) can
   * discover/call this one specifically, without pulling the full headline
   * list every time. `{ headlines: [] }` before any sync has completed, or
   * simply when nothing currently in cache qualifies as an emergency —
   * both an honest "nothing to report", not an error.
   */
  registerEmergencyNewsService(): void {
    this.node.registerService("service://emergency-news", "1.0.0", ["headlines"], async () => {
      return { headlines: this.emergencyHeadlines };
    });
  }
}
