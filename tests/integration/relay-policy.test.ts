import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";

function makeNode(displayName: string, options: ConstructorParameters<typeof NomadNode>[0] = {}): {
  node: NomadNode;
  transport: TcpTransport;
} {
  const node = new NomadNode({ displayName, ...options });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

/**
 * Spec §51/§58: a node can opt out of relaying other peers' traffic (e.g.
 * to save battery) without becoming unreachable itself — it still answers
 * requests addressed directly to it, it just won't ferry someone else's
 * traffic onward to a third node.
 */
describe("relay policy", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("mode 'off': declines to relay A's traffic to C, but still answers A directly", async () => {
    const a = makeNode("A");
    const b = makeNode("B", { relayPolicy: { mode: "off" } });
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });

    const denied = new Promise<string>((resolve) => b.node.once("relay-policy:denied", (peerId: string) => resolve(peerId)));
    let cReceivedData = false;
    c.node.on("data", () => {
      cReceivedData = true;
    });

    a.node.sendData(c.node.nodeId, { message: "B should refuse to carry this" });
    await expect(denied).resolves.toBe(a.node.nodeId);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(cReceivedData).toBe(false);

    // B still answers A directly — opting out of relay doesn't make B unreachable.
    const pongReceived = new Promise<void>((resolve) => a.node.once("pong", () => resolve()));
    a.node.ping(b.node.nodeId);
    await pongReceived;
  });

  it("mode 'battery-above': relays once the reported battery crosses the threshold", async () => {
    let batteryPercent = 5;
    const a = makeNode("A");
    const b = makeNode("B", {
      relayPolicy: { mode: "battery-above", batteryThreshold: 30, getResourceState: () => ({ batteryPercent }) },
    });
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });

    const denied = new Promise<void>((resolve) => b.node.once("relay-policy:denied", () => resolve()));
    a.node.sendData(c.node.nodeId, { attempt: 1 });
    await denied;

    // Battery recovers above the threshold — a fresh relay attempt should now go through.
    batteryPercent = 80;
    const received = new Promise<unknown>((resolve) => c.node.once("data", (packet) => resolve(packet.payload)));
    a.node.sendData(c.node.nodeId, { attempt: 2 });

    await expect(received).resolves.toEqual({ attempt: 2 });
  });
});
