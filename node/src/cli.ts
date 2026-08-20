import { NomadNode } from "./node.js";
import { TcpTransport } from "./transports/tcp.js";
import { WebUiServer } from "./web-ui.js";

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
  const port = Number(args.port ?? 9001);
  const displayName = args.id ?? `NODE-${port}`;

  const node = new NomadNode({ displayName });
  node.addTransport(new TcpTransport(node.nodeId, port));
  await node.start();

  console.log("Nomad-Net Node");
  console.log(`Display name: ${displayName}`);
  console.log(`Node ID: ${node.nodeId}`);
  console.log(`Listening on port: ${port}`);
  console.log(`Status: ${node.status}`);

  if (args.connect) {
    const [host, portStr] = args.connect.split(":");
    try {
      const peerId = await node.connect({ host, port: Number(portStr) });
      console.log(`Connected to peer ${peerId} at ${args.connect}`);
    } catch (err) {
      console.error(`Failed to connect to ${args.connect}:`, (err as Error).message);
    }
  }

  node.on("data", (packet) => {
    console.log(`[DATA] from ${packet.source}: ${JSON.stringify(packet.payload)}`);
  });
  node.on("peer:connected", (peerId: string) => console.log(`[PEER] connected: ${peerId}`));
  node.on("peer:disconnected", (peerId: string) => console.log(`[PEER] disconnected: ${peerId}`));

  // Off by default (spec §59 web interface) — only started when explicitly requested, since it
  // opens a second listening socket even though it's loopback-bound by default (web-ui.ts).
  let webUi: WebUiServer | undefined;
  if (args["web-port"]) {
    webUi = new WebUiServer(node, { port: Number(args["web-port"]) });
    await webUi.start();
    console.log(`Web UI: http://127.0.0.1:${webUi.port}`);
  }

  const shutdown = async (): Promise<void> => {
    if (webUi) await webUi.stop();
    await node.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
