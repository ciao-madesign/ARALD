import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { TrustLevel } from "../../node/src/trust.js";

function makeNode(displayName: string, options: ConstructorParameters<typeof NomadNode>[0] = {}): {
  node: NomadNode;
  transport: TcpTransport;
} {
  const node = new NomadNode({ displayName, ...options });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

describe("trust levels", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("marks a directly-connected peer as SEEN as soon as it connects", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a.node.start(), b.node.start()]);

    // a.node.connect() resolving only proves A has identified B on its outbound socket; B's
    // inbound side processes A's HELLO on its own, independent, asynchronous read — wait for both.
    const bSeesA = new Promise<void>((resolve) => b.node.once("peer:connected", () => resolve()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await bSeesA;

    expect(a.node.trust.get(b.node.nodeId)).toBe(TrustLevel.SEEN);
    expect(b.node.trust.get(a.node.nodeId)).toBe(TrustLevel.SEEN);
  });

  it("promotes a publisher to VERIFIED once its signature has actually been checked", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });

    expect(a.node.trust.get(c.node.nodeId)).toBe(TrustLevel.UNKNOWN); // never even connected directly

    const metadata = c.node.publishContent("bollettino.txt", "text/plain", Buffer.from("neve fresca"));
    await a.node.getContent(metadata.contentId);

    // A never connected directly to C, so it only ever heard about C's identity through
    // its signature — this is VERIFIED evidence, stronger than the SEEN a direct peer gets.
    expect(a.node.trust.get(c.node.nodeId)).toBe(TrustLevel.VERIFIED);
  });

  it("declines to relay traffic from a peer below the configured minTrustToRelay, without affecting that peer's own direct requests", async () => {
    const a = makeNode("A");
    const b = makeNode("B", { minTrustToRelay: TrustLevel.VERIFIED });
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });

    // A is only SEEN at B (just connected, never produced a verified signature).
    expect(b.node.trust.get(a.node.nodeId)).toBe(TrustLevel.SEEN);

    const denied = new Promise<string>((resolve) => b.node.once("trust:relay-denied", (peerId: string) => resolve(peerId)));
    let cReceivedData = false;
    c.node.on("data", () => {
      cReceivedData = true;
    });

    a.node.sendData(c.node.nodeId, { message: "should be blocked at B" });
    await expect(denied).resolves.toBe(a.node.nodeId);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(cReceivedData).toBe(false);

    // A's own direct interaction with B (not relayed onward) is unaffected by the gate.
    const pongReceived = new Promise<void>((resolve) => a.node.once("pong", () => resolve()));
    a.node.ping(b.node.nodeId);
    await pongReceived;
  });
});
