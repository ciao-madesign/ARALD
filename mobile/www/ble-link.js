// Pure, dependency-free protocol logic for talking ARALD packets over a Bluetooth LE link from the
// phone's side — a browser-compatible port of node/src/packet.ts's newline-JSON framing and
// node/src/transports/simulated-link.ts's fragmentation/reassembly, duplicated by necessity: there is
// no bundler in mobile/www/, so no static `import` from node/src/ is possible (same reason
// SERVICE_ICONS/SERVICE_LABELS are duplicated by hand between gateway/nomad/ and mobile/www/, see
// CLAUDE.md). This file is the "pipe" logic only — it does not decide what packets the app sends over
// a Clip connection yet; see mobile/www/ble-client.js for the plugin-driven scan/connect/GATT
// orchestration built on top of it, and mobile/README.md for what's tested here versus written to
// spec because no real Bluetooth hardware exists in this development environment.
//
// Written as a real ES module (`export`, testable directly from tests/unit/ with vitest, same trick
// already used for mirror-portal/lib/format.ts and arald-backend/) — but mobile/www/'s other scripts
// (app.js, mapview.js) are loaded as classic, non-module <script> tags sharing one global scope, so at
// the end of this file every export is also attached to `window.AraldBleLink` — the one deliberate
// bridge point that lets ble-client.js use this logic without an `import`.

/**
 * Same shape/rationale as node/src/transports/simulated-link.ts's own MAX_FRAGMENTS_PER_MESSAGE: a
 * fragment claiming more total pieces than this is rejected outright, before anything is stored —
 * generous headroom over what any legitimate packet would ever produce at any MTU a real BLE link
 * would use.
 */
export const MAX_FRAGMENTS_PER_MESSAGE = 8192;

/**
 * How many distinct, not-yet-complete messages this reassembler tracks at once before evicting the
 * oldest — much smaller than simulated-link.ts's own MAX_CONCURRENT_REASSEMBLIES (32) because a phone
 * client only ever has one active Clip connection at a time (unlike the Node side, which multiplexes
 * many simultaneous peers behind one transport instance), so there is no legitimate reason for more
 * than a couple of messages to be mid-flight concurrently.
 */
const MAX_CONCURRENT_REASSEMBLIES = 8;

const PROTOCOL_VERSION = 1;

/** Mirrors node/src/packet.ts's Priority enum values actually used here — HELLO always uses the same default (MESSAGING) createPacket() would give it when not overridden. */
const PRIORITY_MESSAGING = 2;

/**
 * Newline-delimited JSON framing — same wire shape as node/src/packet.ts's encodePacket(), even
 * though a BLE link here doesn't strictly need the trailing newline (each message is already
 * delimited by its fragment set, never concatenated in a continuous byte stream the way TCP is): kept
 * identical anyway so the two encodings stay interchangeable, and because JSON.parse tolerates
 * trailing whitespace without any extra handling on the decode side.
 */
export function encodePacket(packet) {
  return `${JSON.stringify(packet)}\n`;
}

/** Same minimal-envelope validation as node/src/packet.ts's decodePacket() — never trusts the payload's shape, only the fields every packet type must have. */
export function decodePacket(text) {
  const parsed = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.id !== "string" ||
    typeof parsed.type !== "string" ||
    typeof parsed.source !== "string" ||
    typeof parsed.ttl !== "number"
  ) {
    throw new Error("malformed packet");
  }
  return parsed;
}

/** Builds a HELLO packet identifying this phone to whatever it connects to — same fields/defaults node/src/transports/simulated-link.ts's sendHelloOnce() gives one (ttl 1, default MESSAGING priority, empty payload). */
export function createHello(nodeId) {
  return {
    version: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    type: "HELLO",
    source: nodeId,
    ttl: 1,
    timestamp: Date.now(),
    priority: PRIORITY_MESSAGING,
    payload: {},
  };
}

/**
 * Wire header for one fragment: [msgId: 1 byte][index: 2 bytes big-endian][total: 2 bytes
 * big-endian], immediately followed by that fragment's payload bytes. Unlike
 * SimulatedLinkTransport.transmit() (simulated-link.ts), whose msgId/index/total travel *alongside*
 * each fragment as separate object fields on an in-process JS call, a GATT write/notification can
 * only ever carry the bytes actually put into it — there is no side channel for extra metadata across
 * a real Bluetooth link. This header exists so every field FragmentReassembler needs is self-contained
 * in the bytes themselves (found missing entirely by code review before this was added: the first
 * version passed msgId/index/total as separate fields the way the Node side does, which only worked
 * because nothing here was actually going over a wire yet).
 *
 * msgId is a single byte (not the UUID simulated-link.ts uses) — deliberately tiny, because it has to
 * fit inside an already tiny BLE fragment budget (as little as 20 bytes total at the default MTU) and
 * a phone client only ever reassembles messages for one connection at a time (unlike the Node side,
 * which needs msgIds unique enough to survive many simultaneous peers). A wrapped-around collision
 * between two genuinely concurrent in-flight messages is accepted as out of scope: nothing in this
 * piece ever has more than one handshake in flight on one connection.
 */
const FRAGMENT_HEADER_SIZE = 5;

/** Rolling 1-byte counter for msgId — wraps at 256. Module-level, deliberately not reset per FragmentReassembler instance: two fragmenters on the same connection (phone sending, phone also reassembling incoming) never share this counter's space anyway, since each side only ever reassembles what the *other* side sent. */
let nextMsgId = 0;

/**
 * Splits an already-encoded packet into MTU-sized, self-contained wire fragments — each one ready to
 * hand directly to a single GATT write call. `mtu` is the full byte budget for one fragment,
 * header included (mirrors how a real BLE ATT MTU bounds the whole write, not just its payload).
 */
export function fragmentPacket(packet, mtu) {
  if (mtu <= FRAGMENT_HEADER_SIZE) {
    // Found by code review: the previous `Math.max(1, mtu - FRAGMENT_HEADER_SIZE)` clamp silently
    // produced fragments *larger* than the caller's own declared mtu whenever mtu was too small to
    // fit even the header — a real GATT write at that ATT_MTU would then fail against the peripheral,
    // not just look wrong in a test. mtu is documented as the *full* per-fragment budget, header
    // included, so there is no payload size that honors it below this floor — fail loudly instead.
    throw new Error(`mtu too small to fit the ${FRAGMENT_HEADER_SIZE}-byte fragment header (got ${mtu})`);
  }
  const encoded = new TextEncoder().encode(encodePacket(packet));
  const payloadSize = mtu - FRAGMENT_HEADER_SIZE;
  const total = Math.max(1, Math.ceil(encoded.length / payloadSize));
  if (total > MAX_FRAGMENTS_PER_MESSAGE) {
    throw new Error(`packet too large to fragment (${total} fragments, max ${MAX_FRAGMENTS_PER_MESSAGE})`);
  }
  const msgId = nextMsgId;
  nextMsgId = (nextMsgId + 1) % 256;

  const fragments = [];
  for (let index = 0; index < total; index++) {
    const chunk = encoded.slice(index * payloadSize, (index + 1) * payloadSize);
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

/**
 * Reassembles fragments for a single Bluetooth LE connection, browser-side counterpart to
 * simulated-link.ts's FragmentReassembler — same defensive bounds-checking on index/total (never
 * trust a claim from the wire, spec §57), same "delete once complete" cleanup. Handles fragments
 * arriving out of order (BLE notify delivery is normally in-order per connection, but nothing here
 * assumes it). Takes raw wire bytes (as delivered by one GATT notification) rather than a pre-parsed
 * object — see FRAGMENT_HEADER_SIZE's own doc comment for why the header must live inside the bytes.
 */
export class FragmentReassembler {
  #entries = new Map();

  /** Returns the reassembled packet's decoded string once every fragment for its msgId has arrived, otherwise undefined. Malformed, too-short, or out-of-bounds fragments are rejected outright (return undefined) and never stored. */
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
        // Evict the oldest still-incomplete message — Map preserves insertion order, so the first
        // key is always the oldest. Same FIFO posture as BoundedFifoMap elsewhere in this codebase,
        // reimplemented inline here rather than imported (no bundler in mobile/www/, see file header).
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
      if (!part) return undefined; // shouldn't happen given the bounds check above, but stay defensive
      parts.push(part);
    }
    this.#entries.delete(msgId);

    let offset = 0;
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(totalLength);
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return new TextDecoder().decode(joined);
  }
}

/**
 * Base64 encode/decode for a byte fragment — the documented wire shape for
 * @capacitor-community/bluetooth-le's `value` field when calling the raw `window.Capacitor.Plugins`
 * bridge directly rather than through the plugin's npm wrapper class (see ble-client.js's own header
 * for why this app bypasses that wrapper, same as it already does for @capacitor/geolocation).
 * `btoa`/`atob` operate on binary strings (one char per byte), not directly on typed arrays, hence the
 * char-by-char conversion — standard, well-tested pattern, available in both browsers and Node
 * (which is what makes this pure enough to unit test here rather than only inside ble-client.js).
 */
export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const AraldBleLink = {
  MAX_FRAGMENTS_PER_MESSAGE,
  encodePacket,
  decodePacket,
  createHello,
  fragmentPacket,
  FragmentReassembler,
  bytesToBase64,
  base64ToBytes,
};

// The one deliberate bridge to the classic, non-module scripts in this directory — see file header.
if (typeof window !== "undefined") {
  window.AraldBleLink = AraldBleLink;
}
