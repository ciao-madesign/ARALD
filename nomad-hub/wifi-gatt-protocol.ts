import nacl from "tweetnacl";
import { validateWifiCredentials, type WifiCredentials, type WifiProvisioningResult } from "./wifi-provisioning.js";

/**
 * Byte-level protocol for the Wi-Fi-provisioning GATT exchange
 * (`wifi-gatt-server.ts`, `docs/next-steps.md` "Provisioning Wi-Fi via
 * Bluetooth"). Deliberately separate from `wifi-gatt-server.ts` itself —
 * same "protocol distinct from transport" layering already established by
 * `sx126x-bridge-protocol.ts`/`lora-serial-sx1262.ts` for LoRa: everything
 * here is pure logic (fragmentation, encryption), testable without a real
 * D-Bus/BlueZ bus, and also independently unit-testable against the exact
 * inverse operation the phone side performs (`mobile/www/vendor/nacl.js`'s
 * `nacl.box`/`nacl.box.keyPair`, same TweetNaCl algorithm family, verified
 * interoperable by `tests/unit/nomad-hub-wifi-gatt-protocol.test.ts`
 * encrypting with a phone-side-shaped call and decrypting here).
 *
 * **Fragmentation** mirrors `mobile/www/ble-link.js`'s own technique (same
 * 5-byte wire header: msgId 1 byte + index 2 bytes BE + total 2 bytes BE) —
 * reused as a *technique*, not a direct import: there is no cross-directory
 * import path between `mobile/www/` (browser, no bundler) and `nomad-hub/`
 * (Node), and `mobile/www/ble-link.js`'s own encoding is JSON/mesh-packet
 * specific, which a Wi-Fi-provisioning exchange is not (it happens before
 * the Box has any network path at all, let alone a mesh session) — see
 * `ble-link.js`'s own header for the original rationale this reimplements.
 *
 * **Confidentiality, not authentication**: the request is end-to-end
 * encrypted with `nacl.box` (X25519 ECDH + XSalsa20-Poly1305) using an
 * ephemeral keypair on each side, chosen because the existing Card/Clip BLE
 * exchange elsewhere in this codebase (`node/src/transports/ble.ts`) only
 * signs (Ed25519, authenticity), never encrypts — leaving Wi-Fi credentials
 * in cleartext over the air would be a real regression for exactly the kind
 * of secret this feature exists to carry. This is intentionally "Just
 * Works"-style pairing, not device authentication: *any* phone in
 * Bluetooth range can complete this exchange (there is no pre-shared
 * identity to check the phone against, same trust model as a factory-reset
 * router's own Wi-Fi setup flow) — what `nacl.box` buys here is protection
 * against a passive eavesdropper on the Bluetooth link, not protection
 * against an attacker willing to actively pair. Wire layout of the request,
 * chosen to need no separate length-prefixing beyond the fixed-size fields
 * `nacl.box` itself defines:
 *
 * `[phone ephemeral public key: nacl.box.publicKeyLength bytes][nonce: nacl.box.nonceLength bytes][nacl.box ciphertext of the UTF-8 JSON {ssid, password}]`
 *
 * The response (`{status, reason?}`) travels back over the notify
 * characteristic in **plaintext** — deliberately: it carries no secret (a
 * connection outcome, not a credential), and keeping it plaintext avoids a
 * second, pointless key exchange for the Box→phone direction.
 */

/** Same reasoning/value as `ble-link.js`'s own constant — generous headroom over what any legitimate exchange here would ever need at any real ATT MTU. */
export const MAX_FRAGMENTS_PER_MESSAGE = 8192;

/** Smaller than `ble-link.js`'s own `MAX_CONCURRENT_REASSEMBLIES` (8) — a Wi-Fi-provisioning GATT server only ever reassembles one pairing request per connection, never many concurrent unrelated messages; kept at a couple of slots purely as headroom against a client retrying mid-fragment rather than as a real multiplexing need. */
const MAX_CONCURRENT_REASSEMBLIES = 4;

/** [msgId: 1 byte][index: 2 bytes BE][total: 2 bytes BE] — identical shape to `ble-link.js`'s `FRAGMENT_HEADER_SIZE`, see this file's own header for why it's reimplemented here rather than imported. */
const FRAGMENT_HEADER_SIZE = 5;

let nextMsgId = 0;

/**
 * Splits `bytes` into MTU-sized, self-contained wire fragments — `mtu` is
 * the full per-fragment byte budget, header included (same contract as
 * `ble-link.js`'s `fragmentPacket()`, including the same "reject rather
 * than silently exceed mtu" floor check that a code-review finding added
 * there).
 */
export function fragmentBytes(bytes: Uint8Array, mtu: number): Uint8Array[] {
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

  const fragments: Uint8Array[] = [];
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

interface ReassemblyEntry {
  chunks: Map<number, Uint8Array>;
  total: number;
  bytesSoFar: number;
}

/**
 * Upper bound on a single reassembled message's total byte size — a real
 * Wi-Fi provisioning request/response is always tiny (well under 200
 * bytes), so this is generous headroom, not a tight fit. Found missing by
 * code review: `MAX_FRAGMENTS_PER_MESSAGE` alone only bounds fragment
 * *count*, not the byte size a fragment may actually carry — an
 * unauthenticated nearby BLE device (this characteristic requires no
 * pairing/bonding, see `wifi-gatt-server.ts`'s own header) could otherwise
 * write fragments far larger than the Box's own intended MTU and
 * accumulate megabytes per in-flight reassembly slot, the same class of
 * unbounded-network-fed-memory bug `CLAUDE.md`'s "ogni struttura dati
 * alimentata dalla rete è limitata per dimensione" convention exists to
 * prevent elsewhere in this codebase.
 */
const MAX_REASSEMBLED_BYTES = 4096;

/**
 * Reassembles fragments for a single GATT connection — same defensive
 * bounds-checking on index/total as `ble-link.js`'s counterpart (spec §57:
 * never trust a claim from the wire), same "delete once complete" cleanup.
 */
export class FragmentReassembler {
  #entries = new Map<number, ReassemblyEntry>();

  /** Returns the reassembled bytes once every fragment for its msgId has arrived, otherwise undefined. Malformed, too-short, out-of-bounds, size-limit-exceeding, or total-mismatched fragments are rejected outright and never stored. */
  addFragment(bytes: Uint8Array): Uint8Array | undefined {
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
        if (oldestKey !== undefined) this.#entries.delete(oldestKey);
      }
      entry = { chunks: new Map(), total, bytesSoFar: 0 };
      this.#entries.set(msgId, entry);
    } else if (entry.total !== total) {
      // Un frammento che dichiara un `total` diverso da quello già registrato per questo msgId non
      // appartiene allo stesso messaggio — un msgId (1 byte, spazio di soli 256 valori) può facilmente
      // collidere tra due scambi distinti (found by code review). Scartarlo esplicitamente evita di
      // fondere byte di due messaggi diversi in un'unica ricostruzione corrotta.
      return undefined;
    }
    if (!entry.chunks.has(index)) {
      entry.bytesSoFar += payload.length;
      if (entry.bytesSoFar > MAX_REASSEMBLED_BYTES) {
        this.#entries.delete(msgId);
        return undefined;
      }
    }
    entry.chunks.set(index, payload);
    if (entry.chunks.size < entry.total) return undefined;

    const parts: Uint8Array[] = [];
    for (let i = 0; i < entry.total; i++) {
      const part = entry.chunks.get(i);
      if (!part) return undefined; // shouldn't happen given the bounds check above, but stay defensive
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

export interface EphemeralKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Fresh X25519 keypair, regenerated once per Box process start (`wifi-gatt-server.ts`'s own doc comment explains why not per-request). */
export function generateEphemeralKeyPair(): EphemeralKeyPair {
  return nacl.box.keyPair();
}

/**
 * Decrypts and validates a reassembled Wi-Fi provisioning request — see
 * this file's own header for the wire layout. Never trusts the decrypted
 * JSON's shape either: routed through `validateWifiCredentials()`
 * (`wifi-provisioning.ts`), same defensive posture as every other
 * network-sourced payload in this codebase (`CLAUDE.md`) — `nacl.box.open`
 * authenticates the ciphertext against tampering, but says nothing about
 * whether the plaintext it recovers is a well-formed `{ssid, password}`.
 * Throws with an Italian message safe to relay back to the pairing phone
 * as-is via the response characteristic (same convention as
 * `wifi-provisioning.ts`'s own `validateWifiCredentials()`).
 */
export function openWifiProvisioningRequest(requestBytes: Uint8Array, boxSecretKey: Uint8Array): WifiCredentials {
  const publicKeyLength = nacl.box.publicKeyLength;
  const nonceLength = nacl.box.nonceLength;
  const minLength = publicKeyLength + nonceLength + nacl.box.overheadLength;
  if (requestBytes.length < minLength) {
    throw new Error("richiesta di pairing troppo corta per essere valida");
  }

  const phonePublicKey = requestBytes.slice(0, publicKeyLength);
  const nonce = requestBytes.slice(publicKeyLength, publicKeyLength + nonceLength);
  const ciphertext = requestBytes.slice(publicKeyLength + nonceLength);

  const plaintext = nacl.box.open(ciphertext, nonce, phonePublicKey, boxSecretKey);
  if (!plaintext) {
    throw new Error("decifratura della richiesta di pairing fallita (chiave o messaggio non validi)");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("payload decifrato non è JSON valido");
  }
  return validateWifiCredentials(parsed);
}

/** Plaintext JSON encoding of the outcome sent back over the notify characteristic — see this file's own header for why the response, unlike the request, is not encrypted. */
export function encodeWifiProvisioningResponse(result: WifiProvisioningResult): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(result));
}
