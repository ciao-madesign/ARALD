/**
 * SX1261/62/68 ("SX126x") SPI command opcodes and pure helper math — the equivalent of
 * `sx127x-registers.ts` for the *other* chip family this codebase now targets (`docs/beacon.md`/
 * `docs/compliance.md`, 9 settembre 2026: ARALD standardizes on SX1262 across Box, Portable, and
 * Card, replacing the SX127x plan for Box/Portable, so Box and Card can be tested against each
 * other on the same real LoRa link).
 *
 * **Not the same chip model as SX127x** — this is not an adaptation of `sx127x-registers.ts`.
 * SX127x exposes a flat register map (read/write one byte at address X); SX126x exposes an
 * opcode+parameter *command* interface with handshaking on a separate BUSY pin (the host must not
 * issue a new command while BUSY is asserted). Every function here builds/parses the *exact bytes*
 * a real SX126x expects for one SPI transaction — `[opcode, ...params]` for a command, `[...bytes]`
 * for a response — never a single register address/value pair.
 *
 * **Verification provenance, since this session has no internet access to the actual Semtech PDF
 * datasheet**: every opcode, parameter layout, enum value, and IRQ bit below was checked against
 * Semtech's own official open-source reference driver, fetched from GitHub during this session
 * (`raw.githubusercontent.com` was reachable even when `github.com`/most other sites were not) —
 * `github.com/Lora-net/sx126x_driver` (`src/sx126x.c`/`src/sx126x.h`, the manufacturer's own
 * embedded C implementation) and `github.com/Lora-net/LoRaMac-node` (`src/radio/sx126x/sx126x.c`,
 * for the Hz→PLL-step frequency formula, which isn't in the smaller driver repo). Quoted verbatim
 * from that source in the comments below wherever a value could be exactly confirmed; anything not
 * independently found in either of those two files is called out explicitly as such, not presented
 * as verified — same honesty convention `sx127x-registers.ts`'s own doc comment established, applied
 * here to a case where the *usual* verification method (reading the datasheet PDF directly) wasn't
 * available and a different, still-citable source had to substitute for it.
 */

/** SPI command opcodes — the subset this minimal point-to-point driver actually issues. Verified against `sx126x_commands_e` in `Lora-net/sx126x_driver`'s `sx126x.c` (quoted directly from that enum). */
export enum Sx126xOpcode {
  CLR_IRQ_STATUS = 0x02,
  WRITE_REGISTER = 0x0d,
  WRITE_BUFFER = 0x0e,
  GET_STATUS = 0xc0,
  SET_DIO_IRQ_PARAMS = 0x08,
  READ_REGISTER = 0x1d,
  READ_BUFFER = 0x1e,
  GET_RX_BUFFER_STATUS = 0x13,
  GET_IRQ_STATUS = 0x12,
  SET_STANDBY = 0x80,
  SET_RX = 0x82,
  SET_TX = 0x83,
  SET_RF_FREQUENCY = 0x86,
  SET_PACKET_TYPE = 0x8a,
  SET_MODULATION_PARAMS = 0x8b,
  SET_PACKET_PARAMS = 0x8c,
  SET_TX_PARAMS = 0x8e,
  SET_BUFFER_BASE_ADDRESS = 0x8f,
}

/** `SetStandby`'s single parameter byte — this driver always uses `RC` (the chip's fast, low-power standby oscillator), never `XOSC`, matching `sx127x-registers.ts`'s own precedent of not modeling every chip option, only what this driver's scope needs. Verified: `sx126x_standby_cfgs_e` in `sx126x.h`. */
export enum StandbyConfig {
  RC = 0x00,
  XOSC = 0x01,
}

/** `SetPacketType`'s single parameter byte. This driver is LoRa-only (never GFSK) — `buildSetPacketTypeCommand()` below hardcodes `LORA`, this enum exists only so that choice is a named constant, not a bare `0x01`. Verified: `sx126x_pkt_types_e` in `sx126x.h`. */
export enum PacketType {
  GFSK = 0x00,
  LORA = 0x01,
}

/** `SetPacketParams` (LoRa)'s header-type byte — `EXPLICIT` (the packet's own length travels over the air) is the only mode this driver uses, same choice `sx127x-registers.ts` made for the equivalent SX127x setting and for the same reason (this driver never pre-declares a fixed payload length). Verified: `sx126x_lora_pkt_len_modes_e` in `sx126x.h`. */
export enum HeaderType {
  EXPLICIT = 0x00,
  IMPLICIT = 0x01,
}

/** `GetStatus` response byte, bits [6:4] — read-back chip mode. Used by this driver's `start()` as its sanity check (see `lora-serial-sx1262.ts`): SX126x has no simple single-register "chip version" byte the way SX127x's `RegVersion` provides, so confirming the chip reports `STBY_RC` right after this driver puts it there is the closest equivalent "yes, a real chip is actually there and behaving correctly" check available without one. Verified: `sx126x_chip_modes_e` in `sx126x.h`. */
export enum ChipMode {
  UNUSED = 0,
  RFU = 1,
  STBY_RC = 2,
  STBY_XOSC = 3,
  FS = 4,
  RX = 5,
  TX = 6,
}
/** Bit position/mask for the chip-mode field inside a `GetStatus` response byte. Verified: `SX126X_CHIP_MODES_POS`/`SX126X_CHIP_MODES_MASK` in `sx126x.h` (`POS=4`, `MASK=0x07<<4`). */
const CHIP_MODE_POS = 4;
const CHIP_MODE_MASK = 0x07 << CHIP_MODE_POS;

/** Extracts the chip-mode field from a raw `GetStatus` response byte — see `ChipMode`'s own doc comment for why this driver relies on it. */
export function parseChipMode(statusByte: number): ChipMode {
  return ((statusByte & CHIP_MODE_MASK) >> CHIP_MODE_POS) as ChipMode;
}

/**
 * `SetTx`/`SetRx`'s shared 24-bit timeout parameter, in units of "RTC steps" (1 step ≈ 15.625 µs,
 * i.e. 64 steps/ms — verified: a comment in `sx126x.h` gives the conversion `timeout_duration_ms =
 * timeout_in_rtc_step × (1/64)`). This driver only ever uses the two special values below, never an
 * arbitrary duration — same "keep the parameter space this driver actually exercises small and
 * verifiable" posture as `sx127x-registers.ts`.
 */
export const RX_TX_SINGLE_MODE = 0x000000;
/** `SetRx`'s continuous-receive special value — the chip keeps receiving indefinitely instead of returning to standby after one packet. Verified: `SX126X_RX_CONTINUOUS` in `sx126x.h` (`0x00FFFFFF`). Not a valid value for `SetTx` (transmission is always single-shot in this driver — there is no such thing as "continuous TX" for a data link). */
export const RX_CONTINUOUS = 0x00ffffff;

/** `RegModemConfig1`-equivalent for SX126x's `SetModulationParams` — a 4-bit `bw` field, but unlike SX127x's own bandwidth codes, these are NOT sequential with frequency (found while verifying — a real, easy-to-get-wrong fact about this chip, not this driver's invention). Verified: `sx126x_lora_bw_e` in `sx126x.h`, quoted exactly. */
const BANDWIDTH_CODE: Record<number, number> = {
  7810: 0x00, // BW_007 — the datasheet's own shorthand names round to kHz; this driver keys by the closer-to-exact Hz value it actually configures (matches sx127x-registers.ts's own convention)
  10420: 0x08, // BW_010
  15630: 0x01, // BW_015
  20830: 0x09, // BW_020
  31250: 0x02, // BW_031
  41670: 0x0a, // BW_041
  62500: 0x03, // BW_062
  125000: 0x04, // BW_125
  250000: 0x05, // BW_250
  500000: 0x06, // BW_500
};

/** `SetModulationParams`'s `cr` field — same `codingRateDenominator - 4` mapping `sx127x-registers.ts`'s own `buildModemConfig1Byte()` uses for the SX127x equivalent (coincidentally identical between the two chip families, verified independently here rather than assumed from that fact alone). Verified: `sx126x_lora_cr_e` in `sx126x.h` (`CR_4_5=0x01` .. `CR_4_8=0x04`). */
function codingRateCode(codingRateDenominator: 5 | 6 | 7 | 8): number {
  return codingRateDenominator - 4;
}

/**
 * SX126x's crystal (`XTAL`) is 32 MHz, same as SX127x's, but the frequency register is a 32-bit
 * value over a 25-bit PLL range (`Frf = round(f_RF / FSTEP)`, `FSTEP = FXOSC / 2^25`) — not
 * SX127x's 24-bit-over-19-bit scheme. Verified: `SX126X_XTAL_FREQ`/`SX126X_PLL_STEP_SHIFT_AMOUNT`/
 * `SX126X_PLL_STEP_SCALED` and `SX126xConvertFreqInHzToPllStep()` in `LoRaMac-node`'s
 * `src/radio/sx126x/sx126x.c` — that function splits the division into integer+fractional halves to
 * avoid overflowing a 32-bit multiply on an embedded target; done here as one direct `FSTEP`
 * division instead (mathematically equivalent — verified by hand: `hz * 2^25 / 32e6 == hz / (32e6 /
 * 2^25)`), safe in JS because dividing by `FSTEP` first keeps every intermediate value under ~1e9,
 * nowhere near `Number.MAX_SAFE_INTEGER` — unlike multiplying `hz` by `2^25` *first* would (~3×10^16
 * for a typical EU868 frequency, which would silently lose precision).
 */
const XTAL_FREQ_HZ = 32_000_000;
export const FREQUENCY_STEP_HZ = XTAL_FREQ_HZ / 2 ** 25;

/** Converts a desired carrier frequency in Hz to the 32-bit `SetRfFrequency` parameter value. */
export function frequencyToPllSteps(hz: number): number {
  return Math.round(hz / FREQUENCY_STEP_HZ);
}

/** Inverse of `frequencyToPllSteps()` — converts a raw PLL-step value back to the frequency in Hz it encodes (lossy only up to `FREQUENCY_STEP_HZ`'s own rounding, same real-hardware limitation `sx127x-registers.ts`'s `regsToFrequency()` documents for its own, coarser step). */
export function pllStepsToFrequency(steps: number): number {
  return Math.round(steps * FREQUENCY_STEP_HZ);
}

/** `GetIrqStatus`'s 2-byte response, and `SetDioIrqParams`/`ClearIrqStatus`'s mask parameters — a 16-bit field, unlike SX127x's single `RegIrqFlags` byte. Only the subset this driver actually reads/clears is named (same "real bits, most left out of scope" posture as `sx127x-registers.ts`'s own `IrqFlag`). Verified: `sx126x_irq_masks_e` in `sx126x.h`, quoted exactly (`TX_DONE=1<<0`, `RX_DONE=1<<1`, `HEADER_ERROR=1<<5` — bit 5, not adjacent to the others, a real fact about this chip's bit layout — `CRC_ERROR=1<<6`, `TIMEOUT=1<<9`). */
export enum IrqFlag {
  TX_DONE = 1 << 0,
  RX_DONE = 1 << 1,
  HEADER_ERROR = 1 << 5,
  CRC_ERROR = 1 << 6,
  TIMEOUT = 1 << 9,
}

/** Builds `SetStandby`'s full command bytes (opcode + 1-byte param). Verified layout: `sx126x_set_standby()` in `sx126x.c`. */
export function buildSetStandbyCommand(cfg: StandbyConfig = StandbyConfig.RC): Buffer {
  return Buffer.from([Sx126xOpcode.SET_STANDBY, cfg]);
}

/** Builds `SetPacketType`'s full command bytes — always `LORA`, see this driver's own LoRa-only scope note on the `PacketType` enum. Verified layout: `sx126x_set_pkt_type()` in `sx126x.c`. */
export function buildSetPacketTypeCommand(): Buffer {
  return Buffer.from([Sx126xOpcode.SET_PACKET_TYPE, PacketType.LORA]);
}

/** Builds `SetRfFrequency`'s full command bytes (opcode + 4-byte big-endian PLL step value). Verified layout: `sx126x_set_rf_freq_in_pll_steps()` in `sx126x.c`. */
export function buildSetRfFrequencyCommand(hz: number): Buffer {
  const steps = frequencyToPllSteps(hz);
  return Buffer.from([Sx126xOpcode.SET_RF_FREQUENCY, (steps >>> 24) & 0xff, (steps >>> 16) & 0xff, (steps >>> 8) & 0xff, steps & 0xff]);
}

/**
 * Builds `SetModulationParams` (LoRa)'s full command bytes: opcode + `[sf, bw, cr, ldro]`. `ldro`
 * (low-data-rate optimization) uses the exact same condition `sx127x-registers.ts`'s own
 * `buildModemConfig3Byte()` applies for SX127x (bandwidth ≤125 kHz *and* spreading factor ≥11) —
 * same datasheet requirement, independently applicable to this chip family too, not copied from
 * that file without re-checking it applies here (SX126x's own datasheet section on this setting
 * states the identical condition, per the driver-source comments accompanying `sx126x_lora_mod_params_t`
 * — `ldro` field description). Verified layout: `sx126x_set_lora_mod_params()` in `sx126x.c`.
 */
export function buildSetModulationParamsCommand(spreadingFactor: number, bandwidthHz: number, codingRateDenominator: 5 | 6 | 7 | 8): Buffer {
  if (!Number.isInteger(spreadingFactor) || spreadingFactor < 5 || spreadingFactor > 12) {
    throw new RangeError(`unsupported LoRa spreading factor: ${spreadingFactor} (must be an integer 5-12 — SX126x supports SF5, SX127x does not)`);
  }
  const bwCode = BANDWIDTH_CODE[bandwidthHz];
  if (bwCode === undefined) {
    throw new RangeError(`unsupported LoRa bandwidth: ${bandwidthHz} Hz (must be one of ${Object.keys(BANDWIDTH_CODE).join(", ")})`);
  }
  const needsLowDataRateOptimize = bandwidthHz <= 125000 && spreadingFactor >= 11;
  return Buffer.from([
    Sx126xOpcode.SET_MODULATION_PARAMS,
    spreadingFactor,
    bwCode,
    codingRateCode(codingRateDenominator),
    needsLowDataRateOptimize ? 1 : 0,
  ]);
}

/**
 * Builds `SetPacketParams` (LoRa)'s full command bytes: opcode + `[preambleLen(2B), headerType,
 * payloadLen, crcOn, invertIq]`. This driver always sets `crcOn=1` (relies on `CRC_ERROR`, `IrqFlag`,
 * to reject a corrupted receive rather than trusting an unchecked payload — same choice
 * `sx127x-registers.ts`'s `buildModemConfig2Byte()` makes for SX127x's `RxPayloadCrcOn`) and
 * `invertIq=0` (this driver is never in the "IQ inverted" mode some LoRaWAN gateway configurations
 * use). `preambleLenInSymbols` defaults to 8, a conventional LoRa preamble length with no special
 * significance to this driver — Semtech's own examples use the same default. Verified layout:
 * `sx126x_set_lora_pkt_params()` in `sx126x.c`.
 */
export function buildSetPacketParamsCommand(payloadLength: number, preambleLenInSymbols = 8): Buffer {
  return Buffer.from([
    Sx126xOpcode.SET_PACKET_PARAMS,
    (preambleLenInSymbols >>> 8) & 0xff,
    preambleLenInSymbols & 0xff,
    HeaderType.EXPLICIT,
    payloadLength & 0xff,
    1, // crcOn
    0, // invertIq
  ]);
}

/**
 * Builds `SetTxParams`'s full command bytes: opcode + `[powerDbm, rampTime]`. `rampTime` fixed at
 * `RAMP_200_US` (a mid-range, unremarkable value — not modeled as an option, same "narrow the
 * parameter space to what this driver's scope needs" posture as everywhere else here) —
 * `powerDbm` is signed (SX126x supports negative dBm values for very low power); this driver
 * clamps to the conservative, always-safe [-9, +14] dBm range regardless of the PA configuration in
 * use (a real deployment could reach up to +22 dBm with the high-power PA config and `SetPaConfig`,
 * not modeled by this first slice). Verified layout: `sx126x_set_tx_params()` in `sx126x.c`;
 * `RAMP_200_US` value verified: `sx126x_ramp_time_e` in `sx126x.h`.
 */
const RAMP_200_US = 0x04;
export function buildSetTxParamsCommand(powerDbm: number): Buffer {
  const clamped = Math.max(-9, Math.min(14, Math.round(powerDbm)));
  return Buffer.from([Sx126xOpcode.SET_TX_PARAMS, clamped & 0xff, RAMP_200_US]);
}

/** Builds `SetBufferBaseAddress`'s full command bytes (opcode + 2 params) — same "one shared base address for both TX and RX" choice `lora-serial.ts`'s own `FIFO_BASE_ADDR` makes for SX127x, valid for the identical reason (this driver is never transmitting and receiving at once). Verified layout: `sx126x_set_buffer_base_address()` in `sx126x.c`. */
export function buildSetBufferBaseAddressCommand(txBaseAddress: number, rxBaseAddress: number): Buffer {
  return Buffer.from([Sx126xOpcode.SET_BUFFER_BASE_ADDRESS, txBaseAddress & 0xff, rxBaseAddress & 0xff]);
}

/** Builds `SetTx`'s full command bytes — always single-shot (`RX_TX_SINGLE_MODE`, the only valid choice for TX — see that constant's own doc comment). Verified layout: `sx126x_set_tx()` in `sx126x.c`. */
export function buildSetTxCommand(): Buffer {
  const t = RX_TX_SINGLE_MODE;
  return Buffer.from([Sx126xOpcode.SET_TX, (t >>> 16) & 0xff, (t >>> 8) & 0xff, t & 0xff]);
}

/** Builds `SetRx`'s full command bytes — always `RX_CONTINUOUS` (this driver's RX poll loop, mirroring `lora-serial.ts`'s own IRQ-polling design for SX127x, expects the chip to keep listening indefinitely between polls, not fall back to standby after one packet). Verified layout: `sx126x_set_rx()` in `sx126x.c` (same parameter shape as `SetTx`). */
export function buildSetRxContinuousCommand(): Buffer {
  const t = RX_CONTINUOUS;
  return Buffer.from([Sx126xOpcode.SET_RX, (t >>> 16) & 0xff, (t >>> 8) & 0xff, t & 0xff]);
}

/** Builds `SetDioIrqParams`'s full command bytes: opcode + four 16-bit masks (IRQ, DIO1, DIO2, DIO3). This driver routes every IRQ of interest to DIO1 (the conventional choice, and irrelevant anyway since this driver polls `GetIrqStatus` rather than watching a real DIO1 edge — same declared limitation `lora-serial.ts`'s own class doc states for SX127x's `DIO0`) and leaves DIO2/DIO3 unmapped (`0`). Verified layout: `sx126x_set_dio_irq_params()` in `sx126x.c`. */
export function buildSetDioIrqParamsCommand(irqMask: number): Buffer {
  return Buffer.from([
    Sx126xOpcode.SET_DIO_IRQ_PARAMS,
    (irqMask >>> 8) & 0xff,
    irqMask & 0xff,
    (irqMask >>> 8) & 0xff, // dio1Mask — same mask as irqMask, see doc comment
    irqMask & 0xff,
    0,
    0, // dio2Mask, unused
    0,
    0, // dio3Mask, unused
  ]);
}

/** Builds `ClearIrqStatus`'s full command bytes (opcode + 16-bit mask). Verified layout: `sx126x_clear_irq_status()` in `sx126x.c`. */
export function buildClearIrqStatusCommand(mask: number): Buffer {
  return Buffer.from([Sx126xOpcode.CLR_IRQ_STATUS, (mask >>> 8) & 0xff, mask & 0xff]);
}

/** Builds `GetIrqStatus`'s command byte (opcode only — this driver's bridge protocol, unlike real SPI, has no need for a trailing NOP byte to "make room" for the response; see `sx126x-bridge-protocol.ts`'s own doc comment on why `QUERY` carries its expected response length as a separate field instead). Verified opcode: `sx126x_get_irq_status()` in `sx126x.c`. */
export function buildGetIrqStatusCommand(): Buffer {
  return Buffer.from([Sx126xOpcode.GET_IRQ_STATUS]);
}

/** Parses `GetIrqStatus`'s 2-byte response into the 16-bit IRQ status value. Verified: `sx126x_get_irq_status()` in `sx126x.c` combines the two bytes as `(byte[0] << 8) + byte[1]` — byte 0 most significant. */
export function parseIrqStatus(bytes: Buffer): number {
  if (bytes.length < 2) throw new Error("malformed GetIrqStatus response: expected 2 bytes");
  return (bytes[0] << 8) | bytes[1];
}

/** Builds `GetRxBufferStatus`'s command byte. Verified opcode: `sx126x_get_rx_buffer_status()` in `sx126x.c`. */
export function buildGetRxBufferStatusCommand(): Buffer {
  return Buffer.from([Sx126xOpcode.GET_RX_BUFFER_STATUS]);
}

/** Parses `GetRxBufferStatus`'s 2-byte response. Verified: `sx126x_get_rx_buffer_status()` in `sx126x.c` — byte 0 is `pld_len_in_bytes`, byte 1 is `buffer_start_pointer` (i.e. where in the chip's shared data buffer this received packet actually starts, not necessarily the RX base address configured via `SetBufferBaseAddress` — real hardware can offset it). */
export function parseRxBufferStatus(bytes: Buffer): { payloadLength: number; rxStartBufferPointer: number } {
  if (bytes.length < 2) throw new Error("malformed GetRxBufferStatus response: expected 2 bytes");
  return { payloadLength: bytes[0], rxStartBufferPointer: bytes[1] };
}

/** Builds `GetStatus`'s command byte — see `ChipMode`'s own doc comment for why this driver relies on this instead of a version register. Verified opcode/shape: `sx126x_get_status()` in `sx126x.c` (a 1-byte request, no parameters at all — not even a NOP, unlike every other query command here; a real fact about this specific command, not an inconsistency in this module). */
export function buildGetStatusCommand(): Buffer {
  return Buffer.from([Sx126xOpcode.GET_STATUS]);
}

/** Parses `GetStatus`'s 1-byte response into the chip-mode field — see `parseChipMode()`. Command-status bits (`[3:1]`) are real but not modeled here (this driver only ever needs to confirm "a chip that behaves like an SX126x is present and in the mode we expect", never to distinguish *why* a command failed at this granularity). */
export function parseGetStatusResponse(byte: number): ChipMode {
  return parseChipMode(byte);
}

/** Builds `WriteBuffer`'s full command bytes: opcode + offset + data. Verified layout: `sx126x_write_buffer()` in `sx126x.c`. */
export function buildWriteBufferCommand(offset: number, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([Sx126xOpcode.WRITE_BUFFER, offset & 0xff]), data]);
}

/** Builds `ReadBuffer`'s command bytes (opcode + offset — no trailing NOP needed, see `buildGetIrqStatusCommand()`'s own comment on why). Verified layout/opcode: `sx126x_read_buffer()` in `sx126x.c`. */
export function buildReadBufferCommand(offset: number): Buffer {
  return Buffer.from([Sx126xOpcode.READ_BUFFER, offset & 0xff]);
}

/**
 * The chip's shared TX/RX data buffer size in bytes. **Not independently confirmed against either
 * open-source file fetched this session** (neither `sx126x_driver` nor `LoRaMac-node` defines an
 * explicit named constant for it, only individual buffer-access functions) — 256 bytes is the value
 * universally published in every SX1261/62/68 datasheet's own "Data Buffer" section (the same size
 * as the SX127x family this codebase's other real LoRa driver already targets), but flagged
 * honestly here as *not* independently re-verified this session the way every other constant above
 * was, per this project's own convention of never presenting an unverified claim as checked.
 */
export const CHIP_BUFFER_SIZE = 256;
