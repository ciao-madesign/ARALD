import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { computeContentId, contentSigningPayload } from "../../node/src/content.js";
import { Identity } from "../../node/src/identity.js";

/**
 * Spec §90-92: a provider that answered CONTENT_FOUND a moment ago isn't
 * guaranteed to still be reachable in an unreliable mesh. getContent()
 * used to lock onto the *first* reply and simply wait out the whole
 * request timeout if that specific provider went silent — even when a
 * second, perfectly reachable provider had already offered the same
 * content. This exercises the retry path directly with raw sockets
 * standing in for two providers, so the exact sequence (who answers when,
 * who goes silent) is fully deterministic rather than racing real timing.
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

describe("getContent() retries the next candidate provider when the active one goes silent", () => {
  let requester: NomadNode | undefined;
  let silentSocket: Socket | undefined;
  let honestSocket: Socket | undefined;

  afterEach(async () => {
    silentSocket?.destroy();
    honestSocket?.destroy();
    if (requester) await requester.stop();
    requester = undefined;
    silentSocket = undefined;
    honestSocket = undefined;
  });

  async function connectFakeProvider(port: number, providerId: string): Promise<Socket> {
    const socket = createConnection({ host: "127.0.0.1", port });
    await waitForConnected(socket);
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: providerId, payload: {} })));
    return socket;
  }

  function signedMetadata(identity: Identity, data: Buffer, name: string) {
    const contentId = computeContentId(data);
    const fields = { contentId, name, mimeType: "text/plain", size: data.length, publisherId: identity.nodeId };
    const signature = identity.sign(contentSigningPayload(fields)).toString("hex");
    return { ...fields, createdAt: Date.now(), signature };
  }

  it("falls through to the second provider and still resolves with the real content", async () => {
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 100 });
    const requesterTransport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(requesterTransport);
    await requester.start();

    const silentId = "1".repeat(64);
    const honest = Identity.generate();
    silentSocket = await connectFakeProvider(requesterTransport.port, silentId);
    honestSocket = await connectFakeProvider(requesterTransport.port, honest.nodeId);

    const data = Buffer.from("mappa del rifugio, sentiero nord");
    const metadata = signedMetadata(honest, data, "mappa.txt");
    const resultPromise = requester.getContent(metadata.contentId, { timeoutMs: 3000 });

    // Silent provider answers first — it becomes the active one, and is never heard from again.
    silentSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_FOUND,
          source: silentId,
          destination: requester.nodeId,
          payload: { queryId: "q", contentId: metadata.contentId, metadata },
        }),
      ),
    );
    // The honest provider answers a moment later, while the silent one is still "active" — it's
    // remembered as a fallback candidate, not requested from yet.
    honestSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_FOUND,
          source: honest.nodeId,
          destination: requester.nodeId,
          payload: { queryId: "q", contentId: metadata.contentId, metadata },
        }),
      ),
    );

    // Past contentProviderTimeoutMs (100ms): the requester should have given up on the silent
    // provider and switched its active attempt to the honest one.
    await sleep(180);

    honestSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_CHUNK,
          source: honest.nodeId,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId, chunkIndex: 0, totalChunks: 1, data: data.toString("base64") },
        }),
      ),
    );
    honestSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_COMPLETE,
          source: honest.nodeId,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId, metadata },
        }),
      ),
    );

    await expect(resultPromise).resolves.toEqual(data);
  });

  it("ignores a late reply from the abandoned provider instead of letting it cancel the retry in progress", async () => {
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 100 });
    const requesterTransport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(requesterTransport);
    await requester.start();

    const abandonedId = "2".repeat(64);
    const honest = Identity.generate();
    silentSocket = await connectFakeProvider(requesterTransport.port, abandonedId);
    honestSocket = await connectFakeProvider(requesterTransport.port, honest.nodeId);

    const data = Buffer.from("orari apertura rifugio");
    const metadata = signedMetadata(honest, data, "orari.txt");
    const resultPromise = requester.getContent(metadata.contentId, { timeoutMs: 3000 });

    silentSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_FOUND,
          source: abandonedId,
          destination: requester.nodeId,
          payload: { queryId: "q", contentId: metadata.contentId, metadata },
        }),
      ),
    );
    honestSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_FOUND,
          source: honest.nodeId,
          destination: requester.nodeId,
          payload: { queryId: "q", contentId: metadata.contentId, metadata },
        }),
      ),
    );
    await sleep(180); // now retried onto the honest provider

    // The abandoned provider finally speaks up — with a bogus completion. It must be ignored:
    // it is no longer the active provider, so it cannot fail the request out from under the retry.
    silentSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_COMPLETE,
          source: abandonedId,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId, metadata: { ...metadata, signature: "bad".repeat(20) } },
        }),
      ),
    );

    honestSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_CHUNK,
          source: honest.nodeId,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId, chunkIndex: 0, totalChunks: 1, data: data.toString("base64") },
        }),
      ),
    );
    honestSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_COMPLETE,
          source: honest.nodeId,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId, metadata },
        }),
      ),
    );

    await expect(resultPromise).resolves.toEqual(data);
  });

  it("still times out normally when the only provider goes silent and no candidates exist", async () => {
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 50 });
    const requesterTransport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(requesterTransport);
    await requester.start();

    const silentId = "3".repeat(64);
    silentSocket = await connectFakeProvider(requesterTransport.port, silentId);

    const contentId = computeContentId(Buffer.from("mai arrivato"));
    const resultPromise = requester.getContent(contentId, { timeoutMs: 300 });

    silentSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_FOUND,
          source: silentId,
          destination: requester.nodeId,
          payload: {
            queryId: "q",
            contentId,
            metadata: { contentId, name: "n", mimeType: "text/plain", size: 1, createdAt: Date.now() },
          },
        }),
      ),
    );

    await expect(resultPromise).rejects.toThrow(/content not found within mesh/);
  });

  it("does not abandon a provider that is slow but still making real progress", async () => {
    // contentProviderTimeoutMs measures time since the *last* chunk, not a hard deadline on the
    // whole transfer — each gap below is under the timeout, but their sum comfortably exceeds it.
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 80 });
    const requesterTransport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(requesterTransport);
    await requester.start();

    const slow = Identity.generate();
    const neverResponds = "4".repeat(64);
    honestSocket = await connectFakeProvider(requesterTransport.port, slow.nodeId);
    silentSocket = await connectFakeProvider(requesterTransport.port, neverResponds);

    const parts = [Buffer.from("parte-uno-"), Buffer.from("parte-due-"), Buffer.from("parte-tre")];
    const data = Buffer.concat(parts);
    const metadata = signedMetadata(slow, data, "lento.txt");
    const resultPromise = requester.getContent(metadata.contentId, { timeoutMs: 3000 });

    honestSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_FOUND,
          source: slow.nodeId,
          destination: requester.nodeId,
          payload: { queryId: "q", contentId: metadata.contentId, metadata },
        }),
      ),
    );
    // A second provider is known too, but must never actually be needed — the active one keeps
    // making progress within each timeout window.
    silentSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_FOUND,
          source: neverResponds,
          destination: requester.nodeId,
          payload: { queryId: "q", contentId: metadata.contentId, metadata },
        }),
      ),
    );

    for (let i = 0; i < parts.length; i++) {
      await sleep(60); // under the 80ms per-provider timeout, but three of these exceed it
      honestSocket.write(
        encodePacket(
          createPacket({
            type: MessageType.CONTENT_CHUNK,
            source: slow.nodeId,
            destination: requester.nodeId,
            payload: { contentId: metadata.contentId, chunkIndex: i, totalChunks: parts.length, data: parts[i].toString("base64") },
          }),
        ),
      );
    }
    honestSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_COMPLETE,
          source: slow.nodeId,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId, metadata },
        }),
      ),
    );

    await expect(resultPromise).resolves.toEqual(data);
  });

  it("tries a candidate immediately if it arrives after every previously known one was already exhausted", async () => {
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 60 });
    const requesterTransport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(requesterTransport);
    await requester.start();

    const silentFirstId = "5".repeat(64);
    const lateArriving = Identity.generate();
    silentSocket = await connectFakeProvider(requesterTransport.port, silentFirstId);

    const data = Buffer.from("arrivato tardi ma disponibile");
    const metadata = signedMetadata(lateArriving, data, "tardivo.txt");
    const resultPromise = requester.getContent(metadata.contentId, { timeoutMs: 3000 });

    silentSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_FOUND,
          source: silentFirstId,
          destination: requester.nodeId,
          payload: { queryId: "q", contentId: metadata.contentId, metadata },
        }),
      ),
    );

    // Let the only known provider's retry timer fire with zero candidates queued — the request is
    // now "stalled" (nobody left to try) well before its late-arriving candidate even connects.
    await sleep(120);

    honestSocket = await connectFakeProvider(requesterTransport.port, lateArriving.nodeId);
    honestSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_FOUND,
          source: lateArriving.nodeId,
          destination: requester.nodeId,
          payload: { queryId: "q", contentId: metadata.contentId, metadata },
        }),
      ),
    );
    await sleep(30); // let the immediate retry actually go out
    honestSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_CHUNK,
          source: lateArriving.nodeId,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId, chunkIndex: 0, totalChunks: 1, data: data.toString("base64") },
        }),
      ),
    );
    honestSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_COMPLETE,
          source: lateArriving.nodeId,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId, metadata },
        }),
      ),
    );

    // Must resolve promptly from the immediate retry, not linger until the outer 3000ms backstop —
    // that would mean the late candidate was only queued, never actually tried.
    const winner = await Promise.race([
      resultPromise,
      sleep(1000).then(() => {
        throw new Error("timed out waiting for the immediate retry to the late-arriving candidate");
      }),
    ]);
    expect(winner).toEqual(data);
  });
});
