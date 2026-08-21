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

function renderStatSkeletons() {
  const stats = document.getElementById("stats");
  stats.textContent = "";
  stats.setAttribute("aria-busy", "true");
  for (let i = 0; i < 4; i++) {
    stats.append(el("div", { className: "stat skel-stat" }, [el("div", { className: "v", textContent: "0" }), el("div", { className: "l", textContent: "..." })]));
  }
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
}

function showDashboard() {
  document.getElementById("setup-screen").hidden = true;
  document.getElementById("dashboard-screen").hidden = false;
  firstLoadDone = false;
  peerSeenIds = new Set();
  serviceSeenIds = new Set();
  contentSeenIds = new Set();
  lastContentQuery = null;
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
  const stats = document.getElementById("stats");
  stats.textContent = "";
  stats.removeAttribute("aria-busy");
  const entries = [
    ["Vicini", String(s.peers)],
    ["Servizi attivi", String(s.services)],
    ["Cache", s.cachedContentPercent + "%"],
    ["Relay", s.relaying ? "attivo" : "fermo"],
  ];
  for (const [label, value] of entries) {
    const isRelay = label === "Relay";
    stats.append(
      el("div", { className: "stat" + (isRelay && s.relaying ? " stat-relay-on" : "") }, [
        el("div", { className: "v", textContent: value }),
        el("div", { className: "l", textContent: label }),
      ]),
    );
  }
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
    if (!peerSeenIds.has(p.nodeId)) li.classList.add("enter");
    list.append(li);
  }
  peerSeenIds = nextSeen;
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

// Tracks which service currently has an open call form, so the periodic 5s refresh (refreshAll())
// can preserve it instead of wiping out an in-progress prompt or an in-flight/just-arrived result —
// renderServices() reuses the exact same <li> DOM node for that one service rather than rebuilding
// it, and rebuilds every other row normally.
let openCallServiceId = null;

/** Opens (or no-ops if already open) the call form for `svc` inside its already-rendered `<li>` — shared by the "Chiama" button (renderServices()) and the home hero's quick-links, so tapping either does exactly the same thing. */
function openServiceCallForm(svc, li, callButton) {
  if (openCallServiceId === svc.serviceId) return;
  openCallServiceId = svc.serviceId;
  li.append(buildCallForm(svc));
  if (callButton) callButton.hidden = true;
}

let serviceSeenIds = new Set();

function renderServices(services) {
  const list = document.getElementById("services");
  list.removeAttribute("aria-busy");
  document.getElementById("services-count").textContent = services.length > 0 ? String(services.length) : "";
  const previousOpenLi = openCallServiceId ? list.querySelector('li[data-service-id="' + CSS.escape(openCallServiceId) + '"]') : null;
  if (!services.some((svc) => svc.serviceId === openCallServiceId)) openCallServiceId = null; // the open service is gone from this refresh

  if (renderEmptyIfNeeded(list, services, "Nessun servizio conosciuto.", "plug")) {
    openCallServiceId = null;
    serviceSeenIds = new Set();
    return;
  }
  const nextSeen = new Set();
  for (const svc of services) {
    nextSeen.add(svc.serviceId);
    if (svc.serviceId === openCallServiceId && previousOpenLi) {
      list.append(previousOpenLi); // same node, same open form and its state — not rebuilt
      continue;
    }
    const pill = el("span", { className: "pill " + (svc.availability ? "good" : "off") }, [
      iconEl(svc.availability ? "check-circle" : "circle"),
      el("span", { textContent: svc.availability ? "disponibile" : "non disponibile" }),
    ]);
    const li = el("li", null, [
      el("div", { className: "row" }, [el("span", { className: "row-title mono", textContent: svc.serviceId, title: svc.serviceId }), pill]),
      el("div", { className: "tags" }, (Array.isArray(svc.capabilities) ? svc.capabilities : []).map((c) => el("span", { className: "tag", textContent: String(c) }))),
    ]);
    li.dataset.serviceId = svc.serviceId;
    if (svc.availability && networkPassword) {
      const callButton = el("button", { className: "call-button", textContent: "Chiama" });
      callButton.addEventListener("click", () => openServiceCallForm(svc, li, callButton));
      li.append(callButton);
    }
    if (!serviceSeenIds.has(svc.serviceId)) li.classList.add("enter");
    list.append(li);
  }
  serviceSeenIds = nextSeen;
}

// Known serviceIds get a recognizable icon; anything else (a service this app has never heard of,
// e.g. one an operator registered locally) still gets a quick link, just with a generic icon rather
// than being hidden — "some quick link" beats "silently missing" for an unrecognized-but-available
// service.
const SERVICE_ICONS = { "service://ai": "sparkles", "service://kiwix-search": "book", "service://news": "newspaper" };
const DEFAULT_SERVICE_ICON = "wrench";
const MAX_QUICK_LINKS = 8;

function shortServiceLabel(serviceId) {
  const name = serviceId.replace(/^service:\/\//, "");
  return name.length > 11 ? name.slice(0, 10) + "…" : name;
}

/** Home-hero quick links (spec-inspired "motore di ricerca" UX, per the user's request) — one per currently-available service, tapping opens the exact same call form the "Chiama" button in the Servizi panel would, just reachable in one tap from the top of the screen instead of scrolling to find it. */
function renderQuickLinks(services) {
  const container = document.getElementById("quick-links");
  container.textContent = "";
  const available = services.filter((svc) => svc.availability).slice(0, MAX_QUICK_LINKS);
  for (const svc of available) {
    const link = el("button", { className: "quick-link", type: "button" }, [
      el("span", { className: "quick-link-icon" }, [iconEl(SERVICE_ICONS[svc.serviceId] || DEFAULT_SERVICE_ICON)]),
      el("span", { textContent: shortServiceLabel(svc.serviceId) }),
    ]);
    link.setAttribute("aria-label", "Chiama " + svc.serviceId);
    link.addEventListener("click", () => {
      vibrate(8);
      const li = document.getElementById("services").querySelector('li[data-service-id="' + CSS.escape(svc.serviceId) + '"]');
      if (!li) return; // services list hasn't rendered this one yet — nothing to open or scroll to
      openServiceCallForm(svc, li, li.querySelector(".call-button"));
      li.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    container.append(link);
  }
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
    if (q !== lastContentQuery) contentSeenIds = new Set();
    lastContentQuery = q;
    renderContent(entries, emptyMessage);
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
    const [status, peers, services] = await Promise.all([fetchJson("/api/status"), fetchJson("/api/peers"), fetchJson("/api/services")]);
    if (cycleId !== refreshCycleId) return; // superseded by a newer refresh while this one was in flight
    renderStats(status);
    renderPeers(peers);
    renderServices(services);
    renderQuickLinks(services); // after renderServices() — relies on its <li data-service-id> nodes already existing
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
