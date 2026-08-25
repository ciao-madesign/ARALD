import { describe, expect, it } from "vitest";
import {
  PublicChannels,
  isValidChannelName,
  channelContentName,
  parseChannelFromContentName,
  extractChannelMessagePayload,
  type ChannelMessage,
} from "../../node/src/public-channels.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";

function msg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return { channel: "generale", author: "node-a", text: "ciao", timestamp: Date.now(), contentId: "id-1", ...overrides };
}

describe("isValidChannelName / channelContentName / parseChannelFromContentName", () => {
  it("accepts lowercase alphanumeric, hyphen, underscore, 1-32 chars", () => {
    expect(isValidChannelName("generale")).toBe(true);
    expect(isValidChannelName("zona-nord")).toBe(true);
    expect(isValidChannelName("zona_nord_2")).toBe(true);
    expect(isValidChannelName("a")).toBe(true);
    expect(isValidChannelName("a".repeat(32))).toBe(true);
  });

  it("rejects uppercase, empty, oversized, or otherwise-shaped names", () => {
    expect(isValidChannelName("Generale")).toBe(false);
    expect(isValidChannelName("")).toBe(false);
    expect(isValidChannelName("a".repeat(33))).toBe(false);
    expect(isValidChannelName("zona nord")).toBe(false); // space
    expect(isValidChannelName("zona/nord")).toBe(false); // slash
    expect(isValidChannelName("chat:generale")).toBe(false); // already-prefixed, not a bare channel name
  });

  it("channelContentName()/parseChannelFromContentName() round-trip for a valid channel", () => {
    expect(channelContentName("generale")).toBe("chat:generale");
    expect(parseChannelFromContentName("chat:generale")).toBe("generale");
  });

  it("parseChannelFromContentName() rejects anything not shaped like chat:<valid channel>", () => {
    expect(parseChannelFromContentName("not-a-chat-name")).toBeUndefined();
    expect(parseChannelFromContentName("chat:")).toBeUndefined(); // empty channel part
    expect(parseChannelFromContentName("chat:Not Valid")).toBeUndefined();
    expect(parseChannelFromContentName("chat:" + "a".repeat(33))).toBeUndefined();
    // A hostile publisher could sign a name like this — still rejected, not crashed.
    expect(parseChannelFromContentName("chat:../../etc/passwd")).toBeUndefined();
  });

  it("parseChannelFromContentName() rejects a non-string name without throwing", () => {
    // verifyContentSignature() (content.ts) only proves the signature matches whatever bytes were
    // signed — it never checks that ContentMetadata.name is actually a string. A hand-crafted signer
    // (not NomadNode.publishContent() itself) could sign metadata whose `name` is a number, null, or
    // an object; decodePacket() (packet.ts) never validates payload shape either. This must reject,
    // not throw — a single such packet must never crash the node (CLAUDE.md's defensive-payload
    // convention, tests/integration/malformed-packet-robustness.test.ts's pattern).
    expect(parseChannelFromContentName(12345 as unknown as string)).toBeUndefined();
    expect(parseChannelFromContentName(null as unknown as string)).toBeUndefined();
    expect(parseChannelFromContentName(undefined as unknown as string)).toBeUndefined();
    expect(parseChannelFromContentName({} as unknown as string)).toBeUndefined();
    expect(parseChannelFromContentName(["chat:generale"] as unknown as string)).toBeUndefined();
  });
});

describe("extractChannelMessagePayload", () => {
  it("accepts a well-formed { text, timestamp } payload", () => {
    expect(extractChannelMessagePayload({ text: "ciao", timestamp: 12345 })).toEqual({ text: "ciao", timestamp: 12345 });
  });

  it("rejects a missing/non-string/empty/oversized text, same bound as MAX_MESSAGE_TEXT_LENGTH everywhere else", () => {
    expect(extractChannelMessagePayload({ timestamp: 1 })).toBeUndefined();
    expect(extractChannelMessagePayload({ text: 123, timestamp: 1 })).toBeUndefined();
    expect(extractChannelMessagePayload({ text: "", timestamp: 1 })).toBeUndefined();
    expect(extractChannelMessagePayload({ text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1), timestamp: 1 })).toBeUndefined();
    expect(extractChannelMessagePayload({ text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH), timestamp: 1 })).toBeDefined(); // exactly at the limit
  });

  it("rejects a missing/non-number/non-finite timestamp — this is the field the fix added, it must not be optional", () => {
    expect(extractChannelMessagePayload({ text: "ciao" })).toBeUndefined();
    expect(extractChannelMessagePayload({ text: "ciao", timestamp: "12345" })).toBeUndefined();
    expect(extractChannelMessagePayload({ text: "ciao", timestamp: Number.NaN })).toBeUndefined();
    expect(extractChannelMessagePayload({ text: "ciao", timestamp: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("rejects a payload that isn't even an object, without throwing", () => {
    expect(extractChannelMessagePayload(undefined)).toBeUndefined();
    expect(extractChannelMessagePayload(null)).toBeUndefined();
    expect(extractChannelMessagePayload("ciao")).toBeUndefined();
    expect(extractChannelMessagePayload(42)).toBeUndefined();
    expect(extractChannelMessagePayload(["ciao"])).toBeUndefined();
  });

  it("ignores extra fields — e.g. a payload-level createdAt is never read, only ChannelMessage.timestamp's own field is", () => {
    // Documents the actual fix: nothing about this function's output depends on any field named
    // createdAt, in the payload or otherwise — the only source of truth is the payload's own
    // `timestamp` key.
    expect(extractChannelMessagePayload({ text: "ciao", timestamp: 100, createdAt: 999999 })).toEqual({ text: "ciao", timestamp: 100 });
  });
});

describe("PublicChannels", () => {
  it("records and retrieves messages for a channel, oldest first", () => {
    const channels = new PublicChannels();
    channels.record(msg({ text: "primo", contentId: "1" }));
    channels.record(msg({ text: "secondo", contentId: "2" }));
    channels.record(msg({ text: "terzo", contentId: "3" }));

    const messages = channels.get("generale");
    expect(messages.map((m) => m.text)).toEqual(["primo", "secondo", "terzo"]);
    expect(messages.every((m) => m.channel === "generale")).toBe(true);
  });

  it("returns an empty array for a channel with no messages, never undefined/throwing", () => {
    const channels = new PublicChannels();
    expect(channels.get("nobody-posted-here")).toEqual([]);
  });

  it("keeps separate histories for different channels", () => {
    const channels = new PublicChannels();
    channels.record(msg({ channel: "a", text: "for a", contentId: "1" }));
    channels.record(msg({ channel: "b", text: "for b", contentId: "2" }));

    expect(channels.get("a").map((m) => m.text)).toEqual(["for a"]);
    expect(channels.get("b").map((m) => m.text)).toEqual(["for b"]);
  });

  it("get() returns a copy of the array — pushing/splicing the result never affects internal state", () => {
    const channels = new PublicChannels();
    channels.record(msg({ text: "original", contentId: "1" }));

    const messages = channels.get("generale");
    messages.push(msg({ text: "injected", contentId: "2" }));

    expect(channels.get("generale").map((m) => m.text)).toEqual(["original"]);
  });

  it("ignores a second record() for the same contentId — no duplicate entry", () => {
    // The realistic case: the same message learned twice (once via CONTENT_ANNOUNCE, once via a
    // racing catalog sync) must not appear twice in the channel's history.
    const channels = new PublicChannels();
    channels.record(msg({ text: "hello", contentId: "same-id" }));
    channels.record(msg({ text: "hello", contentId: "same-id" }));

    expect(channels.get("generale")).toHaveLength(1);
  });

  it("trims the oldest message once a channel exceeds maxMessagesPerChannel", () => {
    const channels = new PublicChannels({ maxMessagesPerChannel: 3 });
    for (let i = 0; i < 5; i++) channels.record(msg({ text: `msg${i}`, contentId: `id-${i}` }));

    expect(channels.get("generale").map((m) => m.text)).toEqual(["msg2", "msg3", "msg4"]);
  });

  it("list() reflects only channels this instance has actually recorded a message for", () => {
    const channels = new PublicChannels();
    expect(channels.list()).toEqual([]);

    channels.record(msg({ channel: "a", contentId: "1" }));
    channels.record(msg({ channel: "b", contentId: "2" }));
    expect(channels.list().sort()).toEqual(["a", "b"]);
  });

  it("evicts the oldest channel (plain FIFO) once maxChannels is exceeded, with no trustRank given", () => {
    const channels = new PublicChannels({ maxChannels: 2 });
    channels.record(msg({ channel: "a", contentId: "1" }));
    channels.record(msg({ channel: "b", contentId: "2" }));
    channels.record(msg({ channel: "c", contentId: "3" })); // pushes out "a", the oldest channel

    expect(channels.get("a")).toEqual([]);
    expect(channels.get("b")).toHaveLength(1);
    expect(channels.get("c")).toHaveLength(1);
  });

  it("evicts by the trust of a channel's authors instead of insertion order, when given a trustRank", () => {
    const trustScores: Record<string, number> = { "trusted-author": 10, "sketchy-author": 1, "mid-author": 5 };
    const channels = new PublicChannels({ maxChannels: 2, trustRank: (author) => trustScores[author] ?? 0 });
    channels.record(msg({ channel: "a", author: "trusted-author", contentId: "1" })); // highest trust — must survive despite being oldest
    channels.record(msg({ channel: "b", author: "sketchy-author", contentId: "2" }));
    channels.record(msg({ channel: "c", author: "mid-author", contentId: "3" })); // evicts "b" (lowest score), not "a" (oldest)

    expect(channels.get("a")).toHaveLength(1);
    expect(channels.get("b")).toEqual([]);
    expect(channels.get("c")).toHaveLength(1);
  });

  it("ranks a channel by the HIGHEST trust seen among its authors, not just the most recent one — a single low-trust post must not strip a trusted channel's protection", () => {
    // Regression: found by review — an earlier version ranked eviction purely by the most recent
    // message's author, so one throwaway low-trust post into an otherwise long-established, highly
    // trusted channel would have made that whole channel the top eviction candidate the next time
    // maxChannels was hit, discarding a trusted history over a single new post. Three distinct trust
    // tiers (not just two) so "generale" ends up strictly better-protected than "b" despite its most
    // recent author being the least trusted of all three — under the old "most recent author only"
    // scheme, generale's score would have been sketchy-author's (1), lower than b's (5), making
    // generale — not b — the eviction victim; this proves the fix picks b instead.
    const trustScores: Record<string, number> = { "trusted-author": 10, "mid-author": 5, "sketchy-author": 1 };
    const channels = new PublicChannels({ maxChannels: 2, trustRank: (author) => trustScores[author] ?? 0 });
    channels.record(msg({ channel: "generale", author: "trusted-author", contentId: "1" }));
    channels.record(msg({ channel: "b", author: "mid-author", contentId: "2" }));
    // A low-trust author posts into the already-trusted "generale" — its most recent author is now
    // the sketchy one, but its history still includes the trusted author.
    channels.record(msg({ channel: "generale", author: "sketchy-author", contentId: "3" }));
    // A brand new channel forces an eviction between "generale" (best trust 10) and "b" (best trust
    // 5) — "b" loses, "generale" survives intact despite sketchy-author's post.
    channels.record(msg({ channel: "c", author: "sketchy-author", contentId: "4" }));

    expect(channels.get("generale").map((m) => m.contentId)).toEqual(["1", "3"]); // still fully intact
    expect(channels.get("b")).toEqual([]);
  });

  it("updating an existing channel's history never evicts another channel, even at capacity", () => {
    const channels = new PublicChannels({ maxChannels: 2 });
    channels.record(msg({ channel: "a", contentId: "1" }));
    channels.record(msg({ channel: "b", contentId: "2" }));
    channels.record(msg({ channel: "a", text: "second in a", contentId: "3" })); // existing key — must not evict "b"

    expect(channels.get("a").map((m) => m.text)).toEqual(["ciao", "second in a"]);
    expect(channels.get("b")).toHaveLength(1);
  });
});
