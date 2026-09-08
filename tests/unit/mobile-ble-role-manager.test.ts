import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BleRoleManager } from "../../mobile/www/ble-role-manager.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeManager(overrides: Record<string, unknown> = {}) {
  const enterCentralCalls: number[] = [];
  const enterPeripheralCalls: number[] = [];
  const giveUpCalls: number[] = [];
  const manager = new BleRoleManager({
    centralWindowMs: 9000,
    minBackoffMs: 30000,
    maxBackoffMs: 45000,
    maxAttempts: 3,
    maxCycleDurationMs: 3 * 60 * 1000,
    random: () => 0.5, // deterministic backoff: exact midpoint of [min, max]
    onEnterCentral: () => {
      enterCentralCalls.push(Date.now());
    },
    onEnterPeripheral: () => {
      enterPeripheralCalls.push(Date.now());
    },
    onGiveUp: () => {
      giveUpCalls.push(Date.now());
    },
    ...overrides,
  });
  return { manager, enterCentralCalls, enterPeripheralCalls, giveUpCalls };
}

describe("mobile/www/ble-role-manager (event-driven central/peripheral switch)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at rest: peripheral, onEnterPeripheral called once", async () => {
    const { manager, enterPeripheralCalls } = makeManager();
    await manager.start();
    expect(manager.role).toBe("peripheral");
    expect(enterPeripheralCalls).toHaveLength(1);
  });

  it("requestSend() from rest switches to central", async () => {
    const { manager, enterCentralCalls } = makeManager();
    await manager.start();
    manager.requestSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.role).toBe("central");
    expect(enterCentralCalls).toHaveLength(1);
  });

  it("notifyPeerConnected() ends the cycle immediately and returns to peripheral, no lingering window", async () => {
    const { manager, enterPeripheralCalls } = makeManager();
    await manager.start();
    manager.requestSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.role).toBe("central");

    manager.notifyPeerConnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.role).toBe("peripheral");
    expect(enterPeripheralCalls).toHaveLength(2); // start() + the return after success

    // The central window timer must have been cancelled — advancing well past it must not re-trigger anything.
    await vi.advanceTimersByTimeAsync(9000);
    expect(manager.role).toBe("peripheral");
  });

  it("notifyPeerConnected() while already at rest is a no-op", async () => {
    const { manager, enterPeripheralCalls } = makeManager();
    await manager.start();
    manager.notifyPeerConnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(enterPeripheralCalls).toHaveLength(1); // only the initial start(), no extra call
  });

  it("no peer found within the window: falls back to peripheral, waits a jittered backoff, retries central", async () => {
    const { manager, enterCentralCalls, enterPeripheralCalls } = makeManager();
    await manager.start();
    manager.requestSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(enterCentralCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(9000); // central window expires, no notifyPeerConnected()
    expect(manager.role).toBe("peripheral");
    expect(enterPeripheralCalls).toHaveLength(2);

    // Backoff is min(30s) + 0.5*(max-min)(15s) = 37.5s exactly, given the deterministic random above.
    await vi.advanceTimersByTimeAsync(37499);
    expect(manager.role).toBe("peripheral");
    expect(enterCentralCalls).toHaveLength(1); // not yet retried

    await vi.advanceTimersByTimeAsync(2);
    expect(manager.role).toBe("central");
    expect(enterCentralCalls).toHaveLength(2); // retried automatically
  });

  it("gives up after maxAttempts, calls onGiveUp, and does not auto-retry again", async () => {
    const { manager, enterCentralCalls, giveUpCalls } = makeManager({ maxAttempts: 2 });
    await manager.start();
    manager.requestSend();

    // Attempt 1: window expires, backoff, attempt 2 starts.
    await vi.advanceTimersByTimeAsync(9000); // window 1 expires
    await vi.advanceTimersByTimeAsync(37500); // backoff elapses, attempt 2 begins
    expect(enterCentralCalls).toHaveLength(2);

    // Attempt 2 (the last one allowed) also expires without success.
    await vi.advanceTimersByTimeAsync(9000);
    expect(manager.role).toBe("peripheral");
    expect(giveUpCalls).toHaveLength(1);

    // No further auto-retry, however long we wait.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(enterCentralCalls).toHaveLength(2);
    expect(giveUpCalls).toHaveLength(1);
  });

  it("gives up on maxCycleDurationMs even if maxAttempts has not been reached", async () => {
    const { manager, enterCentralCalls, giveUpCalls } = makeManager({
      maxAttempts: 100,
      maxCycleDurationMs: 10000,
      centralWindowMs: 9000,
    });
    await manager.start();
    manager.requestSend();

    await vi.advanceTimersByTimeAsync(9000); // attempt 1's window expires — elapsed (9000) < 10000, budget not yet exhausted, so a retry gets scheduled first
    expect(giveUpCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(37500); // backoff elapses, attempt 2 begins
    expect(enterCentralCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(9000); // attempt 2's window expires — now elapsed clears maxCycleDurationMs
    expect(giveUpCalls).toHaveLength(1);
  });

  it("a fresh requestSend() after giving up starts an entirely new cycle (attempt counter reset)", async () => {
    const { manager, enterCentralCalls, giveUpCalls } = makeManager({ maxAttempts: 1 });
    await manager.start();
    manager.requestSend();
    await vi.advanceTimersByTimeAsync(9000); // the only attempt allowed expires -> immediate give-up (maxAttempts: 1)
    expect(giveUpCalls).toHaveLength(1);
    expect(enterCentralCalls).toHaveLength(1);

    manager.requestSend(); // a new, independent send need
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.role).toBe("central");
    expect(enterCentralCalls).toHaveLength(2);
  });

  it("requestSend() while already central or waiting out a backoff is a no-op — does not restart the cycle", async () => {
    const { manager, enterCentralCalls } = makeManager();
    await manager.start();
    manager.requestSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(enterCentralCalls).toHaveLength(1);

    manager.requestSend(); // already central — must not re-enter central or reset the window
    await vi.advanceTimersByTimeAsync(0);
    expect(enterCentralCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(9000); // window expires, now waiting out the backoff
    manager.requestSend(); // must not short-circuit the backoff
    await vi.advanceTimersByTimeAsync(37499);
    expect(enterCentralCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(enterCentralCalls).toHaveLength(2);
  });

  it("stop() cancels the already-armed central-window timer, and a late-resolving onEnterCentral() has no further effect", async () => {
    const centralGate = deferred<void>();
    const { manager, enterCentralCalls } = makeManager({
      onEnterCentral: () => {
        enterCentralCalls.push(Date.now());
        return centralGate.promise; // never resolves before stop() below — onEnterCentral() is never awaited by the manager itself either way
      },
    });
    await manager.start();
    manager.requestSend(); // the central-window timer is armed synchronously here, independent of onEnterCentral()'s own promise

    manager.stop(); // torn down while onEnterCentral()'s promise is still pending — must cancel the already-armed timer
    centralGate.resolve(); // the stale call finally resolves, after stop() — must have no further effect, it is never chained to anything
    await vi.advanceTimersByTimeAsync(0);

    // The cancelled timer must never fire — advancing well past what its window would have been must
    // trigger nothing (no retry, no further callback of any kind).
    await vi.advanceTimersByTimeAsync(60000);
    expect(enterCentralCalls).toHaveLength(1); // only the original call, no retry ever scheduled
  });

  it("an onEnterCentral() that never resolves does not defeat the window timer — the bound is enforced independently of the plugin callback (regression test for a real bug caught by code review)", async () => {
    const { manager, enterCentralCalls, enterPeripheralCalls } = makeManager({
      onEnterCentral: () => {
        enterCentralCalls.push(Date.now());
        return new Promise(() => {}); // deliberately never settles — simulates a hung/stuck real plugin call
      },
    });
    await manager.start();
    manager.requestSend();
    expect(manager.role).toBe("central");

    // The window timer must fire on schedule regardless — this is the whole point of arming it
    // synchronously rather than behind onEnterCentral()'s own promise (see #tryCentral()'s doc comment).
    await vi.advanceTimersByTimeAsync(9000);
    expect(manager.role).toBe("peripheral");
    expect(enterPeripheralCalls.length).toBeGreaterThanOrEqual(2);

    // And the retry cycle keeps working normally afterwards, still never waiting on the stuck promise.
    await vi.advanceTimersByTimeAsync(37500);
    expect(manager.role).toBe("central");
    expect(enterCentralCalls).toHaveLength(2);
  });

  it("notifyPeerConnected() arriving after stop() is a no-op, even though #role is left stale by design", async () => {
    const { manager, enterPeripheralCalls } = makeManager();
    await manager.start();
    manager.requestSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.role).toBe("central");

    manager.stop();
    const callsBeforeLateNotify = enterPeripheralCalls.length;
    manager.notifyPeerConnected(); // e.g. a real BLE connect callback firing after teardown, which this class cannot itself cancel
    expect(enterPeripheralCalls).toHaveLength(callsBeforeLateNotify); // must not have fired onEnterPeripheral() again on an already-torn-down manager
  });

  it("stop() cancels a pending backoff timer — the phone never silently re-enters central after teardown", async () => {
    const { manager, enterCentralCalls } = makeManager();
    await manager.start();
    manager.requestSend();
    await vi.advanceTimersByTimeAsync(9000); // window expires, backoff scheduled
    expect(enterCentralCalls).toHaveLength(1);

    manager.stop();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(enterCentralCalls).toHaveLength(1); // the scheduled retry never fires
  });

  it("a failed onEnterCentral() is treated like 'no peer found', not left hanging forever", async () => {
    const { manager, enterPeripheralCalls } = makeManager({
      onEnterCentral: () => {
        throw new Error("plugin call failed");
      },
    });
    await manager.start();
    manager.requestSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.role).toBe("central"); // the state machine still enters the attempt...
    await vi.advanceTimersByTimeAsync(9000); // ...and the window still expires normally, driving the same fallback
    expect(manager.role).toBe("peripheral");
    expect(enterPeripheralCalls.length).toBeGreaterThanOrEqual(2);
  });
});
