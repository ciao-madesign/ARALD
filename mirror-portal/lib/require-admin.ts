import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { DuplicateEmailError, UnknownOrganizationError } from "@/lib/auth-db";

/**
 * Shared role gate for every `app/api/admin/*` route handler — each of them
 * calls this first, before touching any request body, same "check before
 * you do anything" discipline as `web-ui.ts`'s `isAuthorized()` in the mesh
 * codebase. A dedicated exception per failure mode (rather than a boolean)
 * so each route's catch block can map to the right HTTP status without
 * re-deriving why the check failed.
 */

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}

export async function requireAdminSession(): Promise<Session> {
  const session = await auth();
  if (!session?.user) throw new UnauthorizedError("Sessione non valida o scaduta.");
  if (session.user.role !== "admin") throw new ForbiddenError("Questa azione richiede il ruolo Admin ARALD.");
  return session;
}

/**
 * Every `app/api/admin/*` route ends its `catch` block with this — one place
 * that maps each known failure to its HTTP status, so a route handler never
 * has to remember the mapping itself (or leak a raw stack trace on an
 * unexpected error, which this logs server-side instead of returning).
 */
export function adminErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err instanceof DuplicateEmailError) return NextResponse.json({ error: err.message }, { status: 409 });
  if (err instanceof UnknownOrganizationError) return NextResponse.json({ error: err.message }, { status: 400 });
  console.error("mirror-portal admin API error:", err);
  return NextResponse.json({ error: "Errore interno." }, { status: 500 });
}
