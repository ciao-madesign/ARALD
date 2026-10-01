// Coda SOS persistente sul telefono, in attesa di un peer Bluetooth (docs/next-steps.md, "Coda SOS
// persistente sul telefono, in attesa di un peer BLE") — tiene un singolo SOS "pronto", sopravvivendo
// anche alla chiusura dell'app (localStorage), così ble-client.js può trasmetterlo automaticamente al
// primo dispositivo ARALD Bluetooth incrociato, anche minuti o ore dopo il tap iniziale — non solo
// nella finestra immediata del burst di sendEmergencyBeaconViaRelay() (voce #65).
//
// Logica pura, nessun I/O Bluetooth/DOM — stesso principio di ble-relay.js/ble-sos.js: ble-client.js
// decide il *quando* (hook sulla scoperta di un nuovo peer in handleNotification()), questo file
// decide il *cosa* (validazione, scadenza, persistenza). Un solo slot, mai una lista: un nuovo tap su
// "Invia SOS" sostituisce semplicemente l'SOS in attesa con uno più recente — stessa UX di un solo
// pannello/bottone SOS, nessun bisogno di gestire più emergenze in coda contemporaneamente.
//
// Scadenza pigra, mai un timer di sweep in background — stessa disciplina già applicata lato Node a
// ContentStore/RemoteCatalog/ServiceDirectory (CLAUDE.md): un SOS il cui `expiresAt` (lo stesso campo
// che il pacchetto firmato già porta, vedi ble-sos.js/node/src/emergency-beacon.ts) è nel passato
// viene trattato come assente e ripulito al prossimo accesso (loadPendingSos()), mai da un timer
// proprio. Nessun avviso esplicito "SOS scaduto" quando questo accade: stessa scelta già fatta per
// ogni altra scadenza pigra di questo progetto (un contenuto scaduto semplicemente scompare).
//
// Scritto come vero modulo ES (stesso bridge-a-`window` di ble-sos.js/ble-relay.js) per poter essere
// unit-testato sotto vitest (tests/unit/mobile-ble-sos-queue.test.ts) con uno storage iniettabile,
// stesso schema già usato da ble-identity.js's loadOrCreateIdentity(storage).

export const PENDING_SOS_STORAGE_KEY = "arald.pendingSos";

function defaultStorage() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `true` se `entry` ha la forma minima necessaria per essere una voce di coda valida — mai fidarsi di
 * localStorage più di quanto ci si fiderebbe di un file su disco (stessa disciplina di
 * node/src/portable-config.ts): un contenuto malformato o manomesso da devtools non deve mai far
 * crashare il resto dell'app, solo essere trattato come assente.
 */
function isWellFormedEntry(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.queuedAt === "number" &&
    entry.packet !== null &&
    typeof entry.packet === "object" &&
    // Stessa validazione minima dell'involucro già usata da ble-link.js's decodePacket() (mai
    // fidarsi di id/type/source) — trovato mancante dalla revisione: senza questi controlli, una
    // voce con solo payload.metadata.expiresAt valido ma un `packet.id` assente/non-stringa veniva
    // accettata come valida, per poi far chiamare seenCache.markSeen(undefined) e trasmettere un
    // pacchetto che un vero NomadNode scarterebbe comunque alla prima validazione dell'involucro.
    typeof entry.packet.id === "string" &&
    typeof entry.packet.type === "string" &&
    typeof entry.packet.source === "string" &&
    entry.packet.payload !== null &&
    typeof entry.packet.payload === "object" &&
    entry.packet.payload.metadata !== null &&
    typeof entry.packet.payload.metadata === "object" &&
    typeof entry.packet.payload.metadata.expiresAt === "number"
  );
}

/** Riusa lo stesso campo `expiresAt` che il pacchetto SOS firmato già porta (ble-sos.js's `buildEmergencyBeaconPacket()`) invece di inventare una scadenza di coda separata: un SOS che un vero NomadNode tratterebbe già come contenuto scaduto non ha senso restare "in attesa di trasmissione" sul telefono. `entry` deve già essere passato da `isWellFormedEntry()`. */
export function isPendingSosExpired(entry, now = Date.now()) {
  return entry.packet.payload.metadata.expiresAt <= now;
}

/**
 * Restituisce l'SOS in attesa (`{packet, queuedAt}`) se presente, valido e non ancora scaduto —
 * `null` in ogni altro caso (nessuna voce, JSON malformato, forma inattesa, scaduto), ripulendo
 * `storage` silenziosamente ogni volta che il risultato è `null` per un motivo diverso da "non c'era
 * nulla" — così una voce scaduta/malformata non resta a ingombrare indefinitamente.
 */
export function loadPendingSos(storage = defaultStorage()) {
  if (!storage) return null;
  let raw;
  try {
    raw = storage.getItem(PENDING_SOS_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearPendingSos(storage);
    return null;
  }
  if (!isWellFormedEntry(parsed) || isPendingSosExpired(parsed)) {
    clearPendingSos(storage);
    return null;
  }
  return parsed;
}

/** `packet` è un pacchetto già costruito da `ble-sos.js`'s `buildEmergencyBeaconPacket()` — fidato per costruzione (prodotto da questo stesso telefono, non letto da una fonte esterna), a differenza di quanto `loadPendingSos()` legge indietro da `storage`. */
export function savePendingSos(packet, storage = defaultStorage()) {
  if (!storage) return;
  try {
    storage.setItem(PENDING_SOS_STORAGE_KEY, JSON.stringify({ packet, queuedAt: Date.now() }));
  } catch {
    // Storage piena/non disponibile (privacy mode, ecc.) — stesso degrado accettato di
    // app.js's recordActivity()/setContactName(): il burst immediato in corso resta comunque valido,
    // solo non sopravviverebbe a una chiusura dell'app.
  }
}

export function clearPendingSos(storage = defaultStorage()) {
  if (!storage) return;
  try {
    storage.removeItem(PENDING_SOS_STORAGE_KEY);
  } catch {
    // best-effort
  }
}

const AraldBleSosQueue = { PENDING_SOS_STORAGE_KEY, loadPendingSos, savePendingSos, clearPendingSos, isPendingSosExpired };

// Lo stesso ponte deliberato verso i classici script non-modulo di questa directory — vedi il
// commento in cima a ble-sos.js.
if (typeof window !== "undefined") {
  window.AraldBleSosQueue = AraldBleSosQueue;
}
