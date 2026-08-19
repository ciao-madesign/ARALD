import { describe, expect, it } from "vitest";
import { ServiceDirectory } from "../../node/src/service-directory.js";
import type { ServiceAnnouncement } from "../../node/src/service.js";

function announcement(
  serviceId: string,
  providerId: string,
  overrides: Partial<Pick<ServiceAnnouncement, "availability" | "createdAt">> = {},
): ServiceAnnouncement {
  return {
    serviceId,
    version: "1.0.0",
    capabilities: [],
    providerId,
    availability: overrides.availability ?? true,
    createdAt: overrides.createdAt ?? Date.now(),
    signature: "unused-in-these-tests", // ServiceDirectory itself never verifies — that's the caller's job
  };
}

describe("ServiceDirectory", () => {
  it("records and lists announcements, and providersFor() filters by serviceId", () => {
    const directory = new ServiceDirectory();
    directory.record(announcement("service://translation", "alice"));
    directory.record(announcement("service://ocr", "bob"));

    expect(directory.size).toBe(2);
    expect(directory.providersFor("service://translation").map((a) => a.providerId)).toEqual(["alice"]);
  });

  it("keeps distinct entries for the same serviceId from different providers", () => {
    const directory = new ServiceDirectory();
    directory.record(announcement("service://translation", "alice"));
    directory.record(announcement("service://translation", "bob"));

    expect(directory.size).toBe(2);
    expect(directory.providersFor("service://translation").map((a) => a.providerId).sort()).toEqual(["alice", "bob"]);
  });

  it("providersFor() excludes announcements with availability: false", () => {
    const directory = new ServiceDirectory();
    directory.record(announcement("service://ai", "alice", { availability: false }));
    directory.record(announcement("service://ai", "bob", { availability: true }));

    expect(directory.providersFor("service://ai").map((a) => a.providerId)).toEqual(["bob"]);
  });

  it("a newer announcement for the same (serviceId, providerId) replaces the older one", () => {
    const directory = new ServiceDirectory();
    directory.record(announcement("service://ai", "alice", { availability: true, createdAt: 1000 }));
    directory.record(announcement("service://ai", "alice", { availability: false, createdAt: 2000 }));

    expect(directory.size).toBe(1);
    expect(directory.get("service://ai", "alice")?.availability).toBe(false);
  });

  it("a replayed older announcement does not override a newer one already recorded (unlike RemoteCatalog, but for the opposite reason: service state is mutable, so freshness — not first-write — must win)", () => {
    const directory = new ServiceDirectory();
    directory.record(announcement("service://ai", "alice", { availability: false, createdAt: 2000 }));
    directory.record(announcement("service://ai", "alice", { availability: true, createdAt: 1000 })); // stale replay

    expect(directory.get("service://ai", "alice")?.availability).toBe(false);
    expect(directory.get("service://ai", "alice")?.createdAt).toBe(2000);
  });

  it("on a tied createdAt (two announcements signed in the same millisecond), the incoming one wins, not the existing one", () => {
    // registerService() immediately followed by setServiceAvailability() can plausibly stamp the
    // same Date.now() millisecond on both signed announcements — the second one (the actual
    // intent: "now unavailable") must not be silently dropped just because it arrived second with
    // an equal, not strictly greater, timestamp.
    const directory = new ServiceDirectory();
    directory.record(announcement("service://ai", "alice", { availability: true, createdAt: 5000 }));
    directory.record(announcement("service://ai", "alice", { availability: false, createdAt: 5000 }));

    expect(directory.get("service://ai", "alice")?.availability).toBe(false);
  });

  it("evicts the oldest entry once maxSize is exceeded, when no trustRank is given", () => {
    const directory = new ServiceDirectory({ maxSize: 2 });
    directory.record(announcement("service://a", "p1"));
    directory.record(announcement("service://b", "p2"));
    directory.record(announcement("service://c", "p3"));

    expect(directory.size).toBe(2);
    expect(directory.get("service://a", "p1")).toBeUndefined();
    expect(directory.get("service://c", "p3")).toBeDefined();
  });

  it("with trustRank given, evicts the entry from the least-trusted provider instead of the oldest", () => {
    const trust: Record<string, number> = { alice: 5, bob: 0 };
    const directory = new ServiceDirectory({ maxSize: 2, trustRank: (providerId) => trust[providerId] ?? 0 });

    directory.record(announcement("service://a", "alice")); // trusted, oldest — must still survive
    directory.record(announcement("service://b", "bob")); // untrusted
    directory.record(announcement("service://c", "bob")); // untrusted, newer than "b" — "b" evicted, not "a"

    expect(directory.get("service://a", "alice")).toBeDefined();
    expect(directory.get("service://b", "bob")).toBeUndefined();
    expect(directory.get("service://c", "bob")).toBeDefined();
  });
});
