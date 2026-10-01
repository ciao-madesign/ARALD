import { DiscoveryService } from "./server.js";

/**
 * Entry point (`npm run discovery-service -- --port 8450 [--admin-password <password>]`). Un servizio
 * di discovery non ha bisogno di un file di configurazione come `whatsapp-relay`/`email-relay` — solo
 * porta, host e una password admin facoltativa — quindi usa semplici flag CLI invece di `--config`.
 */

function parseArgs(argv: string[]): { port: number; host: string; adminPassword: string | undefined } {
  let port = 8450;
  let host = "0.0.0.0"; // a differenza di web-ui.ts (loopback, un telefono sulla stessa LAN), questo servizio deve essere raggiungibile da Internet
  let adminPassword: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--host") host = argv[++i];
    else if (argv[i] === "--admin-password") adminPassword = argv[++i];
  }
  return { port, host, adminPassword };
}

async function main(): Promise<void> {
  const { port, host, adminPassword } = parseArgs(process.argv.slice(2));
  const service = new DiscoveryService({ port, host, adminPassword });
  await service.start();
  console.log(`[discovery-service] listening on ${host}:${service.port}`);
  if (adminPassword) {
    console.log("[discovery-service] admin verification enabled (POST /admin/verify)");
  } else {
    console.log("[discovery-service] no --admin-password set — /admin/verify disabled, nessuna voce pubblica potrà mai essere verificata su questa istanza");
  }

  process.on("SIGINT", () => {
    void (async () => {
      await service.stop();
      process.exit(0);
    })();
  });
}

main().catch((err) => {
  console.error("[discovery-service] fatal:", err);
  process.exit(1);
});
