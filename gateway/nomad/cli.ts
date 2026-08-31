import { NomadNode } from "../../node/src/node.js";
import { TcpTransport } from "../../node/src/transports/tcp.js";
import { FakeNomadServer } from "./fake-nomad-server.js";
import { KiwixGateway } from "./kiwix-gateway.js";
import { FakeOllamaServer } from "./fake-ollama-server.js";
import { AiGateway } from "./ai-gateway.js";
import { NewsGateway } from "./news-gateway.js";
import { InternetGateway } from "./internet-gateway.js";
import { registerTranslateService } from "./translate-gateway.js";
import { FakeFlatnotesServer } from "./fake-flatnotes-server.js";
import { FlatnotesGateway } from "./flatnotes-gateway.js";

/** How often NewsGateway re-syncs against `--news-url` when given (`docs/security.md`: "aggiornato ogni volta che si può"). */
const NEWS_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** How often NewsGateway regenerates its AI digest (`generateDigest()`) — deliberately less frequent than `NEWS_SYNC_INTERVAL_MS`, since a digest regeneration is a live `service://ai` call, not a cheap cache refresh. */
const NEWS_DIGEST_INTERVAL_MS = 15 * 60 * 1000;

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
 * registered when `--news-url` points at a real RSS/Atom feed URL; without
 * it, `service://news` simply isn't offered by this demo node, same as any
 * real deployment where no feed has been configured.
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

  let fakeFlatnotes: FakeFlatnotesServer | undefined;
  let flatnotesBaseUrl = args["flatnotes-url"];
  if (!flatnotesBaseUrl) {
    fakeFlatnotes = new FakeFlatnotesServer();
    fakeFlatnotes.addNote({ path: "benvenuto", title: "Benvenuto", content: "Questo e' un quaderno condiviso: chiunque puo' leggere o aggiungere una nota." });
    fakeFlatnotes.addNote({ path: "regole-rifugio", title: "Regole del rifugio", content: "Silenzio dopo le 22, spegnere le luci comuni, richiudere il cancello." });
    await fakeFlatnotes.start();
    flatnotesBaseUrl = `http://127.0.0.1:${fakeFlatnotes.port}`;
    console.log(`Fake FlatNotes server (no --flatnotes-url given): ${flatnotesBaseUrl}`);
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

  // service://translation composes service://ai via node.callService() (translate-gateway.ts),
  // never a direct AiGateway reference — same pattern as NewsGateway.generateDigest() below.
  // Unconditional: no CLI flag of its own needed, it has no external URL — it just needs
  // service://ai to exist, which is already always registered above (real backend or fake).
  registerTranslateService(node);
  console.log("Registered service://translation (composes service://ai)");

  const flatnotesGateway = new FlatnotesGateway(node, flatnotesBaseUrl, {
    maxRequestsPerPeerPerWindow: parsePositiveInt(args["flatnotes-max-requests-per-peer"], 10, "flatnotes-max-requests-per-peer"),
    maxRequestsPerWindow: parsePositiveInt(args["flatnotes-max-requests-global"], 60, "flatnotes-max-requests-global"),
    windowMs: parsePositiveInt(args["flatnotes-window-ms"], 60_000, "flatnotes-window-ms"),
  });
  const publishedNotes = await flatnotesGateway.syncCatalog();
  flatnotesGateway.registerSearchService();
  flatnotesGateway.registerCreateService();
  console.log(`Published ${publishedNotes.length} note(s) from FlatNotes, registered service://flatnotes-search and service://flatnotes-create`);

  let newsGateway: NewsGateway | undefined;
  const newsFeedUrl = args["news-url"];
  if (newsFeedUrl) {
    newsGateway = new NewsGateway(node, newsFeedUrl);
    try {
      await newsGateway.syncNews();
      newsGateway.registerNewsService();
      newsGateway.registerEmergencyNewsService();
      newsGateway.startAutoSync(NEWS_SYNC_INTERVAL_MS, (err) => console.error("service://news sync failed:", err));
      console.log(`Registered service://news and service://emergency-news (syncing every ${NEWS_SYNC_INTERVAL_MS / 1000}s from ${newsFeedUrl})`);

      // service://ai is already registered locally above (aiGateway.registerAiService()), so this
      // composes the two gateways via the mesh's own service-call mechanism rather than a direct
      // reference between the classes — see generateDigest()'s doc comment. A failed initial digest
      // (AI backend momentarily unreachable) doesn't take down service://news itself — it just
      // starts without one, same "tolerate a flaky upstream" posture as everything else here.
      // startDigestAutoRefresh() is armed unconditionally (found by review: an earlier version only
      // armed it inside the try, so a failed *initial* attempt left service://news with no digest —
      // and no way to ever get one — for the rest of the process's life, even once the AI backend
      // recovered) — its own onError keeps retrying every interval regardless of how the first call went.
      try {
        await newsGateway.generateDigest();
        console.log(`Generated initial news digest (refreshing every ${NEWS_DIGEST_INTERVAL_MS / 1000}s)`);
      } catch (err) {
        console.error("initial news digest generation failed (will keep retrying):", err);
      }
      newsGateway.startDigestAutoRefresh(NEWS_DIGEST_INTERVAL_MS, (err) => console.error("news digest generation failed:", err));
    } catch (err) {
      console.error(`service://news not registered — initial sync against ${newsFeedUrl} failed:`, err);
      newsGateway = undefined;
    }
  } else {
    console.log(`service://news not registered — no --news-url given (an RSS/Atom feed URL)`);
  }

  // Opt-in, same posture as --news-url: nothing about "Internet senza Internet" is offered unless
  // an operator explicitly asks for it (docs/next-steps.md, discussione 25 agosto 2026). --internet-fetch
  // enables kind: "rss" (gated only by the SSRF guard + parseFeed() itself); --internet-allowed-hosts
  // (comma-separated) is required in addition for kind: "text" to ever succeed — no default list is
  // shipped, the operator decides what they trust.
  if (args["internet-fetch"] !== undefined) {
    const allowedTextHosts = (args["internet-allowed-hosts"] ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    const internetGateway = new InternetGateway(node, {
      allowedTextHosts,
      maxRequestsPerPeerPerWindow: parsePositiveInt(args["internet-max-requests-per-peer"], 10, "internet-max-requests-per-peer"),
      maxRequestsPerWindow: parsePositiveInt(args["internet-max-requests-global"], 60, "internet-max-requests-global"),
      windowMs: parsePositiveInt(args["internet-window-ms"], 60_000, "internet-window-ms"),
      maxResponseBytes: parsePositiveInt(args["internet-max-response-bytes"], 1_000_000, "internet-max-response-bytes"),
    });
    internetGateway.registerInternetFetchService();
    console.log(
      `Registered service://internet-fetch (kind: rss always available; kind: text allowed hosts: ${allowedTextHosts.length > 0 ? allowedTextHosts.join(", ") : "(nessuno — kind: text sempre rifiutato)"})`,
    );
  } else {
    console.log(`service://internet-fetch not registered — no --internet-fetch given`);
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
    newsGateway?.stopDigestAutoRefresh();
    await node.stop();
    if (fakeServer) await fakeServer.stop();
    if (fakeOllama) await fakeOllama.stop();
    if (fakeFlatnotes) await fakeFlatnotes.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
