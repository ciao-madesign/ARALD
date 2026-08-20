import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { BleSimulatedTransport } from "../../node/src/transports/ble.js";
import { computeContentId } from "../../node/src/content.js";

/**
 * Spec §16, §67: routing/content-centric logic must be completely
 * transport-agnostic. Rather than re-testing routing itself (already
 * covered thoroughly over TCP in three-node-relay.test.ts and
 * content-retrieval.test.ts), this proves the exact same `NomadNode`
 * behavior survives unchanged over a transport with a genuinely different
 * shape: small MTU forcing fragmentation, a real connection cap, simulated
 * link latency — none of which routing/content code above the `Transport`
 * interface has any awareness of.
 */

function makeNode(displayName: string, deviceId: string): { node: NomadNode; transport: BleSimulatedTransport } {
  const node = new NomadNode({ displayName });
  const transport = new BleSimulatedTransport(node.nodeId, deviceId);
  node.addTransport(transport);
  return { node, transport };
}

describe("NomadNode over a simulated BLE transport", () => {
  let a: ReturnType<typeof makeNode>;
  let b: ReturnType<typeof makeNode>;
  let c: ReturnType<typeof makeNode>;

  beforeEach(async () => {
    a = makeNode("A", "ble-a");
    b = makeNode("B", "ble-b");
    c = makeNode("C", "ble-c");
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);

    // A <-> B and B <-> C only: A has no direct link to C — same topology as
    // three-node-relay.test.ts, just over BLE instead of TCP.
    await a.node.connect({ host: "ble-b", port: 0 }, "ble-simulated");
    await b.node.connect({ host: "ble-c", port: 0 }, "ble-simulated");
  });

  afterEach(async () => {
    await Promise.all([a.node.stop(), b.node.stop(), c.node.stop()]);
  });

  it("delivers a PING from A to C through B over the fragmented BLE link", async () => {
    const pongReceived = new Promise<string>((resolve) => a.node.once("pong", resolve));
    a.node.ping(c.node.nodeId);
    await expect(pongReceived).resolves.toBe(c.node.nodeId);
  });

  it("delivers DATA from A to C through B, and A does not receive it as if it were the destination", async () => {
    const received = new Promise<unknown>((resolve) => c.node.once("data", (packet) => resolve(packet.payload)));
    const spyOnA = new Promise<void>((resolve, reject) => {
      a.node.once("data", () => reject(new Error("A should not receive a DATA packet addressed to C")));
      setTimeout(resolve, 500);
    });

    a.node.sendData(c.node.nodeId, { message: "hello over BLE" });

    await expect(received).resolves.toEqual({ message: "hello over BLE" });
    await spyOnA;
  });

  it("retrieves single-chunk content C holds that A never fetched or knew the location of", async () => {
    // Its JSON-encoded CONTENT_FOUND/REQUEST/CHUNK/COMPLETE packets are all comfortably larger than
    // the default 20-byte MTU — this genuinely exercises transport-level fragmentation for every
    // step of the content-centric protocol, not just a single hand-picked packet.
    const helloBytes = Buffer.from("hello nomad-net world, over BLE");
    const metadata = c.node.publishContent("hello.txt", "text/plain", helloBytes);
    expect(a.node.contentStore.has(metadata.contentId)).toBe(false);

    const data = await a.node.getContent(metadata.contentId);
    expect(data).toEqual(helloBytes);
    expect(computeContentId(data)).toBe(metadata.contentId);
  });

  it("reassembles multi-chunk content correctly over BLE", async () => {
    // Standalone pair, not the shared a/b/c fixture: Transport.id ("ble-simulated") identifies a
    // *kind* of transport for NomadNode.connect()'s transportId lookup (pickTransport(), node.ts),
    // not a specific instance — a node can't usefully carry two separate BleSimulatedTransport
    // instances at once, so a wider MTU needs its own pair of nodes rather than a second transport
    // bolted onto the existing ones. A higher, still BLE-realistic MTU (well within the 247-byte
    // range BLE 4.2+ negotiates) than the 20-byte default used elsewhere in this file — multi-
    // CONTENT_CHUNK reassembly is what this test proves, not raw fragment count, and thousands of
    // 20-byte fragments for a several-KB file would only slow the test without exercising anything
    // new (the low-level fragmentation/reassembly mechanics are already proven directly in
    // ble-transport.test.ts).
    const wideA = new NomadNode({ displayName: "A-wide" });
    const wideC = new NomadNode({ displayName: "C-wide" });
    wideA.addTransport(new BleSimulatedTransport(wideA.nodeId, "ble-a-wide", { mtu: 200 }));
    wideC.addTransport(new BleSimulatedTransport(wideC.nodeId, "ble-c-wide", { mtu: 200 }));
    try {
      await Promise.all([wideA.start(), wideC.start()]);
      await wideA.connect({ host: "ble-c-wide", port: 0 }, "ble-simulated");

      const bigFile = Buffer.alloc(4096 * 3 + 123, 42); // several content-level chunks (content.ts's CHUNK_SIZE)
      const metadata = wideC.publishContent("big.bin", "application/octet-stream", bigFile);

      const data = await wideA.getContent(metadata.contentId, { timeoutMs: 5000 });
      expect(data).toEqual(bigFile);
    } finally {
      await Promise.all([wideA.stop(), wideC.stop()]);
    }
  });

  it("rejects a request for content that exists nowhere in the mesh", async () => {
    const unknownId = computeContentId(Buffer.from("never published, over BLE"));
    await expect(a.node.getContent(unknownId, { timeoutMs: 300 })).rejects.toThrow(/not found/);
  });
});
