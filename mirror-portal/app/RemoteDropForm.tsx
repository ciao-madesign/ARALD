"use client";

import { useState, type FormEvent } from "react";

/**
 * Compose-and-queue a Drop/Hazard for one Box, from the portal — Pezzo 1
 * del canale di comando (`docs/emergency-portal.md`). One instance per
 * node row in the Home page's Nodi panel (`app/page.tsx`), collapsed by
 * default via `<details>` (same native-disclosure pattern the mobile app
 * already uses for its own collapsible sections). POSTs to
 * `/api/commands/drops`, which signs the drop server-side with this
 * operator's own dedicated mesh identity and queues it — delivery to the
 * Box happens later, on its own polling schedule (`arald-backend`'s
 * command poller), so a successful submit here means "queued", not yet
 * "delivered": the confirmation message says exactly that, never implying
 * the Box has already received it.
 */
export function RemoteDropForm({ nodeUrl }: { nodeUrl: string }): JSX.Element {
  const [text, setText] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"info" | "hazard" | "emergency">("info");
  const [status, setStatus] = useState<"idle" | "submitting" | "queued" | "error">("idle");
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus("submitting");
    setError(undefined);

    const parsedLat = Number(lat);
    const parsedLon = Number(lon);
    // Found by review: without the try/catch, a transport-level failure (offline, DNS, CORS —
    // fetch() *rejects* instead of resolving with a non-ok response for these) left status stuck on
    // "submitting" forever, with the submit button permanently disabled and no error ever shown —
    // exactly the flaky/degraded-connectivity scenario this whole project targets.
    try {
      const res = await fetch("/api/commands/drops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeUrl, text, lat: parsedLat, lon: parsedLon, kind, label: label.length > 0 ? label : undefined }),
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
      <summary>Invia avviso</summary>
      <form onSubmit={handleSubmit} className="admin-form">
        <label>
          Messaggio
          <textarea required value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="es. Sentiero franato dopo il bivio" />
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
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="es. Pericolo" />
        </label>
        <label>
          Latitudine
          <input type="number" step="any" required value={lat} onChange={(e) => setLat(e.target.value)} />
        </label>
        <label>
          Longitudine
          <input type="number" step="any" required value={lon} onChange={(e) => setLon(e.target.value)} />
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
