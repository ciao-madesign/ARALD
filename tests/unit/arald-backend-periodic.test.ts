import { describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { runPeriodicSync } from "../../arald-backend/periodic.js";

describe("runPeriodicSync", () => {
  it("runs runOnce repeatedly, intervalMs apart, until aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const runOnce = vi.fn(async () => {
      calls++;
      if (calls >= 3) controller.abort();
    });

    await runPeriodicSync({ intervalMs: 1, signal: controller.signal, runOnce });

    expect(calls).toBe(3);
  });

  it("keeps going after a tick throws — a single failure never kills the loop", async () => {
    const controller = new AbortController();
    let calls = 0;
    const errors: unknown[] = [];
    const runOnce = vi.fn(async () => {
      calls++;
      if (calls === 2) throw new Error("boom");
      if (calls >= 3) controller.abort();
    });

    await runPeriodicSync({ intervalMs: 1, signal: controller.signal, runOnce, onTickError: (err) => errors.push(err) });

    expect(calls).toBe(3);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });

  it("never calls runOnce when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runOnce = vi.fn(async () => {});

    await runPeriodicSync({ intervalMs: 1000, signal: controller.signal, runOnce });

    expect(runOnce).not.toHaveBeenCalled();
  });

  it("stops waiting immediately when aborted mid-sleep, instead of waiting out the full interval", async () => {
    const controller = new AbortController();
    let calls = 0;
    const runOnce = vi.fn(async () => {
      calls++;
      if (calls === 1) setTimeout(() => controller.abort(), 5);
    });

    const start = Date.now();
    await runPeriodicSync({ intervalMs: 10_000, signal: controller.signal, runOnce });
    const elapsed = Date.now() - start;

    expect(calls).toBe(1);
    expect(elapsed).toBeLessThan(1000);
  });

  it("regression: a completed (non-aborted) sleep doesn't leave its abort listener attached forever", async () => {
    // Real bug found by review: the default sleep's `{ once: true }` only detaches its listener when
    // "abort" actually fires — a sleep that times out normally (the common case for every tick of a
    // long-running Box that's never told to stop) left the listener attached to `signal` forever, an
    // unbounded leak over the process's real lifetime. Runs several ticks that all complete without
    // aborting, and captures the listener count *before* ever calling abort() — checking only after
    // abort() would be misleading: firing "abort" for real invokes (and thus auto-removes, since every
    // listener here is `{ once: true }`) even a leaked one, which would make this assertion pass
    // against the buggy code too, just via a different mechanism than the fix actually provides.
    const controller = new AbortController();
    let calls = 0;
    let listenerCountBeforeAbort = -1;
    const runOnce = vi.fn(async () => {
      calls++;
      if (calls >= 5) {
        listenerCountBeforeAbort = getEventListeners(controller.signal, "abort").length;
        controller.abort();
      }
    });

    await runPeriodicSync({ intervalMs: 1, signal: controller.signal, runOnce });

    expect(calls).toBe(5);
    expect(listenerCountBeforeAbort).toBe(0);
  });

  it("uses the default onTickError (console.error) when none is injected — never throws out of the loop either way", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    let calls = 0;
    const runOnce = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("no injected handler");
      controller.abort();
    });

    await runPeriodicSync({ intervalMs: 1, signal: controller.signal, runOnce });

    expect(calls).toBe(2);
    expect(consoleSpy).toHaveBeenCalledWith("sync tick failed, will retry next interval:", "no injected handler");
    consoleSpy.mockRestore();
  });
});
