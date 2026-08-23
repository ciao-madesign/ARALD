import { describe, expect, it } from "vitest";
import { parseFeed, MAX_FEED_BYTES } from "../../gateway/nomad/rss-feed.js";

describe("parseFeed — RSS 2.0", () => {
  it("parses a well-formed feed's channel metadata and items", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Bollettino Rifugio</title>
          <language>it</language>
          <item>
            <title>Nevicate in quota</title>
            <link>https://example.test/nevicate</link>
            <guid>urn:news:1</guid>
            <description>Attese nevicate sopra i 2000m.</description>
            <pubDate>Thu, 01 Jan 2026 08:00:00 GMT</pubDate>
            <category>meteo</category>
          </item>
        </channel>
      </rss>`;

    const parsed = parseFeed(xml);
    expect(parsed).toBeDefined();
    expect(parsed!.source).toBe("Bollettino Rifugio");
    expect(parsed!.language).toBe("it");
    expect(parsed!.items).toHaveLength(1);
    const [item] = parsed!.items;
    expect(item.id).toBe("urn:news:1");
    expect(item.title).toBe("Nevicate in quota");
    expect(item.link).toBe("https://example.test/nevicate");
    expect(item.summary).toBe("Attese nevicate sopra i 2000m.");
    expect(item.category).toBe("meteo");
    expect(item.publishedAt).toBe(new Date("Thu, 01 Jan 2026 08:00:00 GMT").toISOString());
    expect(item.updatedAt).toBeUndefined(); // RSS 2.0 has no equivalent field
  });

  it("falls back to <link> as the item id when <guid> is absent", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>x</title><link>https://example.test/x</link><pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;
    const parsed = parseFeed(xml);
    expect(parsed!.items[0].id).toBe("https://example.test/x");
  });

  it("defaults summary to an empty string when <description> is absent", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>x</title><link>https://example.test/x</link><guid>1</guid><pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;
    const parsed = parseFeed(xml);
    expect(parsed!.items[0].summary).toBe("");
  });

  it("rejects the whole feed when one item is missing both <guid> and <link>", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>good</title><link>https://example.test/1</link><guid>1</guid><pubDate>2026-01-01T00:00:00Z</pubDate></item>
      <item><title>bad, no id at all</title><pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;
    expect(parseFeed(xml)).toBeUndefined();
  });

  it("rejects the whole feed when one item is missing <title>", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><link>https://example.test/1</link><guid>1</guid><pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;
    expect(parseFeed(xml)).toBeUndefined();
  });

  it("rejects an item whose pubDate can't be parsed as a date at all", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>x</title><link>https://example.test/x</link><guid>1</guid><pubDate>not a date</pubDate></item>
    </channel></rss>`;
    expect(parseFeed(xml)).toBeUndefined();
  });

  it("decodes CDATA-wrapped description content verbatim, without treating embedded HTML as XML", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>x</title><link>https://example.test/x</link><guid>1</guid>
      <description><![CDATA[<b>Attenzione</b>: sentiero chiuso & pericoloso]]></description>
      <pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;
    const parsed = parseFeed(xml);
    expect(parsed!.items[0].summary).toBe("<b>Attenzione</b>: sentiero chiuso & pericoloso");
  });

  it("decodes standard XML entities, with &amp; decoded last so it never double-unescapes", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>Soccorso &amp;amp; primo intervento &lt;urgente&gt;</title><link>https://example.test/x</link><guid>1</guid><pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;
    const parsed = parseFeed(xml);
    // &amp;amp; must decode to the literal text "&amp;" (one unescape pass), not all the way to "&".
    expect(parsed!.items[0].title).toBe("Soccorso &amp; primo intervento <urgente>");
  });

  it("decodes numeric character references, decimal and hex", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>&#8211; &#x2014;</title><link>https://example.test/x</link><guid>1</guid><pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;
    const parsed = parseFeed(xml);
    expect(parsed!.items[0].title).toBe("– —"); // en dash, em dash
  });

  it("truncates to the first 2000 items instead of rejecting an oversized-but-valid feed", () => {
    const items = Array.from(
      { length: 2050 },
      (_, i) => `<item><title>t${i}</title><link>https://example.test/${i}</link><guid>${i}</guid><pubDate>2026-01-01T00:00:00Z</pubDate></item>`,
    ).join("");
    const xml = `<rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
    const parsed = parseFeed(xml);
    expect(parsed!.items).toHaveLength(2000);
    expect(parsed!.items[0].id).toBe("0");
  });
});

describe("parseFeed — Atom", () => {
  it("parses feed-level title/xml:lang and entry fields, using <link href> and <category term>", () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xml:lang="it">
        <title>Wikinotizie</title>
        <entry>
          <title>Frana in Val Camonica</title>
          <id>urn:uuid:1234</id>
          <link href="https://example.test/frana" rel="alternate"/>
          <summary>Una frana ha interrotto la strada provinciale.</summary>
          <category term="cronaca"/>
          <published>2026-02-01T10:00:00Z</published>
          <updated>2026-02-01T12:00:00Z</updated>
        </entry>
      </feed>`;

    const parsed = parseFeed(xml);
    expect(parsed).toBeDefined();
    expect(parsed!.source).toBe("Wikinotizie");
    expect(parsed!.language).toBe("it");
    const [item] = parsed!.items;
    expect(item.id).toBe("urn:uuid:1234");
    expect(item.link).toBe("https://example.test/frana");
    expect(item.summary).toBe("Una frana ha interrotto la strada provinciale.");
    expect(item.category).toBe("cronaca");
    expect(item.publishedAt).toBe("2026-02-01T10:00:00.000Z");
    expect(item.updatedAt).toBe("2026-02-01T12:00:00.000Z");
  });

  it("falls back to <content> when <summary> is absent, and to <updated> when <published> is absent", () => {
    const xml = `<feed><title>t</title>
      <entry>
        <title>x</title>
        <id>1</id>
        <link href="https://example.test/x"/>
        <content>corpo dell'articolo</content>
        <updated>2026-02-01T12:00:00Z</updated>
      </entry>
    </feed>`;
    const parsed = parseFeed(xml);
    const [item] = parsed!.items;
    expect(item.summary).toBe("corpo dell'articolo");
    expect(item.publishedAt).toBe("2026-02-01T12:00:00.000Z");
  });

  it("falls back to the entry's <link href> as id when <id> is absent", () => {
    const xml = `<feed><title>t</title>
      <entry><title>x</title><link href="https://example.test/x"/><updated>2026-01-01T00:00:00Z</updated></entry>
    </feed>`;
    const parsed = parseFeed(xml);
    expect(parsed!.items[0].id).toBe("https://example.test/x");
  });

  it("rejects the whole feed when an entry has neither <published> nor <updated>", () => {
    const xml = `<feed><title>t</title>
      <entry><title>x</title><id>1</id><link href="https://example.test/x"/></entry>
    </feed>`;
    expect(parseFeed(xml)).toBeUndefined();
  });
});

describe("parseFeed — malformed/unrecognized input", () => {
  it("returns undefined for plain garbage, not RSS or Atom at all", () => {
    expect(parseFeed("this is not xml at all")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(parseFeed("")).toBeUndefined();
  });

  it("returns undefined for well-formed XML that's neither RSS nor Atom", () => {
    expect(parseFeed("<root><child>hello</child></root>")).toBeUndefined();
  });

  it("returns undefined for a feed larger than the size cap, without attempting to parse it", () => {
    const huge = "<rss version=\"2.0\"><channel><title>" + "x".repeat(3_000_000) + "</title></channel></rss>";
    expect(parseFeed(huge)).toBeUndefined();
  });

  it("returns undefined for non-string input", () => {
    // @ts-expect-error deliberately passing a non-string to prove the runtime guard, not just the type
    expect(parseFeed(null)).toBeUndefined();
    // @ts-expect-error same as above
    expect(parseFeed(undefined)).toBeUndefined();
  });

  it("checks the size cap in actual UTF-8 bytes, not UTF-16 string length", () => {
    // "€" (U+20AC) is 1 UTF-16 code unit but 3 UTF-8 bytes — a string whose .length undercounts
    // its real byte size roughly 3x. 1,000,000 of them: .length is under the old (buggy) 2,000,000
    // *character* threshold, which would have wrongly accepted this, but the real UTF-8 byte size
    // (3,000,000) is over MAX_FEED_BYTES (2,000,000) and must be rejected.
    const big = "€".repeat(1_000_000);
    expect(big.length).toBeLessThan(MAX_FEED_BYTES);
    const xml = `<rss version="2.0"><channel><title>${big}</title></channel></rss>`;
    expect(parseFeed(xml)).toBeUndefined();
  });
});

describe("parseFeed — regression: problems found by code review", () => {
  it("does not truncate an item's boundary at a </item>-shaped substring inside its own CDATA content", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item>
        <title>Sintassi RSS spiegata</title>
        <link>https://example.test/1</link>
        <guid>1</guid>
        <description><![CDATA[Un tag si chiude così: </item> — non è la fine dell'elemento.]]></description>
        <pubDate>2026-01-01T00:00:00Z</pubDate>
      </item>
      <item>
        <title>Seconda notizia</title>
        <link>https://example.test/2</link>
        <guid>2</guid>
        <pubDate>2026-01-02T00:00:00Z</pubDate>
      </item>
    </channel></rss>`;

    const parsed = parseFeed(xml);
    expect(parsed).toBeDefined();
    expect(parsed!.items).toHaveLength(2);
    expect(parsed!.items[0].summary).toBe("Un tag si chiude così: </item> — non è la fine dell'elemento.");
    expect(parsed!.items[1].title).toBe("Seconda notizia");
  });

  it("does not throw on an out-of-range numeric character reference — leaves it undecoded instead", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>Titolo &#99999999; strano</title><link>https://example.test/1</link><guid>1</guid><pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;
    expect(() => parseFeed(xml)).not.toThrow();
    const parsed = parseFeed(xml);
    expect(parsed!.items[0].title).toBe("Titolo &#99999999; strano");
  });

  it("does not throw on a numeric reference inside the lone/surrogate code point range", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>&#xD800;</title><link>https://example.test/1</link><guid>1</guid><pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;
    expect(() => parseFeed(xml)).not.toThrow();
    expect(parseFeed(xml)!.items[0].title).toBe("&#xD800;");
  });

  it("RSS: leaves source empty (not an item's own title) when the channel itself has no <title>", () => {
    const xml = `<rss version="2.0"><channel>
      <item><title>Titolo del primo articolo</title><link>https://example.test/1</link><guid>1</guid><pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;
    const parsed = parseFeed(xml);
    expect(parsed!.source).toBe("");
    expect(parsed!.items[0].title).toBe("Titolo del primo articolo");
  });

  it("Atom: leaves source empty (not an entry's own title) when the feed itself has no <title>", () => {
    const xml = `<feed>
      <entry><title>Titolo della prima entry</title><id>1</id><link href="https://example.test/1"/><updated>2026-01-01T00:00:00Z</updated></entry>
    </feed>`;
    const parsed = parseFeed(xml);
    expect(parsed!.source).toBe("");
    expect(parsed!.items[0].title).toBe("Titolo della prima entry");
  });

  it("Atom: prefers rel=\"alternate\" over other link relations for an entry's link", () => {
    const xml = `<feed><title>t</title>
      <entry>
        <title>x</title>
        <id>1</id>
        <link href="https://example.test/edit" rel="edit"/>
        <link href="https://example.test/article" rel="alternate"/>
        <updated>2026-01-01T00:00:00Z</updated>
      </entry>
    </feed>`;
    const parsed = parseFeed(xml);
    expect(parsed!.items[0].link).toBe("https://example.test/article");
  });

  it("Atom: falls back to a <link> with no rel attribute (implicit alternate) when none is explicitly rel=\"alternate\"", () => {
    const xml = `<feed><title>t</title>
      <entry>
        <title>x</title>
        <id>1</id>
        <link href="https://example.test/self" rel="self"/>
        <link href="https://example.test/plain"/>
        <updated>2026-01-01T00:00:00Z</updated>
      </entry>
    </feed>`;
    const parsed = parseFeed(xml);
    expect(parsed!.items[0].link).toBe("https://example.test/plain");
  });

  it("decodes text content that mixes CDATA and plain text, in either order", () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>x</title><link>https://example.test/1</link><guid>1</guid>
      <description><![CDATA[Hello]]> World &amp; more</description>
      <pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;
    const parsed = parseFeed(xml);
    expect(parsed!.items[0].summary).toBe("Hello World & more");
  });

  it("does not mistake a <item>-shaped substring inside an earlier CDATA section for a real opening tag", () => {
    // Second-round regression: the first fix only made the *closing*-tag search CDATA-aware:
    // matchAllTagBlocks/feedLevelSection's *opening*-tag scan could still anchor on a fake <item>
    // sitting inside a channel-level CDATA field that comes before the real item, sweeping the
    // real <title> into the wrong place — the same failure class, just the other tag boundary.
    const xml = `<rss version="2.0"><channel>
      <description><![CDATA[This article explains what an <item> tag means in RSS.]]></description>
      <title>Real Channel Title</title>
      <item><title>Headline</title><link>https://example.test/1</link><guid>1</guid><pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;

    const parsed = parseFeed(xml);
    expect(parsed!.source).toBe("Real Channel Title");
    expect(parsed!.items).toHaveLength(1);
    expect(parsed!.items[0].title).toBe("Headline");
  });

  it("does not mistake a <link>-shaped substring inside an Atom entry's CDATA content for a real <link> element", () => {
    const xml = `<feed><title>t</title>
      <entry>
        <title>x</title>
        <id>1</id>
        <content><![CDATA[See <link href="https://example.test/fake"/> for an example.]]></content>
        <link href="https://example.test/real" rel="alternate"/>
        <updated>2026-01-01T00:00:00Z</updated>
      </entry>
    </feed>`;
    const parsed = parseFeed(xml);
    expect(parsed!.items[0].link).toBe("https://example.test/real");
  });

  it("decodes a numeric reference immediately followed by literal entity-shaped text without double-decoding it", () => {
    // &#38; is the numeric reference for "&"; the literal text "amp;" right after it is NOT itself
    // an entity (nothing precedes it with a "&" in the original string) — the correct decode is the
    // 5-character literal "&amp;". A sequential multi-pass decoder can get this wrong: decoding
    // &#38; to "&" in an early pass forms a *new* "&amp;" substring that a later dedicated &amp;
    // pass then re-decodes down to just "&".
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>x</title><link>https://example.test/1</link><guid>1</guid>
      <description>&#38;amp;</description>
      <pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;
    const parsed = parseFeed(xml);
    expect(parsed!.items[0].summary).toBe("&amp;");
  });

  it("parses a feed with many small CDATA sections containing tag-shaped text in well under a second (third-round regression: quadratic-time DoS)", () => {
    // Third-round regression: the second round's CDATA-awareness fix was correct but slow — every
    // rejected match re-scanned one character at a time, so many small CDATA sections each
    // containing a </description>-shaped substring made parsing quadratic in the number of spans.
    // This document is well under MAX_FEED_BYTES but has 20,000 tiny CDATA sections, each one a
    // worst case for the naive version (confirmed to take several seconds before this fix; the
    // generous 2s budget below only guards against a real regression, not a tight timing assertion).
    const fakeCdata = "<![CDATA[</description>]]>";
    const description = fakeCdata.repeat(20_000);
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>x</title><link>https://example.test/1</link><guid>1</guid>
      <description>${description}</description>
      <pubDate>2026-01-01T00:00:00Z</pubDate></item>
    </channel></rss>`;

    const start = Date.now();
    const parsed = parseFeed(xml);
    const elapsedMs = Date.now() - start;

    expect(parsed).toBeDefined();
    expect(parsed!.items).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
