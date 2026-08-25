import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { Identity } from "../../node/src/identity.js";
import { computeContentId, contentSigningPayload, type ContentMetadata } from "../../node/src/content.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";

/**
 * Public (unencrypted) chat channels (`docs/next-steps.md` Opzione J) —
 * `NomadNode.publishChannelMessage()`/`considerChannelMessage()`, built
 * entirely on top of `CONTENT_ANNOUNCE`/catalog sync (already covered
 * generically in `content-announce.test.ts`) and the `chat:<channel>`
 * naming convention (`public-channels.ts`, unit-tested in
 * `tests/unit/public-channels.test.ts`). This file only exercises what's
 * new here: the end-to-end publish -> discover -> fetch -> record flow, and
 * this feature's own defensive posture against a hand-crafted (not
 * `publishContent()`-produced) but validly-signed malformed packet.
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

describe("Public chat channels (publishChannelMessage / considerChannelMessage)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("a message reaches a node two hops away immediately (CONTENT_ANNOUNCE), and the sender sees its own send right away too", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a, b, c].map(({ node }) => node.start()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });

    const sent = a.node.publishChannelMessage("generale", "rifugio raggiunto, tutto bene");

    // The sender's own history is updated synchronously — no round trip needed for its own send.
    expect(a.node.publicChannels.get("generale")).toEqual([sent]);
    expect(sent.author).toBe(a.node.nodeId);
    expect(sent.channel).toBe("generale");

    await waitFor(() => c.node.publicChannels.get("generale").length === 1);
    const received = c.node.publicChannels.get("generale")[0];
    expect(received.text).toBe("rifugio raggiunto, tutto bene");
    expect(received.author).toBe(a.node.nodeId);
    expect(received.contentId).toBe(sent.contentId);
  });

  it("a node that connects *after* the message was published still learns it via catalog sync", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();
    a.node.publishChannelMessage("generale", "pubblicato prima che C si connetta");

    const c = makeNode("C");
    nodes.push(c.node);
    await c.node.start();
    await c.node.connect({ host: "127.0.0.1", port: a.transport.port });

    await waitFor(() => c.node.publicChannels.get("generale").length === 1);
    expect(c.node.publicChannels.get("generale")[0].text).toBe("pubblicato prima che C si connetta");
  });

  it("normalizes the channel name to lowercase before publishing/validating", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();

    const sent = a.node.publishChannelMessage("Generale", "ciao");
    expect(sent.channel).toBe("generale");
    expect(a.node.publicChannels.get("generale")).toHaveLength(1);
    expect(a.node.publicChannels.get("Generale")).toEqual([]); // not case-insensitive lookup — normalized once, at write time
  });

  it("rejects an invalid channel name, empty text, or oversized text without publishing anything", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();

    expect(() => a.node.publishChannelMessage("has spaces", "ciao")).toThrow(/invalid channel name/);
    expect(() => a.node.publishChannelMessage("zona/nord", "ciao")).toThrow(/invalid channel name/);
    expect(() => a.node.publishChannelMessage("a".repeat(33), "ciao")).toThrow(/invalid channel name/);
    expect(() => a.node.publishChannelMessage("generale", "")).toThrow(/1-\d+ characters/);
    expect(() => a.node.publishChannelMessage("generale", "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1))).toThrow(/1-\d+ characters/);

    expect(a.node.publicChannels.list()).toEqual([]);
  });

  it("keeps distinct channels separate", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();

    a.node.publishChannelMessage("zona-nord", "nord");
    a.node.publishChannelMessage("zona-sud", "sud");

    expect(a.node.publicChannels.get("zona-nord").map((m) => m.text)).toEqual(["nord"]);
    expect(a.node.publicChannels.get("zona-sud").map((m) => m.text)).toEqual(["sud"]);
  });

  it("content not named chat:<channel> is never mistaken for a channel message", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a, b].map(({ node }) => node.start()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });

    a.node.publishContent("ordinario.txt", "text/plain", Buffer.from("non e' un messaggio di canale"), { announce: true });
    a.node.publishChannelMessage("generale", "questo si'");

    await waitFor(() => b.node.publicChannels.get("generale").length === 1);
    // Only the real channel message ever shows up anywhere in publicChannels.
    expect(b.node.publicChannels.list()).toEqual(["generale"]);
  });

  it("a validly-signed but malformed CONTENT_ANNOUNCE (non-string name) is rejected, never crashes the node", async () => {
    // verifyContentSignature() only proves the signature matches whatever bytes were signed — it
    // never checks that ContentMetadata.name is actually a string (found during this feature's own
    // development, see public-channels.ts's parseChannelFromContentName() doc comment). A
    // hand-crafted signer (not publishContent() itself) can produce exactly this shape.
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

    const data = Buffer.from("whatever");
    const forgedFields = {
      contentId: computeContentId(data),
      name: 12345 as unknown as string, // not a string — the actual defect under test
      mimeType: "application/json",
      size: data.length,
      publisherId: attacker.nodeId,
      expiresAt: undefined,
    };
    const signature = attacker.sign(contentSigningPayload(forgedFields)).toString("hex");
    const forgedMetadata: ContentMetadata = { ...forgedFields, createdAt: Date.now(), signature };

    socket.write(
      encodePacket(createPacket({ type: MessageType.CONTENT_ANNOUNCE, source: attacker.nodeId, payload: { metadata: forgedMetadata } })),
    );

    // Prove the node is still alive and processed the packet, rather than the absence just being
    // "hasn't gotten there yet" — same pattern as content-announce.test.ts's own forged-signature test.
    const pinged = new Promise<void>((resolve) => victim.node.once("ping", () => resolve()));
    socket.write(encodePacket(createPacket({ type: MessageType.PING, source: attacker.nodeId, payload: {} })));
    await pinged;

    expect(victim.node.publicChannels.list()).toEqual([]);
    socket.destroy();
  });

  it("fetched bytes that don't parse as a chat message ({ text: string }) are silently ignored, never recorded", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a, b].map(({ node }) => node.start()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });

    // Published directly (bypassing publishChannelMessage()'s own validation) with a name that
    // matches the channel convention but a body that isn't { text: string } — e.g. a node that
    // published something else under a name that happens to collide, or a hostile publisher.
    const metadata = a.node.publishContent("chat:generale", "application/json", Buffer.from(JSON.stringify({ notText: 123 }), "utf8"), {
      announce: true,
    });

    await waitFor(() => b.node.remoteCatalog.has(metadata.contentId));
    await new Promise((resolve) => setTimeout(resolve, 200)); // time for the (failed) fetch+parse to have happened
    expect(b.node.publicChannels.get("generale")).toEqual([]);
  });

  it("caps how many CONTENT_QUERY floods a burst of chat: entries can trigger, instead of self-originating one per entry unthrottled", async () => {
    // Regression: found by review — considerChannelMessage() used to call getContent() (which
    // floods a CONTENT_QUERY for any content id not already held) unconditionally for every accepted
    // chat:-named entry. rate-limit.ts only gates packets this node *receives*, never ones it
    // originates itself via floodExcept() — so a single attacker announcing many distinct fake
    // "chat:<channel>" entries (all signed by the same throwaway identity; no need for a fresh one
    // per entry, only distinct content ids) could make this node self-originate one CONTENT_QUERY
    // flood per entry, completely unthrottled. Same amplification class docs/security.md #39 already
    // closed for NewsGateway's own outbound CONTENT_ANNOUNCEs, reintroduced here on the reactive side.
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

    // Accumulated into one buffer and counted only once, at the end — counting matches per-chunk as
    // they arrive would risk undercounting if a TCP chunk boundary happened to split the literal
    // string "type":"CONTENT_QUERY" across two 'data' events (found by review).
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));

    const BURST_SIZE = 30;
    for (let i = 0; i < BURST_SIZE; i++) {
      const data = Buffer.from(`fake content ${i}`);
      const fields = {
        contentId: computeContentId(data),
        name: `chat:burst-${i}`,
        mimeType: "application/json",
        size: data.length,
        publisherId: attacker.nodeId,
        expiresAt: undefined,
      };
      const signature = attacker.sign(contentSigningPayload(fields)).toString("hex");
      const metadata: ContentMetadata = { ...fields, createdAt: Date.now(), signature };
      socket.write(encodePacket(createPacket({ type: MessageType.CONTENT_ANNOUNCE, source: attacker.nodeId, payload: { metadata } })));
    }

    await new Promise((resolve) => setTimeout(resolve, 300)); // time for all 30 announces to be processed
    const received = Buffer.concat(chunks).toString("utf8");
    const queryCount = (received.match(/"type":"CONTENT_QUERY"/g) ?? []).length;
    expect(queryCount).toBeGreaterThan(0); // the guard doesn't silently drop everything...
    expect(queryCount).toBeLessThan(BURST_SIZE); // ...but caps well below the burst size...
    expect(queryCount).toBeLessThanOrEqual(16); // ...specifically at MAX_CONCURRENT_CHANNEL_FETCHES (node.ts)

    socket.destroy();
  });

  it("the recorded timestamp matches the one actually embedded in the published payload bytes, on both the sender's and a receiving node's copy", async () => {
    // Regression context: found by review — ContentMetadata.createdAt is NOT part of what a
    // publisher's signature covers (content.ts's SignableContentFields excludes it), so it can be
    // rewritten by a relay without invalidating verifyContentSignature(). The fix moved the message
    // timestamp into the *signed payload bytes* themselves (ChannelMessagePayload.timestamp) instead
    // of trusting ContentMetadata.createdAt — this proves the wiring end-to-end: what
    // publishChannelMessage() records locally, what's actually inside the published bytes, and what
    // a receiving node fetches+records all agree. (Fully proving resistance to a tampered
    // ContentMetadata.createdAt in flight would need simulating the whole CONTENT_QUERY ->
    // CONTENT_FOUND -> CONTENT_REQUEST -> CONTENT_CHUNK -> CONTENT_COMPLETE exchange at the raw
    // packet level — disproportionate for what's a display-ordering spoof, not a text/identity
    // forgery; extractChannelMessagePayload()'s own unit tests, tests/unit/public-channels.test.ts,
    // cover that it never reads anything from ContentMetadata.)
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a, b].map(({ node }) => node.start()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });

    const sent = a.node.publishChannelMessage("generale", "messaggio originale");
    const publishedBytes = await a.node.getContent(sent.contentId, { timeoutMs: 2000 });
    const embeddedPayload = JSON.parse(publishedBytes.toString("utf8"));
    expect(embeddedPayload.timestamp).toBe(sent.timestamp);

    await waitFor(() => b.node.publicChannels.get("generale").length === 1);
    expect(b.node.publicChannels.get("generale")[0].timestamp).toBe(sent.timestamp);
  });
});
