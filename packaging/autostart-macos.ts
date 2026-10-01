/**
 * Generates a per-user LaunchAgent `.plist` — macOS's own equivalent of
 * `autostart-linux.ts`'s systemd user unit (no root needed, runs as the
 * logged-in user). Format/location verified against Apple's own developer
 * documentation (`CreatingLaunchdJobs`), not assumed.
 *
 * **Entirely unverified against a real macOS host** — no macOS available
 * in this environment (same disclosed limit as every other
 * Windows/macOS-only claim in this codebase, `CLAUDE.md`). Only the
 * generated plist *text* and the file-write step are exercised here; the
 * `launchctl` commands this returns are never run by this code, both
 * because they can't be (no macOS) and because enabling a persistent
 * background service is left to the person to run themselves, same
 * reasoning as `autostart-linux.ts`'s own `installAutostartLinux()`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface AutostartOptions {
  /** Absolute path to the `arald-portable` executable. */
  execPath: string;
  /** Extra arguments, e.g. `["--id", "MyNode", "--portable"]` — each becomes its own `<string>` element, so no shell quoting concerns apply the way they do for the Linux systemd unit's single `ExecStart=` line. */
  args?: string[];
}

export const LAUNCH_AGENT_LABEL = "net.arald.portable";

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function generateLaunchAgentPlist(options: AutostartOptions): string {
  const programArguments = [options.execPath, ...(options.args ?? [])]
    .map((arg) => `        <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
`;
}

/** Writes the plist to `~/Library/LaunchAgents/` and returns the exact `launchctl` command still needed — never run here, see this file's own header for why. */
export function installAutostartMacos(homeDir: string, options: AutostartOptions): { plistPath: string; commandsToRun: string[] } {
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  mkdirSync(launchAgentsDir, { recursive: true });
  const plistPath = path.join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`);
  writeFileSync(plistPath, generateLaunchAgentPlist(options));
  return {
    plistPath,
    // `launchctl bootstrap` (macOS 10.13+) rather than the older `launchctl load` — Apple's own current
    // documentation lists both, bootstrap is the one it presents as current.
    commandsToRun: [`launchctl bootstrap gui/$(id -u) ${plistPath}`],
  };
}
