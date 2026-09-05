import { describe, expect, it } from "vitest";
import {
  IrqFlag,
  LoraMode,
  SX127X_CHIP_VERSION,
  buildModemConfig1Byte,
  buildModemConfig2Byte,
  buildModemConfig3Byte,
  buildOpModeByte,
  extractLoraMode,
  frequencyToRegs,
  regsToFrequency,
} from "../../node/src/transports/sx127x-registers.js";

describe("sx127x-registers", () => {
  it("round-trips a real EU868 frequency (868.1 MHz) through the Frf register formula", () => {
    const hz = 868_100_000;
    const regs = frequencyToRegs(hz);
    const back = regsToFrequency(regs.msb, regs.mid, regs.lsb);
    // FSTEP ~61.035 Hz — the round-trip is exact only up to that granularity, same lossy rounding real hardware has.
    expect(Math.abs(back - hz)).toBeLessThan(61.036);
  });

  it("round-trips the datasheet's own worked example frequency (915 MHz, US band)", () => {
    const hz = 915_000_000;
    const regs = frequencyToRegs(hz);
    expect(regsToFrequency(regs.msb, regs.mid, regs.lsb)).toBeCloseTo(hz, -2);
  });

  it("packs Frf into exactly three bytes, most-significant first", () => {
    const regs = frequencyToRegs(868_100_000);
    expect(regs.msb).toBeGreaterThanOrEqual(0);
    expect(regs.msb).toBeLessThanOrEqual(0xff);
    expect(regs.mid).toBeGreaterThanOrEqual(0);
    expect(regs.mid).toBeLessThanOrEqual(0xff);
    expect(regs.lsb).toBeGreaterThanOrEqual(0);
    expect(regs.lsb).toBeLessThanOrEqual(0xff);
  });

  it("buildOpModeByte always sets LongRangeMode and encodes the requested mode in the low 3 bits", () => {
    const byte = buildOpModeByte(LoraMode.RX_CONTINUOUS);
    expect(byte & 0x80).toBe(0x80);
    expect(extractLoraMode(byte)).toBe(LoraMode.RX_CONTINUOUS);
  });

  it("extractLoraMode ignores LongRangeMode/other bits, only the mode field", () => {
    expect(extractLoraMode(buildOpModeByte(LoraMode.SLEEP))).toBe(LoraMode.SLEEP);
    expect(extractLoraMode(buildOpModeByte(LoraMode.TX))).toBe(LoraMode.TX);
  });

  it("buildModemConfig1Byte rejects an unsupported bandwidth", () => {
    expect(() => buildModemConfig1Byte(123456, 5)).toThrow(/unsupported LoRa bandwidth/);
  });

  it("buildModemConfig1Byte leaves ImplicitHeaderModeOn (bit 0) clear — this driver always uses explicit header", () => {
    const byte = buildModemConfig1Byte(125000, 5);
    expect(byte & 0x01).toBe(0);
  });

  it("buildModemConfig2Byte rejects an out-of-range spreading factor", () => {
    expect(() => buildModemConfig2Byte(5)).toThrow(/spreading factor/);
    expect(() => buildModemConfig2Byte(13)).toThrow(/spreading factor/);
  });

  it("buildModemConfig2Byte always sets RxPayloadCrcOn", () => {
    const byte = buildModemConfig2Byte(7);
    expect(byte & 0b100).toBe(0b100);
  });

  it("buildModemConfig3Byte sets LowDataRateOptimize only when the datasheet requires it (BW<=125kHz and SF>=11)", () => {
    expect(buildModemConfig3Byte(125000, 12) & 0b1000).toBe(0b1000);
    expect(buildModemConfig3Byte(125000, 7) & 0b1000).toBe(0);
    expect(buildModemConfig3Byte(250000, 12) & 0b1000).toBe(0);
  });

  it("buildModemConfig3Byte always sets AgcAutoOn", () => {
    expect(buildModemConfig3Byte(125000, 7) & 0b100).toBe(0b100);
  });

  it("SX127X_CHIP_VERSION is the fixed silicon revision the whole family reports", () => {
    expect(SX127X_CHIP_VERSION).toBe(0x12);
  });

  it("IrqFlag bit values never overlap", () => {
    const values = Object.values(IrqFlag).filter((v): v is number => typeof v === "number");
    let seen = 0;
    for (const v of values) {
      expect(seen & v).toBe(0);
      seen |= v;
    }
  });
});
