import { BoundedFifoMap } from "./bounded-map.js";

export interface RouteEntry {
  nextHop: string;
  cost: number;
}

export interface RoutingTableOptions {
  maxSize?: number;
  maxCost?: number;
  /**
   * Ranks eviction candidates by the trust level of the peer that sourced a route's `nextHop` —
   * the same defense `PeerDirectory`/`RemoteCatalog` already apply to themselves (spec §57,
   * catalog.ts/peer-directory.ts, docs/security.md bug #13): without it, plain FIFO eviction lets
   * any connected peer — even one that just connected, `TrustLevel.SEEN` — evict long-standing
   * routes to genuinely reachable destinations simply by announcing enough fabricated ones in a
   * single ROUTE_ANNOUNCE (node.ts caps how many entries one packet may carry, but not how much of
   * the table an untrusted announcer's entries can occupy once accepted). Pass
   * `(nextHop) => trustRank(trustManager.get(nextHop))`. Omit for plain FIFO (the default before
   * this option existed).
   */
  trustRank?: (nextHop: string) => number;
}

const DEFAULT_MAX_SIZE = 4096;
const DEFAULT_MAX_COST = 64;

/**
 * Distance-vector routing table (spec §22 "routing evoluto"): destination
 * node id -> best known {nextHop, cost}, maintained via Bellman-Ford-style
 * updates exchanged directly between neighbors (see ROUTE_ANNOUNCE in
 * node.ts). Cost is hop count (α·hops in the spec's
 * `Cost = α·hops + β·latency + γ·loss + δ·energy + ε·congestion`) — the
 * other terms need real link measurements this prototype has no hardware to
 * take yet; hop count is the one term that's honestly derivable purely from
 * connection topology, so it's what's implemented here.
 */
export class RoutingTable {
  private readonly routes: BoundedFifoMap<string, RouteEntry>;
  private readonly maxCost: number;

  constructor(options: RoutingTableOptions = {}) {
    const trustRank = options.trustRank;
    this.routes = new BoundedFifoMap({
      maxSize: options.maxSize ?? DEFAULT_MAX_SIZE,
      evictionScore: trustRank ? (_destination, entry) => trustRank(entry.nextHop) : undefined,
    });
    this.maxCost = options.maxCost ?? DEFAULT_MAX_COST;
  }

  /**
   * Offers a candidate route learned from `nextHop` at `cost`. Adopted when
   * it's a new destination, a strictly cheaper path than the one currently
   * held, or a fresh update from the same next hop already in use (so that
   * next hop's path getting worse — or better — is still reflected, not
   * just strictly-better paths discovered from other neighbors). Returns
   * whether the table actually changed.
   */
  offer(destination: string, nextHop: string, cost: number): boolean {
    if (destination === nextHop && cost !== 1) return false; // a direct link is always exactly cost 1
    if (!Number.isFinite(cost) || cost <= 0 || cost > this.maxCost) return false;

    const existing = this.routes.get(destination);
    if (existing) {
      if (existing.nextHop === nextHop) {
        if (existing.cost === cost) return false; // no change
      } else if (existing.cost <= cost) {
        return false; // a different next hop only takes over with a strictly better cost
      }
    }

    this.routes.set(destination, { nextHop, cost }); // evicts the oldest route only when `destination` is genuinely new
    return true;
  }

  /**
   * Removes `destination`'s route, but only if it currently goes via
   * `viaNextHop` — a withdrawal for a route this node has since replaced
   * with a better one from elsewhere is a stale no-op, not a regression.
   */
  withdraw(destination: string, viaNextHop: string): boolean {
    const existing = this.routes.get(destination);
    if (!existing || existing.nextHop !== viaNextHop) return false;
    this.routes.delete(destination);
    return true;
  }

  /** Removes every route currently routed via `peerId` (e.g. on disconnect). Returns the removed destinations. */
  removeRoutesVia(peerId: string): string[] {
    const removed: string[] = [];
    for (const [destination, entry] of this.routes) {
      if (entry.nextHop === peerId) {
        this.routes.delete(destination);
        removed.push(destination);
      }
    }
    return removed;
  }

  bestRoute(destination: string): RouteEntry | undefined {
    return this.routes.get(destination);
  }

  has(destination: string): boolean {
    return this.routes.has(destination);
  }

  list(): Array<{ destination: string; nextHop: string; cost: number }> {
    return Array.from(this.routes.entries()).map(([destination, entry]) => ({ destination, ...entry }));
  }

  get size(): number {
    return this.routes.size;
  }
}
