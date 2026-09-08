import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/**
 * Password hashing for mirror-portal operator accounts (`users` table) — scrypt
 * via node:crypto, no external dependency (bcrypt/argon2 packages), same
 * "standard library first" convention already applied elsewhere in this
 * project (qrcode.ts, rss-feed.ts). Stored format is `salt:hash`, both hex —
 * self-describing, no separate salt column needed.
 */

const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

/**
 * Constant-time comparison against a stored `salt:hash` value. Returns
 * `false` (never throws) for a malformed stored value or a password that
 * derives to a different length — both would otherwise let a caller learn
 * something from a thrown-vs-not-thrown timing difference.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const separatorIndex = stored.indexOf(":");
  if (separatorIndex < 0) return false;
  const salt = stored.slice(0, separatorIndex);
  const hashHex = stored.slice(separatorIndex + 1);
  if (!salt || !hashHex) return false;

  const storedBuffer = Buffer.from(hashHex, "hex");
  if (storedBuffer.length !== KEY_LENGTH) return false;

  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return timingSafeEqual(derived, storedBuffer);
}
