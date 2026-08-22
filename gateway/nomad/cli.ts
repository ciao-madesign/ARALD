import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { FakeNomadServer } from "./fake-nomad-server.js";
import { KiwixGateway } from "./kiwix-gateway.js";
import { FakeOllamaServer } from "./fake-ollama-server.js";
import { AiGateway } from "./ai-gateway.js";
import { NewsGateway } from "./news-gateway.js";

/** How often NewsGateway re-syncs against `--news-url` when given (`docs/security.md`: "aggiornato ogni volta che si può"). */
const NEWS_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Default `maxContentStoreEntries` for this gateway's `NomadNode` (spec
 * §57 resource limits) — deliberately well above `content.ts`'s own
 * conservative default (256, sized for a generic mesh node's opportunistic
 * cache) since a gateway *is* its catalog: `KiwixGateway.syncCatalog()` and
 * `NewsGateway.startAutoSync()` both publish real content on an ongoing
 * basis, and this node's own published entries only ever compete with each
 * other for eviction once the store is full (`node.ts`'s
 * `OWN_CONTENT_TRUST_RANK` already keeps them ahead of anything merely
 * relay-cached). Still finite, not a return to the pre-bound "never
 * evicted" behavior those two gateways' doc comments used to describe — an
 * operator syncing a catalog larger than this needs `--max-content-entries`
 * sized accordingly.
 */
const DEFAULT_MAX_CONTENT_ENTRIES = 8192;

/**
 * Parses a `--flag` value as a positive integer, falling back to `fallback`
 * (with a warning) for anything else — a missing value (`parseArgs` stores
 * the literal string `"true"` for a flag with no following non-flag token),
 * a non-numeric typo, zero, or negative. Bare `Number()` would silently
 * produce `NaN` or a negative value instead, both of which defeat the whole
 * point of `--max-content-entries`: `NaN` disables `BoundedFifoMap`'s size
 * check entirely (both its bound comparisons are always false for `NaN`,
 * so it never evicts and grows unbounded again), and zero/negative makes
 * every `set()` silently no-op instead (`ContentStore.putVerified()` still
 * reports success either way, so a bad value fails silently rather than
 * loudly).
 */
function parsePositiveInt(raw: string | undefined, fallback: number, flagName: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`Invalid --${flagName} (${JSON.stringify(raw)}), expected a positive integer — using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

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
 * instead. `NewsGateway` has no fake fallback (`docs/security.md`) — only
 * registered when `--news-url` points at a real NOMAD news backend; without
 * it, `service://news` simply isn't offered by this demo node, same as any
 * real deployment where that particular NOMAD sub-service isn't running.
 * Not used by the automated test suite (tests/integration/nomad-gateway.test.ts,
 * ai-gateway.test.ts and news-gateway.test.ts build their own fixtures
 * directly), same relationship `tools/simulator/cli.ts` has to its own
 * `simulate.ts`.
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

  const maxContentStoreEntries = parsePositiveInt(args["max-content-entries"], DEFAULT_MAX_CONTENT_ENTRIES, "max-content-entries");
  const node = new NomadNode({ displayName: args.id ?? `GATEWAY-${port}`, maxContentStoreEntries });
  node.addTransport(new TcpTransport(node.nodeId, port));
  await node.start();

  const kiwixGateway = new KiwixGateway(node, nomadBaseUrl);
  const published = await kiwixGateway.syncCatalog();
  kiwixGateway.registerSearchService();

  const aiGateway = new AiGateway(node, aiBaseUrl);
  aiGateway.registerAiService();

  let newsGateway: NewsGateway | undefined;
  const newsBaseUrl = args["news-url"];
  if (newsBaseUrl) {
    newsGateway = new NewsGateway(node, newsBaseUrl);
    try {
      await newsGateway.syncNews();
      newsGateway.registerNewsService();
      newsGateway.startAutoSync(NEWS_SYNC_INTERVAL_MS, (err) => console.error("service://news sync failed:", err));
      console.log(`Registered service://news (syncing every ${NEWS_SYNC_INTERVAL_MS / 1000}s from ${newsBaseUrl})`);
    } catch (err) {
      console.error(`service://news not registered — initial sync against ${newsBaseUrl} failed:`, err);
      newsGateway = undefined;
    }
  } else {
    console.log(`service://news not registered — no --news-url given, and this gateway has no fake news backend`);
  }

  console.log("Nomad-Net NOMAD Gateway");
  console.log(`Node ID: ${node.nodeId}`);
  console.log(`Listening on port: ${port}`);
  console.log(`Published ${published.length} article(s) from NOMAD:`);
  for (const entry of published) console.log(`  content://${entry.path} -> ${entry.contentId.slice(0, 16)}...`);
  console.log(`Registered service://kiwix-search`);
  console.log(`Registered service://ai`);

  const shutdown = async (): Promise<void> => {
    newsGateway?.stopAutoSync();
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
