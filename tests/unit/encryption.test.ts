import { describe, expect, it } from "vitest";
import {
  EncryptionIdentity,
  MAX_DEVICE_CLASS_LENGTH,
  decryptFromPeer,
  encryptForPeer,
  identityAnnouncementPayload,
  isValidDeviceClass,
  signIdentityAnnouncement,
  verifyIdentityAnnouncement,
} from "../../node/src/encryption.js";
import { Identity } from "../../node/src/identity.js";

describe("EncryptionIdentity", () => {
  it("derives the same shared key on both sides (ECDH symmetry)", () => {
    const a = EncryptionIdentity.generate();
    const b = EncryptionIdentity.generate();

    const sharedA = a.sharedKeyWith(b.publicKeyHex);
    const sharedB = b.sharedKeyWith(a.publicKeyHex);

    expect(sharedA).toEqual(sharedB);
    expect(sharedA).toHaveLength(32); // suitable as an AES-256 key
  });

  it("derives different shared keys for different peer pairs", () => {
    const a = EncryptionIdentity.generate();
    const b = EncryptionIdentity.generate();
    const c = EncryptionIdentity.generate();

    expect(a.sharedKeyWith(b.publicKeyHex)).not.toEqual(a.sharedKeyWith(c.publicKeyHex));
  });
});

describe("encryptForPeer / decryptFromPeer", () => {
  it("round-trips plaintext through encryption and decryption", () => {
    const a = EncryptionIdentity.generate();
    const b = EncryptionIdentity.generate();
    const sharedKey = a.sharedKeyWith(b.publicKeyHex);

    const plaintext = Buffer.from("evacuare zona X alle 18:00");
    const encrypted = encryptForPeer(sharedKey, plaintext);
    const decrypted = decryptFromPeer(sharedKey, encrypted);

    expect(decrypted).toEqual(plaintext);
  });

  it("produces different ciphertext for the same plaintext each time (random nonce)", () => {
    const sharedKey = EncryptionIdentity.generate().sharedKeyWith(EncryptionIdentity.generate().publicKeyHex);
    const plaintext = Buffer.from("same message twice");

    const first = encryptForPeer(sharedKey, plaintext);
    const second = encryptForPeer(sharedKey, plaintext);

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it("fails to decrypt with the wrong key (authenticated encryption rejects it)", () => {
    const a = EncryptionIdentity.generate();
    const b = EncryptionIdentity.generate();
    const wrongParty = EncryptionIdentity.generate();

    const sharedKey = a.sharedKeyWith(b.publicKeyHex);
    const wrongKey = a.sharedKeyWith(wrongParty.publicKeyHex);

    const encrypted = encryptForPeer(sharedKey, Buffer.from("secret"));
    expect(() => decryptFromPeer(wrongKey, encrypted)).toThrow();
  });

  it("fails to decrypt tampered ciphertext (authentication tag catches it)", () => {
    const sharedKey = EncryptionIdentity.generate().sharedKeyWith(EncryptionIdentity.generate().publicKeyHex);
    const encrypted = encryptForPeer(sharedKey, Buffer.from("original message"));

    const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.replace(/^.{2}/, encrypted.ciphertext.slice(0, 2) === "00" ? "ff" : "00") };
    expect(() => decryptFromPeer(sharedKey, tampered)).toThrow();
  });
});

describe("IdentityAnnouncement signing/verification", () => {
  it("verifies a correctly self-signed announcement", () => {
    const identity = Identity.generate();
    const encryptionIdentity = EncryptionIdentity.generate();

    const announcement = signIdentityAnnouncement(identity, encryptionIdentity);

    expect(announcement.nodeId).toBe(identity.nodeId);
    expect(announcement.encryptionPublicKey).toBe(encryptionIdentity.publicKeyHex);
    expect(verifyIdentityAnnouncement(announcement)).toBe(true);
  });

  it("rejects an announcement impersonating a different node id", () => {
    const victim = Identity.generate();
    const attacker = Identity.generate();
    const attackerEncryption = EncryptionIdentity.generate();

    // Attacker signs with their own key but claims to be `victim`.
    const forged = signIdentityAnnouncement(attacker, attackerEncryption);
    const impersonating = { ...forged, nodeId: victim.nodeId };

    expect(verifyIdentityAnnouncement(impersonating)).toBe(false);
  });

  it("rejects an announcement whose encryption key was swapped after signing", () => {
    const identity = Identity.generate();
    const genuine = signIdentityAnnouncement(identity, EncryptionIdentity.generate());
    const swapped = { ...genuine, encryptionPublicKey: EncryptionIdentity.generate().publicKeyHex };

    expect(verifyIdentityAnnouncement(swapped)).toBe(false);
  });

  it("signs over both nodeId and encryptionPublicKey (payload helper is stable/deterministic)", () => {
    const payloadA = identityAnnouncementPayload("node-1", "key-1");
    const payloadB = identityAnnouncementPayload("node-1", "key-1");
    const payloadC = identityAnnouncementPayload("node-1", "key-2");

    expect(payloadA).toEqual(payloadB);
    expect(payloadA).not.toEqual(payloadC);
  });
});

describe("IdentityAnnouncement deviceClass ('Node Capabilities', display-only)", () => {
  it("omits deviceClass from the announcement and signs an identical payload to before this field existed, when not given", () => {
    const identity = Identity.generate();
    const encryptionIdentity = EncryptionIdentity.generate();

    const announcement = signIdentityAnnouncement(identity, encryptionIdentity);

    expect(announcement.deviceClass).toBeUndefined();
    expect(Object.hasOwn(announcement, "deviceClass")).toBe(false); // not even present as an explicit `undefined` key — backward-compat signing payload depends on this
    expect(identityAnnouncementPayload(announcement.nodeId, announcement.encryptionPublicKey, undefined)).toEqual(
      identityAnnouncementPayload(announcement.nodeId, announcement.encryptionPublicKey),
    );
  });

  it("includes and verifies a declared deviceClass", () => {
    const identity = Identity.generate();
    const encryptionIdentity = EncryptionIdentity.generate();

    const announcement = signIdentityAnnouncement(identity, encryptionIdentity, "Box");

    expect(announcement.deviceClass).toBe("Box");
    expect(verifyIdentityAnnouncement(announcement)).toBe(true);
  });

  it("rejects an announcement whose deviceClass was tampered with after signing", () => {
    const identity = Identity.generate();
    const genuine = signIdentityAnnouncement(identity, EncryptionIdentity.generate(), "Box");
    const tampered = { ...genuine, deviceClass: "Card" };

    expect(verifyIdentityAnnouncement(tampered)).toBe(false);
  });

  it("rejects an announcement with a deviceClass appended that the original signature never covered", () => {
    const identity = Identity.generate();
    const withoutClass = signIdentityAnnouncement(identity, EncryptionIdentity.generate());
    const smuggled = { ...withoutClass, deviceClass: "Box" };

    expect(verifyIdentityAnnouncement(smuggled)).toBe(false);
  });

  it("isValidDeviceClass accepts a non-empty string within the length bound, rejects everything else", () => {
    expect(isValidDeviceClass("Box")).toBe(true);
    expect(isValidDeviceClass("x".repeat(MAX_DEVICE_CLASS_LENGTH))).toBe(true);
    expect(isValidDeviceClass("")).toBe(false);
    expect(isValidDeviceClass("x".repeat(MAX_DEVICE_CLASS_LENGTH + 1))).toBe(false);
    expect(isValidDeviceClass(undefined)).toBe(false);
    expect(isValidDeviceClass(42)).toBe(false);
    expect(isValidDeviceClass(["Box"])).toBe(false);
  });
});
