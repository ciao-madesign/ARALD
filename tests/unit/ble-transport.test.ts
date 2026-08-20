import { afterEach, describe, expect, it } from "vitest";
import { BleMedium, BleSimulatedTransport } from "../../node/src/transports/ble.js";
import { MessageType, createPacket, type Packet } from "../../node/src/packet.js";
import { Identity } from "../../node/src/identity.js";

function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
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

/**
 * Spec §67, docs/next-steps.md Option A: a simulated BLE `Transport` with no
 * real radio, exercising the same low-level contract (`connect`/`send`/
 * `onPacket`/lifecycle) that `TcpTransport` already validates, plus the
 * fragmentation/reassembly behavior that's genuinely new here (BLE's small
 * MTU forces transport-level fragmentation TCP never needs).
 */
describe("BleSimulatedTransport", () => {
  const transports: BleSimulatedTransport[] = [];
  function makeTransport(
    deviceId: string,
    options?: ConstructorParameters<typeof BleSimulatedTransport>[2],
  ): { transport: BleSimulatedTransport; nodeId: string } {
    const nodeId = Identity.generate().nodeId;
    const t = new BleSimulatedTransport(nodeId, deviceId, options);
    transports.push(t);
    return { transport: t, nodeId };
  }

  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop()));
    transports.length = 0;
  });

  it("connects, exchanges HELLO, and each side learns the other's node id", async () => {
    const a = makeTransport("device-a");
    const b = makeTransport("device-b");
    await Promise.all([a.transport.start(), b.transport.start()]);

    const bConnected = new Promise<string>((resolve) => b.transport.onPeerConnected((peerId) => resolve(peerId)));
    const peerIdSeenByA = await a.transport.connect({ host: "device-b", port: 0 });
    const peerIdSeenByB = await bConnected;

    // A's connect() learns B's node id; B's connected-handler learns A's — two different values,
    // cross-checked against the actual Identity each side was constructed with.
    expect(peerIdSeenByA).toBe(b.nodeId);
    expect(peerIdSeenByB).toBe(a.nodeId);
  });

  it("fragments a packet larger than the MTU and reassembles it correctly on the other end", async () => {
    const mtu = 20;
    const a = makeTransport("device-a", { mtu, latencyMs: 0 });
    const b = makeTransport("device-b", { mtu, latencyMs: 0 });
    await Promise.all([a.transport.start(), b.transport.start()]);
    const peerId = await a.transport.connect({ host: "device-b", port: 0 });

    // Comfortably larger than one MTU-sized fragment — forces genuine multi-fragment reassembly.
    // Filtered to DATA: b's own HELLO exchange (in flight independently of a's connect() already
    // having resolved on a's side — connect() only guarantees *a* is identified, not that b has
    // finished processing a's HELLO yet) also flows through onPacket.
    const payload = { text: "x".repeat(500) };
    const received = new Promise<Packet>((resolve) => {
      b.transport.onPacket((packet) => {
        if (packet.type === MessageType.DATA) resolve(packet);
      });
    });
    await a.transport.send(peerId, createPacket({ type: MessageType.DATA, source: "irrelevant", payload }));

    const packet = await received;
    expect(packet.payload).toEqual(payload);
  });

  it("reassembles fragments correctly even when they arrive out of order", async () => {
    // deliverFragment() schedules each fragment on its own setTimeout(latencyMs) — with a nonzero,
    // slightly jittered-by-the-event-loop latency this isn't strictly guaranteed to preserve send
    // order, so the reassembler must not assume it. Verified directly against FragmentReassembler's
    // public surface would require exporting it; instead this drives the same code path end to end
    // with enough concurrent large sends that out-of-order arrival is realistic, not hypothetical.
    const a = makeTransport("device-a", { mtu: 20, latencyMs: 1 });
    const b = makeTransport("device-b", { mtu: 20, latencyMs: 1 });
    await Promise.all([a.transport.start(), b.transport.start()]);
    const peerId = await a.transport.connect({ host: "device-b", port: 0 });

    const received: any[] = [];
    b.transport.onPacket((packet) => {
      if (packet.type === MessageType.DATA) received.push(packet.payload);
    });

    const payloads = [{ n: 1, text: "a".repeat(300) }, { n: 2, text: "b".repeat(300) }, { n: 3, text: "c".repeat(300) }];
    await Promise.all(
      payloads.map((payload) =>
        a.transport.send(peerId, createPacket({ type: MessageType.DATA, source: "irrelevant", payload })),
      ),
    );

    await waitFor(() => received.length === 3);
    expect(received.sort((x, y) => x.n - y.n)).toEqual(payloads);
  });

  it("rejects a connection attempt once the target is at its own connection limit", async () => {
    const target = makeTransport("device-target", { maxConnections: 1 });
    const first = makeTransport("device-1");
    const second = makeTransport("device-2");
    await Promise.all([target.transport.start(), first.transport.start(), second.transport.start()]);

    await first.transport.connect({ host: "device-target", port: 0 });
    await expect(second.transport.connect({ host: "device-target", port: 0 })).rejects.toThrow(/connection limit|refused/);
  });

  it("a reconnect from an already-connected peer succeeds even while the target is at its connection limit", async () => {
    // Regression test: the capacity check used to run before it was known whether the incoming
    // connection was a brand new peer or a reconnect from one already counted — refusing a
    // legitimate reconnect (net-zero cost to the identified-peer count once it displaces its own
    // stale entry) just because the raw slot count looked full.
    const target = makeTransport("device-target", { maxConnections: 1 });
    const a = makeTransport("device-a");
    await Promise.all([target.transport.start(), a.transport.start()]);

    await a.transport.connect({ host: "device-target", port: 0 });
    await expect(a.transport.connect({ host: "device-target", port: 0 })).resolves.toBe(target.nodeId);
  });

  it("a connect() torn down before it identifies rejects instead of hanging forever", async () => {
    // Regression test: closing a not-yet-identified connection (e.g. the target stopping mid-
    // handshake) used to leave connect()'s promise permanently pending — nothing ever settled it.
    const a = makeTransport("device-a", { latencyMs: 50 }); // large enough that stop() below reliably wins the race
    const b = makeTransport("device-b", { latencyMs: 50 });
    await Promise.all([a.transport.start(), b.transport.start()]);

    const pending = a.transport.connect({ host: "device-b", port: 0 });
    await b.transport.stop(); // torn down before any HELLO round-trip could possibly have completed
    await expect(pending).rejects.toThrow();
  });

  it("two separate BleMedium instances cannot see or reach each other, simulating out-of-range meshes", async () => {
    const medium1 = new BleMedium();
    const medium2 = new BleMedium();
    const a = makeTransport("device-a", { medium: medium1 });
    const b = makeTransport("device-b", { medium: medium2 });
    await Promise.all([a.transport.start(), b.transport.start()]);

    await expect(a.transport.connect({ host: "device-b", port: 0 })).rejects.toThrow(/no BLE device advertising/);
  });

  it("a peer reconnecting displaces the old connection, and B sees exactly one disconnect for the stale one", async () => {
    const a = makeTransport("device-a");
    const b = makeTransport("device-b");
    await Promise.all([a.transport.start(), b.transport.start()]);

    const disconnectedOnB: string[] = [];
    b.transport.onPeerDisconnected((peerId) => disconnectedOnB.push(peerId));
    const connectedOnB: string[] = [];
    b.transport.onPeerConnected((peerId) => connectedOnB.push(peerId));

    await a.transport.connect({ host: "device-b", port: 0 });
    await waitFor(() => connectedOnB.length === 1);

    // A "reconnects" from the same transport instance (same underlying node id) — a fresh
    // connection attempt whose HELLO declares the same source id as before.
    await a.transport.connect({ host: "device-b", port: 0 });
    await waitFor(() => connectedOnB.length === 2);

    // Both connected events are for A (the only peer involved) — the stale first connection was
    // torn down exactly once, not left orphaned and not double-reported.
    expect(connectedOnB.every((id) => id === a.nodeId)).toBe(true);
    expect(disconnectedOnB).toEqual([a.nodeId]);
  });

  it("send() throws when there is no active connection to the given peer id", async () => {
    const a = makeTransport("device-a");
    await a.transport.start();
    await expect(
      a.transport.send("nonexistent-peer-id", createPacket({ type: MessageType.DATA, source: "x", payload: {} })),
    ).rejects.toThrow(/no active BLE connection/);
  });

  it("connect() rejects when the target device isn't advertising at all", async () => {
    const a = makeTransport("device-a");
    await a.transport.start();
    await expect(a.transport.connect({ host: "device-nowhere", port: 0 })).rejects.toThrow(/no BLE device advertising/);
  });
});
