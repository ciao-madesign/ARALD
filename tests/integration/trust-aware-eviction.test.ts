import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { computeContentId, contentSigningPayload } from "../../node/src/content.js";
import { EncryptionIdentity, signIdentityAnnouncement } from "../../node/src/encryption.js";
import { Identity } from "../../node/src/identity.js";
import { TrustLevel } from "../../node/src/trust.js";

/**
 * PeerDirectory and RemoteCatalog now rank entries by the trust of the
 * node id behind them when deciding what to evict at capacity, the same
 * defense TrustManager already applied to itself (docs/security.md). A
 * self-signed claim is cheap to fabricate — anyone can generate a fresh
 * keypair and sign with it — so merely having a *valid* signature only
 * ever earns automatic VERIFIED status, never higher; TRUSTED/ADMIN are
 * operator-assigned (spec §54, RIFUGIO-NET/SOCCORSO-NET). These tests
 * confirm an operator-trusted entry survives a flood of throwaway
 * identities that are each individually "valid", just not trusted.
 */

function waitForConnected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
}

async function connectAttacker(port: number, attackerId: string): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await waitForConnected(socket);
  socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: attackerId, payload: {} })));
  return socket;
}

describe("trust-aware eviction resists a flood of throwaway identities", () => {
  let victim: NomadNode | undefined;
  let legit: NomadNode | undefined;
  let attackerSocket: Socket | undefined;

  afterEach(async () => {
    attackerSocket?.destroy();
    if (victim) await victim.stop();
    if (legit) await legit.stop();
    victim = undefined;
    legit = undefined;
    attackerSocket = undefined;
  });

  it("PeerDirectory: keeps an operator-trusted peer's key while evicting merely-verified throwaway ones", async () => {
    victim = new NomadNode({ displayName: "victim", maxPeerDirectoryEntries: 2 });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    legit = new NomadNode({ displayName: "legit" });
    const legitTransport = new TcpTransport(legit.nodeId, 0);
    legit.addTransport(legitTransport);
    await legit.start();
    await legit.connect({ host: "127.0.0.1", port: victimTransport.port });
    await victim.waitForPeerKey(legit.nodeId, { timeoutMs: 2000 });

    // An operator vouches for this specific, known device — e.g. a rescue team member's phone,
    // spec §54's RIFUGIO-NET/SOCCORSO-NET scenario — not something a throwaway identity can earn.
    victim.trust.set(legit.nodeId, TrustLevel.TRUSTED);

    attackerSocket = await connectAttacker(victimTransport.port, "9".repeat(64));

    for (let i = 0; i < 2; i++) {
      const throwaway = Identity.generate();
      const announcement = signIdentityAnnouncement(throwaway, EncryptionIdentity.generate());
      attackerSocket.write(
        encodePacket(
          createPacket({
            type: MessageType.IDENTITY_RESPONSE,
            source: throwaway.nodeId,
            destination: victim.nodeId,
            payload: { announcements: [announcement] },
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    expect(victim.peerDirectory.has(legit.nodeId)).toBe(true);
    expect(victim.peerDirectory.size).toBe(2); // the trusted entry plus only the *last* throwaway
  });

  it("RemoteCatalog: keeps an operator-trusted publisher's content while evicting merely-verified throwaway publishers", async () => {
    victim = new NomadNode({ displayName: "victim", maxRemoteCatalogEntries: 2 });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    legit = new NomadNode({ displayName: "legit" });
    const legitTransport = new TcpTransport(legit.nodeId, 0);
    legit.addTransport(legitTransport);
    await legit.start();
    const legitData = Buffer.from("mappa ufficiale del rifugio");
    const legitMetadata = legit.publishContent("mappa.txt", "text/plain", legitData);
    await legit.connect({ host: "127.0.0.1", port: victimTransport.port });

    await new Promise((resolve) => {
      const check = (): void => {
        if (victim!.remoteCatalog.has(legitMetadata.contentId)) resolve(undefined);
        else setTimeout(check, 15);
      };
      check();
    });
    victim.trust.set(legit.nodeId, TrustLevel.TRUSTED);

    attackerSocket = await connectAttacker(victimTransport.port, "8".repeat(64));

    for (let i = 0; i < 2; i++) {
      const throwaway = Identity.generate();
      const data = Buffer.from(`spam ${i}`);
      const fields = {
        contentId: computeContentId(data),
        name: `spam-${i}.txt`,
        mimeType: "text/plain",
        size: data.length,
        publisherId: throwaway.nodeId,
      };
      const metadata = { ...fields, createdAt: Date.now(), signature: throwaway.sign(contentSigningPayload(fields)).toString("hex") };
      attackerSocket.write(
        encodePacket(
          createPacket({
            type: MessageType.SYNC_RESPONSE,
            source: throwaway.nodeId,
            destination: victim.nodeId,
            payload: { entries: [metadata] },
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    expect(victim.remoteCatalog.has(legitMetadata.contentId)).toBe(true);
    expect(victim.remoteCatalog.size).toBe(2); // the trusted entry plus only the *last* throwaway
  });

  /**
   * A route carries no signature of its own — unlike PeerDirectory/RemoteCatalog entries above, a
   * ROUTE_ANNOUNCE claim is trusted purely based on which connected peer sent it (its `nextHop`).
   * Found in a full code-review pass: RoutingTable previously had no trustRank at all, so a
   * freshly-connected, untrusted peer could evict a genuinely-trusted neighbor's route just by
   * announcing enough fabricated destinations — this confirms the fix (node.ts wires
   * `trustRank: (nextHop) => trustRank(trust.get(nextHop))` into the RoutingTable it constructs).
   */
  it("RoutingTable: keeps a trusted neighbor's route while evicting a fabricated one from an untrusted peer", async () => {
    victim = new NomadNode({ displayName: "victim", maxRoutingTableEntries: 2 });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    legit = new NomadNode({ displayName: "legit" });
    const legitTransport = new TcpTransport(legit.nodeId, 0);
    legit.addTransport(legitTransport);
    await legit.start();
    await legit.connect({ host: "127.0.0.1", port: victimTransport.port });
    await victim.waitForPeerKey(legit.nodeId, { timeoutMs: 2000 });
    // Connecting already gave legit a direct route (routingTable.offer(peerId, peerId, 1),
    // node.ts) — an operator now vouches for this specific device (spec §54).
    victim.trust.set(legit.nodeId, TrustLevel.TRUSTED);
    expect(victim.routingTable.has(legit.nodeId)).toBe(true);

    const attackerId = "9".repeat(64);
    attackerSocket = await connectAttacker(victimTransport.port, attackerId);
    // Connecting also gave the attacker its own direct route — untrusted (default TrustLevel),
    // filling the table to its cap of 2 alongside legit's.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(victim.routingTable.size).toBe(2);

    attackerSocket.write(
      encodePacket(
        createPacket({
          type: MessageType.ROUTE_ANNOUNCE,
          source: attackerId,
          payload: { routes: [{ destination: "fabricated-destination", cost: 1 }] },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(victim.routingTable.has(legit.nodeId)).toBe(true);
    expect(victim.routingTable.has("fabricated-destination")).toBe(true);
    expect(victim.routingTable.has(attackerId)).toBe(false); // the attacker's own low-trust entry was evicted, not legit's
    expect(victim.routingTable.size).toBe(2);
  });
});

/**
 * MAX_ROUTES_PER_ANNOUNCE (node.ts) bounds how many entries a *single* ROUTE_ANNOUNCE packet may
 * affect — defense-in-depth alongside the trust-weighted eviction above, since even a trust-ranked
 * table could still have a large amount of CPU/memory spent processing one oversized packet before
 * eviction ever gets a say. maxRoutingTableEntries is set generously above what a single packet
 * could ever fill on its own, so any cap on the resulting size is attributable to the packet-level
 * cap specifically, not table capacity.
 */
describe("ROUTE_ANNOUNCE per-packet cap", () => {
  let victim: NomadNode | undefined;
  let attackerSocket: Socket | undefined;

  afterEach(async () => {
    attackerSocket?.destroy();
    if (victim) await victim.stop();
    victim = undefined;
    attackerSocket = undefined;
  });

  it("processes at most MAX_ROUTES_PER_ANNOUNCE entries from a single oversized packet", async () => {
    victim = new NomadNode({ displayName: "victim", maxRoutingTableEntries: 100_000 });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    const attackerId = "9".repeat(64);
    attackerSocket = await connectAttacker(victimTransport.port, attackerId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const sizeBeforeFlood = victim.routingTable.size; // just the attacker's own direct route

    const routes = Array.from({ length: 600 }, (_, i) => ({ destination: `fabricated-${i}`, cost: 1 }));
    attackerSocket.write(encodePacket(createPacket({ type: MessageType.ROUTE_ANNOUNCE, source: attackerId, payload: { routes } })));
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 600 fabricated destinations were offered, but at most 512 (MAX_ROUTES_PER_ANNOUNCE) of them
    // should have actually reached routingTable.offer() — the rest silently dropped, not queued.
    expect(victim.routingTable.size - sizeBeforeFlood).toBeLessThanOrEqual(512);
    expect(victim.routingTable.size - sizeBeforeFlood).toBeGreaterThan(0); // sanity: the cap isn't just rejecting everything
  });
});
