import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode, type IngestSignedContentResult, type NomadNodeOptions } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { Identity } from "../../node/src/identity.js";
import { TrustLevel } from "../../node/src/trust.js";
import { nodeAppendSigningPayload, type SignableNodeAppendFields } from "../../node/src/node-appends.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";

/**
 * `NomadNode.ingestSignedNodeAppend()` — "Pezzo 2" del canale di comando
 * Box↔specchio (docs/emergency-portal.md, docs/security.md voce #82):
 * accetta un Node Append firmato da un'identità DIVERSA da quella del Box
 * (nel caso reale, l'identità mesh dedicata di un operatore del portale),
 * senza mai passare dal canale ECDH `PRIVATE_MESSAGE`. Stesso spirito di
 * `ingest-signed-content.test.ts` (Pezzo 1): la proprietà da verificare non
 * è "un Node Append viene registrato" (già coperto da `node-append.test.ts`
 * per il percorso mesh reale), ma che il Box verifichi indipendentemente,
 * mai fidandosi del chiamante HTTP.
 */

function makeNode(displayName: string, extraOptions: Partial<NomadNodeOptions> = {}): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName, ...extraOptions });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

function signAppend(identity: Identity, box: NomadNode, overrides: Partial<SignableNodeAppendFields> = {}): SignableNodeAppendFields & { signature: string } {
  const fields: SignableNodeAppendFields = {
    text: "Materiale da recuperare al prossimo turno",
    kind: "info",
    timestamp: Date.now(),
    expiresAt: Date.now() + 100000,
    targetNodeId: box.nodeId,
    publisherId: identity.nodeId,
    ...overrides,
  };
  const signature = identity.sign(nodeAppendSigningPayload(fields)).toString("hex");
  return { ...fields, signature };
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

describe("NomadNode.ingestSignedNodeAppend (Pezzo 2, canale di comando)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("accepts an append signed by a foreign identity, recorded with the operator as author, never the Box's own", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const submission = signAppend(operator, box.node);

    expect(box.node.ingestSignedNodeAppend(submission)).toBe("accepted");

    const recorded = box.node.nodeAppends.list();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].text).toBe(submission.text);
    expect(recorded[0].author).toBe(operator.nodeId);
    expect(recorded[0].author).not.toBe(box.node.nodeId);
    expect(recorded[0].appendId).toBe(submission.signature); // reused as the natural idempotency key
  });

  it("rejects a submission whose fields were tampered after signing — the Box never trusts the caller, only re-verifies independently", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const submission = signAppend(operator, box.node);

    expect(box.node.ingestSignedNodeAppend({ ...submission, text: "testo diverso da quanto firmato" })).toBe("rejected");
    expect(box.node.nodeAppends.list()).toEqual([]);
  });

  it("rejects a signature claiming an identity that never actually signed it", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const realOperator = Identity.generate();
    const impersonated = Identity.generate();
    const submission = signAppend(realOperator, box.node);
    const forged = { ...submission, publisherId: impersonated.nodeId };

    expect(box.node.ingestSignedNodeAppend(forged)).toBe("rejected");
    expect(box.node.nodeAppends.list()).toEqual([]);
  });

  it("rejects a submission signed for a different target node — binding targetNodeId prevents cross-Box replay", async () => {
    const box = makeNode("Box");
    const otherBox = makeNode("OtherBox");
    nodes.push(box.node, otherBox.node);
    await Promise.all([box.node.start(), otherBox.node.start()]);

    const operator = Identity.generate();
    const submissionForOtherBox = signAppend(operator, otherBox.node);

    expect(box.node.ingestSignedNodeAppend(submissionForOtherBox)).toBe("rejected");
    expect(box.node.nodeAppends.list()).toEqual([]);
  });

  it("rejects an already-expired append", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const submission = signAppend(operator, box.node, { expiresAt: Date.now() - 1000 });

    expect(box.node.ingestSignedNodeAppend(submission)).toBe("rejected");
  });

  it("never consults this.trust — the authenticated HTTP channel (network password + portal-side authorization) is the trust boundary, not minTrustForNodeAppend", async () => {
    // Default minTrustForNodeAppend is TrustLevel.VERIFIED — a never-before-seen identity would be
    // rejected by considerNodeAppend() (the real-mesh path), but ingestSignedNodeAppend() must not
    // apply the same gate (see that method's own doc comment for why).
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const neverSeenBefore = Identity.generate();
    expect(box.node.trust.get(neverSeenBefore.nodeId)).toBe("UNKNOWN"); // below VERIFIED — considerNodeAppend() (the real-mesh path) would reject this
    const submission = signAppend(neverSeenBefore, box.node);

    expect(box.node.ingestSignedNodeAppend(submission)).toBe("accepted");
  });

  it("ignores unknown/malformed input without throwing", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    expect(box.node.ingestSignedNodeAppend(undefined)).toBe("rejected");
    expect(box.node.ingestSignedNodeAppend(null)).toBe("rejected");
    expect(box.node.ingestSignedNodeAppend({})).toBe("rejected");
    expect(box.node.ingestSignedNodeAppend("not an object")).toBe("rejected");
  });

  /**
   * Regression per la stessa classe di problema trovata dalla revisione per `ingestSignedContent()`
   * (`docs/security.md` voce #81, punto 1), applicata proattivamente qui: senza il gate su
   * `this.rateLimiter`, una chiamata HTTP autenticata poteva sommergere il Box senza alcun budget.
   */
  it("a single operator identity is throttled by the same per-identity packet budget a real mesh peer would get", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const results: IngestSignedContentResult[] = [];
    for (let i = 0; i < 210; i++) {
      const submission = signAppend(operator, box.node, { text: `nota ${i}` });
      results.push(box.node.ingestSignedNodeAppend(submission));
    }

    expect(results).toContain("rate-limited");
    expect(results.filter((r) => r === "accepted").length).toBeLessThan(210);
  });

  /**
   * Same node-wide elevated budget `appendToNode()` itself uses (`tryConsumeElevatedNodeAppendBudget()`,
   * extracted from `appendToNode()`'s own inline block for exactly this sharing, "Pezzo 2").
   */
  it("an elevated-kind (hazard/emergency) append consumes the shared node-wide elevated-node-append budget, and is rate-limited once exhausted", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const results: IngestSignedContentResult[] = [];
    for (let i = 0; i < 4; i++) {
      const operator = Identity.generate(); // a different identity each time — never the per-identity budget
      const submission = signAppend(operator, box.node, { kind: "emergency", text: `allerta ${i}` });
      results.push(box.node.ingestSignedNodeAppend(submission));
    }

    // MAX_ELEVATED_NODE_APPENDS_PER_WINDOW is 3 — the 4th distinct-identity emergency append must
    // still be throttled by the shared, node-wide budget, not admitted just because it's a fresh identity.
    expect(results.slice(0, 3)).toEqual(["accepted", "accepted", "accepted"]);
    expect(results[3]).toBe("rate-limited");
  });

  it("an info-kind append never consumes the elevated budget, however many are submitted", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const results: IngestSignedContentResult[] = [];
    for (let i = 0; i < 5; i++) {
      const operator = Identity.generate();
      const submission = signAppend(operator, box.node, { kind: "info", text: `nota ${i}` });
      results.push(box.node.ingestSignedNodeAppend(submission));
    }

    expect(results).toEqual(["accepted", "accepted", "accepted", "accepted", "accepted"]);
  });

  it("resubmitting the exact same signed submission twice is idempotent — the second call is a no-op, not a duplicate entry", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const submission = signAppend(operator, box.node);

    expect(box.node.ingestSignedNodeAppend(submission)).toBe("accepted");
    expect(box.node.ingestSignedNodeAppend(submission)).toBe("accepted"); // still "accepted": re-verifies fine, record() itself no-ops
    expect(box.node.nodeAppends.list()).toHaveLength(1);
  });

  /**
   * Regression trovata dalla revisione (`docs/security.md` voce #82), stessa classe della fix
   * gemella in `ingest-signed-content.test.ts` (Pezzo 1, applicabile anche lì): prima del fix,
   * questo metodo usava `this.rateLimiter` — la STESSA istanza di `handlePacket()`'s own budget
   * per i peer mesh reali connessi — così un chiamante HTTP poteva dichiarare `publisherId` uguale
   * al `nodeId` di un vero peer e bruciarne il budget con submission mai verificate.
   */
  it("ingesting garbage claiming a real connected peer's nodeId as publisherId never burns that peer's OWN packet budget", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const realPeerId = "7".repeat(64);
    const socket: Socket = createConnection({ host: "127.0.0.1", port: box.transport.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: realPeerId, payload: {} })));
    await waitFor(() => box.node.peers.has(realPeerId));

    let exceeded = 0;
    box.node.on("rate-limit:exceeded", (peerId: string) => {
      if (peerId === realPeerId) exceeded++;
    });

    const operator = Identity.generate();
    for (let i = 0; i < 250; i++) {
      const submission = signAppend(operator, box.node, { text: `nota ${i}` });
      box.node.ingestSignedNodeAppend({ ...submission, publisherId: realPeerId }); // signature now invalid — expected to reject, not the point of this test
    }

    for (let i = 0; i < 20; i++) {
      socket.write(encodePacket(createPacket({ type: MessageType.PING, source: realPeerId, payload: {} })));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(exceeded).toBe(0);
    socket.destroy();
  });

  /**
   * `MAX_HTTP_INGESTED_NODE_APPENDS_PER_WINDOW` (`node.ts`) — trovato necessario dalla revisione
   * (`docs/security.md` voce #82): il budget per-identità da solo non basta contro un burst di
   * MOLTE identità distinte, ciascuna usata una sola volta — questo budget è node-wide e si applica
   * a OGNI submission accettata via questo canale HTTP, indipendentemente dal `kind`.
   */
  /**
   * Regression trovata da un secondo giro di revisione (`docs/security.md` voce #82): prima del
   * fix, il budget CONDIVISO `tryConsumeElevatedNodeAppendBudget()` veniva consumato PRIMA del
   * budget dedicato `tryConsumeHttpIngestedNodeAppendBudget()` — una submission già condannata a
   * fallire per quest'ultimo bruciava comunque irrevocabilmente uno slot del budget condiviso con
   * `appendToNode()`'s own real mesh emergency traffic, per nulla. Verificato qui esaurendo prima
   * il budget HTTP-ingest con 20 submission "info" da identità distinte, poi confermando che il
   * budget elevated (condiviso) resta INTATTO — un vero mittente mesh può ancora inviare 3 append
   * "emergency" reali via `appendToNode()`.
   */
  it("exhausting the HTTP-ingest budget never wastes the shared elevated-node-append budget — a real mesh sender can still send emergency appends afterward", async () => {
    const sender = makeNode("Sender");
    const box = makeNode("Box");
    nodes.push(sender.node, box.node);
    await Promise.all([sender.node.start(), box.node.start()]);
    await sender.node.connect({ host: "127.0.0.1", port: box.transport.port });
    await Promise.all([sender.node.waitForPeerKey(box.node.nodeId), box.node.waitForPeerKey(sender.node.nodeId)]);

    // Exhaust the 20/5min HTTP-ingest budget with cheap "info" submissions from distinct identities.
    for (let i = 0; i < 20; i++) {
      const operator = Identity.generate();
      const submission = signAppend(operator, box.node, { kind: "info", text: `nota ${i}` });
      expect(box.node.ingestSignedNodeAppend(submission)).toBe("accepted");
    }
    // A 21st, even an "emergency"-kind one from a fresh identity, is now rejected by the HTTP-ingest
    // budget — the whole point is that this must NEVER touch the shared elevated budget.
    const wouldBeElevated = Identity.generate();
    expect(box.node.ingestSignedNodeAppend(signAppend(wouldBeElevated, box.node, { kind: "emergency" }))).toBe("rate-limited");

    // A real mesh sender (already VERIFIED via ordinary identity gossip on connect, same as
    // node-append.test.ts) must still be able to send all 3 of MAX_ELEVATED_NODE_APPENDS_PER_WINDOW's
    // worth of real emergency appends — proof the shared budget was never touched by the above.
    for (let i = 0; i < 3; i++) {
      expect(() => sender.node.appendToNode(box.node.nodeId, { text: `allerta reale ${i}`, kind: "emergency" })).not.toThrow();
    }
  });

  it("throttles the total number of HTTP-ingested appends node-wide, across many distinct identities, regardless of kind", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const results: IngestSignedContentResult[] = [];
    for (let i = 0; i < 25; i++) {
      const operator = Identity.generate(); // a different identity every time — the per-identity budget never engages
      const submission = signAppend(operator, box.node, { kind: "info", text: `nota ${i}` });
      results.push(box.node.ingestSignedNodeAppend(submission));
    }

    // MAX_HTTP_INGESTED_NODE_APPENDS_PER_WINDOW is 20 — the 21st distinct-identity submission must
    // still be throttled by the shared, node-wide HTTP-ingest budget.
    expect(results.slice(0, 20)).toEqual(new Array(20).fill("accepted"));
    expect(results[20]).toBe("rate-limited");
  });

  /**
   * `NodeAppends`' `trustRank` wiring (`node-appends.ts`, `node.ts`'s constructor) — trovato
   * necessario dalla revisione (`docs/security.md` voce #82): senza di esso, una singola submission
   * di un'identità mesh già VERIFIED (via il percorso mesh reale) poteva essere sfrattata da un
   * burst successivo di identità HTTP mai vagliate (`UNKNOWN`), sotto una FIFO piatta.
   */
  it("a mesh-sourced entry (real PRIVATE_MESSAGE path, sender already VERIFIED) is never evicted by a flood of HTTP-ingested (never-vetted) entries", async () => {
    const box = makeNode("Box", { maxNodeAppends: 3 });
    nodes.push(box.node);
    await box.node.start();

    const meshSender = Identity.generate();
    box.node.trust.set(meshSender.nodeId, TrustLevel.VERIFIED);
    // Record directly via the same private path considerNodeAppend() would take — simplest way to
    // get a real mesh-sourced, trust-gated entry into the store without wiring a full PRIVATE_MESSAGE
    // exchange between two nodes for this test.
    const meshSubmission = signAppend(meshSender, box.node, { text: "dal percorso mesh reale, già VERIFIED" });
    // Manually record with the mesh-path shape (appendId distinct from a signature, as a real
    // PRIVATE_MESSAGE-delivered append would have) so this test exercises the same trustRank
    // eviction NodeAppends applies regardless of which path an entry came from.
    box.node.nodeAppends.record({
      type: "node-append",
      text: meshSubmission.text,
      kind: meshSubmission.kind,
      timestamp: meshSubmission.timestamp,
      expiresAt: meshSubmission.expiresAt,
      appendId: "mesh-path-packet-id",
      author: meshSender.nodeId,
    });

    // Now flood with HTTP-ingested entries from fresh, never-vetted identities — more than enough to
    // exceed maxNodeAppends (3) several times over.
    for (let i = 0; i < 10; i++) {
      const attacker = Identity.generate();
      const submission = signAppend(attacker, box.node, { text: `flood ${i}` });
      expect(box.node.ingestSignedNodeAppend(submission)).toBe("accepted");
    }

    const remaining = box.node.nodeAppends.list();
    expect(remaining.some((a) => a.appendId === "mesh-path-packet-id")).toBe(true);
    expect(remaining.find((a) => a.appendId === "mesh-path-packet-id")?.author).toBe(meshSender.nodeId);
  });
});
