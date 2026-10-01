import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSystemdUserUnit, installAutostartLinux, SYSTEMD_UNIT_NAME } from "../../packaging/autostart-linux.js";

describe("generateSystemdUserUnit", () => {
  it("produces a well-formed unit with the given exec line", () => {
    const unit = generateSystemdUserUnit({ execPath: "/opt/arald/arald-portable", args: ["--id", "MyNode", "--portable"] });
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("ExecStart=/opt/arald/arald-portable --id MyNode --portable");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Restart=on-failure");
  });

  it("quotes an argument containing whitespace, systemd's own ExecStart= convention", () => {
    const unit = generateSystemdUserUnit({ execPath: "/opt/arald/arald-portable", args: ["--id", "My Node"] });
    expect(unit).toContain('ExecStart=/opt/arald/arald-portable --id "My Node"');
  });

  it("works with no extra args at all", () => {
    const unit = generateSystemdUserUnit({ execPath: "/opt/arald/arald-portable" });
    expect(unit).toContain("ExecStart=/opt/arald/arald-portable");
  });
});

describe("installAutostartLinux", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "arald-autostart-linux-test-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("writes the unit file to ~/.config/systemd/user/ and returns the commands still needed", () => {
    const result = installAutostartLinux(homeDir, { execPath: "/opt/arald/arald-portable", args: ["--portable"] });

    const expectedPath = path.join(homeDir, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
    expect(result.unitPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf8")).toContain("ExecStart=/opt/arald/arald-portable --portable");

    // Never actually runs systemctl/loginctl itself (no user bus in this sandbox, and a persistent
    // background service is a consequential action left to the person) — only tells them what to run.
    expect(result.commandsToRun.some((cmd) => cmd.includes("systemctl --user enable --now"))).toBe(true);
    expect(result.commandsToRun.some((cmd) => cmd.includes("loginctl enable-linger"))).toBe(true);
  });
});
