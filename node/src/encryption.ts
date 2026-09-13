import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { Identity } from "./identity.js";

/**
 * A node's X25519 key pair, used only for end-to-end encryption (spec §52)
 * — deliberately separate from the Ed25519 identity key (`Identity`, used
 * only for signing), which is standard key-separation practice: a key
 * meant for signatures and a key meant for key-exchange shouldn't be the
 * same key, even though both algorithms happen to use 32-byte curve keys.
 */
export class EncryptionIdentity {
  readonly publicKeyHex: string;
  private readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;

  private constructor(publicKey: KeyObject, privateKey: KeyObject, publicKeyHex: string) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.publicKeyHex = publicKeyHex;
  }

  static generate(): EncryptionIdentity {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    return EncryptionIdentity.fromKeyObjects(publicKey, privateKey);
  }

  private static fromKeyObjects(publicKey: KeyObject, privateKey: KeyObject): EncryptionIdentity {
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    const publicKeyHex = Buffer.from(jwk.x, "base64url").toString("hex");
    return new EncryptionIdentity(publicKey, privateKey, publicKeyHex);
  }

  static publicKeyFromHex(hex: string): KeyObject {
    return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(hex, "hex").toString("base64url") }, format: "jwk" });
  }

  /**
   * Derives a symmetric key shared with a peer, from their X25519 public
   * key alone — ECDH is symmetric (DH(myPriv, theirPub) === DH(theirPriv,
   * myPub)), so both sides compute the identical key independently,
   * without ever transmitting it. Hashed down to exactly 32 bytes for
   * direct use as an AES-256-GCM key.
   */
  sharedKeyWith(peerPublicKeyHex: string): Buffer {
    const peerPublicKey = EncryptionIdentity.publicKeyFromHex(peerPublicKeyHex);
    const sharedSecret = diffieHellman({ privateKey: this.privateKey, publicKey: peerPublicKey });
    return createHash("sha256").update(sharedSecret).digest();
  }
}

export interface EncryptedPayload {
  nonce: string;
  ciphertext: string;
  authTag: string;
}

export function encryptForPeer(sharedKey: Buffer, plaintext: Buffer): EncryptedPayload {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sharedKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce: nonce.toString("hex"), ciphertext: ciphertext.toString("hex"), authTag: cipher.getAuthTag().toString("hex") };
}

export function decryptFromPeer(sharedKey: Buffer, payload: EncryptedPayload): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", sharedKey, Buffer.from(payload.nonce, "hex"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "hex")), decipher.final()]);
}

/**
 * A node's self-attestation binding its identity (Ed25519 node id) to its
 * encryption key (X25519), signed by the node id's own private key. This
 * is what lets `PeerDirectory` (peer-directory.ts) trust a claim like
 * "node X's encryption key is Y" without a relay being able to forge it
 * for someone else — exactly the same pattern as `ContentMetadata`'s
 * publisher signature in content.ts, applied to identity instead of
 * content.
 */
export interface IdentityAnnouncement {
  nodeId: string;
  encryptionPublicKey: string;
  /**
   * Optional, free-text device class the node declares about itself (e.g.
   * "Box", "Card", "Relay") — "Node Capabilities", scoped down explicitly
   * with the user (10 settembre 2026, docs/next-steps.md) to exactly this:
   * a self-declared label, propagated mesh-wide the same way the
   * encryption key above already is, **display-only** — never consulted
   * by routing, trust, or any other decision in this codebase. Piggybacked
   * on this struct rather than a new message type specifically so it
   * inherits the same signature (a node can declare its own class, never
   * fabricate someone else's) and the same mesh-wide propagation, for
   * free. `undefined` when the node that produced this announcement never
   * declared one (the common case, and the only case before this field
   * existed — omitted, not an empty string, so `JSON.stringify` drops it
   * entirely from the signed payload and older/newer nodes that never set
   * it sign and verify byte-for-byte identically to before this field was
   * added).
   */
  deviceClass?: string;
  signature: string;
}

/** Bounds `IdentityAnnouncement.deviceClass` (spec §57-style resource limit for a self-declared free-text field) — same order of magnitude as `MAX_RELAY_OPERATOR_LENGTH`/`MAX_NODE_APPEND_LABEL_LENGTH`, a one-line label, not chat-body-length text. */
export const MAX_DEVICE_CLASS_LENGTH = 100;

/** Whether `value` is a well-formed `deviceClass` (non-empty string, within `MAX_DEVICE_CLASS_LENGTH`). Used both to validate a *local* declaration (node.ts's constructor, fail fast) and a *received* one (node.ts's `acceptIdentityAnnouncement()`, fail closed on the whole announcement — see that method's own doc comment for why a malformed-but-validly-signed field can't just be stripped after the fact). */
export function isValidDeviceClass(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_DEVICE_CLASS_LENGTH;
}

export function identityAnnouncementPayload(nodeId: string, encryptionPublicKey: string, deviceClass?: string): Buffer {
  return Buffer.from(JSON.stringify({ nodeId, encryptionPublicKey, deviceClass }));
}

export function signIdentityAnnouncement(
  identity: Identity,
  encryptionIdentity: EncryptionIdentity,
  deviceClass?: string,
): IdentityAnnouncement {
  const nodeId = identity.nodeId;
  const encryptionPublicKey = encryptionIdentity.publicKeyHex;
  const signature = identity.sign(identityAnnouncementPayload(nodeId, encryptionPublicKey, deviceClass)).toString("hex");
  return deviceClass !== undefined ? { nodeId, encryptionPublicKey, deviceClass, signature } : { nodeId, encryptionPublicKey, signature };
}

export function verifyIdentityAnnouncement(announcement: IdentityAnnouncement): boolean {
  try {
    return Identity.verifyWithNodeId(
      announcement.nodeId,
      identityAnnouncementPayload(announcement.nodeId, announcement.encryptionPublicKey, announcement.deviceClass),
      Buffer.from(announcement.signature, "hex"),
    );
  } catch {
    return false;
  }
}
