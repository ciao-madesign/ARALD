// Coda SOS persistente sul telefono, su ogni canale disponibile (docs/next-steps.md, "Coda SOS
// persistente sul telefono, in attesa di un peer BLE" — voce #106; estesa a ogni canale dall'utente,
// "SOS sempre persistente su ogni canale possibile, il primo che funziona libera l'SOS", voce #107) —
// tiene un singolo SOS "pronto", sopravvivendo anche alla chiusura dell'app (localStorage), così
// ble-client.js può trasmetterlo automaticamente non appena un canale qualsiasi diventa disponibile:
// un peer Bluetooth incrociato, o il gateway Wi-Fi/LAN a cui il telefono è appaiato (se raggiungibile
// e se a sua volta ha Internet, la mesh propaga comunque fino a lì — nessun canale "internet" separato,
// solo la stessa propagazione mesh di qualunque altro contenuto). Non più BLE-specifico nonostante il
// nome storico dei file circostanti (`ble-*.js`) — questo file non contiene nulla di Bluetooth, solo
// persistenza/validazione/scadenza, deliberatamente senza prefisso `ble-` per riflettere il suo ruolo
// attuale (rinominato da `ble-sos-queue.js` in questa stessa voce, stesso principio già applicato a
// `gateway/nomad/` → `gateway/local-services/` quando una dipendenza cessava di essere vera, CLAUDE.md).
//
// Logica pura, nessun I/O di rete/Bluetooth/DOM — stesso principio di ble-relay.js/ble-sos.js:
// ble-client.js/app.js decidono il *quando* e il *come* di ciascun canale, questo file decide solo il
// *cosa* (validazione, scadenza, persistenza). Un solo slot, mai una lista: un nuovo tap su "Invia SOS"
// sostituisce semplicemente l'SOS in attesa con uno più recente — stessa UX di un solo pannello/bottone
// SOS, nessun bisogno di gestire più emergenze in coda contemporaneamente.
//
// Scadenza pigra, mai un timer di sweep in background — stessa disciplina già applicata lato Node a
// ContentStore/RemoteCatalog/ServiceDirectory (CLAUDE.md): un SOS il cui `expiresAt` (lo stesso campo
// che il pacchetto Bluetooth firmato già porta, vedi ble-sos.js/node/src/emergency-beacon.ts) è nel
// passato viene trattato come assente e ripulito al prossimo accesso (loadPendingSos()), mai da un
// timer proprio. Nessun avviso esplicito "SOS scaduto" quando questo accade: stessa scelta già fatta
// per ogni altra scadenza pigra di questo progetto (un contenuto scaduto semplicemente scompare).
//
// Scritto come vero modulo ES (stesso bridge-a-`window` di ble-sos.js/ble-relay.js) per poter essere
// unit-testato sotto vitest (tests/unit/mobile-sos-queue.test.ts) con uno storage iniettabile, stesso
// schema già usato da ble-identity.js's loadOrCreateIdentity(storage).

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
 *
 * `packet` resta obbligatorio e validato nell'involucro (`id`/`type`/`source`/`payload.metadata.expiresAt`)
 * anche se oggi serve solo al canale Bluetooth: è l'unico campo che porta già una scadenza e una firma,
 * riusate per l'intera voce indipendentemente dal canale che poi avrà successo. `message`/`lat`/`lon`
 * sono i soli campi che il canale gateway (`node/src/web-ui.ts`'s `POST /api/emergency-beacons`, voce
 * #107) ricostruisce da sé — opzionali, stessa forma di `ble-sos.js`'s `buildEmergencyBeaconPacket()`.
 */
function isWellFormedEntry(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.queuedAt === "number" &&
    (entry.message === undefined || typeof entry.message === "string") &&
    (entry.lat === undefined || typeof entry.lat === "number") &&
    (entry.lon === undefined || typeof entry.lon === "number") &&
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

/** Riusa lo stesso campo `expiresAt` che il pacchetto SOS Bluetooth firmato già porta (ble-sos.js's `buildEmergencyBeaconPacket()`) invece di inventare una scadenza di coda separata, valida per l'intera voce indipendentemente dal canale: un SOS che un vero NomadNode tratterebbe già come contenuto scaduto non ha senso restare "in attesa di trasmissione" su nessun canale. `entry` deve già essere passato da `isWellFormedEntry()`. */
export function isPendingSosExpired(entry, now = Date.now()) {
  return entry.packet.payload.metadata.expiresAt <= now;
}

/**
 * Restituisce l'SOS in attesa (`{packet, message, lat, lon, queuedAt}`) se presente, valido e non
 * ancora scaduto — `null` in ogni altro caso (nessuna voce, JSON malformato, forma inattesa, scaduto),
 * ripulendo `storage` silenziosamente ogni volta che il risultato è `null` per un motivo diverso da
 * "non c'era nulla" — così una voce scaduta/malformata non resta a ingombrare indefinitamente.
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

/**
 * `packet` è un pacchetto Bluetooth già costruito da `ble-sos.js`'s `buildEmergencyBeaconPacket()` —
 * fidato per costruzione (prodotto da questo stesso telefono, non letto da una fonte esterna), a
 * differenza di quanto `loadPendingSos()` legge indietro da `storage`. `message`/`lat`/`lon` sono gli
 * stessi input grezzi passati a quella chiamata, persistiti qui *in aggiunta* al pacchetto perché il
 * canale gateway (voce #107) non riusa il pacchetto Bluetooth firmato — costruisce la propria richiesta
 * da questi campi, lato server, con l'identità del gateway stesso, non quella del telefono.
 */
export function savePendingSos({ packet, message, lat, lon }, storage = defaultStorage()) {
  if (!storage) return;
  try {
    storage.setItem(PENDING_SOS_STORAGE_KEY, JSON.stringify({ packet, message, lat, lon, queuedAt: Date.now() }));
  } catch {
    // Storage piena/non disponibile (privacy mode, ecc.) — stesso degrado accettato di
    // app.js's recordActivity()/setContactName(): i tentativi immediati in corso restano comunque
    // validi, solo non sopravviverebbero a una chiusura dell'app.
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

/**
 * Arbitro condiviso tra tutti i canali della coda SOS persistente (burst Bluetooth immediato, hook su
 * un nuovo peer Bluetooth, canale gateway al tap, ritentativo gateway periodico — `ble-client.js`/
 * `app.js`) per riportare un successo una sola volta per uno specifico SOS (`packetId`), qualunque
 * canale arrivi per primo. Se due canali risolvono lo stesso SOS quasi in contemporanea — scenario
 * reale con più di un canale in corsa, trovato dalla revisione già sulla sola voce Bluetooth (#106),
 * rilevante ancora di più ora che i canali sono molteplici (#107) — solo il primo a chiamare questa
 * funzione ottiene `true` e deve riportare il successo (attività/toast/vibrazione); ogni chiamata
 * successiva per lo stesso `packetId` riceve `false` e non deve fare nulla, l'SOS è già stato tolto
 * dalla coda da chi ha vinto. Il confronto per `packetId` (non un semplice "la coda è vuota?") garantisce
 * che la risoluzione di un SOS *diverso* e più recente (un nuovo tap su "Invia SOS" nel frattempo) non
 * venga mai scambiata per quella del proprio.
 */
export function claimSosSuccess(packetId, storage = defaultStorage()) {
  const pending = loadPendingSos(storage);
  if (!pending || pending.packet.id !== packetId) return false;
  clearPendingSos(storage);
  return true;
}

/**
 * Risolve alla prima promise di `promises` che si risolve a un valore "truthy" — `false` solo se
 * *tutte* si risolvono a un valore falsy o rifiutano (mai un `Promise.race()` puro: quello risolverebbe
 * anche sul primo fallimento, anche se un'altra promise avrebbe poi avuto successo). Logica pura, nessuna
 * dipendenza da `window`/DOM — estratta qui (invece di restare dentro `ble-client.js`, uno script
 * classico mai unit-testato per la parte che tocca il plugin Bluetooth) proprio per poter essere
 * unit-testata sotto vitest, trovato necessario dalla revisione: era l'unico pezzo della nuova
 * orchestrazione multi-canale (voce #107) senza copertura automatica. Usata da `ble-client.js`'s
 * `sendSos()` per far correre in parallelo il canale gateway e il burst Bluetooth — "il primo canale che
 * funziona libera l'SOS", richiesta esplicita dell'utente.
 */
export function raceFirstSuccess(promises) {
  // Una lista vuota non farebbe mai scattare `settle()` qui sotto (il ciclo `for` non esegue alcuna
  // iterazione) — senza questo controllo esplicito la promise restituita non si risolverebbe mai,
  // trovato da un test di regressione dedicato mentre si scriveva la copertura per questa funzione.
  if (promises.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let remaining = promises.length;
    const settle = (ok) => {
      if (ok) {
        resolve(true);
        return;
      }
      remaining -= 1;
      if (remaining === 0) resolve(false);
    };
    for (const p of promises) {
      p.then(settle).catch(() => settle(false));
    }
  });
}

const AraldSosQueue = { PENDING_SOS_STORAGE_KEY, loadPendingSos, savePendingSos, clearPendingSos, claimSosSuccess, raceFirstSuccess, isPendingSosExpired };

// Lo stesso ponte deliberato verso i classici script non-modulo di questa directory — vedi il
// commento in cima a ble-sos.js.
if (typeof window !== "undefined") {
  window.AraldSosQueue = AraldSosQueue;
}
