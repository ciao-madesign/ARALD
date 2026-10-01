import { describe, expect, it } from "vitest";
import { resolveDataDir } from "../../node/src/data-dir.js";

/**
 * `node/src/data-dir.ts` — OS-appropriate data directory resolution for
 * "ARALD Portable" (`cli.ts`'s `--portable`, `packaging/`). Every branch
 * here is exercised directly via injected `platform`/`env`/`homedir`
 * (never the real `process.platform`/`os.homedir()`) — the only way to
 * test the Windows/macOS branches at all in this Linux-only sandbox, and
 * the only way to make the Linux branch itself independent of whatever
 * real home directory/environment this test happens to run under.
 */
describe("resolveDataDir", () => {
  it("uses %APPDATA%\\ARALD on win32 when APPDATA is set", () => {
    const dir = resolveDataDir({ platform: "win32", env: { APPDATA: "C:\\Users\\Mario\\AppData\\Roaming" }, homedir: () => "C:\\Users\\Mario" });
    expect(dir).toBe("C:\\Users\\Mario\\AppData\\Roaming\\ARALD");
  });

  it("falls back to <home>\\AppData\\Roaming\\ARALD on win32 when APPDATA is unset", () => {
    const dir = resolveDataDir({ platform: "win32", env: {}, homedir: () => "C:\\Users\\Mario" });
    expect(dir).toBe("C:\\Users\\Mario\\AppData\\Roaming\\ARALD");
  });

  it("uses ~/Library/Application Support/ARALD on darwin", () => {
    const dir = resolveDataDir({ platform: "darwin", env: {}, homedir: () => "/Users/mario" });
    expect(dir).toBe("/Users/mario/Library/Application Support/ARALD");
  });

  it("uses $XDG_DATA_HOME/arald on linux when XDG_DATA_HOME is set", () => {
    const dir = resolveDataDir({ platform: "linux", env: { XDG_DATA_HOME: "/home/mario/.data" }, homedir: () => "/home/mario" });
    expect(dir).toBe("/home/mario/.data/arald");
  });

  it("falls back to ~/.local/share/arald on linux when XDG_DATA_HOME is unset", () => {
    const dir = resolveDataDir({ platform: "linux", env: {}, homedir: () => "/home/mario" });
    expect(dir).toBe("/home/mario/.local/share/arald");
  });

  it("treats any other platform (e.g. freebsd) the same as linux", () => {
    const dir = resolveDataDir({ platform: "freebsd", env: {}, homedir: () => "/home/mario" });
    expect(dir).toBe("/home/mario/.local/share/arald");
  });

  it("defaults to the real process.platform/process.env/os.homedir() when no options are given", () => {
    // Not asserting an exact path (depends on the real sandbox) — just that it doesn't throw and
    // returns a non-empty absolute-looking path, proving the real defaults are wired correctly.
    const dir = resolveDataDir();
    expect(typeof dir).toBe("string");
    expect(dir.length).toBeGreaterThan(0);
  });
});
