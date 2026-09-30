import { describe, expect, it, vi } from "vitest";

/**
 * `nomad-hub/wifi-provisioning.ts` — the Box-side "apply these Wi-Fi
 * credentials" half of the Bluetooth provisioning feature
 * (`docs/next-steps.md`). Same posture as `nomad-hub-host-power.test.ts`:
 * `node:child_process` mocked so this test never actually reconfigures the
 * network of the machine running the suite (and because no NetworkManager
 * exists in this environment to run `nmcli` against for real anyway).
 */

type ExecFileCallback = (err: (Error & { code?: number; killed?: boolean }) | null, result?: { stdout: string; stderr: string }) => void;

const execFileMock = vi.fn((_cmd: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
  callback(null, { stdout: "", stderr: "" });
});

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

describe("validateWifiCredentials (nomad-hub/wifi-provisioning.ts)", () => {
  it("accepts a well-formed request", async () => {
    const { validateWifiCredentials } = await import("../../nomad-hub/wifi-provisioning.js");
    expect(validateWifiCredentials({ ssid: "RifugioWiFi", password: "montagna123" })).toEqual({
      ssid: "RifugioWiFi",
      password: "montagna123",
    });
  });

  it("rejects a missing/non-object payload", async () => {
    const { validateWifiCredentials } = await import("../../nomad-hub/wifi-provisioning.js");
    expect(() => validateWifiCredentials(null)).toThrow(/payload mancante/);
    expect(() => validateWifiCredentials(undefined)).toThrow(/payload mancante/);
    expect(() => validateWifiCredentials("not an object")).toThrow(/payload mancante/);
  });

  it("rejects a missing, empty, or over-length ssid", async () => {
    const { validateWifiCredentials } = await import("../../nomad-hub/wifi-provisioning.js");
    expect(() => validateWifiCredentials({ password: "montagna123" })).toThrow(/ssid/);
    expect(() => validateWifiCredentials({ ssid: "", password: "montagna123" })).toThrow(/ssid/);
    expect(() => validateWifiCredentials({ ssid: "x".repeat(33), password: "montagna123" })).toThrow(/ssid/);
    expect(() => validateWifiCredentials({ ssid: 12345, password: "montagna123" })).toThrow(/ssid/);
  });

  it("rejects an ssid starting with '-' — nmcli's argument parser can mistake it for an option instead of the positional ssid (regression, code-review)", async () => {
    const { validateWifiCredentials } = await import("../../nomad-hub/wifi-provisioning.js");
    expect(() => validateWifiCredentials({ ssid: "-guest", password: "montagna123" })).toThrow(/ssid/);
    expect(() => validateWifiCredentials({ ssid: "--refuge", password: "montagna123" })).toThrow(/ssid/);
  });

  it("rejects a password outside the WPA/WPA2-PSK length bounds (8-63)", async () => {
    const { validateWifiCredentials } = await import("../../nomad-hub/wifi-provisioning.js");
    expect(() => validateWifiCredentials({ ssid: "Rifugio", password: "short" })).toThrow(/password/);
    expect(() => validateWifiCredentials({ ssid: "Rifugio", password: "x".repeat(64) })).toThrow(/password/);
    expect(() => validateWifiCredentials({ ssid: "Rifugio" })).toThrow(/password/);
    // Boundary values must be accepted, not just rejected outside them.
    expect(validateWifiCredentials({ ssid: "Rifugio", password: "12345678" })).toEqual({ ssid: "Rifugio", password: "12345678" });
    expect(validateWifiCredentials({ ssid: "Rifugio", password: "x".repeat(63) })).toEqual({ ssid: "Rifugio", password: "x".repeat(63) });
  });
});

describe("applyWifiCredentials (nomad-hub/wifi-provisioning.ts)", () => {
  it("invokes 'sudo nmcli --wait <seconds> device wifi connect <ssid> password <password>', never a shell", async () => {
    const { applyWifiCredentials } = await import("../../nomad-hub/wifi-provisioning.js");

    const result = await applyWifiCredentials({ ssid: "RifugioWiFi", password: "montagna123" }, 20);

    expect(result).toEqual({ status: "connected" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[execFileMock.mock.calls.length - 1];
    expect(cmd).toBe("sudo");
    expect(args).toEqual(["nmcli", "--wait", "20", "device", "wifi", "connect", "RifugioWiFi", "password", "montagna123"]);
  });

  it("passes to execFile exactly waitSeconds plus the documented margin, not just 'something above' it (regression, code-review: a loose >30_000 assertion would survive the margin shrinking to near zero)", async () => {
    const { applyWifiCredentials } = await import("../../nomad-hub/wifi-provisioning.js");

    await applyWifiCredentials({ ssid: "Rifugio", password: "montagna123" }, 30);

    const [, , options] = execFileMock.mock.calls[execFileMock.mock.calls.length - 1];
    expect((options as { timeout: number }).timeout).toBe(40_000);
  });

  it("reports {status: 'failed'} instead of throwing when nmcli exits non-zero — a wrong password is an expected outcome, not an internal error", async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _options, callback: ExecFileCallback) => {
      const error = Object.assign(new Error("Error: Connection activation failed"), { code: 4 });
      callback(error);
    });
    const { applyWifiCredentials } = await import("../../nomad-hub/wifi-provisioning.js");

    const result = await applyWifiCredentials({ ssid: "Rifugio", password: "wrongpassword" });

    expect(result.status).toBe("failed");
    expect((result as { reason: string }).reason).toMatch(/password.*nome rete|connessione fallita/i);
  });

  it("maps each documented nmcli exit code to a distinct reason, not one generic message", async () => {
    const { applyWifiCredentials } = await import("../../nomad-hub/wifi-provisioning.js");
    const cases: Array<[number, RegExp]> = [
      [2, /richiesta non valida/],
      [3, /timeout/],
      [4, /connessione fallita/],
      [1, /errore sconosciuto/],
    ];
    for (const [code, expected] of cases) {
      execFileMock.mockImplementationOnce((_cmd, _args, _options, callback: ExecFileCallback) => {
        callback(Object.assign(new Error("nmcli error"), { code }));
      });
      const result = await applyWifiCredentials({ ssid: "Rifugio", password: "montagna123" });
      expect(result).toEqual({ status: "failed", reason: expect.stringMatching(expected) });
    }
  });

  it("distinguishes execFile's own timeout backstop (killed) from nmcli's own --wait timeout (exit code 3)", async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _options, callback: ExecFileCallback) => {
      callback(Object.assign(new Error("nmcli killed"), { killed: true, signal: "SIGTERM" }));
    });
    const { applyWifiCredentials } = await import("../../nomad-hub/wifi-provisioning.js");

    const result = await applyWifiCredentials({ ssid: "Rifugio", password: "montagna123" });

    expect(result).toEqual({ status: "failed", reason: expect.stringMatching(/tempo massimo consentito/) });
  });
});
