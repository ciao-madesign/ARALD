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
});
