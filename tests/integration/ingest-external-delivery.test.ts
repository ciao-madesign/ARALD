import { afterEach, describe, expect, it } from "vitest";
import { NomadNode, type NomadNodeOptions } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { EncryptionIdentity } from "../../node/src/encryption.js";
import { sealExternalDelivery, computeExternalDeliveryAuthProof, type ExternalDeliveryAllowlist } from "../../node/src/external-delivery.js";

/**
 * `NomadNode.ingestExternalDelivery()` — "Pezzo 3" del canale di comando
 * Box↔specchio (`docs/emergency-portal.md`, `docs/security.md` voce #84):
 * accetta una consegna esterna già sigillata composta dal portale, senza
 * alcuna firma Ed25519 — a differenza di `ingestSignedNodeAppend()`/
 * `ingestSignedRelayCommand()` (Pezzo 2/4), questo canale riusa
 * esattamente la stessa validazione (`extractExternalDeliveryPayload()`/
 * `verifyExternalDeliveryAuthProof()`) del percorso mesh reale
 * (`handleExternalDelivery()`), che a sua volta non controlla mai
 * l'identità del mittente. Le proprietà da verificare qui: il Box verifica
 * `destinationId` contro la propria allowlist privata (mai fidandosi del
 * chiamante), il rate limiting è per-`destinationId` (non per-identità,
 * dato che non esiste un'identità su questo canale), e una destinationId
 * sconosciuta non consuma mai il budget di una destinazione reale.
 */

function makeNode(displayName: string, extraOptions: Partial<NomadNodeOptions> = {}): NomadNode {
  const node = new NomadNode({ displayName, ...extraOptions });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return node;
}

describe("NomadNode.ingestExternalDelivery (Pezzo 3, canale di comando)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  function allowlistWith(destinationId: string, destination: EncryptionIdentity, password?: string): ExternalDeliveryAllowlist {
    return new Map([[destinationId, { destinationId, label: "Headquarter", publicKeyHex: destination.publicKeyHex, url: "http://127.0.0.1:1/unused", password }]]);
  }

  it("accepts a valid password-less submission, enqueues it, and emits external-delivery:queued", async () => {
    const destination = EncryptionIdentity.generate();
    const box = makeNode("Box", { externalDeliveryAllowlist: allowlistWith("hq-1", destination) });
    nodes.push(box);
    await box.start();

    const sealed = sealExternalDelivery(destination.publicKeyHex, Buffer.from("report dal campo"));
    const submission = { destinationId: "hq-1", ...sealed, submittedAt: Date.now() };
    const queued: string[] = [];
    box.on("external-delivery:queued", (id: string) => queued.push(id));

    expect(box.ingestExternalDelivery(submission)).toBe("accepted");
    expect(box.externalDeliveryQueue.size).toBe(1);
    expect(queued).toHaveLength(1);
  });

  it("no-ops (rejected) when this node has no externalDeliveryAllowlist configured at all — the role is off", async () => {
    const box = makeNode("Box");
    nodes.push(box);
    await box.start();

    const destination = EncryptionIdentity.generate();
    const sealed = sealExternalDelivery(destination.publicKeyHex, Buffer.from("dati"));
    expect(box.ingestExternalDelivery({ destinationId: "hq-1", ...sealed, submittedAt: Date.now() })).toBe("rejected");
    expect(box.externalDeliveryQueue.size).toBe(0);
  });

  it("rejects a destinationId not present in this Box's own private allowlist", async () => {
    const destination = EncryptionIdentity.generate();
    const box = makeNode("Box", { externalDeliveryAllowlist: allowlistWith("hq-1", destination) });
    nodes.push(box);
    await box.start();

    const sealed = sealExternalDelivery(destination.publicKeyHex, Buffer.from("dati"));
    expect(box.ingestExternalDelivery({ destinationId: "unknown-destination", ...sealed, submittedAt: Date.now() })).toBe("rejected");
    expect(box.externalDeliveryQueue.size).toBe(0);
  });

  it("ignores unknown/malformed input without throwing", async () => {
    const destination = EncryptionIdentity.generate();
    const box = makeNode("Box", { externalDeliveryAllowlist: allowlistWith("hq-1", destination) });
    nodes.push(box);
    await box.start();

    expect(box.ingestExternalDelivery(undefined)).toBe("rejected");
    expect(box.ingestExternalDelivery(null)).toBe("rejected");
    expect(box.ingestExternalDelivery({})).toBe("rejected");
    expect(box.ingestExternalDelivery("not an object")).toBe("rejected");
    expect(box.externalDeliveryQueue.size).toBe(0);
  });

  it("rejects a password-protected destination with no proof or the wrong one, but accepts it with the correct proof", async () => {
    const destination = EncryptionIdentity.generate();
    const box = makeNode("Box", { externalDeliveryAllowlist: allowlistWith("ong-1", destination, "s3gr3t0-canale") });
    nodes.push(box);
    await box.start();

    const sealedNoProof = sealExternalDelivery(destination.publicKeyHex, Buffer.from("no password"));
    expect(box.ingestExternalDelivery({ destinationId: "ong-1", ...sealedNoProof, submittedAt: Date.now() })).toBe("rejected");

    const sealedWrong = sealExternalDelivery(destination.publicKeyHex, Buffer.from("wrong password"));
    const wrongProof = computeExternalDeliveryAuthProof("not-the-password", "ong-1", sealedWrong.nonce, sealedWrong.ciphertext, sealedWrong.authTag);
    expect(box.ingestExternalDelivery({ destinationId: "ong-1", ...sealedWrong, authProof: wrongProof, submittedAt: Date.now() })).toBe("rejected");

    const sealedCorrect = sealExternalDelivery(destination.publicKeyHex, Buffer.from("correct password"));
    const correctProof = computeExternalDeliveryAuthProof("s3gr3t0-canale", "ong-1", sealedCorrect.nonce, sealedCorrect.ciphertext, sealedCorrect.authTag);
    expect(box.ingestExternalDelivery({ destinationId: "ong-1", ...sealedCorrect, authProof: correctProof, submittedAt: Date.now() })).toBe("accepted");
    expect(box.externalDeliveryQueue.size).toBe(1);
  });

  /**
   * `this.ingestRateLimiter.allow(parsed.destinationId)` — deliberatamente per-`destinationId`, non
   * per-identità come gli altri tre `ingest*()` (`ingestExternalDelivery()`'s own doc comment):
   * questo canale non ha un'identità su cui chiavare. `maxPacketsPerWindow` piccolo qui solo per
   * rendere il test pratico da eseguire, non un valore realistico di produzione.
   */
  it("throttles by destinationId once ingestRateLimiter's own budget is exhausted", async () => {
    const destination = EncryptionIdentity.generate();
    const box = makeNode("Box", {
      externalDeliveryAllowlist: allowlistWith("hq-1", destination),
      maxPacketsPerWindow: 2,
      rateLimitWindowMs: 60_000,
    });
    nodes.push(box);
    await box.start();

    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sealed = sealExternalDelivery(destination.publicKeyHex, Buffer.from(`dati ${i}`));
      results.push(box.ingestExternalDelivery({ destinationId: "hq-1", ...sealed, submittedAt: Date.now() }));
    }

    expect(results.slice(0, 2)).toEqual(["accepted", "accepted"]);
    expect(results[2]).toBe("rate-limited");
  });

  it("regression: spamming an unknown destinationId never consumes a real destination's own rate-limit budget", async () => {
    const destination = EncryptionIdentity.generate();
    const box = makeNode("Box", {
      externalDeliveryAllowlist: allowlistWith("hq-1", destination),
      maxPacketsPerWindow: 2,
      rateLimitWindowMs: 60_000,
    });
    nodes.push(box);
    await box.start();

    // Destination lookup happens BEFORE the rate-limit consult (ingestExternalDelivery()'s own doc
    // comment) — an unknown destinationId is rejected without ever touching ingestRateLimiter's
    // bounded state, so it must never be able to exhaust a real destination's own budget.
    for (let i = 0; i < 10; i++) {
      const sealed = sealExternalDelivery(destination.publicKeyHex, Buffer.from(`dati ${i}`));
      expect(box.ingestExternalDelivery({ destinationId: "unknown", ...sealed, submittedAt: Date.now() })).toBe("rejected");
    }

    const sealed = sealExternalDelivery(destination.publicKeyHex, Buffer.from("dati reali"));
    expect(box.ingestExternalDelivery({ destinationId: "hq-1", ...sealed, submittedAt: Date.now() })).toBe("accepted");
  });

  /**
   * `MAX_HTTP_INGESTED_EXTERNAL_DELIVERIES_PER_WINDOW` (`node.ts`) — found by code review
   * (`docs/security.md` voce #84): the per-`destinationId` `ingestRateLimiter` budget alone left a
   * gap, since `RateLimiter`'s default window is far larger than `externalDeliveryQueue`'s own
   * default entry-count cap — a burst against a single allowed, password-less destination could
   * exhaust the *entire shared queue* before its own per-destination budget ran out. This node-wide
   * budget is the actual fix; `maxPacketsPerWindow` is set generously high here so only the
   * dedicated node-wide budget (fixed at 20/5min, not configurable via options) is what throttles.
   */
  it("throttles node-wide across every destinationId, once MAX_HTTP_INGESTED_EXTERNAL_DELIVERIES_PER_WINDOW is exhausted", async () => {
    const destinationA = EncryptionIdentity.generate();
    const destinationB = EncryptionIdentity.generate();
    const allowlist: ExternalDeliveryAllowlist = new Map([
      ["hq-a", { destinationId: "hq-a", label: "A", publicKeyHex: destinationA.publicKeyHex, url: "http://127.0.0.1:1/unused" }],
      ["hq-b", { destinationId: "hq-b", label: "B", publicKeyHex: destinationB.publicKeyHex, url: "http://127.0.0.1:1/unused" }],
    ]);
    const box = makeNode("Box", { externalDeliveryAllowlist: allowlist, maxPacketsPerWindow: 10_000, rateLimitWindowMs: 60_000 });
    nodes.push(box);
    await box.start();

    const results: string[] = [];
    for (let i = 0; i < 21; i++) {
      // Alternate destinations — a per-destination budget alone would never throttle this.
      const destination = i % 2 === 0 ? destinationA : destinationB;
      const destinationId = i % 2 === 0 ? "hq-a" : "hq-b";
      const sealed = sealExternalDelivery(destination.publicKeyHex, Buffer.from(`dati ${i}`));
      results.push(box.ingestExternalDelivery({ destinationId, ...sealed, submittedAt: Date.now() }));
    }

    expect(results.slice(0, 20).every((r) => r === "accepted")).toBe(true);
    expect(results[20]).toBe("rate-limited");
  });

  /**
   * Regression found by code review (`docs/security.md` voce #84): a retried HTTP-ingest delivery
   * (`arald-backend/command-poller.ts` resubmits an identical `pending` command's stored bytes
   * verbatim on the next tick after any non-terminal outcome, e.g. a transport failure) must not
   * queue — and later actually deliver to the real external organization — a second, indistinguishable
   * copy of the exact same submission.
   */
  it("regression: an identical retried submission (same nonce/ciphertext/authTag) is deduplicated, never queued twice", async () => {
    const destination = EncryptionIdentity.generate();
    const box = makeNode("Box", { externalDeliveryAllowlist: allowlistWith("hq-1", destination) });
    nodes.push(box);
    await box.start();

    const submission = { destinationId: "hq-1", ...sealExternalDelivery(destination.publicKeyHex, Buffer.from("report")), submittedAt: Date.now() };

    expect(box.ingestExternalDelivery(submission)).toBe("accepted");
    expect(box.externalDeliveryQueue.size).toBe(1);

    // The exact same bytes, resubmitted (simulating command-poller's own retry-on-transport-failure) —
    // must be a no-op, not a second queue entry.
    expect(box.ingestExternalDelivery(submission)).toBe("accepted"); // ingestExternalDelivery() itself still reports "accepted" (all validation re-passes) — enqueue()'s own dedup is what actually prevents the duplicate
    expect(box.externalDeliveryQueue.size).toBe(1);
  });

  it("does not enqueue anything for a rejected (unknown destinationId / malformed) submission", async () => {
    const destination = EncryptionIdentity.generate();
    const box = makeNode("Box", { externalDeliveryAllowlist: allowlistWith("hq-1", destination) });
    nodes.push(box);
    await box.start();

    const queued: string[] = [];
    box.on("external-delivery:queued", (id: string) => queued.push(id));

    const sealed = sealExternalDelivery(destination.publicKeyHex, Buffer.from("dati"));
    box.ingestExternalDelivery({ destinationId: "unknown", ...sealed, submittedAt: Date.now() });
    box.ingestExternalDelivery({});

    expect(box.externalDeliveryQueue.size).toBe(0);
    expect(queued).toEqual([]);
  });
});
