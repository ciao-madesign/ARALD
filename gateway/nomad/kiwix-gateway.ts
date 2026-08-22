import type { NomadNode } from "../../node/src/node.js";

const DEFAULT_SYNC_CONCURRENCY = 8;

/** Runs `fn` over `items` with at most `limit` calls in flight at once — bounds how many simultaneous requests a large NOMAD catalog sync opens against NOMAD itself, rather than firing all of them at once. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (let i = nextIndex++; i < items.length; i = nextIndex++) {
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Translates Nomad-Net's abstract APIs (spec §37 — `GET content://...`,
 * `CALL service://...`) into HTTP calls against a Project NOMAD instance's
 * Kiwix service (`docs/next-steps.md` Option B) — a real Docker+NOMAD
 * instance in production, `FakeNomadServer` in this slice's tests/demo.
 * Nomad-Net itself never needs to know the difference: this gateway is
 * just another `NomadNode`, using the exact same public API
 * (`publishContent`, `registerService`) any other node would.
 *
 * Two distinct translation modes, matching the two abstract APIs spec §37
 * names:
 * - `syncCatalog()` (`content://...`): fetches NOMAD's article catalog and
 *   publishes each one via `publishContent()`, making it discoverable and
 *   retrievable through the *existing* CONTENT_QUERY/FOUND/REQUEST/CHUNK/
 *   COMPLETE cycle with zero changes to node.ts — genuinely fetched from
 *   NOMAD, not hand-authored content, but served from the cache
 *   `publishContent()` already builds from that point on (the same
 *   fetch-once-serve-many shape any real caching gateway has). Content
 *   addressing (spec §24: a content id is the hash of its bytes) means the
 *   gateway *must* hold the bytes before it can be discoverable by id at
 *   all — there is no way to advertise "this exists" without having
 *   fetched it first, unlike a path-based API.
 * - `registerSearchService()` (`CALL service://...`): registers a service
 *   whose handler proxies a live HTTP call to NOMAD on *every* invocation —
 *   no caching, no snapshot, a genuine per-request translation. Services
 *   aren't content-addressed, so this mode has none of `syncCatalog()`'s
 *   fetch-before-advertise constraint, and is the more faithful
 *   demonstration of "translate this request to NOMAD's local API" spec §37
 *   actually describes.
 */
export class KiwixGateway {
  /** contentId last published for each path, so a re-sync of unchanged content doesn't re-report it in `syncCatalog()`'s return value. Does *not* mean unchanged content is skipped over the wire — see `syncCatalog()`'s doc comment for why it still has to be fetched. */
  private readonly publishedByPath = new Map<string, string>();

  constructor(
    private readonly node: NomadNode,
    /** Base URL of the NOMAD/Kiwix HTTP API, e.g. `http://127.0.0.1:PORT` (a `FakeNomadServer` in tests, a real Project NOMAD instance in production). */
    private readonly baseUrl: string,
  ) {}

  /**
   * Fetches NOMAD's current article list and publishes each one locally
   * (bounded concurrency — `DEFAULT_SYNC_CONCURRENCY` fetches in flight at
   * once, not all of them at once against a real NOMAD instance). Callable
   * more than once to pick up articles added since the last sync — there
   * is no automatic polling/interval here (out of scope for this slice; a
   * real deployment would call this on a timer or in response to a
   * NOMAD-side webhook, neither of which this mocked gateway has anything
   * to hook into). Returns only the entries that are new or whose content
   * actually changed since the last sync from this same `KiwixGateway`
   * instance — not a delta computed for free, since content addressing
   * (spec §24: a content id is the hash of its bytes) means there is no
   * way to know whether an article changed *without* fetching its full
   * body first, unlike a path-based API with something like an ETag.
   *
   * Known, accepted limitation: an article that changes at NOMAD gets
   * published under a brand new content id — the *previous* content id's
   * bytes are not explicitly deleted when that happens, since content in
   * this prototype is otherwise immutable by construction and nothing
   * elsewhere ever deletes a published entry either. A gateway that syncs
   * on a timer against a catalog whose articles are edited over time will
   * keep accumulating historical versions of every edited article — but
   * `node.contentStore` is bounded (`NomadNodeOptions.maxContentStoreEntries`,
   * spec §57 resource limits; this gateway's own `NomadNode` sizes it via
   * `cli.ts`'s `--max-content-entries`, generously above the default sized
   * for a generic mesh node's opportunistic cache), so it's memory-safe
   * rather than truly unbounded. This node's own published entries are
   * preferred for retention over anything merely relay-cached from other
   * peers (`node.ts`'s `OWN_CONTENT_TRUST_RANK`), but **not** over each
   * other — once the store is full, its own oldest published entries are
   * evicted first-in-first-out, historical and current alike. A catalog
   * (including accumulated historical versions) larger than
   * `maxContentStoreEntries` will therefore start losing access to
   * still-current articles, not just superseded ones — an operator syncing
   * a catalog at that scale needs to size that option (or add a `ttlMs` on
   * gateway-published content) accordingly, rather than relying on this
   * prototype's cache to hold everything forever.
   */
  async syncCatalog(): Promise<Array<{ path: string; contentId: string }>> {
    const listRes = await fetch(`${this.baseUrl}/api/articles`);
    if (!listRes.ok) {
      throw new Error(`NOMAD gateway: failed to list articles (HTTP ${listRes.status})`);
    }
    const entries = (await listRes.json()) as Array<{ path: string; title: string; mimeType: string }>;

    const results = await mapWithConcurrency(entries, DEFAULT_SYNC_CONCURRENCY, async (entry) => {
      const articleRes = await fetch(`${this.baseUrl}/api/articles/${encodeURIComponent(entry.path)}`);
      if (!articleRes.ok) {
        // NOMAD "non è dichiarato stabile" (spec §4) — an article listed a moment ago disappearing
        // by the time it's actually fetched is exactly the kind of thing this prototype must
        // tolerate rather than let take the whole sync down with it.
        return undefined;
      }
      const article = (await articleRes.json()) as { path: string; title: string; mimeType: string; body: string };
      const metadata = this.node.publishContent(article.title, article.mimeType, Buffer.from(article.body, "utf8"));
      return { path: article.path, contentId: metadata.contentId };
    });

    const published: Array<{ path: string; contentId: string }> = [];
    for (const result of results) {
      if (!result) continue;
      if (this.publishedByPath.get(result.path) === result.contentId) continue; // unchanged since this instance's last sync
      this.publishedByPath.set(result.path, result.contentId);
      published.push(result);
    }
    return published;
  }

  /**
   * Registers `service://kiwix-search` (spec §37 `CALL service://...`) —
   * every call proxies live to NOMAD's own search endpoint, translating
   * the result back into Nomad-Net's shape. Never caches; a call made
   * while NOMAD happens to be unreachable rejects with a clear error
   * (surfaced to the original caller as a normal SERVICE_RESPONSE `error`,
   * `node.ts`'s `handleServiceRequest`) rather than serving something stale
   * silently.
   */
  registerSearchService(): void {
    this.node.registerService("service://kiwix-search", "1.0.0", ["search"], async (payload) => {
      const { q } = payload as { q?: unknown };
      if (typeof q !== "string") throw new Error("service://kiwix-search requires a string 'q' field");

      const res = await fetch(`${this.baseUrl}/api/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`NOMAD search failed (HTTP ${res.status})`);
      return { results: (await res.json()) as Array<{ path: string; title: string }> };
    });
  }
}
