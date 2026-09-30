import type { NomadNode } from "../../node/src/node.js";

/**
 * Translates ARALD's abstract APIs (spec §37 — `GET content://...`,
 * `CALL service://...`) into HTTP calls against a **real, bare `kiwix-serve`
 * instance** — not Project NOMAD's own (never verified, never seen) API
 * surface. Rewritten 30 September 2026 while investigating
 * `docs/next-steps.md`'s "Ipotesi di indipendenza da Project NOMAD": the
 * previous version of this class called invented endpoints (`/api/articles`,
 * `/api/search?q=`) that `FakeNomadServer` modeled but that neither real
 * Kiwix nor (as far as anyone has verified) real Project NOMAD actually
 * expose — `FakeNomadServer`'s own doc comment said as much explicitly
 * ("Not a Kiwix API clone"). This version targets kiwix-serve's real,
 * documented HTTP API instead, verified against `kiwix/kiwix-tools`'
 * `docs/kiwix-serve.rst` (real web access available this session) — see
 * `docs/next-steps.md` for exactly what was confirmed and what wasn't.
 *
 * **Architectural change forced by what's real, not a stylistic rewrite**:
 * `kiwix-serve` has **no endpoint that lists/enumerates every article in a
 * ZIM file** — confirmed against the same doc. The previous `syncCatalog()`
 * (fetch every article up front, publish each via `publishContent()`) has
 * therefore been **removed**, not adapted: there is nothing for it to call.
 * The real, portable building block is `publishArticle(path)`, which
 * fetches and publishes **one already-known path** — an operator, or code
 * elsewhere that has learned a path some other way (e.g. a
 * `service://kiwix-search` result, or an operator-curated list), calls it
 * per article. Bulk pre-publishing an entire book's worth of content is not
 * possible against real Kiwix without either (a) an operator supplying the
 * full path list from outside this gateway, or (b) a different content
 * source entirely — a genuine open design question, not resolved here.
 */
export class KiwixGateway {
  constructor(
    private readonly node: NomadNode,
    /** Base URL of a real `kiwix-serve` instance, e.g. `http://127.0.0.1:PORT` (`FakeKiwixServer` in tests/demo). */
    private readonly baseUrl: string,
    /**
     * The ZIM file's book name as `kiwix-serve` knows it (the `ZIMNAME` in
     * `/content/ZIMNAME/...`/`/suggest?content=ZIMNAME`) — `kiwix-serve` can
     * serve several books at once, so this gateway must be told which one
     * it speaks for. No default: guessing wrong silently 404s every call.
     */
    private readonly book: string,
  ) {}

  /**
   * Fetches one article by its in-ZIM path (`kiwix-serve`'s real
   * `/content/{book}/{path}`, confirmed against `kiwix-tools`' own API
   * reference) and publishes it via `publishContent()` — the same
   * content-addressed cache every other `content://` source already uses,
   * zero changes to `node.ts`. `Content-Type` is read from the real
   * response header rather than assumed, since a ZIM entry can be
   * HTML, an image, or anything else the archive was built with.
   *
   * Unlike the old `syncCatalog()`, this is neither automatic nor bulk —
   * see this class's doc comment for why kiwix-serve makes that
   * impossible to offer honestly. Safe to call repeatedly for the same
   * path (e.g. from a periodic refresh an operator sets up): content
   * addressing means an unchanged article republishes under the same
   * `contentId` and is a cheap no-op downstream.
   */
  async publishArticle(path: string): Promise<{ path: string; contentId: string }> {
    // Each segment is percent-encoded independently, `/` separators kept literal — a raw
    // interpolation let a path containing `?`/`#` get silently reinterpreted as a query string or
    // fragment by URL parsing (found by review), truncating the request to the wrong resource
    // while this method still reported success for the caller's original, untruncated `path`.
    const encodedPath = encodePathSegments(path);
    const res = await fetch(`${this.baseUrl}/content/${encodePathSegments(this.book)}/${encodedPath}`);
    if (!res.ok) {
      throw new Error(`Kiwix: failed to fetch article '${path}' (HTTP ${res.status})`);
    }
    const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
    const body = Buffer.from(await res.arrayBuffer());
    const title = path.split("/").pop() ?? path;
    const metadata = this.node.publishContent(title, mimeType, body);
    return { path, contentId: metadata.contentId };
  }

  /**
   * Registers `service://kiwix-search` (spec §37 `CALL service://...`) —
   * every call proxies live to kiwix-serve's real `/suggest` endpoint
   * (`?content={book}&term={q}`, confirmed path/params against
   * `kiwix-tools`' own docs), translating the result back into ARALD's
   * shape. Never caches, same reasoning as before: a stale suggestion list
   * is worse than a slow real one.
   *
   * **Response field names are not fully verified.** `kiwix-tools`' own
   * documentation describes the response only as "JSON suggestions", and
   * community reports (GitHub issues on `kiwix/libkiwix`) mention a
   * `label`/`value`-shaped item without a captured concrete example this
   * session could fetch — real web access was available, but no exact
   * sample JSON was found. Parsed defensively below, trying every
   * plausible key name a real response might use; **must be re-verified
   * against a live `kiwix-serve` instance before this is trusted**, per
   * this project's standing rule against presenting unverified specifics
   * as confirmed (same posture already taken for `CHIP_BUFFER_SIZE` in the
   * SX1262 driver).
   */
  registerSearchService(): void {
    this.node.registerService("service://kiwix-search", "1.0.0", ["search"], async (payload) => {
      const { q } = payload as { q?: unknown };
      if (typeof q !== "string") throw new Error("service://kiwix-search requires a string 'q' field");

      const res = await fetch(`${this.baseUrl}/suggest?content=${encodeURIComponent(this.book)}&term=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`Kiwix suggest failed (HTTP ${res.status})`);
      const raw = (await res.json()) as unknown;
      if (!Array.isArray(raw)) throw new Error("Kiwix suggest returned a malformed response");

      // Skips (rather than throws on) any entry that isn't a plain object — a single malformed
      // suggestion must not lose every other legitimate one in the same response, especially given
      // this endpoint's response shape is only best-effort modeled (see this method's doc comment).
      const results = raw
        .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
        .map((e) => ({
          title: pickString(e, ["label", "title", "value"]) ?? "",
          path: pickString(e, ["path", "value", "kind"]) ?? "",
        }));
      return { results };
    });
  }
}

/** Percent-encodes each `/`-separated segment independently, keeping `/` itself literal — encoding the whole string as one component would turn a legitimate nested ZIM path like `wiki/italia` into a single literal segment `wiki%2Fitalia`, which kiwix-serve would not resolve the same way. */
function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** First string-valued field found among `keys`, in order — see `registerSearchService()`'s doc comment for why this defensive lookup exists instead of a single known field name. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}
