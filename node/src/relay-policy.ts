export type RelayMode = "off" | "always" | "when-charging" | "battery-above";

export interface ResourceState {
  /** 0-100. Undefined means unknown/not applicable (e.g. a desktop node with no battery). */
  batteryPercent?: number;
  charging?: boolean;
}

export interface RelayPolicyOptions {
  /** "off" | "always" (default) | "when-charging" | "battery-above" — spec §58. */
  mode?: RelayMode;
  /** Minimum battery percent required to relay when `mode === "battery-above"`. */
  batteryThreshold?: number;
  /** Self-reported resource snapshot (spec §51) — no real hardware sensors in this prototype. */
  getResourceState?: () => ResourceState;
}

const DEFAULT_BATTERY_THRESHOLD = 30;

/**
 * Whether this node is currently willing to spend effort relaying other
 * peers' traffic onward (spec §51 "resource management", §58 "incentivi e
 * batteria" — "Relay OFF / Relay when charging / Relay while battery > X% /
 * Full mesh mode"). Resource state is self-reported via
 * `getResourceState()` rather than read from real hardware sensors — there
 * is none to read in this prototype — consistent with spec §51 describing
 * resource metrics as *advertised*, not measured.
 *
 * This never affects whether a node answers requests addressed directly
 * to it, or serves its own content — only whether it forwards traffic
 * that arrived from elsewhere and is bound somewhere else (see
 * `NomadNode`'s use of this in the `decision.forwardPacket` branch,
 * which by construction only ever covers exactly that case).
 */
export class RelayPolicy {
  private readonly mode: RelayMode;
  private readonly batteryThreshold: number;
  private readonly getResourceState: () => ResourceState;

  constructor(options: RelayPolicyOptions = {}) {
    this.mode = options.mode ?? "always";
    this.batteryThreshold = options.batteryThreshold ?? DEFAULT_BATTERY_THRESHOLD;
    this.getResourceState = options.getResourceState ?? ((): ResourceState => ({}));
  }

  canRelayNow(): boolean {
    switch (this.mode) {
      case "off":
        return false;
      case "always":
        return true;
      case "when-charging":
        return this.getResourceState().charging === true;
      case "battery-above": {
        const { batteryPercent } = this.getResourceState();
        // Unknown battery state is treated as "can't confirm it's safe" — fails closed, not open.
        return batteryPercent !== undefined && batteryPercent >= this.batteryThreshold;
      }
      default:
        return true;
    }
  }
}
