import { once } from "node:events";
import { MockBinding, type MockPortBinding } from "@serialport/binding-mock";
import { SerialPortStream } from "@serialport/stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Identity } from "../../node/src/identity.js";
import { LoraSerialTransport } from "../../node/src/transports/lora-serial.js";
import {
  REG_FRF_LSB,
  REG_FRF_MID,
  REG_FRF_MSB,
  REG_MODEM_CONFIG_1,
  REG_MODEM_CONFIG_2,
  REG_MODEM_CONFIG_3,
  buildModemConfig1Byte,
  buildModemConfig2Byte,
  buildModemConfig3Byte,
  frequencyToRegs,
} from "../../node/src/transports/sx127x-registers.js";
import { FakeSX127xSerialDevice } from "../helpers/fake-sx127x-serial-device.js";

let mockPathCounter = 0;

/**
 * `LoraSerialTransport` is given an already-constructed, already-open
 * `SerialPortStream` rather than opening one itself — see that class's own
 * `start()` doc comment for why: `@serialport/binding-mock` only allows one
 * opener per mock path, and this harness needs `stream.port` (the resulting
 * `MockPortBinding`) to hand to `FakeSX127xSerialDevice`, so the test has to
 * be the one opening it.
 */
async function makeHarness(options: { reportedVersion?: number } = {}): Promise<{
  stream: SerialPortStream;
  device: FakeSX127xSerialDevice;
}> {
  const path = `/dev/mock-sx127x-${mockPathCounter++}`;
  MockBinding.createPort(path, { record: true });
  const stream = new SerialPortStream({ binding: MockBinding, path, baudRate: 57600 });
  await once(stream, "open");
  const device = new FakeSX127xSerialDevice(stream.port as MockPortBinding, options);
  return { stream, device };
}

describe("LoraSerialTransport", () => {
  const transports: LoraSerialTransport[] = [];

  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop()));
    transports.length = 0;
    MockBinding.reset();
  });

  it("start() checks RegVersion and configures the modem registers from the given options", async () => {
    const { stream, device } = await makeHarness();
    const nodeId = Identity.generate().nodeId;
    const transport = new LoraSerialTransport(nodeId, stream, {
      frequencyHz: 868_100_000,
      bandwidthHz: 250_000,
      spreadingFactor: 9,
      codingRateDenominator: 7,
      pollIntervalMs: 5,
    });
    transports.push(transport);

    await transport.start();

    const frf = frequencyToRegs(868_100_000);
    expect(device.readRegisterForTest(REG_FRF_MSB)).toBe(frf.msb);
    expect(device.readRegisterForTest(REG_FRF_MID)).toBe(frf.mid);
    expect(device.readRegisterForTest(REG_FRF_LSB)).toBe(frf.lsb);
    expect(device.readRegisterForTest(REG_MODEM_CONFIG_1)).toBe(buildModemConfig1Byte(250_000, 7));
    expect(device.readRegisterForTest(REG_MODEM_CONFIG_2)).toBe(buildModemConfig2Byte(9));
    expect(device.readRegisterForTest(REG_MODEM_CONFIG_3)).toBe(buildModemConfig3Byte(250_000, 9));
  });

  it("start() uses EU868 (868.1 MHz) and 200-byte MTU defaults when no options are given", async () => {
    const { stream, device } = await makeHarness();
    const transport = new LoraSerialTransport(Identity.generate().nodeId, stream, { pollIntervalMs: 5 });
    transports.push(transport);

    await transport.start();

    const frf = frequencyToRegs(868_100_000);
    expect(device.readRegisterForTest(REG_FRF_MSB)).toBe(frf.msb);
    expect(device.readRegisterForTest(REG_FRF_MID)).toBe(frf.mid);
    expect(device.readRegisterForTest(REG_FRF_LSB)).toBe(frf.lsb);
  });

  it("start() rejects when the chip reports the wrong RegVersion — no chip present, wrong chip, or bridge firmware not running", async () => {
    const { stream } = await makeHarness({ reportedVersion: 0x00 });
    const transport = new LoraSerialTransport(Identity.generate().nodeId, stream, { pollIntervalMs: 5 });
    transports.push(transport);

    await expect(transport.start()).rejects.toThrow(/RegVersion|not responding/);
  });

  it("connect() rejects with a timeout when nothing is ever heard", async () => {
    const { stream } = await makeHarness();
    const transport = new LoraSerialTransport(Identity.generate().nodeId, stream, {
      pollIntervalMs: 5,
      connectTimeoutMs: 100,
    });
    transports.push(transport);
    await transport.start();

    await expect(transport.connect({ host: "irrelevant", port: 0 })).rejects.toThrow(/timeout/);
  });

  it("an 'error' event on the stream never crashes the process — a permanent listener is registered at construction", async () => {
    // Regression test: an earlier version only ever attached a `.once("error", ...)` inside
    // waitForStreamOpen()'s not-yet-open branch, so a stream handed in already open (this harness's
    // usual case, and every other test in this file) had zero error listeners — Node throws
    // synchronously on an 'error' event with none attached, which found by review would crash the
    // whole process on a real serial disconnect. `expect(...).not.toThrow()` on the emit itself is
    // the actual assertion — if the fix regressed, this call would throw synchronously and fail the
    // test (or, without try/catch anywhere, crash the test runner).
    const { stream } = await makeHarness();
    const transport = new LoraSerialTransport(Identity.generate().nodeId, stream, { pollIntervalMs: 5 });
    transports.push(transport);
    await transport.start();

    expect(() => stream.emit("error", new Error("simulated serial I/O failure"))).not.toThrow();
  });
});
