import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, Priority, createPacket, encodePacket } from "../../node/src/packet.js";
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
   * ContentStore now bounds itself the same way RemoteCatalog/PeerDirectory/RoutingTable already
   * do (found in a code-review pass: it was the one network-fed store in the codebase still a
   * plain, unbounded Map). Its eviction score has an extra wrinkle the others don't: a node never
   * records trust for its *own* node id in its own TrustManager, so without special-casing it,
   * this node's own published content would rank at the same UNKNOWN trust as any throwaway
   * publisher and could be evicted from a full store just as readily (node.ts's
   * OWN_CONTENT_TRUST_RANK). This drives eviction via the passive relay-caching path
   * (`observeRelayedContent`) rather than a real content request, since that's the simplest way to
   * get attacker-controlled content into a victim's store without a matching pendingContentRequests
   * entry — a packet addressed to neither the victim nor the attacker is relayed-through, not
   * delivered, which is exactly the condition that path caches under (spec §27).
   */
  it("ContentStore: keeps this node's own published content while evicting throwaway-publisher content", async () => {
    victim = new NomadNode({ displayName: "victim", maxContentStoreEntries: 2 });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    const ownData = Buffer.from("mappa ufficiale del rifugio (pubblicata localmente)");
    const ownMetadata = victim.publishContent("mappa.txt", "text/plain", ownData);

    attackerSocket = await connectAttacker(victimTransport.port, "7".repeat(64));
    const relayDestination = "3".repeat(64); // neither victim nor attacker — makes the packet relay-only, not delivered

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
            type: MessageType.CONTENT_CHUNK,
            source: throwaway.nodeId,
            destination: relayDestination,
            payload: { contentId: metadata.contentId, chunkIndex: 0, totalChunks: 1, data: data.toString("base64") },
          }),
        ),
      );
      attackerSocket.write(
        encodePacket(
          createPacket({
            type: MessageType.CONTENT_COMPLETE,
            source: throwaway.nodeId,
            destination: relayDestination,
            payload: { contentId: metadata.contentId, metadata },
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    expect(victim.contentStore.has(ownMetadata.contentId)).toBe(true);
    expect(victim.contentStore.size).toBe(2); // own content plus only the *last* throwaway
  });

  /**
   * The gap left open by docs/security.md voce #120 ("Nessun TTL wall-clock per Priority.EMERGENCY
   * in PendingDeliveryQueue"): that fix only ever covered unicast traffic through
   * PendingDeliveryQueue. A real Emergency Beacon travels as a broadcast CONTENT_ANNOUNCE, cached
   * directly into ContentStore (handleContentAnnounce's inline-data path, node.ts) — and until this
   * fix, ContentStore's eviction was purely trust-based, so a Beacon sighting (always from a
   * never-seen-before identity by design, emergency-beacon.ts has no trustRank of its own) was the
   * first candidate evicted from a relay already busy caching other peers' routine content,
   * regardless of how urgent the SOS itself was. This exercises the real end-to-end path —
   * NomadNode.sendEmergencyBeacon() -> real CONTENT_ANNOUNCE with inline data -> a connected
   * relay's ContentStore.putVerified() — not a hand-built metadata object, proving the fix actually
   * reaches production code, not just ContentStore's own unit tests (tests/unit/content.test.ts).
   */
  it("ContentStore: a real Emergency Beacon sighting from a never-seen-before identity survives eviction over routine content already cached from other throwaway publishers", async () => {
    victim = new NomadNode({ displayName: "victim", maxContentStoreEntries: 2 });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    // Fill the store to capacity with two ordinary (default-priority) pieces of content from two
    // different throwaway publishers — same passive relay-caching technique as the test above,
    // establishing the "busy relay" precondition the gap was about.
    attackerSocket = await connectAttacker(victimTransport.port, "7".repeat(64));
    const relayDestination = "3".repeat(64); // neither victim nor attacker — relay-only, not delivered
    for (let i = 0; i < 2; i++) {
      const throwaway = Identity.generate();
      const data = Buffer.from(`routine content ${i}`);
      const fields = {
        contentId: computeContentId(data),
        name: `routine-${i}.txt`,
        mimeType: "text/plain",
        size: data.length,
        publisherId: throwaway.nodeId,
      };
      const metadata = { ...fields, createdAt: Date.now(), signature: throwaway.sign(contentSigningPayload(fields)).toString("hex") };
      attackerSocket.write(
        encodePacket(
          createPacket({
            type: MessageType.CONTENT_CHUNK,
            source: throwaway.nodeId,
            destination: relayDestination,
            payload: { contentId: metadata.contentId, chunkIndex: 0, totalChunks: 1, data: data.toString("base64") },
          }),
        ),
      );
      attackerSocket.write(
        encodePacket(
          createPacket({
            type: MessageType.CONTENT_COMPLETE,
            source: throwaway.nodeId,
            destination: relayDestination,
            payload: { contentId: metadata.contentId, metadata },
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    expect(victim.contentStore.size).toBe(2);

    // A genuine SOS now arrives from a connected peer the victim has never heard of before —
    // exactly the "throwaway identity" case emergency-beacon.ts expects as the norm.
    legit = new NomadNode({ displayName: "beacon" });
    const beaconTransport = new TcpTransport(legit.nodeId, 0);
    legit.addTransport(beaconTransport);
    await legit.start();
    await legit.connect({ host: "127.0.0.1", port: victimTransport.port });

    const sighting = legit.sendEmergencyBeacon({ message: "SOS da un'identità mai vista prima", lat: 46.0, lon: 10.0 });

    await new Promise((resolve) => {
      const check = (): void => {
        if (victim!.contentStore.has(sighting.beaconContentId)) resolve(undefined);
        else setTimeout(check, 15);
      };
      check();
    });

    expect(victim.contentStore.has(sighting.beaconContentId)).toBe(true);
    expect(victim.contentStore.get(sighting.beaconContentId)?.metadata.priority).toBe(Priority.EMERGENCY);
    expect(victim.contentStore.size).toBe(2); // the beacon plus only one of the two routine entries
  });

  /**
   * Regression for a bypass found by a later code-review pass on `MAX_UNVETTED_ELEVATED_ENTRIES`
   * (`content.ts`): the budget's original "unvetted" threshold was `trustRank <= 0` (strictly
   * `TrustLevel.UNKNOWN`) — but `NomadNode` promotes a publisher past UNKNOWN automatically and for
   * free in two ways that have nothing to do with operator trust: merely connecting marks it `SEEN`
   * (`addTransport()`'s `onPeerConnected`, keyed on the never-authenticated `packet.source`), and any
   * syntactically-valid self-signature marks it `VERIFIED` (`acceptCatalogEntry()`, which runs
   * *before* `ContentStore.putVerified()` for a `CONTENT_ANNOUNCE`). A directly-connected attacker
   * self-publishing its own content — exactly `sendEmergencyBeacon()`'s own realistic shape, unlike
   * the earlier relay-caching tests above which never connect as the content's own publisher — would
   * reach `VERIFIED` before the budget ever got a chance to see it as "unvetted", bypassing the cap
   * entirely. Fixed by raising the ceiling to cover everything up to (and including) `VERIFIED` —
   * only `TRUSTED`/`ADMIN` (genuine operator action, spec §54) are exempt.
   */
  it("ContentStore: the MAX_UNVETTED_ELEVATED_ENTRIES budget still engages for a single already-connected throwaway identity self-publishing its own flood of EMERGENCY-tagged content — not just the UNKNOWN-trust relay-caching case above", async () => {
    victim = new NomadNode({ displayName: "victim", maxContentStoreEntries: 11 });
    const victimTransport = new TcpTransport(victim.nodeId, 0);
    victim.addTransport(victimTransport);
    await victim.start();

    const trustedEntries = Array.from({ length: 11 }, (_, i) => victim.publishContent(`mappa-${i}.txt`, "text/plain", Buffer.from(`mappa ufficiale ${i}`)));
    expect(victim.contentStore.size).toBe(11);

    // One throwaway identity connects (-> trust.markSeen(), TrustLevel.SEEN) and then self-signs 11
    // distinct pieces of EMERGENCY-tagged junk via ordinary CONTENT_ANNOUNCE packets (-> each one
    // additionally runs through acceptCatalogEntry()'s trust.markVerified(), TrustLevel.VERIFIED) —
    // far more than the budget (8), from a single already-"vetted-by-the-cheap-path" identity.
    const attacker = Identity.generate();
    attackerSocket = await connectAttacker(victimTransport.port, attacker.nodeId);

    for (let i = 0; i < 11; i++) {
      const data = Buffer.from(`attack payload ${i}`);
      const fields = {
        contentId: computeContentId(data),
        name: `attack-${i}.json`,
        mimeType: "application/json",
        size: data.length,
        publisherId: attacker.nodeId,
        priority: Priority.EMERGENCY,
      };
      const metadata = { ...fields, createdAt: Date.now(), signature: attacker.sign(contentSigningPayload(fields)).toString("hex") };
      attackerSocket.write(
        encodePacket(
          createPacket({
            type: MessageType.CONTENT_ANNOUNCE,
            source: attacker.nodeId,
            payload: { metadata, data: data.toString("base64") },
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    // Same bound as the pure-unit-test version of this scenario (tests/unit/content.test.ts): at
    // most cap+1 = 9 trusted entries ever lost, never all 11 — proving the budget actually engages
    // against a directly-connected, self-publishing attacker, not just the never-connected
    // third-party-publisherId relay-caching shape the test above already covered.
    const survivingTrusted = trustedEntries.filter((m) => victim!.contentStore.has(m.contentId));
    expect(survivingTrusted.length).toBeGreaterThanOrEqual(11 - 9);
    expect(survivingTrusted.length).toBeLessThan(11); // sanity: the flood did cost *something*, this isn't a no-op
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
