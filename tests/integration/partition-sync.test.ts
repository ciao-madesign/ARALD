import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";

/**
 * Spec §33-34, "quarto obiettivo tecnico" (§93): two previously-separate
 * mesh segments — A-B-C (with "alpha" published on A) and D-E-F (with
 * "omega" published on F) — meet at a single new link (C <-> D) and
 * reconcile catalogs without re-transferring any actual content bytes.
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
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("partition sync (two separate meshes reconnecting)", () => {
  const nodes: NomadNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it("reconciles catalogs across a new bridge link without transferring content bytes", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    const c = makeNode("C");
    const d = makeNode("D");
    const e = makeNode("E");
    const f = makeNode("F");
    nodes.push(a.node, b.node, c.node, d.node, e.node, f.node);
    await Promise.all([a, b, c, d, e, f].map(({ node }) => node.start()));

    const alphaData = Buffer.from("dolomiti: rifugio alpha, quota 2100m");
    const alphaMeta = a.node.publishContent("alpha.txt", "text/plain", alphaData);

    const omegaData = Buffer.from("dolomiti: rifugio omega, quota 2400m");
    const omegaMeta = f.node.publishContent("omega.txt", "text/plain", omegaData);

    // Build mesh 1 (A-B-C), letting catalog sync propagate alpha's metadata hop by hop.
    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await waitFor(() => b.node.remoteCatalog.has(alphaMeta.contentId));
    await b.node.connect({ host: "127.0.0.1", port: c.transport.port });
    await waitFor(() => c.node.remoteCatalog.has(alphaMeta.contentId));

    // Build mesh 2 (F-E-D) separately, propagating omega's metadata the same way.
    await f.node.connect({ host: "127.0.0.1", port: e.transport.port });
    await waitFor(() => e.node.remoteCatalog.has(omegaMeta.contentId));
    await e.node.connect({ host: "127.0.0.1", port: d.transport.port });
    await waitFor(() => d.node.remoteCatalog.has(omegaMeta.contentId));

    // Neither mesh knows about the other's content yet.
    expect(c.node.remoteCatalog.has(omegaMeta.contentId)).toBe(false);
    expect(d.node.remoteCatalog.has(alphaMeta.contentId)).toBe(false);

    // The two meshes meet at a single new link: C <-> D.
    await c.node.connect({ host: "127.0.0.1", port: d.transport.port });

    await waitFor(() => c.node.remoteCatalog.has(omegaMeta.contentId));
    await waitFor(() => d.node.remoteCatalog.has(alphaMeta.contentId));

    // Only metadata crossed the bridge — nobody on either side fetched the actual bytes.
    expect(c.node.contentStore.has(omegaMeta.contentId)).toBe(false);
    expect(d.node.contentStore.has(alphaMeta.contentId)).toBe(false);
    expect(c.node.remoteCatalog.get(omegaMeta.contentId)?.name).toBe("omega.txt");
    expect(d.node.remoteCatalog.get(alphaMeta.contentId)?.name).toBe("alpha.txt");

    // The catalog only proves existence; actual retrieval still goes through the
    // normal content-query flow, now that the bridge makes the whole thing one mesh.
    const retrievedOmega = await b.node.getContent(omegaMeta.contentId);
    expect(retrievedOmega).toEqual(omegaData);

    const retrievedAlpha = await e.node.getContent(alphaMeta.contentId);
    expect(retrievedAlpha).toEqual(alphaData);
  });

  it("listKnownContent() merges local content and remote-catalog-only entries", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    nodes.push(a.node, b.node);
    await Promise.all([a.node.start(), b.node.start()]);

    const data = Buffer.from("only on A");
    const metadata = a.node.publishContent("only-a.txt", "text/plain", data);

    await a.node.connect({ host: "127.0.0.1", port: b.transport.port });
    await waitFor(() => b.node.remoteCatalog.has(metadata.contentId));

    const known = b.node.listKnownContent();
    expect(known.map((m) => m.contentId)).toContain(metadata.contentId);
    // B knows it exists, but does not hold the bytes.
    expect(b.node.contentStore.has(metadata.contentId)).toBe(false);
  });
});
