import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CHUNK_SIZE,
  ChunkAssembler,
  ContentStore,
  chunkCountForSize,
  compressForTransfer,
  computeContentId,
  contentSigningPayload,
  decodeStoredContent,
  type ContentMetadata,
} from "../../node/src/content.js";
import { Identity } from "../../node/src/identity.js";
import { Priority } from "../../node/src/packet.js";

describe("ContentStore", () => {
  it("derives the content id as sha256 of the payload", () => {
    const data = Buffer.from("hello arald");
    const store = new ContentStore();
    const metadata = store.put("hello.txt", "text/plain", data);
    expect(metadata.contentId).toBe(computeContentId(data));
    expect(metadata.size).toBe(data.length);
  });

  it("refuses to store content whose bytes don't match the claimed content id", () => {
    const store = new ContentStore();
    const fakeMetadata = {
      contentId: computeContentId(Buffer.from("original")),
      name: "x",
      mimeType: "text/plain",
      size: 7,
      createdAt: Date.now(),
    };
    const ok = store.putVerified(fakeMetadata, Buffer.from("tampered"));
    expect(ok).toBe(false);
    expect(store.has(fakeMetadata.contentId)).toBe(false);
  });

  it("splits content into multiple chunks when larger than CHUNK_SIZE", () => {
    const store = new ContentStore();
    const data = Buffer.alloc(CHUNK_SIZE * 2 + 10, 7);
    const metadata = store.put("big.bin", "application/octet-stream", data);
    const chunks = store.chunksFor(metadata.contentId);
    expect(chunks).toHaveLength(3);
    expect(Buffer.concat(chunks)).toEqual(data);
  });
});

describe("chunkCountForSize", () => {
  it("matches ContentStore.chunksFor()'s own count for the same size, including the zero-byte special case", () => {
    const store = new ContentStore();
    for (const size of [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, CHUNK_SIZE * 2 + 10]) {
      const metadata = store.put(`f-${size}.bin`, "application/octet-stream", Buffer.alloc(size, 1));
      expect(chunkCountForSize(size)).toBe(store.chunksFor(metadata.contentId).length);
    }
  });

  it("never returns zero even for a negative size (defensive — never trusted network input in practice)", () => {
    expect(chunkCountForSize(-1)).toBe(1);
  });
});

describe("ContentStore size bound (spec §57)", () => {
  it("evicts the oldest entry once maxSize is exceeded, when no trustRank is given", () => {
    const store = new ContentStore({ maxSize: 2 });
    store.put("a.txt", "text/plain", Buffer.from("a"));
    store.put("b.txt", "text/plain", Buffer.from("b"));
    store.put("c.txt", "text/plain", Buffer.from("c"));

    expect(store.size).toBe(2);
    expect(store.list().map((m) => m.name).sort()).toEqual(["b.txt", "c.txt"]);
  });

  it("with trustRank given, evicts the least-trusted publisher's content instead of the oldest", () => {
    // Unlike RemoteCatalog.record(), ContentStore.putVerified() actually checks the signature
    // (spec §55) — so, unlike catalog.test.ts's equivalent, this needs real identities and real
    // signatures rather than free-form "alice"/"bob" string aliases; the trust table below is
    // keyed by each identity's real (generated) nodeId instead.
    const alice = Identity.generate();
    const bob = Identity.generate();
    const trust: Record<string, number> = { [alice.nodeId]: 5, [bob.nodeId]: 0 };
    const store = new ContentStore({ maxSize: 2, trustRank: (publisherId) => trust[publisherId] ?? 0 });

    function publish(identity: Identity, data: Buffer): ContentMetadata {
      const contentId = computeContentId(data);
      const fields = { contentId, name: "n", mimeType: "text/plain", size: data.length, publisherId: identity.nodeId };
      const metadata = { ...fields, createdAt: Date.now(), signature: identity.sign(contentSigningPayload(fields)).toString("hex") };
      expect(store.putVerified(metadata, data)).toBe(true);
      return metadata;
    }

    const aMeta = publish(alice, Buffer.from("trusted, oldest — must still survive"));
    const bMeta = publish(bob, Buffer.from("untrusted"));
    const cMeta = publish(bob, Buffer.from("untrusted, newer than b — b evicted, not a"));

    expect(store.has(aMeta.contentId)).toBe(true);
    expect(store.has(bMeta.contentId)).toBe(false);
    expect(store.has(cMeta.contentId)).toBe(true);
  });

  it("priority outranks trust: an EMERGENCY-priority entry from an untrusted throwaway publisher survives over a CONTENT-priority entry from a highly-trusted one (docs/next-steps.md, 'Priorità immediata' — the gap left open by docs/security.md voce #120, which only ever covered PendingDeliveryQueue's unicast traffic, never this broadcast/ContentStore path)", () => {
    const trusted = Identity.generate();
    const throwaway = Identity.generate();
    const trust: Record<string, number> = { [trusted.nodeId]: 5, [throwaway.nodeId]: 0 };
    const store = new ContentStore({ maxSize: 2, trustRank: (publisherId) => trust[publisherId] ?? 0 });

    function publish(identity: Identity, data: Buffer, priority?: Priority): ContentMetadata {
      const contentId = computeContentId(data);
      const fields = { contentId, name: "n", mimeType: "application/json", size: data.length, publisherId: identity.nodeId, priority };
      const metadata = { ...fields, createdAt: Date.now(), signature: identity.sign(contentSigningPayload(fields)).toString("hex") };
      expect(store.putVerified(metadata, data)).toBe(true);
      return metadata;
    }

    // A highly-trusted publisher's two ordinary (default-priority) entries fill the store first...
    const routineMeta = publish(trusted, Buffer.from("routine, trusted"));
    publish(trusted, Buffer.from("routine, trusted, newer"));
    // ...then a never-seen-before identity's SOS arrives. Before priority-aware eviction existed,
    // this would have been the one evicted (trust alone: UNKNOWN always loses to a trusted
    // publisher) — now it must survive, and it's the *trusted* publisher's older routine entry that
    // goes instead, despite being from a far more trusted source.
    const sosMeta = publish(throwaway, Buffer.from("SOS da un'identità mai vista prima"), Priority.EMERGENCY);

    expect(store.has(sosMeta.contentId)).toBe(true);
    expect(store.has(routineMeta.contentId)).toBe(false);
  });

  it("clamps a forged/out-of-range priority instead of letting it evade eviction ahead of a real EMERGENCY entry (same defense as store-and-forward.ts's priorityRank() clamp, docs/security.md voce #55)", () => {
    const legit = Identity.generate();
    const forger = Identity.generate();
    const store = new ContentStore({ maxSize: 2, trustRank: () => 0 }); // same trust for both — isolates the priority clamp itself

    function publish(identity: Identity, data: Buffer, priority?: Priority): ContentMetadata {
      const contentId = computeContentId(data);
      const fields = { contentId, name: "n", mimeType: "application/json", size: data.length, publisherId: identity.nodeId, priority };
      const metadata = { ...fields, createdAt: Date.now(), signature: identity.sign(contentSigningPayload(fields)).toString("hex") };
      expect(store.putVerified(metadata, data)).toBe(true);
      return metadata;
    }

    // A self-signed identity can claim anything about its own content, including an out-of-range
    // "priority" value — priorityRank() must clamp it to Priority.BULK (the worst tier), never let
    // it outrank a real EMERGENCY entry the way an unclamped -1000 would (lower numbers are more
    // urgent, so a naive implementation could let a forged negative value "win" eviction forever).
    const legitMeta = publish(legit, Buffer.from("real EMERGENCY entry"), Priority.EMERGENCY);
    const forgedMeta = publish(forger, Buffer.from("forged out-of-range priority claim"), -1000 as Priority);

    const third = publish(legit, Buffer.from("third entry triggers eviction"), Priority.CONTENT);

    expect(store.has(forgedMeta.contentId)).toBe(false); // clamped to BULK-equivalent, evicted first
    expect(store.has(legitMeta.contentId)).toBe(true);
    expect(store.has(third.contentId)).toBe(true);
  });

  it("bounds the damage an unlimited flood of fresh throwaway identities can do by self-signing 'priority: EMERGENCY' — at most MAX_UNVETTED_ELEVATED_ENTRIES (8) unvetted+elevated entries are ever protected at once, favoring the most recent, not an unbounded or permanently-first-come-first-served number (found by code-review, two rounds: a self-declared signed field costs nothing to fabricate, so letting it unconditionally outrank trust would let one attacker evict an entire store's worth of legitimate, highly-trusted content for free; and protecting whoever got there first instead of the most recent would permanently lock out every later — including genuinely legitimate — sighting)", () => {
    const trusted = Identity.generate();
    const trust: Record<string, number> = { [trusted.nodeId]: 5 };
    const TRUSTED_COUNT = 11; // >= 8 (the budget) + 3, enough to prove both the cap and that it stabilizes
    const store = new ContentStore({ maxSize: TRUSTED_COUNT, trustRank: (publisherId) => trust[publisherId] ?? 0 });

    function publish(identity: Identity, data: Buffer, priority?: Priority): ContentMetadata {
      const contentId = computeContentId(data);
      const fields = { contentId, name: "n", mimeType: "application/json", size: data.length, publisherId: identity.nodeId, priority };
      const metadata = { ...fields, createdAt: Date.now(), signature: identity.sign(contentSigningPayload(fields)).toString("hex") };
      expect(store.putVerified(metadata, data)).toBe(true);
      return metadata;
    }

    const trustedEntries = Array.from({ length: TRUSTED_COUNT }, (_, i) => publish(trusted, Buffer.from(`trusted routine content ${i}`)));
    expect(store.size).toBe(TRUSTED_COUNT); // store exactly full of trusted content, nothing to evict yet

    // 11 distinct never-seen-before identities, each claiming priority: EMERGENCY for one piece of
    // throwaway content — far more than the budget (8). Each insertion still evicts *something* (the
    // store is always at capacity), but only the 8 *most recent* qualifying entries at any given
    // moment keep their boosted protection; an entry that ages out of that window is demoted back to
    // ordinary (trust-only) scoring on the very next insertion, so it's the one evicted next, not a
    // trusted entry.
    const attackers = Array.from({ length: TRUSTED_COUNT }, () => Identity.generate());
    const attackEntries = attackers.map((attacker, i) => publish(attacker, Buffer.from(`attack payload ${i}`), Priority.EMERGENCY));

    const survivingTrusted = trustedEntries.filter((m) => store.has(m.contentId));
    // Worst case: the budget (8) plus one extra lost during the single round where the cap was first
    // found already full (see refreshUnvettedElevatedSnapshot()'s own doc comment) — never more,
    // however many additional attackers pile on afterward (11 here, well past that point).
    expect(survivingTrusted).toHaveLength(TRUSTED_COUNT - 9);

    // The two *oldest* attacker entries aged out of the 8-entry recency window once a 9th and then a
    // 10th distinct identity arrived, and were evicted in turn (never a trusted entry, from the
    // round after the budget first filled onward) — while the 9 most recent (the last 9 of the 11)
    // all remain, including every one that arrived strictly after the budget was already full.
    expect(store.has(attackEntries[0].contentId)).toBe(false);
    expect(store.has(attackEntries[1].contentId)).toBe(false);
    for (let i = 2; i < attackEntries.length; i++) expect(store.has(attackEntries[i].contentId)).toBe(true);
  });

  it("the entry budget above is per-content-id, not per-publisher — a single throwaway identity flooding many distinct self-signed EMERGENCY entries is bounded exactly the same way a flood of many distinct identities is (regression: an earlier version of the cap counted distinct publishers instead, so one attacker identity alone could flood an unbounded number of its own entries, each freely protected, and evict a store's entire trusted content for free)", () => {
    const trusted = Identity.generate();
    const trust: Record<string, number> = { [trusted.nodeId]: 5 };
    const TRUSTED_COUNT = 30; // comfortably more than the budget (8) + a generous margin
    const store = new ContentStore({ maxSize: TRUSTED_COUNT, trustRank: (publisherId) => trust[publisherId] ?? 0 });

    function publish(identity: Identity, data: Buffer, priority?: Priority): ContentMetadata {
      const contentId = computeContentId(data);
      const fields = { contentId, name: "n", mimeType: "application/json", size: data.length, publisherId: identity.nodeId, priority };
      const metadata = { ...fields, createdAt: Date.now(), signature: identity.sign(contentSigningPayload(fields)).toString("hex") };
      expect(store.putVerified(metadata, data)).toBe(true);
      return metadata;
    }

    for (let i = 0; i < TRUSTED_COUNT; i++) publish(trusted, Buffer.from(`trusted routine content ${i}`));
    expect(store.size).toBe(TRUSTED_COUNT);

    // One single never-seen-before identity floods 25 distinct self-signed EMERGENCY entries —
    // every one of them could, in principle, have been freely protected if the budget tracked
    // publishers rather than entries.
    const attacker = Identity.generate();
    for (let i = 0; i < 25; i++) publish(attacker, Buffer.from(`single-identity flood payload ${i}`), Priority.EMERGENCY);

    // Same bound as the multi-identity flood above (cap + 1 = 9 trusted entries lost), regardless of
    // how many distinct entries the one identity behind it published.
    const remainingTrustedCount = Array.from({ length: TRUSTED_COUNT }, (_, i) => computeContentId(Buffer.from(`trusted routine content ${i}`))).filter(
      (id) => store.has(id),
    ).length;
    expect(remainingTrustedCount).toBe(TRUSTED_COUNT - 9);
  });
});

describe("ContentStore expiry (spec §24)", () => {
  it("put() without ttlMs never expires", () => {
    const store = new ContentStore();
    const metadata = store.put("x.txt", "text/plain", Buffer.from("x"));
    expect(metadata.expiresAt).toBeUndefined();
    expect(store.has(metadata.contentId)).toBe(true);
  });

  it("get()/has()/chunksFor() treat already-expired content as absent, and purge it on access", () => {
    const store = new ContentStore();
    const data = Buffer.from("stale bulletin");
    const metadata = store.put("b.txt", "text/plain", data, { ttlMs: -1 }); // already in the past
    expect(metadata.expiresAt).toBeLessThan(Date.now());

    expect(store.has(metadata.contentId)).toBe(false);
    expect(store.get(metadata.contentId)).toBeUndefined();
    expect(store.chunksFor(metadata.contentId)).toEqual([]);
  });

  it("list() and size exclude expired entries and purge them as a side effect", () => {
    const store = new ContentStore();
    store.put("fresh.txt", "text/plain", Buffer.from("fresh"));
    const stale = store.put("stale.txt", "text/plain", Buffer.from("stale"), { ttlMs: -1 });

    const listed = store.list();
    expect(listed.map((m) => m.name)).toEqual(["fresh.txt"]);
    expect(store.size).toBe(1);
    expect(store.has(stale.contentId)).toBe(false);
  });

  it("content that hasn't expired yet is still served normally", () => {
    const store = new ContentStore();
    const data = Buffer.from("valid for another hour");
    const metadata = store.put("ok.txt", "text/plain", data, { ttlMs: 60 * 60 * 1000 });

    expect(store.has(metadata.contentId)).toBe(true);
    expect(store.get(metadata.contentId)?.data).toEqual(data);
    expect(store.list().map((m) => m.contentId)).toContain(metadata.contentId);
  });

  it("putVerified() refuses to store metadata whose expiry has already passed, even if the signature is genuine", () => {
    const publisher = Identity.generate();
    const data = Buffer.from("already dead on arrival");
    const contentId = computeContentId(data);
    const name = "n";
    const mimeType = "text/plain";
    const size = data.length;
    const publisherId = publisher.nodeId;
    const expiresAt = Date.now() - 1000;
    const signature = publisher
      .sign(contentSigningPayload({ contentId, name, mimeType, size, publisherId, expiresAt }))
      .toString("hex");
    const metadata: ContentMetadata = { contentId, name, mimeType, size, createdAt: Date.now(), publisherId, signature, expiresAt };

    const store = new ContentStore();
    expect(store.putVerified(metadata, data)).toBe(false);
    expect(store.has(contentId)).toBe(false);
  });
});

describe("ContentStore publisher signature verification (spec §55)", () => {
  function signedMetadata(
    identity: Identity,
    data: Buffer,
    fieldOverrides: Partial<Pick<ContentMetadata, "name" | "mimeType" | "publisherId">> = {},
  ): ContentMetadata {
    const contentId = computeContentId(data);
    const name = fieldOverrides.name ?? "n";
    const mimeType = fieldOverrides.mimeType ?? "text/plain";
    const publisherId = fieldOverrides.publisherId ?? identity.nodeId;
    const size = data.length;
    return {
      contentId,
      name,
      mimeType,
      size,
      createdAt: Date.now(),
      publisherId,
      signature: identity.sign(contentSigningPayload({ contentId, name, mimeType, size, publisherId })).toString("hex"),
    };
  }

  it("accepts content correctly signed by its claimed publisher", () => {
    const publisher = Identity.generate();
    const data = Buffer.from("rifugio: bollettino ufficiale");
    const store = new ContentStore();

    const ok = store.putVerified(signedMetadata(publisher, data), data);
    expect(ok).toBe(true);
  });

  it("rejects content whose hash matches but carries no signature at all", () => {
    const data = Buffer.from("no signature attached");
    const metadata: ContentMetadata = {
      contentId: computeContentId(data),
      name: "n",
      mimeType: "text/plain",
      size: data.length,
      createdAt: Date.now(),
      // publisherId/signature intentionally omitted
    };
    const store = new ContentStore();

    expect(store.putVerified(metadata, data)).toBe(false);
    expect(store.has(metadata.contentId)).toBe(false);
  });

  it("rejects content impersonating a publisher it wasn't actually signed by", () => {
    const victim = Identity.generate();
    const attacker = Identity.generate();
    const data = Buffer.from("evacuare zona X");

    // Attacker signs with their own key but claims to be `victim` — the
    // signature won't verify against victim's public key.
    const forged = signedMetadata(attacker, data, { publisherId: victim.nodeId });
    const store = new ContentStore();

    expect(store.putVerified(forged, data)).toBe(false);
    expect(store.has(forged.contentId)).toBe(false);
  });

  it("rejects genuinely-signed content whose name/mimeType was relabeled after signing (relay tampering)", () => {
    const publisher = Identity.generate();
    const data = Buffer.from("bollettino meteo ufficiale");
    const genuine = signedMetadata(publisher, data, { name: "bollettino.txt", mimeType: "text/plain" });

    // A relay keeps contentId/signature untouched but swaps the label — this must NOT verify,
    // otherwise the signature would only be proving "these bytes exist", not "this is what
    // the publisher actually called them" (spec §55).
    const relabeled: ContentMetadata = { ...genuine, name: "security-patch.exe", mimeType: "application/x-msdownload" };
    const store = new ContentStore();

    expect(store.putVerified(relabeled, data)).toBe(false);
    expect(store.has(relabeled.contentId)).toBe(false);

    // The untouched original, by contrast, still verifies fine.
    expect(store.putVerified(genuine, data)).toBe(true);
  });

  it("NomadNode.publishContent signs content so it round-trips through putVerified", async () => {
    const { NomadNode } = await import("../../node/src/node.js");
    const node = new NomadNode({ displayName: "signer" });
    const data = Buffer.from("published via NomadNode");

    const metadata = node.publishContent("doc.txt", "text/plain", data);

    expect(metadata.publisherId).toBe(node.nodeId);
    expect(metadata.signature).toBeTruthy();
    expect(node.contentStore.has(metadata.contentId)).toBe(true);
  });

  it("rejects a genuinely-signed claim of 'encoding: zstd' whose bytes don't actually decompress — a self-signed identity can lie about encoding the same way it could about name/mimeType (found by code-review)", () => {
    const publisher = Identity.generate();
    const data = Buffer.from("plain text, not a zstd frame");
    const contentId = computeContentId(data);
    const size = data.length;
    const publisherId = publisher.nodeId;
    const signature = publisher
      .sign(contentSigningPayload({ contentId, name: "n", mimeType: "text/plain", size, publisherId, encoding: "zstd", originalSize: 500 }))
      .toString("hex");
    const forged: ContentMetadata = { contentId, name: "n", mimeType: "text/plain", size, createdAt: Date.now(), publisherId, signature, encoding: "zstd", originalSize: 500 };
    const store = new ContentStore();

    // Hash matches, signature verifies — the only thing wrong is a lie only decompression exposes.
    expect(store.putVerified(forged, data)).toBe(false);
    expect(store.has(forged.contentId)).toBe(false);
  });
});

describe("ChunkAssembler", () => {
  it("reassembles chunks received out of order and verifies the hash", () => {
    const data = Buffer.from("A -> B -> C content transfer");
    const contentId = computeContentId(data);
    const metadata = { contentId, name: "n", mimeType: "text/plain", size: data.length, createdAt: Date.now() };

    const assembler = new ChunkAssembler();
    const mid = Math.floor(data.length / 2);
    assembler.addChunk(contentId, 1, 2, data.subarray(mid));
    assembler.addChunk(contentId, 0, 2, data.subarray(0, mid));

    const result = assembler.tryComplete(contentId, metadata);
    expect(result).toEqual(data);
  });

  it("returns undefined while chunks are still missing", () => {
    const contentId = computeContentId(Buffer.from("x"));
    const metadata = { contentId, name: "n", mimeType: "text/plain", size: 1, createdAt: Date.now() };
    const assembler = new ChunkAssembler();
    assembler.addChunk(contentId, 0, 2, Buffer.from("x"));
    expect(assembler.tryComplete(contentId, metadata)).toBeUndefined();
  });

  it("rejects a reassembled buffer that doesn't match the announced hash", () => {
    const metadata = {
      contentId: computeContentId(Buffer.from("expected")),
      name: "n",
      mimeType: "text/plain",
      size: 8,
      createdAt: Date.now(),
    };
    const assembler = new ChunkAssembler();
    assembler.addChunk(metadata.contentId, 0, 1, Buffer.from("different"));
    expect(assembler.tryComplete(metadata.contentId, metadata)).toBeUndefined();
  });

  it("evicts the oldest in-progress content id once maxEntries is exceeded, bounding memory against a flood of fabricated content ids", () => {
    const assembler = new ChunkAssembler({ maxEntries: 2 });
    assembler.addChunk("a", 0, 2, Buffer.from("1"));
    assembler.addChunk("b", 0, 2, Buffer.from("1"));
    assembler.addChunk("c", 0, 2, Buffer.from("1"));

    // "a" was evicted to make room for "c" — completing it now can never succeed, even with all chunks resent.
    assembler.addChunk("a", 1, 2, Buffer.from("2"));
    const metadata = { contentId: "a", name: "n", mimeType: "text/plain", size: 2, createdAt: Date.now() };
    expect(assembler.tryComplete("a", metadata)).toBeUndefined();
  });

  it("rejects a totalChunks claim above maxChunksPerEntry, instead of allocating unbounded chunk slots", () => {
    const assembler = new ChunkAssembler({ maxChunksPerEntry: 4 });
    expect(assembler.addChunk("huge", 0, 1_000_000, Buffer.from("x"))).toBe(false);
    const metadata = { contentId: "huge", name: "n", mimeType: "text/plain", size: 1, createdAt: Date.now() };
    // Never registered at all — a legitimate resend with a sane totalChunks must still work.
    expect(assembler.addChunk("huge", 0, 2, Buffer.from("y"))).toBe(true);
    expect(assembler.addChunk("huge", 1, 2, Buffer.from("z"))).toBe(true);
    expect(assembler.tryComplete("huge", { ...metadata, contentId: computeContentId(Buffer.from("yz")) })).toEqual(
      Buffer.from("yz"),
    );
  });

  it("rejects a chunkIndex outside [0, totalChunks)", () => {
    const assembler = new ChunkAssembler();
    expect(assembler.addChunk("c", -1, 2, Buffer.from("x"))).toBe(false);
    expect(assembler.addChunk("c", 2, 2, Buffer.from("x"))).toBe(false);
    const metadata = { contentId: "c", name: "n", mimeType: "text/plain", size: 1, createdAt: Date.now() };
    // Neither malformed chunk was stored — completing normally with valid chunks still works.
    expect(assembler.addChunk("c", 0, 2, Buffer.from("y"))).toBe(true);
    expect(assembler.addChunk("c", 1, 2, Buffer.from("z"))).toBe(true);
    expect(assembler.tryComplete("c", { ...metadata, contentId: computeContentId(Buffer.from("yz")) })).toEqual(
      Buffer.from("yz"),
    );
  });
});

describe("compressForTransfer/decodeStoredContent — ARALD Content Compression & Optimization (docs/next-steps.md)", () => {
  it("leaves tiny content untouched — below the point where zstd's own framing could ever shrink anything", () => {
    const data = Buffer.from("short");
    const result = compressForTransfer(data);
    expect(result.data).toBe(data); // same buffer, never even attempted
    expect(result.encoding).toBeUndefined();
    expect(result.originalSize).toBeUndefined();
  });

  it("compresses large, genuinely repetitive content and records encoding+originalSize", () => {
    const data = Buffer.from("ARALD mesh network ".repeat(200)); // well over the 512B floor, highly compressible
    const result = compressForTransfer(data);
    expect(result.encoding).toBe("zstd");
    expect(result.originalSize).toBe(data.length);
    expect(result.data.length).toBeLessThan(data.length);
  });

  it("keeps the original, uncompressed, when compression would not actually shrink it (e.g. high-entropy data)", () => {
    const data = randomBytes(2000); // random bytes are, for all practical purposes, incompressible
    const result = compressForTransfer(data);
    expect(result.data).toBe(data);
    expect(result.encoding).toBeUndefined();
    expect(result.originalSize).toBeUndefined();
  });

  it("decodeStoredContent reverses compressForTransfer exactly", () => {
    const original = Buffer.from("ARALD mesh network ".repeat(500));
    const { data: stored, encoding, originalSize } = compressForTransfer(original);
    expect(encoding).toBe("zstd"); // sanity: this test only proves something if compression actually kicked in
    const decoded = decodeStoredContent({ encoding }, stored);
    expect(decoded.equals(original)).toBe(true);
    expect(decoded.length).toBe(originalSize);
  });

  it("decodeStoredContent is a no-op when encoding is undefined, including for content that happens to look like zstd bytes", () => {
    const data = Buffer.from("plain, never compressed");
    expect(decodeStoredContent({ encoding: undefined }, data)).toBe(data);
  });

  it("decodeStoredContent throws (never crashes the process with a raw native error) for data claiming zstd encoding that isn't actually a valid zstd frame — the DoS found by code-review", () => {
    const forged = Buffer.from("plain bytes, not a zstd frame at all");
    expect(() => decodeStoredContent({ encoding: "zstd", originalSize: 1000 }, forged)).toThrow();
  });

  it("decodeStoredContent enforces a decompressed-size ceiling instead of trusting the claimed originalSize unconditionally", () => {
    const real = Buffer.from("x".repeat(5000)); // compresses extremely well
    const { data: compressed, encoding } = compressForTransfer(real);
    expect(encoding).toBe("zstd");
    // A claim smaller than the genuine decompressed size must fail closed, not silently truncate —
    // same "maxOutputLength" mechanism that bounds a genuine zip-bomb independently of what's claimed.
    expect(() => decodeStoredContent({ encoding: "zstd", originalSize: 10 }, compressed)).toThrow();
    // The correct claim still works, proving the throw above is about the cap, not a broken frame.
    expect(decodeStoredContent({ encoding: "zstd", originalSize: real.length }, compressed).equals(real)).toBe(true);
  });

  it("contentSigningPayload is byte-for-byte identical to before compression existed when encoding/originalSize are absent — the backward-compatibility guarantee this feature depends on", () => {
    const fields = { contentId: "abc", name: "n.txt", mimeType: "text/plain", size: 42, publisherId: "pub1", expiresAt: undefined };
    const withCompressionFields = contentSigningPayload(fields);
    const legacyShape = Buffer.from(
      JSON.stringify({
        contentId: fields.contentId,
        name: fields.name,
        mimeType: fields.mimeType,
        size: fields.size,
        publisherId: fields.publisherId,
        expiresAt: fields.expiresAt,
      }),
    );
    expect(withCompressionFields.equals(legacyShape)).toBe(true);
  });

  it("contentSigningPayload does change when encoding/originalSize are set — proves they're actually signed, not silently dropped", () => {
    const base = { contentId: "abc", name: "n.txt", mimeType: "text/plain", size: 10, publisherId: "pub1", expiresAt: undefined };
    const uncompressedPayload = contentSigningPayload(base);
    const compressedPayload = contentSigningPayload({ ...base, encoding: "zstd", originalSize: 100 });
    expect(compressedPayload.equals(uncompressedPayload)).toBe(false);
  });

  it("contentSigningPayload is byte-for-byte identical to before the 'priority' field existed when it's absent — same backward-compatibility guarantee as encoding/originalSize above (docs/next-steps.md, 'Priorità immediata')", () => {
    const fields = { contentId: "abc", name: "n.txt", mimeType: "text/plain", size: 42, publisherId: "pub1", expiresAt: undefined };
    const withPriorityField = contentSigningPayload(fields);
    const legacyShape = Buffer.from(
      JSON.stringify({
        contentId: fields.contentId,
        name: fields.name,
        mimeType: fields.mimeType,
        size: fields.size,
        publisherId: fields.publisherId,
        expiresAt: fields.expiresAt,
      }),
    );
    expect(withPriorityField.equals(legacyShape)).toBe(true);
  });

  it("contentSigningPayload does change when priority is set — proves it's actually signed, not silently dropped (so a relay can never tamper with it to demote a real SOS or inflate routine content)", () => {
    const base = { contentId: "abc", name: "n.txt", mimeType: "text/plain", size: 10, publisherId: "pub1", expiresAt: undefined };
    const withoutPriority = contentSigningPayload(base);
    const withPriority = contentSigningPayload({ ...base, priority: Priority.EMERGENCY });
    expect(withPriority.equals(withoutPriority)).toBe(false);
  });
});
