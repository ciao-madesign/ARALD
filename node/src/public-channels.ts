import { BoundedFifoMap, pushBounded } from "./bounded-map.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "./message-history.js";

/** One message in a public channel — always the result of a successfully verified, fetched, and shape-checked `content://` publication (see `parseChannelFromContentName()`/`extractChannelMessagePayload()`/`node.ts`'s `considerChannelMessage()`). `author` is never itself a separate claim to forge (see its own doc comment below), but `text`/`timestamp` are — both live inside the signed payload bytes, not `ContentMetadata` directly (see `extractChannelMessagePayload()`). */
export interface ChannelMessage {
  channel: string;
  /** The publisher's node id (`ContentMetadata.publisherId`) — not a separate claim inside the message payload, so there is nothing here for a relay to have forged independently of the content signature itself. */
  author: string;
  text: string;
  /**
   * When the publisher created this message, per the *signed payload*
   * itself (`ChannelMessagePayload.timestamp`) — deliberately NOT
   * `ContentMetadata.createdAt` (found by review): `content.ts`'s
   * `SignableContentFields` excludes `createdAt` from what a publisher's
   * signature actually covers (only `ContentMetadata.name`, `mimeType`,
   * etc. are signed), so a relay could rewrite `createdAt` in transit
   * without invalidating `verifyContentSignature()` — a display-ordering
   * spoof, not a text/identity forgery, but still worth closing since it's
   * free to. Embedding the timestamp in the signed bytes themselves (same
   * precedent as `NewsHeadline.publishedAt`, `gateway/nomad/news-gateway.ts`)
   * makes it exactly as trustworthy as `text`/`author`.
   */
  timestamp: number;
  contentId: string;
}

/**
 * The actual signed payload shape a channel message's `content://` bytes
 * must have — `{ text, timestamp }`, deliberately not reusing `node.ts`'s
 * `extractChatText()` (which only validates `text`, for `PRIVATE_MESSAGE`'s
 * `{ text: string }` shape): a channel message additionally needs its own
 * signed `timestamp` (see `ChannelMessage.timestamp`'s doc comment for
 * why `ContentMetadata.createdAt` isn't good enough). `text` is bounded by
 * the same canonical `MAX_MESSAGE_TEXT_LENGTH` every other chat surface in
 * this codebase uses. Returns `undefined` for anything else — rejected,
 * not crashed, same defensive posture as every other network-sourced
 * payload in this codebase.
 */
export interface ChannelMessagePayload {
  text: string;
  timestamp: number;
}

export function extractChannelMessagePayload(payload: unknown): ChannelMessagePayload | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const { text, timestamp } = payload as { text?: unknown; timestamp?: unknown };
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_MESSAGE_TEXT_LENGTH) return undefined;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  return { text, timestamp };
}

/** The `chat:<channel>` naming convention this feature uses for `ContentMetadata.name` (docs/next-steps.md Opzione J) — a deliberate choice to avoid a protocol change: `name` is already covered by the publisher's signature (`contentSigningPayload()`, content.ts), so a relay can't retag a message into a different channel, without needing a new signed `topic`/`tags` field on `ContentMetadata` itself. */
const CHANNEL_NAME_PREFIX = "chat:";

/** Keeps a channel name short and predictable (fits comfortably in a `name` field, safe to use directly in a URL query string or as a mobile UI label) — lowercase ASCII letters/digits/hyphen/underscore only, matching how `publishChannelMessage()` (node.ts) normalizes input before ever signing it. */
const CHANNEL_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

export function isValidChannelName(channel: string): boolean {
  return CHANNEL_NAME_PATTERN.test(channel);
}

/** The `ContentMetadata.name` a message in `channel` is published under. */
export function channelContentName(channel: string): string {
  return CHANNEL_NAME_PREFIX + channel;
}

/**
 * The inverse of `channelContentName()` — extracts and validates a channel
 * name from a `ContentMetadata.name`, used defensively on the *receiving*
 * side (a `name` arriving via `CONTENT_ANNOUNCE`/catalog sync is signed by
 * its publisher, so it can't have been retagged by a relay, but a hostile
 * publisher can still sign whatever bytes it wants — `verifyContentSignature()`
 * (content.ts) only proves the signature matches, never that `name` is
 * even a string: a hand-crafted signer, not `NomadNode.publishContent()`
 * itself, could produce a validly-signed `ContentMetadata` whose `name` is
 * a number, `null`, or an object. `name: unknown` (not `string`) reflects
 * that — this is the one place that boundary gets enforced, same "never
 * trust a payload's shape just because it verified" posture as every other
 * network-sourced field in this codebase, `CLAUDE.md`). Returns `undefined`
 * for anything that isn't a string shaped `chat:<valid channel name>` —
 * rejected, not crashed.
 */
export function parseChannelFromContentName(name: unknown): string | undefined {
  if (typeof name !== "string" || !name.startsWith(CHANNEL_NAME_PREFIX)) return undefined;
  const channel = name.slice(CHANNEL_NAME_PREFIX.length);
  return isValidChannelName(channel) ? channel : undefined;
}

export interface PublicChannelsOptions {
  /** Max distinct channels tracked at once (spec §57 resource limits). */
  maxChannels?: number;
  /** Max messages kept per channel — the oldest is dropped once a channel exceeds this. */
  maxMessagesPerChannel?: number;
  /**
   * Same eviction convention as every other network-fed structure in this
   * codebase (bounded-map.ts) — ranks a channel for eviction (when
   * `maxChannels` is exceeded) by the *highest* trust rank among the
   * authors of the messages this channel currently has (`bestAuthorTrust()`),
   * not just its most recent poster's (found by review: ranking by "most
   * recent author" alone let a single low-trust post instantly strip a
   * long-established, highly-trusted channel of its eviction protection —
   * the whole channel's history would then be the first thing discarded
   * the next time `maxChannels` is hit, even though most of it came from
   * trusted authors). A channel itself isn't a single identity the way a
   * peer or a content publisher is, so this is a best-effort aggregate,
   * not a perfect analogue of `MessageHistory`'s own per-peer trust.
   * Omit for plain FIFO (oldest channel first).
   */
  trustRank?: (author: string) => number;
}

const DEFAULT_MAX_CHANNELS = 128;
const DEFAULT_MAX_MESSAGES_PER_CHANNEL = 500;

/**
 * Local, best-effort view of public (unencrypted) chat channels this node
 * has learned about — built entirely from already-verified `content://`
 * publications named `chat:<channel>` (see `channelContentName()`), never
 * its own signed/propagated structure the way `ContentStore`/`RemoteCatalog`
 * are. `NomadNode.publishChannelMessage()`/`considerChannelMessage()`
 * (node.ts) are the only callers: the former records this node's own sends
 * immediately (a locally-originated `CONTENT_ANNOUNCE` never loops back to
 * its own sender), the latter records what arrives via `CONTENT_ANNOUNCE`
 * or catalog sync, after fetching and shape-checking the actual bytes.
 *
 * Bounded on two axes (spec §57), same shape as `MessageHistory`: `maxChannels`
 * distinct channels tracked at once, and `maxMessagesPerChannel` messages
 * kept within each one — a peer who keeps posting cannot grow this node's
 * memory use without limit just by sending more, and a hostile peer can't
 * grow the number of *distinct channels* tracked without limit either
 * (`chat:<random-garbage>` for a fresh channel name each message).
 */
export class PublicChannels {
  private readonly messages: BoundedFifoMap<string, ChannelMessage[]>;
  private readonly maxMessagesPerChannel: number;

  constructor(options: PublicChannelsOptions = {}) {
    this.maxMessagesPerChannel = options.maxMessagesPerChannel ?? DEFAULT_MAX_MESSAGES_PER_CHANNEL;
    const trustRank = options.trustRank;
    this.messages = new BoundedFifoMap({
      maxSize: options.maxChannels ?? DEFAULT_MAX_CHANNELS,
      evictionScore: trustRank ? (_channel: string, existing: ChannelMessage[]) => this.bestAuthorTrust(existing, trustRank) : undefined,
    });
  }

  /**
   * The highest `trustRank` among `messages`' authors — see
   * `PublicChannelsOptions.trustRank`'s doc comment for why this is a max
   * over the whole (bounded) history, not just the most recent poster.
   * `-Infinity` for an empty list, so an (in practice never-stored, see
   * `record()`) empty channel would always be the first eviction
   * candidate.
   *
   * **Accepted cost tradeoff (noted by review)**: this rescans up to
   * `maxMessagesPerChannel` entries every time it's called, and
   * `BoundedFifoMap`'s eviction search calls it once per tracked channel —
   * an eviction costs O(`maxChannels` × `maxMessagesPerChannel`) rather
   * than the O(`maxChannels`) a single cached "best trust seen so far"
   * field would give. Cheap at this class's own defaults (128 × 500 =
   * 64,000 comparisons, negligible); an operator configuring both knobs
   * far above the defaults would make each eviction proportionally more
   * expensive. Not attacker-reachable (`maxChannels`/`maxMessagesPerChannel`
   * are constructor options, never network-fed) — an incrementally
   * maintained running max would need its own invalidation logic for
   * when the highest-trust message ages out of the bounded array via
   * `pushBounded()`'s trim, which is more machinery than this tradeoff
   * currently justifies.
   */
  private bestAuthorTrust(messages: readonly ChannelMessage[], trustRank: (author: string) => number): number {
    let best = -Infinity;
    for (const m of messages) {
      const score = trustRank(m.author);
      if (score > best) best = score;
    }
    return best;
  }

  /**
   * Records `message` into `message.channel`'s history — a no-op (not an
   * error) if a message with the same `contentId` is already present, so a
   * caller that learns of the same content twice (once via
   * `CONTENT_ANNOUNCE`, once via catalog sync racing it, or a relay
   * re-forwarding the same original packet) never produces a duplicate
   * entry. The per-channel array stays small (`maxMessagesPerChannel`), so
   * this dedup scan is cheap — no separate bounded id-tracking structure
   * needed just for this. Also a no-op if `maxMessagesPerChannel` is
   * configured at `<= 0` and nothing survives trimming — never stores a
   * channel with zero messages (found by review: an empty-but-present
   * channel violated `list()`'s "every listed channel has ≥1 message"
   * contract, which `web-ui.ts`'s `buildChannelList()` relies on).
   */
  record(message: ChannelMessage): void {
    const existing = this.messages.get(message.channel) ?? [];
    if (existing.some((m) => m.contentId === message.contentId)) return;
    pushBounded(existing, message, this.maxMessagesPerChannel);
    if (existing.length === 0) return;
    this.messages.set(message.channel, existing);
  }

  /** The messages in `channel`, oldest first — a copy, never the live internal array. Empty if this node has never learned of a message in `channel`. */
  get(channel: string): ChannelMessage[] {
    const existing = this.messages.get(channel);
    return existing ? [...existing] : [];
  }

  /** Every channel this node currently has at least one message for — not a global registry of "all channels that exist" (there is no such thing, spec's content-centric design has no channel-creation step), only what this node has actually learned. */
  list(): string[] {
    return [...this.messages.keys()];
  }
}
