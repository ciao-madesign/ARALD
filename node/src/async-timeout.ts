/**
 * Races `promise` against a `timeoutMs` timer, rejecting with `new
 * Error(message)` if the timer fires first. Never cancels the underlying
 * `promise` — it keeps running in the background, and any eventual
 * settlement is simply ignored once this has already settled the race (no
 * `AbortController` plumbed through its caller today: `WebUiServer`'s
 * `POST /api/call`, web-ui.ts). Extracted here because both `web-ui.ts` and
 * (originally) `NomadNode.callService()`'s local-provider path (node.ts) had
 * grown the exact same "setTimeout + reject, clear on settle" boilerplate
 * independently — same reasoning as `bounded-map.ts`/`loopback-http-server.ts`.
 * `node.ts` moved off this: `stop()` needs to `clearTimeout()` an in-flight
 * local call's timer *early*, which this function's internal timer can't
 * expose to a caller — see `withServiceTimeout()` in node.ts for the inlined
 * replacement. Still the right choice for `web-ui.ts`, which never needs to
 * cancel early.
 */
export function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
