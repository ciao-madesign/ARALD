import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { EncryptionIdentity, MAX_DEVICE_CLASS_LENGTH, signIdentityAnnouncement } from "../../node/src/encryption.js";
import { Identity } from "../../node/src/identity.js";

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

/**
 * "Node Capabilities" (docs/next-steps.md, node.ts's NomadNodeOptions.deviceClass): the receiving
 * side must not blindly trust a self-declared deviceClass just because the whole announcement is
 * validly signed — a node signs its own claims, valid or not, so `acceptIdentityAnnouncement()`
 * defensively checks the field's shape itself (see that method's own doc comment for why a
 * malformed field forces rejecting the whole announcement rather than stripping just that field).
 * Uses a genuinely, validly-signed announcement (unlike the forged-signature tests above) built
 * directly via `signIdentityAnnouncement()`, which — unlike `NomadNode`'s own constructor — does
 * not itself enforce `MAX_DEVICE_CLASS_LENGTH`, so it can produce exactly the "valid signature,
 * invalid payload shape" case this check exists for.
 */
describe("identity directory rejects a validly-signed but malformed deviceClass ('Node Capabilities')", () => {
  let victim: NomadNode | undefined;
  let attackerSocket: Socket | undefined;

  afterEach(async () => {
    attackerSocket?.destroy();
    if (victim) await victim.stop();
    victim = undefined;
    attackerSocket = undefined;
  });

  it("does not record an otherwise-valid IDENTITY_RESPONSE announcement whose deviceClass exceeds the length bound", async () => {
    victim = new NomadNode({ displayName: "victim" });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    attackerSocket = createConnection({ host: "127.0.0.1", port: victimTransport.port });
    await new Promise<void>((resolve, reject) => {
      attackerSocket!.once("connect", () => resolve());
      attackerSocket!.once("error", reject);
    });

    const attackerIdentity = Identity.generate();
    const oversizedAnnouncement = signIdentityAnnouncement(
      attackerIdentity,
      EncryptionIdentity.generate(),
      "x".repeat(MAX_DEVICE_CLASS_LENGTH + 1), // genuinely, validly self-signed — just an oversized field
    );
    attackerSocket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: attackerIdentity.nodeId, payload: {} })));
    attackerSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.IDENTITY_RESPONSE,
          source: attackerIdentity.nodeId,
          destination: victim.nodeId,
          payload: { announcements: [oversizedAnnouncement] },
        }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    // Rejected wholesale — not just "recorded without the bad field" (see this describe block's own
    // doc comment for why partial acceptance isn't an option here).
    expect(victim.peerDirectory.has(attackerIdentity.nodeId)).toBe(false);
  });

  it("throws in the constructor if deviceClass is empty or exceeds MAX_DEVICE_CLASS_LENGTH — fail fast on a local, non-network misuse", () => {
    expect(() => new NomadNode({ deviceClass: "" })).toThrow(/1-100 characters/);
    expect(() => new NomadNode({ deviceClass: "x".repeat(MAX_DEVICE_CLASS_LENGTH + 1) })).toThrow(/1-100 characters/);
    expect(() => new NomadNode({ deviceClass: "Box" })).not.toThrow();
  });
});
