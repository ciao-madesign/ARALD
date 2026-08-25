// Nomad-Net mobile client (Fase 1, Wi-Fi/TCP — docs/next-steps.md Opzione H). Plain JS, no
// framework, same discipline as node/src/web-ui.ts's own page: every value from the network goes
// through textContent (never innerHTML), because a peer's declared content name, service id, or
// capability list is untrusted input this app renders, exactly like the desktop status page does.
// Icons referenced via iconEl() point at static <symbol> ids defined once in index.html — never
// built from network data, so they carry no such risk.

const STORAGE_KEY_URL = "nomadnet.gatewayUrl";
const STORAGE_KEY_PASSWORD = "nomadnet.networkPassword";

// A serviceId no real service will ever register (real ones are always "service://..." per spec
// §35-37) — used only to probe whether a network password is accepted by POST /api/call without
// actually invoking anything. handleCall() (node/src/web-ui.ts) checks the password before it looks
// at serviceId, so the response to this probe is 401 for a wrong password and something else (404,
// since this id is obviously unknown) for a correct one — that's the only distinction this reads.
const PROBE_SERVICE_ID = "__nomadnet_setup_probe__";

// Matches the URI node/src/web-ui.ts's GET /api/pairing builds and QR-encodes (buildPairingUri()) —
// keep in sync if that format ever changes.
const PAIRING_URI_PREFIX = "nomadnet://pair?";

/**
 * Parses a scanned QR payload back into {host, password}, or null if it isn't one of ours. The `n`
 * (network name) param the QR also carries is cosmetic only — nothing in this app displays it
 * mid-scan, so it's intentionally not extracted here rather than kept as unused parsed state; add it
 * back if a "hai scansionato: <nome>" confirmation step is ever built. Never trusts the content
 * beyond this — the caller still runs it through the exact same validateNetworkPassword() probe as
 * manually-typed credentials before saving anything, since a QR is just a faster way to fill the
 * form, not a bypass of the checks that apply to filling it by hand.
 */
function parsePairingUri(text) {
  if (typeof text !== "string" || !text.startsWith(PAIRING_URI_PREFIX)) return null;
  const params = new URLSearchParams(text.slice(PAIRING_URI_PREFIX.length));
  const host = params.get("h");
  const password = params.get("p");
  if (!host || !password) return null;
  return { host, password };
}

const TRUST_LABELS = {
  UNKNOWN: "Sconosciuto",
  SEEN: "Visto",
  VERIFIED: "Verificato",
  TRUSTED: "Fidato",
  ADMIN: "Admin",
};

let gatewayUrl = localStorage.getItem(STORAGE_KEY_URL) || "";
let networkPassword = localStorage.getItem(STORAGE_KEY_PASSWORD) || "";
let refreshTimer;
/** This node's own node id, from the last /api/status response — set by renderStats(), read by renderChannelMessages() to tell a group channel message this device sent apart from one authored by someone else. */
let myNodeId = null;

// Read calls get a shorter client-side budget than POST /api/call, whose own server-side cap
// (MAX_CALL_TIMEOUT_MS, node/src/web-ui.ts) is 15s — set a bit above that so the server's own
// timeout has a chance to produce a clean error first in the common case, while still guaranteeing
// this app never hangs forever if the connection itself dies (e.g. the phone loses Wi-Fi mid-call).
const READ_TIMEOUT_MS = 10000;
const CALL_TIMEOUT_MS = 20000;

function normalizeGatewayUrl(input) {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return "http://" + trimmed;
}

function apiUrl(path) {
  return gatewayUrl + path;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } catch (err) {
    if (err.name === "AbortError") throw new Error("richiesta scaduta, controlla la connessione");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(path) {
  const res = await fetchWithTimeout(apiUrl(path), undefined, READ_TIMEOUT_MS);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/** POST /api/call (node/src/web-ui.ts) — the one write endpoint, gated by the network password entered during setup. Rejects with `err.status` set when the gateway answered (as opposed to a network/timeout failure), so callers can react to e.g. a wrong network password (401) specifically. */
async function callService(serviceId, payload) {
  const res = await fetchWithTimeout(
    apiUrl("/api/call"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + networkPassword },
      body: JSON.stringify({ serviceId, payload }),
    },
    CALL_TIMEOUT_MS,
  );
  let body;
  try {
    body = await res.json();
  } catch {
    const err = new Error("risposta non valida dal gateway (HTTP " + res.status + ")");
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(body.error || "HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  return body.result;
}

/**
 * GET /api/messages?peer=... (node/src/web-ui.ts) — unlike fetchJson()'s other callers, this needs
 * the network-password Authorization header: message text is "Private messages" (spec §56), not
 * public mesh state like /api/peers/services/content, so it's gated the same way POST /api/call is.
 */
async function fetchMessages(peer) {
  const res = await fetchWithTimeout(
    apiUrl("/api/messages?peer=" + encodeURIComponent(peer)),
    { headers: { Authorization: "Bearer " + networkPassword } },
    READ_TIMEOUT_MS,
  );
  if (res.status === 401) {
    handlePasswordRejected();
    throw new Error("password di rete non valida");
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  const body = await res.json();
  return body.messages;
}

/** POST /api/messages (node/src/web-ui.ts) — sends a 1:1 encrypted chat message. Mirrors callService()'s err.status convention so callers can react to a rejected password the same way. */
async function sendChatMessage(to, text) {
  const res = await fetchWithTimeout(
    apiUrl("/api/messages"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + networkPassword },
      body: JSON.stringify({ to, text }),
    },
    CALL_TIMEOUT_MS,
  );
  let body;
  try {
    body = await res.json();
  } catch {
    const err = new Error("risposta non valida dal gateway (HTTP " + res.status + ")");
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(body.error || "HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  return body.id;
}

/**
 * GET /api/channel-messages?channel=... (node/src/web-ui.ts) — unlike fetchMessages() above, this
 * needs no Authorization header at all: a public channel's contents are public mesh state by
 * definition (docs/next-steps.md Opzione J), not "Private messages" (spec §56), so it's the same
 * always-readable tier as fetchJson()'s other callers (/api/peers, /api/content, ...).
 */
async function fetchChannelMessages(channel) {
  const body = await fetchJson("/api/channel-messages?channel=" + encodeURIComponent(channel));
  return body.messages;
}

/** POST /api/channel-messages (node/src/web-ui.ts) — publishes a message to a public channel. Same auth/err.status convention as sendChatMessage() — posting, unlike reading, still needs the network password. */
async function sendChannelMessage(channel, text) {
  const res = await fetchWithTimeout(
    apiUrl("/api/channel-messages"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + networkPassword },
      body: JSON.stringify({ channel, text }),
    },
    CALL_TIMEOUT_MS,
  );
  let body;
  try {
    body = await res.json();
  } catch {
    const err = new Error("risposta non valida dal gateway (HTTP " + res.status + ")");
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(body.error || "HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  return body.message;
}

/** GET /api/groups (node/src/web-ui.ts) — the encrypted groups this device is a member of. Authenticated, same tier as fetchMessages(): a group's name/membership is private (spec §56), not public mesh state like a channel's. */
async function fetchGroups() {
  const res = await fetchWithTimeout(apiUrl("/api/groups"), { headers: { Authorization: "Bearer " + networkPassword } }, READ_TIMEOUT_MS);
  if (res.status === 401) {
    handlePasswordRejected();
    throw new Error("password di rete non valida");
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/** GET /api/group-messages?groupId=... (node/src/web-ui.ts) — the decrypted message history for a group this device is a member of. Same auth as fetchGroups(). */
async function fetchGroupMessages(groupId) {
  const res = await fetchWithTimeout(
    apiUrl("/api/group-messages?groupId=" + encodeURIComponent(groupId)),
    { headers: { Authorization: "Bearer " + networkPassword } },
    READ_TIMEOUT_MS,
  );
  if (res.status === 401) {
    handlePasswordRejected();
    throw new Error("password di rete non valida");
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  const body = await res.json();
  return body.messages;
}

/** POST /api/group-messages (node/src/web-ui.ts) — sends a message to a group this device is already a member of. Same err.status convention as sendChatMessage()/sendChannelMessage(). */
async function sendGroupMessage(groupId, text) {
  const res = await fetchWithTimeout(
    apiUrl("/api/group-messages"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + networkPassword },
      body: JSON.stringify({ groupId, text }),
    },
    CALL_TIMEOUT_MS,
  );
  let body;
  try {
    body = await res.json();
  } catch {
    const err = new Error("risposta non valida dal gateway (HTTP " + res.status + ")");
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(body.error || "HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  return body.message;
}

/** POST /api/groups (node/src/web-ui.ts) — creates a new encrypted group with a fixed membership decided now (no add/remove-member in this v1, see groups.ts). Same err.status convention as the others above. */
async function createGroup(name, members) {
  const res = await fetchWithTimeout(
    apiUrl("/api/groups"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + networkPassword },
      body: JSON.stringify({ name, members }),
    },
    CALL_TIMEOUT_MS,
  );
  let body;
  try {
    body = await res.json();
  } catch {
    const err = new Error("risposta non valida dal gateway (HTTP " + res.status + ")");
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(body.error || "HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  return body.group;
}

/**
 * Probes whether `password` is accepted by `baseUrl`'s POST /api/call, without invoking any real
 * service (see PROBE_SERVICE_ID above) — used during setup so a wrong network password is caught
 * with a clear error immediately, instead of only surfacing the first time the user taps "Chiama".
 * Returns true/false for a definite answer; throws (network/timeout failure, not a password verdict)
 * when the gateway couldn't be reached at all — callers should treat that as "couldn't verify", not
 * as "wrong password".
 */
async function validateNetworkPassword(baseUrl, password) {
  const res = await fetchWithTimeout(
    baseUrl + "/api/call",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + password },
      body: JSON.stringify({ serviceId: PROBE_SERVICE_ID }),
    },
    READ_TIMEOUT_MS,
  );
  return res.status !== 401;
}

function el(tag, props, children) {
  const e = document.createElement(tag);
  if (props) {
    for (const k in props) {
      if (k === "className") e.className = props[k];
      else if (k === "textContent") e.textContent = props[k];
      else if (k === "type") e.type = props[k];
      else if (k === "placeholder") e.placeholder = props[k];
      else if (k === "value") e.value = props[k];
      else if (k === "title") e.title = props[k];
    }
  }
  if (children) for (const c of children) e.append(c);
  return e;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Builds a <svg class="icon [extraClass]"><use href="#icon-name"></use></svg> referencing the static sprite in index.html. `name` is always a hardcoded literal at call sites, never network data. */
function iconEl(name, extraClass) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", extraClass ? "icon " + extraClass : "icon");
  svg.setAttribute("viewBox", "0 0 24 24"); // without this the <use>'d path (drawn in 24x24 units) renders unscaled and gets clipped by the smaller rendered box instead of fitting it
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", "#icon-" + name);
  svg.append(use);
  return svg;
}

function renderEmptyIfNeeded(list, items, message, iconName) {
  list.textContent = "";
  if (items.length === 0) {
    const empty = el("div", { className: "empty" }, [el("span", { textContent: message })]);
    if (iconName) empty.prepend(iconEl(iconName));
    list.append(el("li", null, [empty]));
    return true;
  }
  return false;
}

/**
 * Shows a brief auto-dismissing toast (bottom pill) — used for confirmations that don't warrant a
 * persistent banner, e.g. "connessione ristabilita" after a transient gateway error clears. Ignored
 * entirely under prefers-reduced-motion at the CSS level (animation-duration collapses to ~0), so no
 * JS branching is needed here for that.
 */
// Two timers are in flight while a toast is showing (the 2600ms "start fading" one, then the 220ms
// "actually hide" one) — both must be tracked and cleared on a new call, or a toast shown while the
// previous one is still mid-fade can get cut short by the first toast's stale "now hide" timer.
let toastHideTimer;
let toastLeaveTimer;
function showToast(message, iconName) {
  const toast = document.getElementById("toast");
  clearTimeout(toastHideTimer);
  clearTimeout(toastLeaveTimer);
  toast.classList.remove("is-leaving");
  toast.textContent = "";
  if (iconName) toast.append(iconEl(iconName));
  toast.append(el("span", { textContent: message }));
  toast.hidden = false;
  toastHideTimer = setTimeout(() => {
    toast.classList.add("is-leaving");
    toastLeaveTimer = setTimeout(() => {
      toast.hidden = true;
    }, 220);
  }, 2600);
}

/** Best-effort haptic feedback (Vibration API — Chrome/Android WebView; silently a no-op elsewhere, e.g. iOS Safari/WebView which never implements it). Never throws: some embedders (including sandboxed iframes) expose the method but reject the call. */
function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    // best-effort only
  }
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "adesso";
  const m = Math.round(s / 60);
  if (m < 60) return "da " + m + " min";
  const h = Math.round(m / 60);
  if (h < 24) return "da " + h + " h";
  return "da " + Math.round(h / 24) + " g";
}

// ---------- setup screen ----------

// True once a gateway address is already known (from a previous successful pairing) — in that case
// the address field stays collapsed by default and only the password is asked for, the same
// "network already joined, just re-enter the password" experience a phone gives when a Wi-Fi
// router's password changes but the network itself is the same one you joined before. A brand-new
// install (no address stored yet) has no such shortcut: the address really is needed once.
function addressFieldNeeded() {
  return !gatewayUrl;
}

function showSetupScreen(errorMessage) {
  document.getElementById("setup-screen").hidden = false;
  document.getElementById("dashboard-screen").hidden = true;
  clearInterval(refreshTimer);
  closeChatPanel();
  closeChannelPanel();
  closeGroupPanel();

  const needsAddress = addressFieldNeeded();
  document.getElementById("address-field").hidden = !needsAddress;
  document.getElementById("gateway-input").required = needsAddress;
  document.getElementById("change-address").hidden = needsAddress;
  if (!needsAddress) {
    document.getElementById("gateway-input").value = gatewayUrl.replace(/^https?:\/\//, "");
  }

  document.getElementById("password-input").value = "";
  document.getElementById("password-input").type = "password";
  setPasswordToggleState(false);

  const errorEl = document.getElementById("setup-error");
  if (errorMessage) {
    errorEl.textContent = "";
    errorEl.append(iconEl("alert-circle"), el("span", { textContent: errorMessage }));
    errorEl.hidden = false;
  } else {
    errorEl.hidden = true;
  }
  setConnectSubmitBusy(false);

  // Focus the first field the user actually needs to fill — helps keyboard/screen-reader users land
  // ready to type instead of having to find the input themselves, and matters more here than on a
  // typical form because this runs every time setup re-appears (e.g. after a password rejection).
  const target = document.getElementById(needsAddress ? "gateway-input" : "password-input");
  if (document.activeElement !== target) target.focus({ preventScroll: true });
}

function setPasswordToggleState(showing) {
  const btn = document.getElementById("toggle-password");
  btn.setAttribute("aria-pressed", String(showing));
  btn.setAttribute("aria-label", showing ? "Nascondi password" : "Mostra password");
  btn.textContent = "";
  btn.append(iconEl(showing ? "eye-off" : "eye"));
}

function setConnectSubmitBusy(busy) {
  const btn = document.getElementById("connect-submit");
  btn.disabled = busy;
  btn.querySelector(".btn-label").textContent = busy ? "Connessione..." : "Connetti";
  btn.querySelector(".btn-spinner").hidden = !busy;
}

document.getElementById("toggle-password").addEventListener("click", () => {
  const input = document.getElementById("password-input");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  setPasswordToggleState(!showing);
  input.focus({ preventScroll: true });
});

document.getElementById("change-address").addEventListener("click", () => {
  document.getElementById("address-field").hidden = false;
  document.getElementById("gateway-input").required = true;
  document.getElementById("change-address").hidden = true;
  document.getElementById("gateway-input").focus({ preventScroll: true });
});

document.getElementById("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const addressVisible = !document.getElementById("address-field").hidden;
  const candidateUrl = addressVisible ? normalizeGatewayUrl(document.getElementById("gateway-input").value) : gatewayUrl;
  const candidatePassword = document.getElementById("password-input").value.trim();
  setConnectSubmitBusy(true);

  const previousUrl = gatewayUrl;
  gatewayUrl = candidateUrl;
  let status;
  try {
    status = await fetchJson("/api/status");
  } catch (err) {
    gatewayUrl = previousUrl;
    showSetupScreen("Impossibile raggiungere il gateway a " + candidateUrl + ": " + err.message);
    return;
  }
  // /api/status only ever includes networkName when the gateway was started with
  // --allow-service-calls (node/src/web-ui.ts buildStatus()) — without this check, a gateway with
  // pairing disabled entirely answers every POST /api/call with 404 regardless of Authorization,
  // which validateNetworkPassword() below would otherwise misread as "any password is accepted"
  // (it only distinguishes 401 from everything else).
  if (!status.networkName) {
    gatewayUrl = previousUrl;
    showSetupScreen("Questo gateway non supporta ancora l'app mobile (nessuna password di rete configurata).");
    return;
  }

  let passwordOk;
  try {
    passwordOk = await validateNetworkPassword(candidateUrl, candidatePassword);
  } catch (err) {
    gatewayUrl = previousUrl;
    showSetupScreen("Impossibile verificare la password: " + err.message);
    return;
  }
  if (!passwordOk) {
    gatewayUrl = previousUrl;
    showSetupScreen("Password di rete errata.");
    return;
  }

  networkPassword = candidatePassword;
  localStorage.setItem(STORAGE_KEY_URL, gatewayUrl);
  localStorage.setItem(STORAGE_KEY_PASSWORD, networkPassword);
  vibrate(12);
  showDashboard();
});

// ---------- QR scanner ----------
//
// Uses the browser's native BarcodeDetector API (Shape Detection API) — zero dependencies, ships in
// Chrome/Android WebView (which is what a Capacitor app on Android actually runs on) since Chrome
// 83, but not in Firefox or Safari, so the button is only ever shown when the API is actually
// present. This app has no way to verify BarcodeDetector's live decode path in this development
// environment (the sandboxed headless Chromium used for automated verification here doesn't
// implement it either — confirmed directly, not assumed), so this is the same class of "written to
// spec, can't fully verify end-to-end in this environment" limitation as the native Android build
// itself (see mobile/README.md) — parsePairingUri() above is covered by feeding it synthetic input
// directly, independent of whether a camera or detector is present.
const hasBarcodeDetector = "BarcodeDetector" in window;
if (hasBarcodeDetector) document.getElementById("scan-qr").hidden = false;

let scannerStream = null;
let scannerRafId = null;
// Bumped by stopScanner() every time it runs (including the very first "annulla" tap before any
// camera was ever granted). getUserMedia() can take a while to resolve (the OS permission prompt,
// slow hardware init) — without this, tapping "Annulla" while that's still pending was a no-op (both
// scannerStream and scannerRafId are still null then), so the camera would be attached and the scan
// loop started anyway the moment getUserMedia() finally resolved, well after the user cancelled.
let scannerSessionId = 0;

function stopScanner() {
  scannerSessionId++;
  if (scannerRafId !== null) cancelAnimationFrame(scannerRafId);
  scannerRafId = null;
  if (scannerStream) {
    scannerStream.getTracks().forEach((track) => track.stop());
    scannerStream = null;
  }
  document.getElementById("scanner-overlay").hidden = true;
}

function applyScannedPairing(pairing) {
  document.getElementById("address-field").hidden = false;
  document.getElementById("gateway-input").required = true;
  document.getElementById("change-address").hidden = true;
  document.getElementById("gateway-input").value = pairing.host;
  document.getElementById("password-input").value = pairing.password;
  // Goes through the exact same submit handler (reachability + password probe) as manual entry —
  // see parsePairingUri()'s doc comment above for why this never shortcuts that validation.
  document.getElementById("setup-form").requestSubmit();
}

async function startScanner() {
  const overlay = document.getElementById("scanner-overlay");
  const video = document.getElementById("scanner-video");
  const errorEl = document.getElementById("scanner-error");
  errorEl.hidden = true;
  overlay.hidden = false;

  const mySessionId = ++scannerSessionId;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch (err) {
    if (mySessionId !== scannerSessionId) return; // cancelled while the permission prompt was still up
    errorEl.textContent = "Impossibile accedere alla fotocamera: " + err.message;
    errorEl.hidden = false;
    return;
  }
  if (mySessionId !== scannerSessionId) {
    // Cancelled while getUserMedia() was still pending — the user already dismissed the scanner,
    // so don't attach a camera stream or start polling it; just release what we were just granted.
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  scannerStream = stream;
  video.srcObject = scannerStream;

  const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
  const scanLoop = async () => {
    if (!scannerStream) return; // stopScanner() already ran — don't schedule another frame
    let codes = [];
    try {
      codes = await detector.detect(video);
    } catch {
      // Transient decode failures (e.g. the video frame isn't ready yet) are normal — keep polling.
    }
    const match = codes.map((code) => parsePairingUri(code.rawValue)).find((parsed) => parsed !== null);
    if (match) {
      stopScanner();
      applyScannedPairing(match);
      return;
    }
    scannerRafId = requestAnimationFrame(() => {
      scanLoop().catch(() => {});
    });
  };
  scanLoop().catch(() => {});
}

document.getElementById("scan-qr").addEventListener("click", () => {
  startScanner().catch(() => {});
});
document.getElementById("scanner-cancel").addEventListener("click", stopScanner);

document.getElementById("forget-network").addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY_URL);
  localStorage.removeItem(STORAGE_KEY_PASSWORD);
  gatewayUrl = "";
  networkPassword = "";
  document.getElementById("gateway-input").value = ""; // showSetupScreen() only writes this field when an address is already known — a full reset has none, so it must be cleared here explicitly or a stale address would linger from before the reset
  showSetupScreen();
});

/**
 * Called when a live service call comes back 401 (the network password was rejected — e.g. the
 * gateway restarted and cli.ts generated a fresh one, per node/src/cli.ts). Bounces back to the
 * setup screen in "just re-enter the password" mode (the address stays remembered) instead of
 * leaving the user stuck with a dead dashboard — the same experience a phone gives when a known
 * Wi-Fi network's password changes: it asks you to rejoin, it doesn't forget the network itself.
 */
function handlePasswordRejected() {
  networkPassword = "";
  localStorage.removeItem(STORAGE_KEY_PASSWORD);
  showSetupScreen("La password di rete non è più valida. Reinseriscila.");
}

// ---------- dashboard ----------

// Skeleton placeholders shown between showDashboard() and the first successful refreshAll() —
// distinguishes "still loading" from "genuinely empty" (an empty peers list and a not-yet-fetched
// one used to look identical). Cleared for good once the first real render happens; the periodic 5s
// refresh never shows skeletons again, even if a later refresh is slow, so live data never flashes
// away mid-session.
let firstLoadDone = false;

const GAUGE_RADIUS = 42;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;

/**
 * Approximate, honestly-labelled network-health reading derived only from the number of reachable
 * peers — the only "how connected am I" signal /api/status actually exposes (no latency/loss
 * measurement exists in this prototype, spec §22). Never claims false precision: the ring fraction
 * is illustrative and caps well short of a full circle even at many peers, and the word label (not
 * a fabricated percentage) is what the "condizione del sentiero" reading actually communicates —
 * same transparency principle as the self-declared "Internet: OFFLINE" on the desktop status page
 * (node/src/web-ui.ts).
 */
function gaugeReading(peers) {
  if (peers === 0) return { fraction: 0.06, label: "Isolato", tone: "off" };
  if (peers === 1) return { fraction: 0.5, label: "Debole", tone: "signal" };
  return { fraction: Math.min(0.95, 0.3 + peers * 0.2), label: "Solido", tone: "signal" };
}

/** Builds the radial "condizione del sentiero" ring — a plain track circle, plus (unless `muted`, used for the loading skeleton) a progress arc in `tone`'s color for `fraction` of the circumference. */
function buildGaugeRing(fraction, muted, tone) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", "gauge-ring" + (muted ? " skel-ring" : ""));
  svg.setAttribute("aria-hidden", "true");
  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("cx", "50");
  track.setAttribute("cy", "50");
  track.setAttribute("r", String(GAUGE_RADIUS));
  track.setAttribute("fill", "none");
  track.setAttribute("stroke", "var(--border)");
  track.setAttribute("stroke-width", "9");
  svg.append(track);
  if (!muted) {
    const arc = document.createElementNS(SVG_NS, "circle");
    arc.setAttribute("cx", "50");
    arc.setAttribute("cy", "50");
    arc.setAttribute("r", String(GAUGE_RADIUS));
    arc.setAttribute("fill", "none");
    arc.setAttribute("stroke", tone === "off" ? "var(--off)" : "var(--signal)");
    arc.setAttribute("stroke-width", "9");
    arc.setAttribute("stroke-linecap", "round");
    arc.setAttribute("stroke-dasharray", (fraction * GAUGE_CIRCUMFERENCE).toFixed(1) + " " + GAUGE_CIRCUMFERENCE.toFixed(1));
    arc.setAttribute("transform", "rotate(-90 50 50)");
    svg.append(arc);
  }
  return svg;
}

function renderStatSkeletons() {
  const stats = document.getElementById("stats");
  stats.textContent = "";
  stats.setAttribute("aria-busy", "true");
  stats.append(
    buildGaugeRing(0, true, "off"),
    el("div", null, [el("div", { className: "skel skel-line w-60" }), el("div", { className: "skel skel-line w-80" })]),
  );
}

function listSkeleton(list, rows) {
  list.textContent = "";
  list.setAttribute("aria-busy", "true");
  for (let i = 0; i < rows; i++) {
    list.append(el("li", { className: "skel-row" }, [el("div", { className: "skel skel-line w-60" }), el("div", { className: "skel skel-line w-40" })]));
  }
}

function renderSkeletons() {
  renderStatSkeletons();
  listSkeleton(document.getElementById("peers"), 2);
  listSkeleton(document.getElementById("services"), 3);
  listSkeleton(document.getElementById("content"), 3);
  listSkeleton(document.getElementById("channels"), 2);
  listSkeleton(document.getElementById("groups"), 2);
}

function showDashboard() {
  document.getElementById("setup-screen").hidden = true;
  document.getElementById("dashboard-screen").hidden = false;
  firstLoadDone = false;
  peerSeenIds = new Set();
  serviceSeenIds = new Set();
  contentSeenIds = new Set();
  lastContentQuery = null;
  channelSeenNames = new Set();
  groupSeenIds = new Set();
  closeChatPanel();
  closeChannelPanel();
  closeGroupPanel();
  renderSkeletons();
  const main = document.getElementById("dashboard-main");
  main.focus({ preventScroll: true }); // announces the screen change to screen-reader users
  refreshAll();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, 5000);
}

// Tracks whether the dashboard is currently showing a "gateway non raggiungibile" banner, so
// clearing it can offer a small "connessione ristabilita" confirmation instead of just silently
// removing the error — otherwise a flaky connection recovering is invisible unless the user happens
// to be looking at the (now-empty) error area at that exact moment.
let dashboardHadError = false;

function setDashboardError(message) {
  const wrap = document.getElementById("dashboard-error-wrap");
  const el = document.getElementById("dashboard-error");
  if (message) {
    el.textContent = "";
    el.append(iconEl("alert-triangle"), document.createTextNode(message));
    wrap.hidden = false;
    dashboardHadError = true;
  } else {
    wrap.hidden = true;
    if (dashboardHadError && firstLoadDone) showToast("Connessione ristabilita", "check-circle");
    dashboardHadError = false;
  }
}

document.getElementById("retry-refresh").addEventListener("click", () => {
  refreshAll().catch(() => {});
});

function renderStats(s) {
  myNodeId = s.nodeId; // needed by renderChannelMessages() to tell "my own message" apart from another author's
  const stats = document.getElementById("stats");
  stats.textContent = "";
  stats.removeAttribute("aria-busy");
  const { fraction, label, tone } = gaugeReading(s.peers);
  const detail =
    (s.peers === 1 ? "1 vicino" : s.peers + " vicini") +
    " · " +
    (s.services === 1 ? "1 servizio attivo" : s.services + " servizi attivi") +
    " · cache " +
    s.cachedContentPercent +
    "% · relay " +
    (s.relaying ? "attivo" : "fermo");
  stats.append(
    buildGaugeRing(fraction, false, tone),
    el("div", null, [el("div", { className: "gauge-label", textContent: label }), el("div", { className: "gauge-detail", textContent: detail })]),
  );
  stats.setAttribute("aria-label", "Stato della rete: " + label + ". " + detail);
  document.getElementById("node-label").textContent = "Connesso a: " + (s.networkName || s.displayName);
}

let peerSeenIds = new Set();

function renderPeers(peers) {
  const list = document.getElementById("peers");
  list.removeAttribute("aria-busy");
  document.getElementById("peers-count").textContent = peers.length > 0 ? String(peers.length) : "";
  if (renderEmptyIfNeeded(list, peers, "Nessun vicino connesso al momento.", "users")) {
    peerSeenIds = new Set();
    return;
  }
  const nextSeen = new Set();
  for (const p of peers) {
    nextSeen.add(p.nodeId);
    const li = el("li", null, [
      el("div", { className: "row" }, [
        el("span", { className: "row-title mono", textContent: p.shortLabel, title: p.shortLabel }),
        el("span", { className: "muted", textContent: timeAgo(p.connectedAt) }),
      ]),
      el("div", { className: "tags" }, [el("span", { className: "tag", textContent: TRUST_LABELS[p.trustLevel] || p.trustLevel })]),
    ]);
    li.dataset.peerId = p.nodeId;
    // canMessage lags a moment behind the connection itself (identity sync, not instant) — the
    // button simply isn't there yet for a peer that just connected, same gating style as services'
    // own "Chiama" button below.
    if (p.canMessage && networkPassword) {
      const messageButton = el("button", { className: "call-button", textContent: "Messaggia" });
      messageButton.addEventListener("click", () => openChatPanel(p.nodeId, p.shortLabel));
      li.append(messageButton);
    }
    if (openChatPeer === p.nodeId) li.classList.add("is-open");
    if (!peerSeenIds.has(p.nodeId)) li.classList.add("enter");
    list.append(li);
  }
  peerSeenIds = nextSeen;
  renderGroupMemberPicker(peers);
}

let channelSeenNames = new Set();

function renderChannels(channels) {
  const list = document.getElementById("channels");
  list.removeAttribute("aria-busy");
  document.getElementById("channels-count").textContent = channels.length > 0 ? String(channels.length) : "";
  if (renderEmptyIfNeeded(list, channels, "Nessun canale conosciuto ancora. Aprine uno qui sopra.", "message-circle")) {
    channelSeenNames = new Set();
    return;
  }
  const nextSeen = new Set();
  for (const c of channels) {
    nextSeen.add(c.channel);
    const li = el("li", null, [
      el("div", { className: "row" }, [
        el("span", { className: "row-title mono", textContent: "#" + c.channel, title: c.channel }),
        el("span", { className: "muted", textContent: timeAgo(c.lastActivity) }),
      ]),
      el("div", { className: "tags" }, [el("span", { className: "tag", textContent: c.messageCount === 1 ? "1 messaggio" : c.messageCount + " messaggi" })]),
    ]);
    li.dataset.channel = c.channel;
    if (networkPassword) {
      const openButton = el("button", { className: "call-button", textContent: "Apri" });
      openButton.addEventListener("click", () => openChannelPanel(c.channel));
      li.append(openButton);
    }
    if (openChannel === c.channel) li.classList.add("is-open");
    if (!channelSeenNames.has(c.channel)) li.classList.add("enter");
    list.append(li);
  }
  channelSeenNames = nextSeen;
}

let groupSeenIds = new Set();

function renderGroups(groups) {
  const list = document.getElementById("groups");
  list.removeAttribute("aria-busy");
  document.getElementById("groups-count").textContent = groups.length > 0 ? String(groups.length) : "";
  if (renderEmptyIfNeeded(list, groups, "Nessun gruppo ancora. Creane uno qui sopra.", "lock")) {
    groupSeenIds = new Set();
    return;
  }
  const nextSeen = new Set();
  for (const g of groups) {
    nextSeen.add(g.groupId);
    const memberCount = g.members.length + 1; // + this device itself, not listed among its own members
    const li = el("li", null, [
      el("div", { className: "row" }, [
        el("span", { className: "row-title", textContent: g.name, title: g.name }),
        el("span", { className: "muted", textContent: memberCount === 2 ? "2 membri" : memberCount + " membri" }),
      ]),
    ]);
    li.dataset.groupId = g.groupId;
    const openButton = el("button", { className: "call-button", textContent: "Apri" });
    openButton.addEventListener("click", () => openGroupPanel(g.groupId, g.name));
    li.append(openButton);
    if (openGroup === g.groupId) li.classList.add("is-open");
    if (!groupSeenIds.has(g.groupId)) li.classList.add("enter");
    list.append(li);
  }
  groupSeenIds = nextSeen;
}

/**
 * Rebuilds the checkbox list inside #create-group-form from the currently known peers — only those
 * with `canMessage` (an encryption key already known), the same bar `createGroup()` itself (node.ts)
 * enforces before it will invite anyone. Rebuilt on every peers refresh (not cached from the moment
 * the panel was opened) so a peer that connects while the "Gruppi" section happens to be open
 * becomes selectable without needing to re-open the section.
 */
function renderGroupMemberPicker(peers) {
  const picker = document.getElementById("group-member-picker");
  const previouslyChecked = new Set(Array.from(picker.querySelectorAll("input:checked")).map((input) => input.value));
  picker.textContent = "";
  const eligible = peers.filter((p) => p.canMessage);
  if (eligible.length === 0) {
    picker.append(el("div", { className: "empty muted", textContent: "Nessun vicino raggiungibile ancora — connettiti a qualcuno prima di creare un gruppo." }));
    return;
  }
  for (const p of eligible) {
    const checkbox = el("input", { type: "checkbox" });
    checkbox.value = p.nodeId;
    checkbox.id = "group-member-" + p.nodeId;
    checkbox.checked = previouslyChecked.has(p.nodeId);
    const label = el("label", { className: "group-member-option" }, [checkbox, el("span", { textContent: p.shortLabel })]);
    label.htmlFor = checkbox.id;
    picker.append(label);
  }
}

function setCallSubmitBusy(submit, busy) {
  submit.disabled = busy;
  submit.textContent = "";
  if (busy) {
    submit.append(el("span", { className: "mini-spinner" }), el("span", { textContent: "Invio..." }));
  } else {
    submit.append(iconEl("send"), el("span", { textContent: "Invia" }));
  }
}

function buildCallForm(service) {
  const isAi = service.serviceId === "service://ai";
  const input = isAi
    ? el("textarea", { placeholder: "Scrivi una domanda..." })
    : el("textarea", { placeholder: "Payload JSON, es. {}", value: "{}" });
  const submit = el("button", { className: "call-submit" });
  setCallSubmitBusy(submit, false);
  const result = el("div", { className: "call-result", textContent: "" });
  result.hidden = true;
  result.setAttribute("role", "status");
  result.setAttribute("aria-live", "polite");

  submit.addEventListener("click", async () => {
    let payload;
    if (isAi) {
      payload = { prompt: input.value };
    } else {
      try {
        payload = JSON.parse(input.value || "{}");
      } catch {
        result.hidden = false;
        result.className = "call-result is-error";
        result.textContent = "Il payload deve essere JSON valido.";
        return;
      }
    }
    setCallSubmitBusy(submit, true);
    try {
      const value = await callService(service.serviceId, payload);
      result.hidden = false;
      result.className = "call-result";
      const rendered = isAi && value && typeof value.response === "string" ? value.response : JSON.stringify(value, null, 2);
      result.textContent = rendered;
      vibrate(10);
    } catch (err) {
      if (err.status === 401) {
        handlePasswordRejected();
        return;
      }
      result.hidden = false;
      result.className = "call-result is-error";
      result.textContent = err.message;
      vibrate([12, 40, 12]);
    } finally {
      setCallSubmitBusy(submit, false);
    }
  });

  return el("div", { className: "call-form" }, [input, submit, result]);
}

// Tracks which service currently has an open call form. The form itself lives in a single shared
// #service-call-panel below the card grid (not inside the card) — per explicit user feedback that
// the tiles must all stay the same size, a card can no longer grow to host its own form. This also
// means renderServices() no longer needs to preserve/reuse a DOM node across the periodic 5s
// refresh (the earlier "reuse the open <li>" dance): the panel is untouched by re-rendering the
// list, so a fresh rebuild every refresh is fine — only the matching card's .is-open highlight and
// the panel's own visibility need to survive.
let openCallServiceId = null;

function closeServiceCallForm() {
  openCallServiceId = null;
  const panel = document.getElementById("service-call-panel");
  panel.hidden = true;
  panel.textContent = "";
  document.querySelectorAll("#services .service-card.is-open").forEach((li) => li.classList.remove("is-open"));
}

/** Opens (or scrolls to, if already open) the shared call form for `svc`. */
function openServiceCallForm(svc) {
  if (openCallServiceId !== svc.serviceId) {
    openCallServiceId = svc.serviceId;
    const panel = document.getElementById("service-call-panel");
    panel.textContent = "";
    const closeButton = el("button", { className: "icon-button", type: "button" }, [iconEl("x")]);
    closeButton.setAttribute("aria-label", "Chiudi");
    closeButton.addEventListener("click", closeServiceCallForm);
    panel.append(
      el("div", { className: "call-panel-header" }, [
        el("div", { className: "call-panel-title" }, [iconEl(SERVICE_ICONS[svc.serviceId] || DEFAULT_SERVICE_ICON), el("span", { textContent: serviceLabel(svc.serviceId) })]),
        closeButton,
      ]),
      buildCallForm(svc),
    );
    panel.hidden = false;
    document.querySelectorAll("#services .service-card").forEach((li) => {
      li.classList.toggle("is-open", li.dataset.serviceId === svc.serviceId);
    });
  }
  document.getElementById("service-call-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- chat 1:1 (docs/next-steps.md Opzione J) ----------
//
// Same shared-panel pattern as #service-call-panel above (one conversation open at a time, panel
// lives outside any collapsible container so it survives "Vicini connessi" being re-collapsed) —
// deliberately does NOT auto-close when the peer disconnects, unlike closeServiceCallForm()'s own
// availability check: a private message is delay-tolerant (store-and-forward queues it until the
// peer reconnects, node.ts), so an offline conversation is still meaningful to read and write to,
// not a dead end the way an unavailable service call would be.

let openChatPeer = null;
let chatPollTimer = null;

function closeChatPanel() {
  openChatPeer = null;
  clearInterval(chatPollTimer);
  chatPollTimer = null;
  const panel = document.getElementById("chat-panel");
  panel.hidden = true;
  panel.textContent = "";
  document.querySelectorAll("#peers li.is-open").forEach((li) => li.classList.remove("is-open"));
}

function renderChatMessages(list, messages) {
  const wasScrolledToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  if (renderEmptyIfNeeded(list, messages, "Nessun messaggio ancora. Scrivine uno.")) return;
  for (const m of messages) {
    list.append(
      el("li", { className: "chat-message " + (m.direction === "sent" ? "is-sent" : "is-received") }, [
        el("div", { className: "chat-bubble", textContent: m.text }),
        el("div", { className: "chat-timestamp muted", textContent: timeAgo(m.timestamp) }),
      ]),
    );
  }
  // Only auto-scroll if the user was already at (or near) the bottom — otherwise the periodic poll
  // below would yank someone scrolling up to read older messages back down every few seconds.
  if (wasScrolledToBottom) list.scrollTop = list.scrollHeight;
}

async function refreshChatMessages(peer, list) {
  try {
    const messages = await fetchMessages(peer);
    if (openChatPeer !== peer) return; // panel closed/switched while this was in flight
    renderChatMessages(list, messages);
  } catch {
    // Best-effort background poll — the main dashboard error banner (refreshAll()) already surfaces
    // a persistently unreachable gateway; no need for this poll to also spam its own error each tick.
  }
}

/** Opens (or scrolls to, if already open) the shared chat panel for a 1:1 conversation with `peer`. */
function openChatPanel(peer, label) {
  if (openChatPeer === peer) {
    document.getElementById("chat-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  closeChatPanel();
  openChatPeer = peer;
  const panel = document.getElementById("chat-panel");
  panel.textContent = "";

  const closeButton = el("button", { className: "icon-button", type: "button" }, [iconEl("x")]);
  closeButton.setAttribute("aria-label", "Chiudi");
  closeButton.addEventListener("click", closeChatPanel);

  const list = el("ul", { className: "chat-messages" });
  list.setAttribute("aria-live", "polite");
  listSkeleton(list, 2);

  const input = el("input", { type: "text", placeholder: "Scrivi un messaggio..." });
  input.autocomplete = "off";
  const submit = el("button", { className: "call-submit", type: "submit" }, [iconEl("send"), el("span", { textContent: "Invia" })]);
  const form = el("form", { className: "chat-compose" }, [input, submit]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    submit.disabled = true;
    try {
      await sendChatMessage(peer, text);
      input.value = "";
      vibrate(10);
      await refreshChatMessages(peer, list);
    } catch (err) {
      if (err.status === 401) {
        handlePasswordRejected();
        return;
      }
      showToast(err.message, "alert-circle");
      vibrate([12, 40, 12]);
    } finally {
      input.disabled = false;
      submit.disabled = false;
      input.focus({ preventScroll: true });
    }
  });

  panel.append(
    el("div", { className: "call-panel-header" }, [
      el("div", { className: "call-panel-title" }, [iconEl("users"), el("span", { textContent: label })]),
      closeButton,
    ]),
    list,
    form,
  );
  panel.hidden = false;
  document.querySelectorAll("#peers li").forEach((li) => li.classList.toggle("is-open", li.dataset.peerId === peer));
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  refreshChatMessages(peer, list);
  // A dedicated, lighter-weight poll independent of refreshAll()'s 5s cycle — only runs while a
  // conversation is actually open, and /api/messages needs the Authorization header refreshAll()'s
  // other calls don't, so piggybacking on that cycle isn't a natural fit here.
  chatPollTimer = setInterval(() => refreshChatMessages(peer, list), 3000);
}

// ---------- public channels (docs/next-steps.md Opzione J) — shares the #chat-panel styling
// (.chat-messages/.chat-bubble/.chat-compose) but its own #channel-panel container, since a channel
// stays open independently of any 1:1 conversation that might also be open. ----------

let openChannel = null;
let channelPollTimer = null;

function closeChannelPanel() {
  openChannel = null;
  clearInterval(channelPollTimer);
  channelPollTimer = null;
  const panel = document.getElementById("channel-panel");
  panel.hidden = true;
  panel.textContent = "";
  document.querySelectorAll("#channels li.is-open").forEach((li) => li.classList.remove("is-open"));
}

function renderChannelMessages(list, messages) {
  const wasScrolledToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  if (renderEmptyIfNeeded(list, messages, "Nessun messaggio ancora. Scrivine uno.")) return;
  for (const m of messages) {
    const isMine = m.author === myNodeId;
    const bubbleChildren = [el("div", { className: "chat-bubble", textContent: m.text })];
    // A group channel needs the author visible (unlike 1:1 chat, where "sent"/"received" already
    // says who) — shown only for someone else's message, never this device's own.
    const children = isMine
      ? bubbleChildren
      : [el("div", { className: "chat-author muted", textContent: "NODE-" + m.author.slice(0, 8) }), ...bubbleChildren];
    children.push(el("div", { className: "chat-timestamp muted", textContent: timeAgo(m.timestamp) }));
    list.append(el("li", { className: "chat-message " + (isMine ? "is-sent" : "is-received") }, children));
  }
  if (wasScrolledToBottom) list.scrollTop = list.scrollHeight;
}

async function refreshChannelMessages(channel, list) {
  try {
    const messages = await fetchChannelMessages(channel);
    if (openChannel !== channel) return; // panel closed/switched while this was in flight
    renderChannelMessages(list, messages);
  } catch {
    // Best-effort background poll, same posture as refreshChatMessages() — the main dashboard error
    // banner already surfaces a persistently unreachable gateway.
  }
}

/** Opens (or scrolls to, if already open) the shared channel panel for `channel` — a channel need not already be known: opening one that's never been posted to just shows an empty thread ready for the first message, matching the content-centric "no channel-creation step" design (public-channels.ts). */
function openChannelPanel(channel) {
  if (openChannel === channel) {
    document.getElementById("channel-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  closeChannelPanel();
  openChannel = channel;
  const panel = document.getElementById("channel-panel");
  panel.textContent = "";

  const closeButton = el("button", { className: "icon-button", type: "button" }, [iconEl("x")]);
  closeButton.setAttribute("aria-label", "Chiudi");
  closeButton.addEventListener("click", closeChannelPanel);

  const list = el("ul", { className: "chat-messages" });
  list.setAttribute("aria-live", "polite");
  listSkeleton(list, 2);

  const input = el("input", { type: "text", placeholder: "Scrivi un messaggio..." });
  input.autocomplete = "off";
  const submit = el("button", { className: "call-submit", type: "submit" }, [iconEl("send"), el("span", { textContent: "Invia" })]);
  const form = el("form", { className: "chat-compose" }, [input, submit]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    submit.disabled = true;
    try {
      await sendChannelMessage(channel, text);
      input.value = "";
      vibrate(10);
      await refreshChannelMessages(channel, list);
    } catch (err) {
      if (err.status === 401) {
        handlePasswordRejected();
        return;
      }
      showToast(err.message, "alert-circle");
      vibrate([12, 40, 12]);
    } finally {
      input.disabled = false;
      submit.disabled = false;
      input.focus({ preventScroll: true });
    }
  });

  panel.append(
    el("div", { className: "call-panel-header" }, [
      el("div", { className: "call-panel-title" }, [iconEl("message-circle"), el("span", { textContent: "#" + channel })]),
      closeButton,
    ]),
    list,
    form,
  );
  panel.hidden = false;
  document.querySelectorAll("#channels li").forEach((li) => li.classList.toggle("is-open", li.dataset.channel === channel));
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  refreshChannelMessages(channel, list);
  channelPollTimer = setInterval(() => refreshChannelMessages(channel, list), 3000);
}

document.getElementById("join-channel-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("join-channel-input");
  const channel = input.value.trim().toLowerCase();
  if (!channel) return;
  document.getElementById("channels-panel").open = true;
  openChannelPanel(channel);
  input.value = "";
});

// ---------- encrypted groups (docs/next-steps.md Opzione J) — same shared-panel pattern as public
// channels above, plus author labels like a channel (a group has more than one other member, unlike
// 1:1 chat) but never a public/unauthenticated read path (a group's contents ARE "Private messages",
// spec §56, unlike a public channel's). ----------

let openGroup = null;
let groupPollTimer = null;

function closeGroupPanel() {
  openGroup = null;
  clearInterval(groupPollTimer);
  groupPollTimer = null;
  const panel = document.getElementById("group-panel");
  panel.hidden = true;
  panel.textContent = "";
  document.querySelectorAll("#groups li.is-open").forEach((li) => li.classList.remove("is-open"));
}

function renderGroupMessages(list, messages) {
  const wasScrolledToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  if (renderEmptyIfNeeded(list, messages, "Nessun messaggio ancora. Scrivine uno.")) return;
  for (const m of messages) {
    const isMine = m.senderId === myNodeId;
    const bubbleChildren = [el("div", { className: "chat-bubble", textContent: m.text })];
    const children = isMine
      ? bubbleChildren
      : [el("div", { className: "chat-author muted", textContent: "NODE-" + m.senderId.slice(0, 8) }), ...bubbleChildren];
    children.push(el("div", { className: "chat-timestamp muted", textContent: timeAgo(m.timestamp) }));
    list.append(el("li", { className: "chat-message " + (isMine ? "is-sent" : "is-received") }, children));
  }
  if (wasScrolledToBottom) list.scrollTop = list.scrollHeight;
}

async function refreshGroupMessages(groupId, list) {
  try {
    const messages = await fetchGroupMessages(groupId);
    if (openGroup !== groupId) return; // panel closed/switched while this was in flight
    renderGroupMessages(list, messages);
  } catch {
    // Best-effort background poll, same posture as refreshChatMessages()/refreshChannelMessages().
  }
}

/** Opens (or scrolls to, if already open) the shared group panel for `groupId`. */
function openGroupPanel(groupId, name) {
  if (openGroup === groupId) {
    document.getElementById("group-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  closeGroupPanel();
  openGroup = groupId;
  const panel = document.getElementById("group-panel");
  panel.textContent = "";

  const closeButton = el("button", { className: "icon-button", type: "button" }, [iconEl("x")]);
  closeButton.setAttribute("aria-label", "Chiudi");
  closeButton.addEventListener("click", closeGroupPanel);

  const list = el("ul", { className: "chat-messages" });
  list.setAttribute("aria-live", "polite");
  listSkeleton(list, 2);

  const input = el("input", { type: "text", placeholder: "Scrivi un messaggio..." });
  input.autocomplete = "off";
  const submit = el("button", { className: "call-submit", type: "submit" }, [iconEl("send"), el("span", { textContent: "Invia" })]);
  const form = el("form", { className: "chat-compose" }, [input, submit]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    submit.disabled = true;
    try {
      await sendGroupMessage(groupId, text);
      input.value = "";
      vibrate(10);
      await refreshGroupMessages(groupId, list);
    } catch (err) {
      if (err.status === 401) {
        handlePasswordRejected();
        return;
      }
      showToast(err.message, "alert-circle");
      vibrate([12, 40, 12]);
    } finally {
      input.disabled = false;
      submit.disabled = false;
      input.focus({ preventScroll: true });
    }
  });

  panel.append(
    el("div", { className: "call-panel-header" }, [
      el("div", { className: "call-panel-title" }, [iconEl("lock"), el("span", { textContent: name })]),
      closeButton,
    ]),
    list,
    form,
  );
  panel.hidden = false;
  document.querySelectorAll("#groups li").forEach((li) => li.classList.toggle("is-open", li.dataset.groupId === groupId));
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  refreshGroupMessages(groupId, list);
  groupPollTimer = setInterval(() => refreshGroupMessages(groupId, list), 3000);
}

function setCreateGroupBusy(submit, busy) {
  submit.disabled = busy;
  submit.textContent = busy ? "Creazione..." : "Crea gruppo cifrato";
}

document.getElementById("create-group-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const nameInput = document.getElementById("create-group-name");
  const name = nameInput.value.trim();
  if (!name) return;
  const members = Array.from(document.querySelectorAll("#group-member-picker input:checked")).map((input) => input.value);
  if (members.length === 0) {
    showToast("Seleziona almeno un vicino per il gruppo", "alert-circle");
    return;
  }
  const submit = event.target.querySelector("button[type=submit]");
  setCreateGroupBusy(submit, true);
  try {
    const group = await createGroup(name, members);
    nameInput.value = "";
    document.querySelectorAll("#group-member-picker input:checked").forEach((input) => (input.checked = false));
    vibrate(10);
    document.getElementById("groups-panel").open = true;
    openGroupPanel(group.groupId, group.name);
    // The sidebar list otherwise wouldn't show the new group until the next periodic 5s refreshAll()
    // tick — an unnecessary wait given the server already told us it exists (the createGroup()
    // response above). Not awaited: nothing here depends on it finishing, same "fire and let the
    // dashboard catch up" posture as the join-channel-form flow relies on refreshAll()'s own poll for.
    refreshAll().catch(() => {});
  } catch (err) {
    if (err.status === 401) {
      handlePasswordRejected();
      return;
    }
    showToast(err.message, "alert-circle");
    vibrate([12, 40, 12]);
  } finally {
    setCreateGroupBusy(submit, false);
  }
});

// Known serviceIds get a recognizable icon and a human-readable name; anything else (a service this
// app has never heard of, e.g. one an operator registered locally) still gets a card, just with a
// generic icon and a name derived from the raw id — "some card" beats "silently missing" for an
// unrecognized-but-available service.
const SERVICE_ICONS = { "service://ai": "sparkles", "service://kiwix-search": "book", "service://news": "newspaper" };
const DEFAULT_SERVICE_ICON = "wrench";
const SERVICE_LABELS = { "service://ai": "Assistente AI", "service://kiwix-search": "Enciclopedia", "service://news": "Notizie" };

function serviceLabel(serviceId) {
  if (SERVICE_LABELS[serviceId]) return SERVICE_LABELS[serviceId];
  const name = serviceId.replace(/^service:\/\//, "").replace(/-/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

let serviceSeenIds = new Set();

/**
 * Servizi are the first thing a user sees below the search bar (moved there, and the old
 * home-hero "quick links" row removed, per explicit user feedback: the small quick-link buttons
 * were unclear and duplicated this same panel — one prominent, actionable list of "what you can do"
 * beats a second, cramped shortcut row above it) — so each entry renders as a full card (icon, a
 * human-readable name, the raw serviceId as a de-emphasized subtitle, capability tags, and a
 * full-width primary "Chiama" button) instead of a compact data row. Every card is the same fixed
 * size (CSS grid + a shared min-height) regardless of content — tapping "Chiama" opens the actual
 * form in the shared #service-call-panel below the grid, never inside the card itself.
 */
function renderServices(services) {
  const list = document.getElementById("services");
  list.removeAttribute("aria-busy");
  document.getElementById("services-count").textContent = services.length > 0 ? String(services.length) : "";
  // Close the shared call panel not just when the open service disappears entirely, but also when it
  // merely becomes unavailable (e.g. its provider disconnected) — otherwise the card would show both
  // the .is-open highlight and the "non disponibile" pill at once, with a live form still open below
  // for a service the server will now reject the call for (node/src/web-ui.ts's availability check).
  if (openCallServiceId && !services.some((svc) => svc.serviceId === openCallServiceId && svc.availability)) closeServiceCallForm();

  if (renderEmptyIfNeeded(list, services, "Nessun servizio conosciuto.", "plug")) {
    serviceSeenIds = new Set();
    return;
  }
  const nextSeen = new Set();
  for (const svc of services) {
    nextSeen.add(svc.serviceId);
    const li = el("li", { className: "service-card" }, [
      el("div", { className: "service-card-icon" }, [iconEl(SERVICE_ICONS[svc.serviceId] || DEFAULT_SERVICE_ICON)]),
      el("div", { className: "service-card-name", textContent: serviceLabel(svc.serviceId), title: serviceLabel(svc.serviceId) }),
      el("div", { className: "service-card-id mono muted", textContent: svc.serviceId, title: svc.serviceId }),
      el("div", { className: "tags" }, (Array.isArray(svc.capabilities) ? svc.capabilities : []).map((c) => el("span", { className: "tag", textContent: String(c) }))),
    ]);
    li.dataset.serviceId = svc.serviceId;
    if (svc.serviceId === openCallServiceId) li.classList.add("is-open");
    if (svc.availability && networkPassword) {
      const callButton = el("button", { className: "call-button", textContent: "Chiama" });
      callButton.addEventListener("click", () => openServiceCallForm(svc));
      li.append(callButton);
    } else {
      li.append(el("span", { className: "pill off" }, [iconEl("circle"), el("span", { textContent: "non disponibile" })]));
    }
    if (!serviceSeenIds.has(svc.serviceId)) li.classList.add("enter");
    list.append(li);
  }
  serviceSeenIds = nextSeen;
}

let contentSeenIds = new Set();

function renderContent(entries, emptyMessage) {
  const list = document.getElementById("content");
  list.removeAttribute("aria-busy");
  document.getElementById("content-count").textContent = entries.length > 0 ? String(entries.length) : "";
  if (renderEmptyIfNeeded(list, entries, emptyMessage, "inbox")) {
    contentSeenIds = new Set();
    return;
  }
  const nextSeen = new Set();
  for (const c of entries) {
    nextSeen.add(c.contentId);
    const pill = el("span", { className: "pill " + (c.availableLocally ? "good" : "warn") }, [
      iconEl(c.availableLocally ? "check-circle" : "cloud"),
      el("span", { textContent: c.availableLocally ? "in cache" : "remoto" }),
    ]);
    const li = el("li", null, [
      el("div", { className: "row" }, [el("span", { className: "row-title", textContent: c.name, title: c.name }), pill]),
      el("div", { className: "muted", textContent: c.mimeType + " · " + formatBytes(c.size) }),
    ]);
    if (!contentSeenIds.has(c.contentId)) li.classList.add("enter");
    list.append(li);
  }
  contentSeenIds = nextSeen;
}

let contentRequestId = 0;
// Tracks the last query refreshContent() actually rendered for — a *changed* query is a new context
// (don't diff-animate its results against a previous, unrelated query's ids), but the periodic 5s
// refresh calls refreshContent() with the same (possibly empty) query every time, and that case must
// keep diffing normally or every row would replay its entrance animation on every tick.
let lastContentQuery = null;
async function refreshContent() {
  const requestId = ++contentRequestId;
  const q = document.getElementById("search-input").value.trim();
  const path = q.length === 0 ? "/api/content" : "/api/search?q=" + encodeURIComponent(q);
  const emptyMessage = q.length === 0 ? "Nessun contenuto conosciuto ancora." : 'Nessun risultato per "' + q + '".';
  document.getElementById("search-spinner").hidden = false;
  try {
    const entries = await fetchJson(path);
    if (requestId !== contentRequestId) return; // superseded by a newer request while this one was in flight
    const isNewQuery = q !== lastContentQuery;
    if (isNewQuery) contentSeenIds = new Set();
    lastContentQuery = q;
    renderContent(entries, emptyMessage);
    // "Contenuti" is collapsed by default (a more technical section — see #content-panel) but a
    // search is an explicit request to see results, so *starting* a non-empty search reveals them
    // rather than leaving them collapsed behind a toggle the user has no reason yet to know about.
    // Gated on isNewQuery (not just "query is non-empty"): the periodic 5s refresh calls this again
    // with the same unchanged query, and re-forcing `open = true` every cycle would silently snap
    // the section back open if the user had manually collapsed it again while still searching.
    if (isNewQuery && q.length > 0) document.getElementById("content-panel").open = true;
  } finally {
    if (requestId === contentRequestId) document.getElementById("search-spinner").hidden = true;
  }
}

let searchDebounce;
document.getElementById("search-input").addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => refreshContent().catch(() => {}), 250);
});
document.getElementById("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  clearTimeout(searchDebounce);
  refreshContent().catch(() => {});
});

// The periodic 5s refresh can overlap with itself on a slow/flaky connection (one tick's fetch
// still in flight when the next tick starts) — this guards against the same "stale response
// applied after a newer one" problem contentRequestId solves for search, just for the rest of the
// dashboard: only the response belonging to the *latest* refreshAll() call is ever rendered.
let refreshCycleId = 0;

async function refreshAll() {
  const cycleId = ++refreshCycleId;
  try {
    const [status, peers, services, channels, groups] = await Promise.all([
      fetchJson("/api/status"),
      fetchJson("/api/peers"),
      fetchJson("/api/services"),
      fetchJson("/api/channels"),
      fetchGroups(),
    ]);
    if (cycleId !== refreshCycleId) return; // superseded by a newer refresh while this one was in flight
    renderStats(status);
    renderPeers(peers);
    renderServices(services);
    renderChannels(channels);
    renderGroups(groups);
    await refreshContent();
    firstLoadDone = true;
    setDashboardError();
  } catch (err) {
    if (cycleId !== refreshCycleId) return;
    setDashboardError("Gateway non raggiungibile: " + err.message);
  }
}

// ---------- boot ----------

if (gatewayUrl && networkPassword) {
  showDashboard();
} else {
  showSetupScreen();
}
