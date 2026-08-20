// Nomad-Net mobile client (Fase 1, Wi-Fi/TCP — docs/next-steps.md Opzione H). Plain JS, no
// framework, same discipline as node/src/web-ui.ts's own page: every value from the network goes
// through textContent (never innerHTML), because a peer's declared content name, service id, or
// capability list is untrusted input this app renders, exactly like the desktop status page does.

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
    }
  }
  if (children) for (const c of children) e.append(c);
  return e;
}

function renderEmptyIfNeeded(list, items, message) {
  list.textContent = "";
  if (items.length === 0) {
    list.append(el("li", null, [el("div", { className: "empty", textContent: message })]));
    return true;
  }
  return false;
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
  document.getElementById("toggle-password").textContent = "Mostra";

  const errorEl = document.getElementById("setup-error");
  if (errorMessage) {
    errorEl.textContent = errorMessage;
    errorEl.hidden = false;
  } else {
    errorEl.hidden = true;
  }
}

document.getElementById("toggle-password").addEventListener("click", () => {
  const input = document.getElementById("password-input");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  document.getElementById("toggle-password").textContent = showing ? "Mostra" : "Nascondi";
});

document.getElementById("change-address").addEventListener("click", () => {
  document.getElementById("address-field").hidden = false;
  document.getElementById("gateway-input").required = true;
  document.getElementById("change-address").hidden = true;
});

document.getElementById("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const addressVisible = !document.getElementById("address-field").hidden;
  const candidateUrl = addressVisible ? normalizeGatewayUrl(document.getElementById("gateway-input").value) : gatewayUrl;
  const candidatePassword = document.getElementById("password-input").value.trim();

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

function showDashboard() {
  document.getElementById("setup-screen").hidden = true;
  document.getElementById("dashboard-screen").hidden = false;
  refreshAll();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, 5000);
}

function setDashboardError(message) {
  const el = document.getElementById("dashboard-error");
  if (message) {
    el.textContent = message;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function renderStats(s) {
  const stats = document.getElementById("stats");
  stats.textContent = "";
  const entries = [
    ["Vicini", String(s.peers)],
    ["Servizi attivi", String(s.services)],
    ["Cache", s.cachedContentPercent + "%"],
    ["Relay", s.relaying ? "attivo" : "fermo"],
  ];
  for (const [label, value] of entries) {
    stats.append(el("div", { className: "stat" }, [el("div", { className: "v", textContent: value }), el("div", { className: "l", textContent: label })]));
  }
  document.getElementById("node-label").textContent = "Connesso a: " + (s.networkName || s.displayName);
}

function renderPeers(peers) {
  const list = document.getElementById("peers");
  if (renderEmptyIfNeeded(list, peers, "Nessun vicino connesso al momento.")) return;
  for (const p of peers) {
    list.append(
      el("li", null, [
        el("div", { className: "row" }, [
          el("span", { className: "row-title mono", textContent: p.shortLabel }),
          el("span", { className: "muted", textContent: timeAgo(p.connectedAt) }),
        ]),
        el("div", { className: "tags" }, [el("span", { className: "tag", textContent: TRUST_LABELS[p.trustLevel] || p.trustLevel })]),
      ]),
    );
  }
}

function buildCallForm(service) {
  const isAi = service.serviceId === "service://ai";
  const input = isAi
    ? el("textarea", { placeholder: "Scrivi una domanda..." })
    : el("textarea", { placeholder: "Payload JSON, es. {}", value: "{}" });
  const submit = el("button", { className: "call-submit", textContent: "Invia" });
  const result = el("div", { className: "call-result", textContent: "" });
  result.hidden = true;

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
    submit.disabled = true;
    submit.textContent = "...";
    try {
      const value = await callService(service.serviceId, payload);
      result.hidden = false;
      result.className = "call-result";
      const rendered = isAi && value && typeof value.response === "string" ? value.response : JSON.stringify(value, null, 2);
      result.textContent = rendered;
    } catch (err) {
      if (err.status === 401) {
        handlePasswordRejected();
        return;
      }
      result.hidden = false;
      result.className = "call-result is-error";
      result.textContent = err.message;
    } finally {
      submit.disabled = false;
      submit.textContent = "Invia";
    }
  });

  return el("div", { className: "call-form" }, [input, submit, result]);
}

// Tracks which service currently has an open call form, so the periodic 5s refresh (refreshAll())
// can preserve it instead of wiping out an in-progress prompt or an in-flight/just-arrived result —
// renderServices() reuses the exact same <li> DOM node for that one service rather than rebuilding
// it, and rebuilds every other row normally.
let openCallServiceId = null;

function renderServices(services) {
  const list = document.getElementById("services");
  const previousOpenLi = openCallServiceId ? list.querySelector('li[data-service-id="' + CSS.escape(openCallServiceId) + '"]') : null;
  if (!services.some((svc) => svc.serviceId === openCallServiceId)) openCallServiceId = null; // the open service is gone from this refresh

  if (renderEmptyIfNeeded(list, services, "Nessun servizio conosciuto.")) {
    openCallServiceId = null;
    return;
  }
  for (const svc of services) {
    if (svc.serviceId === openCallServiceId && previousOpenLi) {
      list.append(previousOpenLi); // same node, same open form and its state — not rebuilt
      continue;
    }
    const pill = el("span", { className: "pill " + (svc.availability ? "good" : "off"), textContent: svc.availability ? "disponibile" : "non disponibile" });
    const li = el("li", null, [
      el("div", { className: "row" }, [el("span", { className: "row-title mono", textContent: svc.serviceId }), pill]),
      el("div", { className: "tags" }, (Array.isArray(svc.capabilities) ? svc.capabilities : []).map((c) => el("span", { className: "tag", textContent: String(c) }))),
    ]);
    li.dataset.serviceId = svc.serviceId;
    if (svc.availability && networkPassword) {
      const callButton = el("button", { className: "call-button", textContent: "Chiama" });
      callButton.addEventListener("click", () => {
        if (openCallServiceId === svc.serviceId) return;
        openCallServiceId = svc.serviceId;
        li.append(buildCallForm(svc));
        callButton.hidden = true;
      });
      li.append(callButton);
    }
    list.append(li);
  }
}

function renderContent(entries, emptyMessage) {
  const list = document.getElementById("content");
  if (renderEmptyIfNeeded(list, entries, emptyMessage)) return;
  for (const c of entries) {
    const pill = el("span", { className: "pill " + (c.availableLocally ? "good" : "warn"), textContent: c.availableLocally ? "in cache" : "remoto" });
    list.append(
      el("li", null, [
        el("div", { className: "row" }, [el("span", { className: "row-title", textContent: c.name }), pill]),
        el("div", { className: "muted", textContent: c.mimeType + " · " + formatBytes(c.size) }),
      ]),
    );
  }
}

let contentRequestId = 0;
async function refreshContent() {
  const requestId = ++contentRequestId;
  const q = document.getElementById("search-input").value.trim();
  const path = q.length === 0 ? "/api/content" : "/api/search?q=" + encodeURIComponent(q);
  const emptyMessage = q.length === 0 ? "Nessun contenuto conosciuto ancora." : 'Nessun risultato per "' + q + '".';
  const entries = await fetchJson(path);
  if (requestId !== contentRequestId) return; // superseded by a newer request while this one was in flight
  renderContent(entries, emptyMessage);
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
    await refreshContent();
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
