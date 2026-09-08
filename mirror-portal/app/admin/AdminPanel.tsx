"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { NodeAssignment, Organization, PublicAppUser, UserRole } from "@/lib/auth-db";

interface FormattedUser extends Omit<PublicAppUser, "createdAt"> {
  createdAt: string;
}

interface FormattedNodeAssignment extends Omit<NodeAssignment, "registeredAt"> {
  registeredAt: string;
}

interface FormattedAuditLogEntry {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

interface AdminPanelProps {
  organizations: Organization[];
  users: FormattedUser[];
  assignedNodes: FormattedNodeAssignment[];
  unassignedNodeUrls: string[];
  auditLogs: FormattedAuditLogEntry[];
}

/**
 * The three write forms (create organization, create user, assign node) plus
 * read-only lists of what already exists. A plain `fetch()` to the
 * `app/api/admin/*` routes on submit, then `router.refresh()` to re-pull the
 * server component's data — deliberately not a Next.js Server Action, see
 * `auth.ts`'s doc comment for why.
 */
export function AdminPanel({ organizations, users, assignedNodes, unassignedNodeUrls, auditLogs }: AdminPanelProps): JSX.Element {
  const router = useRouter();

  return (
    <>
      <CreateOrganizationForm onDone={() => router.refresh()} />
      <CreateUserForm organizations={organizations} onDone={() => router.refresh()} />
      <AssignNodeForm organizations={organizations} unassignedNodeUrls={unassignedNodeUrls} onDone={() => router.refresh()} />

      <section className="panel">
        <h2>Organizzazioni ({organizations.length})</h2>
        {organizations.length === 0 ? (
          <p className="empty">Nessuna organizzazione ancora.</p>
        ) : (
          <ul>
            {organizations.map((o) => (
              <li key={o.id}>{o.name}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Operatori ({users.length})</h2>
        {users.length === 0 ? (
          <p className="empty">Nessun utente ancora.</p>
        ) : (
          <ul>
            {users.map((u) => (
              <li key={u.id}>
                <div className="row">
                  <span>{u.email}</span>
                  <span className="tag info">{u.role === "admin" ? "Admin ARALD" : "Operatore"}</span>
                </div>
                <div className="muted">
                  {u.organizationId ? organizationName(organizations, u.organizationId) : "nessuna organizzazione"} · creato {u.createdAt}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Nodi assegnati ({assignedNodes.length})</h2>
        {assignedNodes.length === 0 ? (
          <p className="empty">Nessun nodo assegnato ancora.</p>
        ) : (
          <ul>
            {assignedNodes.map((n) => (
              <li key={n.nodeUrl}>
                <div className="row">
                  <span>{n.displayName ?? n.nodeUrl}</span>
                  <span className="tag info">{n.organizationName}</span>
                </div>
                <div className="muted">
                  {n.nodeUrl} · assegnato {n.registeredAt}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Audit log (ultimi {auditLogs.length})</h2>
        {auditLogs.length === 0 ? (
          <p className="empty">Nessun evento ancora.</p>
        ) : (
          <ul>
            {auditLogs.map((a) => (
              <li key={a.id}>
                <div className="row">
                  <span>{a.action}</span>
                  <span className="muted">{a.createdAt}</span>
                </div>
                <div className="muted">{a.actorEmail ?? "sconosciuto"}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function organizationName(organizations: Organization[], id: string): string {
  return organizations.find((o) => o.id === id)?.name ?? id;
}

function CreateOrganizationForm({ onDone }: { onDone: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    const res = await fetch("/api/admin/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Errore imprevisto.");
      return;
    }
    setName("");
    onDone();
  }

  return (
    <section className="panel">
      <h2>Nuova organizzazione</h2>
      <form onSubmit={handleSubmit} className="admin-form">
        <label>
          Nome
          <input type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="es. CNSAS Piemonte" />
        </label>
        {error && <p className="login-error">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Creazione…" : "Crea organizzazione"}
        </button>
      </form>
    </section>
  );
}

function CreateUserForm({ organizations, onDone }: { organizations: Organization[]; onDone: () => void }): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("operatore");
  const [organizationId, setOrganizationId] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, role, organizationId: role === "operatore" ? organizationId : undefined }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Errore imprevisto.");
      return;
    }
    setEmail("");
    setPassword("");
    onDone();
  }

  return (
    <section className="panel">
      <h2>Nuovo operatore</h2>
      <form onSubmit={handleSubmit} className="admin-form">
        <label>
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password (almeno 10 caratteri)
          <input type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          Ruolo
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            <option value="operatore">Operatore</option>
            <option value="admin">Admin ARALD</option>
          </select>
        </label>
        {role === "operatore" && (
          <label>
            Organizzazione
            <select required value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
              <option value="" disabled>
                Scegli…
              </option>
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="login-error">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Creazione…" : "Crea operatore"}
        </button>
      </form>
    </section>
  );
}

function AssignNodeForm({
  organizations,
  unassignedNodeUrls,
  onDone,
}: {
  organizations: Organization[];
  unassignedNodeUrls: string[];
  onDone: () => void;
}): JSX.Element {
  const [nodeUrl, setNodeUrl] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    const res = await fetch("/api/admin/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeUrl, organizationId, displayName: displayName || undefined }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Errore imprevisto.");
      return;
    }
    setNodeUrl("");
    setDisplayName("");
    onDone();
  }

  return (
    <section className="panel">
      <h2>Assegna nodo a un&rsquo;organizzazione</h2>
      {unassignedNodeUrls.length === 0 ? (
        <p className="empty">Nessun nodo non assegnato al momento — appariranno qui non appena arald-backend/sync.ts sincronizza dati da un nodo nuovo.</p>
      ) : (
        <p className="muted">Non assegnati: {unassignedNodeUrls.join(", ")}</p>
      )}
      <form onSubmit={handleSubmit} className="admin-form">
        <label>
          Indirizzo nodo
          <input
            type="text"
            required
            list="unassigned-node-urls"
            value={nodeUrl}
            onChange={(e) => setNodeUrl(e.target.value)}
            placeholder="http://box.rifugio.example:8080"
          />
          <datalist id="unassigned-node-urls">
            {unassignedNodeUrls.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </label>
        <label>
          Organizzazione
          <select required value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
            <option value="" disabled>
              Scegli…
            </option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Nome visualizzato (opzionale)
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="es. Rifugio Manuale" />
        </label>
        {error && <p className="login-error">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Assegnazione…" : "Assegna nodo"}
        </button>
      </form>
    </section>
  );
}
