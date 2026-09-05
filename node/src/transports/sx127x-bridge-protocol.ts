/**
 * Wire framing for talking to an SX127x LoRa module over a serial link, used
 * by `LoraSerialTransport` (`lora-serial.ts`). **This protocol is this
 * project's own invention, not a real product's** — a real Ra-02/RFM95
 * breakout is a bare SPI+GPIO device, it doesn't speak serial at all (see
 * `lora-serial.ts`'s own doc comment for why a serial *bridge* — a small MCU
 * that talks SPI to the chip and USB-serial to the host, the shape of every
 * common "LoRa USB dongle" — is the only connectivity path portable across
 * both ARALD Box, which has a GPIO header, and ARALD Portable, an arbitrary
 * x86-64 PC that almost never does). Whoever wires this driver up against a
 * real acquired dongle will very likely need to swap this framing for
 * whatever that dongle's own firmware actually speaks — only the *chip
 * register semantics* underneath (`sx127x-registers.ts`, datasheet-derived)
 * would carry over unchanged.
 *
 * Frame shape, request and response alike:
 * `[SOF=0xAA][type][len][...payload (len bytes)...][checksum]`
 * — `type` is a `BridgeCommand` on a request, a `BridgeStatus` on its
 * response; `checksum` is a single-byte XOR of `type`, `len`, and every
 * payload byte, sufficient to catch a corrupted frame on a wired local link
 * (not a cryptographic integrity claim — same trust boundary as `DockerClient`
 * treating the Docker daemon as a trusted local system, not adversarial
 * network input).
 */

export const FRAME_SOF = 0xaa;
/** Header (SOF+type+len) + trailing checksum byte — every frame's fixed overhead around its payload. */
const FRAME_OVERHEAD_BYTES = 4;
/** `len` is a single byte, so no frame can ever claim a bigger payload than this regardless of what's actually available (matches this driver's own MTU of 200, with headroom). */
export const MAX_FRAME_PAYLOAD_BYTES = 0xff;
/** Anti-DoS bound on the incremental parse buffer (spec §57 resource limits) — a link that never produces a valid SOF byte must not grow this without limit. Generous headroom over the largest legitimate frame. */
const MAX_ACCUMULATOR_BYTES = 8192;

/** Host → device commands. */
export enum BridgeCommand {
  /** No payload. Resets the chip to a known state (mirrors pulling its hardware RESET pin). */
  RESET = 0x01,
  /** Payload: `[addr]`. Response payload on success: `[value]`. */
  READ_REG = 0x02,
  /** Payload: `[addr, value]`. No response payload. */
  WRITE_REG = 0x03,
  /** Payload: the raw bytes to burst-write into the FIFO at its current address pointer. No response payload. */
  FIFO_WRITE = 0x04,
  /** Payload: `[count]`. Response payload on success: `count` bytes read from the FIFO at its current address pointer. */
  FIFO_READ = 0x05,
}

/** Device → host response status byte. */
export enum BridgeStatus {
  OK = 0x00,
  ERROR = 0x01,
}

export interface BridgeFrame {
  /** A `BridgeCommand` value on a request frame, a `BridgeStatus` value on a response frame — this protocol has no separate "is this a request or response" marker, since exactly one command is ever outstanding at a time (`Sx127xBridgeClient`'s own doc comment explains why that's an acceptable simplification here). */
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
 * Incrementally parses frames out of an arbitrarily-chunked byte stream —
 * the same "bytes arrive in whatever grouping the transport layer feels
 * like" reality `TcpTransport`'s `readline`-based framing and
 * `simulated-link.ts`'s `FragmentReassembler` both already have to handle,
 * just with this project's own binary framing instead of newline-JSON or
 * pre-chunked `Fragment` objects.
 *
 * Never throws on malformed input (a torn frame, a checksum mismatch, noise
 * before the first real `SOF` byte) — same posture as `decodePacket()`'s
 * try/catch and `FragmentReassembler.addFragment()`'s bounds checks: a
 * single corrupted frame from a real, noisy radio link must never crash the
 * process. On a checksum failure or an invalid `len`, it resyncs by
 * discarding one byte and re-scanning for the next `SOF`, rather than
 * getting stuck forever on the same corrupt prefix.
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
        // No SOF anywhere yet — keep only enough tail to still recognize a SOF that arrives split
        // across chunks, bounded so a stream that never produces one can't grow this without limit.
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1));
        break;
      }
      if (sofIndex > 0) this.buffer = this.buffer.subarray(sofIndex); // drop leading noise before SOF

      if (this.buffer.length < 3) break; // need SOF+type+len before anything else can be known
      const type = this.buffer[1];
      const len = this.buffer[2];
      const total = FRAME_OVERHEAD_BYTES + len;
      if (this.buffer.length < total) break; // frame not fully arrived yet

      const payload = Buffer.from(this.buffer.subarray(3, 3 + len));
      const receivedChecksum = this.buffer[3 + len];
      if (receivedChecksum === computeChecksum(type, payload)) {
        frames.push({ type, payload });
        this.buffer = this.buffer.subarray(total);
      } else {
        // Corrupt frame — resync by dropping just the SOF byte we anchored on and rescanning,
        // rather than the whole claimed frame length (which is exactly the part we can't trust).
        this.buffer = this.buffer.subarray(1);
      }
    }

    if (this.buffer.length > MAX_ACCUMULATOR_BYTES) this.buffer = Buffer.alloc(0); // never seen a real link do this; defensive only
    return frames;
  }
}
