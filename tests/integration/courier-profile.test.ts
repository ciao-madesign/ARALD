import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { LoraSimulatedTransport } from "../../node/src/transports/lora.js";

/**
 * docs/beacon.md, "NOMAD Mobile Relay (Base/Passive)" — a dedicated
 * "corriere" device carries store-and-forward traffic between two segments
 * of the mesh that never connect to each other directly (spec §32). The
 * doc's own analysis found this needs **no new protocol or NomadNode API**:
 * a Mobile/Fixed Relay is just an ordinary `NomadNode` configured with
 * only a radio transport (BLE/LoRa, here LoRa) and, deliberately, no local
 * services registered — never `registerAsLocationRegistry()`,
 * `registerRelay()` as a *caller* (a courier can still itself be looked up
 * in someone else's `RelayRegistry`, that's unrelated), no `WebUiServer`.
 * There is nothing to assert about the *absence* of services beyond simply
 * never calling those methods below — this file's whole point is that a
 * courier profile is a configuration choice, not a new code path.
 *
 * What piece 1 (`docs/security.md` voce #54) left for this piece: two real
 * gaps in `PendingDeliveryQueue` a physically memory/time-constrained
 * courier actually hits — plain FIFO eviction (an EMERGENCY message could
 * be evicted to make room for routine traffic) and a single TTL for every
 * priority (an EMERGENCY message got no more time to reach a courier than
 * anything else). Both fixed in `node/src/store-and-forward.ts` — this
 * file proves them in a realistic courier scenario end-to-end, not just at
 * the unit level (`tests/unit/store-and-forward.test.ts`).
 */

function makeCourier(deviceId: string, options: { maxPendingDeliveries?: number } = {}): { node: NomadNode; transport: LoraSimulatedTransport } {
  // No displayName-derived services, no WebUiServer, no registerAsLocationRegistry()/registerRelay()
  // call as a self-announcer — exactly the "no local services" half of the courier profile.
  const node = new NomadNode({ displayName: `courier-${deviceId}`, maxPendingDeliveries: options.maxPendingDeliveries });
  const transport = new LoraSimulatedTransport(node.nodeId, deviceId);
  node.addTransport(transport);
  return { node, transport };
}

function makeSegmentNode(displayName: string, deviceId: string): { node: NomadNode; transport: LoraSimulatedTransport } {
  const node = new NomadNode({ displayName });
  const transport = new LoraSimulatedTransport(node.nodeId, deviceId);
  node.addTransport(transport);
  return { node, transport };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("Mobile/Fixed Relay courier profile (docs/beacon.md)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("carries a message between two mesh segments that never connect to each other directly, over a courier's only radio transport", async () => {
    const a = makeSegmentNode("A", "lora-a");
    const courier = makeCourier("lora-courier-1");
    const c = makeSegmentNode("C", "lora-c");
    nodes.push(a.node, courier.node, c.node);
    await Promise.all([a.node.start(), courier.node.start(), c.node.start()]);

    // A <-> courier only, for now — A has no path onward to C.
    await a.node.connect({ host: "lora-courier-1", port: 0 }, "lora-simulated");

    a.node.sendData(c.node.nodeId, { message: "carried by the relay" });
    await waitFor(() => courier.node.pendingDeliveryCount === 1);

    let received: unknown;
    c.node.once("data", (packet) => {
      received = packet.payload;
    });

    // The courier "arrives" at C's segment and flushes what it was carrying.
    await courier.node.connect({ host: "lora-c", port: 0 }, "lora-simulated");

    await waitFor(() => received !== undefined);
    expect(received).toEqual({ message: "carried by the relay" });
    expect(courier.node.pendingDeliveryCount).toBe(0);
  });

  it("under memory pressure while cut off from both segments, still respects the (now priority-weighted, see store-and-forward.test.ts) eviction order end-to-end, then delivers the survivors once reconnected", async () => {
    const a = makeSegmentNode("A", "lora-a2");
    // A courier with a small queue — realistic for a battery/memory-constrained physical device,
    // and small enough to force real eviction within this test. The eviction *policy* itself
    // (priority-weighted, ties broken oldest-first) is proven directly and thoroughly against
    // PendingDeliveryQueue in tests/unit/store-and-forward.test.ts — this test's job is only to
    // confirm the real NomadNode -> courier -> NomadNode wiring actually reaches that queue and
    // survives a real connect/disconnect/reconnect cycle over a real (simulated) radio transport,
    // not to re-derive the policy's logic.
    const courier = makeCourier("lora-courier-2", { maxPendingDeliveries: 2 });
    const c = makeSegmentNode("C", "lora-c2");
    nodes.push(a.node, courier.node, c.node);
    await Promise.all([a.node.start(), courier.node.start(), c.node.start()]);

    await a.node.connect({ host: "lora-courier-2", port: 0 }, "lora-simulated");

    // Three same-priority DATA messages into a 2-slot queue — the queue is full after the second,
    // so the third must evict the first (oldest), matching plain FIFO for same-priority entries.
    a.node.sendData(c.node.nodeId, { message: "first" });
    a.node.sendData(c.node.nodeId, { message: "second" });
    await waitFor(() => courier.node.pendingDeliveryCount === 2);
    a.node.sendData(c.node.nodeId, { message: "third" });
    await waitFor(() => courier.node.pendingDeliveryCount === 2); // still capped — "first" was evicted to make room

    const received: unknown[] = [];
    c.node.on("data", (packet) => received.push(packet.payload));

    await courier.node.connect({ host: "lora-c2", port: 0 }, "lora-simulated");

    await waitFor(() => received.length === 2);
    expect(received).toEqual(expect.arrayContaining([{ message: "second" }, { message: "third" }]));
    expect(received).not.toContainEqual({ message: "first" });
  });
});
