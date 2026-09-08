import { BoundedFifoMap } from "./bounded-map.js";

/** Free-text operator/organization label — bounded so an authenticated but careless caller can't stuff an unbounded string into a small registry. Same order of magnitude as other short free-text fields in this codebase (not `MAX_MESSAGE_TEXT_LENGTH`, which is for chat bodies, not a one-line label). */
export const MAX_RELAY_OPERATOR_LENGTH = 200;

/**
 * The static fields an operator provides once, at install time, for a
 * physical Fixed or Mobile Relay (`docs/beacon.md`, "Fixed Relay e Registro
 * dei relay") — never mesh-propagated, never self-announced by the relay
 * over radio: the operator who is physically standing in front of the
 * hardware already knows all of this, so it's entered directly through an
 * authenticated HTTP endpoint on whichever node exposes the registry
 * (`web-ui.ts`'s `exposeRelayRegistry`), the same way a `POST /api/drops`
 * caller enters a drop.
 *
 * `relayId` is deliberately the relay's own cryptographic `nodeId`
 * (`identity.ts`), not a separate operator-assigned identifier — this
 * project's `nodeId` is already the primary key for every other structure
 * (`PeerDirectory`, `TrustManager`, `publisherId` on content/drops/channel
 * messages...), and reusing it here is what lets the dynamic "online" state
 * below be derived directly from `NomadNode.peers` without a second id
 * scheme to keep in sync. `docs/beacon.md`'s own wording ("Relay ID
 * univoco") doesn't mandate an opaque separate id, and using the nodeId is
 * simpler and free.
 */
export interface RelayStaticFields {
  relayId: string;
  type: "fixed" | "mobile";
  lat: number;
  lon: number;
  /** Radio capabilities the relay carries — both optional, default to `false` when omitted (never assumed present). */
  radio?: { ble?: boolean; lora?: boolean };
  /** Free-text operator/organization label (e.g. "Soccorso Alpino, sezione X") — optional, bounded by `MAX_RELAY_OPERATOR_LENGTH`. */
  operator?: string;
  /** Install date, ms epoch. Optional — defaults to `Date.now()` at registration time if omitted. Unlike `LocationReportPayload.timestamp`, this is purely descriptive metadata (never used for ordering/anti-poisoning decisions), so trusting a caller-supplied value here is fine. */
  installedAt?: number;
}

/**
 * A registered relay as stored and returned to a reader — static fields
 * with `radio`/`installedAt` fully resolved (defaults applied), plus the
 * dynamic fields `RelayRegistry` itself derives from real mesh connectivity
 * (see the class doc comment below).
 */
export interface RelayEntry {
  relayId: string;
  type: "fixed" | "mobile";
  lat: number;
  lon: number;
  radio: { ble: boolean; lora: boolean };
  operator?: string;
  installedAt: number;
  /** Whether `relayId` is currently a connected mesh peer of the node holding this registry. */
  online: boolean;
  /** Last time this relay was seen connecting or disconnecting — `undefined` if it has never been observed as a peer since being registered (e.g. registered in advance of ever coming online). */
  lastSeenAt?: number;
  /** Last self-reported battery level, 0-100 (`RelayTelemetryPayload`, `NomadNode.reportRelayTelemetry()`) — `undefined` if this relay has never sent telemetry, or was never configured to report one (`RelayPolicyOptions.getResourceState`). Distinct from `online`/`lastSeenAt`: a relay can be online with no known battery level (telemetry is opt-in and self-declared, spec §51 — there is no way to *derive* it from mesh connectivity the way online/offline is derived). */
  batteryPercent?: number;
  /** When `batteryPercent` was last updated, by the reporting relay's own clock (clamped, see `recordTelemetry()`) — `undefined` until the first telemetry report arrives. */
  lastTelemetryAt?: number;
}

/**
 * The `PRIVATE_MESSAGE` payload shape a relay's self-reported telemetry has
 * — discriminated by `type: "relay-telemetry"`, same pattern as
 * `LocationReportPayload`/`NodeAppendPayload`: a relay reports its own
 * battery level to whichever node holds the registry it discovered via
 * `service://relay-registry` (`NomadNode.registerAsRelayRegistry()`/
 * `reportRelayTelemetry()`), reusing `PRIVATE_MESSAGE`'s existing
 * ECDH-derived per-peer encryption exactly as-is — no new packet type, no
 * new signing scheme, same reasoning already applied to a location report.
 *
 * `batteryPercent` is read from `RelayPolicy.getCurrentResourceState()` —
 * the *same* self-declared value (spec §51, no real hardware sensors in
 * this prototype) that already governs whether this node relays at all
 * under `RelayMode "battery-above"`, reused here instead of a second,
 * independent battery-reporting channel.
 */
export interface RelayTelemetryPayload {
  type: "relay-telemetry";
  batteryPercent: number;
  timestamp: number;
}

/**
 * Validates and extracts relay telemetry from an already-decrypted
 * `PRIVATE_MESSAGE` payload — same defensive posture as every other
 * network-sourced payload in this codebase (`extractLocationReport()`,
 * `extractDropPayload()`): never trusted just because it decrypted/parsed
 * successfully. Returns `undefined` for anything not shaped exactly like
 * valid telemetry.
 */
export function extractRelayTelemetry(payload: unknown): RelayTelemetryPayload | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (p.type !== "relay-telemetry") return undefined;
  if (typeof p.batteryPercent !== "number" || !Number.isFinite(p.batteryPercent) || p.batteryPercent < 0 || p.batteryPercent > 100) return undefined;
  if (typeof p.timestamp !== "number" || !Number.isFinite(p.timestamp)) return undefined;
  return { type: "relay-telemetry", batteryPercent: p.batteryPercent, timestamp: p.timestamp };
}

/**
 * The `PRIVATE_MESSAGE` payload shape a remote relay command has —
 * discriminated by `type: "relay-command"`, same directed-delivery pattern
 * as `NodeAppendPayload`. **Deliberately the single most sensitive payload
 * in this codebase** (`NomadNode.considerRelayCommand()` gates it on
 * `minTrustForRelayCommand`, default `TrustLevel.ADMIN` — the highest level
 * `TrustManager` can assign, stricter than every other gated feature here):
 * unlike a Node Append (deposits content to be read later) or a location
 * report (records a position), accepting this payload causes the *receiving
 * process itself* to shut down (`NomadNode` only ever emits
 * `"relay:reboot-requested"` — it never calls `process.exit()` itself, see
 * that event's own doc comment in `node.ts`).
 *
 * `command` is a closed union of exactly one value today (`"reboot"`) —
 * kept as a discriminated field rather than a boolean specifically so a
 * future second command doesn't need a second payload shape/extractor, the
 * same reasoning `DropKind`/`NodeAppendPayload.kind` already follow.
 * Deliberately **not** an OTA/firmware-update mechanism — that was
 * evaluated and explicitly rejected as too high-risk for this project's
 * current trust model (see `docs/beacon.md`, "Cosa manca davvero" — an
 * update requires an operator physically connected to the hardware).
 */
export interface RelayCommandPayload {
  type: "relay-command";
  command: "reboot";
  timestamp: number;
}

/**
 * Validates and extracts a relay command from an already-decrypted
 * `PRIVATE_MESSAGE` payload — same defensive posture as
 * `extractRelayTelemetry()` above. Returns `undefined` for anything not
 * shaped exactly like a valid command, including an unrecognized `command`
 * value (forward-compatible rejection, same as `extractDropPayload()`'s
 * exact-match check on `kind`).
 */
export function extractRelayCommand(payload: unknown): RelayCommandPayload | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (p.type !== "relay-command") return undefined;
  if (p.command !== "reboot") return undefined;
  if (typeof p.timestamp !== "number" || !Number.isFinite(p.timestamp)) return undefined;
  return { type: "relay-command", command: p.command, timestamp: p.timestamp };
}

/**
 * Validates and extracts relay registration fields from an untyped HTTP
 * request body — same defensive posture as every other externally-sourced
 * payload in this codebase (`extractLocationReport()`, `extractDropPayload()`):
 * `payload` is never trusted just because the request was authenticated.
 * Returns `undefined` for anything that isn't shaped like a valid
 * registration. Range/type checks on `lat`/`lon` mirror `extractLocationReport()`.
 */
export function extractRelayRegistration(payload: unknown): RelayStaticFields | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.relayId !== "string" || p.relayId.length === 0 || p.relayId.length > 200) return undefined;
  if (p.type !== "fixed" && p.type !== "mobile") return undefined;
  if (typeof p.lat !== "number" || !Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) return undefined;
  if (typeof p.lon !== "number" || !Number.isFinite(p.lon) || p.lon < -180 || p.lon > 180) return undefined;

  let radio: { ble?: boolean; lora?: boolean } | undefined;
  if (p.radio !== undefined) {
    if (!p.radio || typeof p.radio !== "object") return undefined;
    const r = p.radio as Record<string, unknown>;
    if (r.ble !== undefined && typeof r.ble !== "boolean") return undefined;
    if (r.lora !== undefined && typeof r.lora !== "boolean") return undefined;
    radio = { ble: r.ble as boolean | undefined, lora: r.lora as boolean | undefined };
  }

  let operator: string | undefined;
  if (p.operator !== undefined) {
    if (typeof p.operator !== "string" || p.operator.length === 0 || p.operator.length > MAX_RELAY_OPERATOR_LENGTH) return undefined;
    operator = p.operator;
  }

  let installedAt: number | undefined;
  if (p.installedAt !== undefined) {
    if (typeof p.installedAt !== "number" || !Number.isFinite(p.installedAt)) return undefined;
    installedAt = p.installedAt;
  }

  return { relayId: p.relayId, type: p.type, lat: p.lat, lon: p.lon, radio, operator, installedAt };
}

export interface RelayRegistryOptions {
  /** Max distinct relays tracked at once (spec §57 resource limits). */
  maxRelays?: number;
}

const DEFAULT_MAX_RELAYS = 512;

/**
 * A registry of physically-deployed Fixed/Mobile Relay hardware
 * (`docs/beacon.md`, "Fixed Relay e Registro dei relay") — static metadata
 * (position, type, radio capabilities, operator, install date) entered once
 * by whoever installs a relay, plus a dynamic online/last-seen state this
 * class derives itself from real mesh connectivity. Same architectural
 * placement as `LocationRegistry`/`Drops` — pure mesh-adjacent local state,
 * `node/src/`, never `gateway/nomad/`/`nomad-hub/` (this never talks to
 * Project NOMAD or Docker).
 *
 * **Two real differences from `LocationRegistry`, both deliberate:**
 *
 * 1. **No lazy expiry.** `LocationRegistry`/`Drops` both expire an entry
 *    after `maxReportAgeMs`/`expiresAt` — appropriate for a report/post that
 *    goes stale just by the passage of time. A physical relay installation
 *    doesn't: a Fixed Relay that hasn't been re-registered in months is
 *    still installed exactly where it was, it just might currently be
 *    offline (which `online`/`lastSeenAt` already say honestly). Expiring
 *    the *registration itself* on a timer would make the registry forget
 *    real hardware for no reason other than nobody walked past it recently.
 * 2. **No `trustRank`/`evictionScore`.** `LocationRegistry`/`Drops` are fed
 *    by packets from arbitrary mesh peers, so eviction is weighted by trust
 *    to resist a peer manufacturing throwaway identities to evict
 *    legitimate entries (`docs/security.md`, bug #13). Every write here
 *    instead comes through an HTTP endpoint gated by the node's own network
 *    password (`web-ui.ts`'s `exposeRelayRegistry`) — an authenticated
 *    operator, not an arbitrary mesh peer — so plain FIFO eviction under
 *    `maxRelays` pressure is enough; the bound itself still exists per this
 *    project's blanket "every remotely-writable structure is bounded"
 *    convention (spec §57), not because this input is adversarial.
 *
 * **`recordTelemetry()` is the one real mesh-fed write this class has** (a
 * relay self-reports its own battery level over `PRIVATE_MESSAGE`, not
 * through the authenticated HTTP endpoint) — deliberately restricted to
 * *updating* an already-registered `relayId`, never creating a new entry,
 * so it can't be turned into a second, unauthenticated write path into a
 * structure whose eviction policy assumes every entry came from an operator
 * (see that method's own doc comment).
 *
 * **Online/offline derivation, by design kept out of this class**: this
 * class has zero dependency on `NomadNode` — `markOnline()`/`markOffline()`
 * are plain methods a caller invokes. `NomadNode` itself does the wiring
 * (its constructor subscribes to its own `"peer:connected"`/
 * `"peer:disconnected"` events and forwards the peer id here), which keeps
 * `RelayRegistry` fully unit-testable without spinning up a real node or
 * transport. Marking online/offline for a `relayId` that isn't registered
 * is a cheap no-op (a `Map` miss) — the overwhelming majority of peer
 * connect/disconnect events are not relays at all.
 */
export class RelayRegistry {
  private readonly relays: BoundedFifoMap<string, RelayEntry>;

  constructor(options: RelayRegistryOptions = {}) {
    this.relays = new BoundedFifoMap({ maxSize: options.maxRelays ?? DEFAULT_MAX_RELAYS });
  }

  /**
   * Creates or updates the static fields for `fields.relayId` — a relay can
   * be re-registered (e.g. physically moved, operator changed) without
   * losing its current online/lastSeenAt *or* telemetry state (`batteryPercent`/
   * `lastTelemetryAt` also carried forward from `existing`, same as
   * `online`/`lastSeenAt` — found by review: an earlier version of this
   * method rebuilt the entry from `fields` alone, silently discarding
   * already-recorded telemetry on every ordinary re-registration, e.g. an
   * operator correcting a typo'd `operator` label).
   */
  upsert(fields: RelayStaticFields): RelayEntry {
    const existing = this.relays.get(fields.relayId);
    const entry: RelayEntry = {
      relayId: fields.relayId,
      type: fields.type,
      lat: fields.lat,
      lon: fields.lon,
      radio: { ble: fields.radio?.ble ?? false, lora: fields.radio?.lora ?? false },
      operator: fields.operator,
      installedAt: fields.installedAt ?? Date.now(),
      online: existing?.online ?? false,
      lastSeenAt: existing?.lastSeenAt,
      batteryPercent: existing?.batteryPercent,
      lastTelemetryAt: existing?.lastTelemetryAt,
    };
    this.relays.set(fields.relayId, entry);
    return entry;
  }

  /** No-op if `relayId` isn't a registered relay. */
  markOnline(relayId: string, at: number = Date.now()): void {
    const entry = this.relays.get(relayId);
    if (!entry) return;
    this.relays.set(relayId, { ...entry, online: true, lastSeenAt: at });
  }

  /** No-op if `relayId` isn't a registered relay. `lastSeenAt` still advances on disconnect — the moment a relay drops off is itself real, recent contact, not a reason to forget when it was last seen. */
  markOffline(relayId: string, at: number = Date.now()): void {
    const entry = this.relays.get(relayId);
    if (!entry) return;
    this.relays.set(relayId, { ...entry, online: false, lastSeenAt: at });
  }

  /**
   * Records self-reported telemetry (currently just `batteryPercent`) from
   * `relayId` — **no-op if `relayId` isn't already a registered relay**,
   * same deliberate restriction as `markOnline()`/`markOffline()`: this
   * registry only ever knows about relays an authenticated operator
   * explicitly registered via `upsert()` (an HTTP write behind the node's
   * own network password), and must never silently grow a new entry just
   * because *some* mesh peer sent a telemetry-shaped `PRIVATE_MESSAGE`
   * claiming a `relayId` — that would let an arbitrary peer fabricate
   * unbounded distinct "relay" entries this class has no trust-weighted
   * eviction to defend against (`relay-registry.ts`'s own class doc comment
   * explains why plain FIFO is safe *only* because every write today is
   * operator-authenticated; telemetry from the open mesh must not become a
   * second, unauthenticated write path into the same structure).
   *
   * Same anti-out-of-order/anti-future-timestamp guards as
   * `LocationRegistry.record()` (see that method's own doc comment for the
   * full reasoning — store-and-forward delay means a stale telemetry report
   * can arrive after a newer one already did, and a fabricated far-future
   * timestamp must never be able to permanently poison a relay's slot): a
   * report older than or equal to the entry's current `lastTelemetryAt` is
   * silently ignored, and `report.timestamp` is clamped to never exceed
   * this node's own `Date.now()`.
   */
  recordTelemetry(relayId: string, report: RelayTelemetryPayload): void {
    const entry = this.relays.get(relayId);
    if (!entry) return;
    const timestamp = Math.min(report.timestamp, Date.now());
    if (entry.lastTelemetryAt !== undefined && entry.lastTelemetryAt >= timestamp) return;
    this.relays.set(relayId, { ...entry, batteryPercent: report.batteryPercent, lastTelemetryAt: timestamp });
  }

  get(relayId: string): RelayEntry | undefined {
    return this.relays.get(relayId);
  }

  list(): RelayEntry[] {
    return [...this.relays.values()];
  }
}
