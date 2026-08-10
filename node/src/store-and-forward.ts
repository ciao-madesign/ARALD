import type { Packet } from "./packet.js";

export interface PendingDeliveryQueueOptions {
  /** How long a queued packet is worth retrying before it's dropped (wall-clock, independent of the packet's own hop TTL). */
  ttlMs?: number;
  /** Bounds memory: oldest entry is evicted once the queue is full (spec §57 resource limits). */
  maxSize?: number;
}

export interface QueuedDelivery {
  packet: Packet;
  /** The peer this packet must not be re-sent to on retry (typically whoever it was received from), if any. */
  exceptPeerId?: string;
}

interface Entry extends QueuedDelivery {
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SIZE = 256;

/**
 * Store-and-forward queue (spec §30, §72): holds unicast packets a node
 * could not immediately relay — because it currently has no other peer to
 * flood them to, or because every send attempt failed — so they can be
 * retried once connectivity resumes, e.g. a courier device reconnecting to
 * a different segment of the mesh (spec §32).
 *
 * Scope and known limitations (tracked for milestone 12 in docs/roadmap.md):
 * - Only unicast packets are queued (a specific destination is known);
 *   broadcast discovery packets such as CONTENT_QUERY are not.
 * - This queue's wall-clock `ttlMs` is independent of `SeenCache`'s
 *   size-bounded eviction (node/src/routing.ts): under sustained heavy
 *   traffic, a packet's id could in principle age out of another node's
 *   SeenCache before this queue's TTL expires, in which case a very late
 *   retry could be processed as if it were a new packet rather than being
 *   recognized as a duplicate. This is a latent edge case at the current
 *   default sizes (256 queued packets / 4096 seen ids / 5 minute TTL), not
 *   something this prototype resolves — a real fix needs the two caches'
 *   eviction policies to be coordinated, which is out of scope here.
 */
export class PendingDeliveryQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(options: PendingDeliveryQueueOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  }

  has(packetId: string): boolean {
    return this.entries.has(packetId);
  }

  enqueue(packet: Packet, exceptPeerId?: string): void {
    if (this.entries.has(packet.id)) return;
    if (this.entries.size >= this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(packet.id, { packet, exceptPeerId, expiresAt: Date.now() + this.ttlMs });
  }

  /** Removes every entry and returns the deliveries still worth retrying, silently dropping anything expired. */
  drain(): QueuedDelivery[] {
    const now = Date.now();
    const ready: QueuedDelivery[] = [];
    for (const [id, entry] of this.entries) {
      this.entries.delete(id);
      if (entry.expiresAt > now) ready.push({ packet: entry.packet, exceptPeerId: entry.exceptPeerId });
    }
    return ready;
  }

  get size(): number {
    return this.entries.size;
  }
}
