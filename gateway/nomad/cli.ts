import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { FakeNomadServer } from "./fake-nomad-server.js";
import { KiwixGateway } from "./kiwix-gateway.js";
import { FakeOllamaServer } from "./fake-ollama-server.js";
import { AiGateway } from "./ai-gateway.js";

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

/**
 * Manual/demo entry point (`npm run gateway:demo` — see root package.json):
 * runs a NomadNode with the NOMAD gateway attached, backed by a
 * `FakeNomadServer` seeded with a couple of demo articles unless
 * `--nomad-url` points at a real Project NOMAD/Kiwix instance instead, plus
 * an `AiGateway` backed by a `FakeOllamaServer` seeded with a couple of
 * canned answers unless `--ai-url` points at a real Ollama instance
 * instead. Not used by the automated test suite
 * (tests/integration/nomad-gateway.test.ts and ai-gateway.test.ts build
 * their own fixtures directly), same relationship `tools/simulator/cli.ts`
 * has to its own `simulate.ts`.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port ?? 9101);

  let fakeServer: FakeNomadServer | undefined;
  let nomadBaseUrl = args["nomad-url"];
  if (!nomadBaseUrl) {
    fakeServer = new FakeNomadServer();
    fakeServer.addArticle({
      path: "wiki/italia",
      title: "Italia",
      mimeType: "text/plain",
      body: "L'Italia e' una repubblica parlamentare in Europa meridionale.",
    });
    fakeServer.addArticle({
      path: "wiki/rifugio-alpino",
      title: "Rifugio alpino",
      mimeType: "text/plain",
      body: "Un rifugio alpino e' una struttura ricettiva in alta montagna, spesso raggiungibile solo a piedi.",
    });
    await fakeServer.start();
    nomadBaseUrl = `http://127.0.0.1:${fakeServer.port}`;
    console.log(`Fake NOMAD server (no --nomad-url given): ${nomadBaseUrl}`);
  }

  let fakeOllama: FakeOllamaServer | undefined;
  let aiBaseUrl = args["ai-url"];
  if (!aiBaseUrl) {
    fakeOllama = new FakeOllamaServer();
    fakeOllama.addAnswer("rifugio", "In caso di emergenza in un rifugio alpino, contatta il soccorso alpino al 118.");
    fakeOllama.addAnswer("italia", "L'Italia e' una repubblica parlamentare in Europa meridionale.");
    fakeOllama.setDefaultAnswer("Non ho una risposta pronta per questo (risposta simulata, nessun modello reale).");
    await fakeOllama.start();
    aiBaseUrl = `http://127.0.0.1:${fakeOllama.port}`;
    console.log(`Fake Ollama server (no --ai-url given): ${aiBaseUrl}`);
  }

  const node = new NomadNode({ displayName: args.id ?? `GATEWAY-${port}` });
  node.addTransport(new TcpTransport(node.nodeId, port));
  await node.start();

  const kiwixGateway = new KiwixGateway(node, nomadBaseUrl);
  const published = await kiwixGateway.syncCatalog();
  kiwixGateway.registerSearchService();

  const aiGateway = new AiGateway(node, aiBaseUrl);
  aiGateway.registerAiService();

  console.log("Nomad-Net NOMAD Gateway");
  console.log(`Node ID: ${node.nodeId}`);
  console.log(`Listening on port: ${port}`);
  console.log(`Published ${published.length} article(s) from NOMAD:`);
  for (const entry of published) console.log(`  content://${entry.path} -> ${entry.contentId.slice(0, 16)}...`);
  console.log(`Registered service://kiwix-search`);
  console.log(`Registered service://ai`);

  const shutdown = async (): Promise<void> => {
    await node.stop();
    if (fakeServer) await fakeServer.stop();
    if (fakeOllama) await fakeOllama.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
