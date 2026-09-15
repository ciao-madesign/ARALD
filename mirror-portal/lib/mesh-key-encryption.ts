import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption at rest for an operator's mesh Ed25519 private key
 * (`users.mesh_private_key_encrypted`, "Pezzo 1" del canale di comando,
 * `docs/emergency-portal.md`) — AES-256-GCM with a dedicated key
 * (`MESH_IDENTITY_ENCRYPTION_KEY`, `.env.example`'s own doc comment for why
 * this is deliberately NOT `AUTH_SECRET`: key separation, two different
 * blast radii). Stored format `iv:authTag:ciphertext`, all hex — self-
 * describing, same convention as `lib/password.ts`'s `salt:hash` for the
 * same reason (no separate columns needed for the pieces of one value).
 */

const KEY_LENGTH_BYTES = 32; // AES-256
const IV_LENGTH_BYTES = 12; // standard GCM nonce size

function loadKey(): Buffer {
  const hex = process.env.MESH_IDENTITY_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error("MESH_IDENTITY_ENCRYPTION_KEY non impostata su questo progetto Vercel (Project Settings -> Environment Variables).");
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`MESH_IDENTITY_ENCRYPTION_KEY deve essere esattamente ${KEY_LENGTH_BYTES} byte in esadecimale (${KEY_LENGTH_BYTES * 2} caratteri) — genera con 'openssl rand -hex 32'.`);
  }
  return key;
}

export function encryptMeshPrivateKey(raw: Buffer): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * Throws on any malformed/wrong-key/tampered input — an operator's private
 * key must never be silently "recovered" as garbage bytes that would then
 * produce a *different*, wrong Ed25519 identity than the one the mesh
 * already knows about for that operator (a corrupted-looking failure is
 * far safer here than a silently-different-but-valid-looking key).
 */
export function decryptMeshPrivateKey(stored: string): Buffer {
  const key = loadKey();
  const parts = stored.split(":");
  if (parts.length !== 3) throw new Error("formato mesh_private_key_encrypted non valido");
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  if (iv.length !== IV_LENGTH_BYTES) throw new Error("formato mesh_private_key_encrypted non valido (iv)");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]); // throws if authTag doesn't match
}
