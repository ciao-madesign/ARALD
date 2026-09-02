import { arch, cpus, networkInterfaces, platform, totalmem } from "node:os";
import { statfsSync } from "node:fs";

export interface HardwareProfile {
  /** `os.arch()`, e.g. "x64", "arm64". */
  architecture: string;
  /** `os.platform()`, e.g. "linux", "darwin", "win32". */
  platform: string;
  cpuCores: number;
  ramGb: number;
  /** `null` when `statfsSync()` fails (unsupported platform, or `storagePath` doesn't exist) — a storage probe failure shouldn't take down the whole profile. */
  storage: { path: string; totalGb: number; freeGb: number } | null;
  /** Non-internal (non-loopback) interface names only — no addresses, an operator diagnostic ("is there any network at all"), not a network inventory. Deliberately not classified into wifi/ethernet: see this module's doc comment for why. */
  networkInterfaces: string[];
  /** Always `null` — see this module's doc comment. */
  gpu: null;
  npu: null;
  bluetooth: null;
  usb3: null;
}

const BYTES_PER_GB = 1_000_000_000;

/** Rounds to one decimal — human-readable, not falsely precise, same spirit as every other GB figure already surfaced in this project's own hardware documentation. */
function toGb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_GB) * 10) / 10;
}

/**
 * Builds a best-effort hardware profile of whatever machine this process
 * runs on — `docs/deployment.md`'s "NOMAD-NET BOX e PORTABLE" §8
 * "Capability Manager", the one piece of that specification buildable
 * without physical hardware: every field here comes from `node:os`/
 * `node:fs`, so it works identically on this sandbox, an Orange Pi, or any
 * other host `nomad-hub/` ever runs on — no dependency on which SBC/PC is
 * underneath, same principle `DockerClient` already applies to Docker
 * itself.
 *
 * `gpu`/`npu`/`bluetooth`/`usb3` are always `null`, **never** a guessed
 * `true`/`false`: Node's standard library has no portable API for any of
 * them. A real answer would need OS-specific external tooling (e.g.
 * shelling out to `lspci`/`lsusb` on Linux) — fragile, platform-specific,
 * and exactly the kind of invented-data risk this project's own
 * established convention argues against (`CLAUDE.md`: never trust/fabricate
 * what you don't actually know; degrade honestly instead of guessing).
 * `networkInterfaces` is a plain list of interface *names*, deliberately
 * **not** classified into wifi/ethernet/bluetooth booleans for the same
 * reason: interface naming conventions differ enough across Linux
 * distributions (predictable names like `enp3s0`/`wlp2s0` vs. legacy
 * `eth0`/`wlan0`) and operating systems (macOS's `en0` is frequently
 * Wi-Fi, not Ethernet, unlike what the name alone would suggest) that a
 * name-based guess would be wrong often enough to actively mislead an
 * operator reading it — the same reasoning that keeps
 * `gpu`/`npu`/`bluetooth`/`usb3` as `null` rather than a guess.
 */
export function getHardwareProfile(options: { storagePath?: string } = {}): HardwareProfile {
  const storagePath = options.storagePath ?? process.cwd();
  let storage: HardwareProfile["storage"] = null;
  try {
    const stats = statfsSync(storagePath);
    storage = {
      path: storagePath,
      totalGb: toGb(stats.blocks * stats.bsize),
      // bavail (space available to an unprivileged process), not bfree (raw free blocks including
      // space reserved for root) — the same "available" semantics df/du report, and the more useful
      // number for "how much room is actually left for this process to use".
      freeGb: toGb(stats.bavail * stats.bsize),
    };
  } catch {
    // Unsupported platform, or storagePath doesn't exist — storage stays null.
  }

  const interfaces = networkInterfaces();
  const activeInterfaceNames = Object.entries(interfaces)
    .filter(([, addresses]) => (addresses ?? []).some((addr) => !addr.internal))
    .map(([name]) => name);

  return {
    architecture: arch(),
    platform: platform(),
    cpuCores: cpus().length,
    ramGb: toGb(totalmem()),
    storage,
    networkInterfaces: activeInterfaceNames,
    gpu: null,
    npu: null,
    bluetooth: null,
    usb3: null,
  };
}
