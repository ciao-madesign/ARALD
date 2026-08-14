import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { EncryptionIdentity, signIdentityAnnouncement } from "../../node/src/encryption.js";
import { Identity } from "../../node/src/identity.js";

/**
 * A PRIVATE_MESSAGE piggybacks the sender's self-signed IdentityAnnouncement
 * (node.ts's handlePrivateMessage), so the destination can decrypt without
 * depending on identity-sync order/timing having already reached it. That
 * piggybacking must not become a way to poison peerDirectory: an
 * announcement is only trusted when its signed nodeId matches the packet's
 * claimed source AND the signature itself verifies.
 */
describe("PRIVATE_MESSAGE sender-announcement piggyback rejects forged claims", () => {
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

  it("does not record a senderAnnouncement whose signed nodeId doesn't match the packet's claimed source", async () => {
    victim = new NomadNode({ displayName: "victim" });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    const attacker = Identity.generate();
    attackerSocket = await connectAttacker(victimTransport.port, attacker.nodeId);

    // Genuinely valid announcement — but signed by a different identity than the packet's source.
    const someoneElse = Identity.generate();
    const impersonated = signIdentityAnnouncement(someoneElse, EncryptionIdentity.generate());

    const failed = new Promise<[string, string]>((resolve) =>
      victim!.once("private-message:failed", (source: string, reason: string) => resolve([source, reason])),
    );

    attackerSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.PRIVATE_MESSAGE,
          source: attacker.nodeId,
          destination: victim.nodeId,
          payload: { nonce: "00".repeat(12), ciphertext: "00".repeat(16), authTag: "00".repeat(16), senderAnnouncement: impersonated },
        }),
      ),
    );

    const [failedSource, reason] = await failed;
    expect(failedSource).toBe(attacker.nodeId);
    expect(reason).toMatch(/encryption key/);
    expect(victim.peerDirectory.has(someoneElse.nodeId)).toBe(false);
    expect(victim.peerDirectory.has(attacker.nodeId)).toBe(false);
  });

  it("does not record a senderAnnouncement with an invalid signature, even when its nodeId matches the source", async () => {
    victim = new NomadNode({ displayName: "victim" });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    const attacker = Identity.generate();
    attackerSocket = await connectAttacker(victimTransport.port, attacker.nodeId);

    const forgedAnnouncement = {
      nodeId: attacker.nodeId,
      encryptionPublicKey: EncryptionIdentity.generate().publicKeyHex,
      signature: "00".repeat(64),
    };

    const failed = new Promise<[string, string]>((resolve) =>
      victim!.once("private-message:failed", (source: string, reason: string) => resolve([source, reason])),
    );

    attackerSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.PRIVATE_MESSAGE,
          source: attacker.nodeId,
          destination: victim.nodeId,
          payload: { nonce: "00".repeat(12), ciphertext: "00".repeat(16), authTag: "00".repeat(16), senderAnnouncement: forgedAnnouncement },
        }),
      ),
    );

    const [failedSource, reason] = await failed;
    expect(failedSource).toBe(attacker.nodeId);
    expect(reason).toMatch(/encryption key/);
    expect(victim.peerDirectory.has(attacker.nodeId)).toBe(false);
  });
});
