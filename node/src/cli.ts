import { NomadNode } from "./node.js";
import { TcpTransport } from "./transports/tcp.js";
import { WebUiServer, generateNetworkPassword } from "./web-ui.js";

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
    const allowServiceCalls = args["allow-service-calls"] === "true";
    // Generated fresh every run, printed/shown once, never persisted — the mobile client (Opzione H,
    // docs/next-steps.md) is expected to be paired by re-entering this each time the node restarts,
    // the same "out of band, by the operator" trust model as a Wi-Fi router's own password.
    const networkName = allowServiceCalls ? (args["network-name"] ?? displayName) : undefined;
    const networkPassword = allowServiceCalls ? (args["network-password"] ?? generateNetworkPassword()) : undefined;
    webUi = new WebUiServer(node, {
      port: Number(args["web-port"]),
      host: args["web-host"],
      allowServiceCalls,
      networkName,
      networkPassword,
    });
    await webUi.start();
    const webHost = args["web-host"] ?? "127.0.0.1";
    console.log(`Web UI: http://${webHost}:${webUi.port}`);
    if (allowServiceCalls) {
      console.log(`Mobile network name: ${networkName}`);
      console.log(`Mobile network password: ${networkPassword}`);
      console.log(`(anche visibili sulla pagina web sopra, sezione "Collega un telefono")`);
      if (!args["web-host"]) {
        console.log(`Note: --web-host wasn't set, so the Web UI is still loopback-only — a phone on the same Wi-Fi can't reach it yet.`);
      }
    }
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
