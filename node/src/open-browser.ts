import { execFile } from "node:child_process";

/**
 * Best-effort "open this URL in the system's default browser" — the last
 * step of `cli.ts`'s `--portable` first-run wizard (`docs/next-steps.md`,
 * "Installer/wizard ARALD Portable software-puro"): the installer launches
 * the packaged app, the app starts the mesh node, and this opens a browser
 * straight onto the setup page `web-ui.ts` already serves, so the person
 * never has to know a URL exists to type.
 *
 * Deliberately never used anywhere else in `cli.ts` — an ARALD Box/Portable
 * deployment is normally headless (no display, no browser to open at all),
 * so this must never run except when `--portable`'s own wizard explicitly
 * calls it. Never throws and never blocks startup on failure: a missing
 * `xdg-open`/no display available/an unexpected platform all degrade to a
 * logged message pointing the operator at the URL to open by hand, the
 * same "a GUI convenience failing is never a reason to stop the mesh node
 * from starting" posture as every other optional capability in this
 * codebase.
 *
 * Commands verified against each platform's own long-standing convention
 * (`xdg-open` is the freedesktop.org standard every Linux desktop
 * environment implements; `open`/`start` are documented macOS/Windows
 * shell built-ins) — **only the Linux `xdg-open` path has actually been
 * exercised in this environment** (no desktop session here either, so even
 * that path only proves the command is *invoked* correctly, not that a
 * browser window actually appears — no display server in this sandbox to
 * observe that). Windows/macOS are unverified, same disclosed limit as
 * every other cross-platform claim in this codebase (`CLAUDE.md`).
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? // `start` is a cmd.exe built-in, not its own executable — must be run through cmd.exe. The
          // first empty-string argument is `start`'s own window-title parameter: without it, `start`
          // treats a quoted URL as the title instead of the target, a well-known footgun of this
          // specific command.
          ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  execFile(command, args, (err) => {
    if (err) {
      console.error(`Impossibile aprire automaticamente il browser (${(err as Error).message}) — apri manualmente: ${url}`);
    }
  });
}
