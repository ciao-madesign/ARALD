import { describe, expect, it } from "vitest";
import { TrustLevel, TrustManager, meetsTrustLevel } from "../../node/src/trust.js";

describe("TrustManager", () => {
  it("defaults to UNKNOWN for a node it has never heard of", () => {
    const trust = new TrustManager();
    expect(trust.get("nobody")).toBe(TrustLevel.UNKNOWN);
  });

  it("promotes to SEEN, then VERIFIED, as evidence accumulates", () => {
    const trust = new TrustManager();
    trust.markSeen("a");
    expect(trust.get("a")).toBe(TrustLevel.SEEN);

    trust.markVerified("a");
    expect(trust.get("a")).toBe(TrustLevel.VERIFIED);
  });

  it("never lets markSeen/markVerified downgrade an already-higher level", () => {
    const trust = new TrustManager();
    trust.set("a", TrustLevel.TRUSTED);

    trust.markSeen("a");
    expect(trust.get("a")).toBe(TrustLevel.TRUSTED);

    trust.markVerified("a");
    expect(trust.get("a")).toBe(TrustLevel.TRUSTED);
  });

  it("allows an explicit set() to downgrade (operator revocation)", () => {
    const trust = new TrustManager();
    trust.set("a", TrustLevel.ADMIN);
    trust.set("a", TrustLevel.UNKNOWN);
    expect(trust.get("a")).toBe(TrustLevel.UNKNOWN);
  });

  it("lists all known node ids and their levels", () => {
    const trust = new TrustManager();
    trust.markSeen("a");
    trust.set("b", TrustLevel.ADMIN);

    const list = trust.list();
    expect(list).toHaveLength(2);
    expect(list).toContainEqual({ nodeId: "a", level: TrustLevel.SEEN });
    expect(list).toContainEqual({ nodeId: "b", level: TrustLevel.ADMIN });
  });

  it("is bounded: evicts the oldest low-trust entry once full, instead of growing without limit", () => {
    // Regression: markVerified() only proves "this key signed this claim", not that the claim is
    // legitimate — a peer can mint many throwaway keypairs and self-sign fabricated catalog
    // entries purely to grow this map. Without a bound, that's unlimited memory growth from a
    // single connection (spec §57).
    const trust = new TrustManager({ maxSize: 3 });
    trust.markSeen("a");
    trust.markVerified("b");
    trust.markVerified("c");
    expect(trust.size).toBe(3);

    trust.markVerified("d");
    expect(trust.size).toBe(3);
    expect(trust.has("d")).toBe(true); // the new entry made it in...
    expect(trust.has("a")).toBe(false); // ...by evicting the oldest, lowest-tier one (SEEN beats nothing else here)
  });

  it("prefers evicting the lowest trust tier present, protecting operator-assigned TRUSTED/ADMIN entries", () => {
    const trust = new TrustManager({ maxSize: 3 });
    trust.set("admin", TrustLevel.ADMIN);
    trust.set("trusted", TrustLevel.TRUSTED);
    trust.markVerified("verified-1");
    expect(trust.size).toBe(3);

    // A flood of cheaply-mintable VERIFIED entries must not be able to push out ADMIN/TRUSTED ones.
    for (let i = 0; i < 20; i++) {
      trust.markVerified(`verified-flood-${i}`);
    }

    expect(trust.size).toBe(3);
    expect(trust.get("admin")).toBe(TrustLevel.ADMIN);
    expect(trust.get("trusted")).toBe(TrustLevel.TRUSTED);
  });
});

describe("meetsTrustLevel", () => {
  it("orders levels UNKNOWN < SEEN < VERIFIED < TRUSTED < ADMIN", () => {
    expect(meetsTrustLevel(TrustLevel.SEEN, TrustLevel.UNKNOWN)).toBe(true);
    expect(meetsTrustLevel(TrustLevel.UNKNOWN, TrustLevel.SEEN)).toBe(false);
    expect(meetsTrustLevel(TrustLevel.VERIFIED, TrustLevel.VERIFIED)).toBe(true);
    expect(meetsTrustLevel(TrustLevel.TRUSTED, TrustLevel.ADMIN)).toBe(false);
    expect(meetsTrustLevel(TrustLevel.ADMIN, TrustLevel.TRUSTED)).toBe(true);
  });
});
