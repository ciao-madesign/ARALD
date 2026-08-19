/**
 * A bucketed priority queue: `levels` FIFO buckets, bucket 0 highest
 * priority — matching the small, fixed set of priority classes in
 * `Priority` (packet.ts, spec §50: `EMERGENCY(0) > CONTROL(1) >
 * MESSAGING(2) > SERVICE(3) > CONTENT(4) > BULK(5)`). Dequeuing always
 * drains the lowest-numbered non-empty bucket first, so a higher-priority
 * item queued *later* still jumps ahead of a lower-priority one already
 * waiting — while within a single bucket, arrival order is preserved
 * (fairness among same-priority items, no starvation among peers of equal
 * priority).
 *
 * An out-of-range priority (untrusted network input can carry anything —
 * a relayed packet's `priority` field was never validated by its original
 * sender) is clamped to the lowest-priority bucket rather than indexing
 * out of bounds or throwing.
 */
export class PriorityQueue<T> {
  private readonly buckets: T[][];
  private count = 0;

  constructor(private readonly levels: number) {
    this.buckets = Array.from({ length: levels }, () => []);
  }

  enqueue(priority: number, item: T): void {
    const index = Number.isInteger(priority) && priority >= 0 && priority < this.levels ? priority : this.levels - 1;
    this.buckets[index].push(item);
    this.count++;
  }

  dequeue(): T | undefined {
    for (const bucket of this.buckets) {
      if (bucket.length > 0) {
        this.count--;
        return bucket.shift();
      }
    }
    return undefined;
  }

  get size(): number {
    return this.count;
  }
}
