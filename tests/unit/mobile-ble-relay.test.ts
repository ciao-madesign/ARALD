import { describe, expect, it } from "vitest";
import { PendingRelayQueue, SeenCache, decideForward } from "../../mobile/www/ble-relay.js";

function packet(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "p1",
    type: "DATA",
    source: "A",
    ttl: 8,
    timestamp: Date.now(),
    priority: 4,
    payload: {},
    ...overrides,
  };
}

describe("mobile/www/ble-relay (phone-side relay/store-and-forward logic)", () => {
  describe("SeenCache", () => {
    it("does not report an unseen id as seen", () => {
      const cache = new SeenCache();
      expect(cache.hasSeen("x")).toBe(false);
    });

    it("reports a marked id as seen", () => {
      const cache = new SeenCache();
      cache.markSeen("x");
      expect(cache.hasSeen("x")).toBe(true);
    });

    it("evicts the oldest id once full", () => {
      const cache = new SeenCache(3);
      cache.markSeen("a");
      cache.markSeen("b");
      cache.markSeen("c");
      cache.markSeen("d"); // pushes "a" out
      expect(cache.hasSeen("a")).toBe(false);
      expect(cache.hasSeen("b")).toBe(true);
      expect(cache.hasSeen("d")).toBe(true);
      expect(cache.size).toBe(3);
    });
  });

  describe("decideForward", () => {
    it("drops an already-seen packet, never delivers or forwards it", () => {
      const seen = new SeenCache();
      seen.markSeen("p1");
      const decision = decideForward(packet({ id: "p1" }), "me", seen);
      expect(decision.duplicate).toBe(true);
      expect(decision.deliverLocally).toBe(false);
      expect(decision.forwardPacket).toBeUndefined();
    });

    it("delivers but does not forward a unicast packet addressed to the local node", () => {
      const seen = new SeenCache();
      const decision = decideForward(packet({ destination: "me", ttl: 5 }), "me", seen);
      expect(decision.duplicate).toBe(false);
      expect(decision.deliverLocally).toBe(true);
      expect(decision.forwardPacket).toBeUndefined();
    });

    it("forwards but does not deliver a unicast packet addressed to someone else", () => {
      const seen = new SeenCache();
      const decision = decideForward(packet({ destination: "other", ttl: 5 }), "me", seen);
      expect(decision.duplicate).toBe(false);
      expect(decision.deliverLocally).toBe(false);
      expect(decision.forwardPacket).toMatchObject({ destination: "other", ttl: 4 });
    });

    it("both delivers and forwards a broadcast packet (no destination)", () => {
      const seen = new SeenCache();
      const decision = decideForward(packet({ ttl: 5 }), "me", seen);
      expect(decision.duplicate).toBe(false);
      expect(decision.deliverLocally).toBe(true);
      expect(decision.forwardPacket).toMatchObject({ ttl: 4 });
    });

    it("never forwards a packet whose ttl has already reached 0", () => {
      const seen = new SeenCache();
      const decision = decideForward(packet({ ttl: 0 }), "me", seen);
      expect(decision.forwardPacket).toBeUndefined();
    });

    it("marks a packet as seen the first time, so a later identical id is treated as duplicate", () => {
      const seen = new SeenCache();
      decideForward(packet({ id: "p2" }), "me", seen);
      const second = decideForward(packet({ id: "p2" }), "me", seen);
      expect(second.duplicate).toBe(true);
    });
  });

  describe("PendingRelayQueue", () => {
    it("enqueues and drains an entry addressed to the newly connected peer", () => {
      const queue = new PendingRelayQueue();
      queue.enqueue(packet({ id: "p3", destination: "clip-1" }));
      const drained = queue.drainFor("clip-1");
      expect(drained).toHaveLength(1);
      expect(drained[0].packet.id).toBe("p3");
      expect(queue.size).toBe(0);
    });

    it("leaves entries addressed to a different peer in the queue", () => {
      const queue = new PendingRelayQueue();
      queue.enqueue(packet({ id: "p4", destination: "clip-2" }));
      const drained = queue.drainFor("clip-1");
      expect(drained).toHaveLength(0);
      expect(queue.size).toBe(1);
    });

    it("never enqueues the same packet id twice", () => {
      const queue = new PendingRelayQueue();
      queue.enqueue(packet({ id: "p5", destination: "clip-1" }));
      queue.enqueue(packet({ id: "p5", destination: "clip-1" }));
      expect(queue.size).toBe(1);
    });

    it("silently drops an expired entry instead of draining it", () => {
      const queue = new PendingRelayQueue({ ttlMs: -1 }); // already expired the instant it's enqueued
      queue.enqueue(packet({ id: "p6", destination: "clip-1" }));
      const drained = queue.drainFor("clip-1");
      expect(drained).toHaveLength(0);
      expect(queue.size).toBe(0);
    });

    it("gives an EMERGENCY-priority entry a longer TTL than an ordinary one", () => {
      const queue = new PendingRelayQueue({ ttlMs: -1, emergencyTtlMs: 60000 });
      queue.enqueue(packet({ id: "p7", destination: "clip-1", priority: 0 })); // EMERGENCY
      queue.enqueue(packet({ id: "p8", destination: "clip-1", priority: 4 })); // ordinary, already expired
      const drained = queue.drainFor("clip-1");
      const ids = drained.map((d) => d.packet.id);
      expect(ids).toContain("p7");
      expect(ids).not.toContain("p8");
    });

    it("evicts the lowest-priority entry when full, never an EMERGENCY one while a lower-priority alternative exists", () => {
      const queue = new PendingRelayQueue({ maxSize: 2 });
      queue.enqueue(packet({ id: "emergency", destination: "clip-1", priority: 0 }));
      queue.enqueue(packet({ id: "bulk", destination: "clip-1", priority: 5 }));
      queue.enqueue(packet({ id: "new-arrival", destination: "clip-1", priority: 4 })); // triggers eviction
      expect(queue.has("emergency")).toBe(true);
      expect(queue.has("bulk")).toBe(false);
      expect(queue.has("new-arrival")).toBe(true);
    });

    it("evicts the oldest among equal-priority entries when full", () => {
      const queue = new PendingRelayQueue({ maxSize: 2 });
      queue.enqueue(packet({ id: "oldest", destination: "clip-1", priority: 4 }));
      queue.enqueue(packet({ id: "newer", destination: "clip-1", priority: 4 }));
      queue.enqueue(packet({ id: "newest", destination: "clip-1", priority: 4 }));
      expect(queue.has("oldest")).toBe(false);
      expect(queue.has("newer")).toBe(true);
      expect(queue.has("newest")).toBe(true);
    });

    it("clamps a forged/out-of-range priority to the lowest urgency for eviction purposes", () => {
      const queue = new PendingRelayQueue({ maxSize: 2 });
      queue.enqueue(packet({ id: "legit-emergency", destination: "clip-1", priority: 0 }));
      queue.enqueue(packet({ id: "forged", destination: "clip-1", priority: -1 })); // out of range, not a real EMERGENCY
      queue.enqueue(packet({ id: "new-arrival", destination: "clip-1", priority: 4 }));
      // The forged entry must lose eviction priority to the legitimate EMERGENCY one — never the other way around.
      expect(queue.has("legit-emergency")).toBe(true);
      expect(queue.has("forged")).toBe(false);
    });
  });
});
