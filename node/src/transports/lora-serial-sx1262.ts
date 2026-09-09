import { randomBytes } from "node:crypto";
import type { SerialPortStream } from "@serialport/stream";
import { MessageType, createPacket, decodePacket, encodePacket, type Packet } from "../packet.js";
import type { PacketHandler, PeerAddress, PeerConnectedHandler, PeerDisconnectedHandler, Transport } from "../transport.js";
import { FragmentReassembler, MAX_FRAGMENTS_PER_MESSAGE, type Fragment } from "./simulated-link.js";
import {
  BridgeCommand,
  BridgeFrameReader,
  BridgeStatus,
  buildExecutePayload,
  buildQueryPayload,
  encodeBridgeFrame,
  type BridgeFrame,
} from "./sx126x-bridge-protocol.js";
import {
  ChipMode,
  IrqFlag,
  StandbyConfig,
  buildClearIrqStatusCommand,
  buildGetIrqStatusCommand,
  buildGetRxBufferStatusCommand,
  buildGetStatusCommand,
  buildReadBufferCommand,
  buildSetBufferBaseAddressCommand,
  buildSetDioIrqParamsCommand,
  buildSetModulationParamsCommand,
  buildSetPacketParamsCommand,
  buildSetPacketTypeCommand,
  buildSetRfFrequencyCommand,
  buildSetRxContinuousCommand,
  buildSetStandbyCommand,
  buildSetTxCommand,
  buildSetTxParamsCommand,
  buildWriteBufferCommand,
  parseGetStatusResponse,
  parseIrqStatus,
  parseRxBufferStatus,
} from "./sx126x-commands.js";

/**
 * Second real (non-simulated) LoRa driver in this codebase, talking to an
 * SX1262 chip over a serial bridge (`sx126x-bridge-protocol.ts`) — the same
 * connectivity shape `lora-serial.ts` uses for SX127x (a USB-dongle-style
 * MCU bridging serial↔SPI, the only path portable across both ARALD Box and
 * Portable), but **not an adaptation of that file**: SX126x's command
 * interface (opcode+params, with BUSY-pin handshaking) has no register
 * address/value pair to mirror, so every register read/write in the SX127x
 * version becomes an `EXECUTE`/`QUERY` bridge command here instead (see
 * `sx126x-commands.ts`'s own doc comment for the full architectural
 * contrast). ARALD standardizes on this chip across Box, Portable, *and*
 * Card (`docs/compliance.md`, 9 settembre 2026) specifically so Box and Card
 * can be validated against each other on the same real LoRa link — the
 * reason this driver exists alongside, not instead of, the SX127x one.
 *
 * **Never verified against a real chip** (no hardware available in this
 * environment) — validated instead against `FakeSX126xSerialDevice`
 * (`tests/helpers/fake-sx126x-serial-device.ts`), the SX126x counterpart of
 * `FakeSX127xSerialDevice`. Same honest posture as `lora-serial.ts`'s own
 * disclaimer.
 *
 * Two genuine differences from the SX127x driver beyond the command model,
 * both because SX126x's own command set requires them (not stylistic
 * choices):
 * - **`SetTxParams` is mandatory here.** SX127x's transmit power has a
 *   usable power-on-reset default this driver never bothers overriding
 *   (`lora-serial.ts` never writes `RegPaConfig` at all); SX126x has no such
 *   default power level to leave alone — a driver that never calls
 *   `SetTxParams` would transmit at an undefined power. `txPowerDbm`
 *   (default 14, this driver's own conservative always-safe choice — see
 *   `buildSetTxParamsCommand()`'s own doc comment on the clamp) is
 *   configurable for exactly this reason.
 * - **BUSY-retry with backoff on every bridge command.** SX127x's bridge
 *   protocol has only `OK`/`ERROR`; this chip's real hardware BUSY pin
 *   means the bridge can legitimately answer "not yet" (`BridgeStatus.BUSY`)
 *   to a command it hasn't executed at all — `Sx126xBridgeClient` retries
 *   automatically (`sendWithBusyRetry()`) rather than surfacing that as a
 *   command failure, since it isn't one.
 *
 * Every other deliberate scope narrowing carries over unchanged from
 * `lora-serial.ts`'s own doc comment, for the identical reasons: exactly one
 * peer connection at a time, IRQ status polled rather than watched on a real
 * DIO edge, no RF measurement of any kind.
 */
export interface LoraSerialSx1262TransportOptions {
  /** Carrier frequency in Hz — default 868.1 MHz, same EU868 default `lora-serial.ts` uses. */
  frequencyHz?: number;
  /** Channel bandwidth in Hz — one of `sx126x-commands.ts`'s `BANDWIDTH_CODE` keys. Default 125 kHz. */
  bandwidthHz?: number;
  /** LoRa spreading factor. SX126x supports 5-12 (one wider than SX127x's 6-12 floor — see `buildSetModulationParamsCommand()`'s own validation). Default 7. */
  spreadingFactor?: number;
  /** Coding rate denominator (4/5..4/8). Default 5 (4/5). */
  codingRateDenominator?: 5 | 6 | 7 | 8;
  /** TX power in dBm, clamped to [-9, 14] by `buildSetTxParamsCommand()` regardless of what's passed. Default 14 — see the class doc comment on why this chip needs an explicit value at all. */
  txPowerDbm?: number;
  /** Usable payload bytes per over-the-air fragment, after this driver's own 8-byte fragment header. Default 200, matching `lora-serial.ts`. */
  mtu?: number;
  /** How long `connect()` waits for a peer to be heard before giving up. */
  connectTimeoutMs?: number;
  /** How long a single bridge command round trip (excluding BUSY retries — see `busyTimeoutMs`) waits for its response before the link is considered dead. */
  commandTimeoutMs?: number;
  /** How often the RX poll loop reads `GetIrqStatus` — see the class doc's "polled, not interrupt-driven" limitation. */
  pollIntervalMs?: number;
  /** How long a single fragment's TX cycle waits for `TxDone` before giving up. */
  txTimeoutMs?: number;
  /** Initial delay before the first BUSY retry of a bridge command, doubling (capped at `busyRetryMaxDelayMs`) on each subsequent retry. */
  busyRetryBaseDelayMs?: number;
  /** Cap on the exponential BUSY-retry backoff delay. */
  busyRetryMaxDelayMs?: number;
  /** Total time a single bridge command may spend retrying `BridgeStatus.BUSY` responses before giving up outright — a chip stuck BUSY this long is treated as a dead link, not retried forever. */
  busyTimeoutMs?: number;
}

const DEFAULT_FREQUENCY_HZ = 868_100_000;
const DEFAULT_BANDWIDTH_HZ = 125_000;
const DEFAULT_SPREADING_FACTOR = 7;
const DEFAULT_CODING_RATE_DENOMINATOR = 5;
const DEFAULT_TX_POWER_DBM = 14;
const DEFAULT_MTU = 200;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_COMMAND_TIMEOUT_MS = 2000;
const DEFAULT_POLL_INTERVAL_MS = 20;
const DEFAULT_TX_TIMEOUT_MS = 5000;
const DEFAULT_BUSY_RETRY_BASE_DELAY_MS = 5;
const DEFAULT_BUSY_RETRY_MAX_DELAY_MS = 100;
const DEFAULT_BUSY_TIMEOUT_MS = 3000;

/** Shared single-buffer TX/RX base offset — always valid for the same half-duplex/single-connection reason `lora-serial.ts`'s `FIFO_BASE_ADDR` documents. */
const BUFFER_BASE_ADDR = 0x00;

/** Every IRQ this driver ever inspects — passed to `SetDioIrqParams` at `start()` so a real chip's DIO1 line carries them (this driver itself still only ever polls `GetIrqStatus`, never watches DIO1 — see the class doc's declared limitation; setting this up anyway keeps the chip configured the way a real, complete driver would). */
const ALL_IRQ_MASK = IrqFlag.TX_DONE | IrqFlag.RX_DONE | IrqFlag.HEADER_ERROR | IrqFlag.CRC_ERROR | IrqFlag.TIMEOUT;

/**
 * This transport's own over-the-air fragment header — byte-for-byte the
 * same shape as `lora-serial.ts`'s (`msgId` 4 random bytes + 2-byte
 * index/total, big-endian), reimplemented independently here rather than
 * imported, same "don't risk the working SX127x file for a chip-agnostic
 * detail" posture `sx126x-bridge-protocol.ts` already applies to its own
 * framing.
 */
const RADIO_HEADER_BYTES = 8;
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
 * Talks the bridge protocol (`sx126x-bridge-protocol.ts`) over `stream`.
 * Exactly one command outstanding at a time, same reasoning as
 * `Sx127xBridgeClient` (`lora-serial.ts`) — no request-id/correlation field,
 * this driver never pipelines. The one addition over that class:
 * `sendWithBusyRetry()`, wrapped by `enqueue()` as a single unit so a whole
 * BUSY-retry sequence for one command can never be interleaved with a
 * different queued command's own frame.
 */
class Sx126xBridgeClient {
  private readonly reader = new BridgeFrameReader();
  private pending?: { resolve: (frame: BridgeFrame) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly stream: SerialPortStream,
    private readonly commandTimeoutMs: number,
    private readonly busyRetryBaseDelayMs: number,
    private readonly busyRetryMaxDelayMs: number,
    private readonly busyTimeoutMs: number,
  ) {
    stream.on("data", (chunk: Buffer) => this.handleData(chunk));
  }

  private handleData(chunk: Buffer): void {
    for (const frame of this.reader.push(chunk)) {
      if (!this.pending) continue; // a stray/unexpected frame — dropped, same posture as every other transport here
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

  private sendOnce(type: number, payload: Buffer): Promise<BridgeFrame> {
    return new Promise<BridgeFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error("SX126x bridge command timed out"));
      }, this.commandTimeoutMs);
      this.pending = { resolve, reject, timer };
      // `encodeBridgeFrame()` is evaluated before `stream.write()`, so it can throw synchronously
      // (e.g. `payload` exceeds `MAX_FRAME_PAYLOAD_BYTES`) — found by review: an earlier version
      // called it directly as `stream.write()`'s argument, which still auto-rejects this promise (a
      // throw inside a Promise executor does that), but left `this.pending`/`timer` set. Left alone,
      // that stale timer fires `commandTimeoutMs` later and unconditionally clears `this.pending` —
      // if a different, legitimate command's own `sendOnce()` had since claimed it, the stale timer
      // would incorrectly reject *that* one instead of the failed one it actually belonged to.
      let encoded: Buffer;
      try {
        encoded = encodeBridgeFrame(type, payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending = undefined;
        reject(err as Error);
        return;
      }
      this.stream.write(encoded, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending = undefined;
        reject(err);
      });
    });
  }

  /**
   * Sends one request frame, retrying with capped exponential backoff for
   * as long as the bridge keeps reporting `BridgeStatus.BUSY` — up to
   * `busyTimeoutMs` total, after which this gives up rather than retrying
   * forever against a genuinely stuck or absent bridge. Not wrapped in
   * `enqueue()` itself — callers (`reset()`/`execute()`/`query()`) do that,
   * so the whole retry sequence holds the queue as one unit.
   */
  private async sendWithBusyRetry(type: number, payload: Buffer): Promise<BridgeFrame> {
    const deadline = Date.now() + this.busyTimeoutMs;
    let delay = this.busyRetryBaseDelayMs;
    for (;;) {
      const frame = await this.sendOnce(type, payload);
      if (frame.type !== BridgeStatus.BUSY) return frame;
      if (Date.now() >= deadline) throw new Error("SX126x bridge: chip stayed BUSY past the retry deadline");
      await sleep(delay);
      delay = Math.min(delay * 2, this.busyRetryMaxDelayMs);
    }
  }

  async reset(): Promise<void> {
    const frame = await this.enqueue(() => this.sendWithBusyRetry(BridgeCommand.RESET, Buffer.alloc(0)));
    if (frame.type !== BridgeStatus.OK) throw new Error(`SX126x bridge RESET failed (status 0x${frame.type.toString(16)})`);
  }

  async execute(commandBytes: Buffer): Promise<void> {
    const frame = await this.enqueue(() => this.sendWithBusyRetry(BridgeCommand.EXECUTE, buildExecutePayload(commandBytes)));
    if (frame.type !== BridgeStatus.OK) throw new Error(`SX126x bridge EXECUTE failed (status 0x${frame.type.toString(16)})`);
  }

  async query(commandBytes: Buffer, expectedResponseLength: number): Promise<Buffer> {
    const frame = await this.enqueue(() =>
      this.sendWithBusyRetry(BridgeCommand.QUERY, buildQueryPayload(commandBytes, expectedResponseLength)),
    );
    if (frame.type !== BridgeStatus.OK) throw new Error(`SX126x bridge QUERY failed (status 0x${frame.type.toString(16)})`);
    if (frame.payload.length !== expectedResponseLength) throw new Error("SX126x bridge: malformed QUERY response length");
    return frame.payload;
  }
}

interface ActiveConnection {
  peerId: string;
  reassembler: FragmentReassembler;
}

export class LoraSerialSx1262Transport implements Transport {
  readonly id = "lora-serial-sx1262";

  private readonly bridge: Sx126xBridgeClient;
  private readonly frequencyHz: number;
  private readonly bandwidthHz: number;
  private readonly spreadingFactor: number;
  private readonly codingRateDenominator: 5 | 6 | 7 | 8;
  private readonly txPowerDbm: number;
  private readonly mtu: number;
  private readonly connectTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly txTimeoutMs: number;

  private readonly packetHandlers: PacketHandler[] = [];
  private readonly connectedHandlers: PeerConnectedHandler[] = [];
  private readonly disconnectedHandlers: PeerDisconnectedHandler[] = [];

  private started = false;
  private rxPollTimer?: NodeJS.Timeout;
  /** Guards the shared buffer/mode state against a TX cycle and the RX poll loop racing each other — both talk to the same physical chip. */
  private radioBusy: Promise<unknown> = Promise.resolve();
  /** `Date.now()` of the last completed fragment TX cycle, `0` before the first one ever — see `transmitFragmentBytes()`'s pacing (identical rationale to `lora-serial.ts`'s own). */
  private lastFragmentTransmittedAt = 0;
  private connection?: ActiveConnection;
  private pendingConnect?: { resolve: (peerId: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
  /** Whether this side has already sent its own HELLO for the current handshake — see `sendHelloOnce()`. */
  private helloSent = false;
  /** Only set while no connection exists yet — reassembles whatever arrives before a peer is identified. Folded into `this.connection.reassembler` once identified. */
  private reassemblerForPendingConnect?: FragmentReassembler;

  constructor(
    private readonly localNodeId: string,
    private readonly stream: SerialPortStream,
    options: LoraSerialSx1262TransportOptions = {},
  ) {
    this.frequencyHz = options.frequencyHz ?? DEFAULT_FREQUENCY_HZ;
    this.bandwidthHz = options.bandwidthHz ?? DEFAULT_BANDWIDTH_HZ;
    this.spreadingFactor = options.spreadingFactor ?? DEFAULT_SPREADING_FACTOR;
    this.codingRateDenominator = options.codingRateDenominator ?? DEFAULT_CODING_RATE_DENOMINATOR;
    this.txPowerDbm = options.txPowerDbm ?? DEFAULT_TX_POWER_DBM;
    this.mtu = Math.max(1, options.mtu ?? DEFAULT_MTU);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.txTimeoutMs = options.txTimeoutMs ?? DEFAULT_TX_TIMEOUT_MS;
    this.bridge = new Sx126xBridgeClient(
      this.stream,
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      options.busyRetryBaseDelayMs ?? DEFAULT_BUSY_RETRY_BASE_DELAY_MS,
      options.busyRetryMaxDelayMs ?? DEFAULT_BUSY_RETRY_MAX_DELAY_MS,
      options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    );
    // Same crash-prevention rationale as `lora-serial.ts`'s identical listener: an 'error' event with
    // zero listeners throws synchronously in Node and kills the whole process.
    this.stream.on("error", () => {
      /* handled — see lora-serial.ts's identical comment for why this exists and what it deliberately doesn't do */
    });
  }

  /** Same "caller decides whether/how the stream opens" contract as `lora-serial.ts`'s identical method — see that file's doc comment for why this transport never calls `open()` itself. */
  async start(): Promise<void> {
    await this.waitForStreamOpen();

    await this.bridge.reset();
    await this.bridge.execute(buildSetStandbyCommand(StandbyConfig.RC));
    const statusByte = await this.bridge.query(buildGetStatusCommand(), 1);
    const chipMode = parseGetStatusResponse(statusByte[0]);
    if (chipMode !== ChipMode.STBY_RC) {
      throw new Error(
        `SX126x not responding as expected on this serial link (GetStatus reported chip mode ${chipMode}, expected STBY_RC=${ChipMode.STBY_RC}) — no chip present, wrong chip, or the bridge firmware isn't running`,
      );
    }

    await this.bridge.execute(buildSetPacketTypeCommand());
    await this.bridge.execute(buildSetRfFrequencyCommand(this.frequencyHz));
    await this.bridge.execute(buildSetModulationParamsCommand(this.spreadingFactor, this.bandwidthHz, this.codingRateDenominator));
    // Placeholder length — re-set correctly before every TX in transmitFragmentBytes(); RX doesn't
    // depend on this value at all (GetRxBufferStatus reports the real received length per-packet).
    await this.bridge.execute(buildSetPacketParamsCommand(0));
    await this.bridge.execute(buildSetTxParamsCommand(this.txPowerDbm));
    await this.bridge.execute(buildSetBufferBaseAddressCommand(BUFFER_BASE_ADDR, BUFFER_BASE_ADDR));
    await this.bridge.execute(buildSetDioIrqParamsCommand(ALL_IRQ_MASK));
    await this.clearIrqStatus(ALL_IRQ_MASK);

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

  /** Same "no per-device address, first packet's `source` reveals the peer" handshake as `lora-serial.ts`'s identical method. */
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
      // Session-guard identity check — see `lora-serial.ts`'s `connect()` doc comment for the full
      // rationale (a stale handler from a superseded attempt must never touch a newer one's state).
      let pending!: { resolve: (peerId: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
      const timer = setTimeout(() => {
        if (this.pendingConnect !== pending) return;
        this.pendingConnect = undefined;
        this.helloSent = false; // allow a retry to actually re-transmit HELLO, not silently no-op
        reject(new Error("LoRa connect timeout: no peer heard"));
      }, this.connectTimeoutMs);
      pending = { resolve, reject, timer };
      this.pendingConnect = pending;

      this.sendHelloOnce().catch((err) => {
        if (this.pendingConnect !== pending) return;
        clearTimeout(timer);
        this.pendingConnect = undefined;
        this.helloSent = false;
        reject(err as Error);
      });
    });
  }

  /** Sends this side's own HELLO exactly once per handshake — same as `lora-serial.ts`'s identical method. */
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

  /** Fragments `packet` and transmits each fragment's full TX cycle serially — same rationale as `lora-serial.ts`'s identical method. */
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

  /** Serializes access to the shared buffer/mode state between TX cycles and the RX poll loop — same as `lora-serial.ts`'s identical method. */
  private withRadio<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.radioBusy.then(fn, fn);
    this.radioBusy = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Transmits one already-headered fragment, paced against
   * `lastFragmentTransmittedAt` exactly as `lora-serial.ts`'s identical
   * method — see that method's doc comment for the full pacing rationale
   * (unchanged: the receiver's single buffer slot, drained by its own poll
   * loop, has the identical FIFO-overwrite race regardless of chip family).
   * `SetStandby` first (so `WriteBuffer` never races an in-progress RX),
   * then `WriteBuffer`+`SetPacketParams` (this fragment's real length —
   * unlike RX, TX genuinely needs it set correctly per datasheet)+`SetTx`,
   * then poll `GetIrqStatus` for `TX_DONE`.
   */
  private async transmitFragmentBytes(frame: Buffer): Promise<void> {
    const minGapMs = this.pollIntervalMs * 2;
    const elapsedSinceLastFragment = Date.now() - this.lastFragmentTransmittedAt;
    if (elapsedSinceLastFragment < minGapMs) await sleep(minGapMs - elapsedSinceLastFragment);

    await this.bridge.execute(buildSetStandbyCommand(StandbyConfig.RC));
    await this.bridge.execute(buildWriteBufferCommand(BUFFER_BASE_ADDR, frame));
    await this.bridge.execute(buildSetPacketParamsCommand(frame.length));
    await this.bridge.execute(buildSetTxCommand());

    const deadline = Date.now() + this.txTimeoutMs;
    for (;;) {
      const irqBytes = await this.bridge.query(buildGetIrqStatusCommand(), 2);
      const irq = parseIrqStatus(irqBytes);
      if (irq & IrqFlag.TX_DONE) {
        await this.clearIrqStatus(IrqFlag.TX_DONE);
        break;
      }
      if (Date.now() > deadline) throw new Error("LoRa TX timed out waiting for TxDone");
      await sleep(this.pollIntervalMs);
    }
    await this.enterRxContinuous();
    this.lastFragmentTransmittedAt = Date.now();
  }

  private async enterRxContinuous(): Promise<void> {
    // Unlike SX127x's REG_FIFO_ADDR_PTR, SX126x needs no explicit RX buffer-pointer reset here — RX
    // always starts writing at the rxBaseAddress configured once via SetBufferBaseAddress in start();
    // where a given received packet actually landed is reported per-packet by GetRxBufferStatus.
    await this.bridge.execute(buildSetRxContinuousCommand());
  }

  private async clearIrqStatus(mask: number): Promise<void> {
    await this.bridge.execute(buildClearIrqStatusCommand(mask));
  }

  /**
   * Polled on `pollIntervalMs` — same declared IRQ-polling limitation as
   * `lora-serial.ts`. Same "entire body in one try/catch" rationale as that
   * file's identical method: this runs from a bare `setInterval` callback
   * with nothing external able to catch a rejection, so any bridge round
   * trip failing here must be swallowed, not left to crash the process as
   * an unhandled rejection.
   */
  private async pollForReceivedPacket(): Promise<void> {
    if (!this.started) return;
    await this.withRadio(async () => {
      try {
        const irqBytes = await this.bridge.query(buildGetIrqStatusCommand(), 2);
        const irq = parseIrqStatus(irqBytes);
        if (!(irq & IrqFlag.RX_DONE)) return;

        const hadCrcError = Boolean(irq & IrqFlag.CRC_ERROR);
        await this.clearIrqStatus(IrqFlag.RX_DONE | IrqFlag.CRC_ERROR | IrqFlag.HEADER_ERROR);
        if (hadCrcError) return; // corrupted over the air — never trust it, same posture as every malformed-input path in this codebase

        const statusBytes = await this.bridge.query(buildGetRxBufferStatusCommand(), 2);
        const { payloadLength, rxStartBufferPointer } = parseRxBufferStatus(statusBytes);
        const bytes = await this.bridge.query(buildReadBufferCommand(rxStartBufferPointer), payloadLength);
        this.handleReceivedFrame(bytes);
      } catch {
        // link hiccup partway through this poll cycle — next tick tries again, same "recoverable, not fatal" posture as everywhere else.
      }
    });
  }

  private handleReceivedFrame(frame: Buffer): void {
    if (frame.length <= RADIO_HEADER_BYTES) return; // too short to even carry a header — malformed, drop it
    const { msgId, index, total, rest } = decodeRadioFragmentHeader(frame);

    const connectionId = "lora-serial-sx1262"; // constant: this transport only ever has one connection (class doc's scope note)
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
    // This side's first chance to reply if it didn't already send one as the initiator — `.catch()`
    // required here (fire-and-forget), same rationale as `lora-serial.ts`'s identical call.
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
