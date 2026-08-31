import { SimulatedLinkTransport, SimulatedMedium } from "./simulated-link.js";

/**
 * BLE's un-negotiated ATT MTU: 23 bytes total, 3 of which are protocol
 * header, leaving 20 usable. A real connection can negotiate up to 247
 * bytes (BLE 4.2+ Data Length Extension), but 20 is the value every device
 * must support without negotiation — deliberately used as the default here
 * so this transport genuinely exercises fragmentation (a single
 * `CONTENT_CHUNK`, 4096 content bytes plus JSON envelope, needs hundreds of
 * fragments at this MTU) rather than only working because the simulated
 * value happened to be generous. See `docs/next-steps.md` Option A.
 */
const DEFAULT_MTU = 20;

/** Commonly-cited typical simultaneous GATT connection limit for a BLE peripheral (varies by chipset/stack; this is a representative, not a spec-mandated, number). Enforced against *identified* peers only — see `simulated-link.ts`'s `MAX_PENDING_CONNECTIONS`. */
const DEFAULT_MAX_CONNECTIONS = 7;

/** Small but nonzero simulated per-fragment link delay, so delivery is genuinely asynchronous relative to send() rather than resolving in the same tick — real BLE has materially higher per-packet latency than local TCP. */
const DEFAULT_LATENCY_MS = 5;

/**
 * Simulated BLE transport (roadmap Milestone 8, `docs/next-steps.md`
 * Option A): a `SimulatedLinkTransport` (`simulated-link.ts`) configured
 * with BLE's own MTU/connection-cap/latency defaults and error-message
 * label — the connection lifecycle, handshake, and fragmentation/
 * reassembly machinery itself lives entirely in that shared base (extracted
 * once `transports/lora.ts` needed the exact same mechanics; see that
 * file's own doc comment and `docs/security.md` for why duplicating ~300
 * lines of already-tested logic per radio was rejected).
 */
export class BleMedium extends SimulatedMedium {
  /** Exists only to make this class nominally distinct from `LoraMedium` (see `SimulatedMedium`'s doc comment in `simulated-link.ts` for why an empty subclass wasn't enough) — never read. */
  private readonly _ble = true;
}

export interface BleSimulatedTransportOptions {
  /** ATT MTU in bytes for this transport's connections — see `DEFAULT_MTU` for why 20 is the default. */
  mtu?: number;
  /** Max simultaneous connections this transport accepts or initiates — see `DEFAULT_MAX_CONNECTIONS`. */
  maxConnections?: number;
  /** Simulated per-fragment link latency in ms — see `DEFAULT_LATENCY_MS`. */
  latencyMs?: number;
  /** Which `BleMedium` this transport advertises/discovers on. Defaults to a single process-wide medium shared by every transport that doesn't specify one. */
  medium?: BleMedium;
}

const DEFAULT_MEDIUM = new BleMedium();

/**
 * See `simulated-link.ts`'s `SimulatedLinkTransport` for the actual
 * connection/handshake/fragmentation mechanics — this class only supplies
 * BLE's own numbers (`DEFAULT_MTU`/`DEFAULT_MAX_CONNECTIONS`/
 * `DEFAULT_LATENCY_MS` above) and `radioLabel: "BLE"` (interpolated into
 * every error message this transport throws, e.g. `"no BLE device
 * advertising..."`).
 */
export class BleSimulatedTransport extends SimulatedLinkTransport {
  constructor(localNodeId: string, deviceId: string, options: BleSimulatedTransportOptions = {}) {
    super({
      id: "ble-simulated",
      radioLabel: "BLE",
      localNodeId,
      deviceId,
      mtu: options.mtu ?? DEFAULT_MTU,
      maxConnections: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      latencyMs: options.latencyMs ?? DEFAULT_LATENCY_MS,
      medium: options.medium ?? DEFAULT_MEDIUM,
    });
  }
}
