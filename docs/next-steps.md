# Prossimi passi

Riferimento: [`docs/roadmap.md`](./roadmap.md) per lo stato di tutte le milestone (0-20). Questo documento traduce le milestone candidate come "prossimo passo" in piani d'azione concreti — file da toccare, prerequisiti, rischi, criteri di accettazione — così la scelta si può fare con cognizione di causa invece che sulla sola numerazione. Per la stessa lista in linguaggio semplice e non tecnico, vedi [`docs/audit-report.html`](./audit-report.html).

**Stato**: oltre all'Opzione C (store-and-forward, Milestone 12), sono state completate: Milestone 13 (partition sync, `node/src/catalog.ts`), Milestone 15 per intero (firma dei contenuti, trust levels, rate limiting, cifratura E2E dei messaggi privati — vedi `docs/security.md`), Milestone 16 per intero (relay policy legata a batteria/carica **e** routing a costo distance-vector, `node/src/relay-policy.ts` + `node/src/routing-table.ts`) e la Milestone 20 (simulatore di rete, `tools/simulator/`). Un secondo giro post-audit (le 9 slice originariamente pianificate, più una decima aggiunta su richiesta esplicita dell'utente: retry sui content provider, struttura dati limitata condivisa, eviction pesata sulla fiducia, scheduling per priorità, `CONTENT_NOT_FOUND`+scadenza, service discovery, interfaccia web, transport BLE simulato, gateway NOMAD mockato, gateway AI mockato — dettaglio in `docs/security.md`) ha poi rivalutato le opzioni A e B qui sotto: la **versione hardware/Docker reale** di entrambe resta bloccata come descritto (invariato), ma una **versione simulata/mockata** di ciascuna — che valida la logica applicativa senza quei prerequisiti — è realizzabile in puro software ed è ora **completata per entrambe**, gateway AI incluso. Vedi le note aggiunte in coda a ciascuna opzione sotto.

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

**Aggiornamento (Slice 8, seguito dell'audit)**: la parte "hardware BLE reale" sopra resta bloccata invariata. Il paragrafo sopra menziona già la necessità di "un `Transport` fittizio (loopback BLE simulato) per i test automatici" — è esattamente questo che la Slice 8 realizza: un `BleSimulatedTransport` (o nome analogo) dietro la stessa interfaccia `Transport`, con vincoli di MTU/frammentazione realistici applicati in-process (nessun radio reale, nessuna libreria `noble`/`bleno`), per validare che il routing/content-centric layer si comporti correttamente su un link a pacchetti piccoli prima ancora di avere hardware. Vedi `docs/security.md` per il dettaglio una volta completata.

---

## Opzione B — Gateway NOMAD (roadmap Milestone 10-11)

**Cosa costruire**: `gateway/nomad/`, un processo che espone al mesh Nomad-Net (tramite un `NomadNode` locale, stesso transport TCP già validato) le stesse API `content://...` / `service://...` già testate, risolvendo però le richieste chiamando le API HTTP di un'istanza reale di Project NOMAD (es. Kiwix) invece di leggere da un `ContentStore` locale statico.

**File coinvolti**: un entry point del gateway (es. `gateway/nomad/index.ts`) più un adapter per servizio NOMAD esposto — partire da **un solo** servizio (Kiwix è il candidato più semplice: API HTTP di sola lettura) per contenere lo scope iniziale.

**Prerequisiti**: un'istanza di Project NOMAD funzionante e raggiungibile via Docker (richiede un ambiente Docker + sistema Debian-based o container Linux compatibile, spec §4). **Stato: bloccata — nessun ambiente Docker/Project NOMAD disponibile in questa sessione.**

**Criteri di accettazione**: un `NomadNode` con questo gateway attivo risponde a una `CONTENT_QUERY` per un articolo Kiwix reale con lo stesso ciclo `CONTENT_FOUND` → `CONTENT_REQUEST` → `CONTENT_CHUNK`* → `CONTENT_COMPLETE` già coperto dai test esistenti, servendo dati reali invece che contenuto pubblicato via `publishContent()`.

**Rischi principali**: Project NOMAD "non dichiarato stabile" (spec §4) — la sua API potrebbe cambiare sotto i piedi; il setup Docker è un prerequisito ambientale non garantito.

**Sforzo relativo**: **medio** — riusa quasi interamente il codice già scritto e testato in questa sessione (`NomadNode`, protocollo, routing, content store come cache); il lavoro nuovo è isolato nell'adapter HTTP verso NOMAD.

**Aggiornamento (Slice 9, seguito dell'audit — completata)**: la parte "Project NOMAD reale via Docker" sopra resta bloccata invariata. La Slice 9 ha realizzato invece l'adapter HTTP (`gateway/nomad/kiwix-gateway.ts`) contro un **fake server locale** (`gateway/nomad/fake-nomad-server.ts`, avviato dallo stesso processo di test/dimostrazione, che imita la sola API Kiwix di sola lettura effettivamente usata) al posto di un'istanza Docker reale — stesso adapter, stesso protocollo Nomad-Net esposto, stessi criteri di accettazione sopra, verificati end-to-end senza il prerequisito Docker: un `NomadNode` remoto recupera un articolo pubblicato dal gateway attraverso il normale ciclo `CONTENT_QUERY`→`CONTENT_COMPLETE`, e `service://kiwix-search` proxya dal vivo ogni ricerca a NOMAD senza mai cache. Dettaglio completo (inclusi i 3 bug reali trovati e corretti dalla revisione) in `docs/security.md`, bug #19. Quando Docker + un'istanza reale di Project NOMAD saranno disponibili, l'unico lavoro rimasto è puntare `KiwixGateway` a quel `baseUrl` invece che a `FakeNomadServer` — l'adapter e il protocollo esposto non cambiano.

**Aggiornamento (Slice 10, seguito dell'audit — completata)**: estende lo stesso schema a un secondo sotto-servizio NOMAD, Ollama (`docs/reuse-vs-new.md` lo elenca esplicitamente come distinto da Kiwix). `AiGateway` (`gateway/nomad/ai-gateway.ts`) registra `service://ai` — l'esempio che la specifica stessa fa al §37: un dispositivo poco potente chiede alla rete una risposta generata da un'IA locale, la rete trova un nodo più capace in grado di fornirla, senza che il primo debba mai sapere chi ha risposto. `FakeOllamaServer` (`gateway/nomad/fake-ollama-server.ts`) sostituisce un'istanza Ollama reale con un unico endpoint `POST /api/generate` a risposte pre-registrate. Verificato con un test end-to-end a tre nodi (debole → relay → gateway, il nodo debole non si connette mai al gateway) oltre ai casi già coperti per il gateway Kiwix (proxy live senza cache, backend irraggiungibile, input malformato). Dettaglio completo (inclusi i 2 bug reali corretti dalla revisione) in `docs/security.md`, bug #20.

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

## Opzione E — Firma dei contenuti, trust levels, rate limiting, cifratura E2E (Milestone 15) — ✅ completata

Emersa a posteriori: senza autenticità verificabile, sia il content discovery (Milestone 5) sia il catalog sync (Opzione D) si fidano ciecamente di qualunque cosa un peer dichiari — un gap di sicurezza reale, non solo teorico, indipendente da hardware o Docker. Realizzato in tre passate: prima la firma dei contenuti (Ed25519 su nome/tipo/dimensione oltre che sull'hash), poi trust levels (`UNKNOWN/SEEN/VERIFIED/TRUSTED/ADMIN`) e rate limiting per peer, infine la cifratura end-to-end dei messaggi privati (chiavi X25519 dedicate, ECDH + AES-256-GCM, `node/src/encryption.ts`). Diversi bug di sicurezza reali sono stati trovati e corretti durante lo sviluppo — vedi `docs/security.md` per il dettaglio, incluso il più grave della prima passata (verifica della firma calcolata ma mai controllata sul percorso principale di recupero contenuti) e uno particolarmente subdolo della terza (l'identità del nodo stesso poteva essere evitta dalla propria struttura FIFO limitata, rompendo silenziosamente la propria scopribilità).

## Opzione F — Relay policy legata a batteria/carica e routing a costo distance-vector (Milestone 16) — ✅ completata

Realizza sia la parte energy-aware di spec §51/§58 ("Relay OFF / Relay when charging / Relay while battery > X%": un nodo decide se fare da relay per il traffico altrui in base al proprio stato di risorse auto-dichiarato, senza che questo influisca sulle richieste dirette rivolte a lui) sia il routing a costo di §22 (`node/src/routing-table.ts`): un vero meccanismo distance-vector con triggered update e split horizon, che sostituisce il flooding cieco con instradamento diretto per il traffico unicast una volta che una rotta converge, mantenendo il flooding come bootstrap/fallback e come unico meccanismo per il traffico broadcast. Il costo è oggi il solo hop count — gli altri termini della formula di §22 (latenza, perdita, energia, congestione) richiederebbero misurazioni di link reali non disponibili senza hardware, e restano coefficienti futuri come la specifica stessa anticipa.

## Opzione G — Simulatore di rete (roadmap Milestone 20) — ✅ completata

`tools/simulator/simulate.ts` collega N nodi reali in una topologia configurabile e misura consegna/latenza a scala (§76-80), utilizzabile anche da riga di comando. Il suo sviluppo ha scovato un bug reale nel transport TCP di base (due connessioni simultanee tra la stessa coppia di nodi bloccavano per sempre la chiusura di un nodo) — corretto con test di regressione dedicato, vedi `docs/roadmap.md` milestone 20.

## Opzione H — App mobile (roadmap Milestone 9) — pianificazione, su richiesta esplicita dell'utente

**Decisioni già prese con l'utente** (non da rimettere in discussione senza un motivo nuovo):
1. **Client leggero verso un gateway**, non un nodo Nomad-Net completo sul telefono: l'app non reimplementa routing/cache/firma — si connette a un nodo Nomad-Net già esistente (il computer che oggi fa da gateway, con la web UI di spec §59 già costruita) e ne è un'interfaccia, più uno stack di connettività.
2. **Raggiungibilità sia via Wi-Fi/rete locale sia via Bluetooth** — non solo Wi-Fi.
3. **Framework ibrido** (React Native o Capacitor), non nativo Android puro, con la precisazione tecnica seguente sul perché è una scelta valida per *questo* scope e non lo sarebbe per il modello finale a mesh completa.

**Perché ibrido è adeguato a questo scope ma non al modello finale**: BLE ha due ruoli, centrale (scansiona e si connette ad altri) e periferica (si fa scoprire, accetta connessioni). Un nodo mesh reale deve fare entrambi contemporaneamente — è quello che rende possibile il "passaparola" invece di una stella con un centro fisso. Le librerie BLE per framework ibridi coprono bene solo il ruolo centrale; il ruolo periferica richiede comunque un modulo nativo su misura. Siccome qui il telefono si connette *a* un gateway (ruolo centrale, il gateway è la periferica) e non deve farsi scoprire da altri telefoni, l'ibrido è pienamente adeguato — la scelta andrà rivista se in futuro si vorrà far parlare due telefoni direttamente tra loro senza gateway in mezzo.

**Scoperta importante, da tenere presente prima di stimare tempi**: la connettività "anche via Bluetooth" richiede *due* pezzi, non uno solo — un client BLE sul telefono (nuovo lavoro, oggetto di questa opzione) **e** un vero peer BLE periferica dal lato gateway che parli il protocollo Nomad-Net su radio reale. Quel secondo pezzo non esiste ancora: `node/src/transports/ble.ts` (Slice 8) è una simulazione **interamente software**, senza alcun accesso a hardware radio — esattamente il gap che l'Opzione A sopra descrive come bloccato su hardware BLE reale. Le due opzioni sono quindi accoppiate: il ramo "via Bluetooth" di questo piano non è testabile end-to-end finché anche l'Opzione A non ha una controparte reale, non solo simulata. Il piano sotto è strutturato in due fasi proprio per isolare cosa si può fare subito da cosa resta bloccato sullo stesso hardware già noto.

### Fase 1 — Client Wi-Fi/TCP verso un gateway esistente (nessun nuovo blocco hardware)

**Cosa costruire**: un'app Capacitor (wrapper nativo minimale attorno a un'app web) che si connette via TCP/WebSocket a un nodo Nomad-Net già in esecuzione sulla stessa rete locale — concettualmente la web UI di spec §59 già costruita, adattata a schermo di telefono (touch, layout verticale) invece che essere solo letta da un browser desktop. Aggiunge, oltre a quanto la web UI già mostra, la possibilità di *chiamare* un servizio (es. `service://ai`, `service://kiwix-search`) direttamente dal telefono — cosa che la web UI attuale non fa, essendo deliberatamente di sola lettura (spec §59 "l'utente non deve essere costretto a capire il routing", non un pannello di controllo).

**File coinvolti**: nuova directory `mobile/` (oggi un segnaposto vuoto, spec-mandated ma senza codice — vedi `CLAUDE.md`), un progetto Capacitor separato che consuma l'API HTTP già esistente di `WebUiServer` più `POST /api/call`, il ponte verso `NomadNode.callService()` per invocare un servizio.

**Aggiornamento — lato server completato**: `POST /api/call` è stato implementato (`node/src/web-ui.ts`), disattivato di default e protetto da un token di pairing anche quando attivo (vedi `docs/security.md` voce #22 e `docs/development.md` per come avviarlo con `--web-host`/`--allow-service-calls`). Ristretto per design ai soli servizi già noti e disponibili — non fa mai scoprire un servizio nuovo tramite query di rete, solo invocare uno già elencato da `/api/services`. Resta da costruire la controparte client (il progetto Capacitor stesso).

**Prerequisiti**: nessuno oltre a un telefono Android per il test reale (anche un emulatore basta per validare l'interfaccia; il test end-to-end "il telefono vede davvero il gateway" richiede la stessa rete Wi-Fi). **Stato: realizzabile subito, non bloccata.**

**Criteri di accettazione**: un telefono Android (reale o emulato) sulla stessa rete Wi-Fi di un nodo Nomad-Net gateway vede lo stato della mesh (vicini, servizi, contenuti — stessi dati di `/api/status`, `/api/peers`, `/api/services`, `/api/content`), cerca un contenuto, e invoca `service://ai` ricevendo una risposta, tutto dall'interfaccia touch.

**Rischi principali**: nessuno tecnico rilevante — è essenzialmente il lavoro già fatto (web UI) impacchettato diversamente, più un endpoint di scrittura nuovo che va progettato con lo stesso rigore di sicurezza del resto (autenticazione/consenso prima di esporlo, spec §59 non lo prevede ma questa estensione sì).

**Sforzo relativo**: **basso-medio** — riusa quasi interamente `node/src/web-ui.ts` e il protocollo esistente; il lavoro nuovo è il wrapper Capacitor e l'endpoint di invocazione servizi.

### Fase 2 — Connettività Bluetooth dal telefono (bloccata sullo stesso hardware dell'Opzione A)

**Cosa costruire**: uno stack BLE-centrale nell'app (plugin Capacitor tipo `@capacitor-community/bluetooth-le`) che scopre e si connette a un gateway raggiungibile via Bluetooth invece che Wi-Fi, riusando lo stesso protocollo a pacchetti (framing/frammentazione già progettati per BLE nella Slice 8, solo applicati a un client reale invece che a due lati entrambi simulati).

**Prerequisiti**: la stessa cosa già segnalata come bloccata nell'Opzione A — un dispositivo con hardware BLE reale **dal lato gateway** che parli Nomad-Net (non necessariamente un secondo telefono: potrebbe essere un Raspberry Pi/mini-PC con supporto BlueZ). **Stato: bloccata — stesso prerequisito hardware dell'Opzione A, non uno nuovo.**

**Criteri di accettazione**: gli stessi della Fase 1, ma il telefono raggiunge il gateway via Bluetooth con il Wi-Fi disattivato — la dimostrazione "vera" dello scenario rifugio/emergenza che la spec descrive.

**Sforzo relativo**: **alto**, e non stimabile con precisione finché non si decide come/quando procurarsi l'hardware per l'Opzione A — le due stime sono la stessa stima.

### Come procedere

La Fase 1 è pronta per essere pianificata in dettaglio e avviata senza aspettare nulla. La Fase 2 conviene accantonarla fino a quando non si decide cosa fare per l'hardware BLE reale (stesso punto di decisione dell'Opzione A) — costruirla prima sarebbe codice che nessuno può testare davvero.

## Cosa resta possibile in puro software, se si vuole andare oltre

Le versioni **hardware/Docker reali** di BLE (Opzione A) e del gateway NOMAD (Opzione B) restano gli unici due candidati bloccati su prerequisiti esterni. Le loro **versioni simulate/mockate** (Slice 8 e 9 del secondo giro post-audit, vedi le note in coda a ciascuna opzione sopra e `docs/security.md`) sono realizzabili in puro software e sono ora entrambe **completate**. Non restano altri candidati aperti in puro software oltre a un'eventuale ulteriore passata di qualità/sicurezza sul codice esistente.

## Come procedere

Le opzioni A (BLE) e B (gateway NOMAD) restano bloccate sui prerequisiti ambientali originali (hardware fisico; Docker + Project NOMAD) **solo per la loro forma realistica finale** — le rispettive versioni simulate (Slice 8, 9, entrambe completate) hanno nel frattempo validato la logica applicativa come lavoro in puro software. Quando hardware/Docker saranno disponibili, il codice del transport/gateway reale si aggiunge dietro la stessa interfaccia già validata dalla versione simulata, senza dover ripartire da zero.
