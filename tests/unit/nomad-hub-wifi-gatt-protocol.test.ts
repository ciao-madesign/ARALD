import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import {
  FragmentReassembler,
  encodeWifiProvisioningResponse,
  fragmentBytes,
  generateEphemeralKeyPair,
  openWifiProvisioningRequest,
} from "../../nomad-hub/wifi-gatt-protocol.js";

/**
 * `nomad-hub/wifi-gatt-protocol.ts` — pure logic (fragmentation, encryption) behind the Box side of
 * the Wi-Fi-provisioning Bluetooth exchange, testable without a real D-Bus/BlueZ bus. The real
 * phone↔Box interop (this file's crypto against the vendored `mobile/www/vendor/nacl.js` copy of
 * TweetNaCl the phone actually uses) is covered separately in
 * `tests/integration/wifi-provisioning-ble-interop.test.ts` — this file only tests this module's own
 * npm `tweetnacl` round trip in isolation.
 */

describe("fragmentBytes / FragmentReassembler (nomad-hub/wifi-gatt-protocol.ts)", () => {
  it("round-trips a payload larger than one fragment", () => {
    const original = new Uint8Array(137);
    for (let i = 0; i < original.length; i++) original[i] = i % 256;

    const fragments = fragmentBytes(original, 20);
    expect(fragments.length).toBeGreaterThan(1);

    const reassembler = new FragmentReassembler();
    let result: Uint8Array | undefined;
    for (const fragment of fragments) {
      result = reassembler.addFragment(fragment);
    }
    expect(result).toEqual(original);
  });

  it("round-trips a payload that fits in a single fragment", () => {
    const original = new TextEncoder().encode("ok");
    const fragments = fragmentBytes(original, 20);
    expect(fragments).toHaveLength(1);

    const reassembler = new FragmentReassembler();
    expect(reassembler.addFragment(fragments[0])).toEqual(original);
  });

  it("rejects an mtu too small to fit the fragment header, instead of silently exceeding it", () => {
    expect(() => fragmentBytes(new Uint8Array(10), 5)).toThrow(/mtu troppo piccolo/);
    expect(() => fragmentBytes(new Uint8Array(10), 4)).toThrow(/mtu troppo piccolo/);
  });

  it("reassembler rejects a malformed/out-of-bounds fragment instead of storing it", () => {
    const reassembler = new FragmentReassembler();
    expect(reassembler.addFragment(new Uint8Array(2))).toBeUndefined(); // too short
    expect(reassembler.addFragment(new Uint8Array([0, 0, 0, 0, 0]))).toBeUndefined(); // total=0
    expect(reassembler.addFragment(new Uint8Array([0, 0, 5, 0, 1]))).toBeUndefined(); // index(5) >= total(1)
  });

  it("rejects a fragment whose declared total contradicts the one already recorded for its msgId (regression, code review: a colliding msgId from an unrelated message must never merge into an in-flight reassembly)", () => {
    const reassembler = new FragmentReassembler();
    // Start a 3-fragment message with msgId 0.
    reassembler.addFragment(new Uint8Array([0, 0, 0, 0, 3, 0xaa]));
    // A different message, same msgId, claiming a different total — must be rejected outright, not merged.
    expect(reassembler.addFragment(new Uint8Array([0, 0, 1, 0, 5, 0xbb]))).toBeUndefined();
    // The original message must still be completable normally afterward.
    reassembler.addFragment(new Uint8Array([0, 0, 1, 0, 3, 0xcc]));
    expect(reassembler.addFragment(new Uint8Array([0, 0, 2, 0, 3, 0xdd]))).toEqual(new Uint8Array([0xaa, 0xcc, 0xdd]));
  });

  it("evicts an in-flight reassembly once its accumulated size exceeds the byte cap, and allows a fresh attempt on the same msgId afterward (regression, code review: MAX_FRAGMENTS_PER_MESSAGE alone bounds fragment count, not accumulated bytes)", () => {
    const reassembler = new FragmentReassembler();
    const big = new Array(2200).fill(0xff);
    expect(reassembler.addFragment(new Uint8Array([0, 0, 0, 0, 3, ...big]))).toBeUndefined(); // bytesSoFar=2200, under the 4096 cap, incomplete
    expect(reassembler.addFragment(new Uint8Array([0, 0, 1, 0, 3, ...big]))).toBeUndefined(); // bytesSoFar=4400 > cap -> entry evicted

    // A fresh, small 3-fragment message reusing the same msgId must complete normally — proof the
    // oversized entry was actually cleared, not left half-populated with stale chunks/byte count.
    expect(reassembler.addFragment(new Uint8Array([0, 0, 0, 0, 3, 0x01]))).toBeUndefined();
    expect(reassembler.addFragment(new Uint8Array([0, 0, 1, 0, 3, 0x02]))).toBeUndefined();
    expect(reassembler.addFragment(new Uint8Array([0, 0, 2, 0, 3, 0x03]))).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
  });

  it("evicts the oldest incomplete message once MAX_CONCURRENT_REASSEMBLIES is exceeded", () => {
    const reassembler = new FragmentReassembler();
    // 5 distinct, never-completed 2-fragment messages — more than the module's concurrency cap.
    for (let msgId = 0; msgId < 5; msgId++) {
      reassembler.addFragment(new Uint8Array([msgId, 0, 0, 0, 2, 0xaa]));
    }
    // The oldest (msgId 0) should have been evicted — completing it now must fail to reassemble.
    expect(reassembler.addFragment(new Uint8Array([0, 0, 1, 0, 2, 0xbb]))).toBeUndefined();
  });
});

describe("openWifiProvisioningRequest / encodeWifiProvisioningResponse (nomad-hub/wifi-gatt-protocol.ts)", () => {
  function buildRequest(credentials: unknown, boxPublicKey: Uint8Array): Uint8Array {
    const ephemeral = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
    const ciphertext = nacl.box(plaintext, nonce, boxPublicKey, ephemeral.secretKey);
    const request = new Uint8Array(ephemeral.publicKey.length + nonce.length + ciphertext.length);
    request.set(ephemeral.publicKey, 0);
    request.set(nonce, ephemeral.publicKey.length);
    request.set(ciphertext, ephemeral.publicKey.length + nonce.length);
    return request;
  }

  it("decrypts and validates a well-formed request", () => {
    const box = generateEphemeralKeyPair();
    const request = buildRequest({ ssid: "RifugioWiFi", password: "montagna123" }, box.publicKey);

    expect(openWifiProvisioningRequest(request, box.secretKey)).toEqual({ ssid: "RifugioWiFi", password: "montagna123" });
  });

  it("rejects a request encrypted for a different box key", () => {
    const box = generateEphemeralKeyPair();
    const otherBox = generateEphemeralKeyPair();
    const request = buildRequest({ ssid: "Rifugio", password: "montagna123" }, otherBox.publicKey);

    expect(() => openWifiProvisioningRequest(request, box.secretKey)).toThrow(/decifratura/);
  });

  it("rejects a request too short to contain a valid public key + nonce + ciphertext", () => {
    const box = generateEphemeralKeyPair();
    expect(() => openWifiProvisioningRequest(new Uint8Array(10), box.secretKey)).toThrow(/troppo corta/);
  });

  it("rejects a decrypted payload that isn't valid JSON", () => {
    const box = generateEphemeralKeyPair();
    const ephemeral = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ciphertext = nacl.box(new TextEncoder().encode("not json"), nonce, box.publicKey, ephemeral.secretKey);
    const request = new Uint8Array(ephemeral.publicKey.length + nonce.length + ciphertext.length);
    request.set(ephemeral.publicKey, 0);
    request.set(nonce, ephemeral.publicKey.length);
    request.set(ciphertext, ephemeral.publicKey.length + nonce.length);

    expect(() => openWifiProvisioningRequest(request, box.secretKey)).toThrow(/JSON/);
  });

  it("rejects a decrypted JSON payload that isn't well-formed Wi-Fi credentials — never trusts the payload shape even after successful decryption", () => {
    const box = generateEphemeralKeyPair();
    const request = buildRequest({ ssid: "Rifugio" }, box.publicKey); // missing password

    expect(() => openWifiProvisioningRequest(request, box.secretKey)).toThrow(/password/);
  });

  it("encodeWifiProvisioningResponse produces JSON parseable back into the same result", () => {
    const encoded = encodeWifiProvisioningResponse({ status: "failed", reason: "connessione fallita" });
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual({ status: "failed", reason: "connessione fallita" });
  });
});
