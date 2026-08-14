import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { decryptFromPeer, encryptForPeer } from "../../node/src/encryption.js";

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
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/**
 * Spec §52, §56 "private messages: end-to-end encrypted": a message sent
 * via sendPrivateMessage() should be readable by its destination but not
 * by an intermediate relay, even though the relay does forward the packet.
 */
describe("end-to-end encrypted private messages", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("propagates encryption keys transitively across a chain, like catalog sync does for content", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);

    // B learns C's key first, so that when A connects to B afterwards, A's single sync
    // round-trip with B already picks up C's entry too (identity sync is point-to-point
    // at connection time, not retroactively re-announced — same as catalog sync).
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });
    await waitFor(() => b.node.peerDirectory.has(c.node.nodeId));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });

    // A never connected directly to C — it only learns C's key transitively via B.
    const cKeyAsSeenByA = await a.node.waitForPeerKey(c.node.nodeId, { timeoutMs: 2000 });
    expect(cKeyAsSeenByA).toBe(c.node.encryptionIdentity.publicKeyHex);
  });

  it("delivers a private message end-to-end through a relay, which never fires its own private-message event for it", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });
    await waitFor(() => b.node.peerDirectory.has(c.node.nodeId));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await a.node.waitForPeerKey(c.node.nodeId, { timeoutMs: 2000 });

    b.node.once("private-message", () => {
      throw new Error("relay B should not decrypt/deliver a private message not addressed to it");
    });

    const received = new Promise<unknown>((resolve) => c.node.once("private-message", (packet) => resolve(packet.payload)));
    a.node.sendPrivateMessage(c.node.nodeId, { message: "evacuare zona X" });

    await expect(received).resolves.toEqual({ message: "evacuare zona X" });
  });

  it("rejects sending a private message before the destination's key is known", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a.node.start(), b.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });

    // Immediately, before identity sync has had a chance to complete.
    expect(() => a.node.sendPrivateMessage(b.node.nodeId, { hello: "world" })).toThrow(/encryption key/);
  });

  it("waitForPeerKey resolves once identity sync completes, then sendPrivateMessage succeeds", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a.node.start(), b.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });

    await a.node.waitForPeerKey(b.node.nodeId, { timeoutMs: 2000 });

    const received = new Promise<unknown>((resolve) => b.node.once("private-message", (packet) => resolve(packet.payload)));
    a.node.sendPrivateMessage(b.node.nodeId, { hello: "world" });
    await expect(received).resolves.toEqual({ hello: "world" });
  });

  it("proves a relay genuinely could not decrypt this traffic (cryptographic property, not just absence of an event)", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });
    await waitFor(() => b.node.peerDirectory.has(c.node.nodeId));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await a.node.waitForPeerKey(c.node.nodeId, { timeoutMs: 2000 });

    // The actual A<->C shared key — what a.node uses internally when it calls sendPrivateMessage().
    const realSharedKey = a.node.encryptionIdentity.sharedKeyWith(c.node.encryptionIdentity.publicKeyHex);
    const encrypted = encryptForPeer(realSharedKey, Buffer.from(JSON.stringify({ secret: "only C should read this" })));

    // B, the relay, deriving a key from its own private key and A's public key gets a completely
    // different secret — there is no way to arrive at the real A<->C key without either party's
    // private key, which B does not have.
    const bsAttemptedKey = b.node.encryptionIdentity.sharedKeyWith(a.node.encryptionIdentity.publicKeyHex);
    expect(bsAttemptedKey).not.toEqual(realSharedKey);
    expect(() => decryptFromPeer(bsAttemptedKey, encrypted)).toThrow();

    // Meanwhile C, the real destination, decrypts it fine with the same key A used.
    const cKey = c.node.encryptionIdentity.sharedKeyWith(a.node.encryptionIdentity.publicKeyHex);
    expect(decryptFromPeer(cKey, encrypted).toString("utf8")).toBe(JSON.stringify({ secret: "only C should read this" }));
  });

  it("keeps advertising its own identity even after its peer directory evicts other entries under memory pressure", async () => {
    const aNode = new NomadNode({ displayName: "A", maxPeerDirectoryEntries: 1 });
    const aTransport = new TcpTransport(aNode.nodeId, 0);
    aNode.addTransport(aTransport);
    const a = { node: aNode, transport: aTransport };
    const x = makeNode("X");
    const y = makeNode("Y");
    const z = makeNode("Z");
    nodes.push(a.node, x.node, y.node, z.node);
    await Promise.all([a.node.start(), x.node.start(), y.node.start(), z.node.start()]);

    await a.node.connect({ host: "127.0.0.1", port: x.transport.port });
    await waitFor(() => a.node.peerDirectory.has(x.node.nodeId));
    await a.node.connect({ host: "127.0.0.1", port: y.transport.port });
    await waitFor(() => a.node.peerDirectory.has(y.node.nodeId));
    // maxSize 1 means X's entry has now been evicted to make room for Y's.
    expect(a.node.peerDirectory.has(x.node.nodeId)).toBe(false);

    // A fresh peer connecting afterward must still learn A's own key — proving A's self-announcement
    // was never stored in (and therefore never evicted from) the same bounded, evictable directory.
    await z.node.connect({ host: "127.0.0.1", port: a.transport.port });
    const aKeyAsSeenByZ = await z.node.waitForPeerKey(a.node.nodeId, { timeoutMs: 2000 });
    expect(aKeyAsSeenByZ).toBe(a.node.encryptionIdentity.publicKeyHex);

    // And A itself can still originate private messages — sendPrivateMessage() also depends on
    // its own announcement being intact to piggyback onto the outgoing packet.
    await a.node.waitForPeerKey(z.node.nodeId, { timeoutMs: 2000 });
    const received = new Promise<unknown>((resolve) => z.node.once("private-message", (packet) => resolve(packet.payload)));
    a.node.sendPrivateMessage(z.node.nodeId, { hello: "still me" });
    await expect(received).resolves.toEqual({ hello: "still me" });
  });

  it("emits identity:synced on the destination when a sender's key becomes known only via a piggybacked PRIVATE_MESSAGE announcement", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });
    await waitFor(() => b.node.peerDirectory.has(c.node.nodeId));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await a.node.waitForPeerKey(c.node.nodeId, { timeoutMs: 2000 });

    // C never connected to A directly, so C's own identity-sync round trip never involved A —
    // C can only have learned A's key from the piggybacked announcement on the message itself.
    expect(c.node.peerDirectory.has(a.node.nodeId)).toBe(false);
    const synced = new Promise<string[]>((resolve) => c.node.once("identity:synced", resolve));
    a.node.sendPrivateMessage(c.node.nodeId, { hello: "world" });

    await expect(synced).resolves.toEqual([a.node.nodeId]);
  });
});
