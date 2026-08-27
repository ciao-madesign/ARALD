import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * Best-effort SSRF guard shared by every `kind` `internet-gateway.ts` (`InternetGateway`)
 * offers — applied *before* any outbound fetch, regardless of `kind`-specific
 * checks (a `kind: "rss"` request has no domain allowlist, since `parseFeed()`
 * itself is the content-shape barrier for that kind, so this is the only
 * thing standing between a caller and making this node's own network probe
 * arbitrary internal infrastructure the operator's machine can reach —
 * classic SSRF, found while designing this gateway: even a *rejected* fetch
 * (wrong content shape, wrong host) still means a real outbound TCP
 * connection was attempted from the operator's own network).
 *
 * Checks, in order: only `http`/`https` schemes; if the hostname is a literal
 * IP, reject it directly if it falls in a private/loopback/link-local/reserved
 * range; if it's a domain name, resolve it and reject if *any* resolved
 * address falls in one of those ranges.
 *
 * **Known, accepted limitation — not a complete SSRF defense**: the DNS
 * resolution here and the one `fetch()` performs moments later when it
 * actually connects are two separate lookups. A DNS response that changes
 * between the two (DNS rebinding, or a resolver simply returning a
 * different address on a repeat query) can still slip a private address
 * through unnoticed — closing that fully would require pinning the exact
 * resolved address for the subsequent request (a custom `Agent`/dispatcher),
 * out of scope for this prototype. Documented rather than silently assumed
 * solved, same posture already used elsewhere in this codebase for
 * `packet.source` non-authentication (`CLAUDE.md`). This function also
 * doesn't claim to enumerate every obscure reserved range — it covers the
 * common, well-known private/loopback/link-local ones.
 */
export async function isPubliclyRoutableUrl(url: URL): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // URL keeps IPv6 literals bracketed, e.g. "[::1]"
  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) return isPublicAddress(hostname);

  let resolved: string[];
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    resolved = addresses.map((a) => a.address);
  } catch {
    return false; // unresolvable hostname — nothing to fetch from anyway, treat as not allowed
  }
  if (resolved.length === 0) return false;
  return resolved.every((address) => isPublicAddress(address));
}

/** Reserved/private IPv4 ranges checked as [start, end] inclusive 32-bit integers, plus IPv6 ranges checked by prefix below. Not exhaustive — see this module's own doc comment. */
const IPV4_RESERVED_RANGES: Array<[string, string]> = [
  ["0.0.0.0", "0.255.255.255"], // "this" network
  ["10.0.0.0", "10.255.255.255"], // RFC1918
  ["100.64.0.0", "100.127.255.255"], // carrier-grade NAT
  ["127.0.0.0", "127.255.255.255"], // loopback
  ["169.254.0.0", "169.254.255.255"], // link-local (includes cloud metadata endpoints)
  ["172.16.0.0", "172.31.255.255"], // RFC1918
  ["192.0.0.0", "192.0.0.255"], // IETF protocol assignments
  ["192.0.2.0", "192.0.2.255"], // documentation (TEST-NET-1)
  ["192.168.0.0", "192.168.255.255"], // RFC1918
  ["198.18.0.0", "198.19.255.255"], // benchmarking
  ["198.51.100.0", "198.51.100.255"], // documentation (TEST-NET-2)
  ["203.0.113.0", "203.0.113.255"], // documentation (TEST-NET-3)
  ["224.0.0.0", "255.255.255.255"], // multicast + reserved + broadcast
];

function ipv4ToInt(address: string): number {
  const parts = address.split(".").map((p) => Number(p));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Expands a (possibly `::`-compressed) IPv6 address into its 8 hex groups, or `undefined` if it isn't well-formed enough to expand — `isIP()` having already confirmed it's a valid IPv6 literal, this only has to handle the compression syntax itself. */
function expandIPv6Groups(address: string): string[] | undefined {
  if (address.includes("::")) {
    const sides = address.split("::");
    if (sides.length !== 2) return undefined; // "::" may appear at most once in a valid address
    const left = sides[0].length > 0 ? sides[0].split(":") : [];
    const right = sides[1].length > 0 ? sides[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return undefined;
    return [...left, ...Array(missing).fill("0"), ...right];
  }
  const groups = address.split(":");
  return groups.length === 8 ? groups : undefined;
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const value = ipv4ToInt(address);
    return !IPV4_RESERVED_RANGES.some(([start, end]) => value >= ipv4ToInt(start) && value <= ipv4ToInt(end));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::1" || normalized === "::") return false; // loopback / unspecified

    const groups = expandIPv6Groups(normalized);
    if (groups) {
      const firstGroupValue = parseInt(groups[0], 16);
      if (firstGroupValue >= 0xfe80 && firstGroupValue <= 0xfebf) return false; // link-local fe80::/10
      if (firstGroupValue >= 0xfc00 && firstGroupValue <= 0xfdff) return false; // unique local fc00::/7

      // An embedded IPv4 address, in either of its two forms — found by review across two rounds:
      // the first fix here only recognized the IPv4-mapped form (::ffff:a.b.c.d, group 5 == "ffff")
      // via ad-hoc regexes on the dotted-decimal *or* hex-group string forms; it missed the older,
      // deprecated IPv4-compatible form (::a.b.c.d, no "ffff" marker at all — e.g. ::127.0.0.1,
      // which `new URL(...)` normalizes to "::7f00:1"), which fell through to the generic "public"
      // return below undetected. Expanding to 8 groups first and checking prefixes numerically
      // (rather than pattern-matching the compressed string) covers both forms — and any other
      // equivalent-but-differently-compressed spelling of the same address — uniformly. "Zero"
      // groups are compared by parsed numeric value, not a fixed string set (found by a second
      // review round: a set of just `{"0", "0000"}` would silently miss the equally valid `"00"`/
      // `"000"` spellings of the same zero group, an IPv6 text form `expandIPv6Groups()` doesn't
      // rule out even though neither of this module's two real callers — `URL`'s own serializer,
      // `dns.lookup()`'s `inet_ntop` — happens to ever produce it).
      const isZeroGroup = (g: string): boolean => parseInt(g, 16) === 0;
      const isIPv4Mapped = groups.slice(0, 5).every(isZeroGroup) && groups[5] === "ffff";
      const isIPv4Compatible = groups.slice(0, 6).every(isZeroGroup);
      if (isIPv4Mapped || isIPv4Compatible) {
        const high = groups[6].padStart(4, "0");
        const low = groups[7].padStart(4, "0");
        const ipv4 = `${parseInt(high.slice(0, 2), 16)}.${parseInt(high.slice(2, 4), 16)}.${parseInt(low.slice(0, 2), 16)}.${parseInt(low.slice(2, 4), 16)}`;
        return isPublicAddress(ipv4);
      }
    }
    return true;
  }
  return false; // not a recognizable IP literal — treat conservatively as not public
}
