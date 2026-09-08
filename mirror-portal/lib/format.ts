/**
 * Pure display-formatting helpers, kept separate from `db.ts` specifically
 * so they can be unit tested (`tests/unit/mirror-portal-format.test.ts`)
 * without a live Postgres connection or a React render — the same
 * "separate the pure logic from the I/O" split this codebase already
 * applies elsewhere (e.g. `arald-backend/node-client.ts`'s extractors vs.
 * its `fetch()` calls).
 *
 * Every field read here ultimately comes from `data jsonb`, itself
 * whatever a `node-client.ts` snapshot happened to contain when synced —
 * already validated there before it ever reached Postgres, but treated
 * defensively again on the way out: a jsonb column has no schema
 * enforcement of its own, so a row written by an older/different version
 * of the sync script could still have missing or differently-shaped
 * fields by the time this reads it back.
 */

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A node's display name if the synced status snapshot has one, its raw id otherwise — mirrors `getContactName()`'s fallback-to-id pattern in `mobile/www/app.js`. */
export function nodeDisplayName(data: Record<string, unknown>, nodeId: string): string {
  return asString(data.displayName) ?? nodeId;
}

/** `"45.8300, 7.6500"` when both coordinates are present and finite, `undefined` otherwise — never a partial/misleading pair (e.g. just latitude) rendered as if it were a full coordinate. */
export function formatCoords(data: Record<string, unknown>): string | undefined {
  const lat = asFiniteNumber(data.lat);
  const lon = asFiniteNumber(data.lon);
  if (lat === undefined || lon === undefined) return undefined;
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

/** An emergency beacon's message if it has one — a SOS is allowed to carry no text at all (`EmergencyBeaconPayload.message?`, `node/src/emergency-beacon.ts`), so this never fabricates placeholder content, only labels the absence. */
export function beaconMessage(data: Record<string, unknown>): string {
  return asString(data.message) ?? "(nessun messaggio)";
}

/** A drop's `kind` ("info"/"hazard"/"emergency", `DropKind`) normalized to a known value — an unrecognized or missing kind (a row from a future/older sync-script version) degrades to "info" rather than rendering something a viewer might mistake for a real severity level. */
export function dropKind(data: Record<string, unknown>): "info" | "hazard" | "emergency" {
  const kind = asString(data.kind);
  return kind === "hazard" || kind === "emergency" ? kind : "info";
}

/** A relay's `type` ("fixed"/"mobile", `RelayEntry.type`) normalized the same defensive way as `dropKind()` — defaults to "fixed" (the more common, longer-lived deployment) rather than guessing. */
export function relayType(data: Record<string, unknown>): "fixed" | "mobile" {
  return asString(data.type) === "mobile" ? "mobile" : "fixed";
}

/** Whether a relay's synced snapshot reported it online — a missing/non-boolean field (again, an older sync-script version's row) defaults to `false`, never `true`: an unknown online status should never be presented as "online" to an operator deciding whether a relay is actually reachable. */
export function relayOnline(data: Record<string, unknown>): boolean {
  return data.online === true;
}
