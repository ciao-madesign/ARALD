import { createConnection, type Socket } from "node:net";
import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { buildEmergencyBeaconPacket } from "../../mobile/www/ble-sos.js";
import { loadOrCreateIdentity } from "../../mobile/www/ble-identity.js";

/**
 * The definitive proof for docs/security.md voce #65: a SOS packet built entirely by the phone-side
 * modules (`ble-identity.js`/`ble-sos.js`, the exact code that will run in a real browser) is
 * accepted by a real, unmodified `NomadNode.handleContentAnnounce()` -> `considerEmergencyBeacon()`
 * pipeline exactly as if it came from a real `sendEmergencyBeacon()` call — not a mock, not a
 * function-level check against exported helpers in isolation, but the actual packet placed on an
 * actual TCP wire into an actual running node. Same raw-socket-standing-in-for-a-peer pattern as
 * tests/integration/content-provider-retry.test.ts (this project's established way to simulate an
 * arbitrary/adversarial peer talking to a real NomadNode with deterministic control, rather than
 * needing a second full NomadNode+Bluetooth stack that doesn't exist in this environment).
 */

class FakeStorage {
  #map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
}

beforeAll(() => {
  const require = createRequire(import.meta.url);
  (globalThis as unknown as { nacl: unknown }).nacl = require("../../mobile/www/vendor/nacl.js");
});

function waitForConnected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start >= timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("a phone-originated SOS is accepted end-to-end by a real NomadNode", () => {
  let node: NomadNode | undefined;
  let socket: Socket | undefined;

  afterEach(async () => {
    socket?.destroy();
    if (node) await node.stop();
    node = undefined;
    socket = undefined;
  });

  it("produces a real EmergencyBeaconSighting with the phone's own message/lat/lon", async () => {
    node = new NomadNode({ displayName: "emergency-node" });
    const transport = new TcpTransport(node.nodeId, 0);
    node.addTransport(transport);
    await node.start();

    const phoneIdentity = loadOrCreateIdentity(new FakeStorage());
    const phonePacket = buildEmergencyBeaconPacket({ message: "valanga, due persone bloccate", lat: 46.55, lon: 11.35 }, phoneIdentity);

    socket = createConnection({ host: "127.0.0.1", port: transport.port });
    await waitForConnected(socket);
    // HELLO first — same requirement as every real peer, so the transport recognizes subsequent
    // packets on this socket as coming from `phoneIdentity.nodeId`, not an anonymous connection.
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: phoneIdentity.nodeId, payload: {} })));
    // The exact packet a real browser would have produced — sent as raw bytes over the wire, not
    // reconstructed or passed as an in-memory object.
    socket.write(encodePacket(phonePacket as never));

    await waitFor(() => node!.emergencyBeacons.list().some((s) => s.beaconContentId === phonePacket.payload.metadata.contentId));

    const sighting = node.emergencyBeacons.list().find((s) => s.beaconContentId === phonePacket.payload.metadata.contentId)!;
    expect(sighting.deviceId).toBe(phoneIdentity.nodeId);
    expect(sighting.message).toBe("valanga, due persone bloccate");
    expect(sighting.lat).toBe(46.55);
    expect(sighting.lon).toBe(11.35);
  });

  it("a tampered phone packet (signature no longer matches) is silently rejected, never produces a sighting", async () => {
    node = new NomadNode({ displayName: "emergency-node-2" });
    const transport = new TcpTransport(node.nodeId, 0);
    node.addTransport(transport);
    await node.start();

    const phoneIdentity = loadOrCreateIdentity(new FakeStorage());
    const phonePacket = buildEmergencyBeaconPacket({ message: "original message" }, phoneIdentity);
    // Tamper with the announced name after signing — same class of attack `verifyContentSignature()`
    // exists to catch (a relay relabeling genuinely-signed content).
    const tampered = { ...phonePacket, payload: { ...phonePacket.payload, metadata: { ...phonePacket.payload.metadata, name: "not-emergency-beacon" } } };

    socket = createConnection({ host: "127.0.0.1", port: transport.port });
    await waitForConnected(socket);
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: phoneIdentity.nodeId, payload: {} })));
    socket.write(encodePacket(tampered as never));

    // Give the node ample time to have processed it, then assert nothing was ever recorded.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(node.emergencyBeacons.list().some((s) => s.deviceId === phoneIdentity.nodeId)).toBe(false);
  });
});
