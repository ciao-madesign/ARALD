import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, Priority, createPacket, encodePacket } from "../../node/src/packet.js";
import { Identity } from "../../node/src/identity.js";

/**
 * publishContent()'s new `announce` option (spec §25, push counterpart to
 * the pull-based CONTENT_QUERY cycle) — prerequisite shared by the
 * "Nomad News evoluto" and messaging sub-application proposals evaluated in
 * docs/next-steps.md. Connections are all made *before* publishing in every
 * test here specifically so that catalog sync (a one-time, connection-time
 * exchange — see startCatalogSync(), node.ts) has no later opportunity to
 * account for propagation: whatever a remote node learns after that point
 * can only be explained by CONTENT_ANNOUNCE itself.
 */

function makeNode(displayName: string): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 15): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("CONTENT_ANNOUNCE (publishContent's announce option)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("reaches a node two hops away immediately, without a new connection or an explicit query", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a, b, c].map(({ node }) => node.start()));

    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });
    // Nothing published yet, so the connection-time catalog sync above carried nothing —
    // any propagation observed after this point is CONTENT_ANNOUNCE's doing.

    const data = Buffer.from("bollettino urgente: evacuare zona nord");
    const metadata = a.node.publishContent("bollettino.txt", "text/plain", data, { announce: true, priority: Priority.EMERGENCY });

    await waitFor(() => c.node.remoteCatalog.has(metadata.contentId));
    expect(c.node.remoteCatalog.get(metadata.contentId)?.name).toBe("bollettino.txt");
    // Metadata only — the announce never carries bytes, C hasn't fetched the actual content yet.
    expect(c.node.contentStore.has(metadata.contentId)).toBe(false);

    // Retrieval still goes through the normal pull cycle (CONTENT_QUERY -> ... -> CONTENT_COMPLETE).
    const retrieved = await c.node.getContent(metadata.contentId);
    expect(retrieved.toString("utf8")).toBe(data.toString("utf8"));
  });

  it("publishContent() without announce (the default) does not broadcast — every existing caller's behavior is unchanged", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a, b, c].map(({ node }) => node.start()));

    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });

    const data = Buffer.from("contenuto ordinario, mai annunciato");
    const metadata = a.node.publishContent("ordinario.txt", "text/plain", data); // no options — today's default

    await new Promise((resolve) => setTimeout(resolve, 200)); // time for a broadcast to have arrived, if there were one
    expect(b.node.remoteCatalog.has(metadata.contentId)).toBe(false);
    expect(c.node.remoteCatalog.has(metadata.contentId)).toBe(false);

    // Still discoverable the normal way (pull), proving nothing else regressed.
    const retrieved = await c.node.getContent(metadata.contentId, { timeoutMs: 2000 });
    expect(retrieved.toString("utf8")).toBe(data.toString("utf8"));
  });

  it("a well-formed but forged CONTENT_ANNOUNCE (invalid signature) is never recorded", async () => {
    // malformed-packet-robustness.test.ts covers missing/wrong-shaped payloads for this handler;
    // this covers the other half of "never trust a forged claim" — a payload that *is* the right
    // shape but whose signature doesn't verify (an attacker claiming to be a publisher it isn't).
    const victim = makeNode("victim");
    nodes.push(victim.node);
    await victim.node.start();

    const attacker = Identity.generate();
    const socket: Socket = createConnection({ host: "127.0.0.1", port: victim.transport.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: attacker.nodeId, payload: {} })));

    const forgedMetadata = {
      contentId: "forged-content-id",
      name: "bollettino falso",
      mimeType: "text/plain",
      size: 10,
      createdAt: Date.now(),
      publisherId: attacker.nodeId,
      signature: "0".repeat(128), // well-formed hex shape, not an actual signature over this payload
    };
    socket.write(
      encodePacket(
        createPacket({ type: MessageType.CONTENT_ANNOUNCE, source: attacker.nodeId, payload: { metadata: forgedMetadata } }),
      ),
    );

    // Prove the node is still alive and processed the packet (rather than the absence just being
    // "hasn't gotten there yet") by round-tripping a PING afterward.
    const pinged = new Promise<void>((resolve) => victim.node.once("ping", () => resolve()));
    socket.write(encodePacket(createPacket({ type: MessageType.PING, source: attacker.nodeId, payload: {} })));
    await pinged;

    expect(victim.node.remoteCatalog.has(forgedMetadata.contentId)).toBe(false);
    socket.destroy();
  });
});
