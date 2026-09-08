"use client";

import { signOut } from "next-auth/react";

/** A plain client-side call into Auth.js's own signout API route (CSRF-protected internally by the library) — never a Next.js Server Action, see auth.ts's doc comment for why. */
export function LogoutButton(): JSX.Element {
  return (
    <button type="button" className="logout-button" onClick={() => signOut({ redirectTo: "/login" })}>
      Esci
    </button>
  );
}
