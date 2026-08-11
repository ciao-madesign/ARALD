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

function waitFor(predicate: () => boolean, timeoutMs = 1000, intervalMs = 15): Promise<void> {
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

/**
 * Regression test: the relay-policy/trust gates in handlePacket only ran
 * when a packet was first offered for forwarding — a packet that got
 * queued for store-and-forward (spec §30) and later retried via
 * flushPendingDeliveries() bypassed both gates entirely, silently
 * defeating a relay policy or trust revocation for anything already
 * queued by the time conditions changed.
 */
describe("store-and-forward retries still respect the relay policy gate", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("does not deliver a queued packet once it's retried, if the relay policy denies at retry time", async () => {
    const a = makeNode("A");
    const x = makeNode("X", { relayPolicy: { mode: "off" } });
    const c = makeNode("C");
    nodes.push(a.node, x.node, c.node);

    await Promise.all([a.node.start(), x.node.start(), c.node.start()]);
    // Only A <-> X exist at first: X has no path onward to C yet.
    await a.node.connect({ host: "127.0.0.1", port: x.transport.port });

    a.node.sendData(c.node.nodeId, { message: "should never reach C" });
    await waitFor(() => x.node.pendingDeliveryCount === 1);

    let cReceivedData = false;
    c.node.on("data", () => {
      cReceivedData = true;
    });
    const deniedAgain = new Promise<void>((resolve) => x.node.once("relay-policy:denied", () => resolve()));

    // X now connects to C — the queue flush fires, but X's relay policy is "off": the retry must
    // be denied too, exactly like the original forward attempt was, not silently let through.
    await x.node.connect({ host: "127.0.0.1", port: c.transport.port });
    await deniedAgain;

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(cReceivedData).toBe(false);
    // The packet is still worth retrying later (e.g. if the policy changes), not dropped outright.
    expect(x.node.pendingDeliveryCount).toBe(1);
  });
});
