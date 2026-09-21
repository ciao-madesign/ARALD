import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getMirrorSnapshot, type MirrorSectionError, type MirrorSnapshot } from "../lib/db";
import { dropKind, formatCoords, formatDateTime, relayOnline, relayType, timeAgo } from "../lib/format";
import { buildAttentionFeed, summarizeFleet } from "../lib/node-status";
import { PortalHeader } from "./PortalHeader";
import { RemoteDropForm } from "./RemoteDropForm";
import { RemoteNodeAppendForm } from "./RemoteNodeAppendForm";
import { RemoteRelayCommandForm } from "./RemoteRelayCommandForm";
import { RemoteExternalDeliveryForm } from "./RemoteExternalDeliveryForm";

// Never statically cached — a mirror whose whole point is showing what arald-backend/sync.ts most
// recently wrote would be actively misleading if Vercel served a stale build-time snapshot instead of
// querying Postgres on every request.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** The error message for one section, if `getMirrorSnapshot()` reported one — each panel below renders this instead of its list, so one section failing never hides the sections that loaded fine (`lib/db.ts`'s own doc comment on `MirrorSnapshot.errors`). */
function sectionError(errors: MirrorSectionError[], section: MirrorSectionError["section"]): string | undefined {
  return errors.find((e) => e.section === section)?.message;
}

export default async function HomePage(): Promise<JSX.Element> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // An Admin (organizationId === null) sees every organization's data — undefined tells
  // getMirrorSnapshot()/organizationFilterClause() to apply no filter at all. An Operatore always has
  // organizationId set (enforced by the users table's operatore_requires_org CHECK constraint), but this
  // stays defensive rather than asserting it — a null here degrades to "sees nothing" via an empty-string
  // filter that matches no node, never to "sees everything" the way an admin does.
  const organizationId = session.user.role === "admin" ? undefined : session.user.organizationId ?? "";

  let snapshot: MirrorSnapshot;
  try {
    snapshot = await getMirrorSnapshot(organizationId);
  } catch (err) {
    // getMirrorSnapshot() itself never throws for an expected failure (a missing DATABASE_URL or one
    // failing query both surface as snapshot.errors instead) — this is a last-resort net for a truly
    // unexpected exception, so the page still degrades to one panel rather than Next.js's generic
    // error screen. Never a raw stack trace to the browser either way.
    const message = err instanceof Error ? err.message : String(err);
    snapshot = { nodes: [], relays: [], beacons: [], drops: [], destinations: [], errors: [{ section: "config", message }] };
  }

  const configError = sectionError(snapshot.errors, "config");
  const nodesError = sectionError(snapshot.errors, "nodes");
  const relaysError = sectionError(snapshot.errors, "relays");
  const beaconsError = sectionError(snapshot.errors, "beacons");
  const dropsError = sectionError(snapshot.errors, "drops");

  // Re-groups data the four queries above already fetched (voce #80) — no new Postgres query, see
  // lib/node-status.ts's own doc comment for why. Rendered even when relaysError/beaconsError/
  // dropsError are set: a Box's own connection/services still matter on their own, and
  // summarizeFleet() degrades an empty relays/drops/beacons array to "nothing extra to show" rather
  // than throwing, same posture as every other section on this page.
  const fleet = summarizeFleet(snapshot.nodes, snapshot.relays, snapshot.drops, snapshot.beacons, snapshot.destinations);

  // "Richiede attenzione ora" (Fase 5 dell'audit UX/UI, docs/next-steps.md — risolve P2 #10): stessa
  // logica, nessuna nuova query — vedi buildAttentionFeed()'s own doc comment in lib/node-status.ts.
  const attentionFeed = buildAttentionFeed(fleet);

  return (
    <>
      <PortalHeader
        userEmail={session.user.email ?? ""}
        roleLabel={session.user.role === "admin" ? "Admin ARALD" : "Operatore"}
        active="elenco"
        isAdmin={session.user.role === "admin"}
      />

      <div className="notice">
        <div className="notice-inner">
          {/* currentColor invece di un esadecimale letterale (docs/security.md voce #88, trovato dalla
              revisione durante la migrazione token Waypoint) — .notice-inner già imposta `color:
              var(--muted)` sul contenitore, quindi l'icona segue sempre il token corrente invece di
              restare un valore vecchio ogni volta che la palette cambia. */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ marginTop: 1 }} aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="11" x2="12" y2="16" />
            <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
          </svg>
          <span>
            Vista di sola lettura, sincronizzata periodicamente da un ARALD Box (<code>arald-backend/sync.ts</code>). Il portale
            operativo vero gira sul Box stesso via LAN — questo è solo uno specchio per la gestione ordinaria da remoto, mai il
            punto da cui dipende l&rsquo;operatività sul posto.
          </span>
        </div>
      </div>

      {configError && (
        <main className="content">
          <div className="content-inner">
            <div className="panel error">
              <strong>Impossibile leggere i dati dello specchio.</strong>
              <p>{configError}</p>
            </div>
          </div>
        </main>
      )}

      {!configError && (
        <main className="content">
          <div className="content-inner">
            <section className="panel attention-panel">
              <div className="panel-head">
                <span className="sos-badge">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" aria-hidden="true">
                    <line x1="12" y1="7" x2="12" y2="13" />
                    <circle cx="12" cy="17" r="0.9" fill="#fff" stroke="none" />
                  </svg>
                </span>
                <span className="panel-title">Richiede attenzione ora</span>
                <span className="panel-count">({attentionFeed.length})</span>
              </div>
              {(beaconsError || dropsError) && (
                <p className="empty">
                  Impossibile caricare {[beaconsError && "i SOS", dropsError && "gli hazard"].filter(Boolean).join(" e ")}: questo elenco potrebbe non essere completo.
                </p>
              )}
              {attentionFeed.length === 0 ? (
                <p className="empty">Nessun avviso al momento.</p>
              ) : (
                <ul className="row-list">
                  {/* Nessun id stabile disponibile su un AttentionItem derivato (non è una riga di
                      Postgres) — l'indice è comunque sicuro qui: la lista è ricalcolata da zero ad
                      ogni render server-side, mai riordinata/filtrata in place lato client. */}
                  {attentionFeed.map((item, i) => (
                    <li key={i} className={item.kind === "sos" ? "sos-row" : undefined}>
                      <div className="row">
                        <span className="row-text">
                          {item.kind === "offline" ? <>Box «{item.nodeDisplayName}» non raggiungibile</> : <>{item.nodeDisplayName} — {item.text}</>}
                        </span>
                        <span className={`tag ${item.kind}`}>{item.kind}</span>
                      </div>
                      <div className="row-meta mono">
                        <span>{item.kind === "offline" ? `ultimo aggiornamento ${timeAgo(new Date(item.since))}` : timeAgo(new Date(item.since))}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="grid">
              <section className="panel">
                <div className="panel-head">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                    <circle cx="6" cy="18" r="2.2" />
                    <circle cx="18" cy="18" r="2.2" />
                    <circle cx="12" cy="6" r="2.2" />
                    <line x1="7.8" y1="16.7" x2="10.2" y2="7.8" />
                    <line x1="16.2" y1="16.7" x2="13.8" y2="7.8" />
                    <line x1="8.2" y1="18" x2="15.8" y2="18" />
                  </svg>
                  <span className="panel-title">Nodi</span>
                  <span className="panel-count">({snapshot.nodes.length})</span>
                </div>
                {nodesError ? (
                  <p className="empty">Impossibile caricare i nodi: {nodesError}</p>
                ) : snapshot.nodes.length === 0 ? (
                  <p className="empty">Nessun nodo sincronizzato finora.</p>
                ) : (
                  <ul className="row-list">
                    {snapshot.nodes.map((n, i) => {
                      const f = fleet[i];
                      const topAlert = f.alerts[0];
                      return (
                        <li key={n.nodeUrl}>
                          <div className="row">
                            <span className="row-text">{f.displayName}</span>
                            <span className={`tag ${f.connected ? "online" : "offline"}`}>{f.connected ? "online" : "offline"}</span>
                          </div>
                          <div className="row-meta mono">
                            <span className="muted">{n.nodeUrl}</span>
                            <span className="sep">·</span>
                            <span>ultimo sync {formatDateTime(n.syncedAt)}</span>
                            {f.batteryPercent !== undefined && (
                              <>
                                <span className="sep">·</span>
                                <span>batteria {f.batteryPercent}%</span>
                              </>
                            )}
                            <span className="sep">·</span>
                            <span>{f.services.length} servizi</span>
                          </div>
                          {topAlert && (
                            <div className="row-meta">
                              <span className={`tag ${topAlert.kind}`}>
                                {f.alerts.length} avviso{f.alerts.length > 1 ? "i" : ""}
                              </span>
                              <span className="row-text">{topAlert.text}</span>
                            </div>
                          )}
                          <RemoteDropForm nodeUrl={n.nodeUrl} />
                          <RemoteNodeAppendForm nodeUrl={n.nodeUrl} />
                          {/* Solo Fixed Relay (mai Mobile Relay/Card, richiesta esplicita dell'utente) e solo Admin
                              (route.ts stesso lo impone comunque — nascosto qui solo per non mostrare a un Operatore
                              un bottone che fallirebbe sempre con 403). f.displayName.length > 0 è già garantito
                              per costruzione (summarizeFleet() ricade su node.nodeId, mai una stringa vuota in
                              pratica) — controllo difensivo aggiunto comunque (trovato dalla revisione): senza,
                              un `relayLabel` vuoto renderebbe TwoStepConfirmDialog permanentemente non
                              confermabile (il testo da digitare per abilitare "Conferma riavvio" non esisterebbe)
                              senza alcuna spiegazione per l'operatore — meglio non offrire affatto il bottone. */}
                          {f.isFixedRelay && session.user.role === "admin" && f.displayName.length > 0 && (
                            <RemoteRelayCommandForm nodeUrl={n.nodeUrl} relayLabel={f.displayName} />
                          )}
                          {/* Solo se questo Box offre almeno una destinazione senza password (Pezzo 3, scope v1 —
                              route.ts lo impone comunque server-side, nascosto qui solo per non mostrare un form
                              vuoto). Stessa autorizzazione per-organizzazione di RemoteDropForm/RemoteNodeAppendForm,
                              non solo Admin. */}
                          {f.externalDeliveryDestinations.length > 0 && (
                            <RemoteExternalDeliveryForm nodeUrl={n.nodeUrl} destinations={f.externalDeliveryDestinations} />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="panel hazard-panel">
                <div className="panel-head">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                    <path d="M12 3 2 20h20z" />
                    <line x1="12" y1="9" x2="12" y2="14" />
                    <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
                  </svg>
                  <span className="panel-title">Hazard / Info</span>
                  <span className="panel-count">({snapshot.drops.length})</span>
                </div>
                {dropsError ? (
                  <p className="empty">Impossibile caricare i drop: {dropsError}</p>
                ) : snapshot.drops.length === 0 ? (
                  <p className="empty">Nessun drop.</p>
                ) : (
                  <ul className="row-list">
                    {snapshot.drops.map((d) => {
                      const kind = dropKind(d.data);
                      const coords = formatCoords(d.data);
                      return (
                        <li key={d.dropId}>
                          <div className="row">
                            <span className="row-text">{typeof d.data.text === "string" ? d.data.text : ""}</span>
                            <span className={`tag ${kind}`}>{kind}</span>
                          </div>
                          <div className="row-meta mono">
                            {coords && <span>{coords}</span>}
                            {coords && <span className="sep">·</span>}
                            <span>{formatDateTime(d.syncedAt)}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="panel relay-panel">
                <div className="panel-head">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                    <line x1="12" y1="21" x2="12" y2="10" />
                    <path d="M8 10a4 4 0 0 1 8 0" />
                    <path d="M5.5 10a6.5 6.5 0 0 1 13 0" />
                    <circle cx="12" cy="10" r="1.3" fill="currentColor" stroke="none" />
                  </svg>
                  <span className="panel-title">Relay</span>
                  <span className="panel-count">({snapshot.relays.length})</span>
                </div>
                {relaysError ? (
                  <p className="empty">Impossibile caricare i relay: {relaysError}</p>
                ) : snapshot.relays.length === 0 ? (
                  <p className="empty">Nessun relay registrato.</p>
                ) : (
                  <ul className="row-list">
                    {snapshot.relays.map((r) => {
                      const online = relayOnline(r.data);
                      const coords = formatCoords(r.data);
                      return (
                        <li key={r.relayId}>
                          <div className="row">
                            <span className="row-text">
                              {r.relayId} <span className="muted">({relayType(r.data)})</span>
                            </span>
                            <span className={`tag ${online ? "online" : "offline"}`}>{online ? "online" : "offline"}</span>
                          </div>
                          <div className="row-meta mono">
                            <span>{coords ?? "posizione sconosciuta"}</span>
                            <span className="sep">·</span>
                            <span>sync {formatDateTime(r.syncedAt)}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          </div>
        </main>
      )}
    </>
  );
}
