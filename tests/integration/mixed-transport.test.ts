import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { LoraSimulatedTransport } from "../../node/src/transports/lora.js";
import { computeContentId } from "../../node/src/content.js";

/**
 * Proves the actual point of adding a second radio (docs/next-steps.md
 * Opzione L): LoRa **affianca** the mesh's existing links, it never
 * replaces them — a single `NomadNode` can hold multiple `Transport`
 * instances at once (`addTransport()`, already true of every transport in
 * this codebase, spec §16/§67) and use whichever one actually reaches a
 * given peer. Here, one node (`hub`) reaches one peer over plain TCP and a
 * completely different peer over a simulated LoRa link, at the same time —
 * neither peer has any transport in common with the other, so this only
 * works if `hub` genuinely serves both links concurrently, not by
 * coincidence of a shared transport somewhere.
 */

describe("NomadNode with both a TCP and a LoRa transport active at once", () => {
  let hub: NomadNode | undefined;
  let tcpPeer: NomadNode | undefined;
  let loraPeer: NomadNode | undefined;

  afterEach(async () => {
    await Promise.all([hub?.stop(), tcpPeer?.stop(), loraPeer?.stop()]);
    hub = undefined;
    tcpPeer = undefined;
    loraPeer = undefined;
  });

  it("reaches a TCP-only peer and a LoRa-only peer simultaneously from the same node", async () => {
    hub = new NomadNode({ displayName: "Hub" });
    const hubTcp = new TcpTransport(hub.nodeId, 0);
    const hubLora = new LoraSimulatedTransport(hub.nodeId, "hub-lora", { latencyMs: 2 });
    hub.addTransport(hubTcp);
    hub.addTransport(hubLora);

    tcpPeer = new NomadNode({ displayName: "TcpPeer" });
    const tcpPeerTransport = new TcpTransport(tcpPeer.nodeId, 0);
    tcpPeer.addTransport(tcpPeerTransport);

    loraPeer = new NomadNode({ displayName: "LoraPeer" });
    loraPeer.addTransport(new LoraSimulatedTransport(loraPeer.nodeId, "lora-peer", { latencyMs: 2 }));

    await Promise.all([hub.start(), tcpPeer.start(), loraPeer.start()]);

    await hub.connect({ host: "127.0.0.1", port: tcpPeerTransport.port }, "tcp");
    await hub.connect({ host: "lora-peer", port: 0 }, "lora-simulated");

    const tcpPong = new Promise<string>((resolve) => hub!.once("pong", resolve));
    hub.ping(tcpPeer.nodeId);
    await expect(tcpPong).resolves.toBe(tcpPeer.nodeId);

    const helloBytes = Buffer.from("reachable only over the simulated LoRa link");
    const metadata = loraPeer.publishContent("lora-only.txt", "text/plain", helloBytes);
    const data = await hub.getContent(metadata.contentId);
    expect(data).toEqual(helloBytes);
    expect(computeContentId(data)).toBe(metadata.contentId);

    // tcpPeer and loraPeer never connected to each other and share no transport — hub is the only
    // thing that could have relayed either result, proving both links were genuinely live at once.
  });
});
