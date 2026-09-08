// Real Ed25519 identity for the phone's Bluetooth-relay-originated content (SOS via
// `ble-sos.js`/`ble-client.js`, docs/security.md voce #65) — a browser-compatible counterpart to
// node/src/identity.ts's `Identity`. Unlike `ble-client.js`'s `relaySessionNodeId` (a throwaway
// label, never a real key, used only to route packets among Bluetooth peers), this module produces
// a genuine, persistent Ed25519 keypair whose signature `verifyContentSignature()`
// (node/src/content.ts) accepts for real, anywhere in the mesh — required because a phone-originated
// SOS is worthless past the phone's own Bluetooth bubble without one (see ble-sos.js's own header
// comment for the full reasoning).
//
// Deliberately NOT Web Crypto (`crypto.subtle`): verified empirically that `crypto.subtle` — the
// whole object, signing *and* hashing — is entirely `undefined` outside a secure context (HTTPS or
// `localhost`/`127.0.0.1`), and a plain-HTTP LAN address (this app's most common real deployment —
// `local-portal/`, Safari over LAN, docs/emergency-portal.md) is NOT a secure context. Uses vendored
// TweetNaCl (`vendor/nacl.js`, loaded as a preceding classic <script> tag, global `nacl`) for
// Ed25519 instead — see that file's own header for the full reasoning/verification record. `crypto`
// itself (not `.subtle`) — `crypto.getRandomValues()` — IS available outside a secure context,
// verified empirically, and is what both this module's own key generation and nacl.js's internal
// PRNG rely on.
//
// Written as a real ES module, same bridge-to-`window` pattern as ble-link.js/ble-relay.js — see
// either file's own header for why (no bundler in mobile/www/, this file is also directly
// `import`-able from tests/unit/ under vitest).

/**
 * SHA-256 (FIPS 180-4), written from scratch — same precedent as node/src/qrcode.ts's from-scratch
 * QR encoder and gateway/nomad/rss-feed.ts's from-scratch RSS/Atom parser, not a vendored library
 * like nacl.js: unlike Ed25519 signing, SHA-256 has no secret key material and no malleability
 * concerns — a bug here would just produce a wrong digest (caught immediately by
 * `verifyContentSignature()`/`computeContentId()` mismatching on the receiving NomadNode, never a
 * security weakness), the same "algorithmically simple, safe to hand-write and test against known
 * vectors" risk class as a QR encoder. Needed because `crypto.subtle.digest` is unavailable for the
 * same secure-context reason `crypto.subtle.sign` is (see file header) — `computeContentId()`
 * (node/src/content.ts) is plain `sha256(data).hex()`, this must match it exactly bit-for-bit for a
 * phone-originated SOS's `contentId` to verify on a real NomadNode. Verified against known test
 * vectors and a direct comparison against Node's own `createHash("sha256")` on random inputs —
 * tests/unit/mobile-ble-identity.test.ts.
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256RotR(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/** Returns the 32-byte SHA-256 digest of `bytes` (a `Uint8Array`), as a `Uint8Array`. */
export function sha256(bytes) {
  const bitLen = bytes.length * 8;
  // Padding: 0x80, zeros until length % 64 === 56, then the 64-bit big-endian bit length.
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // bitLen fits well within 32 bits for anything this app ever hashes (an SOS payload is at most a
  // few KB) — the high 32 bits of the 64-bit length field are always zero, left as such.
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let chunkStart = 0; chunkStart < paddedLen; chunkStart += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(chunkStart + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = sha256RotR(w[i - 15], 7) ^ sha256RotR(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = sha256RotR(w[i - 2], 17) ^ sha256RotR(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = sha256RotR(e, 6) ^ sha256RotR(e, 11) ^ sha256RotR(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) | 0;
      const s0 = sha256RotR(a, 2) ^ sha256RotR(a, 13) ^ sha256RotR(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;

      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, words[i] >>> 0, false);
  return out;
}

/** Exported so `ble-sos.js` (which already imports `sha256Hex` from this file) can reuse this instead of a second, identical copy — found by review. */
export function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

/** Same shape/rounding as node/src/content.ts's computeContentId() — hex-encoded SHA-256 of `bytes`. */
export function sha256Hex(bytes) {
  return bytesToHex(sha256(bytes));
}

const SEED_STORAGE_KEY = "arald.ble.identity.seed";

/**
 * The `Storage`-like object this module persists an identity into. Defaults to `window.localStorage`
 * when present; callers (tests, or a future context without one) can inject their own — plain
 * `{getItem, setItem}`, the only two methods actually used. Never accessed at module load — only
 * inside `loadOrCreateIdentity()`, so importing this file in an environment without `window` (e.g.
 * vitest's default Node environment) never throws.
 *
 * The `window.localStorage` property access itself is wrapped in try/catch — found by review:
 * merely *reading* that property can throw in some storage-restricted contexts (not just
 * `getItem()`/`setItem()` calls on the object, already handled by `loadOrCreateSeed()` below), which
 * would otherwise propagate uncaught out of `loadOrCreateIdentity()`'s own default-parameter
 * evaluation — the one storage-failure path in this file that wasn't degrading gracefully.
 */
function defaultStorage() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads a persisted 32-byte Ed25519 seed from `storage`, or generates and persists a new one.
 * `crypto.getRandomValues()` — not `crypto.subtle` — for generation: verified available outside a
 * secure context (unlike `crypto.subtle`, see file header), which is exactly the scenario this
 * module exists for.
 *
 * `storage` access is wrapped in try/catch: private-browsing quota limits or a storage backend that
 * throws must never take down the SOS feature entirely — same "degrade, don't crash" posture as
 * every other network/platform-dependent path in this codebase. On failure, a fresh seed is
 * generated and used for this call only (not persisted) — the caller gets a working, if
 * session-only, identity rather than an error.
 */
function loadOrCreateSeed(storage) {
  if (storage) {
    try {
      const existing = storage.getItem(SEED_STORAGE_KEY);
      if (existing && /^[0-9a-f]{64}$/i.test(existing)) return hexToBytes(existing);
    } catch {
      // fall through to generating a fresh, unpersisted seed
    }
  }
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  if (storage) {
    try {
      storage.setItem(SEED_STORAGE_KEY, bytesToHex(seed));
    } catch {
      // best-effort persistence — the seed above is still returned and used for this session
    }
  }
  return seed;
}

/**
 * In-memory cache so repeated calls in the same page load return the exact same identity object,
 * even when `storage` never actually persists anything (found by review: without this, a storage
 * backend whose `getItem()` keeps succeeding-with-null while its `setItem()` silently throws — e.g.
 * Safari private browsing under quota pressure — made every single call regenerate a brand-new
 * random seed, defeating the whole point stated below: two SOS presses in the same tab would carry
 * two unrelated `publisherId`s, looking like two different originators instead of one). Keyed by the
 * `storage` argument itself (a `WeakMap`, so distinct injected storages — as this module's own tests
 * use — still get distinct identities); calls with no storage at all (`undefined`, e.g. no
 * `window.localStorage`) share one dedicated session-only slot instead, since `undefined` can't key a
 * `WeakMap`.
 */
const identityCacheByStorage = new WeakMap();
let sessionOnlyIdentity;

/**
 * Returns this phone's Ed25519 identity for signing Bluetooth-relay-originated content — same
 * `nodeId` scheme as `node/src/identity.ts`'s `Identity` (hex of the raw 32-byte public key),
 * generated once and persisted in `storage` (default `window.localStorage`) so repeated calls in the
 * same browser return the *same* identity rather than a new one each time (a phone re-sending a SOS
 * with a different `publisherId` every time would look like N different originators, not one) — see
 * the in-memory cache above for why persistence alone isn't a strong enough guarantee of that on its
 * own.
 *
 * Requires `window.nacl` (vendored TweetNaCl, `vendor/nacl.js`) to already be loaded — same
 * script-order dependency as `ble-client.js` on `ble-link.js`/`ble-relay.js`.
 */
export function loadOrCreateIdentity(storage = defaultStorage()) {
  if (storage) {
    if (identityCacheByStorage.has(storage)) return identityCacheByStorage.get(storage);
  } else if (sessionOnlyIdentity) {
    return sessionOnlyIdentity;
  }

  const seed = loadOrCreateSeed(storage);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const nodeId = bytesToHex(keyPair.publicKey);
  const identity = {
    nodeId,
    /** Ed25519-signs `bytes` (a `Uint8Array`), returning the 64-byte raw signature — same shape as node/src/identity.ts's `Identity.sign()`. */
    sign(bytes) {
      return nacl.sign.detached(bytes, keyPair.secretKey);
    },
  };
  if (storage) identityCacheByStorage.set(storage, identity);
  else sessionOnlyIdentity = identity;
  return identity;
}

const AraldBleIdentity = { sha256, sha256Hex, loadOrCreateIdentity };

// The one deliberate bridge to the classic, non-module scripts in this directory — see file header.
if (typeof window !== "undefined") {
  window.AraldBleIdentity = AraldBleIdentity;
}
