import { describe, expect, it, vi } from "vitest";

/**
 * `executeSystemShutdown()`/`executeSystemReboot()` (`nomad-hub/host-power.ts`)
 * are one-line wrappers around `execFile("sudo", ["shutdown", "-h"|"-r", "now"])`
 * — not verified against a real host anywhere in this repository (no
 * root/sudo access in this environment, see the module's own doc comment).
 * What *is* verifiable here, without touching a real OS, is that each
 * invokes exactly the right command with exactly the right flag, via
 * `execFile` (never `exec`, which would involve a shell) — `node:child_process`
 * mocked so this test never actually shuts down/reboots the machine running
 * the suite.
 */

type ExecFileCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

// execFileAsync (util.promisify(execFile)) always passes an options object ahead of the callback —
// host-power.ts's timeout option shifts the callback to the 4th positional argument, not the 3rd.
const execFileMock = vi.fn((_cmd: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
  callback(null, { stdout: "", stderr: "" });
});

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

describe("executeSystemShutdown (nomad-hub/host-power.ts)", () => {
  it("invokes execFile with 'sudo shutdown -h now', never a shell", async () => {
    const { executeSystemShutdown } = await import("../../nomad-hub/host-power.js");

    await executeSystemShutdown();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("sudo");
    expect(args).toEqual(["shutdown", "-h", "now"]);
  });

  it("passes the given timeout through to execFile's options", async () => {
    const { executeSystemShutdown } = await import("../../nomad-hub/host-power.js");

    await executeSystemShutdown(5000);

    const [, , options] = execFileMock.mock.calls[execFileMock.mock.calls.length - 1];
    expect((options as { timeout: number }).timeout).toBe(5000);
  });

  it("propagates a failure from execFile instead of swallowing it", async () => {
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      (callback as unknown as (err: Error) => void)(new Error("sudo: a password is required"));
    });
    const { executeSystemShutdown } = await import("../../nomad-hub/host-power.js");

    await expect(executeSystemShutdown()).rejects.toThrow(/password is required/);
  });
});

describe("executeSystemReboot (nomad-hub/host-power.ts)", () => {
  it("invokes execFile with 'sudo shutdown -r now', never a shell — regression: must never reuse the -h (halt) flag executeSystemShutdown() uses", async () => {
    const { executeSystemReboot } = await import("../../nomad-hub/host-power.js");

    await executeSystemReboot();

    const [cmd, args] = execFileMock.mock.calls[execFileMock.mock.calls.length - 1];
    expect(cmd).toBe("sudo");
    expect(args).toEqual(["shutdown", "-r", "now"]);
  });

  it("passes the given timeout through to execFile's options", async () => {
    const { executeSystemReboot } = await import("../../nomad-hub/host-power.js");

    await executeSystemReboot(5000);

    const [, , options] = execFileMock.mock.calls[execFileMock.mock.calls.length - 1];
    expect((options as { timeout: number }).timeout).toBe(5000);
  });

  it("propagates a failure from execFile instead of swallowing it", async () => {
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      (callback as unknown as (err: Error) => void)(new Error("sudo: a password is required"));
    });
    const { executeSystemReboot } = await import("../../nomad-hub/host-power.js");

    await expect(executeSystemReboot()).rejects.toThrow(/password is required/);
  });
});
