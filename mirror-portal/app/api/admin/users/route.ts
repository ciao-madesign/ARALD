import { NextRequest, NextResponse } from "next/server";
import { createUser } from "@/lib/auth-db";
import { normalizeEmail, validateNonEmptyId, validatePassword, validateRole } from "@/lib/admin-validation";
import { hashPassword } from "@/lib/password";
import { adminErrorResponse, requireAdminSession } from "@/lib/require-admin";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();

    const body = await request.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    const password = validatePassword(body?.password);
    const role = validateRole(body?.role);
    if (!email || !password || !role) {
      return NextResponse.json({ error: "Email, password (almeno 10 caratteri) o ruolo non validi." }, { status: 400 });
    }

    // An Admin belongs to no single organization (createUser() forces organizationId to null for
    // that role regardless of what's sent) — only an Operatore is required to name one.
    let organizationId: string | null = null;
    if (role === "operatore") {
      organizationId = validateNonEmptyId(body?.organizationId) ?? null;
      if (!organizationId) {
        return NextResponse.json({ error: "Un Operatore deve appartenere a un'organizzazione." }, { status: 400 });
      }
    }

    const passwordHash = await hashPassword(password);
    // createUser() writes the audit_logs entry itself, in the same transaction as the insert.
    const user = await createUser({
      email,
      passwordHash,
      role,
      organizationId,
      actorUserId: session.user.id,
      actorEmail: session.user.email,
    });

    return NextResponse.json({ user });
  } catch (err) {
    return adminErrorResponse(err);
  }
}
