import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession, adminErrorResponse } from "@/lib/require-admin";
import { getNodeOrganization, getLatestNodeId, isRegisteredFixedRelay, logAudit } from "@/lib/auth-db";
import { validateNonEmptyId } from "@/lib/admin-validation";
import { getOrCreateMeshIdentity } from "@/lib/mesh-identity-store";
import { signRelayCommand, Priority } from "@/lib/mesh-signing";
import { getPool } from "@/lib/db";

/**
 * `POST /api/commands/relay-commands` — "Pezzo 4" del canale di comando
 * Box↔specchio (`docs/emergency-portal.md`, `docs/security.md` voce #83):
 * un Admin ARALD invia un comando di riavvio a un Fixed Relay specifico.
 * Firma lato server con l'identità mesh dedicata dell'operatore
 * (`getOrCreateMeshIdentity()` — la stessa già custodita per Pezzo 1/2,
 * nessuna nuova chiave), la mette in coda in `remote_commands` con
 * `kind = 'relay-command'` (stessa forma "metadata contiene l'intera busta
 * firmata, data resta vuota" già usata per `'node-append'`).
 *
 * **A differenza delle altre due route di questo canale, solo un Admin
 * ARALD può chiamare questa — non un Operatore con accesso
 * all'organizzazione** (`requireAdminSession()`, non `requireSession()`):
 * decisione presa qui, non dall'utente esplicitamente, come misura di
 * difesa aggiuntiva proporzionata alla severità del comando (`node/src/
 * relay-registry.ts`'s own doc comment: "the single most sensitive payload
 * in this codebase") — non contraddice la decisione già presa sul modello
 * di fiducia mesh (`docs/security.md` voce #83), la restringe solo lato
 * portale, dove costa zero lavoro aggiuntivo riusare `requireAdminSession()`
 * già esistente.
 *
 * `targetNodeId` ri-derivato server-side via `getLatestNodeId()`, stessa
 * ragione di `POST /api/commands/node-appends`. Nessun campo body oltre a
 * `nodeUrl` — un "reboot" non ha altri parametri.
 *
 * **"Solo Fixed Relay" ri-verificato qui, non solo lato UI** (trovato da
 * revisione — `docs/security.md` voce #83): `page.tsx` mostra il bottone
 * solo per un nodo con `isFixedRelay: true`, ma quel filtro da solo non
 * basta a impedire una chiamata diretta a questa route (sessione stantia,
 * strumento esterno, futura regressione UI) verso una Card/Mobile Relay —
 * esattamente ciò che la richiesta originale dell'utente ("solo verso i
 * relay fissi") vieta. `isRegisteredFixedRelay()` ri-verifica sul server,
 * prima di firmare qualunque cosa.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const body = await request.json().catch(() => null);

    const nodeUrl = validateNonEmptyId(body?.nodeUrl, 2048);
    if (!nodeUrl) return NextResponse.json({ error: "'nodeUrl' mancante o non valido." }, { status: 400 });

    const organizationId = await getNodeOrganization(nodeUrl);
    if (!organizationId) {
      return NextResponse.json({ error: "nodo sconosciuto o non ancora assegnato a un'organizzazione." }, { status: 404 });
    }

    const targetNodeId = await getLatestNodeId(nodeUrl);
    if (!targetNodeId) {
      return NextResponse.json({ error: "identità mesh del nodo non ancora nota (nessuno stato sincronizzato)." }, { status: 404 });
    }

    if (!(await isRegisteredFixedRelay(targetNodeId))) {
      return NextResponse.json({ error: "il riavvio remoto è disponibile solo per i Fixed Relay registrati." }, { status: 403 });
    }

    const identity = await getOrCreateMeshIdentity(session.user.id);
    const signed = signRelayCommand(identity, targetNodeId);

    // `priority` non è mai letto da command-poller.ts per questo kind (stesso trattamento già
    // documentato per 'node-append') — placeholder fisso.
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO remote_commands (id, organization_id, node_url, kind, metadata, data, priority, created_by)
       VALUES ($1, $2, $3, 'relay-command', $4, '', $5, $6)`,
      [id, organizationId, nodeUrl, JSON.stringify(signed), Priority.MESSAGING, session.user.id],
    );
    await logAudit({
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      action: "remote_relay_reboot_queued",
      details: { commandId: id, nodeUrl },
    });

    return NextResponse.json({ id, status: "pending" }, { status: 201 });
  } catch (err) {
    return adminErrorResponse(err);
  }
}
