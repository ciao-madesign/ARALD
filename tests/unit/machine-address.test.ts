import { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";
import { isThisMachine, machineAddresses, normalizeAddress } from "../../node/src/machine-address.js";

describe("machine-address", () => {
  it("normalizza IPv4 mappato, scope, maiuscole e abbreviazioni IPv6", () => {
    expect(normalizeAddress("::ffff:192.168.1.5")).toBe("192.168.1.5");
    expect(normalizeAddress("FE80::0005%eth0")).toBe("fe80:0:0:0:0:0:0:5");
    expect(normalizeAddress("::1")).toBe("0:0:0:0:0:0:0:1");
    expect(normalizeAddress(undefined)).toBe("?");
  });

  it("la macchina stessa: loopback e ogni indirizzo delle sue interfacce, in qualunque forma", () => {
    for (const a of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) expect(isThisMachine(a), a).toBe(true);
    for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) {
      expect(isThisMachine(i.address), i.address).toBe(true);
      expect(isThisMachine(`::ffff:${i.address}`)).toBe(i.family === "IPv4" || isThisMachine(i.address));
    }
    expect(machineAddresses().has("127.0.0.1")).toBe(true);
  });

  it("un altro dispositivo, un indirizzo assente o malformato non è la macchina", () => {
    for (const a of ["192.0.2.77", "203.0.113.9", "fd00::abcd", "", "non-un-indirizzo", undefined]) expect(isThisMachine(a, () => new Set(["127.0.0.1"])), String(a)).toBe(false);
    expect(isThisMachine("10.0.0.1", () => new Set(["10.0.0.1"]))).toBe(true);
  });
});
