"use client";

import { useState, type FormEvent } from "react";

/**
 * Compose-and-queue a "Consegna esterna differita" for one Box, from the
 * portal — "Pezzo 3" del canale di comando (`docs/emergency-portal.md`,
 * `docs/security.md` voce #84). Same shape as `RemoteDropForm`/
 * `RemoteNodeAppendForm` (one instance per node row, collapsed `<details>`,
 * "queued" ≠ "delivered" posture, try/catch around `fetch()`), but the only
 * one of the four that uploads a *file* rather than typed text — a
 * `<select>` populated from `destinations` (already filtered to this exact
 * Box's own password-less destinations by `lib/node-status.ts`'s
 * `summarizeFleet()`, v1 scope decided explicitly with the user) instead of
 * a free-text `destinationId`, so an operator never has to know or type a
 * technical id, same "friendly label, never a technical address" principle
 * `node/src/external-delivery.ts`'s own top doc comment states for the real
 * mesh path.
 *
 * The file is base64-encoded client-side in fixed-size chunks (never
 * `String.fromCharCode(...bytes)` on the whole array at once — spreading a
 * ~1MB `Uint8Array` as call arguments risks hitting the engine's own
 * argument-count limit) and sent as `dataBase64`; the actual X25519 sealing
 * happens server-side in `POST /api/commands/external-deliveries`
 * (`mesh-signing.ts`'s `sealExternalDeliveryForPortal()`) — the browser
 * never handles key material for this piece at all, unlike nothing else in
 * this app (Node Append/relay command signing also happens server-side, but
 * with a *persisted* per-operator identity; here it's freshly ephemeral per
 * submission either way, so there is no reason to ever move it client-side).
 */

const MAX_FILE_BYTES = 1_000_000; // mirrors mesh-signing.ts's DEFAULT_MAX_EXTERNAL_DELIVERY_PAYLOAD_BYTES
const BASE64_CHUNK_SIZE = 8192;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function RemoteExternalDeliveryForm({
  nodeUrl,
  destinations,
}: {
  nodeUrl: string;
  destinations: Array<{ destinationId: string; label: string }>;
}): JSX.Element {
  const [destinationId, setDestinationId] = useState(destinations[0]?.destinationId ?? "");
  const [file, setFile] = useState<File | undefined>(undefined);
  const [status, setStatus] = useState<"idle" | "submitting" | "queued" | "error">("idle");
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!file) return;
    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      setStatus("error");
      setError(`Il file deve essere tra 1 byte e ${Math.round(MAX_FILE_BYTES / 1_000_000)}MB.`);
      return;
    }
    setStatus("submitting");
    setError(undefined);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const dataBase64 = bytesToBase64(bytes);
      const res = await fetch("/api/commands/external-deliveries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeUrl, destinationId, dataBase64 }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus("error");
        setError(body.error ?? "Errore imprevisto.");
        return;
      }
      setStatus("queued");
      setFile(undefined);
    } catch {
      setStatus("error");
      setError("Impossibile contattare il portale — controlla la connessione e riprova.");
    }
  }

  return (
    <details className="remote-drop-form">
      <summary>Invia consegna esterna</summary>
      <form onSubmit={handleSubmit} className="admin-form">
        <label>
          Destinazione
          <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
            {destinations.map((d) => (
              <option key={d.destinationId} value={d.destinationId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          File
          <input type="file" required onChange={(e) => setFile(e.target.files?.[0])} />
        </label>
        {status === "error" && <p className="login-error">{error}</p>}
        {status === "queued" && <p className="remote-drop-queued">Messo in coda — sarà consegnato al Box appena si aggiorna, poi inoltrato alla destinazione quando torna Internet.</p>}
        <button type="submit" disabled={status === "submitting" || !file}>
          {status === "submitting" ? "Invio…" : "Invia"}
        </button>
      </form>
    </details>
  );
}
