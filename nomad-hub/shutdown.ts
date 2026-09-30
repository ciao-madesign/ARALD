import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs the actual OS shutdown command for whatever host this process runs
 * on (`docs/next-steps.md`, "Pulsante di spegnimento sicuro nella Web UI").
 * `execFile()`, not `exec()` — fixed argv, no shell involved, so there's no
 * string to interpolate and nothing to inject (`CLAUDE.md`'s general
 * defensive posture, applied here even though every argument is a literal,
 * never request-derived).
 *
 * `shutdown -h` (not a hand-rolled `sync()`-then-poweroff sequence) is the
 * standard tool built for exactly the "spegnimento sicuro" the user asked
 * for: it signals every running service to stop, unmounts filesystems, and
 * syncs disks before the actual power-off — reinventing that sequence here
 * would only add an unverified custom path in place of the one every Linux
 * init system already implements and is expected to get right.
 *
 * Requires the system user running this process to hold a `sudo` grant
 * **specific to this one command** (never blanket `sudo`, `CLAUDE.md`'s
 * "Priorità per chi riprende questo lavoro") — host/sudoers configuration is
 * the user's own responsibility, out of scope for this repository, and
 * **not verified against a real host in this environment** (no root/sudo
 * access here to test against).
 */
/**
 * Bounds how long this waits for `sudo`/`shutdown` to actually run before
 * treating it as failed — found by review: without a timeout, a `sudo`
 * invocation that blocks instead of failing fast (e.g. a misconfigured
 * non-interactive askpass helper, or a sudoers policy that isn't NOPASSWD)
 * would leave the returned promise pending forever, so
 * `ManagementServer.handleShutdown()`'s `.catch()` logging would never fire
 * and the failure would be entirely invisible to the operator.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export async function executeSystemShutdown(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
  await execFileAsync("sudo", ["shutdown", "-h", "now"], { timeout: timeoutMs });
}
