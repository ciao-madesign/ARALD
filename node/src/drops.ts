import { BoundedFifoMap } from "./bounded-map.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "./message-history.js";

/**
 * Fixed, exact `ContentMetadata.name` a drop is published under — unlike
 * `chat:<channel>` (`public-channels.ts`), a drop has no per-instance name
 * to distinguish it from other drops: the content itself (different signed
 * bytes → different `contentId`) already does that, so there is exactly
 * one "channel" here, not a family of them. `NomadNode.considerDrop()`
 * recognizes a newly-announced piece of content as a drop by an exact
 * match against this constant, the same way `parseChannelFromContentName()`
 * recognizes a `chat:` prefix.
 */
export const DROP_CONTENT_NAME = "drop";

/** A short, free-text caption for a drop (e.g. "Frana sul sentiero") — distinct from the longer `text` body, purely for display; optional. */
export const MAX_DROP_LABEL_LENGTH = 100;

/**
 * Severity/routing tier for a drop (proposta esterna "HAZARD/INFO", analizzata
 * e approvata dall'utente il 4 settembre 2026 — vedi `docs/beacon.md`).
 * Sostituisce il precedente `urgent: boolean` a due livelli con una
 * tassonomia a tre: un vero SOS personale resta fuori da questo modulo
 * (`emergency-beacon.ts`, pipeline dedicata, voce #56) — `"emergency"` qui è
 * un'allerta d'area ad alta priorità (es. valanga), non un soccorso
 * individuale. `"hazard"` è il caso nuovo introdotto da questa voce (es. un
 * crepaccio sul sentiero): più visibile di un `"info"` ordinario ma senza
 * saltare la coda quanto `"emergency"`. Il mapping verso `Priority`
 * (`node.ts`'s `dropKindPriority()`) e la propagazione (flood mesh-wide via
 * `CONTENT_ANNOUNCE`, invariata per tutti e tre i livelli) restano
 * responsabilità di `NomadNode`, non di questo modulo.
 */
export type DropKind = "info" | "hazard" | "emergency";

const DROP_KINDS: readonly DropKind[] = ["info", "hazard", "emergency"];

/**
 * The signed `content://` payload a drop carries — mirrors
 * `ChannelMessagePayload` (`public-channels.ts`): `timestamp` lives here,
 * inside the bytes a publisher's signature actually covers
 * (`contentSigningPayload()`, `content.ts`), never in `ContentMetadata.createdAt`,
 * which isn't part of what gets signed and could otherwise be rewritten in
 * transit without invalidating anything. `lat`/`lon` are the reporter's own
 * position *at the moment they created the drop* — same "always here, right
 * now" posture already chosen for `shareLocation()`, never an arbitrary
 * point typed in by hand.
 */
export interface DropPayload {
  text: string;
  lat: number;
  lon: number;
  label?: string;
  kind: DropKind;
  timestamp: number;
}

/**
 * Validates and extracts a drop payload from already-fetched, signature-verified
 * `content://` bytes — same defensive posture as every other network-sourced
 * payload in this codebase (`extractChannelMessagePayload()`,
 * `extractLocationReport()`): never trusted just because the JSON parsed and
 * the outer content signature checked out. `undefined` for anything not
 * shaped exactly like a valid drop.
 */
export function extractDropPayload(payload: unknown): DropPayload | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.text !== "string" || p.text.length === 0 || p.text.length > MAX_MESSAGE_TEXT_LENGTH) return undefined;
  if (typeof p.lat !== "number" || !Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) return undefined;
  if (typeof p.lon !== "number" || !Number.isFinite(p.lon) || p.lon < -180 || p.lon > 180) return undefined;
  let label: string | undefined;
  if (p.label !== undefined) {
    if (typeof p.label !== "string" || p.label.length === 0 || p.label.length > MAX_DROP_LABEL_LENGTH) return undefined;
    label = p.label;
  }
  if (typeof p.kind !== "string" || !DROP_KINDS.includes(p.kind as DropKind)) return undefined;
  if (typeof p.timestamp !== "number" || !Number.isFinite(p.timestamp)) return undefined;
  return { text: p.text, lat: p.lat, lon: p.lon, label, kind: p.kind as DropKind, timestamp: p.timestamp };
}

/**
 * A drop as stored locally and returned to a reader. `dropId` is simply the
 * underlying content's `contentId` (a hash of the signed bytes, spec §24) —
 * unlike BitChat's `BoardPostPacket.postID` (a separately generated random
 * id, needed there because their wire format isn't itself content-addressed),
 * Nomad-Net already has a natural, unique, tamper-evident identifier for
 * free. `author` is `ContentMetadata.publisherId` — cryptographically
 * authenticated by the content signature, never a claim inside the payload
 * itself. `expiresAt` mirrors `ContentMetadata.expiresAt` (set once, at
 * publish time, via `publishContent()`'s `options.ttlMs` — never re-derived
 * from the payload, which carries no expiry field of its own).
 */
export interface Drop extends DropPayload {
  dropId: string;
  author: string;
  expiresAt?: number;
}

export interface DropsOptions {
  /** Max distinct drops tracked at once (spec §57 resource limits). */
  maxDrops?: number;
  /** Same eviction convention as every other network-fed structure in this codebase (bounded-map.ts) — ranks a drop for eviction by the trust of whoever authored it. Omit for plain FIFO (oldest drop first). */
  trustRank?: (author: string) => number;
}

const DEFAULT_MAX_DROPS = 1024;

/**
 * Local, best-effort view of drops (location-tagged public notices,
 * `docs/next-steps.md`) this node has learned about — built entirely from
 * already-verified `content://` publications named exactly `DROP_CONTENT_NAME`
 * (see that constant's own doc comment), the same architectural placement
 * as `PublicChannels`: pure mesh-internal state derived from already-signed
 * content, never itself a separately-signed/propagated structure.
 * `NomadNode.publishDrop()`/`considerDrop()` are the only callers.
 *
 * Bounded on one axis, unlike `PublicChannels`' two (`maxChannels` ×
 * `maxMessagesPerChannel`): there is only ever one flat collection of
 * drops, no per-channel grouping to bound separately.
 *
 * **Scadenza pigra**, same convention as `ContentStore`/`RemoteCatalog`/
 * `LocationRegistry`: a drop past its `expiresAt` is treated as absent and
 * evicted at read time (`list()`), never by a background sweep timer.
 */
export class Drops {
  private readonly items: BoundedFifoMap<string, Drop>;

  constructor(options: DropsOptions = {}) {
    const trustRank = options.trustRank;
    this.items = new BoundedFifoMap({
      maxSize: options.maxDrops ?? DEFAULT_MAX_DROPS,
      evictionScore: trustRank ? (_dropId: string, drop: Drop) => trustRank(drop.author) : undefined,
    });
  }

  record(drop: Drop): void {
    this.items.set(drop.dropId, drop);
  }

  /** Every currently-known, non-expired drop — newest first. */
  list(): Drop[] {
    const now = Date.now();
    const live: Drop[] = [];
    for (const [dropId, drop] of this.items) {
      if (drop.expiresAt !== undefined && drop.expiresAt <= now) {
        this.items.delete(dropId);
        continue;
      }
      live.push(drop);
    }
    return live.sort((a, b) => b.timestamp - a.timestamp);
  }
}
