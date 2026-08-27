import { randomBytes, randomUUID } from "node:crypto";
import { Identity } from "./identity.js";
import { EncryptedPayload, decryptFromPeer, encryptForPeer } from "./encryption.js";
import { BoundedFifoMap, pushBounded } from "./bounded-map.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "./message-history.js";

/**
 * A group this node knows about — either because it created it, or because
 * it accepted an invite (`considerGroupInvite()`, node.ts). `key` is the
 * group's shared AES-256-GCM symmetric key, generated once by the creator
 * (`createGroup()`) and distributed to each member individually via a
 * `PRIVATE_MESSAGE` invite (`extractGroupInvite()` below) — never
 * transmitted any other way, never persisted to disk (same choice already
 * made for `MessageHistory`/`PublicChannels`: in-memory only, lost on
 * restart, consistent rather than a new precedent).
 *
 * **v1 scope, explicitly chosen by the user over the alternative (full
 * lifecycle with leave/remove + key rotation)**: membership is fixed at
 * creation. There is no "leave"/"remove member" operation, so there is
 * nothing that would need to trigger a key rotation for forward secrecy —
 * that tradeoff simply doesn't arise in this v1. A future slice could add
 * membership changes, but it would need its own explicit design pass (key
 * rotation is a real, non-implicit decision — see docs/next-steps.md).
 *
 * **Accepted limitation, not solved here**: `members` is exactly what the
 * creator declared in *this node's own* invite — there is no signed, shared
 * group roster. A creator could in principle tell different members
 * different membership lists; nothing in this v1 detects that (would need a
 * group-wide membership consensus mechanism, out of scope). Same treatment
 * as other accepted trust-boundary limits in this codebase (e.g.
 * `packet.source` not being cryptographically bound).
 */
export interface GroupInfo {
  groupId: string;
  name: string;
  key: Buffer;
  members: string[];
  /**
   * The node id that actually invited this node into the group — always
   * the cryptographically-authenticated sender of the invite
   * (`PRIVATE_MESSAGE`'s `packet.source`, trustworthy because it
   * successfully decrypted with the ECDH-derived shared key only that
   * sender and this node share), **never** `GroupInvitePayload.createdBy`
   * itself (found by review: that field is a self-declared claim inside
   * the decrypted payload, unauthenticated on its own — a low-trust
   * contact could forge it to any node id, including a highly-trusted
   * one, to make its own throwaway group score as high-trust for
   * `Groups`' eviction and survive at a genuinely trusted group's expense —
   * the exact class of attack `docs/security.md` bug #13 already fixed for
   * `PeerDirectory`/`RemoteCatalog`). In this v1 (invite authority is
   * creator-only, `NomadNode.createGroup()`) the authenticated sender and
   * the payload's own `createdBy` claim are always the same value for a
   * legitimate invite, so this costs nothing in the honest case.
   */
  createdBy: string;
  createdAt: number;
}

/**
 * A decrypted group chat message, ready for local display — the group-chat
 * analogue of `ChannelMessage`/`StoredMessage`. `messageId` is the sender's
 * Ed25519 signature over the encrypted payload (`GroupMessagePacketPayload.signature`)
 * — not a separately-generated id — used purely for dedup (`Groups.recordMessage()`,
 * mirrors `PublicChannels.record()`'s dedup-by-`contentId`): Ed25519 (EdDSA)
 * signing is deterministic (same key + same signed bytes always produce the
 * same signature), so replaying an identical, already-seen `GROUP_MESSAGE`
 * payload inside a fresh packet (a new random `packet.id`, which alone
 * doesn't stop `SeenCache` from treating it as "new") still produces the
 * same `messageId` here and is recognized as the duplicate it is, instead
 * of being appended again and evicting genuinely newer history once
 * `maxMessagesPerGroup` is reached (found by review).
 */
export interface GroupMessage {
  groupId: string;
  senderId: string;
  text: string;
  timestamp: number;
  messageId: string;
}

/**
 * The `PRIVATE_MESSAGE` payload shape a group invite has — discriminated by
 * `type: "group-invite"` so `handlePrivateMessage()` (node.ts) can tell it
 * apart from an ordinary chat message's `{ text }` shape
 * (`extractChatText()`) without a new packet type: an invite is
 * intrinsically 1:1, so it reuses `PRIVATE_MESSAGE`'s existing ECDH-derived
 * per-peer encryption exactly as-is (the sender authenticity guarantee that
 * matters for an invite already comes from that shared secret being known
 * to only two parties — no extra signature needed here, unlike
 * `GroupMessage` below, which is broadcast to a whole group that all share
 * one key).
 */
export interface GroupInvitePayload {
  type: "group-invite";
  groupId: string;
  name: string;
  /** Hex-encoded 32-byte AES-256-GCM group key. */
  groupKey: string;
  members: string[];
  createdBy: string;
  createdAt: number;
}

const GROUP_ID_PATTERN = /^[0-9a-f]{32}$/;

function isValidGroupId(groupId: unknown): groupId is string {
  return typeof groupId === "string" && GROUP_ID_PATTERN.test(groupId);
}

/**
 * Validates and extracts a group invite from an already-decrypted
 * `PRIVATE_MESSAGE` payload — same defensive posture as every other
 * network-sourced payload in this codebase (`packet.payload` is never
 * trusted just because it decrypted/parsed successfully). Returns
 * `undefined` for anything that isn't shaped exactly like a valid invite —
 * rejected, not crashed.
 */
export function extractGroupInvite(payload: unknown): GroupInvitePayload | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (p.type !== "group-invite") return undefined;
  if (!isValidGroupId(p.groupId)) return undefined;
  if (typeof p.name !== "string" || p.name.length === 0 || p.name.length > 128) return undefined;
  if (typeof p.groupKey !== "string" || !/^[0-9a-f]{64}$/.test(p.groupKey)) return undefined;
  if (!Array.isArray(p.members) || !p.members.every((m) => typeof m === "string")) return undefined;
  if (typeof p.createdBy !== "string" || typeof p.createdAt !== "number" || !Number.isFinite(p.createdAt)) return undefined;
  return {
    type: "group-invite",
    groupId: p.groupId,
    name: p.name,
    groupKey: p.groupKey,
    members: p.members as string[],
    createdBy: p.createdBy,
    createdAt: p.createdAt,
  };
}

/** The plaintext bytes actually encrypted with the group key — same `{ text, timestamp }` shape as `ChannelMessagePayload`, for the same reason (the timestamp needs to be inside authenticated bytes, not left to an untrusted envelope field). */
interface GroupMessagePlaintext {
  text: string;
  timestamp: number;
}

/** A `GROUP_MESSAGE` packet's payload — the group-key-encrypted plaintext above, plus a sender-authenticating Ed25519 signature (see `groupMessageSigningPayload()`'s doc comment for why the GCM auth tag alone isn't enough here). */
export interface GroupMessagePacketPayload extends EncryptedPayload {
  groupId: string;
  senderId: string;
  signature: string;
}

/**
 * Canonical bytes a `GROUP_MESSAGE`'s sender signs (Ed25519, via
 * `Identity.sign()`/`Identity.verifyWithNodeId()` — the same generic
 * signing primitive `content.ts`/`service.ts` already use, no new
 * cryptography). **Why this signature is necessary in addition to the AES-
 * GCM auth tag**: the auth tag proves the ciphertext wasn't tampered with
 * relative to the group key, but *every* member of the group knows that
 * same key — so without an independent per-sender signature, any member
 * could forge a message that looks like it came from another member. The
 * Ed25519 signature is keyed to `senderId`'s own identity key (verifiable
 * by anyone, forgeable only by `senderId` itself), closing that
 * impersonation gap the same way every other signed claim in this codebase
 * does (spec §55-style pattern, applied here to group messages instead of
 * content).
 */
export function groupMessageSigningPayload(fields: { groupId: string; senderId: string; nonce: string; ciphertext: string; authTag: string }): Buffer {
  return Buffer.from(
    JSON.stringify({
      groupId: fields.groupId,
      senderId: fields.senderId,
      nonce: fields.nonce,
      ciphertext: fields.ciphertext,
      authTag: fields.authTag,
    }),
  );
}

/** Encrypts+signs `{ text, timestamp }` for `groupId` with `groupKey`, on behalf of `identity`. */
export function signGroupMessage(
  identity: Identity,
  groupId: string,
  groupKey: Buffer,
  plaintext: GroupMessagePlaintext,
): GroupMessagePacketPayload {
  const encrypted = encryptForPeer(groupKey, Buffer.from(JSON.stringify(plaintext)));
  const signature = identity.sign(groupMessageSigningPayload({ groupId, senderId: identity.nodeId, ...encrypted })).toString("hex");
  return { ...encrypted, groupId, senderId: identity.nodeId, signature };
}

/**
 * Verifies a `GROUP_MESSAGE` packet payload's shape and sender signature
 * (never the group-key decryption itself — a non-member can and should be
 * able to verify *that the claimed sender really sent this*, even though
 * they can't read it; decryption is attempted separately by `Groups`'
 * caller, only once the group is known locally). Returns `undefined` for
 * anything malformed or with an invalid signature — rejected, not crashed,
 * same defensive posture as every other packet handler in this codebase.
 */
export function verifyGroupMessage(payload: unknown): GroupMessagePacketPayload | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (!isValidGroupId(p.groupId)) return undefined;
  if (typeof p.senderId !== "string" || p.senderId.length === 0) return undefined;
  if (typeof p.nonce !== "string" || typeof p.ciphertext !== "string" || typeof p.authTag !== "string") return undefined;
  if (typeof p.signature !== "string") return undefined;
  const fields = { groupId: p.groupId, senderId: p.senderId, nonce: p.nonce, ciphertext: p.ciphertext, authTag: p.authTag };
  try {
    if (!Identity.verifyWithNodeId(p.senderId, groupMessageSigningPayload(fields), Buffer.from(p.signature, "hex"))) return undefined;
  } catch {
    // Malformed signature hex, or a senderId that doesn't parse as an Ed25519 public key — never trust it.
    return undefined;
  }
  return { ...fields, signature: p.signature };
}

/** Decrypts an already-signature-verified `GroupMessagePacketPayload` with `groupKey`, and validates the resulting plaintext shape. Throws if decryption/auth fails (tampered ciphertext, wrong key) — callers should treat that as an anomaly worth logging, not a routine "not for us" case (that's already filtered out by the caller only decrypting groups it knows). Returns `undefined` (not throw) only for a plaintext that decrypts fine but isn't shaped like a chat message. */
export function decryptGroupMessage(payload: GroupMessagePacketPayload, groupKey: Buffer): GroupMessagePlaintext | undefined {
  const decrypted: unknown = JSON.parse(decryptFromPeer(groupKey, payload).toString("utf8"));
  if (!decrypted || typeof decrypted !== "object") return undefined;
  const { text, timestamp } = decrypted as { text?: unknown; timestamp?: unknown };
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_MESSAGE_TEXT_LENGTH) return undefined;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  return { text, timestamp };
}

export function generateGroupId(): string {
  return randomUUID().replace(/-/g, "");
}

export function generateGroupKey(): Buffer {
  return randomBytes(32);
}

export interface GroupsOptions {
  /** Max distinct groups tracked at once (spec §57 resource limits). */
  maxGroups?: number;
  /** Max messages kept per group — the oldest is dropped once a group exceeds this. */
  maxMessagesPerGroup?: number;
  /** Same eviction convention as every other network-fed structure in this codebase (bounded-map.ts) — ranks a group for eviction by the trust of whoever invited us to it (`GroupInfo.createdBy`). Omit for plain FIFO (oldest group first). */
  trustRank?: (createdBy: string) => number;
}

const DEFAULT_MAX_GROUPS = 128;
const DEFAULT_MAX_MESSAGES_PER_GROUP = 500;

interface GroupEntry {
  info: GroupInfo;
  messages: GroupMessage[];
}

/**
 * Local state for encrypted group chats this node is a member of — groups
 * it created (`NomadNode.createGroup()`) or was invited into
 * (`considerGroupInvite()`, node.ts). Unlike `PublicChannels`, this is never
 * built from a network-verifiable public structure: membership and the
 * group key both come from a private, per-recipient invite, so there is no
 * broader "catalog" of all groups in the mesh — only what this node itself
 * was told about.
 *
 * Bounded on two axes (spec §57), same shape as `MessageHistory`/
 * `PublicChannels`: `maxGroups` distinct groups tracked at once, and
 * `maxMessagesPerGroup` messages kept within each one. The bound matters
 * even though invites only ever arrive 1:1 (never broadcast): a noisy or
 * compromised contact could still send unlimited group invites, so this
 * can't be left unbounded any more than any other network-fed structure in
 * this codebase.
 *
 * **A single `BoundedFifoMap` holds both a group's info and its message
 * history together** (`GroupEntry`), deliberately not two separate maps —
 * two independently-evicting maps could drift out of sync (a group evicted
 * from one but not the other), leaving an orphaned message history for a
 * "forgotten" group, or a still-known group that's silently lost its
 * history. One map, one eviction decision, no drift possible.
 */
export class Groups {
  private readonly groups: BoundedFifoMap<string, GroupEntry>;
  private readonly maxMessagesPerGroup: number;

  constructor(options: GroupsOptions = {}) {
    this.maxMessagesPerGroup = options.maxMessagesPerGroup ?? DEFAULT_MAX_MESSAGES_PER_GROUP;
    const trustRank = options.trustRank;
    this.groups = new BoundedFifoMap({
      maxSize: options.maxGroups ?? DEFAULT_MAX_GROUPS,
      evictionScore: trustRank ? (_groupId: string, entry: GroupEntry) => trustRank(entry.info.createdBy) : undefined,
    });
  }

  /** No-op (not an error) if `info.groupId` is already known — an invite for an already-known group (e.g. a retransmit) never overwrites the existing entry (or its message history). */
  addGroup(info: GroupInfo): void {
    if (this.groups.has(info.groupId)) return;
    this.groups.set(info.groupId, { info, messages: [] });
  }

  getGroup(groupId: string): GroupInfo | undefined {
    return this.groups.get(groupId)?.info;
  }

  listGroups(): GroupInfo[] {
    return [...this.groups.values()].map((entry) => entry.info);
  }

  /**
   * Records `message` into its group's history. A no-op if the group itself
   * isn't known (defensive — callers should already have checked
   * `getGroup()` before decrypting), if a message with the same
   * `messageId` is already present (found by review — see `GroupMessage.messageId`'s
   * doc comment: without this, a `GROUP_MESSAGE` packet replayed inside a
   * fresh packet id bypasses `SeenCache` and would otherwise be appended
   * again on every replay, eventually evicting genuinely newer messages
   * once `maxMessagesPerGroup` is reached), or if `maxMessagesPerGroup` is
   * configured at `<= 0` and nothing survives trimming (never leaves a
   * present-but-untouched history any different from "never recorded").
   */
  recordMessage(message: GroupMessage): void {
    const entry = this.groups.get(message.groupId);
    if (!entry) return;
    if (entry.messages.some((m) => m.messageId === message.messageId)) return;
    pushBounded(entry.messages, message, this.maxMessagesPerGroup);
  }

  /** The messages in `groupId`, oldest first — a copy, never the live internal array. Empty if no messages have ever been recorded for `groupId` (including if the group itself is unknown). */
  getMessages(groupId: string): GroupMessage[] {
    return [...(this.groups.get(groupId)?.messages ?? [])];
  }
}
