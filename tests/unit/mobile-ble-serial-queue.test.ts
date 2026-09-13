import { describe, expect, it } from "vitest";
import { SerialQueue } from "../../mobile/www/ble-serial-queue.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mobile/www/ble-serial-queue (SerialQueue)", () => {
  it("runs a single task and resolves with its result", async () => {
    const queue = new SerialQueue();
    const result = await queue.run(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("runs a synchronous (non-promise-returning) task correctly", async () => {
    const queue = new SerialQueue();
    const result = await queue.run(() => 7);
    expect(result).toBe(7);
  });

  it("never starts a second task before the first one has settled", async () => {
    const queue = new SerialQueue();
    const first = deferred<string>();
    const order: string[] = [];

    const p1 = queue.run(async () => {
      order.push("first-started");
      const value = await first.promise;
      order.push("first-finished");
      return value;
    });
    const p2 = queue.run(() => {
      order.push("second-started");
      return "second-result";
    });

    // The second task must not have started yet — the first is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first-started"]);

    first.resolve("first-result");
    await p1;
    await p2;

    expect(order).toEqual(["first-started", "first-finished", "second-started"]);
  });

  it("a rejecting task does not block tasks queued after it", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    const p1 = queue.run(() => {
      order.push("first");
      throw new Error("boom");
    });
    const p2 = queue.run(() => {
      order.push("second");
      return "ok";
    });

    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
    expect(order).toEqual(["first", "second"]);
  });

  it("preserves submission order across many tasks, even when earlier ones are slower", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];
    const delays = [30, 10, 0, 20, 5];

    const tasks = delays.map((delayMs, i) =>
      queue.run(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              order.push(i);
              resolve();
            }, delayMs);
          }),
      ),
    );

    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4]); // submission order, not completion-time order
  });

  it("each run() call gets its own promise, independent of others queued on the same queue", async () => {
    const queue = new SerialQueue();
    const p1 = queue.run(() => "a");
    const p2 = queue.run(() => "b");
    const p3 = queue.run(() => "c");

    expect(await Promise.all([p1, p2, p3])).toEqual(["a", "b", "c"]);
  });
});
