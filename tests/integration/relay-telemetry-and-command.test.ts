import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { Identity } from "../../node/src/identity.js";
import { TrustLevel } from "../../node/src/trust.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { encryptForPeer } from "../../node/src/encryption.js";

/**
 * Relay telemetry (battery self-reporting) and remote relay commands
 * (currently only "reboot") — `docs/beacon.md`, "Fixed Relay e Registro dei
 * relay". Both reuse the same directed-delivery `PRIVATE_MESSAGE` mechanism
 * `appendToNode()` already established (see `tests/integration/node-append.test.ts`
 * for the same technique applied there). Unit-level payload validation and
 * `RelayRegistry.recordTelemetry()`'s own anti-out-of-order/anti-poisoning
 * guards are covered in `tests/unit/relay-registry.test.ts` — this file
 * exercises the real network path.
 *
 * Explicitly evaluated and rejected as out of scope for this feature
 * (user decision, 6 September 2026): remote firmware/software updates over
 * the mesh — an operator must be physically connected to the hardware to
 * update it. Only telemetry (read) and reboot (a narrow, single command)
 * exist here.
 */

function makeNode(displayName: string, options: ConstructorParameters<typeof NomadNode>[0] = {}): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName, ...options });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 15): Promise<void> {
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

async function connectAndSync(a: { node: NomadNode; transport: TcpTransport }, b: { node: NomadNode; transport: TcpTransport }): Promise<void> {
  await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
  await Promise.all([a.node.waitForPeerKey(b.node.nodeId), b.node.waitForPeerKey(a.node.nodeId)]);
}

describe("Relay telemetry (reportRelayTelemetry / considerRelayTelemetry)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("delivers a battery report to the relay registry node, updating an already-registered relay's entry", async () => {
    const relay = makeNode("Relay", { relayPolicy: { getResourceState: () => ({ batteryPercent: 73 }) } });
    const emergencyNode = makeNode("EmergencyNode");
    nodes.push(relay.node, emergencyNode.node);
    await Promise.all([relay, emergencyNode].map(({ node }) => node.start()));
    emergencyNode.node.registerAsRelayRegistry();
    emergencyNode.node.registerRelay({ relayId: relay.node.nodeId, type: "fixed", lat: 45, lon: 9 });
    await connectAndSync(relay, emergencyNode);

    await relay.node.reportRelayTelemetry();
    await waitFor(() => emergencyNode.node.relayRegistry.get(relay.node.nodeId)?.batteryPercent === 73);
    expect(emergencyNode.node.relayRegistry.get(relay.node.nodeId)?.lastTelemetryAt).toEqual(expect.any(Number));
  });

  it("silently ignores telemetry from a relay id that was never registered by an operator — never creates a new entry", async () => {
    const relay = makeNode("Relay", { relayPolicy: { getResourceState: () => ({ batteryPercent: 50 }) } });
    const emergencyNode = makeNode("EmergencyNode");
    nodes.push(relay.node, emergencyNode.node);
    await Promise.all([relay, emergencyNode].map(({ node }) => node.start()));
    emergencyNode.node.registerAsRelayRegistry();
    // Deliberately never registerRelay() — this relay is a stranger to the registry.
    await connectAndSync(relay, emergencyNode);

    await relay.node.reportRelayTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 200)); // time for the (ignored) telemetry to have arrived
    expect(emergencyNode.node.relayRegistry.get(relay.node.nodeId)).toBeUndefined();
    expect(emergencyNode.node.relayRegistry.list()).toEqual([]);
  });

  it("throws when no battery level is configured on relayPolicy, without ever discovering a registry", async () => {
    const relay = makeNode("Relay"); // no relayPolicy.getResourceState configured
    nodes.push(relay.node);
    await relay.node.start();

    await expect(relay.node.reportRelayTelemetry()).rejects.toThrow(/no battery level is currently reported/);
  });

  it("throws when no relay registry is discovered within the timeout", async () => {
    const relay = makeNode("Relay", { relayPolicy: { getResourceState: () => ({ batteryPercent: 10 }) } });
    nodes.push(relay.node);
    await relay.node.start();

    await expect(relay.node.reportRelayTelemetry({ timeoutMs: 100 })).rejects.toThrow();
  });

  it("a later, genuinely newer report overwrites an earlier one — ordinary repeated periodic reporting", async () => {
    let batteryPercent = 80;
    const relay = makeNode("Relay", { relayPolicy: { getResourceState: () => ({ batteryPercent }) } });
    const emergencyNode = makeNode("EmergencyNode");
    nodes.push(relay.node, emergencyNode.node);
    await Promise.all([relay, emergencyNode].map(({ node }) => node.start()));
    emergencyNode.node.registerAsRelayRegistry();
    emergencyNode.node.registerRelay({ relayId: relay.node.nodeId, type: "fixed", lat: 45, lon: 9 });
    await connectAndSync(relay, emergencyNode);

    await relay.node.reportRelayTelemetry();
    await waitFor(() => emergencyNode.node.relayRegistry.get(relay.node.nodeId)?.batteryPercent === 80);

    batteryPercent = 65; // battery draining, next report reflects it
    await relay.node.reportRelayTelemetry();
    await waitFor(() => emergencyNode.node.relayRegistry.get(relay.node.nodeId)?.batteryPercent === 65);
  });
});

describe("Relay commands (sendRelayCommand / considerRelayCommand)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("rejects a reboot command from a sender merely VERIFIED (ordinary identity gossip) — the default TrustLevel.ADMIN gate is deliberately stricter", async () => {
    const emergencyNode = makeNode("EmergencyNode");
    const relay = makeNode("Relay");
    nodes.push(emergencyNode.node, relay.node);
    await Promise.all([emergencyNode, relay].map(({ node }) => node.start()));
    await connectAndSync(emergencyNode, relay);
    expect(relay.node.trust.get(emergencyNode.node.nodeId)).toBe(TrustLevel.VERIFIED); // ordinary gossip, not enough here

    const rejected: string[] = [];
    relay.node.on("relay-command:rejected", (senderId: string) => rejected.push(senderId));
    const rebootRequested: string[] = [];
    relay.node.on("relay:reboot-requested", (senderId: string) => rebootRequested.push(senderId));

    emergencyNode.node.sendRelayCommand(relay.node.nodeId);
    await waitFor(() => rejected.length === 1);
    expect(rejected).toEqual([emergencyNode.node.nodeId]);
    expect(rebootRequested).toEqual([]);
  });

  it("accepts a reboot command once the sender is explicitly trusted at ADMIN on the target — emits relay:reboot-requested with the sender's id", async () => {
    const emergencyNode = makeNode("EmergencyNode");
    const relay = makeNode("Relay");
    nodes.push(emergencyNode.node, relay.node);
    await Promise.all([emergencyNode, relay].map(({ node }) => node.start()));
    await connectAndSync(emergencyNode, relay);
    relay.node.trust.set(emergencyNode.node.nodeId, TrustLevel.ADMIN); // the --trust-admin provisioning step

    const rebootRequested: string[] = [];
    relay.node.on("relay:reboot-requested", (senderId: string) => rebootRequested.push(senderId));

    emergencyNode.node.sendRelayCommand(relay.node.nodeId);
    await waitFor(() => rebootRequested.length === 1);
    expect(rebootRequested).toEqual([emergencyNode.node.nodeId]);
  });

  it("a custom minTrustForRelayCommand of TRUSTED accepts a TRUSTED (not just ADMIN) sender", async () => {
    const emergencyNode = makeNode("EmergencyNode");
    const relay = makeNode("Relay", { minTrustForRelayCommand: TrustLevel.TRUSTED });
    nodes.push(emergencyNode.node, relay.node);
    await Promise.all([emergencyNode, relay].map(({ node }) => node.start()));
    await connectAndSync(emergencyNode, relay);
    relay.node.trust.set(emergencyNode.node.nodeId, TrustLevel.TRUSTED);

    const rebootRequested: string[] = [];
    relay.node.on("relay:reboot-requested", (senderId: string) => rebootRequested.push(senderId));

    emergencyNode.node.sendRelayCommand(relay.node.nodeId);
    await waitFor(() => rebootRequested.length === 1);
  });

  it("sendRelayCommand() throws when the target's encryption key isn't known yet", async () => {
    const emergencyNode = makeNode("EmergencyNode");
    nodes.push(emergencyNode.node);
    await emergencyNode.node.start();

    expect(() => emergencyNode.node.sendRelayCommand("unknown-node-id")).toThrow(/encryption key.*is not yet known/);
  });

  it("caps sendRelayCommand() at MAX_RELAY_COMMANDS_PER_WINDOW (3) within the window, and the receiving side genuinely accepts all 3 rapid-fire sends (none mutually rejected by the replay guard's monotonic-timestamp check)", async () => {
    const emergencyNode = makeNode("EmergencyNode");
    const relay = makeNode("Relay");
    nodes.push(emergencyNode.node, relay.node);
    await Promise.all([emergencyNode, relay].map(({ node }) => node.start()));
    await connectAndSync(emergencyNode, relay);
    relay.node.trust.set(emergencyNode.node.nodeId, TrustLevel.ADMIN);

    // Found by review: an earlier version of this test only checked that sendRelayCommand() itself
    // throws on the 4th call — it never asserted anything about what the *receiver* did with the
    // first 3, so a regression in sendRelayCommand()'s monotonic-timestamp guarantee (e.g. reverting
    // to raw Date.now(), which two same-millisecond back-to-back synchronous calls can share) could
    // make considerRelayCommand()'s own replay guard silently drop the 2nd/3rd as a "replay" of the
    // 1st, and this test would still pass.
    const rebootRequested: string[] = [];
    const rejected: string[] = [];
    relay.node.on("relay:reboot-requested", (senderId: string) => rebootRequested.push(senderId));
    relay.node.on("relay-command:rejected", (senderId: string) => rejected.push(senderId));

    for (let i = 0; i < 3; i++) emergencyNode.node.sendRelayCommand(relay.node.nodeId);
    expect(() => emergencyNode.node.sendRelayCommand(relay.node.nodeId)).toThrow(/too many relay commands/);

    await waitFor(() => rebootRequested.length === 3);
    expect(rejected).toEqual([]);
  });

  it("an attempt against an as-yet-undiscovered target's key throws immediately, without ever consuming the rate-limit budget", async () => {
    const emergencyNode = makeNode("EmergencyNode");
    nodes.push(emergencyNode.node);
    await emergencyNode.node.start();

    const unknownTarget = Identity.generate().nodeId;
    for (let i = 0; i < 10; i++) {
      expect(() => emergencyNode.node.sendRelayCommand(unknownTarget)).toThrow(/encryption key/);
    }

    const relay = makeNode("Relay");
    nodes.push(relay.node);
    await relay.node.start();
    await connectAndSync(emergencyNode, relay);
    relay.node.trust.set(emergencyNode.node.nodeId, TrustLevel.ADMIN);

    // The whole 3-command budget is still available — none of the 10 rejected attempts above spent it.
    for (let i = 0; i < 3; i++) emergencyNode.node.sendRelayCommand(relay.node.nodeId);
    expect(() => emergencyNode.node.sendRelayCommand(relay.node.nodeId)).toThrow(/too many relay commands/);
  });

  it("rejects a replayed copy of an already-accepted command — a genuinely new packet id carrying the same (or an older) payload timestamp is not enough to bypass the replay guard", async () => {
    // Regression for a real gap found by review: SeenCache (routing.ts) only dedupes by packet.id,
    // which is bounded/evictable — it does not, by itself, stop a *new* packet (fresh id) from
    // carrying a stale/replayed relay-command payload once an attacker has captured one genuine
    // ciphertext. considerRelayCommand()'s own guard (command.timestamp strictly greater than the
    // last *accepted* timestamp for that sender) is what actually has to catch this. Simulated here
    // by encrypting a second, forged packet with the exact same encryption identities real
    // sendRelayCommand()/handlePrivateMessage() use (packet.source is never cryptographically bound
    // to which connection delivered it — CLAUDE.md's own documented limit — so this is a realistic
    // forgery, not a test-only shortcut).
    const emergencyNode = makeNode("EmergencyNode");
    const relay = makeNode("Relay");
    nodes.push(emergencyNode.node, relay.node);
    await Promise.all([emergencyNode, relay].map(({ node }) => node.start()));
    await connectAndSync(emergencyNode, relay);
    relay.node.trust.set(emergencyNode.node.nodeId, TrustLevel.ADMIN);

    const rebootRequested: string[] = [];
    const rejected: string[] = [];
    relay.node.on("relay:reboot-requested", (senderId: string) => rebootRequested.push(senderId));
    relay.node.on("relay-command:rejected", (senderId: string) => rejected.push(senderId));

    emergencyNode.node.sendRelayCommand(relay.node.nodeId);
    await waitFor(() => rebootRequested.length === 1);

    // Forge a second, independent packet (fresh packet.id) whose decrypted payload carries the same
    // timestamp as the one just accepted — the real shared key, so decryption genuinely succeeds.
    const sharedKey = emergencyNode.node.encryptionIdentity.sharedKeyWith(relay.node.encryptionIdentity.publicKeyHex);
    const acceptedTimestamp = Date.now(); // sendRelayCommand() just used "now" or later — close enough that <= is what we need to prove
    const replayedPayload = { type: "relay-command" as const, command: "reboot" as const, timestamp: acceptedTimestamp - 5000 };
    const encrypted = encryptForPeer(sharedKey, Buffer.from(JSON.stringify(replayedPayload), "utf8"));
    const forgedPacket = createPacket({
      type: MessageType.PRIVATE_MESSAGE,
      source: emergencyNode.node.nodeId,
      destination: relay.node.nodeId,
      payload: encrypted,
    });

    // A throwaway raw connection into the relay — only needs to complete a HELLO to be accepted as
    // *some* connected peer; packet.source (forged above, not this connection's own identity) is
    // what handlePrivateMessage() actually trusts for the decryption-key lookup.
    const socket = createConnection({ host: "127.0.0.1", port: relay.transport.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const throwawayIdentity = Identity.generate();
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: throwawayIdentity.nodeId, payload: {} })));
    await waitFor(() => relay.node.peers.has(throwawayIdentity.nodeId));
    socket.write(encodePacket(forgedPacket));

    await waitFor(() => rejected.length === 1);
    expect(rebootRequested).toHaveLength(1); // still just the one genuine acceptance — the replay never got through
    socket.destroy();
  });
});
