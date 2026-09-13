import { describe, expect, it } from "vitest";
import {
  BridgeCommand,
  BridgeFrameReader,
  BridgeStatus,
  buildExecutePayload,
  buildQueryPayload,
  encodeBridgeFrame,
} from "../../node/src/transports/sx126x-bridge-protocol.js";

describe("sx126x-bridge-protocol", () => {
  it("encodes and parses a RESET request frame round-trip", () => {
    const reader = new BridgeFrameReader();
    const frames = reader.push(encodeBridgeFrame(BridgeCommand.RESET));
    expect(frames).toEqual([{ type: BridgeCommand.RESET, payload: Buffer.alloc(0) }]);
  });

  it("buildExecutePayload passes the command bytes through unchanged", () => {
    const commandBytes = Buffer.from([0x80, 0x00]);
    expect(buildExecutePayload(commandBytes)).toBe(commandBytes);
  });

  it("buildQueryPayload prepends the expected-response-length byte", () => {
    const commandBytes = Buffer.from([0x12]); // GetIrqStatus opcode
    expect([...buildQueryPayload(commandBytes, 2)]).toEqual([2, 0x12]);
  });

  it("buildQueryPayload rejects an out-of-range expected length", () => {
    expect(() => buildQueryPayload(Buffer.from([0x12]), -1)).toThrow(RangeError);
    expect(() => buildQueryPayload(Buffer.from([0x12]), 256)).toThrow(RangeError);
  });

  it("round-trips a QUERY frame carrying a BUSY response", () => {
    const reader = new BridgeFrameReader();
    const frames = reader.push(encodeBridgeFrame(BridgeStatus.BUSY));
    expect(frames).toEqual([{ type: BridgeStatus.BUSY, payload: Buffer.alloc(0) }]);
  });

  it("BridgeStatus has three distinct values (OK/ERROR/BUSY) — the one new addition over the SX127x bridge", () => {
    expect(new Set([BridgeStatus.OK, BridgeStatus.ERROR, BridgeStatus.BUSY]).size).toBe(3);
  });

  it("splits several frames arriving in one chunk", () => {
    const reader = new BridgeFrameReader();
    const chunk = Buffer.concat([
      encodeBridgeFrame(BridgeCommand.EXECUTE, Buffer.from([0x80, 0x00])),
      encodeBridgeFrame(BridgeStatus.OK),
    ]);
    const frames = reader.push(chunk);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ type: BridgeCommand.EXECUTE, payload: Buffer.from([0x80, 0x00]) });
    expect(frames[1]).toEqual({ type: BridgeStatus.OK, payload: Buffer.alloc(0) });
  });

  it("reassembles one frame arriving split across several chunks", () => {
    const reader = new BridgeFrameReader();
    const whole = encodeBridgeFrame(BridgeCommand.QUERY, Buffer.from([2, 0x12]));
    expect(reader.push(whole.subarray(0, 2))).toEqual([]);
    expect(reader.push(whole.subarray(2, 4))).toEqual([]);
    expect(reader.push(whole.subarray(4))).toEqual([{ type: BridgeCommand.QUERY, payload: Buffer.from([2, 0x12]) }]);
  });

  it("resyncs past a corrupted (checksum-mismatched) frame without getting stuck", () => {
    const reader = new BridgeFrameReader();
    const good = encodeBridgeFrame(BridgeStatus.OK, Buffer.from([1, 2, 3]));
    const corrupted = Buffer.from(good);
    corrupted[corrupted.length - 1] ^= 0xff; // flip the checksum byte
    const frames = reader.push(Buffer.concat([corrupted, encodeBridgeFrame(BridgeCommand.RESET)]));
    expect(frames).toEqual([{ type: BridgeCommand.RESET, payload: Buffer.alloc(0) }]);
  });

  it("drops noise bytes before the first real SOF", () => {
    const reader = new BridgeFrameReader();
    const frames = reader.push(Buffer.concat([Buffer.from([0x00, 0x11, 0x22]), encodeBridgeFrame(BridgeCommand.RESET)]));
    expect(frames).toEqual([{ type: BridgeCommand.RESET, payload: Buffer.alloc(0) }]);
  });

  it("encodeBridgeFrame rejects an oversized payload", () => {
    expect(() => encodeBridgeFrame(BridgeCommand.EXECUTE, Buffer.alloc(256))).toThrow(RangeError);
  });
});
