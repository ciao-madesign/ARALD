import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { Identity } from "../../node/src/identity.js";

/**
 * decodePacket() only validates the packet envelope (id/type/source/ttl) —
 * `payload` is untyped, arbitrary JSON from the network. Every handler that
 * destructures or iterates a specific payload shape (ROUTE_ANNOUNCE's
 * `routes`, IDENTITY_RESPONSE's `announcements`, PRIVATE_MESSAGE's
 * `senderAnnouncement`, ...) must tolerate that shape being missing or
 * malformed rather than throwing — an uncaught exception there would crash
 * the whole node process from a single hostile (or just buggy) peer.
 */
describe("malformed packet payloads never crash the node", () => {
  let victim: NomadNode | undefined;
  let attackerSocket: Socket | undefined;

  afterEach(async () => {
    attackerSocket?.destroy();
    if (victim) await victim.stop();
    victim = undefined;
    attackerSocket = undefined;
  });

  async function connectAttacker(port: number, attackerId: string): Promise<Socket> {
    const socket = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: attackerId, payload: {} })));
    return socket;
  }

  async function expectSurvives(type: MessageType, payload: unknown): Promise<void> {
    victim = new NomadNode({ displayName: "victim" });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    const attacker = Identity.generate();
    attackerSocket = await connectAttacker(victimTransport.port, attacker.nodeId);
    attackerSocket.write(encodePacket(createPacket({ type, source: attacker.nodeId, destination: victim.nodeId, payload })));

    // Give the malformed packet a moment to be processed, then prove the node is still alive and
    // correctly handling a completely unrelated, well-formed packet — a crash from the malformed
    // one would have brought the whole process (and this test) down with it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pinged = new Promise<void>((resolve) => victim!.once("ping", () => resolve()));
    attackerSocket.write(
      encodePacket(createPacket({ type: MessageType.PING, source: attacker.nodeId, destination: victim!.nodeId, payload: {} })),
    );
    await pinged;
  }

  it("survives a PRIVATE_MESSAGE with no payload fields at all", () => expectSurvives(MessageType.PRIVATE_MESSAGE, {}));
  it("survives a PRIVATE_MESSAGE with a null senderAnnouncement", () =>
    expectSurvives(MessageType.PRIVATE_MESSAGE, { senderAnnouncement: null }));
  it("survives a ROUTE_ANNOUNCE with a missing routes array", () => expectSurvives(MessageType.ROUTE_ANNOUNCE, {}));
  it("survives a ROUTE_ANNOUNCE with a routes array of garbage entries", () =>
    expectSurvives(MessageType.ROUTE_ANNOUNCE, { routes: [null, 42, "nope", { destination: 7 }, { destination: "x", cost: "not-a-number" }] }));
  it("survives an IDENTITY_RESPONSE with a missing announcements array", () =>
    expectSurvives(MessageType.IDENTITY_RESPONSE, {}));
  it("survives an IDENTITY_RESPONSE with a garbage announcements array", () =>
    expectSurvives(MessageType.IDENTITY_RESPONSE, { announcements: [null, 42, "nope"] }));
  it("survives an IDENTITY_REQUEST with a malformed knownNodeIds field", () =>
    expectSurvives(MessageType.IDENTITY_REQUEST, { knownNodeIds: 42 }));
  it("survives a SYNC_REQUEST with a malformed knownContentIds field", () =>
    expectSurvives(MessageType.SYNC_REQUEST, { knownContentIds: 42 }));
  it("survives a SYNC_RESPONSE with a missing entries array", () => expectSurvives(MessageType.SYNC_RESPONSE, {}));
  it("survives a SYNC_RESPONSE with a garbage entries array", () =>
    expectSurvives(MessageType.SYNC_RESPONSE, { entries: [null, 42, "nope"] }));
  it("survives a SERVICE_ANNOUNCE with a missing announcement", () => expectSurvives(MessageType.SERVICE_ANNOUNCE, {}));
  it("survives a SERVICE_ANNOUNCE with a garbage announcement", () =>
    expectSurvives(MessageType.SERVICE_ANNOUNCE, { announcement: { serviceId: 42, providerId: null } }));
  it("survives a SERVICE_QUERY with a missing serviceId", () => expectSurvives(MessageType.SERVICE_QUERY, {}));
  it("survives a SERVICE_REQUEST with no payload fields at all — this used to crash the process", () =>
    expectSurvives(MessageType.SERVICE_REQUEST, undefined));
  it("survives a SERVICE_REQUEST with a missing serviceId", () => expectSurvives(MessageType.SERVICE_REQUEST, { payload: {} }));
  it("survives a SERVICE_RESPONSE with no payload fields at all", () => expectSurvives(MessageType.SERVICE_RESPONSE, {}));
  it("survives a SERVICE_RESPONSE with a garbage announcement", () =>
    expectSurvives(MessageType.SERVICE_RESPONSE, { serviceId: "x", announcement: { serviceId: null } }));
  it("survives a GROUP_MESSAGE with no payload fields at all", () => expectSurvives(MessageType.GROUP_MESSAGE, {}));
  it("survives a GROUP_MESSAGE with a garbage groupId/senderId/signature", () =>
    expectSurvives(MessageType.GROUP_MESSAGE, { groupId: 42, senderId: null, nonce: "x", ciphertext: "y", authTag: "z", signature: {} }));
  it("survives a GROUP_MESSAGE with a well-formed-looking but unverifiable signature for a group this node doesn't know", () =>
    expectSurvives(MessageType.GROUP_MESSAGE, {
      groupId: "0".repeat(32),
      senderId: "0".repeat(64),
      nonce: "00".repeat(12),
      ciphertext: "00".repeat(16),
      authTag: "00".repeat(16),
      signature: "00".repeat(64),
    }));

  // CONTENT_* handlers (handleContentQuery/handleContentFound/handleContentNotFound/
  // handleContentRequest/handleContentChunk/handleContentComplete, node.ts) used to access
  // packet.payload fields directly with no guard at all, unlike every handler above — a single
  // malformed packet of any of these six types crashed the process outright. Found by a full
  // code-review pass, not by an incident; see docs/security.md for the corresponding entry.
  it("survives a CONTENT_QUERY with no payload fields at all", () => expectSurvives(MessageType.CONTENT_QUERY, undefined));
  it("survives a CONTENT_QUERY with a non-string contentId", () => expectSurvives(MessageType.CONTENT_QUERY, { contentId: 42 }));
  it("survives a CONTENT_FOUND with no payload fields at all", () => expectSurvives(MessageType.CONTENT_FOUND, undefined));
  it("survives a CONTENT_NOT_FOUND with no payload fields at all", () => expectSurvives(MessageType.CONTENT_NOT_FOUND, undefined));
  it("survives a CONTENT_REQUEST with no payload fields at all", () => expectSurvives(MessageType.CONTENT_REQUEST, undefined));
  it("survives a CONTENT_CHUNK with no payload fields at all", () => expectSurvives(MessageType.CONTENT_CHUNK, undefined));
  it("survives a CONTENT_CHUNK with a non-string data field", () =>
    expectSurvives(MessageType.CONTENT_CHUNK, { contentId: "x", chunkIndex: 0, totalChunks: 1, data: 12345 }));
  it("survives a CONTENT_COMPLETE with no payload fields at all", () => expectSurvives(MessageType.CONTENT_COMPLETE, undefined));
  it("survives a CONTENT_COMPLETE with a null metadata field", () =>
    expectSurvives(MessageType.CONTENT_COMPLETE, { contentId: "x", metadata: null }));
  it("survives a CONTENT_ANNOUNCE with no payload fields at all", () => expectSurvives(MessageType.CONTENT_ANNOUNCE, undefined));
  it("survives a CONTENT_ANNOUNCE with a null metadata field", () => expectSurvives(MessageType.CONTENT_ANNOUNCE, { metadata: null }));
  it("survives a CONTENT_ANNOUNCE with a non-string contentId in metadata", () =>
    expectSurvives(MessageType.CONTENT_ANNOUNCE, { metadata: { contentId: 42, signature: "not-real" } }));
  it("survives a PEER_LIST with a non-array payload", () => expectSurvives(MessageType.PEER_LIST, { not: "an array" }));
  it("survives a PEER_LIST with garbage entries", () => expectSurvives(MessageType.PEER_LIST, [null, 42, "nope", { id: 7 }]));

  // observeRelayedContent() (node.ts) is a second, independent code path for CONTENT_CHUNK/
  // CONTENT_COMPLETE — reached only when this node is *relaying* the packet (destination is some
  // other node), never validated by handleContentChunk/handleContentComplete above since those
  // only run when this node is itself the destination. Needs its own malformed-payload coverage.
  async function expectRelaySurvives(type: MessageType, payload: unknown): Promise<void> {
    victim = new NomadNode({ displayName: "victim" });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    const attacker = Identity.generate();
    attackerSocket = await connectAttacker(victimTransport.port, attacker.nodeId);
    // Addressed to a node the victim has never heard of — decideForward() sets deliverLocally to
    // false, routing this through observeRelayedContent()'s relay-caching path instead of
    // handleContentChunk/handleContentComplete.
    const someOtherNode = Identity.generate().nodeId;
    attackerSocket.write(encodePacket(createPacket({ type, source: attacker.nodeId, destination: someOtherNode, ttl: 8, payload })));

    await new Promise((resolve) => setTimeout(resolve, 100));
    const pinged = new Promise<void>((resolve) => victim!.once("ping", () => resolve()));
    attackerSocket.write(
      encodePacket(createPacket({ type: MessageType.PING, source: attacker.nodeId, destination: victim!.nodeId, payload: {} })),
    );
    await pinged;
  }

  it("survives a relayed CONTENT_CHUNK with no payload fields at all", () =>
    expectRelaySurvives(MessageType.CONTENT_CHUNK, undefined));
  it("survives a relayed CONTENT_CHUNK with a non-string data field", () =>
    expectRelaySurvives(MessageType.CONTENT_CHUNK, { contentId: "x", chunkIndex: 0, totalChunks: 1, data: 12345 }));
  it("survives a relayed CONTENT_COMPLETE with no payload fields at all", () =>
    expectRelaySurvives(MessageType.CONTENT_COMPLETE, undefined));
  it("survives a relayed CONTENT_COMPLETE with a null metadata field", () =>
    expectRelaySurvives(MessageType.CONTENT_COMPLETE, { contentId: "x", metadata: null }));
});
