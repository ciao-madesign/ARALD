import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";

/**
 * "ARALD Content Compression & Optimization" (docs/next-steps.md, docs/security.md): compression
 * happens transparently inside `publishContent()`/`getContent()` — nothing about the mesh
 * transfer, caching, or relay path (exercised at length by `content-retrieval.test.ts`/
 * `content-multi-source-retrieval.test.ts`) needed to change, so this file only exercises the one
 * thing those don't: that a caller of `getContent()` always gets back the original, decompressed
 * bytes, while what's actually stored/transferred on the wire is the smaller, compressed form.
 */

function makeNode(displayName: string): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

describe("content compression, transparent end to end (A fetches from B over a real TCP connection)", () => {
  let a: ReturnType<typeof makeNode>;
  let b: ReturnType<typeof makeNode>;

  beforeEach(async () => {
    a = makeNode("A");
    b = makeNode("B");
    await Promise.all([a.node.start(), b.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
  });

  afterEach(async () => {
    await Promise.all([a.node.stop(), b.node.stop()]);
  });

  it("compresses large repetitive content, and a remote fetcher gets back the exact original bytes", async () => {
    const original = Buffer.from("ARALD mesh network status report. ".repeat(500)); // ~17.5KB, highly compressible
    const metadata = b.node.publishContent("report.txt", "text/plain", original);

    // Publisher's own metadata already reflects the compressed form.
    expect(metadata.encoding).toBe("zstd");
    expect(metadata.originalSize).toBe(original.length);
    expect(metadata.size).toBeLessThan(original.length);

    // What B actually holds locally is the *compressed* bytes, not the original — the point of
    // doing this before chunking/storing, not just before sending.
    const storedOnB = b.node.contentStore.get(metadata.contentId);
    expect(storedOnB?.data.length).toBe(metadata.size);

    // A never had this content; fetches it through the mesh (CONTENT_QUERY -> CONTENT_FOUND ->
    // CONTENT_REQUEST -> CONTENT_CHUNK* -> CONTENT_COMPLETE, same as any other content).
    expect(a.node.contentStore.has(metadata.contentId)).toBe(false);
    const fetched = await a.node.getContent(metadata.contentId);

    // The caller-facing contract: exactly the original bytes, transparently decompressed — never
    // the compressed wire form, and never required to know `encoding` exists at all.
    expect(fetched.equals(original)).toBe(true);

    // A's own cache now also holds the *compressed* form (same bytes that were hashed/signed/
    // chunked/verified) — relaying/caching keeps benefiting from the smaller footprint, it isn't
    // re-inflated the moment it lands.
    const storedOnA = a.node.contentStore.get(metadata.contentId);
    expect(storedOnA?.data.length).toBe(metadata.size);
    expect(storedOnA?.data.length).toBeLessThan(original.length);
  });

  it("a cache hit on the publisher's own node is also decompressed transparently (the other getContent() resolution path)", async () => {
    const original = Buffer.from("ARALD mesh network status report. ".repeat(500));
    const metadata = b.node.publishContent("report2.txt", "text/plain", original);
    expect(metadata.encoding).toBe("zstd"); // sanity: this test only means something if compression kicked in

    // B already has this locally — getContent() resolves from cache, never touches the network.
    const fetched = await b.node.getContent(metadata.contentId);
    expect(fetched.equals(original)).toBe(true);
  });

  it("small/ordinary content is published and fetched exactly as before — no compression attempted, no behavior change", async () => {
    const original = Buffer.from("hello arald");
    const metadata = b.node.publishContent("hello.txt", "text/plain", original);

    expect(metadata.encoding).toBeUndefined();
    expect(metadata.originalSize).toBeUndefined();
    expect(metadata.size).toBe(original.length);

    const fetched = await a.node.getContent(metadata.contentId);
    expect(fetched.equals(original)).toBe(true);
  });

  it("content that would not actually shrink (already high-entropy) is stored uncompressed, never a 'compressed' form that's bigger", async () => {
    // A JPEG-like blob is a reasonable stand-in for "already compressed media" without pulling in
    // a real image — both are high-entropy from zstd's point of view.
    const { randomBytes } = await import("node:crypto");
    const original = randomBytes(2000);
    const metadata = b.node.publishContent("photo.bin", "application/octet-stream", original);

    expect(metadata.encoding).toBeUndefined();
    expect(metadata.size).toBe(original.length);

    const fetched = await a.node.getContent(metadata.contentId);
    expect(fetched.equals(original)).toBe(true);
  });
});
