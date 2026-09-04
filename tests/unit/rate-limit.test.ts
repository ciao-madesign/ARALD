import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../node/src/rate-limit.js";

describe("RateLimiter", () => {
  it("allows packets up to the configured budget within a window", () => {
    const limiter = new RateLimiter({ maxPacketsPerWindow: 3, windowMs: 10_000 });
    expect(limiter.allow("peer-a")).toBe(true);
    expect(limiter.allow("peer-a")).toBe(true);
    expect(limiter.allow("peer-a")).toBe(true);
  });

  it("rejects packets once a peer exceeds its budget within the window", () => {
    const limiter = new RateLimiter({ maxPacketsPerWindow: 3, windowMs: 10_000 });
    limiter.allow("peer-a");
    limiter.allow("peer-a");
    limiter.allow("peer-a");
    expect(limiter.allow("peer-a")).toBe(false);
    expect(limiter.allow("peer-a")).toBe(false);
  });

  it("tracks each peer's budget independently", () => {
    const limiter = new RateLimiter({ maxPacketsPerWindow: 1, windowMs: 10_000 });
    expect(limiter.allow("peer-a")).toBe(true);
    expect(limiter.allow("peer-a")).toBe(false);
    expect(limiter.allow("peer-b")).toBe(true);
  });

  it("resets a peer's budget once its window elapses", async () => {
    const limiter = new RateLimiter({ maxPacketsPerWindow: 1, windowMs: 30 });
    expect(limiter.allow("peer-a")).toBe(true);
    expect(limiter.allow("peer-a")).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(limiter.allow("peer-a")).toBe(true);
  });

  it("forgets a peer's budget on reset, e.g. after it disconnects", () => {
    const limiter = new RateLimiter({ maxPacketsPerWindow: 1, windowMs: 10_000 });
    limiter.allow("peer-a");
    expect(limiter.allow("peer-a")).toBe(false);

    limiter.reset("peer-a");
    expect(limiter.allow("peer-a")).toBe(true);
  });

  it("evicts the oldest tracked peer id once maxTrackedPeers is exceeded, instead of growing without bound (regression, docs/security.md — the broadcast-reception path has no disconnect event to ever reset() a throwaway identity)", () => {
    const limiter = new RateLimiter({ maxPacketsPerWindow: 1, windowMs: 10_000, maxTrackedPeers: 2 });
    expect(limiter.allow("peer-a")).toBe(true);
    expect(limiter.allow("peer-a")).toBe(false); // over budget, tracked normally

    expect(limiter.allow("peer-b")).toBe(true); // still 2 tracked peers, at capacity: {a, b}
    expect(limiter.allow("peer-c")).toBe(true); // a third distinct id evicts "peer-a" (the oldest) to make room: {b, c}

    // "peer-a"'s window state was evicted — treated as never-before-seen again. This is the whole
    // point: the map never held more than maxTrackedPeers entries no matter how many distinct
    // throwaway ids (e.g. a broadcast sender minting a fresh identity per packet) called allow().
    expect(limiter.allow("peer-a")).toBe(true);
  });
});
