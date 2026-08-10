import { describe, expect, it } from "vitest";
import { DEFAULT_TTL, MessageType, createPacket, decodePacket, encodePacket } from "../../node/src/packet.js";

describe("packet", () => {
  it("creates a packet with sane defaults", () => {
    const packet = createPacket({ type: MessageType.HELLO, source: "A", payload: {} });
    expect(packet.version).toBe(1);
    expect(packet.ttl).toBe(DEFAULT_TTL);
    expect(packet.id).toBeTruthy();
    expect(packet.destination).toBeUndefined();
  });

  it("generates unique ids for each packet", () => {
    const a = createPacket({ type: MessageType.PING, source: "A", payload: {} });
    const b = createPacket({ type: MessageType.PING, source: "A", payload: {} });
    expect(a.id).not.toBe(b.id);
  });

  it("round-trips through encode/decode", () => {
    const packet = createPacket({ type: MessageType.DATA, source: "A", destination: "B", payload: { hello: "world" } });
    const decoded = decodePacket(encodePacket(packet).trim());
    expect(decoded).toEqual(packet);
  });

  it("rejects malformed packets", () => {
    expect(() => decodePacket(JSON.stringify({ foo: "bar" }))).toThrow();
    expect(() => decodePacket("not json")).toThrow();
  });
});
