import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";

/**
 * In-process network simulator (roadmap milestone 20, spec §76-80): spins
 * up N real `NomadNode`+`TcpTransport` instances on localhost, wires them
 * into a configurable topology, and runs the "content fanout" scenario —
 * one node publishes content, every other node tries to retrieve it
 * through the mesh — reporting delivery ratio and latency (spec §76
 * "packet delivery ratio", §77 "discovery time"/"retrieval latency").
 *
 * This exercises the exact same code path as `tests/integration/`, just
 * at a scale (tens to low hundreds of nodes) that isn't practical to keep
 * as a fast, always-run test. No hardware/BLE/Docker involved — pure
 * software, same as everything else in this milestone round.
 */

export type Topology = "chain" | "ring" | "star" | "random";

export interface SimulationOptions {
  nodeCount: number;
  topology: Topology;
  /** Extra random edges added on top of the guaranteed-connected spanning tree, only used by topology "random". */
  randomExtraLinks?: number;
  /** Size in bytes of the content the publisher (node 0) publishes. */
  contentSize?: number;
  /** Per-node timeout for its getContent() call. */
  getContentTimeoutMs?: number;
  /**
   * TTL each simulated node uses for packets it originates (spec §19).
   * Controlled flooding only reaches nodes within this many hops — a
   * "random" topology's spanning tree has no depth guarantee (attaching
   * each new node to a uniformly random already-connected one can, by
   * chance, produce a long chain-like branch), so a mesh that's larger
   * than the default TTL (8) can legitimately leave some nodes
   * unreachable. That's expected protocol behavior, not a bug — size
   * this generously (e.g. >= nodeCount) when the goal is testing scale
   * itself rather than TTL exhaustion specifically.
   */
  defaultTtl?: number;
  /**
   * Per-peer rate limit each simulated node applies (spec §57). This
   * routing layer floods unicast packets to *every* connected peer, not
   * just along a single directed path (there is no routing table yet —
   * see docs/next-steps.md) — so a node with many neighbors (a hub in a
   * "random" topology with extra links) can legitimately see many packets
   * per second on a given link during a burst of concurrent transfers.
   * The default rate limit (200/window) can be tight enough to drop some
   * of that legitimate traffic at larger scale; raise this when the goal
   * is testing delivery at scale rather than the rate limiter itself.
   */
  maxPacketsPerWindow?: number;
  rateLimitWindowMs?: number;
}

export interface DeliveryResult {
  nodeId: string;
  success: boolean;
  latencyMs?: number;
  error?: string;
}

export interface SimulationResult {
  nodeCount: number;
  topology: Topology;
  edgeCount: number;
  connectSetupMs: number;
  publisherId: string;
  contentId: string;
  deliveries: DeliveryResult[];
  deliveryRatio: number;
  avgLatencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
}

function buildTopologyEdges(nodeCount: number, topology: Topology, randomExtraLinks: number): Array<[number, number]> {
  const edges: Array<[number, number]> = [];
  switch (topology) {
    case "chain":
      for (let i = 0; i < nodeCount - 1; i++) edges.push([i, i + 1]);
      break;
    case "ring":
      for (let i = 0; i < nodeCount - 1; i++) edges.push([i, i + 1]);
      if (nodeCount > 2) edges.push([nodeCount - 1, 0]);
      break;
    case "star":
      for (let i = 1; i < nodeCount; i++) edges.push([0, i]);
      break;
    case "random": {
      // Track undirected pairs already wired, so we never generate the same logical link twice
      // (not even reversed) — a node pair connected a second time is still just one mesh link,
      // and generating a redundant edge only wastes a connection attempt for no topological gain.
      const edgeKey = (x: number, y: number): string => `${Math.min(x, y)}-${Math.max(x, y)}`;
      const seenPairs = new Set<string>();

      // A random spanning tree first, so the mesh is guaranteed connected regardless of chance.
      const connected = [0];
      for (let i = 1; i < nodeCount; i++) {
        const j = connected[Math.floor(Math.random() * connected.length)];
        edges.push([i, j]);
        seenPairs.add(edgeKey(i, j));
        connected.push(i);
      }

      // Bounded attempts: a small/dense graph can run out of non-duplicate pairs to offer quickly.
      let added = 0;
      let attempts = 0;
      const maxAttempts = Math.max(randomExtraLinks * 20, 50);
      while (added < randomExtraLinks && attempts < maxAttempts) {
        attempts++;
        const a = Math.floor(Math.random() * nodeCount);
        const b = Math.floor(Math.random() * nodeCount);
        if (a === b) continue;
        const key = edgeKey(a, b);
        if (seenPairs.has(key)) continue;
        edges.push([a, b]);
        seenPairs.add(key);
        added++;
      }
      break;
    }
  }
  return edges;
}

export async function runSimulation(options: SimulationOptions): Promise<SimulationResult> {
  const { nodeCount, topology } = options;
  if (nodeCount < 2) {
    throw new Error("nodeCount must be at least 2 (a publisher and at least one requester)");
  }

  const instances = Array.from({ length: nodeCount }, (_, i) => {
    const node = new NomadNode({
      displayName: `SIM-${i}`,
      defaultTtl: options.defaultTtl,
      maxPacketsPerWindow: options.maxPacketsPerWindow,
      rateLimitWindowMs: options.rateLimitWindowMs,
    });
    const transport = new TcpTransport(node.nodeId, 0);
    node.addTransport(transport);
    return { node, transport };
  });

  const setupStart = Date.now();
  try {
    await Promise.all(instances.map(({ node }) => node.start()));

    const edges = buildTopologyEdges(nodeCount, topology, options.randomExtraLinks ?? 0);
    for (const [i, j] of edges) {
      // node[i].connect() resolving only proves i's outbound side has identified j — j's inbound
      // side processes i's HELLO on its own, independent, asynchronous read. Without waiting for
      // that too, a node can start querying the mesh with an empty peer table even though the
      // "connection" it was just given already technically exists at the TCP level.
      const jSeesI = new Promise<void>((resolve) => {
        const handler = (peerId: string): void => {
          if (peerId === instances[i].node.nodeId) {
            instances[j].node.off("peer:connected", handler);
            resolve();
          }
        };
        instances[j].node.on("peer:connected", handler);
      });
      await instances[i].node.connect({ host: "127.0.0.1", port: instances[j].transport.port });
      await jSeesI;
    }
    const connectSetupMs = Date.now() - setupStart;

    const data = Buffer.alloc(options.contentSize ?? 1024, 7);
    const publisher = instances[0].node;
    const metadata = publisher.publishContent("simulated.bin", "application/octet-stream", data);

    const deliveries = await Promise.all(
      instances.slice(1).map(async ({ node }): Promise<DeliveryResult> => {
        const start = Date.now();
        try {
          const received = await node.getContent(metadata.contentId, {
            timeoutMs: options.getContentTimeoutMs ?? 5000,
          });
          const ok = received.equals(data);
          return {
            nodeId: node.nodeId,
            success: ok,
            latencyMs: Date.now() - start,
            error: ok ? undefined : "retrieved bytes did not match the published content",
          };
        } catch (err) {
          return { nodeId: node.nodeId, success: false, error: (err as Error).message };
        }
      }),
    );

    const successes = deliveries.filter((d) => d.success);
    const latencies = successes.map((d) => d.latencyMs).filter((l): l is number => l !== undefined);

    return {
      nodeCount,
      topology,
      edgeCount: edges.length,
      connectSetupMs,
      publisherId: publisher.nodeId,
      contentId: metadata.contentId,
      deliveries,
      deliveryRatio: successes.length / deliveries.length,
      avgLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
      minLatencyMs: latencies.length > 0 ? Math.min(...latencies) : null,
      maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : null,
    };
  } finally {
    await Promise.all(instances.map(({ node }) => node.stop()));
  }
}
