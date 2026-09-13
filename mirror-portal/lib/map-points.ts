import type { MirrorSnapshot } from "./db";
import { asFiniteNumber, beaconMessage, dropKind, formatDateTime, relayOnline, relayType } from "./format";

/**
 * Pure logic behind the Mappa screen (docs/security.md voce #75) — kept separate from
 * `app/mappa/page.tsx` for the exact reason `lib/format.ts`'s own doc comment already gives for
 * itself: so it can be unit tested without a live Postgres connection or a React/Next.js render.
 * Pulled out specifically after `toMapPoints()` living inline in `page.tsx` turned out to be
 * untestable from this repo's root vitest suite — that file also imports `next/navigation` and the
 * `@/auth` path alias (only resolvable inside Next.js's own build, not a plain Vite/vitest run), so
 * any test trying to import a function out of it failed to load the whole module graph. This file
 * imports only `./db` (types) and `./format` (already-pure helpers), nothing Next.js-specific.
 */

export interface MapPoint {
  id: string;
  kind: "sos" | "hazard" | "info" | "emergency" | "relay-on" | "relay-off";
  lat: number;
  lon: number;
  title: string;
  meta: string;
}

/**
 * Only beacons/drops/relays ever carry a real `{lat, lon}` in their synced `data` (same fields
 * `formatCoords()` reads) — a node's own status snapshot (`NodeStatusRow.data`, mirroring
 * `node/src/web-ui.ts`'s `/api/status`) has no location field at all in this codebase today, so
 * "Nodi" from the Elenco tab deliberately has no equivalent pin here. Not an oversight: fabricating a
 * position for a node would be presenting something as real that this mirror genuinely doesn't know
 * (CLAUDE.md's own rule against ever showing unverified data as if it were verified) — see
 * docs/next-steps.md for the idea of wiring a real node location into a future sync, if wanted.
 */
export function toMapPoints(snapshot: MirrorSnapshot): MapPoint[] {
  const points: MapPoint[] = [];

  for (const b of snapshot.beacons) {
    const lat = asFiniteNumber(b.data.lat);
    const lon = asFiniteNumber(b.data.lon);
    if (lat === undefined || lon === undefined) continue;
    points.push({
      id: `beacon-${b.beaconContentId}`,
      kind: "sos",
      lat,
      lon,
      title: beaconMessage(b.data),
      meta: `via ${b.nodeUrl} · ${formatDateTime(b.syncedAt)}`,
    });
  }

  for (const d of snapshot.drops) {
    const lat = asFiniteNumber(d.data.lat);
    const lon = asFiniteNumber(d.data.lon);
    if (lat === undefined || lon === undefined) continue;
    const kind = dropKind(d.data);
    points.push({
      id: `drop-${d.dropId}`,
      kind: kind === "emergency" ? "emergency" : kind === "hazard" ? "hazard" : "info",
      lat,
      lon,
      title: typeof d.data.text === "string" ? d.data.text : "(senza testo)",
      meta: formatDateTime(d.syncedAt),
    });
  }

  for (const r of snapshot.relays) {
    const lat = asFiniteNumber(r.data.lat);
    const lon = asFiniteNumber(r.data.lon);
    if (lat === undefined || lon === undefined) continue;
    const online = relayOnline(r.data);
    points.push({
      id: `relay-${r.relayId}`,
      kind: online ? "relay-on" : "relay-off",
      lat,
      lon,
      title: `${r.relayId} (${relayType(r.data)})`,
      meta: online ? `online · sync ${formatDateTime(r.syncedAt)}` : `offline · sync ${formatDateTime(r.syncedAt)}`,
    });
  }

  return points;
}
