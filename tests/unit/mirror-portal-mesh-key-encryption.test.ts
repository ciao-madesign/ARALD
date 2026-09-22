import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptMeshPrivateKey, decryptMeshPrivateKey } from "../../mirror-portal/lib/mesh-key-encryption.js";

const VALID_KEY_HEX = randomBytes(32).toString("hex");

describe("mirror-portal lib/mesh-key-encryption", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips a private key unchanged", () => {
    vi.stubEnv("MESH_IDENTITY_ENCRYPTION_KEY", VALID_KEY_HEX);
    const raw = randomBytes(32);

    const stored = encryptMeshPrivateKey(raw);
    const decrypted = decryptMeshPrivateKey(stored);

    expect(decrypted).toEqual(raw);
  });

  it("never stores the plaintext key inside the stored value", () => {
    vi.stubEnv("MESH_IDENTITY_ENCRYPTION_KEY", VALID_KEY_HEX);
    const raw = randomBytes(32);
    const stored = encryptMeshPrivateKey(raw);
    expect(stored).not.toContain(raw.toString("hex"));
  });

  it("produces a different ciphertext each time (random IV), even for the same input", () => {
    vi.stubEnv("MESH_IDENTITY_ENCRYPTION_KEY", VALID_KEY_HEX);
    const raw = randomBytes(32);
    expect(encryptMeshPrivateKey(raw)).not.toBe(encryptMeshPrivateKey(raw));
  });

  it("throws (never silently decrypts to garbage) when decrypted with the wrong key", () => {
    vi.stubEnv("MESH_IDENTITY_ENCRYPTION_KEY", VALID_KEY_HEX);
    const stored = encryptMeshPrivateKey(randomBytes(32));

    vi.stubEnv("MESH_IDENTITY_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    expect(() => decryptMeshPrivateKey(stored)).toThrow();
  });

  it("throws on a tampered stored value (GCM auth tag catches it)", () => {
    vi.stubEnv("MESH_IDENTITY_ENCRYPTION_KEY", VALID_KEY_HEX);
    const stored = encryptMeshPrivateKey(randomBytes(32));
    const [iv, authTag, ciphertext] = stored.split(":");
    const tamperedByte = (parseInt(ciphertext.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, "0");
    const tampered = `${iv}:${authTag}:${tamperedByte}${ciphertext.slice(2)}`;

    expect(() => decryptMeshPrivateKey(tampered)).toThrow();
  });

  it("throws on a malformed stored value (wrong number of segments)", () => {
    vi.stubEnv("MESH_IDENTITY_ENCRYPTION_KEY", VALID_KEY_HEX);
    expect(() => decryptMeshPrivateKey("not-the-right-format")).toThrow(/formato/);
    expect(() => decryptMeshPrivateKey("a:b")).toThrow(/formato/);
  });

  it("throws a clear error when MESH_IDENTITY_ENCRYPTION_KEY is not set at all", () => {
    vi.stubEnv("MESH_IDENTITY_ENCRYPTION_KEY", "");
    expect(() => encryptMeshPrivateKey(randomBytes(32))).toThrow(/MESH_IDENTITY_ENCRYPTION_KEY/);
  });

  it("throws a clear error when MESH_IDENTITY_ENCRYPTION_KEY isn't exactly 32 bytes of hex", () => {
    vi.stubEnv("MESH_IDENTITY_ENCRYPTION_KEY", "0011"); // too short
    expect(() => encryptMeshPrivateKey(randomBytes(32))).toThrow(/32 byte/);
  });
});
