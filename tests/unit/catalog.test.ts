import { describe, expect, it } from "vitest";
import { RemoteCatalog } from "../../node/src/catalog.js";
import type { ContentMetadata } from "../../node/src/content.js";

function metadata(contentId: string, createdAt = Date.now()): ContentMetadata {
  return { contentId, name: `${contentId}.txt`, mimeType: "text/plain", size: 10, createdAt };
}

describe("RemoteCatalog", () => {
  it("records and lists entries it has learned about", () => {
    const catalog = new RemoteCatalog();
    catalog.record(metadata("a"));
    catalog.record(metadata("b"));

    expect(catalog.size).toBe(2);
    expect(catalog.has("a")).toBe(true);
    expect(catalog.list().map((m) => m.contentId).sort()).toEqual(["a", "b"]);
  });

  it("keeps the first entry recorded for a content id and ignores later claims for the same id", () => {
    // A content id is the hash of its bytes (spec §24) — immutable by construction — so a later
    // claim for the same id can't legitimately describe different content, and `createdAt` isn't
    // covered by the publisher signature (contentSigningPayload in content.ts) precisely so it
    // can't be used to let a tampered claim override an already-recorded one.
    const catalog = new RemoteCatalog();
    catalog.record(metadata("a", 1000));
    catalog.record({ ...metadata("a", 9_999_999_999), name: "tampered.exe" });

    expect(catalog.get("a")?.createdAt).toBe(1000);
    expect(catalog.get("a")?.name).toBe("a.txt");
  });

  it("evicts the oldest entry once maxSize is exceeded, when no trustRank is given", () => {
    const catalog = new RemoteCatalog({ maxSize: 2 });
    catalog.record(metadata("a"));
    catalog.record(metadata("b"));
    catalog.record(metadata("c"));

    expect(catalog.size).toBe(2);
    expect(catalog.has("a")).toBe(false);
    expect(catalog.has("c")).toBe(true);
  });

  it("with trustRank given, evicts the entry from the least-trusted publisher instead of the oldest", () => {
    const trust: Record<string, number> = { alice: 5, bob: 0 };
    const catalog = new RemoteCatalog({ maxSize: 2, trustRank: (publisherId) => trust[publisherId] ?? 0 });

    catalog.record({ ...metadata("a"), publisherId: "alice" }); // trusted, oldest — must still survive
    catalog.record({ ...metadata("b"), publisherId: "bob" }); // untrusted
    catalog.record({ ...metadata("c"), publisherId: "bob" }); // untrusted, newer than "b" — "b" evicted, not "a"

    expect(catalog.has("a")).toBe(true);
    expect(catalog.has("b")).toBe(false);
    expect(catalog.has("c")).toBe(true);
  });
});
