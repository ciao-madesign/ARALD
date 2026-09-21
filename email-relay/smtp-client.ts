import { randomBytes } from "node:crypto";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * A minimal SMTP client written from scratch (`CLAUDE.md`, "nessuna nuova
 * dipendenza esterna senza necessità reale") — same posture as `qrcode.ts`/
 * `rss-feed.ts`/the SX126x bridge protocol elsewhere in this project.
 *
 * Deliberately **implicit TLS from the first byte** (SMTPS, historically
 * port 465), not STARTTLS (plaintext connection upgraded to TLS mid-stream,
 * historically port 587): both give the same transport security, but
 * STARTTLS requires re-issuing EHLO after the upgrade and a plaintext
 * window before it that a client has to get exactly right — implicit TLS
 * has no upgrade dance to get wrong. Both are equally supported by
 * mainstream providers (Gmail included) — chosen for less code and less
 * risk to hand-write correctly, not because STARTTLS doesn't work.
 *
 * Only `AUTH PLAIN` is implemented (not `AUTH LOGIN` or OAuth) — the
 * simplest mechanism a single pre-configured account can use, widely
 * supported (Gmail app passwords included).
 *
 * **Not verified against a real SMTP server in this session** (no internet
 * access in this environment) — verified only against `fake-smtp-server.ts`
 * in this same directory, which models just enough of RFC 5321 to exercise
 * this client's exact command sequence.
 */

export interface SmtpConfig {
  host: string;
  /** Default 465 (implicit TLS/SMTPS) — not 587 (STARTTLS, unsupported here, see module doc comment). */
  port?: number;
  username: string;
  password: string;
  /** Skips certificate verification — for `fake-smtp-server.ts`'s self-signed test certificate only, never set against a real server. */
  rejectUnauthorized?: boolean;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export interface SmtpMessage {
  fromAddress: string;
  toAddress: string;
  subject: string;
  bodyText: string;
}

const DEFAULT_PORT = 465;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const CRLF = "\r\n";

/** Rejects an admin-configured address containing a raw CR/LF — cheap defense in depth against command injection into the SMTP command stream (`MAIL FROM`/`RCPT TO` are sent as one line each), even though these values come from the relay's own config file, not from the mesh. */
function assertNoLineBreak(value: string, fieldName: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`SMTP ${fieldName} must not contain a line break`);
  }
}

/** RFC 5322 §3.3 date format (e.g. "Wed, 21 Sep 2026 06:45:00 +0000") — not `Date.prototype.toUTCString()`, which ends in "GMT" (an obsolete zone name RFC 5322 only tolerates, never produces). */
function formatRfc5322Date(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/** RFC 5321 §4.5.2 dot-stuffing: a line starting with "." gets a second "." prepended, so it's never mistaken for the terminating "." line. Applied line-by-line, CRLF-normalized regardless of the input's own line endings. */
function dotStuff(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => (line.startsWith(".") ? "." + line : line))
    .join(CRLF);
}

const QP_LINE_LENGTH = 76;

/** Quoted-printable-encodes one line's UTF-8 bytes (RFC 2045 §6.7): any byte outside printable ASCII (and "=" itself) becomes "=XX" hex, and a trailing space/tab is also encoded so it survives MTAs that trim trailing whitespace. */
function quotedPrintableEncodeLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  let encoded = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    const isLast = i === bytes.length - 1;
    const isPrintableAscii = byte >= 0x21 && byte <= 0x7e && byte !== 0x3d;
    const isSafeWhitespace = (byte === 0x20 || byte === 0x09) && !isLast;
    encoded += isPrintableAscii || isSafeWhitespace ? String.fromCharCode(byte) : "=" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return softWrapQuotedPrintable(encoded);
}

/** Soft-wraps an already-encoded quoted-printable line at 76 octets (RFC 2045 §6.7) using a trailing "=" continuation, never splitting inside an "=XX" escape. */
function softWrapQuotedPrintable(encoded: string): string {
  const segments: string[] = [];
  let rest = encoded;
  while (rest.length > QP_LINE_LENGTH) {
    let cut = QP_LINE_LENGTH;
    if (rest[cut - 1] === "=") cut -= 1;
    else if (rest[cut - 2] === "=") cut -= 2;
    segments.push(rest.slice(0, cut) + "=");
    rest = rest.slice(cut);
  }
  segments.push(rest);
  return segments.join(CRLF);
}

/**
 * Quoted-printable-encodes the whole body (RFC 2045), line by line. Chosen
 * over declaring `Content-Transfer-Encoding: 8bit` because that would
 * require negotiating the 8BITMIME extension via EHLO first and falling
 * back otherwise — quoted-printable stays 7-bit-clean unconditionally, so
 * it needs no capability negotiation with the server and can't be silently
 * mangled by a strict receiving MTA. Necessary because message bodies are
 * plain UTF-8 text and routinely contain non-ASCII characters (accented
 * Italian text — "città", "è arrivato" — given this project's user base).
 */
function quotedPrintableEncode(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map(quotedPrintableEncodeLine)
    .join(CRLF);
}

function buildMessageSource(message: SmtpMessage): string {
  const headers = [
    `From: ${message.fromAddress}`,
    `To: ${message.toAddress}`,
    `Subject: ${message.subject}`,
    `Date: ${formatRfc5322Date(new Date())}`,
    `Message-ID: <${randomBytes(16).toString("hex")}@arald-email-relay>`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: quoted-printable`,
  ].join(CRLF);
  return headers + CRLF + CRLF + dotStuff(quotedPrintableEncode(message.bodyText));
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

/**
 * Line-buffered reader over the TLS socket — a single SMTP response can
 * arrive as one or more TCP chunks, and a multiline response (`250-...`
 * continuing, `250 ...` ending) can span several. Accumulates raw bytes
 * until a complete response (its final line uses a space, not a dash,
 * after the status code) is available.
 */
class SmtpResponseReader {
  private buffer = "";

  constructor(private readonly socket: TLSSocket) {
    socket.setEncoding("utf8");
  }

  read(timeoutMs: number): Promise<SmtpResponse> {
    return new Promise((resolve, reject) => {
      const tryParse = (): SmtpResponse | undefined => {
        const lines = this.buffer.split(CRLF);
        // The last element is either "" (buffer ends exactly on a CRLF) or a partial line still
        // arriving — either way, not yet a complete line, so it's excluded from parsing here and
        // left in the buffer for the next chunk.
        const complete = lines.slice(0, -1);
        if (complete.length === 0) return undefined;
        const last = complete[complete.length - 1];
        const match = /^(\d{3})([ -])/.exec(last);
        if (!match) throw new Error(`malformed SMTP response line: ${JSON.stringify(last)}`);
        if (match[2] === "-") return undefined; // more lines still coming
        const code = Number(match[1]);
        for (const line of complete) {
          const lineMatch = /^(\d{3})[ -](.*)$/.exec(line);
          if (!lineMatch || Number(lineMatch[1]) !== code) {
            throw new Error(`inconsistent status code across multiline SMTP response: ${JSON.stringify(complete)}`);
          }
        }
        this.buffer = lines[lines.length - 1];
        return { code, lines: complete.map((line) => line.slice(4)) };
      };

      const already = (() => {
        try {
          return tryParse();
        } catch (err) {
          reject(err as Error);
          return undefined;
        }
      })();
      if (already) {
        resolve(already);
        return;
      }

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for SMTP response"));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };
      const onData = (chunk: string): void => {
        this.buffer += chunk;
        let parsed: SmtpResponse | undefined;
        try {
          parsed = tryParse();
        } catch (err) {
          cleanup();
          reject(err as Error);
          return;
        }
        if (parsed) {
          cleanup();
          resolve(parsed);
        }
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("SMTP connection closed while waiting for a response"));
      };
      this.socket.on("data", onData);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
    });
  }
}

function expectCode(response: SmtpResponse, expected: number, step: string): void {
  if (response.code !== expected) {
    throw new Error(`SMTP ${step} failed: ${response.code} ${response.lines.join(" ")}`);
  }
}

/**
 * Sends one plain-text email over a fresh SMTP connection — connect, greet,
 * authenticate, envelope, body, quit. Every step is sequential and
 * single-shot (no pipelining, no connection reuse across calls) — this
 * relay sends one message at a time, simplicity over throughput.
 */
export async function sendEmail(config: SmtpConfig, message: SmtpMessage): Promise<void> {
  assertNoLineBreak(message.fromAddress, "from address");
  assertNoLineBreak(message.toAddress, "to address");
  assertNoLineBreak(message.subject, "subject");

  const commandTimeoutMs = config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const socket = await connectTls(config);
  const reader = new SmtpResponseReader(socket);
  try {
    expectCode(await reader.read(commandTimeoutMs), 220, "greeting");

    socket.write(`EHLO arald-email-relay${CRLF}`);
    expectCode(await reader.read(commandTimeoutMs), 250, "EHLO");

    const authPlain = Buffer.from(`\0${config.username}\0${config.password}`).toString("base64");
    socket.write(`AUTH PLAIN ${authPlain}${CRLF}`);
    expectCode(await reader.read(commandTimeoutMs), 235, "AUTH PLAIN");

    socket.write(`MAIL FROM:<${message.fromAddress}>${CRLF}`);
    expectCode(await reader.read(commandTimeoutMs), 250, "MAIL FROM");

    socket.write(`RCPT TO:<${message.toAddress}>${CRLF}`);
    expectCode(await reader.read(commandTimeoutMs), 250, "RCPT TO");

    socket.write(`DATA${CRLF}`);
    expectCode(await reader.read(commandTimeoutMs), 354, "DATA");

    const source = buildMessageSource(message);
    // The terminating "." must be alone on its own line: if the body already ends in CRLF (extremely
    // common — any bodyText ending in a newline), only "." + CRLF is needed; prepending an
    // unconditional CRLF here would insert a spurious blank line into the delivered message.
    const terminator = source.endsWith(CRLF) ? `.${CRLF}` : `${CRLF}.${CRLF}`;
    socket.write(source + terminator);
    expectCode(await reader.read(commandTimeoutMs), 250, "message body");

    socket.write(`QUIT${CRLF}`);
    // Best-effort — the message is already accepted (250 above); a slow/absent QUIT reply doesn't
    // undo that, so it isn't awaited with the same strictness as the steps above.
    await reader.read(commandTimeoutMs).catch(() => undefined);
  } finally {
    socket.destroy();
  }
}

function connectTls(config: SmtpConfig): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: config.host,
      port: config.port ?? DEFAULT_PORT,
      rejectUnauthorized: config.rejectUnauthorized ?? true,
      timeout: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    });
    const onceError = (err: Error): void => {
      socket.destroy();
      reject(err);
    };
    const onTimeout = (): void => onceError(new Error("timed out connecting to SMTP server"));
    socket.once("error", onceError);
    socket.once("timeout", onTimeout);
    socket.once("secureConnect", () => {
      socket.off("error", onceError);
      socket.off("timeout", onTimeout);
      // `timeout` here is a persistent idle-timer, not a one-shot connect timeout — left armed, it
      // would destroy an otherwise-healthy in-transaction connection on any later idle gap ≥
      // connectTimeoutMs, independent of and possibly shorter than the caller's commandTimeoutMs.
      // Per-command timeouts are already enforced separately by SmtpResponseReader.read(), so the
      // connect-phase idle timer is disabled entirely once the connection is established.
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}
