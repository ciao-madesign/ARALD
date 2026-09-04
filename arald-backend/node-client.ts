/**
 * HTTP client toward one ARALD node's `WebUiServer` (`node/src/web-ui.ts`),
 * treated as an external contract — plain `fetch()` against the same public
 * JSON endpoints any browser/mobile client already uses, deliberately never
 * an import from `node/src/*`. This is what a real future "ARALD Box"
 * bridge (`docs/emergency-portal.md`) would have to do anyway: it runs on a
 * different machine than the node it reads from, so it can only ever see
 * the node's HTTP surface, never its in-process types.
 *
 * Every field pulled from a response is validated defensively before use —
 * same posture this codebase applies to anything payload-shaped that
 * crosses a trust boundary (`CLAUDE.md`, "Convenzioni consolidate") — a
 * malformed or unexpected entry is dropped and counted, never allowed to
 * crash the sync or reach a SQL query un-typed.
 */

export interface NodeCredentials {
  /** Base URL of the node's WebUiServer, e.g. `http://127.0.0.1:8080` — no trailing slash. */
  nodeUrl: string;
  /**
   * The node's network password (`WebUiOptions.networkPassword`) — required
   * only for `/api/relays` and `/api/emergency-beacons`, which are gated
   * behind it (`docs/emergency-portal.md`'s own note: "manca solo un client
   * che li invochi da Internet"). Omit to sync only the always-public
   * endpoints (`/api/status`, `/api/drops`, `/api/node-appends`).
   */
  networkPassword?: string;
}

export interface RelayRow {
  relayId: string;
  type: "fixed" | "mobile";
  lat: number;
  lon: number;
  online: boolean;
}

export interface EmergencyBeaconRow {
  beaconContentId: string;
  deviceId: string;
  message?: string;
  lat?: number;
  lon?: number;
  timestamp: number;
}

export interface DropRow {
  dropId: string;
  author: string;
  text: string;
  lat: number;
  lon: number;
  kind: string;
}

export interface NodeAppendRow {
  appendId: string;
  text: string;
  kind: string;
  timestamp: number;
}

export interface StatusRow {
  nodeId: string;
  displayName: string;
  connected: boolean;
  peers: number;
  relaying: boolean;
}

export interface NodeSnapshot {
  status?: StatusRow;
  relays: RelayRow[];
  emergencyBeacons: EmergencyBeaconRow[];
  drops: DropRow[];
  nodeAppends: NodeAppendRow[];
  /** Endpoints that returned 404 (not exposed by this node, e.g. `exposeRelayRegistry` off) or were skipped for lack of a network password — reported so the caller can tell "empty" from "not available", same distinction the mobile UI's capability-gated panels already make. */
  skipped: string[];
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Never throws for an HTTP-level response, whatever its status — only for a
 * genuine transport failure (connection refused, timeout) or a `200` whose
 * body isn't valid JSON. Every endpoint this module calls is meant to keep
 * going when one of its *siblings* fails (see `fetchNodeSnapshot()`'s own
 * doc comment) — deciding what a given status code means for a given
 * endpoint (a 404 means something different on `/api/relays`, gated behind
 * a feature flag, than it would on `/api/status`, which is always on) is
 * each caller's job, never this function's.
 */
async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status === 204 || !res.ok) return { status: res.status, body: undefined };
    return { status: res.status, body: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asArray(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [];
}

function extractRelayRow(raw: unknown): RelayRow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.relayId !== "string" || r.relayId.length === 0) return undefined;
  if (r.type !== "fixed" && r.type !== "mobile") return undefined;
  if (!isFiniteNumber(r.lat) || !isFiniteNumber(r.lon)) return undefined;
  if (typeof r.online !== "boolean") return undefined;
  return { relayId: r.relayId, type: r.type, lat: r.lat, lon: r.lon, online: r.online };
}

function extractEmergencyBeaconRow(raw: unknown): EmergencyBeaconRow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.beaconContentId !== "string" || r.beaconContentId.length === 0) return undefined;
  if (typeof r.deviceId !== "string" || r.deviceId.length === 0) return undefined;
  if (!isFiniteNumber(r.timestamp)) return undefined;
  return {
    beaconContentId: r.beaconContentId,
    deviceId: r.deviceId,
    message: typeof r.message === "string" ? r.message : undefined,
    lat: isFiniteNumber(r.lat) ? r.lat : undefined,
    lon: isFiniteNumber(r.lon) ? r.lon : undefined,
    timestamp: r.timestamp,
  };
}

function extractDropRow(raw: unknown): DropRow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.dropId !== "string" || r.dropId.length === 0) return undefined;
  if (typeof r.author !== "string" || typeof r.text !== "string") return undefined;
  if (!isFiniteNumber(r.lat) || !isFiniteNumber(r.lon)) return undefined;
  if (typeof r.kind !== "string") return undefined;
  return { dropId: r.dropId, author: r.author, text: r.text, lat: r.lat, lon: r.lon, kind: r.kind };
}

function extractNodeAppendRow(raw: unknown): NodeAppendRow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.appendId !== "string" || r.appendId.length === 0) return undefined;
  if (typeof r.text !== "string" || typeof r.kind !== "string") return undefined;
  if (!isFiniteNumber(r.timestamp)) return undefined;
  return { appendId: r.appendId, text: r.text, kind: r.kind, timestamp: r.timestamp };
}

function extractStatusRow(raw: unknown): StatusRow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.nodeId !== "string" || r.nodeId.length === 0) return undefined;
  if (typeof r.displayName !== "string" || typeof r.connected !== "boolean") return undefined;
  if (!isFiniteNumber(r.peers) || typeof r.relaying !== "boolean") return undefined;
  return { nodeId: r.nodeId, displayName: r.displayName, connected: r.connected, peers: r.peers, relaying: r.relaying };
}

/** Fetches every endpoint this sync cares about from one node. Never throws for a single missing/unauthorized endpoint — records it in `skipped` instead, same "degrade, don't crash" posture as the rest of this codebase's network-facing code. Does throw if the node itself is unreachable (wrong `nodeUrl`, node not running) or `/api/status` itself is malformed — those mean there is nothing useful to sync at all. */
export async function fetchNodeSnapshot(creds: NodeCredentials): Promise<NodeSnapshot> {
  const base = creds.nodeUrl.replace(/\/$/, "");
  const skipped: string[] = [];

  const statusRes = await fetchJson(`${base}/api/status`);
  const status = extractStatusRow(statusRes.body);
  if (statusRes.status !== 200) {
    // /api/status is always on (never gated behind a flag) — anything but 200 here means the node
    // itself is unreachable or badly broken, not "one optional endpoint is off": there is nothing
    // useful left to sync, so this is the one case where fetchNodeSnapshot() throws rather than
    // recording a skip and moving on.
    throw new Error(`${base}/api/status returned ${statusRes.status} instead of 200 — is the node running and reachable?`);
  }
  if (!status) {
    throw new Error(`${base}/api/status returned an unrecognized shape`);
  }

  const [dropsRes, appendsRes] = await Promise.all([fetchJson(`${base}/api/drops`), fetchJson(`${base}/api/node-appends`)]);
  let drops: DropRow[] = [];
  let nodeAppends: NodeAppendRow[] = [];
  if (dropsRes.status === 200) {
    drops = asArray(dropsRes.body).map(extractDropRow).filter((v): v is DropRow => v !== undefined);
  } else {
    skipped.push(`/api/drops (unexpected status ${dropsRes.status})`);
  }
  if (appendsRes.status === 200) {
    nodeAppends = asArray(appendsRes.body).map(extractNodeAppendRow).filter((v): v is NodeAppendRow => v !== undefined);
  } else {
    skipped.push(`/api/node-appends (unexpected status ${appendsRes.status})`);
  }

  let relays: RelayRow[] = [];
  let emergencyBeacons: EmergencyBeaconRow[] = [];

  if (!creds.networkPassword) {
    skipped.push("/api/relays (no network password provided)", "/api/emergency-beacons (no network password provided)");
  } else {
    const authHeader = { Authorization: `Bearer ${creds.networkPassword}` };
    const [relaysRes, beaconsRes] = await Promise.all([
      fetchJson(`${base}/api/relays`, authHeader),
      fetchJson(`${base}/api/emergency-beacons`, authHeader),
    ]);
    if (relaysRes.status === 200) {
      relays = asArray(relaysRes.body).map(extractRelayRow).filter((v): v is RelayRow => v !== undefined);
    } else if (relaysRes.status === 404) {
      skipped.push("/api/relays (not exposed by this node)");
    } else if (relaysRes.status === 401) {
      skipped.push("/api/relays (wrong network password)");
    } else {
      skipped.push(`/api/relays (unexpected status ${relaysRes.status})`);
    }
    if (beaconsRes.status === 200) {
      emergencyBeacons = asArray(beaconsRes.body).map(extractEmergencyBeaconRow).filter((v): v is EmergencyBeaconRow => v !== undefined);
    } else if (beaconsRes.status === 404) {
      skipped.push("/api/emergency-beacons (not exposed by this node)");
    } else if (beaconsRes.status === 401) {
      skipped.push("/api/emergency-beacons (wrong network password)");
    } else {
      skipped.push(`/api/emergency-beacons (unexpected status ${beaconsRes.status})`);
    }
  }

  return { status, relays, emergencyBeacons, drops, nodeAppends, skipped };
}
