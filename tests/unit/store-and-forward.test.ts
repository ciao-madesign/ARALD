import { describe, expect, it } from "vitest";
import { createPacket, MessageType, Priority } from "../../node/src/packet.js";
import { PendingDeliveryQueue } from "../../node/src/store-and-forward.js";

function packetTo(destination: string, priority?: Priority): ReturnType<typeof createPacket> {
  return createPacket({ type: MessageType.DATA, source: "A", destination, payload: {}, priority });
}

describe("PendingDeliveryQueue", () => {
  it("drains a queued packet back out, remembering who not to resend it to", () => {
    const queue = new PendingDeliveryQueue();
    const packet = packetTo("C");
    queue.enqueue(packet, "A");
    expect(queue.size).toBe(1);

    const drained = queue.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0].packet).toBe(packet);
    expect(drained[0].exceptPeerId).toBe("A");
    expect(queue.size).toBe(0);
  });

  it("does not queue the same packet id twice", () => {
    const queue = new PendingDeliveryQueue();
    const packet = packetTo("C");
    queue.enqueue(packet);
    queue.enqueue(packet);
    expect(queue.size).toBe(1);
  });

  it("evicts the oldest entry once maxSize is exceeded", () => {
    const queue = new PendingDeliveryQueue({ maxSize: 2 });
    const first = packetTo("C");
    const second = packetTo("D");
    const third = packetTo("E");
    queue.enqueue(first);
    queue.enqueue(second);
    queue.enqueue(third);

    expect(queue.size).toBe(2);
    expect(queue.has(first.id)).toBe(false);
    expect(queue.has(third.id)).toBe(true);
  });

  it("drops (does not return) entries that expired while queued", async () => {
    const queue = new PendingDeliveryQueue({ ttlMs: 10 });
    queue.enqueue(packetTo("C"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(queue.drain()).toEqual([]);
    expect(queue.size).toBe(0);
  });

  it("evicts a lower-priority entry before a higher-priority one, even though it was queued more recently", () => {
    const queue = new PendingDeliveryQueue({ maxSize: 2 });
    const bulk = packetTo("C", Priority.BULK);
    const emergency = packetTo("D", Priority.EMERGENCY);
    queue.enqueue(bulk);
    queue.enqueue(emergency);

    // A third, ordinary-priority packet arrives — under plain FIFO this would evict `bulk` (still
    // correct here), but the real proof is the next assertion: a *fourth* packet must evict `bulk`'s
    // replacement rather than ever touching `emergency`, which plain FIFO would eventually reach.
    const third = packetTo("E", Priority.CONTENT);
    queue.enqueue(third);
    expect(queue.has(bulk.id)).toBe(false);
    expect(queue.has(emergency.id)).toBe(true);

    const fourth = packetTo("F", Priority.CONTENT);
    queue.enqueue(fourth);
    expect(queue.has(third.id)).toBe(false);
    expect(queue.has(emergency.id)).toBe(true); // still never evicted, despite being the oldest entry by now
  });

  it("breaks a tie between same-priority entries by evicting the older one first (matches plain FIFO)", () => {
    const queue = new PendingDeliveryQueue({ maxSize: 2 });
    const first = packetTo("C", Priority.CONTENT);
    const second = packetTo("D", Priority.CONTENT);
    const third = packetTo("E", Priority.CONTENT);
    queue.enqueue(first);
    queue.enqueue(second);
    queue.enqueue(third);

    expect(queue.has(first.id)).toBe(false);
    expect(queue.has(third.id)).toBe(true);
  });

  it("holds an EMERGENCY packet past the point an ordinary-priority one would already have expired", async () => {
    const queue = new PendingDeliveryQueue({ ttlMs: 20, emergencyTtlMs: 200 });
    queue.enqueue(packetTo("C", Priority.CONTENT));
    queue.enqueue(packetTo("D", Priority.EMERGENCY));

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Draining removes every entry regardless of expiry, keeping only what's still ready — the
    // ordinary packet is gone, the emergency one is still well within its own longer TTL.
    const drained = queue.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0].packet.priority).toBe(Priority.EMERGENCY);
  });

  it("never lets a forged/out-of-range priority evade eviction ahead of a real EMERGENCY entry (regression, docs/security.md voce #55)", () => {
    const queue = new PendingDeliveryQueue({ maxSize: 2 });
    // packet.priority is untrusted network input — decodePacket() never validates it — so a peer
    // could send a packet claiming an out-of-range value like this. Before the priorityRank() clamp,
    // `-forged.priority` (= 1000) would have outscored every legitimate priority, including EMERGENCY.
    const forged = packetTo("C", -1000 as Priority);
    const emergency = packetTo("D", Priority.EMERGENCY);
    queue.enqueue(forged);
    queue.enqueue(emergency);

    const real = packetTo("E", Priority.CONTENT);
    queue.enqueue(real);

    expect(queue.has(forged.id)).toBe(false); // clamped to Priority.BULK-equivalent, evicted first
    expect(queue.has(emergency.id)).toBe(true);
  });

  it("also clamps a missing/NaN priority the same way (not just negative)", () => {
    const queue = new PendingDeliveryQueue({ maxSize: 2 });
    const malformed = packetTo("C");
    // createPacket() itself always fills in a default priority, so a genuinely missing/malformed
    // value (as a real decodePacket() output from untrusted network JSON could produce, since it
    // never validates this field) has to be simulated by mutating the decoded object directly.
    (malformed as { priority: unknown }).priority = NaN;
    const emergency = packetTo("D", Priority.EMERGENCY);
    queue.enqueue(malformed);
    queue.enqueue(emergency);

    const real = packetTo("E", Priority.CONTENT);
    queue.enqueue(real);

    expect(queue.has(malformed.id)).toBe(false);
    expect(queue.has(emergency.id)).toBe(true);
  });

  it("requeue() preserves the original expiresAt instead of granting a fresh TTL window (regression, docs/security.md voce #55)", async () => {
    const queue = new PendingDeliveryQueue({ ttlMs: 30 });
    queue.enqueue(packetTo("C"), "A");
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Simulate flushPendingDeliveries()'s "still worth retrying later" path: drain, then re-queue
    // the same delivery because a relay gate denied it this time.
    const [delivery] = queue.drain();
    queue.requeue(delivery);

    // Waiting past the *original* ttlMs (30ms) — a fresh 30ms window granted by requeue() would
    // still have this entry alive; carrying the original expiresAt through means it's already gone.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(queue.drain()).toEqual([]);
  });

  it("requeue() is a no-op once the original deadline has already passed", async () => {
    const queue = new PendingDeliveryQueue({ ttlMs: 10 });
    queue.enqueue(packetTo("C"));
    const [delivery] = queue.drain();

    await new Promise((resolve) => setTimeout(resolve, 30)); // well past the original 10ms TTL
    queue.requeue(delivery);

    expect(queue.size).toBe(0);
  });

  it("simulating unbounded reconnect/retry churn on an EMERGENCY entry still lets it expire on schedule", async () => {
    const queue = new PendingDeliveryQueue({ ttlMs: 1_000_000, emergencyTtlMs: 40 });
    queue.enqueue(packetTo("C", Priority.EMERGENCY), "A");

    // A courier reconnecting repeatedly while the gate keeps denying the retry — drain+requeue many
    // times in quick succession, the way flushPendingDeliveries() would on every new peer connection.
    for (let i = 0; i < 20; i++) {
      const [delivery] = queue.drain();
      queue.requeue(delivery);
    }

    await new Promise((resolve) => setTimeout(resolve, 60)); // past the original 40ms emergencyTtlMs
    expect(queue.drain()).toEqual([]);
  });
});
