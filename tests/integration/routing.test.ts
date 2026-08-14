import { afterEach, describe, expect, it, vi } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, type Packet } from "../../node/src/packet.js";

/**
 * Spec §22 "routing evoluto": once a node has learned a path to a
 * destination via distance-vector ROUTE_ANNOUNCE exchanges, unicast traffic
 * should travel that specific path instead of being blindly flooded to
 * every connected peer. Controlled flooding (spec §21) remains the
 * fallback/bootstrap mechanism — used before a route has converged, and
 * whenever the known route turns out to be stale — and stays the only
 * mechanism for broadcast traffic (e.g. CONTENT_QUERY), which is untouched
 * by any of this.
 */
function makeNode(displayName: string): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 15): Promise<void> {
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

describe("distance-vector routing", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("seeds a direct, cost-1 route to a peer the instant it connects", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a.node.start(), b.node.start()]);

    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });

    expect(a.node.routingTable.bestRoute(b.node.nodeId)).toEqual({ nextHop: b.node.nodeId, cost: 1 });
  });

  it("converges to a cost-2 route across a 3-node chain via ROUTE_ANNOUNCE, even though A never connects to C directly", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);

    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });

    await waitFor(() => a.node.routingTable.has(c.node.nodeId));
    expect(a.node.routingTable.bestRoute(c.node.nodeId)).toEqual({ nextHop: b.node.nodeId, cost: 2 });
  });

  it("delivers unicast DATA before any route has converged, via the flooding fallback", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });

    // Fire immediately — do not wait for routing convergence first.
    const received = new Promise<unknown>((resolve) => c.node.once("data", (packet) => resolve(packet.payload)));
    a.node.sendData(c.node.nodeId, { hello: "world" });

    await expect(received).resolves.toEqual({ hello: "world" });
  });

  it("routes a unicast send to a single next hop instead of flooding to every peer, once a route is known", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    const d = makeNode("D");
    nodes.push(a.node, b.node, c.node, d.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start(), d.node.start()]);

    // Diamond: A -> {B, C} -> D. Under pure flooding, A would send a D-bound
    // unicast packet to both B and C. With routing, it should go to exactly one.
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await a.node.connect({ host: "127.0.0.1", port: c.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: d.transport.port });
    await c.node.connect({ host: "127.0.0.1", port: d.transport.port });

    await waitFor(() => a.node.routingTable.has(d.node.nodeId));
    const route = a.node.routingTable.bestRoute(d.node.nodeId)!;
    expect([b.node.nodeId, c.node.nodeId]).toContain(route.nextHop);

    const sendToPeerSpy = vi.spyOn(a.node as unknown as { sendToPeer(id: string, p: Packet): Promise<boolean> }, "sendToPeer");
    const received = new Promise<unknown>((resolve) => d.node.once("data", (packet) => resolve(packet.payload)));

    a.node.sendData(d.node.nodeId, { hello: "D" });
    await expect(received).resolves.toEqual({ hello: "D" });

    // Other calls may have gone out concurrently for unrelated routing-protocol traffic
    // (ROUTE_ANNOUNCE, IDENTITY_REQUEST, ...) — only the DATA send itself needs to have gone
    // to exactly one peer instead of being flooded to both B and C.
    const dataSends = sendToPeerSpy.mock.calls.filter(([, packet]) => packet.type === MessageType.DATA);
    expect(dataSends).toHaveLength(1);
    expect(dataSends[0][0]).toBe(route.nextHop);
  });

  it("withdraws routes through a peer once it disconnects", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start()]);
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });
    await waitFor(() => a.node.routingTable.has(c.node.nodeId));

    await b.node.stop();
    await waitFor(() => !a.node.routingTable.has(b.node.nodeId));

    expect(a.node.routingTable.has(b.node.nodeId)).toBe(false);
    expect(a.node.routingTable.has(c.node.nodeId)).toBe(false); // was only reachable via B
  });

  it("still delivers after losing its routed path, falling back to flooding through a surviving link", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    const d = makeNode("D");
    nodes.push(a.node, b.node, c.node, d.node);
    await Promise.all([a.node.start(), b.node.start(), c.node.start(), d.node.start()]);

    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await a.node.connect({ host: "127.0.0.1", port: c.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: d.transport.port });
    await c.node.connect({ host: "127.0.0.1", port: d.transport.port });
    await waitFor(() => a.node.routingTable.has(d.node.nodeId));

    // Take down whichever of B/C ended up as A's chosen next hop to D.
    const winner = a.node.routingTable.bestRoute(d.node.nodeId)!.nextHop === b.node.nodeId ? b.node : c.node;
    await winner.stop();
    await waitFor(() => !a.node.routingTable.has(d.node.nodeId));

    // A no longer has any route knowledge for D, but the surviving relay
    // still has its own direct route to D, so flooding still gets there.
    const received = new Promise<unknown>((resolve) => d.node.once("data", (packet) => resolve(packet.payload)));
    a.node.sendData(d.node.nodeId, { hello: "still reachable" });

    await expect(received).resolves.toEqual({ hello: "still reachable" });
  });
});
