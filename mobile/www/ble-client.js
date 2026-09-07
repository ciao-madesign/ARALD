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
// Classic (non-module) script, loaded after ble-link.js/ble-relay.js (entrambi moduli) in
// index.html — legge la logica pura da `window.AraldBleLink` (framing/frammentazione) e
// `window.AraldBleRelay` (dedup/instradamento/coda), gli stessi ponti deliberati già documentati
// nei rispettivi file. Ogni accesso a quegli oggetti avviene solo dentro gestori di evento, mai a
// livello di script — stesso motivo già spiegato in ble-link.js.
//
// AMBITO DI QUESTO PEZZO: il telefono relaya pacchetti — non li interpreta né li mostra ancora
// (nessuna UI per SOS/chat/drop ricevuti via questo percorso). Il telefono non ha un'identità
// crittografica reale (nessuna chiave Ed25519) — relaySessionNodeId è un'etichetta usa-e-getta per
// tutta la sessione di relay, mai una vera identità di rete.
//
// COSA È VERIFICATO QUI, COSA NO: la logica di relay pura (ble-relay.js) è unit-testata
// (tests/unit/mobile-ble-relay.test.ts). Tutto ciò che chiama window.Capacitor.Plugins.BluetoothLe
// resta scritto a spec, mai eseguito contro il plugin reale/un bridge nativo/hardware Bluetooth
// reale — stessa onestà già applicata al pezzo precedente e a node/src/transports/lora-serial.ts.

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

/**
 * Non un'identità crittografica (nessuna chiave Ed25519, a differenza di un vero NomadNode) — una
 * etichetta usa-e-getta per l'intera sessione di relay, rigenerata solo quando il relay viene
 * riattivato. Identità/crittografia reale per qualunque cosa il telefono arrivasse un giorno a
 * originare (non solo relayare) resta esplicitamente lavoro futuro.
 */
function newRelaySessionNodeId() {
  return `phone-${crypto.randomUUID()}`;
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
    }
    return; // qualunque altra cosa prima dell'identificazione viene ignorata
  }

  const decision = window.AraldBleRelay.decideForward(packet, relaySessionNodeId, seenCache);
  if (decision.duplicate || !decision.forwardPacket) return;
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

  await plugin.initialize();
  if (sessionId !== relaySessionId) return; // disattivato/riattivato mentre initialize() era in corso — non avviare una scansione per una sessione già superata
  await issueScan(plugin, sessionId);
  scanRefreshTimer = setInterval(() => {
    if (relayActive && sessionId === relaySessionId) issueScan(plugin, sessionId);
  }, SCAN_REFRESH_INTERVAL_MS);
}

async function deactivateRelay() {
  relayActive = false;
  relaySessionId += 1; // invalida qualunque connectToPeer()/handleScanResult() ancora in corso per la sessione precedente
  if (scanRefreshTimer) {
    clearInterval(scanRefreshTimer);
    scanRefreshTimer = null;
  }

  const plugin = bleRelayPlugin();
  if (plugin) {
    try {
      await plugin.stopLEScan();
    } catch {
      // best-effort
    }
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

  connections.clear();
  seenCache = null;
  pendingQueue = null;
  relaySessionNodeId = null;
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
      relayActive = false; // l'attivazione è fallita — non deve restare bloccato come se fosse attivo
      setBleRelayStatus("Errore: " + err.message, true);
    } finally {
      toggle.disabled = false;
    }
  });
}
