import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { computeContentId, type ContentMetadata } from "../../node/src/content.js";

/**
 * Regression test for a real finding from code review: the first version of
 * catalog sync (spec §33-34) recorded whatever a peer's SYNC_RESPONSE
 * claimed with no signature check at all, so a single malicious node could
 * inject a fabricated "this content exists, published by <anyone>" entry
 * that would then propagate transitively to every other node it later
 * synced with. This directly exercises the wire protocol (a raw socket
 * standing in for a malicious/non-conforming node) rather than going
 * through NomadNode's own (always-honest) sync implementation.
 */

describe("catalog sync rejects forged/unsigned entries", () => {
  let victim: NomadNode | undefined;
  let attackerSocket: Socket | undefined;

  afterEach(async () => {
    attackerSocket?.destroy();
    if (victim) await victim.stop();
    victim = undefined;
    attackerSocket = undefined;
  });

  it("does not record a SYNC_RESPONSE entry that carries no valid signature", async () => {
    victim = new NomadNode({ displayName: "victim" });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    const forgedData = Buffer.from("evacuare zona X — fake update");
    const forgedMetadata: ContentMetadata = {
      contentId: computeContentId(forgedData),
      name: "evacuazione.txt",
      mimeType: "text/plain",
      size: forgedData.length,
      createdAt: Date.now(),
      publisherId: "a".repeat(64), // not a real public key
      signature: "b".repeat(128), // not a real signature
    };

    attackerSocket = createConnection({ host: "127.0.0.1", port: victimTransport.port });
    await new Promise<void>((resolve, reject) => {
      attackerSocket!.once("connect", () => resolve());
      attackerSocket!.once("error", reject);
    });

    const attackerId = "f".repeat(64);
    attackerSocket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: attackerId, payload: {} })));
    attackerSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.SYNC_RESPONSE,
          source: attackerId,
          destination: victim.nodeId,
          payload: { entries: [forgedMetadata] },
        }),
      ),
    );

    // Give the victim time to process the forged packet — then confirm it never appears.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(victim.remoteCatalog.has(forgedMetadata.contentId)).toBe(false);
    expect(victim.listKnownContent().map((m) => m.contentId)).not.toContain(forgedMetadata.contentId);
  });

  it("does not propagate a forged entry to a second node via a follow-up sync", async () => {
    victim = new NomadNode({ displayName: "victim" });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    const forgedData = Buffer.from("second hop should never see this either");
    const forgedMetadata: ContentMetadata = {
      contentId: computeContentId(forgedData),
      name: "malicious.txt",
      mimeType: "text/plain",
      size: forgedData.length,
      createdAt: Date.now(),
      publisherId: "c".repeat(64),
      signature: "d".repeat(128),
    };

    attackerSocket = createConnection({ host: "127.0.0.1", port: victimTransport.port });
    await new Promise<void>((resolve, reject) => {
      attackerSocket!.once("connect", () => resolve());
      attackerSocket!.once("error", reject);
    });
    const attackerId = "e".repeat(64);
    attackerSocket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: attackerId, payload: {} })));
    attackerSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.SYNC_RESPONSE,
          source: attackerId,
          destination: victim.nodeId,
          payload: { entries: [forgedMetadata] },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(victim.remoteCatalog.has(forgedMetadata.contentId)).toBe(false);

    // A second, honest node now connects to victim — its own sync must not learn the forged entry either,
    // since victim never accepted it in the first place.
    const witness = new NomadNode({ displayName: "witness" });
    const witnessTransport = new TcpTransport(witness.nodeId, 0);
    witness.addTransport(witnessTransport);
    await witness.start();
    await witness.connect({ host: "127.0.0.1", port: victimTransport.port });

    // Give any legitimate sync traffic a moment to settle, then confirm the forged entry never crossed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(witness.remoteCatalog.has(forgedMetadata.contentId)).toBe(false);

    await witness.stop();
  });
});
