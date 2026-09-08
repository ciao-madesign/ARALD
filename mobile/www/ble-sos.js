// Builds a genuinely valid, signed SOS packet the phone can broadcast over its Bluetooth relay
// (docs/security.md voce #65) — the phone *originating* content, not just relaying someone else's,
// closing the asymmetry left open by voce #63 ("il telefono relaya, non ancora origina").
//
// Mirrors node/src/node.ts's `sendEmergencyBeacon()`/`buildContentAnnouncePacket()` closely enough
// that the resulting packet is indistinguishable, to any real NomadNode that receives it, from one a
// Card or another NomadNode would have produced: same `EmergencyBeaconPayload` shape
// (node/src/emergency-beacon.ts), same `ContentMetadata`/`contentSigningPayload()` field order
// (node/src/content.ts), same `Priority.EMERGENCY`/`DEFAULT_TTL`. `verifyContentSignature()`
// requires a genuine Ed25519 signature over that exact byte encoding — `ble-identity.js`'s
// `loadOrCreateIdentity()` is what makes that possible outside a secure context (see its own header).
//
// Deliberately narrower than sendEmergencyBeacon() in one respect: no `senderAnnouncement` (the
// self-signed `IdentityAnnouncement` that would let an Emergency Node's "Rispondi" reach back to the
// phone) — that needs an X25519 encryption keypair *and* a PRIVATE_MESSAGE receive path
// `ble-client.js` doesn't have yet. Declared out of scope for this piece, not silently dropped —
// docs/security.md voce #65.
//
// No encryption (`NomadNodeOptions.emergencyBeaconKey`, node/src/emergency-beacon.ts's
// `EmergencyBeaconEncryptedEnvelope`) — the phone has no way to hold that pre-shared key today, and
// the payload here travels in cleartext exactly like a beacon on a deployment that never configured
// one (backward-compatible by construction, not a new wire shape).
//
// Written as a real ES module, same bridge-to-`window` pattern as ble-link.js/ble-relay.js/
// ble-identity.js — imports `sha256Hex` directly from ble-identity.js (a real ES `import`, works
// natively in the browser between two already-co-served files without a bundler, same reasoning
// that already lets both be directly `import`-able from tests/unit/ under vitest) rather than going
// through `window.AraldBleIdentity`, so this file's own logic never depends on `window` existing.

import { sha256Hex, bytesToHex } from "./ble-identity.js";
import { randomUUID } from "./ble-link.js";

/**
 * Same value as node/src/emergency-beacon.ts's `MAX_BEACON_MESSAGE_LENGTH` (itself equal to
 * `message-history.ts`'s canonical `MAX_MESSAGE_TEXT_LENGTH`) — raised from an original 200
 * (`docs/security.md` voce #65) specifically so a phone's longer SOS message doesn't get accepted
 * here only to be silently dropped by `extractEmergencyBeaconPayload()` on every real Emergency Node
 * it reaches. Duplicated as a constant here rather than imported, same no-bundler reason as every
 * other cross-referenced value in this file's own header comment.
 */
export const MAX_SOS_MESSAGE_LENGTH = 4000;

/** Same fixed content name every emergency beacon uses — node/src/emergency-beacon.ts's
 * EMERGENCY_BEACON_CONTENT_NAME, duplicated here for the same no-bundler reason SERVICE_ICONS is
 * duplicated between gateway/nomad/ and mobile/www/ (see CLAUDE.md). */
const EMERGENCY_BEACON_CONTENT_NAME = "emergency-beacon";

/** Mirrors node/src/packet.ts's Priority.EMERGENCY (0) and DEFAULT_TTL (8) — the exact values a real
 * sendEmergencyBeacon() call would use, so a phone-originated SOS floods with the same urgency/reach
 * as a Card-originated one. */
const PRIORITY_EMERGENCY = 0;
const DEFAULT_TTL = 8;
const PROTOCOL_VERSION = 1;

/** Same defaults as node/src/node.ts's private DEFAULT_BEACON_TTL_MS/MAX_BEACON_TTL_MS (not exported
 * there, mirrored here as values) — a phone-originated SOS's underlying content gets the same
 * default 24h lifetime as a Card-originated one if the caller doesn't specify one, rather than
 * `undefined` (never expires) by omission; capped the same way if the caller does specify one. */
const DEFAULT_BEACON_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BEACON_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Same byte encoding as node/src/content.ts's `contentSigningPayload()` — explicit field order,
 * JSON-encoded, `undefined` fields included (JSON.stringify drops them, matching Node's own
 * behavior for the same object shape). Must match exactly: this is what the signature actually
 * covers, and `verifyContentSignature()` on the receiving NomadNode re-derives and compares these
 * same bytes against the declared signature.
 */
function contentSigningPayload(fields) {
  return new TextEncoder().encode(
    JSON.stringify({
      contentId: fields.contentId,
      name: fields.name,
      mimeType: fields.mimeType,
      size: fields.size,
      publisherId: fields.publisherId,
      expiresAt: fields.expiresAt,
    }),
  );
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Validates and builds a fully signed CONTENT_ANNOUNCE packet for a SOS — ready to fragment
 * (`window.AraldBleLink.fragmentPacket`) and send. Same field validation as `sendEmergencyBeacon()`
 * (node/src/node.ts): `lat`/`lon` range-checked, `message` length-bounded (1-`MAX_SOS_MESSAGE_LENGTH`
 * if present, never an empty string — same "present but empty" rejection as the Node side). Throws
 * on invalid input, same as the Node original, so a caller's try/catch (ble-client.js's UI handler)
 * can surface a clear error instead of silently sending something malformed.
 *
 * `identity` is `ble-identity.js`'s `loadOrCreateIdentity()` result (`{nodeId, sign(bytes)}`).
 */
export function buildEmergencyBeaconPacket({ message, lat, lon, ttlMs } = {}, identity) {
  if (message !== undefined && (message.length === 0 || message.length > MAX_SOS_MESSAGE_LENGTH)) {
    throw new Error(`SOS message must be 1-${MAX_SOS_MESSAGE_LENGTH} characters`);
  }
  if (lat !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
    throw new Error("SOS 'lat' must be a finite number in [-90, 90]");
  }
  if (lon !== undefined && (!Number.isFinite(lon) || lon < -180 || lon > 180)) {
    throw new Error("SOS 'lon' must be a finite number in [-180, 180]");
  }
  if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
    throw new Error("SOS 'ttlMs' must be a finite positive number");
  }

  const timestamp = Date.now();
  const beaconPayload = { message, lat, lon, timestamp };
  const data = new TextEncoder().encode(JSON.stringify(beaconPayload));

  const contentId = sha256Hex(data);
  const name = EMERGENCY_BEACON_CONTENT_NAME;
  const mimeType = "application/json";
  const size = data.length;
  const publisherId = identity.nodeId;
  const expiresAt = Date.now() + Math.min(ttlMs ?? DEFAULT_BEACON_TTL_MS, MAX_BEACON_TTL_MS);

  const signature = bytesToHex(identity.sign(contentSigningPayload({ contentId, name, mimeType, size, publisherId, expiresAt })));
  const metadata = { contentId, name, mimeType, size, createdAt: Date.now(), publisherId, signature, expiresAt };

  return {
    version: PROTOCOL_VERSION,
    id: randomUUID(),
    type: "CONTENT_ANNOUNCE",
    source: identity.nodeId,
    ttl: DEFAULT_TTL,
    timestamp,
    priority: PRIORITY_EMERGENCY,
    payload: { metadata, data: bytesToBase64(data) },
  };
}

const AraldBleSos = { MAX_SOS_MESSAGE_LENGTH, buildEmergencyBeaconPacket };

// The one deliberate bridge to the classic, non-module scripts in this directory — see file header.
if (typeof window !== "undefined") {
  window.AraldBleSos = AraldBleSos;
}
