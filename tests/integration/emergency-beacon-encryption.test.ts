import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";

/**
 * Beacon payload encryption (`docs/beacon.md`, "Packet-vs-Observation/RSSI"
 * pezzo 3 — la parte "cifratura del payload verso il relay", l'unica parte
 * genuinamente costruibile di quel pezzo dopo la riconciliazione con la
 * sessione parallela: la parte "Observation" è già coperta dalla voce #58
 * (`Drop.receivedFrom`/`observedAt`), e RSSI/SNR reali restano bloccati su
 * hardware fisico).
 *
 * `NomadNodeOptions.emergencyBeaconKey` — quando impostata (stessa chiave
 * pre-condivisa su Beacon ed Emergency Node, mai su un relay ordinario in
 * mezzo), `sendEmergencyBeacon()` cifra il payload con AES-256-GCM
 * (`encryptForPeer()`/`decryptFromPeer()`, `encryption.ts`, riusati as-is)
 * e `considerEmergencyBeacon()` lo decifra solo se questo nodo ha la stessa
 * chiave. Un relay senza la chiave continua a inoltrare/cache-are i byte
 * cifrati normalmente (nulla nel routing dipende dalla lettura del
 * payload), ma non registra mai una propria sighting leggibile — la
 * proprietà di "blind forwarding" richiesta dalla proposta originale.
 *
 * Validazione unit-level di `extractEmergencyBeaconEnvelope()` in
 * `tests/unit/emergency-beacon.test.ts` — questo file esercita il percorso
 * di rete reale (cifratura end-to-end su una catena a 3 nodi, relay senza
 * chiave, chiave sbagliata, retrocompatibilità col percorso in chiaro).
 */

function makeNode(displayName: string, options: ConstructorParameters<typeof NomadNode>[0] = {}): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName, ...options });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

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

describe("Emergency beacon payload encryption (emergencyBeaconKey)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("throws in the constructor if emergencyBeaconKey isn't exactly 32 bytes", () => {
    expect(() => new NomadNode({ emergencyBeaconKey: randomBytes(31) })).toThrow(/32 bytes/);
    expect(() => new NomadNode({ emergencyBeaconKey: randomBytes(33) })).toThrow(/32 bytes/);
    expect(() => new NomadNode({ emergencyBeaconKey: randomBytes(32) })).not.toThrow();
  });

  it("delivers a fully readable sighting end-to-end when beacon and Emergency Node share the same key, through a relay that never sees it in the clear", async () => {
    const key = randomBytes(32);
    const beacon = makeNode("Beacon", { emergencyBeaconKey: key });
    const relay = makeNode("Relay"); // deliberately no key — the untrusted middle hop
    const emergencyNode = makeNode("EmergencyNode", { emergencyBeaconKey: key });
    nodes.push(beacon.node, relay.node, emergencyNode.node);
    await Promise.all([beacon, relay, emergencyNode].map(({ node }) => node.start()));
    await beacon.node.connect({ host: "127.0.0.1", port: relay.transport.port });
    await relay.node.connect({ host: "127.0.0.1", port: emergencyNode.transport.port });

    const sighting = beacon.node.sendEmergencyBeacon({ message: "gamba rotta, non posso camminare", lat: 46.5, lon: 10.3 });

    await waitFor(() => emergencyNode.node.emergencyBeacons.list().length === 1);
    const received = emergencyNode.node.emergencyBeacons.list()[0];
    expect(received.beaconContentId).toBe(sighting.beaconContentId);
    expect(received.message).toBe("gamba rotta, non posso camminare");
    expect(received.lat).toBe(46.5);
    expect(received.lon).toBe(10.3);

    // The relay forwarded/cached the ciphertext (proven by the Emergency Node receiving it at all —
    // it only ever connected to the relay, never to the beacon), but never had the key, so it never
    // produced its own readable sighting — the "blind forwarding" property this feature exists for.
    await new Promise((resolve) => setTimeout(resolve, 200)); // time for relay's own (failed) decode to have happened
    expect(relay.node.emergencyBeacons.list()).toEqual([]);
  });

  it("never records a sighting when the receiver's key doesn't match the sender's — wrong key is indistinguishable from no key", async () => {
    const beacon = makeNode("Beacon", { emergencyBeaconKey: randomBytes(32) });
    const wrongKeyNode = makeNode("WrongKey", { emergencyBeaconKey: randomBytes(32) });
    nodes.push(beacon.node, wrongKeyNode.node);
    await Promise.all([beacon, wrongKeyNode].map(({ node }) => node.start()));
    await beacon.node.connect({ host: "127.0.0.1", port: wrongKeyNode.transport.port });

    beacon.node.sendEmergencyBeacon({ message: "non dovrebbe essere leggibile qui" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(wrongKeyNode.node.emergencyBeacons.list()).toEqual([]);
  });

  it("stays fully plaintext and unaffected when emergencyBeaconKey is omitted on both sides — the pre-existing default, unchanged", async () => {
    const beacon = makeNode("Beacon");
    const receiver = makeNode("Receiver");
    nodes.push(beacon.node, receiver.node);
    await Promise.all([beacon, receiver].map(({ node }) => node.start()));
    await beacon.node.connect({ host: "127.0.0.1", port: receiver.transport.port });

    beacon.node.sendEmergencyBeacon({ message: "test in chiaro" });
    await waitFor(() => receiver.node.emergencyBeacons.list().length === 1);
    expect(receiver.node.emergencyBeacons.list()[0].message).toBe("test in chiaro");
  });

  it("the wire bytes are genuinely ciphertext when a key is configured — the plaintext message never appears on the wire in the clear", async () => {
    const key = randomBytes(32);
    const beacon = makeNode("Beacon", { emergencyBeaconKey: key });
    nodes.push(beacon.node);
    await beacon.node.start();

    const chunks: Buffer[] = [];

    // Eavesdrop with a raw socket acting as an extra peer of the beacon — floodExcept() sends to
    // every connected peer for a broadcast packet (no destination), this one included. Same
    // technique tests/integration/drops.test.ts's own wire-format tests use.
    const net = await import("node:net");
    const rawSocket = net.createConnection({ host: "127.0.0.1", port: beacon.transport.port });
    await new Promise<void>((resolve, reject) => {
      rawSocket.once("connect", () => resolve());
      rawSocket.once("error", reject);
    });
    const { encodePacket, createPacket, MessageType } = await import("../../node/src/packet.js");
    const { Identity } = await import("../../node/src/identity.js");
    const listener = Identity.generate();
    rawSocket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: listener.nodeId, payload: {} })));
    await waitFor(() => beacon.node.peers.has(listener.nodeId));
    rawSocket.on("data", (chunk) => chunks.push(chunk));

    const plaintextMessage = "messaggio-segreto-non-deve-comparire-in-chiaro";
    beacon.node.sendEmergencyBeacon({ message: plaintextMessage });

    await new Promise((resolve) => setTimeout(resolve, 200));
    const raw = Buffer.concat(chunks).toString("utf8");
    expect(raw).not.toContain(plaintextMessage);

    const lines = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const announce = lines.find((p) => p.type === "CONTENT_ANNOUNCE" && p.payload?.metadata?.name === "emergency-beacon");
    expect(announce).toBeDefined();
    const decodedData = JSON.parse(Buffer.from(announce.payload.data, "base64").toString("utf8"));
    expect(decodedData).toMatchObject({ encrypted: true, nonce: expect.any(String), ciphertext: expect.any(String), authTag: expect.any(String) });
    expect(decodedData.ciphertext).not.toContain(plaintextMessage);

    rawSocket.destroy();
  });
});
