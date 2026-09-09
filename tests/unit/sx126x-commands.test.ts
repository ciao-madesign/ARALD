import { describe, expect, it } from "vitest";
import {
  ChipMode,
  FREQUENCY_STEP_HZ,
  IrqFlag,
  RX_CONTINUOUS,
  RX_TX_SINGLE_MODE,
  Sx126xOpcode,
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
  frequencyToPllSteps,
  parseChipMode,
  parseGetStatusResponse,
  parseIrqStatus,
  parseRxBufferStatus,
  pllStepsToFrequency,
} from "../../node/src/transports/sx126x-commands.js";

describe("sx126x-commands", () => {
  it("round-trips a real EU868 frequency (868.1 MHz) through the PLL-step formula", () => {
    const hz = 868_100_000;
    const steps = frequencyToPllSteps(hz);
    const back = pllStepsToFrequency(steps);
    // FSTEP ~0.954 Hz — round-trip exact only up to that granularity.
    expect(Math.abs(back - hz)).toBeLessThan(FREQUENCY_STEP_HZ + 0.001);
  });

  it("round-trips the 915 MHz US-band frequency too", () => {
    const hz = 915_000_000;
    expect(pllStepsToFrequency(frequencyToPllSteps(hz))).toBeCloseTo(hz, -1);
  });

  it("frequencyToPllSteps never exceeds Number.MAX_SAFE_INTEGER for a realistic frequency", () => {
    expect(frequencyToPllSteps(868_100_000)).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(frequencyToPllSteps(2_400_000_000))).toBe(true);
  });

  it("buildSetStandbyCommand defaults to RC, opcode first", () => {
    const cmd = buildSetStandbyCommand();
    expect(cmd[0]).toBe(Sx126xOpcode.SET_STANDBY);
    expect(cmd.length).toBe(2);
  });

  it("buildSetRfFrequencyCommand packs the PLL step value as 4 big-endian bytes after the opcode", () => {
    const cmd = buildSetRfFrequencyCommand(868_100_000);
    expect(cmd[0]).toBe(Sx126xOpcode.SET_RF_FREQUENCY);
    expect(cmd.length).toBe(5);
    const steps = (cmd[1] << 24) | (cmd[2] << 16) | (cmd[3] << 8) | cmd[4];
    expect(steps >>> 0).toBe(frequencyToPllSteps(868_100_000));
  });

  it("buildSetModulationParamsCommand rejects an out-of-range spreading factor", () => {
    expect(() => buildSetModulationParamsCommand(4, 125000, 5)).toThrow(/spreading factor/);
    expect(() => buildSetModulationParamsCommand(13, 125000, 5)).toThrow(/spreading factor/);
  });

  it("buildSetModulationParamsCommand accepts SF5 — one wider than SX127x's own floor of 6", () => {
    expect(() => buildSetModulationParamsCommand(5, 125000, 5)).not.toThrow();
  });

  it("buildSetModulationParamsCommand rejects an unsupported bandwidth", () => {
    expect(() => buildSetModulationParamsCommand(7, 123456, 5)).toThrow(/unsupported LoRa bandwidth/);
  });

  it("buildSetModulationParamsCommand sets LDRO only when bandwidth<=125kHz and SF>=11", () => {
    expect(buildSetModulationParamsCommand(12, 125000, 5)[4]).toBe(1);
    expect(buildSetModulationParamsCommand(7, 125000, 5)[4]).toBe(0);
    expect(buildSetModulationParamsCommand(12, 250000, 5)[4]).toBe(0);
  });

  it("buildSetPacketParamsCommand always sets crcOn and never invertIq", () => {
    const cmd = buildSetPacketParamsCommand(42);
    // opcode(0), preambleLen(1-2, 2B), headerType(3), payloadLen(4), crcOn(5), invertIq(6)
    expect(cmd[4]).toBe(42);
    expect(cmd[5]).toBe(1); // crcOn
    expect(cmd[6]).toBe(0); // invertIq
  });

  it("buildSetTxParamsCommand clamps power to [-9, 14] dBm", () => {
    expect(buildSetTxParamsCommand(999)[1]).toBe(14 & 0xff);
    expect(buildSetTxParamsCommand(-999)[1]).toBe(-9 & 0xff);
    expect(buildSetTxParamsCommand(10)[1]).toBe(10);
  });

  it("buildSetBufferBaseAddressCommand packs both offsets after the opcode", () => {
    const cmd = buildSetBufferBaseAddressCommand(0x10, 0x20);
    expect([...cmd]).toEqual([Sx126xOpcode.SET_BUFFER_BASE_ADDRESS, 0x10, 0x20]);
  });

  it("buildSetTxCommand always uses the single-shot timeout value", () => {
    const cmd = buildSetTxCommand();
    const t = (cmd[1] << 16) | (cmd[2] << 8) | cmd[3];
    expect(t).toBe(RX_TX_SINGLE_MODE);
  });

  it("buildSetRxContinuousCommand always uses the RX_CONTINUOUS special timeout value", () => {
    const cmd = buildSetRxContinuousCommand();
    const t = (cmd[1] << 16) | (cmd[2] << 8) | cmd[3];
    expect(t).toBe(RX_CONTINUOUS);
  });

  it("buildSetDioIrqParamsCommand routes the same mask to DIO1 and zeros DIO2/DIO3", () => {
    const cmd = buildSetDioIrqParamsCommand(0x0203);
    expect(cmd.length).toBe(9);
    expect((cmd[1] << 8) | cmd[2]).toBe(0x0203); // irqMask
    expect((cmd[3] << 8) | cmd[4]).toBe(0x0203); // dio1Mask
    expect((cmd[5] << 8) | cmd[6]).toBe(0); // dio2Mask
    expect((cmd[7] << 8) | cmd[8]).toBe(0); // dio3Mask
  });

  it("buildClearIrqStatusCommand/buildGetIrqStatusCommand/parseIrqStatus round-trip a 16-bit value", () => {
    expect(buildGetIrqStatusCommand()).toEqual(Buffer.from([Sx126xOpcode.GET_IRQ_STATUS]));
    expect(parseIrqStatus(Buffer.from([0x02, 0x03]))).toBe(0x0203);
    expect(() => parseIrqStatus(Buffer.from([0x01]))).toThrow(/malformed/);
    const clearCmd = buildClearIrqStatusCommand(IrqFlag.TX_DONE | IrqFlag.RX_DONE);
    expect((clearCmd[1] << 8) | clearCmd[2]).toBe(IrqFlag.TX_DONE | IrqFlag.RX_DONE);
  });

  it("parseRxBufferStatus decodes payloadLength/rxStartBufferPointer in that order", () => {
    expect(parseRxBufferStatus(Buffer.from([5, 10]))).toEqual({ payloadLength: 5, rxStartBufferPointer: 10 });
    expect(() => parseRxBufferStatus(Buffer.from([5]))).toThrow(/malformed/);
  });

  it("GetStatus round-trips a chip mode through parseGetStatusResponse/parseChipMode", () => {
    const statusByte = ChipMode.STBY_RC << 4;
    expect(parseGetStatusResponse(statusByte)).toBe(ChipMode.STBY_RC);
    expect(parseChipMode(statusByte)).toBe(ChipMode.STBY_RC);
    expect(buildGetStatusCommand()).toEqual(Buffer.from([Sx126xOpcode.GET_STATUS]));
  });

  it("buildWriteBufferCommand/buildReadBufferCommand carry the offset right after the opcode", () => {
    expect([...buildWriteBufferCommand(0x05, Buffer.from([1, 2, 3]))]).toEqual([Sx126xOpcode.WRITE_BUFFER, 0x05, 1, 2, 3]);
    expect([...buildReadBufferCommand(0x07)]).toEqual([Sx126xOpcode.READ_BUFFER, 0x07]);
  });

  it("IrqFlag bit values never overlap", () => {
    const values = Object.values(IrqFlag).filter((v): v is number => typeof v === "number");
    let seen = 0;
    for (const v of values) {
      expect(seen & v).toBe(0);
      seen |= v;
    }
  });

  it("buildSetPacketTypeCommand always selects LoRa (this driver is LoRa-only)", () => {
    expect([...buildSetPacketTypeCommand()]).toEqual([Sx126xOpcode.SET_PACKET_TYPE, 1]);
  });
});
