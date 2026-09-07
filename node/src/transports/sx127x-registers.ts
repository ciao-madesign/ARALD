/**
 * SX1276/77/78/79 ("SX127x") register map and pure helper math, taken from
 * the public Semtech datasheet (the same chip family behind the Ra-02/RFM95
 * breakouts `docs/deployment.md` already cites as the LoRa module reference
 * for ARALD Box/Portable). Only the subset `LoraSerialTransport`
 * (`transports/lora-serial.ts`) actually needs — every value here is a
 * documented chip fact, never invented, and independently checkable against
 * any copy of the datasheet. This is deliberately the *only* file in this
 * driver that claims datasheet fidelity: the bridge wire protocol carrying
 * these register reads/writes over a serial link
 * (`sx127x-bridge-protocol.ts`) is this project's own invention, not a real
 * product's — see that file's doc comment.
 */

/** Read/write the 256-byte FIFO through this single address; auto-increments internally on burst access. */
export const REG_FIFO = 0x00;
/** Operating mode + LoRa/FSK mode select — see `OpMode`. */
export const REG_OP_MODE = 0x01;
export const REG_FRF_MSB = 0x06;
export const REG_FRF_MID = 0x07;
export const REG_FRF_LSB = 0x08;
/** PA_BOOST select + output power. Not touched by this driver's fidelity target (TX power isn't modeled), listed for completeness against the datasheet's own register table. */
export const REG_PA_CONFIG = 0x09;
export const REG_FIFO_ADDR_PTR = 0x0d;
export const REG_FIFO_TX_BASE_ADDR = 0x0e;
export const REG_FIFO_RX_BASE_ADDR = 0x0f;
export const REG_FIFO_RX_CURRENT_ADDR = 0x10;
/** TxDone/RxDone/PayloadCrcError/etc. — bits clear **only** when the host writes a 1 to that bit position; writing 0 to a bit leaves it unchanged. A real, easy-to-get-wrong chip quirk this driver and the fake device both need to honor identically. */
export const REG_IRQ_FLAGS = 0x12;
export const REG_RX_NB_BYTES = 0x13;
export const REG_MODEM_CONFIG_1 = 0x1d;
export const REG_MODEM_CONFIG_2 = 0x1e;
export const REG_MODEM_CONFIG_3 = 0x26;
/** Payload length in implicit-header mode; the length of the *last received* packet in explicit-header mode (this driver always uses explicit header, so it only ever reads this one). */
export const REG_PAYLOAD_LENGTH = 0x22;
/** Fixed silicon revision ID for the whole SX1276/77/78/79 family — read-only on real hardware, `start()`'s sanity check that a chip is actually there. */
export const REG_VERSION = 0x42;
export const SX127X_CHIP_VERSION = 0x12;

/** `RegOpMode` bit 7 — must be set for LoRa mode (vs. the chip's FSK/OOK mode, unused by this driver). Per datasheet, only changeable while `Mode` is `SLEEP`. */
export const OP_MODE_LONG_RANGE_MODE_BIT = 0x80;
/** `RegOpMode` bit 3 — required above ~525 MHz vs. below; EU868 needs this cleared (high-frequency mode), listed for completeness. */
export const OP_MODE_LOW_FREQUENCY_MODE_ON_BIT = 0x08;

/** `RegOpMode` bits [2:0] — the seven values the datasheet defines for this field. */
export enum LoraMode {
  SLEEP = 0b000,
  STANDBY = 0b001,
  FSTX = 0b010,
  TX = 0b011,
  FSRX = 0b100,
  RX_CONTINUOUS = 0b101,
  RX_SINGLE = 0b110,
  CAD = 0b111,
}
const LORA_MODE_MASK = 0b111;

/** Builds a `RegOpMode` byte for LoRa mode at the given operating mode (always sets `LongRangeMode`, never touches `LowFrequencyModeOn` — EU868 is always in the chip's high-frequency range). */
export function buildOpModeByte(mode: LoraMode): number {
  return OP_MODE_LONG_RANGE_MODE_BIT | (mode & LORA_MODE_MASK);
}

/** Extracts just the `Mode` field from a `RegOpMode` byte, ignoring `LongRangeMode`/other bits. */
export function extractLoraMode(opModeByte: number): LoraMode {
  return (opModeByte & LORA_MODE_MASK) as LoraMode;
}

/** `RegIrqFlags` bit positions (LoRa mode) — datasheet Table 18. Only the three this driver actually reads/clears are named; the rest of the byte is real but unused here. */
export enum IrqFlag {
  RX_TIMEOUT = 0x80,
  RX_DONE = 0x40,
  PAYLOAD_CRC_ERROR = 0x20,
  VALID_HEADER = 0x10,
  TX_DONE = 0x08,
  CAD_DONE = 0x04,
  FHSS_CHANGE_CHANNEL = 0x02,
  CAD_DETECTED = 0x01,
}

/**
 * Frequency synthesizer step (datasheet §4.1.4): `FSTEP = FXOSC / 2^19`,
 * `FXOSC = 32 MHz` (the chip's crystal oscillator, fixed by the reference
 * design every SX127x breakout uses). `RegFrf` is a 24-bit register split
 * across three 8-bit registers (`Frf = round(f_RF / FSTEP)`); the actual
 * carrier frequency the datasheet's own formula derives from it is
 * `f_RF = Frf * FSTEP`, so the two functions below are exact inverses of
 * each other only up to `FSTEP`'s own rounding — the same lossy round-trip
 * real hardware has, not a bug in either function.
 */
const FXOSC_HZ = 32_000_000;
export const FREQUENCY_STEP_HZ = FXOSC_HZ / 2 ** 19;

/** Converts a desired carrier frequency in Hz to the three `RegFrfMsb/Mid/Lsb` byte values. */
export function frequencyToRegs(hz: number): { msb: number; mid: number; lsb: number } {
  const frf = Math.round(hz / FREQUENCY_STEP_HZ);
  return {
    msb: (frf >> 16) & 0xff,
    mid: (frf >> 8) & 0xff,
    lsb: frf & 0xff,
  };
}

/** Converts `RegFrfMsb/Mid/Lsb` byte values back to the carrier frequency in Hz they encode. */
export function regsToFrequency(msb: number, mid: number, lsb: number): number {
  const frf = ((msb & 0xff) << 16) | ((mid & 0xff) << 8) | (lsb & 0xff);
  return Math.round(frf * FREQUENCY_STEP_HZ);
}

/** `RegModemConfig1`'s 4-bit `Bw` field (datasheet Table 14) — the discrete channel bandwidths the chip supports, keyed by Hz for a friendlier public API than a raw nibble. */
const BANDWIDTH_CODE: Record<number, number> = {
  7800: 0b0000,
  10400: 0b0001,
  15600: 0b0010,
  20800: 0b0011,
  31250: 0b0100,
  41700: 0b0101,
  62500: 0b0110,
  125000: 0b0111,
  250000: 0b1000,
  500000: 0b1001,
};

/**
 * Builds `RegModemConfig1` (bandwidth + coding rate + header mode).
 * `ImplicitHeaderModeOn` (bit 0) is always left `0` (explicit header) — this
 * driver never uses implicit-header mode, so `RegPayloadLength` is only ever
 * read (the length of the last *received* packet), never written to declare
 * one up front.
 */
export function buildModemConfig1Byte(bandwidthHz: number, codingRateDenominator: 5 | 6 | 7 | 8): number {
  const bwCode = BANDWIDTH_CODE[bandwidthHz];
  if (bwCode === undefined) {
    throw new RangeError(`unsupported LoRa bandwidth: ${bandwidthHz} Hz (must be one of ${Object.keys(BANDWIDTH_CODE).join(", ")})`);
  }
  const codingRateCode = codingRateDenominator - 4; // datasheet: 4/5..4/8 encoded as 1..4
  return ((bwCode & 0xf) << 4) | ((codingRateCode & 0b111) << 1);
}

/** Builds `RegModemConfig2` (spreading factor + CRC). `RxPayloadCrcOn` (bit 2) is always set — this driver relies on `PayloadCrcError` (`IrqFlag`) to reject a corrupted receive rather than trusting an unchecked payload. */
export function buildModemConfig2Byte(spreadingFactor: number): number {
  if (!Number.isInteger(spreadingFactor) || spreadingFactor < 6 || spreadingFactor > 12) {
    throw new RangeError(`unsupported LoRa spreading factor: ${spreadingFactor} (must be an integer 6-12)`);
  }
  const RX_PAYLOAD_CRC_ON = 0b100;
  return ((spreadingFactor & 0xf) << 4) | RX_PAYLOAD_CRC_ON;
}

/**
 * Builds `RegModemConfig3` (low-data-rate optimization + AGC). `AgcAutoOn`
 * (bit 2) is always set — the standard choice absent a reason to hand-tune
 * `RegLna` instead, not modeled by this driver. `LowDataRateOptimize`
 * (bit 3) is set only when the datasheet actually requires it (symbol
 * duration exceeding 16ms — bandwidth ≤125kHz *and* spreading factor ≥11),
 * a real, easy-to-miss chip requirement, not an arbitrary choice.
 */
export function buildModemConfig3Byte(bandwidthHz: number, spreadingFactor: number): number {
  const AGC_AUTO_ON = 0b100;
  const LOW_DATA_RATE_OPTIMIZE = 0b1000;
  const needsLowDataRateOptimize = bandwidthHz <= 125000 && spreadingFactor >= 11;
  return AGC_AUTO_ON | (needsLowDataRateOptimize ? LOW_DATA_RATE_OPTIMIZE : 0);
}
