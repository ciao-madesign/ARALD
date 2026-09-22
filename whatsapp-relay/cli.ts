import { readFileSync } from "node:fs";
import path from "node:path";
import { loadOrCreateDestinationKeypair } from "./keypair.js";
import { FakeWhatsAppCloudServer } from "./fake-whatsapp-cloud-server.js";
import { EXTERNAL_DELIVERY_PATH, WhatsAppRelayServer, type WhatsAppRelayDestinationConfig } from "./server.js";
import type { WhatsAppCloudConfig } from "./whatsapp-client.js";

/**
 * Entry point (`npm run whatsapp-relay -- --config relay.json`, mirrors
 * `nomad-hub`'s `--fake-docker`/`gateway/nomad`'s demo `cli.ts`). Reads a
 * JSON config, resolves/persists one X25519 key pair per destination
 * (`keypair.ts`), starts `WhatsAppRelayServer`, and prints the exact
 * `--external-delivery-destinations` entry an admin needs to paste into
 * their ARALD Box's own config for each destination — the two processes
 * never talk to each other directly, this is purely operator convenience.
 *
 * `--fake-whatsapp` starts a `FakeWhatsAppCloudServer` in this same process
 * and points the relay at it instead of the real Meta API — for a local
 * demo/smoke test, never a real delivery, same posture as `--fake-docker`.
 */

interface RelayConfigFile {
  host?: string;
  port?: number;
  whatsapp: { phoneNumberId: string; accessToken: string; baseUrl?: string };
  destinations: Array<{ destinationId: string; label: string; toNumber: string; keyFile: string; password?: string }>;
}

function parseArgs(argv: string[]): { configPath: string; fakeWhatsApp: boolean } {
  let configPath: string | undefined;
  let fakeWhatsApp = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") configPath = argv[++i];
    else if (argv[i] === "--fake-whatsapp") fakeWhatsApp = true;
  }
  if (!configPath) throw new Error("usage: whatsapp-relay --config <file.json> [--fake-whatsapp]");
  return { configPath, fakeWhatsApp };
}

async function main(): Promise<void> {
  const { configPath, fakeWhatsApp } = parseArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(configPath, "utf8")) as RelayConfigFile;
  const configDir = path.dirname(path.resolve(configPath));

  let whatsapp: WhatsAppCloudConfig;
  let fakeServer: FakeWhatsAppCloudServer | undefined;
  if (fakeWhatsApp) {
    fakeServer = new FakeWhatsAppCloudServer({ expectedAccessToken: config.whatsapp.accessToken });
    await fakeServer.start();
    whatsapp = { phoneNumberId: config.whatsapp.phoneNumberId, accessToken: config.whatsapp.accessToken, baseUrl: fakeServer.baseUrl };
    console.log(`[whatsapp-relay] --fake-whatsapp: standing in for the real Meta API at ${fakeServer.baseUrl} — no real WhatsApp message will ever be sent.`);
  } else {
    whatsapp = {
      phoneNumberId: config.whatsapp.phoneNumberId,
      accessToken: config.whatsapp.accessToken,
      baseUrl: config.whatsapp.baseUrl ?? "https://graph.facebook.com/v19.0",
    };
  }

  const destinations = new Map<string, WhatsAppRelayDestinationConfig>();
  for (const entry of config.destinations) {
    const keyFile = path.isAbsolute(entry.keyFile) ? entry.keyFile : path.join(configDir, entry.keyFile);
    const identity = loadOrCreateDestinationKeypair(keyFile);
    destinations.set(entry.destinationId, { identity, toNumber: entry.toNumber });
  }

  const server = new WhatsAppRelayServer({ host: config.host, port: config.port, destinations, whatsapp });
  await server.start();
  console.log(`[whatsapp-relay] listening on port ${server.port}, path ${EXTERNAL_DELIVERY_PATH}`);
  console.log(`[whatsapp-relay] add each of these to the Box's --external-delivery-destinations file:\n`);
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
  console.error("[whatsapp-relay] fatal:", err);
  process.exit(1);
});
