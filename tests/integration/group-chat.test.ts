import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { Identity } from "../../node/src/identity.js";
import { signGroupMessage, generateGroupKey } from "../../node/src/groups.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";

/**
 * End-to-end encrypted group chat (`NomadNode.createGroup()`/`sendGroupMessage()`,
 * `node/src/groups.ts`, docs/next-steps.md Opzione J). Unit-level payload
 * validation/signature/decryption is covered in `tests/unit/groups.test.ts`
 * — this file exercises the real network path: invite delivery over
 * `PRIVATE_MESSAGE`, `GROUP_MESSAGE` broadcast/multi-hop delivery, and —
 * the property that actually matters for "encrypted" — that a node outside
 * the group receives the ciphertext but can never read it.
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

describe("Encrypted group chat (createGroup / sendGroupMessage)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("creates a group, delivers the invite, and a message reaches a member two hops away — while a non-member never learns a thing", async () => {
    const a = makeNode("A"); // creator
    const b = makeNode("B"); // member, 1 hop from A
    const c = makeNode("C"); // member, 2 hops from A (via B)
    const outsider = makeNode("Outsider"); // not a member, connected directly to A
    nodes.push(a.node, b.node, c.node, outsider.node);
    await Promise.all([a, b, c, outsider].map(({ node }) => node.start()));

    // B<->C connect (and sync identities) FIRST, then A<->B — IDENTITY_REQUEST/RESPONSE (node.ts) is
    // a one-shot exchange at connection time, never retroactively re-announced to an already-connected
    // peer (see PrivateMessagePayload's doc comment in node.ts), so this ordering is what lets B's
    // reply to A's own IDENTITY_REQUEST include an entry for C that B already knows by then —
    // otherwise A would never learn C's key transitively at all.
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });
    await Promise.all([b.node.waitForPeerKey(c.node.nodeId), c.node.waitForPeerKey(b.node.nodeId)]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await a.node.connect({ host: "127.0.0.1", port: outsider.transport.port });
    await Promise.all([
      a.node.waitForPeerKey(b.node.nodeId),
      b.node.waitForPeerKey(a.node.nodeId),
      a.node.waitForPeerKey(outsider.node.nodeId),
      outsider.node.waitForPeerKey(a.node.nodeId),
      // A needs C's key too, to invite it directly (the invite is a 1:1 PRIVATE_MESSAGE, not itself
      // multi-hop-routed through B) — learned transitively via IDENTITY_RESPONSE from B, per above.
      a.node.waitForPeerKey(c.node.nodeId),
    ]);

    const info = a.node.createGroup("Escursione", [b.node.nodeId, c.node.nodeId]);
    expect(info.members.sort()).toEqual([b.node.nodeId, c.node.nodeId].sort());
    // The creator's own group state is recorded synchronously, no round trip needed.
    expect(a.node.groups.getGroup(info.groupId)).toBeDefined();

    await waitFor(() => b.node.groups.getGroup(info.groupId) !== undefined);
    await waitFor(() => c.node.groups.getGroup(info.groupId) !== undefined);

    const sent = a.node.sendGroupMessage(info.groupId, "ci vediamo al rifugio alle 15");
    // Sender's own history updates synchronously, same as publishChannelMessage()/sendPrivateMessage().
    expect(a.node.groups.getMessages(info.groupId)).toEqual([sent]);

    await waitFor(() => b.node.groups.getMessages(info.groupId).length === 1);
    await waitFor(() => c.node.groups.getMessages(info.groupId).length === 1); // 2 hops away

    expect(b.node.groups.getMessages(info.groupId)[0].text).toBe("ci vediamo al rifugio alle 15");
    expect(c.node.groups.getMessages(info.groupId)[0].text).toBe("ci vediamo al rifugio alle 15");
    expect(c.node.groups.getMessages(info.groupId)[0].senderId).toBe(a.node.nodeId);

    // The outsider is directly connected to A (one hop) — it necessarily receives the broadcast
    // GROUP_MESSAGE packet — but was never invited, so it has no group key and no group at all.
    await new Promise((resolve) => setTimeout(resolve, 200)); // time for it to have arrived and been (silently) dropped
    expect(outsider.node.groups.getGroup(info.groupId)).toBeUndefined();
    expect(outsider.node.groups.getMessages(info.groupId)).toEqual([]);
  });

  it("createGroup() throws and sends nothing if a member's encryption key isn't known yet", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();

    const strangerId = Identity.generate().nodeId; // never connected, key never learned
    expect(() => a.node.createGroup("Gruppo", [strangerId])).toThrow(/encryption key/);
    expect(a.node.groups.listGroups()).toEqual([]);
  });

  it("createGroup() rejects an empty name or a member list with no one else in it", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();

    expect(() => a.node.createGroup("", [Identity.generate().nodeId])).toThrow(/1-\d+ characters/);
    expect(() => a.node.createGroup("Solo io", [])).toThrow(/at least one other member/);
    expect(() => a.node.createGroup("Solo io", [a.node.nodeId])).toThrow(/at least one other member/); // self filtered out
  });

  it("sendGroupMessage() throws for a group this node doesn't know (never a member, or a typo'd id)", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();

    expect(() => a.node.sendGroupMessage("not-a-real-group", "ciao")).toThrow(/not a known group/);
  });

  it("sendGroupMessage() rejects empty or oversized text without sending anything", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a, b].map(({ node }) => node.start()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await Promise.all([a.node.waitForPeerKey(b.node.nodeId), b.node.waitForPeerKey(a.node.nodeId)]);

    const info = a.node.createGroup("Gruppo", [b.node.nodeId]);
    expect(() => a.node.sendGroupMessage(info.groupId, "")).toThrow(/1-\d+ characters/);
    expect(() => a.node.sendGroupMessage(info.groupId, "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1))).toThrow(/1-\d+ characters/);
    expect(a.node.groups.getMessages(info.groupId)).toEqual([]);
  });

  it("a group invite never gets mistaken for an ordinary 1:1 chat message, and vice versa — no regression on sendPrivateMessage()/handlePrivateMessage()", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a, b].map(({ node }) => node.start()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await Promise.all([a.node.waitForPeerKey(b.node.nodeId), b.node.waitForPeerKey(a.node.nodeId)]);

    const received = new Promise<void>((resolve) => b.node.once("private-message", () => resolve()));
    a.node.sendPrivateMessage(b.node.nodeId, { text: "messaggio normale" });
    await received;

    expect(b.node.messageHistory.get(a.node.nodeId).map((m) => m.text)).toEqual(["messaggio normale"]);
    expect(b.node.groups.listGroups()).toEqual([]); // never misparsed as an invite

    const invited = new Promise<void>((resolve) => b.node.once("group:invited", () => resolve()));
    const info = a.node.createGroup("Gruppo", [b.node.nodeId]);
    await invited;

    expect(b.node.groups.getGroup(info.groupId)).toBeDefined();
    expect(b.node.messageHistory.get(a.node.nodeId).map((m) => m.text)).toEqual(["messaggio normale"]); // unchanged — the invite is not chat text either
  });

  it("a forged GROUP_MESSAGE claiming to be from a different sender than who actually signed it is dropped, never recorded", async () => {
    // Simulates the exact impersonation groupMessageSigningPayload()'s Ed25519 signature exists to
    // prevent (see groups.ts's doc comment): a group member who knows the shared key re-encrypts a
    // message but forges the senderId field to claim it came from someone else in the group.
    const a = makeNode("A"); // creator
    const b = makeNode("B"); // real member, will be impersonated
    const victim = makeNode("Victim"); // real member, receives the forged message
    nodes.push(a.node, b.node, victim.node);
    await Promise.all([a, b, victim].map(({ node }) => node.start()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await a.node.connect({ host: "127.0.0.1", port: victim.transport.port });
    await Promise.all([
      a.node.waitForPeerKey(b.node.nodeId),
      b.node.waitForPeerKey(a.node.nodeId),
      a.node.waitForPeerKey(victim.node.nodeId),
      victim.node.waitForPeerKey(a.node.nodeId),
    ]);

    const info = a.node.createGroup("Gruppo", [b.node.nodeId, victim.node.nodeId]);
    await waitFor(() => victim.node.groups.getGroup(info.groupId) !== undefined);

    // An attacker (not necessarily a real member — the point is the signature alone is what's
    // checked) who somehow obtained the group key encrypts a message and claims to be `b`.
    const attacker = Identity.generate();
    const forgedButClaimingB = { ...signGroupMessage(attacker, info.groupId, info.key, { text: "non sono davvero B", timestamp: Date.now() }), senderId: b.node.nodeId };

    const socket: Socket = createConnection({ host: "127.0.0.1", port: a.transport.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: attacker.nodeId, payload: {} })));
    socket.write(encodePacket(createPacket({ type: MessageType.GROUP_MESSAGE, source: attacker.nodeId, payload: forgedButClaimingB })));

    // Prove the mesh is still alive and actually processed the forged packet, rather than the
    // absence just being "hasn't arrived yet" — a legitimate message from A right after it.
    a.node.sendGroupMessage(info.groupId, "questo e' vero");
    await waitFor(() => victim.node.groups.getMessages(info.groupId).some((m) => m.text === "questo e' vero"));

    expect(victim.node.groups.getMessages(info.groupId).map((m) => m.text)).toEqual(["questo e' vero"]);
    expect(victim.node.groups.getMessages(info.groupId).some((m) => m.text === "non sono davvero B")).toBe(false);
    socket.destroy();
  });

  it("a GROUP_MESSAGE for an unrelated/unknown groupId is dropped by a real member without affecting its own group's history", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a, b].map(({ node }) => node.start()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await Promise.all([a.node.waitForPeerKey(b.node.nodeId), b.node.waitForPeerKey(a.node.nodeId)]);

    const info = a.node.createGroup("Gruppo", [b.node.nodeId]);
    await waitFor(() => b.node.groups.getGroup(info.groupId) !== undefined);

    const stranger = Identity.generate();
    const unrelated = signGroupMessage(stranger, "f".repeat(32), generateGroupKey(), { text: "per un altro gruppo", timestamp: Date.now() });

    const socket: Socket = createConnection({ host: "127.0.0.1", port: a.transport.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: stranger.nodeId, payload: {} })));
    socket.write(encodePacket(createPacket({ type: MessageType.GROUP_MESSAGE, source: stranger.nodeId, payload: unrelated })));

    a.node.sendGroupMessage(info.groupId, "vero messaggio del gruppo");
    await waitFor(() => b.node.groups.getMessages(info.groupId).length === 1);

    expect(b.node.groups.getMessages(info.groupId).map((m) => m.text)).toEqual(["vero messaggio del gruppo"]);
    socket.destroy();
  });

  it("replaying an already-seen GROUP_MESSAGE payload inside a fresh packet id is not appended twice", async () => {
    // Regression: found by review — SeenCache (routing.ts) dedups broadcast packets by their random
    // per-packet `id`, not by payload content, so a captured GROUP_MESSAGE payload re-wrapped in a
    // new packet id bypasses it entirely. Groups.recordMessage()'s dedup-by-messageId (the sender's
    // own deterministic Ed25519 signature) is what actually stops the *duplicate-storage* half of
    // that — this proves it holds over the real network path, not just the unit-level Groups API.
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a, b].map(({ node }) => node.start()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await Promise.all([a.node.waitForPeerKey(b.node.nodeId), b.node.waitForPeerKey(a.node.nodeId)]);

    const info = a.node.createGroup("Gruppo", [b.node.nodeId]);
    await waitFor(() => b.node.groups.getGroup(info.groupId) !== undefined);

    // Signed once — sent twice, byte-for-byte identical payload (same nonce/ciphertext/signature),
    // each time wrapped in its own brand-new packet id (createPacket() mints a fresh one every call)
    // so SeenCache alone can't tell the two packets apart, exactly what a captured-and-resent packet
    // would look like on the wire. verifyGroupMessage() only ever checks payload.senderId's
    // signature, never packet.source (see groups.ts) — so the connecting socket's own claimed
    // identity is irrelevant here; it's a distinct throwaway one (not A's real node id) specifically
    // so TcpTransport's own same-peer-id connection dedup (tcp-duplicate-connection.test.ts) doesn't
    // collide with A's real, already-established connection to B.
    const relay = Identity.generate();
    const payload = signGroupMessage(a.node.identity, info.groupId, info.key, { text: "solo una volta", timestamp: Date.now() });

    const socket: Socket = createConnection({ host: "127.0.0.1", port: b.transport.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: relay.nodeId, payload: {} })));
    socket.write(encodePacket(createPacket({ type: MessageType.GROUP_MESSAGE, source: relay.nodeId, payload })));
    await waitFor(() => b.node.groups.getMessages(info.groupId).length === 1);

    socket.write(encodePacket(createPacket({ type: MessageType.GROUP_MESSAGE, source: relay.nodeId, payload }))); // the replay

    // Prove B actually processed the replayed packet (rather than the count just not having grown
    // yet) by sending a second, genuinely distinct message right after and waiting for it to land.
    a.node.sendGroupMessage(info.groupId, "questo e' un secondo messaggio vero");
    await waitFor(() => b.node.groups.getMessages(info.groupId).some((m) => m.text === "questo e' un secondo messaggio vero"));

    expect(b.node.groups.getMessages(info.groupId)).toHaveLength(2); // not 3 — the replay never got appended
    socket.destroy();
  });

  it("a forged GroupInvitePayload.createdBy claim is ignored — GroupInfo.createdBy always reflects who actually sent the invite", async () => {
    // Regression: found by review — considerGroupInvite() (node.ts) used to trust the invite
    // payload's own self-declared `createdBy` field for Groups' trust-weighted eviction, instead of
    // the cryptographically-authenticated sender of the PRIVATE_MESSAGE itself. A low-trust contact
    // could forge that field to a highly-trusted node id to make its own throwaway group evict a
    // genuinely trusted one once maxGroups filled up (docs/security.md bug #13's attack class,
    // applied here). This sends a real, validly-decryptable invite but with createdBy forged.
    const attacker = makeNode("Attacker");
    const victim = makeNode("Victim");
    nodes.push(attacker.node, victim.node);
    await Promise.all([attacker, victim].map(({ node }) => node.start()));
    await attacker.node.connect({ host: "127.0.0.1", port: victim.transport.port });
    await Promise.all([attacker.node.waitForPeerKey(victim.node.nodeId), victim.node.waitForPeerKey(attacker.node.nodeId)]);

    const forgedTrustedId = "0".repeat(64); // an arbitrary node id the attacker doesn't control at all
    const invited = new Promise<void>((resolve) => victim.node.once("group:invited", () => resolve()));
    attacker.node.sendPrivateMessage(victim.node.nodeId, {
      type: "group-invite",
      groupId: "a".repeat(32),
      name: "Gruppo fasullo",
      groupKey: generateGroupKey().toString("hex"),
      members: [victim.node.nodeId],
      createdBy: forgedTrustedId, // the forged claim under test
      createdAt: Date.now(),
    });
    await invited;

    const recorded = victim.node.groups.getGroup("a".repeat(32));
    expect(recorded).toBeDefined();
    expect(recorded!.createdBy).toBe(attacker.node.nodeId); // the real, authenticated sender — never the forged claim
    expect(recorded!.createdBy).not.toBe(forgedTrustedId);
  });
});
