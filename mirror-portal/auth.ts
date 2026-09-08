import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { countRecentLoginFailures, findUserByEmail, logAudit, type UserRole } from "@/lib/auth-db";
import { normalizeEmail, validatePassword } from "@/lib/admin-validation";
import { hashPassword, verifyPassword } from "@/lib/password";

/**
 * Operator authentication for the mirror (`app/`) — Auth.js (`next-auth`)
 * Credentials provider over the `users` table already in `arald_portal`
 * (`lib/auth-db.ts`), JWT session strategy (Credentials providers can't use
 * Auth.js's database session strategy, and we don't want one anyway: no
 * `sessions` table to manage, no adapter package needed). Chosen over a
 * hand-rolled cookie/session scheme (explicitly discussed and confirmed with
 * the user before writing this) so password/session handling — the part
 * that is genuinely risky to get wrong by hand — is a collaudata library's
 * job, not this repository's; still no new *account/service* dependency,
 * unlike Auth0/Clerk, since it runs entirely against our own Postgres.
 *
 * Deliberately no `middleware.ts`: Next.js Middleware runs in the Edge
 * runtime by default, which cannot use `pg` (raw TCP) or the full
 * `node:crypto` this file needs. Route protection instead happens inside
 * each Server Component/Route Handler (`await auth()`, all Node.js runtime
 * by default) — see `app/page.tsx`/`app/admin/page.tsx`/`app/api/admin/*`.
 */

declare module "next-auth" {
  interface User {
    role: UserRole;
    organizationId: string | null;
  }
  interface Session {
    user: {
      id: string;
      email: string;
      role: UserRole;
      organizationId: string | null;
    };
  }
}

/**
 * `next-auth/jwt`'s own `JWT` interface is deliberately not augmented via
 * `declare module` here — it re-exports from `@auth/core/jwt`, a transitive
 * dependency whose module specifier TypeScript couldn't resolve for
 * declaration merging under this project's `moduleResolution: "bundler"`.
 * A local extended type + a narrow cast at the two call sites below avoids
 * that entirely, at the cost of one cast instead of ambient global typing.
 */
type TokenWithClaims = { sub?: string; role?: UserRole; organizationId?: string | null };

const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;
const MAX_LOGIN_FAILURES_IN_WINDOW = 10;

/**
 * A fixed, never-real credential hashed once and reused as the comparison
 * target whenever `authorize()` doesn't find a matching user — so a login
 * attempt against an unknown email still pays the same scrypt cost as one
 * against a known email with the wrong password (found by review: without
 * this, an unknown email returned from `authorize()` almost immediately —
 * only a fast indexed SELECT, no scrypt — while a known email always paid
 * scrypt's ~50-100ms, letting repeated, averaged timing measurements
 * distinguish valid operator emails from invalid ones even though the two
 * cases return an identical response body).
 */
let dummyPasswordHash: Promise<string> | undefined;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHash) dummyPasswordHash = hashPassword("never a real account — timing equalization only");
  return dummyPasswordHash;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  // Vercel sets VERCEL=1 and Auth.js auto-trusts the Host header there; explicit here so the same
  // config also works when run locally (`npm run start`, this project's own live-verification runs
  // against local Postgres) or self-hosted anywhere else behind a proxy that sets Host accurately.
  trustHost: true,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials) {
        // Same bounds admin-validation.ts enforces at the (authenticated) admin panel's write
        // endpoints, applied here too — found by review: this Credentials provider is reachable by
        // anyone with no credentials at all, so it's the one path that had never actually bounded
        // email/password length before hitting Postgres and scrypt with them.
        const email = normalizeEmail(credentials?.email);
        const password = validatePassword(credentials?.password);
        if (!email || !password) return null;

        const recentFailures = await countRecentLoginFailures(email, LOGIN_FAILURE_WINDOW_SECONDS);
        if (recentFailures >= MAX_LOGIN_FAILURES_IN_WINDOW) {
          // No extra audit_logs entry for the lockout itself — it's derived from login_failure
          // entries already there, another one would just inflate the count further.
          return null;
        }

        const user = await findUserByEmail(email);
        const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await getDummyPasswordHash()));
        if (!user || !passwordOk) {
          // Logged even on failure, and even for an email that doesn't exist — an audit trail of
          // failed logins is itself useful (docs/emergency-portal.md's "audit log" requirement, and
          // now also what countRecentLoginFailures() above reads), and the response Auth.js sends
          // back is identical either way, so this never turns into a user-enumeration side-channel
          // via the response — see getDummyPasswordHash() above for why it also isn't one via timing.
          await logAudit({ actorEmail: email, action: "login_failure" });
          return null;
        }

        await logAudit({ actorUserId: user.id, actorEmail: user.email, action: "login_success" });
        return { id: user.id, email: user.email, role: user.role, organizationId: user.organizationId };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      const claims = token as typeof token & TokenWithClaims;
      if (user) {
        claims.role = user.role;
        claims.organizationId = user.organizationId;
      }
      return claims;
    },
    async session({ session, token }) {
      const claims = token as typeof token & TokenWithClaims;
      session.user.id = claims.sub ?? "";
      session.user.role = claims.role ?? "operatore";
      session.user.organizationId = claims.organizationId ?? null;
      return session;
    },
  },
});
