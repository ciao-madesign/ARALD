import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Identity } from "../../node/src/identity.js";
import {
  Groups,
  extractGroupInvite,
  groupMessageSigningPayload,
  signGroupMessage,
  verifyGroupMessage,
  decryptGroupMessage,
  generateGroupId,
  generateGroupKey,
  type GroupInfo,
  type GroupInvitePayload,
  type GroupMessage,
} from "../../node/src/groups.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";

function validInvite(overrides: Partial<GroupInvitePayload> = {}): GroupInvitePayload {
  return {
    type: "group-invite",
    groupId: generateGroupId(),
    name: "Escursione",
    groupKey: generateGroupKey().toString("hex"),
    members: ["node-a", "node-b"],
    createdBy: "node-a",
    createdAt: Date.now(),
    ...overrides,
  };
}

// A distinct default messageId per call (mirrors how a real signature is unique per encrypted
// message, groups.ts's GroupMessage.messageId doc comment) — tests that care about dedup pass an
// explicit, shared messageId instead of relying on this default.
let nextMessageId = 0;
function chatMessage(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return { groupId: "generic", senderId: "node-a", text: "ciao", timestamp: Date.now(), messageId: `msg-${nextMessageId++}`, ...overrides };
}

function group(overrides: Partial<GroupInfo> = {}): GroupInfo {
  return {
    groupId: generateGroupId(),
    name: "Escursione",
    key: generateGroupKey(),
    members: ["node-b"],
    createdBy: "node-a",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("extractGroupInvite", () => {
  it("accepts a well-formed invite", () => {
    const invite = validInvite();
    expect(extractGroupInvite(invite)).toEqual(invite);
  });

  it("rejects a non-object payload without throwing", () => {
    expect(extractGroupInvite(undefined)).toBeUndefined();
    expect(extractGroupInvite(null)).toBeUndefined();
    expect(extractGroupInvite("nope")).toBeUndefined();
    expect(extractGroupInvite(42)).toBeUndefined();
  });

  it("rejects a wrong or missing type discriminator — this is what tells it apart from a plain chat message", () => {
    expect(extractGroupInvite({ ...validInvite(), type: "chat" })).toBeUndefined();
    const { type: _type, ...withoutType } = validInvite();
    expect(extractGroupInvite(withoutType)).toBeUndefined();
  });

  it("rejects a malformed groupId (not the expected 32-hex-char shape)", () => {
    expect(extractGroupInvite(validInvite({ groupId: "not-hex" }))).toBeUndefined();
    expect(extractGroupInvite(validInvite({ groupId: "" }))).toBeUndefined();
    expect(extractGroupInvite(validInvite({ groupId: 12345 as unknown as string }))).toBeUndefined();
  });

  it("rejects an empty or oversized name", () => {
    expect(extractGroupInvite(validInvite({ name: "" }))).toBeUndefined();
    expect(extractGroupInvite(validInvite({ name: "x".repeat(129) }))).toBeUndefined();
    expect(extractGroupInvite(validInvite({ name: "x".repeat(128) }))).toBeDefined(); // exactly at the limit
  });

  it("rejects a malformed groupKey (must be exactly 64 hex chars — a 32-byte AES-256 key)", () => {
    expect(extractGroupInvite(validInvite({ groupKey: "too-short" }))).toBeUndefined();
    expect(extractGroupInvite(validInvite({ groupKey: "a".repeat(63) }))).toBeUndefined();
    expect(extractGroupInvite(validInvite({ groupKey: "g".repeat(64) }))).toBeUndefined(); // not hex
  });

  it("rejects a non-array or non-string-array members field", () => {
    expect(extractGroupInvite(validInvite({ members: "node-a" as unknown as string[] }))).toBeUndefined();
    expect(extractGroupInvite(validInvite({ members: [1, 2] as unknown as string[] }))).toBeUndefined();
    const emptyMembersInvite = validInvite({ members: [] });
    // Empty is shape-valid here; NomadNode.createGroup() itself is what refuses to create a group with no other members.
    expect(extractGroupInvite(emptyMembersInvite)).toEqual(emptyMembersInvite);
  });

  it("rejects a missing/wrong-typed createdBy or a non-finite createdAt", () => {
    expect(extractGroupInvite(validInvite({ createdBy: 42 as unknown as string }))).toBeUndefined();
    expect(extractGroupInvite(validInvite({ createdAt: "yesterday" as unknown as number }))).toBeUndefined();
    expect(extractGroupInvite(validInvite({ createdAt: Number.NaN }))).toBeUndefined();
  });

  it("ignores extra fields on the payload", () => {
    const invite = validInvite();
    expect(extractGroupInvite({ ...invite, extra: "field" })).toEqual(invite);
  });
});

describe("signGroupMessage / verifyGroupMessage / decryptGroupMessage", () => {
  it("round-trips: a signed+encrypted message verifies and decrypts back to the original plaintext", () => {
    const sender = Identity.generate();
    const groupKey = generateGroupKey();
    const groupId = generateGroupId();
    const plaintext = { text: "ci vediamo al rifugio", timestamp: 12345 };

    const payload = signGroupMessage(sender, groupId, groupKey, plaintext);
    const verified = verifyGroupMessage(payload);
    expect(verified).toBeDefined();
    expect(verified?.senderId).toBe(sender.nodeId);

    const decrypted = decryptGroupMessage(verified!, groupKey);
    expect(decrypted).toEqual(plaintext);
  });

  it("verifyGroupMessage rejects a payload whose signature doesn't match its claimed senderId", () => {
    const sender = Identity.generate();
    const impostor = Identity.generate();
    const groupKey = generateGroupKey();
    const groupId = generateGroupId();
    const payload = signGroupMessage(sender, groupId, groupKey, { text: "hello", timestamp: 1 });

    // A group member (impostor) who knows the shared group key re-encrypts and signs the same
    // plaintext, but claims to be `sender` — exactly the impersonation the Ed25519 signature exists
    // to prevent (see groupMessageSigningPayload()'s doc comment): the forged senderId doesn't match
    // whoever's key actually produced the signature.
    const forged = { ...payload, senderId: sender.nodeId, signature: impostor.sign(groupMessageSigningPayload({ ...payload, senderId: impostor.nodeId })).toString("hex") };
    expect(verifyGroupMessage(forged)).toBeUndefined();
  });

  it("verifyGroupMessage rejects a tampered ciphertext/nonce/authTag/groupId even with a structurally valid signature", () => {
    const sender = Identity.generate();
    const groupKey = generateGroupKey();
    const groupId = generateGroupId();
    const payload = signGroupMessage(sender, groupId, groupKey, { text: "hello", timestamp: 1 });

    expect(verifyGroupMessage({ ...payload, ciphertext: randomBytes(payload.ciphertext.length / 2).toString("hex") })).toBeUndefined();
    expect(verifyGroupMessage({ ...payload, groupId: generateGroupId() })).toBeUndefined();
    expect(verifyGroupMessage({ ...payload, nonce: randomBytes(12).toString("hex") })).toBeUndefined();
  });

  it("verifyGroupMessage rejects malformed shapes without throwing", () => {
    expect(verifyGroupMessage(undefined)).toBeUndefined();
    expect(verifyGroupMessage(null)).toBeUndefined();
    expect(verifyGroupMessage({})).toBeUndefined();
    expect(verifyGroupMessage({ groupId: "not-hex", senderId: "x", nonce: "a", ciphertext: "b", authTag: "c", signature: "d" })).toBeUndefined();
    // A senderId that doesn't parse as an Ed25519 public key at all (not just "wrong") must reject cleanly, not throw.
    expect(verifyGroupMessage({ groupId: generateGroupId(), senderId: "not-a-valid-hex-pubkey!", nonce: "a", ciphertext: "b", authTag: "c", signature: "d" })).toBeUndefined();
  });

  it("decryptGroupMessage throws (not returns undefined) when the ciphertext doesn't decrypt with the given key — an anomaly for a caller that already knows the group, not a routine rejection", () => {
    const sender = Identity.generate();
    const groupId = generateGroupId();
    const payload = signGroupMessage(sender, groupId, generateGroupKey(), { text: "hello", timestamp: 1 });
    expect(() => decryptGroupMessage(payload, generateGroupKey())).toThrow();
  });

  it("decryptGroupMessage rejects a plaintext that decrypts fine but isn't shaped like a chat message", () => {
    const sender = Identity.generate();
    const groupKey = generateGroupKey();
    const groupId = generateGroupId();
    // signGroupMessage() only ever produces well-shaped plaintext; this simulates a hostile/buggy
    // sender who knows the group key but sends something else entirely.
    const payload = signGroupMessage(sender, groupId, groupKey, { text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1), timestamp: 1 } as never);
    expect(decryptGroupMessage(payload, groupKey)).toBeUndefined();
  });
});

describe("Groups", () => {
  it("addGroup()/getGroup() round-trip, and a second addGroup() for the same groupId is a no-op", () => {
    const groups = new Groups();
    const info = group();
    groups.addGroup(info);
    groups.addGroup(group({ groupId: info.groupId, name: "retransmit, should not overwrite" }));

    expect(groups.getGroup(info.groupId)?.name).toBe("Escursione");
  });

  it("getGroup() returns undefined for an unknown group", () => {
    const groups = new Groups();
    expect(groups.getGroup("unknown")).toBeUndefined();
  });

  it("recordMessage()/getMessages() round-trip, oldest first", () => {
    const groups = new Groups();
    const info = group();
    groups.addGroup(info);
    groups.recordMessage(chatMessage({ groupId: info.groupId, senderId: "node-a", text: "uno", timestamp: 1 }));
    groups.recordMessage(chatMessage({ groupId: info.groupId, senderId: "node-b", text: "due", timestamp: 2 }));

    expect(groups.getMessages(info.groupId).map((m) => m.text)).toEqual(["uno", "due"]);
  });

  it("recordMessage() for an unknown group is a no-op, never crashes", () => {
    const groups = new Groups();
    groups.recordMessage(chatMessage({ groupId: "unknown", senderId: "node-a", text: "uno", timestamp: 1 }));
    expect(groups.getMessages("unknown")).toEqual([]);
  });

  it("getMessages() returns a copy — mutating the result never affects internal state", () => {
    const groups = new Groups();
    const info = group();
    groups.addGroup(info);
    groups.recordMessage(chatMessage({ groupId: info.groupId, senderId: "node-a", text: "original", timestamp: 1 }));

    const messages = groups.getMessages(info.groupId);
    messages.push(chatMessage({ groupId: info.groupId, senderId: "node-a", text: "injected", timestamp: 2 }));

    expect(groups.getMessages(info.groupId).map((m) => m.text)).toEqual(["original"]);
  });

  it("trims the oldest message once a group exceeds maxMessagesPerGroup", () => {
    const groups = new Groups({ maxMessagesPerGroup: 3 });
    const info = group();
    groups.addGroup(info);
    for (let i = 0; i < 5; i++) groups.recordMessage(chatMessage({ groupId: info.groupId, senderId: "node-a", text: `msg${i}`, timestamp: i }));

    expect(groups.getMessages(info.groupId).map((m) => m.text)).toEqual(["msg2", "msg3", "msg4"]);
  });

  it("ignores a second recordMessage() with the same messageId — a replayed GROUP_MESSAGE (fresh packet id, identical signed payload) is not appended again", () => {
    // Regression: found by review — SeenCache (routing.ts) dedups broadcast packets by their random
    // per-packet `id`, not by payload content, so a captured GROUP_MESSAGE payload re-wrapped in a
    // fresh packet id would otherwise bypass it and be appended (and re-flooded) again on every
    // replay, eventually evicting genuinely newer messages once maxMessagesPerGroup is hit.
    // messageId (the sender's deterministic Ed25519 signature, see GroupMessage's doc comment) is
    // what actually stops the *duplicate-storage* half of that.
    const groups = new Groups();
    const info = group();
    groups.addGroup(info);
    groups.recordMessage(chatMessage({ groupId: info.groupId, text: "originale", timestamp: 1, messageId: "same-signature" }));
    groups.recordMessage(chatMessage({ groupId: info.groupId, text: "originale", timestamp: 1, messageId: "same-signature" })); // replay

    expect(groups.getMessages(info.groupId)).toHaveLength(1);
  });

  it("listGroups() reflects only groups actually added", () => {
    const groups = new Groups();
    expect(groups.listGroups()).toEqual([]);
    groups.addGroup(group({ groupId: "g1" }));
    groups.addGroup(group({ groupId: "g2" }));
    expect(groups.listGroups().map((g) => g.groupId).sort()).toEqual(["g1", "g2"]);
  });

  it("evicts the oldest group (plain FIFO) once maxGroups is exceeded, with no trustRank given", () => {
    const groups = new Groups({ maxGroups: 2 });
    groups.addGroup(group({ groupId: "a" }));
    groups.addGroup(group({ groupId: "b" }));
    groups.addGroup(group({ groupId: "c" })); // pushes out "a"

    expect(groups.getGroup("a")).toBeUndefined();
    expect(groups.getGroup("b")).toBeDefined();
    expect(groups.getGroup("c")).toBeDefined();
  });

  it("evicts by the trust of whoever created/invited into the group, when given a trustRank", () => {
    const trustScores: Record<string, number> = { "trusted-inviter": 10, "sketchy-inviter": 1 };
    const groups = new Groups({ maxGroups: 2, trustRank: (createdBy) => trustScores[createdBy] ?? 0 });
    groups.addGroup(group({ groupId: "a", createdBy: "trusted-inviter" })); // must survive despite being oldest
    groups.addGroup(group({ groupId: "b", createdBy: "sketchy-inviter" }));
    groups.addGroup(group({ groupId: "c", createdBy: "sketchy-inviter" })); // evicts "b" (lowest score), not "a"

    expect(groups.getGroup("a")).toBeDefined();
    expect(groups.getGroup("b")).toBeUndefined();
    expect(groups.getGroup("c")).toBeDefined();
  });

  it("evicting a group also removes its message history — no orphaned messages for a group that's no longer known", () => {
    // Regression guard for the exact bug this design intentionally avoids (see Groups' own doc
    // comment: info and messages are a SINGLE BoundedFifoMap entry, not two independently-evicting
    // maps, precisely so this can't happen).
    const groups = new Groups({ maxGroups: 2 });
    groups.addGroup(group({ groupId: "a" }));
    groups.recordMessage(chatMessage({ groupId: "a", text: "hello", timestamp: 1 }));
    groups.addGroup(group({ groupId: "b" }));
    groups.addGroup(group({ groupId: "c" })); // evicts "a"

    expect(groups.getGroup("a")).toBeUndefined();
    expect(groups.getMessages("a")).toEqual([]); // not an orphaned history for a "forgotten" group
  });

  it("a still-known group never loses its message history just because other groups were evicted", () => {
    const groups = new Groups({ maxGroups: 2 });
    groups.addGroup(group({ groupId: "b" }));
    groups.recordMessage(chatMessage({ groupId: "b", text: "evict me", timestamp: 1 }));
    groups.addGroup(group({ groupId: "a" }));
    groups.recordMessage(chatMessage({ groupId: "a", text: "keep me", timestamp: 2 }));
    groups.addGroup(group({ groupId: "c" })); // evicts "b" (oldest, plain FIFO)

    expect(groups.getMessages("a").map((m) => m.text)).toEqual(["keep me"]);
  });

  it("updating an existing group's message history never evicts another group, even at capacity", () => {
    const groups = new Groups({ maxGroups: 2 });
    groups.addGroup(group({ groupId: "a" }));
    groups.addGroup(group({ groupId: "b" }));
    groups.recordMessage(chatMessage({ groupId: "a", text: "second in a", timestamp: 2 }));

    expect(groups.getGroup("a")).toBeDefined();
    expect(groups.getGroup("b")).toBeDefined();
  });
});
