"use client";

import dynamic from "next/dynamic";
import type { MapPoint } from "../../lib/map-points";

interface MapClientProps {
  points: MapPoint[];
  /** Not plotted (see lib/map-points.ts's toMapPoints() doc comment on why nodes have no coordinates to plot) — shown as a one-line note instead so an operator isn't left wondering why the node count on Elenco doesn't match anything visible here. */
  nodeCount: number;
  /**
   * One message per section (SOS/hazard-info/relay) that failed to load — found by review: the first
   * version only checked for a `config`-level failure, so a single section's query failing (a
   * transient Postgres hiccup, `lib/db.ts`'s own per-section `Promise.allSettled`) silently rendered
   * a map missing exactly those pins with no indication anything was wrong, unlike the Elenco tab
   * (app/page.tsx), which already shows this per-panel. Empty array = nothing failed.
   */
  partialErrors: string[];
}

// Leaflet touches `window`/`document` at import time, so the actual map must never run during SSR or
// the Next.js build's server-side render — `next/dynamic` with `ssr: false` is only usable from a
// Client Component (this one), not directly from mappa/page.tsx's Server Component, hence this thin
// wrapper existing at all.
const LeafletMap = dynamic(() => import("./LeafletMap").then((m) => m.LeafletMap), {
  ssr: false,
  loading: () => <div className="map-loading">Caricamento mappa…</div>,
});

export function MapClient({ points, nodeCount, partialErrors }: MapClientProps): JSX.Element {
  return (
    <>
      {partialErrors.length > 0 && (
        <div className="panel error" style={{ margin: "14px 28px 0" }}>
          <strong>Alcuni dati potrebbero mancare su questa mappa.</strong>
          <p>{partialErrors.join(" · ")}</p>
        </div>
      )}
      <div className="notice">
        <div className="notice-inner">
          <span>
            {points.length === 0
              ? "Nessuna posizione da mostrare al momento."
              : `${points.length} elementi geolocalizzati su questa mappa.`}{" "}
            I {nodeCount} nodi elencati in &ldquo;Elenco&rdquo; non hanno una posizione propria sincronizzata e non compaiono qui.
          </span>
        </div>
      </div>
      <div className="map-container">
        <LeafletMap points={points} />
      </div>
    </>
  );
}
