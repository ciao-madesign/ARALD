import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireSession, adminErrorResponse } from "@/lib/require-admin";
import { getNodeOrganization, logAudit } from "@/lib/auth-db";
import { validateNonEmptyId } from "@/lib/admin-validation";
import { getOrCreateMeshIdentity } from "@/lib/mesh-identity-store";
import { signDrop, MAX_MESSAGE_TEXT_LENGTH, MAX_DROP_LABEL_LENGTH, type DropKind } from "@/lib/mesh-signing";
import { getPool } from "@/lib/db";

/**
 * `POST /api/commands/drops` — Pezzo 1 del canale di comando Box↔specchio
 * (`docs/emergency-portal.md`, `docs/security.md` voce #81): un operatore
 * autenticato compone un Drop/Hazard destinato a un Box specifico. Firma
 * lato server con l'identità mesh dedicata di *quell'operatore*
 * (`getOrCreateMeshIdentity()`) — non quella del Box — e lo mette in coda
 * in `remote_commands`; `arald-backend`'s command poller lo consegna al
 * Box quando questo interroga la propria coda (mai il contrario: il Box
 * non ha un IP pubblico raggiungibile in generale).
 *
 * Qualunque operatore autenticato può chiamare questo endpoint (non solo
 * Admin) — l'autorizzazione vera è per-organizzazione, verificata qui
 * sotto contro `getNodeOrganization(nodeUrl)`, non dal ruolo da solo.
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
    const lat = body?.lat;
    if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      return NextResponse.json({ error: "'lat' deve essere un numero tra -90 e 90." }, { status: 400 });
    }
    const lon = body?.lon;
    if (typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      return NextResponse.json({ error: "'lon' deve essere un numero tra -180 e 180." }, { status: 400 });
    }
    const kind: unknown = body?.kind ?? "info";
    if (kind !== "info" && kind !== "hazard" && kind !== "emergency") {
      return NextResponse.json({ error: "'kind' deve essere uno tra 'info', 'hazard', 'emergency'." }, { status: 400 });
    }
    let label: string | undefined;
    if (body?.label !== undefined && body?.label !== null) {
      if (typeof body.label !== "string" || body.label.length === 0 || body.label.length > MAX_DROP_LABEL_LENGTH) {
        return NextResponse.json({ error: `'label' deve avere 1-${MAX_DROP_LABEL_LENGTH} caratteri.` }, { status: 400 });
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

    const identity = await getOrCreateMeshIdentity(session.user.id);
    const signed = signDrop(identity, { text, lat, lon, label, kind: kind as DropKind });

    const id = randomUUID();
    await getPool().query(
      `INSERT INTO remote_commands (id, organization_id, node_url, kind, metadata, data, priority, created_by)
       VALUES ($1, $2, $3, 'drop', $4, $5, $6, $7)`,
      [id, organizationId, nodeUrl, JSON.stringify(signed.metadata), signed.data.toString("base64"), signed.priority, session.user.id],
    );
    await logAudit({
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      action: "remote_drop_queued",
      details: { commandId: id, nodeUrl, dropKind: kind },
    });

    return NextResponse.json({ id, status: "pending" }, { status: 201 });
  } catch (err) {
    return adminErrorResponse(err);
  }
}
