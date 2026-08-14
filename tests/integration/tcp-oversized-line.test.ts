import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { Identity } from "../../node/src/identity.js";

/**
 * `readline`'s Interface buffers indefinitely while waiting for a `\n` —
 * with no cap, a peer that just never sends one could grow that buffer
 * without bound (memory-exhaustion DoS from a single connected peer,
 * before the packet ever reaches decodePacket()/the rate limiter). See the
 * MAX_LINE_BYTES guard in node/src/transports/tcp.ts's wireSocket().
 */
describe("TcpTransport rejects an oversized line instead of buffering it indefinitely", () => {
  let victim: NomadNode | undefined;
  let attackerSocket: Socket | undefined;

  afterEach(async () => {
    attackerSocket?.destroy();
    if (victim) await victim.stop();
    victim = undefined;
    attackerSocket = undefined;
  });

  it("destroys the connection once bytes-since-last-newline exceed the cap, and the node stays responsive", async () => {
    victim = new NomadNode({ displayName: "victim" });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    const attacker = Identity.generate();
    attackerSocket = createConnection({ host: "127.0.0.1", port: victimTransport.port });
    await new Promise<void>((resolve, reject) => {
      attackerSocket!.once("connect", () => resolve());
      attackerSocket!.once("error", reject);
    });
    attackerSocket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: attacker.nodeId, payload: {} })));

    const closed = new Promise<void>((resolve) => attackerSocket!.once("close", () => resolve()));

    // Stream well past MAX_LINE_BYTES (2MB) without ever sending a newline.
    const chunk = Buffer.alloc(256 * 1024, "x");
    for (let sent = 0; sent < 3 * 1024 * 1024; sent += chunk.length) {
      if (attackerSocket.destroyed) break;
      attackerSocket.write(chunk);
    }

    await closed;
    expect(attackerSocket.destroyed).toBe(true);

    // The victim itself must still be alive and correctly serving an unrelated, well-behaved peer.
    const honest = new NomadNode({ displayName: "honest" });
    const honestTransport = new TcpTransport(honest.nodeId, 0);
    honest.addTransport(honestTransport);
    await honest.start();
    try {
      await honest.connect({ host: "127.0.0.1", port: victimTransport.port });
      expect(honest.peers.list().some((p) => p.id === victim.nodeId)).toBe(true);
    } finally {
      await honest.stop();
    }
  });
});
