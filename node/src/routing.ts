import { BoundedFifoMap } from "./bounded-map.js";
import type { Packet } from "./packet.js";

/** Bounded "seen packet id" cache used for deduplication (spec §20-21). */
export class SeenCache {
  private readonly seen: BoundedFifoMap<string, number>;

  constructor(maxSize = 4096) {
    this.seen = new BoundedFifoMap({ maxSize });
  }

  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  markSeen(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.set(id, Date.now());
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface ForwardDecision {
  duplicate: boolean;
  /** Whether the local node should hand this packet to its own application logic. */
  deliverLocally: boolean;
  /** Present when the packet should be relayed onward, already TTL-decremented (spec §19). */
  forwardPacket?: Packet;
}

/**
 * Controlled flooding routing decision (spec §21-22 — the "evolved",
 * cost-based routing in §22 is future work; this is deliberately the
 * simplest mechanism that gets multi-hop content discovery working).
 *
 * - Unicast packet (destination set) addressed to us: deliver, do not
 *   forward further — the packet has reached its target.
 * - Unicast packet addressed to someone else: relay only, do not deliver.
 * - Broadcast packet (no destination, e.g. CONTENT_QUERY): deliver locally
 *   (so this node can answer if it has the content) AND keep flooding it
 *   onward, since other nodes may also be able to answer.
 * - Already-seen packet id: always dropped (spec §20).
 */
export function decideForward(packet: Packet, localNodeId: string, seenCache: SeenCache): ForwardDecision {
  if (seenCache.hasSeen(packet.id)) {
    return { duplicate: true, deliverLocally: false };
  }
  seenCache.markSeen(packet.id);

  const isUnicastForMe = packet.destination !== undefined && packet.destination === localNodeId;
  const isBroadcast = packet.destination === undefined;
  const deliverLocally = isUnicastForMe || isBroadcast;

  const shouldForward = !isUnicastForMe && packet.ttl > 0;
  const forwardPacket = shouldForward ? { ...packet, ttl: packet.ttl - 1 } : undefined;

  return { duplicate: false, deliverLocally, forwardPacket };
}
