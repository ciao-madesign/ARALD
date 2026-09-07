// Bluetooth LE central client — the phone connecting *to* a wearable ARALD Clip/Cover
// (docs/beacon.md, "ARALD Cover e ARALD Clip"), user-initiated (never a background/passive relay),
// which is exactly what makes this realistic on iOS too: the phone only ever acts as BLE *central*
// (scan + connect out), never as a *peripheral* accepting incoming connections — the role Apple
// restricts heavily in the background and this project's own mobile/README.md already documents as
// poorly supported by hybrid frameworks. The Clip is the always-on peripheral instead.
//
// Classic (non-module) script, loaded after ble-link.js (a module) in index.html — reads the pure
// protocol logic from `window.AraldBleLink` (the one deliberate bridge point that file's own header
// documents) and reuses app.js's existing UI helpers (`showToast`, `vibrate`, both defined as plain
// globals, no import needed here either). Every access to `window.AraldBleLink` below happens only
// inside event handlers (never at script top level), so it never matters whether ble-link.js's module
// script has finished executing by the time *this* classic script runs — by the time a user can tap
// anything, the page has long since finished loading.
//
// SCOPE OF THIS PIECE (deliberately limited, agreed with the user before writing this file): connect
// to a nearby Clip, exchange a HELLO handshake, show its node id once identified. Nothing is routed
// over this connection yet beyond that handshake — no SOS, chat, or location report. A future piece
// decides what to send once this pipe itself is trusted to work; see the plan/CLAUDE.md entry for
// this piece for the full reasoning.
//
// WHAT IS AND ISN'T VERIFIED HERE: the protocol logic this file calls into (ble-link.js) is unit
// tested (tests/unit/mobile-ble-link.test.ts). Everything below that calls into
// `window.Capacitor.Plugins.BluetoothLe` is written from the publicly documented behavior of
// @capacitor-community/bluetooth-le as best understood, but has never run against the real plugin,
// a real native bridge, or real Bluetooth hardware — no phone, no Clip, and no Bluetooth radio exist
// in this development environment. Verify exact method/parameter names against that plugin's own
// documentation before relying on this against real hardware, the same honesty already applied to
// node/src/transports/lora-serial.ts before it was checked against a real SX127x chip.

/**
 * Provisional GATT identifiers for a Clip this phone looks for — invented by this project as a
 * placeholder, not a standard or a firmware commitment (docs/beacon.md has no formal GATT profile
 * for the Clip yet, deliberately out of scope for this piece — see its own "Cosa NON è costruibile"
 * section). Random v4 UUIDs, not "cute" hand-picked ones, specifically so they never collide by
 * accident with a real assigned Bluetooth SIG service. Replace these, and only these, once real Clip
 * firmware work begins — nothing else in this file depends on their specific values.
 */
const CLIP_SERVICE_UUID = "6f2c6a2e-6b7b-4b8e-9a1a-0c1a6f6e5b2a";
const CLIP_WRITE_CHARACTERISTIC_UUID = "6f2c6a2f-6b7b-4b8e-9a1a-0c1a6f6e5b2a";
const CLIP_NOTIFY_CHARACTERISTIC_UUID = "6f2c6a30-6b7b-4b8e-9a1a-0c1a6f6e5b2a";

/**
 * BLE's un-negotiated ATT MTU (20 usable bytes) — same value and rationale as
 * node/src/transports/ble.ts's own DEFAULT_MTU: the value every device must support without
 * negotiation, so this genuinely exercises fragmentation rather than only working because a generous
 * value was assumed. This is the *full* per-write budget (header included) — see ble-link.js's
 * FRAGMENT_HEADER_SIZE for how much of it is payload.
 */
const BLE_MTU = 20;

/** How long to scan for a nearby Clip before giving up — generous for a real BLE scan (advertising intervals can be slow), but still bounded so a tap on "Collega" never hangs forever with no feedback. */
const SCAN_TIMEOUT_MS = 15000;

/** How long to wait for the Clip's own HELLO once connected before giving up — mirrors CONNECT_TIMEOUT_MS in node/src/transports/simulated-link.ts. */
const HELLO_TIMEOUT_MS = 5000;

let connectedDeviceId = null;
let myEphemeralNodeId = null;

/**
 * Not a cryptographic node identity (no Ed25519 keys here, unlike a real NomadNode) — a throwaway
 * label the phone uses only to identify itself in this connection's HELLO handshake, regenerated
 * every connection. Real identity/crypto for whatever gets routed over this pipe is explicitly future
 * work (see this file's own scope note above).
 */
function ephemeralPhoneNodeId() {
  return `phone-${crypto.randomUUID()}`;
}

function bleClipPlugin() {
  return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BluetoothLe;
}

function setBleClipStatus(text, isError) {
  const status = document.getElementById("ble-clip-status");
  if (!status) return;
  status.classList.toggle("error", Boolean(isError));
  status.textContent = text;
}

function setBleClipConnectedUi(peerNodeId) {
  document.getElementById("ble-clip-connect-button").hidden = true;
  document.getElementById("ble-clip-disconnect-button").hidden = false;
  setBleClipStatus(`Collegato alla Clip: ${peerNodeId}`, false);
}

function setBleClipDisconnectedUi() {
  document.getElementById("ble-clip-connect-button").hidden = false;
  document.getElementById("ble-clip-disconnect-button").hidden = true;
}

/** Writes one already-fragmented ARALD packet to the Clip's write characteristic, one plugin call per fragment — each fragment is a single self-contained wire-ready byte array (header + payload, see ble-link.js's fragmentPacket()), base64-encoded as this plugin's documented `value` wire shape. */
async function sendFragmentedPacket(plugin, deviceId, packet) {
  const fragments = window.AraldBleLink.fragmentPacket(packet, BLE_MTU);
  for (const fragment of fragments) {
    await plugin.write({
      deviceId,
      service: CLIP_SERVICE_UUID,
      characteristic: CLIP_WRITE_CHARACTERISTIC_UUID,
      value: window.AraldBleLink.bytesToBase64(fragment),
    });
  }
}

/** Scans for a nearby Clip advertising CLIP_SERVICE_UUID and resolves with its deviceId, or rejects on timeout/scan failure. Always stops the scan itself before settling, on every path. */
function scanForClip(plugin) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      plugin.stopLEScan().catch(() => {});
      reject(new Error("Nessuna Clip trovata nelle vicinanze — assicurati che sia accesa e vicina."));
    }, SCAN_TIMEOUT_MS);

    plugin
      .requestLEScan({ services: [CLIP_SERVICE_UUID] }, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        plugin.stopLEScan().catch(() => {});
        resolve(result.device.deviceId);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Subscribes to the Clip's notify characteristic and resolves once a HELLO packet has been fully
 * reassembled from it, or rejects on timeout/subscription failure. Subscribing happens synchronously
 * before this returns its promise, so the caller can send its own HELLO immediately after calling this
 * without risking missing a fast reply — see connectToClip()'s own comment on handshake ordering.
 */
function waitForPeerHello(plugin, deviceId) {
  const reassembler = new window.AraldBleLink.FragmentReassembler();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("La Clip non ha risposto in tempo."));
    }, HELLO_TIMEOUT_MS);

    plugin
      .startNotifications(
        { deviceId, service: CLIP_SERVICE_UUID, characteristic: CLIP_NOTIFY_CHARACTERISTIC_UUID },
        (event) => {
          if (settled) return;
          try {
            const bytes = window.AraldBleLink.base64ToBytes(event.value);
            const reassembled = reassembler.addFragment(bytes);
            if (!reassembled) return;
            const packet = window.AraldBleLink.decodePacket(reassembled);
            if (packet.type !== "HELLO") return; // ignore anything else until the pipe itself is trusted — see scope note above
            settled = true;
            clearTimeout(timer);
            resolve(packet.source);
          } catch {
            // malformed notification — never trust it, same posture as every other packet handler in this codebase
          }
        },
      )
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

/** Best-effort teardown of a connection that was opened but never made it to a fully identified state — every step independently caught so one failure (e.g. notifications were never actually subscribed) never stops the rest from being attempted. */
async function cleanupFailedConnection(plugin, deviceId) {
  try {
    await plugin.stopNotifications({ deviceId, service: CLIP_SERVICE_UUID, characteristic: CLIP_NOTIFY_CHARACTERISTIC_UUID });
  } catch {
    // best-effort
  }
  try {
    await plugin.disconnect({ deviceId });
  } catch {
    // best-effort
  }
}

/**
 * Connects to a nearby Clip: scan -> connect -> subscribe to notifications -> send our own HELLO ->
 * wait for the Clip's HELLO to arrive and reassemble -> resolve with the Clip's node id.
 *
 * Handshake ordering (found wrong by code review in an earlier version of this file, which waited for
 * the Clip's HELLO *before* sending its own): both sides must send their HELLO independently, the same
 * way node/src/transports/simulated-link.ts's sendHelloOnce() does on each side of a connection —
 * never gated on hearing the other side first, or two peers that both wait to hear a HELLO before
 * sending one would deadlock forever. Notifications are subscribed (waitForPeerHello) before this
 * phone sends its own HELLO, so a fast reply is never missed.
 *
 * Cleanup on failure (also found missing by code review): once `plugin.connect()` succeeds, a real
 * native BLE connection exists regardless of what happens next. Every step after that point runs
 * inside a try/catch that tears the connection back down on any failure — otherwise a timed-out
 * handshake would leave a real connection open with no way for the UI to ever reach it again, since
 * `connectedDeviceId` (what disconnectFromClip() checks) is only set once the whole handshake
 * succeeds.
 */
async function connectToClip() {
  const plugin = bleClipPlugin();
  if (!plugin) throw new Error("Bluetooth non disponibile su questo dispositivo.");
  if (connectedDeviceId) throw new Error("Già collegato a una Clip.");

  await plugin.initialize();
  const deviceId = await scanForClip(plugin);
  await plugin.connect({ deviceId }, () => {
    // Called by the plugin on an unexpected disconnect — reset our local state so a stale
    // "collegato" status is never shown once the physical link is actually gone.
    if (connectedDeviceId === deviceId) {
      connectedDeviceId = null;
      setBleClipDisconnectedUi();
      setBleClipStatus("Collegamento con la Clip interrotto.", true);
    }
  });

  try {
    const peerHelloPromise = waitForPeerHello(plugin, deviceId);
    // Attach a handler immediately, before anything below can throw — found by code review: if
    // sendFragmentedPacket() rejects (e.g. a GATT write failure), the code below never reaches
    // `await peerHelloPromise`, but that promise's own HELLO_TIMEOUT_MS timer still fires later and
    // rejects it with nothing attached, an unhandled rejection surfacing ~5s after the real error was
    // already shown to the user. This no-op catch doesn't change what the `await` below sees or
    // throws — a promise can have more than one handler.
    peerHelloPromise.catch(() => {});

    myEphemeralNodeId = ephemeralPhoneNodeId();
    await sendFragmentedPacket(plugin, deviceId, window.AraldBleLink.createHello(myEphemeralNodeId));
    const peerNodeId = await peerHelloPromise;
    connectedDeviceId = deviceId;
    return peerNodeId;
  } catch (err) {
    await cleanupFailedConnection(plugin, deviceId);
    throw err;
  }
}

/**
 * `connectedDeviceId` is cleared only once `plugin.disconnect()` itself has actually succeeded — found
 * wrong by code review in an earlier version, which cleared it upfront: if `plugin.disconnect()` then
 * failed, the UI would already claim "disconnesso" while the native connection could still be alive,
 * a claim this code had no way to back up.
 */
async function disconnectFromClip() {
  const plugin = bleClipPlugin();
  if (!plugin || !connectedDeviceId) return;
  const deviceId = connectedDeviceId;
  try {
    await plugin.stopNotifications({ deviceId, service: CLIP_SERVICE_UUID, characteristic: CLIP_NOTIFY_CHARACTERISTIC_UUID });
  } catch {
    // best-effort only — still proceed to disconnect below even if this failed
  }
  await plugin.disconnect({ deviceId });
  connectedDeviceId = null;
}

const bleClipPanel = document.getElementById("ble-clip-panel");
if (bleClipPanel) {
  // Feature-gated on the plugin's presence, not a server capability flag like every other
  // conditional panel in this app (#location-registry-panel, #map-panel, ...) — there is no gateway
  // involved in deciding whether Bluetooth is available, only this device's own runtime.
  bleClipPanel.hidden = !bleClipPlugin();

  document.getElementById("ble-clip-connect-button").addEventListener("click", async () => {
    const button = document.getElementById("ble-clip-connect-button");
    button.disabled = true;
    setBleClipStatus("Ricerca della tua Clip...", false);
    try {
      const peerNodeId = await connectToClip();
      vibrate(15);
      showToast("Collegato alla Clip", "wifi");
      setBleClipConnectedUi(peerNodeId);
    } catch (err) {
      setBleClipStatus("Errore: " + err.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("ble-clip-disconnect-button").addEventListener("click", async () => {
    const button = document.getElementById("ble-clip-disconnect-button");
    button.disabled = true;
    try {
      await disconnectFromClip();
      setBleClipDisconnectedUi();
      setBleClipStatus("Disconnesso dalla Clip.", false);
    } catch (err) {
      setBleClipStatus("Errore durante la disconnessione: " + err.message, true);
      // Deliberately does NOT call setBleClipDisconnectedUi() here (found by code review): if
      // plugin.disconnect() itself failed, connectedDeviceId is still set and the native connection
      // may still be alive — switching the UI to "Collega" would claim a disconnection this code
      // can't back up. The Disconnetti button stays visible so the user can retry.
    } finally {
      button.disabled = false;
    }
  });
}
