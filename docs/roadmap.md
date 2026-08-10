# Roadmap

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §61-74, §88, §90-95, §102.

Stato al 10 agosto 2026, versione specifica 0.1.

## Milestone

| # | Milestone | Stato | Note |
|---|---|---|---|
| 0 | Repository e documentazione | ✅ Fatto | questo commit |
| 1 | Node runtime (identity, packet, TCP, HELLO/PING/PONG, peer list) | ✅ Fatto | `node/src/identity.ts`, `packet.ts`, `transports/tcp.ts` |
| 2 | Packet protocol (TTL, dedup, multi-hop `A -> B -> C`) | ✅ Fatto | `node/src/routing.ts` |
| 3 | TCP transport | ✅ Fatto | incluso in Milestone 1 |
| 4 | Multi-hop | ✅ Fatto | `tests/integration/three-node-relay.test.ts` |
| 5 | Content discovery | ✅ Fatto | `node/src/content.ts`, `tests/integration/content-retrieval.test.ts` |
| 6 | File transfer (chunking, verifica hash) | ✅ Fatto | incluso nel content protocol, chunking a scopo dimostrativo |
| 7 | Cache | ✅ Fatto | `tests/integration/cache-replication.test.ts` |
| 8 | BLE | ⏳ Non iniziato | richiede `node/src/transports/ble.ts` dietro l'interfaccia `Transport` esistente |
| 9 | Smartphone (app mobile minimale) | ⏳ Non iniziato | `mobile/android` prioritario su `mobile/ios` (§47) |
| 10 | NOMAD integration | ⏳ Non iniziato | richiede Project NOMAD in esecuzione (Docker, Debian-based) |
| 11 | Gateway (`gateway/nomad/`) | ⏳ Non iniziato | traduzione richieste Nomad-Net → API NOMAD |
| 12 | Store-and-forward | ✅ Fatto (scope: pacchetti unicast) | `node/src/store-and-forward.ts`, `tests/integration/store-and-forward.test.ts` — vedi limitazione nota sotto |
| 13 | Partition synchronization | ✅ Fatto | `node/src/catalog.ts`, `tests/integration/partition-sync.test.ts` |
| 14 | Wi-Fi high bandwidth | ⏳ Bloccato — richiede hardware/OS Wi-Fi Direct reale | `node/src/transports/wifi.ts` |
| 15 | Security hardening | 🔶 Parziale — firma dei contenuti fatta | vedi `security.md`; restano trust levels, E2E, rate limiting |
| 16 | Energy-aware routing | ⏳ Non iniziato | funzione di costo multi-metrica (§22) — software puro, nessun blocco hardware |
| 17 | Raspberry / mini-PC node | ⏳ Bloccato — richiede hardware | deployment hardware, non richiesto per MVP software |
| 18 | Rifugio pilot | ⏳ Bloccato — richiede hardware/deployment reale | vedi `deployment.md` |
| 19 | Emergency pilot | ⏳ Bloccato — richiede hardware/deployment reale | vedi `deployment.md` |
| 20 | Scalability testing | ⏳ Non iniziato | 100+ dispositivi simulati (§80) — software puro, nessun blocco hardware |

## I "cinque obiettivi tecnici" della specifica (§90-95)

1. ✅ **Primo obiettivo**: `A -> B -> C` senza Internet, A recupera `content://example/hello` posseduto solo da C.
2. ✅ **Secondo obiettivo**: un quarto nodo D recupera lo stesso contenuto da A (cache), senza raggiungere C.
3. ✅ **Terzo obiettivo**: C viene spento, B (che ha il contenuto in cache) risponde a D.
4. ✅ **Quarto obiettivo**: due mesh separate (`A-B-C` / `D-E-F`) si incontrano su un solo nuovo collegamento e sincronizzano i cataloghi senza ritrasferire i byte — vedi `tests/integration/partition-sync.test.ts`.
5. ⏳ **Quinto obiettivo**: un gateway con Internet recupera un contenuto assente localmente e lo propaga nella mesh — **bloccato**: richiede Milestone 11 (gateway NOMAD/Internet), che a sua volta richiede Docker + un'istanza NOMAD raggiungibile.

Gli obiettivi 1-4 sono dimostrati dai test in `tests/integration/`. L'obiettivo finale (§95 — la rete continua a funzionare transitando tra `ONLINE -> OFFLINE -> PARTITIONED -> SYNCING -> ONLINE`) richiede anche il quinto obiettivo, quindi resta bloccato sullo stesso prerequisito.

## Milestone 12 — store-and-forward: dettagli e limitazione nota

Un nodo che riceve un pacchetto unicast (destinatario specifico) ma non ha al momento nessun collegamento verso cui inoltrarlo — o il cui unico tentativo di invio fallisce — lo tiene in coda (`node/src/store-and-forward.ts`, classe `PendingDeliveryQueue`) invece di scartarlo. La coda viene svuotata automaticamente ogni volta che il nodo stabilisce una nuova connessione (scenario "courier", spec §32: un dispositivo che si sposta tra due segmenti di rete disconnessi). Scope volutamente limitato ai pacchetti unicast (DATA, ACK, e l'intero flusso `CONTENT_FOUND/REQUEST/CHUNK/COMPLETE` una volta che un provider è stato trovato) — le query di scoperta broadcast (`CONTENT_QUERY`) non vengono accodate.

**Limitazione nota**: la scadenza della coda (`storeAndForwardTtlMs`, default 5 minuti) è indipendente dall'eviction della cache di deduplicazione (`SeenCache` in `node/src/routing.ts`, limitata per dimensione a 4096 id, non per tempo). In condizioni di traffico molto sostenuto, l'id di un pacchetto rimasto a lungo in coda potrebbe uscire dalla `SeenCache` di un altro nodo prima che il pacchetto venga effettivamente ritentato, con il rischio teorico di una consegna duplicata. Non è stata risolta in questa milestone (richiederebbe coordinare le due politiche di eviction) — è documentata come rischio noto, non come bug silenzioso.

## Milestone 13 — partition sync: dettagli

Quando due nodi si connettono (in qualunque momento, non solo dopo una partizione), si scambiano automaticamente un catalogo dei contenuti che conoscono — solo metadata (`contentId`, nome, tipo, dimensione, publisher, firma), mai i byte veri e propri (`node/src/catalog.ts`, classe `RemoteCatalog`; pacchetti `SYNC_REQUEST`/`SYNC_RESPONSE`). Questo permette a un nodo di sapere che un contenuto esiste altrove nella mesh prima ancora di chiederlo esplicitamente per nome/ID — utile per un'eventuale interfaccia di ricerca (spec §59). Il recupero effettivo dei byte avviene comunque, quando serve, attraverso il normale meccanismo di `CONTENT_QUERY` già in uso da Milestone 5. Ogni voce di catalogo ricevuta da un peer deve superare la stessa verifica di firma usata per i contenuti veri e propri (vedi Milestone 15) prima di essere accettata — un peer non fidato non può iniettare informazioni false su cosa esiste nella mesh.

## Milestone 15 — sicurezza: cosa è stato fatto e cosa resta

**Fatto**: ogni contenuto pubblicato tramite `NomadNode.publishContent()` viene firmato con la chiave del nodo (Ed25519) su un payload che copre `contentId`, nome, tipo e dimensione — non solo l'hash — cosicché un relay non possa "rietichettare" un contenuto genuino con un nome diverso mantenendo la firma valida (`node/src/content.ts`, `contentSigningPayload`/`verifyContentSignature`). Sia il completamento di un trasferimento (`ContentStore.putVerified`, usato sia dal richiedente finale sia dai relay che fanno cache passiva) sia una voce di catalogo ricevuta via sync devono superare questa verifica prima di essere accettati — nessuno dei due percorsi si fida ciecamente di quello che un peer dichiara.

**Non ancora fatto** (candidati per una prossima sessione, nessuno richiede hardware o Docker): trust levels (`UNKNOWN/SEEN/VERIFIED/TRUSTED/ADMIN`, spec §54), cifratura end-to-end dei pacchetti (oggi un relay legge il payload in chiaro), rate limiting/admission control contro un nodo che fa flooding (spec §57). Vedi [`security.md`](./security.md) per i dettagli.

## Ordine di lavoro consigliato per i prossimi passi

Con Milestone 12, 13 e (parzialmente) 15 completate in questa sessione, tutto ciò che si poteva costruire e testare **senza hardware BLE e senza Docker/Project NOMAD** è stato portato avanti fino al punto in cui la prossima estensione naturale richiede uno di questi due elementi:

- **Milestone 8/9** (BLE, app mobile) richiedono dispositivi fisici per i test end-to-end.
- **Milestone 10/11** (integrazione e gateway NOMAD) richiedono Docker e un'istanza di Project NOMAD raggiungibile.
- **Milestone 14** (Wi-Fi Direct) richiede API di sistema operativo legate all'hardware di rete reale.
- **Milestone 17-19** (deployment hardware, pilot) richiedono per definizione hardware reale.

Restano invece **ancora percorribili senza hardware/Docker**, se si vuole proseguire ulteriormente prima di procurarsi quegli elementi: completare la Milestone 15 (trust levels, rate limiting, E2E — vedi sopra), la Milestone 16 (routing energy-aware, con metriche simulate/auto-dichiarate in assenza di dispositivi reali) e la Milestone 20 (simulatore/test di scalabilità con molti nodi in-process). Il confronto dettagliato delle opzioni originariamente aperte è in [`docs/next-steps.md`](./next-steps.md) (aggiornato con lo stato corrente).
