# Protocollo

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §15, §18-26, §48-51.

## Formato pacchetto (prototipo, JSON — §15, §48)

```ts
interface Packet<T = unknown> {
  version: number;       // protocol version, oggi = 1
  id: string;             // UUID, usato per la deduplicazione (§20)
  type: MessageType;
  source: string;          // node id (hex della public key)
  destination?: string;    // assente = broadcast/flood
  ttl: number;              // decrementato a ogni hop (§19)
  timestamp: number;
  priority?: Priority;      // §50, default MESSAGING
  payload: T;
}
```

Implementato in `node/src/packet.ts`. Framing su TCP: un pacchetto JSON per riga (newline-delimited), vedi `node/src/transports/tcp.ts`.

## Tipi di pacchetto implementati

| Tipo | Uso | Fase |
|---|---|---|
| `HELLO` | annuncio all'apertura di una connessione | Milestone 1 |
| `PING` / `PONG` | liveness check | Milestone 1 |
| `PEER_LIST` | scambio dei peer conosciuti | Milestone 1-2 |
| `DATA` | payload applicativo generico, instradato per `destination` | Milestone 2 (multi-hop) |
| `ACK` | conferma di ricezione di un `DATA` | Milestone 2 |
| `CONTENT_QUERY` | "chi ha `content_id`?" | Milestone 4 |
| `CONTENT_FOUND` | risposta positiva alla query, dal nodo che possiede il contenuto | Milestone 4 |
| `CONTENT_NOT_FOUND` | risposta esplicita a un `CONTENT_REQUEST` per contenuto che il nodo non ha (più) — evitato o scaduto (§24) dal momento in cui aveva risposto `CONTENT_FOUND` | Milestone 4 (seguito audit) |
| `CONTENT_REQUEST` | richiesta esplicita del contenuto trovato | Milestone 4 |
| `CONTENT_CHUNK` | un chunk del contenuto (§26) | Milestone 4 |
| `CONTENT_COMPLETE` | fine trasferimento, contiene l'hash finale da verificare | Milestone 4 |
| `CONTENT_ANNOUNCE` | annuncio broadcast proattivo di un contenuto (solo metadata firmata, mai i byte) — push, controparte di `CONTENT_QUERY`/pull; opt-in via `publishContent(..., { announce: true })` | Milestone 4 (seguito audit, `docs/security.md` voce #34) |
| `SYNC_REQUEST` | annuncio del proprio catalogo (content id conosciuti) a un peer appena connesso | Milestone 13 |
| `SYNC_RESPONSE` | risposta con le voci di catalogo che il peer non conosceva ancora (solo metadata, mai i byte) | Milestone 13 |
| `IDENTITY_REQUEST` | annuncio dei node id di cui si conosce già la chiave di cifratura, a un peer appena connesso | Milestone 15 |
| `IDENTITY_RESPONSE` | risposta con gli `IdentityAnnouncement` (autofirmati) che il peer non conosceva ancora | Milestone 15 |
| `PRIVATE_MESSAGE` | payload applicativo cifrato end-to-end (AES-256-GCM su chiave derivata via ECDH X25519), instradato per `destination`; porta con sé l'`IdentityAnnouncement` del mittente | Milestone 15 |
| `ROUTE_ANNOUNCE` | annuncio distance-vector (`{destination, cost}` o `cost: null` per un ritiro) scambiato tra vicini diretti — al massimo `MAX_ROUTES_PER_ANNOUNCE` (512, node.ts) entry di un singolo pacchetto vengono effettivamente applicate, il resto scartato silenziosamente; l'eviction di `RoutingTable` è pesata sulla fiducia del `nextHop` che ha annunciato ciascuna rotta (§57, docs/security.md voce #26), non un semplice FIFO | Milestone 16 |
| `SERVICE_ANNOUNCE` | annuncio proattivo (floodato) di un servizio offerto localmente | Milestone 4 (service discovery, seguito audit) |
| `SERVICE_QUERY` | "chi offre `service_id`?" — fallback quando non si conosce già un fornitore da un `SERVICE_ANNOUNCE` precedente | Milestone 4 (seguito audit) |
| `SERVICE_REQUEST` | invocazione effettiva del servizio verso un fornitore noto (`CALL service://...`) | Milestone 4 (seguito audit) |
| `SERVICE_RESPONSE` | risposta a `SERVICE_QUERY` (con l'annuncio) **oppure** a `SERVICE_REQUEST` (con `result`/`error`) — vedi sotto | Milestone 4 (seguito audit) |

Un `CONTENT_QUERY` senza risposta resta comunque segnalato solo implicitamente (nessun `CONTENT_FOUND` entro `contentRequestTimeoutMs`, mentre il flood si esaurisce per TTL, §21) — nessun nodo può dichiarare "non esiste da nessuna parte" per l'intera mesh. `CONTENT_NOT_FOUND` copre invece il caso più mirato e frequente: un nodo specifico che aveva risposto `CONTENT_FOUND` non ha più il contenuto al momento del `CONTENT_REQUEST` (evitato da una cache limitata, o scaduto — §24, vedi "Scadenza dei contenuti" sotto). `NomadNode.handleContentNotFound()` (node.ts) fa fallire immediatamente la richiesta pendente sul prossimo candidato noto invece di aspettare che `contentProviderTimeoutMs` scada su un fornitore che non risponderà mai — solo una risposta dal fornitore attualmente attivo viene onorata, stessa logica di `handleContentChunk`/`handleContentComplete`.

## Scadenza dei contenuti (§24)

`ContentMetadata` porta un campo opzionale `expiresAt` (epoch ms assoluto) — assente per contenuto che non scade mai. Coperto dalla firma del publisher (`contentSigningPayload`, spec §55) insieme agli altri campi, così un relay non può manometterlo per tenere in vita contenuto scaduto oltre l'intenzione del publisher, né per accorciarne la vita. `NomadNode.publishContent(name, mimeType, data, { ttlMs })` imposta `expiresAt = Date.now() + ttlMs`; senza `ttlMs` il contenuto non scade. `ContentStore` e `RemoteCatalog` applicano entrambi una scadenza "pigra": ogni lettura (`get`/`has`/`list`/`chunksFor`/`size`) tratta una voce scaduta come assente e la elimina in quel momento, senza un timer di sweep in background. `ContentStore.putVerified()` rifiuta contenuto già scaduto al momento dell'arrivo (spec §24: non ha senso metterlo in cache), e `handleSyncResponse()` scarta allo stesso modo una voce di catalogo già scaduta ricevuta via sync.

`ContentStore` è inoltre limitata per dimensione (spec §57, `docs/security.md` voce #32) come ogni altra struttura dati alimentata dalla rete nel progetto: `BoundedFifoMap` con `maxSize` (default 256, deliberatamente più basso del 4096 usato dalle strutture puramente metadata, dato che qui ogni entry porta i byte veri del contenuto) ed eviction pesata sulla fiducia del publisher (`NomadNodeOptions.maxContentStoreEntries`). Il contenuto pubblicato localmente da questo stesso nodo (via `publishContent()`) è preferito nella permanenza rispetto a qualunque contenuto solo relay-cached da altri publisher, ma non rispetto ad altro contenuto pubblicato localmente — tra due entry proprie l'eviction resta FIFO (la più vecchia sfrattata per prima).

## Servizi (§35-37)

Non solo file: anche servizi (`service://translation`, `service://ocr`, `service://ai`, ...). Stesso schema di firma di `ContentMetadata` (`ServiceAnnouncement`, `node/src/service.ts`): `providerId` + firma Ed25519 su `serviceId, version, capabilities, providerId, resourceRequirements, availability, createdAt`. A differenza del contenuto (immutabile — un content id è l'hash dei suoi byte), `availability` di un servizio è per natura mutevole nel tempo, quindi qui `createdAt` **è** parte del payload firmato (deliberatamente, a differenza di `ContentMetadata`): è ciò che permette a `ServiceDirectory` di rifiutare un annuncio più vecchio "rigiocato" (replay) a favore di uno realmente più recente per la stessa coppia (serviceId, providerId) — a parità di `createdAt` vince l'annuncio in arrivo, non quello già registrato (due annunci firmati a distanza di pochi millisecondi, es. `registerService()` seguito subito da `setServiceAvailability()`, possono avere lo stesso `Date.now()`).

Flusso:
- `NomadNode.registerService(serviceId, version, capabilities, handler, options)` registra un servizio locale e flooda subito un `SERVICE_ANNOUNCE` — proattivo, non serve essere interrogati perché la mesh lo impari.
- `NomadNode.discoverService(serviceId)` risolve immediatamente se un fornitore è già noto (registrazione locale disponibile, o un annuncio già ricevuto), altrimenti flooda un `SERVICE_QUERY` e aspetta la prima `SERVICE_RESPONSE`.
- `NomadNode.callService(serviceId, payload)` invoca il servizio: se registrato localmente e disponibile, gira in-process senza alcun round-trip di rete; altrimenti chiama `discoverService()` e poi invia `SERVICE_REQUEST` al fornitore trovato, aspettando `result`/`error` nella `SERVICE_RESPONSE` corrispondente (correlata per `requestId`, e onorata solo se `packet.source` coincide col fornitore effettivamente contattato — stesso confine di fiducia di `handleContentChunk`/`handleContentComplete`).
- `NomadNode.setServiceAvailability(serviceId, availability)` aggiorna e riannuncia un servizio già registrato (es. metterlo temporaneamente fuori rotazione perché sovraccarico), senza dover rimuovere/ri-registrare l'handler.

`SERVICE_RESPONSE` copre deliberatamente due ruoli distinti con un solo tipo di pacchetto (spec §49 elenca solo 4 tipi per i servizi): risposta a `SERVICE_QUERY` (porta `queryId` + `announcement`, mirror di `CONTENT_FOUND`) oppure risposta a `SERVICE_REQUEST` (porta `requestId` + `result`/`error`, mirror di `CONTENT_COMPLETE` — senza però il chunking, una chiamata/risultato si assume stia in un solo pacchetto). Vedi `node/src/service.ts`, `node/src/service-directory.ts`, `tests/unit/service.test.ts`, `tests/unit/service-directory.test.ts`, `tests/integration/service-discovery.test.ts`.

Tre esempi concreti di servizio "reale" (nel senso di parlare con un backend HTTP vero, non solo un handler in-process che fa echo) sono in `gateway/nomad/`, seguito audit: `KiwixGateway.registerSearchService()` registra `service://kiwix-search`, `AiGateway.registerAiService()` registra `service://ai` — quest'ultimo è esattamente l'esempio di spec §37 (un dispositivo poco potente chiede alla rete una risposta generata da un'IA locale, la rete trova un nodo più capace) — e `NewsGateway.registerNewsService()` registra `service://news` (`docs/security.md` bug #27). I primi due sono `ServiceHandler` ordinari che proxano live a un backend NOMAD (mockato, vedi `docs/security.md` bug #19-20) a ogni chiamata; `service://news` è diverso di proposito — il suo handler non fa mai una chiamata HTTP live, risponde sempre da una cache in memoria che solo `NewsGateway.syncNews()`/`startAutoSync()` aggiornano in background, perché "la news di adesso" deve rispondere istantaneamente anche se il backend reale è momentaneamente lento o irraggiungibile. Nessuno dei tre handler aggiunge nulla al protocollo sopra: la scoperta multi-hop di chi offre il servizio è la stessa già descritta, dimostrata in `tests/integration/ai-gateway.test.ts` con un nodo debole che chiama `service://ai` attraverso un relay, senza mai connettersi al nodo gateway. `NewsGateway.generateDigest()` (`docs/security.md` voce #37) è lo stesso pattern applicato tra due servizi di questo codebase invece che da un chiamante esterno: compone `service://news` con `service://ai` chiamando quest'ultimo tramite `node.callService()`, mai un riferimento diretto alla classe `AiGateway` — un esempio concreto di "un servizio ne consuma un altro attraverso la mesh, non un import diretto".

`SYNC_REQUEST`/`SYNC_RESPONSE`, `IDENTITY_REQUEST`/`IDENTITY_RESPONSE` e `ROUTE_ANNOUNCE` sono tutti scambiati direttamente peer-a-peer (un solo hop, come `HELLO`) — non vengono mai inoltrati/floodati oltre i due nodi coinvolti. I primi due si scambiano ogni volta che due nodi si connettono (vedi `docs/roadmap.md` milestone 13); `ROUTE_ANNOUNCE` in aggiunta ogni volta che la tabella di instradamento locale cambia (triggered update, non solo alla connessione) — vedi `docs/roadmap.md` milestone 16. `PRIVATE_MESSAGE`, a differenza di questi, **è** instradato/floodato come `DATA` (per `destination`, non un solo hop) — un relay lo inoltra senza poterlo decifrare.

Tipi previsti dalla specifica ma **non ancora implementati** (§49): `ANNOUNCE`, `CAPABILITY`, `ROUTE_QUERY`, `ROUTE_REPLY`, `STORE`, `FORWARD`, `ERROR`. (I quattro `SERVICE_*` erano ancora in questa lista prima della Slice 6, seguito audit — corretto qui: sono implementati, vedi sopra.)

## TTL e deduplicazione (§19-21)

- Ogni pacchetto nasce con un TTL (default 8 nel prototipo).
- Ogni nodo che inoltra un pacchetto lo decrementa; a TTL 0 il pacchetto viene scartato.
- Ogni nodo mantiene una cache `seen packet id -> timestamp` (`node/src/routing.ts`, classe `SeenCache`) con eviction dimensionale, per evitare di rielaborare o reinoltrare lo stesso pacchetto (controlled flooding, §21).

## Instradamento per traffico unicast (§22, Milestone 16)

Un pacchetto con `destination` impostato (unicast) viene instradato verso il next hop noto in `node/src/routing-table.ts` quando esiste una rotta — un solo invio, non un flood verso tutti i vicini. Se non esiste ancora una rotta nota (mesh appena connessa) o l'invio instradato fallisce, si ricade sul controlled flooding come nel resto del protocollo. Il flooding resta l'unico meccanismo per il traffico broadcast (`CONTENT_QUERY`, destination assente). Il TTL si decrementa comunque a ogni hop, instradato o floodato che sia — instradare cambia solo *a chi* viene inviato il pacchetto, non la logica di TTL/dedup.

## Content ID (§24)

```
content_id = sha256(payload)
```

esadecimale, calcolato da `node/src/content.ts`. Metadata associati nel prototipo: `contentId, name, mimeType, size, createdAt, publisherId, signature`. Firma del publisher (§55) è implementata — vedi [`security.md`](./security.md); expiry non è ancora implementata.

## Flusso di content discovery (§25, Milestone 4)

```
A --CONTENT_QUERY(id)--> B --CONTENT_QUERY(id)--> C
C possiede il contenuto:
C --CONTENT_FOUND(id)--> B --CONTENT_FOUND(id)--> A
A --CONTENT_REQUEST(id)--> B --CONTENT_REQUEST(id)--> C
C --CONTENT_CHUNK(id, 0..n)--> B --CONTENT_CHUNK--> A
C --CONTENT_COMPLETE(id, hash)--> B --> A
A verifica sha256(chunk riassemblati) == hash
```

Ogni hop lungo il percorso di ritorno **verifica se possiede già il contenuto in cache locale** prima di continuare a propagare la query: questo è ciò che rende possibile la cache trasparente del Milestone 5 (§27-29, §90-92 obiettivo 2 e 3).

## Priorità (§50)

Definite in `Priority` (`node/src/packet.ts`): `EMERGENCY(0) > CONTROL(1) > MESSAGING(2) > SERVICE(3) > CONTENT(4) > BULK(5)`.

Ogni pacchetto `CONTENT_*` legato al ciclo pull (`CONTENT_QUERY`/`CONTENT_FOUND`/...) usa sempre `Priority.CONTENT`, indipendentemente da cosa contiene — la priorità resta fissa per tipo di messaggio per quella famiglia. Un contenuto che debba "saltare la coda e raggiungere subito tutta la mesh" (es. un bollettino di emergenza, o un nuovo messaggio in un canale di chat pubblico) usa invece `CONTENT_ANNOUNCE` (vedi sopra, `docs/security.md` voce #34): `publishContent(..., { announce: true, priority })` origina un annuncio broadcast alla priorità dichiarata, parallelo a `SERVICE_ANNOUNCE`. **Limite noto, accettato**: quella priorità non è autenticata più di quanto lo sia `packet.source` (`CLAUDE.md`) — un peer può già dichiarare qualunque priorità su qualunque pacchetto che origina; il rate limiting per-peer esistente (applicato prima dello switch sui tipi in `handlePacket()`) resta la difesa principale contro un flood a priorità `EMERGENCY` **ricevuto da un peer**. Il primo consumatore reale di questo meccanismo è `service://emergency-news` (`docs/security.md` voce #39, `gateway/nomad/news-gateway.ts`) — e ha esposto la metà mancante del problema: quel rate limiting non copre un pacchetto che *questo stesso nodo* origina da sé (`floodExcept()` non passa mai per `handlePacket()`), quindi un `NewsGateway` alimentato da un feed `--news-url` ostile poteva flooder la mesh a priorità `EMERGENCY` senza alcun limite. `NewsGateway` applica ora il proprio tetto locale (`MAX_EMERGENCY_ANNOUNCES_PER_SYNC`) — una mitigazione specifica al chiamante, non un cambiamento al meccanismo `CONTENT_ANNOUNCE` stesso, che resta generico e senza un limite di questo tipo incorporato: un futuro chiamante che origina i propri `CONTENT_ANNOUNCE` a priorità alta (es. i canali pubblici di chat) dovrà applicare una protezione analoga per conto proprio.

`TcpTransport` (`node/src/transports/tcp.ts`) applica ora uno scheduling reale per-peer, non solo un campo dati: ogni socket ha una `PriorityQueue` a 6 bucket FIFO (`node/src/priority-queue.ts`) — `send()` mette in coda il pacchetto e restituisce una promise che si risolve solo quando *quel* pacchetto è stato effettivamente scritto sul socket; un loop di drain (`drainQueue()`, con guardia di rientranza `draining`) svuota sempre il bucket non vuoto a priorità più alta prima di passare al successivo, preservando l'ordine di arrivo fra pacchetti della stessa priorità. Effetto pratico: un burst BULK (es. un trasferimento a chunk in corso) non fa più attendere un pacchetto EMERGENCY dietro di sé solo perché è stato accodato prima — a meno che il pacchetto EMERGENCY non arrivi mentre il *primissimo* invio del burst sta già scrivendo (quello parte sempre subito, non c'è ancora nulla in coda con cui riordinarlo). La coda per peer è limitata a `MAX_QUEUED_SENDS_PER_PEER` (500): oltre quella soglia `send()` rifiuta immediatamente invece di crescere senza limite, e alla disconnessione tutti gli invii ancora in coda vengono rifiutati (mai lasciati pending). Vedi `tests/unit/priority-queue.test.ts` e `tests/integration/tcp-priority-scheduling.test.ts`.
