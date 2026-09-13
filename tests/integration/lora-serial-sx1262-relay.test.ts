import { once } from "node:events";
import { MockBinding, type MockPortBinding } from "@serialport/binding-mock";
import { SerialPortStream } from "@serialport/stream";
import { afterEach, describe, expect, it } from "vitest";
import { Identity } from "../../node/src/identity.js";
import { MessageType, createPacket, type Packet } from "../../node/src/packet.js";
import { ChipMode } from "../../node/src/transports/sx126x-commands.js";
import { LoraSerialSx1262Transport } from "../../node/src/transports/lora-serial-sx1262.js";
import { FakeSX126xSerialDevice, linkFakeRadios } from "../helpers/fake-sx126x-serial-device.js";

let mockPathCounter = 0;

/**
 * Same "two fake radios wired together" shape as
 * `tests/integration/lora-serial-relay.test.ts` uses for the SX127x driver
 * — here both ends are `LoraSerialSx1262Transport`s driving
 * `FakeSX126xSerialDevice`s linked via `linkFakeRadios()`.
 */
async function makeNode(
  options: ConstructorParameters<typeof LoraSerialSx1262Transport>[2] = {},
  deviceOptions: ConstructorParameters<typeof FakeSX126xSerialDevice>[1] = {},
): Promise<{ transport: LoraSerialSx1262Transport; nodeId: string; device: FakeSX126xSerialDevice }> {
  const path = `/dev/mock-sx1262-relay-${mockPathCounter++}`;
  MockBinding.createPort(path, { record: true });
  const stream = new SerialPortStream({ binding: MockBinding, path, baudRate: 57600 });
  await once(stream, "open");
  const device = new FakeSX126xSerialDevice(stream.port as MockPortBinding, deviceOptions);
  const nodeId = Identity.generate().nodeId;
  const transport = new LoraSerialSx1262Transport(nodeId, stream, { pollIntervalMs: 5, connectTimeoutMs: 2000, ...options });
  return { transport, nodeId, device };
}

describe("LoraSerialSx1262Transport relay (two fake SX126x devices)", () => {
  const transports: LoraSerialSx1262Transport[] = [];

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

  it("start() configures the requested TX power via SetTxParams", async () => {
    const a = await makeNode({ txPowerDbm: 5 });
    transports.push(a.transport);
    await a.transport.start();
    expect(a.device.getLastTxPowerDbmForTest()).toBe(5);
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

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(delivered).toBe(false);
  });

  it("connect() can be retried after a timeout — HELLO is actually re-sent, not silently skipped", async () => {
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
  }, 60000); // ~287 fragments, each several sequential bridge round-trips — found by review to be flaky at 20000ms under CPU contention (several vitest processes running in parallel); generous margin instead of a tighter one tied to this machine's current load

  it("a fragment too large for its WriteBuffer bridge frame fails send() cleanly, and the bridge recovers for a later normal send()", async () => {
    // Regression test found by review: an earlier version of Sx126xBridgeClient.sendOnce() set
    // `this.pending`/its timeout `timer` before evaluating `encodeBridgeFrame()`, which can throw
    // synchronously (payload over sx126x-bridge-protocol.ts's 255-byte MAX_FRAME_PAYLOAD_BYTES) — at
    // mtu=300, a full-size fragment's WriteBuffer bridge-frame payload (opcode+offset+292 data bytes)
    // is 294 bytes, over that limit. The throw still rejected the *current* command correctly (a
    // Promise executor throwing auto-rejects), but left the stale timer running, free to later
    // misfire against a completely different, still-in-flight command. Fixed by clearing
    // `timer`/`pending` synchronously in a catch around the encode step.
    const a = await makeNode({ mtu: 300 });
    const b = await makeNode({ mtu: 300 });
    transports.push(a.transport, b.transport);
    linkFakeRadios(a.device, b.device);

    await Promise.all([a.transport.start(), b.transport.start()]);
    const peerId = await a.transport.connect({ host: "irrelevant", port: 0 });

    const oversizedPayload = { text: "z".repeat(2000) };
    await expect(
      a.transport.send(peerId, createPacket({ type: MessageType.DATA, source: a.nodeId, payload: oversizedPayload })),
    ).rejects.toThrow();

    const normalPayload = { ok: true };
    const received = new Promise<Packet>((resolve) => {
      b.transport.onPacket((packet) => {
        if (packet.type === MessageType.DATA) resolve(packet);
      });
    });
    await a.transport.send(peerId, createPacket({ type: MessageType.DATA, source: a.nodeId, payload: normalPayload }));
    const packet = await received;
    expect(packet.payload).toEqual(normalPayload);
  });

  it("a BUSY response from the bridge is retried transparently, not surfaced as a failure", async () => {
    // Exercises Sx126xBridgeClient.sendWithBusyRetry() — the one bridge-level behavior this chip
    // family has that SX127x's bridge protocol has no equivalent of at all (no BUSY concept there).
    const a = await makeNode();
    const b = await makeNode();
    transports.push(a.transport, b.transport);
    linkFakeRadios(a.device, b.device);

    a.device.simulateBusyOnNextCommand(3); // forces the first 3 bridge commands of start() to be retried
    await Promise.all([a.transport.start(), b.transport.start()]);
    const peerId = await a.transport.connect({ host: "irrelevant", port: 0 });
    expect(peerId).toBe(b.nodeId);
  });

  it("start() rejects when the chip reports an unexpected mode after SetStandby — no chip present, wrong chip, or dead bridge", async () => {
    const a = await makeNode({}, { reportedChipModeOverride: ChipMode.TX });
    transports.push(a.transport);
    await expect(a.transport.start()).rejects.toThrow(/not responding as expected/);
  });
});
