"use client";

import dynamic from "next/dynamic";
import type { MapPoint } from "../../lib/map-points";
import { attentionItemText, type AttentionItem } from "../../lib/node-status";

interface MapClientProps {
  points: MapPoint[];
  /** Not plotted (see lib/map-points.ts's toMapPoints() doc comment on why nodes have no coordinates to plot) — shown as a one-line note instead so an operator isn't left wondering why the node count on Elenco doesn't match anything visible here. */
  nodeCount: number;
  /**
   * One message per section (SOS/hazard-info/relay) that failed to load — found by review: the first
   * version only checked for a `config`-level failure, so a single section's query failing (a
   * transient Postgres hiccup, `lib/db.ts`'s own per-section `Promise.allSettled`) silently rendered
   * a map missing exactly those pins with no indication anything was wrong, unlike the Elenco tab,
   * which already shows this per-panel. Empty array = nothing failed.
   */
  partialErrors: string[];
  /**
   * "Priorità 3: stato dei nodi" (docs/ux-ui-design-system.md §9) — un Box offline, o un SOS/hazard
   * senza coordinate proprie, non avrebbe altrimenti alcuna visibilità su questa schermata (nessun
   * pin possibile, vedi `points` sopra). Stesso feed di `app/elenco/page.tsx` (`buildAttentionFeed()`,
   * nessuna nuova query), presentato qui come una singola riga compatta (`AttentionBar` sotto) invece
   * della lista completa — questa schermata privilegia "cosa sta succedendo adesso" sulla quantità di
   * dettaglio (§10), il dettaglio completo resta su "Elenco". Vuoto = niente da segnalare, nessuna
   * barra mostrata.
   */
  attentionFeed: AttentionItem[];
}

// Leaflet touches `window`/`document` at import time, so the actual map must never run during SSR or
// the Next.js build's server-side render — `next/dynamic` with `ssr: false` is only usable from a
// Client Component (this one), not directly from page.tsx's Server Component, hence this thin
// wrapper existing at all.
const LeafletMap = dynamic(() => import("./LeafletMap").then((m) => m.LeafletMap), {
  ssr: false,
  loading: () => <div className="map-loading">Caricamento mappa…</div>,
});

/**
 * Riga singola, compatta (mai una lista che cresce): mostra solo la voce più urgente del feed
 * (`buildAttentionFeed()` ordina già per severità) più un conteggio totale, con un link al dettaglio
 * completo. Lo stesso principio "cosa sta succedendo adesso, non tutto il possibile" della mappa
 * stessa (§10), applicato qui.
 */
function AttentionBar({ feed }: { feed: AttentionItem[] }): JSX.Element | null {
  if (feed.length === 0) return null;
  const top = feed[0];
  return (
    <div className="map-attention-bar">
      <span className="sos-badge sos-badge-sm" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4">
          <line x1="12" y1="7" x2="12" y2="13" />
          <circle cx="12" cy="17" r="0.9" fill="#fff" stroke="none" />
        </svg>
      </span>
      <span className="map-attention-text">
        <strong>{feed.length} {feed.length > 1 ? "richiedono" : "richiede"} attenzione ora</strong>
        {" — "}
        {attentionItemText(top)}
      </span>
      <a href="/elenco" className="map-attention-link">
        Vedi tutto →
      </a>
    </div>
  );
}

export function MapClient({ points, nodeCount, partialErrors, attentionFeed }: MapClientProps): JSX.Element {
  return (
    // .map-screen (flex column, altezza nota solo per header+nav sopra di lei — vedi globals.css)
    // invece di sottrarre magic number separati per ciascun banner che può comparire qui
    // (notice/partialErrors/AttentionBar, tutti di altezza realisticamente variabile): un bug reale
    // trovato da code-review --level high, la versione precedente sottraeva solo l'altezza
    // dell'AttentionBar e ignorava quella del banner `partialErrors` quando entrambi comparivano
    // insieme, rischiando di spingere la mappa sotto il fold su schermi stretti. Con `.map-container`
    // ora `flex: 1 1 auto`, qualunque numero di banner sopra di lei — uno, due, nessuno — lascia
    // sempre e solo lo spazio verticale che resta davvero, mai un calcolo da tenere sincronizzato a
    // mano con ogni nuovo elemento che si aggiunge in futuro.
    <div className="map-screen">
      {partialErrors.length > 0 && (
        <div className="panel error" style={{ margin: "14px 28px 0" }}>
          <strong>Alcuni dati potrebbero mancare su questa mappa.</strong>
          <p>{partialErrors.join(" · ")}</p>
        </div>
      )}
      <AttentionBar feed={attentionFeed} />
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
    </div>
  );
}
