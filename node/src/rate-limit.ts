export interface RateLimiterOptions {
  /** Max packets a single peer may send within one window before further packets are dropped (spec §57). */
  maxPacketsPerWindow?: number;
  /** Window length in milliseconds. */
  windowMs?: number;
}

interface PeerWindow {
  count: number;
  windowStart: number;
}

const DEFAULT_MAX_PACKETS_PER_WINDOW = 200;
const DEFAULT_WINDOW_MS = 1000;

/**
 * Per-peer packet rate limiting (spec §57 "abusi" — flooding, resource
 * exhaustion). Deliberately simple (fixed windows, not a token bucket):
 * each connected peer gets its own independent budget, so one
 * misbehaving or compromised peer can't starve traffic from the others,
 * and can't be used to indirectly exhaust this node's own CPU/memory by
 * generating packets faster than they can be processed.
 */
export class RateLimiter {
  private readonly windows = new Map<string, PeerWindow>();
  private readonly maxPacketsPerWindow: number;
  private readonly windowMs: number;

  constructor(options: RateLimiterOptions = {}) {
    this.maxPacketsPerWindow = options.maxPacketsPerWindow ?? DEFAULT_MAX_PACKETS_PER_WINDOW;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /** Returns true if a packet from `peerId` should be processed, false if this peer is currently over budget. */
  allow(peerId: string): boolean {
    const now = Date.now();
    let window = this.windows.get(peerId);
    if (!window || now - window.windowStart >= this.windowMs) {
      window = { count: 0, windowStart: now };
      this.windows.set(peerId, window);
    }
    window.count += 1;
    return window.count <= this.maxPacketsPerWindow;
  }

  /** Forgets a peer's budget entirely, e.g. once it disconnects — avoids unbounded growth as peers churn. */
  reset(peerId: string): void {
    this.windows.delete(peerId);
  }
}
