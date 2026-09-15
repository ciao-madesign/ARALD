import type { BeaconRow, DropRow, NodeStatusRow, RelayRow } from "./db";
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

export function summarizeFleet(nodes: NodeStatusRow[], relays: RelayRow[], drops: DropRow[], beacons: BeaconRow[]): NodeFleetStatus[] {
  return nodes.map((node) => {
    const ownRelays = relays.filter((r) => r.relayId === node.nodeId && r.data.type === "fixed");
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
    };
  });
}
