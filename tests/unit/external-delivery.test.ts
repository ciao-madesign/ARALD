import { describe, expect, it, vi } from "vitest";
import {
  computeExternalDeliveryAuthProof,
  verifyExternalDeliveryAuthProof,
  sealExternalDelivery,
  unsealExternalDelivery,
  extractExternalDeliveryPayload,
  extractExternalDeliveryDirectoryPayload,
  ExternalDeliveryDirectory,
  ExternalDeliveryQueue,
  MAX_EXTERNAL_DELIVERY_DESTINATION_ID_LENGTH,
  MAX_EXTERNAL_DELIVERY_LABEL_LENGTH,
  type ExternalDeliveryPayload,
  type ExternalDeliveryDirectoryPayload,
  type QueuedExternalDelivery,
} from "../../node/src/external-delivery.js";
import { EncryptionIdentity } from "../../node/src/encryption.js";
import { Priority } from "../../node/src/packet.js";

// ---------------------------------------------------------------------------
// Cifratura E2E
// ---------------------------------------------------------------------------

describe("sealExternalDelivery/unsealExternalDelivery", () => {
  it("round-trips plaintext through the correct destination identity", () => {
    const destination = EncryptionIdentity.generate();
    const plaintext = Buffer.from("report dal campo", "utf8");
    const sealed = sealExternalDelivery(destination.publicKeyHex, plaintext);
    expect(unsealExternalDelivery(destination, sealed)).toEqual(plaintext);
  });

  it("never lets the wrong identity decrypt — a BOX holding neither key must never succeed", () => {
    const destination = EncryptionIdentity.generate();
    const impostor = EncryptionIdentity.generate();
    const sealed = sealExternalDelivery(destination.publicKeyHex, Buffer.from("segreto"));
    expect(() => unsealExternalDelivery(impostor, sealed)).toThrow();
  });

  it("uses a fresh ephemeral key on every call — two submissions to the same destination are unlinkable by key", () => {
    const destination = EncryptionIdentity.generate();
    const a = sealExternalDelivery(destination.publicKeyHex, Buffer.from("uno"));
    const b = sealExternalDelivery(destination.publicKeyHex, Buffer.from("due"));
    expect(a.senderEphemeralPublicKey).not.toBe(b.senderEphemeralPublicKey);
  });
});

// ---------------------------------------------------------------------------
// Autorizzazione per-destinazione
// ---------------------------------------------------------------------------

describe("computeExternalDeliveryAuthProof/verifyExternalDeliveryAuthProof", () => {
  // Two distinct sealed envelopes (fresh ephemeral key each time, per sealExternalDelivery()) — used
  // throughout to prove authProof is bound to the *specific submission*, not just (password, destinationId).
  const destination = EncryptionIdentity.generate();
  const sealedA = sealExternalDelivery(destination.publicKeyHex, Buffer.from("report A"));
  const sealedB = sealExternalDelivery(destination.publicKeyHex, Buffer.from("report B"));

  it("is deterministic — same inputs always produce the same proof", () => {
    expect(computeExternalDeliveryAuthProof("s3gr3t0", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag)).toBe(
      computeExternalDeliveryAuthProof("s3gr3t0", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag),
    );
  });

  it("differs for a different password, destinationId, nonce, ciphertext, or authTag", () => {
    const base = computeExternalDeliveryAuthProof("s3gr3t0", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag);
    expect(computeExternalDeliveryAuthProof("altro", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag)).not.toBe(base);
    expect(computeExternalDeliveryAuthProof("s3gr3t0", "hq-2", sealedA.nonce, sealedA.ciphertext, sealedA.authTag)).not.toBe(base);
    expect(computeExternalDeliveryAuthProof("s3gr3t0", "hq-1", sealedB.nonce, sealedB.ciphertext, sealedB.authTag)).not.toBe(base);
    expect(computeExternalDeliveryAuthProof("s3gr3t0", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedB.authTag)).not.toBe(base);
  });

  it("accepts any request (including no proof at all) when no password is configured", () => {
    expect(verifyExternalDeliveryAuthProof(undefined, undefined, "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag)).toBe(true);
    expect(verifyExternalDeliveryAuthProof("garbage", undefined, "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag)).toBe(true);
  });

  it("rejects a missing proof when a password is configured", () => {
    expect(verifyExternalDeliveryAuthProof(undefined, "s3gr3t0", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag)).toBe(false);
  });

  it("accepts the correct proof and rejects an incorrect password or destinationId", () => {
    const proof = computeExternalDeliveryAuthProof("s3gr3t0", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag);
    expect(verifyExternalDeliveryAuthProof(proof, "s3gr3t0", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag)).toBe(true);
    expect(verifyExternalDeliveryAuthProof(proof, "wrong-password", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag)).toBe(false);
    expect(verifyExternalDeliveryAuthProof(proof, "s3gr3t0", "hq-2", sealedA.nonce, sealedA.ciphertext, sealedA.authTag)).toBe(false); // bound to destinationId too
  });

  it("regression (found by code-review): a proof captured for one submission must NOT validate a different submission to the same destination with the same password — otherwise anyone who observes one valid proof in the clear (every mesh relay on the path, by design) could forge unlimited new submissions with arbitrary ciphertext", () => {
    const proofForA = computeExternalDeliveryAuthProof("s3gr3t0", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag);
    // Same password, same destinationId — but sealedB's own nonce/ciphertext/authTag, exactly what an
    // attacker forging a new submission while replaying a captured proof would attempt.
    expect(verifyExternalDeliveryAuthProof(proofForA, "s3gr3t0", "hq-1", sealedB.nonce, sealedB.ciphertext, sealedB.authTag)).toBe(false);
    // The genuinely-computed proof for B, by contrast, must validate B.
    const proofForB = computeExternalDeliveryAuthProof("s3gr3t0", "hq-1", sealedB.nonce, sealedB.ciphertext, sealedB.authTag);
    expect(verifyExternalDeliveryAuthProof(proofForB, "s3gr3t0", "hq-1", sealedB.nonce, sealedB.ciphertext, sealedB.authTag)).toBe(true);
  });

  it("never throws on a malformed/mismatched-length proof — timing-safe comparison guarded against Buffer.from throwing or length-mismatch crashing timingSafeEqual", () => {
    expect(verifyExternalDeliveryAuthProof("not-hex-at-all!!", "s3gr3t0", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag)).toBe(false);
    expect(verifyExternalDeliveryAuthProof("ab", "s3gr3t0", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag)).toBe(false); // valid hex, wrong length
    expect(verifyExternalDeliveryAuthProof("", "s3gr3t0", "hq-1", sealedA.nonce, sealedA.ciphertext, sealedA.authTag)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractExternalDeliveryPayload
// ---------------------------------------------------------------------------

function validDeliveryPayload(overrides: Partial<ExternalDeliveryPayload> = {}): ExternalDeliveryPayload {
  const destination = EncryptionIdentity.generate();
  const sealed = sealExternalDelivery(destination.publicKeyHex, Buffer.from("hello"));
  return {
    destinationId: "hq-1",
    senderEphemeralPublicKey: sealed.senderEphemeralPublicKey,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    authTag: sealed.authTag,
    submittedAt: Date.now(),
    ...overrides,
  };
}

describe("extractExternalDeliveryPayload", () => {
  const maxCiphertextHexLength = 10_000;

  it("accepts a well-formed payload, with and without authProof", () => {
    const payload = validDeliveryPayload();
    expect(extractExternalDeliveryPayload(payload, maxCiphertextHexLength)).toEqual(payload);
    const base = validDeliveryPayload();
    const withProof = { ...base, authProof: computeExternalDeliveryAuthProof("pw", base.destinationId, base.nonce, base.ciphertext, base.authTag) };
    expect(extractExternalDeliveryPayload(withProof, maxCiphertextHexLength)).toEqual(withProof);
  });

  it("rejects a missing/non-string/empty/oversized destinationId", () => {
    expect(extractExternalDeliveryPayload({ ...validDeliveryPayload(), destinationId: undefined }, maxCiphertextHexLength)).toBeUndefined();
    expect(extractExternalDeliveryPayload({ ...validDeliveryPayload(), destinationId: 42 }, maxCiphertextHexLength)).toBeUndefined();
    expect(extractExternalDeliveryPayload({ ...validDeliveryPayload(), destinationId: "" }, maxCiphertextHexLength)).toBeUndefined();
    expect(
      extractExternalDeliveryPayload(
        { ...validDeliveryPayload(), destinationId: "x".repeat(MAX_EXTERNAL_DELIVERY_DESTINATION_ID_LENGTH + 1) },
        maxCiphertextHexLength,
      ),
    ).toBeUndefined();
  });

  it("rejects a malformed senderEphemeralPublicKey/nonce/authTag (wrong length or non-hex)", () => {
    const base = validDeliveryPayload();
    expect(extractExternalDeliveryPayload({ ...base, senderEphemeralPublicKey: "too-short" }, maxCiphertextHexLength)).toBeUndefined();
    expect(extractExternalDeliveryPayload({ ...base, senderEphemeralPublicKey: "zz".repeat(32) }, maxCiphertextHexLength)).toBeUndefined();
    expect(extractExternalDeliveryPayload({ ...base, nonce: "ab" }, maxCiphertextHexLength)).toBeUndefined();
    expect(extractExternalDeliveryPayload({ ...base, authTag: "ab" }, maxCiphertextHexLength)).toBeUndefined();
  });

  it("rejects ciphertext beyond maxCiphertextHexLength, accepts it exactly at the limit", () => {
    const base = validDeliveryPayload();
    const oversized = "ab".repeat(Math.ceil((maxCiphertextHexLength + 2) / 2));
    expect(extractExternalDeliveryPayload({ ...base, ciphertext: oversized }, maxCiphertextHexLength)).toBeUndefined();
    const atLimit = "ab".repeat(maxCiphertextHexLength / 2);
    expect(extractExternalDeliveryPayload({ ...base, ciphertext: atLimit }, maxCiphertextHexLength)).toBeDefined();
  });

  it("rejects non-hex ciphertext", () => {
    expect(extractExternalDeliveryPayload({ ...validDeliveryPayload(), ciphertext: "not-hex!!" }, maxCiphertextHexLength)).toBeUndefined();
  });

  it("rejects a malformed authProof but tolerates a fully absent one", () => {
    const base = validDeliveryPayload();
    expect(extractExternalDeliveryPayload({ ...base, authProof: "too-short" }, maxCiphertextHexLength)).toBeUndefined();
    expect(extractExternalDeliveryPayload({ ...base, authProof: 42 }, maxCiphertextHexLength)).toBeUndefined();
    expect(extractExternalDeliveryPayload(base, maxCiphertextHexLength)).toBeDefined();
  });

  it("rejects a missing/non-number/non-finite submittedAt", () => {
    expect(extractExternalDeliveryPayload({ ...validDeliveryPayload(), submittedAt: undefined }, maxCiphertextHexLength)).toBeUndefined();
    expect(extractExternalDeliveryPayload({ ...validDeliveryPayload(), submittedAt: "now" }, maxCiphertextHexLength)).toBeUndefined();
    expect(extractExternalDeliveryPayload({ ...validDeliveryPayload(), submittedAt: Number.NaN }, maxCiphertextHexLength)).toBeUndefined();
  });

  it("rejects a payload that isn't even an object, without throwing", () => {
    expect(extractExternalDeliveryPayload(undefined, maxCiphertextHexLength)).toBeUndefined();
    expect(extractExternalDeliveryPayload(null, maxCiphertextHexLength)).toBeUndefined();
    expect(extractExternalDeliveryPayload("nope", maxCiphertextHexLength)).toBeUndefined();
    expect(extractExternalDeliveryPayload(42, maxCiphertextHexLength)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractExternalDeliveryDirectoryPayload / ExternalDeliveryDirectory
// ---------------------------------------------------------------------------

function validDirectoryPayload(overrides: Partial<ExternalDeliveryDirectoryPayload> = {}): ExternalDeliveryDirectoryPayload {
  const destination = EncryptionIdentity.generate();
  return {
    destinations: [{ destinationId: "hq-1", label: "Headquarter", publicKeyHex: destination.publicKeyHex, requiresPassword: false }],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("extractExternalDeliveryDirectoryPayload", () => {
  it("accepts a well-formed payload, including an empty destinations array", () => {
    const payload = validDirectoryPayload();
    expect(extractExternalDeliveryDirectoryPayload(payload)).toEqual(payload);
    expect(extractExternalDeliveryDirectoryPayload({ destinations: [], createdAt: Date.now() })).toBeDefined();
  });

  it("never leaks a url or password field even if present in the raw object — only the four allowed fields are copied out", () => {
    const destination = EncryptionIdentity.generate();
    const raw = {
      destinations: [
        {
          destinationId: "hq-1",
          label: "Headquarter",
          publicKeyHex: destination.publicKeyHex,
          requiresPassword: true,
          url: "https://internal.example/intake", // must never survive extraction
          password: "s3gr3t0", // must never survive extraction
        },
      ],
      createdAt: Date.now(),
    };
    const extracted = extractExternalDeliveryDirectoryPayload(raw);
    expect(extracted).toBeDefined();
    expect(extracted!.destinations[0]).toEqual({
      destinationId: "hq-1",
      label: "Headquarter",
      publicKeyHex: destination.publicKeyHex,
      requiresPassword: true,
    });
    expect(Object.keys(extracted!.destinations[0])).not.toContain("url");
    expect(Object.keys(extracted!.destinations[0])).not.toContain("password");
  });

  it("rejects a missing/non-number createdAt", () => {
    expect(extractExternalDeliveryDirectoryPayload({ ...validDirectoryPayload(), createdAt: undefined })).toBeUndefined();
    expect(extractExternalDeliveryDirectoryPayload({ ...validDirectoryPayload(), createdAt: "now" })).toBeUndefined();
  });

  it("rejects a non-array destinations field", () => {
    expect(extractExternalDeliveryDirectoryPayload({ ...validDirectoryPayload(), destinations: {} })).toBeUndefined();
    expect(extractExternalDeliveryDirectoryPayload({ ...validDirectoryPayload(), destinations: undefined })).toBeUndefined();
  });

  it("rejects a malformed destination entry (bad destinationId/label/publicKeyHex/requiresPassword)", () => {
    const destination = EncryptionIdentity.generate();
    const base = { destinationId: "hq-1", label: "Headquarter", publicKeyHex: destination.publicKeyHex, requiresPassword: false };
    expect(extractExternalDeliveryDirectoryPayload({ destinations: [{ ...base, destinationId: "" }], createdAt: Date.now() })).toBeUndefined();
    expect(
      extractExternalDeliveryDirectoryPayload({
        destinations: [{ ...base, label: "x".repeat(MAX_EXTERNAL_DELIVERY_LABEL_LENGTH + 1) }],
        createdAt: Date.now(),
      }),
    ).toBeUndefined();
    expect(extractExternalDeliveryDirectoryPayload({ destinations: [{ ...base, publicKeyHex: "too-short" }], createdAt: Date.now() })).toBeUndefined();
    expect(extractExternalDeliveryDirectoryPayload({ destinations: [{ ...base, requiresPassword: "yes" }], createdAt: Date.now() })).toBeUndefined();
    expect(extractExternalDeliveryDirectoryPayload({ destinations: ["not-an-object"], createdAt: Date.now() })).toBeUndefined();
  });

  it("rejects a payload that isn't even an object, without throwing", () => {
    expect(extractExternalDeliveryDirectoryPayload(undefined)).toBeUndefined();
    expect(extractExternalDeliveryDirectoryPayload(null)).toBeUndefined();
    expect(extractExternalDeliveryDirectoryPayload("nope")).toBeUndefined();
  });
});

describe("ExternalDeliveryDirectory", () => {
  it("records and lists destinations, tagging each with its publisher's boxNodeId", () => {
    const directory = new ExternalDeliveryDirectory();
    directory.record("box-a", validDirectoryPayload({ destinations: [{ destinationId: "hq-1", label: "HQ", publicKeyHex: "a".repeat(64), requiresPassword: false }] }));
    expect(directory.list()).toEqual([{ destinationId: "hq-1", label: "HQ", publicKeyHex: "a".repeat(64), requiresPassword: false, boxNodeId: "box-a" }]);
  });

  it("aggregates distinct publishers, each keeping its own destinations", () => {
    const directory = new ExternalDeliveryDirectory();
    directory.record("box-a", validDirectoryPayload({ destinations: [{ destinationId: "hq-1", label: "HQ", publicKeyHex: "a".repeat(64), requiresPassword: false }] }));
    directory.record("box-b", validDirectoryPayload({ destinations: [{ destinationId: "ong-1", label: "ONG", publicKeyHex: "b".repeat(64), requiresPassword: true }] }));
    const list = directory.list();
    expect(list).toHaveLength(2);
    expect(list.map((d) => d.boxNodeId).sort()).toEqual(["box-a", "box-b"]);
  });

  it("a newer publication from the same publisher replaces the older one", () => {
    const directory = new ExternalDeliveryDirectory();
    directory.record("box-a", validDirectoryPayload({ createdAt: 100, destinations: [{ destinationId: "old", label: "Old", publicKeyHex: "a".repeat(64), requiresPassword: false }] }));
    directory.record("box-a", validDirectoryPayload({ createdAt: 200, destinations: [{ destinationId: "new", label: "New", publicKeyHex: "b".repeat(64), requiresPassword: false }] }));
    expect(directory.list().map((d) => d.destinationId)).toEqual(["new"]);
  });

  it("an out-of-order (older) publication never overwrites a newer one already recorded", () => {
    const directory = new ExternalDeliveryDirectory();
    directory.record("box-a", validDirectoryPayload({ createdAt: 200, destinations: [{ destinationId: "new", label: "New", publicKeyHex: "b".repeat(64), requiresPassword: false }] }));
    directory.record("box-a", validDirectoryPayload({ createdAt: 100, destinations: [{ destinationId: "old", label: "Old", publicKeyHex: "a".repeat(64), requiresPassword: false }] }));
    expect(directory.list().map((d) => d.destinationId)).toEqual(["new"]);
  });

  it("list() returns an empty array when nothing has been recorded, never undefined/throwing", () => {
    expect(new ExternalDeliveryDirectory().list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ExternalDeliveryQueue
// ---------------------------------------------------------------------------

function queuedEntry(overrides: Partial<QueuedExternalDelivery> & { packetId: string }): Omit<QueuedExternalDelivery, "expiresAt" | "priority"> & {
  priority: unknown;
} {
  return {
    destinationId: "hq-1",
    url: "https://org.example/intake",
    senderEphemeralPublicKey: "a".repeat(64),
    nonce: "b".repeat(24),
    ciphertext: "c".repeat(100),
    authTag: "d".repeat(32),
    submittedAt: Date.now(),
    sizeBytes: 1000,
    priority: Priority.CONTENT,
    ...overrides,
  };
}

describe("ExternalDeliveryQueue", () => {
  it("enqueues and reports size/totalBytesUsed", () => {
    const queue = new ExternalDeliveryQueue();
    queue.enqueue(queuedEntry({ packetId: "1", sizeBytes: 500 }));
    queue.enqueue(queuedEntry({ packetId: "2", sizeBytes: 700 }));
    expect(queue.size).toBe(2);
    expect(queue.totalBytesUsed).toBe(1200);
  });

  it("ignores a second enqueue() for the same packetId — no duplicate entry, no double-counted bytes", () => {
    const queue = new ExternalDeliveryQueue();
    queue.enqueue(queuedEntry({ packetId: "same", sizeBytes: 500 }));
    queue.enqueue(queuedEntry({ packetId: "same", sizeBytes: 500 }));
    expect(queue.size).toBe(1);
    expect(queue.totalBytesUsed).toBe(500);
  });

  it("evicts the lowest-priority (highest Priority number), oldest-first entry once maxEntries is exceeded", () => {
    const queue = new ExternalDeliveryQueue({ maxEntries: 2 });
    queue.enqueue(queuedEntry({ packetId: "emergency", priority: Priority.EMERGENCY }));
    queue.enqueue(queuedEntry({ packetId: "bulk-1", priority: Priority.BULK }));
    queue.enqueue(queuedEntry({ packetId: "bulk-2", priority: Priority.BULK })); // triggers eviction

    const remaining = queue.entriesDueForAttempt().map((e) => e.packetId);
    expect(remaining).toContain("emergency");
    // one of the two BULK entries was evicted to make room — exactly one BULK entry should survive
    expect(remaining.filter((id) => id.startsWith("bulk"))).toHaveLength(1);
    expect(remaining).toHaveLength(2);
  });

  it("evicts by total byte budget, independent of entry count — same-priority ties evict the oldest first", () => {
    const queue = new ExternalDeliveryQueue({ maxEntries: 100, maxTotalBytes: 1000 });
    queue.enqueue(queuedEntry({ packetId: "big-old", sizeBytes: 900, priority: Priority.CONTENT }));
    queue.enqueue(queuedEntry({ packetId: "small-new", sizeBytes: 200, priority: Priority.CONTENT })); // pushes total to 1100 > 1000

    expect(queue.totalBytesUsed).toBeLessThanOrEqual(1000);
    expect(queue.size).toBe(1);
    // both entries share the same priority — the older one ("big-old") is evicted, not the newer one.
    expect(queue.has("small-new")).toBe(true);
    expect(queue.has("big-old")).toBe(false);
  });

  it("clamps an out-of-range/forged priority to the least urgent (BULK), so a forged EMERGENCY tag can't dodge eviction", () => {
    const queue = new ExternalDeliveryQueue({ maxEntries: 1 });
    queue.enqueue(queuedEntry({ packetId: "forged", priority: 999 })); // out of range — must be treated as BULK
    queue.enqueue(queuedEntry({ packetId: "real-emergency", priority: Priority.EMERGENCY }));

    const remaining = queue.entriesDueForAttempt().map((e) => e.packetId);
    expect(remaining).toEqual(["real-emergency"]);
  });

  it("entriesDueForAttempt() silently drops (and stops counting) an expired entry, without touching a still-live one", () => {
    // ttlMs is a single queue-wide setting, applied at enqueue() time as `Date.now() + ttlMs` — so
    // "expired" vs. "still live" is controlled here purely by advancing the fake clock between two
    // enqueue() calls on the same queue, same pattern already used by location-registry.test.ts/
    // relay-registry.test.ts for their own lazy-expiry tests.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const queue = new ExternalDeliveryQueue({ ttlMs: 1000 });
      queue.enqueue(queuedEntry({ packetId: "will-expire", sizeBytes: 300 })); // expiresAt = 1000

      vi.setSystemTime(1500); // past "will-expire"'s expiresAt, before "live"'s own
      queue.enqueue(queuedEntry({ packetId: "live", sizeBytes: 100 })); // expiresAt = 2500

      const due = queue.entriesDueForAttempt().map((e) => e.packetId);
      expect(due).toEqual(["live"]);
      expect(queue.size).toBe(1); // the expired entry was actually removed, not just filtered from the result
      expect(queue.totalBytesUsed).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("remove() deletes an entry and subtracts its bytes; a second remove() for the same id is a no-op", () => {
    const queue = new ExternalDeliveryQueue();
    queue.enqueue(queuedEntry({ packetId: "1", sizeBytes: 500 }));
    queue.remove("1");
    expect(queue.size).toBe(0);
    expect(queue.totalBytesUsed).toBe(0);
    expect(() => queue.remove("1")).not.toThrow();
    expect(() => queue.remove("never-existed")).not.toThrow();
  });

  it("does not remove an entry that failed delivery — entriesDueForAttempt() leaves it queued for the next tick", () => {
    const queue = new ExternalDeliveryQueue();
    queue.enqueue(queuedEntry({ packetId: "1" }));
    queue.entriesDueForAttempt(); // simulates an attempt that the caller decided not to remove() after
    expect(queue.has("1")).toBe(true);
  });
});
