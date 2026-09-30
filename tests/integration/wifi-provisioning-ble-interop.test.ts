import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { sealWifiCredentials, fragmentBytes as phoneFragmentBytes, FragmentReassembler as PhoneFragmentReassembler } from "../../mobile/www/ble-wifi-provisioning.js";
import {
  FragmentReassembler,
  encodeWifiProvisioningResponse,
  fragmentBytes,
  generateEphemeralKeyPair,
  openWifiProvisioningRequest,
} from "../../nomad-hub/wifi-gatt-protocol.js";

/**
 * The definitive proof (same rationale as
 * `tests/integration/phone-originated-sos-interop.test.ts`) that the phone-side Wi-Fi-provisioning
 * code (`mobile/www/ble-wifi-provisioning.js`, exact code that runs in a real browser, using the
 * *vendored* `mobile/www/vendor/nacl.js` copy of TweetNaCl) actually interoperates with the Box-side
 * code (`nomad-hub/wifi-gatt-server.ts`'s own protocol logic, using the *npm* `tweetnacl` package) —
 * two independent copies of the same algorithm family that must agree on wire format and produce
 * mutually decryptable ciphertext for this feature to work for real. Neither side's own unit tests
 * alone would catch a wire-format mismatch between them.
 */

beforeAll(() => {
  const require = createRequire(import.meta.url);
  (globalThis as unknown as { nacl: unknown }).nacl = require("../../mobile/www/vendor/nacl.js");
});

const GATT_MTU = 20;

describe("phone (ble-wifi-provisioning.js) -> Box (wifi-gatt-protocol.ts) request interop", () => {
  it("a request sealed by the phone module is decrypted and validated correctly by the Box module", () => {
    const box = generateEphemeralKeyPair();
    const credentials = { ssid: "RifugioWiFi", password: "montagna123" };

    const request = sealWifiCredentials(credentials, box.publicKey);

    // Fragment with the phone's own fragmenter, reassemble with the Box's own reassembler — the two
    // must share the exact same wire header shape for this to work over a real GATT link.
    const fragments = phoneFragmentBytes(request, GATT_MTU);
    expect(fragments.length).toBeGreaterThan(1); // exercises real multi-fragment reassembly, not just the trivial single-fragment case

    const reassembler = new FragmentReassembler();
    let reassembled: Uint8Array | undefined;
    for (const fragment of fragments) {
      reassembled = reassembler.addFragment(fragment);
    }
    expect(reassembled).toBeDefined();

    expect(openWifiProvisioningRequest(reassembled!, box.secretKey)).toEqual(credentials);
  });
});

describe("Box (wifi-gatt-protocol.ts) -> phone (ble-wifi-provisioning.js) response interop", () => {
  it("a response encoded by the Box module is reassembled and parsed correctly by the phone module", () => {
    const result = { status: "failed" as const, reason: "connessione fallita — verifica che password e nome rete siano corretti" };
    const encoded = encodeWifiProvisioningResponse(result);

    const fragments = fragmentBytes(encoded, GATT_MTU);
    expect(fragments.length).toBeGreaterThan(1);

    const reassembler = new PhoneFragmentReassembler();
    let reassembled: Uint8Array | undefined;
    for (const fragment of fragments) {
      reassembled = reassembler.addFragment(fragment);
    }
    expect(reassembled).toBeDefined();

    expect(JSON.parse(new TextDecoder().decode(reassembled!))).toEqual(result);
  });
});
