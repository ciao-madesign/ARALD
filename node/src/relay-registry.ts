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

  /** Creates or updates the static fields for `fields.relayId` — a relay can be re-registered (e.g. physically moved, operator changed) without losing its current online/lastSeenAt state. */
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

  get(relayId: string): RelayEntry | undefined {
    return this.relays.get(relayId);
  }

  list(): RelayEntry[] {
    return [...this.relays.values()];
  }
}
