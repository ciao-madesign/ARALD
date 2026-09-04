import { afterEach, describe, expect, it } from "vitest";
import { BleMedium, BleSimulatedTransport } from "../../node/src/transports/ble.js";
import { SimulatedMedium } from "../../node/src/transports/simulated-link.js";
import { BeaconBroadcastTransport } from "../../node/src/transports/beacon-broadcast.js";
import { MessageType, createPacket, type Packet } from "../../node/src/packet.js";
import { Identity } from "../../node/src/identity.js";

function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
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

function beaconPacket(source: string): Packet {
  return createPacket({ type: MessageType.CONTENT_ANNOUNCE, source, payload: { hello: "sos" } });
}

/**
 * `SimulatedMedium.broadcast()` (`simulated-link.ts`) — the connectionless
 * "advertising" primitive Beacon Mode needs (`docs/beacon.md`, "Cosa manca
 * davvero" #2). Tested directly against the medium first, without any
 * `Transport` involved, since the delivery/exclusion/independent-copy
 * semantics are properties of the medium itself.
 */
describe("SimulatedMedium.broadcast()", () => {
  it("delivers to every registered broadcast listener except the sender itself", () => {
    const medium = new SimulatedMedium();
    const receivedByA: Packet[] = [];
    const receivedByB: Packet[] = [];
    const receivedBySender: Packet[] = [];
    medium.registerBroadcastListener("a", (packet) => receivedByA.push(packet));
    medium.registerBroadcastListener("b", (packet) => receivedByB.push(packet));
    medium.registerBroadcastListener("sender", (packet) => receivedBySender.push(packet));

    medium.broadcast("sender", beaconPacket("beacon-node-id"));

    expect(receivedByA).toHaveLength(1);
    expect(receivedByB).toHaveLength(1);
    expect(receivedBySender).toHaveLength(0); // never delivered back to its own sender
  });

  it("gives each listener its own independently-decoded packet, never a shared mutable reference", () => {
    const medium = new SimulatedMedium();
    let seenByA: Packet | undefined;
    let seenByB: Packet | undefined;
    medium.registerBroadcastListener("a", (packet) => (seenByA = packet));
    medium.registerBroadcastListener("b", (packet) => (seenByB = packet));

    medium.broadcast("sender", beaconPacket("beacon-node-id"));

    expect(seenByA).toEqual(seenByB); // same content...
    expect(seenByA).not.toBe(seenByB); // ...but not the same object
  });

  it("delivers nothing (and does not throw) when no one is listening", () => {
    const medium = new SimulatedMedium();
    expect(() => medium.broadcast("sender", beaconPacket("beacon-node-id"))).not.toThrow();
  });

  it("stops delivering to a listener once unregistered", () => {
    const medium = new SimulatedMedium();
    const received: Packet[] = [];
    medium.registerBroadcastListener("a", (packet) => received.push(packet));
    medium.unregisterBroadcastListener("a");

    medium.broadcast("sender", beaconPacket("beacon-node-id"));
    expect(received).toHaveLength(0);
  });
});

/**
 * End-to-end wiring: `BeaconBroadcastTransport.advertise()` ->
 * `SimulatedMedium.broadcast()` -> `SimulatedLinkTransport.receiveBroadcast()`
 * -> the receiving transport's ordinary `packetHandlers` — proving a
 * connectable device (BLE/LoRa Relay Mode) picks up an advertisement from a
 * pure Beacon Mode device it was never connected to, plus the global
 * anti-flood budget on the receiving side (`docs/beacon.md` #4).
 */
describe("SimulatedLinkTransport receiving a broadcast", () => {
  const transports: BleSimulatedTransport[] = [];
  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop()));
    transports.length = 0;
  });

  it("delivers a beacon's advertised packet to a never-connected relay's normal packet handler, with fromPeerId set to the beacon's own identity", async () => {
    const medium = new BleMedium();
    const beaconNodeId = Identity.generate().nodeId;
    const beacon = new BeaconBroadcastTransport("beacon-device", medium);

    const relayNodeId = Identity.generate().nodeId;
    const relay = new BleSimulatedTransport(relayNodeId, "relay-device", { medium });
    transports.push(relay);
    await relay.start();

    const received = new Promise<{ packet: Packet; fromPeerId: string }>((resolve) => {
      relay.onPacket((packet, fromPeerId) => resolve({ packet, fromPeerId }));
    });

    beacon.advertise(beaconPacket(beaconNodeId));

    const { packet, fromPeerId } = await received;
    expect(packet.source).toBe(beaconNodeId);
    expect(fromPeerId).toBe(beaconNodeId); // never the beacon's raw deviceId — packet.source is the canonical identity
  });

  it("never lets the beacon's own device register as a connectable peer — a relay can't connect() to it", async () => {
    const medium = new BleMedium();
    new BeaconBroadcastTransport("beacon-device", medium); // registers only as a broadcast sender, never connectable

    const relayNodeId = Identity.generate().nodeId;
    const relay = new BleSimulatedTransport(relayNodeId, "relay-device", { medium });
    transports.push(relay);
    await relay.start();

    await expect(relay.connect({ host: "beacon-device", port: 0 })).rejects.toThrow(/no BLE device advertising/);
  });

  it("drops broadcasts past the global per-window budget, protecting a relay from a flood regardless of how many distinct sender identities are used", async () => {
    const medium = new BleMedium();
    const relayNodeId = Identity.generate().nodeId;
    const relay = new BleSimulatedTransport(relayNodeId, "relay-device", { medium });
    transports.push(relay);
    await relay.start();

    const received: Packet[] = [];
    relay.onPacket((packet) => received.push(packet));

    // A generous burst, well past any reasonable per-window budget, each from its own *distinct*
    // throwaway identity — proving the limit is global (not per-sender), the whole point of this
    // defense (docs/beacon.md #4, "Card usa-e-getta": a per-identity limit alone is trivially
    // bypassed by minting a fresh id for every packet).
    for (let i = 0; i < 100; i++) {
      const beacon = new BeaconBroadcastTransport(`throwaway-device-${i}`, medium);
      beacon.advertise(beaconPacket(Identity.generate().nodeId));
    }

    // Give any (there shouldn't be any pending) async delivery a moment, then assert the budget held.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThan(100);
  });

  it("resets the broadcast budget on the next window, once it's passed", async () => {
    const medium = new BleMedium();
    const relayNodeId = Identity.generate().nodeId;
    const relay = new BleSimulatedTransport(relayNodeId, "relay-device", { medium });
    transports.push(relay);
    await relay.start();

    const received: Packet[] = [];
    relay.onPacket((packet) => received.push(packet));

    for (let i = 0; i < 100; i++) {
      const beacon = new BeaconBroadcastTransport(`throwaway-device-${i}`, medium);
      beacon.advertise(beaconPacket(Identity.generate().nodeId));
    }
    await waitFor(() => received.length > 0);
    const countAfterFirstBurst = received.length;

    await new Promise((resolve) => setTimeout(resolve, 1100)); // past the 1s broadcast window

    const secondBeacon = new BeaconBroadcastTransport("second-window-device", medium);
    secondBeacon.advertise(beaconPacket(Identity.generate().nodeId));
    await waitFor(() => received.length > countAfterFirstBurst);
    expect(received.length).toBe(countAfterFirstBurst + 1);
  });
});
