import type { IncomingMessage, ServerResponse } from "node:http";
import { LoopbackHttpServer, sendJson } from "../node/src/loopback-http-server.js";

/**
 * Stands in for a real Docker Engine API for tests/demo — same reasoning
 * as every other `Fake*Server` in `gateway/nomad/`, models only the
 * subset of endpoints `DockerClient` actually calls
 * (`GET /containers/json`, `GET /containers/:id/json`,
 * `POST /containers/:id/{start,stop,restart}`, `GET /containers/:id/logs`),
 * not a faithful reimplementation of the real Docker Engine API. Reached
 * via TCP in tests (`LoopbackHttpServer` is TCP-only), unlike the real
 * daemon's Unix Domain Socket — `DockerClient`'s `{ host, port }`
 * connection variant exists specifically for this.
 *
 * Log lines are served through the exact same 8-byte-frame multiplexing a
 * real non-TTY container's log stream uses (verified against a real local
 * `dockerd` while building `DockerClient`) — so `DockerClient.getContainerLogs()`'s
 * demuxing path is genuinely exercised by tests against this fake, not
 * bypassed by serving pre-demuxed plain text.
 */
export interface FakeContainerOptions {
  id: string;
  name: string;
  image: string;
  state?: "running" | "exited" | "created";
  health?: "none" | "healthy" | "unhealthy";
  logLines?: string[];
  /** Default `false` (the shape every container this project creates/simulates actually has). When `true`, `logLines` are served as plain concatenated text with no Docker multiplexing framing — genuinely exercises `DockerClient.getContainerLogs()`'s "skip demuxLogStream() for a TTY container" branch, which a fake that only ever reports `Tty: false` (as this one did before this option existed) left completely untested. */
  tty?: boolean;
}

interface FakeContainer {
  id: string;
  name: string;
  image: string;
  state: "running" | "exited" | "created";
  health: "none" | "healthy" | "unhealthy";
  pid: number;
  startedAt: string;
  logLines: string[];
  tty: boolean;
}

export interface FakeDockerServerOptions {
  port?: number;
  host?: string;
}

let nextPid = 1000;

export class FakeDockerServer {
  private readonly containers = new Map<string, FakeContainer>();
  private readonly httpServer: LoopbackHttpServer;

  constructor(options: FakeDockerServerOptions = {}) {
    this.httpServer = new LoopbackHttpServer((req, res) => void this.route(req, res), { port: options.port, host: options.host });
  }

  get port(): number {
    return this.httpServer.port;
  }

  addContainer(options: FakeContainerOptions): void {
    this.containers.set(options.id, {
      id: options.id,
      name: options.name,
      image: options.image,
      state: options.state ?? "created",
      health: options.health ?? "none",
      pid: options.state === "running" ? nextPid++ : 0,
      startedAt: options.state === "running" ? new Date().toISOString() : "0001-01-01T00:00:00Z",
      logLines: options.logLines ?? [],
      tty: options.tty ?? false,
    });
  }

  /** Appends one log line to a fake container — lets a test simulate log output arriving after the container was added. */
  addLogLine(id: string, line: string): void {
    this.containers.get(id)?.logLines.push(line);
  }

  async start(): Promise<void> {
    await this.httpServer.start();
  }

  async stop(): Promise<void> {
    await this.httpServer.stop();
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/containers/json") {
      sendJson(
        res,
        200,
        Array.from(this.containers.values(), (c) => ({
          Id: c.id,
          Names: [`/${c.name}`],
          Image: c.image,
          State: c.state,
          Status: describeStatus(c),
          Health: { Status: c.health, FailingStreak: 0 },
        })),
      );
      return;
    }

    const inspectMatch = /^\/containers\/([^/]+)\/json$/.exec(url.pathname);
    if (req.method === "GET" && inspectMatch) {
      const container = this.containers.get(inspectMatch[1]);
      if (!container) {
        sendJson(res, 404, { message: `No such container: ${inspectMatch[1]}` });
        return;
      }
      sendJson(res, 200, {
        Id: container.id,
        Name: `/${container.name}`,
        Image: container.image,
        Config: { Tty: container.tty },
        State: {
          Status: container.state,
          Pid: container.pid,
          StartedAt: container.startedAt,
          Health: { Status: container.health },
        },
      });
      return;
    }

    const actionMatch = /^\/containers\/([^/]+)\/(start|stop|restart)$/.exec(url.pathname);
    if (req.method === "POST" && actionMatch) {
      const container = this.containers.get(actionMatch[1]);
      if (!container) {
        sendJson(res, 404, { message: `No such container: ${actionMatch[1]}` });
        return;
      }
      this.applyAction(container, actionMatch[2] as "start" | "stop" | "restart", res);
      return;
    }

    const logsMatch = /^\/containers\/([^/]+)\/logs$/.exec(url.pathname);
    if (req.method === "GET" && logsMatch) {
      const container = this.containers.get(logsMatch[1]);
      if (!container) {
        sendJson(res, 404, { message: `No such container: ${logsMatch[1]}` });
        return;
      }
      const tail = Number(url.searchParams.get("tail") ?? container.logLines.length);
      const lines = container.logLines.slice(Math.max(0, container.logLines.length - tail));
      // A real TTY-attached container's log stream carries no multiplexing framing at all (Docker
      // only multiplexes stdout/stderr apart when there's no TTY to combine them into one stream) —
      // mirrored here so a client that (incorrectly) always demuxed would produce garbled output
      // against this branch, not just against a real daemon.
      const body = container.tty ? Buffer.from(lines.map((line) => `${line}\n`).join(""), "utf8") : Buffer.concat(lines.map((line) => muxLogFrame(`${line}\n`)));
      res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream", "Content-Length": body.length });
      res.end(body);
      return;
    }

    sendJson(res, 404, { message: "not found" });
  }

  private applyAction(container: FakeContainer, verb: "start" | "stop" | "restart", res: ServerResponse): void {
    // Same "already in that state -> 304" convention a real daemon uses for start/stop (verified
    // against a real local dockerd) — restart always succeeds regardless of current state, matching
    // that same verification.
    if (verb === "start") {
      if (container.state === "running") {
        res.writeHead(304).end();
        return;
      }
      container.state = "running";
      container.pid = nextPid++;
      container.startedAt = new Date().toISOString();
    } else if (verb === "stop") {
      if (container.state !== "running") {
        res.writeHead(304).end();
        return;
      }
      container.state = "exited";
      container.pid = 0;
    } else {
      container.state = "running";
      container.pid = nextPid++;
      container.startedAt = new Date().toISOString();
    }
    res.writeHead(204).end();
  }
}

function describeStatus(c: FakeContainer): string {
  if (c.state === "running") return "Up (simulato)";
  if (c.state === "exited") return "Exited (0) (simulato)";
  return "Created (simulato)";
}

/** Builds one Docker-style multiplexed log frame for stdout (`streamType` 1) — see `DockerClient`'s `demuxLogStream()` for the format this mirrors. */
function muxLogFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0); // stdout
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
