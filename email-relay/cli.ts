import { readFileSync } from "node:fs";
import path from "node:path";
import { FakeSmtpServer } from "./fake-smtp-server.js";
import { loadOrCreateDestinationKeypair } from "./keypair.js";
import { EXTERNAL_DELIVERY_PATH, EmailRelayServer, type EmailRelayDestinationConfig } from "./server.js";
import type { SmtpConfig } from "./smtp-client.js";

/**
 * Entry point (`npm run email-relay -- --config relay.json`), mirrors
 * `whatsapp-relay/cli.ts` exactly. Reads a JSON config, resolves/persists
 * one X25519 key pair per destination (`keypair.ts`), starts
 * `EmailRelayServer`, and prints the exact `--external-delivery-destinations`
 * entry an admin needs to paste into their ARALD Box's own config for each
 * destination.
 *
 * `--fake-smtp` starts a `FakeSmtpServer` in this same process (TLS, using
 * the committed test certificate) and points the relay at it instead of a
 * real mail server — for a local demo/smoke test, never a real delivery,
 * same posture as `--fake-whatsapp`/`--fake-docker`.
 */

interface RelayConfigFile {
  host?: string;
  port?: number;
  smtp: { host: string; port?: number; username: string; password: string };
  fromAddress: string;
  destinations: Array<{ destinationId: string; label: string; toAddress: string; keyFile: string; subject?: string; password?: string }>;
}

const DEFAULT_SUBJECT = "Message via ARALD mesh";

function parseArgs(argv: string[]): { configPath: string; fakeSmtp: boolean } {
  let configPath: string | undefined;
  let fakeSmtp = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") configPath = argv[++i];
    else if (argv[i] === "--fake-smtp") fakeSmtp = true;
  }
  if (!configPath) throw new Error("usage: email-relay --config <file.json> [--fake-smtp]");
  return { configPath, fakeSmtp };
}

async function main(): Promise<void> {
  const { configPath, fakeSmtp } = parseArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(configPath, "utf8")) as RelayConfigFile;
  const configDir = path.dirname(path.resolve(configPath));

  let smtp: SmtpConfig;
  let fakeServer: FakeSmtpServer | undefined;
  if (fakeSmtp) {
    fakeServer = new FakeSmtpServer({ expectedUsername: config.smtp.username, expectedPassword: config.smtp.password });
    await fakeServer.start();
    smtp = { host: "127.0.0.1", port: fakeServer.port, username: config.smtp.username, password: config.smtp.password, rejectUnauthorized: false };
    console.log(`[email-relay] --fake-smtp: standing in for a real mail server on 127.0.0.1:${fakeServer.port} — no real email will ever be sent.`);
  } else {
    smtp = { host: config.smtp.host, port: config.smtp.port, username: config.smtp.username, password: config.smtp.password };
  }

  const destinations = new Map<string, EmailRelayDestinationConfig>();
  for (const entry of config.destinations) {
    const keyFile = path.isAbsolute(entry.keyFile) ? entry.keyFile : path.join(configDir, entry.keyFile);
    const identity = loadOrCreateDestinationKeypair(keyFile);
    destinations.set(entry.destinationId, { identity, toAddress: entry.toAddress, subject: entry.subject ?? DEFAULT_SUBJECT });
  }

  const server = new EmailRelayServer({ host: config.host, port: config.port, destinations, smtp, fromAddress: config.fromAddress });
  await server.start();
  console.log(`[email-relay] listening on port ${server.port}, path ${EXTERNAL_DELIVERY_PATH}`);
  console.log(`[email-relay] add each of these to the Box's --external-delivery-destinations file:\n`);
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
  console.error("[email-relay] fatal:", err);
  process.exit(1);
});
