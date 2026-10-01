import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateNetworkPassword } from "./web-ui.js";

/**
 * Persisted settings for an "ARALD Portable" install (`cli.ts`'s `--portable`
 * flag, `packaging/`, `docs/next-steps.md` "Installer/wizard ARALD Portable
 * software-puro") — the file a non-technical user's install writes once on
 * first run and reuses on every later start, so the wizard only ever runs
 * once, not on every boot. Every field here already has a direct flag
 * equivalent elsewhere in `cli.ts` (`--identity-dir`, `--web-port`, `--port`,
 * `--network-password`) — this is deliberately not a parallel, richer
 * configuration surface, only the minimum needed for the Wi-Fi-only portable
 * profile to be self-sufficient without any flag at all.
 */
export interface PortableConfig {
  /** Absolute path, passed straight through to `Identity.loadOrCreate()` exactly as `--identity-dir` already does — chosen once and persisted so a restart never mints a new node identity. */
  identityDir: string;
  /** `WebUiOptions.port` — fixed, not `0`, unlike the mesh `port` below: the wizard needs a predictable address to open a browser to on every run, not just the first. */
  webPort: number;
  /** The mesh `TcpTransport`'s own listen port — `0` (OS-assigned) by default: nothing in this profile needs it to be predictable the way `webPort` does, and `0` avoids a fixed port ever colliding with another local service. */
  port: number;
  /** Generated once via `generateNetworkPassword()` (`web-ui.ts`) and persisted — regenerating it on every start would silently invalidate every phone already paired with this install. */
  networkPassword: string;
}

/** Default `webPort` for a fresh portable config — the same value every example in `CLAUDE.md`/`docs/development.md` already uses for `--web-port`, not a new convention. */
const DEFAULT_PORTABLE_WEB_PORT = 8080;

/**
 * `0o600`/`0o700` (owner-only) on `config.json`/`identityDir` — found by
 * code review: the first version wrote both with the OS default
 * (~0644/0755 after umask), the only secret-bearing artifact in this
 * codebase to do so — `identity.ts`'s own `Identity.loadOrCreate()` writes
 * `private.key` as `0o600` and its directory as `0o700` for exactly the
 * same reason (a shared/multi-user machine must not let another local
 * account read this node's mesh network password or list its identity
 * directory). Creating `identityDir` with `0o700` here matters even though
 * `Identity.loadOrCreate()` also requests `0o700` on its own `mkdirSync()`
 * call: Node does not `chmod` an *already-existing* directory on a
 * recursive `mkdirSync()`, so if this module created it first with default
 * permissions, that later call would silently do nothing to fix it.
 *
 * Same reasoning applies to `writeFileSync`'s own `mode` option on
 * `config.json`: it is honored only at true file-*creation* time — it does
 * nothing to a path that already exists with looser permissions (e.g. a
 * config a user hand-edited with a plain text editor, or the repair-write
 * path below overwriting a file this module itself first created before
 * this permissions fix existed). `persistConfigSecurely()` therefore always
 * follows the write with an explicit `chmodSync`, never relying on `mode`
 * alone (found by the regression test added alongside this fix).
 */
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

/** Writes `config` to `configPath` as pretty-printed JSON and unconditionally enforces `SECRET_FILE_MODE` via `chmodSync` afterwards — `writeFileSync`'s own `mode` option is not enough on its own (see the comment on `SECRET_FILE_MODE` above). */
function persistConfigSecurely(configPath: string, config: PortableConfig): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: SECRET_FILE_MODE });
  chmodSync(configPath, SECRET_FILE_MODE);
}

/** `mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE })` doesn't retroactively `chmod` a directory that already existed with different permissions — same `mode`-at-creation-only caveat as files, so this always follows up with an explicit `chmodSync` too. */
function ensureSecretDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
  chmodSync(dir, SECRET_DIR_MODE);
}

export interface LoadOrCreatePortableConfigResult {
  config: PortableConfig;
  /** `true` only when no config file existed yet at `configPath` and this call just created one with fresh defaults — the one signal `cli.ts` needs to decide whether this is a genuine first run (and should open a browser) versus an ordinary restart of an already-set-up install. */
  created: boolean;
}

/**
 * Loads `configPath` if it already holds a well-formed `PortableConfig`, or
 * creates one (and the `dataDir` it lives under, plus a sibling `identity/`
 * directory for `identityDir`) with fresh defaults otherwise — same
 * "defensive load, never trust the shape of a file this process didn't just
 * write itself" posture as `cli.ts`'s own `loadExternalDeliveryAllowlist()`:
 * a config file is still something a user could have hand-edited into a
 * broken state, not a payload from the network, but the same discipline
 * applies for the same reason (a malformed field must never crash the
 * process, only fall back to a fresh default for that field alone).
 *
 * **Race-safe against two `--portable` launches racing on the same
 * `dataDir`** — found by code review: a non-technical user double-clicking
 * the packaged app twice in quick succession is a plausible way to trigger
 * exactly this. This only matters, and only uses the `"wx"` flag (fail
 * instead of overwrite if the file now exists), when `configPath` genuinely
 * didn't exist a moment ago — a file that already exists but is malformed
 * (bad JSON, not an object) is a different, non-racy case and is simply
 * overwritten with fresh defaults, never routed through `"wx"` (which would
 * always fail with `EEXIST` there, since the file really is present — found
 * by a regression test after an earlier version of this fix conflated the
 * two cases and broke ordinary malformed-file recovery). In the genuine
 * race case, if a concurrent process won, this one discards the config it
 * just generated in memory (never shown to the operator yet at this point)
 * and re-reads whatever the winner actually persisted, rather than two
 * processes each believing a different network password is the real one.
 *
 * Throws (never swallows) if the filesystem itself refuses a write
 * (permission denied, read-only data directory, etc.) — there is nothing
 * more this module can do at that point, but the thrown message names the
 * exact path and operation that failed, instead of letting a read failure
 * and a write failure further down present as the same confusing
 * "could not read/parse" message (found by code review).
 */
export function loadOrCreatePortableConfig(configPath: string, dataDir: string): LoadOrCreatePortableConfigResult {
  const configPathExistedBefore = existsSync(configPath);
  const existing = tryLoadExistingConfig(configPath, dataDir);
  if (existing) return { config: existing, created: false };

  const config: PortableConfig = {
    identityDir: path.join(dataDir, "identity"),
    webPort: DEFAULT_PORTABLE_WEB_PORT,
    port: 0,
    networkPassword: generateNetworkPassword(),
  };
  ensureSecretDir(config.identityDir);

  if (configPathExistedBefore) {
    // The file is present but tryLoadExistingConfig() above couldn't salvage it (malformed JSON, not an
    // object) — there is no concurrent "winner" to race against here, just an ordinary overwrite.
    try {
      persistConfigSecurely(configPath, config);
    } catch (err) {
      throw new Error(`--portable: impossibile scrivere il file di configurazione in ${configPath} — ${(err as Error).message}`);
    }
    return { config, created: true };
  }

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: SECRET_FILE_MODE, flag: "wx" });
    chmodSync(configPath, SECRET_FILE_MODE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Lost the race: another process created configPath between our existsSync() check above and
      // this write. Its config is now the real one — read it back instead of two processes disagreeing
      // about the network password/identity in use.
      const winner = tryLoadExistingConfig(configPath, dataDir);
      if (winner) return { config: winner, created: false };
    }
    throw new Error(`--portable: impossibile scrivere il file di configurazione in ${configPath} — ${(err as Error).message}`);
  }
  return { config, created: true };
}

/** Returns a validated `PortableConfig` if `configPath` already exists and is at least partially salvageable, `undefined` if it doesn't exist (the normal first-run case) or is entirely malformed. A partially-malformed file (parses fine, but is missing/invalid in some fields) has its gaps filled and is re-persisted immediately — found necessary while writing this: without it, a config missing just `networkPassword` would silently mint a *new* one on every single start (never persisted, so never found next time either), invalidating every phone already paired with this install on every restart instead of exactly once. */
function tryLoadExistingConfig(configPath: string, dataDir: string): PortableConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(`--portable: could not read/parse ${configPath} — ${(err as Error).message} — regenerating with fresh defaults`);
    return undefined;
  }
  const validated = validatePortableConfig(parsed, dataDir);
  if (!validated) {
    console.error(`--portable: ${configPath} exists but is malformed — regenerating with fresh defaults`);
    return undefined;
  }
  if (validated.hadFallback) {
    try {
      persistConfigSecurely(configPath, validated.config);
    } catch (err) {
      throw new Error(`--portable: impossibile riscrivere il file di configurazione riparato in ${configPath} — ${(err as Error).message}`);
    }
  }
  return validated.config;
}

interface ValidatePortableConfigResult {
  config: PortableConfig;
  /** `true` if any field had to fall back to a fresh default because `raw` lacked it or had the wrong shape — tells the caller this result must be re-persisted, not just returned as-is. */
  hadFallback: boolean;
}

/** `{value, usedFallback}` instead of a mutate-in-branch `let` — sidesteps any ambiguity in narrowing an `unknown`-typed field back down after a conditional reassignment, and keeps each field's validation self-contained and independently testable in spirit. */
function stringOrFallback(value: unknown, fallback: string): { value: string; usedFallback: boolean } {
  return typeof value === "string" && value.length > 0 ? { value, usedFallback: false } : { value: fallback, usedFallback: true };
}

function intInRangeOrFallback(value: unknown, min: number, max: number, fallback: number): { value: number; usedFallback: boolean } {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? { value, usedFallback: false } : { value: fallback, usedFallback: true };
}

/** Returns a well-formed `PortableConfig` built from `raw`'s valid fields, falling back to a fresh default for any field that is missing or the wrong shape — never throws, never trusts `raw` beyond `typeof`/range checks, same defensive posture as every other network/file-sourced payload in this codebase (`CLAUDE.md`). Returns `undefined` only when `raw` isn't an object at all, the one case with nothing salvageable. */
function validatePortableConfig(raw: unknown, dataDir: string): ValidatePortableConfigResult | undefined {
  // `Array.isArray` check is deliberate, not redundant with `typeof raw !== "object"`: JS arrays are
  // themselves `typeof "object"`, so a config file that degenerated into e.g. `[1,2,3]` would otherwise
  // be treated as "an object missing every field" (still recoverable, just with every field defaulted)
  // instead of the clearly-not-a-config-at-all case it actually is — same bucket as malformed JSON.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;

  const identityDir = stringOrFallback(entry.identityDir, path.join(dataDir, "identity"));
  ensureSecretDir(identityDir.value);
  const webPort = intInRangeOrFallback(entry.webPort, 1, 65535, DEFAULT_PORTABLE_WEB_PORT);
  const port = intInRangeOrFallback(entry.port, 0, 65535, 0);
  const networkPassword = stringOrFallback(entry.networkPassword, generateNetworkPassword());

  const hadFallback = identityDir.usedFallback || webPort.usedFallback || port.usedFallback || networkPassword.usedFallback;
  return {
    config: { identityDir: identityDir.value, webPort: webPort.value, port: port.value, networkPassword: networkPassword.value },
    hadFallback,
  };
}
