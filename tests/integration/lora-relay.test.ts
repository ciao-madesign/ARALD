import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { LoraSimulatedTransport } from "../../node/src/transports/lora.js";
import { computeContentId } from "../../node/src/content.js";

/**
 * Spec §16, §67: routing/content-centric logic must be completely
 * transport-agnostic. Mirrors `tests/integration/ble-relay.test.ts` for the
 * second radio built on the same `SimulatedLinkTransport` base
 * (`node/src/transports/simulated-link.ts`) — proves the exact same
 * `NomadNode` behavior survives unchanged over a transport with LoRa's own
 * shape (larger-but-still-fragmenting MTU, higher per-fragment latency,
 * a more generous connection cap) exactly as it already does over BLE's.
 *
 * `latencyMs` is set low explicitly everywhere in this file (LoRa's own
 * `DEFAULT_LATENCY_MS` is 250ms, not chosen for test-suite speed) — the
 * default itself is proven directly in `tests/unit/lora-transport.test.ts`
 * ("uses a much higher default latency than BLE..."), same split already
 * used by `ble-relay.test.ts` relying on BLE's already-fast 5ms default.
 */

function makeNode(displayName: string, deviceId: string): { node: NomadNode; transport: LoraSimulatedTransport } {
  const node = new NomadNode({ displayName });
  const transport = new LoraSimulatedTransport(node.nodeId, deviceId, { latencyMs: 2 });
  node.addTransport(transport);
  return { node, transport };
}

describe("NomadNode over a simulated LoRa transport", () => {
  let a: ReturnType<typeof makeNode>;
  let b: ReturnType<typeof makeNode>;
  let c: ReturnType<typeof makeNode>;

  beforeEach(async () => {
    a = makeNode("A", "lora-a");
    b = makeNode("B", "lora-b");
    c = makeNode("C", "lora-c");
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);

    // A <-> B and B <-> C only: A has no direct link to C — same topology as
    // three-node-relay.test.ts/ble-relay.test.ts, just over LoRa.
    await a.node.connect({ host: "lora-b", port: 0 }, "lora-simulated");
    await b.node.connect({ host: "lora-c", port: 0 }, "lora-simulated");
  });

  afterEach(async () => {
    await Promise.all([a.node.stop(), b.node.stop(), c.node.stop()]);
  });

  it("delivers a PING from A to C through B over the fragmented LoRa link", async () => {
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

    a.node.sendData(c.node.nodeId, { message: "hello over LoRa" });

    await expect(received).resolves.toEqual({ message: "hello over LoRa" });
    await spyOnA;
  });

  it("retrieves single-chunk content C holds that A never fetched or knew the location of", async () => {
    const helloBytes = Buffer.from("hello nomad-net world, over LoRa");
    const metadata = c.node.publishContent("hello.txt", "text/plain", helloBytes);
    expect(a.node.contentStore.has(metadata.contentId)).toBe(false);

    const data = await a.node.getContent(metadata.contentId);
    expect(data).toEqual(helloBytes);
    expect(computeContentId(data)).toBe(metadata.contentId);
  });

  it("reassembles multi-chunk content correctly over LoRa", async () => {
    // Standalone pair, not the shared a/b/c fixture — same reasoning as ble-relay.test.ts's own
    // "reassembles multi-chunk content" test: Transport.id ("lora-simulated") identifies a *kind*
    // of transport for NomadNode.connect()'s transportId lookup, not a specific instance.
    const wideA = new NomadNode({ displayName: "A-wide" });
    const wideC = new NomadNode({ displayName: "C-wide" });
    wideA.addTransport(new LoraSimulatedTransport(wideA.nodeId, "lora-a-wide", { latencyMs: 2 }));
    wideC.addTransport(new LoraSimulatedTransport(wideC.nodeId, "lora-c-wide", { latencyMs: 2 }));
    try {
      await Promise.all([wideA.start(), wideC.start()]);
      await wideA.connect({ host: "lora-c-wide", port: 0 }, "lora-simulated");

      const bigFile = Buffer.alloc(4096 * 3 + 123, 42); // several content-level chunks (content.ts's CHUNK_SIZE)
      const metadata = wideC.publishContent("big.bin", "application/octet-stream", bigFile);

      const data = await wideA.getContent(metadata.contentId, { timeoutMs: 5000 });
      expect(data).toEqual(bigFile);
    } finally {
      await Promise.all([wideA.stop(), wideC.stop()]);
    }
  });

  it("rejects a request for content that exists nowhere in the mesh", async () => {
    const unknownId = computeContentId(Buffer.from("never published, over LoRa"));
    await expect(a.node.getContent(unknownId, { timeoutMs: 300 })).rejects.toThrow(/not found/);
  });
});
