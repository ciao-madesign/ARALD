import { describe, expect, it } from "vitest";
import { resolveCallTimeoutMs } from "../../node/src/web-ui.js";

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
