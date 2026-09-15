import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NomadNode, type IngestSignedContentResult, type NomadNodeOptions } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { Identity } from "../../node/src/identity.js";
import { TrustLevel } from "../../node/src/trust.js";
import { relayCommandSigningPayload, type SignableRelayCommandFields } from "../../node/src/relay-registry.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";

/**
 * `NomadNode.ingestSignedRelayCommand()` — "Pezzo 4" del canale di comando
 * Box↔specchio (docs/emergency-portal.md, docs/security.md voce #83):
 * accetta un comando di riavvio firmato da un'identità DIVERSA da quella
 * del Box, senza mai passare dal canale ECDH `PRIVATE_MESSAGE`, e
 * **deliberatamente senza consultare `this.trust`** — la decisione
 * discussa esplicitamente con l'utente di riusare lo stesso canale meno
 * vagliato di Pezzo 1/2 per questo comando, il più sensibile del
 * codebase. Le proprietà da verificare qui: il Box verifica indipendentemente
 * (mai fidandosi del chiamante HTTP), la protezione anti-replay è
 * CONDIVISA con il percorso mesh reale (`considerRelayCommand()`), e i due
 * budget (per-identità + node-wide) proteggono anche in assenza di un
 * gate di fiducia.
 */

function makeNode(displayName: string, extraOptions: Partial<NomadNodeOptions> = {}): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName, ...extraOptions });
  const transport = new TcpTransport(node.nodeId, 0);
  node.addTransport(transport);
  return { node, transport };
}

function signCommand(identity: Identity, box: NomadNode, overrides: Partial<SignableRelayCommandFields> = {}): SignableRelayCommandFields & { signature: string } {
  const fields: SignableRelayCommandFields = {
    command: "reboot",
    timestamp: Date.now(),
    targetNodeId: box.nodeId,
    publisherId: identity.nodeId,
    ...overrides,
  };
  const signature = identity.sign(relayCommandSigningPayload(fields)).toString("hex");
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

describe("NomadNode.ingestSignedRelayCommand (Pezzo 4, canale di comando)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("accepts a command signed by a foreign, never-vetted identity, and emits relay:reboot-requested with that identity as sender", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const submission = signCommand(operator, box.node);
    const requested: string[] = [];
    box.node.on("relay:reboot-requested", (senderId: string) => requested.push(senderId));

    expect(box.node.ingestSignedRelayCommand(submission)).toBe("accepted");
    expect(requested).toEqual([operator.nodeId]);
  });

  it("deliberately accepts a command from an identity this Box has never independently vetted (UNKNOWN trust) — the explicit design decision for this piece", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const neverSeenBefore = Identity.generate();
    expect(box.node.trust.get(neverSeenBefore.nodeId)).toBe(TrustLevel.UNKNOWN);
    const submission = signCommand(neverSeenBefore, box.node);

    expect(box.node.ingestSignedRelayCommand(submission)).toBe("accepted");
  });

  it("rejects a submission whose fields were tampered after signing", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const submission = signCommand(operator, box.node);
    const requested: string[] = [];
    box.node.on("relay:reboot-requested", (senderId: string) => requested.push(senderId));

    expect(box.node.ingestSignedRelayCommand({ ...submission, timestamp: submission.timestamp + 1 })).toBe("rejected");
    expect(requested).toEqual([]);
  });

  it("rejects a signature claiming an identity that never actually signed it", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const realOperator = Identity.generate();
    const impersonated = Identity.generate();
    const submission = signCommand(realOperator, box.node);
    const forged = { ...submission, publisherId: impersonated.nodeId };

    expect(box.node.ingestSignedRelayCommand(forged)).toBe("rejected");
  });

  it("rejects a submission signed for a different target node — binding targetNodeId prevents cross-Box replay", async () => {
    const box = makeNode("Box");
    const otherBox = makeNode("OtherBox");
    nodes.push(box.node, otherBox.node);
    await Promise.all([box.node.start(), otherBox.node.start()]);

    const operator = Identity.generate();
    const submissionForOtherBox = signCommand(operator, otherBox.node);

    expect(box.node.ingestSignedRelayCommand(submissionForOtherBox)).toBe("rejected");
  });

  it("ignores unknown/malformed input without throwing", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    expect(box.node.ingestSignedRelayCommand(undefined)).toBe("rejected");
    expect(box.node.ingestSignedRelayCommand(null)).toBe("rejected");
    expect(box.node.ingestSignedRelayCommand({})).toBe("rejected");
    expect(box.node.ingestSignedRelayCommand("not an object")).toBe("rejected");
  });

  /**
   * Regression per la stessa classe di problema corretta per gli altri due endpoint di ingest
   * (`docs/security.md` voci #81/#82): il rate limiter usato qui è `this.ingestRateLimiter`, MAI
   * `this.rateLimiter` — condividere quest'ultimo con `handlePacket()`'s own budget per i veri peer
   * mesh connessi permetterebbe a un chiamante HTTP di bruciare il budget di un vero peer
   * dichiarando il suo `nodeId` come `publisherId`, senza bisogno di una firma valida.
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
      const submission = signCommand(operator, box.node, { timestamp: Date.now() + i });
      box.node.ingestSignedRelayCommand({ ...submission, publisherId: realPeerId }); // signature now invalid — expected to reject, not the point of this test
    }

    for (let i = 0; i < 20; i++) {
      socket.write(encodePacket(createPacket({ type: MessageType.PING, source: realPeerId, payload: {} })));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(exceeded).toBe(0);
    socket.destroy();
  });

  /**
   * `MAX_HTTP_INGESTED_RELAY_COMMANDS_PER_WINDOW` (`node.ts`) — la sola difesa di volume rimasta su
   * questo canale dato che non consulta la fiducia. Deliberatamente piccolo (3/5min, come
   * `MAX_ELEVATED_DROPS_PER_WINDOW`), dato che un falso positivo qui non aggiunge solo una voce
   * spuria, mette offline il Box (soggetto a `--allow-remote-reboot`).
   */
  it("throttles the total number of HTTP-ingested reboot commands node-wide, across many distinct identities", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const results: IngestSignedContentResult[] = [];
    for (let i = 0; i < 4; i++) {
      const operator = Identity.generate(); // a different identity each time — the per-identity budget never engages
      const submission = signCommand(operator, box.node);
      results.push(box.node.ingestSignedRelayCommand(submission));
    }

    // MAX_HTTP_INGESTED_RELAY_COMMANDS_PER_WINDOW is 3 — the 4th distinct-identity submission must
    // still be throttled by the shared, node-wide budget.
    expect(results.slice(0, 3)).toEqual(["accepted", "accepted", "accepted"]);
    expect(results[3]).toBe("rate-limited");
  });

  /**
   * Replay protection CONDIVISA (`lastAcceptedRelayCommandAt`) tra i due percorsi — trovato
   * necessario proattivamente (`docs/security.md` voce #83): che un `senderId` abbia inviato il
   * suo ultimo comando accettato via mesh reale o via ingest HTTP, è lo stesso fatto logico su
   * quell'identità, e deve essere osservato/aggiornato da entrambi per impedire davvero un replay
   * incrociato tra i due canali.
   */
  it("replay protection is shared across the mesh path and the HTTP-ingest path for the same publisherId", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const first = signCommand(operator, box.node, { timestamp: 1000 });
    expect(box.node.ingestSignedRelayCommand(first)).toBe("accepted");

    // A second submission from the same identity with an EARLIER-OR-EQUAL timestamp is a replay,
    // even though it's freshly, validly signed — same "strictly increasing" rule
    // considerRelayCommand() itself enforces.
    const replay = signCommand(operator, box.node, { timestamp: 1000 });
    expect(box.node.ingestSignedRelayCommand(replay)).toBe("rejected");

    const stale = signCommand(operator, box.node, { timestamp: 500 });
    expect(box.node.ingestSignedRelayCommand(stale)).toBe("rejected");

    // A strictly newer timestamp from the same identity is accepted.
    const next = signCommand(operator, box.node, { timestamp: 2000 });
    expect(box.node.ingestSignedRelayCommand(next)).toBe("accepted");
  });

  it("does not consume the HTTP-ingest budget or update replay state for a rejected (tampered/malformed) submission", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const tampered = signCommand(operator, box.node, { timestamp: 1000 });
    expect(box.node.ingestSignedRelayCommand({ ...tampered, timestamp: 999 })).toBe("rejected"); // signature no longer matches

    // The real, untampered submission at the SAME timestamp must still be accepted — proof the
    // rejected attempt above never touched replay state (it would otherwise look like a replay).
    expect(box.node.ingestSignedRelayCommand(tampered)).toBe("accepted");
  });

  /**
   * `trustRank`-based eviction on `lastAcceptedRelayCommandAt` (`node.ts`'s constructor) — trovato
   * necessario dalla revisione (`docs/security.md` voce #83): senza di esso, l'entry di un vero
   * mittente mesh ADMIN-trusted poteva essere sfrattata da un burst successivo di identità HTTP mai
   * vagliate, sotto una FIFO piatta, riaprendo la finestra di replay per quel mittente.
   *
   * `MAX_TRACKED_RELAY_COMMAND_SENDERS` è 256 e `MAX_HTTP_INGESTED_RELAY_COMMANDS_PER_WINDOW` è
   * 3/5min — per riempire la mappa servirebbero 256+ submission accettate, impraticabile in tempo
   * reale. `vi.useFakeTimers()` fa avanzare l'orologio di una finestra intera a ogni iterazione
   * (bypassando il budget senza un vero ritardo), attivato solo DOPO la fase di setup reale via
   * mesh (connessione TCP reale, `waitFor()` basato su eventi) — mescolare timer finti con vera I/O
   * di rete sarebbe fragile, quindi le due fasi restano separate.
   */
  it("keeps a mesh-sourced ADMIN sender's replay protection intact through a flood of HTTP-ingested throwaway identities filling the bounded map", async () => {
    const box = makeNode("Box");
    const sender = makeNode("Sender");
    nodes.push(box.node, sender.node);
    await Promise.all([box.node.start(), sender.node.start()]);
    await sender.node.connect({ host: "127.0.0.1", port: box.transport.port });
    await Promise.all([sender.node.waitForPeerKey(box.node.nodeId), box.node.waitForPeerKey(sender.node.nodeId)]);
    box.node.trust.set(sender.node.nodeId, TrustLevel.ADMIN); // the --trust-admin provisioning step

    const requested: string[] = [];
    box.node.on("relay:reboot-requested", (id: string) => requested.push(id));
    sender.node.sendRelayCommand(box.node.nodeId); // real mesh path — considerRelayCommand() records sender's entry
    await waitFor(() => requested.length === 1);

    vi.useFakeTimers();
    try {
      let now = Date.now();
      vi.setSystemTime(now);
      // Flood past MAX_TRACKED_RELAY_COMMAND_SENDERS (256) with fresh, never-vetted identities —
      // each iteration jumps the clock forward past HTTP_INGESTED_RELAY_COMMAND_RATE_LIMIT_WINDOW_MS
      // (5min) so MAX_HTTP_INGESTED_RELAY_COMMANDS_PER_WINDOW (3) never throttles it. The very first
      // attacker identity/timestamp is kept aside — found by a third review pass: without checking
      // that IT specifically got evicted, this test would pass vacuously even if the map's size
      // bound were silently dropped entirely (nothing would ever get evicted, sender's entry would
      // trivially "survive", for the wrong reason).
      let firstAttacker: Identity | undefined;
      let firstAttackerTimestamp: number | undefined;
      for (let i = 0; i < 260; i++) {
        now += 6 * 60 * 1000;
        vi.setSystemTime(now);
        const attacker = Identity.generate();
        if (i === 0) {
          firstAttacker = attacker;
          firstAttackerTimestamp = now;
        }
        const submission = signCommand(attacker, box.node, { timestamp: now });
        expect(box.node.ingestSignedRelayCommand(submission)).toBe("accepted");
      }

      // The sender's own entry must have survived: a "replay" (a stale timestamp, signed by the
      // real sender's own identity) is still rejected, proving lastAcceptedRelayCommandAt still
      // remembers a timestamp for sender — never evicted ahead of any of the 260 lower-trust
      // (UNKNOWN) throwaway entries above.
      const replayFields: SignableRelayCommandFields = { command: "reboot", timestamp: 1, targetNodeId: box.node.nodeId, publisherId: sender.node.nodeId };
      const replaySignature = sender.node.identity.sign(relayCommandSigningPayload(replayFields)).toString("hex");
      expect(box.node.ingestSignedRelayCommand({ ...replayFields, signature: replaySignature })).toBe("rejected");

      // Positive proof eviction actually happened (not just that sender's entry was untouched): the
      // very first, lowest-trust throwaway attacker's own original timestamp is no longer remembered
      // as "last accepted" — resubmitting it now succeeds again instead of being rejected as a
      // replay, which only happens if that identity's entry was actually evicted from the map.
      const evictedAttackerSubmission = signCommand(firstAttacker!, box.node, { timestamp: firstAttackerTimestamp! });
      expect(box.node.ingestSignedRelayCommand(evictedAttackerSubmission)).toBe("accepted");
    } finally {
      vi.useRealTimers();
    }
  });
});
