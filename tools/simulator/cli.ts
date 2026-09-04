import { runSimulation, type Topology } from "./simulate.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = "true";
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const nodeCount = Number(args.nodes ?? 10);
  const topology = (args.topology ?? "chain") as Topology;
  const contentSize = args["content-size"] ? Number(args["content-size"]) : undefined;
  const randomExtraLinks = args["extra-links"] ? Number(args["extra-links"]) : undefined;
  const getContentTimeoutMs = args.timeout ? Number(args.timeout) : undefined;
  const defaultTtl = args.ttl ? Number(args.ttl) : undefined;
  const maxPacketsPerWindow = args["rate-limit"] ? Number(args["rate-limit"]) : undefined;

  console.log(`ARALD simulator: ${nodeCount} nodes, topology=${topology}`);
  const result = await runSimulation({
    nodeCount,
    topology,
    contentSize,
    randomExtraLinks,
    getContentTimeoutMs,
    defaultTtl,
    maxPacketsPerWindow,
  });

  console.log(`Links: ${result.edgeCount}  Setup: ${result.connectSetupMs}ms`);
  console.log(`Publisher: ${result.publisherId.slice(0, 12)}...  Content: ${result.contentId.slice(0, 12)}...`);
  console.log(
    `Delivery ratio: ${(result.deliveryRatio * 100).toFixed(1)}% ` +
      `(${result.deliveries.filter((d) => d.success).length}/${result.deliveries.length})`,
  );
  if (result.avgLatencyMs !== null) {
    console.log(
      `Latency: avg=${result.avgLatencyMs.toFixed(1)}ms min=${result.minLatencyMs}ms max=${result.maxLatencyMs}ms`,
    );
  }

  const failures = result.deliveries.filter((d) => !d.success);
  if (failures.length > 0) {
    console.log(`Failures (showing up to 10 of ${failures.length}):`);
    for (const failure of failures.slice(0, 10)) {
      console.log(`  ${failure.nodeId.slice(0, 12)}...: ${failure.error}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
