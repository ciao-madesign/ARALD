import { BoundedFifoMap } from "./bounded-map.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "./message-history.js";
import type { DropKind } from "./drops.js";
import { Identity } from "./identity.js";

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
 * Signable fields for a Node Append submitted *not* through the mesh's own
 * `PRIVATE_MESSAGE` (ECDH+AES-256-GCM) channel, but through the "canale di
 * comando Box↔specchio" — "Pezzo 2" (`docs/emergency-portal.md`,
 * `docs/security.md` voce #82). A real mesh-originated append authenticates
 * its sender implicitly: `handlePrivateMessage()` only ever decrypts
 * successfully if the ciphertext was really produced with the ECDH-derived
 * shared key between `packet.source` and this node, so a valid decryption
 * *is* the proof of authorship (see `NodeAppend`'s own doc comment). A
 * remotely-submitted append has no such channel — it arrives as an ordinary
 * authenticated HTTP request, never through the mesh at all — so it needs an
 * explicit Ed25519 signature instead, by the *operator's* own mesh identity
 * (the same one `mirror-portal/lib/mesh-signing.ts` already custodies for
 * signing Drops, "Pezzo 1") — never the Box's own `this.identity`, and never
 * a new key type: same generic `Identity.sign()`/`Identity.verifyWithNodeId()`
 * primitive `content.ts`/`groups.ts` already use for an analogous "prove who
 * really composed this, independent of the transport it arrived on" need.
 *
 * `targetNodeId` is part of what gets signed, not just part of the HTTP
 * envelope: it binds a given signature to the one Box it was meant for, so a
 * submission captured in transit (e.g. from the portal's own Postgres queue)
 * can't be replayed against a *different* Box's ingest endpoint even if that
 * Box also trusts the same operator identity — same defense-in-depth
 * reasoning `computeExternalDeliveryAuthProof()` already applies (voce #70).
 *
 * Deliberately does **not** reuse `content.ts`'s `ContentMetadata`/
 * `contentSigningPayload()` the way Drop ingestion does (`ingestSignedContent()`,
 * "Pezzo 1"): a Node Append is never `content://`-addressable or discoverable
 * by an arbitrary mesh peer — routing it through `ContentStore` would make it
 * exactly that, contradicting its whole point ("deposited specifically at
 * one node... never re-propagated further", see `NodeAppends`' own doc
 * comment). It gets its own small, bespoke signing scheme instead, same
 * pattern `groups.ts`'s `groupMessageSigningPayload()`/`verifyGroupMessage()`
 * already establishes for a claim that isn't content-shaped.
 */
export interface SignableNodeAppendFields {
  text: string;
  label?: string;
  kind: DropKind;
  timestamp: number;
  expiresAt: number;
  targetNodeId: string;
  publisherId: string;
}

export function nodeAppendSigningPayload(fields: SignableNodeAppendFields): Buffer {
  return Buffer.from(
    JSON.stringify({
      text: fields.text,
      label: fields.label,
      kind: fields.kind,
      timestamp: fields.timestamp,
      expiresAt: fields.expiresAt,
      targetNodeId: fields.targetNodeId,
      publisherId: fields.publisherId,
    }),
  );
}

/** A `SignableNodeAppendFields` plus the Ed25519 signature (hex) over `nodeAppendSigningPayload()`, by `publisherId`. */
export interface SignedNodeAppendSubmission extends SignableNodeAppendFields {
  signature: string;
}

/**
 * Validates shape and signature together (same combined style as
 * `verifyGroupMessage()`, `groups.ts`) — returns `undefined` for anything
 * malformed or with an invalid/mismatched signature, never throws. Callers
 * (`NomadNode.ingestSignedNodeAppend()`) never need to trust the shape of
 * `payload` just because it parsed as JSON.
 */
export function verifySignedNodeAppendSubmission(payload: unknown): SignedNodeAppendSubmission | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.text !== "string" || p.text.length === 0 || p.text.length > MAX_MESSAGE_TEXT_LENGTH) return undefined;
  let label: string | undefined;
  if (p.label !== undefined) {
    if (typeof p.label !== "string" || p.label.length === 0 || p.label.length > MAX_NODE_APPEND_LABEL_LENGTH) return undefined;
    label = p.label;
  }
  if (p.kind !== "info" && p.kind !== "hazard" && p.kind !== "emergency") return undefined;
  if (typeof p.timestamp !== "number" || !Number.isFinite(p.timestamp)) return undefined;
  if (typeof p.expiresAt !== "number" || !Number.isFinite(p.expiresAt)) return undefined;
  if (typeof p.targetNodeId !== "string" || p.targetNodeId.length === 0) return undefined;
  if (typeof p.publisherId !== "string" || p.publisherId.length === 0) return undefined;
  if (typeof p.signature !== "string") return undefined;
  const fields: SignableNodeAppendFields = {
    text: p.text,
    label,
    kind: p.kind,
    timestamp: p.timestamp,
    expiresAt: p.expiresAt,
    targetNodeId: p.targetNodeId,
    publisherId: p.publisherId,
  };
  try {
    if (!Identity.verifyWithNodeId(p.publisherId, nodeAppendSigningPayload(fields), Buffer.from(p.signature, "hex"))) return undefined;
  } catch {
    // Malformed signature hex, or a publisherId that doesn't parse as an Ed25519 public key — never trust it.
    return undefined;
  }
  return { ...fields, signature: p.signature };
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
  /**
   * Ranks an entry by the *live* trust level of its `author` at eviction time — same wiring
   * pattern as `ContentStore`'s own `trustRank` option (`content.ts`): pass
   * `(author) => trustRank(trustManager.get(author))`. Added by review ("Pezzo 2" del canale di
   * comando, `docs/security.md` voce #82) once `NomadNode.ingestSignedNodeAppend()` started
   * recording entries into this same bounded store *without* passing
   * `minTrustForNodeAppend`'s gate first — see this class's own doc comment below for why plain
   * FIFO stopped being safe once that became possible. Omit for plain FIFO (the original
   * behavior, still what every existing caller/test that doesn't pass this option gets).
   */
  trustRank?: (author: string) => number;
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
 * **`trustRank`-based eviction, added for "Pezzo 2" (`docs/security.md`
 * voce #82) — this class's original premise no longer holds unconditionally.**
 * The mesh path (`NomadNode.considerNodeAppend()`, gated on
 * `minTrustForNodeAppend`) still only ever calls `record()` for a sender
 * that already cleared that trust level. But `ingestSignedNodeAppend()` (an
 * authenticated HTTP submission, never a mesh packet) deliberately does
 * **not** apply that same gate — its own doc comment explains why — so an
 * entry recorded through it carries no such guarantee: its author may be an
 * identity this Box has never independently vetted at all. Passing
 * `trustRank` (same wiring `ContentStore` already uses) ensures a
 * genuinely mesh-vetted (`>= minTrustForNodeAppend`) entry is evicted
 * *before* an HTTP-ingested one only whenever its author's live trust
 * *outranks* the HTTP-ingested entry's — found necessary by review after a
 * burst of many distinct, self-generated identities submitted via HTTP
 * (each clearing only the network password, not a vetted trust level)
 * could otherwise evict a legitimately mesh-sourced entry under plain FIFO,
 * exactly the "throwaway-identity eviction" attack `bounded-map.ts`'s own
 * `evictionScore` option exists to close everywhere else in this codebase.
 * **Known residual gap, found by a second review pass**: on a *tie* —
 * an HTTP-ingested entry whose author independently reached the same
 * trust rank some other way (e.g. by also being a real, connected mesh
 * peer that produced any one valid signature this Box observed;
 * `TrustLevel.VERIFIED` is documented, `trust.ts`, as cheap to earn this
 * way and proves only "this key signed something", never legitimacy) —
 * `bounded-map.ts`'s own tie-break (oldest entry first) can still evict a
 * genuinely mesh-sourced entry ahead of the tied HTTP-ingested one.
 * `trustRank` alone can't see *how* an entry arrived, only the current
 * trust of its author; closing this fully would need `NodeAppend` to carry
 * its own arrival-path signal, not attempted here — same "accepted,
 * documented limit" treatment this codebase already gives `packet.source`
 * (`CLAUDE.md`, "Binding crittografico"), not a claim this eviction scheme
 * is airtight. `ingestSignedNodeAppend()`'s own
 * `MAX_HTTP_INGESTED_NODE_APPENDS_PER_WINDOW` (`node.ts`) additionally
 * throttles how fast HTTP-ingested entries can accumulate at all, bounding
 * how often this residual gap can even be exercised.
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
    const trustRank = options.trustRank;
    this.items = new BoundedFifoMap({
      maxSize: options.maxNodeAppends ?? DEFAULT_MAX_NODE_APPENDS,
      evictionScore: trustRank ? (_appendId, item) => trustRank(item.author) : undefined,
    });
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
