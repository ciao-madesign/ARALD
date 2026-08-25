import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { MessageType, createPacket, encodePacket } from "../../node/src/packet.js";
import { Identity } from "../../node/src/identity.js";
import { serviceSigningPayload } from "../../node/src/service.js";

/**
 * Spec §35-37: services are discoverable and callable the same way content
 * is discoverable and retrievable — SERVICE_ANNOUNCE/QUERY mirror
 * CONTENT_QUERY/FOUND for discovery, SERVICE_REQUEST/RESPONSE mirror
 * CONTENT_REQUEST/COMPLETE for the actual invocation (minus chunking — a
 * call/result is assumed to fit in one packet). Exercised against a real,
 * mock local service (a simple echo/translate-style handler) registered on
 * a genuine NomadNode, over a real TCP connection to a second node —
 * mirrors the two/three-node style already used for content and private
 * messages, since there's no adversarial timing to control deterministically
 * here (unlike the raw-socket content-provider-retry/CONTENT_NOT_FOUND tests).
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

describe("service discovery and invocation", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("discovers a service via SERVICE_QUERY (registered before the two nodes ever connect) and invokes it", async () => {
    const provider = makeNode("provider");
    const caller = makeNode("caller");
    nodes.push(provider.node, caller.node);
    await Promise.all([provider.node.start(), caller.node.start()]);

    provider.node.registerService("service://translation", "1.0.0", ["it-en"], (payload) => {
      const { text } = payload as { text: string };
      return { translated: text.toUpperCase() };
    });

    // Connected only after registering — the caller has no way to already know about this
    // service except by flooding SERVICE_QUERY once it actually needs it.
    await caller.node.connect({ host: "127.0.0.1", port: provider.transport.port });

    const result = await caller.node.callService("service://translation", { text: "ciao" }, { timeoutMs: 2000 });
    expect(result).toEqual({ translated: "CIAO" });
  });

  it("propagates a SERVICE_ANNOUNCE to an already-connected peer without it ever having to query", async () => {
    const provider = makeNode("provider");
    const caller = makeNode("caller");
    nodes.push(provider.node, caller.node);
    await Promise.all([provider.node.start(), caller.node.start()]);
    await caller.node.connect({ host: "127.0.0.1", port: provider.transport.port });
    // connect() resolving only guarantees the caller's own side identified the peer — the
    // provider's inbound socket may not have processed the caller's HELLO yet, so its own peer
    // table (what floodExcept() below actually sends to) could still be empty for a moment.
    await waitFor(() => provider.node.peers.has(caller.node.nodeId));

    provider.node.registerService("service://ocr", "1.0.0", ["it"], (payload) => {
      const { imageBytes } = payload as { imageBytes: number };
      return { text: `estratto da ${imageBytes} byte` };
    });

    await waitFor(() => caller.node.services.providersFor("service://ocr").length > 0);
    expect(caller.node.services.providersFor("service://ocr")[0].providerId).toBe(provider.node.nodeId);

    // Already known via the announcement — callService() must not need to flood a query at all.
    const result = await caller.node.callService("service://ocr", { imageBytes: 4096 }, { timeoutMs: 500 });
    expect(result).toEqual({ text: "estratto da 4096 byte" });
  });

  it("rejects the caller with the provider's own error when the handler throws", async () => {
    const provider = makeNode("provider");
    const caller = makeNode("caller");
    nodes.push(provider.node, caller.node);
    await Promise.all([provider.node.start(), caller.node.start()]);

    provider.node.registerService("service://ai", "1.0.0", ["chat"], () => {
      throw new Error("modello non disponibile: memoria insufficiente");
    });
    await caller.node.connect({ host: "127.0.0.1", port: provider.transport.port });

    await expect(caller.node.callService("service://ai", {}, { timeoutMs: 2000 })).rejects.toThrow(
      /modello non disponibile/,
    );
  });

  it("times out when nobody in the mesh offers the requested service", async () => {
    const caller = makeNode("caller");
    nodes.push(caller.node);
    await caller.node.start();

    await expect(caller.node.callService("service://nonexistent", {}, { timeoutMs: 150 })).rejects.toThrow(
      /no provider found/,
    );
  });

  it("setServiceAvailability(false) re-announces, and callers relying on the propagated announcement stop treating it as a candidate", async () => {
    const provider = makeNode("provider");
    const caller = makeNode("caller");
    nodes.push(provider.node, caller.node);
    await Promise.all([provider.node.start(), caller.node.start()]);
    await caller.node.connect({ host: "127.0.0.1", port: provider.transport.port });
    await waitFor(() => provider.node.peers.has(caller.node.nodeId));

    provider.node.registerService("service://ai", "1.0.0", ["chat"], () => ({ ok: true }));
    await waitFor(() => caller.node.services.providersFor("service://ai").length > 0);

    provider.node.setServiceAvailability("service://ai", false);
    await waitFor(() => caller.node.services.providersFor("service://ai").length === 0);

    // No longer a known candidate on the caller's side — callService() must fall back to
    // flooding SERVICE_QUERY, which finds nobody available and times out.
    await expect(caller.node.callService("service://ai", {}, { timeoutMs: 150 })).rejects.toThrow(/no provider found/);
  });

  it("serves a locally-registered service in-process, with no network round trip needed", async () => {
    const solo = makeNode("solo");
    nodes.push(solo.node);
    await solo.node.start();

    solo.node.registerService("service://echo", "1.0.0", [], (payload, fromNodeId) => ({ payload, fromNodeId }));

    const result = await solo.node.callService("service://echo", { x: 1 }, { timeoutMs: 50 });
    expect(result).toEqual({ payload: { x: 1 }, fromNodeId: solo.node.nodeId });
  });

  it("falls through to a genuinely available remote provider instead of hanging on its own unavailable local registration", async () => {
    // Regression test: discoverService()'s local-registration fast path used to return the local
    // announcement unconditionally, ignoring its own availability flag — so a node with an
    // unavailable local registration for the same serviceId could never reach a real remote
    // provider at all, timing out instead of ever asking the mesh.
    const remoteProvider = makeNode("remote-provider");
    const caller = makeNode("caller");
    nodes.push(remoteProvider.node, caller.node);
    await Promise.all([remoteProvider.node.start(), caller.node.start()]);
    await caller.node.connect({ host: "127.0.0.1", port: remoteProvider.transport.port });
    await waitFor(() => remoteProvider.node.peers.has(caller.node.nodeId));

    remoteProvider.node.registerService("service://ai", "1.0.0", ["chat"], () => ({ from: "remote" }));
    caller.node.registerService("service://ai", "1.0.0", ["chat"], () => ({ from: "local" }), { availability: false });

    const result = await caller.node.callService("service://ai", {}, { timeoutMs: 2000 });
    expect(result).toEqual({ from: "remote" });
  });

  it("stop() rejects any in-flight callService() invocation instead of leaving it hanging past shutdown", async () => {
    const provider = makeNode("provider");
    const caller = makeNode("caller");
    nodes.push(provider.node);
    await Promise.all([provider.node.start(), caller.node.start()]);
    await caller.node.connect({ host: "127.0.0.1", port: provider.transport.port });
    await waitFor(() => provider.node.peers.has(caller.node.nodeId));

    // A handler that never resolves — the provider genuinely received the SERVICE_REQUEST but can
    // never send a SERVICE_RESPONSE, so the call is guaranteed to still be sitting in
    // pendingServiceCalls (not just discoverService()'s wait) by the time stop() runs below.
    provider.node.registerService("service://slow", "1.0.0", [], () => new Promise(() => {}));
    await waitFor(() => caller.node.services.providersFor("service://slow").length > 0);

    const pending = caller.node.callService("service://slow", {}, { timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 30)); // let invokeService() actually send and register the pending call
    try {
      const startedStopAt = Date.now();
      await caller.node.stop();
      await expect(pending).rejects.toThrow(/node stopped/);
      // Proves the rejection came from stop()'s own cleanup, not from waiting out the 5000ms timeout.
      expect(Date.now() - startedStopAt).toBeLessThan(1000);
    } finally {
      // afterEach only tracks `provider` above — make sure caller's transport is torn down too
      // even if the assertion throws, so a failing run doesn't leak an open TCP server/port.
      await caller.node.stop().catch(() => undefined);
    }
  });

  it("callService() times out a locally-registered handler that never resolves, instead of hanging forever (regression: found by review, digest AI work)", async () => {
    // withServiceTimeout() (node.ts) closes a gap the remote-invocation path never had: a handler
    // registered on *this* node used to be awaited with no timeout at all, silently ignoring
    // options.timeoutMs whenever the provider happened to be local rather than remote — exactly the
    // topology gateway/nomad/cli.ts's demo sets up for service://ai + any of its consumers.
    const caller = makeNode("caller");
    nodes.push(caller.node);
    await caller.node.start();

    caller.node.registerService("service://hangs", "1.0.0", ["noop"], () => new Promise(() => {})); // never resolves

    const start = Date.now();
    await expect(caller.node.callService("service://hangs", {}, { timeoutMs: 100 })).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(1000); // bounded by timeoutMs, not left hanging
  });

  it("stop() rejects an in-flight callService() invocation of a *local* handler too, not just remote ones", async () => {
    // Not pushed to `nodes` (stopped explicitly below) — afterEach() would otherwise call stop()
    // on it a second time, same convention as the existing remote-call version of this test above.
    const solo = makeNode("solo");
    await solo.node.start();

    solo.node.registerService("service://hangs-local", "1.0.0", [], () => new Promise(() => {})); // never resolves

    const pending = solo.node.callService("service://hangs-local", {}, { timeoutMs: 5000 });
    const startedStopAt = Date.now();
    await solo.node.stop();
    await expect(pending).rejects.toThrow(/node stopped/);
    // Proves the rejection came from stop()'s own cleanup, not from waiting out the 5000ms timeout.
    expect(Date.now() - startedStopAt).toBeLessThan(1000);
  });

  it("rejects a validly-signed SERVICE_ANNOUNCE whose capabilities isn't an array, instead of storing it for a later consumer (e.g. the web UI) to crash on", async () => {
    // Regression test: a valid Ed25519 signature only proves the claimed providerId produced this
    // exact JSON — it says nothing about the shape of the fields inside. An attacker who generates
    // their own (trivially cheap) keypair can self-sign a `capabilities` field of any type and pass
    // verifyServiceAnnouncement() cleanly. node.ts's recordServiceAnnouncement() must reject this at
    // the trust boundary, the same way it already rejects a non-string serviceId/providerId.
    const victim = makeNode("victim");
    nodes.push(victim.node);
    await victim.node.start();

    const attacker = Identity.generate();
    const fields = {
      serviceId: "service://ai",
      version: "1.0.0",
      capabilities: "not-an-array" as unknown as string[],
      providerId: attacker.nodeId,
      resourceRequirements: undefined,
      availability: true,
      createdAt: Date.now(),
    };
    const announcement = { ...fields, signature: attacker.sign(serviceSigningPayload(fields)).toString("hex") };

    const socket = createConnection({ host: "127.0.0.1", port: victim.transport.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.write(encodePacket(createPacket({ type: MessageType.HELLO, source: attacker.nodeId, payload: {} })));
    socket.write(
      encodePacket(createPacket({ type: MessageType.SERVICE_ANNOUNCE, source: attacker.nodeId, payload: { announcement } })),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(victim.node.services.providersFor("service://ai")).toHaveLength(0);
    socket.destroy();
  });
});
