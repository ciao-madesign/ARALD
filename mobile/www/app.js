// Nomad-Net mobile client (Fase 1, Wi-Fi/TCP — docs/next-steps.md Opzione H). Plain JS, no
// framework, same discipline as node/src/web-ui.ts's own page: every value from the network goes
// through textContent (never innerHTML), because a peer's declared content name, service id, or
// capability list is untrusted input this app renders, exactly like the desktop status page does.

const STORAGE_KEY_URL = "nomadnet.gatewayUrl";
const STORAGE_KEY_TOKEN = "nomadnet.pairingToken";

const TRUST_LABELS = {
  UNKNOWN: "Sconosciuto",
  SEEN: "Visto",
  VERIFIED: "Verificato",
  TRUSTED: "Fidato",
  ADMIN: "Admin",
};

let gatewayUrl = localStorage.getItem(STORAGE_KEY_URL) || "";
let pairingToken = localStorage.getItem(STORAGE_KEY_TOKEN) || "";
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

/** POST /api/call (node/src/web-ui.ts) — the one write endpoint, gated by the pairing token entered during setup. Rejects with `err.status` set when the gateway answered (as opposed to a network/timeout failure), so callers can react to e.g. a wrong pairing token (401) specifically. */
async function callService(serviceId, payload) {
  const res = await fetchWithTimeout(
    apiUrl("/api/call"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + pairingToken },
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

function showSetupScreen(errorMessage) {
  document.getElementById("setup-screen").hidden = false;
  document.getElementById("dashboard-screen").hidden = true;
  clearInterval(refreshTimer);
  const errorEl = document.getElementById("setup-error");
  if (errorMessage) {
    errorEl.textContent = errorMessage;
    errorEl.hidden = false;
  } else {
    errorEl.hidden = true;
  }
}

document.getElementById("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const candidateUrl = normalizeGatewayUrl(document.getElementById("gateway-input").value);
  const candidateToken = document.getElementById("token-input").value.trim();

  const previousUrl = gatewayUrl;
  gatewayUrl = candidateUrl;
  try {
    await fetchJson("/api/status");
  } catch (err) {
    gatewayUrl = previousUrl;
    showSetupScreen("Impossibile raggiungere il gateway a " + candidateUrl + ": " + err.message);
    return;
  }

  pairingToken = candidateToken;
  localStorage.setItem(STORAGE_KEY_URL, gatewayUrl);
  localStorage.setItem(STORAGE_KEY_TOKEN, pairingToken);
  showDashboard();
});

document.getElementById("change-gateway").addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY_URL);
  localStorage.removeItem(STORAGE_KEY_TOKEN);
  gatewayUrl = "";
  pairingToken = "";
  showSetupScreen();
});

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
  document.getElementById("node-label").textContent = s.displayName + " (" + gatewayUrl.replace(/^https?:\/\//, "") + ")";
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
      result.hidden = false;
      result.className = "call-result is-error";
      result.textContent =
        err.status === 401 ? 'Token di pairing non corretto. Tocca "Cambia gateway" e reinseriscilo.' : err.message;
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
    if (svc.availability && pairingToken) {
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

if (gatewayUrl && pairingToken) {
  document.getElementById("gateway-input").value = gatewayUrl.replace(/^https?:\/\//, "");
  document.getElementById("token-input").value = pairingToken;
  showDashboard();
} else {
  showSetupScreen();
}
