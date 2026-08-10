import { afterEach, describe, expect, it } from "vitest";
import { NomadNode, type NomadNodeOptions } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";

/**
 * Spec §30 "store-and-forward" / §32 "courier": A --X-- C, where X has no
 * path onward to C when the packet arrives. Instead of the packet dying by
 * TTL, X holds it and delivers it once it later connects to C — the same
 * pattern as an escursionista carrying data on a phone between two
 * disconnected rifugi.
 */

function makeNode(displayName: string, options: Partial<NomadNodeOptions> = {}): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName, ...options });
  const transport = new TcpTransport(node.nodeId, 0);
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

describe("store-and-forward (courier scenario)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("an intermediate node queues an undeliverable packet and delivers it once it later connects to the destination", async () => {
    const a = makeNode("A");
    const x = makeNode("X");
    const c = makeNode("C");
    nodes.push(a.node, x.node, c.node);

    await Promise.all([a.node.start(), x.node.start(), c.node.start()]);
    // Only A <-> X exist at first: X has no path onward to C yet.
    await a.node.connect({ host: "127.0.0.1", port: x.transport.port });

    a.node.sendData(c.node.nodeId, { message: "carried by X" });

    // X received the packet from A but has nobody else to flood it to: it queues it instead of dropping it.
    await waitFor(() => x.node.pendingDeliveryCount === 1);

    let received: unknown;
    c.node.once("data", (packet) => {
      received = packet.payload;
    });

    // X later connects to C (the courier "arrives" somewhere new) and flushes its queue.
    await x.node.connect({ host: "127.0.0.1", port: c.transport.port });

    await waitFor(() => received !== undefined);
    expect(received).toEqual({ message: "carried by X" });
    expect(x.node.pendingDeliveryCount).toBe(0);
  });

  it("drops a queued packet once its store-and-forward TTL expires, instead of delivering it late", async () => {
    const a = makeNode("A");
    const x = makeNode("X", { storeAndForwardTtlMs: 50 });
    const c = makeNode("C");
    nodes.push(a.node, x.node, c.node);

    await Promise.all([a.node.start(), x.node.start(), c.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: x.transport.port });

    a.node.sendData(c.node.nodeId, { message: "should expire before delivery" });
    await waitFor(() => x.node.pendingDeliveryCount === 1);

    // Let the 50ms store-and-forward TTL lapse before X gets a chance to deliver it.
    await new Promise((resolve) => setTimeout(resolve, 150));

    let received = false;
    c.node.once("data", () => {
      received = true;
    });

    await x.node.connect({ host: "127.0.0.1", port: c.transport.port });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(received).toBe(false);
    expect(x.node.pendingDeliveryCount).toBe(0);
  });
});
