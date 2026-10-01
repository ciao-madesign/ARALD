/**
 * Generates the `schtasks` command that registers "ARALD Portable" to
 * start at logon — Windows's own equivalent of `autostart-linux.ts`'s
 * systemd user unit / `autostart-macos.ts`'s LaunchAgent, no admin rights
 * needed for a per-user logon task. Syntax verified via real web access
 * against Microsoft's own `schtasks create` documentation (`/tn`, `/tr`,
 * `/sc onlogon`), not assumed.
 *
 * **Entirely unverified against a real Windows host** — no Windows
 * available in this environment (same disclosed limit as every other
 * Windows/macOS-only claim in this codebase, `CLAUDE.md`). Unlike
 * `autostart-linux.ts`/`autostart-macos.ts`, there is no file for this
 * function to write ahead of time — `schtasks /create` registers the task
 * directly with Task Scheduler, so `commandToRun()` below only builds the
 * command string; actually running it is left to the person, for the same
 * "a persistent background service is a consequential action a human runs
 * themselves" reasoning as the other two platforms.
 */

export interface AutostartOptions {
  /** Absolute path to `arald-portable.exe`. */
  execPath: string;
  /** Extra arguments, e.g. `["--id", "MyNode", "--portable"]` — joined into the single quoted string `schtasks /tr` expects. */
  args?: string[];
}

export const SCHEDULED_TASK_NAME = "ARALD Portable";

function quoteForTr(value: string): string {
  return /["\s]/.test(value) ? `\\"${value.replace(/"/g, '\\"')}\\"` : value;
}

/**
 * Returns the single `schtasks /create ...` command that registers the
 * logon task — one command, not a file to write, so there is nothing for
 * this function to persist to disk the way the Linux/macOS equivalents do.
 */
export function generateAutostartCommand(options: AutostartOptions): string {
  const innerCommand = [options.execPath, ...(options.args ?? [])].map(quoteForTr).join(" ");
  return `schtasks /create /tn "${SCHEDULED_TASK_NAME}" /tr "${innerCommand}" /sc onlogon /f`;
}
