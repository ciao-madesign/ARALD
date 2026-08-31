import { SimulatedLinkTransport, SimulatedMedium } from "./simulated-link.js";

/**
 * Representative raw-LoRa physical payload budget: the SX126x/SX127x radios
 * this transport models cap a single over-the-air packet at 255 bytes
 * (implicit-header mode), of which a real link would spend some on its own
 * framing (address/sequence/CRC, protocol-dependent) before this transport
 * ever sees a byte — 200 is a representative usable payload after that
 * overhead, not a specific chip/library's exact number. Deliberately **not**
 * shrunk further the way BLE's `DEFAULT_MTU` (20 bytes) was — that story
 * (small MTU forcing genuine multi-fragment reassembly) is already proven
 * there; LoRa's real difference from BLE is latency/range, not a smaller
 * MTU (see `DEFAULT_LATENCY_MS`). A `CONTENT_CHUNK` (4096 content bytes plus
 * JSON envelope) still needs dozens of fragments at this MTU, so
 * fragmentation is still genuinely exercised, just with fewer fragments
 * than BLE's default produces for the same packet.
 */
const DEFAULT_MTU = 200;

/**
 * LoRa has no physical connection-slot limit the way BLE's GATT peripheral
 * role does — any number of nodes can be in range of the same channel.
 * More generous than BLE's `DEFAULT_MAX_CONNECTIONS` (7) for that reason,
 * though still finite as the same anti-DoS/memory bound every bounded
 * structure in this codebase has (spec §57), not an attempt to model a real
 * physical limit that doesn't exist for this radio. The resource that
 * actually constrains a real LoRa deployment is shared channel airtime
 * (and, in the EU 868 MHz ISM band, a legally mandated ~1% duty cycle per
 * sub-band) — **not modeled by this transport in this version**, an
 * accepted limitation like others documented in this codebase (e.g.
 * `packet.source` not being cryptographically bound, `CLAUDE.md`): a
 * future version could rate-limit `send()` itself to approximate it, but
 * that's a real design decision (what counts toward the budget, how
 * multiple simulated nodes on one process-wide `LoraMedium` would even
 * share a "channel" fairly) deserving its own pass, not something to bolt
 * on as a side effect of adding this transport.
 */
const DEFAULT_MAX_CONNECTIONS = 16;

/**
 * Simulated per-fragment link delay — two orders of magnitude above BLE's
 * `DEFAULT_LATENCY_MS` (5ms), which is the point: this is what actually
 * distinguishes LoRa from BLE in this codebase's simulation, not a smaller
 * MTU (see `DEFAULT_MTU`). 250ms is representative of a moderate spreading-
 * factor/bandwidth configuration — real long-range settings (SF12, narrow
 * bandwidth, chosen specifically to maximize range) can take several
 * *seconds* of air time for a single packet this size. A test or demo that
 * wants to model that extreme end explicitly should pass a much higher
 * `latencyMs`, the same way BLE's own tests override its default when they
 * need to (e.g. `latencyMs: 0`/`1` for fast fragmentation-only assertions).
 */
const DEFAULT_LATENCY_MS = 250;

/**
 * Simulated LoRa transport, affiancato a `BleSimulatedTransport`
 * (`docs/next-steps.md` Opzione L) — not a replacement: BLE stays the
 * short-range/low-latency link, this is the long-range/low-throughput one,
 * both usable on the same `NomadNode` at once via `addTransport()` (see
 * `tests/integration/mixed-transport.test.ts`). No real LoRa hardware
 * (SX126x/SX127x module or an integrated board like a Heltec/TTGO "LoRa32")
 * is available in this environment — same starting point BLE itself had
 * before Slice 8, resolved the same way: a `SimulatedLinkTransport`
 * (`simulated-link.ts`) configured with LoRa's own numbers, verifiable in
 * automated tests, with real hardware left for whenever it's physically
 * available.
 */
export class LoraMedium extends SimulatedMedium {
  /** Exists only to make this class nominally distinct from `BleMedium` (see `SimulatedMedium`'s doc comment in `simulated-link.ts` for why an empty subclass wasn't enough) — never read. */
  private readonly _lora = true;
}

export interface LoraSimulatedTransportOptions {
  /** Usable payload bytes per LoRa packet for this transport's connections — see `DEFAULT_MTU`. */
  mtu?: number;
  /** Max simultaneous connections this transport accepts or initiates — see `DEFAULT_MAX_CONNECTIONS`. */
  maxConnections?: number;
  /** Simulated per-fragment link latency in ms — see `DEFAULT_LATENCY_MS`. */
  latencyMs?: number;
  /** Which `LoraMedium` this transport advertises/discovers on. Defaults to a single process-wide medium shared by every transport that doesn't specify one. */
  medium?: LoraMedium;
}

const DEFAULT_MEDIUM = new LoraMedium();

/**
 * See `simulated-link.ts`'s `SimulatedLinkTransport` for the actual
 * connection/handshake/fragmentation mechanics — this class only supplies
 * LoRa's own numbers (`DEFAULT_MTU`/`DEFAULT_MAX_CONNECTIONS`/
 * `DEFAULT_LATENCY_MS` above) and `radioLabel: "LoRa"` (interpolated into
 * every error message this transport throws, e.g. `"no LoRa device
 * advertising..."`).
 */
export class LoraSimulatedTransport extends SimulatedLinkTransport {
  constructor(localNodeId: string, deviceId: string, options: LoraSimulatedTransportOptions = {}) {
    super({
      id: "lora-simulated",
      radioLabel: "LoRa",
      localNodeId,
      deviceId,
      mtu: options.mtu ?? DEFAULT_MTU,
      maxConnections: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      latencyMs: options.latencyMs ?? DEFAULT_LATENCY_MS,
      medium: options.medium ?? DEFAULT_MEDIUM,
    });
  }
}
