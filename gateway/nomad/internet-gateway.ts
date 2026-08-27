import type { NomadNode } from "../../node/src/node.js";
import { BoundedFifoMap } from "../../node/src/bounded-map.js";
import { trustRank } from "../../node/src/trust.js";
import { parseFeed, MAX_FEED_BYTES } from "./rss-feed.js";
import { fetchTextBounded } from "./fetch-bounded.js";
import { isPubliclyRoutableUrl } from "./url-safety.js";

/** Bounds `rateLimitState`/`globalRateLimitState` — this gateway's own tracked-peer state (spec §57), same reasoning `NewsGateway.publishedById` documents: a hostile/rotating set of caller node ids must not grow this map forever. */
const MAX_TRACKED_RATE_LIMIT_PEERS = 4096;

/** Default per-caller request budget — see `InternetGatewayOptions.maxRequestsPerPeerPerWindow`. */
const DEFAULT_MAX_REQUESTS_PER_PEER_PER_WINDOW = 10;
/** Default budget across *every* caller combined — see `InternetGatewayOptions.maxRequestsPerWindow`, and the doc comment on `checkRateLimit()` for why this exists in addition to the per-peer one. */
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 60;
const DEFAULT_WINDOW_MS = 60_000;
/** Default cap on a single fetched response's size for `kind: "text"` — `kind: "rss"` uses `MAX_FEED_BYTES` (`rss-feed.ts`) instead, since `parseFeed()` already assumes content within that bound. */
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

export type InternetFetchKind = "rss" | "text";

export interface InternetGatewayOptions {
  /**
   * Hostnames (exact match, case-insensitive, no wildcards) allowed for
   * `kind: "text"` requests — the primary safety boundary for that kind,
   * since unlike `kind: "rss"` (gated by `parseFeed()` rejecting anything
   * that isn't a real feed) arbitrary text has no content-shape barrier of
   * its own. No default list is shipped — an operator opts a domain in
   * explicitly, the same posture `NewsGateway`'s `feedUrl`/`emergencyCategory`
   * already have for "the operator configures what they trust, not the
   * codebase". Empty/omitted means `kind: "text"` never succeeds.
   */
  allowedTextHosts?: string[];
  /** See `DEFAULT_MAX_REQUESTS_PER_PEER_PER_WINDOW`. */
  maxRequestsPerPeerPerWindow?: number;
  /** See `DEFAULT_MAX_REQUESTS_PER_WINDOW`. */
  maxRequestsPerWindow?: number;
  /** See `DEFAULT_WINDOW_MS`. */
  windowMs?: number;
  /** See `DEFAULT_MAX_RESPONSE_BYTES`. Only applies to `kind: "text"` — `kind: "rss"` is capped by `MAX_FEED_BYTES` instead. */
  maxResponseBytes?: number;
}

interface InternetFetchResult {
  contentId: string;
  mimeType: string;
  size: number;
}

interface RateWindow {
  windowStart: number;
  count: number;
}

/**
 * `service://internet-fetch` — a deliberately narrow "Internet senza
 * Internet" gateway (`docs/next-steps.md`, discussione con l'utente 25
 * agosto 2026): a node with real Internet access opts in to fetching a
 * *curated* set of request shapes on behalf of the mesh, never arbitrary
 * web browsing. Two `kind`s, each with a fundamentally different safety
 * boundary:
 * - `"rss"`: no domain allowlist — the barrier is that `parseFeed()`
 *   (`rss-feed.ts`, already hardened across "Nomad News evoluto") must
 *   successfully parse the response as a real RSS/Atom feed, or the
 *   request fails outright. Nothing that isn't feed-shaped can ever come
 *   back through this path.
 * - `"text"`: gated by `allowedTextHosts` instead — plain text has no
 *   content-shape barrier of its own (it can encode anything), so the
 *   operator's own explicit allowlist is the entire safety boundary for
 *   this kind, not a convenience on top of a smarter check.
 *
 * Every request also passes `isPubliclyRoutableUrl()` first, regardless of
 * `kind` — a `kind: "rss"` request has no host allowlist, so without this
 * a caller could still make this node's own network probe internal
 * infrastructure the operator's machine can reach (SSRF), even though the
 * *content* of such a probe could never come back (see `url-safety.ts`).
 *
 * A successful fetch is published as `content://` (same pattern
 * `NewsGateway`/`KiwixGateway` already use) rather than returned inline in
 * the `SERVICE_RESPONSE` — a service response today travels in a single
 * packet (~2MB practical ceiling), while `publishContent()` gets the
 * existing chunked transfer, size bounds, and mesh-wide caching for free.
 * The response is therefore just a reference (`contentId`/`mimeType`/`size`);
 * the caller fetches the actual bytes via the ordinary `getContent()` cycle.
 */
export class InternetGateway {
  private readonly allowedTextHosts: Set<string>;
  private readonly maxRequestsPerPeerPerWindow: number;
  private readonly maxRequestsPerWindow: number;
  private readonly windowMs: number;
  private readonly maxResponseBytes: number;
  /** Keyed by the unauthenticated caller id (`fromNodeId`) — bounded and weighted by trust, same convention `CLAUDE.md` requires for every network-fed/identity-keyed structure (`PeerDirectory`/`RemoteCatalog`/`MessageHistory`/`PublicChannels` all pass `trustRank(this.trust.get(...))`, found missing here by review): once `MAX_TRACKED_RATE_LIMIT_PEERS` is reached, eviction prefers dropping the least-trusted tracked caller's window rather than plain FIFO, so a low-trust identity can't cheaply evict a legitimate, higher-trust caller's rate-limit tracking just by being seen more recently. */
  private readonly rateLimitState: BoundedFifoMap<string, RateWindow>;
  private globalRateLimitState: RateWindow = { windowStart: 0, count: 0 };

  constructor(
    private readonly node: NomadNode,
    options: InternetGatewayOptions = {},
  ) {
    this.allowedTextHosts = new Set((options.allowedTextHosts ?? []).map((h) => h.toLowerCase()));
    this.maxRequestsPerPeerPerWindow = options.maxRequestsPerPeerPerWindow ?? DEFAULT_MAX_REQUESTS_PER_PEER_PER_WINDOW;
    this.maxRequestsPerWindow = options.maxRequestsPerWindow ?? DEFAULT_MAX_REQUESTS_PER_WINDOW;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.rateLimitState = new BoundedFifoMap<string, RateWindow>({
      maxSize: MAX_TRACKED_RATE_LIMIT_PEERS,
      evictionScore: (peerId) => trustRank(this.node.trust.get(peerId)),
    });
  }

  /** Registers `service://internet-fetch` — see the class doc comment for the full contract. Rejects (never resolves with an error payload) on any validation/rate-limit/fetch failure, same convention as every other service handler in this codebase — `callService()`'s caller sees the rejection reason as-is. */
  registerInternetFetchService(): void {
    this.node.registerService("service://internet-fetch", "1.0.0", ["rss", "text"], async (payload, fromNodeId) => {
      return this.handleFetch(payload, fromNodeId);
    });
  }

  private async handleFetch(payload: unknown, fromNodeId: string): Promise<InternetFetchResult> {
    const { kind, url } = validateRequest(payload);
    const parsedUrl = new URL(url); // already proven parseable by validateRequest()

    // Free (no I/O), so checked before the rate-limit budget is touched — a request naming a host
    // outside the allowlist is rejected at zero cost, same reasoning as validateRequest() above.
    if (kind === "text") {
      const host = parsedUrl.hostname.toLowerCase();
      if (!this.allowedTextHosts.has(host)) {
        throw new Error(`host non presente nella allowlist di questo gateway: ${host}`);
      }
    }

    // Found by a second review round: isPubliclyRoutableUrl() itself is NOT free — for a hostname
    // that isn't an IP literal it performs a real DNS lookup, real I/O with a real (if small) cost.
    // A first fix here moved checkRateLimit() past the free checks above but left it *after* this
    // SSRF guard too, so a flood of requests naming distinct non-allowlisted-anyway or arbitrary
    // hostnames could still queue unbounded DNS lookups completely unbounded by either rate-limit
    // layer. The budget is consumed here instead — after every genuinely free check, but before the
    // first one that actually costs something (this SSRF guard, then the fetch itself for a request
    // that clears it) — so both real-work steps below are bounded by it, not just the fetch.
    this.checkRateLimit(fromNodeId);

    if (!(await isPubliclyRoutableUrl(parsedUrl))) {
      throw new Error("URL non consentito: schema non supportato o indirizzo privato/riservato");
    }

    if (kind === "rss") {
      const xml = await fetchTextBounded(url, MAX_FEED_BYTES);
      if (!parseFeed(xml)) throw new Error("il contenuto scaricato non è un feed RSS/Atom valido");
      // publishContent() signs with *this gateway node's own* identity — the resulting content://
      // signature attests "this node downloaded these bytes from this URL just now", never anything
      // about the origin site itself (which signed nothing and isn't part of the mesh's trust model
      // at all). A receiving peer trusts the gateway's attestation, not the destination site.
      const metadata = this.node.publishContent(`internet-fetch (rss): ${url}`, "application/xml", Buffer.from(xml, "utf8"));
      return { contentId: metadata.contentId, mimeType: "application/xml", size: metadata.size };
    }

    // kind === "text" — same signing-attestation caveat as the "rss" branch above.
    const text = await fetchTextBounded(url, this.maxResponseBytes);
    const metadata = this.node.publishContent(`internet-fetch (text): ${url}`, "text/plain", Buffer.from(text, "utf8"));
    return { contentId: metadata.contentId, mimeType: "text/plain", size: metadata.size };
  }

  /**
   * Two layers, both required: a per-caller budget (`maxRequestsPerPeerPerWindow`,
   * default 10/min) and a budget across *every* caller combined
   * (`maxRequestsPerWindow`, default 60/min). The per-caller layer alone
   * isn't enough — `fromNodeId` is a `SERVICE_REQUEST` packet's own
   * `source` field, not cryptographically authenticated (`CLAUDE.md`,
   * "Binding crittografico"), so a determined attacker can trivially
   * rotate fake source ids to dodge a per-identity limit entirely. The
   * global layer is the real backstop: it can't be evaded by changing
   * identity, and directly bounds the actual outbound traffic/requests
   * this operator's node will ever make in aggregate, regardless of how
   * many distinct (real or fabricated) callers are asking.
   */
  private checkRateLimit(peerId: string): void {
    const now = Date.now();

    if (now - this.globalRateLimitState.windowStart >= this.windowMs) {
      this.globalRateLimitState = { windowStart: now, count: 0 };
    }
    if (this.globalRateLimitState.count >= this.maxRequestsPerWindow) {
      throw new Error("service://internet-fetch: limite di richieste della mesh raggiunto, riprova più tardi");
    }

    const entry = this.rateLimitState.get(peerId);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.rateLimitState.set(peerId, { windowStart: now, count: 1 });
    } else {
      if (entry.count >= this.maxRequestsPerPeerPerWindow) {
        throw new Error("service://internet-fetch: limite di richieste per questo nodo raggiunto, riprova più tardi");
      }
      entry.count++;
    }

    this.globalRateLimitState.count++;
  }
}

/** Validates an `internet-fetch` request payload defensively — never trusts its shape (`CLAUDE.md`: the payload of a call is exactly as untrusted as any network-sourced value). Throws with a message safe to surface to the caller as-is (same convention as every other service handler here). */
function validateRequest(payload: unknown): { kind: InternetFetchKind; url: string } {
  if (!payload || typeof payload !== "object") throw new Error("richiesta non valida: payload mancante");
  const { kind, url } = payload as { kind?: unknown; url?: unknown };
  if (kind !== "rss" && kind !== "text") {
    throw new Error(`kind non supportato: ${typeof kind === "string" ? kind : JSON.stringify(kind)}`);
  }
  if (typeof url !== "string" || url.length === 0) throw new Error("url mancante o non valido");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("url malformato");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("schema non supportato: solo http/https");
  return { kind, url };
}
