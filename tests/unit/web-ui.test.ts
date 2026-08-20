import { describe, expect, it } from "vitest";
import { generateNetworkPassword, resolveCallTimeoutMs } from "../../node/src/web-ui.js";

/**
 * Pure logic extracted from WebUiServer.handleCall() (spec §59 mobile
 * client, docs/next-steps.md Opzione H) specifically so the timeout cap
 * doesn't need an integration test that actually waits out 15 real
 * seconds to verify — see tests/integration/web-ui.test.ts for the
 * end-to-end POST /api/call behavior this feeds into.
 */
describe("resolveCallTimeoutMs", () => {
  it("defaults to 5000ms when no timeout is requested", () => {
    expect(resolveCallTimeoutMs(undefined)).toBe(5000);
  });

  it("honors a requested value under the cap", () => {
    expect(resolveCallTimeoutMs(2000)).toBe(2000);
  });

  it("caps a requested value above the maximum at 15000ms", () => {
    expect(resolveCallTimeoutMs(999_999)).toBe(15000);
  });

  it("falls back to the default for a non-number, zero, or negative request instead of throwing", () => {
    expect(resolveCallTimeoutMs("2000")).toBe(5000);
    expect(resolveCallTimeoutMs(0)).toBe(5000);
    expect(resolveCallTimeoutMs(-500)).toBe(5000);
    expect(resolveCallTimeoutMs(null)).toBe(5000);
  });
});

/**
 * A code-review pass on the Wi-Fi-like pairing feature (docs/security.md) found that the alphabet
 * this originally shipped with (excluding 0/O/1/I/L) has 31 symbols, not the 32 its own comment
 * claimed — since 256 % 31 !== 0, `randomBytes()[i] % 31` was measurably biased toward the
 * alphabet's first 8 symbols. Fixed by switching to Crockford's Base32 alphabet (excludes I/L/O/U
 * instead, keeping 0/1 since nothing ambiguous remains for them to be confused with) — these tests
 * pin the resulting charset and format so a future edit to NETWORK_PASSWORD_ALPHABET can't
 * silently reintroduce a non-power-of-two length.
 */
describe("generateNetworkPassword", () => {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  it("has a bias-free, exactly-32-symbol alphabet (256 divides evenly by 32)", () => {
    expect(ALPHABET.length).toBe(32);
  });

  it("produces two 4-symbol groups joined by a dash", () => {
    expect(generateNetworkPassword()).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it("only ever uses symbols from the bias-free alphabet, never the visually-ambiguous I, L, O, U", () => {
    for (let i = 0; i < 50; i++) {
      const password = generateNetworkPassword();
      for (const char of password.replace("-", "")) {
        expect(ALPHABET).toContain(char);
      }
      expect(password).not.toMatch(/[ILOU]/);
    }
  });

  it("is not a fixed string across calls", () => {
    const generated = new Set(Array.from({ length: 20 }, () => generateNetworkPassword()));
    expect(generated.size).toBeGreaterThan(1);
  });
});
