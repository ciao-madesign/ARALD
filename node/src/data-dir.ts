/**
 * Resolves the OS-appropriate base directory for ARALD's own persistent
 * state when run as "ARALD Portable" (`packaging/`, `docs/next-steps.md`
 * "Installer/wizard ARALD Portable software-puro") — a single place for
 * the node's identity, its generated config, and anything else a
 * non-technical user's install should keep across restarts, chosen the
 * same way most desktop apps do: a per-user, OS-conventional location, not
 * a path the user ever has to think about.
 *
 * Only `cli.ts`'s `--portable` flag calls this — every other deployment
 * (ARALD Box/Portable-with-radio, a developer running `tsx`/`node dist/cli.js`
 * directly) keeps using explicit flags (`--identity-dir`, etc.) exactly as
 * before, untouched by this file's existence.
 *
 * Windows/macOS conventions verified against each platform's own
 * documentation (not assumed): Windows' `%APPDATA%` (Roaming) is
 * Microsoft's own documented location for "user-specific but
 * machine-independent" application data; macOS's `~/Library/Application
 * Support` is Apple's documented per-user application-support location.
 * **Only the Linux branch has actually been exercised in this
 * environment** (no Windows/macOS host here) — same disclosed limit as
 * every other cross-platform claim in this codebase (`CLAUDE.md`).
 */

import { homedir as realHomedir } from "node:os";

export interface ResolveDataDirOptions {
  /** Defaults to `process.platform`. Injectable so this function's Windows/macOS branches are unit-testable on any host, including this Linux sandbox. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. Injectable for the same reason — `APPDATA` only exists on a real Windows host otherwise. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `node:os`'s real `homedir()`. Injectable so a test never depends on the actual invoking user's real home directory. */
  homedir?: () => string;
}

/** Folder name used on Windows/macOS, where the platform convention capitalizes application-data folder names. Linux uses the lowercase "arald" idiom instead (`~/.local/share/arald` or `$XDG_DATA_HOME/arald`). */
const APP_FOLDER_NAME_TITLECASE = "ARALD";
const APP_FOLDER_NAME_LOWERCASE = "arald";

/**
 * Returns the absolute path of ARALD Portable's per-user data directory —
 * never created here (that's `loadOrCreatePortableConfig()`'s job, which
 * needs to create more than just this one directory); this function is
 * pure path computation, safe to call speculatively.
 */
export function resolveDataDir(options: ResolveDataDirOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? realHomedir;

  if (platform === "win32") {
    // %APPDATA% is always set by Windows itself for any interactively-launched process; falling back
    // to "<home>\AppData\Roaming" (its own documented default value) covers the rare case of a process
    // launched with a stripped environment, rather than throwing here.
    const appData = env.APPDATA || `${homedir()}\\AppData\\Roaming`;
    return `${appData}\\${APP_FOLDER_NAME_TITLECASE}`;
  }
  if (platform === "darwin") {
    return `${homedir()}/Library/Application Support/${APP_FOLDER_NAME_TITLECASE}`;
  }
  // Linux and every other platform `process.platform` can report (freebsd, etc.) — XDG_DATA_HOME when
  // set (the XDG Base Directory spec's own override for exactly this purpose), else the spec's own
  // documented default of "~/.local/share".
  const xdgDataHome = env.XDG_DATA_HOME;
  if (xdgDataHome) return `${xdgDataHome}/${APP_FOLDER_NAME_LOWERCASE}`;
  return `${homedir()}/.local/share/${APP_FOLDER_NAME_LOWERCASE}`;
}
