import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";

/**
 * Spec §57 "abusi": a single peer generating far more traffic than any
 * legitimate use would (flooding) must not be able to consume unbounded
 * processing on this node. Exercises the wire protocol directly (a raw
 * socket standing in for a flooding/non-conforming peer).
 */

describe("rate limiting protects against a flooding peer", () => {
  let victim: NomadNode | undefined;
  let flooderSocket: Socket | undefined;
  let polite: NomadNode | undefined;

  afterEach(async () => {
    flooderSocket?.destroy();
    if (polite) await polite.stop();
    if (victim) await victim.stop();
    victim = undefined;
    flooderSocket = undefined;
    polite = undefined;
  });

  it("drops packets from a peer once it exceeds its per-window budget", async () => {
    victim = new NomadNode({ displayName: "victim", maxPacketsPerWindow: 5, rateLimitWindowMs: 2000 });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    flooderSocket = createConnection({ host: "127.0.0.1", port: victimTransport.port });
    await new Promise<void>((resolve, reject) => {
      flooderSocket!.once("connect", () => resolve());
      flooderSocket!.once("error", reject);
    });

    const flooderId = "9".repeat(64);
    flooderSocket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: flooderId, payload: {} })));

    let exceededCount = 0;
    victim.on("rate-limit:exceeded", () => {
      exceededCount++;
    });

    const totalPings = 50;
    for (let i = 0; i < totalPings; i++) {
      flooderSocket.write(encodePacket(createPacket({ type: MessageType.PING, source: flooderId, payload: {} })));
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    // HELLO itself already used one slot of the 5-packet budget, so at most 4 of the
    // pings could have been processed — the rest must have been dropped as over-budget.
    expect(exceededCount).toBeGreaterThanOrEqual(totalPings - 5);
    expect(exceededCount).toBeLessThanOrEqual(totalPings);
  });

  it("does not rate-limit a well-behaved peer sending well under the budget", async () => {
    victim = new NomadNode({ displayName: "victim2", maxPacketsPerWindow: 5, rateLimitWindowMs: 2000 });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    polite = new NomadNode({ displayName: "polite" });
    const politeTransport = new TcpTransport(polite.nodeId, 0);
    polite.addTransport(politeTransport);
    await polite.start();

    let exceeded = false;
    victim.on("rate-limit:exceeded", () => {
      exceeded = true;
    });

    const pongReceived = new Promise<void>((resolve) => polite!.once("pong", () => resolve()));
    await polite.connect({ host: "127.0.0.1", port: victimTransport.port });
    polite.ping(victim.nodeId);
    await pongReceived;

    expect(exceeded).toBe(false);
  });
});
