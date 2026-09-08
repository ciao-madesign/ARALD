import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256, sha256Hex, loadOrCreateIdentity } from "../../mobile/www/ble-identity.js";
import { verifyContentSignature, contentSigningPayload, type ContentMetadata } from "../../node/src/content.js";

// ble-identity.js references the bare global `nacl` (vendored TweetNaCl, mobile/www/vendor/nacl.js
// — a classic, non-module script that self-attaches to `self.nacl` in a real browser) only inside
// function bodies, never at module-load time, so it is enough to set this before *calling*
// loadOrCreateIdentity() below, not before the import above.
beforeAll(() => {
  const require = createRequire(import.meta.url);
  (globalThis as unknown as { nacl: unknown }).nacl = require("../../mobile/www/vendor/nacl.js");
});

/** Minimal in-memory Storage-like fake — no `localStorage` global exists under vitest's default Node environment (verified empirically), so loadOrCreateIdentity()'s injectable `storage` parameter is exercised directly here instead of relying on a real one. */
class FakeStorage {
  #map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
}

/** Simulates Safari private-browsing-under-quota-pressure: reads always succeed (returning null, as if nothing were ever written), writes always throw — the exact split that made loadOrCreateIdentity() regenerate a brand-new random seed on every single call before its in-memory cache was added (found by code review). */
class SilentlyFailingWritesStorage {
  getItem(): string | null {
    return null;
  }
  setItem(): void {
    throw new Error("simulated quota-limited storage: writes always fail");
  }
}

class ThrowingStorage {
  getItem(): string | null {
    throw new Error("simulated storage failure (e.g. private browsing quota)");
  }
  setItem(): void {
    throw new Error("simulated storage failure");
  }
}

describe("mobile/www/ble-identity (real Ed25519 identity for phone-originated content)", () => {
  describe("sha256/sha256Hex", () => {
    it("matches the known SHA-256(\"\") test vector", () => {
      expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    it("matches the known SHA-256(\"abc\") test vector", () => {
      expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    it("matches Node's createHash(\"sha256\") across padding boundary lengths and random input", () => {
      const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 1000];
      for (const length of lengths) {
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        const mine = sha256Hex(bytes);
        const node = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
        expect(mine, `length ${length}`).toBe(node);
      }
    });

    it("sha256() returns the same 32 bytes sha256Hex() hex-encodes", () => {
      const bytes = new TextEncoder().encode("consistency check");
      expect(Buffer.from(sha256(bytes)).toString("hex")).toBe(sha256Hex(bytes));
    });
  });

  describe("loadOrCreateIdentity", () => {
    it("returns a 64-hex-character nodeId (raw Ed25519 public key, same scheme as node/src/identity.ts)", () => {
      const identity = loadOrCreateIdentity(new FakeStorage());
      expect(identity.nodeId).toMatch(/^[0-9a-f]{64}$/);
    });

    it("persists across calls with the same storage — repeated calls return the same identity, not a new one each time", () => {
      const storage = new FakeStorage();
      const first = loadOrCreateIdentity(storage);
      const second = loadOrCreateIdentity(storage);
      expect(second.nodeId).toBe(first.nodeId);
    });

    it("two different storages produce two different identities", () => {
      const a = loadOrCreateIdentity(new FakeStorage());
      const b = loadOrCreateIdentity(new FakeStorage());
      expect(a.nodeId).not.toBe(b.nodeId);
    });

    it("degrades to a working, if unpersisted, identity when storage throws — never crashes the caller", () => {
      expect(() => loadOrCreateIdentity(new ThrowingStorage())).not.toThrow();
      const identity = loadOrCreateIdentity(new ThrowingStorage());
      expect(identity.nodeId).toMatch(/^[0-9a-f]{64}$/);
    });

    it("works with storage=undefined (no window.localStorage available)", () => {
      expect(() => loadOrCreateIdentity(undefined)).not.toThrow();
    });

    it("regression: loadOrCreateIdentity() with no argument never throws even if merely accessing window.localStorage itself throws (not just getItem()/setItem() on it)", () => {
      // vitest's default Node environment has no `window` at all, so defaultStorage()'s own
      // `typeof window !== "undefined"` check already short-circuits — this simulates the real
      // browser scenario the fix targets: a `window` that exists, but whose `localStorage` property
      // getter itself throws (some storage-restricted contexts), not just its getItem()/setItem().
      (globalThis as unknown as { window: unknown }).window = {
        get localStorage(): never {
          throw new Error("simulated: accessing localStorage itself throws");
        },
      };
      try {
        expect(() => loadOrCreateIdentity()).not.toThrow();
      } finally {
        delete (globalThis as unknown as { window?: unknown }).window;
      }
    });

    it("regression: a storage whose writes silently fail (reads keep returning null) still returns the SAME identity on every call in the same session, not a fresh one each time", () => {
      const storage = new SilentlyFailingWritesStorage();
      const first = loadOrCreateIdentity(storage);
      const second = loadOrCreateIdentity(storage);
      const third = loadOrCreateIdentity(storage);
      expect(second.nodeId).toBe(first.nodeId);
      expect(third.nodeId).toBe(first.nodeId);
    });

    it("regression: with storage=undefined every call also returns the same session-only identity, not a fresh one each time", () => {
      const first = loadOrCreateIdentity(undefined);
      const second = loadOrCreateIdentity(undefined);
      expect(second.nodeId).toBe(first.nodeId);
    });

    it("sign() produces a signature verifiable by Identity.verifyWithNodeId() — real interop, not just self-consistency", async () => {
      const { Identity } = await import("../../node/src/identity.js");
      const identity = loadOrCreateIdentity(new FakeStorage());
      const data = new TextEncoder().encode("interop check");
      const signature = Buffer.from(identity.sign(data));
      expect(Identity.verifyWithNodeId(identity.nodeId, Buffer.from(data), signature)).toBe(true);
    });

    it("a phone identity signs a ContentMetadata that verifyContentSignature() accepts for real — the core claim this module exists to satisfy", () => {
      const identity = loadOrCreateIdentity(new FakeStorage());
      const contentId = sha256Hex(new TextEncoder().encode("payload bytes"));
      const fields = { contentId, name: "emergency-beacon", mimeType: "application/json", size: 42, publisherId: identity.nodeId, expiresAt: undefined };
      const signature = Buffer.from(identity.sign(contentSigningPayload(fields))).toString("hex");
      const metadata: ContentMetadata = { ...fields, createdAt: Date.now(), signature };
      expect(verifyContentSignature(metadata)).toBe(true);
    });

    it("a tampered field is rejected by verifyContentSignature() — the signature is not just present, it is checked", () => {
      const identity = loadOrCreateIdentity(new FakeStorage());
      const contentId = sha256Hex(new TextEncoder().encode("payload bytes"));
      const fields = { contentId, name: "emergency-beacon", mimeType: "application/json", size: 42, publisherId: identity.nodeId, expiresAt: undefined };
      const signature = Buffer.from(identity.sign(contentSigningPayload(fields))).toString("hex");
      const tampered: ContentMetadata = { ...fields, name: "not-what-was-signed", createdAt: Date.now(), signature };
      expect(verifyContentSignature(tampered)).toBe(false);
    });
  });
});
