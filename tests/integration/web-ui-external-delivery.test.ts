import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { WebUiServer } from "../../node/src/web-ui.js";
import { EncryptionIdentity } from "../../node/src/encryption.js";
import type { ExternalDeliveryAllowlist } from "../../node/src/external-delivery.js";

/**
 * GET /api/external-delivery-destinations and POST /api/external-delivery
 * (`node/src/web-ui.ts`, "Consegna esterna differita" —
 * `docs/service-catalog.md`). Same dedicated-file convention
 * `node-append-web-ui.test.ts`/`drops-web-ui.test.ts` already use for a
 * `WebUiServer` feature. GET is unauthenticated (mirrors `GET /api/drops`
 * — no sensitive data in the public directory projection); POST is gated
 * behind the network password like every other write this class exposes.
 * `attemptExternalDeliveryPost()`'s SSRF guard is out of scope here (this
 * file never reaches it) — see `external-delivery.test.ts` for that.
 */
describe("WebUiServer /api/external-delivery(-destinations)", () => {
  const TOKEN = "test-pairing-token-0123456789abcdef";
  const nodes: NomadNode[] = [];
  const webUis: WebUiServer[] = [];

  afterEach(async () => {
    await Promise.all(webUis.map((w) => w.stop()));
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
    webUis.length = 0;
  });

  function makeGateway(displayName: string, allowlist?: ExternalDeliveryAllowlist): { node: NomadNode; transport: TcpTransport; webUi: WebUiServer } {
    const node = new NomadNode({ displayName, externalDeliveryAllowlist: allowlist });
    const transport = new TcpTransport(node.nodeId, 0);
    node.addTransport(transport);
    const webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    nodes.push(node);
    webUis.push(webUi);
    return { node, transport, webUi };
  }

  function authedFetch(webUi: WebUiServer, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${webUi.port}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${TOKEN}` },
    });
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

  it("GET /api/external-delivery-destinations needs no auth at all, even when allowServiceCalls/networkPassword are set", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${a.webUi.port}/api/external-delivery-destinations`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("GET /api/external-delivery-destinations stays reachable (200) even when allowServiceCalls is off, unlike POST", async () => {
    const node = new NomadNode({ displayName: "N" });
    const webUi = new WebUiServer(node, { port: 0 });
    nodes.push(node);
    webUis.push(webUi);
    await Promise.all([node.start(), webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/external-delivery-destinations`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("GET /api/external-delivery-destinations reflects a locally-published directory, never leaking url/password", async () => {
    const destination = EncryptionIdentity.generate();
    const allowlist: ExternalDeliveryAllowlist = new Map([
      [
        "hq-1",
        { destinationId: "hq-1", label: "Headquarter", publicKeyHex: destination.publicKeyHex, url: "http://internal.example/intake", password: "s3gr3t0" },
      ],
    ]);
    const a = makeGateway("A", allowlist);
    await Promise.all([a.node.start(), a.webUi.start()]);
    a.node.publishExternalDeliveryDirectory();

    const res = await fetch(`http://127.0.0.1:${a.webUi.port}/api/external-delivery-destinations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { destinationId: "hq-1", label: "Headquarter", publicKeyHex: destination.publicKeyHex, requiresPassword: true, boxNodeId: a.node.nodeId },
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("internal.example");
    expect(serialized).not.toContain("s3gr3t0");
  });

  it("POST /api/external-delivery 404s when allowServiceCalls is off, same as every other write endpoint", async () => {
    const node = new NomadNode({ displayName: "N" });
    const webUi = new WebUiServer(node, { port: 0 });
    nodes.push(node);
    webUis.push(webUi);
    await Promise.all([node.start(), webUi.start()]);

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/external-delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boxNodeId: "x", destinationId: "hq-1", publicKeyHex: "a".repeat(64), dataBase64: "aGVsbG8=" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/external-delivery without a valid Authorization header is a 401", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const noAuth = await fetch(`http://127.0.0.1:${a.webUi.port}/api/external-delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boxNodeId: "x", destinationId: "hq-1", publicKeyHex: "a".repeat(64), dataBase64: "aGVsbG8=" }),
    });
    expect(noAuth.status).toBe(401);

    const wrongPassword = await fetch(`http://127.0.0.1:${a.webUi.port}/api/external-delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-password" },
      body: JSON.stringify({ boxNodeId: "x", destinationId: "hq-1", publicKeyHex: "a".repeat(64), dataBase64: "aGVsbG8=" }),
    });
    expect(wrongPassword.status).toBe(401);
  });

  it("POST /api/external-delivery rejects a missing/empty boxNodeId/destinationId/publicKeyHex/dataBase64, or a non-string password, with 400", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    async function post(body: unknown): Promise<number> {
      const res = await authedFetch(a.webUi, "/api/external-delivery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.status;
    }

    const valid = { boxNodeId: "box-1", destinationId: "hq-1", publicKeyHex: "a".repeat(64), dataBase64: "aGVsbG8=" };
    expect(await post({ ...valid, boxNodeId: undefined })).toBe(400);
    expect(await post({ ...valid, boxNodeId: "" })).toBe(400);
    expect(await post({ ...valid, destinationId: undefined })).toBe(400);
    expect(await post({ ...valid, destinationId: "" })).toBe(400);
    expect(await post({ ...valid, publicKeyHex: undefined })).toBe(400);
    expect(await post({ ...valid, publicKeyHex: "" })).toBe(400);
    expect(await post({ ...valid, dataBase64: undefined })).toBe(400);
    expect(await post({ ...valid, dataBase64: "" })).toBe(400);
    expect(await post({ ...valid, password: 12345 })).toBe(400);
  });

  it("POST /api/external-delivery with a malformed JSON body is a 400", async () => {
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const res = await authedFetch(a.webUi, "/api/external-delivery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/external-delivery with a decoded file just over the node's own maxExternalDeliveryPayloadBytes is a 400 (sendExternalDelivery()'s own cap, not the HTTP body-size gate)", async () => {
    // Default maxExternalDeliveryPayloadBytes is 1_000_000 — this file decodes to 1_000_001 bytes,
    // just over that cap but comfortably under the HTTP layer's own body-size limit (sized to fit a
    // base64-encoded payload up to the cap, see handleSendExternalDelivery()'s own doc comment) — so
    // this exercises sendExternalDelivery()'s validation specifically, not readRequestBody()'s.
    const a = makeGateway("A");
    await Promise.all([a.node.start(), a.webUi.start()]);

    const justOverCap = Buffer.alloc(1_000_001).toString("base64");
    const res = await authedFetch(a.webUi, "/api/external-delivery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boxNodeId: "some-box", destinationId: "hq-1", publicKeyHex: "a".repeat(64), dataBase64: justOverCap }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/external delivery payload must be/);
  });

  it("POST /api/external-delivery end to end: submits a file that reaches a real connected BOX's queue, never readable by it", async () => {
    const destination = EncryptionIdentity.generate();
    const allowlist: ExternalDeliveryAllowlist = new Map([
      ["hq-1", { destinationId: "hq-1", label: "Headquarter", publicKeyHex: destination.publicKeyHex, url: "http://127.0.0.1:1/unused" }],
    ]);
    const box = makeGateway("Box", allowlist);
    const gateway = makeGateway("Gateway"); // the operator's paired node — not the BOX itself
    await Promise.all([box.node.start(), box.webUi.start(), gateway.node.start(), gateway.webUi.start()]);
    await gateway.node.connect({ host: "127.0.0.1", port: box.transport.port });

    const dataBase64 = Buffer.from("report dal campo", "utf8").toString("base64");
    const res = await authedFetch(gateway.webUi, "/api/external-delivery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boxNodeId: box.node.nodeId, destinationId: "hq-1", publicKeyHex: destination.publicKeyHex, dataBase64 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(true);
    expect(typeof body.packetId).toBe("string");

    await waitFor(() => box.node.externalDeliveryQueue.size === 1);
    // The BOX only ever sees opaque ciphertext — never asserted readable here, by construction: this
    // test never gives the BOX the destination's private key, matching production. Sealing/decryption
    // round-trip fidelity is covered end to end in external-delivery.test.ts.
  });
});
