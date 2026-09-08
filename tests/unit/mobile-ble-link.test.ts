import { describe, expect, it } from "vitest";
import {
  FragmentReassembler,
  MAX_FRAGMENTS_PER_MESSAGE,
  base64ToBytes,
  bytesToBase64,
  createHello,
  decodePacket,
  encodePacket,
  fragmentPacket,
} from "../../mobile/www/ble-link.js";

/** Builds a raw wire fragment matching ble-link.js's own header layout: [msgId][index hi][index lo][total hi][total lo][payload...] — used to exercise FragmentReassembler's defensive bounds-checking without going through fragmentPacket() first. */
function rawFragment(msgId: number, index: number, total: number, payload: number[] = [1]): Uint8Array {
  return new Uint8Array([msgId, (index >> 8) & 0xff, index & 0xff, (total >> 8) & 0xff, total & 0xff, ...payload]);
}

describe("mobile/www/ble-link (phone-side BLE protocol logic)", () => {
  describe("encodePacket/decodePacket", () => {
    it("round-trips a packet", () => {
      const packet = { version: 1, id: "abc", type: "DATA", source: "A", ttl: 8, timestamp: 123, priority: 4, payload: { hello: "world" } };
      const decoded = decodePacket(encodePacket(packet).trim());
      expect(decoded).toEqual(packet);
    });

    it("rejects malformed packets, same minimal-envelope validation as node/src/packet.ts", () => {
      expect(() => decodePacket(JSON.stringify({ foo: "bar" }))).toThrow();
      expect(() => decodePacket("not json")).toThrow();
      expect(() => decodePacket(JSON.stringify({ id: "x", type: "HELLO", source: "A" }))).toThrow(); // missing ttl
    });
  });

  describe("createHello", () => {
    it("builds a well-formed HELLO packet", () => {
      const hello = createHello("phone-123");
      expect(hello.type).toBe("HELLO");
      expect(hello.source).toBe("phone-123");
      expect(hello.ttl).toBe(1);
      expect(hello.id).toBeTruthy();
    });

    it("generates a fresh id every call", () => {
      const a = createHello("phone-1");
      const b = createHello("phone-1");
      expect(a.id).not.toBe(b.id);
    });
  });

  describe("bytesToBase64/base64ToBytes", () => {
    it("round-trips arbitrary bytes, including non-ASCII values", () => {
      const bytes = new Uint8Array([0, 1, 255, 128, 42, 200]);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    });

    it("round-trips an empty buffer", () => {
      const bytes = new Uint8Array(0);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    });
  });

  describe("fragmentPacket", () => {
    it("produces exactly one self-contained fragment for a packet smaller than the MTU", () => {
      const packet = createHello("phone-1");
      const fragments = fragmentPacket(packet, 200);
      expect(fragments.length).toBe(1);
      expect(fragments[0]).toBeInstanceOf(Uint8Array);
      // header: msgId(1) + index=0(2, hi/lo) + total=1(2, hi/lo)
      expect(fragments[0][1]).toBe(0);
      expect(fragments[0][2]).toBe(0);
      expect(fragments[0][3]).toBe(0);
      expect(fragments[0][4]).toBe(1);
    });

    it("splits a packet larger than the MTU into multiple fragments, each within the MTU including its header", () => {
      const packet = { version: 1, id: "abc", type: "DATA", source: "A", ttl: 8, timestamp: 1, priority: 4, payload: { blob: "x".repeat(500) } };
      const mtu = 20;
      const fragments = fragmentPacket(packet, mtu);
      expect(fragments.length).toBeGreaterThan(1);
      for (const fragment of fragments) {
        expect(fragment.length).toBeLessThanOrEqual(mtu);
      }
      // every fragment of one fragmentPacket() call shares the same msgId (header byte 0)
      expect(new Set(fragments.map((f) => f[0])).size).toBe(1);
    });

    it("rejects a packet that would need more fragments than MAX_FRAGMENTS_PER_MESSAGE", () => {
      const packet = { version: 1, id: "abc", type: "DATA", source: "A", ttl: 8, timestamp: 1, priority: 4, payload: { blob: "x".repeat(MAX_FRAGMENTS_PER_MESSAGE * 20) } };
      expect(() => fragmentPacket(packet, 6)).toThrow(); // payload budget of 1 byte/fragment at this MTU
    });

    it("rejects an mtu too small to fit even the fragment header, rather than silently emitting an oversized fragment", () => {
      const packet = createHello("phone-1");
      expect(() => fragmentPacket(packet, 5)).toThrow();
      expect(() => fragmentPacket(packet, 1)).toThrow();
    });
  });

  describe("FragmentReassembler", () => {
    it("reassembles a full round-trip through fragmentPacket -> decodePacket", () => {
      const packet = { version: 1, id: "abc", type: "DATA", source: "A", ttl: 8, timestamp: 1, priority: 4, payload: { blob: "y".repeat(300) } };
      const fragments = fragmentPacket(packet, 20);
      const reassembler = new FragmentReassembler();
      let reassembled: string | undefined;
      for (const fragment of fragments) {
        reassembled = reassembler.addFragment(fragment);
      }
      expect(reassembled).toBeTruthy();
      expect(decodePacket(reassembled!)).toEqual(packet);
    });

    it("reassembles correctly even when fragments arrive out of order", () => {
      const packet = createHello("phone-1");
      const fragments = fragmentPacket(packet, 10); // tiny MTU forces several fragments
      expect(fragments.length).toBeGreaterThan(1);
      const reassembler = new FragmentReassembler();
      const shuffled = [...fragments].reverse();
      let reassembled: string | undefined;
      for (const fragment of shuffled) {
        reassembled = reassembler.addFragment(fragment);
      }
      expect(reassembled).toBeTruthy();
      expect(decodePacket(reassembled!)).toEqual(packet);
    });

    it("rejects a fragment shorter than the header size", () => {
      const reassembler = new FragmentReassembler();
      expect(reassembler.addFragment(new Uint8Array([1, 2, 3]))).toBeUndefined();
      expect(reassembler.addFragment(new Uint8Array(0))).toBeUndefined();
    });

    it("rejects a fragment with an out-of-range index", () => {
      const reassembler = new FragmentReassembler();
      expect(reassembler.addFragment(rawFragment(0, 5, 3))).toBeUndefined(); // index >= total
    });

    it("rejects a fragment claiming zero total fragments", () => {
      const reassembler = new FragmentReassembler();
      expect(reassembler.addFragment(rawFragment(0, 0, 0))).toBeUndefined();
    });

    it("rejects a fragment claiming more pieces than MAX_FRAGMENTS_PER_MESSAGE fits in a 2-byte total field would allow", () => {
      const reassembler = new FragmentReassembler();
      // total encoded as 0xFFFF (65535) is well above MAX_FRAGMENTS_PER_MESSAGE (8192)
      expect(reassembler.addFragment(rawFragment(0, 0, 0xffff))).toBeUndefined();
    });

    it("evicts the oldest incomplete message once too many are concurrently in flight", () => {
      const reassembler = new FragmentReassembler();
      // Start more concurrent, never-completed messages than the reassembler tracks, then confirm the
      // very first one can no longer be completed — it must have been evicted to make room.
      const overflowCount = 10; // comfortably above the small per-connection cap this file documents
      for (let i = 0; i < overflowCount; i++) {
        reassembler.addFragment(rawFragment(i, 0, 2, [i]));
      }
      // Completing the very first message's second fragment should no longer succeed — its
      // in-progress state was evicted, so this looks like a fresh, still-incomplete message instead.
      const result = reassembler.addFragment(rawFragment(0, 1, 2, [0]));
      expect(result).toBeUndefined();
    });
  });
});
