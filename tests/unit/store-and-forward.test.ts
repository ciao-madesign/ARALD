import { describe, expect, it } from "vitest";
import { createPacket, MessageType } from "../../node/src/packet.js";
import { PendingDeliveryQueue } from "../../node/src/store-and-forward.js";

function packetTo(destination: string): ReturnType<typeof createPacket> {
  return createPacket({ type: MessageType.DATA, source: "A", destination, payload: {} });
}

describe("PendingDeliveryQueue", () => {
  it("drains a queued packet back out, remembering who not to resend it to", () => {
    const queue = new PendingDeliveryQueue();
    const packet = packetTo("C");
    queue.enqueue(packet, "A");
    expect(queue.size).toBe(1);

    const drained = queue.drain();
    expect(drained).toEqual([{ packet, exceptPeerId: "A" }]);
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
});
