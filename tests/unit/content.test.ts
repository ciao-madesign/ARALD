import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, ChunkAssembler, ContentStore, computeContentId } from "../../node/src/content.js";

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
});
