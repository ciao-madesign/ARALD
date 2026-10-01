import { describe, expect, it, vi } from "vitest";

/**
 * `node/src/open-browser.ts` — the last step of `cli.ts`'s `--portable`
 * first-run wizard. `node:child_process` mocked so this test never
 * actually tries to pop open a real browser (no display server in this
 * sandbox anyway, same reasoning as `nomad-hub-host-power.test.ts`).
 */
type ExecFileCallback = (err: Error | null) => void;
const execFileMock = vi.fn((_cmd: string, _args: string[], callback: ExecFileCallback) => {
  callback(null);
});
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

describe("openInBrowser", () => {
  it("uses xdg-open on linux", async () => {
    const { openInBrowser } = await import("../../node/src/open-browser.js");
    openInBrowser("http://127.0.0.1:8080", "linux");
    expect(execFileMock).toHaveBeenCalledWith("xdg-open", ["http://127.0.0.1:8080"], expect.any(Function));
  });

  it("uses open on darwin", async () => {
    const { openInBrowser } = await import("../../node/src/open-browser.js");
    openInBrowser("http://127.0.0.1:8080", "darwin");
    expect(execFileMock).toHaveBeenCalledWith("open", ["http://127.0.0.1:8080"], expect.any(Function));
  });

  it("uses cmd /c start on win32, with the empty-string title argument that avoids the quoted-URL-as-title footgun", async () => {
    const { openInBrowser } = await import("../../node/src/open-browser.js");
    openInBrowser("http://127.0.0.1:8080", "win32");
    expect(execFileMock).toHaveBeenCalledWith("cmd", ["/c", "start", "", "http://127.0.0.1:8080"], expect.any(Function));
  });

  it("never throws when execFile reports an error — logs instead", async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, callback: ExecFileCallback) => {
      callback(new Error("xdg-open: command not found"));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { openInBrowser } = await import("../../node/src/open-browser.js");

    expect(() => openInBrowser("http://127.0.0.1:8080", "linux")).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("http://127.0.0.1:8080"));
    errorSpy.mockRestore();
  });
});
