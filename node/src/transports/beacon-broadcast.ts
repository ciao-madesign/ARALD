import type { Packet } from "../packet.js";
import type { SimulatedMedium } from "./simulated-link.js";

/**
 * A pure Beacon Mode transmitter (`docs/beacon.md`, "NOMAD Card" — Beacon
 * Mode) — deliberately **not** a `Transport` (transport.ts): `connect()`/
 * `onPeerConnected()`/`onPeerDisconnected()` would all be meaningless for a
 * device that never accepts an incoming connection and never establishes
 * one of its own. Forcing this into that interface with no-op
 * implementations would be architecturally dishonest — the whole point of
 * this class is that real advertising-only radio hardware has no
 * connection state machine at all, unlike `SimulatedLinkTransport`'s
 * point-to-point HELLO handshake (`ble.ts`/`lora.ts`).
 *
 * API is deliberately minimal: `advertise()` is the only thing a real
 * Beacon Mode radio does — broadcast a signed packet to anyone in range,
 * with no idea who (if anyone) is listening, no acknowledgement channel.
 * Generic over `SimulatedMedium` (works with `BleMedium` or `LoraMedium`
 * unchanged) — same "no radio-specific duplication where the physical
 * parameter doesn't actually change the logic" principle `simulated-link.ts`
 * itself already follows; a beacon message is small enough to need no
 * MTU-aware fragmentation regardless of which radio carries it.
 *
 * Never registered as a connectable device (`SimulatedMedium.register()`)
 * — only as a broadcast listener, and only implicitly, as the *sender*
 * side of `SimulatedMedium.broadcast()`. A pure Beacon device never
 * actually needs to *receive* anything either (it has no local services,
 * nothing to reply to), so this class doesn't call
 * `registerBroadcastListener()` on itself at all.
 */
export class BeaconBroadcastTransport {
  private readonly deviceId: string;
  private readonly medium: SimulatedMedium;

  constructor(deviceId: string, medium: SimulatedMedium) {
    this.deviceId = deviceId;
    this.medium = medium;
  }

  /** Broadcasts `packet` once to every other device currently listening on this medium — no delivery guarantee, no acknowledgement. Repetition (retrying the same already-signed packet over time) is the caller's responsibility (`NomadNode.sendEmergencyBeacon()`) — this method itself is fire-and-forget by design, matching what a single real advertising frame actually is. */
  advertise(packet: Packet): void {
    this.medium.broadcast(this.deviceId, packet);
  }
}
