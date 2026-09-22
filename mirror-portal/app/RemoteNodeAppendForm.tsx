"use client";

import { useState, type FormEvent } from "react";

/**
 * Compose-and-queue a Node Append for one Box, from the portal — Pezzo 2
 * del canale di comando (`docs/emergency-portal.md`, `docs/security.md`
 * voce #82). Same shape as `RemoteDropForm` (one instance per node row,
 * collapsed `<details>`, "queued" ≠ "delivered" posture, try/catch around
 * `fetch()` — see that component's own doc comment for why), minus
 * lat/lon: a Node Append has no location, it's deposited at *this specific
 * Box* for whoever connects to it locally, not shown on a map. POSTs to
 * `/api/commands/node-appends`, which signs server-side with this
 * operator's own dedicated mesh identity (the same one `RemoteDropForm`
 * already uses, no new key material) and queues it.
 */
export function RemoteNodeAppendForm({ nodeUrl }: { nodeUrl: string }): JSX.Element {
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"info" | "hazard" | "emergency">("info");
  const [status, setStatus] = useState<"idle" | "submitting" | "queued" | "error">("idle");
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus("submitting");
    setError(undefined);

    try {
      const res = await fetch("/api/commands/node-appends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeUrl, text, kind, label: label.length > 0 ? label : undefined }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus("error");
        setError(body.error ?? "Errore imprevisto.");
        return;
      }
      setStatus("queued");
      setText("");
      setLabel("");
    } catch {
      setStatus("error");
      setError("Impossibile contattare il portale — controlla la connessione e riprova.");
    }
  }

  return (
    <details className="remote-drop-form">
      <summary>Invia nota al Box</summary>
      <form onSubmit={handleSubmit} className="admin-form">
        <label>
          Messaggio
          <textarea required value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="es. Materiale da recuperare al prossimo turno" />
        </label>
        <label>
          Livello
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="info">Info</option>
            <option value="hazard">Hazard</option>
            <option value="emergency">Emergency</option>
          </select>
        </label>
        <label>
          Etichetta (opzionale)
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="es. Logistica" />
        </label>
        {status === "error" && <p className="login-error">{error}</p>}
        {status === "queued" && <p className="remote-drop-queued">Messo in coda — sarà consegnato al Box appena si aggiorna.</p>}
        <button type="submit" disabled={status === "submitting"}>
          {status === "submitting" ? "Invio…" : "Invia"}
        </button>
      </form>
    </details>
  );
}
