import { BoundedFifoMap } from "./bounded-map.js";
import { Priority, PRIORITY_LEVEL_COUNT, type Packet } from "./packet.js";

export interface PendingDeliveryQueueOptions {
  /** How long a queued packet is worth retrying before it's dropped (wall-clock, independent of the packet's own hop TTL) — every priority except EMERGENCY, see `emergencyTtlMs`. */
  ttlMs?: number;
  /**
   * Wall-clock TTL reserved for `Priority.EMERGENCY` packets specifically
   * (`docs/beacon.md`, "NOMAD Mobile Relay" §9 — a Fixed/Mobile Relay
   * courier should hold an emergency message *longer* than routine traffic
   * while waiting to physically reach connectivity again, not the same
   * `ttlMs` as everything else). Defaults to a longer window than `ttlMs`
   * for exactly that reason — see `DEFAULT_EMERGENCY_TTL_MS`.
   */
  emergencyTtlMs?: number;
  /** Bounds memory: once full, the lowest-priority entry is evicted to make room — see the class doc comment for why this queue picks by priority instead of plain FIFO (spec §57 resource limits). */
  maxSize?: number;
}

export interface QueuedDelivery {
  packet: Packet;
  /** The peer this packet must not be re-sent to on retry (typically whoever it was received from), if any. */
  exceptPeerId?: string;
  /**
   * When this entry originally stops being worth retrying (ms epoch) —
   * populated on `drain()`, consumed by `requeue()`. Carrying the
   * *original* deadline through a requeue (instead of letting a caller
   * compute a fresh one) is what stops a repeatedly-retried-and-denied
   * packet from having its wall-clock TTL reset on every single retry —
   * see `requeue()`'s own doc comment.
   */
  expiresAt: number;
}

type Entry = QueuedDelivery;

const DEFAULT_TTL_MS = 5 * 60 * 1000;
// 6x the default ordinary TTL: an emergency message is exactly the traffic store-and-forward's
// "wait for a courier to physically arrive" model needs to survive the longest — dropping it after
// 5 minutes because no relay happened by in time is a far worse outcome than dropping a routine
// content-sync retry (docs/beacon.md, "NOMAD Mobile Relay" §9).
const DEFAULT_EMERGENCY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SIZE = 256;

/**
 * Store-and-forward queue (spec §30, §72): holds unicast packets a node
 * could not immediately relay — because it currently has no other peer to
 * flood them to, or because every send attempt failed — so they can be
 * retried once connectivity resumes, e.g. a courier device reconnecting to
 * a different segment of the mesh (spec §32).
 *
 * **Priority-weighted eviction and TTL** (`docs/beacon.md`, "NOMAD Mobile
 * Relay" §9-§10 — a Mobile/Fixed Relay courier has real, physical limits on
 * how much it can hold and for how long): under memory pressure, the
 * lowest-priority queued packet is evicted first — `Priority.EMERGENCY`
 * (numerically 0, "most urgent") outranks `Priority.BULK` (5, "least
 * urgent"), so an emergency message in this queue is never sacrificed to
 * make room for routine traffic, unlike the plain FIFO eviction this class
 * used before this was added. Unlike the trust-weighted eviction elsewhere
 * in this codebase (`RoutingTable`/`PeerDirectory`/`RemoteCatalog`, via an
 * injected `trustRank` callback), this doesn't need to be a constructor
 * option: `packet.priority` is already intrinsic to every queued entry, no
 * external state (a `TrustManager` lookup) is needed to rank it, so the
 * queue can just always do this. Separately, `emergencyTtlMs` gives
 * `Priority.EMERGENCY` packets a longer wall-clock TTL than everything else
 * — see its own doc comment above.
 *
 * Scope and known limitations (tracked for milestone 12 in docs/roadmap.md):
 * - Only unicast packets are queued (a specific destination is known);
 *   broadcast discovery packets such as CONTENT_QUERY are not.
 * - This queue's wall-clock `ttlMs`/`emergencyTtlMs` are independent of
 *   `SeenCache`'s size-bounded eviction (node/src/routing.ts): under
 *   sustained heavy traffic, a packet's id could in principle age out of
 *   another node's SeenCache before this queue's TTL expires, in which case
 *   a very late retry could be processed as if it were a new packet rather
 *   than being recognized as a duplicate. This is a latent edge case at the
 *   current default sizes (256 queued packets / 4096 seen ids / 5-30 minute
 *   TTL), not something this prototype resolves — a real fix needs the two
 *   caches' eviction policies to be coordinated, which is out of scope here.
 * - No "inventory negotiation" (announce what's queued, transfer only what
 *   the other side is missing) for these generic queued packets — unlike
 *   `RemoteCatalog`'s sync, which already does this for published content.
 *   `docs/beacon.md` marks this explicitly as optional ("eventuale") and
 *   only worthwhile over a narrow-band radio link, never over the TCP
 *   transport this prototype actually runs on — deliberately not built
 *   here, not an oversight.
 *
 * **Two defensive fixes found by code review, both worth calling out
 * explicitly** (the kind of gap that's easy to reintroduce if this file is
 * touched again without rereading this comment):
 * 1. `packet.priority` is untrusted network input — `decodePacket()`
 *    (packet.ts) never validates it, so a forged/out-of-range/missing value
 *    could otherwise turn `-entry.packet.priority` into a score that always
 *    "wins" eviction, letting garbage displace a legitimate
 *    `Priority.EMERGENCY` entry — the exact inversion of what this class is
 *    for. `priorityRank()` below applies the same defensive clamp
 *    `priority-queue.ts` already uses for the identical reason (untrusted
 *    `priority` field): anything not a valid in-range integer is treated as
 *    the *lowest* priority, never the highest.
 * 2. `flushPendingDeliveries()` (node.ts) re-queues a drained entry when a
 *    retry is denied by a relay-policy/trust gate — worth retrying again
 *    later, not a permanent drop. That happens on every new peer
 *    connection, which for an actual courier device is the normal, frequent
 *    case (arriving at a new mesh segment) — so a persistently-denied entry
 *    could be re-queued many times. If each re-queue computed a fresh
 *    `expiresAt`, an `EMERGENCY` entry (already immune to eviction, see
 *    above) combined with a TTL that keeps resetting would never actually
 *    leave the queue — no longer a wall-clock *bound*, contradicting spec
 *    §57. `requeue()` carries the *original* `expiresAt` through instead of
 *    computing a new one, so the entry still expires on schedule regardless
 *    of how many times it's retried and denied in between.
 */
export class PendingDeliveryQueue {
  private readonly entries: BoundedFifoMap<string, Entry>;
  private readonly ttlMs: number;
  private readonly emergencyTtlMs: number;

  constructor(options: PendingDeliveryQueueOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.emergencyTtlMs = options.emergencyTtlMs ?? DEFAULT_EMERGENCY_TTL_MS;
    this.entries = new BoundedFifoMap({
      maxSize: options.maxSize ?? DEFAULT_MAX_SIZE,
      // Lower score = evicted first (bounded-map.ts) — negating priority means EMERGENCY (0) scores
      // highest (survives) and BULK (5) scores lowest (evicted first), with ties (same priority)
      // still broken in favor of the oldest entry, exactly like the plain-FIFO default this replaces.
      // priorityRank() (not the raw, untrusted packet.priority) is what's negated — see the class
      // doc comment's point 1.
      evictionScore: (_id, entry) => -priorityRank(entry.packet.priority),
    });
  }

  has(packetId: string): boolean {
    return this.entries.has(packetId);
  }

  enqueue(packet: Packet, exceptPeerId?: string): void {
    if (this.entries.has(packet.id)) return;
    const ttlMs = priorityRank(packet.priority) === Priority.EMERGENCY ? this.emergencyTtlMs : this.ttlMs;
    this.entries.set(packet.id, { packet, exceptPeerId, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Re-inserts a delivery previously returned by `drain()`, keeping its
   * original `expiresAt` rather than starting a fresh TTL window — see the
   * class doc comment's point 2 for why a plain `enqueue()` here would be
   * wrong. A no-op if the delivery already expired (no point re-inserting
   * it just to have it silently dropped by the next `drain()` anyway) or if
   * another entry with the same packet id has since been queued.
   */
  requeue(delivery: QueuedDelivery): void {
    if (this.entries.has(delivery.packet.id)) return;
    if (delivery.expiresAt <= Date.now()) return;
    this.entries.set(delivery.packet.id, delivery);
  }

  /** Removes every entry and returns the deliveries still worth retrying, silently dropping anything expired. */
  drain(): QueuedDelivery[] {
    const now = Date.now();
    const ready: QueuedDelivery[] = [];
    for (const [id, entry] of this.entries) {
      this.entries.delete(id);
      if (entry.expiresAt > now) ready.push(entry);
    }
    return ready;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Clamps an untrusted `packet.priority` to a valid `Priority` level,
 * defaulting to the *lowest*-urgency one (`Priority.BULK`) for anything
 * malformed — same defensive posture, and the exact same reasoning, as
 * `PriorityQueue.enqueue()`'s clamp in `priority-queue.ts`: a relayed
 * packet's `priority` field was never validated by its original sender
 * (`decodePacket()` only validates the envelope, not the payload/other
 * fields — see `CLAUDE.md`'s "convenzioni consolidate"), so treating an
 * out-of-range value as automatically *most* urgent (which is what
 * `-entry.packet.priority` would do for a large negative or `NaN` input if
 * left unclamped) would be exactly backwards.
 */
function priorityRank(priority: unknown): Priority {
  return Number.isInteger(priority) && (priority as number) >= 0 && (priority as number) < PRIORITY_LEVEL_COUNT
    ? (priority as Priority)
    : Priority.BULK;
}
