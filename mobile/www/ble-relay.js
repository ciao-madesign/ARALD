// Relay/store-and-forward decision logic for the phone acting as a genuine mesh relay over
// Bluetooth — a browser-compatible port of node/src/routing.ts (SeenCache, decideForward()) and
// node/src/store-and-forward.ts (PendingDeliveryQueue), duplicated by necessity: no bundler in
// mobile/www/, no static `import` from node/src/ possible (same reason ble-link.js/
// SERVICE_ICONS/SERVICE_LABELS are duplicated by hand — see CLAUDE.md).
//
// This is deliberately pure packet-envelope logic, no Bluetooth I/O — mirrors how decideForward()
// on the Node side never trusts a payload's shape, only the envelope (id/type/source/destination/
// ttl/priority) that decodePacket() already validates. See mobile/www/ble-client.js for how this is
// wired to real (multi-)connection I/O.
//
// Ambito di questo pezzo (docs/security.md voce #63, CLAUDE.md): il telefono relay davvero i
// pacchetti tra i dispositivi Bluetooth a cui è connesso — dedup, TTL, instradamento broadcast/
// unicast, coda in memoria per un peer non ancora raggiungibile — ma non interpreta o mostra ancora
// il contenuto di ciò che relaya (nessuna UI per SOS/chat/drop ricevuti via questo percorso, quello
// resta un pezzo futuro).

export const MAX_SEEN_IDS = 4096; // stesso default di node/src/routing.ts's SeenCache

/** Porta browser-compatibile di node/src/routing.ts's SeenCache — stesso schema Map-bounded-FIFO già usato da ble-link.js's FragmentReassembler per l'eviction. */
export class SeenCache {
  #seen = new Map();
  #maxSize;

  constructor(maxSize = MAX_SEEN_IDS) {
    this.#maxSize = maxSize;
  }

  hasSeen(id) {
    return this.#seen.has(id);
  }

  markSeen(id) {
    if (this.#seen.has(id)) return;
    if (this.#seen.size >= this.#maxSize) {
      const oldestKey = this.#seen.keys().next().value;
      this.#seen.delete(oldestKey);
    }
    this.#seen.set(id, Date.now());
  }

  get size() {
    return this.#seen.size;
  }
}

/**
 * Porto letterale di node/src/routing.ts's decideForward() — già pura, nessuna logica specifica di
 * Node.js da adattare. Stessa semantica esatta: pacchetto già visto → scartato; unicast per il nodo
 * locale → consegna, non inoltro; unicast per qualcun altro → solo inoltro; broadcast (nessuna
 * destination) → consegna E inoltro; TTL decrementato, mai inoltrato a TTL 0.
 */
export function decideForward(packet, localNodeId, seenCache) {
  if (seenCache.hasSeen(packet.id)) {
    return { duplicate: true, deliverLocally: false };
  }
  seenCache.markSeen(packet.id);

  const isUnicastForMe = packet.destination !== undefined && packet.destination === localNodeId;
  const isBroadcast = packet.destination === undefined;
  const deliverLocally = isUnicastForMe || isBroadcast;

  const shouldForward = !isUnicastForMe && packet.ttl > 0;
  const forwardPacket = shouldForward ? { ...packet, ttl: packet.ttl - 1 } : undefined;

  return { duplicate: false, deliverLocally, forwardPacket };
}

// Stessi valori di node/src/packet.ts's Priority enum — solo i due estremi servono qui
// (priorityRank() clampa tutto il resto in mezzo, EMERGENCY=0 più urgente, BULK=5 meno urgente).
const PRIORITY_EMERGENCY = 0;
const PRIORITY_BULK = 5;
const PRIORITY_LEVEL_COUNT = 6;

/**
 * Clamps an untrusted packet.priority — stesso identico ragionamento/clamp di
 * node/src/store-and-forward.ts's priorityRank(): decodePacket() (ble-link.js) valida solo
 * l'involucro, mai la forma/il range di priority, quindi un valore forgiato/fuori range va trattato
 * come il MENO urgente possibile, mai il più urgente (altrimenti un pacchetto forgiato diventerebbe
 * immune all'eviction al posto di una voce EMERGENCY legittima — l'esatto contrario di quello che
 * questa funzione deve garantire).
 */
function priorityRank(priority) {
  return Number.isInteger(priority) && priority >= 0 && priority < PRIORITY_LEVEL_COUNT ? priority : PRIORITY_BULK;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_EMERGENCY_TTL_MS = 30 * 60 * 1000; // stesso rapporto 6x di store-and-forward.ts
const DEFAULT_MAX_SIZE = 256;

/**
 * Porto semplificato di node/src/store-and-forward.ts's PendingDeliveryQueue: bounded, eviction
 * pesata sulla priorità (mai plain FIFO — una voce EMERGENCY non deve mai essere sfrattata per fare
 * spazio a traffico ordinario), due livelli di TTL wall-clock (EMERGENCY sopravvive più a lungo).
 * Solo pacchetti unicast (un `destination` noto) — un broadcast non ha "un prossimo hop" da
 * aspettare, si inoltra subito e basta, stesso limite già dichiarato nell'originale Node.
 * Nessuna persistenza (deciso con l'utente per questo pezzo): tutto in memoria, azzerato se l'app
 * viene chiusa — coerente con un corriere opportunistico, non l'unica copia di un messaggio
 * importante che comunque continua a circolare via altri percorsi/relay.
 */
export class PendingRelayQueue {
  #entries = new Map();
  #ttlMs;
  #emergencyTtlMs;
  #maxSize;

  constructor(options = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#emergencyTtlMs = options.emergencyTtlMs ?? DEFAULT_EMERGENCY_TTL_MS;
    this.#maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  }

  has(packetId) {
    return this.#entries.has(packetId);
  }

  enqueue(packet, exceptPeerId) {
    if (this.#entries.has(packet.id)) return;
    if (this.#entries.size >= this.#maxSize) this.#evictLowestPriority();
    const ttlMs = priorityRank(packet.priority) === PRIORITY_EMERGENCY ? this.#emergencyTtlMs : this.#ttlMs;
    this.#entries.set(packet.id, { packet, exceptPeerId, expiresAt: Date.now() + ttlMs });
  }

  /** Reinserisce una entry già estratta (stessa expiresAt originale, mai una fresca) — stesso schema di requeue() nell'originale Node, anche se questo pezzo non ha ancora un percorso che lo chiama (nessun gate di relay-policy qui da negare); esposto per coerenza/uso futuro. */
  requeue(entry) {
    if (this.#entries.has(entry.packet.id)) return;
    if (entry.expiresAt <= Date.now()) return;
    if (this.#entries.size >= this.#maxSize) this.#evictLowestPriority();
    this.#entries.set(entry.packet.id, entry);
  }

  /** Rimuove e ritorna ogni entry destinata a `peerNodeId`, silenziosamente scartando qualunque entry (per chiunque) già scaduta incontrata lungo la strada — stesso "pulisci mentre attraversi" del drain() originale. */
  drainFor(peerNodeId) {
    const now = Date.now();
    const ready = [];
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(id);
        continue;
      }
      if (entry.packet.destination === peerNodeId) {
        this.#entries.delete(id);
        ready.push(entry);
      }
    }
    return ready;
  }

  #evictLowestPriority() {
    let worstId;
    let worstRank = -1;
    for (const [id, entry] of this.#entries) {
      const rank = priorityRank(entry.packet.priority);
      if (rank > worstRank) {
        worstRank = rank;
        worstId = id;
      }
    }
    if (worstId !== undefined) this.#entries.delete(worstId);
  }

  get size() {
    return this.#entries.size;
  }
}

// Stessa costante di node/src/drops.ts's DROP_CONTENT_NAME — duplicata per lo stesso motivo
// no-bundler già spiegato in cima a questo file.
const DROP_CONTENT_NAME = "drop";
// Stessa costante di node/src/public-channels.ts's CHANNEL_NAME_PREFIX/CHANNEL_NAME_PATTERN.
const CHANNEL_NAME_PREFIX = "chat:";
const CHANNEL_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
// Stessa costante di node/src/emergency-beacon.ts's EMERGENCY_BEACON_CONTENT_NAME.
const EMERGENCY_BEACON_CONTENT_NAME = "emergency-beacon";

/**
 * Classifica un pacchetto che il relay ha appena deciso di inoltrare (voce #66, `docs/security.md`)
 * — usata da `ble-client.js` per contare *cosa* passa attraverso il telefono senza mai mostrarne il
 * contenuto, rispettando un vincolo esplicito dell'utente: solo contenuti destinati a visione
 * pubblica, mai contenuti privati; per un SOS solo il conteggio, mai il contenuto.
 *
 * **Allowlist, non denylist** — la postura più sicura qui: riconosce esplicitamente solo le tre
 * categorie pubbliche (bacheca, canale, SOS); qualunque altra cosa — `PRIVATE_MESSAGE`,
 * `GROUP_MESSAGE`, `HELLO`, `PEER_LIST`, `SERVICE_*`, un `CONTENT_ANNOUNCE` con un `name` non
 * riconosciuto — ritorna `undefined`, mai contata né mostrata. Non serve un ramo "privato" da
 * popolare: tutto ciò che questa funzione non riconosce esplicitamente resta invisibile per
 * costruzione.
 *
 * Classifica **solo** in base a `packet.type`/`payload.metadata.name`, entrambi campi già in chiaro
 * nell'involucro del pacchetto (mai serve decifrare nulla — `PRIVATE_MESSAGE`/`GROUP_MESSAGE` sono
 * già ciphertext per costruzione, il telefono non ha comunque la chiave per leggerli). Per la
 * categoria `"sos"`, **non accede a nessun altro campo del payload oltre a `name`** — nemmeno
 * `payload.data` (che per un SOS di `sendEmergencyBeacon()` conterrebbe i byte veri e propri,
 * `ble-sos.js`'s stesso schema) — così è strutturalmente impossibile che un dettaglio di un SOS
 * arrivi mai a chi chiama questa funzione, non solo per disciplina di chi la usa.
 *
 * Nessuna verifica della firma qui (limite accettato, dichiarato esplicitamente) — un peer potrebbe
 * gonfiare i conteggi con un `metadata.name` falsificato, ma non c'è mai alcun contenuto mostrato in
 * nessun caso: un problema di accuratezza del conteggio, mai di privacy.
 */
export function classifyRelayedPacket(packet) {
  if (!packet || packet.type !== "CONTENT_ANNOUNCE") return undefined;
  const name = packet.payload && packet.payload.metadata && packet.payload.metadata.name;
  if (typeof name !== "string") return undefined;

  if (name === DROP_CONTENT_NAME) return { kind: "drop" };
  if (name === EMERGENCY_BEACON_CONTENT_NAME) return { kind: "sos" };
  if (name.startsWith(CHANNEL_NAME_PREFIX)) {
    const channel = name.slice(CHANNEL_NAME_PREFIX.length);
    if (CHANNEL_NAME_PATTERN.test(channel)) return { kind: "channel", channel };
  }
  return undefined;
}

const AraldBleRelay = { SeenCache, decideForward, PendingRelayQueue, classifyRelayedPacket };

// The one deliberate bridge to the classic, non-module scripts in this directory — see ble-link.js's file header for the same pattern.
if (typeof window !== "undefined") {
  window.AraldBleRelay = AraldBleRelay;
}
