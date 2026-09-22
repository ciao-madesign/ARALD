import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireSession, adminErrorResponse } from "@/lib/require-admin";
import { getNodeOrganization, getLatestNodeId, getExternalDeliveryDestination, logAudit } from "@/lib/auth-db";
import { validateNonEmptyId } from "@/lib/admin-validation";
import { buildExternalDeliverySubmission, Priority, MAX_EXTERNAL_DELIVERY_DESTINATION_ID_LENGTH, DEFAULT_MAX_EXTERNAL_DELIVERY_PAYLOAD_BYTES } from "@/lib/mesh-signing";
import { getPool } from "@/lib/db";

/**
 * `POST /api/commands/external-deliveries` — "Pezzo 3" del canale di comando
 * Box↔specchio (`docs/emergency-portal.md`, `docs/security.md` voce #84): un
 * operatore autenticato invia un file verso una destinazione esterna via un
 * Box specifico. A differenza di `POST /api/commands/node-appends`/
 * `relay-commands`, non c'è alcuna firma Ed25519 qui — il canale reale
 * (`NomadNode.handleExternalDelivery()`) non ne richiede una nemmeno lì
 * (vedi `mesh-signing.ts`'s own doc comment sulla sezione "Pezzo 3" per il
 * ragionamento completo): la sicurezza è `destinationId` (risolto qui
 * server-side contro l'ultima sincronizzazione nota, mai fidata dal client)
 * più — fuori scope in questa prima versione — una password per-destinazione.
 *
 * **Scope v1, deciso esplicitamente con l'utente**: solo destinazioni senza
 * password. `getExternalDeliveryDestination()` ri-verifica
 * `requiresPassword` server-side (mai solo il filtro lato client di
 * `lib/node-status.ts`'s `summarizeFleet()`) e questa route rifiuta con 400
 * qualunque destinazione che la richieda, anche se un client aggirasse il
 * filtro chiamando questa route direttamente — stessa disciplina di
 * ri-controllo server-side di `isRegisteredFixedRelay()` per "Pezzo 4".
 *
 * Stessa autorizzazione per-organizzazione di `POST /api/commands/drops`/
 * `node-appends` (non solo Admin) — questo non è il comando "riavvio remoto"
 * di "Pezzo 4", non ha bisogno dello stesso gate più severo.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const body = await request.json().catch(() => null);

    const nodeUrl = validateNonEmptyId(body?.nodeUrl, 2048);
    if (!nodeUrl) return NextResponse.json({ error: "'nodeUrl' mancante o non valido." }, { status: 400 });

    const destinationId = validateNonEmptyId(body?.destinationId, MAX_EXTERNAL_DELIVERY_DESTINATION_ID_LENGTH);
    if (!destinationId) return NextResponse.json({ error: "'destinationId' mancante o non valido." }, { status: 400 });

    const dataBase64 = typeof body?.dataBase64 === "string" ? body.dataBase64 : "";
    if (dataBase64.length === 0) {
      return NextResponse.json({ error: "'dataBase64' mancante." }, { status: 400 });
    }
    let data: Buffer;
    try {
      data = Buffer.from(dataBase64, "base64");
    } catch {
      return NextResponse.json({ error: "'dataBase64' non è base64 valido." }, { status: 400 });
    }
    if (data.length === 0 || data.length > DEFAULT_MAX_EXTERNAL_DELIVERY_PAYLOAD_BYTES) {
      return NextResponse.json({ error: `il file deve avere 1-${DEFAULT_MAX_EXTERNAL_DELIVERY_PAYLOAD_BYTES} byte.` }, { status: 400 });
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

    const destination = await getExternalDeliveryDestination(nodeUrl, targetNodeId, destinationId);
    if (!destination) {
      return NextResponse.json({ error: "destinazione sconosciuta per questo Box." }, { status: 404 });
    }
    if (destination.requiresPassword) {
      return NextResponse.json({ error: "questa destinazione richiede una password — non supportata in questa prima versione." }, { status: 400 });
    }

    const submission = buildExternalDeliverySubmission(destinationId, destination.publicKeyHex, data);

    // priority is a fixed placeholder, same reasoning POST /api/commands/node-appends's own comment
    // gives: command-poller.ts's ingestRequest() forwards the whole signed metadata object as-is to
    // POST /api/ingest-external-delivery, which has no priority field of its own on this HTTP-direct
    // delivery leg (NomadNode.ingestExternalDelivery() always enqueues at Priority.CONTENT).
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO remote_commands (id, organization_id, node_url, kind, metadata, data, priority, created_by)
       VALUES ($1, $2, $3, 'external-delivery', $4, '', $5, $6)`,
      [id, organizationId, nodeUrl, JSON.stringify(submission), Priority.CONTENT, session.user.id],
    );
    await logAudit({
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      action: "remote_external_delivery_queued",
      details: { commandId: id, nodeUrl, destinationId, sizeBytes: data.length },
    });

    return NextResponse.json({ id, status: "pending" }, { status: 201 });
  } catch (err) {
    return adminErrorResponse(err);
  }
}
