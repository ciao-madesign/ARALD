import { NextRequest, NextResponse } from "next/server";
import { assignNode } from "@/lib/auth-db";
import { validateNodeDisplayName, validateNonEmptyId } from "@/lib/admin-validation";
import { adminErrorResponse, requireAdminSession } from "@/lib/require-admin";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();

    const body = await request.json().catch(() => null);
    const nodeUrl = validateNonEmptyId(body?.nodeUrl, 2048); // a URL, not an id — allow more than the default 200
    const organizationId = validateNonEmptyId(body?.organizationId);
    if (!nodeUrl || !organizationId) {
      return NextResponse.json({ error: "nodeUrl o organizationId non validi." }, { status: 400 });
    }

    let displayName: string | undefined;
    if (body?.displayName !== undefined && body?.displayName !== null) {
      const validated = validateNodeDisplayName(body.displayName);
      if (!validated) return NextResponse.json({ error: "displayName non valido." }, { status: 400 });
      displayName = validated;
    }

    // assignNode() writes the audit_logs entry itself, in the same transaction as the upsert —
    // including the node's previous organization, if it had one (see auth-db.ts).
    await assignNode({ nodeUrl, organizationId, displayName, actorUserId: session.user.id, actorEmail: session.user.email });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return adminErrorResponse(err);
  }
}
