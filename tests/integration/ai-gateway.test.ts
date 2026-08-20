import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { FakeOllamaServer } from "../../gateway/nomad/fake-ollama-server.js";
import { AiGateway } from "../../gateway/nomad/ai-gateway.js";

/**
 * Spec §37's own worked example: "un dispositivo poco potente chiede alla
 * rete una risposta generata da un'intelligenza artificiale locale, e la
 * rete trova un nodo piu' capace in grado di fornirla" — service://ai,
 * discovered and invoked exactly like any other service (spec §35-36,
 * already covered generically by service-discovery.test.ts), with the
 * actual generation proxied to Project NOMAD's Ollama (`FakeOllamaServer`
 * here, no Docker/real model available in this environment). The first
 * test below is deliberately multi-hop (weak device -> relay -> gateway)
 * since the whole point of the spec's scenario is that the weak device
 * never needs to know — or connect to — whichever node ends up answering.
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

describe("AI gateway (mocked Ollama, no Docker/real Project NOMAD)", () => {
  let fakeOllama: FakeOllamaServer | undefined;
  let weak: ReturnType<typeof makeNode> | undefined;
  let relay: ReturnType<typeof makeNode> | undefined;
  let gateway: ReturnType<typeof makeNode> | undefined;

  afterEach(async () => {
    await Promise.all([weak?.node.stop(), relay?.node.stop(), gateway?.node.stop(), fakeOllama?.stop()].filter(Boolean));
    fakeOllama = undefined;
    weak = undefined;
    relay = undefined;
    gateway = undefined;
  });

  it("a weak device discovers and calls service://ai through a relay, never connecting directly to the gateway node", async () => {
    fakeOllama = new FakeOllamaServer();
    fakeOllama.addAnswer("rifugio", "In caso di emergenza in rifugio, contatta il soccorso alpino al 118.");
    await fakeOllama.start();

    weak = makeNode("weak-device");
    relay = makeNode("relay");
    gateway = makeNode("gateway");
    await Promise.all([weak.node.start(), relay.node.start(), gateway.node.start()]);

    // weak <-> relay <-> gateway: weak never connects to gateway directly, mirroring
    // three-node-relay.test.ts's A/B/C shape.
    await weak.node.connect({ host: "127.0.0.1", port: relay.transport.port });
    await relay.node.connect({ host: "127.0.0.1", port: gateway.transport.port });
    await waitFor(() => relay.node.peers.has(gateway.node.nodeId));
    await waitFor(() => gateway.node.peers.has(relay.node.nodeId));

    const aiGateway = new AiGateway(gateway.node, `http://127.0.0.1:${fakeOllama.port}`);
    aiGateway.registerAiService();

    const result = (await weak.node.callService(
      "service://ai",
      { prompt: "Cosa faccio in caso di emergenza in rifugio?" },
      { timeoutMs: 3000 },
    )) as { response: string };

    expect(result.response).toBe("In caso di emergenza in rifugio, contatta il soccorso alpino al 118.");
  });

  it("proxies live to the AI backend on every call, reflecting a canned answer added between two calls rather than a cached response", async () => {
    fakeOllama = new FakeOllamaServer();
    fakeOllama.setDefaultAnswer("non lo so ancora");
    await fakeOllama.start();

    gateway = makeNode("gateway");
    weak = makeNode("weak-device");
    await Promise.all([gateway.node.start(), weak.node.start()]);
    await weak.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const aiGateway = new AiGateway(gateway.node, `http://127.0.0.1:${fakeOllama.port}`);
    aiGateway.registerAiService();

    const first = (await weak.node.callService("service://ai", { prompt: "meteo domani" }, { timeoutMs: 2000 })) as {
      response: string;
    };
    expect(first.response).toBe("non lo so ancora");

    // Added *after* the first call — a cached/snapshotted service would still answer with the
    // default, proving each call genuinely reaches the backend rather than serving a snapshot
    // taken once at registerAiService() time.
    fakeOllama.addAnswer("meteo", "Domani sole, temperatura in calo in quota.");
    const second = (await weak.node.callService("service://ai", { prompt: "meteo domani" }, { timeoutMs: 2000 })) as {
      response: string;
    };
    expect(second.response).toBe("Domani sole, temperatura in calo in quota.");
  });

  it("rejects a non-string prompt with a clear error instead of forwarding it to the AI backend", async () => {
    fakeOllama = new FakeOllamaServer();
    await fakeOllama.start();

    gateway = makeNode("gateway");
    weak = makeNode("weak-device");
    await Promise.all([gateway.node.start(), weak.node.start()]);
    await weak.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const aiGateway = new AiGateway(gateway.node, `http://127.0.0.1:${fakeOllama.port}`);
    aiGateway.registerAiService();

    await expect(weak.node.callService("service://ai", { prompt: 12345 }, { timeoutMs: 2000 })).rejects.toThrow(/prompt/);
  });

  it("rejects the caller with a clear error when the AI backend is unreachable, instead of hanging or crashing", async () => {
    fakeOllama = new FakeOllamaServer();
    await fakeOllama.start();
    const unreachableUrl = `http://127.0.0.1:${fakeOllama.port}`;
    await fakeOllama.stop();
    fakeOllama = undefined; // already stopped; afterEach shouldn't stop it again

    gateway = makeNode("gateway");
    weak = makeNode("weak-device");
    await Promise.all([gateway.node.start(), weak.node.start()]);
    await weak.node.connect({ host: "127.0.0.1", port: gateway.transport.port });

    const aiGateway = new AiGateway(gateway.node, unreachableUrl);
    aiGateway.registerAiService();

    await expect(weak.node.callService("service://ai", { prompt: "qualsiasi" }, { timeoutMs: 2000 })).rejects.toThrow();
  });

  it("FakeOllamaServer responds 400 to a malformed JSON body instead of crashing, and keeps answering afterwards", async () => {
    fakeOllama = new FakeOllamaServer();
    await fakeOllama.start();

    const malformed = await fetch(`http://127.0.0.1:${fakeOllama.port}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    expect(malformed.status).toBe(400);

    fakeOllama.addAnswer("ciao", "ciao a te");
    const ok = await fetch(`http://127.0.0.1:${fakeOllama.port}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "ciao" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ response: "ciao a te" });
  });
});
