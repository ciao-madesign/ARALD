import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { computeContentId } from "../../node/src/content.js";

/**
 * Regression test for the most severe finding from code review: on the
 * *primary* content-retrieval path (not just catalog sync), `getContent()`
 * resolved with the delivered bytes regardless of whether
 * `ContentStore.putVerified()` actually accepted them — so a node serving
 * content with a correct hash but a forged/missing publisher signature
 * (spec §55) would still have its data handed back as if trustworthy. This
 * exercises the wire protocol directly (a raw socket standing in for a
 * malicious/non-conforming node) to prove the fix closes the bypass.
 */

function waitForConnected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
}

describe("getContent() rejects hash-valid but signature-invalid content", () => {
  let victim: NomadNode | undefined;
  let attackerSocket: Socket | undefined;

  afterEach(async () => {
    attackerSocket?.destroy();
    if (victim) await victim.stop();
    victim = undefined;
    attackerSocket = undefined;
  });

  it("rejects getContent() instead of resolving with unverified bytes, and never caches them", async () => {
    victim = new NomadNode({ displayName: "victim" });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    attackerSocket = createConnection({ host: "127.0.0.1", port: victimTransport.port });
    await waitForConnected(attackerSocket);

    const attackerId = "1".repeat(64);
    attackerSocket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: attackerId, payload: {} })));

    const forgedData = Buffer.from("looks legitimate, hash matches, signature does not");
    const forgedContentId = computeContentId(forgedData);
    const forgedMetadata = {
      contentId: forgedContentId,
      name: "trusted-looking.txt",
      mimeType: "text/plain",
      size: forgedData.length,
      createdAt: Date.now(),
      publisherId: "2".repeat(64), // not a real key
      signature: "3".repeat(128), // not a real signature
    };

    // The victim starts looking for this content id...
    const resultPromise = victim.getContent(forgedContentId, { timeoutMs: 500 });

    // ...and the "attacker" answers unsolicited, claiming to have it, then delivers it —
    // bytes that genuinely hash to forgedContentId, wrapped in metadata it can't legitimately sign.
    attackerSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_FOUND,
          source: attackerId,
          destination: victim.nodeId,
          payload: { queryId: "irrelevant", contentId: forgedContentId, metadata: forgedMetadata },
        }),
      ),
    );
    attackerSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_CHUNK,
          source: attackerId,
          destination: victim.nodeId,
          payload: { contentId: forgedContentId, chunkIndex: 0, totalChunks: 1, data: forgedData.toString("base64") },
        }),
      ),
    );
    attackerSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_COMPLETE,
          source: attackerId,
          destination: victim.nodeId,
          payload: { contentId: forgedContentId, metadata: forgedMetadata },
        }),
      ),
    );

    await expect(resultPromise).rejects.toThrow(/signature/);
    expect(victim.contentStore.has(forgedContentId)).toBe(false);
  });
});
