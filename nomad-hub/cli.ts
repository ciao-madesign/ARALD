import { DockerClient, DEFAULT_DOCKER_SOCKET_PATH } from "./docker-client.js";
import { FakeDockerServer } from "./fake-docker-server.js";
import { ManagementServer, generateManagementPassword } from "./management-server.js";

/**
 * Local copy of `gateway/nomad/cli.ts`'s own `parseArgs()` (`--flag value`
 * or bare `--flag` → `"true"`) — duplicated rather than imported so
 * `nomad-hub/` has zero coupling to `gateway/nomad/`: see
 * `management-server.ts`'s class doc comment for the same reasoning
 * applied to `web-ui.ts`. This is a genuinely separate system (Docker/host
 * administration, never the mesh), not a variant of the NOMAD gateway.
 */
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
 * Entry point for the "NOMAD Management API" (`npm run hub`) —
 * `docs/deployment.md`'s "Il NOMAD Hub come sistema portatile", the
 * Docker/host-administration counterpart to `gateway/nomad/cli.ts`'s
 * mesh-facing NOMAD service gateway. Unlike every gateway there, this
 * never touches a `NomadNode`/the mesh at all — it only ever talks to a
 * Docker daemon (`DockerClient`) and serves `ManagementServer`'s HTTP API
 * for the separate `mobile/www/hub-control.html` page.
 *
 * Real Docker (`--docker-socket`, default `/var/run/docker.sock`) is the
 * default target — unlike `gateway:demo`'s "fake unless a real backend URL
 * is given" pattern, there's no URL to omit here: the whole point of this
 * process is administering whatever Docker daemon already runs on this
 * host, so pointing at a fake one needs an explicit opt-in (`--fake-docker`)
 * rather than being the default nothing-configured behavior.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port ?? 8420);
  const managementPassword = args["management-password"] ?? generateManagementPassword();

  let fakeDocker: FakeDockerServer | undefined;
  let docker: DockerClient;
  if (args["fake-docker"] !== undefined) {
    fakeDocker = new FakeDockerServer();
    fakeDocker.addContainer({ id: "demo-core", name: "nomad-hub-core-demo", image: "nomad-net/core:latest", state: "running", logLines: ["core avviato", "in ascolto sulla mesh"] });
    fakeDocker.addContainer({ id: "demo-kiwix", name: "nomad-hub-kiwix-demo", image: "nomad-net/kiwix:latest", state: "exited", logLines: ["kiwix arrestato"] });
    await fakeDocker.start();
    docker = new DockerClient({ host: "127.0.0.1", port: fakeDocker.port });
    console.log(`Fake Docker server (--fake-docker dato): 127.0.0.1:${fakeDocker.port}`);
  } else {
    const socketPath = args["docker-socket"] ?? DEFAULT_DOCKER_SOCKET_PATH;
    docker = new DockerClient({ socketPath });
    console.log(`Connessione al Docker Engine reale su ${socketPath}`);
  }

  const containerNamePrefix = args["container-prefix"];
  const capabilityStoragePath = args["capability-storage-path"];
  const host = args["host"];
  const server = new ManagementServer(docker, { port, host, managementPassword, containerNamePrefix, capabilityStoragePath });
  await server.start();

  console.log("NOMAD Hub Management API");
  const boundHost = host ?? "127.0.0.1";
  console.log(`Ascolto su: http://${boundHost}:${server.port}`);
  if (!host) {
    console.log(`Nota: --host non impostato, quindi in ascolto solo su 127.0.0.1 — un telefono sulla stessa Wi-Fi non può ancora raggiungerlo.`);
  }
  // Never served over HTTP (management-server.ts's own doc comment explains why) — printed here only,
  // for whoever has console/SSH access to the process that just started.
  console.log(`Password di gestione: ${managementPassword}`);
  if (containerNamePrefix) {
    console.log(`Filtro container attivo: solo nomi con prefisso "${containerNamePrefix}"`);
  } else {
    console.log("Nessun filtro container: ogni container del demone Docker e' gestibile da qui.");
  }
  console.log(`Profilo hardware su GET /api/hub/capabilities (storage riportato per: ${capabilityStoragePath ?? process.cwd()})`);

  const shutdown = async (): Promise<void> => {
    await server.stop();
    if (fakeDocker) await fakeDocker.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
