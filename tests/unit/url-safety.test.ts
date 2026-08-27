import { describe, expect, it, vi, afterEach } from "vitest";

/**
 * `isPubliclyRoutableUrl()` (`gateway/nomad/url-safety.ts`) — the SSRF guard
 * shared by both `kind`s of `service://internet-fetch` (`internet-gateway.ts`).
 * Domain-name resolution is mocked (`node:dns/promises`) so these tests are
 * deterministic and don't depend on real DNS/network being reachable from
 * this sandbox (it isn't, per `docs/security.md`) — only IP-literal cases
 * and `localhost` (resolved via the OS hosts file, no network trip) exercise
 * the real code path end to end.
 */

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

const { isPubliclyRoutableUrl } = await import("../../gateway/nomad/url-safety.js");

describe("isPubliclyRoutableUrl()", () => {
  afterEach(() => {
    lookupMock.mockReset();
  });

  it("rejects non-http(s) schemes", async () => {
    expect(await isPubliclyRoutableUrl(new URL("ftp://8.8.8.8/"))).toBe(false);
    expect(await isPubliclyRoutableUrl(new URL("file:///etc/passwd"))).toBe(false);
  });

  it("allows a public IPv4 literal", async () => {
    expect(await isPubliclyRoutableUrl(new URL("http://8.8.8.8/"))).toBe(true);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["RFC1918 10/8", "10.1.2.3"],
    ["RFC1918 172.16/12", "172.16.0.5"],
    ["RFC1918 192.168/16", "192.168.1.1"],
    ["link-local incl. cloud metadata", "169.254.169.254"],
    ["this-network", "0.0.0.1"],
    ["multicast", "224.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["documentation TEST-NET-1", "192.0.2.1"],
  ])("rejects a private/reserved IPv4 literal (%s: %s)", async (_label, ip) => {
    expect(await isPubliclyRoutableUrl(new URL(`http://${ip}/`))).toBe(false);
  });

  it("allows a public IPv6 literal", async () => {
    expect(await isPubliclyRoutableUrl(new URL("http://[2001:4860:4860::8888]/"))).toBe(true);
  });

  it.each([
    ["loopback", "::1"],
    ["link-local", "fe80::1"],
    ["unique local", "fc00::1"],
    ["unique local (fd prefix)", "fd12:3456::1"],
  ])("rejects a private/reserved IPv6 literal (%s: %s)", async (_label, ip) => {
    expect(await isPubliclyRoutableUrl(new URL(`http://[${ip}]/`))).toBe(false);
  });

  it("unwraps an IPv4-mapped IPv6 literal and checks the embedded address", async () => {
    expect(await isPubliclyRoutableUrl(new URL("http://[::ffff:127.0.0.1]/"))).toBe(false);
    expect(await isPubliclyRoutableUrl(new URL("http://[::ffff:8.8.8.8]/"))).toBe(true);
  });

  it("unwraps the deprecated IPv4-compatible IPv6 form (::a.b.c.d, no ffff marker) too", async () => {
    // Regression: a first fix only handled the IPv4-*mapped* form (::ffff:a.b.c.d) — this older,
    // marker-less form (`new URL("http://[::127.0.0.1]/").hostname` normalizes to "[::7f00:1]",
    // confirmed empirically) fell through to the generic "public" return undetected.
    expect(await isPubliclyRoutableUrl(new URL("http://[::127.0.0.1]/"))).toBe(false);
    expect(await isPubliclyRoutableUrl(new URL("http://[::10.0.0.1]/"))).toBe(false);
    expect(await isPubliclyRoutableUrl(new URL("http://[::8.8.8.8]/"))).toBe(true);
  });

  it("resolves a domain name and allows it when every resolved address is public", async () => {
    lookupMock.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    expect(await isPubliclyRoutableUrl(new URL("http://example.test/"))).toBe(true);
    expect(lookupMock).toHaveBeenCalledWith("example.test", { all: true, verbatim: true });
  });

  it("rejects a domain name when it resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await isPubliclyRoutableUrl(new URL("http://internal.test/"))).toBe(false);
  });

  it("rejects a domain name when ANY of several resolved addresses is private, not just the first", async () => {
    lookupMock.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    expect(await isPubliclyRoutableUrl(new URL("http://mixed.test/"))).toBe(false);
  });

  it("rejects an unresolvable hostname instead of throwing", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    expect(await isPubliclyRoutableUrl(new URL("http://does-not-exist.test/"))).toBe(false);
  });

  it("rejects a domain that resolves to zero addresses", async () => {
    lookupMock.mockResolvedValue([]);
    expect(await isPubliclyRoutableUrl(new URL("http://empty.test/"))).toBe(false);
  });

  it("rejects localhost end to end, without mocking dns (real hosts-file resolution)", async () => {
    vi.doUnmock("node:dns/promises");
    vi.resetModules();
    const { isPubliclyRoutableUrl: real } = await import("../../gateway/nomad/url-safety.js");
    expect(await real(new URL("http://localhost/"))).toBe(false);
  });
});
