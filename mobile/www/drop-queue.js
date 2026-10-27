// Coda persistente dei drop in uscita sul telefono (docs/test-protocol.md T1.5, docs/security.md
// voce #149): un drop creato mentre il Box non è raggiungibile resta qui, sopravvive a una chiusura
// dell'app (localStorage) e viene ritentato da app.js al primo ciclo di polling riuscito.
//
// Sulla falsariga di sos-queue.js, ma una LISTA e non un solo slot (si possono creare più drop prima
// che il Box torni), sempre limitata: `MAX_PENDING_DROPS`. Quando è piena `enqueuePendingDrop()`
// RIFIUTA il nuovo drop invece di scartare silenziosamente il più vecchio — la coda contiene testo
// che l'utente ha scritto e non ha ancora visto pubblicato, perderlo senza dirlo sarebbe peggio di
// dire "coda piena" (l'SOS ha uno slot solo per un motivo diverso: un'emergenza attiva alla volta).
//
// Ogni voce è legata al Box (`gateway`) per cui è stata scritta: testo e posizione di un utente non
// devono mai finire su una mesh diversa solo perché nel frattempo ha cambiato rete. Una voce di un
// altro Box non viene inviata né cancellata, scade da sola.
//
// Scadenza pigra, mai un timer di sweep: una voce più vecchia di `PENDING_DROP_MAX_AGE_MS` viene tolta
// al prossimo `loadPendingDrops()` e restituita in `expired`, così il chiamante può aggiornare lo
// stato mostrato all'utente invece di lasciarlo "in attesa" per sempre. `enqueuePendingDrop()`
// non toglie MAI nulla: le voci scadute restano (e contano per il limite) fino a quando
// `loadPendingDrops()` non le ha restituite a chi può aggiornare lo stato.
//
// Logica pura, nessun I/O di rete/DOM: app.js decide il *quando* (submit, polling) e il *come*
// (fetch, DOM), questo file decide il *cosa* (validazione, scadenza, persistenza, classificazione
// degli errori, ordine e arresto del ciclo di invio — `flushPendingDrops()`, con l'invio iniettato).
// Vero modulo ES con ponte verso `window` come sos-queue.js, per essere unit-testato con uno storage
// iniettabile (tests/unit/mobile-drop-queue.test.ts).
//
// **Limiti noti, non risolti qui** (docs/security.md voce #149):
// - Duplicati: ogni invio porta `idempotencyKey` = `queueId` (voce #150), e il Box non pubblica due
//   volte la stessa chiave. Resta possibile un duplicato solo se il Box si riavvia fra la richiesta
//   originale e il suo ritentativo (la memoria delle chiavi è in RAM), o con un Box più vecchio che
//   ignora il campo. `claimPendingDrop()` evita in più l'invio parallelo della stessa voce.
// - Il momento della segnalazione (`createdAt` = `queuedAt`) viene riportato al Box, che lo usa come
//   `timestamp` del drop (limitato a [adesso - 24 h, adesso]): un drop uscito dalla coda dopo ore
//   conserva l'ora in cui è stato scritto (inviato solo per i drop in coda, mai per un invio diretto:
//   l'orologio di un telefono senza rete può essere sbagliato). Un Box più vecchio lo ignora e usa l'ora di pubblicazione.

export const PENDING_DROPS_STORAGE_KEY = "arald.pendingDrops";
export const MAX_PENDING_DROPS = 20;

/**
 * Stessa durata di default che il nodo dà a un drop (`DEFAULT_DROP_TTL_MS`, node/src/node.ts) — da
 * tenere allineata a mano: un drop in coda più a lungo di quanto il nodo lo farebbe vivere è già
 * un'informazione vecchia. La scadenza assoluta di un drop accodato resta `queuedAt + questo`.
 */
export const PENDING_DROP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Per quanto una voce "presa in carico" (`claimPendingDrop()`) viene considerata in invio da qualcun
 * altro. Più lungo del timeout di una richiesta di app.js (`CALL_TIMEOUT_MS`, 20 s): se la pagina muore
 * a metà invio, la voce torna disponibile dopo questo tempo.
 */
export const CLAIM_TTL_MS = 30_000;

/** Stesso limite di `MAX_DROP_LABEL_LENGTH` in node/src/drops.ts (da tenere allineato a mano). */
const MAX_DROP_LABEL_LENGTH = 100;

/** Stesso limite di `MAX_MESSAGE_TEXT_LENGTH` in node/src/message-history.ts (da tenere allineato a mano). */
const MAX_DROP_TEXT_LENGTH = 4000;

const VALID_KINDS =new Set(["info", "hazard", "emergency"]);

function defaultStorage() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Identificatore di una voce, usato anche come chiave di idempotenza verso il nodo (`POST /api/drops`
 * → `idempotencyKey`): app.js lo genera PRIMA del primo invio, così il ritentativo di un invio la cui
 * risposta si è persa porta la stessa chiave e il Box non pubblica un duplicato.
 */
export function newQueueId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "q-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/**
 * `true` se `entry` ha la forma minima di una voce valida — mai fidarsi di localStorage più di un
 * file su disco (stessa disciplina di sos-queue.js): una voce malformata o manomessa è trattata come
 * assente, mai un crash dell'app. `lat`/`lon` finiti e obbligatori: il nodo li esige (`POST
 * /api/drops` risponde 400 senza), quindi una voce senza posizione non potrebbe mai essere inviata.
 */
function isWellFormedEntry(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.queueId === "string" &&
    entry.queueId.length > 0 &&
    typeof entry.gateway === "string" &&
    entry.gateway.length > 0 &&
    typeof entry.text === "string" &&
    entry.text.length > 0 &&
    typeof entry.lat === "number" &&
    Number.isFinite(entry.lat) &&
    Math.abs(entry.lat) <= 90 &&
    typeof entry.lon === "number" &&
    Number.isFinite(entry.lon) &&
    Math.abs(entry.lon) <= 180 &&
    (entry.label === undefined || (typeof entry.label === "string" && entry.label.length <= MAX_DROP_LABEL_LENGTH)) &&
    typeof entry.kind === "string" &&
    VALID_KINDS.has(entry.kind) &&
    typeof entry.queuedAt === "number" &&
    Number.isFinite(entry.queuedAt) &&
    (entry.sendingSince === undefined || (typeof entry.sendingSince === "number" && Number.isFinite(entry.sendingSince)))
  );
}

export function isPendingDropExpired(entry, now = Date.now()) {
  return entry.queuedAt + PENDING_DROP_MAX_AGE_MS <= now;
}

/**
 * Vita residua da riportare al nodo come `expiresInMs`: sempre > 0 per una voce non scaduta e mai
 * oltre la durata piena, anche per una voce con `queuedAt` nel futuro (orologio sbagliato o storage
 * manomesso) — il nodo rifiuterebbe o accorcerebbe comunque un valore fuori scala.
 */
export function remainingLifetimeMs(entry, now = Date.now()) {
  return Math.min(PENDING_DROP_MAX_AGE_MS, entry.queuedAt + PENDING_DROP_MAX_AGE_MS - now);
}

function readEntries(storage) {
  let raw;
  try {
    raw = storage.getItem(PENDING_DROPS_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntries(entries, storage) {
  try {
    if (entries.length === 0) storage.removeItem(PENDING_DROPS_STORAGE_KEY);
    else storage.setItem(PENDING_DROPS_STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    // Storage piena/non disponibile (modalità privata, ecc.).
    return false;
  }
}

/**
 * Restituisce `{ pending, expired }`: le voci valide e non scadute (dalla più vecchia alla più
 * recente) e quelle appena trovate scadute, che da qui in poi non sono più nello storage. Ripulisce
 * `storage` da voci malformate — spariscono senza traccia, di loro non si può sapere nulla. Una voce
 * con `queuedAt` nel futuro (orologio che ha corso avanti e poi è stato corretto, o storage manomesso)
 * viene riportata a "adesso": altrimenti non scadrebbe mai.
 */
export function loadPendingDrops(storage = defaultStorage(), now = Date.now()) {
  if (!storage) return { pending: [], expired: [] };
  const all = readEntries(storage);
  const pending = [];
  const expired = [];
  let changed = false;
  for (const entry of all) {
    if (!isWellFormedEntry(entry)) {
      changed = true;
      continue;
    }
    if (entry.queuedAt > now) {
      entry.queuedAt = now;
      changed = true;
    }
    if (isPendingDropExpired(entry, now)) {
      expired.push(entry);
      changed = true;
    } else {
      pending.push(entry);
    }
  }
  if (changed) writeEntries(pending, storage);
  return { pending, expired };
}

/**
 * Accoda un drop per il Box `gateway`. Restituisce la voce creata (con il suo `queueId`, da riusare
 * come riferimento nello stato mostrato all'utente) oppure `null` se non è stato possibile salvarlo:
 * coda piena, input non valido o storage non scrivibile. `null` non significa mai "accodato
 * comunque" — il chiamante deve dirlo all'utente.
 *
 * Non toglie nulla dallo storage (nemmeno le voci scadute, che contano per il limite): la ripulitura
 * spetta a `loadPendingDrops()`, che le restituisce a chi può aggiornarne lo stato mostrato.
 */
export function enqueuePendingDrop({ text, lat, lon, label, kind, gateway, queueId }, storage = defaultStorage(), now = Date.now()) {
  if (!storage) return null;
  const entry = { queueId: queueId || newQueueId(), gateway, text, lat, lon, label: label || undefined, kind: kind || "info", queuedAt: now };
  // Il limite del testo si applica solo qui, non in isWellFormedEntry(): un testo troppo lungo già in
  // storage resta una voce valida e il nodo lo rifiuta con un 400 definitivo ("Non pubblicata"),
  // invece di sparire senza traccia al caricamento.
  if (!isWellFormedEntry(entry) || text.length > MAX_DROP_TEXT_LENGTH) return null;
  const existing = readEntries(storage).filter(isWellFormedEntry);
  if (existing.length >= MAX_PENDING_DROPS) return null;
  // Stesso id già in coda (doppio invio dello stesso modulo): è la stessa segnalazione, già salvata.
  const already = existing.find((e) => e.queueId === entry.queueId);
  if (already) return already;
  existing.push(entry);
  return writeEntries(existing, storage) ? entry : null;
}

export function removePendingDrop(queueId, storage = defaultStorage()) {
  if (!storage) return;
  const remaining = readEntries(storage).filter((entry) => !(entry && entry.queueId === queueId));
  writeEntries(remaining, storage);
}

/**
 * Prende in carico una voce prima di inviarla: `true` se esiste ancora e nessuno la sta già inviando
 * (da una voce `sendingSince` più recente di `CLAIM_TTL_MS`), e in tal caso la marca. Rilegge lo storage
 * ogni volta, così due pagine/schede sulla stessa origine non inviano la stessa voce in parallelo e una
 * voce già pubblicata e rimossa da un'altra pagina non viene reinviata. Non è atomico fra schede
 * (localStorage non ha un compare-and-set): riduce la finestra, non la chiude del tutto.
 */
export function claimPendingDrop(queueId, storage = defaultStorage(), now = Date.now()) {
  if (!storage) return false;
  const all = readEntries(storage);
  const entry = all.find((e) => e && e.queueId === queueId && isWellFormedEntry(e));
  if (!entry) return false;
  if (typeof entry.sendingSince === "number" && now - entry.sendingSince < CLAIM_TTL_MS) return false;
  entry.sendingSince = now;
  return writeEntries(all, storage);
}

/** Toglie la marca di `claimPendingDrop()` dopo un invio fallito, così la voce può essere ritentata subito. */
export function releasePendingDrop(queueId, storage = defaultStorage()) {
  if (!storage) return;
  const all = readEntries(storage);
  const entry = all.find((e) => e && e.queueId === queueId);
  if (!entry || entry.sendingSince === undefined) return;
  delete entry.sendingSince;
  writeEntries(all, storage);
}

/**
 * Cosa fare di un invio fallito, in base all'errore che `createDrop()` (app.js) ha sollevato:
 * - `"retry"` — niente `status` (rete caduta, Box spento, timeout), oppure 408/5xx o una risposta non
 *   JSON (captive portal, proxy): il Box non è raggiungibile ORA, vale per ogni voce. Si ferma il giro.
 * - `"throttled"` — 429, il limite di drop ad alta priorità del nodo, che si libera col tempo. Riguarda
 *   questa voce, non le altre (un drop `info` non è limitato): si salta e si prosegue.
 * - `"reauth"` — 401: la password non è più valida. La voce resta in coda; serve un nuovo pairing.
 * - `"discard"` — 400/413: il nodo ha esaminato e rifiutato questi dati (testo, etichetta, tipo o
 *   posizione non validi, corpo troppo grande). Riprovare darebbe lo stesso esito all'infinito.
 * - `"unsupported"` — ogni altro 4xx (403, 404, 405, ...): o questo Box non offre i drop, o c'è un
 *   intermediario (portale captive, proxy, un altro server sullo stesso indirizzo) che risponde al
 *   posto suo. Non è un rifiuto del nodo sul contenuto, quindi il testo dell'utente non si cancella:
 *   la voce resta, si salta e scade da sola.
 */
export function classifyDropSendFailure(err) {
  const status = err && typeof err === "object" ? err.status : undefined;
  if (typeof status !== "number") return "retry";
  if (status === 401) return "reauth";
  if (status === 429) return "throttled";
  if (status === 400 || status === 413) return "discard";
  if (status >= 400 && status < 500 && status !== 408) return "unsupported";
  return "retry";
}

/**
 * All'invio diretto dal modulo: accodare solo se il problema è transitorio ("retry" o "throttled").
 * Un 401 si gestisce chiedendo la password, un rifiuto del nodo o un 4xx "unsupported" si mostrano
 * all'utente come errore — accodare un drop che non verrà mai accettato sarebbe solo una falsa promessa.
 */
export function shouldQueueOnSubmit(err) {
  const kind = classifyDropSendFailure(err);
  return kind === "retry" || kind === "throttled";
}

/**
 * Un giro di invio della coda per il Box `gateway`, con l'invio vero (`send(entry, expiresInMs)`, che
 * deve lanciare un errore con `.status` se il Box risponde con un errore) e le segnalazioni
 * (`onPublished`/`onDiscarded`/`onExpired`/`onReauth`) iniettati da app.js — così l'ordine, l'arresto e
 * la gestione degli errori sono unit-testabili senza rete né DOM.
 *
 * Dalla più vecchia alla più recente. Le voci di un altro Box si ignorano. Prima di ogni invio la voce
 * viene presa in carico (`claimPendingDrop()`). Dopo un fallimento: "retry" ferma il giro (il Box non
 * c'è per nessuna voce), "reauth" lo ferma e avvisa, "throttled"/"unsupported" saltano solo quella voce,
 * "discard" la toglie. Mai lancia.
 */
export async function flushPendingDrops({ gateway, send, onPublished, onDiscarded, onExpired, onReauth }, storage = defaultStorage(), clock = Date.now) {
  const result = { published: 0, discarded: 0, expired: 0, stoppedBy: null };
  if (!storage) return result;
  const { pending, expired } = loadPendingDrops(storage, clock());
  for (const entry of expired) {
    result.expired += 1;
    if (onExpired) onExpired(entry);
  }
  for (const entry of pending) {
    if (entry.gateway !== gateway) continue;
    // La vita residua si ricalcola al momento dell'invio: loadPendingDrops() ha filtrato prima, e il
    // nodo risponde 400 a un `expiresInMs` non positivo (che qui diventerebbe un rifiuto definitivo).
    if (remainingLifetimeMs(entry, clock()) <= 0) {
      removePendingDrop(entry.queueId, storage);
      result.expired += 1;
      if (onExpired) onExpired(entry);
      continue;
    }
    if (!claimPendingDrop(entry.queueId, storage, clock())) continue;

    let failure = null;
    let error;
    try {
      await send(entry, remainingLifetimeMs(entry, clock()));
    } catch (err) {
      error = err;
      failure = classifyDropSendFailure(err);
    }

    if (failure === null) {
      removePendingDrop(entry.queueId, storage);
      result.published += 1;
      if (onPublished) onPublished(entry);
      continue;
    }
    if (failure === "discard") {
      removePendingDrop(entry.queueId, storage);
      result.discarded += 1;
      if (onDiscarded) onDiscarded(entry, error);
      continue;
    }
    releasePendingDrop(entry.queueId, storage);
    if (failure === "reauth") {
      result.stoppedBy = "reauth";
      if (onReauth) onReauth();
      break;
    }
    if (failure === "retry") {
      result.stoppedBy = "retry";
      break;
    }
    // "throttled" / "unsupported": il Box risponde, solo non per questa voce — si prosegue con le altre.
  }
  return result;
}

const AraldDropQueue = {
  PENDING_DROPS_STORAGE_KEY,
  MAX_PENDING_DROPS,
  PENDING_DROP_MAX_AGE_MS,
  CLAIM_TTL_MS,
  newQueueId,
  loadPendingDrops,
  enqueuePendingDrop,
  removePendingDrop,
  claimPendingDrop,
  releasePendingDrop,
  isPendingDropExpired,
  remainingLifetimeMs,
  classifyDropSendFailure,
  shouldQueueOnSubmit,
  flushPendingDrops,
};

// Stesso ponte deliberato verso i classici script non-modulo di questa directory — vedi il commento
// in cima a ble-sos.js.
if (typeof window !== "undefined") {
  window.AraldDropQueue = AraldDropQueue;
}
