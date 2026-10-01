import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateLaunchAgentPlist, installAutostartMacos, LAUNCH_AGENT_LABEL } from "../../packaging/autostart-macos.js";

describe("generateLaunchAgentPlist", () => {
  it("produces a well-formed plist with the given program arguments", () => {
    const plist = generateLaunchAgentPlist({ execPath: "/Applications/ARALD.app/Contents/MacOS/arald-portable", args: ["--id", "MyNode", "--portable"] });
    expect(plist).toContain("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain("<string>/Applications/ARALD.app/Contents/MacOS/arald-portable</string>");
    expect(plist).toContain("<string>--id</string>");
    expect(plist).toContain("<string>MyNode</string>");
    expect(plist).toContain("<string>--portable</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
  });

  it("XML-escapes a value containing special characters instead of producing invalid XML", () => {
    const plist = generateLaunchAgentPlist({ execPath: "/path", args: ["--id", "A & B <test>"] });
    expect(plist).toContain("A &amp; B &lt;test&gt;");
    expect(plist).not.toContain("A & B <test>");
  });
});

describe("installAutostartMacos", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "arald-autostart-macos-test-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("writes the plist to ~/Library/LaunchAgents/ and returns the launchctl command still needed", () => {
    const result = installAutostartMacos(homeDir, { execPath: "/Applications/ARALD.app/Contents/MacOS/arald-portable" });

    const expectedPath = path.join(homeDir, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
    expect(result.plistPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf8")).toContain("arald-portable");
    expect(result.commandsToRun.some((cmd) => cmd.includes("launchctl bootstrap"))).toBe(true);
  });
});
