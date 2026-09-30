import { Variant, systemBus, interface as dbusInterface, type MessageBus, type ProxyObject } from "dbus-next";
import {
  FragmentReassembler,
  encodeWifiProvisioningResponse,
  fragmentBytes,
  generateEphemeralKeyPair,
  openWifiProvisioningRequest,
  type EphemeralKeyPair,
} from "./wifi-gatt-protocol.js";
import { applyWifiCredentials, type WifiProvisioningResult } from "./wifi-provisioning.js";

const { Interface } = dbusInterface;

/**
 * Real (non-simulated) BLE GATT peripheral for the Box side of Wi-Fi
 * provisioning (`wifi-provisioning.ts`'s own doc comment describes the
 * "apply these credentials" half this file finally connects to a real
 * Bluetooth transport for). Same class of feature as the SX1262 LoRa driver
 * (`node/src/transports/lora-serial-sx1262.ts`) and
 * `firmware/sx126x-bridge/`: written completely and for real, verified only
 * against a faithful fake bus (`tests/unit/nomad-hub-wifi-gatt-server.test.ts`)
 * because this sandbox has no Bluetooth/D-Bus stack to test against —
 * **never a reason to leave the real implementation unwritten** when real
 * hardware exists for the user to verify it on themselves (`CLAUDE.md`, "il
 * bring-up fisico ... resta lavoro privato dell'utente").
 *
 * **Why `dbus-next`, not `bleno`**: `bleno` (and most native BLE peripheral
 * bindings) requires a native compiled addon per platform/Node version — a
 * real maintenance and portability risk this project has consistently
 * avoided (`CLAUDE.md`, "nessuna nuova dipendenza esterna senza necessità
 * reale"; the whole reason `lora-serial.ts`/`lora-serial-sx1262.ts` talk to
 * a serial bridge instead of SPI/GPIO directly is the same portability
 * concern). `dbus-next` is pure JS, talking to BlueZ's own official D-Bus
 * GATT-peripheral API — no native compilation, no BlueZ-version-specific
 * binding.
 *
 * **`configureMembers()`, not `@property`/`@method` decorators** — found
 * the hard way, not assumed: `dbus-next`'s own decorators are written for
 * the old "TC39 stage 2" decorator shape (`{key, descriptor, finisher}`,
 * verified by reading `node_modules/dbus-next/lib/service/interface.js`
 * directly), which is a *different* runtime calling convention from both
 * TypeScript's own `experimentalDecorators` output and esbuild's decorator
 * transform (the one `tsx nomad-hub/cli.ts` and this project's own
 * `vitest` suite actually use) — confirmed empirically: decorator syntax
 * here threw `Cannot read properties of undefined (reading 'value')` at
 * class-definition time under `tsx`. `dbus-next`'s README itself flags this
 * ("you'll need a Babel plugin to make this code work for now") and its own
 * `Interface.configureMembers()` static method is the *documented*
 * alternative for exactly this situation ("when decorators cannot be
 * supported") — plain getters/methods on the class, registered by calling
 * `SomeClass.configureMembers({properties, methods})` once right after the
 * class body, with zero decorator-transform dependency. Every class below
 * uses this form.
 *
 * **A known, investigated dependency-hygiene tradeoff** (verified via `npm
 * audit` in this session, not assumed): `dbus-next` declares an *optional*
 * dependency (`usocket`, a native binding `dbus-next`'s own
 * `lib/connection.js` reaches for to connect to an *abstract-namespace*
 * Unix domain socket address — a real gap in Node's own `net.Socket`, which
 * cannot dial that address family at all; confirmed empirically in this
 * sandbox, where attempting `systemBus()` with no real D-Bus available
 * still exercises `usocket`'s native code path and fails there with
 * `ENOENT`, not a "usocket never loads" no-op). Whether the real Box's
 * system bus needs that path or the plain filesystem-socket path Node's own
 * `net` module already handles is **not verified here** (no real D-Bus in
 * this environment to check against) — `usocket` is therefore treated as
 * plausibly required, not a discardable extra. Its own build tooling
 * (`node-gyp`) used to pull in the long-deprecated `request` package and,
 * through it, several packages with critical CVEs (`form-data`, `tar`, plus
 * moderate findings in `qs`/`tough-cookie`/`uuid`) — confirmed by `npm
 * audit` before any fix. Root `package.json`'s `overrides` field forces
 * `node-gyp` to a current major version (which replaced `request` with
 * `make-fetch-happen` years ago) and `tar` to a current patched release,
 * which removes that entire chain from the dependency tree while still
 * letting `usocket` install and compile normally (verified: it does, in
 * this very sandbox, which does have a working native toolchain). An
 * earlier, blunter attempt — `omit=optional` in a root `.npmrc`, discarding
 * `usocket` outright — was reverted after it also skipped the *essential*
 * optional platform binaries `esbuild`/`vite` need to run at all (verified:
 * broke `tsx`/`vitest` outright). With the overrides in place, `npm audit`
 * shows only 1 vulnerability genuinely attributable to `dbus-next` — a
 * moderate prototype-pollution finding in `xml2js`, `dbus-next`'s own
 * *direct*, non-optional dependency used only to parse D-Bus introspection
 * XML replies from BlueZ itself over the trusted local system bus, never
 * attacker-controlled network or Bluetooth input; no fix is available
 * upstream, accepted as a residual risk on that basis. The other findings
 * `npm audit` reports are entirely the pre-existing, unrelated
 * `vitest`/`vite`/`esbuild` dev-only toolchain, already present before this
 * feature.
 *
 * **BlueZ D-Bus GATT peripheral API, verified via real web access to
 * `bluez/bluez`'s own source** (`doc/org.bluez.GattManager.rst`,
 * `.../GattService.rst`, `.../GattCharacteristic.rst`,
 * `.../LEAdvertisingManager.rst`, `.../LEAdvertisement.rst`, and the
 * official `test/example-gatt-server` Python example — not assumed, same
 * discipline as every other external API this project has integrated):
 * BlueZ discovers a GATT application by calling
 * `org.freedesktop.DBus.ObjectManager.GetManagedObjects()` on the object
 * path passed to `GattManager1.RegisterApplication()` — this file exports
 * that interface itself at the application's root path
 * (`WifiProvisioningApplication` below). Pushing a new value to a
 * subscribed central is done by emitting the *standard*
 * `org.freedesktop.DBus.Properties.PropertiesChanged` signal on the
 * characteristic's own object path (`Interface.emitPropertiesChanged()`)
 * — `StartNotify`/`StopNotify` only track a local subscription flag on our
 * side, BlueZ itself decides what actually reaches a subscribed central at
 * the ATT layer. The BlueZ adapter is discovered by walking the *root*
 * object manager (`/`, service `org.bluez`) for whichever object advertises
 * `GattManager1`, rather than hardcoding `/org/bluez/hci0` — robust to a
 * multi-adapter or renamed-adapter host.
 *
 * **No BLE-level pairing/bonding required** (`Flags` below never include
 * `encrypt-read`/`encrypt-write`) — deliberate, see
 * `wifi-gatt-protocol.ts`'s own header for why: confidentiality is provided
 * by the application-layer `nacl.box` encryption instead, so this feature
 * doesn't need the phone and Box to already trust each other at the OS
 * Bluetooth-stack level (which this project has no way to verify/configure
 * blind in this environment anyway).
 */

const BLUEZ_SERVICE_NAME = "org.bluez";
const BLUEZ_ROOT_PATH = "/";
const OBJECT_MANAGER_IFACE = "org.freedesktop.DBus.ObjectManager";
const GATT_MANAGER_IFACE = "org.bluez.GattManager1";
const LE_ADVERTISING_MANAGER_IFACE = "org.bluez.LEAdvertisingManager1";
const GATT_SERVICE_IFACE = "org.bluez.GattService1";
const GATT_CHARACTERISTIC_IFACE = "org.bluez.GattCharacteristic1";
const LE_ADVERTISEMENT_IFACE = "org.bluez.LEAdvertisement1";

const APP_PATH = "/org/araldwifi";
const SERVICE_PATH = `${APP_PATH}/service0`;
const PUBLIC_KEY_CHAR_PATH = `${SERVICE_PATH}/char0`;
const REQUEST_CHAR_PATH = `${SERVICE_PATH}/char1`;
const RESPONSE_CHAR_PATH = `${SERVICE_PATH}/char2`;
const ADVERTISEMENT_PATH = "/org/araldwifi/advertisement0";

/**
 * Invented, project-owned 128-bit UUIDs — same placeholder posture already
 * used by `mobile/www/ble-client.js`'s `RELAY_SERVICE_UUID`/etc (not a
 * firmware/industry standard, just distinct enough not to collide with a
 * real assigned GATT service in practice).
 */
export const WIFI_PROVISIONING_SERVICE_UUID = "9c1f9a00-6b7b-4b8e-9a1a-0c1a6f6e5b3a";
const PUBLIC_KEY_CHAR_UUID = "9c1f9a01-6b7b-4b8e-9a1a-0c1a6f6e5b3a";
const REQUEST_CHAR_UUID = "9c1f9a02-6b7b-4b8e-9a1a-0c1a6f6e5b3a";
const RESPONSE_CHAR_UUID = "9c1f9a03-6b7b-4b8e-9a1a-0c1a6f6e5b3a";

/** Same value/rationale as `mobile/www/ble-client.js`'s `BLE_MTU`/`node/src/transports/ble.ts`'s `DEFAULT_MTU` — the conservative default ATT MTU before any negotiation. */
const GATT_MTU = 20;

/** Exported for `tests/unit/nomad-hub-wifi-gatt-server.test.ts`, which exercises adapter discovery against a lightweight fake bus object (just `getProxyObject`/`getInterface`/`GetManagedObjects`) — no real D-Bus connection needed, same "faithful fake, not real hardware" pattern as `tests/helpers/fake-sx127x-serial-device.ts`. */
export async function findAdapterWithGattManager(bus: MessageBus): Promise<string> {
  const bluezRoot = await bus.getProxyObject(BLUEZ_SERVICE_NAME, BLUEZ_ROOT_PATH);
  const objectManager = bluezRoot.getInterface(OBJECT_MANAGER_IFACE);
  const managedObjects = (await objectManager.GetManagedObjects()) as Record<string, Record<string, unknown>>;
  for (const [path, interfaces] of Object.entries(managedObjects)) {
    if (GATT_MANAGER_IFACE in interfaces) return path;
  }
  throw new Error(
    "nessun adattatore Bluetooth con supporto GattManager1 trovato su questo host (BlueZ non è in esecuzione, o non c'è un adattatore fisico collegato)",
  );
}

/** Exported for `tests/unit/nomad-hub-wifi-gatt-server.test.ts` — every class below is constructed and exercised directly, without a real D-Bus bus (only `startWifiGattServer()` itself touches the bus). */
export class WifiProvisioningGattService extends Interface {
  constructor() {
    super(GATT_SERVICE_IFACE);
  }

  get UUID(): string {
    return WIFI_PROVISIONING_SERVICE_UUID;
  }

  get Primary(): boolean {
    return true;
  }
}
// Every `configureMembers()` property in this file passes `access: "read"` explicitly (found missing
// by code review): dbus-next defaults an unspecified `access` to read-*write*
// (`node_modules/dbus-next/lib/service/interface.js`), even though every class here only ever defines
// a getter, never a setter. Without this, a D-Bus `Properties.Set` call against one of these
// getter-only properties reaches `iface[propertyKey] = value` and throws — caught by dbus-next as an
// ordinary D-Bus error reply rather than crashing the process, but the intended read-only contract
// wasn't actually enforced at the protocol-declaration layer the way the code implied.
WifiProvisioningGattService.configureMembers({
  properties: {
    UUID: { signature: "s", access: "read" },
    Primary: { signature: "b", access: "read" },
  },
});

/** Read-only characteristic exposing this process's ephemeral X25519 public key — regenerated once per process start (`startWifiGattServer()`), never per request: a pairing phone reads it once at the start of its own exchange, and a fresh keypair per connection attempt would buy no real security here (see `wifi-gatt-protocol.ts`'s header on the "Just Works"-style trust model) while complicating key bookkeeping for no benefit. */
export class PublicKeyCharacteristic extends Interface {
  #publicKeyBytes: Uint8Array;

  constructor(publicKeyBytes: Uint8Array) {
    super(GATT_CHARACTERISTIC_IFACE);
    this.#publicKeyBytes = publicKeyBytes;
  }

  get UUID(): string {
    return PUBLIC_KEY_CHAR_UUID;
  }

  get Service(): string {
    return SERVICE_PATH;
  }

  get Flags(): string[] {
    return ["read"];
  }

  ReadValue(_options: Record<string, Variant>): Buffer {
    return Buffer.from(this.#publicKeyBytes);
  }
}
PublicKeyCharacteristic.configureMembers({
  properties: {
    UUID: { signature: "s", access: "read" },
    Service: { signature: "o", access: "read" },
    Flags: { signature: "as", access: "read" },
  },
  methods: {
    ReadValue: { inSignature: "a{sv}", outSignature: "ay" },
  },
});

/** Upper bound on how many distinct devices' in-flight reassemblies this characteristic tracks at once — this GATT server is exported once for the whole adapter (not per-connection, see this class's own doc comment), so without a cap a stream of connect/disconnect attempts from distinct BLE addresses could grow this map without limit (same `CLAUDE.md` convention as every other network-fed structure in this codebase). Generous relative to any realistic number of concurrent pairing attempts near one Box. */
const MAX_TRACKED_DEVICES = 8;

/**
 * Write-only characteristic receiving the fragmented, encrypted pairing
 * request. `WriteValue()` deliberately never awaits the actual provisioning
 * attempt (decrypt → `applyWifiCredentials()` → respond) before returning —
 * `nmcli`'s own `--wait` can take up to `DEFAULT_NMCLI_WAIT_SECONDS +
 * EXEC_TIMEOUT_MARGIN_SECONDS` (`wifi-provisioning.ts`), far longer than a
 * GATT write should ever block for; the real outcome is delivered later,
 * asynchronously, over the response characteristic's notify instead.
 *
 * **One `FragmentReassembler` per device, not one shared for the whole
 * characteristic** — found by code review: this object is exported once for
 * the whole adapter and every connected central's `WriteValue()` calls land
 * on the same instance, so a single shared reassembler let an unrelated
 * second connection (a genuine second phone, or any other nearby BLE
 * device — this characteristic requires no pairing/bonding, see this file's
 * own header) corrupt an in-flight reassembly by writing a fragment with a
 * colliding `msgId` (only 256 possible values). BlueZ passes the remote
 * device's own object path in `options.device` for exactly this kind of
 * per-peer bookkeeping (verified in `doc/org.bluez.GattCharacteristic.rst`);
 * this class keys its reassemblers by that path, bounded/evicted FIFO like
 * every other network-fed map in this codebase. A missing/non-string
 * `options.device` (never trust the shape of anything from the wire) falls
 * back to a shared sentinel key — degrading to the old single-reassembler
 * behavior only in that unexpected case, never silently dropping the write.
 */
export class RequestCharacteristic extends Interface {
  #reassemblersByDevice = new Map<string, FragmentReassembler>();
  #onRequestReady: (bytes: Uint8Array) => void;

  constructor(onRequestReady: (bytes: Uint8Array) => void) {
    super(GATT_CHARACTERISTIC_IFACE);
    this.#onRequestReady = onRequestReady;
  }

  get UUID(): string {
    return REQUEST_CHAR_UUID;
  }

  get Service(): string {
    return SERVICE_PATH;
  }

  get Flags(): string[] {
    return ["write", "write-without-response"];
  }

  WriteValue(value: Buffer, options: Record<string, Variant>): void {
    const deviceKey = typeof options?.device?.value === "string" ? options.device.value : "__unknown_device__";

    let reassembler = this.#reassemblersByDevice.get(deviceKey);
    if (!reassembler) {
      if (this.#reassemblersByDevice.size >= MAX_TRACKED_DEVICES) {
        const oldestKey = this.#reassemblersByDevice.keys().next().value;
        if (oldestKey !== undefined) this.#reassemblersByDevice.delete(oldestKey);
      }
      reassembler = new FragmentReassembler();
      this.#reassemblersByDevice.set(deviceKey, reassembler);
    }

    const reassembled = reassembler.addFragment(new Uint8Array(value));
    if (reassembled) this.#onRequestReady(reassembled);
  }
}
RequestCharacteristic.configureMembers({
  properties: {
    UUID: { signature: "s", access: "read" },
    Service: { signature: "o", access: "read" },
    Flags: { signature: "as", access: "read" },
  },
  methods: {
    WriteValue: { inSignature: "aya{sv}", outSignature: "" },
  },
});

/**
 * Notify-only characteristic carrying the plaintext `{status, reason?}`
 * outcome back to the phone, fragmented the same way as the request.
 * `pushValue()` is a no-op until a central has actually subscribed
 * (`StartNotify()`) — BlueZ itself would drop a `PropertiesChanged` signal
 * nobody subscribed to at the ATT layer regardless, this just avoids doing
 * the (cheap but pointless) work of emitting it.
 *
 * **Not independently flow-controlled between fragments** — an accepted,
 * documented limitation consistent with this whole feature's "written to
 * spec, never verified against real hardware" honesty (same posture as
 * `mobile/README.md`'s own disclosure for the phone-side Bluetooth code):
 * BlueZ is assumed to serialize/queue successive `PropertiesChanged`
 * signals on the same characteristic correctly, not independently verified
 * here.
 *
 * **Broadcasts to every subscribed central, never just the one that sent
 * the matching request** — noted by code review, inherent to this GATT
 * peripheral's shape rather than a bug in this class: BlueZ exports one
 * object per characteristic for the whole adapter (not one per connection),
 * so `PropertiesChanged` on this object path necessarily reaches every
 * central currently subscribed via `StartNotify()`. In the expected use (one
 * phone pairing with one Box at a time, in physical proximity) this is
 * harmless; a second phone connected at the same moment would also see the
 * first phone's pairing outcome. Not fixable without per-connection GATT
 * objects, out of scope for this feature.
 */
export class ResponseCharacteristic extends Interface {
  #notifying = false;
  #lastValue: Buffer = Buffer.alloc(0);

  constructor() {
    super(GATT_CHARACTERISTIC_IFACE);
  }

  get UUID(): string {
    return RESPONSE_CHAR_UUID;
  }

  get Service(): string {
    return SERVICE_PATH;
  }

  get Flags(): string[] {
    return ["notify"];
  }

  get Notifying(): boolean {
    return this.#notifying;
  }

  get Value(): Buffer {
    return this.#lastValue;
  }

  StartNotify(): void {
    this.#notifying = true;
  }

  StopNotify(): void {
    this.#notifying = false;
  }

  pushValue(bytes: Uint8Array): void {
    this.#lastValue = Buffer.from(bytes);
    if (!this.#notifying) return;
    Interface.emitPropertiesChanged(this, { Value: this.#lastValue }, []);
  }
}
ResponseCharacteristic.configureMembers({
  properties: {
    UUID: { signature: "s", access: "read" },
    Service: { signature: "o", access: "read" },
    Flags: { signature: "as", access: "read" },
    Notifying: { signature: "b", access: "read" },
    Value: { signature: "ay", access: "read" },
  },
  methods: {
    StartNotify: { inSignature: "", outSignature: "" },
    StopNotify: { inSignature: "", outSignature: "" },
  },
});

/**
 * Exports `org.freedesktop.DBus.ObjectManager` at the application's own
 * root path — the mechanism BlueZ actually uses to discover the whole
 * service/characteristic tree on `RegisterApplication()` (verified from
 * BlueZ's own `test/example-gatt-server`, see this file's header). The
 * returned shape is a static snapshot of each object's *declared*
 * properties (UUID/Flags/etc) — dynamic properties that change after
 * registration (`Notifying`, `Value`) are communicated via
 * `PropertiesChanged` afterward, never by BlueZ re-querying this method.
 */
export class WifiProvisioningApplication extends Interface {
  constructor() {
    super(OBJECT_MANAGER_IFACE);
  }

  GetManagedObjects(): Record<string, Record<string, Record<string, Variant>>> {
    return {
      [SERVICE_PATH]: {
        [GATT_SERVICE_IFACE]: {
          UUID: new Variant("s", WIFI_PROVISIONING_SERVICE_UUID),
          Primary: new Variant("b", true),
        },
      },
      [PUBLIC_KEY_CHAR_PATH]: {
        [GATT_CHARACTERISTIC_IFACE]: {
          UUID: new Variant("s", PUBLIC_KEY_CHAR_UUID),
          Service: new Variant("o", SERVICE_PATH),
          Flags: new Variant("as", ["read"]),
        },
      },
      [REQUEST_CHAR_PATH]: {
        [GATT_CHARACTERISTIC_IFACE]: {
          UUID: new Variant("s", REQUEST_CHAR_UUID),
          Service: new Variant("o", SERVICE_PATH),
          Flags: new Variant("as", ["write", "write-without-response"]),
        },
      },
      [RESPONSE_CHAR_PATH]: {
        [GATT_CHARACTERISTIC_IFACE]: {
          UUID: new Variant("s", RESPONSE_CHAR_UUID),
          Service: new Variant("o", SERVICE_PATH),
          Flags: new Variant("as", ["notify"]),
          Notifying: new Variant("b", false),
          Value: new Variant("ay", Buffer.alloc(0)),
        },
      },
    };
  }
}
WifiProvisioningApplication.configureMembers({
  methods: {
    GetManagedObjects: { inSignature: "", outSignature: "a{oa{sa{sv}}}" },
  },
});

export class WifiProvisioningAdvertisement extends Interface {
  constructor() {
    super(LE_ADVERTISEMENT_IFACE);
  }

  get Type(): string {
    return "peripheral";
  }

  get ServiceUUIDs(): string[] {
    return [WIFI_PROVISIONING_SERVICE_UUID];
  }

  get LocalName(): string {
    return "ARALD-Box";
  }

  Release(): void {
    // BlueZ ci notifica che l'advertisement è stato rimosso (es. dopo UnregisterAdvertisement) — nessuna azione necessaria qui.
  }
}
WifiProvisioningAdvertisement.configureMembers({
  properties: {
    Type: { signature: "s", access: "read" },
    ServiceUUIDs: { signature: "as", access: "read" },
    LocalName: { signature: "s", access: "read" },
  },
  methods: {
    Release: { inSignature: "", outSignature: "" },
  },
});

/**
 * Decrypts, applies, and responds to one reassembled pairing request —
 * never throws (mirrors `wifi-provisioning.ts`'s own `applyWifiCredentials()`
 * contract): any failure (malformed request, decrypt failure, invalid
 * credentials, `nmcli` failure) is turned into a `{status: "failed",
 * reason}` sent back over the notify characteristic, exactly like a normal
 * connection failure would be — a pairing phone has no way to distinguish
 * "your request was malformed" from "the network you asked for doesn't
 * exist" and doesn't need to.
 */
async function handleProvisioningRequest(requestBytes: Uint8Array, boxSecretKey: Uint8Array, responseChar: ResponseCharacteristic): Promise<void> {
  let result: WifiProvisioningResult;
  try {
    const credentials = openWifiProvisioningRequest(requestBytes, boxSecretKey);
    result = await applyWifiCredentials(credentials);
  } catch (err) {
    result = { status: "failed", reason: err instanceof Error ? err.message : "richiesta di pairing non valida" };
  }
  const responseBytes = encodeWifiProvisioningResponse(result);
  for (const fragment of fragmentBytes(responseBytes, GATT_MTU)) {
    responseChar.pushValue(fragment);
  }
}

export interface WifiGattServerHandle {
  /** Unregisters the advertisement/application from BlueZ and disconnects from the bus — best-effort, never throws (mirrors the rest of this codebase's shutdown-path posture, e.g. `NomadNode`'s own transport teardown). */
  stop(): Promise<void>;
}

/**
 * Starts the real BlueZ GATT peripheral for Wi-Fi provisioning: discovers
 * an adapter, registers the application + advertisement, and wires the
 * request characteristic to `applyWifiCredentials()` via
 * `handleProvisioningRequest()`. Requires a reachable system D-Bus with
 * BlueZ running and at least one adapter — on any other host (including
 * this project's own sandbox, verified to have neither), this rejects; the
 * caller (`cli.ts`) treats that as a non-fatal, opt-in feature failure, not
 * a reason to crash the rest of the Hub process (same posture as
 * `--map-file`/`--external-delivery-destinations` elsewhere in this
 * codebase for other optional, environment-dependent capabilities).
 *
 * **A `MessageBus` reports a connection failure as an `'error'` EVENT, not
 * a rejected promise** — found the hard way, not assumed: without a
 * listener, Node's own `EventEmitter` re-throws an unhandled `'error'`
 * event, which crashed the *entire* Hub process (not just this feature)
 * when tested in this sandbox against a nonexistent D-Bus socket. The
 * `bus.on("error", ...)` listener below turns that into an ordinary
 * rejection of `startupFailure`, raced against the whole registration
 * sequence (`registerEverything()`) so a connection failure at *any* point
 * during startup — not just the very first call — surfaces as a normal
 * rejection of this function instead of a hang or a crash. The listener is
 * never removed, even after a successful start: a *later* connection drop
 * (BlueZ restarting, D-Bus itself going away) then degrades instead of
 * taking the whole host process down with it — the next GATT operation
 * against a dead bus simply fails on its own terms instead. A separate
 * `STARTUP_TIMEOUT_MS` backstop (below) covers the other failure shape —
 * a D-Bus call that simply never replies rather than erroring — so this
 * function is always guaranteed to settle one way or another within a
 * bounded time, never hanging `cli.ts`'s signal-handler registration
 * indefinitely (found by code review).
 */
export async function startWifiGattServer(): Promise<WifiGattServerHandle> {
  const bus = systemBus();
  let rejectStartup: ((err: Error) => void) | undefined;
  const startupFailure = new Promise<never>((_, reject) => {
    rejectStartup = reject;
  });
  // Rimane collegato anche oltre la fase di avvio (mai rimosso) — vedi il commento di questa funzione:
  // una volta che startupFailure si è già stabilizzata (avvio riuscito), richiamare rejectStartup() su
  // un errore successivo è un no-op innocuo, ma il listener stesso deve restare per sempre per evitare
  // che un secondo 'error' senza ascoltatori faccia comunque crashare il processo host.
  bus.on("error", (err: unknown) => {
    rejectStartup?.(err instanceof Error ? err : new Error(String(err)));
  });

  const ephemeralKeyPair: EphemeralKeyPair = generateEphemeralKeyPair();

  // Guardia di rientranza globale — mai due `applyWifiCredentials()` (quindi due `sudo nmcli device
  // wifi connect`) in volo contemporaneamente, indipendentemente da quale dispositivo ha inviato la
  // richiesta completata per ultimo: la rete del Box è uno stato unico e condiviso, due tentativi
  // concorrenti di riconfigurarla correrebbero l'uno contro l'altro (found by code review). Stesso
  // pattern di `externalDeliveryAttemptInFlight` in `node/src/node.ts` (`CLAUDE.md`), qui a livello di
  // funzione invece che di campo di classe perché questo modulo non ne ha una. Una richiesta completata
  // mentre un'altra è già in corso riceve subito un "failed" invece di essere accodata: un pairing
  // Wi-Fi è un'operazione singola e immediata dal punto di vista dell'operatore, non una coda di lavoro.
  let provisioningInFlight = false;
  const responseChar = new ResponseCharacteristic();
  const requestChar = new RequestCharacteristic((requestBytes) => {
    if (provisioningInFlight) {
      const busyBytes = encodeWifiProvisioningResponse({ status: "failed", reason: "un'altra richiesta di provisioning è già in corso su questo Box" });
      for (const fragment of fragmentBytes(busyBytes, GATT_MTU)) responseChar.pushValue(fragment);
      return;
    }
    provisioningInFlight = true;
    void handleProvisioningRequest(requestBytes, ephemeralKeyPair.secretKey, responseChar).finally(() => {
      provisioningInFlight = false;
    });
  });

  const service = new WifiProvisioningGattService();
  const publicKeyChar = new PublicKeyCharacteristic(ephemeralKeyPair.publicKey);
  const application = new WifiProvisioningApplication();
  const advertisement = new WifiProvisioningAdvertisement();

  const registerEverything = async (): Promise<{ gattManager: ReturnType<ProxyObject["getInterface"]>; advertisingManager: ReturnType<ProxyObject["getInterface"]> }> => {
    const adapterPath = await findAdapterWithGattManager(bus);

    bus.export(APP_PATH, application);
    bus.export(SERVICE_PATH, service);
    bus.export(PUBLIC_KEY_CHAR_PATH, publicKeyChar);
    bus.export(REQUEST_CHAR_PATH, requestChar);
    bus.export(RESPONSE_CHAR_PATH, responseChar);
    bus.export(ADVERTISEMENT_PATH, advertisement);

    const adapterObj: ProxyObject = await bus.getProxyObject(BLUEZ_SERVICE_NAME, adapterPath);
    const gattManager = adapterObj.getInterface(GATT_MANAGER_IFACE);
    const advertisingManager = adapterObj.getInterface(LE_ADVERTISING_MANAGER_IFACE);

    await gattManager.RegisterApplication(APP_PATH, {});
    await advertisingManager.RegisterAdvertisement(ADVERTISEMENT_PATH, {});
    return { gattManager, advertisingManager };
  };

  // Backstop indipendente dal listener 'error' sopra: quel listener cattura solo un fallimento che il
  // bus segnala attivamente, ma una chiamata D-Bus che semplicemente non riceve mai risposta (BlueZ
  // bloccato, un metodo che non risponde) non emette alcun evento — senza questo timeout,
  // startWifiGattServer() resterebbe in attesa per sempre (found by code review), ritardando a tempo
  // indefinito la registrazione dei gestori SIGINT/SIGTERM in nomad-hub/cli.ts.
  const STARTUP_TIMEOUT_MS = 15000;
  const startupTimeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timeout nell'avvio del server GATT (BlueZ/D-Bus non ha risposto in tempo)")), STARTUP_TIMEOUT_MS);
  });

  let gattManager: ReturnType<ProxyObject["getInterface"]>;
  let advertisingManager: ReturnType<ProxyObject["getInterface"]>;
  try {
    ({ gattManager, advertisingManager } = await Promise.race([registerEverything(), startupFailure, startupTimeout]));
  } catch (err) {
    // Rollback best-effort: se l'avvio fallisce a metà (comprese le esportazioni già avvenute), non
    // lasciare oggetti esportati orfani sul bus.
    bus.unexport(APP_PATH, application);
    bus.unexport(SERVICE_PATH, service);
    bus.unexport(PUBLIC_KEY_CHAR_PATH, publicKeyChar);
    bus.unexport(REQUEST_CHAR_PATH, requestChar);
    bus.unexport(RESPONSE_CHAR_PATH, responseChar);
    bus.unexport(ADVERTISEMENT_PATH, advertisement);
    bus.disconnect();
    throw err;
  }

  return {
    async stop(): Promise<void> {
      try {
        await advertisingManager.UnregisterAdvertisement(ADVERTISEMENT_PATH);
      } catch {
        // best-effort
      }
      try {
        await gattManager.UnregisterApplication(APP_PATH);
      } catch {
        // best-effort
      }
      bus.unexport(APP_PATH, application);
      bus.unexport(SERVICE_PATH, service);
      bus.unexport(PUBLIC_KEY_CHAR_PATH, publicKeyChar);
      bus.unexport(REQUEST_CHAR_PATH, requestChar);
      bus.unexport(RESPONSE_CHAR_PATH, responseChar);
      bus.unexport(ADVERTISEMENT_PATH, advertisement);
      bus.disconnect();
    },
  };
}
