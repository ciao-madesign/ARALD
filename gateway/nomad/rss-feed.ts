/**
 * Minimal RSS 2.0 / Atom feed parser, written from scratch — no XML/RSS
 * library dependency, same "no unnecessary external dependency" convention
 * as `node/src/qrcode.ts`. Deliberately not a general-purpose XML parser:
 * it's a defensive tag/attribute scanner over the specific, small subset of
 * elements RSS 2.0 and Atom actually use for a headline feed. Fed directly
 * by an operator-configured `--news-url` backend (`NewsGateway.syncNews()`)
 * that could be slow, malformed, or actively hostile (spec §57) — every
 * accessor here treats the input as untrusted text, never assumes
 * well-formed XML, and validation is atomic per feed: one item missing a
 * required field invalidates the whole feed rather than silently dropping
 * just that item, mirroring the all-or-nothing contract `NewsGateway`
 * already had for its previous JSON-array validation (voce #27).
 *
 * Every tag/attribute scan in this file runs through `execOutsideCdata()`,
 * which never matches inside a `<![CDATA[...]]>` section — otherwise a
 * `<item>`/`<title>`-shaped substring *inside* CDATA content (e.g. an
 * article discussing RSS/XML syntax) could be mistaken for a real tag
 * boundary elsewhere in the document (found by review, empirically
 * confirmed). `execOutsideCdata()` jumps straight past a whole rejected
 * CDATA span in one step (`findSpanContaining()`, binary search) rather
 * than re-testing every position inside it one at a time — a feed with
 * many small CDATA sections, each containing a tag-shaped substring,
 * previously made parsing algorithmically quadratic (confirmed: a crafted
 * ~1.8MB feed, still under `MAX_FEED_BYTES`, took over 7 seconds to parse
 * with the naive per-position check, vs. milliseconds for a same-size
 * feed without that pattern, and vs. milliseconds again after this fix) —
 * a real CPU-exhaustion DoS given `--news-url` is explicitly treated as a
 * potentially hostile, repeatedly-refetched backend (spec §57).
 */

/** One entry from a parsed feed — the RSS/Atom-native shape `NewsGateway.syncNews()` maps onto `NewsHeadline`. */
export interface FeedItem {
  /** RSS `<guid>` (falling back to `<link>`) or Atom `<id>` (falling back to the entry's chosen `<link href>`) — whichever is present, used as the stable dedup key. */
  id: string;
  title: string;
  /** RSS `<description>` or Atom `<summary>`/`<content>` — empty string if the feed omits it for this item (allowed; unlike title/link/date, real feeds routinely leave this out). */
  summary: string;
  link: string;
  /** Normalized to ISO 8601 from the feed's native date format (RFC 822 for RSS `<pubDate>`, already ISO 8601 for Atom `<published>`/`<updated>`) — never the feed's raw string verbatim, unlike the JSON mini-API this replaces. */
  publishedAt: string;
  /** Atom `<updated>` only, when distinct from `<published>` — RSS 2.0 has no equivalent, so always undefined for RSS items. */
  updatedAt?: string;
  /** First `<category>` element/attribute, if the feed provides one. */
  category?: string;
}

export interface ParsedFeed {
  /** Feed-level `<title>` (RSS `<channel>`/Atom `<feed>`) — the publication's own name, e.g. "Wikinotizie". Empty string if the feed omits it. Scoped to the channel/feed's own preamble, never an item's/entry's own `<title>` (see `feedLevelSection()`). */
  source: string;
  /** RSS `<language>` or Atom's `xml:lang` attribute on the root `<feed>` element, if present. */
  language?: string;
  items: FeedItem[];
}

/**
 * Hard cap on feed document size this parser will even attempt to scan
 * (spec §57 resource limits) — checked here as a backstop against any
 * caller handing this function an oversized string directly, but the
 * primary defense against a hostile/misbehaving `--news-url` backend
 * returning an enormous body is `NewsGateway.syncNews()`'s own streaming
 * fetch, which never buffers past this many bytes in the first place —
 * exported so both share one source of truth for the limit.
 */
export const MAX_FEED_BYTES = 2_000_000;
/** Hard cap on items read from a single feed — real feeds are typically a few dozen entries; this bounds worst-case work/memory from an oversized-but-otherwise-valid feed without rejecting it outright. Well above what any single legitimate sync should ever contain, so it never collides with `NewsGateway`'s own separate, longer-horizon bound (`publishedById`'s `MAX_TRACKED_HEADLINES`, which protects total distinct headlines *across* many syncs over time, not the size of any one feed response). */
const MAX_ITEMS_PER_FEED = 2000;

/**
 * Parses `xml` as RSS 2.0 or Atom, whichever it looks like. Returns
 * `undefined` for anything this parser can't confidently make sense of —
 * not RSS or Atom at all, oversized, or containing at least one item/entry
 * missing a field required to identify or display it — rather than
 * guessing or returning a partial result, mirroring the "reject the whole
 * batch, not just the bad entry" contract `NewsGateway.syncNews()` already
 * applied to its previous JSON-array validation. Never throws — every
 * malformed shape it can't handle (including an out-of-range numeric
 * character reference, `decodeEntities()`) is turned into `undefined`
 * instead of propagating an exception to the caller.
 */
export function parseFeed(xml: string): ParsedFeed | undefined {
  if (typeof xml !== "string" || xml.length === 0 || Buffer.byteLength(xml, "utf8") > MAX_FEED_BYTES) return undefined;
  const channel = extractTagContent(xml, "channel");
  if (channel !== undefined) return parseRssChannel(channel);
  if (/<feed[\s>]/i.test(xml)) return parseAtomFeed(xml);
  return undefined;
}

/** The part of `xml` before its first `<itemTag>` (CDATA-aware), where RSS channel-level (or Atom feed-level) metadata like `<title>`/`<language>` actually lives, as opposed to inside any individual item/entry. Extracting `<title>` from the whole document unscoped would match the *first* `<title>` anywhere, including an item's own, once the channel/feed itself omits one — found by review. */
function feedLevelSection(xml: string, itemTag: string): string {
  const spans = findCdataSpans(xml);
  const match = execOutsideCdata(new RegExp(`<${itemTag}[\\s>]`, "gi"), xml, 0, spans);
  return match ? xml.slice(0, match.index) : xml;
}

function parseRssChannel(channel: string): ParsedFeed | undefined {
  const preamble = feedLevelSection(channel, "item");
  const sourceRaw = extractTagContent(preamble, "title");
  const languageRaw = extractTagContent(preamble, "language");
  const items: FeedItem[] = [];
  for (const block of matchAllTagBlocks(channel, "item").slice(0, MAX_ITEMS_PER_FEED)) {
    const item = parseRssItem(block);
    if (!item) return undefined; // one malformed item invalidates the whole feed — see class doc comment
    items.push(item);
  }
  return { source: sourceRaw !== undefined ? decodeText(sourceRaw) : "", language: languageRaw !== undefined ? decodeText(languageRaw) : undefined, items };
}

function parseRssItem(block: string): FeedItem | undefined {
  const title = decodeOrUndefined(extractTagContent(block, "title"));
  const link = decodeOrUndefined(extractTagContent(block, "link"));
  const guid = decodeOrUndefined(extractTagContent(block, "guid"));
  const description = extractTagContent(block, "description");
  const pubDate = decodeOrUndefined(extractTagContent(block, "pubDate"));
  const category = decodeOrUndefined(extractTagContent(block, "category"));

  const id = guid || link;
  if (!title || !id || !link) return undefined;
  const publishedAt = pubDate !== undefined ? toIso(pubDate) : undefined;
  if (!publishedAt) return undefined;

  return { id, title, summary: description !== undefined ? decodeText(description) : "", link, publishedAt, category };
}

function parseAtomFeed(xml: string): ParsedFeed | undefined {
  const preamble = feedLevelSection(xml, "entry");
  const rootTagMatch = preamble.match(/<feed\b[^>]*>/i);
  const langMatch = rootTagMatch?.[0].match(/\bxml:lang=["']([^"']*)["']/i);
  const sourceRaw = extractTagContent(preamble, "title");
  const items: FeedItem[] = [];
  for (const block of matchAllTagBlocks(xml, "entry").slice(0, MAX_ITEMS_PER_FEED)) {
    const item = parseAtomEntry(block);
    if (!item) return undefined; // one malformed entry invalidates the whole feed — see class doc comment
    items.push(item);
  }
  return { source: sourceRaw !== undefined ? decodeText(sourceRaw) : "", language: langMatch ? decodeEntities(langMatch[1]) : undefined, items };
}

function parseAtomEntry(block: string): FeedItem | undefined {
  const title = decodeOrUndefined(extractTagContent(block, "title"));
  const idRaw = decodeOrUndefined(extractTagContent(block, "id"));
  const link = pickAtomLink(block);
  const summary = extractTagContent(block, "summary") ?? extractTagContent(block, "content");
  const published = decodeOrUndefined(extractTagContent(block, "published"));
  const updated = decodeOrUndefined(extractTagContent(block, "updated"));
  const category = extractTagAttr(block, "category", "term") ?? decodeOrUndefined(extractTagContent(block, "category"));

  const id = idRaw || link;
  if (!title || !id || !link) return undefined;
  const publishedAt = toIso(published ?? updated ?? "");
  if (!publishedAt) return undefined;

  return {
    id,
    title,
    summary: summary !== undefined ? decodeText(summary) : "",
    link,
    publishedAt,
    updatedAt: updated !== undefined ? toIso(updated) : undefined,
    category,
  };
}

/**
 * An Atom entry may list several `<link>` elements for different relations
 * (`rel="edit"`, `rel="self"`, `rel="replies"`, ...) — picking the first one
 * in document order regardless of `rel` can return an editing/API URL
 * instead of the actual article, a real pattern from several blogging
 * platforms' Atom output (found by review). Per the Atom spec a `<link>`
 * with no `rel` at all defaults to `rel="alternate"`, so preference order
 * is: explicit `rel="alternate"` > no `rel` attribute > whatever's first.
 * CDATA-aware like every other scan in this file.
 */
function pickAtomLink(block: string): string | undefined {
  const spans = findCdataSpans(block);
  const links = matchAllOutsideCdata(/<link\b[^>]*\/?>/gi, block, spans).map((match) => {
    const tag = match[0];
    return { href: tag.match(/\bhref=["']([^"']*)["']/i)?.[1], rel: tag.match(/\brel=["']([^"']*)["']/i)?.[1] };
  });
  const chosen =
    links.find((l) => l.href !== undefined && l.rel === "alternate") ??
    links.find((l) => l.href !== undefined && l.rel === undefined) ??
    links.find((l) => l.href !== undefined);
  return chosen?.href !== undefined ? decodeOrUndefined(chosen.href) : undefined;
}

function decodeOrUndefined(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const decoded = decodeText(raw);
  return decoded.length > 0 ? decoded : undefined;
}

/** Parses a feed-native date string (RFC 822 or ISO 8601, whatever `Date` can make sense of) into a real ISO 8601 string — `undefined` for anything unparseable, rather than propagating an invalid/empty date string into `NewsHeadline`. */
function toIso(raw: string): string | undefined {
  if (raw.length === 0) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Every `[start, end)` span occupied by a `<![CDATA[...]]>` section in `xml` (markers included), in ascending order — an unterminated trailing CDATA section counts as extending to the end of the string. */
function findCdataSpans(xml: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < xml.length) {
    const start = xml.indexOf("<![CDATA[", i);
    if (start === -1) break;
    const end = xml.indexOf("]]>", start + 9);
    if (end === -1) {
      spans.push([start, xml.length]);
      break;
    }
    spans.push([start, end + 3]);
    i = end + 3;
  }
  return spans;
}

/** Binary search for the span (if any) containing `index`, given `spans` in ascending, non-overlapping order (as `findCdataSpans()` produces) — O(log n) instead of `Array.some()`'s O(n), which mattered: see the file doc comment for the quadratic-time DoS this replaced. */
function findSpanContaining(index: number, spans: Array<[number, number]>): [number, number] | undefined {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = spans[mid];
    if (index < start) hi = mid - 1;
    else if (index >= end) lo = mid + 1;
    else return spans[mid];
  }
  return undefined;
}

/**
 * Runs global regex `re` over `xml` starting at `from`, skipping any match
 * that falls inside one of `spans` (a CDATA section) and returning the
 * first one that doesn't — or `null` if none does. `re` must have the `g`
 * flag; a fresh `RegExp` per call is expected (this mutates `re.lastIndex`),
 * never a shared/cached instance. A rejected match jumps `lastIndex`
 * straight to the end of the span it fell in, rather than stepping forward
 * one character at a time — the fix for the quadratic-time CDATA-skipping
 * described in the file doc comment: without this jump, a document with
 * many small CDATA spans forces re-testing (and re-running the tag regex)
 * at every position inside each one.
 */
function execOutsideCdata(re: RegExp, xml: string, from: number, spans: Array<[number, number]>): RegExpExecArray | null {
  re.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const span = findSpanContaining(match.index, spans);
    if (!span) return match;
    re.lastIndex = span[1]; // always > match.index (match.index is inside [span[0], span[1])) — guarantees progress
  }
  return null;
}

/** Every non-overlapping match of global regex `re` outside any CDATA span, in document order — built on `execOutsideCdata()`, so it inherits the same span-skipping behavior instead of scanning CDATA content position by position. */
function matchAllOutsideCdata(re: RegExp, xml: string, spans: Array<[number, number]>): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  let from = 0;
  for (;;) {
    const match = execOutsideCdata(re, xml, from, spans);
    if (!match) break;
    results.push(match);
    from = match.index + match[0].length;
  }
  return results;
}

/** Finds the index of the next literal `</tag>` at or after `from`, CDATA-aware (`spans`, precomputed by the caller so a single open+close tag search only pays for `findCdataSpans()` once — `extractTagContent`/`matchAllTagBlocks` each compute it once per call, not once per field; a block with several fields, e.g. an RSS item's title/link/guid/description/pubDate/category, still recomputes it once per field, an accepted constant-factor cost bounded by item size, not the quadratic-in-document-size issue this file's doc comment describes). Returns -1 if none is found. */
function findClosingTag(xml: string, from: number, tag: string, spans: Array<[number, number]>): number {
  const match = execOutsideCdata(new RegExp(`<\\/${tag}>`, "gi"), xml, from, spans);
  return match ? match.index : -1;
}

/** First `<tag>...</tag>` occurrence's inner content, undecoded — `undefined` if absent or unterminated. Matches an optional attribute list on the opening tag (`<tag attr="x">`), but not a self-closing `<tag/>` (no inner content to return). Both the opening and closing tag search are CDATA-aware. */
function extractTagContent(xml: string, tag: string): string | undefined {
  const spans = findCdataSpans(xml);
  const openMatch = execOutsideCdata(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi"), xml, 0, spans);
  if (!openMatch) return undefined;
  const bodyStart = openMatch.index + openMatch[0].length;
  const closeIndex = findClosingTag(xml, bodyStart, tag, spans);
  if (closeIndex === -1) return undefined;
  return xml.slice(bodyStart, closeIndex);
}

/** A named attribute's value from the first self-closing/opening `<tag ...>` occurrence (CDATA-aware) — for RSS/Atom elements that carry their value as an attribute rather than text content. */
function extractTagAttr(xml: string, tag: string, attr: string): string | undefined {
  const spans = findCdataSpans(xml);
  const match = execOutsideCdata(new RegExp(`<${tag}\\s[^>]*\\b${attr}=["']([^"']*)["']`, "gi"), xml, 0, spans);
  return match ? decodeEntities(match[1]) : undefined;
}

/** Every top-level `<tag>...</tag>` block's full outer content (open+body+close), for splitting a channel/feed into its `<item>`/`<entry>` blocks. Both the opening and closing tag search are CDATA-aware, so neither a fake opening tag nor a fake closing tag inside CDATA content anywhere in the document can corrupt block boundaries. */
function matchAllTagBlocks(xml: string, tag: string): string[] {
  const spans = findCdataSpans(xml);
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi");
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const openMatch = execOutsideCdata(openRe, xml, from, spans);
    if (!openMatch) break;
    const bodyStart = openMatch.index + openMatch[0].length;
    const closeIndex = findClosingTag(xml, bodyStart, tag, spans);
    if (closeIndex === -1) break; // no matching close from here on — stop rather than loop forever
    const blockEnd = closeIndex + `</${tag}>`.length;
    blocks.push(xml.slice(openMatch.index, blockEnd));
    from = blockEnd;
  }
  return blocks;
}

/**
 * Trims, then decodes the value as a mix of plain XML-entity-escaped text
 * and zero or more `<![CDATA[...]]>` sections (a legal, real-world pattern
 * — e.g. `<![CDATA[<b>bold</b>]]> plain trailing text` — not just a value
 * that's a single CDATA block start to finish, which an earlier version of
 * this function assumed, leaking literal `<![CDATA[`/`]]>` markers into
 * the result whenever a feed mixed the two, found by review). CDATA
 * content is taken verbatim (never entity-decoded — that's what CDATA is
 * for); surrounding plain text is entity-decoded normally.
 */
function decodeText(raw: string): string {
  const trimmed = raw.trim();
  let result = "";
  let i = 0;
  while (i < trimmed.length) {
    const cdataStart = trimmed.indexOf("<![CDATA[", i);
    if (cdataStart === -1) {
      result += decodeEntities(trimmed.slice(i));
      break;
    }
    result += decodeEntities(trimmed.slice(i, cdataStart));
    const cdataEnd = trimmed.indexOf("]]>", cdataStart + 9);
    if (cdataEnd === -1) {
      // Unterminated CDATA inside an already-bounded text node (not a tag-boundary search, so
      // there's no "keep looking further" option) — take the remainder verbatim rather than
      // silently dropping it.
      result += trimmed.slice(cdataStart + 9);
      break;
    }
    result += trimmed.slice(cdataStart + 9, cdataEnd);
    i = cdataEnd + 3;
  }
  return result;
}

/**
 * Matches any of the 5 predefined XML entities or a numeric character
 * reference, decimal or hex.
 */
const ENTITY_RE = /&lt;|&gt;|&quot;|&apos;|&amp;|&#x([0-9a-fA-F]+);|&#([0-9]+);/g;

/**
 * Decodes XML entities in a single left-to-right pass over the *original*
 * string, via one combined regex and a dispatching replacer — deliberately
 * not five sequential `.replace()` passes (an earlier version of this
 * function), which had a real double-decode bug: decoding a numeric
 * reference like `&#38;` (→ `&`) in an early pass could accidentally form
 * a *new* substring — e.g. `&#38;amp;` becoming `&amp;` mid-string — that
 * a later pass (`&amp;` → `&`) would then re-decode, corrupting text that
 * was never itself a nested entity (found by review; empirically
 * confirmed before this fix existed: `&#38;amp;` wrongly decoded to `&`
 * instead of the correct literal `&amp;`). A single pass over the
 * original string can't exhibit this, since replacement output is never
 * re-scanned. An out-of-range/surrogate numeric reference (invalid per
 * Unicode, `codePointOrOriginal()`) is left as its original escaped text
 * rather than thrown — `String.fromCodePoint()` throws a `RangeError` on
 * those, which would otherwise break `parseFeed()`'s documented "never
 * throws, returns undefined" contract.
 */
function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (match, hex: string | undefined, dec: string | undefined) => {
    switch (match) {
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      case "&amp;":
        return "&";
    }
    if (hex !== undefined) return codePointOrOriginal(parseInt(hex, 16), match);
    if (dec !== undefined) return codePointOrOriginal(parseInt(dec, 10), match);
    return match;
  });
}

/** A valid Unicode scalar value is `0..0x10FFFF` excluding the surrogate range `0xD800..0xDFFF` — anything else makes `String.fromCodePoint()` throw. Falls back to `original` (the untouched matched text) rather than guessing a replacement character. */
function codePointOrOriginal(codePoint: number, original: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return original;
  return String.fromCodePoint(codePoint);
}
