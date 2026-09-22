import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireSession, adminErrorResponse } from "@/lib/require-admin";
import { getNodeOrganization, getLatestNodeId, logAudit } from "@/lib/auth-db";
import { validateNonEmptyId } from "@/lib/admin-validation";
import { getOrCreateMeshIdentity } from "@/lib/mesh-identity-store";
import { signNodeAppend, Priority, MAX_MESSAGE_TEXT_LENGTH, MAX_NODE_APPEND_LABEL_LENGTH, type DropKind } from "@/lib/mesh-signing";
import { getPool } from "@/lib/db";

/**
 * `POST /api/commands/node-appends` — "Pezzo 2" del canale di comando
 * Box↔specchio (`docs/emergency-portal.md`, `docs/security.md` voce #82):
 * un operatore autenticato compone un Node Append destinato a un Box
 * specifico. Firma lato server con l'identità mesh dedicata di
 * *quell'operatore* (`getOrCreateMeshIdentity()` — la stessa già custodita
 * per "Pezzo 1", nessuna nuova chiave), lo mette in coda in
 * `remote_commands` con `kind = 'node-append'` (a differenza di `kind =
 * 'drop'`, il payload firmato intero vive in `metadata`, `data` resta una
 * stringa vuota — un Node Append non ha un blob binario separato) e
 * `arald-backend`'s command poller lo consegna al Box quando questo
 * interroga la propria coda.
 *
 * A differenza di `POST /api/commands/drops`, `targetNodeId` (parte di
 * ciò che viene firmato — vedi `mesh-signing.ts`) non arriva dal client:
 * viene ri-derivato qui dalla riga di stato più recente sincronizzata per
 * `nodeUrl` (`getLatestNodeId()`), così la firma è sempre vincolata
 * all'identità mesh *attuale* del Box secondo il portale stesso, mai a una
 * copia potenzialmente stale nella pagina del client.
 *
 * Stessa autorizzazione per-organizzazione di `POST /api/commands/drops`
 * (non solo Admin) — vedi quella route per il ragionamento completo.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const body = await request.json().catch(() => null);

    const nodeUrl = validateNonEmptyId(body?.nodeUrl, 2048);
    if (!nodeUrl) return NextResponse.json({ error: "'nodeUrl' mancante o non valido." }, { status: 400 });

    const text = typeof body?.text === "string" ? body.text : "";
    if (text.length === 0 || text.length > MAX_MESSAGE_TEXT_LENGTH) {
      return NextResponse.json({ error: `'text' deve avere 1-${MAX_MESSAGE_TEXT_LENGTH} caratteri.` }, { status: 400 });
    }
    const kind: unknown = body?.kind ?? "info";
    if (kind !== "info" && kind !== "hazard" && kind !== "emergency") {
      return NextResponse.json({ error: "'kind' deve essere uno tra 'info', 'hazard', 'emergency'." }, { status: 400 });
    }
    let label: string | undefined;
    if (body?.label !== undefined && body?.label !== null) {
      if (typeof body.label !== "string" || body.label.length === 0 || body.label.length > MAX_NODE_APPEND_LABEL_LENGTH) {
        return NextResponse.json({ error: `'label' deve avere 1-${MAX_NODE_APPEND_LABEL_LENGTH} caratteri.` }, { status: 400 });
      }
      label = body.label;
    }

    const organizationId = await getNodeOrganization(nodeUrl);
    if (!organizationId) {
      return NextResponse.json({ error: "nodo sconosciuto o non ancora assegnato a un'organizzazione." }, { status: 404 });
    }
    if (session.user.role !== "admin" && session.user.organizationId !== organizationId) {
      return NextResponse.json({ error: "non hai accesso a questo nodo." }, { status: 403 });
    }

    const targetNodeId = await getLatestNodeId(nodeUrl);
    if (!targetNodeId) {
      return NextResponse.json({ error: "identità mesh del nodo non ancora nota (nessuno stato sincronizzato)." }, { status: 404 });
    }

    const identity = await getOrCreateMeshIdentity(session.user.id);
    const signed = signNodeAppend(identity, { text, label, kind: kind as DropKind, targetNodeId });

    // `priority` is a fixed placeholder, never `dropKindPriority(kind)`, for a 'node-append' row —
    // found by review: command-poller.ts's ingestRequest() never reads this column for this kind
    // (it forwards the whole signed `metadata` object as-is to POST /api/ingest-node-append, which
    // has no `priority` field at all — a Node Append's wire priority only exists on the *mesh* path,
    // via appendToNode()'s own dropKindPriority(kind) call, never on this HTTP-direct delivery leg).
    // Computing dropKindPriority(kind) here anyway would misleadingly imply it's honored somewhere.
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO remote_commands (id, organization_id, node_url, kind, metadata, data, priority, created_by)
       VALUES ($1, $2, $3, 'node-append', $4, '', $5, $6)`,
      [id, organizationId, nodeUrl, JSON.stringify(signed), Priority.CONTENT, session.user.id],
    );
    await logAudit({
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      action: "remote_node_append_queued",
      details: { commandId: id, nodeUrl, appendKind: kind },
    });

    return NextResponse.json({ id, status: "pending" }, { status: 201 });
  } catch (err) {
    return adminErrorResponse(err);
  }
}
