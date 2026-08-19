import { describe, expect, it } from "vitest";
import { PriorityQueue } from "../../node/src/priority-queue.js";

describe("PriorityQueue", () => {
  it("dequeues items in priority order, not enqueue order", () => {
    const queue = new PriorityQueue<string>(6);
    queue.enqueue(4, "content"); // enqueued first, but lower priority (higher number)
    queue.enqueue(0, "emergency"); // enqueued later, but highest priority

    expect(queue.dequeue()).toBe("emergency");
    expect(queue.dequeue()).toBe("content");
  });

  it("preserves arrival order within the same priority level", () => {
    const queue = new PriorityQueue<string>(6);
    queue.enqueue(2, "first");
    queue.enqueue(2, "second");
    queue.enqueue(2, "third");

    expect(queue.dequeue()).toBe("first");
    expect(queue.dequeue()).toBe("second");
    expect(queue.dequeue()).toBe("third");
  });

  it("a higher-priority item queued after several lower-priority ones still jumps the whole line", () => {
    const queue = new PriorityQueue<string>(6);
    queue.enqueue(5, "bulk-1");
    queue.enqueue(5, "bulk-2");
    queue.enqueue(4, "content");
    queue.enqueue(0, "emergency");

    expect(queue.dequeue()).toBe("emergency");
    expect(queue.dequeue()).toBe("content");
    expect(queue.dequeue()).toBe("bulk-1");
    expect(queue.dequeue()).toBe("bulk-2");
  });

  it("returns undefined once empty, and size reflects the true remaining count", () => {
    const queue = new PriorityQueue<string>(6);
    expect(queue.size).toBe(0);
    expect(queue.dequeue()).toBeUndefined();

    queue.enqueue(1, "a");
    queue.enqueue(3, "b");
    expect(queue.size).toBe(2);
    queue.dequeue();
    expect(queue.size).toBe(1);
    queue.dequeue();
    expect(queue.size).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("clamps an out-of-range priority to the lowest-priority bucket instead of throwing", () => {
    const queue = new PriorityQueue<string>(6);
    queue.enqueue(999, "malformed-priority");
    queue.enqueue(-1, "also-malformed");
    queue.enqueue(0, "emergency");

    expect(queue.dequeue()).toBe("emergency"); // still jumps ahead of both malformed entries
    expect(queue.size).toBe(2);
  });
});
