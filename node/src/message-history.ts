import { BoundedFifoMap, pushBounded } from "./bounded-map.js";

export interface StoredMessage {
  /** The other party in this 1:1 conversation — always the peer's node id, regardless of `direction`. */
  peer: string;
  direction: "sent" | "received";
  text: string;
  timestamp: number;
}

export interface MessageHistoryOptions {
  /** Max distinct peers (conversations) tracked at once (spec §57 resource limits). */
  maxPeers?: number;
  /** Max messages kept per conversation — the oldest is dropped once a conversation exceeds this. */
  maxMessagesPerPeer?: number;
  /** Same eviction convention as every other network-fed structure in this codebase (bounded-map.ts) — ranks a peer for eviction when `maxPeers` is exceeded, so a low-trust peer's conversation is dropped before a trusted one's. Omit for plain FIFO (oldest conversation first). */
  trustRank?: (peer: string) => number;
}

const DEFAULT_MAX_PEERS = 256;
const DEFAULT_MAX_MESSAGES_PER_PEER = 500;

/**
 * Canonical cap on a single chat message's length (spec §57) — enforced in
 * two places that must agree, not just one: `node.ts`'s `extractChatText()`
 * (rejects an oversized `text` as "not a chat message" before it ever
 * reaches `record()`, the same defensive posture applied to any other
 * untrusted network-sourced field in this codebase) covers messages
 * *received* over `PRIVATE_MESSAGE` from any connected peer, not just ones
 * sent through this node's own HTTP API — `web-ui.ts`'s `POST /api/messages`
 * validation imports this same constant rather than keeping an independent
 * copy that could silently drift out of sync.
 */
export const MAX_MESSAGE_TEXT_LENGTH = 4000;

/**
 * Local-only history of 1:1 private messages (both sent and received),
 * keyed by the other party's node id. Purely this node's own record for a
 * thin HTTP client (the mobile app's chat UI, `web-ui.ts`'s `/api/messages`)
 * to poll — never itself signed, verified, or propagated to other peers,
 * unlike every other bounded structure in this codebase. `sendPrivateMessage()`/
 * `handlePrivateMessage()` (node.ts) are the only callers; a `PRIVATE_MESSAGE`
 * payload that isn't shaped like a chat message (no string `text` field —
 * `sendPrivateMessage()`'s payload is `unknown`, used by other things besides
 * chat) is never recorded here, so this stays exactly "the chat", not a raw
 * log of every private packet.
 *
 * Bounded on two axes (spec §57): `maxPeers` conversations tracked at once,
 * and `maxMessagesPerPeer` messages kept within each one — a peer who keeps
 * messaging this node cannot grow its memory use without limit just by
 * sending more.
 */
export class MessageHistory {
  private readonly conversations: BoundedFifoMap<string, StoredMessage[]>;
  private readonly maxMessagesPerPeer: number;

  constructor(options: MessageHistoryOptions = {}) {
    this.maxMessagesPerPeer = options.maxMessagesPerPeer ?? DEFAULT_MAX_MESSAGES_PER_PEER;
    const trustRank = options.trustRank;
    this.conversations = new BoundedFifoMap({
      maxSize: options.maxPeers ?? DEFAULT_MAX_PEERS,
      evictionScore: trustRank ? (peer: string) => trustRank(peer) : undefined,
    });
  }

  record(peer: string, direction: "sent" | "received", text: string): void {
    const messages = this.conversations.get(peer) ?? [];
    pushBounded(messages, { peer, direction, text, timestamp: Date.now() }, this.maxMessagesPerPeer);
    if (messages.length === 0) return; // maxMessagesPerPeer <= 0 — nothing survived trimming, don't record an empty conversation
    this.conversations.set(peer, messages);
  }

  /** The conversation with `peer`, oldest first — a copy, never the live internal array. Empty if no messages have ever been exchanged with `peer`. */
  get(peer: string): StoredMessage[] {
    const messages = this.conversations.get(peer);
    return messages ? [...messages] : [];
  }
}
