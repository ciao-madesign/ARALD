import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, decodePacket, encodePacket, type Packet } from "../../node/src/packet.js";
import { computeContentId, contentSigningPayload } from "../../node/src/content.js";
import { Identity } from "../../node/src/identity.js";

/**
 * Spec §25: before this slice, a provider that no longer had content it had
 * previously advertised (evicted, or expired — spec §24) simply stayed
 * silent on a CONTENT_REQUEST, forcing the requester to burn the full
 * `contentProviderTimeoutMs` before trying its next candidate. CONTENT_NOT_FOUND
 * makes that explicit, so failover is immediate. Provider behavior is driven
 * by raw sockets for full determinism (mirrors content-provider-retry.test.ts);
 * the last test exercises the real ContentStore/handleContentRequest expiry
 * path end to end against a genuine NomadNode.
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

function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
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

describe("CONTENT_NOT_FOUND", () => {
  let requester: NomadNode | undefined;
  let socketA: Socket | undefined;
  let socketB: Socket | undefined;

  afterEach(async () => {
    socketA?.destroy();
    socketB?.destroy();
    if (requester) await requester.stop();
    requester = undefined;
    socketA = undefined;
    socketB = undefined;
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

  function sendContentFound(socket: Socket, source: string, requesterId: string, metadata: ReturnType<typeof signedMetadata>): void {
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

  it("fails over to the next candidate immediately on CONTENT_NOT_FOUND, without waiting for contentProviderTimeoutMs", async () => {
    // A deliberately huge provider timeout — if the requester relied on it instead of reacting to
    // CONTENT_NOT_FOUND directly, this test's own short race below would time out first.
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 5000 });
    const requesterTransport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(requesterTransport);
    await requester.start();

    const declining = "6".repeat(64);
    const honest = Identity.generate();
    socketA = await connectFakeProvider(requesterTransport.port, declining);
    socketB = await connectFakeProvider(requesterTransport.port, honest.nodeId);

    const data = Buffer.from("bollettino neve aggiornato");
    const metadata = signedMetadata(honest, data, "neve.txt");
    const resultPromise = requester.getContent(metadata.contentId, { timeoutMs: 3000 });

    sendContentFound(socketA, declining, requester.nodeId, metadata); // becomes active first
    sendContentFound(socketB, honest.nodeId, requester.nodeId, metadata); // remembered as fallback

    await sleep(30); // let the requester's CONTENT_REQUEST to "declining" actually go out

    socketA.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_NOT_FOUND,
          source: declining,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId },
        }),
      ),
    );

    socketB.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_CHUNK,
          source: honest.nodeId,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId, chunkIndex: 0, totalChunks: 1, data: data.toString("base64") },
        }),
      ),
    );
    socketB.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_COMPLETE,
          source: honest.nodeId,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId, metadata },
        }),
      ),
    );

    const winner = await Promise.race([
      resultPromise,
      sleep(500).then(() => {
        throw new Error("timed out — CONTENT_NOT_FOUND did not trigger an immediate retry");
      }),
    ]);
    expect(winner).toEqual(data);
  });

  it("ignores a CONTENT_NOT_FOUND from a provider that isn't the currently active one", async () => {
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 100 });
    const requesterTransport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(requesterTransport);
    await requester.start();

    const abandonedId = "7".repeat(64);
    const honest = Identity.generate();
    socketA = await connectFakeProvider(requesterTransport.port, abandonedId);
    socketB = await connectFakeProvider(requesterTransport.port, honest.nodeId);

    const data = Buffer.from("stato sentiero est");
    const metadata = signedMetadata(honest, data, "sentiero.txt");
    const resultPromise = requester.getContent(metadata.contentId, { timeoutMs: 3000 });

    sendContentFound(socketA, abandonedId, requester.nodeId, metadata);
    sendContentFound(socketB, honest.nodeId, requester.nodeId, metadata);
    await sleep(180); // silent timeout fires — requester already moved on to "honest"

    // The abandoned provider finally speaks up, declining — it must not disturb the retry already
    // in progress with a different, currently-active provider.
    socketA.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_NOT_FOUND,
          source: abandonedId,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId },
        }),
      ),
    );

    socketB.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_CHUNK,
          source: honest.nodeId,
          destination: requester.nodeId,
          payload: { contentId: metadata.contentId, chunkIndex: 0, totalChunks: 1, data: data.toString("base64") },
        }),
      ),
    );
    socketB.write(
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

  it("falls through to the outer timeout when CONTENT_NOT_FOUND leaves no other candidate", async () => {
    requester = new NomadNode({ displayName: "requester", contentProviderTimeoutMs: 5000 });
    const requesterTransport = new TcpTransport(requester.nodeId, 0);
    requester.addTransport(requesterTransport);
    await requester.start();

    const onlyProvider = "8".repeat(64);
    socketA = await connectFakeProvider(requesterTransport.port, onlyProvider);

    const contentId = computeContentId(Buffer.from("non esiste da nessuna parte"));
    const resultPromise = requester.getContent(contentId, { timeoutMs: 300 });

    socketA.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_FOUND,
          source: onlyProvider,
          destination: requester.nodeId,
          payload: { queryId: "q", contentId, metadata: { contentId, name: "n", mimeType: "text/plain", size: 1, createdAt: Date.now() } },
        }),
      ),
    );
    await sleep(30);
    socketA.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_NOT_FOUND,
          source: onlyProvider,
          destination: requester.nodeId,
          payload: { contentId },
        }),
      ),
    );

    await expect(resultPromise).rejects.toThrow(/content not found within mesh/);
  });

  it("a real provider whose content has expired replies CONTENT_NOT_FOUND to a CONTENT_REQUEST", async () => {
    const provider = new NomadNode({ displayName: "provider" });
    requester = provider; // reuse afterEach's cleanup — this test plays "provider", not "requester"
    const providerTransport = new TcpTransport(provider.nodeId, 0);
    provider.addTransport(providerTransport);
    await provider.start();

    // ttlMs must clear the gap between computing expiresAt and putVerified()'s own Date.now() check
    // inside publishContent() itself — too small a value (e.g. 1ms) can make publishing race its own
    // expiry check under system clock jitter and fail with "already expired" before the test even starts.
    const data = Buffer.from("previsioni valide solo per un istante");
    const metadata = provider.publishContent("previsioni.txt", "text/plain", data, { ttlMs: 30 });
    await sleep(60); // now genuinely expired — ContentStore.get() will lazily evict it

    const requesterIdentity = Identity.generate();
    const fake = createConnection({ host: "127.0.0.1", port: providerTransport.port });
    socketA = fake;
    await waitForConnected(fake);
    fake.write(encodePacket(createPacket({ type: MessageType.HELLO, source: requesterIdentity.nodeId, payload: {} })));

    const received: Packet[] = [];
    let buffer = "";
    fake.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) received.push(decodePacket(line));
      }
    });

    fake.write(
      encodePacket(
        createPacket({
          type: MessageType.CONTENT_REQUEST,
          source: requesterIdentity.nodeId,
          destination: provider.nodeId,
          payload: { contentId: metadata.contentId },
        }),
      ),
    );

    await waitFor(() => received.some((p) => p.type === MessageType.CONTENT_NOT_FOUND));
    const notFound = received.find((p) => p.type === MessageType.CONTENT_NOT_FOUND)!;
    expect((notFound.payload as { contentId: string }).contentId).toBe(metadata.contentId);
    expect(received.some((p) => p.type === MessageType.CONTENT_CHUNK)).toBe(false);
  });
});
