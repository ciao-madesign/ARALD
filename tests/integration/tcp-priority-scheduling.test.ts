import { afterEach, describe, expect, it } from "vitest";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, Priority, createPacket, type Packet } from "../../node/src/packet.js";
import { Identity } from "../../node/src/identity.js";

/**
 * Spec §50: priority was previously carried as data only, with no actual
 * differentiated scheduling — a burst of BULK traffic to one peer (e.g. a
 * chunked transfer in flight) could make an EMERGENCY packet wait behind
 * all of it just because it happened to be queued first. TcpTransport now
 * queues sends per peer and drains them in priority order (priority-queue.ts).
 * Exercised at the transport layer directly, since that's where the queue
 * actually lives — NomadNode's own send methods don't expose custom
 * priorities per call.
 */

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

describe("TcpTransport priority-based send scheduling", () => {
  let server: TcpTransport | undefined;
  let client: TcpTransport | undefined;

  afterEach(async () => {
    await Promise.all([server?.stop(), client?.stop()].filter(Boolean));
    server = undefined;
    client = undefined;
  });

  function makePacket(priority: Priority, label: string): Packet {
    return createPacket({ type: MessageType.DATA, source: Identity.generate().nodeId, payload: { label }, priority });
  }

  it("delivers a higher-priority packet before lower-priority ones already queued behind it", async () => {
    const serverIdentity = Identity.generate();
    server = new TcpTransport(serverIdentity.nodeId, 0);
    await server.start();

    const clientIdentity = Identity.generate();
    client = new TcpTransport(clientIdentity.nodeId, 0);
    const peerId = await client.connect({ host: "127.0.0.1", port: server.port });

    const arrivalOrder: Priority[] = [];
    server.onPacket((packet) => {
      if (packet.type === MessageType.DATA) arrivalOrder.push(packet.priority);
    });

    // The very first send of a burst always starts writing immediately — there is nothing yet
    // queued to reorder it against. Everything sent *after* it, while that first write is still
    // in flight, is what actually gets reordered by priority.
    const sends = Promise.all([
      client.send(peerId, makePacket(Priority.BULK, "starter")),
      client.send(peerId, makePacket(Priority.BULK, "bulk-2")),
      client.send(peerId, makePacket(Priority.EMERGENCY, "emergency")),
      client.send(peerId, makePacket(Priority.CONTENT, "content")),
    ]);

    await sends;
    await waitFor(() => arrivalOrder.length === 4);

    expect(arrivalOrder).toEqual([Priority.BULK, Priority.EMERGENCY, Priority.CONTENT, Priority.BULK]);
  });

  it("preserves arrival order among packets of the same priority (no starvation, no reordering within a tier)", async () => {
    const serverIdentity = Identity.generate();
    server = new TcpTransport(serverIdentity.nodeId, 0);
    await server.start();

    const clientIdentity = Identity.generate();
    client = new TcpTransport(clientIdentity.nodeId, 0);
    const peerId = await client.connect({ host: "127.0.0.1", port: server.port });

    const arrivalOrder: string[] = [];
    server.onPacket((packet) => {
      if (packet.type === MessageType.DATA) arrivalOrder.push((packet.payload as { label: string }).label);
    });

    await Promise.all([
      client.send(peerId, makePacket(Priority.CONTENT, "first")),
      client.send(peerId, makePacket(Priority.CONTENT, "second")),
      client.send(peerId, makePacket(Priority.CONTENT, "third")),
    ]);
    await waitFor(() => arrivalOrder.length === 3);

    expect(arrivalOrder).toEqual(["first", "second", "third"]);
  });

  it("each send() resolves in true write order, not enqueue order, once its own packet is actually written", async () => {
    const serverIdentity = Identity.generate();
    server = new TcpTransport(serverIdentity.nodeId, 0);
    await server.start();

    const clientIdentity = Identity.generate();
    client = new TcpTransport(clientIdentity.nodeId, 0);
    const peerId = await client.connect({ host: "127.0.0.1", port: server.port });

    // Checked client-side, on the send() promises themselves — asserting against server-side
    // arrival here would race the receiving socket's own async delivery against the local
    // write-completion callback, which isn't guaranteed to land in a particular relative order
    // even when the underlying writes happened in the right sequence.
    const resolutionOrder: string[] = [];
    const starter = client
      .send(peerId, makePacket(Priority.BULK, "starter"))
      .then(() => resolutionOrder.push("starter"));
    const bulk = client.send(peerId, makePacket(Priority.BULK, "bulk")).then(() => resolutionOrder.push("bulk"));
    const emergency = client
      .send(peerId, makePacket(Priority.EMERGENCY, "emergency"))
      .then(() => resolutionOrder.push("emergency"));

    await Promise.all([starter, bulk, emergency]);

    // "emergency" was enqueued after "bulk" but its send() promise still resolves first —
    // proving each send() genuinely tracks its own write completion, in priority order.
    expect(resolutionOrder).toEqual(["starter", "emergency", "bulk"]);
  });

  it("rejects sends once the per-peer queue is full, without blocking sends already accepted", async () => {
    const serverIdentity = Identity.generate();
    server = new TcpTransport(serverIdentity.nodeId, 0);
    await server.start();

    const clientIdentity = Identity.generate();
    client = new TcpTransport(clientIdentity.nodeId, 0);
    const peerId = await client.connect({ host: "127.0.0.1", port: server.port });

    // Issued synchronously (no await between calls) so none of them can drain before all 505
    // are queued: the first begins writing immediately, and JS run-to-completion guarantees the
    // rest enqueue behind it before the event loop ever gets a turn to fire that write's I/O
    // callback and free up space. Matches MAX_QUEUED_SENDS_PER_PEER = 500 in transports/tcp.ts:
    // send #1 starts the in-flight write; sends #2-501 (500 of them) fill the queue; #502-505
    // find it full and are rejected.
    const TOTAL = 505;
    const results = await Promise.allSettled(
      Array.from({ length: TOTAL }, (_, i) => client!.send(peerId, makePacket(Priority.BULK, `p${i}`))),
    );

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(TOTAL - 4);
    expect(rejected.length).toBe(4);
    for (const r of rejected) {
      expect((r.reason as Error).message).toMatch(/send queue full/);
    }
  });

  it("rejects queued sends still waiting behind an in-flight write when the socket is torn down", async () => {
    const serverIdentity = Identity.generate();
    server = new TcpTransport(serverIdentity.nodeId, 0);
    await server.start();

    const clientIdentity = Identity.generate();
    client = new TcpTransport(clientIdentity.nodeId, 0);
    const peerId = await client.connect({ host: "127.0.0.1", port: server.port });

    // "starter" begins writing immediately (queue was empty); "queued" is enqueued behind it
    // while that write is still in flight — exactly the state drainQueue() is in when a peer
    // disconnects mid-burst. Neither promise may be left hanging once the socket is destroyed:
    // "starter"'s write may have already been handed to the kernel by the time destroy() runs
    // (loopback writes this small can complete essentially immediately), so it may legitimately
    // resolve rather than reject — but "queued" never even started writing, so drainQueue() must
    // reject it once it observes the socket is gone, not leave it pending forever.
    const starter = client.send(peerId, makePacket(Priority.BULK, "starter"));
    const queued = client.send(peerId, makePacket(Priority.BULK, "queued"));

    await client.stop();

    await expect(queued).rejects.toThrow();
    // No assertion on which way "starter" settles (see comment above) — just that it does settle
    // at all; if drainQueue() ever left it pending, this await would hang until the test timeout.
    await starter.catch(() => undefined);
  });
});
