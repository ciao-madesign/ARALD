# Prossimi passi

Riferimento: [`docs/roadmap.md`](./roadmap.md) per lo stato di tutte le milestone (0-20). Questo documento traduce le milestone candidate come "prossimo passo" in piani d'azione concreti — file da toccare, prerequisiti, rischi, criteri di accettazione — così la scelta si può fare con cognizione di causa invece che sulla sola numerazione.

**Stato: tutto ciò che si poteva fare senza hardware BLE e senza Docker/Project NOMAD è stato completato**, in due passate successive. Oltre all'Opzione C (store-and-forward, Milestone 12), sono state completate: Milestone 13 (partition sync, `node/src/catalog.ts`), Milestone 15 quasi per intero (firma dei contenuti, trust levels, rate limiting — vedi `docs/security.md`), una parte della Milestone 16 (relay policy legata a batteria/carica, `node/src/relay-policy.ts`) e la Milestone 20 (simulatore di rete, `tools/simulator/`). Le opzioni A (BLE) e B (gateway NOMAD), qui sotto invariate rispetto alla pianificazione originale, restano **bloccate**: richiedono rispettivamente hardware fisico e un'istanza Docker di Project NOMAD, nessuno dei due disponibile in questa sessione. Restano solo due candidati aperti in puro software (cifratura E2E e routing a costo multi-metrica completo) — vedi la sezione finale.

## Come leggere questo documento

Per ciascuna opzione: cosa costruire, file coinvolti, prerequisiti, criteri di accettazione (come si verifica che è fatta), rischi principali, sforzo relativo.

---

## Opzione A — BLE transport (roadmap Milestone 8)

**Cosa costruire**: `node/src/transports/ble.ts`, che implementa l'interfaccia `Transport` già esistente (`node/src/transport.ts`) — lo stesso contratto già usato da `TcpTransport`, così il routing e il content-centric layer restano invariati (spec §16, §67).

**Decisione preliminare da prendere prima di iniziare**: dove prototipare BLE.
- Su Node.js desktop, con librerie come `@abandonware/noble` (central/scan) e `@abandonware/bleno` (peripheral/advertise) — stesso linguaggio del resto del progetto, ma il supporto per fare *sia* central *sia* peripheral sullo stesso processo è limitato e dipende dal sistema operativo (più fattibile su Linux/BlueZ, limitato su macOS).
- Direttamente in un'app Android nativa (Kotlin, `BluetoothLeScanner`/`BluetoothGattServer`) — la specifica privilegia comunque Android come primo target mobile (§47), quindi questo lavoro confluirebbe comunque nella Milestone 9.

**File coinvolti**: `node/src/transports/ble.ts`; probabilmente anche un livello di fragmentation *a livello di transport* separato dal chunking di contenuto esistente — l'MTU BLE tipico (~20-500 byte) è molto più piccolo di `CHUNK_SIZE` (4096 byte in `node/src/content.ts`), quindi un singolo `CONTENT_CHUNK` andrebbe comunque spezzettato ulteriormente per attraversare un link BLE.

**Prerequisiti**: hardware BLE reale per i test end-to-end. I test automatici (`tests/integration/`) non possono verificare BLE reale in CI — servirebbe un `Transport` fittizio ("loopback BLE simulato") per i test automatici, più verifica manuale su dispositivi reali. **Stato: bloccata — nessun hardware BLE disponibile in questa sessione.**

**Criteri di accettazione**: gli stessi scenari di `tests/integration/three-node-relay.test.ts` e `content-retrieval.test.ts`, ma con `TcpTransport` sostituito da `BleTransport`, eseguiti su almeno due dispositivi fisici (spec §67 — "il routing non deve essere modificato" nel passaggio di transport).

**Rischi principali**: complessità cross-platform (§46-47, in particolare i vincoli iOS trattati come sperimentali in `docs/transport.md`); l'MTU limitato obbliga a rivedere il framing; una mesh BLE reale è meno affidabile di TCP locale e richiede retry/backoff che oggi non esistono nel codice.

**Sforzo relativo**: **alto** — nuovo dominio tecnico, hardware nel loop, nessuna copertura CI automatica possibile.

---

## Opzione B — Gateway NOMAD (roadmap Milestone 10-11)

**Cosa costruire**: `gateway/nomad/`, un processo che espone al mesh Nomad-Net (tramite un `NomadNode` locale, stesso transport TCP già validato) le stesse API `content://...` / `service://...` già testate, risolvendo però le richieste chiamando le API HTTP di un'istanza reale di Project NOMAD (es. Kiwix) invece di leggere da un `ContentStore` locale statico.

**File coinvolti**: un entry point del gateway (es. `gateway/nomad/index.ts`) più un adapter per servizio NOMAD esposto — partire da **un solo** servizio (Kiwix è il candidato più semplice: API HTTP di sola lettura) per contenere lo scope iniziale.

**Prerequisiti**: un'istanza di Project NOMAD funzionante e raggiungibile via Docker (richiede un ambiente Docker + sistema Debian-based o container Linux compatibile, spec §4). **Stato: bloccata — nessun ambiente Docker/Project NOMAD disponibile in questa sessione.**

**Criteri di accettazione**: un `NomadNode` con questo gateway attivo risponde a una `CONTENT_QUERY` per un articolo Kiwix reale con lo stesso ciclo `CONTENT_FOUND` → `CONTENT_REQUEST` → `CONTENT_CHUNK`* → `CONTENT_COMPLETE` già coperto dai test esistenti, servendo dati reali invece che contenuto pubblicato via `publishContent()`.

**Rischi principali**: Project NOMAD "non dichiarato stabile" (spec §4) — la sua API potrebbe cambiare sotto i piedi; il setup Docker è un prerequisito ambientale non garantito.

**Sforzo relativo**: **medio** — riusa quasi interamente il codice già scritto e testato in questa sessione (`NomadNode`, protocollo, routing, content store come cache); il lavoro nuovo è isolato nell'adapter HTTP verso NOMAD.

---

## Opzione C — Store-and-forward (roadmap Milestone 12) — ✅ completata

**Nota**: questa sezione è stata lasciata invariata come riferimento storico della pianificazione originale. Lo stato reale è in [`docs/roadmap.md`](./roadmap.md).

**Cosa costruire**: una coda di consegne pendenti per pacchetti unicast il cui destinatario non è (ancora) raggiungibile, invece di lasciarli morire silenziosamente per TTL come accade oggi. È precondizione esplicita per il quarto e quinto obiettivo tecnico della specifica (§93-94: partition sync tra mesh separate, gateway Internet intermittente).

**File coinvolti**: un nuovo modulo (es. `node/src/store-and-forward.ts`) più un punto di integrazione in `node.ts`: quando `floodExcept` non ha peer raggiungibili per un pacchetto unicast (o il pacchetto muore per assenza di percorso), va accodato invece di essere scartato, e ritentato quando un nuovo peer si connette (evento `peer:connected`, già emesso da `NomadNode`).

**Prerequisiti**: nessuno nuovo — si basa interamente su codice e infrastruttura di test già esistenti.

**Criteri di accettazione**: un test analogo a `tests/integration/cache-replication.test.ts`, ma con un nodo destinatario D **disconnesso** al momento dell'invio, che si riconnette successivamente a un nodo intermedio e riceve comunque il pacchetto/contenuto accodato nel frattempo.

**Rischi principali**: va progettata una policy di scadenza/priorità/quota per la coda (spec §50, §57) per evitare che un nodo con storage limitato si riempia di consegne pendenti mai reclamate — nessun rischio legato a dipendenze esterne però.

**Sforzo relativo**: **medio-basso** — è l'opzione più vicina al codice già scritto e verificato in questa sessione; nessuna nuova dipendenza esterna (hardware BLE, Docker) nel percorso critico.

---

## Opzione D — Partition sync (roadmap Milestone 13) — ✅ completata

Aggiunta a questo documento a posteriori: emersa come prosecuzione naturale dell'Opzione C una volta completata, senza introdurre dipendenze nuove. Due nodi che si connettono si scambiano automaticamente un catalogo di cosa possiedono (solo metadata, mai i byte), così due segmenti di mesh precedentemente separati possono sapere cosa esiste dall'altra parte non appena si ricollegano, senza dover ritrasferire tutto — vedi `node/src/catalog.ts` e `docs/roadmap.md` milestone 13 per il dettaglio. Realizza direttamente il quarto obiettivo tecnico della specifica (§93).

## Opzione E — Firma dei contenuti, trust levels, rate limiting (Milestone 15, quasi completa) — ✅ completata

Emersa a posteriori: senza autenticità verificabile, sia il content discovery (Milestone 5) sia il catalog sync (Opzione D) si fidano ciecamente di qualunque cosa un peer dichiari — un gap di sicurezza reale, non solo teorico, indipendente da hardware o Docker. Realizzato in due passate: prima la firma dei contenuti (Ed25519 su nome/tipo/dimensione oltre che sull'hash), poi trust levels (`UNKNOWN/SEEN/VERIFIED/TRUSTED/ADMIN`) e rate limiting per peer. Tre bug di sicurezza reali sono stati trovati e corretti durante lo sviluppo — vedi `docs/security.md` per il dettaglio, incluso il più grave (verifica della firma calcolata ma mai controllata sul percorso principale di recupero contenuti). Resta aperta solo la cifratura end-to-end.

## Opzione F — Relay policy legata a batteria/carica (parte della roadmap Milestone 16) — ✅ completata (parziale)

Realizza la parte pratica di spec §51/§58 ("Relay OFF / Relay when charging / Relay while battery > X%"): un nodo decide se fare da relay per il traffico altrui in base al proprio stato di risorse auto-dichiarato, senza che questo influisca sulle richieste dirette rivolte a lui. Non realizza la funzione di costo multi-metrica completa di §22 (che richiederebbe una vera selezione di percorso tra alternative, non presente nell'architettura a controlled-flooding attuale) — vedi `docs/roadmap.md` milestone 16 per la distinzione.

## Opzione G — Simulatore di rete (roadmap Milestone 20) — ✅ completata

`tools/simulator/simulate.ts` collega N nodi reali in una topologia configurabile e misura consegna/latenza a scala (§76-80), utilizzabile anche da riga di comando. Il suo sviluppo ha scovato un bug reale nel transport TCP di base (due connessioni simultanee tra la stessa coppia di nodi bloccavano per sempre la chiusura di un nodo) — corretto con test di regressione dedicato, vedi `docs/roadmap.md` milestone 20.

## Cosa resta possibile in puro software, se si vuole andare oltre

Solo due candidati restano aperti, nessuno dei due richiede hardware BLE o Docker/Project NOMAD — entrambi più complessi delle estensioni già fatte e meritano di essere affrontati singolarmente:

| Candidato | Cosa aggiungerebbe | Sforzo |
|---|---|---|
| Cifratura end-to-end (spec §52) | I relay instradano senza poter leggere il payload di `DATA`/`CONTENT_CHUNK` privati — oggi lo leggono in chiaro | Medio-alto |
| Routing a costo multi-metrica completo (spec §22, resto della Milestone 16) | Vera selezione del percorso migliore tra più alternative (hop count, latenza, perdita, energia, congestione), non solo un sì/no complessivo come l'attuale relay policy | Alto — richiederebbe superare il modello di controlled flooding attuale |

## Come procedere

Le opzioni A (BLE) e B (gateway NOMAD) sono le uniche due rimaste dalla pianificazione originale, ed entrambe restano bloccate sugli stessi prerequisiti ambientali (hardware fisico; Docker + Project NOMAD). Quando quegli elementi saranno disponibili, si riprende da lì. Nel frattempo, se si vuole proseguire ulteriormente in puro software, la tabella sopra elenca le due opzioni ancora aperte — indicare quale avviare alla prossima richiesta.
