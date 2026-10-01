/**
 * Generates a systemd **user** unit (not a system-wide one — no root
 * needed, matches "ARALD Portable" running as an ordinary desktop app
 * under the logged-in user, same persistence mechanism already validated
 * on the real ARALD Box prototype, `docs/deployment.md` 28 settembre
 * 2026 — just a user unit there instead of a system one).
 *
 * **Only the generated unit *text* is verified in this environment** — its
 * syntax matches real, working `docs/riavvio-box-prototipo.md`/`docs/deployment.md`
 * precedent — actually installing/starting it (`systemctl --user enable
 * --now`) requires a running user systemd instance (a real login session
 * with D-Bus), which this sandbox does not have (`systemctl --user status`
 * fails here with "Failed to connect to bus: No medium found", confirmed
 * directly, not assumed). `installAutostartLinux()` below still performs
 * the real filesystem steps (write the unit file, print the exact commands
 * to run) — only the two `systemctl`/`loginctl` calls themselves are left
 * for the user to run by hand on a real desktop.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface AutostartOptions {
  /** Absolute path to the `arald-portable` executable (or the `node dist/cli.js` invocation, for a non-SEA dev setup). */
  execPath: string;
  /** Extra arguments, e.g. `["--id", "MyNode", "--portable"]` — each wrapped in double quotes only if it contains whitespace, systemd's own documented `ExecStart=` quoting rule. */
  args?: string[];
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export const SYSTEMD_UNIT_NAME = "arald-portable.service";

export function generateSystemdUserUnit(options: AutostartOptions): string {
  const execLine = [options.execPath, ...(options.args ?? [])].map(quoteIfNeeded).join(" ");
  return `[Unit]
Description=ARALD Portable
After=network.target

[Service]
ExecStart=${execLine}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * Writes the unit file to the standard per-user systemd unit directory
 * (`~/.config/systemd/user/`, the documented search path for user units)
 * and returns the exact commands the person still needs to run themselves
 * — `installAutostartLinux()` never calls `systemctl`/`loginctl` itself,
 * both because this sandbox cannot (no user bus here) and because actually
 * enabling a persistent background service is exactly the kind of
 * consequential, hard-to-reverse-blindly action this project always surfaces
 * to a human rather than runs silently on their behalf.
 */
export function installAutostartLinux(homeDir: string, options: AutostartOptions): { unitPath: string; commandsToRun: string[] } {
  const unitDir = path.join(homeDir, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, SYSTEMD_UNIT_NAME);
  writeFileSync(unitPath, generateSystemdUserUnit(options));
  return {
    unitPath,
    commandsToRun: [
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`,
      // A user unit only starts automatically at boot (not just at login) once "lingering" is enabled
      // for that user — systemd's own documented requirement, easy to miss and easy to explain wrong,
      // so stated explicitly here rather than left implicit.
      "loginctl enable-linger $USER   # necessario perché il servizio parta anche senza una sessione utente attiva",
    ],
  };
}
