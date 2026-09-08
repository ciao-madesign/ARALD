/**
 * Generic "run this on a timer, forever, until told to stop" loop —
 * extracted out of `sync.ts` because the two concerns are independent:
 * this file knows nothing about nodes, Postgres, or ARALD at all, only
 * "call `runOnce()` repeatedly, `intervalMs` apart, and stop cleanly on
 * `signal`". Kept as its own module so the scheduling behavior (in
 * particular: a single failing tick must never kill the loop) can be unit
 * tested without a real HTTP server or a real database on the other end.
 */

export interface PeriodicSyncOptions {
  /** How long to wait after one tick finishes before starting the next — not a fixed-rate timer, so a slow tick never causes two overlapping runs. */
  intervalMs: number;
  /** Aborting this stops the loop — either between ticks (cancels the wait immediately) or, if already sleeping, right away; a tick already in flight always finishes rather than being cut off mid-write. */
  signal: AbortSignal;
  /** One sync attempt. A thrown error is caught and logged by `runPeriodicSync()` itself, never left to propagate and kill the loop — the whole reason this exists is that a Box's connectivity is expected to come and go, so one bad tick (node briefly unreachable, mirror briefly unreachable) must not need a human to restart the process. */
  runOnce: () => Promise<void>;
  /** Injectable for tests — real callers never need to pass this. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable for tests — real callers never need to pass this. */
  onTickError?: (err: unknown) => void;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    // `{ once: true }` only detaches the listener when the "abort" event actually fires — a sleep
    // that completes normally (the far more common case, once per tick for the entire lifetime of a
    // long-running Box) would otherwise leave its listener attached to `signal` forever, a real
    // unbounded leak found by review (confirmed empirically: N completed ticks left N listeners on
    // the same never-fired signal). Both paths below explicitly remove the same listener reference.
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultOnTickError(err: unknown): void {
  console.error("sync tick failed, will retry next interval:", err instanceof Error ? err.message : err);
}

export async function runPeriodicSync(options: PeriodicSyncOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const onTickError = options.onTickError ?? defaultOnTickError;

  while (!options.signal.aborted) {
    try {
      await options.runOnce();
    } catch (err) {
      onTickError(err);
    }
    if (options.signal.aborted) break;
    await sleep(options.intervalMs, options.signal);
  }
}
