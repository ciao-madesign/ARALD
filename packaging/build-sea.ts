import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds "ARALD Portable" (`docs/next-steps.md`, "Installer/wizard ARALD
 * Portable software-puro") as a Node.js Single Executable Application — a
 * standalone binary for the *current* host platform/architecture that
 * bundles the whole mesh runtime (`node/src/cli.ts`) plus the Node.js
 * runtime itself, so the person running it never needs Node installed.
 * CI (`.github/workflows/build-portable.yml`) runs this same script on
 * five separate runners (one per target platform/arch) to produce all five
 * artifacts — this script itself never cross-compiles, it only ever builds
 * for whatever platform/arch it's actually running on (`process.platform`/
 * `process.arch`), the same constraint Node's own SEA has (see the
 * "cross-platform" caveat below).
 *
 * **Verified empirically in this session, not assumed** — the published
 * Node.js SEA docs page describes a newer single-flag `--build-sea`
 * workflow that this environment's actual Node binary (`node --help`) does
 * **not** have; only the older two-step `--experimental-sea-config` +
 * `postject` flow (still fully supported) is present here, so that is what
 * this script uses — hand-verified end to end against this repo's real
 * `node/dist/cli.js` before being treated as the real build process.
 *
 * **The real `node/dist/cli.js` cannot be fed to SEA directly**: an
 * injected SEA main script can only `require()`/`import` Node's own
 * built-in modules by default, never another file on disk — confirmed by
 * reproducing the exact failure (`ERR_UNKNOWN_BUILTIN_MODULE`) against a
 * minimal two-file example before writing this script. `node/dist/cli.js`
 * pulls in every other compiled file under `node/dist/` via relative
 * imports, so it must be bundled into one self-contained file first — done
 * here with `esbuild` (already present via this repo's own dev toolchain,
 * no new dependency).
 *
 * **`@serialport/bindings-cpp`/`@serialport/stream` are marked external to
 * the bundle, deliberately never embedded**: they ship a native compiled
 * addon, which neither a bundler nor SEA's own asset system can embed the
 * way they embed plain JS (SEA's docs: a native addon "must be written to
 * a temp file first and loaded with `process.dlopen()`" — not attempted
 * here). `cli.ts`'s own `--lora-serial-port` branch already `await
 * import()`s both packages lazily instead of at module top level
 * (`cli.ts`'s own doc comment there explains why) specifically so that
 * marking them external never breaks the bundle: the dynamic import simply
 * stays an unresolved `require()` call that is never reached unless an
 * operator actually passes `--lora-serial-port` to this binary — which it
 * doesn't support, consistent with this being the Wi-Fi-only portable
 * profile (`docs/next-steps.md`'s own framing of this feature).
 */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const BUILD_DIR = path.join(SCRIPT_DIR, "build");
const BUNDLE_PATH = path.join(BUILD_DIR, "bundle.cjs");
const SEA_CONFIG_PATH = path.join(BUILD_DIR, "sea-config.json");
const BLOB_PATH = path.join(BUILD_DIR, "sea-prep.blob");

/**
 * The fixed "sentinel fuse" string `postject` burns into the binary so
 * Node's own startup code can recognize an SEA at launch — a constant
 * baked into Node's source, not something a build configures; verified
 * directly against Node's official SEA documentation and confirmed
 * working end to end in this session (the injected binary ran correctly).
 */
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function outputBinaryName(): string {
  return process.platform === "win32" ? "arald-portable.exe" : "arald-portable";
}

async function main(): Promise<void> {
  console.log(`Building ARALD Portable for ${process.platform}-${process.arch}...`);

  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });

  console.log("1/5 — compiling node/src (tsc)...");
  execFileSync("npm", ["run", "build", "-w", "node"], { cwd: REPO_ROOT, stdio: "inherit" });

  console.log("2/5 — bundling into a single CommonJS file (esbuild)...");
  execFileSync(
    "npx",
    [
      "--yes",
      "esbuild",
      path.join(REPO_ROOT, "node/dist/cli.js"),
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--external:@serialport/bindings-cpp",
      "--external:@serialport/stream",
      `--outfile=${BUNDLE_PATH}`,
    ],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );

  console.log("3/5 — generating the SEA preparation blob...");
  writeFileSync(
    SEA_CONFIG_PATH,
    JSON.stringify({ main: BUNDLE_PATH, output: BLOB_PATH, disableExperimentalSEAWarning: true }, null, 2),
  );
  execFileSync(process.execPath, ["--experimental-sea-config", SEA_CONFIG_PATH], { cwd: REPO_ROOT, stdio: "inherit" });

  console.log("4/5 — copying the Node.js binary and injecting the blob (postject)...");
  const outputPath = path.join(BUILD_DIR, outputBinaryName());
  copyFileSync(process.execPath, outputPath);
  if (process.platform === "darwin") {
    // Required by SEA on macOS before injection — a signed Mach-O binary rejects having bytes added to
    // it. **Unverified in this session (no macOS host here)**, written per Node's own documented
    // requirement, same disclosed-but-unexercised honesty as every other macOS/Windows-only step below.
    try {
      execFileSync("codesign", ["--remove-signature", outputPath], { stdio: "inherit" });
    } catch (err) {
      console.error(`codesign --remove-signature failed (continuing anyway, expected on a non-macOS host): ${(err as Error).message}`);
    }
  }
  const postjectArgs = [
    "--yes",
    "postject",
    outputPath,
    "NODE_SEA_BLOB",
    BLOB_PATH,
    "--sentinel-fuse",
    SENTINEL_FUSE,
  ];
  if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
  execFileSync("npx", postjectArgs, { cwd: REPO_ROOT, stdio: "inherit" });

  console.log("5/5 — finishing touches...");
  if (process.platform !== "win32") chmodSync(outputPath, 0o755);
  if (process.platform === "darwin") {
    // Ad-hoc re-signing (no real certificate) — still produces a binary Gatekeeper allows running
    // locally, per Node's own docs. **Unverified in this session.**
    try {
      execFileSync("codesign", ["--sign", "-", outputPath], { stdio: "inherit" });
    } catch (err) {
      console.error(`codesign --sign failed (continuing anyway, expected on a non-macOS host): ${(err as Error).message}`);
    }
  }

  console.log(`\nDone: ${outputPath}`);
  console.log(`Try it: ${outputPath} --id MyNode --portable true`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
