import { BoundedFifoMap } from "./bounded-map.js";

export interface RateLimiterOptions {
  /** Max packets a single peer may send within one window before further packets are dropped (spec §57). */
  maxPacketsPerWindow?: number;
  /** Window length in milliseconds. */
  windowMs?: number;
  /** Max distinct peer ids tracked at once (spec §57 resource limits) — see the class doc comment's second paragraph for why this stopped being optional. */
  maxTrackedPeers?: number;
}

interface PeerWindow {
  count: number;
  windowStart: number;
}

const DEFAULT_MAX_PACKETS_PER_WINDOW = 200;
const DEFAULT_WINDOW_MS = 1000;
/** Same bound `web-ui.ts` uses for its own per-source-IP rate-limit state (`MAX_TRACKED_MAP_TILE_RATE_LIMIT_IPS`) — same shape of problem, same order of magnitude. */
const DEFAULT_MAX_TRACKED_PEERS = 4096;

/**
 * Per-peer packet rate limiting (spec §57 "abusi" — flooding, resource
 * exhaustion). Deliberately simple (fixed windows, not a token bucket):
 * each connected peer gets its own independent budget, so one
 * misbehaving or compromised peer can't starve traffic from the others,
 * and can't be used to indirectly exhaust this node's own CPU/memory by
 * generating packets faster than they can be processed.
 *
 * **`windows` is bounded** (found necessary by review, `docs/security.md`
 * — added alongside the broadcast-reception path, `transports/simulated-link.ts`'s
 * `receiveBroadcast()`): every `fromPeerId` that ever reaches `allow()`
 * used to arrive only via a real transport `connect()`, which always
 * eventually disconnects and calls `reset()` below — so this map was
 * naturally bounded by "currently or recently connected peer count" even
 * without an explicit size limit. A connectionless broadcast reception has
 * no disconnect event to ever call `reset()` for, and `packet.source` (used
 * as `fromPeerId` for a broadcast-received packet) is not cryptographically
 * authenticated — a sender minting a fresh throwaway identity per packet
 * (the realistic "Card usa-e-getta" case this feature exists to support)
 * would otherwise grow `windows` by one permanent entry per packet,
 * forever. `receiveBroadcast()`'s own *global* per-window cap slows this
 * down but does not stop it — packets within that global budget still each
 * reach `allow()` with their own distinct `fromPeerId`. `BoundedFifoMap`
 * with plain FIFO eviction (no trust ranking: there is no meaningful trust
 * signal for an unauthenticated claimed source id) closes the gap the same
 * way `spec §57` bounds every other network-fed structure in this codebase.
 */
export class RateLimiter {
  private readonly windows: BoundedFifoMap<string, PeerWindow>;
  private readonly maxPacketsPerWindow: number;
  private readonly windowMs: number;

  constructor(options: RateLimiterOptions = {}) {
    this.maxPacketsPerWindow = options.maxPacketsPerWindow ?? DEFAULT_MAX_PACKETS_PER_WINDOW;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.windows = new BoundedFifoMap({ maxSize: options.maxTrackedPeers ?? DEFAULT_MAX_TRACKED_PEERS });
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
