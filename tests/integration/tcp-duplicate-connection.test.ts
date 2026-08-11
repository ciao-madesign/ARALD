import { describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";

/**
 * Regression test: if the same pair of nodes ends up with two simultaneous
 * TCP connections between them (e.g. both sides happen to dial each other,
 * or a topology generator accidentally produces the same logical link
 * twice), the transport used to silently orphan whichever socket lost the
 * peerId->socket map slot. An orphaned *inbound* socket is still tracked by
 * Node's own net.Server internally, so `server.close()` inside `stop()`
 * never sees its connection count reach zero and hangs forever. Found via
 * tools/simulator's "random" topology occasionally generating a duplicate
 * edge — see node/src/transports/tcp.ts's wireSocket() for the fix.
 */
describe("TcpTransport with a duplicate/redundant connection between the same peer pair", () => {
  it("dedupes the second connection instead of orphaning a socket, and stop() still completes", async () => {
    const a = new NomadNode({ displayName: "A" });
    const aTransport = new TcpTransport(a.nodeId, 0);
    a.addTransport(aTransport);

    const b = new NomadNode({ displayName: "B" });
    const bTransport = new TcpTransport(b.nodeId, 0);
    b.addTransport(bTransport);

    await Promise.all([a.start(), b.start()]);

    await a.connect({ host: "127.0.0.1", port: bTransport.port });
    // A second, redundant connection between the same pair, this time in the reverse direction —
    // this is exactly the scenario that used to orphan a socket and hang stop() forever.
    await b.connect({ host: "127.0.0.1", port: aTransport.port });

    // Still exactly one logical peer each — the duplicate didn't create a phantom second entry.
    expect(a.peers.list().filter((p) => p.id === b.nodeId)).toHaveLength(1);
    expect(b.peers.list().filter((p) => p.id === a.nodeId)).toHaveLength(1);

    await Promise.race([
      Promise.all([a.stop(), b.stop()]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("stop() did not complete — regression reproduced")), 3000)),
    ]);
  });
});
