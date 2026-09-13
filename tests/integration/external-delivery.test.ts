import { createServer, type IncomingMessage, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NomadNode, type NomadNodeOptions } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { EncryptionIdentity } from "../../node/src/encryption.js";
import { Identity } from "../../node/src/identity.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import {
  sealExternalDelivery,
  unsealExternalDelivery,
  computeExternalDeliveryAuthProof,
  type ExternalDeliveryAllowlist,
} from "../../node/src/external-delivery.js";

/**
 * "Consegna esterna differita" (`docs/service-catalog.md`) — the real
 * network path: an operator (never in direct contact with the BOX)
 * discovers a friendly-label directory purely via catalog sync, submits a
 * file E2E-sealed to an external destination, the BOX queues it without
 * ever being able to read it, and delivers it to a fake local HTTP server
 * standing in for the destination organization's own intake endpoint —
 * only that destination's private key can decrypt what arrives. Unit-level
 * payload/queue/directory validation is covered in
 * `tests/unit/external-delivery.test.ts`; this file only exercises what's
 * new at the mesh/network layer.
 *
 * `isPubliclyRoutableUrl()` (`url-safety.ts`, `attemptExternalDeliveryPost()`'s
 * own SSRF guard) is mocked open here, same technique
 * `internet-gateway.test.ts` already uses for the same reason: every fake
 * destination server in this file is deliberately loopback (127.0.0.1), the
 * exact address class that guard exists to reject in production — the guard
 * itself is unit-tested end to end in `tests/unit/url-safety.test.ts`, and
 * one dedicated test below un-mocks it to confirm `attemptExternalDeliveryPost()`
 * actually wires it in.
 */
vi.mock("../../node/src/url-safety.js", () => ({ isPubliclyRoutableUrl: vi.fn(async () => true) }));

function makeNode(displayName: string, options: Partial<NomadNodeOptions> = {}): { node: NomadNode; transport: TcpTransport } {
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

/** A minimal local stand-in for an external organization's own intake endpoint — captures every POST body verbatim, opaque to this test just as it is to the BOX (only decrypted afterward, with the destination's own private key, to prove what actually arrived). */
async function startFakeDestinationServer(): Promise<{ url: string; received: unknown[]; close: () => Promise<void> }> {
  const received: unknown[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push({ malformed: body });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  const url = `http://127.0.0.1:${address.port}/intake`;
  return { url, received, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

describe("Consegna esterna differita (sendExternalDelivery / handleExternalDelivery / directory sync / delivery)", () => {
  const nodes: NomadNode[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    await Promise.all(servers.map((s) => s.close()));
    nodes.length = 0;
    servers.length = 0;
  });

  it("end to end: an operator two hops from the BOX (never in direct contact with it) discovers the directory via catalog sync, submits a file, the BOX queues then delivers it, and only the correct destination key can decrypt what arrived", async () => {
    const destination = EncryptionIdentity.generate();
    const fakeServer = await startFakeDestinationServer();
    servers.push(fakeServer);

    const allowlist: ExternalDeliveryAllowlist = new Map([
      ["hq-1", { destinationId: "hq-1", label: "Headquarter", publicKeyHex: destination.publicKeyHex, url: fakeServer.url }],
    ]);
    const box = makeNode("Box", { externalDeliveryAllowlist: allowlist });
    const relay = makeNode("Relay");
    const operator = makeNode("Operatore"); // two hops from Box, via Relay — never connects to Box directly
    nodes.push(box.node, relay.node, operator.node);
    await Promise.all([box, relay, operator].map(({ node }) => node.start()));
    await box.node.connect({ host: "127.0.0.1", port: relay.transport.port });
    await operator.node.connect({ host: "127.0.0.1", port: relay.transport.port });

    box.node.publishExternalDeliveryDirectory();

    // The operator's device learns {destinationId, label, publicKeyHex, boxNodeId, requiresPassword}
    // purely via CONTENT_ANNOUNCE relayed by Relay, followed by considerExternalDeliveryDirectory()'s
    // own getContent() round trip across the two hops to the Box — a longer timeout than this file's
    // other waitFor() calls, since that round trip (CONTENT_QUERY -> CONTENT_FOUND -> CONTENT_REQUEST
    // -> CONTENT_CHUNK/COMPLETE) can itself take close to contentRequestTimeoutMs's own 3s default.
    await waitFor(() => operator.node.externalDeliveryDirectory.list().length === 1, 5000);
    const entry = operator.node.externalDeliveryDirectory.list()[0];
    expect(entry).toEqual({
      destinationId: "hq-1",
      label: "Headquarter",
      publicKeyHex: destination.publicKeyHex,
      requiresPassword: false,
      boxNodeId: box.node.nodeId,
    });

    const plaintext = Buffer.from("report dal campo: tutto tranquillo", "utf8");
    operator.node.sendExternalDelivery(entry.boxNodeId, entry.destinationId, entry.publicKeyHex, plaintext);

    await waitFor(() => box.node.externalDeliveryQueue.size === 1);
    await box.node.attemptExternalDeliveries();

    await waitFor(() => fakeServer.received.length === 1);
    expect(box.node.externalDeliveryQueue.size).toBe(0); // removed after a successful (2xx) delivery

    const arrived = fakeServer.received[0] as {
      destinationId: string;
      senderEphemeralPublicKey: string;
      nonce: string;
      ciphertext: string;
      authTag: string;
      submittedAt: number;
    };
    expect(arrived.destinationId).toBe("hq-1");
    expect(typeof arrived.submittedAt).toBe("number");

    // Only the destination's own private key can decrypt — an impostor holding neither ephemeral nor
    // destination private key must fail.
    const decrypted = unsealExternalDelivery(destination, arrived);
    expect(decrypted).toEqual(plaintext);
    const impostor = EncryptionIdentity.generate();
    expect(() => unsealExternalDelivery(impostor, arrived)).toThrow();
  });

  it("silently drops a submission whose destinationId isn't in the BOX's private allowlist — never queued", async () => {
    const destination = EncryptionIdentity.generate();
    const allowlist: ExternalDeliveryAllowlist = new Map([
      ["hq-1", { destinationId: "hq-1", label: "Headquarter", publicKeyHex: destination.publicKeyHex, url: "http://127.0.0.1:1/unused" }],
    ]);
    const box = makeNode("Box", { externalDeliveryAllowlist: allowlist });
    const sender = makeNode("Sender");
    nodes.push(box.node, sender.node);
    await Promise.all([box, sender].map(({ node }) => node.start()));
    await sender.node.connect({ host: "127.0.0.1", port: box.transport.port });

    sender.node.sendExternalDelivery(box.node.nodeId, "unknown-destination", destination.publicKeyHex, Buffer.from("dati"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(box.node.externalDeliveryQueue.size).toBe(0);
  });

  it("rejects a submission to a password-protected destination with no proof or the wrong one, but accepts it with the correct password", async () => {
    const destination = EncryptionIdentity.generate();
    const allowlist: ExternalDeliveryAllowlist = new Map([
      [
        "ong-1",
        {
          destinationId: "ong-1",
          label: "Centro Operativo",
          publicKeyHex: destination.publicKeyHex,
          url: "http://127.0.0.1:1/unused",
          password: "s3gr3t0-canale",
        },
      ],
    ]);
    const box = makeNode("Box", { externalDeliveryAllowlist: allowlist });
    const sender = makeNode("Sender");
    nodes.push(box.node, sender.node);
    await Promise.all([box, sender].map(({ node }) => node.start()));
    await sender.node.connect({ host: "127.0.0.1", port: box.transport.port });

    // No password at all.
    sender.node.sendExternalDelivery(box.node.nodeId, "ong-1", destination.publicKeyHex, Buffer.from("no password"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(box.node.externalDeliveryQueue.size).toBe(0);

    // Wrong password.
    sender.node.sendExternalDelivery(box.node.nodeId, "ong-1", destination.publicKeyHex, Buffer.from("wrong password"), {
      password: "not-the-password",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(box.node.externalDeliveryQueue.size).toBe(0);

    // Correct password — accepted and queued.
    sender.node.sendExternalDelivery(box.node.nodeId, "ong-1", destination.publicKeyHex, Buffer.from("correct password"), {
      password: "s3gr3t0-canale",
    });
    await waitFor(() => box.node.externalDeliveryQueue.size === 1);
  });

  it("regression (found by code-review): a captured authProof from one accepted submission is refused for a *different* submission's content, even with the same password/destinationId — a relay observing one valid proof in the clear must never be able to forge new submissions with it", async () => {
    const destination = EncryptionIdentity.generate();
    const allowlist: ExternalDeliveryAllowlist = new Map([
      [
        "ong-1",
        { destinationId: "ong-1", label: "Centro Operativo", publicKeyHex: destination.publicKeyHex, url: "http://127.0.0.1:1/unused", password: "s3gr3t0-canale" },
      ],
    ]);
    const box = makeNode("Box", { externalDeliveryAllowlist: allowlist });
    nodes.push(box.node);
    await box.node.start();

    // The genuine submission whose authProof gets "observed" and replayed — its exact sealed fields
    // are what the forged packet below borrows the proof from, deliberately with different content.
    const genuine = sealExternalDelivery(destination.publicKeyHex, Buffer.from("submissione originale"));
    const observedAuthProof = computeExternalDeliveryAuthProof("s3gr3t0-canale", "ong-1", genuine.nonce, genuine.ciphertext, genuine.authTag);

    // A raw socket standing in for a relay that captured `observedAuthProof` off the wire and now
    // forges a new EXTERNAL_DELIVERY packet reusing it verbatim, but with different sealed content —
    // same raw-injection technique tests/integration/malformed-packet-robustness.test.ts already uses
    // for adversarial packets that a real NomadNode would never construct on its own.
    const forger: Socket = createConnection({ host: "127.0.0.1", port: box.transport.port });
    await new Promise<void>((resolve, reject) => {
      forger.once("connect", () => resolve());
      forger.once("error", reject);
    });
    const forgerIdentity = Identity.generate();
    forger.write(encodePacket(createPacket({ type: MessageType.HELLO, source: forgerIdentity.nodeId, payload: {} })));
    await waitFor(() => box.node.peers.has(forgerIdentity.nodeId));

    const forgedSeal = sealExternalDelivery(destination.publicKeyHex, Buffer.from("dato falsificato dal relay"));
    const forgedPacket = createPacket({
      type: MessageType.EXTERNAL_DELIVERY,
      source: forgerIdentity.nodeId,
      destination: box.node.nodeId,
      payload: {
        destinationId: "ong-1",
        senderEphemeralPublicKey: forgedSeal.senderEphemeralPublicKey,
        nonce: forgedSeal.nonce,
        ciphertext: forgedSeal.ciphertext,
        authTag: forgedSeal.authTag,
        authProof: observedAuthProof, // the captured proof, replayed against different content
        submittedAt: Date.now(),
      },
    });
    forger.write(encodePacket(forgedPacket));

    await new Promise((resolve) => setTimeout(resolve, 250));
    // Never queued — verifyExternalDeliveryAuthProof() rejects a proof that doesn't match this
    // packet's own nonce/ciphertext/authTag, even though it matches the right password/destinationId.
    expect(box.node.externalDeliveryQueue.size).toBe(0);
    forger.destroy();
  });

  it("sendExternalDelivery() rejects an oversized payload locally, before ever sending anything on the wire", async () => {
    const destination = EncryptionIdentity.generate();
    const sender = makeNode("Sender", { maxExternalDeliveryPayloadBytes: 10 });
    nodes.push(sender.node);
    await sender.node.start();

    expect(() => sender.node.sendExternalDelivery("some-box", "hq-1", destination.publicKeyHex, Buffer.alloc(11))).toThrow(
      /external delivery payload must be/,
    );
    // Exactly at the limit is fine (validated only, no peer to actually deliver to here).
    expect(() => sender.node.sendExternalDelivery("some-box", "hq-1", destination.publicKeyHex, Buffer.alloc(10))).not.toThrow();
  });

  it("a failed delivery attempt (destination unreachable) leaves the entry queued for the next tick, never silently dropped", async () => {
    const destination = EncryptionIdentity.generate();
    // Port 1 is a reserved/unreachable port on every platform this test runs on — the POST is
    // guaranteed to fail (ECONNREFUSED or similar), never a real 2xx.
    const allowlist: ExternalDeliveryAllowlist = new Map([
      ["hq-1", { destinationId: "hq-1", label: "Headquarter", publicKeyHex: destination.publicKeyHex, url: "http://127.0.0.1:1/unreachable" }],
    ]);
    const box = makeNode("Box", { externalDeliveryAllowlist: allowlist });
    const sender = makeNode("Sender");
    nodes.push(box.node, sender.node);
    await Promise.all([box, sender].map(({ node }) => node.start()));
    await sender.node.connect({ host: "127.0.0.1", port: box.transport.port });

    sender.node.sendExternalDelivery(box.node.nodeId, "hq-1", destination.publicKeyHex, Buffer.from("dati"));
    await waitFor(() => box.node.externalDeliveryQueue.size === 1);

    await box.node.attemptExternalDeliveries();
    expect(box.node.externalDeliveryQueue.size).toBe(1); // still there — best-effort, no ack, retried next tick
  });

  it("attemptExternalDeliveryPost()'s real (unmocked) SSRF guard refuses a loopback destination URL — an admin misconfiguration never reaches a real fetch()", async () => {
    // The only test in this file that exercises the real url-safety.ts instead of this file's own
    // top-level mock (see that mock's own doc comment) — same vi.doUnmock() + vi.resetModules() +
    // re-import technique tests/unit/url-safety.test.ts's own "real hosts-file resolution" test and
    // tests/integration/internet-gateway.test.ts already use for the identical need.
    vi.doUnmock("../../node/src/url-safety.js");
    vi.resetModules();
    const { NomadNode: RealNomadNode } = await import("../../node/src/node.js");
    const { TcpTransport: RealTcpTransport } = await import("../../node/src/transports/tcp.js");
    const { EncryptionIdentity: RealEncryptionIdentity } = await import("../../node/src/encryption.js");

    const destination = RealEncryptionIdentity.generate();
    const fakeServer = await startFakeDestinationServer(); // deliberately loopback — exactly what must be refused
    servers.push(fakeServer);
    const allowlist = new Map([
      ["hq-1", { destinationId: "hq-1", label: "Headquarter", publicKeyHex: destination.publicKeyHex, url: fakeServer.url }],
    ]);
    const box = new RealNomadNode({ displayName: "Box", externalDeliveryAllowlist: allowlist });
    const boxTransport = new RealTcpTransport(box.nodeId, 0);
    box.addTransport(boxTransport);
    const sender = new RealNomadNode({ displayName: "Sender" });
    const senderTransport = new RealTcpTransport(sender.nodeId, 0);
    sender.addTransport(senderTransport);
    nodes.push(box, sender);
    await Promise.all([box.start(), sender.start()]);
    await sender.connect({ host: "127.0.0.1", port: boxTransport.port });

    sender.sendExternalDelivery(box.nodeId, "hq-1", destination.publicKeyHex, Buffer.from("dati"));
    await waitFor(() => box.externalDeliveryQueue.size === 1);

    await box.attemptExternalDeliveries();
    expect(box.externalDeliveryQueue.size).toBe(1); // refused before ever reaching the fake server
    expect(fakeServer.received).toHaveLength(0);
  });
});
