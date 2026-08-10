import { describe, expect, it } from "vitest";
import { createPacket, MessageType } from "../../node/src/packet.js";
import { SeenCache, decideForward } from "../../node/src/routing.js";

describe("routing / decideForward", () => {
  it("delivers a unicast packet addressed to us, without forwarding it further", () => {
    const packet = createPacket({ type: MessageType.DATA, source: "A", destination: "C", payload: {} });
    const decision = decideForward(packet, "C", new SeenCache());
    expect(decision.deliverLocally).toBe(true);
    expect(decision.forwardPacket).toBeUndefined();
  });

  it("forwards (relays) a unicast packet addressed to someone else, decrementing TTL", () => {
    const packet = createPacket({ type: MessageType.DATA, source: "A", destination: "C", ttl: 5, payload: {} });
    const decision = decideForward(packet, "B", new SeenCache());
    expect(decision.deliverLocally).toBe(false);
    expect(decision.forwardPacket?.ttl).toBe(4);
  });

  it("drops a unicast packet for someone else once TTL is exhausted", () => {
    const packet = createPacket({ type: MessageType.DATA, source: "A", destination: "C", ttl: 0, payload: {} });
    const decision = decideForward(packet, "B", new SeenCache());
    expect(decision.forwardPacket).toBeUndefined();
  });

  it("both delivers locally and keeps flooding a broadcast packet (e.g. CONTENT_QUERY)", () => {
    const packet = createPacket({ type: MessageType.CONTENT_QUERY, source: "A", ttl: 5, payload: {} });
    const decision = decideForward(packet, "B", new SeenCache());
    expect(decision.deliverLocally).toBe(true);
    expect(decision.forwardPacket?.ttl).toBe(4);
  });

  it("drops a duplicate packet id without delivering or forwarding it again", () => {
    const seenCache = new SeenCache();
    const packet = createPacket({ type: MessageType.CONTENT_QUERY, source: "A", ttl: 5, payload: {} });

    const first = decideForward(packet, "B", seenCache);
    expect(first.duplicate).toBe(false);

    const second = decideForward(packet, "B", seenCache);
    expect(second.duplicate).toBe(true);
    expect(second.deliverLocally).toBe(false);
    expect(second.forwardPacket).toBeUndefined();
  });
});

describe("SeenCache", () => {
  it("evicts the oldest entry once it exceeds its max size", () => {
    const cache = new SeenCache(2);
    cache.markSeen("a");
    cache.markSeen("b");
    cache.markSeen("c");
    expect(cache.size).toBe(2);
    expect(cache.hasSeen("a")).toBe(false);
    expect(cache.hasSeen("c")).toBe(true);
  });
});
