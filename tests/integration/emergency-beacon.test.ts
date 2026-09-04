import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { BleMedium, BleSimulatedTransport } from "../../node/src/transports/ble.js";
import { BeaconBroadcastTransport } from "../../node/src/transports/beacon-broadcast.js";

/**
 * docs/beacon.md, "NOMAD Card" Beacon Mode — end-to-end proof of the
 * connectionless broadcast path (voce successiva a #55, "Cosa manca
 * davvero" #1/#2/#3): a pure Beacon Mode device (only a
 * `BeaconBroadcastTransport`, no local services, never connectable at all)
 * advertises a SOS; a Card in Relay Mode (a regular `NomadNode` with a
 * `BleSimulatedTransport`) picks it up over the air without ever having
 * connected to the beacon, then relays it normally over its own separate
 * TCP link to an Emergency Node, which records the sighting — proving the
 * broadcast really does bridge into the ordinary connected mesh, not just
 * that a single hop works in isolation.
 */

function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("Emergency beacon: broadcast Beacon Mode -> connected Relay Mode -> Emergency Node", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("delivers a SOS from a pure Beacon Mode device, through a Relay Mode node it never connected to, to a connected Emergency Node", async () => {
    const medium = new BleMedium();

    // Pure Beacon Mode: no local services, no connectable transport at all — only an advertiser.
    const beacon = new NomadNode({ displayName: "Beacon" });
    beacon.setBroadcastTransport(new BeaconBroadcastTransport("beacon-device", medium));
    nodes.push(beacon);
    await beacon.start(); // no transport to start — a pure Beacon Mode node never listens for anything

    // Relay Mode: hears broadcasts on the BLE medium, and separately relays over TCP.
    const relay = new NomadNode({ displayName: "Relay" });
    relay.addTransport(new BleSimulatedTransport(relay.nodeId, "relay-device", { medium }));
    const relayTcp = new TcpTransport(relay.nodeId, 0);
    relay.addTransport(relayTcp);
    nodes.push(relay);

    const emergencyNode = new NomadNode({ displayName: "EmergencyNode" });
    emergencyNode.addTransport(new TcpTransport(emergencyNode.nodeId, 0));
    nodes.push(emergencyNode);

    await Promise.all([relay.start(), emergencyNode.start()]);
    await emergencyNode.connect({ host: "127.0.0.1", port: relayTcp.port }, "tcp");

    const sighting = beacon.sendEmergencyBeacon({ message: "valanga, siamo bloccati", lat: 46.5, lon: 10.3 });

    // The relay picked it up purely from the air — it never called connect() toward the beacon.
    await waitFor(() => relay.emergencyBeacons.list().length === 1);
    const relaySighting = relay.emergencyBeacons.list()[0];
    expect(relaySighting.beaconContentId).toBe(sighting.beaconContentId);
    expect(relaySighting.deviceId).toBe(beacon.nodeId);
    expect(relaySighting.message).toBe("valanga, siamo bloccati");
    // Received directly from the beacon itself (a broadcast, not a relay hop) — receivedFrom must
    // not be set to the beacon's own identity (that would be circular, see considerEmergencyBeacon()).
    expect(relaySighting.receivedFrom).toBeUndefined();

    // The Emergency Node only ever talks to `relay` over TCP — this sighting can only have arrived
    // by the relay forwarding what it heard over the air.
    await waitFor(() => emergencyNode.emergencyBeacons.list().length === 1);
    const emergencySighting = emergencyNode.emergencyBeacons.list()[0];
    expect(emergencySighting.beaconContentId).toBe(sighting.beaconContentId);
    expect(emergencySighting.deviceId).toBe(beacon.nodeId);
    // Received via the relay, a real different peer than the beacon — this IS a genuine relay hop.
    expect(emergencySighting.receivedFrom).toBe(relay.nodeId);

    // The beacon itself already recorded its own origination as a sighting.
    expect(beacon.emergencyBeacons.list()).toHaveLength(1);
    expect(beacon.emergencyBeacons.list()[0].beaconContentId).toBe(sighting.beaconContentId);
  });

  it("lets the Emergency Node reply to the beacon, even though it never connected to it — the beacon's encryption key travels inline with the announce (found necessary during implementation: sendPrivateMessage() requires a known peerDirectory key, normally only exchanged on peer:connected, which never happens for a pure Beacon Mode device)", async () => {
    const medium = new BleMedium();

    const beacon = new NomadNode({ displayName: "Beacon" });
    beacon.setBroadcastTransport(new BeaconBroadcastTransport("beacon-device-2", medium));
    nodes.push(beacon);
    await beacon.start();

    const relay = new NomadNode({ displayName: "Relay" });
    relay.addTransport(new BleSimulatedTransport(relay.nodeId, "relay-device-2", { medium }));
    const relayTcp = new TcpTransport(relay.nodeId, 0);
    relay.addTransport(relayTcp);
    nodes.push(relay);

    const emergencyNode = new NomadNode({ displayName: "EmergencyNode3" });
    emergencyNode.addTransport(new TcpTransport(emergencyNode.nodeId, 0));
    nodes.push(emergencyNode);

    await Promise.all([relay.start(), emergencyNode.start()]);
    await emergencyNode.connect({ host: "127.0.0.1", port: relayTcp.port }, "tcp");

    beacon.sendEmergencyBeacon({ message: "test risposta" });
    await waitFor(() => emergencyNode.emergencyBeacons.list().length === 1);

    // The Emergency Node never connected to the beacon (only to `relay`, over TCP) — without the
    // beacon's encryption key having traveled inline with the announce, this would throw.
    expect(() => emergencyNode.sendPrivateMessage(beacon.nodeId, { text: "ricevuto, soccorsi in arrivo" })).not.toThrow();
  });

  it("a Beacon+Relay Mode node can originate AND relay at the same time, without conflict", async () => {
    const medium = new BleMedium();

    // Combined device: both a connected mesh participant (Relay Mode) and an advertiser (Beacon
    // Mode) on the same NomadNode — docs/beacon.md's own claim that the two roles don't conflict.
    const combined = new NomadNode({ displayName: "BeaconRelay" });
    const combinedTcp = new TcpTransport(combined.nodeId, 0);
    combined.addTransport(combinedTcp);
    combined.setBroadcastTransport(new BeaconBroadcastTransport("combined-device", medium));
    nodes.push(combined);

    const emergencyNode = new NomadNode({ displayName: "EmergencyNode2" });
    emergencyNode.addTransport(new TcpTransport(emergencyNode.nodeId, 0));
    nodes.push(emergencyNode);

    await Promise.all([combined.start(), emergencyNode.start()]);
    await emergencyNode.connect({ host: "127.0.0.1", port: combinedTcp.port }, "tcp");

    combined.sendEmergencyBeacon({ message: "solo test combinato" });

    // Delivered to the connected Emergency Node via the ordinary CONTENT_ANNOUNCE flood — the
    // broadcast leg (no listeners on this medium besides the sender) contributes nothing here, and
    // that's fine: the point is the two roles coexist without one breaking the other.
    await waitFor(() => emergencyNode.emergencyBeacons.list().length === 1);
    expect(emergencyNode.emergencyBeacons.list()[0].deviceId).toBe(combined.nodeId);
  });

  it("respects the per-caller anti-flood budget on sendEmergencyBeacon()", async () => {
    const beacon = new NomadNode({ displayName: "FloodyBeacon" });
    nodes.push(beacon);
    await beacon.start();

    // MAX_EMERGENCY_BEACON_PER_WINDOW is 3 (node.ts) — the 4th call within the same window must throw.
    beacon.sendEmergencyBeacon({ message: "one" });
    beacon.sendEmergencyBeacon({ message: "two" });
    beacon.sendEmergencyBeacon({ message: "three" });
    expect(() => beacon.sendEmergencyBeacon({ message: "four" })).toThrow(/too many emergency beacons/);
  });

  it("validates fields before consuming the anti-flood budget — an invalid call never counts against it", async () => {
    const beacon = new NomadNode({ displayName: "ValidatingBeacon" });
    nodes.push(beacon);
    await beacon.start();

    for (let i = 0; i < 10; i++) {
      expect(() => beacon.sendEmergencyBeacon({ lat: 999 })).toThrow(/'lat' must be a finite number/);
    }
    // None of the above should have consumed the budget — three legitimate calls must still succeed.
    expect(() => beacon.sendEmergencyBeacon({ message: "ok" })).not.toThrow();
    expect(() => beacon.sendEmergencyBeacon({ message: "ok" })).not.toThrow();
    expect(() => beacon.sendEmergencyBeacon({ message: "ok" })).not.toThrow();
  });
});
