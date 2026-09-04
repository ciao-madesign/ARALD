import { BoundedFifoMap } from "./bounded-map.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "./message-history.js";
import type { DropKind } from "./drops.js";

/** Mirrors `MAX_DROP_LABEL_LENGTH` (`drops.ts`) — same short free-text caption purpose, kept as its own constant rather than imported so this module doesn't take on a dependency for a single number that happens to match today. */
export const MAX_NODE_APPEND_LABEL_LENGTH = 100;

/**
 * The `PRIVATE_MESSAGE` payload shape a Node Append has — discriminated by
 * `type: "node-append"`, same pattern as `LocationReportPayload`/`GroupInvitePayload`:
 * a Node Append is intrinsically directed at exactly one node (`docs/beacon.md`,
 * "Directed Content Delivery + Node Append"), so it reuses `PRIVATE_MESSAGE`'s
 * existing ECDH-derived per-peer encryption exactly as-is — no new packet
 * type, no new signing scheme. Reusing `DropKind` (`drops.ts`, voce #57)
 * instead of inventing a parallel severity enum: a Node Append and a drop are
 * the same three-tier content taxonomy, only the delivery shape differs
 * (targeted at one node vs. flooded mesh-wide).
 *
 * `expiresAt` is an *absolute* epoch timestamp, resolved by the sender at
 * send time (`NomadNode.appendToNode()`) — never a relative duration for the
 * receiver to reinterpret. Store-and-forward delay before arrival is exactly
 * the scenario Node Append exists for (a courier may carry this for minutes
 * or hours before reaching the target), so a relative TTL measured from
 * *arrival* would make an append's actual lifetime depend on how long it sat
 * in a courier's queue — the same reasoning `ContentMetadata.expiresAt`
 * already applies to published content's `ttlMs`.
 */
export interface NodeAppendPayload {
  type: "node-append";
  text: string;
  label?: string;
  kind: DropKind;
  timestamp: number;
  expiresAt: number;
}

/**
 * Validates and extracts a Node Append from an already-decrypted
 * `PRIVATE_MESSAGE` payload — same defensive posture as every other
 * network-sourced payload in this codebase (`extractLocationReport()`,
 * `extractDropPayload()`): `payload` is never trusted just because it
 * decrypted/parsed successfully. Returns `undefined` for anything that
 * isn't shaped exactly like a valid append.
 */
export function extractNodeAppendPayload(payload: unknown): NodeAppendPayload | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (p.type !== "node-append") return undefined;
  if (typeof p.text !== "string" || p.text.length === 0 || p.text.length > MAX_MESSAGE_TEXT_LENGTH) return undefined;
  let label: string | undefined;
  if (p.label !== undefined) {
    if (typeof p.label !== "string" || p.label.length === 0 || p.label.length > MAX_NODE_APPEND_LABEL_LENGTH) return undefined;
    label = p.label;
  }
  if (p.kind !== "info" && p.kind !== "hazard" && p.kind !== "emergency") return undefined;
  if (typeof p.timestamp !== "number" || !Number.isFinite(p.timestamp)) return undefined;
  if (typeof p.expiresAt !== "number" || !Number.isFinite(p.expiresAt)) return undefined;
  return { type: "node-append", text: p.text, label, kind: p.kind, timestamp: p.timestamp, expiresAt: p.expiresAt };
}

/**
 * A Node Append as stored locally and returned to a reader. `author` is the
 * cryptographically-authenticated sender (`PRIVATE_MESSAGE`'s `packet.source`,
 * trustworthy because it successfully decrypted with the ECDH-derived shared
 * key only that sender and this node share — same reasoning as
 * `LocationReport.reporterId`), never a field out of the payload itself.
 * `appendId` is the outer packet's own `id` (a random UUID minted once by
 * `createPacket()` and never changed as a packet is relayed/re-queued) —
 * reused as a free, already-unique identifier rather than generating a
 * second one: unlike a drop or published content, a Node Append has no
 * `ContentMetadata.contentId` to borrow (it never goes through
 * `publishContent()`).
 */
export interface NodeAppend extends NodeAppendPayload {
  appendId: string;
  author: string;
}

export interface NodeAppendsOptions {
  /** Max distinct appends tracked at once on this node (spec §57 resource limits). */
  maxNodeAppends?: number;
}

const DEFAULT_MAX_NODE_APPENDS = 256;

/**
 * Local, single-node "bulletin" of content deposited here via a Node Append
 * (`docs/beacon.md`, "Directed Content Delivery + Node Append") — content
 * addressed to *this* node specifically, meant to be read by whoever
 * connects to it locally, never re-propagated further into the mesh
 * (`routing.ts`'s `decideForward()` already stops forwarding once a unicast
 * packet reaches its destination — nothing in this class needs to enforce
 * that separately). Same architectural placement as `Drops`/`LocationRegistry`
 * — pure mesh-adjacent local state, `node/src/`, not `gateway/nomad/`.
 *
 * **No `trustRank`/eviction-by-trust, unlike `Drops`.** Every entry here has
 * already passed a trust-level gate *before* `record()` is ever called
 * (`NomadNode.considerNodeAppend()`, gated on `minTrustForNodeAppend`) —
 * unlike a drop, which accepts a claim from any mesh peer regardless of
 * trust. Same reasoning `RelayRegistry` already documents for its own
 * plain-FIFO choice: the *gate*, not the eviction policy, is what does the
 * defensive work here. Still bounded (spec §57 blanket resource-limit
 * convention) — a single already-VERIFIED sender could otherwise still
 * exhaust memory with an unbounded number of distinct appends.
 *
 * **Lazy expiry, same as `Drops`.** Unlike `RelayRegistry`'s permanent
 * installation records, a Node Append is explicitly TTL-bearing
 * (`docs/beacon.md`'s own example: "TTL: 48h") — `list()` treats an expired
 * entry as absent and evicts it on access, never a background sweep, same
 * convention as `ContentStore`/`Drops`/`RemoteCatalog`.
 */
export class NodeAppends {
  private readonly items: BoundedFifoMap<string, NodeAppend>;

  constructor(options: NodeAppendsOptions = {}) {
    this.items = new BoundedFifoMap({ maxSize: options.maxNodeAppends ?? DEFAULT_MAX_NODE_APPENDS });
  }

  /** No-op if `append.appendId` is already recorded (the same append delivered twice, e.g. once directly and once via a racing catalog-adjacent path — there is no such second path today, but matching `Drops.record()`'s idempotency costs nothing). */
  record(append: NodeAppend): void {
    if (this.items.has(append.appendId)) return;
    this.items.set(append.appendId, append);
  }

  /** Every currently-known, non-expired append, newest first — expired ones are lazily evicted from the underlying map as part of this call, same convention as `Drops.list()`/`ContentStore.list()`. */
  list(): NodeAppend[] {
    const now = Date.now();
    const expired: string[] = [];
    const result: NodeAppend[] = [];
    for (const append of this.items.values()) {
      if (append.expiresAt <= now) {
        expired.push(append.appendId);
      } else {
        result.push(append);
      }
    }
    for (const appendId of expired) this.items.delete(appendId);
    return result.sort((a, b) => b.timestamp - a.timestamp);
  }
}
