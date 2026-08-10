# Prossimi passi

Riferimento: [`docs/roadmap.md`](./roadmap.md) per lo stato di tutte le milestone (0-20). Questo documento traduce le milestone candidate come "prossimo passo" in piani d'azione concreti — file da toccare, prerequisiti, rischi, criteri di accettazione — così la scelta si può fare con cognizione di causa invece che sulla sola numerazione.

**Stato: Opzione C (store-and-forward) selezionata e completata.** Vedi `node/src/store-and-forward.ts`, `tests/integration/store-and-forward.test.ts` e la nota su [`docs/roadmap.md`](./roadmap.md#milestone-12--store-and-forward-dettagli-e-limitazione-nota) per lo scope e una limitazione nota (non bloccante). Le opzioni A (BLE) e B (gateway NOMAD) restano aperte e sono confrontate qui sotto, invariate.

## Come leggere questo documento

Per ciascuna opzione: cosa costruire, file coinvolti, prerequisiti, criteri di accettazione (come si verifica che è fatta), rischi principali, sforzo relativo.

---

## Opzione A — BLE transport (roadmap Milestone 8)

**Cosa costruire**: `node/src/transports/ble.ts`, che implementa l'interfaccia `Transport` già esistente (`node/src/transport.ts`) — lo stesso contratto già usato da `TcpTransport`, così il routing e il content-centric layer restano invariati (spec §16, §67).

**Decisione preliminare da prendere prima di iniziare**: dove prototipare BLE.
- Su Node.js desktop, con librerie come `@abandonware/noble` (central/scan) e `@abandonware/bleno` (peripheral/advertise) — stesso linguaggio del resto del progetto, ma il supporto per fare *sia* central *sia* peripheral sullo stesso processo è limitato e dipende dal sistema operativo (più fattibile su Linux/BlueZ, limitato su macOS).
- Direttamente in un'app Android nativa (Kotlin, `BluetoothLeScanner`/`BluetoothGattServer`) — la specifica privilegia comunque Android come primo target mobile (§47), quindi questo lavoro confluirebbe comunque nella Milestone 9.

**File coinvolti**: `node/src/transports/ble.ts`; probabilmente anche un livello di fragmentation *a livello di transport* separato dal chunking di contenuto esistente — l'MTU BLE tipico (~20-500 byte) è molto più piccolo di `CHUNK_SIZE` (4096 byte in `node/src/content.ts`), quindi un singolo `CONTENT_CHUNK` andrebbe comunque spezzettato ulteriormente per attraversare un link BLE.

**Prerequisiti**: hardware BLE reale per i test end-to-end. I test automatici (`tests/integration/`) non possono verificare BLE reale in CI — servirebbe un `Transport` fittizio ("loopback BLE simulato") per i test automatici, più verifica manuale su dispositivi reali.

**Criteri di accettazione**: gli stessi scenari di `tests/integration/three-node-relay.test.ts` e `content-retrieval.test.ts`, ma con `TcpTransport` sostituito da `BleTransport`, eseguiti su almeno due dispositivi fisici (spec §67 — "il routing non deve essere modificato" nel passaggio di transport).

**Rischi principali**: complessità cross-platform (§46-47, in particolare i vincoli iOS trattati come sperimentali in `docs/transport.md`); l'MTU limitato obbliga a rivedere il framing; una mesh BLE reale è meno affidabile di TCP locale e richiede retry/backoff che oggi non esistono nel codice.

**Sforzo relativo**: **alto** — nuovo dominio tecnico, hardware nel loop, nessuna copertura CI automatica possibile.

---

## Opzione B — Gateway NOMAD (roadmap Milestone 10-11)

**Cosa costruire**: `gateway/nomad/`, un processo che espone al mesh Nomad-Net (tramite un `NomadNode` locale, stesso transport TCP già validato) le stesse API `content://...` / `service://...` già testate, risolvendo però le richieste chiamando le API HTTP di un'istanza reale di Project NOMAD (es. Kiwix) invece di leggere da un `ContentStore` locale statico.

**File coinvolti**: un entry point del gateway (es. `gateway/nomad/index.ts`) più un adapter per servizio NOMAD esposto — partire da **un solo** servizio (Kiwix è il candidato più semplice: API HTTP di sola lettura) per contenere lo scope iniziale.

**Prerequisiti**: un'istanza di Project NOMAD funzionante e raggiungibile via Docker (richiede un ambiente Docker + sistema Debian-based o container Linux compatibile, spec §4) — **da verificare se disponibile nell'ambiente di sviluppo corrente prima di iniziare**, altrimenti questa opzione si blocca subito su un prerequisito ambientale.

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

## Confronto sintetico

| Opzione | Nuove dipendenze esterne | Riuso del codice esistente | Testabilità automatica in CI | Sforzo |
|---|---|---|---|---|
| A. BLE transport | Alta (libreria BLE + hardware) | Alto (stessa interfaccia `Transport`) | Bassa (serve hardware reale o un fake transport) | Alto |
| B. Gateway NOMAD | Alta (Docker + Project NOMAD) | Alto (stesso protocollo/routing) | Media (dipende da un'istanza NOMAD raggiungibile) | Medio |
| C. Store-and-forward | Nessuna | Molto alto | Alta (stessa infrastruttura `tests/integration/` già in uso) | Medio-basso |

## Raccomandazione (non vincolante)

Se l'obiettivo immediato resta validare la logica di rete senza introdurre dipendenze ambientali (hardware BLE, Docker) — coerentemente con il principio bottom-up della specifica (§89, §105) — l'**Opzione C (store-and-forward)** è la prosecuzione più naturale: usa la stessa infrastruttura di test già verificata in questa sessione e sblocca direttamente il quarto e quinto obiettivo tecnico (§93-94, roadmap). Le opzioni A e B restano necessarie prima o poi, ma richiedono di verificare un prerequisito ambientale (hardware BLE reale; un'istanza Docker di Project NOMAD) prima ancora di poter iniziare a scrivere codice.

## Come procedere

L'Opzione C (store-and-forward) è stata scelta e completata. Restano aperte le opzioni A (BLE transport) e B (gateway NOMAD): alla prossima richiesta di continuare lo sviluppo, indicare quale avviare (anche entrambe, in sequenza) — questo documento va aggiornato con lo stato "in corso" e i task concreti via via che si procede, così resta lo strumento di riferimento per capire cosa è pianificato e cosa è ancora aperto.
