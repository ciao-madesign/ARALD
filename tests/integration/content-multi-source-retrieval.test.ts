import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket, type Packet } from "../../node/src/packet.js";
import { CHUNK_SIZE, computeContentId, contentSigningPayload } from "../../node/src/content.js";
import { Identity } from "../../node/src/identity.js";

/**
 * "ARALD Data Plane" multi-source retrieval (docs/next-steps.md) — a multi-chunk transfer is split
 * between two providers that both answer CONTENT_FOUND, instead of trying one at a time; a single
 * known provider still gets asked for the rest of a multi-chunk transfer once its first half is
 * done (the "safety net" that keeps a single-copy fetch from ever regressing); a stalled half is
 * reassigned to a waiting third provider, same as a stalled *whole* transfer already was before
 * this feature (tests/integration/content-provider-retry.test.ts). Same raw-socket technique as
 * that file, for fully deterministic control over who answers what and when.
 */

function waitForConnected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunksOf(data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) chunks.push(data.subarray(offset, offset + CHUNK_SIZE));
  return chunks;
}

describe("getContent() multi-source retrieval for a multi-chunk transfer", () => {
  let requester: NomadNode | undefined;
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.length = 0;
    if (requester) await requester.stop();
    requester = undefined;
  });

  async function connectFakeProvider(port: number, providerId: string): Promise<Socket> {
    const socket = createConnection({ host: "127.0.0.1", port });
    await waitForConnected(socket);
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: providerId, payload: {} })));
    sockets.push(socket);
    return socket;
  }

  function signedMetadata(identity: Identity, data: Buffer, name: string) {
    const contentId = computeContentId(data);
    const fields = { contentId, name, mimeType: "application/octet-stream", size: data.length, publisherId: identity.nodeId };
    const signature = identity.sign(contentSigningPayload(fields)).toString("hex");
    return { ...fields, createdAt: Date.now(), signature };
  }

  function sendFound(socket: Socket, source: string, requesterId: string, metadata: ReturnType<typeof signedMetadata>) {
    socket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_FOUND,
          source,
          destination: requesterId,
          payload: { queryId: "q", contentId: metadata.contentId, metadata },
        }),
      ),
    );
  }

  function sendChunk(socket: Socket, source: string, requesterId: string, contentId: string, chunkIndex: number, totalChunks: number, chunk: Buffer) {
    socket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_CHUNK,
          source,
          destination: requesterId,
          payload: { contentId, chunkIndex, totalChunks, data: chunk.toString("base64") },
        }),
      ),
    );
  }

  function sendComplete(socket: Socket, source: string, requesterId: string, metadata: ReturnType<typeof signedMetadata>) {
    socket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_COMPLETE,
          source,
          destination: requesterId,
          payload: { contentId: metadata.contentId, metadata },
        }),
      ),
    );
  }

  /** Reads exactly one decoded packet of `type` arriving on `socket`, ignoring any other traffic (e.g. HELLO echoes). */
  function nextPacketOfType(socket: Socket, type: MessageType, timeoutMs = 2000): Promise<Packet<{ chunkStart?: number; chunkEnd?: number; contentId?: string }>> {
    return new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => {
        socket.off("data", onData);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let newlineIndex: number;
        while ((newlineIndex = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, newlineIndex);
          buf = buf.slice(newlineIndex + 1);
          if (!line) continue;
          const packet = JSON.parse(line);
          if (packet.type === type) {
            clearTimeout(timer);
            socket.off("data", onData);
            resolve(packet);
            return;
          }
        }
      };
      socket.on("data", onData);
    });
  }

  it("splits a multi-chunk transfer between two providers that both answer CONTENT_FOUND, instead of trying one at a time", async () => {
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 3000 });
    const transport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(transport);
    await requester.start();

    const publisher = Identity.generate();
    const data = Buffer.alloc(CHUNK_SIZE * 3 + 123, 7); // 4 chunks total
    const metadata = signedMetadata(publisher, data, "big.bin");
    const chunks = chunksOf(data);
    expect(chunks).toHaveLength(4);

    const providerAId = "a".repeat(64);
    const providerBId = "b".repeat(64);
    const socketA = await connectFakeProvider(transport.port, providerAId);
    const socketB = await connectFakeProvider(transport.port, providerBId);

    const resultPromise = requester.getContent(metadata.contentId, { timeoutMs: 5000 });

    sendFound(socketA, providerAId, requester.nodeId, metadata);
    const requestToA = await nextPacketOfType(socketA, MessageType.CONTENT_REQUEST);
    // First reply ever: split in half immediately, front half to A, back half left unassigned.
    expect(requestToA.payload).toMatchObject({ chunkStart: 0, chunkEnd: 1 });

    sendFound(socketB, providerBId, requester.nodeId, metadata);
    const requestToB = await nextPacketOfType(socketB, MessageType.CONTENT_REQUEST);
    // Second reply: the unassigned back half is handed to B concurrently — not queued as a mere fallback.
    expect(requestToB.payload).toMatchObject({ chunkStart: 2, chunkEnd: 3 });

    sendChunk(socketA, providerAId, requester.nodeId, metadata.contentId, 0, 4, chunks[0]);
    sendChunk(socketA, providerAId, requester.nodeId, metadata.contentId, 1, 4, chunks[1]);
    sendComplete(socketA, providerAId, requester.nodeId, metadata);

    sendChunk(socketB, providerBId, requester.nodeId, metadata.contentId, 2, 4, chunks[2]);
    sendChunk(socketB, providerBId, requester.nodeId, metadata.contentId, 3, 4, chunks[3]);
    sendComplete(socketB, providerBId, requester.nodeId, metadata);

    await expect(resultPromise).resolves.toEqual(data);
  });

  it("asks the same provider for the rest once its half is done, when no second provider ever showed up (never regresses a single-copy transfer)", async () => {
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 3000 });
    const transport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(transport);
    await requester.start();

    const publisher = Identity.generate();
    const data = Buffer.alloc(CHUNK_SIZE * 3 + 123, 9);
    const metadata = signedMetadata(publisher, data, "solo.bin");
    const chunks = chunksOf(data);

    const providerId = "c".repeat(64);
    const socket = await connectFakeProvider(transport.port, providerId);

    const resultPromise = requester.getContent(metadata.contentId, { timeoutMs: 5000 });

    sendFound(socket, providerId, requester.nodeId, metadata);
    const firstRequest = await nextPacketOfType(socket, MessageType.CONTENT_REQUEST);
    expect(firstRequest.payload).toMatchObject({ chunkStart: 0, chunkEnd: 1 });

    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 0, 4, chunks[0]);
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 1, 4, chunks[1]);
    sendComplete(socket, providerId, requester.nodeId, metadata);

    // Nobody else ever answered CONTENT_FOUND — the same provider must be asked for the back half
    // instead of the transfer hanging forever with it unassigned.
    const secondRequest = await nextPacketOfType(socket, MessageType.CONTENT_REQUEST);
    expect(secondRequest.payload).toMatchObject({ chunkStart: 2, chunkEnd: 3 });

    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 2, 4, chunks[2]);
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 3, 4, chunks[3]);
    sendComplete(socket, providerId, requester.nodeId, metadata);

    await expect(resultPromise).resolves.toEqual(data);
  });

  it("reassigns a stalled half to a third provider that answers later, without disturbing the other, still-healthy half", async () => {
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 100 });
    const transport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(transport);
    await requester.start();

    const publisher = Identity.generate();
    const data = Buffer.alloc(CHUNK_SIZE * 3 + 123, 3);
    const metadata = signedMetadata(publisher, data, "flaky.bin");
    const chunks = chunksOf(data);

    const healthyId = "d".repeat(64);
    const stalledId = "e".repeat(64);
    const rescuerId = "f".repeat(64);
    const healthySocket = await connectFakeProvider(transport.port, healthyId);
    const stalledSocket = await connectFakeProvider(transport.port, stalledId);

    const resultPromise = requester.getContent(metadata.contentId, { timeoutMs: 5000 });

    sendFound(healthySocket, healthyId, requester.nodeId, metadata);
    await nextPacketOfType(healthySocket, MessageType.CONTENT_REQUEST); // front half [0,1] to healthy

    // From here on, healthy must never be asked again — its half is already fully, successfully
    // delivered; only the stalled half should ever need a rescuer.
    let furtherRequestsToHealthy = 0;
    healthySocket.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes('"CONTENT_REQUEST"')) furtherRequestsToHealthy++;
    });

    sendFound(stalledSocket, stalledId, requester.nodeId, metadata);
    await nextPacketOfType(stalledSocket, MessageType.CONTENT_REQUEST); // back half [2,3] to stalled

    // healthy actually delivers its half; stalled never responds at all.
    sendChunk(healthySocket, healthyId, requester.nodeId, metadata.contentId, 0, 4, chunks[0]);
    sendChunk(healthySocket, healthyId, requester.nodeId, metadata.contentId, 1, 4, chunks[1]);
    sendComplete(healthySocket, healthyId, requester.nodeId, metadata);

    // Past contentProviderTimeoutMs (100ms) with nobody else known yet — stalled's half just sits
    // unassigned (no candidate, and the "same provider" safety net only applies to a provider that
    // just *completed*, not one that went silent — a silent one is exactly who it must not trust
    // again automatically).
    await sleep(180);

    const rescuerSocket = await connectFakeProvider(transport.port, rescuerId);
    sendFound(rescuerSocket, rescuerId, requester.nodeId, metadata);
    const rescueRequest = await nextPacketOfType(rescuerSocket, MessageType.CONTENT_REQUEST);
    expect(rescueRequest.payload).toMatchObject({ chunkStart: 2, chunkEnd: 3 });

    sendChunk(rescuerSocket, rescuerId, requester.nodeId, metadata.contentId, 2, 4, chunks[2]);
    sendChunk(rescuerSocket, rescuerId, requester.nodeId, metadata.contentId, 3, 4, chunks[3]);
    sendComplete(rescuerSocket, rescuerId, requester.nodeId, metadata);

    await expect(resultPromise).resolves.toEqual(data);
    expect(furtherRequestsToHealthy).toBe(0);
  });

  it("ignores a chunk whose own totalChunks claim disagrees with the already-fixed real total, instead of letting it fake premature completion", async () => {
    // Regression test (found by review): a single provider, multi-chunk transfer. Found by review
    // for the general multi-provider case, but reproducible with just one — the bug was in how a
    // chunk's own claimed totalChunks interacts with entry.totalChunks (node.ts), independent of
    // how many providers are involved.
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 3000 });
    const transport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(transport);
    await requester.start();

    const publisher = Identity.generate();
    const data = Buffer.alloc(CHUNK_SIZE * 3 + 123, 5); // 4 real chunks
    const metadata = signedMetadata(publisher, data, "bogus-chunk.bin");
    const chunks = chunksOf(data);

    const providerId = "9".repeat(64);
    const socket = await connectFakeProvider(transport.port, providerId);
    const resultPromise = requester.getContent(metadata.contentId, { timeoutMs: 5000 });

    sendFound(socket, providerId, requester.nodeId, metadata);
    await nextPacketOfType(socket, MessageType.CONTENT_REQUEST); // front half [0,1]

    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 0, 4, chunks[0]);
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 1, 4, chunks[1]);
    // A bogus extra chunk, claiming a totalChunks (16) that disagrees with the real, already-fixed
    // total (4) — accepted by the assembler on its own terms (chunkIndex 15 < its own totalChunks
    // 16), but must never count toward "do we have everything" for the real 4-chunk transfer.
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 15, 16, Buffer.from("bogus"));
    sendComplete(socket, providerId, requester.nodeId, metadata); // only chunks 0-1 genuinely done so far

    // The bogus chunk must not have caused a premature hash-mismatch rejection — the second half
    // (safety net) should still be on its way.
    const secondRequest = await nextPacketOfType(socket, MessageType.CONTENT_REQUEST, 1000);
    expect(secondRequest.payload).toMatchObject({ chunkStart: 2, chunkEnd: 3 });

    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 2, 4, chunks[2]);
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 3, 4, chunks[3]);
    sendComplete(socket, providerId, requester.nodeId, metadata);

    await expect(resultPromise).resolves.toEqual(data);
  });

  it("still fetches the rest of a transfer whose first CONTENT_FOUND metadata.size underestimated the real chunk count", async () => {
    // Regression test (found by review): metadata.size is only ever a heuristic for the *initial*
    // split (handleContentFound) — never trusted as the real total. A provider whose real content
    // needs more chunks than that estimate implied must still get asked for the rest once the real
    // size is learned from the wire (the first real CONTENT_CHUNK), not leave the gap unassigned
    // forever.
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 3000 });
    const transport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(transport);
    await requester.start();

    const publisher = Identity.generate();
    const data = Buffer.alloc(CHUNK_SIZE * 3 + 123, 11); // really 4 chunks
    const realContentId = computeContentId(data);
    // Metadata dishonestly/mistakenly claims a tiny size — chunkCountForSize() would estimate just
    // 1 chunk from this, even though the real data (and the provider's real chunksFor()-equivalent
    // chunking below) needs 4. The signature only covers the fields actually used to verify at the
    // end (contentId/name/mimeType/size/publisherId/expiresAt) — a mismatched `size` here is exactly
    // the kind of not-yet-verified claim handleContentFound() must never rely on for more than a
    // one-time heuristic.
    const fields = { contentId: realContentId, name: "underestimated.bin", mimeType: "application/octet-stream", size: 1, publisherId: publisher.nodeId };
    const signature = publisher.sign(contentSigningPayload(fields)).toString("hex");
    const metadata = { ...fields, createdAt: Date.now(), signature };
    const chunks = chunksOf(data);

    const providerId = "8".repeat(64);
    const socket = await connectFakeProvider(transport.port, providerId);
    const resultPromise = requester.getContent(metadata.contentId, { timeoutMs: 5000 });

    sendFound(socket, providerId, requester.nodeId, metadata);
    const firstRequest = await nextPacketOfType(socket, MessageType.CONTENT_REQUEST);
    // Sized from the (wrong) estimate of 1 chunk — requests only chunk 0, same as a genuinely
    // single-chunk transfer would.
    expect(firstRequest.payload).toMatchObject({ chunkStart: 0, chunkEnd: 0 });

    // The provider answers truthfully about the *real* chunking (totalChunks=4) despite only being
    // asked for chunk 0 — this is what reveals the estimate was wrong. The gap isn't requested
    // until this original (undersized) request is itself genuinely done (its own CONTENT_COMPLETE)
    // — not reactively off this single chunk (found by review, second pass): the provider could
    // still have more of *this* same request in flight, and reassigning it immediately would risk
    // its own still-arriving CONTENT_COMPLETE for this original request being mistaken for
    // completing the new gap instead, untracking it while genuinely delivering the gap's chunks.
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 0, 4, chunks[0]);
    sendComplete(socket, providerId, requester.nodeId, metadata);

    // Only now is the gap (chunks 1-3) requested on its own.
    const gapRequest = await nextPacketOfType(socket, MessageType.CONTENT_REQUEST, 1000);
    expect(gapRequest.payload).toMatchObject({ chunkStart: 1, chunkEnd: 3 });

    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 1, 4, chunks[1]);
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 2, 4, chunks[2]);
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 3, 4, chunks[3]);
    sendComplete(socket, providerId, requester.nodeId, metadata);

    await expect(resultPromise).resolves.toEqual(data);
  });

  it("never loses a provider's own still-in-flight chunks to a gap-closing reassignment of that same provider (found by review, second pass)", async () => {
    // The race the second review pass found: the original split *does* happen (estimate > 1 chunk),
    // so the first provider's own original range still has more than one chunk outstanding at the
    // moment its first chunk reveals a real total bigger than estimated. Reassigning that provider
    // to the new gap *immediately* (instead of waiting for its original CONTENT_COMPLETE) would
    // overwrite its still-live ActiveContentFetch entry — its own still-arriving chunks/COMPLETE for
    // the *original* range would then be misattributed to the new one, and handleContentChunk's
    // `!activeFetches.has(packet.source)` guard would silently drop the real gap chunks once they
    // actually arrive. This provider ends up doing all the work, across three sequential rounds, and
    // every single chunk must still make it into the final result.
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 3000 });
    const transport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(transport);
    await requester.start();

    const publisher = Identity.generate();
    const data = Buffer.alloc(CHUNK_SIZE * 5 + 123, 13); // really 6 chunks
    const realContentId = computeContentId(data);
    // Estimated at 4 chunks (metadata.size claims a size that chunkCountForSize() turns into 4) —
    // more than one, so the initial split assigns this provider a real two-chunk front half [0,1]
    // (mid = ceil(4/2) = 2) and leaves [2,3] unassigned, before the real total (6) is ever known.
    const estimatedSize = CHUNK_SIZE * 3 + 1;
    const fields = {
      contentId: realContentId,
      name: "underestimated-multi.bin",
      mimeType: "application/octet-stream",
      size: estimatedSize,
      publisherId: publisher.nodeId,
    };
    const signature = publisher.sign(contentSigningPayload(fields)).toString("hex");
    const metadata = { ...fields, createdAt: Date.now(), signature };
    const chunks = chunksOf(data);
    expect(chunks).toHaveLength(6);

    const providerId = "7".repeat(64);
    const socket = await connectFakeProvider(transport.port, providerId);
    const resultPromise = requester.getContent(metadata.contentId, { timeoutMs: 5000 });

    sendFound(socket, providerId, requester.nodeId, metadata);
    const firstRequest = await nextPacketOfType(socket, MessageType.CONTENT_REQUEST);
    expect(firstRequest.payload).toMatchObject({ chunkStart: 0, chunkEnd: 1 });

    // Chunk 0 reveals the real total (6) is bigger than the estimate (4) implied — but chunk 1 of
    // this SAME original request is still outstanding, and must not be lost.
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 0, 6, chunks[0]);
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 1, 6, chunks[1]);
    sendComplete(socket, providerId, requester.nodeId, metadata);

    const secondRequest = await nextPacketOfType(socket, MessageType.CONTENT_REQUEST, 1000);
    expect(secondRequest.payload).toMatchObject({ chunkStart: 2, chunkEnd: 3 }); // the half the initial split had already set aside
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 2, 6, chunks[2]);
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 3, 6, chunks[3]);
    sendComplete(socket, providerId, requester.nodeId, metadata);

    const thirdRequest = await nextPacketOfType(socket, MessageType.CONTENT_REQUEST, 1000);
    expect(thirdRequest.payload).toMatchObject({ chunkStart: 4, chunkEnd: 5 }); // the gap only discovered once the real total was learned
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 4, 6, chunks[4]);
    sendChunk(socket, providerId, requester.nodeId, metadata.contentId, 5, 6, chunks[5]);
    sendComplete(socket, providerId, requester.nodeId, metadata);

    await expect(resultPromise).resolves.toEqual(data);
  });
});
