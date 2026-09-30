import { createRequire } from "node:module";
import nacl from "tweetnacl";
import { beforeAll, describe, expect, it } from "vitest";
import { FragmentReassembler, fragmentBytes, sealWifiCredentials } from "../../mobile/www/ble-wifi-provisioning.js";

/**
 * `mobile/www/ble-wifi-provisioning.js` — pure logic only (fragmentation, encryption): the plugin
 * orchestration (`provisionWifiOverBluetooth()`) is written to spec, never executed against a real
 * plugin/hardware, same accepted limitation as `ble-client.js`'s own tested/untested split (see that
 * file's header). Real phone↔Box wire-format interop is covered separately in
 * `tests/integration/wifi-provisioning-ble-interop.test.ts`.
 */

// ble-wifi-provisioning.js references the bare global `nacl` (vendored TweetNaCl) only inside
// sealWifiCredentials()'s body, never at module-load time — same pattern as
// tests/unit/mobile-ble-identity.test.ts.
beforeAll(() => {
  const require = createRequire(import.meta.url);
  (globalThis as unknown as { nacl: unknown }).nacl = require("../../mobile/www/vendor/nacl.js");
});

function rawFragment(msgId: number, index: number, total: number, payload: number[] = [1]): Uint8Array {
  return new Uint8Array([msgId, (index >> 8) & 0xff, index & 0xff, (total >> 8) & 0xff, total & 0xff, ...payload]);
}

describe("fragmentBytes / FragmentReassembler (mobile/www/ble-wifi-provisioning.js)", () => {
  it("round-trips a multi-fragment payload", () => {
    const original = new Uint8Array(83);
    for (let i = 0; i < original.length; i++) original[i] = (i * 7) % 256;

    const fragments = fragmentBytes(original, 20);
    expect(fragments.length).toBeGreaterThan(1);

    const reassembler = new FragmentReassembler();
    let result: Uint8Array | undefined;
    for (const fragment of fragments) result = reassembler.addFragment(fragment);
    expect(result).toEqual(original);
  });

  it("rejects an mtu too small for the fragment header", () => {
    expect(() => fragmentBytes(new Uint8Array(10), 5)).toThrow(/mtu troppo piccolo/);
  });

  it("rejects a malformed or out-of-bounds fragment", () => {
    const reassembler = new FragmentReassembler();
    expect(reassembler.addFragment(new Uint8Array(2))).toBeUndefined();
    expect(reassembler.addFragment(rawFragment(0, 5, 1))).toBeUndefined(); // index >= total
  });
});

describe("sealWifiCredentials (mobile/www/ble-wifi-provisioning.js)", () => {
  it("produces a request whose length matches ephemeral public key + nonce + ciphertext (plaintext + Poly1305 overhead)", () => {
    const boxKeyPair = nacl.box.keyPair();
    const credentials = { ssid: "Rifugio", password: "montagna123" };
    const request = sealWifiCredentials(credentials, boxKeyPair.publicKey);

    const plaintextLength = new TextEncoder().encode(JSON.stringify(credentials)).length;
    const expectedLength = nacl.box.publicKeyLength + nacl.box.nonceLength + plaintextLength + nacl.box.overheadLength;
    expect(request).toHaveLength(expectedLength);
  });

  it("is only decryptable by the holder of the matching secret key", () => {
    const boxKeyPair = nacl.box.keyPair();
    const wrongKeyPair = nacl.box.keyPair();
    const request = sealWifiCredentials({ ssid: "Rifugio", password: "montagna123" }, boxKeyPair.publicKey);

    const phonePublicKey = request.slice(0, nacl.box.publicKeyLength);
    const nonce = request.slice(nacl.box.publicKeyLength, nacl.box.publicKeyLength + nacl.box.nonceLength);
    const ciphertext = request.slice(nacl.box.publicKeyLength + nacl.box.nonceLength);

    expect(nacl.box.open(ciphertext, nonce, phonePublicKey, wrongKeyPair.secretKey)).toBeNull();
    const opened = nacl.box.open(ciphertext, nonce, phonePublicKey, boxKeyPair.secretKey);
    expect(opened).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(opened!))).toEqual({ ssid: "Rifugio", password: "montagna123" });
  });

  it("uses a fresh ephemeral keypair on every call, never reusing one across attempts", () => {
    const boxKeyPair = nacl.box.keyPair();
    const requestA = sealWifiCredentials({ ssid: "Rifugio", password: "montagna123" }, boxKeyPair.publicKey);
    const requestB = sealWifiCredentials({ ssid: "Rifugio", password: "montagna123" }, boxKeyPair.publicKey);

    const publicKeyA = requestA.slice(0, nacl.box.publicKeyLength);
    const publicKeyB = requestB.slice(0, nacl.box.publicKeyLength);
    expect(publicKeyA).not.toEqual(publicKeyB);
  });
});
