"use client";

import { useState } from "react";

/**
 * Queue a remote reboot command for one Fixed Relay, from the portal —
 * Pezzo 4 del canale di comando (`docs/emergency-portal.md`,
 * `docs/security.md` voce #83). Rendered only for a node `page.tsx`
 * already knows is a Fixed Relay (`NodeFleetStatus.isFixedRelay`, see that
 * field's own doc comment) — never for a Mobile Relay/Card, per the
 * user's own original request. Same "queued" ≠ "delivered" posture and
 * try/catch around `fetch()` as `RemoteDropForm`/`RemoteNodeAppendForm`,
 * plus a native `confirm()` before sending: unlike a note or a drop, this
 * command — once accepted by the Box and if `--allow-remote-reboot` is
 * set there — actually reboots the device, so a stray click deserves one
 * extra deliberate step, not a bare button.
 */
export function RemoteRelayCommandForm({ nodeUrl }: { nodeUrl: string }): JSX.Element {
  const [status, setStatus] = useState<"idle" | "submitting" | "queued" | "error">("idle");
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleClick(): Promise<void> {
    if (!window.confirm("Riavviare questo Box da remoto? Il riavvio effettivo dipende anche dalla configurazione locale del Box (--allow-remote-reboot).")) {
      return;
    }
    setStatus("submitting");
    setError(undefined);

    try {
      const res = await fetch("/api/commands/relay-commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeUrl }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus("error");
        setError(body.error ?? "Errore imprevisto.");
        return;
      }
      setStatus("queued");
    } catch {
      setStatus("error");
      setError("Impossibile contattare il portale — controlla la connessione e riprova.");
    }
  }

  return (
    <div className="remote-relay-command-form">
      {status === "error" && <p className="login-error">{error}</p>}
      {status === "queued" && <p className="remote-drop-queued">Comando di riavvio messo in coda — sarà consegnato al Box appena si aggiorna.</p>}
      <button type="button" onClick={handleClick} disabled={status === "submitting"}>
        {status === "submitting" ? "Invio…" : "Riavvia (remoto)"}
      </button>
    </div>
  );
}
