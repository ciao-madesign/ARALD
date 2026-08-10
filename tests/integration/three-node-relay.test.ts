import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";

/**
 * Spec §90 "primo obiettivo tecnico": three nodes, A -> B -> C, A has no
 * direct connection to C. No Internet, no BLE — plain TCP on localhost is
 * the point (spec §16): validate multi-hop routing before introducing a
 * radio transport.
 */

function makeNode(displayName: string): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

describe("three-node relay (A -> B -> C)", () => {
  let a: ReturnType<typeof makeNode>;
  let b: ReturnType<typeof makeNode>;
  let c: ReturnType<typeof makeNode>;

  beforeEach(async () => {
    a = makeNode("A");
    b = makeNode("B");
    c = makeNode("C");
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);

    // A <-> B and B <-> C only: A has no direct link to C.
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });
  });

  afterEach(async () => {
    await Promise.all([a.node.stop(), b.node.stop(), c.node.stop()]);
  });

  it("delivers a PING from A to C through B", async () => {
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

    a.node.sendData(c.node.nodeId, { message: "hello from A" });

    await expect(received).resolves.toEqual({ message: "hello from A" });
    await spyOnA;
  });

  it("never delivers a packet to the intermediate relay B as if it were the destination", async () => {
    let bReceivedData = false;
    b.node.on("data", () => {
      bReceivedData = true;
    });

    const received = new Promise<unknown>((resolve) => c.node.once("data", (packet) => resolve(packet.payload)));
    a.node.sendData(c.node.nodeId, { message: "pass through B" });
    await received;

    expect(bReceivedData).toBe(false);
  });
});
