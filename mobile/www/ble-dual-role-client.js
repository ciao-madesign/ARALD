// Phone-to-phone Bluetooth relay WITHOUT an ARALD Clip in between, using genuine simultaneous
// central+peripheral operation — the simplification that replaces the event-driven switch in
// mobile/www/ble-role-manager.js (kept intact, unused here, as a documented fallback — see the very
// bottom of this file for exactly when/how to fall back to it).
//
// ============================================================================================
// WHY THIS FILE EXISTS, AND WHAT IT REPLACES
// ============================================================================================
// docs/security.md voce #68 built an event-driven central/peripheral switch on the premise that
// real BLE forbids two centrals from connecting to each other, and that the plugin candidate for
// giving the phone a peripheral role (@capgo/capacitor-bluetooth-low-energy) could only be *either*
// central *or* peripheral at a time — never both — based on its own README wording ("mode: 'central'
// | 'peripheral'") and a session where this plugin's actual source was unreachable (capgo.app and
// GitHub were both blocked by this environment's network egress policy).
//
// This session found a way around that block: the npm registry itself (registry.npmjs.org) was
// reachable the whole time. `npm pack @capgo/capacitor-bluetooth-low-energy@8.2.0` downloaded the
// real published package — TypeScript definitions AND native Android (`BluetoothLowEnergyPlugin.java`)
// AND iOS (`BluetoothLowEnergy.swift`) source, not a README summary. Reading that source (not
// guessed, not inferred from documentation prose) settled the question:
//
//   - Android: `initialize({mode})` sets `bluetoothLeScanner` (mode: 'central') OR
//     `bluetoothLeAdvertiser` (mode: 'peripheral') — an if/else that populates exactly one of the
//     two fields, and NEITHER initialize() branch ever nulls the other field. `startScan()` only
//     checks `bluetoothLeScanner != null`; `startAdvertising()`/`addGattService()` only check
//     `bluetoothLeAdvertiser != null` / the last-set `mode` string. Calling `initialize()` twice —
//     once per mode — leaves BOTH fields populated, and nothing gates cross-use afterwards.
//   - iOS: identical shape with `CBCentralManager`/`CBPeripheralManager` — and `startScan()` is even
//     more permissive there, lazily creating its own `centralManager` if one doesn't exist yet,
//     regardless of which mode `initialize()` was last called with.
//   - The GATT server (`BluetoothGattServer`, peripheral role — the local service centrals connect
//     to) and the map of outbound `BluetoothGatt` client connections (`connectedGatts`, central role
//     — devices we connected out to) are completely separate native objects/fields. Nothing shares
//     state between them; nothing about opening one closes or blocks the other. This matches how the
//     Android BLE stack itself is designed (a `BluetoothGattServer` and a `BluetoothGatt` client are
//     unrelated objects that the OS is built to let coexist) — the plugin doesn't fight that design,
//     it just never bothered to expose "both at once" as an intended, documented mode.
//
// Net result: `initialize({mode:'central'})` then `initialize({mode:'peripheral'})`, in that exact
// order (so the final `mode` string is "peripheral" — the one string comparison `addGattService()`
// actually checks), gives a phone BOTH roles at once, permanently, for as long as the relay feature
// is on. No more dropping peripheral connections to go find someone to send to (the whole premise
// docs/security.md voce #68 was built around) — the phone can simply always be discoverable AND
// always be looking for others, at the same time.
//
// ============================================================================================
// THE NEW LIMITATION THIS DISCOVERY ALSO SURFACED (not a free simplification)
// ============================================================================================
// Reading the same Android source turned up a real, separate problem: `connect()`,
// `writeCharacteristic()`, `startCharacteristicNotifications()`, `readCharacteristic()`, and a few
// others each track their in-flight native call behind a SINGLE shared field
// (`pendingConnectCall`, `pendingWriteCall`, `pendingNotifyCall`, `pendingReadCall`, ... — not one
// per device). `onConnectionStateChange()`/`onCharacteristicWrite()`/etc. resolve *whatever* is
// sitting in that field when they fire — there is no per-`deviceId` disambiguation anywhere in the
// callback code. Two calls of the *same* method in flight at once, to two different devices — which
// is exactly what this project's relay does whenever it discovers several ARALD peers in the same
// scan burst — can resolve/reject the wrong caller's promise. This is new complexity the OLD plugin
// (@capacitor-community/bluetooth-le, still used unchanged in mobile/www/ble-client.js for the
// phone↔Clip/Card link) does not have. It is worked around here with `mobile/www/ble-serial-queue.js`
// — every `connect()`/`discoverServices()`/`startCharacteristicNotifications()`/`writeCharacteristic()`
// call in this file goes through one shared `SerialQueue`, so only one is ever in flight at a time,
// for any device. `notifyGattCharacteristicChanged()` (used to push data to a central connected to
// our own GATT server) resolves synchronously on the native side with no pending-call field at all,
// so it is NOT queued — see its own call site below for why.
//
// A second round of code review found that serializing alone is not quite enough: a call that TIMES
// OUT (`withGattTimeout()`, so `gattQueue` can move on) leaves its real native operation still
// running, unable to be cancelled — if it eventually does complete, it still resolves whatever the
// plugin's shared field holds BY THEN, which by now belongs to a later, different call. For
// `connect()` this is fully closed: `connectAndConfirm()` (below) ignores that call's own ambiguous
// promise for success/failure and instead keys off `deviceConnected`/`deviceDisconnected` events,
// which always carry the correct `deviceId` (read from `gatt.getDevice().getAddress()`, never from
// the ambiguous field) — the plugin exposes no equivalent deviceId-tagged event for
// `discoverServices()`/`startCharacteristicNotifications()`/`writeCharacteristic()`, so a narrower
// version of the same cross-device mis-attribution risk remains genuinely open for those three
// (only on a timeout, not on the happy path) — accepted and documented at each site rather than
// silently left unmentioned. This narrows, but does not fully close, the gap this plugin's own
// single-shared-pending-call design opens up for concurrent multi-device use.
//
// ============================================================================================
// WHAT IS AND ISN'T VERIFIED HERE
// ============================================================================================
// Verified, from the actual published package source (not guessed): the API surface used below
// (method names, option/event shapes), the dual-init sequence, and the serialization requirement.
// NOT verified, and not verifiable in this environment (no real device, no emulator): whether a real
// phone's BLE radio/OS actually sustains simultaneous scan+advertise+GATT-server+GATT-client
// reliably in practice — chipset limits, OS throttling, and background-mode restrictions are real
// things this reading of the source code cannot see. GATT peripheral support in this plugin is also
// very recent (`@since 8.2.0`, published ~2 months before this was written) — less battle-tested than
// the rest of the plugin. Same honesty standard already applied throughout this codebase to code that
// has never run against real hardware (node/src/transports/lora-serial.ts, ble-client.js, and
// ble-role-manager.js's own header all carry the same caveat).
//
// ============================================================================================
// SCOPE, AND THE RELATIONSHIP TO ble-role-manager.js
// ============================================================================================
// This file is a self-contained alternative to ble-role-manager.js for the phone-to-phone relay
// problem — it does NOT use ble-role-manager.js at all (no central/peripheral switching is needed
// once both roles run at once). ble-role-manager.js is left completely untouched, still fully
// tested (docs/security.md voce #68), as the FALLBACK: if real-device validation ever shows that
// true simultaneous dual-role is unreliable in practice (the one thing this session could not
// verify), the fix is to keep using @capgo/capacitor-bluetooth-low-energy (it still supports
// explicit, one-role-at-a-time `initialize({mode})` calls) but drive its central/peripheral
// switching through ble-role-manager.js's `onEnterCentral`/`onEnterPeripheral` callbacks instead of
// this file's "always both" approach — the event-driven design (rest at peripheral, switch to
// central only when sending) still works as documented, it would just need `onEnterCentral`/
// `onEnterPeripheral` wired to this file's `initialize({mode:'central'})`/`initialize({mode:
// 'peripheral'})` + `startScan()`/`startAdvertising()` calls instead of never being wired at all.
// Nothing needs to be un-done to fall back — ble-role-manager.js already works today, on its own.
//
// This file does NOT touch mobile/www/ble-client.js (unrelated: that file talks to a DIFFERENT
// plugin, @capacitor-community/bluetooth-le, for the phone↔ARALD-Clip/Card link, which is out of
// scope here and must keep working unmodified) or any UI (index.html/app.js) — this is a backend
// orchestration module only, exposing state via plain method calls, ready for a future UI-wiring
// pass to call into. Reuses mobile/www/ble-link.js (wire framing/fragmentation) and
// mobile/www/ble-relay.js (SeenCache/decideForward/PendingRelayQueue) exactly as ble-client.js
// already does — same protocol, same relay logic, different plugin underneath.
//
// Not unit-tested directly (same posture as ble-client.js's own header explains): everything here
// calls window.Capacitor.Plugins.BluetoothLowEnergy, written to the spec verified above, never
// executed against the real plugin/native code/Bluetooth hardware. mobile/www/ble-serial-queue.js
// (the one piece of genuinely pure logic this file depends on) IS unit-tested on its own.

/**
 * Provisional GATT identifiers — intentionally IDENTICAL to mobile/www/ble-client.js's own
 * RELAY_SERVICE_UUID/RELAY_WRITE_CHARACTERISTIC_UUID/RELAY_NOTIFY_CHARACTERISTIC_UUID (duplicated
 * here, not imported/shared, to avoid touching that working, already-shipped file for this piece —
 * see this file's header). If either file's copy of these three values is ever edited, the other
 * must be updated to match, or the two plugin adapters stop being wire-compatible with each other.
 */
const RELAY_SERVICE_UUID = "6f2c6a2e-6b7b-4b8e-9a1a-0c1a6f6e5b2a";
const RELAY_WRITE_CHARACTERISTIC_UUID = "6f2c6a2f-6b7b-4b8e-9a1a-0c1a6f6e5b2a";
const RELAY_NOTIFY_CHARACTERISTIC_UUID = "6f2c6a30-6b7b-4b8e-9a1a-0c1a6f6e5b2a";

/** Same value/rationale as ble-client.js's own BLE_MTU. */
const BLE_MTU = 20;

/**
 * Same cap as ble-client.js's own MAX_CONNECTIONS, but now genuinely load-bearing for BOTH
 * directions, not just a prudent guess: this phone really is a peripheral now (real GATT server,
 * real advertising), so real chipset/OS limits on concurrent BLE connections apply to it directly.
 * Gates only OUTBOUND (central-role) connect attempts, counting outbound entries alone — found by
 * code review that an earlier version counted `connections.size` (both directions together), which
 * meant enough inbound connections alone could silently stop this phone from ever attempting new
 * outbound ones, contradicting this very comment. See `MAX_INBOUND_CONNECTIONS` below for the
 * separate inbound bound this review also found missing entirely.
 */
const MAX_CONNECTIONS = 7;

/**
 * A separate bound for INBOUND connections (centrals that connected to us) — found missing by code
 * review: every other network-fed structure in this project is bounded (`SeenCache`,
 * `PendingRelayQueue`, `BoundedFifoMap` throughout `node/src/`), but `connections` had no cap at all
 * on the inbound side, since the BLE/OS layer accepts them before this code ever runs (the plugin
 * exposes no "reject this connection" call — see `MAX_CONNECTIONS`'s own comment). Same value as
 * `MAX_CONNECTIONS` for symmetry, tracked as an independent count. Eviction is FIFO (oldest first,
 * see `evictOldestInboundIfFull()`) — there is no trust signal at this ephemeral, session-only layer
 * to weigh eviction by (same as `relaySessionNodeId` itself: a throwaway label, never a real
 * identity), so FIFO is the same honest default `SeenCache` already uses here for the same reason.
 */
const MAX_INBOUND_CONNECTIONS = 7;

/** Same value/rationale as ble-client.js's own HELLO_TIMEOUT_MS. */
const HELLO_TIMEOUT_MS = 5000;

/**
 * Bounds every native call routed through `gattQueue` (see its own doc comment) — found missing by
 * code review: `SerialQueue` only advances to its next queued task once the current one's promise
 * settles, so a single `connect()`/`discoverServices()`/`startCharacteristicNotifications()`/
 * `writeCharacteristic()` call whose native promise never settles (plausible on real hardware —
 * this GATT-peripheral path is explicitly unverified there, see this file's own header) would freeze
 * every other device's GATT operations for the rest of the session, with no error surfaced. One
 * generous value applied uniformly to all four call types for simplicity, long enough for the
 * slowest of them (`connect()` itself, which genuinely can take a few seconds over real BLE) — a
 * future pass could tune per-operation timeouts once real-hardware timing data exists, not
 * guessable now. See `withGattTimeout()`.
 */
const GATT_QUEUE_TIMEOUT_MS = 15000;

let relayActive = false;
/** Same generation-counter pattern as ble-client.js's relaySessionId / ble-role-manager.js's #sessionId — checked after every await so a stale in-flight operation from a superseded session can never act on state that no longer belongs to it. */
let relaySessionId = 0;
let relaySessionNodeId = null;
let seenCache = null;
let pendingQueue = null;
/**
 * Map<deviceId, { peerNodeId, reassembler, identifyResolvers, direction: 'outbound'|'inbound' }>.
 * `direction` decides which plugin calls to use for sending/receiving on that connection — see
 * `sendFragmentedPacket()`. Populated from two different sources: `connectToPeer()` for outbound
 * (we called `connect()`), `handleCentralConnected()` for inbound (someone connected to our GATT
 * server) — `ble-relay.js`'s forwarding logic treats both identically once identified, same as
 * ble-client.js's single-source `connections` Map.
 */
let connections = new Map();
/**
 * Serializes every `connect()`/`discoverServices()`/`startCharacteristicNotifications()`/
 * `writeCharacteristic()` call — see this file's header for why this is required for correctness
 * with this specific plugin, not an arbitrary throttle. One shared queue for all four call types,
 * not one per type: simpler to reason about, and the extra serialization cost is negligible for the
 * small, occasional relay traffic this project actually produces (same MTU=20/MAX_CONNECTIONS=7
 * assumptions already baked into the rest of this design).
 */
let gattQueue = null;
/** Handles returned by addListener(), removed on deactivateRelay() via removeAllListeners() instead of tracking/removing each individually — simpler, and this plugin has no other listeners anyone else could be relying on. */

function bleDualRolePlugin() {
  return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BluetoothLowEnergy;
}

/**
 * Races a `gattQueue`-bound task against `GATT_QUEUE_TIMEOUT_MS` — see that constant's own doc
 * comment for why this exists. On timeout, this function's own promise rejects so `gattQueue` moves
 * on to its next queued task.
 *
 * **Residual risk found by a second round of code review, not fully closeable from here**: the
 * underlying native call cannot actually be cancelled (the plugin exposes no such method) — so if
 * it eventually does settle AFTER this function has already given up and let `gattQueue` advance to
 * the NEXT queued call of the same type (for a possibly different device), that late native
 * completion still resolves whatever the plugin's own single shared `pendingXCall` field (see this
 * file's header) happens to hold by then — which by now belongs to that *different* call, not this
 * abandoned one. For `discoverServices()`/`startCharacteristicNotifications()`/`writeCharacteristic()`
 * this function is the only guard available: this plugin exposes no deviceId-tagged event to confirm
 * any of the three independently of their own ambiguous promise, so a genuine (if narrow — it only
 * matters when a call actually times out, not on the happy path) cross-device mis-attribution risk
 * remains for those three, accepted and documented rather than silently left unmentioned. `connect()`
 * is the one call this risk WAS fully closeable for — see `connectAndConfirm()` below, used instead
 * of this function for that specific call, precisely because a reliable alternative signal exists
 * for it and not for the other three.
 */
function withGattTimeout(taskFn) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("operazione BLE scaduta")), GATT_QUEUE_TIMEOUT_MS);
    taskFn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Issues `connect()` and waits for a deviceId-tagged confirmation event (`deviceConnected` on
 * success, `deviceDisconnected` on failure) instead of trusting `connect()`'s own returned promise
 * for correctness — see `withGattTimeout()`'s doc comment for why: that promise resolves via the
 * plugin's single shared `pendingConnectCall` field, so a timed-out, abandoned `connect()` call can
 * later resolve/reject the wrong device's attempt. `deviceConnected`/`deviceDisconnected` events, by
 * contrast, always carry the correct `deviceId` — read directly from `gatt.getDevice().getAddress()`
 * on the native side, never from the ambiguous pending-call field — so keying off them side-steps the
 * bug entirely for this specific call.
 *
 * `connect()`'s own promise is still awaited far enough to catch an IMMEDIATE, synchronous rejection
 * (a bad `deviceId`, a permission denied) — but never relied on for a *successful* outcome; a hang or
 * a late/misattributed resolution of that promise alone can no longer fool this function, only a
 * matching event (or the timeout) can settle it.
 *
 * Two things found by a third round of code review, both fixed here:
 *   - `addListener()` is itself awaited (its own returned promise, confirming registration) BEFORE
 *     `connect()` is issued — not fired off in parallel with it. Without that ordering, a very fast
 *     `deviceConnected` event could in principle fire before the listener was actually wired up
 *     natively, and this function would wait out the full timeout for a connection that had already
 *     succeeded.
 *   - Settling (`resolve`/`reject`) happens IMMEDIATELY when a matching event (or the timeout) fires
 *     — listener removal (`handle.remove()`) runs afterwards, fire-and-forget, never awaited before
 *     settling. An earlier version awaited listener removal first: if THAT native call ever hung —
 *     the exact same class of native-call unreliability this whole file exists to work around — this
 *     function's promise, and therefore `gattQueue.run()`'s promise, would never settle either,
 *     silently reopening the original "queue stuck forever" bug for every other device.
 */
async function connectAndConfirm(plugin, deviceId) {
  let settled = false;
  let connectedHandle;
  let disconnectedHandle;
  let timer;

  const removeListenersBestEffort = () => {
    for (const handle of [connectedHandle, disconnectedHandle]) {
      if (handle) handle.remove().catch(() => {});
    }
  };

  const result = new Promise((resolve, reject) => {
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
      removeListenersBestEffort();
    };

    timer = setTimeout(() => finish(reject, new Error("connect() non confermato in tempo")), GATT_QUEUE_TIMEOUT_MS);

    // `allSettled`, not `all` — found by a fourth round of code review: with `Promise.all`, if only
    // ONE of the two `addListener()` calls rejected (a plausible transient native-bridge failure,
    // never verified on real hardware), the whole combinator rejects before either handle is ever
    // assigned to `connectedHandle`/`disconnectedHandle` — permanently leaking whichever listener
    // DID register successfully (`removeListenersBestEffort()` would have nothing to remove). Using
    // `allSettled` and capturing every handle that actually resolved, regardless of the other's
    // outcome, means a partial failure can still be fully cleaned up.
    Promise.allSettled([
      plugin.addListener("deviceConnected", (event) => {
        if (event.deviceId === deviceId) finish(resolve);
      }),
      plugin.addListener("deviceDisconnected", (event) => {
        if (event.deviceId === deviceId) finish(reject, new Error("device disconnesso prima che il connect si confermasse"));
      }),
    ]).then(([connectedResult, disconnectedResult]) => {
      if (connectedResult.status === "fulfilled") connectedHandle = connectedResult.value;
      if (disconnectedResult.status === "fulfilled") disconnectedHandle = disconnectedResult.value;

      if (settled) {
        // The timeout (or, in principle, an already-queued microtask delivering the event) fired
        // while these registrations were still in flight — remove them right away instead of
        // leaving them dangling.
        removeListenersBestEffort();
        return;
      }
      if (connectedResult.status === "rejected" || disconnectedResult.status === "rejected") {
        finish(reject, connectedResult.reason ?? disconnectedResult.reason);
        return;
      }
      plugin.connect({ deviceId }).catch((err) => finish(reject, err));
    });
  });

  return result;
}

function newRelaySessionNodeId() {
  return `phone-${crypto.randomUUID()}`;
}

function findConnectionByPeerNodeId(peerNodeId) {
  for (const [deviceId, conn] of connections) {
    if (conn.peerNodeId === peerNodeId) return { deviceId, conn };
  }
  return null;
}

/** Number → byte-array round trip helpers — this plugin's `value` fields are plain `number[]`, not base64 (unlike the old plugin's `@capacitor-community/bluetooth-le`, which is why ble-link.js's bytesToBase64/base64ToBytes aren't reused here for the wire hop itself, only for framing the packet bytes beforehand). */
function bytesToNumberArray(bytes) {
  return Array.from(bytes);
}

function numberArrayToBytes(numbers) {
  return Uint8Array.from(numbers);
}

/**
 * Sends one already-fragmented packet to a connection, direction-aware:
 *   - outbound (we are central toward them): `writeCharacteristic()` on THEIR write characteristic
 *     — queued (see `gattQueue`'s own doc comment).
 *   - inbound (they are central toward us, connected to our GATT server): `notifyGattCharacteristicChanged()`
 *     targeted at their deviceId, on OUR notify characteristic — NOT queued: this call resolves
 *     synchronously on the native side (`characteristic.setValue()` + `gattServer.notifyCharacteristicChanged()`,
 *     no `pendingXCall` field involved at all, verified by reading the same Android source), so the
 *     race this file's header describes does not apply to it.
 */
async function sendFragmentedPacket(plugin, deviceId, conn, packet) {
  const fragments = window.AraldBleLink.fragmentPacket(packet, BLE_MTU);
  for (const fragment of fragments) {
    const value = bytesToNumberArray(fragment);
    if (conn.direction === "outbound") {
      await gattQueue.run(() =>
        withGattTimeout(() =>
          plugin.writeCharacteristic({
            deviceId,
            service: RELAY_SERVICE_UUID,
            characteristic: RELAY_WRITE_CHARACTERISTIC_UUID,
            value,
          }),
        ),
      );
    } else {
      await plugin.notifyGattCharacteristicChanged({
        service: RELAY_SERVICE_UUID,
        characteristic: RELAY_NOTIFY_CHARACTERISTIC_UUID,
        value,
        deviceId,
      });
    }
  }
}

/** Same as ble-client.js's own flushPendingFor(), adapted to this file's connection shape (needs `conn` for direction-aware sending, not just `deviceId`). */
function flushPendingFor(plugin, deviceId, conn, peerNodeId) {
  if (!pendingQueue) return;
  for (const entry of pendingQueue.drainFor(peerNodeId)) {
    sendFragmentedPacket(plugin, deviceId, conn, entry.packet).catch(() => {
      pendingQueue.requeue(entry);
    });
  }
}

/** Same as ble-client.js's own forwardPacket(), adapted to this file's connection shape. */
function forwardPacket(plugin, fromDeviceId, packet) {
  if (packet.destination !== undefined) {
    const target = findConnectionByPeerNodeId(packet.destination);
    if (target) {
      sendFragmentedPacket(plugin, target.deviceId, target.conn, packet).catch(() => {
        if (pendingQueue) pendingQueue.enqueue(packet, fromDeviceId);
      });
    } else if (pendingQueue) {
      pendingQueue.enqueue(packet, fromDeviceId);
    }
    return;
  }
  for (const [deviceId, conn] of connections) {
    if (deviceId === fromDeviceId || conn.peerNodeId === null) continue;
    sendFragmentedPacket(plugin, deviceId, conn, packet).catch(() => {});
  }
}

/**
 * Shared reassembly/HELLO/forwarding logic for one connection's incoming bytes, regardless of which
 * event produced them (`characteristicChanged` for outbound, `gattCharacteristicWriteRequest` for
 * inbound) — same shape and same reasoning as ble-client.js's own handleNotification(), see its
 * comment for why `conn.peerNodeId` is set synchronously here rather than after an await.
 */
function handleFragmentBytes(plugin, deviceId, conn, numberArrayValue) {
  let packet;
  try {
    const bytes = numberArrayToBytes(numberArrayValue);
    const reassembled = conn.reassembler.addFragment(bytes);
    if (!reassembled) return;
    packet = window.AraldBleLink.decodePacket(reassembled);
  } catch {
    return; // malformed — never trust a payload's shape, same posture as everywhere else in this project
  }

  if (conn.peerNodeId === null) {
    if (packet.type === "HELLO" && conn.identifyResolvers) {
      conn.peerNodeId = packet.source;
      conn.identifyResolvers.resolve(packet.source);
      conn.identifyResolvers = null;
    }
    return;
  }

  const decision = window.AraldBleRelay.decideForward(packet, relaySessionNodeId, seenCache);
  if (decision.duplicate || !decision.forwardPacket) return;
  forwardPacket(plugin, deviceId, decision.forwardPacket);
}

function reserveConnectionSlot(deviceId, direction) {
  const entry = {
    peerNodeId: null,
    reassembler: new window.AraldBleLink.FragmentReassembler(),
    identifyResolvers: null,
    direction,
  };
  connections.set(deviceId, entry);
  return entry;
}

/**
 * Same identity-guarded cleanup as ble-client.js's own cleanupConnection() — see its comment for why
 * `connections.get(deviceId) === conn` must be checked before deleting. Only calls `plugin.disconnect()`
 * for outbound connections: there is no native call to forcibly drop an inbound central from the
 * peripheral side in this plugin (see MAX_CONNECTIONS's own doc comment) — an inbound entry is
 * removed from JS-side bookkeeping only, its real teardown is reported later via the
 * `centralDisconnected` event.
 *
 * `plugin.disconnect()` is deliberately called directly here, NOT through `gattQueue` — checked
 * against the same Android source `gattQueue` itself is grounded in: `disconnect()` resolves
 * synchronously (`call.resolve()` right after issuing the native disconnect, no `pendingXCall` field
 * involved at all), so concurrent `disconnect()` calls for different devices cannot mis-resolve each
 * other the way `connect()`/`writeCharacteristic()`/etc. can — there is nothing here for `gattQueue`
 * to protect against. Code review raised this as a question; this comment is the answer, not a gap.
 */
async function cleanupConnection(plugin, deviceId, conn) {
  if (connections.get(deviceId) !== conn) return;
  connections.delete(deviceId);
  if (conn.direction === "outbound") {
    try {
      await plugin.disconnect({ deviceId });
    } catch {
      // best-effort
    }
  }
}

/**
 * Enforces `MAX_INBOUND_CONNECTIONS` (see its own doc comment for why this exists) — evicts the
 * oldest still-tracked inbound entry (FIFO, `Map` preserves insertion order) only when actually at
 * capacity, freeing a slot for a new inbound connection about to be reserved. The evicted device
 * stays connected at the BLE/OS level (nothing here can drop it, see `cleanupConnection()`'s own
 * comment) — it simply stops being relayed to/through until it disconnects and reconnects, an
 * accepted degraded state under resource pressure, same spirit as every other bounded/evicting
 * structure in this project trading completeness for a hard memory bound.
 */
function evictOldestInboundIfFull() {
  const inboundIds = [...connections].filter(([, conn]) => conn.direction === "inbound").map(([deviceId]) => deviceId);
  if (inboundIds.length < MAX_INBOUND_CONNECTIONS) return;
  connections.delete(inboundIds[0]);
}

class RelaySessionEndedError extends Error {}

/**
 * Connects outbound to a device already reserved in `connections` (direction: 'outbound') — mirrors
 * ble-client.js's own connectToPeer(), with two differences forced by this plugin: every native
 * call goes through `gattQueue` (see its own doc comment), and an explicit `discoverServices()` step
 * is needed before subscribing to notifications (not required by the old plugin's API shape).
 */
async function connectToPeer(plugin, deviceId, sessionId) {
  const conn = connections.get(deviceId);
  if (!conn) return;

  try {
    await gattQueue.run(() => connectAndConfirm(plugin, deviceId));
    if (sessionId !== relaySessionId) throw new RelaySessionEndedError();

    await gattQueue.run(() => withGattTimeout(() => plugin.discoverServices({ deviceId })));
    if (sessionId !== relaySessionId) throw new RelaySessionEndedError();

    await gattQueue.run(() =>
      withGattTimeout(() =>
        plugin.startCharacteristicNotifications({
          deviceId,
          service: RELAY_SERVICE_UUID,
          characteristic: RELAY_NOTIFY_CHARACTERISTIC_UUID,
        }),
      ),
    );
    if (sessionId !== relaySessionId) throw new RelaySessionEndedError();

    const peerNodeId = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.identifyResolvers = null;
        reject(new Error("nessuna risposta HELLO in tempo"));
      }, HELLO_TIMEOUT_MS);
      conn.identifyResolvers = {
        resolve: (id) => {
          clearTimeout(timer);
          resolve(id);
        },
        reject: (err) => {
          clearTimeout(timer);
          conn.identifyResolvers = null;
          reject(err);
        },
      };
      sendFragmentedPacket(plugin, deviceId, conn, window.AraldBleLink.createHello(relaySessionNodeId)).catch((err) => {
        if (conn.identifyResolvers) conn.identifyResolvers.reject(err);
      });
    });
    if (sessionId !== relaySessionId) throw new RelaySessionEndedError();

    flushPendingFor(plugin, deviceId, conn, peerNodeId);
  } catch (err) {
    await cleanupConnection(plugin, deviceId, conn);
    throw err;
  }
}

/** Same shape as ble-client.js's own handleScanResult() — one difference: no per-session scan re-issuing loop is needed here, because this plugin's `startScan({timeout: 0})` (the default) runs indefinitely on its own, unlike the old plugin's `requestLEScan()` whose continuous-scanning semantics this project could never verify (see ble-client.js's SCAN_REFRESH_INTERVAL_MS comment) — verified from this plugin's own StartScanOptions doc comment ("timeout in milliseconds, set to 0 for no timeout, @default 0"). */
function handleDeviceScanned(plugin, sessionId, event) {
  if (!relayActive || sessionId !== relaySessionId) return;
  const deviceId = event.deviceId;
  if (connections.has(deviceId)) return;
  // Counts OUTBOUND entries only — found by code review that counting `connections.size` (both
  // directions together) let enough inbound connections alone silently block new outbound attempts,
  // contradicting MAX_CONNECTIONS's own doc comment.
  const outboundCount = [...connections.values()].filter((conn) => conn.direction === "outbound").length;
  if (outboundCount >= MAX_CONNECTIONS) return;
  reserveConnectionSlot(deviceId, "outbound");
  connectToPeer(plugin, deviceId, sessionId).catch(() => {
    // connectToPeer()/cleanupConnection() already cleaned up the slot on failure — a future scan
    // result for the same device can retry naturally, nothing else to do here.
  });
}

/**
 * An outbound connection dropped unexpectedly (not via our own deactivateRelay()/cleanupConnection()
 * path) — mirrors the disconnect callback ble-client.js's old plugin API passed directly to
 * connect(); this plugin instead reports it via a global event.
 *
 * **Accepted residual risk, found by a third round of code review, not fixable from here**: this
 * event carries only a `deviceId`, no token identifying which connection *attempt* it belongs to.
 * `deviceId` is a native/OS-level address, reused across a disconnect-then-reconnect of the same
 * physical device — if `cleanupConnection()` already deleted a stale entry for this `deviceId` and
 * called `plugin.disconnect()` on it, and a brand-new, already-identified connection to that same
 * `deviceId` is established before that stale disconnect's event is finally delivered, this handler
 * cannot tell the two apart and would delete the NEW, live entry instead of the old, already-gone
 * one. There is no per-attempt correlation id in this plugin's event payloads to guard against it
 * with (unlike, say, the identify-timeout in `handleCentralConnected()`, which DOES have a
 * closure-captured `conn` object to check identity against). A narrow, timing-dependent race,
 * documented rather than papered over with an ineffective guard.
 */
function handleDeviceDisconnected(sessionId, event) {
  if (sessionId !== relaySessionId) return;
  const conn = connections.get(event.deviceId);
  if (conn && conn.direction === "outbound") connections.delete(event.deviceId);
}

/**
 * A central (another phone, running as OUR peer) connected to our own GATT server — the inbound
 * counterpart to connectToPeer(). No `connect()`/`discoverServices()` needed (we host the service),
 * so this is considerably shorter: reserve the slot, send our own HELLO right away (independent of
 * hearing theirs first, same reasoning as the outbound side and as ble-client.js), wait for theirs.
 */
function handleCentralConnected(plugin, sessionId, event) {
  if (!relayActive || sessionId !== relaySessionId) return;
  const deviceId = event.deviceId;
  if (connections.has(deviceId)) return; // already tracked (e.g. a duplicate event) — nothing to do
  evictOldestInboundIfFull();
  const conn = reserveConnectionSlot(deviceId, "inbound");

  // Session-guarded, unlike an earlier version — found by code review: without checking `sessionId`
  // here, a resolve/reject/timeout firing after a `deactivateRelay()`+`activateRelay()` cycle had
  // already replaced `connections`/`pendingQueue` with fresh objects for a new session would still
  // act on the NEW session's `pendingQueue` (draining and misdelivering entries meant for whatever
  // peer now actually holds that `deviceId`, via this stale/no-longer-connected `conn`) — the same
  // class of bug the `sessionId` checks throughout `connectToPeer()` already guard against.
  const timer = setTimeout(() => {
    if (sessionId !== relaySessionId) return;
    // Identity-guarded (`connections.get(deviceId) === conn`), same pattern as cleanupConnection() —
    // found necessary by a second round of code review: `deviceId` alone is not a unique key across
    // this connection's whole lifetime — the same physical device could disconnect and reconnect
    // (getting a fresh `conn` object via a new handleCentralConnected() call, or evicted-then-
    // re-added by evictOldestInboundIfFull()) before THIS timer fires. Without the identity check,
    // a timer belonging to an already-superseded `conn` could delete a newer, possibly already
    // identified and actively relaying, connection that happens to share the same `deviceId`.
    if (connections.get(deviceId) === conn) connections.delete(deviceId);
  }, HELLO_TIMEOUT_MS);
  conn.identifyResolvers = {
    resolve: (peerNodeId) => {
      clearTimeout(timer);
      if (sessionId !== relaySessionId) return;
      flushPendingFor(plugin, deviceId, conn, peerNodeId);
    },
    reject: () => {
      clearTimeout(timer);
      if (sessionId !== relaySessionId) return;
      conn.identifyResolvers = null;
    },
  };
  sendFragmentedPacket(plugin, deviceId, conn, window.AraldBleLink.createHello(relaySessionNodeId)).catch(() => {
    // best-effort — if this particular send fails, the central's own HELLO (once it arrives) still
    // identifies them for future forwarding; only our own outbound greeting was lost, not the link.
  });
}

/**
 * The central that connected to us disconnected — remove our JS-side bookkeeping for it (see
 * cleanupConnection()'s doc comment for why there is no native "kick" call to also issue here).
 * Same accepted residual risk as `handleDeviceDisconnected()`'s own doc comment describes (no
 * per-attempt correlation id available for a fast disconnect-then-reconnect of the same `deviceId`)
 * — not repeated in full here, see that comment.
 */
function handleCentralDisconnected(sessionId, event) {
  if (sessionId !== relaySessionId) return;
  const conn = connections.get(event.deviceId);
  if (conn && conn.direction === "inbound") connections.delete(event.deviceId);
}

/**
 * Registers every listener this file needs, once, for the lifetime of one relay session — unlike
 * the old plugin's per-connection callback style (ble-client.js), this plugin's `addListener()` is
 * global (one function receives events for every device), so dispatch-by-`deviceId` happens inside
 * each handler above rather than by registering a fresh listener per connection.
 */
async function registerListeners(plugin, sessionId) {
  await plugin.addListener("deviceScanned", (event) => handleDeviceScanned(plugin, sessionId, event));
  await plugin.addListener("deviceDisconnected", (event) => handleDeviceDisconnected(sessionId, event));
  await plugin.addListener("characteristicChanged", (event) => {
    const conn = connections.get(event.deviceId);
    if (conn && conn.direction === "outbound") handleFragmentBytes(plugin, event.deviceId, conn, event.value);
  });
  await plugin.addListener("centralConnected", (event) => handleCentralConnected(plugin, sessionId, event));
  await plugin.addListener("centralDisconnected", (event) => handleCentralDisconnected(sessionId, event));
  await plugin.addListener("gattCharacteristicWriteRequest", (event) => {
    const conn = connections.get(event.deviceId);
    if (conn && conn.direction === "inbound") handleFragmentBytes(plugin, event.deviceId, conn, event.value);
  });
}

/**
 * The verified dual-init sequence from this file's own header: `initialize({mode:'central'})` THEN
 * `initialize({mode:'peripheral'})`, in that exact order — the order matters because only the LAST
 * call's `mode` string is what `addGattService()` checks, while the FIRST call's manager/scanner
 * reference is what stays populated and usable afterwards (see the header for the full reasoning).
 * Both roles are then started together and left running for the whole session — no switching.
 */
async function activateRelay() {
  const plugin = bleDualRolePlugin();
  if (!plugin) throw new Error("Bluetooth non disponibile su questo dispositivo.");

  relaySessionId += 1;
  const sessionId = relaySessionId;
  relaySessionNodeId = newRelaySessionNodeId();
  seenCache = new window.AraldBleRelay.SeenCache();
  pendingQueue = new window.AraldBleRelay.PendingRelayQueue();
  connections = new Map();
  gattQueue = new window.AraldBleSerialQueue.SerialQueue();
  relayActive = true;

  // Everything below can fail — Bluetooth off, a permission denied, the plugin missing peripheral
  // support on this OS version, etc. ("il caso più comune" per ble-client.js's own activateRelay()
  // comment on the same class of failure). Found missing by code review: an earlier version left
  // `relayActive` stuck at `true` on any such failure, unlike ble-client.js's own activateRelay(),
  // which explicitly resets it — a future caller (e.g. a UI toggle) would then believe the relay is
  // running when it never finished starting.
  try {
    await registerListeners(plugin, sessionId);
    if (sessionId !== relaySessionId) return;

    await plugin.initialize({ mode: "central" });
    if (sessionId !== relaySessionId) return;
    await plugin.initialize({ mode: "peripheral" });
    if (sessionId !== relaySessionId) return;

    await plugin.addGattService({
      service: RELAY_SERVICE_UUID,
      characteristics: [
        {
          uuid: RELAY_WRITE_CHARACTERISTIC_UUID,
          properties: {
            write: true,
            writeWithoutResponse: true,
            read: false,
            notify: false,
            broadcast: false,
            indicate: false,
            authenticatedSignedWrites: false,
            extendedProperties: false,
          },
        },
        {
          uuid: RELAY_NOTIFY_CHARACTERISTIC_UUID,
          properties: {
            notify: true,
            read: false,
            write: false,
            writeWithoutResponse: false,
            broadcast: false,
            indicate: false,
            authenticatedSignedWrites: false,
            extendedProperties: false,
          },
        },
      ],
    });
    if (sessionId !== relaySessionId) return;

    await plugin.startAdvertising({ services: [RELAY_SERVICE_UUID] });
    if (sessionId !== relaySessionId) return;

    // timeout: 0 (the default) — runs indefinitely, verified from this plugin's own doc comment,
    // see handleDeviceScanned()'s own comment for why this needs no periodic re-issuing unlike
    // ble-client.js.
    await plugin.startScan({ services: [RELAY_SERVICE_UUID] });
  } catch (err) {
    if (sessionId === relaySessionId) relayActive = false;
    throw err;
  }
}

async function deactivateRelay() {
  relayActive = false;
  relaySessionId += 1; // invalidates any in-flight operation still tied to the previous session
  const deactivatingSessionId = relaySessionId; // this deactivation's own "ownership" token — see the guard before the final cleanup below

  const plugin = bleDualRolePlugin();
  if (plugin) {
    // Every step below re-checks `deactivatingSessionId` BEFORE running, not only the disconnect
    // loop, and BEFORE rather than after each call — found by a third round of code review:
    // checking only after a call would be too late for calls whose damage happens at the moment
    // they're ISSUED, not when their promise settles. `removeAllListeners()` is the clearest case:
    // if `activateRelay()` starts a brand-new session while this deactivation was still mid-await on
    // an earlier step, and this deactivation then reaches `removeAllListeners()` before noticing the
    // new session, that call immediately wipes out the NEW session's just-registered listeners the
    // instant it runs — checking afterwards would have already been too late. The same reasoning
    // applies to `stopScan()`/`stopAdvertising()`/`removeGattService()` against a new session that
    // already called `startScan()`/`startAdvertising()`/`addGattService()`.
    //
    // This can only check BETWEEN steps, never DURING one already in flight — accepted as a
    // residual, narrow risk: a session flip happening in the exact middle of one of these specific
    // calls is not fully closeable without a cancellation primitive this plugin does not expose.
    if (deactivatingSessionId !== relaySessionId) return;
    try {
      await plugin.stopScan();
    } catch {
      // best-effort
    }

    if (deactivatingSessionId !== relaySessionId) return;
    try {
      await plugin.stopAdvertising();
    } catch {
      // best-effort
    }

    if (deactivatingSessionId !== relaySessionId) return;
    try {
      await plugin.removeGattService({ service: RELAY_SERVICE_UUID });
    } catch {
      // best-effort
    }

    // Snapshotted before the loop, deliberately — but each iteration re-checks
    // `deactivatingSessionId` regardless, found necessary by a second round of code review: a
    // `deviceId` is a native/OS-level identifier, not scoped to this file's JS-side session concept
    // — if a NEW session has since started and already reconnected outbound to that same physical
    // device, calling `plugin.disconnect({deviceId})` here on behalf of the OLD, superseded
    // deactivation would sever that new, live connection. Checking before each iteration — not
    // after — accepts leaving the remaining old-session devices un-disconnected at the native level
    // (they will simply time out/disconnect naturally) rather than risk severing something that no
    // longer belongs to this deactivation. Same residual limitation as above: a single
    // `disconnect()` call already in flight when the session flips cannot itself be aborted.
    for (const [deviceId, conn] of [...connections]) {
      if (deactivatingSessionId !== relaySessionId) break;
      if (conn.direction === "outbound") {
        try {
          await plugin.disconnect({ deviceId });
        } catch {
          // best-effort
        }
      }
    }

    if (deactivatingSessionId !== relaySessionId) return;
    try {
      await plugin.removeAllListeners();
    } catch {
      // best-effort
    }
  }

  // Found missing by code review: without this check, a second `activateRelay()` call starting a
  // brand-new session while THIS deactivation was still mid-flight on a slow await above (e.g. an
  // unresponsive device's `plugin.disconnect()`, or `removeAllListeners()`) would resume here and
  // clobber that new session's live `connections`/`seenCache`/`pendingQueue`/`gattQueue` — all
  // module-level bindings this old deactivation has no business touching anymore by the time it
  // gets here. `relaySessionId` only ever increases (never reused), so a mismatch here can only mean
  // a newer session has since begun.
  if (deactivatingSessionId !== relaySessionId) return;

  connections.clear();
  seenCache = null;
  pendingQueue = null;
  gattQueue = null;
  relaySessionNodeId = null;
}

const AraldBleDualRoleClient = {
  activateRelay,
  deactivateRelay,
  isActive: () => relayActive,
  getConnectedPeerCount: () => [...connections.values()].filter((c) => c.peerNodeId !== null).length,
};

// The one deliberate bridge to the classic, non-module scripts in this directory — see ble-link.js's
// file header for the same pattern. No UI is wired to this yet (see this file's header) — a future
// pass would call activateRelay()/deactivateRelay() from a toggle, same shape as ble-client.js's own
// #ble-relay-toggle handler.
if (typeof window !== "undefined") {
  window.AraldBleDualRoleClient = AraldBleDualRoleClient;
}
