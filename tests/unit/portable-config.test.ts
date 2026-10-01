import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOrCreatePortableConfig } from "../../node/src/portable-config.js";

// Only `existsSync` is ever overridden (per-test, via `mockReturnValueOnce`) — every other `node:fs`
// export delegates to the real implementation, so every test except the one that explicitly uses the
// override below still exercises real file I/O exactly as before.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

/**
 * `node/src/portable-config.ts` — the persisted settings file behind
 * `cli.ts`'s `--portable` flag (`docs/next-steps.md`, "Installer/wizard
 * ARALD Portable software-puro"). Real filesystem operations throughout
 * (a fresh `mkdtempSync` directory per test, cleaned up after) — this
 * module's whole job is file I/O, so faking `node:fs` would test nothing
 * real.
 */
describe("loadOrCreatePortableConfig", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "arald-portable-config-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates a fresh config with sensible defaults when no file exists yet", () => {
    const configPath = path.join(dataDir, "config.json");
    const { config, created } = loadOrCreatePortableConfig(configPath, dataDir);

    expect(created).toBe(true);
    expect(config.identityDir).toBe(path.join(dataDir, "identity"));
    expect(existsSync(config.identityDir)).toBe(true); // actually created on disk, not just named
    expect(config.webPort).toBeGreaterThan(0);
    expect(config.port).toBe(0);
    expect(config.networkPassword).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/); // generateNetworkPassword()'s own shape
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(config);
  });

  it("loads back an already-well-formed config unchanged, never regenerating the password", () => {
    const configPath = path.join(dataDir, "config.json");
    const first = loadOrCreatePortableConfig(configPath, dataDir);

    const second = loadOrCreatePortableConfig(configPath, dataDir);
    expect(second.created).toBe(false);
    expect(second.config).toEqual(first.config);
  });

  it("regenerates with fresh defaults when the file contains malformed JSON", () => {
    const configPath = path.join(dataDir, "config.json");
    writeFileSync(configPath, "{ not valid json");

    const { config, created } = loadOrCreatePortableConfig(configPath, dataDir);
    expect(created).toBe(true);
    expect(config.networkPassword).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("regenerates with fresh defaults when the file is valid JSON but not an object", () => {
    const configPath = path.join(dataDir, "config.json");
    writeFileSync(configPath, JSON.stringify([1, 2, 3]));

    const { created } = loadOrCreatePortableConfig(configPath, dataDir);
    expect(created).toBe(true);
  });

  it("fills in just the missing/invalid fields of a partially-malformed config, and persists the repaired result instead of regenerating it on every future call (regression: a config missing only networkPassword must not mint a new one on every single start)", () => {
    const configPath = path.join(dataDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ identityDir: path.join(dataDir, "my-identity"), webPort: 9999, port: -5 /* invalid */ }));

    const first = loadOrCreatePortableConfig(configPath, dataDir);
    expect(first.created).toBe(false); // the file DID exist and was salvageable, not a from-scratch creation
    expect(first.config.identityDir).toBe(path.join(dataDir, "my-identity")); // valid field preserved
    expect(first.config.webPort).toBe(9999); // valid field preserved
    expect(first.config.port).toBe(0); // invalid field (-5) replaced with the default
    expect(first.config.networkPassword).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/); // missing field filled in

    // The repaired config must have been written back to disk — a second load returns the exact same
    // password instead of generating yet another new one.
    const second = loadOrCreatePortableConfig(configPath, dataDir);
    expect(second.config).toEqual(first.config);
  });

  it("rejects an out-of-range webPort/port and falls back instead of trusting the file blindly", () => {
    const configPath = path.join(dataDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ identityDir: path.join(dataDir, "id"), webPort: 70000, port: 70000, networkPassword: "AAAA-BBBB" }));

    const { config } = loadOrCreatePortableConfig(configPath, dataDir);
    expect(config.webPort).not.toBe(70000);
    expect(config.port).not.toBe(70000);
    expect(config.networkPassword).toBe("AAAA-BBBB"); // the one valid field survives untouched
  });

  it("writes config.json and the identity directory owner-only (0600/0700), never the OS default — the only secret-bearing artifact in this codebase that isn't owner-only would otherwise be this one (regression, code review)", () => {
    const configPath = path.join(dataDir, "config.json");
    const { config } = loadOrCreatePortableConfig(configPath, dataDir);

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(config.identityDir).mode & 0o777).toBe(0o700);
  });

  it("re-persisting a repaired partially-malformed config also keeps it owner-only", () => {
    const configPath = path.join(dataDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ webPort: 9999 })); // missing everything else

    loadOrCreatePortableConfig(configPath, dataDir);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("recovers from losing a create race against a concurrent --portable launch on the same dataDir, instead of crashing or silently disagreeing about the network password (regression, code review)", () => {
    const configPath = path.join(dataDir, "config.json");
    // Simulates the exact race: this call's own existsSync() check reports "nothing here yet" (as it
    // genuinely would have, a moment earlier), but by the time it goes to create the file, a concurrent
    // process has already won and written its own real config to disk.
    const winnerConfig = loadOrCreatePortableConfig(path.join(dataDir, "winner-placeholder.json"), dataDir).config;
    writeFileSync(configPath, JSON.stringify(winnerConfig, null, 2), { mode: 0o600 });
    vi.mocked(existsSync).mockReturnValueOnce(false);

    const { config, created } = loadOrCreatePortableConfig(configPath, dataDir);
    expect(created).toBe(false); // recovered the winner's config, not a fresh third one
    expect(config.networkPassword).toBe(winnerConfig.networkPassword);
  });
});
