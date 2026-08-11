/** Trust states for a node id (spec §54) — particularly useful for controlled networks (e.g. RIFUGIO-NET, SOCCORSO-NET). */
export enum TrustLevel {
  UNKNOWN = "UNKNOWN",
  SEEN = "SEEN",
  VERIFIED = "VERIFIED",
  TRUSTED = "TRUSTED",
  ADMIN = "ADMIN",
}

const RANK: Record<TrustLevel, number> = {
  [TrustLevel.UNKNOWN]: 0,
  [TrustLevel.SEEN]: 1,
  [TrustLevel.VERIFIED]: 2,
  [TrustLevel.TRUSTED]: 3,
  [TrustLevel.ADMIN]: 4,
};

/** True if `level` meets or exceeds `threshold` — the ordering `UNKNOWN < SEEN < VERIFIED < TRUSTED < ADMIN` (spec §54). */
export function meetsTrustLevel(level: TrustLevel, threshold: TrustLevel): boolean {
  return RANK[level] >= RANK[threshold];
}

export interface TrustManagerOptions {
  /** Bounds memory (spec §57): once full, the oldest entry from the lowest trust tier present is evicted first. */
  maxSize?: number;
}

const DEFAULT_MAX_SIZE = 4096;

/**
 * Per-node-id trust tracking (spec §54). Two levels are earned
 * automatically as a byproduct of normal protocol activity:
 *
 * - `SEEN`: this node id has connected to us directly (spec §7 "Peer
 *   Discovery") — we've observed it, nothing more. A `source` field is
 *   self-declared, not proven, so `SEEN` alone is not a security claim.
 * - `VERIFIED`: this node id has produced at least one cryptographically
 *   valid signature we could check (spec §55) — over published content,
 *   or a catalog entry. That's real evidence it controls the private key
 *   for the identity it claims — **not** evidence that the content behind
 *   that signature is legitimate, only that the claimed key produced it.
 *   A self-signed, fabricated catalog entry still earns VERIFIED for its
 *   (freshly generated, throwaway) publisher key; this level answers "is
 *   this the same identity we saw sign before", not "is this trustworthy".
 *
 * `TRUSTED`/`ADMIN` are never assigned automatically — they're for an
 * operator to configure explicitly via `set()`, e.g. for a controlled
 * deployment (spec §54's RIFUGIO-NET/SOCCORSO-NET examples). Levels only
 * ever advance automatically, never regress on their own; `set()` can
 * move a node id to any level, including downward, as an explicit
 * operator action.
 *
 * Bounded like every other cache fed by network input in this codebase
 * (spec §57): because `markVerified()` only proves "this key signed this
 * claim", not "this claim is worth anything", a single peer can cheaply
 * mint many throwaway keypairs and self-sign fabricated catalog entries
 * (spec §33 `SYNC_RESPONSE`) purely to grow this map — eviction prefers
 * removing the oldest entry from the *lowest* trust tier present, so an
 * attacker flooding low-trust entries can't push out operator-assigned
 * `TRUSTED`/`ADMIN` ones.
 */
export class TrustManager {
  private readonly levels = new Map<string, TrustLevel>();
  private readonly maxSize: number;

  constructor(options: TrustManagerOptions = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  }

  get(nodeId: string): TrustLevel {
    return this.levels.get(nodeId) ?? TrustLevel.UNKNOWN;
  }

  /** Whether this node id has any recorded trust state at all (as opposed to defaulting to UNKNOWN). */
  has(nodeId: string): boolean {
    return this.levels.has(nodeId);
  }

  markSeen(nodeId: string): void {
    this.ensureCapacityFor(nodeId);
    this.raiseTo(nodeId, TrustLevel.SEEN);
  }

  markVerified(nodeId: string): void {
    this.ensureCapacityFor(nodeId);
    this.raiseTo(nodeId, TrustLevel.VERIFIED);
  }

  /** Explicit operator action — can set any level, including downgrading (e.g. revoking trust). */
  set(nodeId: string, level: TrustLevel): void {
    this.ensureCapacityFor(nodeId);
    this.levels.set(nodeId, level);
  }

  list(): Array<{ nodeId: string; level: TrustLevel }> {
    return Array.from(this.levels, ([nodeId, level]) => ({ nodeId, level }));
  }

  get size(): number {
    return this.levels.size;
  }

  private raiseTo(nodeId: string, level: TrustLevel): void {
    if (RANK[level] > RANK[this.get(nodeId)]) {
      this.levels.set(nodeId, level);
    }
  }

  private ensureCapacityFor(nodeId: string): void {
    if (this.levels.has(nodeId) || this.levels.size < this.maxSize) return;
    let evictKey: string | undefined;
    let evictRank = Infinity;
    for (const [id, level] of this.levels) {
      const rank = RANK[level];
      if (rank < evictRank) {
        evictRank = rank;
        evictKey = id;
        if (rank === RANK[TrustLevel.UNKNOWN]) break; // nothing evicts more cheaply than this
      }
    }
    if (evictKey !== undefined) this.levels.delete(evictKey);
  }
}
