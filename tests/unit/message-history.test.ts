import { describe, expect, it } from "vitest";
import { MessageHistory } from "../../node/src/message-history.js";

describe("MessageHistory", () => {
  it("records and retrieves messages for a conversation, oldest first", () => {
    const history = new MessageHistory();
    history.record("peer-a", "sent", "ciao");
    history.record("peer-a", "received", "come stai?");
    history.record("peer-a", "sent", "bene, grazie");

    const messages = history.get("peer-a");
    expect(messages.map((m) => m.text)).toEqual(["ciao", "come stai?", "bene, grazie"]);
    expect(messages.map((m) => m.direction)).toEqual(["sent", "received", "sent"]);
    expect(messages.every((m) => m.peer === "peer-a")).toBe(true);
    expect(messages.every((m) => typeof m.timestamp === "number")).toBe(true);
  });

  it("returns an empty array for a peer with no history, never undefined/throwing", () => {
    const history = new MessageHistory();
    expect(history.get("nobody")).toEqual([]);
  });

  it("keeps separate conversations for different peers", () => {
    const history = new MessageHistory();
    history.record("a", "sent", "for a");
    history.record("b", "sent", "for b");

    expect(history.get("a").map((m) => m.text)).toEqual(["for a"]);
    expect(history.get("b").map((m) => m.text)).toEqual(["for b"]);
  });

  it("get() returns a copy of the array — pushing/splicing the result never affects internal state", () => {
    // Same convention as ContentStore.list() elsewhere in this codebase: the returned *container*
    // is a copy (so a caller can't corrupt future record()/get() calls by mutating the array it got
    // back), but the StoredMessage objects inside are treated as immutable by convention, not
    // deep-copied — nothing in this codebase ever mutates one after recording it.
    const history = new MessageHistory();
    history.record("a", "sent", "original");

    const messages = history.get("a");
    messages.push({ peer: "a", direction: "sent", text: "injected", timestamp: 0 });

    expect(history.get("a").map((m) => m.text)).toEqual(["original"]);
  });

  it("trims the oldest message once a conversation exceeds maxMessagesPerPeer", () => {
    const history = new MessageHistory({ maxMessagesPerPeer: 3 });
    for (let i = 0; i < 5; i++) history.record("a", "sent", `msg${i}`);

    // Only the 3 most recent survive — the oldest two (msg0, msg1) were dropped.
    expect(history.get("a").map((m) => m.text)).toEqual(["msg2", "msg3", "msg4"]);
  });

  it("evicts the oldest conversation (plain FIFO) once maxPeers is exceeded, with no trustRank given", () => {
    const history = new MessageHistory({ maxPeers: 2 });
    history.record("a", "sent", "x");
    history.record("b", "sent", "y");
    history.record("c", "sent", "z"); // pushes out "a", the oldest conversation

    expect(history.get("a")).toEqual([]);
    expect(history.get("b").map((m) => m.text)).toEqual(["y"]);
    expect(history.get("c").map((m) => m.text)).toEqual(["z"]);
  });

  it("evicts by trustRank instead of insertion order, when given one — same convention as every other bounded structure in this codebase", () => {
    const trustScores: Record<string, number> = { a: 10, b: 1, c: 5 };
    const history = new MessageHistory({ maxPeers: 2, trustRank: (peer) => trustScores[peer] ?? 0 });
    history.record("a", "sent", "trusted, oldest"); // highest trust — must survive despite being oldest
    history.record("b", "sent", "least trusted");
    history.record("c", "sent", "new arrival"); // evicts "b" (lowest score), not "a" (oldest)

    expect(history.get("a").map((m) => m.text)).toEqual(["trusted, oldest"]);
    expect(history.get("b")).toEqual([]);
    expect(history.get("c").map((m) => m.text)).toEqual(["new arrival"]);
  });

  it("updating an existing peer's conversation never evicts another conversation, even at capacity", () => {
    const history = new MessageHistory({ maxPeers: 2 });
    history.record("a", "sent", "1");
    history.record("b", "sent", "1");
    history.record("a", "sent", "2"); // existing key — must not evict "b"

    expect(history.get("a").map((m) => m.text)).toEqual(["1", "2"]);
    expect(history.get("b").map((m) => m.text)).toEqual(["1"]);
  });
});
