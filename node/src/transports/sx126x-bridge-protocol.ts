/**
 * Wire framing for talking to an SX126x LoRa module over a serial link, used
 * by `LoraSerialSx1262Transport` (`lora-serial-sx1262.ts`) — the SX1262
 * counterpart of `sx127x-bridge-protocol.ts`. **This project's own
 * invention, not a real product's**, same as that file: a real SX1262
 * breakout is a bare SPI+GPIO+BUSY device, it doesn't speak serial at all
 * (see `lora-serial-sx1262.ts`'s own doc comment for why a serial *bridge* —
 * a small MCU that talks SPI to the chip and USB-serial to the host — is the
 * only connectivity path portable across both ARALD Box and Portable).
 *
 * **Not the same command set as `sx127x-bridge-protocol.ts`, deliberately.**
 * That protocol's `READ_REG`/`WRITE_REG`/`FIFO_WRITE`/`FIFO_READ` commands
 * assume a flat register map — there is no such thing to address on an
 * SX126x, which instead exposes opcode+parameter *commands*
 * (`sx126x-commands.ts`). This protocol has exactly three commands instead:
 * `RESET` (unchanged in spirit), `EXECUTE` (fire-and-forget: send an opcode
 * and its parameter bytes, e.g. `SetStandby`/`SetTx`/`WriteBuffer` — no
 * response data expected beyond a status), and `QUERY` (send an opcode and
 * its parameter bytes *and* how many response bytes to expect back, e.g.
 * `GetStatus`/`GetIrqStatus`/`ReadBuffer`). Splitting on "does this command
 * produce response data" rather than modeling each individual SX126x opcode
 * as its own bridge command keeps this protocol's own command set stable as
 * `sx126x-commands.ts` gains opcodes this driver doesn't use yet.
 *
 * **BUSY-pin signaling** — the one genuinely new concept relative to the
 * SX127x bridge, required because SX126x's SPI model has no equivalent: a
 * real SX126x asserts a hardware BUSY line while it's internally processing
 * the previous command, and the datasheet requires the host wait for it to
 * clear before issuing the next one. This protocol can't forward a raw GPIO
 * level over a byte stream, so instead the bridge itself is expected to wait
 * out BUSY before ever touching the chip, and to report back explicitly
 * when it had to: `BridgeStatus.BUSY` (distinct from `OK`/`ERROR`) means
 * "the chip was still busy when I received this command; I did not execute
 * it, retry after a short backoff" — never "I executed it while busy" (that
 * would risk corrupting an in-flight chip transaction). `Sx126xBridgeClient`
 * (`lora-serial-sx1262.ts`) retries automatically on `BUSY`, same posture as
 * `Sx127xBridgeClient` retrying a plain timeout, just with a distinguishable
 * reason.
 *
 * Frame shape, request and response alike, and the checksum/resync
 * behavior, are otherwise an intentional byte-for-byte copy of
 * `sx127x-bridge-protocol.ts`'s own framing — reused "as a form" per this
 * project's own precedent (chip-agnostic transport-level framing), but
 * re-implemented independently in this file rather than imported, so this
 * new, less-proven protocol can never risk the working SX127x one:
 * `[SOF=0xAA][type][len][...payload (len bytes)...][checksum]` — `type` is
 * a `BridgeCommand` on a request, a `BridgeStatus` on its response;
 * `checksum` is a single-byte XOR of `type`, `len`, and every payload byte.
 */

export const FRAME_SOF = 0xaa;
/** Header (SOF+type+len) + trailing checksum byte — every frame's fixed overhead around its payload. */
const FRAME_OVERHEAD_BYTES = 4;
/** `len` is a single byte, so no frame can ever claim a bigger payload than this — matches `sx127x-bridge-protocol.ts`'s own bound, still generous for the largest `QUERY`/`EXECUTE` payload this driver ever builds (a `WriteBuffer` burst at this driver's MTU). */
export const MAX_FRAME_PAYLOAD_BYTES = 0xff;
/** Anti-DoS bound on the incremental parse buffer (spec §57 resource limits), identical rationale to `sx127x-bridge-protocol.ts`'s own. */
const MAX_ACCUMULATOR_BYTES = 8192;

/** Host → device commands. */
export enum BridgeCommand {
  /** No payload. Resets the chip to a known state (mirrors pulling its hardware RESET pin, which also needs the bridge to wait out the chip's own post-reset BUSY assertion before returning `OK`). */
  RESET = 0x01,
  /** Payload: `[opcode, ...params]` — an SX126x command that produces no response data of its own (e.g. `SetStandby`, `SetTx`, `WriteBuffer`, `ClearIrqStatus`). No response payload on success. */
  EXECUTE = 0x02,
  /** Payload: `[expectedResponseLength, opcode, ...params]` — an SX126x command that does produce response data (e.g. `GetStatus`, `GetIrqStatus`, `ReadBuffer`). Response payload on success: exactly `expectedResponseLength` bytes read back from the chip. */
  QUERY = 0x03,
}

/** Device → host response status byte. */
export enum BridgeStatus {
  OK = 0x00,
  ERROR = 0x01,
  /** The chip's BUSY line was still asserted when this command arrived — not executed, retry. See this file's own doc comment for why this exists (no equivalent on the SX127x bridge, which has no BUSY pin to model). */
  BUSY = 0x02,
}

export interface BridgeFrame {
  /** A `BridgeCommand` value on a request frame, a `BridgeStatus` value on a response frame — same "no separate request/response marker" simplification `sx127x-bridge-protocol.ts` uses, valid for the identical reason (`Sx126xBridgeClient` never has more than one command outstanding at a time). */
  type: number;
  payload: Buffer;
}

function computeChecksum(type: number, payload: Buffer): number {
  let c = (type ^ payload.length) & 0xff;
  for (const b of payload) c ^= b;
  return c;
}

/** Encodes one frame. Throws synchronously (a programmer error, never something a malformed wire input could trigger) if `payload` exceeds `MAX_FRAME_PAYLOAD_BYTES`. */
export function encodeBridgeFrame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > MAX_FRAME_PAYLOAD_BYTES) {
    throw new RangeError(`bridge frame payload too large: ${payload.length} bytes (max ${MAX_FRAME_PAYLOAD_BYTES})`);
  }
  return Buffer.concat([
    Buffer.from([FRAME_SOF, type & 0xff, payload.length]),
    payload,
    Buffer.from([computeChecksum(type & 0xff, payload)]),
  ]);
}

/**
 * Builds an `EXECUTE` request's payload: `[opcode, ...params]`. `commandBytes` is expected to be
 * exactly what one of `sx126x-commands.ts`'s `build*Command()` functions returns (opcode already
 * included as its first byte) — this is a thin identity passthrough, not a re-encoding, kept as a
 * named function only so callers never have to reason about the frame-level payload shape
 * themselves.
 */
export function buildExecutePayload(commandBytes: Buffer): Buffer {
  return commandBytes;
}

/** Builds a `QUERY` request's payload: `[expectedResponseLength, opcode, ...params]`. */
export function buildQueryPayload(commandBytes: Buffer, expectedResponseLength: number): Buffer {
  if (!Number.isInteger(expectedResponseLength) || expectedResponseLength < 0 || expectedResponseLength > 0xff) {
    throw new RangeError(`expectedResponseLength out of range: ${expectedResponseLength}`);
  }
  return Buffer.concat([Buffer.from([expectedResponseLength]), commandBytes]);
}

/**
 * Incrementally parses frames out of an arbitrarily-chunked byte stream — a direct, independent
 * copy of `sx127x-bridge-protocol.ts`'s own `BridgeFrameReader` (same resync-on-checksum-failure,
 * never-throws posture; see that class's doc comment for the full rationale, unchanged here).
 */
export class BridgeFrameReader {
  private buffer = Buffer.alloc(0);

  /** Appends `chunk` and returns every complete, valid frame it could extract (zero, one, or several). */
  push(chunk: Buffer): BridgeFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: BridgeFrame[] = [];

    for (;;) {
      const sofIndex = this.buffer.indexOf(FRAME_SOF);
      if (sofIndex === -1) {
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1));
        break;
      }
      if (sofIndex > 0) this.buffer = this.buffer.subarray(sofIndex);

      if (this.buffer.length < 3) break;
      const type = this.buffer[1];
      const len = this.buffer[2];
      const total = FRAME_OVERHEAD_BYTES + len;
      if (this.buffer.length < total) break;

      const payload = Buffer.from(this.buffer.subarray(3, 3 + len));
      const receivedChecksum = this.buffer[3 + len];
      if (receivedChecksum === computeChecksum(type, payload)) {
        frames.push({ type, payload });
        this.buffer = this.buffer.subarray(total);
      } else {
        this.buffer = this.buffer.subarray(1);
      }
    }

    if (this.buffer.length > MAX_ACCUMULATOR_BYTES) this.buffer = Buffer.alloc(0);
    return frames;
  }
}
