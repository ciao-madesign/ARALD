import { describe, expect, it } from "vitest";
import { RelayPolicy } from "../../node/src/relay-policy.js";

describe("RelayPolicy", () => {
  it("defaults to always relaying when no mode is configured", () => {
    const policy = new RelayPolicy();
    expect(policy.canRelayNow()).toBe(true);
  });

  it("mode 'off' never relays", () => {
    const policy = new RelayPolicy({ mode: "off" });
    expect(policy.canRelayNow()).toBe(false);
  });

  it("mode 'when-charging' relays only while the reported state says charging", () => {
    let charging = false;
    const policy = new RelayPolicy({ mode: "when-charging", getResourceState: () => ({ charging }) });

    expect(policy.canRelayNow()).toBe(false);
    charging = true;
    expect(policy.canRelayNow()).toBe(true);
  });

  it("mode 'battery-above' relays only once the battery is at or above the threshold", () => {
    let batteryPercent = 10;
    const policy = new RelayPolicy({
      mode: "battery-above",
      batteryThreshold: 30,
      getResourceState: () => ({ batteryPercent }),
    });

    expect(policy.canRelayNow()).toBe(false);
    batteryPercent = 30;
    expect(policy.canRelayNow()).toBe(true);
    batteryPercent = 95;
    expect(policy.canRelayNow()).toBe(true);
  });

  it("mode 'battery-above' fails closed when battery state is unknown", () => {
    const policy = new RelayPolicy({ mode: "battery-above", getResourceState: () => ({}) });
    expect(policy.canRelayNow()).toBe(false);
  });
});
