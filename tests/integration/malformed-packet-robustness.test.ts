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
});
