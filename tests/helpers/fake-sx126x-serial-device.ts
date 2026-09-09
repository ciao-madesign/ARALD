import type { MockPortBinding } from "@serialport/binding-mock";
import {
  BridgeCommand,
  BridgeFrameReader,
  BridgeStatus,
  encodeBridgeFrame,
  type BridgeFrame,
} from "../../node/src/transports/sx126x-bridge-protocol.js";
import { CHIP_BUFFER_SIZE, ChipMode, IrqFlag, Sx126xOpcode } from "../../node/src/transports/sx126x-commands.js";

/**
 * Test-only double for a real SX1262 chip sitting behind
 * `LoraSerialSx1262Transport`'s serial bridge protocol
 * (`node/src/transports/sx126x-bridge-protocol.ts`) — the SX126x
 * counterpart of `fake-sx127x-serial-device.ts`. See that file's own doc
 * comment for why this exists (validating a real driver's command
 * sequences without physical hardware) and why it wraps a
 * `MockPortBinding` directly rather than opening a second stream on the
 * same mock path (`@serialport/binding-mock` only allows one opener per
 * path).
 *
 * Unlike the SX127x fake, this one interprets `BridgeCommand.EXECUTE`/
 * `QUERY` payloads as `[opcode, ...params]` (`QUERY` payloads carry an
 * extra leading expected-response-length byte — see
 * `buildQueryPayload()`) rather than a register address/value pair — see
 * `sx126x-bridge-protocol.ts`'s own doc comment for why the command set is
 * shaped that way. Chip-mode/buffer/IRQ semantics are faithful to what
 * `sx126x-commands.ts` itself documents as verified against Semtech's own
 * open-source reference driver; commands this driver issues but whose real
 * effect this fake never actually observes (`SetModulationParams`,
 * `SetRfFrequency`, `SetDioIrqParams`) are accepted and acknowledged but
 * not otherwise modeled — this fake never transmits radio waves, so
 * nothing downstream would ever observe a difference.
 *
 * `simulateBusyOnNextCommand()` lets a test force the next `count` bridge
 * commands to receive `BridgeStatus.BUSY` before the following retry
 * succeeds normally — exercising `Sx126xBridgeClient.sendWithBusyRetry()`'s
 * retry path, which the SX127x fake has no equivalent of (that bridge
 * protocol has no BUSY concept at all).
 */
export class FakeSX126xSerialDevice {
  private readonly buffer = Buffer.alloc(CHIP_BUFFER_SIZE);
  private chipMode: ChipMode = ChipMode.STBY_RC; // real chip's power-on-reset default
  private irqStatus = 0;
  private txBaseAddress = 0;
  private rxBaseAddress = 0;
  private lastRxPayloadLength = 0;
  private lastRxStartPointer = 0;
  private lastTxPowerDbm: number | undefined;
  /** Bytes from the most recent `WriteBuffer` call — `SetTx` transmits exactly this, since (unlike this fake's other state) the *length* of what's currently sitting in `buffer` isn't otherwise tracked anywhere: a real chip already knows it from the payload-length field `SetPacketParams` configured, which this fake accepts but doesn't model (see class doc comment). */
  private lastWrittenBufferBytes = Buffer.alloc(0);
  private readonly frameReader = new BridgeFrameReader();
  private busyCountdown = 0;
  private readonly reportedChipModeOverride?: ChipMode;

  /** Set by `linkFakeRadios()` — called with the exact bytes this device "transmitted", so a paired fake can receive them. Never delayed/queued by this class itself. */
  onTransmit?: (payload: Buffer) => void;

  constructor(private readonly binding: MockPortBinding, options: { reportedChipModeOverride?: ChipMode } = {}) {
    // Mirrors FakeSX127xSerialDevice's `reportedVersion` option — lets a test exercise
    // LoraSerialSx1262Transport.start()'s "no chip present / wrong chip" rejection path by making
    // GetStatus always report something other than the STBY_RC the driver expects right after it
    // issues SetStandby, regardless of this fake's real internal chip mode.
    this.reportedChipModeOverride = options.reportedChipModeOverride;
    const originalWrite = binding.write.bind(binding);
    binding.write = async (chunk: Buffer) => {
      await originalWrite(chunk);
      this.handleHostBytes(chunk);
    };
  }

  private handleHostBytes(chunk: Buffer): void {
    for (const frame of this.frameReader.push(chunk)) this.handleRequestFrame(frame);
  }

  private respond(status: BridgeStatus, payload: Buffer = Buffer.alloc(0)): void {
    if (!this.binding.isOpen) return; // torn down mid-exchange — nothing to reply to
    this.binding.emitData(encodeBridgeFrame(status, payload));
  }

  private handleRequestFrame(frame: BridgeFrame): void {
    if (this.busyCountdown > 0 && frame.type !== BridgeCommand.RESET) {
      this.busyCountdown--;
      this.respond(BridgeStatus.BUSY);
      return;
    }
    try {
      this.executeFrame(frame);
    } catch {
      this.respond(BridgeStatus.ERROR);
    }
  }

  private executeFrame(frame: BridgeFrame): void {
    switch (frame.type) {
      case BridgeCommand.RESET: {
        this.buffer.fill(0);
        this.chipMode = ChipMode.STBY_RC;
        this.irqStatus = 0;
        this.txBaseAddress = 0;
        this.rxBaseAddress = 0;
        this.lastRxPayloadLength = 0;
        this.lastRxStartPointer = 0;
        this.lastTxPowerDbm = undefined;
        this.lastWrittenBufferBytes = Buffer.alloc(0);
        this.respond(BridgeStatus.OK);
        return;
      }
      case BridgeCommand.EXECUTE: {
        if (frame.payload.length < 1) throw new Error("malformed EXECUTE request");
        this.executeChipCommand(frame.payload[0], frame.payload.subarray(1));
        this.respond(BridgeStatus.OK);
        return;
      }
      case BridgeCommand.QUERY: {
        if (frame.payload.length < 2) throw new Error("malformed QUERY request");
        const expectedResponseLength = frame.payload[0];
        const opcode = frame.payload[1];
        const params = frame.payload.subarray(2);
        const response = this.queryChipCommand(opcode, params, expectedResponseLength);
        this.respond(BridgeStatus.OK, response);
        return;
      }
      default:
        throw new Error(`unknown bridge command 0x${frame.type.toString(16)}`);
    }
  }

  private executeChipCommand(opcode: number, params: Buffer): void {
    switch (opcode) {
      case Sx126xOpcode.SET_STANDBY:
        this.chipMode = ChipMode.STBY_RC;
        return;
      case Sx126xOpcode.SET_PACKET_TYPE:
      case Sx126xOpcode.SET_RF_FREQUENCY:
      case Sx126xOpcode.SET_MODULATION_PARAMS:
      case Sx126xOpcode.SET_PACKET_PARAMS:
      case Sx126xOpcode.SET_DIO_IRQ_PARAMS:
        return; // accepted, not otherwise modeled — see class doc comment
      case Sx126xOpcode.SET_TX_PARAMS:
        if (params.length < 1) throw new Error("malformed SetTxParams");
        this.lastTxPowerDbm = params.readInt8(0);
        return;
      case Sx126xOpcode.SET_BUFFER_BASE_ADDRESS:
        if (params.length < 2) throw new Error("malformed SetBufferBaseAddress");
        this.txBaseAddress = params[0];
        this.rxBaseAddress = params[1];
        return;
      case Sx126xOpcode.CLR_IRQ_STATUS:
        if (params.length < 2) throw new Error("malformed ClearIrqStatus");
        this.irqStatus &= ~((params[0] << 8) | params[1]);
        return;
      case Sx126xOpcode.WRITE_BUFFER: {
        if (params.length < 1) throw new Error("malformed WriteBuffer");
        const offset = params[0];
        const data = params.subarray(1);
        for (let i = 0; i < data.length; i++) this.buffer[(offset + i) % CHIP_BUFFER_SIZE] = data[i];
        if (offset === this.txBaseAddress) this.lastWrittenBufferBytes = Buffer.from(data);
        return;
      }
      case Sx126xOpcode.SET_TX: {
        this.chipMode = ChipMode.TX;
        this.irqStatus |= IrqFlag.TX_DONE;
        this.onTransmit?.(this.lastWrittenBufferBytes);
        return;
      }
      case Sx126xOpcode.SET_RX:
        this.chipMode = ChipMode.RX;
        return;
      default:
        throw new Error(`unknown EXECUTE opcode 0x${opcode.toString(16)}`);
    }
  }

  private queryChipCommand(opcode: number, params: Buffer, expectedResponseLength: number): Buffer {
    switch (opcode) {
      case Sx126xOpcode.GET_STATUS:
        return Buffer.from([(this.reportedChipModeOverride ?? this.chipMode) << 4]);
      case Sx126xOpcode.GET_IRQ_STATUS:
        return Buffer.from([(this.irqStatus >>> 8) & 0xff, this.irqStatus & 0xff]);
      case Sx126xOpcode.GET_RX_BUFFER_STATUS:
        return Buffer.from([this.lastRxPayloadLength & 0xff, this.lastRxStartPointer & 0xff]);
      case Sx126xOpcode.READ_BUFFER: {
        const offset = params.length > 0 ? params[0] : this.lastRxStartPointer;
        const out = Buffer.alloc(expectedResponseLength);
        for (let i = 0; i < expectedResponseLength; i++) out[i] = this.buffer[(offset + i) % CHIP_BUFFER_SIZE];
        return out;
      }
      default:
        throw new Error(`unknown QUERY opcode 0x${opcode.toString(16)}`);
    }
  }

  /**
   * Simulates a frame arriving over the air — the receiving half of
   * `linkFakeRadios()`, or callable directly by a unit test. Silently
   * dropped unless this fake is currently in `RX` mode, mirroring the real
   * half-duplex constraint the transport's own doc comment declares.
   */
  simulateIncomingRadioFrame(bytes: Buffer, options: { crcError?: boolean } = {}): void {
    if (this.chipMode !== ChipMode.RX) return;
    for (let i = 0; i < bytes.length; i++) this.buffer[(this.rxBaseAddress + i) % CHIP_BUFFER_SIZE] = bytes[i];
    this.lastRxPayloadLength = bytes.length;
    this.lastRxStartPointer = this.rxBaseAddress;
    this.irqStatus |= IrqFlag.RX_DONE;
    if (options.crcError) this.irqStatus |= IrqFlag.CRC_ERROR;
  }

  /** Forces the next `count` bridge commands (any type except `RESET`) to receive `BridgeStatus.BUSY` instead of being executed — see class doc comment. */
  simulateBusyOnNextCommand(count = 1): void {
    this.busyCountdown = count;
  }

  /** Last power value asserted via `SetTxParams`, for a unit test to confirm `start()` configured it — same "expose otherwise-unobservable config for assertions" purpose as `FakeSX127xSerialDevice.readRegisterForTest()`. */
  getLastTxPowerDbmForTest(): number | undefined {
    return this.lastTxPowerDbm;
  }
}

/** Links two fakes so each one's `onTransmit` delivers to the other's `simulateIncomingRadioFrame` — same as `linkFakeRadios()` in `fake-sx127x-serial-device.ts`. */
export function linkFakeRadios(a: FakeSX126xSerialDevice, b: FakeSX126xSerialDevice, options: { latencyMs?: number } = {}): void {
  const latencyMs = options.latencyMs ?? 0;
  a.onTransmit = (bytes) => setTimeout(() => b.simulateIncomingRadioFrame(bytes), latencyMs);
  b.onTransmit = (bytes) => setTimeout(() => a.simulateIncomingRadioFrame(bytes), latencyMs);
}
