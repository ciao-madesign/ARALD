import { BoundedFifoMap } from "./bounded-map.js";
import { Priority, priorityRank, type Packet } from "./packet.js";

export interface PendingDeliveryQueueOptions {
  /** How long a queued packet is worth retrying before it's dropped (wall-clock, independent of the packet's own hop TTL) — every priority except EMERGENCY, which never expires by wall-clock at all (see the class doc comment, "No TTL for EMERGENCY"). */
  ttlMs?: number;
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
const DEFAULT_MAX_SIZE = 256;

/**
 * Store-and-forward queue (spec §30, §72): holds unicast packets a node
 * could not immediately relay — because it currently has no other peer to
 * flood them to, or because every send attempt failed — so they can be
 * retried once connectivity resumes, e.g. a courier device reconnecting to
 * a different segment of the mesh (spec §32).
 *
 * **Priority-weighted eviction** (`docs/beacon.md`, "NOMAD Mobile Relay"
 * §9-§10 — a Mobile/Fixed Relay courier has real, physical limits on how
 * much it can hold): under memory pressure, the lowest-priority queued
 * packet is evicted first — `Priority.EMERGENCY` (numerically 0, "most
 * urgent") outranks `Priority.BULK` (5, "least urgent"), so an emergency
 * message in this queue is never sacrificed to make room for routine
 * traffic, unlike the plain FIFO eviction this class used before this was
 * added. Unlike the trust-weighted eviction elsewhere in this codebase
 * (`RoutingTable`/`PeerDirectory`/`RemoteCatalog`, via an injected
 * `trustRank` callback), this doesn't need to be a constructor option:
 * `packet.priority` is already intrinsic to every queued entry, no external
 * state (a `TrustManager` lookup) is needed to rank it, so the queue can
 * just always do this.
 *
 * **No wall-clock TTL for `Priority.EMERGENCY`** (`docs/next-steps.md`,
 * proposed by the user 5 ottobre 2026): a Mobile/Fixed Relay courier that
 * picks up an SOS and then goes physically isolated for hours used to lose
 * it anyway once the old 30-minute `emergencyTtlMs` elapsed, even though the
 * message was still perfectly deliverable the moment the courier reached
 * connectivity again — dropping it on a clock was strictly worse than
 * holding it, since the priority-weighted eviction above already protects
 * it best under memory pressure (an EMERGENCY entry is the *last* thing
 * evicted, never a reason to also time it out). `enqueue()` now gives
 * `Priority.EMERGENCY` packets `expiresAt: Infinity` — the only way out of
 * this queue for one is a real delivery (`drain()` handing it to a caller
 * that successfully sends it) or eviction (only reachable if the queue is
 * genuinely full of same-or-higher-priority entries, an extreme case).
 *
 * **Why this can't cause a resolved SOS to look "freshly re-ignited" to an
 * operator, considered explicitly alongside this change**: every point that
 * could show a late, redundant re-delivery of the *same* SOS already
 * deduplicates by the beacon's own `contentId`, never by delivery time —
 * `EmergencyBeacons.record()` (`emergency-beacon.ts`) is a no-op for an
 * already-known `beaconContentId` (no second sighting, no new local event);
 * `arald-backend/postgres-sync.ts` upserts the mirror's `emergency_beacons`
 * row `ON CONFLICT (beacon_content_id)`, never inserting a duplicate; and
 * `mirror-portal/lib/db.ts`'s `rankByEventTimestamp()` orders by the
 * beacon's own signed `data.timestamp`, not by `synced_at` — a found-by-
 * review fix from an earlier voice specifically so a late re-sync can never
 * bump an old SOS back to the top of "most recent". A courier holding this
 * message for hours longer only means it keeps trying to reach a still-
 * isolated segment that genuinely never heard it yet — exactly the
 * delay-tolerant delivery this queue exists for — never a duplicate alert
 * anywhere that already has it.
 *
 * Scope and known limitations (tracked for milestone 12 in docs/roadmap.md):
 * - Only unicast packets are queued (a specific destination is known);
 *   broadcast discovery packets such as CONTENT_QUERY are not.
 * - This queue's wall-clock `ttlMs` (non-EMERGENCY only now) is independent
 *   of `SeenCache`'s size-bounded eviction (node/src/routing.ts): under
 *   sustained heavy traffic, a packet's id could in principle age out of
 *   another node's SeenCache before this queue's TTL expires, in which case
 *   a very late retry could be processed as if it were a new packet rather
 *   than being recognized as a duplicate. This is a latent edge case at the
 *   current default sizes (256 queued packets / 4096 seen ids / 5 minute
 *   TTL), not something this prototype resolves — a real fix needs the two
 *   caches' eviction policies to be coordinated, which is out of scope here.
 *   `Priority.EMERGENCY` packets are unaffected by this specific limitation
 *   (no TTL to race against), but still rely on the content-id-based dedup
 *   described above rather than this queue's own bookkeeping.
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
 *    `expiresAt`, a non-EMERGENCY entry with a TTL that keeps resetting
 *    would never actually leave the queue — no longer a wall-clock *bound*,
 *    contradicting spec §57 (an EMERGENCY entry has no TTL to reset any
 *    more, but the same `requeue()` path still applies to it uniformly).
 *    `requeue()` carries the *original* `expiresAt` through instead of
 *    computing a new one, so a non-EMERGENCY entry still expires on
 *    schedule regardless of how many times it's retried and denied in
 *    between.
 */
export class PendingDeliveryQueue {
  private readonly entries: BoundedFifoMap<string, Entry>;
  private readonly ttlMs: number;

  constructor(options: PendingDeliveryQueueOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
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
    // Infinity, never a long-but-finite window, for EMERGENCY — see the class doc comment, "No
    // wall-clock TTL for Priority.EMERGENCY". Date.now() + Infinity is still Infinity; both the
    // drain()/requeue() comparisons below work correctly against it unchanged.
    const expiresAt = priorityRank(packet.priority) === Priority.EMERGENCY ? Infinity : Date.now() + this.ttlMs;
    this.entries.set(packet.id, { packet, exceptPeerId, expiresAt });
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
