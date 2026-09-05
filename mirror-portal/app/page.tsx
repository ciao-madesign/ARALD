import { getMirrorSnapshot, type MirrorSectionError, type MirrorSnapshot } from "../lib/db";
import { beaconMessage, dropKind, formatCoords, nodeDisplayName, relayOnline, relayType } from "../lib/format";

// Never statically cached — a mirror whose whole point is showing what arald-backend/sync.ts most
// recently wrote would be actively misleading if Vercel served a stale build-time snapshot instead of
// querying Postgres on every request.
export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatSyncedAt(at: Date): string {
  return at.toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" });
}

/** The error message for one section, if `getMirrorSnapshot()` reported one — each panel below renders this instead of its list, so one section failing never hides the sections that loaded fine (`lib/db.ts`'s own doc comment on `MirrorSnapshot.errors`). */
function sectionError(errors: MirrorSectionError[], section: MirrorSectionError["section"]): string | undefined {
  return errors.find((e) => e.section === section)?.message;
}

export default async function HomePage(): Promise<JSX.Element> {
  let snapshot: MirrorSnapshot;
  try {
    snapshot = await getMirrorSnapshot();
  } catch (err) {
    // getMirrorSnapshot() itself never throws for an expected failure (a missing DATABASE_URL or one
    // failing query both surface as snapshot.errors instead) — this is a last-resort net for a truly
    // unexpected exception, so the page still degrades to one panel rather than Next.js's generic
    // error screen. Never a raw stack trace to the browser either way.
    const message = err instanceof Error ? err.message : String(err);
    snapshot = { nodes: [], relays: [], beacons: [], drops: [], errors: [{ section: "config", message }] };
  }

  const configError = sectionError(snapshot.errors, "config");
  const nodesError = sectionError(snapshot.errors, "nodes");
  const relaysError = sectionError(snapshot.errors, "relays");
  const beaconsError = sectionError(snapshot.errors, "beacons");
  const dropsError = sectionError(snapshot.errors, "drops");

  return (
    <main>
      <header>
        <h1>ARALD — Specchio Emergency Portal</h1>
        <p className="muted">
          Vista di sola lettura, sincronizzata periodicamente da un ARALD Box (<code>arald-backend/sync.ts</code>). Il
          portale operativo vero gira sul Box stesso via LAN — questo è solo uno specchio per la gestione ordinaria da
          remoto, mai il punto da cui dipende l&rsquo;operatività sul posto.
        </p>
      </header>

      {configError && (
        <div className="panel error">
          <strong>Impossibile leggere i dati dello specchio.</strong>
          <p>{configError}</p>
        </div>
      )}

      {!configError && (
        <>
          <section className="panel">
            <h2>Nodi ({snapshot.nodes.length})</h2>
            {nodesError ? (
              <p className="empty">Impossibile caricare i nodi: {nodesError}</p>
            ) : snapshot.nodes.length === 0 ? (
              <p className="empty">Nessun nodo sincronizzato finora.</p>
            ) : (
              <ul>
                {snapshot.nodes.map((n) => (
                  <li key={n.nodeUrl}>
                    <div className="row">
                      <span>{nodeDisplayName(n.data, n.nodeId)}</span>
                      <span className="muted">{n.nodeUrl}</span>
                    </div>
                    <div className="muted">Ultimo sync: {formatSyncedAt(n.syncedAt)}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>SOS ricevuti ({snapshot.beacons.length})</h2>
            {beaconsError ? (
              <p className="empty">Impossibile caricare i SOS: {beaconsError}</p>
            ) : snapshot.beacons.length === 0 ? (
              <p className="empty">Nessun SOS.</p>
            ) : (
              <ul>
                {snapshot.beacons.map((b) => {
                  const coords = formatCoords(b.data);
                  return (
                    <li key={b.beaconContentId}>
                      <div className="row">
                        <span>{beaconMessage(b.data)}</span>
                        <span className="tag emergency">SOS</span>
                      </div>
                      <div className="muted">
                        via {b.nodeUrl}
                        {coords ? ` · ${coords}` : ""} · {formatSyncedAt(b.syncedAt)}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>HAZARD / INFO ({snapshot.drops.length})</h2>
            {dropsError ? (
              <p className="empty">Impossibile caricare i drop: {dropsError}</p>
            ) : snapshot.drops.length === 0 ? (
              <p className="empty">Nessun drop.</p>
            ) : (
              <ul>
                {snapshot.drops.map((d) => {
                  const kind = dropKind(d.data);
                  const coords = formatCoords(d.data);
                  return (
                    <li key={d.dropId}>
                      <div className="row">
                        <span>{typeof d.data.text === "string" ? d.data.text : ""}</span>
                        <span className={`tag ${kind}`}>{kind}</span>
                      </div>
                      <div className="muted">
                        via {d.nodeUrl}
                        {coords ? ` · ${coords}` : ""} · {formatSyncedAt(d.syncedAt)}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>Relay ({snapshot.relays.length})</h2>
            {relaysError ? (
              <p className="empty">Impossibile caricare i relay: {relaysError}</p>
            ) : snapshot.relays.length === 0 ? (
              <p className="empty">Nessun relay registrato.</p>
            ) : (
              <ul>
                {snapshot.relays.map((r) => {
                  const online = relayOnline(r.data);
                  const coords = formatCoords(r.data);
                  return (
                    <li key={r.relayId}>
                      <div className="row">
                        <span>
                          {r.relayId} <span className="muted">({relayType(r.data)})</span>
                        </span>
                        <span className={`tag ${online ? "online" : "offline"}`}>{online ? "online" : "offline"}</span>
                      </div>
                      <div className="muted">
                        {coords ?? "posizione sconosciuta"} · sync {formatSyncedAt(r.syncedAt)}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
