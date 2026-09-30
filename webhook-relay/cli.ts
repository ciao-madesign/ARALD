import { readFileSync } from "node:fs";
import path from "node:path";
import { FakeWebhookServer } from "./fake-webhook-server.js";
import { loadOrCreateDestinationKeypair } from "./keypair.js";
import { EXTERNAL_DELIVERY_PATH, WebhookRelayServer, type WebhookRelayDestinationConfig } from "./server.js";

/**
 * Entry point (`npm run webhook-relay -- --config relay.json`), mirrors
 * `whatsapp-relay/cli.ts`/`email-relay/cli.ts`. Reads a JSON config,
 * resolves/persists one X25519 key pair per destination (`keypair.ts`),
 * starts `WebhookRelayServer`, and prints the exact
 * `--external-delivery-destinations` entry an admin needs to paste into
 * their ARALD Box's own config for each destination.
 *
 * Unlike the other two relays, there is no single shared "backend config"
 * here — each destination carries its own `webhookUrl`/`authToken`, since
 * this relay is deliberately generic across whatever real external service
 * each one turns out to be.
 *
 * `--fake-webhook` starts one `FakeWebhookServer` in this same process and
 * points *every* destination at it (each on its own path, `/<destinationId>`)
 * instead of their real configured `webhookUrl` — for a local demo/smoke
 * test, never a real delivery, same posture as `--fake-whatsapp`/`--fake-smtp`.
 */

interface RelayConfigFile {
  host?: string;
  port?: number;
  destinations: Array<{ destinationId: string; label: string; webhookUrl: string; authToken?: string; keyFile: string; password?: string }>;
}

function parseArgs(argv: string[]): { configPath: string; fakeWebhook: boolean } {
  let configPath: string | undefined;
  let fakeWebhook = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") configPath = argv[++i];
    else if (argv[i] === "--fake-webhook") fakeWebhook = true;
  }
  if (!configPath) throw new Error("usage: webhook-relay --config <file.json> [--fake-webhook]");
  return { configPath, fakeWebhook };
}

async function main(): Promise<void> {
  const { configPath, fakeWebhook } = parseArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(configPath, "utf8")) as RelayConfigFile;
  const configDir = path.dirname(path.resolve(configPath));

  let fakeServer: FakeWebhookServer | undefined;
  if (fakeWebhook) {
    fakeServer = new FakeWebhookServer();
    await fakeServer.start();
    console.log(
      `[webhook-relay] --fake-webhook: standing in for every configured destination's real webhook at ${fakeServer.baseUrl} — no real HTTP request will ever reach a real external service.`,
    );
  }

  const destinations = new Map<string, WebhookRelayDestinationConfig>();
  for (const entry of config.destinations) {
    const keyFile = path.isAbsolute(entry.keyFile) ? entry.keyFile : path.join(configDir, entry.keyFile);
    const identity = loadOrCreateDestinationKeypair(keyFile);
    const webhookUrl = fakeServer ? `${fakeServer.baseUrl}/${entry.destinationId}` : entry.webhookUrl;
    destinations.set(entry.destinationId, { identity, webhookUrl, authToken: entry.authToken });
  }

  const server = new WebhookRelayServer({ host: config.host, port: config.port, destinations });
  await server.start();
  console.log(`[webhook-relay] listening on port ${server.port}, path ${EXTERNAL_DELIVERY_PATH}`);
  console.log(`[webhook-relay] add each of these to the Box's --external-delivery-destinations file:\n`);
  for (const entry of config.destinations) {
    const destination = destinations.get(entry.destinationId)!;
    console.log(
      JSON.stringify(
        {
          destinationId: entry.destinationId,
          label: entry.label,
          publicKeyHex: destination.identity.publicKeyHex,
          url: `http://<this-server-address>:${server.port}${EXTERNAL_DELIVERY_PATH}`,
          password: entry.password,
        },
        null,
        2,
      ),
    );
  }

  process.on("SIGINT", () => {
    void (async () => {
      await server.stop();
      if (fakeServer) await fakeServer.stop();
      process.exit(0);
    })();
  });
}

main().catch((err) => {
  console.error("[webhook-relay] fatal:", err);
  process.exit(1);
});
