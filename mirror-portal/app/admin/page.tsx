import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listAssignedNodes, listOrganizations, listRecentAuditLogs, listUnassignedNodeUrls, listUsers } from "@/lib/auth-db";
import { AdminPanel } from "./AdminPanel";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Dates are formatted here, server-side, into plain strings before crossing into the "use client"
// AdminPanel below — not passed through as Date objects and formatted client-side. Node's default
// timezone (this server) and a browser's local timezone can differ, and toLocaleString()'s output
// depends on it; formatting once, server-side, and shipping a string avoids a React hydration
// mismatch between the server-rendered HTML and the client's first render entirely, rather than
// working around it.
function formatAt(at: Date): string {
  return at.toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" });
}

export default async function AdminPage(): Promise<JSX.Element> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "admin") redirect("/");

  const [organizations, users, assignedNodes, unassignedNodeUrls, auditLogs] = await Promise.all([
    listOrganizations(),
    listUsers(),
    listAssignedNodes(),
    listUnassignedNodeUrls(),
    listRecentAuditLogs(50),
  ]);

  const formattedUsers = users.map((u) => ({ ...u, createdAt: formatAt(u.createdAt) }));
  const formattedAssignedNodes = assignedNodes.map((n) => ({ ...n, registeredAt: formatAt(n.registeredAt) }));
  const formattedAuditLogs = auditLogs.map((a) => ({ ...a, createdAt: formatAt(a.createdAt) }));

  return (
    <main>
      <header>
        <div className="row">
          <h1>ARALD — Pannello Admin</h1>
          <a href="/">&larr; Torna allo specchio</a>
        </div>
        <p className="muted">Organizzazioni, operatori e assegnazione dei nodi mesh — visibile solo agli Admin ARALD.</p>
      </header>
      <AdminPanel
        organizations={organizations}
        users={formattedUsers}
        assignedNodes={formattedAssignedNodes}
        unassignedNodeUrls={unassignedNodeUrls}
        auditLogs={formattedAuditLogs}
      />
    </main>
  );
}
