import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../mirror-portal/lib/password";

describe("mirror-portal password hashing", () => {
  it("round-trips a correct password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", stored)).toBe(false);
  });

  it("never produces the same stored value twice (random salt)", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("rejects a stored value with no separator", async () => {
    expect(await verifyPassword("anything", "nosaltorhash")).toBe(false);
  });

  it("rejects a stored value with an empty salt or hash", async () => {
    expect(await verifyPassword("anything", ":deadbeef")).toBe(false);
    expect(await verifyPassword("anything", "abcd:")).toBe(false);
  });

  it("rejects a stored value whose hash decodes to the wrong length, without throwing", async () => {
    expect(await verifyPassword("anything", "abcd:deadbeef")).toBe(false);
  });

  it("rejects a stored value with non-hex hash content, without throwing", async () => {
    await expect(verifyPassword("anything", "abcd:not-hex-at-all!!")).resolves.toBe(false);
  });
});
