import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Applies Wi-Fi credentials received from an out-of-band pairing exchange
 * (`docs/next-steps.md`, "Provisioning Wi-Fi via Bluetooth per un Box senza
 * cavo Ethernet") to the host's `NetworkManager`, via `sudo nmcli` — same
 * `execFile`-never-a-shell posture as `host-power.ts` (`CLAUDE.md`'s general
 * defensive stance): `ssid`/`password` are untrusted input from a phone over
 * Bluetooth, never interpolated into a shell string, passed as literal argv
 * entries to `nmcli` instead.
 *
 * **What this module is, and what it deliberately is not**: this is only
 * the Box-side "apply these credentials" half of the feature — the
 * Bluetooth exchange itself (a GATT peripheral service the phone connects
 * to before the Box has any Wi-Fi at all) is **not implemented here**,
 * same class of blocker as Milestone 8 (`node/src/transports/ble.ts`, real
 * BLE transport) — this session's sandbox has no Bluetooth stack at all
 * (`systemctl`/`bluetoothctl`/D-Bus all unreachable, verified directly, not
 * assumed), so a native BLE peripheral binding (e.g. `bleno`, BlueZ over
 * D-Bus) could be written but never even imported or exercised here, let
 * alone verified against a real phone. Writing it blind would carry the
 * same real risk this project has consistently avoided for BLE elsewhere
 * (`docs/next-steps.md`, Opzione A). This module is deliberately
 * transport-agnostic so a future real GATT server — once real Bluetooth
 * hardware is available — only has to decode bytes off a characteristic
 * into `{ssid, password}` and call `applyWifiCredentials()`, exactly the
 * "protocol separate from transport" layering `sx126x-bridge-protocol.ts`/
 * `lora-serial-sx1262.ts` already established for LoRa.
 *
 * **`nmcli` syntax verified with real web access** (not assumed, same
 * discipline as `KiwixGateway`/`FlatnotesGateway`'s own API verification,
 * `docs/security.md` voci #97/#100): `nmcli [OPTIONS] device wifi connect
 * <ssid> password <password>` — `--wait <seconds>` is a *global* option
 * and must precede `device`, not follow it. Exit codes are meaningful and
 * distinct (not just zero/non-zero): `1` generic error, `2` invalid user
 * input, `3` the `--wait` timeout expired with no result yet, `4` connection
 * activation failed (e.g. wrong password) — mapped to distinct messages in
 * `describeNmcliFailure()` below instead of one generic "failed".
 */

export interface WifiCredentials {
  ssid: string;
  password: string;
}

/** IEEE 802.11 SSID limit (32 bytes) — treated here as a character-count upper bound, an accepted simplification: a multibyte UTF-8 SSID could exceed 32 *bytes* while staying under 32 *characters*, not worth the extra complexity for a first version rejecting only the clearly-invalid case. */
const MAX_SSID_LENGTH = 32;
/** WPA/WPA2-PSK passphrase length bounds (Wi-Fi Alliance standard, not nmcli-specific) — a raw 64-hex-digit PSK key is a separate, rarer input form this module doesn't support. Reti aperte o WEP non sono supportate da questa prima versione (found by review): il messaggio sotto lo dichiara esplicitamente, invece di un errore di lunghezza che sembrerebbe un bug a un operatore con una rete aperta. */
const MIN_WPA_PASSWORD_LENGTH = 8;
const MAX_WPA_PASSWORD_LENGTH = 63;

/**
 * Validates a Wi-Fi provisioning request defensively — never trusts its
 * shape, same posture as every other network-sourced payload in this
 * codebase (`CLAUDE.md`). Throws with a message safe to surface to the
 * pairing phone as-is — sempre in italiano, stessa lingua di
 * `describeNmcliFailure()` sotto (found by review: la prima versione
 * mescolava italiano/inglese tra le due funzioni dello stesso file).
 */
export function validateWifiCredentials(payload: unknown): WifiCredentials {
  if (!payload || typeof payload !== "object") throw new Error("richiesta non valida: payload mancante");
  const { ssid, password } = payload as { ssid?: unknown; password?: unknown };

  if (typeof ssid !== "string" || ssid.length === 0 || ssid.length > MAX_SSID_LENGTH) {
    throw new Error(`'ssid' deve essere una stringa non vuota di al massimo ${MAX_SSID_LENGTH} caratteri`);
  }
  // Un SSID che inizia con "-" rischia di essere interpretato da nmcli come un'opzione invece che
  // come l'SSID posizionale (found by review) — non essendo verificabile con certezza se un
  // separatore "--" risolva il problema per questo specifico sottocomando di nmcli in questo
  // ambiente privo di NetworkManager, viene rifiutato esplicitamente invece di tentare un workaround
  // non verificato.
  if (ssid.startsWith("-")) {
    throw new Error("'ssid' non può iniziare con '-' (non supportato in modo affidabile da nmcli)");
  }
  if (typeof password !== "string" || password.length < MIN_WPA_PASSWORD_LENGTH || password.length > MAX_WPA_PASSWORD_LENGTH) {
    throw new Error(
      `'password' deve essere una stringa di ${MIN_WPA_PASSWORD_LENGTH}-${MAX_WPA_PASSWORD_LENGTH} caratteri (WPA/WPA2-PSK) — reti aperte o WEP non sono supportate da questa versione`,
    );
  }
  return { ssid, password };
}

export type WifiProvisioningResult = { status: "connected" } | { status: "failed"; reason: string };

/** How long `nmcli` itself is told to wait for the connection to succeed/fail (its own `--wait`, verified default 90s if omitted — kept far shorter here since a phone waiting on a Bluetooth exchange needs a prompt answer, not nmcli's own default). */
const DEFAULT_NMCLI_WAIT_SECONDS = 30;
/** `execFile`'s own timeout, strictly above `nmcli`'s `--wait` — a backstop in case `nmcli`/`sudo` itself hangs instead of exiting on its own timeout, same "belt and suspenders" reasoning as `host-power.ts`'s `DEFAULT_TIMEOUT_MS`. */
const EXEC_TIMEOUT_MARGIN_SECONDS = 10;

/**
 * Runs `nmcli device wifi connect` with the given credentials. Never
 * throws: a failure to connect is a normal, expected outcome of Wi-Fi
 * provisioning (wrong password, network out of range), reported as
 * `{status: "failed", reason}` rather than a rejected promise — the caller
 * (a future real GATT service) needs to relay this back to the pairing
 * phone as a normal response, not treat it as an internal server error.
 *
 * Requires the system user running this process to hold a `sudo`/polkit
 * grant for `nmcli` (host/OS configuration, the user's own responsibility
 * per `CLAUDE.md`) — invocato quindi tramite `sudo`, non direttamente,
 * stesso motivo di `host-power.ts`: su un Box headless senza sessione
 * grafica attiva le regole polkit di default di NetworkManager negano
 * `network-control` a un processo systemd senza sessione (found by review —
 * la prima versione lo dichiarava nel commento ma non lo faceva nel
 * codice). **Non verificato against a real host in this environment**, no
 * NetworkManager/root access here to test against.
 */
export async function applyWifiCredentials(
  credentials: WifiCredentials,
  waitSeconds: number = DEFAULT_NMCLI_WAIT_SECONDS,
): Promise<WifiProvisioningResult> {
  try {
    await execFileAsync(
      "sudo",
      ["nmcli", "--wait", String(waitSeconds), "device", "wifi", "connect", credentials.ssid, "password", credentials.password],
      { timeout: (waitSeconds + EXEC_TIMEOUT_MARGIN_SECONDS) * 1000 },
    );
    return { status: "connected" };
  } catch (err) {
    return { status: "failed", reason: describeNmcliFailure(err) };
  }
}

/**
 * Il fallback generico copre due casi distinti che non è possibile
 * distinguere in modo affidabile solo dal codice di uscita — `sudo` stesso
 * che rifiuta (nessun grant configurato) e un codice di `nmcli` non tra i
 * quattro documentati — invece di analizzare `stderr` per indovinare quale
 * dei due sia, un'euristica fragile attraverso versioni diverse di
 * sudo/nmcli (found by review, deliberatamente non risolto qui).
 */
function describeNmcliFailure(err: unknown): string {
  const error = err as { code?: number; killed?: boolean } | undefined;
  if (error?.killed) {
    // The execFile timeout backstop fired — nmcli/sudo itself didn't exit on its own --wait.
    return "timeout: nmcli non ha risposto entro il tempo massimo consentito";
  }
  switch (error?.code) {
    case 2:
      return "richiesta non valida (SSID o password rifiutati da nmcli)";
    case 3:
      return "timeout: nessuna risposta dalla rete indicata entro il tempo massimo";
    case 4:
      return "connessione fallita — verifica che password e nome rete siano corretti";
    default:
      return "errore sconosciuto nell'applicare le credenziali Wi-Fi (verifica anche i permessi sudo/polkit configurati sul Box)";
  }
}
