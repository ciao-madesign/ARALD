import { createUser } from "../lib/auth-db";
import { normalizeEmail, validatePassword } from "../lib/admin-validation";
import { hashPassword } from "../lib/password";
import { getPool } from "../lib/db";

/**
 * One-shot CLI to create the very first Admin ARALD account — there is no
 * public self-signup by design (an emergency portal is not a service you
 * open a free account on), so someone has to exist before the Admin panel
 * (`app/admin/`) can create anyone else. Run once, locally, against the real
 * DATABASE_URL (this cannot run from this sandbox — same network policy
 * that blocks arald-backend/sync.ts from reaching Neon directly, see
 * docs/emergency-portal.md):
 *
 *   DATABASE_URL=postgresql://... npm run create-admin -- --email you@example.com --password "a strong password"
 *
 * Deliberately not an HTTP endpoint (no "bootstrap only if zero users exist"
 * API route) — a plain CLI script run once, by someone who already has
 * DATABASE_URL, is a smaller attack surface and needs no extra logic to
 * disable itself after first use.
 */

function readArg(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const email = normalizeEmail(readArg("email") ?? process.env.ADMIN_EMAIL);
  const password = validatePassword(readArg("password") ?? process.env.ADMIN_PASSWORD);

  if (!email || !password) {
    console.error("Uso: npm run create-admin -- --email you@example.com --password \"almeno 10 caratteri\"");
    console.error("(oppure le variabili d'ambiente ADMIN_EMAIL / ADMIN_PASSWORD)");
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);
  // createUser() writes its own audit_logs entry (action "user_created") atomically with the
  // insert — actorUserId: null is itself the bootstrap signature (every later admin/operator
  // created from app/admin/ has a real actorUserId, an already-authenticated Admin session).
  const user = await createUser({ email, passwordHash, role: "admin", organizationId: null, actorUserId: null, actorEmail: email });

  console.log(`Admin ARALD creato: ${user.email} (id ${user.id}).`);
}

main()
  .catch((err) => {
    console.error("Errore durante la creazione dell'admin:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await getPool().end();
    } catch {
      // getPool() itself throws when DATABASE_URL was never set — nothing was ever opened, nothing to close.
    }
  });
