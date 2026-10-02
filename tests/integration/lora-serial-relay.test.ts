import { once } from "node:events";
import { MockBinding, type MockPortBinding } from "@serialport/binding-mock";
import { SerialPortStream } from "@serialport/stream";
import { afterEach, describe, expect, it } from "vitest";
import { Identity } from "../../node/src/identity.js";
import { MessageType, Priority, createPacket, type Packet } from "../../node/src/packet.js";
import { LoraSerialTransport } from "../../node/src/transports/lora-serial.js";
import { FakeSX127xSerialDevice, linkFakeRadios } from "../helpers/fake-sx127x-serial-device.js";

let mockPathCounter = 0;

/**
 * Same "two fake radios wired together" shape as
 * `tests/integration/mixed-transport.test.ts` uses for two real
 * `NomadNode`s over TCP+LoRa-simulated — here both ends are
 * `LoraSerialTransport`s driving `FakeSX127xSerialDevice`s linked via
 * `linkFakeRadios()`, standing in for real hardware nowhere available in
 * this environment (see `lora-serial.ts`'s own doc comment on that limit).
 */
async function makeNode(
  options: ConstructorParameters<typeof LoraSerialTransport>[2] = {},
): Promise<{ transport: LoraSerialTransport; nodeId: string; device: FakeSX127xSerialDevice }> {
  const path = `/dev/mock-sx127x-relay-${mockPathCounter++}`;
  MockBinding.createPort(path, { record: true });
  const stream = new SerialPortStream({ binding: MockBinding, path, baudRate: 57600 });
  await once(stream, "open");
  const device = new FakeSX127xSerialDevice(stream.port as MockPortBinding);
  const nodeId = Identity.generate().nodeId;
  const transport = new LoraSerialTransport(nodeId, stream, { pollIntervalMs: 5, connectTimeoutMs: 2000, ...options });
  return { transport, nodeId, device };
}

describe("LoraSerialTransport relay (two fake SX127x devices)", () => {
  const transports: LoraSerialTransport[] = [];

  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop()));
    transports.length = 0;
    MockBinding.reset();
  });

  it("connects, exchanges HELLO over the linked fake radios, and each side learns the other's node id", async () => {
    const a = await makeNode();
    const b = await makeNode();
    transports.push(a.transport, b.transport);
    linkFakeRadios(a.device, b.device);

    await Promise.all([a.transport.start(), b.transport.start()]);

    const bConnected = new Promise<string>((resolve) => b.transport.onPeerConnected((peerId) => resolve(peerId)));
    const peerIdSeenByA = await a.transport.connect({ host: "irrelevant", port: 0 });
    const peerIdSeenByB = await bConnected;

    expect(peerIdSeenByA).toBe(b.nodeId);
    expect(peerIdSeenByB).toBe(a.nodeId);
  });

  it("a packet fragmented across several over-the-air fragments is reassembled correctly on the other end", async () => {
    const a = await makeNode();
    const b = await makeNode();
    transports.push(a.transport, b.transport);
    linkFakeRadios(a.device, b.device);

    await Promise.all([a.transport.start(), b.transport.start()]);
    const peerId = await a.transport.connect({ host: "irrelevant", port: 0 });

    const transmittedFragments: Buffer[] = [];
    a.device.onTransmit = (bytes) => {
      transmittedFragments.push(bytes);
      setTimeout(() => b.device.simulateIncomingRadioFrame(bytes), 0);
    };

    // Comfortably larger than one MTU-sized fragment (default MTU 200, minus a 6-byte header) —
    // forces genuine multi-fragment reassembly, same scenario as tests/unit/lora-transport.test.ts's
    // simulated-transport equivalent.
    const payload = { text: "x".repeat(2000) };
    const received = new Promise<Packet>((resolve) => {
      b.transport.onPacket((packet) => {
        if (packet.type === MessageType.DATA) resolve(packet);
      });
    });
    await a.transport.send(peerId, createPacket({ type: MessageType.DATA, source: a.nodeId, payload }));

    const packet = await received;
    expect(packet.payload).toEqual(payload);
    expect(transmittedFragments.length).toBeGreaterThan(1);
  });

  it("a packet sent in the opposite direction (B to A) also arrives correctly", async () => {
    const a = await makeNode();
    const b = await makeNode();
    transports.push(a.transport, b.transport);
    linkFakeRadios(a.device, b.device);

    await Promise.all([a.transport.start(), b.transport.start()]);
    await a.transport.connect({ host: "irrelevant", port: 0 });

    const payload = { ping: "hello from B" };
    const received = new Promise<Packet>((resolve) => {
      a.transport.onPacket((packet) => {
        if (packet.type === MessageType.DATA) resolve(packet);
      });
    });
    await b.transport.send(a.nodeId, createPacket({ type: MessageType.DATA, source: b.nodeId, payload }));

    const packet = await received;
    expect(packet.payload).toEqual(payload);
  });

  it("connect() rejects once already connected — this driver supports exactly one peer at a time", async () => {
    const a = await makeNode();
    const b = await makeNode();
    transports.push(a.transport, b.transport);
    linkFakeRadios(a.device, b.device);

    await Promise.all([a.transport.start(), b.transport.start()]);
    await a.transport.connect({ host: "irrelevant", port: 0 });

    await expect(a.transport.connect({ host: "irrelevant", port: 0 })).rejects.toThrow(/already connected|connecting/);
  });

  it("send() throws when there is no active connection to the given peer id", async () => {
    const a = await makeNode();
    transports.push(a.transport);
    await a.transport.start();

    await expect(
      a.transport.send("nonexistent-peer-id", createPacket({ type: MessageType.DATA, source: a.nodeId, payload: {} })),
    ).rejects.toThrow(/no active LoRa connection/);
  });

  it("a corrupted (CRC-error) incoming frame is dropped, never delivered to onPacket", async () => {
    const a = await makeNode();
    const b = await makeNode();
    transports.push(a.transport, b.transport);
    linkFakeRadios(a.device, b.device);

    await Promise.all([a.transport.start(), b.transport.start()]);
    await a.transport.connect({ host: "irrelevant", port: 0 });

    let delivered = false;
    b.transport.onPacket((packet) => {
      if (packet.type === MessageType.DATA) delivered = true;
    });

    a.device.onTransmit = (bytes) => setTimeout(() => b.device.simulateIncomingRadioFrame(bytes, { crcError: true }), 0);
    await a.transport.send(b.nodeId, createPacket({ type: MessageType.DATA, source: a.nodeId, payload: { x: 1 } }));

    // Give the RX poll loop several ticks to have noticed it, if it were (incorrectly) going to.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(delivered).toBe(false);
  });

  it("connect() can be retried after a timeout — HELLO is actually re-sent, not silently skipped", async () => {
    // Regression test: an earlier version left `helloSent` stuck `true` after a timed-out connect(),
    // so a retry's sendHelloOnce() became a silent no-op and could never succeed even once the link
    // was fixed (found by review). Deliberately start unlinked so the first attempt genuinely times
    // out, then link the two fakes and retry.
    const a = await makeNode({ connectTimeoutMs: 80 });
    const b = await makeNode();
    transports.push(a.transport, b.transport);
    await Promise.all([a.transport.start(), b.transport.start()]);

    await expect(a.transport.connect({ host: "irrelevant", port: 0 })).rejects.toThrow(/timeout/);

    linkFakeRadios(a.device, b.device);
    const peerId = await a.transport.connect({ host: "irrelevant", port: 0 });
    expect(peerId).toBe(b.nodeId);
  });

  it("two separate send() calls back to back both arrive — pacing isn't limited to one packet's own fragments", async () => {
    // Regression test for the same FIFO-overwrite race the multi-fragment pacing fix addresses
    // (see transmitFragmentBytes()'s doc comment), but triggered across two distinct single-fragment
    // packets sent one right after another — the case an earlier version (pacing only inside one
    // transmitPacket() call) still lost, found by review.
    const a = await makeNode();
    const b = await makeNode();
    transports.push(a.transport, b.transport);
    linkFakeRadios(a.device, b.device);

    await Promise.all([a.transport.start(), b.transport.start()]);
    const peerId = await a.transport.connect({ host: "irrelevant", port: 0 });

    const received: unknown[] = [];
    b.transport.onPacket((packet) => {
      if (packet.type === MessageType.DATA) received.push(packet.payload);
    });

    await Promise.all([
      a.transport.send(peerId, createPacket({ type: MessageType.DATA, source: a.nodeId, payload: { n: 1 } })),
      a.transport.send(peerId, createPacket({ type: MessageType.DATA, source: a.nodeId, payload: { n: 2 } })),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toHaveLength(2);
  });

  it("a fragment count beyond the old single-byte header's 255 limit round-trips correctly", async () => {
    // Regression test for the header widened from 1 to 2 bytes for index/total (found by review).
    // Deliberately keeps the default MTU (so the HELLO handshake itself, which also goes through
    // transmitPacket(), isn't affected) and instead makes the *payload* big enough on its own to need
    // well over 255 fragments (~290 at the default 200-byte MTU) — the old 1-byte total field would
    // have wrapped to 290 & 0xff = 34, truncating reassembly.
    const a = await makeNode();
    const b = await makeNode();
    transports.push(a.transport, b.transport);
    linkFakeRadios(a.device, b.device);

    await Promise.all([a.transport.start(), b.transport.start()]);
    const peerId = await a.transport.connect({ host: "irrelevant", port: 0 });

    const payload = { text: "y".repeat(55_000) };
    const received = new Promise<Packet>((resolve) => {
      b.transport.onPacket((packet) => {
        if (packet.type === MessageType.DATA) resolve(packet);
      });
    });
    await a.transport.send(peerId, createPacket({ type: MessageType.DATA, source: a.nodeId, payload }));

    const packet = await received;
    expect(packet.payload).toEqual(payload);
  }, 20000);

  it("a packet queued at EMERGENCY priority overtakes a BULK packet queued earlier but not yet started (docs/next-steps.md, \"ARALD Data Plane\")", async () => {
    const a = await makeNode();
    const b = await makeNode();
    transports.push(a.transport, b.transport);
    linkFakeRadios(a.device, b.device);

    await Promise.all([a.transport.start(), b.transport.start()]);
    const peerId = await a.transport.connect({ host: "irrelevant", port: 0 });

    const receivedOrder: string[] = [];
    const allReceived = new Promise<void>((resolve) => {
      b.transport.onPacket((packet) => {
        if (packet.type !== MessageType.DATA) return;
        receivedOrder.push((packet.payload as { tag: string }).tag);
        if (receivedOrder.length === 3) resolve();
      });
    });

    // Large enough to need several fragments — gives a window, while it's still transmitting, to
    // queue a second BULK packet and an EMERGENCY one behind it.
    const firstPacket = createPacket({
      type: MessageType.DATA,
      source: a.nodeId,
      priority: Priority.BULK,
      payload: { tag: "bulk-in-flight", text: "x".repeat(2000) },
    });
    const queuedBulk = createPacket({
      type: MessageType.DATA,
      source: a.nodeId,
      priority: Priority.BULK,
      payload: { tag: "bulk-queued-first" },
    });
    const queuedEmergency = createPacket({
      type: MessageType.DATA,
      source: a.nodeId,
      priority: Priority.EMERGENCY,
      payload: { tag: "emergency-queued-second" },
    });

    const originalOnTransmit = a.device.onTransmit;
    let firstFragmentSeen = false;
    a.device.onTransmit = (bytes) => {
      originalOnTransmit?.(bytes);
      if (!firstFragmentSeen) {
        firstFragmentSeen = true;
        // firstPacket's send() is still awaiting its own remaining fragments at this point — both
        // calls below enqueue behind it without jumping the in-flight transmission (can't preempt a
        // real half-duplex radio mid-TX), but the second must still jump the first once both are
        // waiting, since EMERGENCY (0) outranks BULK (5).
        void a.transport.send(peerId, queuedBulk);
        void a.transport.send(peerId, queuedEmergency);
      }
    };

    await a.transport.send(peerId, firstPacket);
    await allReceived;

    expect(receivedOrder).toEqual(["bulk-in-flight", "emergency-queued-second", "bulk-queued-first"]);
  });

  it("rejects sends once sendQueue is full, without blocking sends already accepted (MAX_QUEUED_SENDS, docs/next-steps.md \"ARALD Data Plane\")", async () => {
    // pollIntervalMs lowered from the harness default (5ms) so draining 500 real queued sends stays
    // fast — the bound itself is independent of timing, only how long this test takes to prove it.
    const a = await makeNode({ pollIntervalMs: 1 });
    const b = await makeNode({ pollIntervalMs: 1 });
    transports.push(a.transport, b.transport);
    linkFakeRadios(a.device, b.device);

    await Promise.all([a.transport.start(), b.transport.start()]);
    const peerId = await a.transport.connect({ host: "irrelevant", port: 0 });

    // Issued synchronously (no await between calls), same technique as transports/tcp.ts's own
    // identical test (tests/integration/tcp-priority-scheduling.test.ts) — JS run-to-completion
    // guarantees all 505 enqueue before the drain loop's first `await` ever yields back here: send
    // #1 starts transmitting immediately, #2-501 (500) fill the queue, #502-505 find it full.
    const TOTAL = 505;
    const results = await Promise.allSettled(
      Array.from({ length: TOTAL }, (_, i) =>
        a.transport.send(peerId, createPacket({ type: MessageType.DATA, source: a.nodeId, payload: { n: i } })),
      ),
    );

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(TOTAL - 4);
    expect(rejected.length).toBe(4);
    for (const r of rejected) {
      expect((r.reason as Error).message).toMatch(/send queue full/);
    }
  }, 20000);
});
