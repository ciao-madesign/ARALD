import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";

/**
 * Spec §91-92, "secondo" e "terzo obiettivo tecnico": after a content
 * transfer crosses the mesh once, both the original requester (A) and the
 * relay that carried it (B) end up with a usable local copy — so a later
 * requester (D) can be served even after the original provider (C) is gone.
 */

function makeNode(displayName: string): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

describe("cache and opportunistic replication", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("second objective: a new node (D) gets content from A's cache without reaching the original provider (C)", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });

    const data = Buffer.from("rifugio dolomiti: mappa sentieri");
    const metadata = c.node.publishContent("mappa.txt", "text/plain", data);

    // A retrieves and caches the content the first time.
    await a.node.getContent(metadata.contentId);
    expect(a.node.contentStore.has(metadata.contentId)).toBe(true);

    // C (the original provider) is now shut down entirely.
    await c.node.stop();

    // D connects only to A and asks for the same content.
    const d = makeNode("D");
    nodes.push(d.node);
    await d.node.start();
    await d.node.connect({ host: "127.0.0.1", port: a.transport.port });

    const served = await d.node.getContent(metadata.contentId, { timeoutMs: 1000 });
    expect(served).toEqual(data);
  });

  it("third objective: a relay (B) that passively cached transiting content keeps serving it after the provider (C) is gone", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });

    const data = Buffer.from("bollettino meteo: neve fresca 30cm");
    const metadata = c.node.publishContent("meteo.txt", "text/plain", data);

    // A retrieves the content through B, which relays every CONTENT_CHUNK and
    // therefore has the opportunity to passively reassemble and cache it too.
    await a.node.getContent(metadata.contentId);
    expect(b.node.contentStore.has(metadata.contentId)).toBe(true);

    // The original provider C is now gone.
    await c.node.stop();

    // D connects only to B (not to A, not to C) and asks for the same content.
    const d = makeNode("D");
    nodes.push(d.node);
    await d.node.start();
    await d.node.connect({ host: "127.0.0.1", port: b.transport.port });

    const served = await d.node.getContent(metadata.contentId, { timeoutMs: 1000 });
    expect(served).toEqual(data);
  });
});
