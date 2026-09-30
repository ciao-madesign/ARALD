// Phone side of "provisioning Wi-Fi via Bluetooth per il Box" (docs/next-steps.md) — lets a phone
// hand Wi-Fi credentials to a Box that has no network path at all yet (no Ethernet cable available),
// over the same physical Bluetooth radio this app already uses for the mesh relay role
// (ble-client.js). Talks to the real BlueZ GATT peripheral the Box exposes
// (nomad-hub/wifi-gatt-server.ts) — same "written to spec, never executed against the real
// plugin/hardware" honesty already established for every other file in this directory (see
// ble-client.js's own header): no phone/Box pairing has been verified end-to-end in this development
// environment.
//
// Deliberately NOT built on ble-link.js's fragmentation (JSON/mesh-packet framing, wrong shape for a
// pairing exchange that happens before the Box has any network identity to put in a HELLO's `source`
// field) — this file reimplements the same 5-byte-header fragmentation *technique* over raw bytes
// instead, mirroring nomad-hub/wifi-gatt-protocol.ts (the Box-side counterpart) byte-for-byte so the
// two sides interoperate; see that file's own header for the full wire-format rationale this module
// is the other half of.
//
// Confidentiality: nacl.box (X25519 ECDH + XSalsa20-Poly1305), vendored TweetNaCl
// (vendor/nacl.js, global `nacl` — same dependency ble-identity.js already uses for Ed25519, chosen
// over Web Crypto for the same secure-context reason documented there). Ephemeral keypair generated
// fresh for every pairing attempt (never persisted) — this is a one-shot exchange, not a repeated
// identity.
//
// Written as a real ES module, same bridge-to-`window` pattern as ble-link.js/ble-identity.js.

/** Same UUIDs as nomad-hub/wifi-gatt-server.ts — must match exactly for the phone to find/talk to the right GATT service. */
const WIFI_PROVISIONING_SERVICE_UUID = "9c1f9a00-6b7b-4b8e-9a1a-0c1a6f6e5b3a";
const PUBLIC_KEY_CHARACTERISTIC_UUID = "9c1f9a01-6b7b-4b8e-9a1a-0c1a6f6e5b3a";
const REQUEST_CHARACTERISTIC_UUID = "9c1f9a02-6b7b-4b8e-9a1a-0c1a6f6e5b3a";
const RESPONSE_CHARACTERISTIC_UUID = "9c1f9a03-6b7b-4b8e-9a1a-0c1a6f6e5b3a";

/** Same value as ble-client.js's own BLE_MTU / nomad-hub/wifi-gatt-server.ts's GATT_MTU. */
const GATT_MTU = 20;

/** How long to scan for a nearby Box advertising the service above before giving up. */
const SCAN_TIMEOUT_MS = 15000;
/**
 * How long to wait for the Box's response after sending the request — generously above the Box's own
 * worst-case `nmcli` wait (`DEFAULT_NMCLI_WAIT_SECONDS` + `EXEC_TIMEOUT_MARGIN_SECONDS` =
 * 40s, nomad-hub/wifi-provisioning.ts) plus Bluetooth transfer/fragmentation overhead.
 */
const RESPONSE_TIMEOUT_MS = 50000;

/** Same 5-byte wire header shape as nomad-hub/wifi-gatt-protocol.ts's fragmentBytes()/FragmentReassembler — see that file's own header for the full rationale, reimplemented here (not imported: no cross-directory import path between mobile/www/ and nomad-hub/, see file header above). */
const FRAGMENT_HEADER_SIZE = 5;
const MAX_FRAGMENTS_PER_MESSAGE = 8192;
const MAX_CONCURRENT_REASSEMBLIES = 4;

let nextMsgId = 0;

export function fragmentBytes(bytes, mtu) {
  if (mtu <= FRAGMENT_HEADER_SIZE) {
    throw new Error(`mtu troppo piccolo per contenere l'header di frammento da ${FRAGMENT_HEADER_SIZE} byte (ricevuto ${mtu})`);
  }
  const payloadSize = mtu - FRAGMENT_HEADER_SIZE;
  const total = Math.max(1, Math.ceil(bytes.length / payloadSize));
  if (total > MAX_FRAGMENTS_PER_MESSAGE) {
    throw new Error(`messaggio troppo grande da frammentare (${total} frammenti, massimo ${MAX_FRAGMENTS_PER_MESSAGE})`);
  }
  const msgId = nextMsgId;
  nextMsgId = (nextMsgId + 1) % 256;

  const fragments = [];
  for (let index = 0; index < total; index++) {
    const chunk = bytes.slice(index * payloadSize, (index + 1) * payloadSize);
    const wire = new Uint8Array(FRAGMENT_HEADER_SIZE + chunk.length);
    wire[0] = msgId;
    wire[1] = (index >> 8) & 0xff;
    wire[2] = index & 0xff;
    wire[3] = (total >> 8) & 0xff;
    wire[4] = total & 0xff;
    wire.set(chunk, FRAGMENT_HEADER_SIZE);
    fragments.push(wire);
  }
  return fragments;
}

export class FragmentReassembler {
  #entries = new Map();

  addFragment(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < FRAGMENT_HEADER_SIZE) return undefined;

    const msgId = bytes[0];
    const index = (bytes[1] << 8) | bytes[2];
    const total = (bytes[3] << 8) | bytes[4];
    const payload = bytes.slice(FRAGMENT_HEADER_SIZE);
    if (total <= 0 || total > MAX_FRAGMENTS_PER_MESSAGE || index < 0 || index >= total) {
      return undefined;
    }

    let entry = this.#entries.get(msgId);
    if (!entry) {
      if (this.#entries.size >= MAX_CONCURRENT_REASSEMBLIES) {
        const oldestKey = this.#entries.keys().next().value;
        this.#entries.delete(oldestKey);
      }
      entry = { chunks: new Map(), total };
      this.#entries.set(msgId, entry);
    }
    entry.chunks.set(index, payload);
    if (entry.chunks.size < entry.total) return undefined;

    const parts = [];
    for (let i = 0; i < entry.total; i++) {
      const part = entry.chunks.get(i);
      if (!part) return undefined;
      parts.push(part);
    }
    this.#entries.delete(msgId);

    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return joined;
  }
}

/**
 * Encrypts `{ssid, password}` for the Box identified by `boxPublicKey` (raw bytes read from its
 * public-key characteristic) — wire layout `[ephemeral public key][nonce][nacl.box ciphertext]`,
 * exact mirror of nomad-hub/wifi-gatt-protocol.ts's `openWifiProvisioningRequest()`. A fresh ephemeral
 * keypair per call — this is a one-shot pairing exchange, never reused across attempts.
 */
export function sealWifiCredentials(credentials, boxPublicKey) {
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

function bleProvisioningPlugin() {
  return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BluetoothLe;
}

/**
 * Scans for a nearby device advertising the Wi-Fi provisioning service, resolving with its
 * `deviceId` as soon as one is found (stops the scan immediately — this flow talks to exactly one
 * Box, never many at once, unlike ble-client.js's relay role). Rejects on timeout.
 */
function scanForBox(plugin) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      plugin.stopLEScan().catch(() => {});
      reject(new Error("nessun Box trovato nelle vicinanze entro il tempo massimo"));
    }, SCAN_TIMEOUT_MS);

    plugin
      .requestLEScan({ services: [WIFI_PROVISIONING_SERVICE_UUID] }, (result) => {
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
 * Full pairing flow: scan → connect → read the Box's public key → seal `{ssid, password}` → write it
 * fragmented → wait for the fragmented, reassembled plaintext `{status, reason?}` response over
 * notify. Always disconnects on the way out, success or failure (best-effort — a failed
 * disconnect/stopNotifications here is never surfaced, same posture as ble-client.js's
 * `cleanupConnection()`).
 *
 * `onStatus(text)` is an optional callback invoked with short Italian progress messages
 * ("Ricerca del Box...", "Invio delle credenziali...", ...) for a caller to show in the UI —
 * this function itself has no DOM dependency, so it stays unit-testable.
 *
 * `plugin.read()`'s exact raw-bridge shape (`{deviceId, service, characteristic} -> {value:
 * base64String}`) is **inferred from the established object+base64 write/notify convention already
 * used elsewhere in this file/ble-client.js, not independently verified** — this whole mobile-BLE
 * subsystem's already-accepted standard of care (ble-client.js's own header comment).
 */
export async function provisionWifiOverBluetooth({ ssid, password }, { onStatus } = {}) {
  const plugin = bleProvisioningPlugin();
  if (!plugin) throw new Error("Bluetooth non disponibile su questo dispositivo.");

  const report = (text) => {
    if (onStatus) onStatus(text);
  };

  await plugin.initialize();

  report("Ricerca del Box nelle vicinanze...");
  const deviceId = await scanForBox(plugin);

  let notificationsStarted = false;
  try {
    report("Connessione al Box...");
    await plugin.connect({ deviceId }, () => {});

    report("Lettura della chiave del Box...");
    const publicKeyRead = await plugin.read({
      deviceId,
      service: WIFI_PROVISIONING_SERVICE_UUID,
      characteristic: PUBLIC_KEY_CHARACTERISTIC_UUID,
    });
    const boxPublicKey = window.AraldBleLink.base64ToBytes(publicKeyRead.value);

    const reassembler = new FragmentReassembler();
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("nessuna risposta dal Box entro il tempo massimo"));
      }, RESPONSE_TIMEOUT_MS);
      plugin
        .startNotifications(
          { deviceId, service: WIFI_PROVISIONING_SERVICE_UUID, characteristic: RESPONSE_CHARACTERISTIC_UUID },
          (event) => {
            const bytes = window.AraldBleLink.base64ToBytes(event.value);
            const reassembled = reassembler.addFragment(bytes);
            if (!reassembled) return;
            clearTimeout(timer);
            try {
              resolve(JSON.parse(new TextDecoder().decode(reassembled)));
            } catch {
              reject(new Error("risposta del Box non valida"));
            }
          },
        )
        .then(() => {
          notificationsStarted = true;
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });

    report("Invio delle credenziali Wi-Fi...");
    const request = sealWifiCredentials({ ssid, password }, boxPublicKey);
    for (const fragment of fragmentBytes(request, GATT_MTU)) {
      await plugin.write({
        deviceId,
        service: WIFI_PROVISIONING_SERVICE_UUID,
        characteristic: REQUEST_CHARACTERISTIC_UUID,
        value: window.AraldBleLink.bytesToBase64(fragment),
      });
    }

    report("In attesa della risposta del Box...");
    return await responsePromise;
  } finally {
    if (notificationsStarted) {
      try {
        await plugin.stopNotifications({ deviceId, service: WIFI_PROVISIONING_SERVICE_UUID, characteristic: RESPONSE_CHARACTERISTIC_UUID });
      } catch {
        // best-effort
      }
    }
    try {
      await plugin.disconnect({ deviceId });
    } catch {
      // best-effort
    }
  }
}

const AraldBleWifiProvisioning = {
  fragmentBytes,
  FragmentReassembler,
  sealWifiCredentials,
  provisionWifiOverBluetooth,
};

// The one deliberate bridge to the classic, non-module scripts in this directory — see ble-link.js's own header for why.
if (typeof window !== "undefined") {
  window.AraldBleWifiProvisioning = AraldBleWifiProvisioning;
}
