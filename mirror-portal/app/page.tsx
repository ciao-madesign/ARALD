import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getMirrorSnapshot, type MirrorSectionError, type MirrorSnapshot } from "../lib/db";
import { toMapPoints } from "../lib/map-points";
import { roleLabel } from "../lib/format";
import { buildAttentionFeed, summarizeFleet } from "../lib/node-status";
import { PortalHeader } from "./PortalHeader";
import { MapClient } from "./mappa/MapClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function sectionError(errors: MirrorSectionError[], section: MirrorSectionError["section"]): string | undefined {
  return errors.find((e) => e.section === section)?.message;
}

const SECTION_LABELS: Record<Exclude<MirrorSectionError["section"], "config">, string> = {
  nodes: "nodi",
  beacons: "SOS",
  drops: "hazard/info",
  relays: "relay",
  // "Consegna esterna differita" destinations never put a pin on this map (no lat/lon of their own) —
  // included only because SECTION_LABELS' own type requires every non-"config" section, not because
  // this page ever surfaces a "destinations" failure to the operator.
  destinations: "destinazioni",
};

/**
 * Mirror Portal map-centrica (docs/ux-ui-design-system.md §9: "Il Mirror Portal deve essere
 * progettato principalmente come strumento di situational awareness. La mappa deve assumere
 * maggiore importanza rispetto alle card." — priorità 1 mappa, 2 emergenze, 3 stato dei nodi).
 * `/` è ora questa schermata (prima era "Elenco" — spostato su `/elenco`, `app/elenco/page.tsx`):
 * la prima cosa che un operatore vede dopo il login è la mappa, non una tabella. `PortalHeader`'s
 * tab "Elenco"/"Mappa" sono stati scambiati di conseguenza (vedi il suo stesso commento).
 */
export default async function HomePage(): Promise<JSX.Element> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const organizationId = session.user.role === "admin" ? undefined : session.user.organizationId ?? "";

  let snapshot: MirrorSnapshot;
  try {
    snapshot = await getMirrorSnapshot(organizationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    snapshot = { nodes: [], relays: [], beacons: [], drops: [], destinations: [], errors: [{ section: "config", message }] };
  }

  const configError = sectionError(snapshot.errors, "config");
  const points = configError ? [] : toMapPoints(snapshot);
  const nodeCount = snapshot.nodes.length;

  // Ogni sezione che influisce davvero su questa schermata — non più solo le tre che mettono un pin
  // sulla mappa (beacons/drops/relays): "nodes" è stata aggiunta qui (trovato da code-review --level
  // high) perché l'AttentionBar sotto dipende da `snapshot.nodes` (stato dei nodi, "priorità 3" della
  // specifica) tanto quanto la mappa dipende dalle altre tre. Un fallimento della query nodi azzera
  // silenziosamente `fleet`/`attentionFeed` (entrambi derivati da un array vuoto) — senza "nodes" in
  // questo elenco l'operatore vedrebbe una mappa "pulita" senza alcun avviso, nonostante lo stato di
  // ogni nodo sia in realtà sconosciuto: un falso tutto-ok proprio sulla schermata pensata per la
  // situational awareness.
  const partialErrors: string[] = [];
  if (!configError) {
    for (const section of ["nodes", "beacons", "drops", "relays"] as const) {
      const message = sectionError(snapshot.errors, section);
      if (message) partialErrors.push(`${SECTION_LABELS[section]}: ${message}`);
    }
  }

  // "Priorità 3: stato dei nodi" (docs/ux-ui-design-system.md §9) — un nodo non ha mai coordinate
  // proprie (lib/map-points.ts's toMapPoints() stessa onestà), quindi non può mai avere un pin sulla
  // mappa: il suo stato (offline, o un SOS/hazard senza posizione) resterebbe altrimenti invisibile
  // su questa schermata, nonostante sia proprio la priorità subito sotto la mappa stessa. Riusa
  // `summarizeFleet()`/`buildAttentionFeed()` già esistenti (app/elenco/page.tsx, nessuna nuova
  // query) invece di duplicarne la logica — stesso feed, due presentazioni diverse: qui una singola
  // riga compatta (MapClient's AttentionBar), lì la lista completa.
  const fleet = summarizeFleet(snapshot.nodes, snapshot.relays, snapshot.drops, snapshot.beacons, snapshot.destinations);
  const attentionFeed = buildAttentionFeed(fleet);

  return (
    <>
      <PortalHeader
        userEmail={session.user.email ?? ""}
        roleLabel={roleLabel(session.user.role)}
        active="mappa"
        isAdmin={session.user.role === "admin"}
      />

      {configError ? (
        <main className="content">
          <div className="content-inner">
            <div className="panel error">
              <strong>Impossibile leggere i dati dello specchio.</strong>
              <p>{configError}</p>
            </div>
          </div>
        </main>
      ) : (
        <MapClient points={points} nodeCount={nodeCount} partialErrors={partialErrors} attentionFeed={attentionFeed} />
      )}
    </>
  );
}
