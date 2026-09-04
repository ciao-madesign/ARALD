# ARALD — Specifica progettuale completa

**Rete intermittente distribuita per emergenze, rifugi alpini e ambienti senza connettività**

- **Versione:** 0.1
- **Data:** 10 agosto 2026
- **Stato:** Specifica preliminare / base per sviluppo MVP

> Questo documento è la specifica di riferimento (single source of truth) del progetto. Il codice sorgente e gli altri documenti in `docs/` sono derivati da questa specifica e vi fanno riferimento tramite il numero di sezione. Per la sintesi operativa "cosa esiste già / cosa va costruito da zero" vedere [`docs/reuse-vs-new.md`](./reuse-vs-new.md).

---

## 1. Visione del progetto

ARALD è un sistema di rete distribuito progettato per permettere a dispositivi digitali di comunicare, scambiare contenuti e utilizzare servizi anche quando Internet non è disponibile.

L'obiettivo non è creare una nuova Internet basata semplicemente su TCP/IP, ma costruire un livello di rete locale e intermittente capace di:

- scoprire dispositivi vicini;
- creare collegamenti tra dispositivi;
- inoltrare pacchetti attraverso più nodi;
- trasferire file e contenuti;
- conservare temporaneamente dati;
- replicare contenuti;
- sincronizzare reti precedentemente separate;
- eseguire servizi distribuiti;
- collegarsi a Internet quando un gateway diventa disponibile;
- funzionare anche in presenza di connessioni intermittenti;
- continuare a essere utile quando Internet e rete cellulare sono completamente assenti.

Il sistema deve essere particolarmente adatto a: emergenze, terremoti, alluvioni, blackout, operazioni di soccorso, rifugi alpini, trekking, aree montane, comunità remote, eventi molto affollati, scuole, spedizioni, infrastrutture temporanee, ambienti con connettività intermittente.

Definizione sintetica:

> "ARALD è una rete distribuita, content-centric e delay-tolerant che permette a dispositivi mobili e nodi edge di condividere contenuti, servizi e comunicazioni senza infrastruttura Internet, utilizzando una combinazione di mesh locali, store-and-forward, caching opportunistico, replica distribuita e gateway intermittenti verso Internet."

---

## 2. Idea centrale

La rete Internet tradizionale ragiona così:

```
IP -> HOST -> RESOURCE
```

ARALD ragiona così:

```
CONTENT ID -> NETWORK -> AVAILABLE PROVIDER -> BEST PATH
```

L'utente non dovrebbe dover sapere quale dispositivo possiede il contenuto, dove si trova il server, quanti hop servono, quale tecnologia radio viene usata, se il contenuto è originale o una copia, se è temporaneamente disponibile, se il dispositivo che lo possiede è collegato a Internet.

L'utente chiede semplicemente:

```
content://wikipedia/italia
service://translation
service://ai
content://maps/dolomiti
```

La rete determina autonomamente dove e come ottenere la risorsa.

---

## 3. Principio architetturale fondamentale

ARALD è costruito come una serie di livelli indipendenti:

```
APPLICATION LAYER
Web / Chat / Files / Maps / Search / AI
                |
                v
SERVICE / CONTENT LAYER
NOMAD / Kiwix / Kolibri / Maps / AI / Apps
                |
                v
OFFLINE NETWORK FABRIC
Discovery / Routing / Cache / Sync /
Replication / Store & Forward
                |
                v
TRANSPORT LAYER
BLE / Wi-Fi Direct / Wi-Fi LAN /
Ethernet / Internet
```

Il Network Fabric non dipende da un particolare mezzo di trasporto: per il routing è irrilevante se un pacchetto passa attraverso BLE, Wi-Fi, Wi-Fi Direct, Ethernet, un eventuale collegamento radio o Internet. Il trasporto deve essere sostituibile.

---

## 4. Rapporto con Project NOMAD

Project N.O.M.A.D. ("Node for Offline Media, Archives, and Data") è una delle principali basi tecnologiche del progetto.

- Repository ufficiale: https://github.com/Crosstalk-Solutions/project-nomad
- FAQ: https://github.com/Crosstalk-Solutions/project-nomad/blob/main/FAQ.md

È un server offline-first che raccoglie strumenti e contenuti per creare una macchina di conoscenza autonoma. La repository è in sviluppo attivo e il progetto non è dichiarato stabile. Usa Docker e un Command Center/API che orchestra diversi container: Kiwix, Wikipedia offline, documentazione, libri, Ollama, Qdrant, RAG, Kolibri, mappe offline, CyberChef, FlatNotes, container personalizzati.

Project NOMAD è pensato per sistemi Debian-based, gestibile via Docker, accessibile via browser (non richiede ambiente desktop). Stack: Docker, Node.js, TypeScript, AdonisJS, React, Vite, Inertia.js, MySQL, Redis, Ollama, Qdrant.

ARALD tratta NOMAD come un insieme di servizi locali già disponibili, non da riscrivere. Non deve essere necessariamente modificato nella prima fase; va considerato come "service provider" locale:

```
ARALD
    |
    | request
    v
NOMAD Gateway
    |
    +-- Kiwix
    +-- Ollama
    +-- Qdrant
    +-- Maps
    +-- Kolibri
    +-- altri servizi
```

ARALD fornisce un livello di rete che permette di raggiungere questi servizi anche da dispositivi non direttamente collegati al computer NOMAD.

---

## 5. Rapporto con BitChat

- Repository: https://github.com/permissionlesstech/bitchat
- Whitepaper: https://github.com/permissionlesstech/bitchat/blob/main/WHITEPAPER.md

BitChat è un'app decentralizzata di messaggistica peer-to-peer via BLE mesh. La repository documenta: BLE mesh, peer discovery, multi-hop relay, controlled flooding, source routing, TTL, deduplicazione, fragmentation, store-and-forward, persistent outbox, courier mechanism, spray-and-wait, gossip synchronization, crittografia, identità basate su chiavi crittografiche, fallback tramite Nostr quando Internet è disponibile.

Il whitepaper 2.0 descrive un'architettura già orientata ad ambienti low bandwidth, lossy, partitioned, con membership variabile, e un'architettura dual transport (Bluetooth mesh locale + Nostr per Internet). Licenza: public domain.

ARALD **non** è una fork di BitChat. Modello previsto:

```
BitChat transport/network concepts
                +
Project NOMAD services/content
                +
NUOVO ARALD NETWORK FABRIC
```

BitChat è orientato principalmente a messaggi. ARALD generalizza il concetto di messaggio in quello di risorsa: messaggio, file, documento, immagine, mappa, database, pagina, servizio, richiesta AI, risposta AI, applicazione, dataset.

---

## 6. Casi d'uso

### 6.1 Emergenza / calamità
Internet e rete cellulare assenti, elettricità parziale, operatori di soccorso, dispositivi mobili, uno o più nodi NOMAD disponibili. Un nodo può contenere mappe, manuali, numeri di emergenza, procedure, documentazione medica, database, messaggi, AI locale. I dispositivi vicini comunicano via mesh; un secondo nodo può arrivare dopo ore e sincronizzare i dati. Non serve infrastruttura preesistente.

### 6.2 Rifugio alpino (caso d'uso prioritario)
```
NOMAD NODE
|
+-- mappe
+-- sentieri
+-- informazioni rifugio
+-- bollettini
+-- manuali
+-- meteo dell'ultimo aggiornamento
+-- informazioni di sicurezza
+-- AI locale
+-- documentazione
```
Gli escursionisti si connettono localmente, possono richiedere mappe/documenti senza rete cellulare; i messaggi possono essere memorizzati e inoltrati successivamente.

### 6.3 Area rurale
Un singolo nodo con Internet periodico sincronizza dati e li distribuisce alla comunità; la rete non richiede Internet continuo per ogni dispositivo.

### 6.4 Eventi affollati
Nodi collegati a Internet + rete locale distribuita per programma, mappe, lineup, FAQ, orari, istruzioni, sicurezza; contenuti statici replicati.

### 6.5 Scuole
Un nodo NOMAD fornisce libri, Wikipedia, corsi, mappe, documentazione, AI, contenuti educativi ad accesso locale.

### 6.6 Spedizioni / navi / ambienti remoti
Rete interna autonoma con documentazione, mappe, comunicazioni, database, strumenti AI, procedure.

### 6.7 Comunità locali
Bacheca, chat, file, documenti, comunicazioni, informazioni locali — caso d'uso più debole come primo prodotto per l'esistenza di alternative quando Internet funziona.

---

## 7. Architettura dei nodi

```
Mesh Node
|
+-- Identity Manager
+-- Transport Manager
+-- Peer Discovery
+-- Routing Engine
+-- Content Discovery
+-- Cache Manager
+-- Store & Forward
+-- Sync Engine
+-- Security Manager
+-- Service Registry
+-- Storage Manager
```

Non tutti i dispositivi devono avere tutte le funzioni: un telefono può essere client/cache/relay limitato; un computer relay/server/cache/gateway; un server NOMAD service provider/content provider/gateway/nodo di sincronizzazione.

---

## 8. Cosa è fisicamente un gateway

Il gateway non è un hardware specifico: è un dispositivo che possiede contemporaneamente (1) accesso a ARALD e (2) accesso a un'altra rete, normalmente Internet.

```
INTERNET
   |
COMPUTER
   |
ARALD
   |
smartphone
```

Un gateway può essere Mac, PC, Linux server, Raspberry Pi, mini-PC, smartphone Android, eventualmente iPhone in scenari compatibili. Non è necessariamente uno smartphone. Nel primo prototipo può essere semplicemente il computer usato per lo sviluppo; in un'installazione reale un mini-PC o un nodo dedicato.

---

## 9. Strategia hardware iniziale

Il progetto **non** richiede un Raspberry Pi per iniziare. Il primo prototipo usa Mac / PC / smartphone. Il Raspberry Pi arriva successivamente come nodo sempre acceso:

```
Mac -> software node -> smartphone -> routing -> content -> NOMAD -> gateway -> hardware dedicato
```

---

## 10. Architettura software

Repository iniziale:

```
arald/
README.md
LICENSE
docs/
    architecture.md
    protocol.md
    roadmap.md
    development.md
protocol/
node/
gateway/
mobile/
tests/
tools/
```

Struttura in fase successiva:

```
protocol/
    packet/
    content/
    service/
    sync/
node/
    identity/
    discovery/
    routing/
    cache/
    storage/
    transports/
gateway/
    nomad/
mobile/
    android/
    ios/
```

---

## 11. Tecnologie del primo prototipo

TypeScript, Node.js, JSON per il protocollo iniziale, TCP/WebSocket come transport di sviluppo, test automatici, GitHub, Docker dove utile. Non necessario iniziare subito con Rust, protobuf, CBOR, BLE, LoRa, database distribuiti: prima deve funzionare la logica della rete, poi i componenti possono essere ottimizzati.

## 12. Perché TypeScript / Node.js

Sviluppo rapido, buone librerie di networking, fortemente tipizzato, interfacce chiare, portabile su Mac/Linux/Raspberry, CLI rapide, test semplici, coerente con parte dello stack di Project NOMAD. Non è necessariamente il linguaggio definitivo per tutti i componenti: in futuro alcune parti potrebbero essere riscritte in Rust, Swift, Kotlin o codice nativo specifico per piattaforma.

---

## 13. Primo programma: nomad-node

```
node/
    package.json
    tsconfig.json
    src/
        index.ts
        identity.ts
        peer.ts
        protocol.ts
        transport.ts
```

Avvio:

```
npm install
npm run dev
```

Output:

```
ARALD Node
Node ID: 7f3a...
Status: ONLINE
```

## 14. Identità del nodo

Ogni nodo possiede un'identità crittografica. Primo prototipo: **Ed25519 key pair** (`private.key` mai trasmessa, `public.key` base dell'identità). L'identità visualizzata dall'utente (`NODE-A`) è separata dall'identità interna (`7f8a91c3...`).

## 15. Primo protocollo

Tipi iniziali: `HELLO`, `PING`, `PONG`, `PEER_LIST`, `DATA`, `ACK`.

```ts
interface Packet {
    id: string;
    type: MessageType;
    source: string;
    destination?: string;
    ttl: number;
    timestamp: number;
    payload: unknown;
}
```

Formato iniziale JSON; in seguito possibile passaggio a CBOR, protobuf, MessagePack o formato binario custom.

## 16. Primo transport

**Non** BLE. Per lo sviluppo iniziale: TCP oppure WebSocket, per separare il problema della rete dal problema del Bluetooth.

```
A <-> B         poi   A -> B -> C         solo dopo   A --BLE--> B --BLE--> C
```

## 17. Primo test

```
nomad-node --id A --port 9001
nomad-node --id B --port 9002
```

```
NODE A -- TCP -- NODE B
```

A invia `HELLO`, B risponde `HELLO`; A invia `PING`, B risponde `PONG`. Questo è il primo milestone.

## 18. Multi-hop

```
A
|
B
|
C
```

A non è direttamente collegato a C. A invia con `destination = C`; B riceve, verifica `destination != B` e inoltra: `A -> B -> C`. Primo vero comportamento mesh.

## 19. TTL

Ogni pacchetto ha un TTL (es. 5). Ogni relay decrementa (5→4→3→2→1→0); a zero il pacchetto viene eliminato. Impedisce che pacchetti persi o flooding errati circolino indefinitamente.

## 20. Deduplicazione

Ogni pacchetto ha un ID univoco. Ogni nodo mantiene una cache `seen_packets`; se riceve nuovamente lo stesso ID: `DROP`. Fondamentale in una mesh con flooding o gossip.

## 21. Controlled flooding

Non serve subito un routing sofisticato: si usa controlled flooding — i nodi inoltrano solo se non hanno già visto il pacchetto, TTL > 0, il pacchetto è valido e non è già stato inoltrato. In seguito si potrà passare a routing più intelligente.

## 22. Routing evoluto

Il routing deve essere content/service-aware: non solo "come raggiungo C?" ma anche "dove trovo il contenuto richiesto?". Metriche possibili: hop count, latenza, packet loss, banda, batteria, storage, congestione, stabilità del nodo, disponibilità del contenuto, transport utilizzato, affidabilità del nodo.

```
Cost = α·hops + β·latency + γ·loss + δ·energy + ε·congestion
```

I coefficienti saranno determinati sperimentalmente.

---

## 23. Content-centric network

Passaggio fondamentale da BitChat a ARALD: non `SEND FILE TO NODE C` ma `GET content://wikipedia/italia`. La rete risponde `CE L'HO`, `CONOSCO UN PROVIDER` o `NON DISPONIBILE`. Il contenuto può essere sul server originario, su un nodo intermedio, su un telefono, in cache, su un altro segmento di rete.

## 24. Content ID

`content_id = SHA-256(canonical_content)`, oppure un CID content-addressed compatibile con sistemi come IPFS. Per il primo prototipo è sufficiente SHA-256. Metadata: `content_id, name, mime_type, size, hash, version, publisher, timestamp, expiry, signature`.

## 25. Content protocol

Tipi: `CONTENT_QUERY, CONTENT_FOUND, CONTENT_REQUEST, CONTENT_CHUNK, CONTENT_COMPLETE, CONTENT_ERROR`.

```
A --CONTENT_QUERY--> B --CONTENT_QUERY--> C
C possiede il contenuto -> CONTENT_FOUND -> CONTENT_REQUEST -> CONTENT_CHUNK ... -> CONTENT_COMPLETE
```

## 26. Fragmentation

File grandi divisi in chunk (`content_id, chunk_index, total_chunks, chunk_hash, payload`); il destinatario ricostruisce il file e verifica l'hash finale.

## 27. Cache

Un nodo può conservare contenuti ricevuti; se un altro nodo richiede lo stesso contenuto a un nodo che lo ha in cache, non serve raggiungere l'origine. Riduce traffico, latenza, consumo energetico, dipendenza da nodi specifici.

## 28. Cache policy

LRU, TTL, popolarità, scarsità del contenuto, priorità, spazio disponibile. Un contenuto raro potrebbe essere conservato più a lungo di uno facilmente reperibile.

## 29. Replicazione

Contenuti richiesti spesso (high demand) possono essere replicati automaticamente su più nodi; le copie sono utilizzabili quando l'origine è offline. Replica manuale, automatica o opportunistica.

## 30. Store-and-forward

Se il destinatario non è raggiungibile, un nodo intermedio conserva il dato e lo inoltra quando possibile: il dato non va perso solo perché la connessione non esiste nel momento della richiesta. BitChat utilizza già concetti di persistent sender outbox, opportunistic couriers, spray-and-wait, copy budget, sincronizzazione gossip: riferimento diretto per ARALD.

## 31. Delay-tolerant networking

Una richiesta a cui non si può rispondere subito diventa `REQUEST ACCEPTED / STATUS = PENDING` invece di `ERROR`, e viene soddisfatta più tardi quando il contenuto diventa disponibile (es. tramite un gateway Internet). Comportamento di una "Internet intermittente".

## 32. Courier

Un dispositivo mobile può trasportare fisicamente messaggi, metadata, richieste, contenuti e sincronizzazioni tra segmenti di rete non collegati, consegnandoli quando raggiunge l'altro segmento.

## 33. Sync

Quando due reti precedentemente separate si incontrano, non trasferiscono tutto: confrontano prima cataloghi, content ID, versioni, messaggi, servizi, stato. Tecniche possibili: Merkle tree, Bloom filter, GCS filter, version vector, content hash. BitChat usa già meccanismi di sincronizzazione e GCS filter per la cronologia pubblica.

## 34. Network partition

La rete deve gestire segmenti separati (`A-B-C` / `D-E-F`) che poi si ricollegano (`C <-> D`) e si sincronizzano, senza richiedere che tutti i dispositivi siano connessi contemporaneamente.

## 35. Service discovery

Non solo file, anche servizi: `service://translation`, `service://ocr`, `service://search`, `service://ai`, `service://maps`, `service://weather-cache`. Annuncio `SERVICE_ANNOUNCE` con `service_id, version, capabilities, provider_id, resource requirements, availability`.

## 36. AI distribuita

Un nodo potente pubblicizza un servizio LLM locale; un telefono poco potente invia `AI_REQUEST`; la rete trova il provider (es. via gateway NOMAD/Ollama) e restituisce la risposta, senza richiedere il modello su ogni telefono.

## 37. Integrazione con Project NOMAD

Project NOMAD può diventare il principale service provider di ARALD. ARALD non deve inizialmente conoscere i dettagli interni di Kiwix, Ollama o Qdrant: conosce solo un'API astratta (`GET content://wiki/italia`, `CALL service://ai`); il gateway traduce la richiesta nell'API locale del servizio.

## 38. Gateway Internet

Un nodo può avere `INTERNET_GATEWAY = true` e scaricare/aggiornare/sincronizzare contenuti, recuperare mappe, aggiornare AI, inviare dati, sincronizzare reti separate. Il gateway è una funzione software, non necessariamente hardware dedicato.

## 39. Smartphone come gateway

In teoria possibile (4G/5G ↔ BLE mesh), ma **non** deve essere il primo modello per via di: consumo batteria, gestione background, restrizioni OS, instabilità del processo, NAT, gestione transport simultanei. Il gateway ideale per installazioni reali è un computer/mini-PC sempre acceso.

## 40. Mac come primo gateway

Nel primo sviluppo il Mac può fare contemporaneamente sviluppo, nodo, server, gateway e simulatore di NOMAD, permettendo di sviluppare senza Raspberry Pi.

---

## 41. Transport abstraction

```ts
interface Transport {
    id: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    discover(): Promise<Peer[]>;
    connect(peer: Peer): Promise<Connection>;
    send(peer: Peer, packet: Packet): Promise<void>;
    getCapabilities(): TransportCapabilities;
}
```

Primi transport: TCP, BLE, Wi-Fi. Successivi: Wi-Fi Direct, Ethernet, LoRa gateway, Internet.

## 42. BLE

Transport principale per la prima mesh mobile. Vantaggi: presente su quasi tutti gli smartphone, basso consumo, buona discovery, non richiede infrastruttura Wi-Fi, adatto a piccoli pacchetti. Svantaggi: banda limitata, range variabile, gestione connessioni complessa, comportamento diverso tra OS, consumo energetico se continuo, difficoltà a mantenere una mesh mobile persistente. Da usare per discovery, control, piccoli messaggi, metadata, relay, richieste — non per grandi contenuti.

## 43. Wi-Fi

Da usare per file, mappe, documenti, database, contenuti voluminosi, sincronizzazioni. Modalità: Wi-Fi LAN, Wi-Fi Direct, hotspot, infrastruttura locale. Il Network Fabric deve nascondere la differenza.

## 44. BLE + Wi-Fi

```
Phone --BLE--> Node --Wi-Fi--> NOMAD
```
Il telefono usa BLE per entrare nella rete; il nodo usa Wi-Fi per il trasferimento ad alta velocità.

## 45. Eventuale LoRa

Non nel primo MVP. Potenziale transport a bassa banda e lunga distanza per messaggi, telemetria, emergenze, sincronizzazione minima, collegamento tra cluster (`BLE cluster -> gateway -> LoRa -> gateway -> BLE cluster`). Esistono studi recenti su architetture ibride BLE-LoRa per comunicazione di emergenza: riferimento di ricerca, non dipendenza software del progetto.

---

## 46. iOS

Apple Core Bluetooth permette comunicazione BLE e supporta meccanismi specifici di background execution. **A partire da iOS 26**, Apple documenta inoltre la possibilità, in determinate condizioni, di mantenere alcune attività BLE in background se l'app ha una **Live Activity** attiva e un `CBManager` istanziato.

Questo **non** significa che un iPhone possa essere considerato automaticamente un router mesh sempre acceso. Il progetto deve distinguere e testare sperimentalmente ciascuno di questi scenari:

- iPhone in foreground
- iPhone in background
- iPhone con Live Activity
- iPhone sospeso
- iPhone con app terminata

Non bisogna assumere che "BLE disponibile" implichi "app disponibile continuamente per fare relay". Questo va trattato come un **vincolo da verificare sperimentalmente**, non come una garanzia progettuale.

La prima versione iOS può quindi essere: client, nodo opportunistico, relay quando l'app è attiva, cache, courier. Il ruolo di nodo infrastrutturale permanente resta affidato a computer/server.

Riferimento: https://developer.apple.com/documentation/corebluetooth

## 47. Android

Maggiore flessibilità per scenari BLE, ma richiede comunque gestione esplicita delle autorizzazioni. Per Android 12+: `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`. Disponibile anche Companion Device Manager per alcuni scenari di associazione.

Riferimento: https://developer.android.com/develop/connectivity/bluetooth/bt-permissions

La strategia mobile iniziale privilegia Android per i test di rete persistente, usando iOS come secondo target.

---

## 48. Packet format

```
+----------------------+
| Protocol Version     |
+----------------------+
| Packet Type          |
+----------------------+
| Packet ID            |
+----------------------+
| Source ID            |
+----------------------+
| Destination ID       |
+----------------------+
| TTL                  |
+----------------------+
| Timestamp            |
+----------------------+
| Priority              |
+----------------------+
| Flags                |
+----------------------+
| Payload Length        |
+----------------------+
| Payload               |
+----------------------+
| Signature / MAC        |
+----------------------+
```

## 49. Packet types

```
HELLO, ANNOUNCE, CAPABILITY, ROUTE_QUERY, ROUTE_REPLY,
CONTENT_QUERY, CONTENT_REPLY, CONTENT_REQUEST, CONTENT_CHUNK,
SERVICE_QUERY, SERVICE_ANNOUNCE, SERVICE_REQUEST, SERVICE_RESPONSE,
SYNC_REQUEST, SYNC_RESPONSE, STORE, FORWARD, ACK, PING, PONG, ERROR
```

Il protocollo potrà essere ridotto o esteso dopo i test.

## 50. Priorità

```
P0 Emergency
P1 Control
P2 Messaging
P3 Services
P4 Content
P5 Bulk replication
```

In caso di congestione: Emergency > Control > Messages > Service > Content > Bulk.

## 51. Resource management

Ogni nodo può pubblicizzare `battery, CPU, RAM, storage, bandwidth, connection type, availability, relay capability, cache capability`. Il routing può evitare, ad esempio, un telefono con batteria al 5%.

---

## 52. Sicurezza

Modello zero-trust: un relay non deve poter leggere una comunicazione privata (`Sender -> encrypt -> Relay (opaque packet) -> Relay -> Receiver -> decrypt`). BitChat usa già un modello basato su identità crittografiche e sessioni sicure, con Noise e primitive moderne: questa parte va studiata direttamente dalla repository BitChat.

## 53. Identità

Ogni nodo ha `public key` / `private key`; l'identità deve essere verificabile. Il nome leggibile (es. "Rifugio XYZ") non è l'identità primaria: l'identità primaria è crittografica.

## 54. Trust

Stati possibili: `UNKNOWN, SEEN, VERIFIED, TRUSTED, ADMIN`. Utile per reti controllate (`RIFUGIO-NET`, `SOCCORSO-NET`, `SCHOOL-NET`).

## 55. Autenticità dei contenuti

Metadata: `content_id, version, publisher, signature, hash, timestamp, expiry`. Il nodo verifica `hash(content) == content_id` e `signature == valid` prima di considerare attendibile il contenuto — fondamentale per contenuti di emergenza (es. "Evacuare zona X" non deve poter essere modificato da un nodo arbitrario).

## 56. Privacy

Tre categorie: **Public content** (replicabile), **Private content** (cifrato per utenti autorizzati), **Private messages** (end-to-end encrypted). Da minimizzare: identificatori persistenti, posizione, cronologia dei contatti, contenuti richiesti.

## 57. Abusi

Un nodo malevolo potrebbe modificare contenuti, impersonare un server, fare flooding, generare richieste eccessive, consumare batteria altrui, occupare storage, pubblicizzare servizi falsi, droppare pacchetti. Contromisure: autenticazione, firme, rate limiting, quotas, reputation, admission control, TTL, priority, resource limits.

## 58. Incentivi e batteria

Il client deve poter scegliere: `Relay OFF`, `Relay when charging`, `Relay while battery > 30%`, `Emergency mode`, `Full mesh mode`. Non bisogna presumere che un dispositivo faccia relay continuamente.

---

## 59. Web interface

```
ARALD
Connected
Internet: OFFLINE
Local network: ONLINE
Peers: 37
Services: 14
Cached content: 82%
Search:
[ Wikipedia Italia              ]
Available through:
NODE-B -> NODE-C -> NOMAD
```

L'utente non deve essere costretto a capire il routing.

## 60. Esperienza "Internet offline"

Non solo `"No Internet connection"`, ma `Internet: OFFLINE / ARALD: ONLINE` con accesso continuo a ricerca, mappe, documenti, AI, chat, servizi, contenuti locali.

---

## 61. Primo MVP

Il primo MVP **non** deve avere: LoRa, routing sofisticato, AI distribuita, sincronizzazione globale, grandi dataset, sistema di reputation completo, supporto multipiattaforma perfetto. Deve dimostrare `A -> B -> C` senza Internet, con discovery, routing, trasferimento, contenuto, cache.

## 62–74. Fasi di sviluppo

1. **Software puro** (Mac/PC): identity, packet, TCP transport, `HELLO`, `PING`/`PONG`, peer list, routing, TTL, deduplication.
2. **Tre nodi** simulati sullo stesso computer (`A:9001 -> B:9002 -> C:9003`), A invia a C, B inoltra, C riceve.
3. **Trasferimento file**: `hello.txt` da C ad A passando per B, verifica hash.
4. **Content discovery**: A non sa che C possiede il file, chiede `content://example/hello`, B inoltra, C annuncia `CONTENT_FOUND`, A effettua `CONTENT_REQUEST`.
5. **Cache**: A conserva il contenuto ricevuto; D lo richiede successivamente e A risponde direttamente senza raggiungere C.
6. **BLE**: nuovo transport (`node/src/transports/ble.ts`) dietro la stessa interfaccia `Transport`, routing invariato.
7. **Smartphone**: prima app mobile con node identity, peer discovery, connection, search, content request, cache, relay di base.
8. **NOMAD node**: installazione di Project NOMAD su Linux/Debian via Docker.
9. **Gateway** (`gateway/nomad/`): traduce richieste ARALD in richieste API NOMAD (es. `GET content://wiki/italia` → Kiwix, `CALL service://ai` → servizio AI).
10. **Test offline completo**: Internet OFF, NOMAD + Node + BLE mesh, A cerca un contenuto presente su NOMAD e lo ottiene attraverso la mesh — primo MVP completo.

## 72–74. Fasi successive

- **Store-and-forward**: un nodo intermedio conserva una consegna pendente finché il destinatario non torna raggiungibile.
- **Partition sync**: due mesh separate (`A-B-C` / `D-E-F`) si avvicinano (`C <-> D`) e scambiano catalogo, content ID, messaggi, servizi, versioni.
- **Internet gateway**: un nodo con `INTERNET_GATEWAY` scarica, aggiorna, sincronizza, propaga — vera rete intermittente.

## 75. Architettura completa futura

```
                        INTERNET
                        |
                 +--------------+
                 |   Gateway    |
                 +--------------+
                        |
                     Wi-Fi
                        |
                 +--------------+
                 | NOMAD SERVER |
                 +--------------+
                        |
                     ARALD
                        |
      +-----------------+----------------+
      |                 |                |
    Wi-Fi             BLE              BLE
      |                 |                |
   Node A             Phone B          Phone C
      |                                  |
     BLE                                BLE
      |                                  |
   Phone D                            Phone E
```

Ogni nodo può essere client, relay, cache, courier, provider, gateway.

---

## 76–79. Metriche

- **Rete**: peer discovery time, average hop count, packet delivery ratio, latency, throughput, route stability, packet loss, duplicate ratio.
- **Content**: cache hit ratio, discovery time, replication time, content availability, content retrieval latency, storage overhead.
- **DTN**: delivery probability, delivery delay, number of couriers, replication overhead, pending request lifetime.
- **Device**: CPU, RAM, storage, battery, BLE scanning overhead, Wi-Fi energy consumption.

## 80. Scenari di test

A/B diretto; A→B→C; due mesh separate che si ricongiungono; nodo che si sposta; gateway intermittente; 100+ dispositivi simulati; nodo malevolo; batteria bassa; packet loss elevato; connessione intermittente.

## 81–83. Casi d'uso completi

**Rifugio**: nodo NOMAD locale (mappe, sentieri, info rifugio, documentazione, AI, messaggistica) raggiungibile via Wi-Fi/BLE anche senza Internet.
**Emergenza**: contenuti pre-caricati su NOMAD prima dell'emergenza; rete locale continua durante Internet OFF; nodo mobile porta informazioni; sincronizzazione al ritorno del gateway.
**Internet intermittente**: quando disponibile il gateway scarica aggiornamenti/mappe/contenuti/dati; quando assente i dati restano disponibili localmente; al ritorno, `SYNC`. Questa è la definizione operativa di rete intermittente.

## 84. Criticità principali

| Area | Problema | Soluzione |
|---|---|---|
| Banda | BLE non adatto ai grandi file | BLE per controllo/discovery, Wi-Fi per trasferimento |
| Portata | BLE range limitato/variabile | multi-hop + nodi infrastrutturali |
| Batteria | relay continuo consuma | energy-aware routing, modalità relay configurabili |
| iOS | attività BLE in background soggette a regole di sistema (vedi §46) | non basare l'infrastruttura su iPhone sempre attivi |
| Android | flessibile ma richiede permessi BLE espliciti | gestione permessi runtime |
| Scalabilità | flooding indiscriminato non scala | cataloghi, TTL, dedup, routing, probabilistic discovery, cache |
| Sincronizzazione | reti separate per giorni | content hash, Merkle tree, version vector, filtri |
| Storage | replica eccessiva | quota, TTL, LRU, popularity, scarcity |
| Sicurezza | nodo malevolo | identità crittografica, firme, E2E encryption, trust, rate limiting |
| Incentivi | utenti non vogliono fare relay | opt-in, battery thresholds, emergency mode, relay prioritario sui nodi infrastrutturali |

## 85. Principio di deployment

La rete non deve dipendere dalla presenza di migliaia di smartphone. Per ambienti reali devono esistere nodi infrastrutturali (es. `NODE 1 -> NODE 2 -> NODE 3` in un rifugio); gli smartphone diventano nodi opportunistici. Più realistico di "ogni smartphone deve essere sempre un router".

## 86. Hardware futuro (non necessario per l'MVP)

- **Raspberry Pi**: nodo permanente, BLE, Wi-Fi, Ethernet, storage, basso consumo.
- **Mini-PC**: NOMAD completo, AI, grandi cache, gateway.
- **Smartphone**: client, relay opportunistico, courier, cache.
- **Hardware radio dedicato**: potenziale futuro per LoRa, emergenza, backbone a lunga distanza.

---

## 87. Struttura della repository finale

```
arald/
|
+-- protocol/
|   +-- packet/
|   +-- content/
|   +-- service/
|   +-- sync/
|
+-- node/
|   +-- identity/
|   +-- discovery/
|   +-- routing/
|   +-- cache/
|   +-- storage/
|   +-- transports/
|       +-- tcp/
|       +-- ble/
|       +-- wifi/
|
+-- gateway/
|   +-- nomad/
|   +-- internet/
|
+-- mobile/
|   +-- android/
|   +-- ios/
|
+-- tests/
|   +-- unit/
|   +-- integration/
|   +-- network/
|   +-- dtn/
|
+-- tools/
|   +-- simulator/
|   +-- benchmark/
|
+-- docs/
    +-- architecture.md
    +-- protocol.md
    +-- security.md
    +-- transport.md
    +-- development.md
    +-- deployment.md
    +-- roadmap.md
```

## 88. Primi commit consigliati

1. init repository
2. create nomad-node
3. node identity
4. packet protocol
5. TCP transport
6. A-B communication
7. A-B-C routing
8. content transfer
9. local cache
10. NOMAD gateway

Poi: BLE transport, Raspberry/Linux deployment, Android prototype, service discovery, store-and-forward, synchronization, Wi-Fi transport, security hardening.

## 89. Principio di sviluppo

Non sviluppare contemporaneamente BLE, routing, content discovery, AI, NOMAD, mobile, sicurezza, sincronizzazione. Ogni livello va validato prima di aggiungere il successivo:

```
software network -> multi-hop -> content -> cache -> BLE -> smartphone -> NOMAD -> gateway -> DTN -> synchronization -> deployment reale
```

## 90–95. Obiettivi tecnici incrementali

1. **Primo obiettivo**: tre nodi ARALD (`A -> B -> C`) che comunicano senza Internet; C possiede `hello.txt`, A lo richiede via `content://example/hello`, B inoltra, C risponde, A riceve.
2. **Secondo obiettivo**: A conserva il contenuto in cache; D lo richiede e A risponde direttamente (content discovery + routing + caching + replica dimostrati).
3. **Terzo obiettivo**: C viene spento; B (che aveva il contenuto in cache) risponde a D (resilienza, replica, indipendenza dal provider originale).
4. **Quarto obiettivo**: due reti separate (`A-B-C` / `D-E-F`) si incontrano (`C ↔ D`) e sincronizzano i contenuti (partition tolerance, opportunistic sync).
5. **Quinto obiettivo**: un nodo con Internet (`GATEWAY`) recupera un contenuto non disponibile localmente e lo propaga nella mesh (gateway, Internet intermittente, store-and-forward, content replication).
6. **Obiettivo finale**: la rete continua a offrire comunicazione, contenuti, mappe, documentazione, AI, servizi, cache e sincronizzazione sia con Internet ON che OFF, sincronizzando automaticamente al ritorno della connettività.

---

## 96. Repository e riferimenti tecnici da studiare

- **Project NOMAD** — https://github.com/Crosstalk-Solutions/project-nomad — base dei servizi offline (contenuti, AI, mappe, documentazione, server locale).
- **BitChat** — https://github.com/permissionlesstech/bitchat — riferimento per BLE mesh, peer discovery, relay, TTL, flooding, routing, fragmentation, store-and-forward, courier, gossip, sicurezza. Non va copiato integralmente come architettura applicativa.
- **BitChat Protocol Whitepaper 2.0** — https://github.com/permissionlesstech/bitchat/blob/main/WHITEPAPER.md — riferimento principale per la parte mesh/DTN.
- **Apple Core Bluetooth** — https://developer.apple.com/documentation/corebluetooth — nodo iOS e vincoli BLE/background (vedi §46).
- **Android Bluetooth permissions** — https://developer.android.com/develop/connectivity/bluetooth/bt-permissions — BLE su Android (vedi §47).

## 97. Tecnologie di supporto da valutare

Docker (Project NOMAD, servizi, gateway, ambienti di test) · Node.js/TypeScript (Network Runtime) · WebSocket/TCP (primo transport/simulatore, routing pre-BLE) · BLE (transport mobile primario) · Wi-Fi (transport alta capacità) · SQLite (storage locale peer/cache/queue/metadata/pending requests) · Redis (da valutare sui nodi server, non sui telefoni — già usato internamente da Project NOMAD) · MySQL (non necessario nel core, confinato a Project NOMAD) · Qdrant (non necessario per la rete, usato da NOMAD per RAG) · Ollama (service provider AI locale) · Kiwix (provider di contenuti offline) · ProtoMaps (provider di mappe offline tramite NOMAD).

## 98–99. Decisione architetturale e ruoli

ARALD **non** deve diventare un fork gigante di Project NOMAD, né di BitChat:

```
BitChat -- networking ideas --> ARALD -- [content, services, cache, DTN, gateway] --> Project NOMAD
```

ARALD è il livello di rete/interconnessione. Project NOMAD resta il livello dei servizi e dei contenuti. Definizione dei tre ruoli:

- **ARALD**: "Come raggiungo una risorsa?"
- **Project NOMAD**: "Quali risorse e servizi posso offrire?"
- **Gateway**: "Come collego ARALD a una rete esterna?"

Questa separazione va mantenuta durante tutto lo sviluppo.

## 100–101. Definizione del prodotto finale

Non semplicemente "Internet senza Internet", ma:

> "Una rete locale distribuita, content-centric e delay-tolerant che consente a dispositivi mobili e nodi edge di condividere comunicazioni, contenuti e servizi senza infrastruttura Internet e di sincronizzarsi automaticamente quando una connessione esterna diventa disponibile."

Valore distintivo: `BLE mesh + Wi-Fi + content discovery + distributed cache + replication + store-and-forward + delay tolerance + NOMAD + intermittent Internet gateway`.

La rete deve poter transitare continuamente tra `ONLINE -> OFFLINE -> PARTITIONED -> SYNCING -> ONLINE` senza interrompere necessariamente i servizi disponibili localmente.

## 102. Roadmap completa (milestone)

0. Repository e documentazione
1. Node runtime
2. Packet protocol
3. TCP transport
4. Multi-hop
5. Content discovery
6. File transfer
7. Cache
8. BLE
9. Smartphone
10. NOMAD integration
11. Gateway
12. Store-and-forward
13. Partition synchronization
14. Wi-Fi high bandwidth
15. Security hardening
16. Energy-aware routing
17. Raspberry / mini-PC node
18. Rifugio pilot
19. Emergency pilot
20. Scalability testing

## 103–104. Pilot

**Rifugio**: 1 NOMAD server, 1 gateway, 2-3 nodi fissi, 10-50 smartphone; contenuti (mappa, sentieri, info rifugio, numeri utili, manuali, documentazione, AI locale); test: Internet attivo → sincronizzazione → Internet spento → accesso contenuti → messaggi → spostamento utenti → riavvio nodi → perdita di un nodo → ritorno Internet → sincronizzazione.

**Emergenza**: Internet e cellulare OFF, alcuni nodi spenti, alcuni mobili, packet loss, rete divisa, successivo collegamento tra segmenti. Metriche: tempo di discovery, % messaggi consegnati, % contenuti disponibili, tempo di sincronizzazione, consumo batteria, traffico generato, numero di hop.

## 105. Principio finale

Sviluppo dal basso verso l'alto:

```
PACKET -> NODE -> ROUTING -> CONTENT -> CACHE -> BLE/WIFI -> NOMAD -> DTN -> GATEWAY -> REAL DEPLOYMENT
```

```
Internet intermittente + NOMAD + BLE/Wi-Fi mesh + smartphone + store-and-forward + content-centric routing = ARALD
```

---

### Nota tecnica sul riuso

Questa specifica distingue volontariamente tra concetti già implementati da BitChat/Project NOMAD e componenti che ARALD deve sviluppare ex novo. In particolare, **content-centric routing, catalogo distribuito dei contenuti, cache/replica generalizzate, service discovery, integrazione NOMAD e sincronizzazione DTN dei contenuti non vanno considerati automaticamente "già risolti"** solo perché BitChat o Project NOMAD forniscono componenti affini. Il dettaglio è in [`docs/reuse-vs-new.md`](./reuse-vs-new.md).
