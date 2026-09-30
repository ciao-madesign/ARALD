import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

/**
 * Ed25519 node identity (spec §14, §53). The private key never leaves this
 * class; the node id displayed everywhere else is the hex-encoded raw
 * public key, deliberately separate from any human-readable display name.
 */
export class Identity {
  readonly nodeId: string;
  private readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;

  private constructor(publicKey: KeyObject, privateKey: KeyObject, nodeId: string) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.nodeId = nodeId;
  }

  static generate(): Identity {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return Identity.fromKeyObjects(publicKey, privateKey);
  }

  static fromRawKeys(publicKeyRaw: Buffer, privateKeyRaw: Buffer): Identity {
    const x = publicKeyRaw.toString("base64url");
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    const privateKey = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", x, d: privateKeyRaw.toString("base64url") },
      format: "jwk",
    });
    return Identity.fromKeyObjects(publicKey, privateKey);
  }

  /**
   * Loads an identity from `<directory>/private.key` + `public.key`, generating and persisting a
   * new one if the directory is genuinely empty. Throws instead of silently regenerating if
   * exactly one of the two files is present — that shape isn't a fresh directory, it's leftover
   * state from a write interrupted between the two `writeFileSync()` calls below (process killed,
   * disk full, power loss on a device like an ARALD Box). Treating it as "absent" would silently
   * overwrite the still-recoverable `private.key` with a brand-new random identity, discarding the
   * old key forever and defeating the entire purpose of a caller (e.g. `cli.ts`'s `--identity-dir`)
   * persisting identity specifically to survive an unclean restart (found by review).
   */
  static loadOrCreate(directory: string): Identity {
    const privatePath = path.join(directory, "private.key");
    const publicPath = path.join(directory, "public.key");
    const hasPrivate = existsSync(privatePath);
    const hasPublic = existsSync(publicPath);
    if (hasPrivate && hasPublic) {
      return Identity.fromRawKeys(readFileSync(publicPath), readFileSync(privatePath));
    }
    if (hasPrivate || hasPublic) {
      throw new Error(
        `Identity.loadOrCreate: ${directory} has only one of private.key/public.key — refusing to overwrite what looks like an interrupted write instead of a fresh directory`,
      );
    }
    const identity = Identity.generate();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(privatePath, identity.exportRawPrivateKey(), { mode: 0o600 });
    writeFileSync(publicPath, identity.exportRawPublicKey());
    return identity;
  }

  private static fromKeyObjects(publicKey: KeyObject, privateKey: KeyObject): Identity {
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    const nodeId = Buffer.from(jwk.x, "base64url").toString("hex");
    return new Identity(publicKey, privateKey, nodeId);
  }

  sign(data: Buffer): Buffer {
    return cryptoSign(null, data, this.privateKey);
  }

  verify(data: Buffer, signature: Buffer): boolean {
    return cryptoVerify(null, data, this.publicKey, signature);
  }

  exportRawPublicKey(): Buffer {
    return Buffer.from(this.nodeId, "hex");
  }

  exportRawPrivateKey(): Buffer {
    const jwk = this.privateKey.export({ format: "jwk" }) as { d: string };
    return Buffer.from(jwk.d, "base64url");
  }

  /** Verifies a signature against an arbitrary node id's public key, without needing an Identity instance for it. */
  static verifyWithNodeId(nodeId: string, data: Buffer, signature: Buffer): boolean {
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(nodeId, "hex").toString("base64url") },
      format: "jwk",
    });
    return cryptoVerify(null, data, publicKey, signature);
  }
}
