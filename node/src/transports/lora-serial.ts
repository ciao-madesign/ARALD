import { randomBytes } from "node:crypto";
import type { SerialPortStream } from "@serialport/stream";
import { MessageType, createPacket, decodePacket, encodePacket, type Packet } from "../packet.js";
import type { PacketHandler, PeerAddress, PeerConnectedHandler, PeerDisconnectedHandler, Transport } from "../transport.js";
import { FragmentReassembler, MAX_FRAGMENTS_PER_MESSAGE, type Fragment } from "./simulated-link.js";
import {
  BridgeCommand,
  BridgeFrameReader,
  BridgeStatus,
  encodeBridgeFrame,
  type BridgeFrame,
} from "./sx127x-bridge-protocol.js";
import {
  IrqFlag,
  LoraMode,
  REG_FIFO_ADDR_PTR,
  REG_FIFO_RX_BASE_ADDR,
  REG_FIFO_RX_CURRENT_ADDR,
  REG_FIFO_TX_BASE_ADDR,
  REG_FRF_LSB,
  REG_FRF_MID,
  REG_FRF_MSB,
  REG_IRQ_FLAGS,
  REG_MODEM_CONFIG_1,
  REG_MODEM_CONFIG_2,
  REG_MODEM_CONFIG_3,
  REG_OP_MODE,
  REG_PAYLOAD_LENGTH,
  REG_RX_NB_BYTES,
  REG_VERSION,
  SX127X_CHIP_VERSION,
  buildModemConfig1Byte,
  buildModemConfig2Byte,
  buildModemConfig3Byte,
  buildOpModeByte,
  frequencyToRegs,
} from "./sx127x-registers.js";

/**
 * First real (non-simulated) LoRa driver in this codebase, talking to an
 * SX127x chip over a serial bridge (`sx127x-bridge-protocol.ts`) instead of
 * `transports/lora.ts`'s in-process `SimulatedLinkTransport`. Why serial and
 * not direct SPI+GPIO, even though a bare Ra-02/RFM95 breakout is natively
 * an SPI+GPIO device: `docs/deployment.md` documents two ways to attach a
 * LoRa module to ARALD Box/Portable — a USB dongle, or a direct header
 * breakout — and only the first is portable across *both* targets. ARALD
 * Box (an SBC) has a GPIO header a direct breakout could use; ARALD
 * Portable is an arbitrary x86-64 PC that essentially never does. This
 * driver therefore assumes a module whose own firmware bridges USB↔serial↔
 * SPI to the chip (the shape of every common "LoRa USB dongle" — a small
 * MCU that speaks SPI to the radio and USB-serial to the host), the only
 * connectivity path that works on every documented target. See
 * `sx127x-bridge-protocol.ts`'s own doc comment for why that bridge
 * protocol is this project's own invention, never a real product's, while
 * `sx127x-registers.ts` — the chip semantics this driver actually issues
 * commands against — is faithful to the public Semtech datasheet.
 *
 * **Never verified against a real chip** (no hardware available in this
 * environment) — validated instead against `FakeSX127xSerialDevice`
 * (`tests/helpers/fake-sx127x-serial-device.ts`), which emulates the same
 * register/FIFO semantics this driver depends on. Same honest posture
 * `nomad-hub/docker-client.ts` had before it was confirmed against a real
 * Docker daemon — here there is no real chip in this session to confirm
 * against.
 *
 * Deliberate scope narrowing for this first slice, not physical law:
 * - **Exactly one peer connection at a time.** A single SX127x front-end is
 *   genuinely half-duplex (it's either transmitting or receiving, never
 *   both), but real hardware could still time-multiplex several peers the
 *   way a walkie-talkie can talk to more than one other radio over time —
 *   this driver doesn't attempt that yet, unlike the simulated LoRa
 *   transport's `maxConnections: 16` (a limit that only exists there as an
 *   anti-DoS bound, since nothing in a pure-JS simulation forces a
 *   half-duplex constraint at all). A second `connect()`/an inbound HELLO
 *   from a different peer while already connected is refused/ignored.
 * - **IRQ flags are polled, not interrupt-driven.** A production driver
 *   would watch the chip's `DIO0` pin edge (hardware interrupt, far more
 *   power-efficient); this invented serial bridge doesn't expose GPIO
 *   interrupts to the host at all, so `RegIrqFlags` is read on a timer
 *   instead — correct, just not how a real embedded driver would do it.
 * - **No RF measurement of any kind** (RSSI/SNR, real range/duty-cycle) —
 *   blocked on physical hardware, same limitation already declared for
 *   `docs/beacon.md`/`docs/test-protocol.md`.
 */
export interface LoraSerialTransportOptions {
  /** Carrier frequency in Hz — default 868.1 MHz, the EU868 default this codebase already uses elsewhere (`docs/beacon.md`'s regulatory-compliance section). */
  frequencyHz?: number;
  /** Channel bandwidth in Hz — one of the ten values `RegModemConfig1`'s `Bw` field supports (see `sx127x-registers.ts`'s `buildModemConfig1Byte`). Default 125 kHz, a common general-purpose choice. */
  bandwidthHz?: number;
  /** LoRa spreading factor, 6-12. Default 7 — shortest air time / shortest range of the supported range, a reasonable default for validating protocol correctness rather than maximizing range. */
  spreadingFactor?: number;
  /** Coding rate denominator (4/5..4/8). Default 5 (4/5), the lowest FEC overhead. */
  codingRateDenominator?: 5 | 6 | 7 | 8;
  /** Usable payload bytes per over-the-air fragment, after this driver's own 8-byte fragment header (`RADIO_HEADER_BYTES`). Default 200, matching `LoraSimulatedTransport`'s own MTU for continuity between the two. */
  mtu?: number;
  /** How long `connect()` waits for a peer to be heard before giving up — mirrors `CONNECT_TIMEOUT_MS` in every other transport in this codebase. */
  connectTimeoutMs?: number;
  /** How long a single bridge command (`sx127x-bridge-protocol.ts`) waits for its response before the link is considered dead. */
  commandTimeoutMs?: number;
  /** How often the RX poll loop reads `RegIrqFlags` — see the class doc comment's "IRQ flags are polled, not interrupt-driven" limitation. */
  pollIntervalMs?: number;
  /** How long a single fragment's TX cycle waits for `TxDone` before giving up. */
  txTimeoutMs?: number;
}

const DEFAULT_FREQUENCY_HZ = 868_100_000;
const DEFAULT_BANDWIDTH_HZ = 125_000;
const DEFAULT_SPREADING_FACTOR = 7;
const DEFAULT_CODING_RATE_DENOMINATOR = 5;
const DEFAULT_MTU = 200;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_COMMAND_TIMEOUT_MS = 2000;
const DEFAULT_POLL_INTERVAL_MS = 20;
const DEFAULT_TX_TIMEOUT_MS = 5000;

/** Shared single-buffer FIFO base for both TX and RX — always valid because this driver is never transmitting and receiving at once (see the class doc's half-duplex/single-connection scope). A production driver splitting the 256-byte FIFO into separate TX/RX halves would use two different base addresses instead. */
const FIFO_BASE_ADDR = 0x00;

/**
 * This transport's own over-the-air fragment header — `msgId` (4 random
 * bytes, unique enough for the lifetime of one connection, not a
 * cryptographic identifier) + `index` + `total` (2 bytes each, big-endian),
 * prepended to every fragment's bytes before it reaches the physical FIFO.
 * Necessary because, unlike `simulated-link.ts`'s `Fragment`, raw radio
 * bytes carry no metadata of their own — this is this driver's equivalent
 * of that in-process object's fields, just serialized.
 *
 * `index`/`total` are 2 bytes, not 1 — found by review: a single byte caps
 * a fragment count at 255, silently wrapping (not erroring) for anything
 * beyond it, and this codebase's own `FragmentReassembler`
 * (`simulated-link.ts`, reused as-is here) already assumes up to
 * `MAX_FRAGMENTS_PER_MESSAGE = 8192` is legitimate — a real catalog-sync
 * payload (`NomadNode.startCatalogSync()`, potentially thousands of content
 * ids) can genuinely need more than 255 fragments at this driver's MTU. Two
 * bytes covers the entire `MAX_FRAGMENTS_PER_MESSAGE` range with headroom;
 * `transmitPacket()` still asserts against it explicitly rather than
 * silently wrapping a second time if that bound ever changes.
 */
const RADIO_HEADER_BYTES = 8;
/**
 * `transmitPacket()`'s sender-side cap is `MAX_FRAGMENTS_PER_MESSAGE`
 * itself (imported from `simulated-link.ts`), not the wire encoding's own
 * larger 2-byte capacity (0xffff) — an earlier version checked against
 * 0xffff, which let a packet needing, say, 20000 fragments transmit
 * "successfully" from this driver's point of view while
 * `FragmentReassembler.addFragment()` silently rejected every single
 * fragment on arrival for exceeding *its* limit, with neither side ever
 * surfacing an error (found by review). Checking against the receiver's
 * real acceptance cap here means a too-large packet fails loudly, at the
 * sender, before a single fragment goes out.
 */
const MAX_RADIO_FRAGMENTS = MAX_FRAGMENTS_PER_MESSAGE;

function encodeRadioFragmentHeader(msgId: Buffer, index: number, total: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(index, 0);
  header.writeUInt16BE(total, 2);
  return Buffer.concat([msgId, header]);
}

function decodeRadioFragmentHeader(bytes: Buffer): { msgId: string; index: number; total: number; rest: Buffer } {
  return {
    msgId: bytes.subarray(0, 4).toString("hex"),
    index: bytes.readUInt16BE(4),
    total: bytes.readUInt16BE(6),
    rest: bytes.subarray(RADIO_HEADER_BYTES),
  };
}

/**
 * Talks the bridge protocol (`sx127x-bridge-protocol.ts`) over `stream`.
 * Exactly one command is ever outstanding at a time — `enqueue()` serializes
 * every call through a promise chain, since this invented protocol has no
 * request-id/correlation field to match an out-of-order response back to
 * its request (a deliberate simplification: this driver only ever issues
 * one command, awaits its response, then issues the next, so pipelining was
 * never needed).
 */
class Sx127xBridgeClient {
  private readonly reader = new BridgeFrameReader();
  private pending?: { resolve: (frame: BridgeFrame) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly stream: SerialPortStream,
    private readonly commandTimeoutMs: number,
  ) {
    stream.on("data", (chunk: Buffer) => this.handleData(chunk));
  }

  private handleData(chunk: Buffer): void {
    for (const frame of this.reader.push(chunk)) {
      if (!this.pending) continue; // a stray/unexpected frame — dropped, same "never trust unsolicited input" posture as every other transport here
      clearTimeout(this.pending.timer);
      const { resolve } = this.pending;
      this.pending = undefined;
      resolve(frame);
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run;
    return run;
  }

  private sendAndAwait(type: number, payload: Buffer): Promise<BridgeFrame> {
    return this.enqueue(
      () =>
        new Promise<BridgeFrame>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending = undefined;
            reject(new Error("SX127x bridge command timed out"));
          }, this.commandTimeoutMs);
          this.pending = { resolve, reject, timer };
          this.stream.write(encodeBridgeFrame(type, payload), (err) => {
            if (!err) return;
            clearTimeout(timer);
            this.pending = undefined;
            reject(err);
          });
        }),
    );
  }

  private expectOk(frame: BridgeFrame): void {
    if (frame.type !== BridgeStatus.OK) throw new Error(`SX127x bridge command failed (status 0x${frame.type.toString(16)})`);
  }

  async reset(): Promise<void> {
    this.expectOk(await this.sendAndAwait(BridgeCommand.RESET, Buffer.alloc(0)));
  }

  async readRegister(addr: number): Promise<number> {
    const frame = await this.sendAndAwait(BridgeCommand.READ_REG, Buffer.from([addr & 0xff]));
    this.expectOk(frame);
    if (frame.payload.length < 1) throw new Error("SX127x bridge: malformed READ_REG response");
    return frame.payload[0];
  }

  async writeRegister(addr: number, value: number): Promise<void> {
    this.expectOk(await this.sendAndAwait(BridgeCommand.WRITE_REG, Buffer.from([addr & 0xff, value & 0xff])));
  }

  async fifoWrite(bytes: Buffer): Promise<void> {
    this.expectOk(await this.sendAndAwait(BridgeCommand.FIFO_WRITE, bytes));
  }

  async fifoRead(count: number): Promise<Buffer> {
    const frame = await this.sendAndAwait(BridgeCommand.FIFO_READ, Buffer.from([count & 0xff]));
    this.expectOk(frame);
    if (frame.payload.length !== count) throw new Error("SX127x bridge: malformed FIFO_READ response");
    return frame.payload;
  }
}

interface ActiveConnection {
  peerId: string;
  reassembler: FragmentReassembler;
}

export class LoraSerialTransport implements Transport {
  readonly id = "lora-serial";

  private readonly bridge: Sx127xBridgeClient;
  private readonly frequencyHz: number;
  private readonly bandwidthHz: number;
  private readonly spreadingFactor: number;
  private readonly codingRateDenominator: 5 | 6 | 7 | 8;
  private readonly mtu: number;
  private readonly connectTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly txTimeoutMs: number;

  private readonly packetHandlers: PacketHandler[] = [];
  private readonly connectedHandlers: PeerConnectedHandler[] = [];
  private readonly disconnectedHandlers: PeerDisconnectedHandler[] = [];

  private started = false;
  private rxPollTimer?: NodeJS.Timeout;
  /** Guards the shared FIFO/mode registers against a TX cycle and the RX poll loop racing each other — both talk to the same physical chip. */
  private radioBusy: Promise<unknown> = Promise.resolve();
  /** `Date.now()` of the last completed fragment TX cycle, `0` before the first one ever — see `transmitFragmentBytes()`'s pacing. */
  private lastFragmentTransmittedAt = 0;
  private connection?: ActiveConnection;
  private pendingConnect?: { resolve: (peerId: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
  /** Whether this side has already sent its own HELLO for the current handshake — see `sendHelloOnce()`, mirrors `ConnectionEntry.helloSent` in `simulated-link.ts`. */
  private helloSent = false;
  /** Only set while no connection exists yet — reassembles whatever arrives before a peer is identified (e.g. the HELLO itself). Folded into `this.connection.reassembler` once identified so a mid-handshake multi-fragment message isn't lost. */
  private reassemblerForPendingConnect?: FragmentReassembler;

  constructor(
    private readonly localNodeId: string,
    private readonly stream: SerialPortStream,
    options: LoraSerialTransportOptions = {},
  ) {
    this.frequencyHz = options.frequencyHz ?? DEFAULT_FREQUENCY_HZ;
    this.bandwidthHz = options.bandwidthHz ?? DEFAULT_BANDWIDTH_HZ;
    this.spreadingFactor = options.spreadingFactor ?? DEFAULT_SPREADING_FACTOR;
    this.codingRateDenominator = options.codingRateDenominator ?? DEFAULT_CODING_RATE_DENOMINATOR;
    this.mtu = Math.max(1, options.mtu ?? DEFAULT_MTU);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.txTimeoutMs = options.txTimeoutMs ?? DEFAULT_TX_TIMEOUT_MS;
    this.bridge = new Sx127xBridgeClient(this.stream, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    // A permanent listener, not `.once()` — `waitForStreamOpen()` only ever attaches one for the
    // brief window before the stream opens (and only in the not-yet-open branch, never at all if the
    // caller hands in an already-open stream, the exact case every test in this codebase uses). An
    // 'error' event with zero listeners throws synchronously in Node and kills the whole process, not
    // just this transport (found by review) — a real disconnected/misbehaving USB-serial link must
    // degrade like every other transport's link failure in this codebase, never crash it. No further
    // recovery logic here (e.g. auto-reconnect): out of scope for this first slice, same as `stop()`
    // never attempting one.
    this.stream.on("error", () => {
      /* handled: prevents an unhandled 'error' event from crashing the process; the stream's own
         'close' event (not listened to separately here) is what a caller should use to notice the
         link is gone — out of scope to wire up further in this slice. */
    });
  }

  /**
   * Waits for `this.stream` to be open (it may already be, or may still be
   * auto-opening — the caller decides which; this transport never calls
   * `open()` itself, deliberately: it takes an already-constructed
   * `SerialPortStream` rather than a `path`/`binding` pair to build one from,
   * so a test can hold onto `stream.port` — the underlying `MockPortBinding`
   * when `binding: MockBinding` — and hand that same reference to
   * `FakeSX127xSerialDevice`; `MockBinding` only allows a single opener per
   * mock path, so the transport can't be the one calling `open()` if a test
   * also needs a handle on the result), resets the chip, checks its
   * version, and writes the modem configuration this instance was
   * constructed with.
   */
  async start(): Promise<void> {
    await this.waitForStreamOpen();

    await this.bridge.reset();
    const version = await this.bridge.readRegister(REG_VERSION);
    if (version !== SX127X_CHIP_VERSION) {
      throw new Error(
        `SX127x not responding as expected on this serial link (RegVersion read 0x${version.toString(16)}, expected 0x${SX127X_CHIP_VERSION.toString(16)}) — no chip present, wrong chip, or the bridge firmware isn't running`,
      );
    }

    const frf = frequencyToRegs(this.frequencyHz);
    await this.bridge.writeRegister(REG_FRF_MSB, frf.msb);
    await this.bridge.writeRegister(REG_FRF_MID, frf.mid);
    await this.bridge.writeRegister(REG_FRF_LSB, frf.lsb);
    await this.bridge.writeRegister(REG_MODEM_CONFIG_1, buildModemConfig1Byte(this.bandwidthHz, this.codingRateDenominator));
    await this.bridge.writeRegister(REG_MODEM_CONFIG_2, buildModemConfig2Byte(this.spreadingFactor));
    await this.bridge.writeRegister(REG_MODEM_CONFIG_3, buildModemConfig3Byte(this.bandwidthHz, this.spreadingFactor));
    await this.bridge.writeRegister(REG_FIFO_TX_BASE_ADDR, FIFO_BASE_ADDR);
    await this.bridge.writeRegister(REG_FIFO_RX_BASE_ADDR, FIFO_BASE_ADDR);
    await this.bridge.writeRegister(REG_OP_MODE, buildOpModeByte(LoraMode.STANDBY));
    await this.clearIrqFlags();

    this.started = true;
    await this.enterRxContinuous();
    this.rxPollTimer = setInterval(() => void this.pollForReceivedPacket(), this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.rxPollTimer) {
      clearInterval(this.rxPollTimer);
      this.rxPollTimer = undefined;
    }
    if (this.pendingConnect) {
      clearTimeout(this.pendingConnect.timer);
      this.pendingConnect.reject(new Error("LoRa transport stopped before identifying a peer"));
      this.pendingConnect = undefined;
    }
    if (this.connection) {
      const { peerId } = this.connection;
      this.connection = undefined;
      for (const handler of this.disconnectedHandlers) handler(peerId);
    }
    this.helloSent = false;
    this.reassemblerForPendingConnect = undefined;
  }

  private waitForStreamOpen(): Promise<void> {
    if (this.stream.isOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.stream.once("open", () => resolve());
      this.stream.once("error", (err) => reject(err));
    });
  }

  /**
   * LoRa has no per-device address to dial the way BLE's simulated `medium.find()`
   * does — `address` is accepted only to satisfy the `Transport` interface and is
   * otherwise ignored. `connect()` transmits one HELLO, then waits for the
   * ongoing RX poll loop (started in `start()`) to identify a peer from
   * whatever arrives next, exactly the same "first packet's `source` reveals
   * the peer" handshake every other transport in this codebase uses.
   */
  connect(_address: PeerAddress): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.started) {
        reject(new Error("LoRa serial transport not started"));
        return;
      }
      if (this.connection || this.pendingConnect) {
        reject(new Error("LoRa serial transport already connected or connecting — only one peer at a time in this version"));
        return;
      }
      // `pending` (not just `this.pendingConnect`) is what the timeout/catch handlers below check
      // themselves against before touching shared state — found by review: without that identity
      // check, a *stale* handler from an already-timed-out/failed attempt (e.g. its own
      // sendHelloOnce() finally settling well after the timeout already fired and a fresh connect()
      // retry is already under way) would unconditionally clear `this.pendingConnect`/`helloSent`,
      // potentially wiping out a newer, still-active attempt's state — including one that's actually
      // about to succeed, causing it to spuriously time out even though a peer really was identified.
      let pending!: { resolve: (peerId: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
      const timer = setTimeout(() => {
        if (this.pendingConnect !== pending) return; // superseded by a later attempt — not ours to touch
        this.pendingConnect = undefined;
        // Without this, a retried connect() after a timeout would find `helloSent` already true and
        // silently skip re-transmitting HELLO (found by review) — a courier-style radio link losing
        // its first handshake attempt to a transient gap is exactly the case worth retrying, and a
        // retry that never actually re-transmits anything can only succeed if the *other* side
        // happens to speak first.
        this.helloSent = false;
        reject(new Error("LoRa connect timeout: no peer heard"));
      }, this.connectTimeoutMs);
      pending = { resolve, reject, timer };
      this.pendingConnect = pending;

      this.sendHelloOnce().catch((err) => {
        if (this.pendingConnect !== pending) return; // superseded — see the timeout handler's comment above
        clearTimeout(timer);
        this.pendingConnect = undefined;
        this.helloSent = false; // same reasoning as the timeout branch above — a failed attempt must not block a retry
        reject(err as Error);
      });
    });
  }

  /** Sends this side's own HELLO exactly once per handshake — called eagerly by `connect()` (the initiating side) and again, fire-and-forget, by `identifyPeer()` once a peer is heard (the accepting side's first chance to reply; a no-op if this side already sent one as the initiator). Mirrors `sendHelloOnce()`/`ConnectionEntry.helloSent` in `simulated-link.ts` exactly. */
  private async sendHelloOnce(): Promise<void> {
    if (this.helloSent) return;
    this.helloSent = true;
    const hello = createPacket({ type: MessageType.HELLO, source: this.localNodeId, payload: {}, ttl: 1 });
    await this.transmitPacket(hello);
  }

  async send(peerId: string, packet: Packet): Promise<void> {
    if (!this.connection || this.connection.peerId !== peerId) {
      throw new Error(`no active LoRa connection to peer ${peerId}`);
    }
    await this.transmitPacket(packet);
  }

  /**
   * Fragments `packet` and transmits each fragment's full TX cycle serially
   * — unlike the simulated transport's concurrent `Promise.all()`, a real
   * half-duplex radio can only ever have one fragment in flight at a time.
   * Pacing between fragments (so a fast-following one never displaces a
   * still-unread one from the receiver's single hardware FIFO slot) lives
   * in `transmitFragmentBytes()` itself, not here — see that method's doc
   * comment for why it has to apply across separate `send()` calls too, not
   * just within one packet's own fragment loop.
   */
  private async transmitPacket(packet: Packet): Promise<void> {
    const encoded = Buffer.from(encodePacket(packet), "utf8");
    const usableBytes = Math.max(1, this.mtu - RADIO_HEADER_BYTES);
    const total = Math.max(1, Math.ceil(encoded.length / usableBytes));
    if (total > MAX_RADIO_FRAGMENTS) {
      throw new Error(`packet too large to fragment over this LoRa link: ${total} fragments needed, max ${MAX_RADIO_FRAGMENTS}`);
    }
    const msgId = randomBytes(4);
    for (let index = 0; index < total; index++) {
      const chunk = encoded.subarray(index * usableBytes, (index + 1) * usableBytes);
      const frame = Buffer.concat([encodeRadioFragmentHeader(msgId, index, total), chunk]);
      await this.withRadio(() => this.transmitFragmentBytes(frame));
    }
  }

  /** Serializes access to the shared chip/FIFO/mode registers between TX cycles and the RX poll loop — see `radioBusy`'s own doc comment. */
  private withRadio<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.radioBusy.then(fn, fn);
    this.radioBusy = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Transmits one already-headered fragment. Paced against
   * `lastFragmentTransmittedAt` — a minimum gap of `pollIntervalMs * 2`
   * since the *previous* fragment this transport sent, regardless of
   * whether it belonged to the same packet or a different one.
   *
   * Why unconditionally, not just between fragments of one `transmitPacket()`
   * call: the receiving side has exactly one hardware FIFO slot, drained by
   * its own poll loop, not an unbounded queue — sending a fragment before
   * that poll has had a real chance to run silently overwrites the
   * previous, still-unread one. Pacing only within a single packet's own
   * loop (an earlier version of this method did exactly that) still left
   * the same race reachable across two *separate* `send()` calls to the
   * same peer in quick succession — e.g. `NomadNode` firing off several
   * `void this.sendToPeer(...)` calls back to back — since nothing else
   * enforces a gap between them (found by review). Tracking the pacing
   * state here, at the point every fragment of every packet funnels
   * through regardless of call site, closes that gap for both cases at
   * once. Margin above exactly one poll interval because the receiver's
   * poll *tick* firing isn't the finish line — its whole async
   * register/FIFO round trip (several chained bridge commands) has to
   * complete too; cutting this too close reintroduced the same race
   * empirically during development.
   */
  private async transmitFragmentBytes(frame: Buffer): Promise<void> {
    const minGapMs = this.pollIntervalMs * 2;
    const elapsedSinceLastFragment = Date.now() - this.lastFragmentTransmittedAt;
    if (elapsedSinceLastFragment < minGapMs) await sleep(minGapMs - elapsedSinceLastFragment);

    await this.bridge.writeRegister(REG_OP_MODE, buildOpModeByte(LoraMode.STANDBY));
    await this.bridge.writeRegister(REG_FIFO_ADDR_PTR, FIFO_BASE_ADDR);
    await this.bridge.fifoWrite(frame);
    await this.bridge.writeRegister(REG_PAYLOAD_LENGTH, frame.length);
    await this.bridge.writeRegister(REG_OP_MODE, buildOpModeByte(LoraMode.TX));

    const deadline = Date.now() + this.txTimeoutMs;
    for (;;) {
      const irq = await this.bridge.readRegister(REG_IRQ_FLAGS);
      if (irq & IrqFlag.TX_DONE) {
        await this.bridge.writeRegister(REG_IRQ_FLAGS, IrqFlag.TX_DONE); // clear-on-write-1 (sx127x-registers.ts)
        break;
      }
      if (Date.now() > deadline) throw new Error("LoRa TX timed out waiting for TxDone");
      await sleep(this.pollIntervalMs);
    }
    await this.enterRxContinuous();
    this.lastFragmentTransmittedAt = Date.now();
  }

  private async enterRxContinuous(): Promise<void> {
    await this.bridge.writeRegister(REG_FIFO_ADDR_PTR, FIFO_BASE_ADDR);
    await this.bridge.writeRegister(REG_OP_MODE, buildOpModeByte(LoraMode.RX_CONTINUOUS));
  }

  private async clearIrqFlags(): Promise<void> {
    await this.bridge.writeRegister(REG_IRQ_FLAGS, 0xff); // every bit is clear-on-write-1; writing all-ones clears everything at once
  }

  /**
   * Polled on `pollIntervalMs` (see the class doc's declared IRQ-polling
   * limitation). Skips this tick entirely — rather than racing it — whenever
   * a TX cycle currently holds `radioBusy`, since a real chip mid-transmit
   * has no RX result to offer anyway.
   *
   * The entire body runs inside one try/catch — not just the first bridge
   * command — because this method is invoked from `setInterval` via a bare
   * `void this.pollForReceivedPacket()` (`start()`), with nothing external
   * ever awaiting or catching its result. A rejection from *any* of the
   * several bridge round trips below (a transient timeout on the IRQ-clear
   * write, the length/address reads, or the final `fifoRead`) would
   * otherwise propagate out of `withRadio()`'s returned promise as a
   * genuinely unhandled rejection — found by review: an unhandled rejection
   * crashes the process under Node's default `--unhandled-rejections=throw`,
   * exactly the "never a crash, always a recoverable failure" posture this
   * class's own doc comment promises, for the one code path (background RX
   * polling) with no caller able to catch it the way `send()`/`connect()`'s
   * callers can.
   */
  private async pollForReceivedPacket(): Promise<void> {
    if (!this.started) return;
    await this.withRadio(async () => {
      try {
        const irq = await this.bridge.readRegister(REG_IRQ_FLAGS);
        if (!(irq & IrqFlag.RX_DONE)) return;

        const hadCrcError = Boolean(irq & IrqFlag.PAYLOAD_CRC_ERROR);
        await this.bridge.writeRegister(REG_IRQ_FLAGS, IrqFlag.RX_DONE | IrqFlag.PAYLOAD_CRC_ERROR | IrqFlag.VALID_HEADER);
        if (hadCrcError) return; // corrupted over the air — never trust it, same posture as every malformed-input path in this codebase

        const length = await this.bridge.readRegister(REG_RX_NB_BYTES);
        const currentAddr = await this.bridge.readRegister(REG_FIFO_RX_CURRENT_ADDR);
        await this.bridge.writeRegister(REG_FIFO_ADDR_PTR, currentAddr);
        const bytes = await this.bridge.fifoRead(length);
        this.handleReceivedFrame(bytes);
      } catch {
        // link hiccup partway through this poll cycle — next tick tries again, same "recoverable,
        // not fatal" posture as every other transport in this codebase.
      }
    });
  }

  private handleReceivedFrame(frame: Buffer): void {
    if (frame.length <= RADIO_HEADER_BYTES) return; // too short to even carry a header — malformed, drop it
    const { msgId, index, total, rest } = decodeRadioFragmentHeader(frame);

    const connectionId = "lora-serial"; // constant: this transport only ever has one connection (class doc's scope note)
    if (!this.connection && !this.reassemblerForPendingConnect) {
      this.reassemblerForPendingConnect = new FragmentReassembler();
    }
    const reassembler = this.connection?.reassembler ?? this.reassemblerForPendingConnect!;

    const fragment: Fragment = { connectionId, msgId, index, total, bytes: Buffer.from(rest) };
    const reassembled = reassembler.addFragment(fragment);
    if (!reassembled) return;

    let packet: Packet;
    try {
      packet = decodePacket(reassembled.toString("utf8"));
    } catch {
      return; // malformed once fully reassembled — never trust it, same posture as every other transport's decodePacket try/catch
    }

    if (!this.connection) this.identifyPeer(packet.source);
    if (this.connection && this.connection.peerId === packet.source) {
      for (const handler of this.packetHandlers) handler(packet, packet.source);
    }
  }

  private identifyPeer(peerId: string): void {
    this.connection = { peerId, reassembler: this.reassemblerForPendingConnect ?? new FragmentReassembler() };
    this.reassemblerForPendingConnect = undefined;
    if (this.pendingConnect) {
      clearTimeout(this.pendingConnect.timer);
      this.pendingConnect.resolve(peerId);
      this.pendingConnect = undefined;
    }
    // This side's first chance to reply if it didn't already send one as the initiator (connect()).
    // `.catch()` here is required, not optional (found by review): unlike connect()'s own
    // sendHelloOnce() call, which has a `.catch()` on its result, this fire-and-forget call had none
    // — a TX failure on the reply (a bridge error, or txTimeoutMs elapsing) would otherwise be a
    // genuinely unhandled promise rejection, the same crash class fix 2 above exists to prevent for
    // pollForReceivedPacket(). Recoverable, not fatal: the initiator's own connect() simply times out
    // and can retry (now that a retry actually works, see connect()'s own fix).
    this.sendHelloOnce().catch(() => {});
    for (const handler of this.connectedHandlers) handler(peerId, undefined);
  }

  onPacket(handler: PacketHandler): void {
    this.packetHandlers.push(handler);
  }

  onPeerConnected(handler: PeerConnectedHandler): void {
    this.connectedHandlers.push(handler);
  }

  onPeerDisconnected(handler: PeerDisconnectedHandler): void {
    this.disconnectedHandlers.push(handler);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
