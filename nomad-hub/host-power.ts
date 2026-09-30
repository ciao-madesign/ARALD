import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs the actual OS `shutdown` command for whatever host this process runs
 * on — `executeSystemShutdown()` (`docs/next-steps.md`, "Pulsante di
 * spegnimento sicuro nella Web UI") and `executeSystemReboot()` (added
 * alongside it: "aggiungi anche il riavvio, stessa logica", stessa richiesta
 * dell'utente per un caso di problemi bloccanti che richiedono di riavviare
 * il Box). Both are the same `shutdown` utility, differing only in the `-h`
 * (halt) vs `-r` (reboot) flag — sharing `runShutdownCommand()` below rather
 * than duplicating the same `execFile`/timeout logic twice.
 *
 * `execFile()`, not `exec()` — fixed argv, no shell involved, so there's no
 * string to interpolate and nothing to inject (`CLAUDE.md`'s general
 * defensive posture, applied here even though every argument is a literal,
 * never request-derived).
 *
 * `shutdown -h`/`shutdown -r` (not a hand-rolled `sync()`-then-poweroff/
 * reboot sequence) are the standard tool built for exactly the "sicuro" the
 * user asked for: they signal every running service to stop, unmount
 * filesystems, and sync disks before the actual power-off/reboot —
 * reinventing that sequence here would only add an unverified custom path
 * in place of the one every Linux init system already implements and is
 * expected to get right.
 *
 * **Whether services come back up automatically after a reboot is entirely
 * a host/OS configuration matter, not something this function (or the rest
 * of this repository) controls or guarantees** — explicitly out of scope
 * per `CLAUDE.md` ("il bring-up fisico di qualunque prototipo resta lavoro
 * privato dell'utente"). On the current Box prototype, only the ARALD node
 * itself is confirmed to auto-start via `systemd` (`docs/riavvio-box-prototipo.md`,
 * 28 settembre 2026) — whether `nomad-hub` itself and whatever Docker
 * containers this host runs (Project NOMAD today, per `docs/next-steps.md`'s
 * "Ipotesi di indipendenza da Project NOMAD" not necessarily a permanent
 * dependency — this module doesn't care either way, it only reboots the OS)
 * also have a restart-on-boot policy configured is **not documented or
 * decided anywhere in this repository**; see `management-server.ts`'s own
 * doc comment on `handleReboot()` for how this is surfaced rather than
 * silently assumed.
 *
 * Requires the system user running this process to hold a `sudo` grant
 * **specific to these two commands** (never blanket `sudo`, `CLAUDE.md`'s
 * "Priorità per chi riprende questo lavoro") — host/sudoers configuration is
 * the user's own responsibility, out of scope for this repository, and
 * **not verified against a real host in this environment** (no root/sudo
 * access here to test against).
 */

/**
 * Bounds how long this waits for `sudo`/`shutdown` to actually run before
 * treating it as failed — found by review (originally for the shutdown-only
 * version of this module): without a timeout, a `sudo` invocation that
 * blocks instead of failing fast (e.g. a misconfigured non-interactive
 * askpass helper, or a sudoers policy that isn't NOPASSWD) would leave the
 * returned promise pending forever, so `ManagementServer`'s `.catch()`
 * logging would never fire and the failure would be entirely invisible to
 * the operator.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

async function runShutdownCommand(flag: "-h" | "-r", timeoutMs: number): Promise<void> {
  await execFileAsync("sudo", ["shutdown", flag, "now"], { timeout: timeoutMs });
}

export async function executeSystemShutdown(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
  await runShutdownCommand("-h", timeoutMs);
}

export async function executeSystemReboot(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
  await runShutdownCommand("-r", timeoutMs);
}
