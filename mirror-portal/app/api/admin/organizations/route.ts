import { NextRequest, NextResponse } from "next/server";
import { createOrganization } from "@/lib/auth-db";
import { validateOrganizationName } from "@/lib/admin-validation";
import { adminErrorResponse, requireAdminSession } from "@/lib/require-admin";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();

    const body = await request.json().catch(() => null);
    const name = validateOrganizationName(body?.name);
    if (!name) return NextResponse.json({ error: "Nome organizzazione non valido." }, { status: 400 });

    // createOrganization() writes the audit_logs entry itself, in the same transaction as the
    // insert — see auth-db.ts's withTransaction() doc comment for why that matters.
    const organization = await createOrganization({ name, actorUserId: session.user.id, actorEmail: session.user.email });

    return NextResponse.json({ organization });
  } catch (err) {
    return adminErrorResponse(err);
  }
}
