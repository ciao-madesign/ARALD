import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EncryptionIdentity } from "../node/src/encryption.js";

/**
 * Identico a `whatsapp-relay/keypair.ts`/`email-relay/keypair.ts` — loads a
 * destination's persisted X25519 identity from `<file>` (JSON:
 * `{publicKeyHex, privateKeyHex}`), generating and persisting a new one if
 * absent. Losing this file means losing the ability to decrypt anything
 * already in flight toward this destination — back it up like any other
 * private key.
 */
export function loadOrCreateDestinationKeypair(file: string): EncryptionIdentity {
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { publicKeyHex: string; privateKeyHex: string };
    return EncryptionIdentity.fromRawKeys(Buffer.from(raw.publicKeyHex, "hex"), Buffer.from(raw.privateKeyHex, "hex"));
  }
  const identity = EncryptionIdentity.generate();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ publicKeyHex: identity.publicKeyHex, privateKeyHex: identity.exportRawPrivateKey().toString("hex") }, null, 2),
    { mode: 0o600 },
  );
  return identity;
}
