import { readFileSync } from "node:fs";
import path from "node:path";
import { createServer, type Server, type TLSSocket } from "node:tls";

const CRLF = "\r\n";

export interface FakeSmtpServerOptions {
  port?: number;
  host?: string;
  expectedUsername: string;
  expectedPassword: string;
  /** Defaults to `tests/helpers/fixtures/fake-smtp-cert.{pem,key}` — a committed test-only self-signed certificate (generated once via `openssl`, no runtime dependency), never a real server identity. */
  certPath?: string;
  keyPath?: string;
}

export interface ReceivedEmail {
  fromAddress: string;
  toAddress: string;
  subject: string;
  bodyText: string;
}

// `__dirname` (not `import.meta.url`): this file has no local `package.json` declaring `"type":
// "module"` (same as every other file directly under this folder), so both `tsc` (NodeNext module
// resolution) and `tsx` at runtime treat it as CommonJS, where `__dirname` is what's actually
// available — `import.meta` is a syntax error in that mode.
const DEFAULT_CERT_PATH = path.join(__dirname, "..", "tests", "helpers", "fixtures", "fake-smtp-cert.pem");
const DEFAULT_KEY_PATH = path.join(__dirname, "..", "tests", "helpers", "fixtures", "fake-smtp-cert.key");

type ConnState = "greeted" | "authenticated" | "mail" | "rcpt" | "data";

/**
 * Stands in for a real SMTP server (`smtp-client.ts`) — same role as
 * `gateway/nomad/fake-ollama-server.ts`/`whatsapp-relay/fake-whatsapp-cloud-server.ts`
 * for their own backends: a small, deterministic double just faithful
 * enough to exercise `sendEmail()`'s exact command sequence end to end,
 * never a real mail server. Implements only what that one client actually
 * sends — no pipelining, no capability negotiation beyond a fixed EHLO
 * reply, no mechanism but `AUTH PLAIN`.
 */
export class FakeSmtpServer {
  private readonly server: Server;
  private readonly expectedUsername: string;
  private readonly expectedPassword: string;
  private readonly received: ReceivedEmail[] = [];
  private boundPort: number | undefined;
  private nextMessageFailure: { code: number; message: string } | undefined;
  private nextAuthFailure = false;
  private pendingResponseDelayMs = 0;
  private capturedHeaderBlock: string | undefined;
  private readonly listenOptions: { port: number; host: string };

  constructor(options: FakeSmtpServerOptions) {
    this.expectedUsername = options.expectedUsername;
    this.expectedPassword = options.expectedPassword;
    const cert = readFileSync(options.certPath ?? DEFAULT_CERT_PATH);
    const key = readFileSync(options.keyPath ?? DEFAULT_KEY_PATH);
    this.server = createServer({ cert, key }, (socket) => this.handleConnection(socket));
    this.listenOptions = { port: options.port ?? 0, host: options.host ?? "127.0.0.1" };
  }

  get port(): number {
    return this.boundPort ?? this.listenOptions.port;
  }

  /** Every email received so far, oldest first — a copy, never the live internal array. */
  get emails(): readonly ReceivedEmail[] {
    return [...this.received];
  }

  /** Raw header block (as received on the wire, before the blank-line separator) of the most recently accepted message — test-only introspection, kept out of `ReceivedEmail`/`emails` so existing exact-equality assertions on it stay unaffected. */
  get lastHeaderBlock(): string | undefined {
    return this.capturedHeaderBlock;
  }

  /** Delays every response line by `ms` until consumed, one response at a time — lets a test simulate a slow-but-alive server (e.g. a slow AUTH/DATA reply) to exercise timeout handling on the client. */
  delayNextResponseMs(ms: number): void {
    this.pendingResponseDelayMs = ms;
  }

  /** The *next* message accepted through `DATA` is rejected with this SMTP code/message instead — resets itself after being consumed once. */
  failNextMessage(code: number, message: string): void {
    this.nextMessageFailure = { code, message };
  }

  /** The *next* `AUTH PLAIN` attempt fails regardless of the credentials presented — resets itself after being consumed once. */
  failNextAuth(): void {
    this.nextAuthFailure = true;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.listenOptions.port, this.listenOptions.host, () => {
        const address = this.server.address();
        this.boundPort = typeof address === "object" && address !== null ? address.port : this.listenOptions.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handleConnection(socket: TLSSocket): void {
    let state: ConnState = "greeted";
    let buffer = "";
    let pendingFrom = "";
    let pendingTo = "";
    let dataLines: string[] = [];

    const respond = (line: string): void => {
      if (this.pendingResponseDelayMs > 0) {
        const delay = this.pendingResponseDelayMs;
        this.pendingResponseDelayMs = 0;
        setTimeout(() => socket.write(line), delay);
        return;
      }
      socket.write(line);
    };

    socket.setEncoding("utf8");
    respond(`220 fake-smtp ready${CRLF}`);

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf(CRLF)) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + CRLF.length);
        handleLine(line);
      }
    });

    const handleLine = (line: string): void => {
      if (state === "data") {
        if (line === ".") {
          finishData();
          return;
        }
        // RFC 5321 §4.5.2 de-stuffing: a leading ".." on the wire means a literal single "." at the
        // start of that line's real content.
        dataLines.push(line.startsWith("..") ? line.slice(1) : line);
        return;
      }

      const command = line.slice(0, 4).toUpperCase();
      if (command === "EHLO") {
        state = "greeted";
        respond(`250 fake-smtp Hello${CRLF}`);
      } else if (command === "AUTH") {
        const b64 = line.slice(line.indexOf(" ", 5) + 1).trim();
        const decoded = Buffer.from(b64, "base64").toString("utf8");
        const parts = decoded.split("\0");
        const username = parts[1];
        const password = parts[2];
        if (this.nextAuthFailure) {
          this.nextAuthFailure = false;
          respond(`535 Authentication failed${CRLF}`);
        } else if (username === this.expectedUsername && password === this.expectedPassword) {
          state = "authenticated";
          respond(`235 Authentication successful${CRLF}`);
        } else {
          respond(`535 Authentication failed${CRLF}`);
        }
      } else if (command === "MAIL") {
        pendingFrom = extractAddress(line);
        state = "mail";
        respond(`250 OK${CRLF}`);
      } else if (command === "RCPT") {
        pendingTo = extractAddress(line);
        state = "rcpt";
        respond(`250 OK${CRLF}`);
      } else if (command === "DATA") {
        dataLines = [];
        state = "data";
        respond(`354 Start mail input${CRLF}`);
      } else if (command === "QUIT") {
        respond(`221 Bye${CRLF}`);
        socket.end();
      } else {
        respond(`500 unrecognized command${CRLF}`);
      }
    };

    const finishData = (): void => {
      state = "rcpt";
      if (this.nextMessageFailure) {
        const failure = this.nextMessageFailure;
        this.nextMessageFailure = undefined;
        respond(`${failure.code} ${failure.message}${CRLF}`);
        return;
      }
      const raw = dataLines.join(CRLF);
      const separatorIndex = raw.indexOf(CRLF + CRLF);
      const headerBlock = separatorIndex === -1 ? raw : raw.slice(0, separatorIndex);
      const bodyText = separatorIndex === -1 ? "" : raw.slice(separatorIndex + 2 * CRLF.length);
      const subjectLine = headerBlock.split(CRLF).find((l) => l.toLowerCase().startsWith("subject:"));
      const subject = subjectLine ? subjectLine.slice(subjectLine.indexOf(":") + 1).trim() : "";
      this.capturedHeaderBlock = headerBlock;
      this.received.push({ fromAddress: pendingFrom, toAddress: pendingTo, subject, bodyText });
      respond(`250 OK message accepted${CRLF}`);
    };
  }
}

/** Extracts the address between `<` and `>` from a `MAIL FROM:<...>`/`RCPT TO:<...>` command line. */
function extractAddress(line: string): string {
  const match = /<([^>]*)>/.exec(line);
  return match ? match[1] : "";
}
