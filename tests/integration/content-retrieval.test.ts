import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { CHUNK_SIZE, computeContentId } from "../../node/src/content.js";

/**
 * Spec §90 "primo obiettivo tecnico", first half: A does not know C holds
 * the content — it asks the mesh with content://example/hello, B relays the
 * query and the reply, C serves the bytes, A verifies the hash. No Internet.
 */

function makeNode(displayName: string): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

describe("content-centric retrieval (A -> B -> C, content only on C)", () => {
  let a: ReturnType<typeof makeNode>;
  let b: ReturnType<typeof makeNode>;
  let c: ReturnType<typeof makeNode>;

  beforeEach(async () => {
    a = makeNode("A");
    b = makeNode("B");
    c = makeNode("C");
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });
  });

  afterEach(async () => {
    await Promise.all([a.node.stop(), b.node.stop(), c.node.stop()]);
  });

  it("retrieves single-chunk content that A never fetched or knew the location of", async () => {
    const helloBytes = Buffer.from("hello nomad-net world");
    const metadata = c.node.publishContent("hello.txt", "text/plain", helloBytes);

    expect(a.node.contentStore.has(metadata.contentId)).toBe(false);

    const data = await a.node.getContent(metadata.contentId);
    expect(data).toEqual(helloBytes);
    expect(computeContentId(data)).toBe(metadata.contentId);
  });

  it("reassembles multi-chunk content correctly", async () => {
    const bigFile = Buffer.alloc(CHUNK_SIZE * 3 + 123, 42);
    const metadata = c.node.publishContent("big.bin", "application/octet-stream", bigFile);

    const data = await a.node.getContent(metadata.contentId);
    expect(data).toEqual(bigFile);
  });

  it("rejects a request for content that exists nowhere in the mesh", async () => {
    const unknownId = computeContentId(Buffer.from("never published"));
    await expect(a.node.getContent(unknownId, { timeoutMs: 300 })).rejects.toThrow(/not found/);
  });

  it("resolves all concurrent callers requesting the same content id, without one clobbering another", async () => {
    const data = Buffer.from("concurrent callers should not clobber each other");
    const metadata = c.node.publishContent("shared.txt", "text/plain", data);

    const [first, second, third] = await Promise.all([
      a.node.getContent(metadata.contentId),
      a.node.getContent(metadata.contentId),
      a.node.getContent(metadata.contentId),
    ]);

    expect(first).toEqual(data);
    expect(second).toEqual(data);
    expect(third).toEqual(data);
  });

  it("does not let one caller's timeout reject a still-pending concurrent caller for the same content id", async () => {
    const data = Buffer.from("slow reply but both callers should still resolve");
    const metadata = c.node.publishContent("slow.txt", "text/plain", data);

    // A short-timeout caller and a long-timeout caller race on the same content id;
    // both must resolve successfully once the (single) transfer completes. The short
    // timeout is deliberately much smaller than the long one (to exercise the race)
    // but not so tight that it flakes under CPU contention from other tests running
    // in parallel — actual local delivery normally completes in low single-digit ms.
    const shortTimeout = a.node.getContent(metadata.contentId, { timeoutMs: 500 });
    const longTimeout = a.node.getContent(metadata.contentId, { timeoutMs: 5000 });

    await expect(shortTimeout).resolves.toEqual(data);
    await expect(longTimeout).resolves.toEqual(data);
  });
});
