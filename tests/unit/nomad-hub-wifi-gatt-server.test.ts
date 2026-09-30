import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  PublicKeyCharacteristic,
  RequestCharacteristic,
  ResponseCharacteristic,
  WifiProvisioningApplication,
  WifiProvisioningGattService,
  WifiProvisioningAdvertisement,
  WIFI_PROVISIONING_SERVICE_UUID,
  findAdapterWithGattManager,
  startWifiGattServer,
} from "../../nomad-hub/wifi-gatt-server.js";
import { fragmentBytes, FragmentReassembler, generateEphemeralKeyPair } from "../../nomad-hub/wifi-gatt-protocol.js";

/**
 * A faithful-enough fake system bus — same "faithful fake, not real hardware" posture as
 * `tests/helpers/fake-sx127x-serial-device.ts` — exercising `startWifiGattServer()`'s own real
 * registration/rollback/reentrancy-guard logic without a real D-Bus/BlueZ. Modeled only on the
 * `MessageBus` surface `wifi-gatt-server.ts` actually calls: `on`, `export`, `unexport`,
 * `disconnect`, `getProxyObject`.
 */
class FakeBus extends EventEmitter {
  exported = new Map<string, unknown>();
  export(path: string, iface: unknown): void {
    this.exported.set(path, iface);
  }
  unexport(path: string): void {
    this.exported.delete(path);
  }
  disconnect(): void {}
  async getProxyObject(_serviceName: string, path: string) {
    if (path === "/") {
      return { getInterface: () => ({ GetManagedObjects: async () => ({ "/org/bluez/hci0": { "org.bluez.GattManager1": {} } }) }) };
    }
    return {
      getInterface: (name: string) => {
        if (name === "org.bluez.GattManager1") {
          return { RegisterApplication: vi.fn(async () => {}), UnregisterApplication: vi.fn(async () => {}) };
        }
        if (name === "org.bluez.LEAdvertisingManager1") {
          return { RegisterAdvertisement: vi.fn(async () => {}), UnregisterAdvertisement: vi.fn(async () => {}) };
        }
        throw new Error(`fake bus: unexpected interface requested: ${name}`);
      },
    };
  }
}

let lastFakeBus: FakeBus | undefined;

vi.mock("dbus-next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dbus-next")>();
  return {
    ...actual,
    systemBus: () => {
      lastFakeBus = new FakeBus();
      return lastFakeBus;
    },
  };
});

type ExecFileCallback = (err: (Error & { code?: number }) | null, result?: { stdout: string; stderr: string }) => void;
// `vi.hoisted()` (not a plain top-level `const`, unlike `tests/unit/nomad-hub-wifi-provisioning.test.ts`'s
// own identical-looking mock): that file only ever imports `wifi-provisioning.js` *dynamically*, inside
// each `it()`, so its mock factory never actually runs until well after its own top-level `const` has
// initialized. This file, unlike that one, imports `wifi-gatt-server.js` *statically* at the top (needed
// by the other describe blocks above, which construct its exported classes directly) — that eager
// import transitively reaches `node:child_process` during this file's own top-level evaluation, before a
// plain `const execFileMock = ...` further down would have run yet, throwing a TDZ ReferenceError
// (found empirically). `vi.hoisted()` runs its callback at the very top, before any import, so this is
// safe regardless of when — or how — the mocked module first gets imported.
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn((_cmd: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
    callback(null, { stdout: "", stderr: "" });
  }),
}));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

/**
 * `nomad-hub/wifi-gatt-server.ts` — the real BlueZ D-Bus GATT peripheral.
 * Every class here is constructed and exercised directly (the same
 * "faithful fake, not real hardware" posture as
 * `tests/helpers/fake-sx127x-serial-device.ts`) — no real system D-Bus/BlueZ
 * exists in this sandbox (verified, not assumed) to test `startWifiGattServer()`
 * itself end-to-end; that remains the user's own hardware verification, per
 * this file's own header comment.
 */

describe("WifiProvisioningGattService", () => {
  it("declares itself as a primary service with the documented UUID", () => {
    const service = new WifiProvisioningGattService();
    expect(service.UUID).toBe(WIFI_PROVISIONING_SERVICE_UUID);
    expect(service.Primary).toBe(true);
  });
});

describe("PublicKeyCharacteristic", () => {
  it("ReadValue() returns the exact bytes it was constructed with, as a Buffer", () => {
    const keyPair = generateEphemeralKeyPair();
    const characteristic = new PublicKeyCharacteristic(keyPair.publicKey);

    const value = characteristic.ReadValue({});
    expect(Buffer.isBuffer(value)).toBe(true);
    expect(new Uint8Array(value)).toEqual(keyPair.publicKey);
  });

  it("declares read-only Flags", () => {
    const characteristic = new PublicKeyCharacteristic(new Uint8Array(32));
    expect(characteristic.Flags).toEqual(["read"]);
  });
});

describe("RequestCharacteristic", () => {
  it("invokes the callback only once the last fragment of a message arrives", () => {
    const onRequestReady = vi.fn();
    const characteristic = new RequestCharacteristic(onRequestReady);

    const payload = new Uint8Array(50);
    for (let i = 0; i < payload.length; i++) payload[i] = i;
    const fragments = fragmentBytes(payload, 20);
    expect(fragments.length).toBeGreaterThan(1);

    for (const fragment of fragments.slice(0, -1)) {
      characteristic.WriteValue(Buffer.from(fragment), {});
      expect(onRequestReady).not.toHaveBeenCalled();
    }
    characteristic.WriteValue(Buffer.from(fragments[fragments.length - 1]), {});
    expect(onRequestReady).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(onRequestReady.mock.calls[0][0])).toEqual(payload);
  });

  it("declares write flags, never read/notify", () => {
    const characteristic = new RequestCharacteristic(() => {});
    expect(characteristic.Flags).toEqual(["write", "write-without-response"]);
  });

  it("keeps two devices' in-flight reassemblies isolated, even when their fragments interleave and their msgId collides (regression, code review: a single shared reassembler let one connection corrupt another's request)", () => {
    const onRequestReady = vi.fn();
    const characteristic = new RequestCharacteristic(onRequestReady);

    const payloadA = new TextEncoder().encode("message from device A");
    const payloadB = new TextEncoder().encode("a different message from device B");
    // Both fragmented independently — each module-level fragmenter assigns its own msgId sequence
    // starting at 0, so these two messages are highly likely to collide on msgId, exactly the
    // scenario this test targets regardless of the exact counter value.
    const fragmentsA = fragmentBytes(payloadA, 20);
    const fragmentsB = fragmentBytes(payloadB, 20);
    expect(fragmentsA.length).toBeGreaterThan(1);
    expect(fragmentsB.length).toBeGreaterThan(1);

    const deviceA = { device: { value: "/org/bluez/hci0/dev_AA_AA_AA_AA_AA_AA" } };
    const deviceB = { device: { value: "/org/bluez/hci0/dev_BB_BB_BB_BB_BB_BB" } };

    // Interleave: A's first fragment, B's first fragment, A's rest, B's rest.
    characteristic.WriteValue(Buffer.from(fragmentsA[0]), deviceA);
    characteristic.WriteValue(Buffer.from(fragmentsB[0]), deviceB);
    for (const fragment of fragmentsA.slice(1)) characteristic.WriteValue(Buffer.from(fragment), deviceA);
    for (const fragment of fragmentsB.slice(1)) characteristic.WriteValue(Buffer.from(fragment), deviceB);

    expect(onRequestReady).toHaveBeenCalledTimes(2);
    const reassembledPayloads = onRequestReady.mock.calls.map((call) => new TextDecoder().decode(call[0] as Uint8Array));
    expect(reassembledPayloads).toContain(new TextDecoder().decode(payloadA));
    expect(reassembledPayloads).toContain(new TextDecoder().decode(payloadB));
  });
});

describe("ResponseCharacteristic", () => {
  it("pushValue() before StartNotify() updates Value but never throws (no subscriber to notify yet)", () => {
    const characteristic = new ResponseCharacteristic();
    expect(() => characteristic.pushValue(new Uint8Array([1, 2, 3]))).not.toThrow();
    expect(new Uint8Array(characteristic.Value)).toEqual(new Uint8Array([1, 2, 3]));
    expect(characteristic.Notifying).toBe(false);
  });

  it("StartNotify()/StopNotify() toggle the Notifying property", () => {
    const characteristic = new ResponseCharacteristic();
    characteristic.StartNotify();
    expect(characteristic.Notifying).toBe(true);
    characteristic.StopNotify();
    expect(characteristic.Notifying).toBe(false);
  });

  it("pushValue() after StartNotify() emits a PropertiesChanged-triggering event for Value", () => {
    const characteristic = new ResponseCharacteristic();
    characteristic.StartNotify();

    const emitSpy = vi.spyOn(characteristic.$emitter, "emit");
    characteristic.pushValue(new Uint8Array([9, 9]));

    expect(emitSpy).toHaveBeenCalledWith(
      "properties-changed",
      expect.objectContaining({ Value: expect.objectContaining({ value: expect.anything() }) }),
      [],
    );
  });
});

describe("WifiProvisioningApplication.GetManagedObjects", () => {
  it("advertises the service and all three characteristics with distinct UUIDs", () => {
    const application = new WifiProvisioningApplication();
    const managed = application.GetManagedObjects();

    const paths = Object.keys(managed);
    expect(paths).toHaveLength(4); // service + 3 characteristics

    const uuids = new Set<string>();
    for (const path of paths) {
      const ifaces = managed[path];
      for (const ifaceName of Object.keys(ifaces)) {
        const uuidVariant = ifaces[ifaceName].UUID;
        expect(uuidVariant).toBeDefined();
        uuids.add(uuidVariant.value as string);
      }
    }
    expect(uuids.size).toBe(4); // service UUID + 3 characteristic UUIDs, all distinct
  });

  it("every characteristic's Service property points at the service's own object path", () => {
    const application = new WifiProvisioningApplication();
    const managed = application.GetManagedObjects();

    const servicePath = Object.keys(managed).find((path) => "org.bluez.GattService1" in managed[path]);
    expect(servicePath).toBeDefined();

    for (const [path, ifaces] of Object.entries(managed)) {
      const characteristic = ifaces["org.bluez.GattCharacteristic1"];
      if (!characteristic) continue;
      expect(characteristic.Service.value).toBe(servicePath);
    }
  });
});

describe("WifiProvisioningAdvertisement", () => {
  it("advertises as a peripheral offering the provisioning service UUID", () => {
    const advertisement = new WifiProvisioningAdvertisement();
    expect(advertisement.Type).toBe("peripheral");
    expect(advertisement.ServiceUUIDs).toEqual([WIFI_PROVISIONING_SERVICE_UUID]);
  });

  it("Release() never throws", () => {
    const advertisement = new WifiProvisioningAdvertisement();
    expect(() => advertisement.Release()).not.toThrow();
  });
});

describe("findAdapterWithGattManager", () => {
  function fakeBus(managedObjects: Record<string, Record<string, unknown>>) {
    return {
      getProxyObject: vi.fn(async () => ({
        getInterface: () => ({
          GetManagedObjects: async () => managedObjects,
        }),
      })),
    } as unknown as Parameters<typeof findAdapterWithGattManager>[0];
  }

  it("returns the path of the object that implements GattManager1", () => {
    const bus = fakeBus({
      "/org/bluez": { "org.bluez.Agent1": {} },
      "/org/bluez/hci0": { "org.bluez.GattManager1": {}, "org.bluez.LEAdvertisingManager1": {} },
    });
    return expect(findAdapterWithGattManager(bus)).resolves.toBe("/org/bluez/hci0");
  });

  it("rejects with an explanatory Italian message when no adapter exposes GattManager1 (e.g. BlueZ not running, or no adapter present)", () => {
    const bus = fakeBus({ "/org/bluez": { "org.bluez.Agent1": {} } });
    return expect(findAdapterWithGattManager(bus)).rejects.toThrow(/nessun adattatore Bluetooth/);
  });
});

describe("startWifiGattServer (end-to-end against a fake bus)", () => {
  const REQUEST_CHAR_PATH = "/org/araldwifi/service0/char1";
  const PUBLIC_KEY_CHAR_PATH = "/org/araldwifi/service0/char0";

  /** Builds a real, correctly encrypted pairing request against whatever public key the running server actually exposes — same wire shape `mobile/www/ble-wifi-provisioning.js`'s `sealWifiCredentials()` produces, built with the plain npm `tweetnacl` package here (proven interoperable with the vendored copy in `tests/integration/wifi-provisioning-ble-interop.test.ts`). */
  async function sealRequest(credentials: unknown, boxPublicKey: Uint8Array): Promise<Uint8Array> {
    const nacl = (await import("tweetnacl")).default;
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

  function writeFragmented(requestChar: RequestCharacteristic, bytes: Uint8Array, deviceOptions: Record<string, { value: string }>): void {
    for (const fragment of fragmentBytes(bytes, 20)) {
      requestChar.WriteValue(Buffer.from(fragment), deviceOptions);
    }
  }

  it("registers the application/advertisement and rolls everything back cleanly on stop()", async () => {
    execFileMock.mockClear();
    const handle = await startWifiGattServer();
    expect(lastFakeBus).toBeDefined();
    expect(lastFakeBus!.exported.size).toBe(6); // application + service + 3 characteristics + advertisement

    await handle.stop();
    expect(lastFakeBus!.exported.size).toBe(0);
  });

  it("never runs two applyWifiCredentials() attempts concurrently — a second complete request arriving while the first is still in flight is answered 'failed' immediately instead of triggering a second nmcli invocation (regression, code review)", async () => {
    execFileMock.mockClear();
    // execFile never calls its callback here — simulates nmcli's own real multi-second `--wait`, so the
    // first request stays "in flight" for the whole test, exactly the window the reentrancy guard exists for.
    execFileMock.mockImplementation(() => {});

    const handle = await startWifiGattServer();
    const requestChar = lastFakeBus!.exported.get(REQUEST_CHAR_PATH) as RequestCharacteristic;
    const publicKeyChar = lastFakeBus!.exported.get(PUBLIC_KEY_CHAR_PATH) as PublicKeyCharacteristic;
    const boxPublicKey = new Uint8Array(publicKeyChar.ReadValue({}));

    const requestA = await sealRequest({ ssid: "RifugioA", password: "montagna123" }, boxPublicKey);
    const requestB = await sealRequest({ ssid: "RifugioB", password: "montagna456" }, boxPublicKey);

    const deviceA = { device: { value: "/org/bluez/hci0/dev_AA" } };
    const deviceB = { device: { value: "/org/bluez/hci0/dev_BB" } };

    writeFragmented(requestChar, requestA, deviceA);
    // Second, distinct device completes its own request while the first is still in flight (execFile
    // never resolves) — must never call execFile again.
    writeFragmented(requestChar, requestB, deviceB);

    // Only the first request should have reached execFile — the second was rejected immediately by the
    // in-flight guard, before ever calling applyWifiCredentials()/execFile.
    expect(execFileMock).toHaveBeenCalledTimes(1);

    await handle.stop();
  });
});
