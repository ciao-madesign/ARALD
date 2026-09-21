import type { BeaconRow, DestinationRow, DropRow, NodeStatusRow, RelayRow } from "./db";
import { asFiniteNumber, dropKind } from "./format";

/**
 * Pure "fleet status" derivation for the Home page's Nodi panel (voce #80
 * — "Pezzo 0" of the canale di comando roadmap, `docs/emergency-portal.md`)
 * — kept separate from `page.tsx` for the same testability reason as
 * `map-points.ts` (`lib/map-points.ts`'s own doc comment): no live
 * Postgres, no React render, plain arrays in and out.
 *
 * Deliberately reads nothing new from Postgres: `services` rides inside
 * the same `node_status_snapshots.data` blob `arald-backend/postgres-
 * sync.ts` already writes (one row per node, no new table), and "avviso"
 * is derived from `drops`/`beacons` `getMirrorSnapshot()` already fetches
 * for the SOS/Hazard panels above — this file only re-groups data the page
 * already has, per node, so an operator can tell at a glance which Box
 * needs attention without opening the Mappa or scrolling the SOS list.
 */

export interface ServiceSummary {
  serviceId: string;
  version: string;
  availability: boolean;
}

export interface NodeAlert {
  kind: "hazard" | "emergency" | "sos";
  text: string;
  timestamp: number;
}

export interface NodeFleetStatus {
  nodeUrl: string;
  nodeId: string;
  displayName: string;
  connected: boolean;
  internet?: "ONLINE" | "OFFLINE";
  localNetwork?: "ONLINE" | "OFFLINE";
  peers?: number;
  /** Only services this node itself hosts (`isLocal`) — a service this node merely knows about via mesh gossip says nothing about the Box's own health. */
  services: ServiceSummary[];
  /**
   * Present only when exactly one `relays` row has `relayId === nodeId` and
   * is registered as `type: "fixed"` — `relayId` is deliberately the
   * relay's own cryptographic `nodeId` (`relay-registry.ts`'s own doc
   * comment), so this is a real identity match, not a guess. Matching on
   * `RelayRow.nodeUrl` instead (which Box's `/api/relays` endpoint this row
   * was synced *from*) would be wrong: `RelayRegistry` is "un campo sempre
   * presente su ogni NomadNode, con l'esposizione HTTP come opt-in separato
   * su qualunque nodo l'operatore scelga" (`docs/beacon.md`) — a fleet can
   * (and in practice often does) register every relay, including several
   * Boxes' own self-entries, on one shared node's registry. `nodeUrl`
   * matching would then either never find a Box's own entry at all (it
   * lives in a *different* Box's registry) or, worse, silently attribute a
   * companion physical relay's battery to the wrong Box whenever that
   * Box's own registry happens to hold exactly one unrelated `"fixed"`
   * entry (found by review). More than one "fixed" relay sharing this
   * `nodeId` — which should never happen given `relay_id` is the Postgres
   * primary key — or none at all, leaves both fields `undefined` rather
   * than picking one arbitrarily: an ambiguous match is worse than an
   * honest "not available".
   */
  batteryPercent?: number;
  relayOnline?: boolean;
  /**
   * `true` exactly when the same `ownRelays.length === 1` match above found a `"fixed"` registry
   * entry for this node — the one signal `RemoteRelayCommandForm` (Pezzo 4, "riavvio remoto Fixed
   * Relay", `docs/security.md` voce #83) gates its own visibility on, per the user's own original
   * request ("solo verso i relay fissi, mai Mobile Relay/Card"). Deliberately its own boolean field
   * rather than inferring "fixed" from `batteryPercent`/`relayOnline` being defined — those two can
   * independently be `undefined` for a genuine fixed relay (e.g. `online` missing from its own
   * telemetry) without that meaning "not a fixed relay".
   */
  isFixedRelay: boolean;
  /** Most recent hazard/emergency drops and SOS beacons attributed to this node's `nodeUrl`, newest first — the "avviso" an operator needs to see at a glance, per the piece's own brief. Bounded by whatever `getMirrorSnapshot()` already capped `drops`/`beacons` to (`RECENT_LIST_LIMIT`), not re-capped here. */
  alerts: NodeAlert[];
  /**
   * "Consegna esterna differita" destinations this exact Box owns and offers, password-less only —
   * "Pezzo 3" del canale di comando (`docs/security.md` voce #84). Filtered on `boxNodeId === nodeId`
   * (same identity-match reasoning `isFixedRelay` above already gives for `ownRelays`, not `nodeUrl`:
   * a single Box's own synced directory can carry entries mesh-propagated from *other* Boxes too,
   * `ExternalDeliveryDirectory`'s own doc comment) **and** `requiresPassword === false` — v1 scope,
   * decided explicitly with the user: a password-protected destination is simply never offered here,
   * not merely hidden behind a client-side check (`RemoteExternalDeliveryForm` never even receives
   * one to try). `publicKeyHex` is deliberately not exposed here — the API route re-derives it itself
   * server-side (`getExternalDeliveryDestination()`, `lib/auth-db.ts`) rather than trusting anything
   * this client-rendered list carries, same "server-side re-check" discipline `isFixedRelay` already
   * established for Pezzo 4.
   */
  externalDeliveryDestinations: Array<{ destinationId: string; label: string }>;
  /** When `node_status_snapshots` was last written for this Box (`NodeStatusRow.syncedAt`) — the one honest anchor available for "since when" on an offline entry in `buildAttentionFeed()` below: `postgres-sync.ts` only ever upserts this row on a *successful* poll (a Box that can't be reached at all leaves the row, and this timestamp, exactly where they were — `arald-backend/sync.ts`'s own "status snapshot: skipped (node unreachable or malformed)" log line), so an old `syncedAt` genuinely means "last time this Box was known reachable", not just "last time we happened to write a row". */
  syncedAt: Date;
}

function extractServiceSummary(raw: unknown): ServiceSummary | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.serviceId !== "string" || r.serviceId.length === 0) return undefined;
  if (typeof r.version !== "string" || typeof r.availability !== "boolean") return undefined;
  if (r.isLocal !== true) return undefined;
  return { serviceId: r.serviceId, version: r.version, availability: r.availability };
}

function extractServices(data: Record<string, unknown>): ServiceSummary[] {
  if (!Array.isArray(data.services)) return [];
  return data.services.map(extractServiceSummary).filter((s): s is ServiceSummary => s !== undefined);
}

function asOnlineState(value: unknown): "ONLINE" | "OFFLINE" | undefined {
  return value === "ONLINE" || value === "OFFLINE" ? value : undefined;
}

export function summarizeFleet(
  nodes: NodeStatusRow[],
  relays: RelayRow[],
  drops: DropRow[],
  beacons: BeaconRow[],
  destinations: DestinationRow[] = [],
): NodeFleetStatus[] {
  return nodes.map((node) => {
    const ownRelays = relays.filter((r) => r.relayId === node.nodeId && r.data.type === "fixed");
    const externalDeliveryDestinations = destinations
      .filter((d) => d.boxNodeId === node.nodeId && d.data.requiresPassword === false)
      .map((d) => ({
        destinationId: d.destinationId,
        label: typeof d.data.label === "string" && d.data.label.length > 0 ? d.data.label : d.destinationId,
      }));
    const battery = ownRelays.length === 1 ? asFiniteNumber(ownRelays[0].data.batteryPercent) : undefined;
    const online = ownRelays.length === 1 && typeof ownRelays[0].data.online === "boolean" ? (ownRelays[0].data.online as boolean) : undefined;

    const dropAlerts: NodeAlert[] = drops
      .filter((d) => d.nodeUrl === node.nodeUrl && dropKind(d.data) !== "info")
      .map((d) => ({
        kind: dropKind(d.data) as "hazard" | "emergency",
        text: typeof d.data.text === "string" ? d.data.text : "",
        timestamp: asFiniteNumber(d.data.timestamp) ?? 0,
      }));
    const sosAlerts: NodeAlert[] = beacons
      .filter((b) => b.nodeUrl === node.nodeUrl)
      .map((b) => ({
        kind: "sos" as const,
        text: typeof b.data.message === "string" && b.data.message.length > 0 ? b.data.message : "(nessun messaggio)",
        timestamp: asFiniteNumber(b.data.timestamp) ?? 0,
      }));
    const alerts = [...dropAlerts, ...sosAlerts].sort((a, b) => b.timestamp - a.timestamp);

    return {
      nodeUrl: node.nodeUrl,
      nodeId: node.nodeId,
      displayName: typeof node.data.displayName === "string" && node.data.displayName.length > 0 ? node.data.displayName : node.nodeId,
      connected: node.data.connected === true,
      internet: asOnlineState(node.data.internet),
      localNetwork: asOnlineState(node.data.localNetwork),
      peers: asFiniteNumber(node.data.peers),
      services: extractServices(node.data),
      batteryPercent: battery,
      relayOnline: online,
      isFixedRelay: ownRelays.length === 1,
      alerts,
      externalDeliveryDestinations,
      syncedAt: node.syncedAt,
    };
  });
}

/**
 * "Richiede attenzione ora" — the Home page's unified triage feed (Fase 5 del piano di audit UX/UI,
 * `docs/next-steps.md`, risolve P2 #10: "nessuna vista aggregata ... richiede aprire più pannelli").
 * Flattens every node's own `alerts` (already SOS+hazard+emergency, per-node) across the whole fleet,
 * plus one synthetic "offline" entry per node whose last-known `connected` was false — same field the
 * existing Nodi panel already renders as an online/offline tag, reused here rather than inventing a
 * new "hasn't synced in N minutes" staleness heuristic with no documented sync cadence to base a
 * threshold on (this repository's own standing rule against presenting an unverified guess as real).
 */
export interface AttentionItem {
  kind: "sos" | "emergency" | "hazard" | "offline";
  nodeDisplayName: string;
  /** Empty for "offline" — there's no message to show, just the node name and `since`. */
  text: string;
  /**
   * ms since epoch: the alert's own event time for sos/emergency/hazard, `syncedAt` for offline (see
   * `NodeFleetStatus.syncedAt`'s own doc comment for why that's an honest "since" instead of a
   * fabricated duration). For sos/emergency/hazard this is `NodeAlert.timestamp`, i.e. whatever the
   * originating mesh packet self-declared (`DropPayload.timestamp`/`EmergencyBeaconPayload.timestamp`)
   * — not authenticated, same trust posture `summarizeFleet()`'s own `alerts` array already had before
   * this feed existed (the Nodi panel's `topAlert` ordering already relies on it). Flagged honestly
   * here rather than left unstated (found by review): a forged/skewed event timestamp can currently
   * distort where an item lands within its own severity bucket, or make a stale alert read as
   * "adesso" — a pre-existing limitation this feed inherits, not one it introduces or was designed
   * to close; revisiting it means changing `summarizeFleet()`'s ordering too, out of this phase's scope.
   */
  since: number;
}

const ATTENTION_SEVERITY_RANK: Record<AttentionItem["kind"], number> = { sos: 0, emergency: 1, hazard: 2, offline: 3 };

export function buildAttentionFeed(fleet: NodeFleetStatus[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const f of fleet) {
    for (const alert of f.alerts) items.push({ kind: alert.kind, nodeDisplayName: f.displayName, text: alert.text, since: alert.timestamp });
    if (!f.connected) items.push({ kind: "offline", nodeDisplayName: f.displayName, text: "", since: f.syncedAt.getTime() });
  }
  // Same severity order the wireframe fixes (SOS, poi Hazard/emergency, poi Box offline); within a
  // severity, most recent first — matches how `alerts` is already ordered per node above.
  return items.sort((a, b) => ATTENTION_SEVERITY_RANK[a.kind] - ATTENTION_SEVERITY_RANK[b.kind] || b.since - a.since);
}
