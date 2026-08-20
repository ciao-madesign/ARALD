# Roadmap

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §61-74, §88, §90-95, §102.

Stato al 14 agosto 2026, versione specifica 0.1.

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
| 8 | BLE | ✅ Simulato (seguito audit, Slice 8) — hardware reale ⏳ bloccato | `node/src/transports/ble.ts`, dietro l'interfaccia `Transport` esistente, nessun radio reale |
| 9 | Smartphone (app mobile minimale) | ⏳ Pianificata, non avviata | Piano in due fasi in `docs/next-steps.md` Opzione H — client leggero ibrido (Capacitor) verso un gateway; Fase 1 (Wi-Fi/TCP) subito realizzabile, Fase 2 (Bluetooth) bloccata sullo stesso hardware dell'Opzione A |
| 10 | NOMAD integration | ✅ Mockato (seguito audit, Slice 9-10) — Project NOMAD reale ⏳ bloccato | richiede Docker + Project NOMAD in esecuzione per la forma finale reale |
| 11 | Gateway (`gateway/nomad/`) | ✅ Mockato (seguito audit, Slice 9-10) — Docker reale ⏳ bloccato | `kiwix-gateway.ts` (`content://`, `service://kiwix-search`) + `ai-gateway.ts` (`service://ai`), verificati contro `FakeNomadServer`/`FakeOllamaServer` |
| 12 | Store-and-forward | ✅ Fatto (scope: pacchetti unicast) | `node/src/store-and-forward.ts`, `tests/integration/store-and-forward.test.ts` — vedi limitazione nota sotto |
| 13 | Partition synchronization | ✅ Fatto | `node/src/catalog.ts`, `tests/integration/partition-sync.test.ts` |
| 14 | Wi-Fi high bandwidth | ⏳ Bloccato — richiede hardware/OS Wi-Fi Direct reale | `node/src/transports/wifi.ts` |
| 15 | Security hardening | ✅ Fatto | `node/src/encryption.ts`, `node/src/peer-directory.ts`; vedi `security.md` per il dettaglio completo |
| 16 | Energy-aware / cost-based routing | ✅ Fatto | `node/src/relay-policy.ts` (parte energy-aware) + `node/src/routing-table.ts` (parte cost-based, §22) |
| 17 | Raspberry / mini-PC node | ⏳ Bloccato — richiede hardware | deployment hardware, non richiesto per MVP software |
| 18 | Rifugio pilot | ⏳ Bloccato — richiede hardware/deployment reale | vedi `deployment.md` |
| 19 | Emergency pilot | ⏳ Bloccato — richiede hardware/deployment reale | vedi `deployment.md` |
| 20 | Scalability testing | ✅ Fatto | `tools/simulator/simulate.ts`, `tests/network/simulate.test.ts` |

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

## Milestone 15 — sicurezza: dettagli

**Fatto**:
- **Firma dei contenuti** (§55): ogni contenuto pubblicato tramite `NomadNode.publishContent()` viene firmato con la chiave del nodo (Ed25519) su un payload che copre `contentId`, nome, tipo e dimensione — non solo l'hash — cosicché un relay non possa "rietichettare" un contenuto genuino con un nome diverso mantenendo la firma valida (`node/src/content.ts`, `contentSigningPayload`/`verifyContentSignature`). Sia il completamento di un trasferimento sia una voce di catalogo ricevuta via sync devono superare questa verifica prima di essere accettati.
- **Trust levels** (§54): `UNKNOWN/SEEN/VERIFIED/TRUSTED/ADMIN` per node id (`node/src/trust.ts`, `TrustManager`). `SEEN` si guadagna alla connessione diretta, `VERIFIED` quando una firma di quel node id verifica correttamente; `TRUSTED`/`ADMIN` restano assegnazioni manuali dell'operatore. Un nodo può opzionalmente rifiutarsi di fare da relay per un peer sotto una soglia di fiducia configurata (`minTrustToRelay`), senza che questo influisca sulle richieste dirette di quel peer.
- **Rate limiting** (§57): ogni peer ha un budget di pacchetti per finestra temporale (`node/src/rate-limit.ts`); superato il budget, i pacchetti in eccesso vengono scartati senza essere processati.
- **Cifratura end-to-end dei messaggi privati** (§52, §56): chiavi X25519 dedicate (`node/src/encryption.ts`, distinte dalle chiavi Ed25519 di firma), scambio di chiavi via ECDH, cifratura autenticata AES-256-GCM. Ogni nodo pubblica un `IdentityAnnouncement` — il proprio node id Ed25519 legato alla propria chiave di cifratura X25519, autofirmato — propagato peer-to-peer (`node/src/peer-directory.ts`, pacchetti `IDENTITY_REQUEST`/`IDENTITY_RESPONSE`) con lo stesso pattern bilaterale del catalog sync. `NomadNode.sendPrivateMessage()`/evento `private-message` sono additivi rispetto a `sendData()`/evento `data` (che restano deliberatamente in chiaro, usati dal resto della test suite per la meccanica di routing/relay, non per la privacy) — un relay inoltra il pacchetto `PRIVATE_MESSAGE` senza poter decifrarlo, verificato crittograficamente (non solo per assenza dell'evento) in `tests/integration/private-messaging.test.ts`.

Vedi [`security.md`](./security.md) per il dettaglio completo, inclusi i bug reali di sicurezza trovati e corretti durante lo sviluppo.

## Milestone 16 — relay policy e routing a costo: dettagli

Due parti indipendenti, entrambe complete:
- **Relay policy legata a batteria/carica** (§51, §58): un nodo decide se e quando fare da relay per il traffico altrui in base al proprio stato di risorse auto-dichiarato (`node/src/relay-policy.ts`, modalità `off`/`always`/`when-charging`/`battery-above`) — un sì/no complessivo, non una scelta tra percorsi alternativi.
- **Routing a costo (distance-vector)** (§22): `node/src/routing-table.ts`, propagato tramite pacchetti `ROUTE_ANNOUNCE` scambiati direttamente tra vicini (mai flood-ati, come `IDENTITY_REQUEST`/`SYNC_REQUEST`). Ogni nodo mantiene la migliore rotta nota (`{nextHop, cost}`) per destinazione, aggiornata con lo stesso pattern "triggered update" dei protocolli distance-vector classici (es. RIP): un cambiamento locale (nuovo vicino diretto, rotta migliore/peggiore appresa, rotta ritirata alla disconnessione) viene ripropagato subito agli altri vicini, applicando lo split horizon (non si riannuncia a un vicino una rotta il cui next hop è quel vicino stesso). Il costo è oggi il solo hop count (α·hops nella formula `Cost = α·hops + β·latency + γ·loss + δ·energy + ε·congestion` di §22) — gli altri termini richiederebbero misurazioni di link reali (latenza, perdita, energia, congestione) che questo prototipo non ha modo di raccogliere senza hardware reale; sono lasciati come coefficienti futuri, come la specifica stessa anticipa ("i coefficienti saranno determinati sperimentalmente"). Il traffico unicast (`sendData`, `sendPrivateMessage`, risposte content-centric) preferisce la rotta nota quando esiste; il controlled flooding (Milestone 2/21) resta il meccanismo di bootstrap/fallback prima che una rotta converga, e l'unico meccanismo per il traffico broadcast (`CONTENT_QUERY`) — vedi `tests/integration/routing.test.ts` per la prova diretta (spia su `sendToPeer`) che l'invio instradato usa un solo next hop invece di floodare tutti i vicini, e per la prova di resilienza quando la rotta nota diventa stale e si torna al flooding.

**Limitazione nota, condivisa con il modello di fiducia del resto del progetto**: le rotte non sono autenticate crittograficamente — un vicino connesso può annunciare qualunque `{destination, cost}, e viene creduto sulla parola, esattamente come già accade per il controlled flooding (che inoltra a chiunque sia connesso senza validare l'affidabilità del percorso). A differenza del flooding, però, instradare significa inviare a un solo next hop invece che a tutti: un vicino malevolo che si dichiara falsamente il percorso più economico verso una destinazione può quindi silenziosamente fare da blackhole per quel traffico, senza la ridondanza che il flooding offrirebbe. Non risolto in questa milestone (richiederebbe autenticazione delle rotte e/o percorsi multipli con conferma end-to-end, entrambi fuori scope) — documentato come rischio noto in `security.md`.

## Milestone 20 — simulatore: dettagli

`tools/simulator/simulate.ts` avvia N istanze reali di `NomadNode` in locale, le collega secondo una topologia configurabile (catena, anello, stella, casuale) ed esegue lo scenario "content fanout" (un nodo pubblica, tutti gli altri lo richiedono), misurando percentuale di consegna e latenza (§76-77). Utilizzabile anche da riga di comando: `npm run simulate -- --nodes 50 --topology random`. Lo sviluppo di questo strumento ha scovato un bug reale nel transport TCP di base (due connessioni simultanee tra la stessa coppia di nodi lasciavano un socket "orfano" che bloccava per sempre la chiusura del nodo) — corretto in `node/src/transports/tcp.ts`, con test di regressione dedicato.

## Secondo giro: seguito dell'audit tecnico (concluso, più un'estensione)

Con le Milestone 12, 13, 15, 16 e 20 completate, è stato eseguito un audit tecnico completo (test, sicurezza, qualità del codice — vedi [`docs/audit-report.html`](./audit-report.html)) che ha identificato ulteriori miglioramenti realizzabili in puro software, realizzati come sequenza di 9 slice pianificate più una decima aggiunta successivamente su richiesta esplicita dell'utente, tracciate in dettaglio in [`security.md`](./security.md) ("Bug corretti nel seguito dell'audit"):

| # | Slice | Stato |
|---|---|---|
| 1 | Retry al prossimo content provider quando quello attivo tace | ✅ Fatto |
| 2 | `BoundedFifoMap` condivisa (rimossa duplicazione 5x) | ✅ Fatto |
| 3 | Eviction pesata sulla fiducia per `PeerDirectory`/`RemoteCatalog` | ✅ Fatto |
| 4 | Scheduling reale basato su priorità in `TcpTransport` | ✅ Fatto |
| 5 | Pacchetto `CONTENT_NOT_FOUND` + scadenza dei contenuti | ✅ Fatto |
| 6 | Protocollo di service discovery (`SERVICE_*`) | ✅ Fatto |
| 7 | Interfaccia web locale di stato/ricerca (spec §59) | ✅ Fatto |
| 8 | Transport BLE **simulato** (Milestone 8 senza hardware reale) | ✅ Fatto |
| 9 | Gateway NOMAD mockato contro un fake server locale (Milestone 11 senza Docker) | ✅ Fatto |
| 10 | Gateway AI mockato (`service://ai`, spec §37) contro un fake Ollama locale | ✅ Fatto |

Le Slice 8, 9 e 10 dimostrano che una parte di Milestone 8 e 11 *è* realizzabile in puro software: un transport BLE simulato (stessa interfaccia `Transport`, vincoli di MTU/frammentazione realistici, nessun radio reale) e due adapter gateway (Kiwix e AI) contro server HTTP fittizi locali invece di Project NOMAD vero. Non sostituiscono la validazione con hardware/Docker reali (restano comunque necessarie prima di un deployment vero), ma permettono di validare la logica applicativa adesso — tutte e tre le slice sono ora completate, chiudendo sia il secondo giro post-audit di 9 slice pianificate sia l'estensione con la decima.

## Ordine di lavoro consigliato per i prossimi passi

Dopo la Slice 10 (l'ultima realizzata, oltre le 9 pianificate), quello che resta è bloccato su uno dei due prerequisiti esterni veri e propri:

- **Milestone 8/9** (BLE/hardware reale, app mobile) richiedono dispositivi fisici per i test end-to-end.
- **Milestone 10/11** (integrazione e gateway NOMAD reali) richiedono Docker e un'istanza di Project NOMAD raggiungibile.
- **Milestone 14** (Wi-Fi Direct) richiede API di sistema operativo legate all'hardware di rete reale.
- **Milestone 17-19** (deployment hardware, pilot) richiedono per definizione hardware reale.

Il confronto dettagliato è in [`docs/next-steps.md`](./next-steps.md) (aggiornato con lo stato corrente).
