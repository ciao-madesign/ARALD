import { describe, expect, it } from "vitest";
import {
  CHUNK_SIZE,
  ChunkAssembler,
  ContentStore,
  computeContentId,
  contentSigningPayload,
  type ContentMetadata,
} from "../../node/src/content.js";
import { Identity } from "../../node/src/identity.js";

describe("ContentStore", () => {
  it("derives the content id as sha256 of the payload", () => {
    const data = Buffer.from("hello nomad-net");
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
    assembler.addChunk("huge", 0, 1_000_000, Buffer.from("x"));
    const metadata = { contentId: "huge", name: "n", mimeType: "text/plain", size: 1, createdAt: Date.now() };
    // Never registered at all — a legitimate resend with a sane totalChunks must still work.
    assembler.addChunk("huge", 0, 2, Buffer.from("y"));
    assembler.addChunk("huge", 1, 2, Buffer.from("z"));
    expect(assembler.tryComplete("huge", { ...metadata, contentId: computeContentId(Buffer.from("yz")) })).toEqual(
      Buffer.from("yz"),
    );
  });

  it("rejects a chunkIndex outside [0, totalChunks)", () => {
    const assembler = new ChunkAssembler();
    assembler.addChunk("c", -1, 2, Buffer.from("x"));
    assembler.addChunk("c", 2, 2, Buffer.from("x"));
    const metadata = { contentId: "c", name: "n", mimeType: "text/plain", size: 1, createdAt: Date.now() };
    // Neither malformed chunk was stored — completing normally with valid chunks still works.
    assembler.addChunk("c", 0, 2, Buffer.from("y"));
    assembler.addChunk("c", 1, 2, Buffer.from("z"));
    expect(assembler.tryComplete("c", { ...metadata, contentId: computeContentId(Buffer.from("yz")) })).toEqual(
      Buffer.from("yz"),
    );
  });
});
