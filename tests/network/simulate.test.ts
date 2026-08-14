import { describe, expect, it } from "vitest";
import { runSimulation, type Topology } from "../../tools/simulator/simulate.js";

/**
 * Roadmap milestone 20 ("scalability testing", spec §80): the simulator
 * wires up real NomadNode instances at a scale beyond what the fast
 * tests/integration/ suite exercises (a handful of nodes), and checks the
 * mesh still achieves full content delivery across every node.
 */

describe("network simulator", () => {
  const topologies: Topology[] = ["chain", "ring", "star", "random"];

  it.each(topologies)(
    "achieves 100%% delivery on a small %s topology",
    async (topology) => {
      const result = await runSimulation({ nodeCount: 6, topology, randomExtraLinks: 2, getContentTimeoutMs: 3000 });
      expect(result.deliveries).toHaveLength(5);
      expect(result.deliveryRatio).toBe(1);
      for (const delivery of result.deliveries) {
        expect(delivery.success, delivery.error).toBe(true);
      }
    },
    15000,
  );

  it(
    "scales to a few dozen nodes on a random topology with full delivery",
    async () => {
      // A "random" spanning tree has no depth guarantee — attaching each new node to a uniformly
      // random already-connected one can, by chance, produce a long chain-like branch deeper than
      // the default TTL (8). Since this test is about scale, not TTL tuning, give it a TTL that
      // comfortably covers any possible tree shape for this node count (spec §19). Also raise the
      // per-peer rate limit: this routing layer floods unicast packets to every connected peer
      // rather than along a single directed path (no routing table yet), so a hub node produced by
      // "random" + extra links can legitimately see well over the default 200/window during a
      // burst of 29 concurrent transfers — that's the rate limiter doing its documented job
      // (spec §57) against organic congestion, not something this delivery test is meant to probe.
      const result = await runSimulation({
        nodeCount: 30,
        topology: "random",
        randomExtraLinks: 15,
        getContentTimeoutMs: 6000,
        defaultTtl: 40,
        maxPacketsPerWindow: 5000,
      });
      expect(result.nodeCount).toBe(30);
      expect(result.deliveries).toHaveLength(29);
      expect(result.deliveryRatio).toBe(1);
    },
    30000,
  );

  it(
    "a TTL shorter than the mesh's depth leaves the farthest nodes legitimately unreachable",
    async () => {
      // Documents the tradeoff exercised above, deterministically, with numbers checked
      // empirically rather than derived by hand (the round trip involves more than one packet
      // type, each getting its own fresh TTL budget, so "distance <= TTL" is not quite the whole
      // story; distance-vector routing (spec §22) also speeds up how fast opportunistic caching
      // reaches intermediate nodes, which recalibrates the margin further vs. flooding alone).
      // With defaultTtl=8 on a chain, empirically the farthest node still occasionally succeeds
      // via a cached copy up to distance 17 — a 20-node chain (max distance 19) gives a
      // comfortable, non-flaky margin past that cutoff. Expected protocol behavior (spec §19,
      // §21), not a bug.
      const result = await runSimulation({ nodeCount: 20, topology: "chain", getContentTimeoutMs: 1500, defaultTtl: 8 });
      expect(result.deliveries).toHaveLength(19);
      expect(result.deliveryRatio).toBeLessThan(1);
      const farthest = result.deliveries[result.deliveries.length - 1];
      expect(farthest.success).toBe(false);
    },
    15000,
  );

  it("reports plausible latency statistics alongside the delivery ratio", async () => {
    const result = await runSimulation({ nodeCount: 8, topology: "chain", getContentTimeoutMs: 3000 });
    expect(result.avgLatencyMs).not.toBeNull();
    expect(result.minLatencyMs).not.toBeNull();
    expect(result.maxLatencyMs).not.toBeNull();
    expect(result.minLatencyMs!).toBeLessThanOrEqual(result.avgLatencyMs!);
    expect(result.avgLatencyMs!).toBeLessThanOrEqual(result.maxLatencyMs!);
  }, 15000);
});
