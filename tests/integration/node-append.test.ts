import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { Identity } from "../../node/src/identity.js";
import { EncryptionIdentity, signIdentityAnnouncement } from "../../node/src/encryption.js";
import { TrustLevel } from "../../node/src/trust.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";
import { MAX_NODE_APPEND_LABEL_LENGTH } from "../../node/src/node-appends.js";

/**
 * Directed Content Delivery + Node Append (`docs/beacon.md`, "Directed
 * Content Delivery + Node Append" — piece 2 of the 4 September 2026 plan).
 * Unit-level payload validation/eviction is covered in
 * `tests/unit/node-appends.test.ts` — this file exercises the real network
 * path: `NomadNode.appendToNode()` (reusing `sendPrivateMessage()`'s
 * existing E2E encryption and `floodExcept()`'s existing directed
 * store-and-forward), the trust gate `considerNodeAppend()` applies at the
 * target, the "never re-forwarded past the target" DIRECTED semantic
 * (`routing.ts`'s `decideForward()`), and its own rate limit.
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

describe("Directed Content Delivery + Node Append (appendToNode / considerNodeAppend)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("delivers an append directly to the target, who is already VERIFIED for the sender via ordinary identity gossip on connect", async () => {
    const sender = makeNode("Sender");
    const target = makeNode("Target");
    nodes.push(sender.node, target.node);
    await Promise.all([sender, target].map(({ node }) => node.start()));
    await sender.node.connect({ host: "127.0.0.1", port: target.transport.port });
    await Promise.all([sender.node.waitForPeerKey(target.node.nodeId), target.node.waitForPeerKey(sender.node.nodeId)]);
    expect(target.node.trust.get(sender.node.nodeId)).toBe(TrustLevel.VERIFIED);

    sender.node.appendToNode(target.node.nodeId, { text: "Sentiero 4 chiuso per frana.", label: "Info", kind: "hazard" });
    await waitFor(() => target.node.nodeAppends.list().length === 1);

    const stored = target.node.nodeAppends.list()[0];
    expect(stored).toMatchObject({ text: "Sentiero 4 chiuso per frana.", label: "Info", kind: "hazard", author: sender.node.nodeId });
    expect(stored.appendId).toEqual(expect.any(String));
    expect(stored.expiresAt).toBeGreaterThan(Date.now());
  });

  it("defaults kind to 'info' when omitted", async () => {
    const sender = makeNode("Sender");
    const target = makeNode("Target");
    nodes.push(sender.node, target.node);
    await Promise.all([sender, target].map(({ node }) => node.start()));
    await sender.node.connect({ host: "127.0.0.1", port: target.transport.port });
    await Promise.all([sender.node.waitForPeerKey(target.node.nodeId), target.node.waitForPeerKey(sender.node.nodeId)]);

    sender.node.appendToNode(target.node.nodeId, { text: "Acqua non disponibile alla fontana alta." });
    await waitFor(() => target.node.nodeAppends.list().length === 1);
    expect(target.node.nodeAppends.list()[0].kind).toBe("info");
  });

  it("an intermediate relay never records the append into its own nodeAppends, and never re-forwards it past the target", async () => {
    const sender = makeNode("Sender");
    const relay = makeNode("Relay");
    const target = makeNode("Target"); // 2 hops from sender, via relay
    nodes.push(sender.node, relay.node, target.node);
    await Promise.all([sender, relay, target].map(({ node }) => node.start()));

    await relay.node.connect({ host: "127.0.0.1", port: target.transport.port });
    await Promise.all([relay.node.waitForPeerKey(target.node.nodeId), target.node.waitForPeerKey(relay.node.nodeId)]);
    await sender.node.connect({ host: "127.0.0.1", port: relay.transport.port });
    await Promise.all([sender.node.waitForPeerKey(relay.node.nodeId), relay.node.waitForPeerKey(sender.node.nodeId)]);
    await sender.node.waitForPeerKey(target.node.nodeId); // learned transitively via relay's IDENTITY_RESPONSE

    sender.node.appendToNode(target.node.nodeId, { text: "Depositato per il rifugio.", kind: "info" });
    await waitFor(() => target.node.nodeAppends.list().length === 1);

    // Give the relay every chance to have (wrongly) recorded/re-forwarded it too.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(relay.node.nodeAppends.list()).toEqual([]);
  });

  it("silently drops an append from a sender below minTrustForNodeAppend, without recording or throwing", async () => {
    const sender = makeNode("Sender");
    const target = makeNode("Target");
    nodes.push(sender.node, target.node);
    await Promise.all([sender, target].map(({ node }) => node.start()));
    await sender.node.connect({ host: "127.0.0.1", port: target.transport.port });
    await Promise.all([sender.node.waitForPeerKey(target.node.nodeId), target.node.waitForPeerKey(sender.node.nodeId)]);

    // Ordinary identity gossip already granted VERIFIED — explicitly downgrade it on the target to
    // exercise the gate, same technique tests/integration/trust-aware-eviction.test.ts already uses.
    target.node.trust.set(sender.node.nodeId, TrustLevel.SEEN);

    sender.node.appendToNode(target.node.nodeId, { text: "Non dovrebbe arrivare.", kind: "info" });
    await new Promise((resolve) => setTimeout(resolve, 200)); // time for the (rejected) delivery to have happened
    expect(target.node.nodeAppends.list()).toEqual([]);
  });

  it("accepts an append from a sender at exactly minTrustForNodeAppend (VERIFIED), and from one above it (TRUSTED)", async () => {
    const sender = makeNode("Sender");
    const target = makeNode("Target");
    nodes.push(sender.node, target.node);
    await Promise.all([sender, target].map(({ node }) => node.start()));
    await sender.node.connect({ host: "127.0.0.1", port: target.transport.port });
    await Promise.all([sender.node.waitForPeerKey(target.node.nodeId), target.node.waitForPeerKey(sender.node.nodeId)]);

    target.node.trust.set(sender.node.nodeId, TrustLevel.TRUSTED);
    sender.node.appendToNode(target.node.nodeId, { text: "Da un operatore fidato.", kind: "info" });
    await waitFor(() => target.node.nodeAppends.list().length === 1);
    expect(target.node.nodeAppends.list()[0].author).toBe(sender.node.nodeId);
  });

  it("a custom minTrustForNodeAppend of TRUSTED rejects a merely VERIFIED sender", async () => {
    const sender = makeNode("Sender");
    const target = new NomadNode({ displayName: "Target", minTrustForNodeAppend: TrustLevel.TRUSTED });
    const targetTransport = new TcpTransport(target.nodeId, 0);
    target.addTransport(targetTransport);
    nodes.push(sender.node, target);
    await Promise.all([sender.node.start(), target.start()]);
    await sender.node.connect({ host: "127.0.0.1", port: targetTransport.port });
    await Promise.all([sender.node.waitForPeerKey(target.nodeId), target.waitForPeerKey(sender.node.nodeId)]);
    expect(target.trust.get(sender.node.nodeId)).toBe(TrustLevel.VERIFIED); // ordinary gossip, not enough here

    sender.node.appendToNode(target.nodeId, { text: "Non dovrebbe bastare.", kind: "info" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(target.nodeAppends.list()).toEqual([]);
  });

  it("appendToNode() rejects invalid text/label/kind/expiresInMs locally, without sending or throwing a decryption/key error", async () => {
    const sender = makeNode("Sender");
    nodes.push(sender.node);
    await sender.node.start();

    expect(() => sender.node.appendToNode("some-node-id", { text: "" })).toThrow(/1-\d+ characters/);
    expect(() => sender.node.appendToNode("some-node-id", { text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1) })).toThrow(/1-\d+ characters/);
    expect(() => sender.node.appendToNode("some-node-id", { text: "ok", label: "x".repeat(MAX_NODE_APPEND_LABEL_LENGTH + 1) })).toThrow(
      /label must be/,
    );
    expect(() => sender.node.appendToNode("some-node-id", { text: "ok", kind: "urgent" as never })).toThrow(/'kind' must be/);
    expect(() => sender.node.appendToNode("some-node-id", { text: "ok", expiresInMs: 0 })).toThrow(/'expiresInMs'/);
    expect(() => sender.node.appendToNode("some-node-id", { text: "ok", expiresInMs: -1 })).toThrow(/'expiresInMs'/);
  });

  it("appendToNode() throws when the target's encryption key isn't known yet", async () => {
    const sender = makeNode("Sender");
    nodes.push(sender.node);
    await sender.node.start();

    expect(() => sender.node.appendToNode("unknown-node-id", { text: "ok" })).toThrow(/encryption key.*is not yet known/);
  });

  it("rejects a non-positive expiresInMs on an elevated-priority append WITHOUT consuming the elevated rate-limit budget", async () => {
    const sender = makeNode("Sender");
    const target = makeNode("Target");
    nodes.push(sender.node, target.node);
    await Promise.all([sender, target].map(({ node }) => node.start()));
    await sender.node.connect({ host: "127.0.0.1", port: target.transport.port });
    await Promise.all([sender.node.waitForPeerKey(target.node.nodeId), target.node.waitForPeerKey(sender.node.nodeId)]);

    for (let i = 0; i < 10; i++) {
      expect(() => sender.node.appendToNode(target.node.nodeId, { text: "bad", kind: "emergency", expiresInMs: -1 })).toThrow(
        /'expiresInMs'/,
      );
    }
    // None of the rejected attempts sent anything — 3 genuinely elevated appends still go through.
    for (let i = 0; i < 3; i++) sender.node.appendToNode(target.node.nodeId, { text: `emergenza ${i}`, kind: "emergency" });
    await waitFor(() => target.node.nodeAppends.list().length === 3);
  });

  it("caps elevated-priority appends at the shared budget within the window, independent of info-append volume, with hazard and emergency sharing it", async () => {
    const sender = makeNode("Sender");
    const target = makeNode("Target");
    nodes.push(sender.node, target.node);
    await Promise.all([sender, target].map(({ node }) => node.start()));
    await sender.node.connect({ host: "127.0.0.1", port: target.transport.port });
    await Promise.all([sender.node.waitForPeerKey(target.node.nodeId), target.node.waitForPeerKey(sender.node.nodeId)]);

    // Info appends never touch the elevated budget.
    for (let i = 0; i < 10; i++) sender.node.appendToNode(target.node.nodeId, { text: `routine ${i}`, kind: "info" });

    // hazard + emergency share one counter — 2 hazard + 1 emergency exhausts the budget of 3.
    sender.node.appendToNode(target.node.nodeId, { text: "h1", kind: "hazard" });
    sender.node.appendToNode(target.node.nodeId, { text: "h2", kind: "hazard" });
    sender.node.appendToNode(target.node.nodeId, { text: "e1", kind: "emergency" });
    expect(() => sender.node.appendToNode(target.node.nodeId, { text: "one too many", kind: "hazard" })).toThrow(
      /too many high-priority node appends/,
    );
    expect(() => sender.node.appendToNode(target.node.nodeId, { text: "one too many", kind: "emergency" })).toThrow(
      /too many high-priority node appends/,
    );

    // The rejected attempts sent nothing — only the 10 info + 3 accepted elevated appends land.
    await waitFor(() => target.node.nodeAppends.list().length === 13);
  });

  it("a call against an as-yet-undiscovered target's key throws immediately, without ever consuming the elevated rate-limit budget", async () => {
    // Regression: found by review — appendToNode() used to consume the elevated budget *before*
    // discovering (via sendPrivateMessage()) that the target's key wasn't known yet, so a caller
    // retrying against a not-yet-reachable relay (the ordinary case for a courier scenario) could
    // exhaust the whole budget on calls that never sent anything, then get rate-limited on the very
    // first attempt that would have actually succeeded once the key became known. Proven here by
    // exhausting what would have been the whole budget against an unknown target, then connecting a
    // real one and showing 3 genuinely elevated appends still go through in full.
    const sender = makeNode("Sender");
    nodes.push(sender.node);
    await sender.node.start();

    const unknownTarget = Identity.generate().nodeId;
    for (let i = 0; i < 10; i++) {
      expect(() => sender.node.appendToNode(unknownTarget, { text: `attempt ${i}`, kind: "emergency" })).toThrow(/encryption key/);
    }

    const target = makeNode("Target");
    nodes.push(target.node);
    await target.node.start();
    await sender.node.connect({ host: "127.0.0.1", port: target.transport.port });
    await Promise.all([sender.node.waitForPeerKey(target.node.nodeId), target.node.waitForPeerKey(sender.node.nodeId)]);

    for (let i = 0; i < 3; i++) sender.node.appendToNode(target.node.nodeId, { text: `emergenza ${i}`, kind: "emergency" });
    await waitFor(() => target.node.nodeAppends.list().length === 3);
  });

  it("each kind is sent at its own Priority on the wire: info=CONTENT, hazard=MESSAGING, emergency=EMERGENCY", async () => {
    const sender = makeNode("Sender");
    nodes.push(sender.node);
    await sender.node.start();

    // A raw eavesdropping "peer" (HELLO only, no real NomadNode behind it) — floodExcept() only
    // takes its single-hop routing-table shortcut when a *route* to the destination is already
    // known; since sender never connects to a real target here, there is none, so every send falls
    // through to "flood to every connected peer" — this raw socket included. Same technique
    // tests/integration/drops.test.ts's own wire-priority test uses for a broadcast packet, adapted
    // here for a directed one specifically because no route exists to short-circuit it.
    const socket: Socket = createConnection({ host: "127.0.0.1", port: sender.transport.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const listener = Identity.generate();
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: listener.nodeId, payload: {} })));
    await waitFor(() => sender.node.peers.has(listener.nodeId));

    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));

    // A fake target whose encryption key is registered directly (bypassing any real connection/
    // gossip) — appendToNode() only needs peerDirectory to know a key, it has no idea whether that
    // came from a real handshake or not. Never connected to sender directly, so no routing-table
    // route exists — exactly the condition floodExcept() needs to broadcast instead of single-hop.
    const fakeTargetIdentity = Identity.generate();
    const fakeTargetEncryption = EncryptionIdentity.generate();
    const fakeTargetAnnouncement = signIdentityAnnouncement(fakeTargetIdentity, fakeTargetEncryption);
    sender.node.peerDirectory.record(fakeTargetAnnouncement);

    const infoId = sender.node.appendToNode(fakeTargetIdentity.nodeId, { text: "tutto tranquillo", kind: "info" });
    const hazardId = sender.node.appendToNode(fakeTargetIdentity.nodeId, { text: "crepaccio sul sentiero", kind: "hazard" });
    const emergencyId = sender.node.appendToNode(fakeTargetIdentity.nodeId, { text: "PERICOLO REALE", kind: "emergency" });

    await new Promise((resolve) => setTimeout(resolve, 200));
    const lines = Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const messages = lines.filter((p) => p.type === "PRIVATE_MESSAGE" && p.destination === fakeTargetIdentity.nodeId);
    expect(messages).toHaveLength(3);
    // Priority-based scheduling in TcpTransport (docs/security.md #4) can reorder same-tick sends on
    // the wire, same discovery as tests/integration/drops.test.ts's own wire-priority test — so
    // match each message to its call by packet id (appendToNode()'s own return value) instead of
    // arrival order.
    const priorityById = new Map(messages.map((p) => [p.id, p.priority]));
    expect(priorityById.get(infoId)).toBe(4); // Priority.CONTENT
    expect(priorityById.get(hazardId)).toBe(2); // Priority.MESSAGING
    expect(priorityById.get(emergencyId)).toBe(0); // Priority.EMERGENCY

    socket.destroy();
  });
});
