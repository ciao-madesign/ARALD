import { afterEach, describe, expect, it } from "vitest";
import { arch, cpus, platform } from "node:os";
import { FakeDockerServer } from "../../nomad-hub/fake-docker-server.js";
import { DockerClient } from "../../nomad-hub/docker-client.js";
import { ManagementServer } from "../../nomad-hub/management-server.js";

/**
 * `ManagementServer`/`DockerClient` (`nomad-hub/`) — the NOMAD Hub's
 * Docker/host-administration API (`docs/deployment.md`, "Il NOMAD Hub come
 * sistema portatile"). Mocked against `FakeDockerServer` the same way every
 * `gateway/nomad/*.ts` gateway is mocked against its own `Fake*Server` (no
 * real Docker reachable in the automated test environment this suite runs
 * in by default — see `docs/security.md`'s entry for this component for
 * the separate manual verification done against a real local `dockerd`
 * while designing `DockerClient`'s log-demuxing/status-code handling).
 *
 * Unlike every `gateway/nomad/` test file, this never touches a `NomadNode`
 * — `ManagementServer` doesn't join the mesh at all, so these tests talk to
 * it via plain `fetch()`, the same way a real operator's phone would.
 */

function apiUrl(server: ManagementServer, path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

async function authedFetch(server: ManagementServer, path: string, password: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(server, path), {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${password}` },
  });
}

describe("NOMAD Hub Management API (mocked, no real Docker)", () => {
  let fakeDocker: FakeDockerServer | undefined;
  let server: ManagementServer | undefined;

  afterEach(async () => {
    await Promise.all([server?.stop(), fakeDocker?.stop()].filter(Boolean));
    fakeDocker = undefined;
    server = undefined;
  });

  async function setup(options?: {
    containerNamePrefix?: string;
    actionRateLimitWindowMs?: number;
    maxActionsPerWindow?: number;
    capabilityStoragePath?: string;
  }): Promise<{
    password: string;
  }> {
    fakeDocker = new FakeDockerServer();
    await fakeDocker.start();
    const docker = new DockerClient({ host: "127.0.0.1", port: fakeDocker.port });
    const password = "TEST-PASS";
    server = new ManagementServer(docker, { managementPassword: password, ...options });
    await server.start();
    return { password };
  }

  it("rejects a request with no Authorization header", async () => {
    const {} = await setup();
    const res = await fetch(apiUrl(server!, "/api/hub/status"));
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong password", async () => {
    await setup();
    const res = await authedFetch(server!, "/api/hub/status", "WRONG-PASS");
    expect(res.status).toBe(401);
  });

  it("lists containers with name/state/health", async () => {
    const { password } = await setup();
    fakeDocker!.addContainer({ id: "c1", name: "nomad-core", image: "nomad-net/core:latest", state: "running", health: "healthy" });
    fakeDocker!.addContainer({ id: "c2", name: "nomad-kiwix", image: "nomad-net/kiwix:latest", state: "exited" });

    const res = await authedFetch(server!, "/api/hub/status", password);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { containers: Array<{ id: string; name: string; state: string; health: string }> };
    expect(body.containers.map((c) => c.name).sort()).toEqual(["nomad-core", "nomad-kiwix"]);
    const core = body.containers.find((c) => c.name === "nomad-core")!;
    expect(core.state).toBe("running");
    expect(core.health).toBe("healthy");
  });

  it("start/stop/restart actually change the container's reported state", async () => {
    const { password } = await setup();
    fakeDocker!.addContainer({ id: "c1", name: "nomad-core", image: "x", state: "exited" });

    const start = await authedFetch(server!, "/api/hub/containers/nomad-core/start", password, { method: "POST" });
    expect(start.status).toBe(200);
    let status = await (await authedFetch(server!, "/api/hub/status", password)).json();
    expect(status.containers[0].state).toBe("running");

    const stop = await authedFetch(server!, "/api/hub/containers/nomad-core/stop", password, { method: "POST" });
    expect(stop.status).toBe(200);
    status = await (await authedFetch(server!, "/api/hub/status", password)).json();
    expect(status.containers[0].state).toBe("exited");

    const restart = await authedFetch(server!, "/api/hub/containers/nomad-core/restart", password, { method: "POST" });
    expect(restart.status).toBe(200);
    status = await (await authedFetch(server!, "/api/hub/status", password)).json();
    expect(status.containers[0].state).toBe("running");
  });

  it("starting an already-running container still answers 200 (Docker's own 304 'already in that state' isn't treated as an error)", async () => {
    const { password } = await setup();
    fakeDocker!.addContainer({ id: "c1", name: "nomad-core", image: "x", state: "running" });

    const res = await authedFetch(server!, "/api/hub/containers/nomad-core/start", password, { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("an action against an unknown container id/name answers 404, never reaching Docker", async () => {
    const { password } = await setup();
    const res = await authedFetch(server!, "/api/hub/containers/does-not-exist/start", password, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("a malformed percent-escape in the container id path segment answers 400 instead of crashing the server (regression: decodeURIComponent() threw an uncaught URIError)", async () => {
    const { password } = await setup();
    const malformedAction = await authedFetch(server!, "/api/hub/containers/%/start", password, { method: "POST" });
    expect(malformedAction.status).toBe(400);
    const malformedLogs = await authedFetch(server!, "/api/hub/containers/%/logs", password);
    expect(malformedLogs.status).toBe(400);

    // The server must still be alive and answering normal requests after both malformed ones above.
    const status = await authedFetch(server!, "/api/hub/status", password);
    expect(status.status).toBe(200);
  });

  it("fetches container logs, correctly demultiplexed from Docker's stream-framing format", async () => {
    const { password } = await setup();
    fakeDocker!.addContainer({ id: "c1", name: "nomad-core", image: "x", state: "running" });
    fakeDocker!.addLogLine("c1", "riga uno");
    fakeDocker!.addLogLine("c1", "riga due");

    const res = await authedFetch(server!, "/api/hub/containers/nomad-core/logs", password);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: string };
    expect(body.logs).toBe("riga uno\nriga due\n");
  });

  it("logs endpoint against an unknown container answers 404", async () => {
    const { password } = await setup();
    const res = await authedFetch(server!, "/api/hub/containers/does-not-exist/logs", password);
    expect(res.status).toBe(404);
  });

  it("containerNamePrefix hides out-of-prefix containers from status, and 404s any action/log request against one", async () => {
    const { password } = await setup({ containerNamePrefix: "nomad-" });
    fakeDocker!.addContainer({ id: "c1", name: "nomad-core", image: "x", state: "running" });
    fakeDocker!.addContainer({ id: "c2", name: "unrelated-service", image: "x", state: "running" });

    const status = await (await authedFetch(server!, "/api/hub/status", password)).json();
    expect(status.containers.map((c: { name: string }) => c.name)).toEqual(["nomad-core"]);

    const action = await authedFetch(server!, "/api/hub/containers/unrelated-service/stop", password, { method: "POST" });
    expect(action.status).toBe(404);

    const logs = await authedFetch(server!, "/api/hub/containers/unrelated-service/logs", password);
    expect(logs.status).toBe(404);
  });

  it("rate limit: rejects the (N+1)th control action from the same caller within the window, but never affects status/logs reads", async () => {
    const { password } = await setup({ maxActionsPerWindow: 2, actionRateLimitWindowMs: 60_000 });
    fakeDocker!.addContainer({ id: "c1", name: "nomad-core", image: "x", state: "running" });

    for (let i = 0; i < 2; i++) {
      const res = await authedFetch(server!, "/api/hub/containers/nomad-core/restart", password, { method: "POST" });
      expect(res.status).toBe(200);
    }
    const limited = await authedFetch(server!, "/api/hub/containers/nomad-core/restart", password, { method: "POST" });
    expect(limited.status).toBe(429);

    // Reads are never subject to the action rate limit.
    for (let i = 0; i < 5; i++) {
      const status = await authedFetch(server!, "/api/hub/status", password);
      expect(status.status).toBe(200);
    }
  });

  it("CORS: an unconditional Allow-Origin header, and a working OPTIONS preflight — mirrors web-ui.ts's own reasoning (the mobile Control UI page is a different origin)", async () => {
    await setup();
    const res = await authedFetch(server!, "/api/hub/status", "wrong-password-still-gets-cors");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const preflight = await fetch(apiUrl(server!, "/api/hub/status"), { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("log tail is clamped to MAX_LOG_TAIL (1000) instead of accepting an unbounded value", async () => {
    const { password } = await setup();
    fakeDocker!.addContainer({ id: "c1", name: "nomad-core", image: "x", state: "running" });
    // More lines than MAX_LOG_TAIL — the only way to actually distinguish "clamped to 1000" from
    // "not clamped at all" (a prior version of this test only seeded 10 lines, so both cases would
    // return the same 10-line result and the assertion couldn't tell them apart — found by review).
    for (let i = 0; i < 1005; i++) fakeDocker!.addLogLine("c1", `riga ${i}`);

    const res = await authedFetch(server!, "/api/hub/containers/nomad-core/logs?tail=999999999", password);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: string };
    expect(body.logs.split("\n").filter(Boolean)).toHaveLength(1000); // clamped, not all 1005

    // A default (no `tail` param) request is clamped to DEFAULT_LOG_TAIL (200), independently of
    // MAX_LOG_TAIL — proves the two constants are both actually wired in, not just one of them.
    const defaultRes = await authedFetch(server!, "/api/hub/containers/nomad-core/logs", password);
    const defaultBody = (await defaultRes.json()) as { logs: string };
    expect(defaultBody.logs.split("\n").filter(Boolean)).toHaveLength(200);
  });

  it("a TTY-attached container's un-multiplexed log stream is returned as-is, not corrupted by attempting to demux it", async () => {
    // Regression coverage (found by review): FakeDockerServer used to hardcode Config.Tty: false
    // for every container, so DockerClient.getContainerLogs()'s "skip demuxLogStream() for a TTY
    // container" branch had zero test coverage — a regression there (e.g. always demuxing
    // regardless of the tty flag) would silently corrupt logs for any real TTY container and no
    // test would have caught it.
    const { password } = await setup();
    fakeDocker!.addContainer({ id: "c1", name: "nomad-tty", image: "x", state: "running", tty: true });
    fakeDocker!.addLogLine("c1", "riga tty uno");
    fakeDocker!.addLogLine("c1", "riga tty due");

    const res = await authedFetch(server!, "/api/hub/containers/nomad-tty/logs", password);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: string };
    expect(body.logs).toBe("riga tty uno\nriga tty due\n");
  });

  it("GET /api/hub/capabilities requires the management password, same as every other endpoint", async () => {
    await setup();
    const res = await fetch(apiUrl(server!, "/api/hub/capabilities"));
    expect(res.status).toBe(401);
  });

  it("GET /api/hub/capabilities reports real, verifiable host facts — not fabricated ones", async () => {
    const { password } = await setup();
    const res = await authedFetch(server!, "/api/hub/capabilities", password);
    expect(res.status).toBe(200);
    const profile = (await res.json()) as {
      architecture: string;
      platform: string;
      cpuCores: number;
      ramGb: number;
      networkInterfaces: string[];
      gpu: unknown;
      npu: unknown;
      bluetooth: unknown;
      usb3: unknown;
    };

    // Cross-checked against node:os directly, on the same process running the test — these must
    // match exactly, since getHardwareProfile() is just a thin wrapper around those same calls.
    expect(profile.architecture).toBe(arch());
    expect(profile.platform).toBe(platform());
    expect(profile.cpuCores).toBe(cpus().length);
    expect(profile.ramGb).toBeGreaterThan(0);
    expect(Array.isArray(profile.networkInterfaces)).toBe(true);

    // Never a guessed true/false — see capability-manager.ts's own doc comment for why.
    expect(profile.gpu).toBeNull();
    expect(profile.npu).toBeNull();
    expect(profile.bluetooth).toBeNull();
    expect(profile.usb3).toBeNull();
  });

  it("GET /api/hub/capabilities reports storage for capabilityStoragePath when given, falling back to null (never throwing) for a path that doesn't exist", async () => {
    const { password } = await setup({ capabilityStoragePath: process.cwd() });
    const res = await authedFetch(server!, "/api/hub/capabilities", password);
    const profile = (await res.json()) as { storage: { path: string; totalGb: number; freeGb: number } | null };
    expect(profile.storage).not.toBeNull();
    expect(profile.storage!.path).toBe(process.cwd());
    expect(profile.storage!.totalGb).toBeGreaterThan(0);

    // Explicitly torn down before the second setup() below — afterEach() only stops whichever
    // server/fakeDocker the module-level variables currently reference, so leaving this first pair
    // running would leak it (still listening) once setup() reassigns those variables.
    await server!.stop();
    await fakeDocker!.stop();

    await setup({ capabilityStoragePath: "/this/path/definitely/does/not/exist/anywhere" });
    const badRes = await authedFetch(server!, "/api/hub/capabilities", password);
    expect(badRes.status).toBe(200); // never a 500 — a bad storage path degrades to null, doesn't crash the endpoint
    const badProfile = (await badRes.json()) as { storage: unknown };
    expect(badProfile.storage).toBeNull();
  });

  it("GET /api/hub/capabilities works even when Docker itself is unreachable — it never touches DockerClient", async () => {
    const { password } = await setup();
    await fakeDocker!.stop(); // simulates Docker being down, without tearing down the ManagementServer itself
    const res = await authedFetch(server!, "/api/hub/capabilities", password);
    expect(res.status).toBe(200);

    // For contrast: /api/hub/status *does* depend on Docker, and correctly degrades to 502 here.
    const statusRes = await authedFetch(server!, "/api/hub/status", password);
    expect(statusRes.status).toBe(502);
  });
});
