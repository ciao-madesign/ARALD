// NOMAD Hub Control UI — talks to nomad-hub/'s Management API (Docker/host administration for
// whatever machine runs Project NOMAD), never to node/src/web-ui.ts's mesh-facing WebUiServer that
// index.html/app.js use. Deliberately its own small file: no shared state, no shared localStorage
// keys, no imports from app.js — see hub-control.html's own top comment for the full boundary
// reasoning (docs/deployment.md, "Il NOMAD Hub come sistema portatile").

const STORAGE_KEY_URL = "nomadhub.apiUrl";
const STORAGE_KEY_PASSWORD = "nomadhub.managementPassword";
const READ_TIMEOUT_MS = 8000;
const ACTION_TIMEOUT_MS = 15000;
const STATUS_POLL_MS = 4000;

let apiUrl = null;
let managementPassword = null;
let pollTimer = null;
let logsOpenFor = null; // container id currently showing its log panel, or null

function el(tag, props, children) {
  const e = document.createElement(tag);
  if (props) {
    for (const k in props) {
      if (k === "className") e.className = props[k];
      else if (k === "textContent") e.textContent = props[k];
      else if (k === "type") e.type = props[k];
      else if (k === "disabled") e.disabled = props[k];
      else if (k === "title") e.title = props[k];
    }
  }
  if (children) for (const c of children) e.append(c);
  return e;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function iconEl(name, extraClass) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", extraClass ? "icon " + extraClass : "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", "#hub-icon-" + name);
  svg.append(use);
  return svg;
}

function normalizeApiUrl(raw) {
  const trimmed = (raw || "").trim();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed.replace(/\/$/, "") : "http://" + trimmed.replace(/\/$/, "");
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

/** Every call to the Management API — always Bearer-authenticated (unlike app.js's fetchJson(), nothing here is ever unauthenticated: see management-server.ts's class doc comment on why). */
async function hubFetch(path, options, timeoutMs) {
  const res = await fetchWithTimeout(
    apiUrl + path,
    Object.assign({}, options, { headers: Object.assign({ Authorization: "Bearer " + managementPassword }, (options && options.headers) || {}) }),
    timeoutMs || READ_TIMEOUT_MS,
  );
  let body = null;
  try {
    body = await res.json();
  } catch {
    // a 204/empty body (e.g. an action response) has nothing to parse — not an error by itself
  }
  if (res.status === 401) {
    const err = new Error("password di gestione non valida");
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || "HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  return body;
}

function showToast(message, iconName) {
  const toast = document.getElementById("hub-toast");
  toast.textContent = "";
  if (iconName) toast.append(iconEl(iconName));
  toast.append(el("span", { textContent: message }));
  toast.hidden = false;
  clearTimeout(showToast._hideTimer);
  clearTimeout(showToast._leaveTimer);
  toast.classList.remove("is-leaving");
  showToast._hideTimer = setTimeout(() => {
    toast.classList.add("is-leaving");
    showToast._leaveTimer = setTimeout(() => {
      toast.hidden = true;
    }, 220);
  }, 2600);
}

function setSetupError(message) {
  const el = document.getElementById("hub-setup-error");
  if (message) {
    el.textContent = message;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function setStatusError(message) {
  const el = document.getElementById("hub-status-error");
  if (message) {
    el.textContent = message;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function showDashboard() {
  document.getElementById("hub-setup-screen").hidden = true;
  document.getElementById("hub-dashboard-screen").hidden = false;
  refreshStatus();
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshStatus, STATUS_POLL_MS);
}

function showSetup() {
  clearInterval(pollTimer);
  pollTimer = null;
  document.getElementById("hub-dashboard-screen").hidden = true;
  document.getElementById("hub-setup-screen").hidden = false;
}

const STATE_LABELS = { running: "In esecuzione", exited: "Fermo", created: "Creato" };
const HEALTH_LABELS = { none: null, healthy: "integro", unhealthy: "non integro", starting: "in avvio" };

function pillForState(state) {
  const kind = state === "running" ? "good" : state === "exited" ? "off" : "warn";
  const pill = el("span", { className: "pill " + kind, textContent: STATE_LABELS[state] || state });
  return pill;
}

function renderContainerRow(container) {
  const li = el("li", { className: "enter" });
  const header = el("div", { className: "hub-row-header" });
  header.append(el("span", { className: "row-title", textContent: container.name }), pillForState(container.state));
  li.append(header);
  li.append(el("p", { className: "hint", textContent: container.image }));

  const healthLabel = HEALTH_LABELS[container.health];
  if (healthLabel) li.append(el("span", { className: "tag", textContent: healthLabel }));

  const actions = el("div", { className: "hub-row-actions" });
  const startBtn = el("button", { type: "button", textContent: "Avvia", disabled: container.state === "running" });
  const stopBtn = el("button", { type: "button", textContent: "Ferma", disabled: container.state !== "running" });
  const restartBtn = el("button", { type: "button", textContent: "Riavvia" });
  const logsBtn = el("button", { type: "button", className: "link-button", textContent: logsOpenFor === container.id ? "Nascondi log" : "Vedi log" });

  startBtn.addEventListener("click", () => runAction(container, "start"));
  stopBtn.addEventListener("click", () => {
    // Native confirm() — this app has no destructive-action pattern of its own yet to reuse (every
    // other action anywhere in mobile/www/ is additive: a message, a drop, a group), and a full custom
    // confirmation dialog is out of scope for this first version of the Control UI.
    if (window.confirm('Fermare "' + container.name + '"?')) runAction(container, "stop");
  });
  restartBtn.addEventListener("click", () => {
    if (window.confirm('Riavviare "' + container.name + '"?')) runAction(container, "restart");
  });
  logsBtn.addEventListener("click", () => {
    // renderContainers() itself triggers loadLogs() for whichever container logsOpenFor now names
    // (see its own doc comment) — no need to call loadLogs() again here.
    logsOpenFor = logsOpenFor === container.id ? null : container.id;
    renderContainers(lastContainers);
  });

  actions.append(startBtn, stopBtn, restartBtn, logsBtn);
  li.append(actions);

  if (logsOpenFor === container.id) {
    li.append(el("pre", { className: "hub-log-view mono", textContent: "Caricamento…" }));
  }

  return li;
}

let lastContainers = [];

function renderContainers(containers) {
  lastContainers = containers;
  const list = document.getElementById("hub-container-list");
  list.textContent = "";
  if (containers.length === 0) {
    list.append(el("li", null, [el("div", { className: "empty", textContent: "Nessun container visibile (controlla eventuali filtri sul prefisso nome)." })]));
    return;
  }
  for (const container of containers) list.append(renderContainerRow(container));

  // renderContainerRow() always rebuilds an open log panel starting from the "Caricamento…"
  // placeholder (it has no memory of previously-fetched log text) — every caller of
  // renderContainers() (the periodic poll, and the refreshStatus() that follows every
  // start/stop/restart action) would otherwise leave the panel stuck on that placeholder forever
  // instead of showing current logs. Re-fetching here, in the one place every render path already
  // goes through, keeps an open panel live without each caller needing to remember to do it.
  if (logsOpenFor !== null) {
    const openContainer = containers.find((c) => c.id === logsOpenFor);
    if (openContainer) loadLogs(openContainer);
  }
}

async function refreshStatus() {
  try {
    const body = await hubFetch("/api/hub/status");
    setStatusError(null);
    renderContainers(body.containers || []);
  } catch (err) {
    if (err.status === 401) {
      showSetup();
      setSetupError("Password di gestione non valida.");
      return;
    }
    setStatusError(err.message);
  }
}

async function runAction(container, verb) {
  try {
    await hubFetch("/api/hub/containers/" + encodeURIComponent(container.id) + "/" + verb, { method: "POST" }, ACTION_TIMEOUT_MS);
    showToast(container.name + ": " + verb + " eseguito");
    await refreshStatus();
  } catch (err) {
    showToast(container.name + ": " + err.message, "alert");
  }
}

// renderContainers() re-fires loadLogs() for the open panel on every render (the 4s poll, or right
// after a start/stop/restart action) so an open panel stays live — but that means two loadLogs()
// calls for the same still-open container can be in flight at once if the Management API is briefly
// slow (found by review: the first fetch resolving *after* a second, newer one would overwrite fresh
// text with a stale response, since `logsOpenFor !== container.id` alone only tells the panel is
// still open, not which of the two responses is more recent). A simple monotonically increasing
// token, checked after the fetch resolves, discards any response that isn't from the most recently
// started request — the same "only the latest wins" pattern as an AbortController, without needing
// one here since hubFetch() itself has no cancellation hook.
let logsFetchToken = 0;

async function loadLogs(container) {
  const token = ++logsFetchToken;
  try {
    const body = await hubFetch("/api/hub/containers/" + encodeURIComponent(container.id) + "/logs?tail=200");
    if (logsOpenFor !== container.id || token !== logsFetchToken) return; // panel closed/switched, or a newer request already answered
    const pre = document.querySelector('#hub-container-list pre.hub-log-view');
    if (pre) pre.textContent = body.logs && body.logs.length > 0 ? body.logs : "(nessuna riga di log)";
  } catch (err) {
    if (logsOpenFor !== container.id || token !== logsFetchToken) return;
    const pre = document.querySelector('#hub-container-list pre.hub-log-view');
    if (pre) pre.textContent = "Errore nel caricare i log: " + err.message;
  }
}

async function validateAndConnect(rawUrl, password) {
  const normalized = normalizeApiUrl(rawUrl);
  if (!normalized) throw new Error("indirizzo non valido");
  const previousApiUrl = apiUrl;
  const previousPassword = managementPassword;
  apiUrl = normalized;
  managementPassword = password;
  try {
    await hubFetch("/api/hub/status");
  } catch (err) {
    apiUrl = previousApiUrl;
    managementPassword = previousPassword;
    if (err.status === 401) throw new Error("password di gestione non valida");
    throw new Error("impossibile raggiungere la Management API a questo indirizzo");
  }
}

function init() {
  const setupForm = document.getElementById("hub-setup-form");
  const addressInput = document.getElementById("hub-address-input");
  const passwordInput = document.getElementById("hub-password-input");
  const togglePassword = document.getElementById("hub-toggle-password");
  const submitButton = document.getElementById("hub-connect-submit");

  togglePassword.addEventListener("click", () => {
    const showing = passwordInput.type === "text";
    passwordInput.type = showing ? "password" : "text";
    togglePassword.setAttribute("aria-pressed", String(!showing));
    togglePassword.setAttribute("aria-label", showing ? "Mostra password" : "Nascondi password");
    togglePassword.textContent = "";
    togglePassword.append(iconEl(showing ? "eye" : "eye-off"));
  });

  setupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setSetupError(null);
    submitButton.disabled = true;
    submitButton.querySelector(".btn-spinner").hidden = false;
    try {
      await validateAndConnect(addressInput.value, passwordInput.value);
      try {
        localStorage.setItem(STORAGE_KEY_URL, apiUrl);
        localStorage.setItem(STORAGE_KEY_PASSWORD, managementPassword);
      } catch {
        // storage unavailable — the session still works, it just won't be remembered next time
      }
      showDashboard();
    } catch (err) {
      setSetupError(err.message);
    } finally {
      submitButton.disabled = false;
      submitButton.querySelector(".btn-spinner").hidden = true;
    }
  });

  document.getElementById("hub-change-gateway").addEventListener("click", () => {
    apiUrl = null;
    managementPassword = null;
    try {
      localStorage.removeItem(STORAGE_KEY_URL);
      localStorage.removeItem(STORAGE_KEY_PASSWORD);
    } catch {
      // nothing to do — nothing was persisted in the first place if storage is unavailable
    }
    addressInput.value = "";
    passwordInput.value = "";
    showSetup();
  });

  let storedUrl = null;
  let storedPassword = null;
  try {
    storedUrl = localStorage.getItem(STORAGE_KEY_URL);
    storedPassword = localStorage.getItem(STORAGE_KEY_PASSWORD);
  } catch {
    // no persisted session — falls through to the setup screen below
  }
  if (storedUrl && storedPassword) {
    apiUrl = storedUrl;
    managementPassword = storedPassword;
    showDashboard();
  }
}

document.addEventListener("DOMContentLoaded", init);
