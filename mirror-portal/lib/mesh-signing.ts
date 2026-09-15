import { createHash } from "node:crypto";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";

/**
 * Pure mesh-signing primitives for the canale di comando (Pezzo 1/2,
 * `docs/emergency-portal.md`) — deliberately DUPLICATED from
 * `node/src/identity.ts`/`content.ts`/`drops.ts`, never imported from
 * there. `mirror-portal/` is a separate Vercel project (its own
 * `package.json`, root directory) outside the root npm workspace
 * (`package.json`'s own `workspaces` list only has `node`) — a relative
 * import reaching into `../node/src/*` would work in this monorepo
 * checkout but has no guarantee of surviving Vercel's own build, which
 * only packages this directory. Same discipline `arald-backend/
 * node-client.ts` already applies one layer up (treating a NomadNode's
 * HTTP surface as an external contract, never importing its TS types) —
 * here applied to the small amount of pure crypto/constants this piece
 * needs, kept in sync with the originals by hand. Any future drift is a
 * doc-comment problem, not a type-system one: if `node/src/identity.ts`'s
 * JWK shape or `contentSigningPayload()`'s field order ever changes, this
 * file must change with it or every signature this module produces stops
 * verifying against a real Box — the same risk every other piece of this
 * project accepts when it treats a peer's HTTP/wire contract as external.
 */

// ---- mirrors node/src/identity.ts ----

export class MeshIdentity {
  readonly nodeId: string;
  private readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;

  private constructor(publicKey: KeyObject, privateKey: KeyObject, nodeId: string) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.nodeId = nodeId;
  }

  static generate(): MeshIdentity {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return MeshIdentity.fromKeyObjects(publicKey, privateKey);
  }

  static fromRawKeys(publicKeyRaw: Buffer, privateKeyRaw: Buffer): MeshIdentity {
    const x = publicKeyRaw.toString("base64url");
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x, d: privateKeyRaw.toString("base64url") }, format: "jwk" });
    return MeshIdentity.fromKeyObjects(publicKey, privateKey);
  }

  private static fromKeyObjects(publicKey: KeyObject, privateKey: KeyObject): MeshIdentity {
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    const nodeId = Buffer.from(jwk.x, "base64url").toString("hex");
    return new MeshIdentity(publicKey, privateKey, nodeId);
  }

  sign(data: Buffer): Buffer {
    return cryptoSign(null, data, this.privateKey);
  }

  exportRawPublicKey(): Buffer {
    return Buffer.from(this.nodeId, "hex");
  }

  exportRawPrivateKey(): Buffer {
    const jwk = this.privateKey.export({ format: "jwk" }) as { d: string };
    return Buffer.from(jwk.d, "base64url");
  }
}

// ---- mirrors node/src/content.ts ----

export interface SignableContentFields {
  contentId: string;
  name: string;
  mimeType: string;
  size: number;
  publisherId?: string;
  expiresAt?: number;
}

export function computeContentId(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function contentSigningPayload(fields: SignableContentFields): Buffer {
  return Buffer.from(
    JSON.stringify({
      contentId: fields.contentId,
      name: fields.name,
      mimeType: fields.mimeType,
      size: fields.size,
      publisherId: fields.publisherId,
      expiresAt: fields.expiresAt,
    }),
  );
}

// ---- mirrors node/src/drops.ts + node.ts's dropKindPriority() ----

export const DROP_CONTENT_NAME = "drop";
export const MAX_DROP_LABEL_LENGTH = 100;
export const MAX_MESSAGE_TEXT_LENGTH = 4000; // node/src/message-history.ts — drops share this bound
export type DropKind = "info" | "hazard" | "emergency";

/** Priority enum values (`node/src/packet.ts`) — only the three this piece ever needs to pick between. */
export const Priority = { EMERGENCY: 0, MESSAGING: 2, CONTENT: 4 } as const;

export function dropKindPriority(kind: DropKind): number {
  switch (kind) {
    case "emergency":
      return Priority.EMERGENCY;
    case "hazard":
      return Priority.MESSAGING;
    case "info":
      return Priority.CONTENT;
  }
}

export interface DropPayload {
  text: string;
  lat: number;
  lon: number;
  label?: string;
  kind: DropKind;
  timestamp: number;
}

export interface SignedDrop {
  metadata: {
    contentId: string;
    name: string;
    mimeType: string;
    size: number;
    createdAt: number;
    publisherId: string;
    signature: string;
    expiresAt?: number;
  };
  data: Buffer;
  priority: number;
}

// 24h/72h — mirror node.ts's own DEFAULT_DROP_TTL_MS/MAX_DROP_TTL_MS. Exported (found by review,
// docs/security.md voce #81): node.ts now exports its own copies specifically so
// tests/unit/mirror-portal-mesh-signing.test.ts can assert the two match directly, instead of the
// only synchronization being this comment — a future change to either constant with no matching
// change to the other now fails a real test instead of silently drifting.
export const DEFAULT_DROP_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_DROP_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Builds and signs a Drop exactly as `NomadNode.publishDrop()` would,
 * minus the parts that are specific to a live mesh node (the elevated-
 * drop rate limit, `this.drops.record()`'s own bookkeeping) — those stay
 * the Box's job, via `ingestSignedContent()`/`considerDrop()`, once this
 * signed object reaches it.
 */
export function signDrop(identity: MeshIdentity, drop: { text: string; lat: number; lon: number; label?: string; kind: DropKind; expiresInMs?: number }): SignedDrop {
  const ttlMs = Math.min(drop.expiresInMs ?? DEFAULT_DROP_TTL_MS, MAX_DROP_TTL_MS);
  const payload: DropPayload = { text: drop.text, lat: drop.lat, lon: drop.lon, label: drop.label, kind: drop.kind, timestamp: Date.now() };
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  const contentId = computeContentId(data);
  const size = data.length;
  const publisherId = identity.nodeId;
  const expiresAt = Date.now() + ttlMs;
  const signature = identity.sign(contentSigningPayload({ contentId, name: DROP_CONTENT_NAME, mimeType: "application/json", size, publisherId, expiresAt })).toString("hex");
  return {
    metadata: { contentId, name: DROP_CONTENT_NAME, mimeType: "application/json", size, createdAt: Date.now(), publisherId, signature, expiresAt },
    data,
    priority: dropKindPriority(drop.kind),
  };
}

// ---- mirrors node/src/node-appends.ts + node.ts's Node Append TTL bounds ----
// "Pezzo 2" del canale di comando Box↔specchio (docs/emergency-portal.md, docs/security.md voce
// #82). Deliberately its own small signing scheme, not contentSigningPayload()/SignedDrop above —
// see node/src/node-appends.ts's own doc comment for why a Node Append never goes through
// ContentMetadata (it would become content://-discoverable by any mesh peer, contradicting its
// whole "deposited at one node, never re-propagated" point).

/** Mirrors `MAX_NODE_APPEND_LABEL_LENGTH` (`node/src/node-appends.ts`) — kept as its own constant rather than imported, same reasoning that file's own comment gives for not importing `MAX_DROP_LABEL_LENGTH` either. */
export const MAX_NODE_APPEND_LABEL_LENGTH = 100;

export interface SignableNodeAppendFields {
  text: string;
  label?: string;
  kind: DropKind;
  timestamp: number;
  expiresAt: number;
  /** The one Box this signature is bound to — part of what's signed, not just the HTTP envelope (see node-appends.ts's own doc comment for why). */
  targetNodeId: string;
  publisherId: string;
}

/** Field order must match `node/src/node-appends.ts`'s `nodeAppendSigningPayload()` exactly — verified byte-for-byte in `tests/unit/mirror-portal-mesh-signing.test.ts`. */
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

export interface SignedNodeAppend extends SignableNodeAppendFields {
  signature: string;
}

// 24h/72h — mirror node.ts's own DEFAULT_NODE_APPEND_TTL_MS/MAX_NODE_APPEND_TTL_MS. Exported for the
// same cross-check reason DEFAULT_DROP_TTL_MS/MAX_DROP_TTL_MS are (see that pair's own comment) —
// tests/unit/mirror-portal-mesh-signing.test.ts asserts both pairs match node.ts's real constants.
export const DEFAULT_NODE_APPEND_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_NODE_APPEND_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Builds and signs a Node Append exactly as `NomadNode.appendToNode()`
 * would for a real mesh send, but for the remote-ingest path
 * (`NomadNode.ingestSignedNodeAppend()`, "Pezzo 2") instead of the mesh's
 * own `PRIVATE_MESSAGE` channel — no ECDH/encryption identity needed here,
 * only the same Ed25519 `MeshIdentity` already custodied for `signDrop()`.
 */
export function signNodeAppend(
  identity: MeshIdentity,
  append: { text: string; label?: string; kind: DropKind; expiresInMs?: number; targetNodeId: string },
): SignedNodeAppend {
  const ttlMs = Math.min(append.expiresInMs ?? DEFAULT_NODE_APPEND_TTL_MS, MAX_NODE_APPEND_TTL_MS);
  const timestamp = Date.now();
  const expiresAt = timestamp + ttlMs;
  const publisherId = identity.nodeId;
  const fields: SignableNodeAppendFields = {
    text: append.text,
    label: append.label,
    kind: append.kind,
    timestamp,
    expiresAt,
    targetNodeId: append.targetNodeId,
    publisherId,
  };
  const signature = identity.sign(nodeAppendSigningPayload(fields)).toString("hex");
  return { ...fields, signature };
}
