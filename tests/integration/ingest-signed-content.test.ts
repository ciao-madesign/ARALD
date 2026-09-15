import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode, type IngestSignedContentResult } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { Identity } from "../../node/src/identity.js";
import { computeContentId, contentSigningPayload, type ContentMetadata } from "../../node/src/content.js";
import { DROP_CONTENT_NAME, type DropPayload } from "../../node/src/drops.js";
import { MessageType, Priority, createPacket, encodePacket } from "../../node/src/packet.js";

/**
 * `NomadNode.ingestSignedContent()` — "Pezzo 1" del canale di comando
 * Box↔specchio (docs/emergency-portal.md, docs/security.md voce #81):
 * accetta content già firmato da un'identità DIVERSA da quella del Box
 * (nel caso reale, l'identità mesh dedicata di un operatore del portale),
 * senza mai firmare nulla localmente — il contrario esatto di
 * `publishContent()`. La proprietà da verificare qui non è "un Drop viene
 * pubblicato" (già coperto da `drops.test.ts`), ma che il Box non debba
 * fidarsi del chiamante: la verifica della firma è indipendente e reale.
 */

function signContent(identity: Identity, name: string, mimeType: string, data: Buffer, expiresAt?: number): ContentMetadata {
  const contentId = computeContentId(data);
  const size = data.length;
  const publisherId = identity.nodeId;
  const signature = identity.sign(contentSigningPayload({ contentId, name, mimeType, size, publisherId, expiresAt })).toString("hex");
  return { contentId, name, mimeType, size, createdAt: Date.now(), publisherId, signature, expiresAt };
}

function makeNode(displayName: string): { node: NomadNode; transport: TcpTransport } {
  const node = new NomadNode({ displayName });
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

describe("NomadNode.ingestSignedContent (Pezzo 1, canale di comando)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("accepts content signed by a foreign identity, never the Box's own", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const data = Buffer.from("materiale firmato dall'operatore", "utf8");
    const metadata = signContent(operator, "bulletin", "text/plain", data);

    const result = box.node.ingestSignedContent(metadata, data);

    expect(result).toBe("accepted");
    expect(box.node.contentStore.get(metadata.contentId)?.data.toString("utf8")).toBe("materiale firmato dall'operatore");
    // Never touches this.identity: the stored metadata's publisherId is still the operator's, not the Box's.
    expect(metadata.publisherId).toBe(operator.nodeId);
    expect(metadata.publisherId).not.toBe(box.node.nodeId);
  });

  it("rejects a tampered signature — the Box never trusts the caller, only re-verifies independently", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const data = Buffer.from("originale", "utf8");
    const metadata = signContent(operator, "bulletin", "text/plain", data);
    const tampered = Buffer.from("dati diversi da quelli firmati", "utf8");

    const result = box.node.ingestSignedContent(metadata, tampered);

    expect(result).toBe("rejected");
    expect(box.node.contentStore.get(metadata.contentId)).toBeUndefined();
  });

  it("rejects a signature claiming an identity that never actually signed it", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const realOperator = Identity.generate();
    const impersonated = Identity.generate();
    const data = Buffer.from("finto", "utf8");
    const metadata = signContent(realOperator, "bulletin", "text/plain", data);
    // Swap in someone else's node id while keeping the (now invalid) signature bytes.
    const forged: ContentMetadata = { ...metadata, publisherId: impersonated.nodeId };

    expect(box.node.ingestSignedContent(forged, data)).toBe("rejected");
  });

  it("rejects already-expired content, same as putVerified() would for a local publish", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const data = Buffer.from("scaduto", "utf8");
    const metadata = signContent(operator, "bulletin", "text/plain", data, Date.now() - 1000);

    expect(box.node.ingestSignedContent(metadata, data)).toBe("rejected");
  });

  it("sends a CONTENT_ANNOUNCE on the wire, at the requested priority, only when announce:true is passed", async () => {
    // A raw socket listener, not a second NomadNode — same technique drops.test.ts's own priority
    // test uses, specifically to observe exactly what hits the wire instead of relying on
    // remoteCatalog population, which (per the connect()-timing race documented in CLAUDE.md) can
    // in principle also happen through the connect-time catalog sync handshake, unrelated to
    // whether ingestSignedContent() itself explicitly floods.
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const socket: Socket = createConnection({ host: "127.0.0.1", port: box.transport.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const listener = Identity.generate();
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: listener.nodeId, payload: {} })));
    await waitFor(() => box.node.peers.has(listener.nodeId));

    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));

    const operator = Identity.generate();
    const data = Buffer.from("silenzioso", "utf8");
    const silent = signContent(operator, "bulletin", "text/plain", data);
    expect(box.node.ingestSignedContent(silent, data, { announce: false })).toBe("accepted");

    const loud = signContent(operator, "bulletin2", "text/plain", data);
    expect(box.node.ingestSignedContent(loud, data, { announce: true, priority: Priority.EMERGENCY })).toBe("accepted");

    await new Promise((resolve) => setTimeout(resolve, 200));
    const lines = Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const announces = lines.filter((p) => p.type === "CONTENT_ANNOUNCE");

    expect(announces.map((p) => p.payload?.metadata?.contentId)).toEqual([loud.contentId]); // never silent.contentId
    expect(announces[0].priority).toBe(0); // Priority.EMERGENCY

    socket.destroy();
  });

  it("a drop-named payload is recorded with the operator as author, receivedFrom undefined — same bookkeeping as a real drop", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const payload: DropPayload = { text: "sentiero chiuso", lat: 45.5, lon: 7.5, kind: "hazard", timestamp: Date.now() };
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    const metadata = signContent(operator, DROP_CONTENT_NAME, "application/json", data);

    expect(box.node.ingestSignedContent(metadata, data, { announce: true, priority: Priority.MESSAGING })).toBe("accepted");

    await waitFor(() => box.node.drops.list().length === 1);
    const recorded = box.node.drops.list()[0];
    expect(recorded.text).toBe("sentiero chiuso");
    expect(recorded.kind).toBe("hazard");
    expect(recorded.author).toBe(operator.nodeId);
    expect(recorded.author).not.toBe(box.node.nodeId);
    expect(recorded.receivedFrom).toBeUndefined();
  });

  it("a malformed drop-shaped payload (bad JSON/shape) is stored as content but never recorded as a Drop", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const data = Buffer.from(JSON.stringify({ notAValidDrop: true }), "utf8");
    const metadata = signContent(operator, DROP_CONTENT_NAME, "application/json", data);

    expect(box.node.ingestSignedContent(metadata, data)).toBe("accepted");
    expect(box.node.contentStore.has(metadata.contentId)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(box.node.drops.list()).toEqual([]);
  });

  it("content whose name isn't the exact drop content name is never mistaken for one", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const data = Buffer.from("non un drop", "utf8");
    const metadata = signContent(operator, "dropped", "text/plain", data);

    expect(box.node.ingestSignedContent(metadata, data)).toBe("accepted");
    expect(box.node.drops.list()).toEqual([]);
  });

  /**
   * Regression per la revisione (`docs/security.md` voce #81, punto 1): senza il gate su
   * `this.rateLimiter`, una chiamata HTTP autenticata poteva sommergere il Box senza alcun budget,
   * a differenza di un pacchetto arrivato da un vero peer mesh (sempre passato da
   * `this.rateLimiter.allow(fromPeerId)` prima di raggiungere un handler).
   */
  it("a single operator identity is throttled by the same per-identity packet budget a real mesh peer would get", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const operator = Identity.generate();
    const results: IngestSignedContentResult[] = [];
    // DEFAULT_MAX_PACKETS_PER_WINDOW (rate-limit.ts) is 200 within a 1s window — well below that
    // many distinct submissions from the SAME identity must eventually get throttled.
    for (let i = 0; i < 210; i++) {
      const data = Buffer.from(`bollettino ${i}`, "utf8");
      const metadata = signContent(operator, `bulletin-${i}`, "text/plain", data);
      results.push(box.node.ingestSignedContent(metadata, data));
    }

    expect(results).toContain("rate-limited");
    expect(results.filter((r) => r === "accepted").length).toBeLessThan(210);
  });

  /**
   * Regression per la revisione (`docs/security.md` voce #81, punto 2): la priorità di
   * annuncio di un Drop remoto ora deriva SEMPRE dal `kind` firmato, mai dal campo `priority`
   * non firmato passato dal chiamante HTTP — altrimenti un operatore poteva firmare un drop
   * "info" mentre chiedeva `Priority.EMERGENCY` nel body della richiesta.
   */
  it("a Drop's announced priority is always derived from its own signed kind, never the caller-supplied options.priority", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const socket: Socket = createConnection({ host: "127.0.0.1", port: box.transport.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const listener = Identity.generate();
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: listener.nodeId, payload: {} })));
    await waitFor(() => box.node.peers.has(listener.nodeId));

    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));

    const operator = Identity.generate();
    const payload: DropPayload = { text: "tutto tranquillo", lat: 45.5, lon: 7.5, kind: "info", timestamp: Date.now() };
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    const metadata = signContent(operator, DROP_CONTENT_NAME, "application/json", data);

    // Caller asks for EMERGENCY, but the signed payload's own kind is "info".
    expect(box.node.ingestSignedContent(metadata, data, { announce: true, priority: Priority.EMERGENCY })).toBe("accepted");

    await new Promise((resolve) => setTimeout(resolve, 200));
    const lines = Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const announce = lines.find((p) => p.type === "CONTENT_ANNOUNCE" && p.payload?.metadata?.contentId === metadata.contentId);

    expect(announce).toBeDefined();
    expect(announce.priority).toBe(Priority.CONTENT); // dropKindPriority("info"), never the requested EMERGENCY

    socket.destroy();
  });

  /**
   * Regression per la revisione (`docs/security.md` voce #81, punto 2): un Drop `"emergency"`/
   * `"hazard"` remoto ora consuma lo stesso budget `MAX_ELEVATED_DROPS_PER_WINDOW` condiviso con
   * `publishDrop()` — prima veniva bypassato del tutto.
   */
  it("an elevated-kind (hazard/emergency) Drop consumes the same node-wide elevated-drop budget publishDrop() uses, and is rate-limited once exhausted", async () => {
    const box = makeNode("Box");
    nodes.push(box.node);
    await box.node.start();

    const results: IngestSignedContentResult[] = [];
    for (let i = 0; i < 4; i++) {
      const operator = Identity.generate(); // a different identity each time — never the per-identity budget being tested here
      const payload: DropPayload = { text: `allerta ${i}`, lat: 45.5, lon: 7.5, kind: "emergency", timestamp: Date.now() };
      const data = Buffer.from(JSON.stringify(payload), "utf8");
      const metadata = signContent(operator, DROP_CONTENT_NAME, "application/json", data);
      results.push(box.node.ingestSignedContent(metadata, data));
    }

    // MAX_ELEVATED_DROPS_PER_WINDOW is 3 — the 4th distinct-identity emergency drop must still be
    // throttled by the shared, node-wide budget, not admitted just because it's a fresh identity.
    expect(results.slice(0, 3)).toEqual(["accepted", "accepted", "accepted"]);
    expect(results[3]).toBe("rate-limited");
  });
});
