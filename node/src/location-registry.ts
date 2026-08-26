import { BoundedFifoMap } from "./bounded-map.js";

/**
 * The `PRIVATE_MESSAGE` payload shape a location report has — discriminated
 * by `type: "location-report"`, same pattern as `GroupInvitePayload`
 * (groups.ts): a location report is intrinsically 1:1 (a person sharing
 * their own position with one specific registry node they've chosen to
 * trust), so it reuses `PRIVATE_MESSAGE`'s existing ECDH-derived per-peer
 * encryption exactly as-is — no new packet type, no new transport crypto.
 * `timestamp` is captured once by the sender (`NomadNode.shareLocation()`,
 * `Date.now()`), never trusted from an HTTP client — the same reasoning
 * already applied to `ChannelMessagePayload.timestamp`/`GroupMessage.timestamp`.
 */
export interface LocationReportPayload {
  type: "location-report";
  lat: number;
  lon: number;
  /** Meters, if the sender's device reported one — optional, never required. */
  accuracy?: number;
  timestamp: number;
}

/**
 * Validates and extracts a location report from an already-decrypted
 * `PRIVATE_MESSAGE` payload — same defensive posture as every other
 * network-sourced payload in this codebase (`extractChatText()`,
 * `extractGroupInvite()`): `payload` is never trusted just because it
 * decrypted/parsed successfully. Returns `undefined` for anything that
 * isn't shaped exactly like a valid report — rejected, not crashed.
 */
export function extractLocationReport(payload: unknown): LocationReportPayload | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (p.type !== "location-report") return undefined;
  if (typeof p.lat !== "number" || !Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) return undefined;
  if (typeof p.lon !== "number" || !Number.isFinite(p.lon) || p.lon < -180 || p.lon > 180) return undefined;
  let accuracy: number | undefined;
  if (p.accuracy !== undefined) {
    if (typeof p.accuracy !== "number" || !Number.isFinite(p.accuracy) || p.accuracy < 0) return undefined;
    accuracy = p.accuracy;
  }
  if (typeof p.timestamp !== "number" || !Number.isFinite(p.timestamp)) return undefined;
  return { type: "location-report", lat: p.lat, lon: p.lon, accuracy, timestamp: p.timestamp };
}

/** A location report as stored locally and returned to a reader — `reporterId` is the cryptographically-authenticated sender (`PRIVATE_MESSAGE`'s `packet.source`, trustworthy because it successfully decrypted with the ECDH-derived shared key only that sender and this node share), never a field out of the payload itself. */
export interface LocationReport {
  reporterId: string;
  lat: number;
  lon: number;
  accuracy?: number;
  timestamp: number;
}

export interface LocationRegistryOptions {
  /** Max distinct reporters tracked at once (spec §57 resource limits). */
  maxReports?: number;
  /**
   * A report older than this (by its own `timestamp`, compared against
   * `Date.now()` at access time — never a background sweep, same lazy-expiry
   * convention already used by `ContentStore`/`RemoteCatalog`/`ServiceDirectory`)
   * is treated as absent: an old, possibly-stale position is never shown as
   * if it were current. Omit to never expire a report on its own (only
   * eviction under `maxReports` pressure removes one).
   */
  maxReportAgeMs?: number;
  /** Same eviction convention as every other network-fed structure in this codebase (bounded-map.ts) — ranks a reporter for eviction by the trust of whoever sent the report. Omit for plain FIFO (oldest reporter first). */
  trustRank?: (reporterId: string) => number;
}

const DEFAULT_MAX_REPORTS = 256;

/**
 * Local, mesh-internal state for opportunistically-shared positions — a
 * consent-gated feature (`docs/next-steps.md` Opzione J "tracciamento
 * posizione"), never automatic: a report only ever lands here because its
 * sender explicitly chose, in the moment, to call `shareLocation()`
 * (`NomadNode`) toward this specific node. Same architectural placement as
 * `Groups`/`PublicChannels`/`MessageHistory` — pure mesh-internal state, not
 * an adapter to something external, so it lives in `node/src/`, not
 * `gateway/nomad/`.
 *
 * **Retention, by explicit user decision**: only the single latest report
 * per reporter — `record()` overwrites the previous entry for the same
 * `reporterId`, never accumulates a history (this is not a chat log), but
 * only when the incoming report is actually newer (see `record()`'s own
 * doc comment for why a delay-tolerant mesh needs that ordering guard).
 *
 * **Read access, by explicit user decision**: this class itself enforces
 * nothing about who may read it — the access-control boundary lives one
 * layer up, in `web-ui.ts`'s `exposeLocationRegistry` option (an operator
 * opt-in, separate from and independent of `allowServiceCalls`) plus its
 * own network password. A naive "check the caller's TrustLevel inside a
 * `service://...` handler" design was considered and rejected: a
 * `SERVICE_REQUEST`'s `fromNodeId` is not cryptographically authenticated
 * (`service.ts`'s own doc comment on `ServiceHandler`, same known limit as
 * `packet.source`), so it's spoofable — trivially defeating a trust check
 * built on it. Gating on a *separate node's own HTTP password* instead
 * reuses an already-audited mechanism (`docs/security.md` voce #24) with no
 * new network protocol and no new spoofing surface.
 *
 * Bounded on `maxReports` distinct reporters (spec §57) — a noisy or
 * compromised contact could otherwise share unlimited distinct reporter
 * identities (a new PRIVATE_MESSAGE sender each time) without limit.
 */
export class LocationRegistry {
  private readonly reports: BoundedFifoMap<string, LocationReport>;
  private readonly maxReportAgeMs: number | undefined;

  constructor(options: LocationRegistryOptions = {}) {
    this.maxReportAgeMs = options.maxReportAgeMs;
    const trustRank = options.trustRank;
    this.reports = new BoundedFifoMap({
      maxSize: options.maxReports ?? DEFAULT_MAX_REPORTS,
      evictionScore: trustRank ? (reporterId: string) => trustRank(reporterId) : undefined,
    });
  }

  /**
   * Records (overwriting any previous entry for the same `reporterId` —
   * never accumulates) a report from `reporterId` — unless a report already
   * on file for that reporter has a timestamp at least as recent, in which
   * case this is a silent no-op (found by review). This mesh is
   * delay-tolerant with store-and-forward (spec §30): a report that was
   * queued because no route existed yet can be relayed and arrive *after* a
   * later report the sender already managed to deliver via a faster path —
   * without this guard, that stale, out-of-order delivery would silently
   * regress (or, combined with `maxReportAgeMs`, even erase) an
   * already-recorded newer position. Same bug class already found and fixed
   * once before in this codebase for the same underlying reason
   * (`docs/security.md`, `NewsGateway.startAutoSync()`'s `syncGeneration`
   * guard against an out-of-order sync response).
   *
   * `report.timestamp` is also clamped to never exceed this node's own
   * `Date.now()` (found by review): without this, a single report bearing a
   * fabricated far-future timestamp would permanently poison this
   * reporter's slot — every subsequent genuine update would then lose the
   * ordering check above (an honest `Date.now()` can never catch up to a
   * fake one far enough in the future), and `isExpired()`'s `Date.now() -
   * report.timestamp` would stay negative forever, so `maxReportAgeMs`
   * could never reclaim it either. Clamping only ever pulls a claimed
   * timestamp backward toward "now", never forward, so it can't be used to
   * construct a report that appears newer than it really is.
   *
   * **Accepted limitation, not solved here (found by review)**: this
   * clamps against `Date.now()`, which Node does not guarantee is
   * monotonic — if *this* node's own system clock steps backward (an NTP
   * correction, a VM resume from an old snapshot), a report already
   * recorded under the earlier, larger clock reading can reject a
   * genuinely later report whose own sender-side timestamp is smaller than
   * that stale local reading, the same "stuck slot" symptom as the bug
   * above, until local time climbs back past it. Narrower and
   * self-recovering compared to that bug (bounded to whatever the clock
   * step was, not permanent, and never spreads beyond the one affected
   * reporter) — and not fully fixable by a local monotonic clock either,
   * since the deeper issue is unsynchronized wall clocks *across* nodes,
   * which this feature has no NTP-equivalent for. Same class of accepted,
   * documented trust-boundary limit as `packet.source` not being
   * cryptographically bound (`CLAUDE.md`) — a real edge case, but out of
   * proportion to defend against fully in this prototype.
   */
  record(reporterId: string, report: LocationReportPayload): void {
    const timestamp = Math.min(report.timestamp, Date.now());
    const existing = this.reports.get(reporterId);
    if (existing && existing.timestamp >= timestamp) return;
    this.reports.set(reporterId, { reporterId, lat: report.lat, lon: report.lon, accuracy: report.accuracy, timestamp });
  }

  private isExpired(report: LocationReport): boolean {
    return this.maxReportAgeMs !== undefined && Date.now() - report.timestamp > this.maxReportAgeMs;
  }

  /** The latest known report for `reporterId`, or `undefined` if none is known or it has expired (lazily evicted from the underlying map on this access, same convention as `ContentStore.get()`). */
  get(reporterId: string): LocationReport | undefined {
    const report = this.reports.get(reporterId);
    if (!report) return undefined;
    if (this.isExpired(report)) {
      this.reports.delete(reporterId);
      return undefined;
    }
    return report;
  }

  /** Every currently-known, non-expired report — expired ones are lazily evicted from the underlying map as part of this call, same convention as `ContentStore.list()`. */
  list(): LocationReport[] {
    const expired: string[] = [];
    const result: LocationReport[] = [];
    for (const report of this.reports.values()) {
      if (this.isExpired(report)) {
        expired.push(report.reporterId);
      } else {
        result.push(report);
      }
    }
    for (const reporterId of expired) this.reports.delete(reporterId);
    return result;
  }
}
