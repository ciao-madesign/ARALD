// Bluetooth LE relay — the phone as a genuine mesh relay node (docs/security.md voce #63): "ogni
// nodo della mesh deve poter fare da relay, compresi gli smartphone" (istruzione esplicita
// dell'utente). Scopre e si collega automaticamente a *qualunque* dispositivo ARALD nei paraggi
// (Clip, altri relay), tiene più connessioni simultanee, e relaya davvero pacchetti tra di loro —
// dedup, TTL, instradamento broadcast/unicast, coda in memoria per un peer non ancora raggiungibile.
// Sostituisce il pezzo precedente (voce #62), che connetteva a UN SOLO dispositivo scelto
// dall'utente: qui non c'è più un "abbinamento" — è un toggle on/off, il resto è automatico.
//
// Il telefono agisce sempre e solo come BLE *centrale* (scan + connect out), mai come periferica —
// vedi mobile/README.md per l'indagine sulla fattibilità del lato periferica (annotata per un
// prossimo sviluppo, non costruita qui): il plugin scelto (@capacitor-community/bluetooth-le) è
// central-only per dichiarazione esplicita del proprio README.
//
// Classic (non-module) script, loaded after ble-link.js/ble-relay.js/ble-identity.js/ble-sos.js
// (tutti moduli) in index.html — legge la logica pura da `window.AraldBleLink`
// (framing/frammentazione), `window.AraldBleRelay` (dedup/instradamento/coda),
// `window.AraldBleIdentity` (identità Ed25519 reale) e `window.AraldBleSos` (costruzione del
// pacchetto SOS), gli stessi ponti deliberati già documentati nei rispettivi file. Ogni accesso a
// quegli oggetti avviene solo dentro gestori di evento, mai a livello di script — stesso motivo già
// spiegato in ble-link.js.
//
// AMBITO: il telefono relaya pacchetti altrui (nessuna interpretazione/UI per SOS/chat/drop ricevuti
// via relay — resta esplicitamente fuori scope, `docs/security.md` voce #65) **e**, da questo pezzo
// in avanti, ne origina uno proprio — un SOS (`sendSos()` sotto). Due identità
// distinte e deliberatamente diverse coesistono in questo file: `relaySessionNodeId` resta
// un'etichetta usa-e-getta rigenerata a ogni sessione di relay, usata solo per instradare pacchetti
// altrui (mai per firmare nulla); l'identità Ed25519 vera e persistente
// (`window.AraldBleIdentity.loadOrCreateIdentity()`) è usata solo per firmare un SOS originato da
// questo telefono — necessaria perché `verifyContentSignature()` lato mesh scarterebbe qualunque
// contenuto non firmato davvero non appena tocca un `NomadNode` reale, vedi `ble-sos.js`'s header.
//
// COSA È VERIFICATO QUI, COSA NO: la logica di relay pura (ble-relay.js), l'identità/firma
// (ble-identity.js) e la costruzione del pacchetto SOS (ble-sos.js) sono unit-testate
// (tests/unit/mobile-ble-relay.test.ts, mobile-ble-identity.test.ts, mobile-ble-sos.test.ts) — e un
// SOS costruito da questi moduli è verificato end-to-end contro un vero NomadNode via socket TCP
// grezzo (tests/integration/phone-originated-sos-interop.test.ts), non solo contro helper esportati
// in isolamento. Tutto ciò che chiama window.Capacitor.Plugins.BluetoothLe resta scritto a spec, mai
// eseguito contro il plugin reale/un bridge nativo/hardware Bluetooth reale — stessa onestà già
// applicata al pezzo precedente e a node/src/transports/lora-serial.ts.

/**
 * Provisional GATT identifiers — stesso placeholder invenzione-di-questo-progetto già usato nel
 * pezzo precedente (voce #62), non uno standard/una specifica firmware. Vedi il commento originale
 * lì per il ragionamento completo.
 */
const RELAY_SERVICE_UUID = "6f2c6a2e-6b7b-4b8e-9a1a-0c1a6f6e5b2a";
const RELAY_WRITE_CHARACTERISTIC_UUID = "6f2c6a2f-6b7b-4b8e-9a1a-0c1a6f6e5b2a";
const RELAY_NOTIFY_CHARACTERISTIC_UUID = "6f2c6a30-6b7b-4b8e-9a1a-0c1a6f6e5b2a";

/** Stesso valore/motivazione di node/src/transports/ble.ts's DEFAULT_MTU — vedi ble-client.js precedente (voce #62). */
const BLE_MTU = 20;

/** Tetto di connessioni simultanee — stesso numero di node/src/transports/ble.ts's DEFAULT_MAX_CONNECTIONS (limite tipico di un chipset BLE reale per un ruolo periferica; qui il telefono è centrale, ma un tetto prudente evita comunque di provare a tenere aperte connessioni oltre quanto uno stack BLE reale gestirebbe bene). */
const MAX_CONNECTIONS = 7;

/** Quanto attendere l'HELLO di un peer appena connesso prima di rinunciare a quella singola connessione — mirrors CONNECT_TIMEOUT_MS in node/src/transports/simulated-link.ts. */
const HELLO_TIMEOUT_MS = 5000;

/**
 * Ogni quanto ri-emettere una scansione mentre il relay è attivo — difesa "best-effort" contro
 * un'eventuale scansione che si fermasse da sola: le esatte semantiche del ciclo di vita della
 * promise ritornata da `requestLEScan()` di questo plugin (si risolve subito dopo l'avvio, o resta
 * pendente finché non si chiama `stopLEScan()`?) non sono verificabili in questo ambiente — invece
 * di assumerle, questo file ri-emette periodicamente la scansione (fermando prima quella
 * precedente, un'operazione sicura anche se non ce n'era già una attiva) come rete di sicurezza,
 * mai come sostituto di una scansione realmente continua se il plugin già la fornisce.
 */
const SCAN_REFRESH_INTERVAL_MS = 30000;

/** Same defaults as node/src/node.ts's DEFAULT_BEACON_BROADCAST_REPEAT_COUNT/_INTERVAL_MS — see `tryBleSosBurst()`'s own comment for why an SOS is repeated on a timer instead of sent once. */
const SOS_BROADCAST_REPEAT_COUNT = 5;
const SOS_BROADCAST_REPEAT_INTERVAL_MS = 2000;

let relayActive = false;
/**
 * Contatore incrementato a ogni attivazione/disattivazione — permette a un `connectToPeer()`/
 * `handleScanResult()` ancora in corso al momento di una disattivazione (o di una riattivazione
 * rapida) di accorgersi che la sessione a cui appartiene non esiste più, e abortire invece di
 * continuare a operare su stato di sessione ormai azzerato (`relaySessionNodeId`/`pendingQueue`) —
 * trovato mancante dalla revisione, vedi il commento di `connectToPeer()`.
 */
let relaySessionId = 0;
/** Un solo id per l'intera sessione di relay (non più uno per singola connessione, a differenza della voce #62) — generato una volta all'attivazione, riusato in ogni HELLO verso ogni peer. Necessario perché un pacchetto unicast diretto "al telefono" arrivato da un peer non sarebbe mai riconoscibile come tale se il telefono si presentasse con identità diverse a peer diversi. */
let relaySessionNodeId = null;
let seenCache = null;
let pendingQueue = null;
/** Map<deviceId, { peerNodeId: string|null, reassembler: FragmentReassembler, identifyResolvers: {resolve,reject}|null }> — una entry per ogni connessione, riservata (vedi handleScanResult()) prima ancora che plugin.connect() sia stato chiamato, per evitare una doppia connessione allo stesso device da due risultati di scansione ravvicinati. */
let connections = new Map();
let scanRefreshTimer = null;
/** `setTimeout` handles for an in-flight `tryBleSosBurst()`'s scheduled repeats (voce #65) — tracked so `deactivateRelay()` can cancel them, same discipline `node.ts`'s `pendingBeaconRepeats` already applies for the exact same reason: without this, a repeat could still fire after the relay (and its connections) has already been torn down. */
let pendingSosTimers = new Set();

/**
 * Contatori di attività relay (pezzo 3, `docs/security.md` voce successiva) — quanti pacchetti
 * *altrui* questo telefono ha inoltrato per categoria, mai il contenuto stesso. Vincolo esplicito
 * dell'utente: "mostra soltanto contenuti destinati a visione pubblica ... anche per SOS mostra solo
 * numero di contenuti relayati, non il contenuto vero e proprio". Popolati solo in
 * `handleNotification()`, solo per pacchetti classificati da `window.AraldBleRelay.classifyRelayedPacket()`
 * (allowlist — vedi quel commento) — mai per un SOS originato da questo stesso telefono
 * (`tryBleSosBurst()` non tocca questi contatori: è origine, non relay-di-terzi, già
 * visibile altrove nell'UI tramite lo stato del pannello SOS). Azzerati a ogni attivazione del relay
 * (`activateRelay()`), stessa vita di `seenCache`/`pendingQueue` — nessuna persistenza tra sessioni.
 */
let relayActivityDrops = 0;
let relayActivitySos = 0;
/** Map<canale, conteggio> — un canale mai visto in questa sessione semplicemente non compare, niente voce a zero da popolare in anticipo. */
let relayActivityChannels = new Map();

/**
 * Tetto sul numero di canali distinti tracciati per sessione (trovato mancante dalla revisione):
 * `relayActivityChannels` è alimentata da `payload.metadata.name`, un campo del pacchetto — mai
 * fidato quanto il tipo dichiarato (stessa convenzione di CLAUDE.md già rispettata da `SeenCache`/
 * `PendingRelayQueue` in questo stesso file, entrambe bounded). Senza un tetto, un peer connesso
 * potrebbe trasmettere un flusso di `CONTENT_ANNOUNCE` con nomi canale distinti ma validi
 * (`chat:<1-32 char da [a-z0-9_-]>`, uno spazio enorme) durante una sessione di relay lunga (es. un
 * dispiegamento sul campo di ore), facendo crescere questa mappa senza limite — la stessa classe di
 * bug che `SeenCache`/`PendingRelayQueue` esistono già per evitare in questo file.
 */
const MAX_RELAY_ACTIVITY_CHANNELS = 256;

/**
 * Incrementa il contatore di un canale, con la stessa eviction FIFO semplice già usata da
 * `SeenCache.markSeen()` sopra (nessuna informazione di fiducia disponibile qui, stesso motivo per
 * cui `SeenCache` stessa non ne ha una) quando si raggiunge `MAX_RELAY_ACTIVITY_CHANNELS`: il canale
 * osservato per primo in questa sessione lascia spazio al più recente, mai il contrario.
 */
function recordChannelActivity(channel) {
  if (!relayActivityChannels.has(channel) && relayActivityChannels.size >= MAX_RELAY_ACTIVITY_CHANNELS) {
    const oldestKey = relayActivityChannels.keys().next().value;
    relayActivityChannels.delete(oldestKey);
  }
  relayActivityChannels.set(channel, (relayActivityChannels.get(channel) ?? 0) + 1);
}

/**
 * Non un'identità crittografica (nessuna chiave Ed25519) — una etichetta usa-e-getta per l'intera
 * sessione di relay, rigenerata solo quando il relay viene riattivato, usata solo per instradare
 * pacchetti altrui (mai per firmare nulla). Distinta deliberatamente dall'identità Ed25519 vera e
 * persistente usata per originare un SOS (`window.AraldBleIdentity.loadOrCreateIdentity()`, voce
 * #64) — vedi il commento di intestazione di questo file per la spiegazione completa di perché
 * coesistono due identità diverse.
 */
function newRelaySessionNodeId() {
  return `phone-${window.AraldBleLink.randomUUID()}`;
}

function bleRelayPlugin() {
  return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BluetoothLe;
}

function setBleRelayStatus(text, isError) {
  const status = document.getElementById("ble-relay-status");
  if (!status) return;
  status.classList.toggle("error", Boolean(isError));
  status.textContent = text;
}

/**
 * Riflette lo stato della coda SOS persistente (`window.AraldSosQueue`, `sos-queue.js`) sull'interfaccia:
 * un piccolo punto rosso su `#sos-button` (visibile anche a pannello chiuso — trovato necessario, non un
 * dettaglio solo del pannello: l'utente deve accorgersi che un SOS è ancora in attesa senza doverlo
 * riaprire) più il blocco informativo `#sos-pending` dentro il pannello stesso. Chiamata da ogni punto
 * che può cambiare lo stato della coda (dopo un `savePendingSos()`/`clearPendingSos()`, all'apertura
 * del pannello, al caricamento dello script) — mai da un timer proprio, coerente con la scadenza pigra
 * di `sos-queue.js`'s `loadPendingSos()` che questa funzione stessa invoca.
 */
function renderPendingSosUi() {
  const button = document.getElementById("sos-button");
  if (!button || typeof window.AraldSosQueue === "undefined") return;
  const pending = window.AraldSosQueue.loadPendingSos();
  button.classList.toggle("has-pending", Boolean(pending));

  const block = document.getElementById("sos-pending");
  if (!block) return;
  block.hidden = !pending;
  if (pending) document.getElementById("sos-pending-since").textContent = timeAgo(pending.queuedAt);
}

function renderRelayPeers() {
  const list = document.getElementById("ble-relay-peers");
  if (!list) return;
  list.textContent = "";
  const identified = [...connections.values()].filter((conn) => conn.peerNodeId !== null);
  if (identified.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = relayActive ? "In cerca di dispositivi nelle vicinanze..." : "";
    list.append(li);
    return;
  }
  for (const conn of identified) {
    const li = document.createElement("li");
    li.textContent = conn.peerNodeId;
    list.append(li);
  }
}

/** Aggiorna i due contatori semplici (Bacheca/SOS) — O(1), separata dalla lista canali sotto (trovato dalla revisione: le due cose hanno un costo molto diverso, non vale la pena accoppiarle). */
function renderRelayActivityCounts() {
  const dropsEl = document.getElementById("ble-relay-activity-drops");
  const sosEl = document.getElementById("ble-relay-activity-sos");
  if (dropsEl) dropsEl.textContent = String(relayActivityDrops);
  if (sosEl) sosEl.textContent = String(relayActivitySos);
}

/**
 * Svuota e ricostruisce l'elenco canali — stesso schema di `renderRelayPeers()`, mai un aggiornamento
 * incrementale del DOM. Separata da `renderRelayActivityCounts()` perché molto più costosa (fino a
 * `MAX_RELAY_ACTIVITY_CHANNELS` elementi, ordinamento incluso): chiamata solo quando l'insieme dei
 * canali può davvero essere cambiato (un pacchetto canale relayato, o un reset), mai per ogni singolo
 * drop/SOS relayato — trovato dalla revisione: prima di questa voce, ogni pacchetto qualunque
 * ricostruiva anche questa lista, un costo reale su un telefono che relaya per ore.
 */
function renderRelayActivityChannels() {
  const channelsEl = document.getElementById("ble-relay-activity-channels");
  if (!channelsEl) return;

  channelsEl.textContent = "";
  const channels = [...relayActivityChannels.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (channels.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Nessuno";
    channelsEl.append(li);
    return;
  }
  for (const [channel, count] of channels) {
    const li = document.createElement("li");
    li.textContent = `${channel}: ${count}`;
    channelsEl.append(li);
  }
}

/**
 * Renderizza l'intero blocco "Attività relay" (contatori + elenco canali) — usata solo sui reset
 * (`activateRelay()`/`deactivateRelay()`), dove tutto è comunque azzerato insieme. Mostra sempre e solo
 * un numero/nome canale per categoria (mai un elenco di contenuti) — l'unico modo in cui questo blocco
 * potrebbe mostrare qualcosa di privato è se `relayActivity*` lo contenesse già, e quei contatori non lo
 * contengono mai per costruzione (vedi il commento su `classifyRelayedPacket()` in ble-relay.js).
 */
function renderRelayActivity() {
  renderRelayActivityCounts();
  renderRelayActivityChannels();
}

function findConnectionByPeerNodeId(peerNodeId) {
  for (const [deviceId, conn] of connections) {
    if (conn.peerNodeId === peerNodeId) return { deviceId, conn };
  }
  return null;
}

/** Scrive un pacchetto già frammentato sulla caratteristica di scrittura di un peer — stessa funzione della voce #62, invariata. */
async function sendFragmentedPacket(plugin, deviceId, packet) {
  const fragments = window.AraldBleLink.fragmentPacket(packet, BLE_MTU);
  for (const fragment of fragments) {
    await plugin.write({
      deviceId,
      service: RELAY_SERVICE_UUID,
      characteristic: RELAY_WRITE_CHARACTERISTIC_UUID,
      value: window.AraldBleLink.bytesToBase64(fragment),
    });
  }
}

/**
 * Invia le entry in coda destinate esattamente al peer appena identificato — chiamata subito dopo
 * l'handshake di ogni nuova connessione. Se l'invio di una singola entry fallisce, la rimette in
 * coda invece di perderla silenziosamente (stesso spirito di requeue() in ble-relay.js).
 */
function flushPendingFor(plugin, deviceId, peerNodeId) {
  if (!pendingQueue) return;
  for (const entry of pendingQueue.drainFor(peerNodeId)) {
    sendFragmentedPacket(plugin, deviceId, entry.packet).catch(() => {
      pendingQueue.requeue(entry);
    });
  }
}

/**
 * Decide cosa fare di un pacchetto già identificato come "da inoltrare" (decideForward() lo ha già
 * decrementato di TTL) — mai chiamata per un pacchetto duplicato o già a destinazione, quello lo
 * decide decideForward() stesso. Pacchetto unicast → al peer connesso corrispondente se c'è,
 * altrimenti in coda; pacchetto broadcast → a ogni altro peer connesso e identificato (mai a quello
 * da cui è arrivato — floodExcept(), stesso principio di routing.ts lato mesh).
 */
function forwardPacket(plugin, fromDeviceId, packet) {
  if (packet.destination !== undefined) {
    const target = findConnectionByPeerNodeId(packet.destination);
    if (target) {
      // Se l'invio fallisce (link congestionato, scrittura GATT respinta — guasti reali comuni sul
      // BLE), la connessione al peer potrebbe restare comunque valida: la stessa logica di
      // floodExcept() lato mesh (node.ts) ricade sulla coda invece di perdere il pacchetto per
      // sempre, trovato mancante qui dalla revisione.
      sendFragmentedPacket(plugin, target.deviceId, packet).catch(() => {
        if (pendingQueue) pendingQueue.enqueue(packet, fromDeviceId);
      });
    } else if (pendingQueue) {
      pendingQueue.enqueue(packet, fromDeviceId);
    }
    return;
  }
  for (const [deviceId, conn] of connections) {
    if (deviceId === fromDeviceId || conn.peerNodeId === null) continue;
    sendFragmentedPacket(plugin, deviceId, packet).catch(() => {});
  }
}

/**
 * Il canale Bluetooth della coda SOS persistente, lato "scoperta di un peer" (docs/next-steps.md,
 * voci #106/#107) — chiamata da `handleNotification()` ogni volta che un nuovo peer (`deviceId`)
 * completa l'identificazione (HELLO ricevuto) mentre il relay è attivo, cioè esattamente il momento
 * "il telefono incrocia un dispositivo ARALD" descritto lì. Se c'è un SOS in attesa (sopravvissuto
 * anche a un riavvio dell'app — `window.AraldSosQueue.loadPendingSos()` legge da `localStorage`,
 * scadenza pigra inclusa), tenta di consegnarlo.
 *
 * **La coda viene svuotata e il successo riportato solo dopo una scrittura GATT realmente riuscita
 * verso `deviceId`** (trovato dalla revisione: la prima versione chiamava `forwardPacket()`, sempre
 * fire-and-forget per il ramo broadcast — `.catch(() => {})` — e dichiarava "trasmesso" subito dopo,
 * perdendo per sempre l'unica copia in coda anche se quella scrittura falliva per davvero, un guasto
 * comune su BLE reale — link caduto a metà, radio occupata). Se la scrittura fallisce, l'SOS resta in
 * coda invece di sparire, ritentato al prossimo peer identificato. Solo dopo quel successo si prova
 * anche a inoltrarlo, come bonus best-effort mai atteso (coerente con `forwardPacket()` broadcast
 * altrove in questo file), a ogni *altro* peer già identificato — `deviceId` passato come
 * `fromDeviceId` così non viene scritto una seconda volta sullo stesso device appena servito.
 *
 * `window.AraldSosQueue.claimSosSuccess(packetId)` è l'arbitro condiviso con ogni altro canale (il
 * burst Bluetooth immediato di `sendSos()`, il canale gateway di `tryGatewaySosChannel()`/
 * `tryFlushPendingSosViaGateway()`, voce #107): restituisce `false` se un altro canale ha già
 * consegnato e segnalato questo stesso SOS nel frattempo (stesso pacchetto, id confrontato), nel qual
 * caso questa funzione non deve ripetere la segnalazione (attività/toast/vibrazione) — trovato
 * necessario con un solo canale (#106), ancora più rilevante ora che sono più di uno.
 *
 * `seenCache.markSeen()` è ripetuto qui anche se il tentativo originale lo aveva già fatto: se l'app è
 * stata chiusa e riaperta nel frattempo, `seenCache` è un'istanza nuova (azzerata a ogni
 * `activateRelay()`, mai persistita) e non conterrebbe ancora l'id di questo pacchetto — ripeterlo è
 * idempotente (`SeenCache.markSeen()`, ble-relay.js) e garantisce che il pacchetto non venga
 * ri-processato se mai rimbalzasse indietro da un peer che lo relaya a sua volta.
 */
async function tryFlushPendingSos(plugin, deviceId) {
  if (typeof window.AraldSosQueue === "undefined") return; // modulo non caricato — guardia difensiva, stesso schema di renderPendingSosUi()
  const pending = window.AraldSosQueue.loadPendingSos();
  if (!pending) return;

  seenCache.markSeen(pending.packet.id);
  try {
    await sendFragmentedPacket(plugin, deviceId, pending.packet);
  } catch {
    return; // non consegnato — resta in coda, ritentato al prossimo peer identificato
  }
  forwardPacket(plugin, deviceId, pending.packet);

  if (!window.AraldSosQueue.claimSosSuccess(pending.packet.id)) return; // un altro canale lo ha già consegnato/segnalato nel frattempo
  renderPendingSosUi();
  recordActivity("sos", undefined, "sent");
  showToast("SOS trasmesso", "alert-circle");
  vibrate([30, 50, 30, 50, 30]);
}

/**
 * Gestore delle notifiche di UNA connessione — persistente per tutta la vita della connessione
 * (a differenza della voce #62, dove smetteva di ascoltare dopo l'HELLO): prima dell'identificazione
 * accetta solo un HELLO (che identifica il peer, mai inoltrato oltre — è locale alla connessione,
 * stesso trattamento di TTL=1 già riservato a HELLO lato mesh); dopo, ogni pacchetto passa da
 * decideForward() e viene eventualmente inoltrato.
 *
 * `conn.peerNodeId` viene impostato SINCRONAMENTE qui dentro, non dopo un `await` in connectToPeer()
 * — se fosse impostato più tardi (dopo che la promise di identificazione si risolve) esisterebbe una
 * finestra in cui un secondo pacchetto arrivato molto in fretta dopo l'HELLO troverebbe ancora
 * `peerNodeId === null` e verrebbe scartato come se fosse pre-identificazione.
 */
function handleNotification(plugin, deviceId, event) {
  const conn = connections.get(deviceId);
  if (!conn) return; // connessione già smontata — evento residuo, ignoralo

  let packet;
  try {
    const bytes = window.AraldBleLink.base64ToBytes(event.value);
    const reassembled = conn.reassembler.addFragment(bytes);
    if (!reassembled) return;
    packet = window.AraldBleLink.decodePacket(reassembled);
  } catch {
    return; // malformato — non fidarsi mai, stessa postura di ogni altro handler di questo progetto
  }

  if (conn.peerNodeId === null) {
    if (packet.type === "HELLO" && conn.identifyResolvers) {
      conn.peerNodeId = packet.source;
      conn.identifyResolvers.resolve(packet.source);
      conn.identifyResolvers = null;
      // Coda SOS persistente (docs/next-steps.md) — proprio il momento "il telefono incrocia un
      // dispositivo". Mai attesa qui: handleNotification() è un callback sincrono del plugin, stesso
      // trattamento fire-and-forget già riservato a ogni altra chiamata asincrona in questo file; gli
      // errori restano comunque contenuti dentro tryFlushPendingSos() stessa (mai un rifiuto non gestito).
      tryFlushPendingSos(plugin, deviceId).catch(() => {});
    }
    return; // qualunque altra cosa prima dell'identificazione viene ignorata
  }

  const decision = window.AraldBleRelay.decideForward(packet, relaySessionNodeId, seenCache);
  if (decision.duplicate || !decision.forwardPacket) return;

  // Conta *cosa* passa (pezzo 3), mai il contenuto — vedi il commento su classifyRelayedPacket() in
  // ble-relay.js per la postura allowlist. Solo per pacchetti altrui: questa funzione gestisce
  // esclusivamente notifiche in arrivo da una connessione, mai un SOS che questo telefono origina
  // (quello passa da tryBleSosBurst() -> forwardPacket() direttamente, senza mai
  // transitare da qui).
  const classification = window.AraldBleRelay.classifyRelayedPacket(decision.forwardPacket);
  if (classification) {
    if (classification.kind === "drop") relayActivityDrops += 1;
    else if (classification.kind === "sos") relayActivitySos += 1;
    else if (classification.kind === "channel") recordChannelActivity(classification.channel);
    renderRelayActivityCounts();
    // La lista canali (fino a MAX_RELAY_ACTIVITY_CHANNELS elementi, con ordinamento) è molto più
    // costosa dei due contatori sopra — ricostruita solo quando l'insieme dei canali può davvero
    // essere cambiato, mai per un drop/SOS relayato (trovato dalla revisione).
    if (classification.kind === "channel") renderRelayActivityChannels();
  }

  forwardPacket(plugin, deviceId, decision.forwardPacket);
}

/** Riserva una entry nella mappa delle connessioni PRIMA di qualunque await — vedi la nota nel commento di `connections` sopra sul perché è necessario farlo sincronamente. */
function reserveConnectionSlot(deviceId) {
  const entry = { peerNodeId: null, reassembler: new window.AraldBleLink.FragmentReassembler(), identifyResolvers: null };
  connections.set(deviceId, entry);
  return entry;
}

/**
 * Smonta una connessione riservata/aperta che non è mai arrivata a un'identificazione riuscita (o
 * che il chiamante ha comunque deciso di abbandonare).
 *
 * `conn` è l'oggetto riservato al momento della connessione (non solo il `deviceId`) — un secondo
 * controllo di identità oltre al `sessionId` già verificato da `connectToPeer()`, trovato ancora
 * mancante dalla revisione: un tentativo scaduto (sessione precedente, mai riuscito a connettersi in
 * tempo) può risolversi *dopo* che una scansione della sessione nuova ha già ri-scoperto lo stesso
 * `deviceId` fisico e stabilito una connessione reale e valida su quello slot. Senza questo
 * controllo, il cleanup del tentativo vecchio cancellerebbe dalla mappa `connections` — e
 * disconnetterebbe a livello nativo — la connessione nuova e legittima, solo perché condivide lo
 * stesso `deviceId`. `connections.get(deviceId) === conn` è vero solo se questo è ancora lo slot
 * "corrente" per quel device; se non lo è più, questa chiamata non tocca né la mappa né la
 * connessione nativa — quel device è già gestito da un tentativo più recente.
 */
async function cleanupConnection(plugin, deviceId, conn) {
  if (connections.get(deviceId) !== conn) return;
  connections.delete(deviceId);
  try {
    await plugin.stopNotifications({ deviceId, service: RELAY_SERVICE_UUID, characteristic: RELAY_NOTIFY_CHARACTERISTIC_UUID });
  } catch {
    // best-effort
  }
  try {
    await plugin.disconnect({ deviceId });
  } catch {
    // best-effort
  }
  renderRelayPeers();
}

/** Chiamata dal plugin quando una connessione cade inaspettatamente — stessa guardia di identità di cleanupConnection() (un callback legato a un tentativo di connessione ormai superato non deve mai cancellare lo slot di una connessione più recente sullo stesso deviceId). Il link nativo di *questa* connessione è già morto, nessun bisogno di richiamare stopNotifications()/disconnect() su di esso. */
function handlePeerDisconnected(deviceId, conn) {
  if (connections.get(deviceId) !== conn) return;
  connections.delete(deviceId);
  renderRelayPeers();
}

/**
 * Errore sentinella usato solo per abortire un `connectToPeer()` la cui sessione di relay è stata
 * disattivata mentre era in corso — mai mostrato all'utente (chi chiama `.catch(() => {})` su
 * `connectToPeer()` lo ignora comunque), serve solo a far scattare `cleanupConnection()` invece di
 * lasciare una connessione nativa appesa. Vedi `connectToPeer()`'s controlli su `sessionId`.
 */
class RelaySessionEndedError extends Error {}

/**
 * Connette un device già riservato in `connections` (via reserveConnectionSlot()): connect ->
 * sottoscrizione notifiche persistente -> invio del proprio HELLO -> attesa dell'HELLO del peer.
 * Ordine handshake e cleanup-su-fallimento: stessa disciplina già stabilita nella voce #62 (invio
 * indipendente, mai gated su sentire l'altro lato prima — altrimenti deadlock).
 *
 * `plugin.connect()` vive DENTRO il try/catch (non prima, come in una prima versione corretta dalla
 * revisione) — altrimenti un fallimento del connect stesso (il caso più comune di tutti: il
 * dispositivo è uscito dal raggio tra la scansione e il tentativo, radio occupata, timeout nativo)
 * saltava `cleanupConnection()` per intero, lasciando lo slot riservato in `connections` per sempre
 * — occupando per sempre un posto su `MAX_CONNECTIONS` senza mai una connessione reale dietro.
 *
 * `sessionId` (catturato da `handleScanResult()` al momento della riserva dello slot) è controllato
 * dopo ogni `await`: se il relay è stato disattivato/riattivato nel frattempo (`relaySessionId` è
 * cambiato — vedi `deactivateRelay()`), questa funzione abortisce invece di continuare a operare su
 * stato di sessione ormai stale (`relaySessionNodeId`/`pendingQueue` potrebbero essere già stati
 * azzerati) — trovato dalla revisione: senza questo controllo, una connessione ancora in corso al
 * momento della disattivazione poteva sopravvivere al `connections.clear()` di
 * `deactivateRelay()` (invisibile lì, quindi mai smontata da quel ciclo) e più tardi inviare un
 * HELLO con `source: null`.
 */
async function connectToPeer(plugin, deviceId, sessionId) {
  const conn = connections.get(deviceId);
  if (!conn) return; // lo slot è stato rimosso nel frattempo — nulla da fare

  try {
    await plugin.connect({ deviceId }, () => handlePeerDisconnected(deviceId, conn));
    if (sessionId !== relaySessionId) throw new RelaySessionEndedError();

    await plugin.startNotifications(
      { deviceId, service: RELAY_SERVICE_UUID, characteristic: RELAY_NOTIFY_CHARACTERISTIC_UUID },
      (event) => handleNotification(plugin, deviceId, event),
    );
    if (sessionId !== relaySessionId) throw new RelaySessionEndedError();

    const peerNodeId = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.identifyResolvers = null;
        reject(new Error("nessuna risposta HELLO in tempo"));
      }, HELLO_TIMEOUT_MS);
      conn.identifyResolvers = {
        resolve: (id) => {
          clearTimeout(timer);
          resolve(id);
        },
        reject: (err) => {
          clearTimeout(timer);
          conn.identifyResolvers = null;
          reject(err);
        },
      };
      sendFragmentedPacket(plugin, deviceId, window.AraldBleLink.createHello(relaySessionNodeId)).catch((err) => {
        if (conn.identifyResolvers) conn.identifyResolvers.reject(err);
      });
    });
    if (sessionId !== relaySessionId) throw new RelaySessionEndedError();

    flushPendingFor(plugin, deviceId, peerNodeId);
    renderRelayPeers();
  } catch (err) {
    await cleanupConnection(plugin, deviceId, conn);
    throw err;
  }
}

/** Chiamata per ogni risultato di scansione — connette al device solo se il relay è ancora attivo, non è già (in via di) connessione, e c'è capacità libera. Riserva sincronamente lo slot prima di qualunque await, così due risultati di scansione ravvicinati per lo stesso device non possano mai avviare due tentativi di connessione paralleli. */
function handleScanResult(plugin, sessionId, result) {
  if (!relayActive || sessionId !== relaySessionId) return;
  const deviceId = result.device.deviceId;
  if (connections.has(deviceId)) return;
  if (connections.size >= MAX_CONNECTIONS) return;
  reserveConnectionSlot(deviceId);
  renderRelayPeers();
  connectToPeer(plugin, deviceId, sessionId).catch(() => {
    // connectToPeer()/cleanupConnection() hanno già ripulito lo slot in caso di fallimento — una
    // futura scansione può ritentare naturalmente, nessun'altra azione richiesta qui.
  });
}

/**
 * Emette una scansione per `sessionId`. Controlla `relaySessionId` subito dopo l'unico `await`
 * prima della vera e propria `requestLEScan()` — trovato mancante dalla revisione (nonostante il
 * commento su `relaySessionId` lo dichiarasse già fatto): senza questo controllo, una chiamata
 * ormai superata (es. il refresh periodico di una sessione appena disattivata) poteva comunque
 * eseguire `requestLEScan()` *dopo* che la sessione nuova aveva già registrato la propria
 * scansione, sovrascrivendola con un callback legato alla sessione vecchia — ogni risultato futuro
 * sarebbe arrivato con un `sessionId` scartato da `handleScanResult()`, lasciando la sessione nuova
 * silenziosamente senza scoperta di nuovi peer fino al refresh periodico successivo.
 */
async function issueScan(plugin, sessionId) {
  try {
    await plugin.stopLEScan();
  } catch {
    // best-effort — va bene anche se non c'era nulla in corso
  }
  if (sessionId !== relaySessionId) return; // sessione già superata — non registrare una scansione che nessuno ascolterebbe più
  try {
    await plugin.requestLEScan({ services: [RELAY_SERVICE_UUID] }, (result) => handleScanResult(plugin, sessionId, result));
  } catch {
    // la scansione non è partita — il refresh periodico sotto ritenterà
  }
}

async function activateRelay() {
  const plugin = bleRelayPlugin();
  if (!plugin) throw new Error("Bluetooth non disponibile su questo dispositivo.");

  relaySessionId += 1;
  const sessionId = relaySessionId;
  relaySessionNodeId = newRelaySessionNodeId();
  seenCache = new window.AraldBleRelay.SeenCache();
  pendingQueue = new window.AraldBleRelay.PendingRelayQueue();
  connections = new Map();
  relayActive = true;
  // Azzerati ad ogni (ri)attivazione — stessa vita di seenCache/pendingQueue sopra, mai persistenti tra sessioni.
  relayActivityDrops = 0;
  relayActivitySos = 0;
  relayActivityChannels = new Map();
  renderRelayActivity();

  try {
    await plugin.initialize();
  } catch (err) {
    // Trovato dalla revisione: senza questo, un fallimento qui (Bluetooth spento, permesso negato)
    // lasciava `relayActive` bloccato a true per sempre — non solo il gestore del toggle (che aveva
    // già il proprio reset ridondante, ora rimosso) ma anche `tryBleSosBurst()` (che non
    // ce l'aveva affatto) avrebbero poi saltato una riattivazione reale a ogni chiamata successiva,
    // inviando su una `connections` map vuota e riportando un falso successo. Il reset vive qui, non
    // in ogni singolo chiamante, così ogni chiamante presente e futuro lo eredita gratis.
    if (sessionId === relaySessionId) relayActive = false;
    throw err;
  }
  if (sessionId !== relaySessionId) return; // disattivato/riattivato mentre initialize() era in corso — non avviare una scansione per una sessione già superata
  await issueScan(plugin, sessionId);
  scanRefreshTimer = setInterval(() => {
    if (relayActive && sessionId === relaySessionId) issueScan(plugin, sessionId);
  }, SCAN_REFRESH_INTERVAL_MS);
}

/**
 * `sessionId` catturato subito dopo l'incremento di `relaySessionId` sopra — stesso schema già
 * usato da `activateRelay()`/`connectToPeer()`/`issueScan()`. Trovato mancante dalla revisione:
 * prima di questa voce (#64) `deactivateRelay()` era l'unica funzione a scrivere su stato condiviso
 * (`connections`/`seenCache`/`pendingQueue`/`relaySessionNodeId`) senza mai controllare la propria
 * sessione — innocuo finché `activateRelay()` aveva un solo chiamante sincronizzato (il gestore del
 * toggle, disabilitato mentre in corso). `tryBleSosBurst()` è un secondo chiamante di
 * `activateRelay()` non protetto da quello stesso mutex: se l'utente disattiva il relay e poi preme
 * SOS mentre `deactivateRelay()` è ancora a metà dei propri `await` di disconnessione,
 * `tryBleSosBurst()` può far ripartire una nuova sessione (nuovo `connections`/
 * `seenCache`/ecc.) *prima* che la vecchia `deactivateRelay()` raggiunga la propria coda — che,
 * senza questo controllo, cancellerebbe/azzererebbe lo stato della sessione nuova e già viva, non
 * più quello della sessione vecchia a cui si riferiva.
 */
async function deactivateRelay() {
  relayActive = false;
  relaySessionId += 1; // invalida qualunque connectToPeer()/handleScanResult() ancora in corso per la sessione precedente
  const sessionId = relaySessionId;
  if (scanRefreshTimer) {
    clearInterval(scanRefreshTimer);
    scanRefreshTimer = null;
  }
  for (const timer of pendingSosTimers) clearTimeout(timer);
  pendingSosTimers.clear();

  const plugin = bleRelayPlugin();
  if (plugin) {
    try {
      await plugin.stopLEScan();
    } catch {
      // best-effort
    }
    // Snapshot preso qui, prima di qualunque await del loop — sono comunque i device della sessione
    // che questa chiamata sta smontando, indipendentemente da cosa succede a `connections` nel
    // frattempo; disconnetterli a livello nativo resta corretto anche se una sessione più recente è
    // nel frattempo partita.
    for (const deviceId of [...connections.keys()]) {
      try {
        await plugin.stopNotifications({ deviceId, service: RELAY_SERVICE_UUID, characteristic: RELAY_NOTIFY_CHARACTERISTIC_UUID });
      } catch {
        // best-effort
      }
      try {
        await plugin.disconnect({ deviceId });
      } catch {
        // best-effort
      }
    }
  }

  if (sessionId !== relaySessionId) return; // una sessione più recente è già partita (es. tryBleSosBurst() ha riattivato) — non toccare il suo stato live
  connections.clear();
  seenCache = null;
  pendingQueue = null;
  relaySessionNodeId = null;
  relayActivityDrops = 0;
  relayActivitySos = 0;
  relayActivityChannels = new Map();
  renderRelayActivity();
}

/**
 * Canale Bluetooth della coda SOS persistente — il burst immediato ripetuto `SOS_BROADCAST_REPEAT_COUNT`
 * volte ogni `SOS_BROADCAST_REPEAT_INTERVAL_MS` (stessi valori di `DEFAULT_BEACON_BROADCAST_REPEAT_COUNT`/
 * `_INTERVAL_MS` lato Node) verso ogni peer Bluetooth connesso e identificato, riusando `forwardPacket()`
 * col suo stesso percorso broadcast — `fromDeviceId` impostato a un sentinella che non combacia mai con
 * un vero deviceId così nessun peer viene escluso. Un broadcast non connesso non ha canale di risposta,
 * "ripeti, non fingere un ACK", stessa reasoning già accettata per `sendEmergencyBeacon()` lato Node;
 * questo cattura anche un peer che si connette nei secondi immediatamente successivi al tap, perché ogni
 * ripetizione ricalcola `connections` al momento dell'invio, non una sola volta all'inizio.
 *
 * Attiva il relay Bluetooth se non è già attivo (un SOS non deve richiedere all'utente di averlo già
 * acceso come passo separato) — se il plugin non è disponibile o l'attivazione fallisce, risolve a
 * `false` invece di lanciare: è solo *uno* dei canali che `sendSos()` fa correre in parallelo, un suo
 * fallimento non deve mai interrompere l'altro.
 *
 * Risolve a `true` solo se, al termine del burst, esiste almeno un peer già connesso e identificato
 * (`conn.peerNodeId !== null`) — **nota di onestà**: questo è "un peer era identificato", non "la
 * scrittura è riuscita per davvero" (a differenza di `tryFlushPendingSos()`, che invece attende l'esito
 * reale di ogni singola scrittura GATT verso un peer appena incrociato) — stesso standard "nessun vero
 * ack, mai fingerne uno" già accettato per il burst immediato prima che esistesse una coda persistente,
 * non irrobustito qui per restare nello scope della voce che introduce il canale gateway (#107), non
 * una revisione del burst immediato pre-esistente.
 */
async function tryBleSosBurst(packet) {
  const plugin = bleRelayPlugin();
  if (!plugin) return false;
  if (!relayActive) {
    try {
      await activateRelay();
    } catch {
      return false;
    }
  }
  if (!relayActive) return false; // activateRelay() può essere stato superato da una disattivazione nel frattempo
  seenCache.markSeen(packet.id);

  const sessionId = relaySessionId;
  const sendOnce = () => {
    if (!relayActive || sessionId !== relaySessionId) return; // relay disattivato/riattivato nel frattempo — non un errore, solo nessun'altra ripetizione ha senso
    forwardPacket(plugin, "__sos_origin__", packet);
  };
  sendOnce();
  for (let i = 1; i < SOS_BROADCAST_REPEAT_COUNT; i++) {
    const timer = setTimeout(() => {
      pendingSosTimers.delete(timer);
      sendOnce();
    }, i * SOS_BROADCAST_REPEAT_INTERVAL_MS);
    pendingSosTimers.add(timer);
  }

  // Attende l'ultima ripetizione prima di risolvere — non un ack di consegna reale (non esiste in un
  // broadcast non connesso), solo "ho finito di provare".
  await new Promise((resolve) => setTimeout(resolve, (SOS_BROADCAST_REPEAT_COUNT - 1) * SOS_BROADCAST_REPEAT_INTERVAL_MS));
  return [...connections.values()].some((conn) => conn.peerNodeId !== null);
}

/**
 * Guardia di rientranza condivisa per il canale gateway (trovato dalla revisione) — a differenza del
 * canale Bluetooth (deduplicato lato mesh dallo stesso `packet.id` via `SeenCache`), ogni chiamata a
 * `node.sendEmergencyBeacon()` lato server costruisce un SOS firmato *nuovo e distinto* (nuovo
 * `contentId`/timestamp): due richieste sovrapposte per lo stesso SOS in coda pubblicherebbero due
 * sighting reali e separati per la stessa emergenza (oltre a consumare due unità del budget anti-flood
 * `MAX_EMERGENCY_BEACON_PER_WINDOW` per un solo tap), anche se `claimSosSuccess()` evita comunque un
 * secondo *report* lato UI — il problema è a monte, non solo nella notifica. Scenario reale: `sendSos()`
 * avvia `tryGatewaySosChannel()`, e prima che quella risposta arrivi (gateway lento, non il timeout)
 * `app.js`'s `refreshAll()` (ogni 5s) chiama `tryFlushPendingSosViaGateway()` per lo stesso SOS ancora
 * in coda — stessa classe di bug già risolta per `node.ts`'s `attemptExternalDeliveries()`/
 * `externalDeliveryAttemptInFlight` (voce #70, `CLAUDE.md`), riproposta qui per il canale gateway.
 * Un secondo chiamante mentre una richiesta è già in corso ne attende semplicemente l'esito invece di
 * avviarne una propria — corretto perché, finché la coda ha un solo slot, due chiamate sovrapposte sono
 * sempre per lo stesso SOS in attesa.
 */
let gatewaySosAttempt = null;

/**
 * Canale gateway della coda SOS persistente (voce #107, `app.js`'s `trySendEmergencyBeaconViaGateway()`,
 * `node/src/web-ui.ts`'s `POST /api/emergency-beacons`) — se il telefono è appaiato e il gateway è
 * raggiungibile, gli chiede di originare l'SOS con la propria identità. Mai un throw: `false` per
 * qualunque fallimento (nessun gateway appaiato, password errata, rete non raggiungibile, errore del
 * gateway) — è solo *uno* dei canali in corsa in `sendSos()`, il suo fallimento non deve mai impedire
 * all'altro di proseguire né propagarsi come un errore generale dell'invio SOS. Vedi `gatewaySosAttempt`
 * sopra per la guardia di rientranza condivisa con `tryFlushPendingSosViaGateway()`.
 */
async function tryGatewaySosChannel({ message, lat, lon }) {
  if (typeof trySendEmergencyBeaconViaGateway !== "function") return false;
  if (gatewaySosAttempt) {
    return gatewaySosAttempt.then(
      () => true,
      () => false,
    );
  }
  const attempt = trySendEmergencyBeaconViaGateway({ message, lat, lon });
  gatewaySosAttempt = attempt;
  try {
    await attempt;
    return true;
  } catch {
    return false;
  } finally {
    if (gatewaySosAttempt === attempt) gatewaySosAttempt = null;
  }
}

/**
 * Orchestratore della coda SOS persistente, su ogni canale disponibile (docs/next-steps.md, voci
 * #106/#107 — "SOS sempre persistente su ogni canale possibile, il primo che funziona libera l'SOS",
 * richiesta esplicita dell'utente). Non più solo relayare pacchetti altrui (voce #63): il telefono ne
 * origina uno proprio, chiudendo l'asimmetria "relaya ma non origina" — firmato con una vera chiave
 * Ed25519 (`window.AraldBleIdentity.loadOrCreateIdentity()`, a differenza di `relaySessionNodeId`, mai
 * una vera identità), necessario perché `verifyContentSignature()` (lato mesh, `node/src/node.ts`)
 * scarta senza pietà qualunque contenuto non firmato davvero: senza una firma vera un SOS via Bluetooth
 * avrebbe portata zero oltre la bolla locale del telefono (`docs/security.md` voce #65). Il pacchetto
 * Bluetooth viene costruito una sola volta (stesso `packet.id` per ogni ripetizione, stesso motivo di
 * `sendEmergencyBeacon()`/`buildContentAnnouncePacket()` lato Node: `SeenCache` deve riconoscerle come
 * lo stesso evento, non un secondo SOS distinto) — il canale gateway non lo riusa affatto, costruisce la
 * propria richiesta dai soli `message`/`lat`/`lon`, firmata lato server con l'identità del gateway.
 *
 * **Nessun vero rate limiting anti-flood lato client** (a differenza di `MAX_EMERGENCY_BEACON_PER_WINDOW`
 * lato Node, applicato comunque una volta che il canale gateway raggiunge quel `NomadNode`) — dichiarato
 * esplicitamente come limite accettato: un livello client-side non potrebbe comunque impedire a un
 * chiamante determinato di aggirarlo. L'unica protezione qui è di UX (il bottone resta disabilitato
 * durante l'invio, `#sos-button`), non di sicurezza.
 *
 * **Coda SOS persistente**: l'intera voce (pacchetto Bluetooth + `message`/`lat`/`lon` grezzi per un
 * eventuale ritentativo gateway successivo) viene persistita (`window.AraldSosQueue.savePendingSos()`,
 * `localStorage` — sopravvive a una chiusura dell'app) *prima* di far correre i canali, non dopo — così
 * anche un fallimento di entrambi a metà tentativo (relay disattivato nel frattempo, app chiusa) lascia
 * comunque l'SOS in coda invece di perderlo. I due canali corrono in parallelo via `raceFirstSuccess()`
 * — il primo che ha successo "libera" l'SOS (lo rimuove dalla coda); se nessuno dei due riesce ORA,
 * resta in coda: `handleNotification()`/`tryFlushPendingSos()` la trasmetteranno al primo peer Bluetooth
 * futuro, `app.js`'s `tryFlushPendingSosViaGateway()` (agganciata al polling periodico già esistente del
 * gateway) ritenterà quel canale appena il gateway torna raggiungibile — anche minuti o ore dopo, anche
 * dopo un riavvio dell'app.
 *
 * Restituisce una delle tre stringhe che il chiamante (il gestore del bottone SOS) usa per scegliere il
 * testo/stato onesto da mostrare, stesso vocabolario "sent"/"queued" già usato da `recordActivity()` per
 * gli altri invii (app.js):
 * - `"sent"` — consegnato ORA da uno dei due canali, nessun altro lo ha già segnalato nel frattempo.
 * - `"claimed-elsewhere"` — consegnato ORA, ma `window.AraldSosQueue.claimSosSuccess()` ha trovato che
 *   un canale indipendente (`tryFlushPendingSos()` su un nuovo peer Bluetooth, o un ritentativo gateway
 *   periodico) lo aveva già consegnato e segnalato (attività/toast/vibrazione) mentre questa stessa
 *   chiamata era ancora in attesa — trovato dalla revisione (voce #106, rilevante ancora di più con più
 *   di un canale): senza questo controllo il chiamante ripeterebbe una segnalazione già fatta.
 * - `"queued"` — nessun canale ha avuto successo ora, resta in coda.
 */
async function sendSos({ message, lat, lon } = {}) {
  const identity = window.AraldBleIdentity.loadOrCreateIdentity();
  const packet = window.AraldBleSos.buildEmergencyBeaconPacket({ message, lat, lon }, identity);
  window.AraldSosQueue.savePendingSos({ packet, message, lat, lon });
  renderPendingSosUi();

  const won = await window.AraldSosQueue.raceFirstSuccess([tryGatewaySosChannel({ message, lat, lon }), tryBleSosBurst(packet)]);
  if (!won) return "queued";

  if (!window.AraldSosQueue.claimSosSuccess(packet.id)) return "claimed-elsewhere";
  renderPendingSosUi();
  return "sent";
}

/**
 * Ritentativo periodico del canale gateway per un SOS già in coda (voce #107) — chiamata da `app.js`'s
 * `refreshAll()` ogni volta che il suo stesso poll al gateway ha successo, non da un timer proprio:
 * quel successo è di per sé il segnale più economico che il gateway è di nuovo raggiungibile ORA,
 * stessa disciplina "scadenza pigra, mai uno sweep in background" già applicata da `sos-queue.js`
 * all'intera coda. Mai lanciata, mai attesa dal chiamante — un fallimento (ancora nessun gateway, lo
 * stesso errore di prima) non deve mai bloccare il refresh della dashboard.
 *
 * Ricostruisce la richiesta dai soli `message`/`lat`/`lon` persistiti (mai dal pacchetto Bluetooth,
 * che questo canale non riusa — vedi il commento di `sendSos()`). Passa da `tryGatewaySosChannel()`
 * (non direttamente da `trySendEmergencyBeaconViaGateway()`) per condividerne la guardia di rientranza
 * (`gatewaySosAttempt`, vedi il suo commento) — senza questo, una `sendSos()` ancora in attesa della
 * propria chiamata gateway e questo stesso ritentativo periodico potrebbero avviare due richieste HTTP
 * sovrapposte per il medesimo SOS, pubblicando due sighting reali e distinti per una sola emergenza
 * (trovato dalla revisione). Usa lo stesso arbitro condiviso `claimSosSuccess()` di ogni altro canale:
 * se nel frattempo il canale Bluetooth ha già consegnato lo stesso SOS (o un tap più recente lo ha
 * sostituito in coda), questo ritentativo non segnala nulla.
 */
async function tryFlushPendingSosViaGateway() {
  if (typeof window.AraldSosQueue === "undefined") return;
  const pending = window.AraldSosQueue.loadPendingSos();
  if (!pending) return;

  const delivered = await tryGatewaySosChannel({ message: pending.message, lat: pending.lat, lon: pending.lon });
  if (!delivered) return; // ancora irraggiungibile/rifiutato — resta in coda, ritentato al prossimo ciclo

  if (!window.AraldSosQueue.claimSosSuccess(pending.packet.id)) return; // un altro canale lo ha già consegnato/segnalato nel frattempo
  renderPendingSosUi();
  recordActivity("sos", undefined, "sent");
  showToast("SOS trasmesso", "alert-circle");
  vibrate([30, 50, 30, 50, 30]);
}

const bleRelayPanel = document.getElementById("ble-relay-panel");
if (bleRelayPanel) {
  // Feature-gated sulla presenza del plugin, non su una capability del gateway — stesso schema già
  // usato nella voce #62.
  bleRelayPanel.hidden = !bleRelayPlugin();

  document.getElementById("ble-relay-toggle").addEventListener("click", async () => {
    const toggle = document.getElementById("ble-relay-toggle");
    toggle.disabled = true;
    try {
      if (relayActive) {
        await deactivateRelay();
        setBleRelayStatus("Relay Bluetooth disattivato.", false);
        toggle.textContent = "Attiva relay Bluetooth";
        toggle.setAttribute("aria-pressed", "false");
      } else {
        await activateRelay();
        setBleRelayStatus("Relay Bluetooth attivo — in cerca di dispositivi nelle vicinanze...", false);
        toggle.textContent = "Disattiva relay Bluetooth";
        toggle.setAttribute("aria-pressed", "true");
        vibrate(15);
        showToast("Relay Bluetooth attivo", "wifi");
      }
      renderRelayPeers();
    } catch (err) {
      // Nessun reset di relayActive qui — activateRelay() lo fa già da sé su un proprio fallimento
      // (vedi il suo commento), così ogni chiamante (questo gestore e tryBleSosBurst())
      // eredita lo stesso comportamento senza doverlo ripetere.
      setBleRelayStatus("Errore: " + err.message, true);
    } finally {
      toggle.disabled = false;
    }
  });
}

const sosButton = document.getElementById("sos-button");
if (sosButton) {
  // A differenza di #ble-relay-panel sopra (feature-gated sul plugin, un relay Bluetooth non ha senso
  // senza), #sos-button NON è più condizionato alla sola presenza del plugin Bluetooth (voce #107): il
  // canale gateway (`app.js`'s `trySendEmergencyBeaconViaGateway()`) funziona indipendentemente da esso,
  // ed è sempre disponibile qui — questo bottone vive dentro #dashboard-screen, raggiungibile solo dopo
  // il pairing. Nasconderlo quando il plugin manca avrebbe reso l'intera funzione SOS invisibile su
  // qualunque telefono/browser senza quel plugin, anche se il canale gateway avrebbe funzionato da solo
  // (bug reale trovato eseguendo la verifica end-to-end di questa voce, mai da un test automatico: nulla
  // in questo file aveva mai coperto la visibilità condizionale del bottone stesso).
  renderPendingSosUi(); // riflette subito un'eventuale coda SOS sopravvissuta a una chiusura dell'app

  const sosPanel = document.getElementById("sos-panel");
  const sosMessage = document.getElementById("sos-message");
  const sosStatus = document.getElementById("sos-status");
  const sosSend = document.getElementById("sos-send");

  sosButton.addEventListener("click", () => {
    sosPanel.hidden = !sosPanel.hidden;
    if (!sosPanel.hidden) {
      renderPendingSosUi(); // ricontrolla al momento dell'apertura — scadenza pigra, vedi sos-queue.js
      sosMessage.focus();
    }
  });

  document.getElementById("sos-cancel").addEventListener("click", () => {
    sosPanel.hidden = true;
    sosStatus.classList.remove("error");
    sosStatus.textContent = "";
  });

  const sosPendingCancel = document.getElementById("sos-pending-cancel");
  if (sosPendingCancel) {
    sosPendingCancel.addEventListener("click", () => {
      // Nessuna conferma nativa qui (a differenza di #sos-send sotto): annullare un SOS già in coda è
      // un'azione reversibile nel senso che pratica — un nuovo tap su "Invia SOS" lo rimette subito in
      // coda — mentre il bottone di invio vero innesca un broadcast/una richiesta reale, da proteggere
      // con window.confirm().
      window.AraldSosQueue.clearPendingSos();
      renderPendingSosUi();
      showToast("SOS in coda annullato", "x");
    });
  }

  sosSend.addEventListener("click", async () => {
    // Unica conferma nativa — previene un tap accidentale senza aggiungere passi in un'emergenza
    // reale (nessun modulo di conferma custom esiste già in mobile/www/ da riusare, stesso ragionamento
    // già applicato a hub-control.js per Ferma/Riavvia).
    if (!window.confirm("Inviare una richiesta di soccorso (SOS)?")) return;

    sosSend.disabled = true;
    sosStatus.classList.remove("error");
    sosStatus.textContent = "Invio SOS in corso...";
    try {
      // Best-effort: una posizione nota rende il SOS più utile, ma la sua assenza (permesso negato,
      // GPS non disponibile) non deve mai bloccare l'invio — stesso principio già applicato altrove
      // in questo file a ogni altro percorso di geolocalizzazione.
      let lat, lon;
      try {
        const position = await getCurrentPosition();
        lat = position.lat;
        lon = position.lon;
      } catch {
        // nessuna posizione — il SOS parte comunque
      }
      const message = sosMessage.value.trim() || undefined;
      // L'esito di sendSos() distingue onestamente "consegnato ORA da un canale" da "già consegnato e
      // segnalato da un altro canale mentre questo era ancora in attesa" da "rimasto in coda, un canale
      // qualsiasi lo trasmetterà da solo appena disponibile" (coda SOS persistente su ogni canale
      // possibile, docs/next-steps.md voci #106/#107) — mai "consegnato" in senso di conferma end-to-end
      // reale in nessuno dei tre casi, vedi recordActivity()'s own doc comment (app.js) per perché
      // "sent"/"queued" restano le affermazioni oneste più forti possibili qui.
      const outcome = await sendSos({ message, lat, lon });
      sosMessage.value = "";
      renderPendingSosUi();
      if (outcome === "queued") {
        recordActivity("sos", undefined, "queued");
        sosStatus.textContent = "Nessun canale disponibile ora — l'SOS resta in attesa, verrà trasmesso automaticamente appena un gateway o un dispositivo Bluetooth saranno raggiungibili.";
        vibrate([30, 50, 30, 50, 30]);
        showToast("SOS in coda", "alert-circle");
        // Il pannello resta aperto per mostrare lo stato appena scritto in #sos-status invece di
        // nasconderlo subito — a differenza dei due rami sotto, qui l'operatore potrebbe voler sapere
        // di più (es. riprovare dopo aver avvicinato il telefono a un altro dispositivo).
      } else if (outcome === "claimed-elsewhere") {
        // Un altro canale (es. un peer Bluetooth appena incrociato, o un ritentativo gateway periodico)
        // ha già consegnato e segnalato questo stesso SOS — attività/toast/vibrazione già mostrati da
        // quel percorso, qui si aggiorna solo il testo locale del pannello, senza ripetere la notifica.
        sosStatus.textContent = "SOS inviato.";
        sosPanel.hidden = true;
      } else {
        recordActivity("sos", undefined, "sent");
        sosStatus.textContent = "SOS inviato.";
        vibrate([30, 50, 30, 50, 30]);
        showToast("SOS inviato", "alert-circle");
        sosPanel.hidden = true;
      }
    } catch (err) {
      sosStatus.classList.add("error");
      sosStatus.textContent = "Errore: " + err.message;
    } finally {
      sosSend.disabled = false;
    }
  });
}
