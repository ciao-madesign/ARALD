// Stato dell'Emergency State Screen (docs/ux-ui-design-system.md §8, "Dopo l'attivazione SOS non
// lasciare l'utente sulla normale home. Passare a una Emergency State Screen dedicata.") — persistito
// su localStorage (sopravvive a una chiusura dell'app, stesso motivo di sos-queue.js) perché
// un'emergenza resta "attiva" anche dopo che il relativo SOS è stato trasmesso: a differenza della
// coda di sos-queue.js (puro dettaglio di instradamento, azzerata non appena un canale ha successo),
// questo stato esiste finché l'utente non tocca esplicitamente "Concludi emergenza" — è ciò che decide
// se ble-client.js deve riproporre la schermata di emergenza invece del modulo di invio quando si
// tocca di nuovo il bottone SOS, o al riavvio dell'app.
//
// Logica pura, nessun I/O di rete/DOM — stesso principio di sos-queue.js/ble-sos.js: ble-client.js
// decide *quando* mostrare/aggiornare la schermata, questo file decide solo *cosa* c'è da mostrare
// (validazione, persistenza). Un solo slot, mai una lista: stessa UX di un solo bottone/pannello SOS,
// nessun bisogno di gestire più emergenze contemporanee sullo stesso telefono.
//
// Nessuna scadenza: a differenza di sos-queue.js's isPendingSosExpired() (legata alla validità di un
// pacchetto Bluetooth firmato), un'emergenza non "scade" da sola — si conclude solo per azione
// esplicita dell'utente, stessa scelta già fatta per node/src/emergency-beacon.ts's EmergencyBeacons
// (nessuna scadenza pigra, "la difesa anti-flood vive a monte"; qui il motivo è diverso ma l'esito
// identico: inventare una scadenza per un'emergenza reale sarebbe più pericoloso che non averne una).
//
// Scritto come vero modulo ES (stesso bridge-a-`window` di sos-queue.js) per essere unit-testato sotto
// vitest (tests/unit/mobile-emergency-state.test.ts) con uno storage iniettabile.

export const ACTIVE_EMERGENCY_STORAGE_KEY = "arald.activeEmergency";

function defaultStorage() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `true` se `entry` ha la forma minima necessaria per essere uno stato di emergenza valido — mai
 * fidarsi di localStorage più di quanto ci si fiderebbe di un file su disco (stessa disciplina di
 * sos-queue.js's isWellFormedEntry()): un contenuto malformato o manomesso da devtools non deve mai
 * far crashare il resto dell'app, solo essere trattato come assente.
 */
function isWellFormedEmergency(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.activatedAt === "number" &&
    (entry.status === "queued" || entry.status === "sent") &&
    (entry.message === undefined || typeof entry.message === "string") &&
    (entry.lat === undefined || typeof entry.lat === "number") &&
    (entry.lon === undefined || typeof entry.lon === "number") &&
    (entry.channel === undefined || entry.channel === "gateway" || entry.channel === "bluetooth") &&
    (entry.sentAt === undefined || typeof entry.sentAt === "number")
  );
}

/** `null` se non c'è nessuna emergenza attiva, o se la voce persistita è malformata (ripulita silenziosamente in quel caso, stesso trattamento di sos-queue.js's loadPendingSos()). */
export function loadActiveEmergency(storage = defaultStorage()) {
  if (!storage) return null;
  let raw;
  try {
    raw = storage.getItem(ACTIVE_EMERGENCY_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearActiveEmergency(storage);
    return null;
  }
  if (!isWellFormedEmergency(parsed)) {
    clearActiveEmergency(storage);
    return null;
  }
  return parsed;
}

export function saveActiveEmergency(entry, storage = defaultStorage()) {
  if (!storage) return;
  try {
    storage.setItem(ACTIVE_EMERGENCY_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Storage piena/non disponibile — stesso degrado accettato di sos-queue.js's savePendingSos():
    // il tentativo in corso resta comunque valido, solo non sopravviverebbe a una chiusura dell'app.
  }
}

export function clearActiveEmergency(storage = defaultStorage()) {
  if (!storage) return;
  try {
    storage.removeItem(ACTIVE_EMERGENCY_STORAGE_KEY);
  } catch {
    // best-effort
  }
}

/**
 * Segna l'emergenza attiva come trasmessa da `channel` ("gateway"|"bluetooth") — no-op (restituisce
 * `null`) se non c'è più nessuna emergenza attiva da aggiornare: può succedere davvero, non solo in
 * teoria — l'utente potrebbe aver già toccato "Concludi emergenza" mentre un canale in corsa (es. il
 * ritentativo periodico del gateway, o un peer Bluetooth appena incrociato) stava ancora per avere
 * successo in background. Senza questo controllo, quel canale in ritardo resusciterebbe un'emergenza
 * che l'utente ha già chiuso — stessa classe di guardia anti-resurrezione già applicata altrove in
 * questo progetto (es. node/src/node.ts's uso di `packet.source === entry.activeProvider`, CLAUDE.md).
 * Non sovrascrive `status` già `"sent"` con un nuovo `channel`: il primo canale a riuscire è quello che
 * conta, un secondo canale concorrente che arriva dopo non deve sostituirne l'attribuzione già mostrata
 * all'utente.
 */
export function markActiveEmergencySent(channel, storage = defaultStorage()) {
  const active = loadActiveEmergency(storage);
  if (!active || active.status === "sent") return null;
  const updated = { ...active, status: "sent", channel, sentAt: Date.now() };
  saveActiveEmergency(updated, storage);
  return updated;
}

const AraldEmergencyState = { ACTIVE_EMERGENCY_STORAGE_KEY, loadActiveEmergency, saveActiveEmergency, clearActiveEmergency, markActiveEmergencySent };

// Lo stesso ponte deliberato verso i classici script non-modulo di questa directory — vedi il
// commento in cima a sos-queue.js.
if (typeof window !== "undefined") {
  window.AraldEmergencyState = AraldEmergencyState;
}
