import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";

/**
 * `messageHistory` bounds conversation count and messages-per-conversation
 * (message-history.ts), but neither of those bounds an individual message's
 * *text length* — that's `MAX_MESSAGE_TEXT_LENGTH`, enforced by
 * `extractChatText()` (node.ts), the one gate both `sendPrivateMessage()`
 * (outgoing) and `handlePrivateMessage()` (incoming) funnel through. Unlike
 * `web-ui.ts`'s `POST /api/messages` validation — which only ever sees
 * messages *this* node originates via its own HTTP API — a connected peer
 * can call `sendPrivateMessage()` directly (or send a raw PRIVATE_MESSAGE
 * packet) with an arbitrarily large `text`, up to the transport's own
 * MAX_LINE_BYTES packet ceiling, bypassing that HTTP layer entirely. This
 * covers that network-receive (and matching send) path directly, using two
 * real connected nodes rather than a raw socket, since the point here is
 * the *content* of a legitimately-encrypted/decrypted message, not forgery.
 */
describe("chat message text length bound (extractChatText / MAX_MESSAGE_TEXT_LENGTH)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  async function makeConnectedPair(): Promise<{ a: NomadNode; b: NomadNode }> {
    const a = new NomadNode({ displayName: "A" });
    const b = new NomadNode({ displayName: "B" });
    const aTransport = new TcpTransport(a.nodeId, 0);
    const bTransport = new TcpTransport(b.nodeId, 0);
    a.addTransport(aTransport);
    b.addTransport(bTransport);
    nodes.push(a, b);
    await Promise.all([a.start(), b.start()]);
    await a.connect({ host: "127.0.0.1", port: bTransport.port });
    await Promise.all([a.waitForPeerKey(b.nodeId), b.waitForPeerKey(a.nodeId)]);
    return { a, b };
  }

  it("delivers an oversized message normally but records it in neither party's history", async () => {
    const { a, b } = await makeConnectedPair();
    const oversized = "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1);

    const received = new Promise<unknown>((resolve) => b.once("private-message", (packet) => resolve(packet.payload)));
    a.sendPrivateMessage(b.nodeId, { text: oversized });
    const payload = (await received) as { text?: string };

    // Delivery/decryption itself is unaffected — this is purely a "not a chat message" classification.
    expect(payload.text).toBe(oversized);

    expect(a.messageHistory.get(b.nodeId)).toEqual([]);
    expect(b.messageHistory.get(a.nodeId)).toEqual([]);
  });

  it("records a message exactly at the length limit", async () => {
    const { a, b } = await makeConnectedPair();
    const atLimit = "x".repeat(MAX_MESSAGE_TEXT_LENGTH);

    const received = new Promise<void>((resolve) => b.once("private-message", () => resolve()));
    a.sendPrivateMessage(b.nodeId, { text: atLimit });
    await received;

    expect(a.messageHistory.get(b.nodeId).map((m) => m.text)).toEqual([atLimit]);
    expect(b.messageHistory.get(a.nodeId).map((m) => m.text)).toEqual([atLimit]);
  });
});
