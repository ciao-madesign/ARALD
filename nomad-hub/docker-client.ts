import { request as httpRequest, type IncomingMessage } from "node:http";

/**
 * Either the real Docker Engine API's Unix Domain Socket (production — the
 * daemon never listens on TCP unless an operator explicitly reconfigures
 * it, which this project doesn't ask anyone to do) or a `host`/`port` pair
 * (tests/demo, to reach `FakeDockerServer` — built on
 * `node/src/loopback-http-server.ts`'s `LoopbackHttpServer`, which is
 * TCP-only, so it can't be addressed by `socketPath`).
 */
export type DockerConnection = { socketPath: string } | { host: string; port: number };

export const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";

export interface DockerContainerSummary {
  id: string;
  name: string;
  image: string;
  /** Docker's own container state string: "running" | "exited" | "created" | "paused" | ... */
  state: string;
  /** Human-readable status Docker itself formats, e.g. "Up 5 minutes" or "Exited (0) 2 hours ago". */
  status: string;
  /** "none" when the image defines no HEALTHCHECK — Docker's own default, not something this client invents. */
  health: string;
}

export interface DockerContainerDetail extends DockerContainerSummary {
  pid: number;
  startedAt: string;
  /** Whether this container was created with a TTY attached — determines whether its log stream is multiplexed (see `getContainerLogs()`'s doc comment). */
  tty: boolean;
}

/** A non-2xx/204/304 response from the Docker Engine API — `statusCode` is Docker's own HTTP status, safe to pass straight through to an HTTP caller of this gateway. */
export class DockerApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/**
 * Minimal client for the subset of the Docker Engine API this project
 * needs (list/inspect/start/stop/restart/logs) — raw HTTP over the
 * daemon's Unix Domain Socket via `node:http`'s `socketPath` option, no
 * `dockerode`/SDK dependency. Same precedent as every gateway in
 * `gateway/nomad/` talking to *its* external backend with plain
 * `fetch`/`node:http` (`CLAUDE.md`: "nessuna dipendenza esterna senza
 * necessità reale") — the Docker Engine API is plain HTTP/JSON, and the
 * slice this project actually needs is small and stable, unlike a
 * general-purpose SDK's full surface (build contexts, swarm, volumes,
 * networks, exec streams, image management) that would go almost entirely
 * unused here.
 *
 * No request body size bounding here (unlike `readRequestBody()` in
 * `node/src/loopback-http-server.ts`, which guards against a hostile
 * mesh-facing client): the Docker daemon is a trusted local system this
 * code is a *client* of, not adversarial network input — the same trust
 * boundary every `gateway/nomad/*.ts` file already draws around its own
 * `fetch()` calls to Kiwix/Ollama/FlatNotes.
 */
export class DockerClient {
  constructor(private readonly connection: DockerConnection = { socketPath: DEFAULT_DOCKER_SOCKET_PATH }) {}

  async listContainers(): Promise<DockerContainerSummary[]> {
    const { statusCode, body } = await this.request("GET", "/containers/json?all=true");
    if (statusCode !== 200) throw new DockerApiError(extractErrorMessage(body), statusCode);
    const raw = JSON.parse(body.toString("utf8")) as RawContainerListEntry[];
    return raw.map(toSummary);
  }

  async inspectContainer(id: string): Promise<DockerContainerDetail> {
    const { statusCode, body } = await this.request("GET", `/containers/${encodeURIComponent(id)}/json`);
    if (statusCode !== 200) throw new DockerApiError(extractErrorMessage(body), statusCode);
    return toDetail(JSON.parse(body.toString("utf8")) as RawContainerInspect);
  }

  async startContainer(id: string): Promise<void> {
    await this.action(id, "start");
  }

  async stopContainer(id: string): Promise<void> {
    await this.action(id, "stop");
  }

  async restartContainer(id: string): Promise<void> {
    await this.action(id, "restart");
  }

  /**
   * Last `tail` lines of the container's combined stdout+stderr, as plain
   * text. A non-TTY container (the default for a long-running service
   * container, and every container `FakeDockerServer` simulates) has its
   * log stream multiplexed by Docker into 8-byte-header frames (verified
   * against a real local `dockerd` while designing this: `[streamType,
   * 0,0,0, sizeBE32]` followed by `size` bytes of payload) — `demuxLogStream()`
   * strips that framing. A TTY container's stream has no such framing (Docker
   * never multiplexes it, since a TTY only ever carries one combined
   * stream), so this checks `inspectContainer()`'s `tty` flag first rather
   * than assuming every container looks like the ones this project's own
   * `FakeDockerServer`/demo containers create.
   */
  async getContainerLogs(id: string, tail: number): Promise<string> {
    const detail = await this.inspectContainer(id);
    const { statusCode, body } = await this.request("GET", `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=${tail}`);
    if (statusCode !== 200) throw new DockerApiError(extractErrorMessage(body), statusCode);
    return detail.tty ? body.toString("utf8") : demuxLogStream(body);
  }

  private async action(id: string, verb: "start" | "stop" | "restart"): Promise<void> {
    const { statusCode, body } = await this.request("POST", `/containers/${encodeURIComponent(id)}/${verb}`);
    // 204 = the action was applied; 304 = the container was already in that state (Docker's own
    // convention for start/stop, verified against a real daemon) — neither is an error worth throwing on.
    if (statusCode !== 204 && statusCode !== 304) {
      throw new DockerApiError(extractErrorMessage(body), statusCode);
    }
  }

  private request(method: string, path: string): Promise<{ statusCode: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        "socketPath" in this.connection
          ? { socketPath: this.connection.socketPath, method, path, headers: { Host: "localhost" } }
          : { host: this.connection.host, port: this.connection.port, method, path, headers: { Host: "localhost" } },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
}

interface RawContainerListEntry {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Health?: { Status: string };
}

interface RawContainerInspect {
  Id: string;
  Name: string;
  Image: string;
  Config?: { Tty?: boolean };
  State: { Status: string; Pid: number; StartedAt: string; Health?: { Status: string } };
}

/** Docker's `Names` entries always have a leading `/` (e.g. `/nomad-hub-demo`) — verified against a real daemon. */
function stripLeadingSlash(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

function toSummary(raw: RawContainerListEntry): DockerContainerSummary {
  return {
    id: raw.Id,
    name: stripLeadingSlash(raw.Names[0] ?? raw.Id),
    image: raw.Image,
    state: raw.State,
    status: raw.Status,
    health: raw.Health?.Status ?? "none",
  };
}

function toDetail(raw: RawContainerInspect): DockerContainerDetail {
  return {
    id: raw.Id,
    name: stripLeadingSlash(raw.Name),
    image: raw.Image,
    state: raw.State.Status,
    status: raw.State.Status,
    health: raw.State.Health?.Status ?? "none",
    pid: raw.State.Pid,
    startedAt: raw.State.StartedAt,
    tty: raw.Config?.Tty ?? false,
  };
}

/** Docker's own error body shape on a non-2xx response, e.g. `{"message":"No such container: x"}` — verified against a real daemon. Falls back to the raw body (or a generic message for an empty one) if it isn't that shape, since a proxy/network error in front of the daemon wouldn't necessarily return Docker's own JSON. */
function extractErrorMessage(body: Buffer): string {
  const text = body.toString("utf8");
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.length > 0) return parsed.message;
  } catch {
    // not JSON — fall through to the raw text below
  }
  return text.length > 0 ? text : "Docker Engine API request failed";
}

/**
 * Strips Docker's log-stream multiplexing framing (`stdout`/`stderr`
 * interleaved as `[streamType(1), 0,0,0, sizeBE(4)]` + `size` bytes of
 * payload, repeated) down to plain concatenated text — verified frame-by-frame
 * against a real local `dockerd`'s `/containers/:id/logs` response while
 * designing this client. Malformed/truncated input (a frame header at the
 * very end with fewer than 8 bytes left, or claiming more payload than
 * remains) stops demuxing and returns what was decoded so far rather than
 * throwing — a partial log is more useful to an operator than an error, and
 * Docker itself is the only source of this data (see the class doc comment
 * on why it's trusted, not adversarial, input).
 */
function demuxLogStream(buffer: Buffer): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > buffer.length) break;
    parts.push(buffer.subarray(payloadStart, payloadEnd).toString("utf8"));
    offset = payloadEnd;
  }
  return parts.join("");
}
