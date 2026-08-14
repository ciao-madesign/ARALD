import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";

/**
 * Regression-shaped test mirroring catalog-sync-security.test.ts: identity
 * directory entries (spec §52) must be signature-verified before being
 * trusted, exactly like catalog entries — otherwise a single malicious
 * node could inject a fabricated "node X's encryption key is Y" claim, and
 * anyone who later calls sendPrivateMessage(X, ...) would unknowingly
 * encrypt for an attacker-controlled key instead of the real node X.
 */
describe("identity directory rejects forged/unsigned encryption key claims", () => {
  let victim: NomadNode | undefined;
  let attackerSocket: Socket | undefined;

  afterEach(async () => {
    attackerSocket?.destroy();
    if (victim) await victim.stop();
    victim = undefined;
    attackerSocket = undefined;
  });

  it("does not record an IDENTITY_RESPONSE entry with an invalid signature", async () => {
    victim = new NomadNode({ displayName: "victim" });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    attackerSocket = createConnection({ host: "127.0.0.1", port: victimTransport.port });
    await new Promise<void>((resolve, reject) => {
      attackerSocket!.once("connect", () => resolve());
      attackerSocket!.once("error", reject);
    });

    const attackerId = "5".repeat(64);
    attackerSocket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: attackerId, payload: {} })));

    // Claim: "node <target> uses this encryption key" — target is some real-looking node id the
    // attacker doesn't control, with a signature that cannot possibly be valid for it.
    const targetNodeId = "6".repeat(64);
    const forgedAnnouncement = {
      nodeId: targetNodeId,
      encryptionPublicKey: "7".repeat(64),
      signature: "8".repeat(128),
    };
    attackerSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.IDENTITY_RESPONSE,
          source: attackerId,
          destination: victim.nodeId,
          payload: { announcements: [forgedAnnouncement] },
        }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(victim.peerDirectory.has(targetNodeId)).toBe(false);
    expect(() => victim.sendPrivateMessage(targetNodeId, { x: 1 })).toThrow(/encryption key/);
  });

  it("does not let a forged entry propagate to a second, honest node via a follow-up sync", async () => {
    victim = new NomadNode({ displayName: "victim" });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    attackerSocket = createConnection({ host: "127.0.0.1", port: victimTransport.port });
    await new Promise<void>((resolve, reject) => {
      attackerSocket!.once("connect", () => resolve());
      attackerSocket!.once("error", reject);
    });
    const attackerId = "1".repeat(64);
    attackerSocket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: attackerId, payload: {} })));
    const targetNodeId = "2".repeat(64);
    attackerSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.IDENTITY_RESPONSE,
          source: attackerId,
          destination: victim.nodeId,
          payload: {
            announcements: [{ nodeId: targetNodeId, encryptionPublicKey: "3".repeat(64), signature: "4".repeat(128) }],
          },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(victim.peerDirectory.has(targetNodeId)).toBe(false);

    const witness = new NomadNode({ displayName: "witness" });
    const witnessTransport = new TcpTransport(witness.nodeId, 0);
    witness.addTransport(witnessTransport);
    await witness.start();
    await witness.connect({ host: "127.0.0.1", port: victimTransport.port });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(witness.peerDirectory.has(targetNodeId)).toBe(false);

    await witness.stop();
  });
});
