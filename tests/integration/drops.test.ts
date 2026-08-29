import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { Identity } from "../../node/src/identity.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";
import { MAX_DROP_LABEL_LENGTH } from "../../node/src/drops.js";

/**
 * Bacheca "drop" (docs/next-steps.md — concept credited to BitChat's
 * mesh-local `BoardManager`, Unlicense/public domain; no code reused, see
 * drops.ts's own doc comment). `NomadNode.publishDrop()`/`considerDrop()`,
 * built entirely on top of `CONTENT_ANNOUNCE`/catalog sync (already covered
 * generically in `content-announce.test.ts`) and the fixed `DROP_CONTENT_NAME`
 * convention (`drops.ts`, unit-tested in `tests/unit/drops.test.ts`). This
 * file only exercises what's new here: publish -> discover -> fetch ->
 * record, the urgent/EMERGENCY-priority path and its own rate limit, and
 * this feature's defensive posture against malformed fetched bytes.
 */

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

describe("Bacheca drops (publishDrop / considerDrop)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("a drop reaches a node two hops away immediately (CONTENT_ANNOUNCE), and the sender sees its own publish right away too", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    nodes.push(a.node, b.node, c.node);
    await Promise.all([a, b, c].map(({ node }) => node.start()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });

    const sent = a.node.publishDrop({ text: "Frana sul sentiero", lat: 45.5, lon: 7.5, label: "Pericolo", urgent: false });

    // The sender's own view is updated synchronously — no round trip needed for its own publish.
    expect(a.node.drops.list()).toEqual([sent]);
    expect(sent.author).toBe(a.node.nodeId);

    await waitFor(() => c.node.drops.list().length === 1);
    const received = c.node.drops.list()[0];
    expect(received.text).toBe("Frana sul sentiero");
    expect(received.label).toBe("Pericolo");
    expect(received.lat).toBe(45.5);
    expect(received.lon).toBe(7.5);
    expect(received.author).toBe(a.node.nodeId);
    expect(received.dropId).toBe(sent.dropId);
  });

  it("a node that connects *after* the drop was published still learns it via catalog sync", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();
    a.node.publishDrop({ text: "pubblicato prima che C si connetta", lat: 10, lon: 20, urgent: false });

    const c = makeNode("C");
    nodes.push(c.node);
    await c.node.start();
    await c.node.connect({ host: "127.0.0.1", port: a.transport.port });

    await waitFor(() => c.node.drops.list().length === 1);
    expect(c.node.drops.list()[0].text).toBe("pubblicato prima che C si connetta");
  });

  it("an urgent drop is announced at Priority.EMERGENCY on the wire; a non-urgent one at Priority.CONTENT", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();

    const socket: Socket = createConnection({ host: "127.0.0.1", port: a.transport.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const listener = Identity.generate();
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: listener.nodeId, payload: {} })));
    await waitFor(() => a.node.peers.has(listener.nodeId));

    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));

    a.node.publishDrop({ text: "tutto tranquillo", lat: 1, lon: 1, urgent: false });
    a.node.publishDrop({ text: "PERICOLO REALE", lat: 2, lon: 2, urgent: true });

    await new Promise((resolve) => setTimeout(resolve, 200));
    const lines = Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const announces = lines.filter((p) => p.type === "CONTENT_ANNOUNCE" && p.payload?.metadata?.name === "drop");
    expect(announces).toHaveLength(2);

    // Priority isn't recoverable from the announce alone (metadata carries no urgent flag) — match by
    // arrival order instead: the non-urgent drop was published first.
    expect(announces[0].priority).toBe(4); // Priority.CONTENT
    expect(announces[1].priority).toBe(0); // Priority.EMERGENCY

    socket.destroy();
  });

  it("rejects invalid text/lat/lon/label without publishing or recording anything", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();

    expect(() => a.node.publishDrop({ text: "", lat: 0, lon: 0, urgent: false })).toThrow(/1-\d+ characters/);
    expect(() => a.node.publishDrop({ text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1), lat: 0, lon: 0, urgent: false })).toThrow(/1-\d+ characters/);
    expect(() => a.node.publishDrop({ text: "ok", lat: 91, lon: 0, urgent: false })).toThrow(/'lat'/);
    expect(() => a.node.publishDrop({ text: "ok", lat: -91, lon: 0, urgent: false })).toThrow(/'lat'/);
    expect(() => a.node.publishDrop({ text: "ok", lat: 0, lon: 181, urgent: false })).toThrow(/'lon'/);
    expect(() => a.node.publishDrop({ text: "ok", lat: 0, lon: -181, urgent: false })).toThrow(/'lon'/);
    expect(() => a.node.publishDrop({ text: "ok", lat: 0, lon: 0, label: "x".repeat(MAX_DROP_LABEL_LENGTH + 1), urgent: false })).toThrow(
      /label must be/,
    );
    expect(() => a.node.publishDrop({ text: "ok", lat: 0, lon: 0, urgent: false, expiresInMs: 0 })).toThrow(/'expiresInMs'/);
    expect(() => a.node.publishDrop({ text: "ok", lat: 0, lon: 0, urgent: false, expiresInMs: -1 })).toThrow(/'expiresInMs'/);
    expect(() => a.node.publishDrop({ text: "ok", lat: 0, lon: 0, urgent: false, expiresInMs: Number.NaN })).toThrow(/'expiresInMs'/);
    expect(() => a.node.publishDrop({ text: "ok", lat: 0, lon: 0, urgent: false, expiresInMs: Number.POSITIVE_INFINITY })).toThrow(
      /'expiresInMs'/,
    );

    expect(a.node.drops.list()).toEqual([]);
  });

  it("rejects a non-positive expiresInMs on an urgent drop WITHOUT consuming the urgent rate-limit budget", async () => {
    // Regression: found by review — publishDrop() used to check/increment the urgent rate limit
    // before validating expiresInMs, so a non-positive value (which publishContent() below would
    // have rejected anyway, since ContentStore.putVerified() refuses already-expired content) burned
    // one unit of MAX_URGENT_DROPS_PER_WINDOW's budget without ever publishing anything — exactly the
    // "misbehaving or compromised paired client in a tight loop" scenario the rate limit exists to
    // stop. Proven here by exhausting what would have been the whole budget with rejected calls, then
    // showing 3 genuinely urgent drops (MAX_URGENT_DROPS_PER_WINDOW, node.ts) still go through.
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();

    for (let i = 0; i < 10; i++) {
      expect(() => a.node.publishDrop({ text: "bad", lat: 0, lon: 0, urgent: true, expiresInMs: -1 })).toThrow(/'expiresInMs'/);
    }
    expect(a.node.drops.list()).toEqual([]); // none of the rejected attempts published anything

    for (let i = 0; i < 3; i++) a.node.publishDrop({ text: `urgente ${i}`, lat: 0, lon: 0, urgent: true });
    expect(a.node.drops.list()).toHaveLength(3);
  });

  it("caps urgent drops at MAX_URGENT_DROPS_PER_WINDOW (node.ts) within the window, independent of non-urgent volume", async () => {
    const a = makeNode("A");
    nodes.push(a.node);
    await a.node.start();

    // Non-urgent drops never touch the urgent budget.
    for (let i = 0; i < 10; i++) a.node.publishDrop({ text: `routine ${i}`, lat: 0, lon: 0, urgent: false });

    for (let i = 0; i < 3; i++) a.node.publishDrop({ text: `urgente ${i}`, lat: 0, lon: 0, urgent: true });
    expect(() => a.node.publishDrop({ text: "urgente 4", lat: 0, lon: 0, urgent: true })).toThrow(/too many urgent drops/);

    // The rejected attempt published nothing — only the 10 routine + 3 accepted urgent drops exist.
    expect(a.node.drops.list()).toHaveLength(13);
  });

  it("content not named exactly 'drop' is never mistaken for one", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a, b].map(({ node }) => node.start()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });

    a.node.publishContent("ordinario.txt", "text/plain", Buffer.from("non e' un drop"), { announce: true });
    a.node.publishContent("dropped", "text/plain", Buffer.from("nome simile ma non uguale"), { announce: true });
    a.node.publishDrop({ text: "questo si'", lat: 0, lon: 0, urgent: false });

    await waitFor(() => b.node.drops.list().length === 1);
    expect(b.node.drops.list()[0].text).toBe("questo si'");
  });

  it("fetched bytes that don't parse as a valid drop payload are silently ignored, never recorded", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a, b].map(({ node }) => node.start()));
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });

    // Published directly (bypassing publishDrop()'s own validation) under the exact drop content
    // name, but with a body that isn't shaped like DropPayload.
    const metadata = a.node.publishContent("drop", "application/json", Buffer.from(JSON.stringify({ notAValidDrop: true }), "utf8"), {
      announce: true,
    });

    await waitFor(() => b.node.remoteCatalog.has(metadata.contentId));
    await new Promise((resolve) => setTimeout(resolve, 200)); // time for the (failed) fetch+parse to have happened
    expect(b.node.drops.list()).toEqual([]);
  });
});
