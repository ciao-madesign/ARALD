import type { MockPortBinding } from "@serialport/binding-mock";
import {
  BridgeCommand,
  BridgeFrameReader,
  BridgeStatus,
  encodeBridgeFrame,
  type BridgeFrame,
} from "../../node/src/transports/sx127x-bridge-protocol.js";
import {
  IrqFlag,
  LoraMode,
  REG_FIFO_ADDR_PTR,
  REG_FIFO_RX_BASE_ADDR,
  REG_FIFO_RX_CURRENT_ADDR,
  REG_FIFO_TX_BASE_ADDR,
  REG_IRQ_FLAGS,
  REG_OP_MODE,
  REG_PAYLOAD_LENGTH,
  REG_RX_NB_BYTES,
  REG_VERSION,
  SX127X_CHIP_VERSION,
  extractLoraMode,
} from "../../node/src/transports/sx127x-registers.js";

const FIFO_SIZE = 256;

/**
 * Test-only double for a real SX127x chip sitting behind
 * `LoraSerialTransport`'s serial bridge protocol
 * (`node/src/transports/sx127x-bridge-protocol.ts`) — never shipped in
 * `node/src/`, unlike `nomad-hub/fake-docker-server.ts`/
 * `gateway/nomad/fake-ollama-server.ts`: those exist as CLI-selectable
 * stand-ins a demo can run against instead of the real backend, a real use
 * case this doesn't have (nobody demos ARALD against a pretend radio chip).
 * This exists purely to validate `LoraSerialTransport`'s register/FIFO
 * command sequences without physical hardware, same goal, narrower scope.
 *
 * Wraps the `MockPortBinding` a test obtains from its own
 * `SerialPortStream({ binding: MockBinding, ... })` — **not** a second,
 * independent stream on the same mock path: `@serialport/binding-mock`
 * only allows one opener per path (`MockBinding.open()`'s `port.openOpt`
 * check), so there is no "other end" to open separately the way two real
 * serial ports would have. Instead this drives both directions of the one
 * binding directly: `binding.emitData()` to simulate bytes arriving from
 * the chip, and a thin wrapper around `binding.write` to observe bytes the
 * driver sent to it — exactly the pattern `@serialport/binding-mock`'s own
 * README example (`port.port.emitData(...)`) is built around.
 *
 * Register/FIFO semantics are faithful to the public SX1276/77/78/79
 * datasheet wherever this class actually models chip behavior (mode
 * transitions, `RegVersion`, FIFO pointer auto-increment, `RegIrqFlags`
 * clear-on-write-1) — registers this driver writes but never reads back
 * (`RegFrfMsb/Mid/Lsb`, `RegModemConfig1/2/3`, `RegPaConfig`) are stored
 * generically (readable via `readRegisterForTest()`, for a unit test to
 * assert `start()` configured them correctly) but otherwise not
 * interpreted — this fake never actually transmits radio waves, so nothing
 * downstream of those values would ever observe a difference.
 */
export class FakeSX127xSerialDevice {
  private readonly registers = new Map<number, number>();
  private readonly fifo = Buffer.alloc(FIFO_SIZE);
  private fifoPtr = 0;
  private irqFlags = 0;
  private opMode = 0;
  private payloadLength = 0;
  private readonly frameReader = new BridgeFrameReader();

  /** Set by `linkFakeRadios()` — called with the exact bytes this device "transmitted" (its FIFO content at the moment `RegOpMode` was written into `TX`), so a paired fake can receive them. Never delayed/queued by this class itself; a caller wanting simulated air latency does that in this callback. */
  onTransmit?: (payload: Buffer) => void;

  private readonly reportedVersion: number;

  constructor(
    private readonly binding: MockPortBinding,
    options: { reportedVersion?: number } = {},
  ) {
    // Defaults to the real chip's fixed silicon revision; a test overrides this to exercise
    // LoraSerialTransport.start()'s "no chip present / wrong chip" rejection path, a scenario the
    // simulated LoRa transport (transports/lora.ts) has no equivalent of — a real driver's sanity
    // check that never applied to a pure in-process simulation.
    this.reportedVersion = options.reportedVersion ?? SX127X_CHIP_VERSION;
    const originalWrite = binding.write.bind(binding);
    binding.write = async (buffer: Buffer) => {
      await originalWrite(buffer);
      this.handleHostBytes(buffer);
    };
  }

  private handleHostBytes(chunk: Buffer): void {
    for (const frame of this.frameReader.push(chunk)) this.handleRequestFrame(frame);
  }

  private respond(status: BridgeStatus, payload: Buffer = Buffer.alloc(0)): void {
    if (!this.binding.isOpen) return; // torn down mid-exchange (e.g. transport.stop() raced a response) — nothing to reply to
    this.binding.emitData(encodeBridgeFrame(status, payload));
  }

  private handleRequestFrame(frame: BridgeFrame): void {
    try {
      this.executeCommand(frame);
    } catch {
      this.respond(BridgeStatus.ERROR);
    }
  }

  private executeCommand(frame: BridgeFrame): void {
    switch (frame.type) {
      case BridgeCommand.RESET: {
        this.registers.clear();
        this.fifo.fill(0);
        this.fifoPtr = 0;
        this.irqFlags = 0;
        this.payloadLength = 0;
        this.opMode = 0; // datasheet power-on default: Sleep, FSK/OOK mode — the driver always switches into LoRa mode itself before relying on anything else
        this.respond(BridgeStatus.OK);
        return;
      }
      case BridgeCommand.READ_REG: {
        if (frame.payload.length < 1) throw new Error("malformed READ_REG request");
        const addr = frame.payload[0];
        this.respond(BridgeStatus.OK, Buffer.from([this.readRegister(addr)]));
        return;
      }
      case BridgeCommand.WRITE_REG: {
        if (frame.payload.length < 2) throw new Error("malformed WRITE_REG request");
        this.writeRegister(frame.payload[0], frame.payload[1]);
        this.respond(BridgeStatus.OK);
        return;
      }
      case BridgeCommand.FIFO_WRITE: {
        for (const byte of frame.payload) {
          this.fifo[this.fifoPtr % FIFO_SIZE] = byte;
          this.fifoPtr = (this.fifoPtr + 1) % FIFO_SIZE; // real FIFO address pointer auto-increments, wrapping at the buffer's physical size
        }
        this.respond(BridgeStatus.OK);
        return;
      }
      case BridgeCommand.FIFO_READ: {
        if (frame.payload.length < 1) throw new Error("malformed FIFO_READ request");
        const count = frame.payload[0];
        const out = Buffer.alloc(count);
        for (let i = 0; i < count; i++) {
          out[i] = this.fifo[this.fifoPtr % FIFO_SIZE];
          this.fifoPtr = (this.fifoPtr + 1) % FIFO_SIZE;
        }
        this.respond(BridgeStatus.OK, out);
        return;
      }
      default:
        throw new Error(`unknown bridge command 0x${frame.type.toString(16)}`);
    }
  }

  private readRegister(addr: number): number {
    if (addr === REG_VERSION) return this.reportedVersion;
    if (addr === REG_IRQ_FLAGS) return this.irqFlags;
    if (addr === REG_OP_MODE) return this.opMode;
    if (addr === REG_RX_NB_BYTES) return this.registers.get(REG_RX_NB_BYTES) ?? 0;
    if (addr === REG_FIFO_RX_CURRENT_ADDR) return this.registers.get(REG_FIFO_RX_CURRENT_ADDR) ?? 0;
    if (addr === REG_PAYLOAD_LENGTH) return this.payloadLength;
    return this.registers.get(addr) ?? 0;
  }

  private writeRegister(addr: number, value: number): void {
    if (addr === REG_OP_MODE) {
      const previousMode = extractLoraMode(this.opMode);
      this.opMode = value;
      const newMode = extractLoraMode(value);
      if (newMode === LoraMode.TX && previousMode !== LoraMode.TX) this.transmitCurrentFifo();
      return;
    }
    if (addr === REG_IRQ_FLAGS) {
      this.irqFlags &= ~value & 0xff; // clear-on-write-1 (sx127x-registers.ts) — never a plain overwrite
      return;
    }
    if (addr === REG_FIFO_ADDR_PTR) {
      this.fifoPtr = value;
      return;
    }
    if (addr === REG_PAYLOAD_LENGTH) {
      this.payloadLength = value;
      return;
    }
    this.registers.set(addr, value);
  }

  private transmitCurrentFifo(): void {
    const txBase = this.registers.get(REG_FIFO_TX_BASE_ADDR) ?? 0;
    const payload = Buffer.from(this.fifo.subarray(txBase, txBase + this.payloadLength));
    this.irqFlags |= IrqFlag.TX_DONE;
    this.onTransmit?.(payload);
  }

  /**
   * Simulates a frame arriving over the air — the receiving half of
   * `linkFakeRadios()`, or callable directly by a unit test that wants to
   * exercise `LoraSerialTransport`'s receive path without a second device.
   * Silently dropped (real radios can't receive while transmitting, or
   * while not listening at all) unless this fake is currently in
   * `RX_CONTINUOUS`/`RX_SINGLE` mode — mirrors the real half-duplex
   * constraint `LoraSerialTransport`'s own doc comment declares.
   */
  simulateIncomingRadioFrame(bytes: Buffer, options: { crcError?: boolean } = {}): void {
    const mode = extractLoraMode(this.opMode);
    if (mode !== LoraMode.RX_CONTINUOUS && mode !== LoraMode.RX_SINGLE) return;

    const rxBase = this.registers.get(REG_FIFO_RX_BASE_ADDR) ?? 0;
    for (let i = 0; i < bytes.length; i++) this.fifo[(rxBase + i) % FIFO_SIZE] = bytes[i];
    this.registers.set(REG_RX_NB_BYTES, bytes.length);
    this.registers.set(REG_FIFO_RX_CURRENT_ADDR, rxBase);
    this.irqFlags |= IrqFlag.RX_DONE | IrqFlag.VALID_HEADER;
    if (options.crcError) this.irqFlags |= IrqFlag.PAYLOAD_CRC_ERROR;
  }

  /** Reads a register's raw stored value regardless of what it means — for a test asserting `start()` configured e.g. `RegFrfMsb`/`RegModemConfig1` correctly, none of which this fake otherwise interprets. */
  readRegisterForTest(addr: number): number {
    return this.readRegister(addr);
  }
}

/** Links two fakes so each one's `onTransmit` delivers to the other's `simulateIncomingRadioFrame` — the fake-device equivalent of `SimulatedMedium`'s in-process delivery, no real RF modeling. `latencyMs` (default 0) is a plain `setTimeout`, not a claim about real LoRa air time. */
export function linkFakeRadios(a: FakeSX127xSerialDevice, b: FakeSX127xSerialDevice, options: { latencyMs?: number } = {}): void {
  const latencyMs = options.latencyMs ?? 0;
  a.onTransmit = (bytes) => setTimeout(() => b.simulateIncomingRadioFrame(bytes), latencyMs);
  b.onTransmit = (bytes) => setTimeout(() => a.simulateIncomingRadioFrame(bytes), latencyMs);
}
