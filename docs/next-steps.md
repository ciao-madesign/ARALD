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

**Aggiornamento — completata (lato applicativo)**: `POST /api/call` è stato implementato (`node/src/web-ui.ts`), disattivato di default e protetto da una password di rete anche quando attivo (rinominata da "token di pairing" a un modello "nome rete + password" in stile Wi-Fi su richiesta esplicita dell'utente — vedi `docs/security.md` voce #24), con CORS abilitato solo insieme (vedi `docs/security.md` voce #22 e `docs/development.md` per come avviarlo con `--web-host`/`--allow-service-calls`). Ristretto per design ai soli servizi già noti e disponibili — non fa mai scoprire un servizio nuovo tramite query di rete, solo invocare uno già elencato da `/api/services`. L'app Capacitor stessa (`mobile/`, vedi `mobile/README.md`) è scritta e verificata end-to-end con un browser reale: schermata di pairing in stile Wi-Fi (indirizzo una tantum, poi solo nome rete/password), dashboard con vicini/servizi/contenuti, chiamata a `service://ai` con risposta mostrata, gestione degli errori.

**Prerequisiti**: nessuno per validare l'app in un browser (fatto, vedi sopra). Per un telefono Android reale serve Android Studio/SDK su una macchina di sviluppo normale — **la compilazione nativa (`./gradlew assembleDebug`) non è completabile in questo ambiente**: richiede l'Android Gradle Plugin da `dl.google.com`, host bloccato dalla policy di rete di questa sessione remota (403 dal proxy, non un problema di codice). Il progetto Gradle è comunque generato e committato (`mobile/android/`), pronto per essere compilato altrove.

**Criteri di accettazione**: verificati con un browser reale al posto di un telefono fisico (stesso protocollo HTTP, stessa app web) — vicini/servizi/contenuti mostrati correttamente, ricerca funzionante, chiamata a `service://ai` con risposta a schermo, errore chiaro quando il gateway non è raggiungibile. Resta da verificare su un telefono Android reale o un emulatore, una volta disponibile un ambiente con l'SDK.

**Rischi principali**: nessuno tecnico rilevante rimasto aperto — l'endpoint di scrittura è stato progettato con lo stesso rigore di sicurezza del resto (password di rete, restrizione ai soli servizi noti, timeout con tetto reale, CORS solo quando esplicitamente richiesto), vedi `docs/security.md` voci #22 e #24 per il dettaglio dei problemi trovati dalla revisione e corretti.

**Sforzo relativo**: **basso-medio**, confermato — ha riusato quasi interamente `node/src/web-ui.ts` e il protocollo esistente.

### Fase 2 — Connettività Bluetooth dal telefono (bloccata sullo stesso hardware dell'Opzione A)

**Cosa costruire**: uno stack BLE-centrale nell'app (plugin Capacitor tipo `@capacitor-community/bluetooth-le`) che scopre e si connette a un gateway raggiungibile via Bluetooth invece che Wi-Fi, riusando lo stesso protocollo a pacchetti (framing/frammentazione già progettati per BLE nella Slice 8, solo applicati a un client reale invece che a due lati entrambi simulati).

**Prerequisiti**: la stessa cosa già segnalata come bloccata nell'Opzione A — un dispositivo con hardware BLE reale **dal lato gateway** che parli Nomad-Net (non necessariamente un secondo telefono: potrebbe essere un Raspberry Pi/mini-PC con supporto BlueZ). **Stato: bloccata — stesso prerequisito hardware dell'Opzione A, non uno nuovo.**

**Criteri di accettazione**: gli stessi della Fase 1, ma il telefono raggiunge il gateway via Bluetooth con il Wi-Fi disattivato — la dimostrazione "vera" dello scenario rifugio/emergenza che la spec descrive.

**Sforzo relativo**: **alto**, e non stimabile con precisione finché non si decide come/quando procurarsi l'hardware per l'Opzione A — le due stime sono la stessa stima.

### Come procedere

La Fase 1 è pronta per essere pianificata in dettaglio e avviata senza aspettare nulla. La Fase 2 conviene accantonarla fino a quando non si decide cosa fare per l'hardware BLE reale (stesso punto di decisione dell'Opzione A) — costruirla prima sarebbe codice che nessuno può testare davvero.

### Debito di design della UI mobile — ✅ affrontato (voce #28, `docs/security.md`)

**Stato precedente** (lasciato come riferimento storico): `mobile/www/` era stata verificata *funzionalmente* end-to-end (pairing, dashboard, chiamata servizi, ricerca, scansione QR, la home "motore di ricerca" con collegamenti rapidi — voce #27) ma non aveva mai ricevuto una vera passata di design — ogni iterazione aveva aggiunto/spostato funzionalità dentro lo stesso impianto visivo minimale nato per dimostrare che il flusso funzionava.

**Affrontato** (su richiesta esplicita dell'utente, primo dei tre punti aperti scelto per primo): passata di design completa su `mobile/www/index.html`/`styles.css`/`app.js`, stesso workflow a doppio check, dettaglio completo in `docs/security.md` voce #28 — sprite di icone SVG coerenti al posto delle emoji, gerarchia visiva (intestazioni con icona+contatore, pill con icona, ombre leggere), transizioni tra schermate e rendering diff-based per le liste (solo le righe nuove si animano), skeleton di caricamento, feedback tattile (vibrazione best-effort, scala su tap, toast di riconnessione), layout tablet a tre colonne da 700px, accessibilità (aria-live, focus management, focus-visible, skip-link, title su testo troncato). La revisione ha trovato 5 problemi reali (il più serio: banner d'errore/toast rimanevano visibili-ma-vuoti nonostante l'attributo `hidden`, per una regola CSS che batteva lo user-agent stylesheet a parità di specificità), tutti corretti — vedi la voce per il dettaglio.

Restano comunque fuori portata in questo ambiente, invariati: la verifica su un telefono reale o un emulatore (nessun hardware/SDK Android disponibile — vedi `mobile/README.md`), e la scansione QR live via `BarcodeDetector` (non implementata nel Chromium headless usato qui).

**Nota per il futuro**: dopo l'identità visiva "Waypoint" (voce #31, approvata dall'utente il 22 agosto 2026 con la richiesta esplicita "usa meno arancione"), l'utente ha segnalato che in futuro è previsto un **restyling grafico per rendere l'aspetto più moderno** — non una richiesta immediata né ancora specificata in dettaglio (non è chiaro se sarà un affinamento della stessa identità Waypoint o una direzione visiva nuova), solo un punto da riprendere in una prossima sessione dedicata all'estetica.

## Cosa resta possibile in puro software, se si vuole andare oltre

Le versioni **hardware/Docker reali** di BLE (Opzione A) e del gateway NOMAD (Opzione B) restano gli unici due candidati bloccati su prerequisiti esterni. Le loro **versioni simulate/mockate** (Slice 8 e 9 del secondo giro post-audit, vedi le note in coda a ciascuna opzione sopra e `docs/security.md`) sono realizzabili in puro software e sono ora entrambe **completate**, così come un terzo sotto-servizio NOMAD, `service://news` (`NewsGateway`, `docs/security.md` bug #27, su richiesta esplicita dell'utente), e una UI mobile "motore di ricerca" con collegamenti rapidi ai servizi (stesso #27).

Un candidato reale era emerso proprio dalla revisione della voce #27: **`ContentStore` (`node/src/content.ts`) non aveva alcun limite di dimensione**, a differenza di `RemoteCatalog`/`PeerDirectory`/`ServiceDirectory`/`RoutingTable` (tutti dietro `BoundedFifoMap` con `maxSize`), pur essendo alimentato dalla rete via `putVerified()` (contenuto ricevuto/relayato da peer non fidati). Non corretto nella voce #27 perché la portata di una modifica a una struttura centrale usata ovunque nel sistema (percorso locale e di rete insieme) era nettamente più ampia di quanto giustificasse quella slice — **affrontato con una propria slice dedicata, `docs/security.md` voce #32**: `BoundedFifoMap` con eviction pesata sulla fiducia e un rank dedicato per il contenuto pubblicato localmente da questo stesso nodo, più le ricadute corrette in `gateway/nomad/` (i cui commenti assumevano un `ContentStore` illimitato).

## Come procedere

Le opzioni A (BLE) e B (gateway NOMAD) restano bloccate sui prerequisiti ambientali originali (hardware fisico; Docker + Project NOMAD) **solo per la loro forma realistica finale** — le rispettive versioni simulate (Slice 8, 9, entrambe completate) hanno nel frattempo validato la logica applicativa come lavoro in puro software. Quando hardware/Docker saranno disponibili, il codice del transport/gateway reale si aggiunge dietro la stessa interfaccia già validata dalla versione simulata, senza dover ripartire da zero.

## Opzione I — Nomad News evoluto (valutazione di una proposta esterna dell'utente, 21 agosto 2026)

L'utente ha proposto una specifica dettagliata per evolvere `service://news` (voce #27, `docs/security.md`) verso un vero "News Service offline-first": Wikinews via Kiwix per l'archivio storico, un News Gateway con ingestor RSS periodico per gli aggiornamenti recenti, livelli headline/summary/articolo completo per l'efficienza su link a banda stretta, priorità P0-P4 per i bollettini di emergenza, digest generati da un'IA locale, e query di sincronizzazione a diff sugli ID tra nodi. Valutazione completa (non implementata in questa voce — solo analizzata e documentata):

**Già coperto dall'architettura esistente, riusabile direttamente:**
- **Priorità P0-P4**: esiste letteralmente — `Priority` (`node/src/packet.ts`) ha 6 livelli, `EMERGENCY(0)`...`BULK(5)`, già usato per lo scheduling reale in `TcpTransport` (Slice 4, `docs/protocol.md` "Priorità"). Non serve un nuovo schema.
- **Sync a diff sugli ID tra nodi**: è esattamente ciò che il partition sync esistente (Milestone 13, `node/src/catalog.ts`) fa già genericamente per qualunque contenuto — due nodi che si riconnettono si scambiano un catalogo di metadata e trasferiscono solo ciò che manca. Nessun protocollo nuovo da progettare per questa parte.
- **Firma/hash del contenuto**: schema già esistente e generale (`content.ts`/`ContentMetadata`), lo stesso che la proposta descrive per lo schema della notizia.
- **Wikinews via Kiwix**: architetturalmente "solo un altro path Kiwix" — `KiwixGateway` esiste già (mockato). Nessun lavoro concettuale nuovo, stesso limite Docker/Project NOMAD reale già noto per il resto dell'integrazione Kiwix.
- **Store-and-forward per notizie non consegnabili subito**: già generico per qualunque contenuto (Milestone 12).
- **Gateway dedicato con sync periodico + cache-serving istantaneo**: `NewsGateway` (voce #27) copre già questa parte — `startAutoSync()`, dedup via `publishedById`, `service://news` risponde sempre dalla cache senza mai bloccare su una chiamata live.

**Realizzabile ora in puro software** (stesso schema "mockato, non verificabile contro un backend reale" già accettato per Kiwix/Ollama):
1. ✅ **Fatto** (`docs/security.md` voce #33): parser RSS/Atom scritto da zero (`gateway/nomad/rss-feed.ts`, coerente con "niente dipendenze esterne non necessarie" — stesso precedente dell'encoder QR, `node/src/qrcode.ts`), a sostituzione dell'API JSON ad-hoc di `NewsGateway`; testato con fixture XML dirette e contro un server HTTP locale di test (mai un fake server spedito, per la stessa scelta esplicita dell'utente già seguita per `NewsGateway`). Quattro giri di revisione, l'ultimo dei quali ha trovato un vero DoS a tempo quadratico nella gestione di CDATA — vedi la voce per il dettaglio completo.
2. ✅ **Fatto** (contestuale al punto 1): schema più ricco della notizia (`source`, `category`, `language`, `updatedAt`) — estensione diretta del modello dati (`NewsHeadline`, `news-gateway.ts`).
3. Livelli headline/summary/articolo completo — oggi `NewsGateway` pubblica titolo+riassunto insieme in un unico blob; separarli in due tier (il primo sempre sincronizzato, il secondo on-demand via `CONTENT_REQUEST`) è un affinamento realistico, allineato con l'efficienza per link a banda stretta (BLE) che la proposta cita.
4. Digest generato via IA (`content://news/digest/latest` concettualmente — vedi però la nota sull'indirizzamento per path sotto): comporre `NewsGateway` con `AiGateway`/`service://ai` già esistente (mockato con `FakeOllamaServer`) per generare un riassunto delle notizie in cache. Stesso limite "nessun modello linguistico reale disponibile qui".
5. `service://emergency-news`: un sotto-caso specializzato che filtra solo le notizie a priorità alta, riusando l'infrastruttura sopra — ma vedi il punto successivo per cosa serve davvero perché "salti la coda".

**Lavoro architetturale genuinamente nuovo, non solo estensione — ✅ fatto (`docs/security.md` voce #34)**: oggi la priorità di un pacchetto è fissa **per tipo di messaggio**, non parametrizzabile per singolo contenuto — ogni `CONTENT_*` usa sempre `Priority.CONTENT`. La scoperta dei contenuti è inoltre **pull-based** (`CONTENT_QUERY`/`CONTENT_FOUND`), senza un annuncio broadcast come `SERVICE_ANNOUNCE` per i servizi. "Un bollettino P0 salta la coda e raggiunge subito tutti i nodi" (come descritto nella proposta) non era quindi gratis: risolto con un nuovo `MessageType.CONTENT_ANNOUNCE` (broadcast, parallelo a `SERVICE_ANNOUNCE`, stessa disciplina di firma) e `publishContent(..., { announce: true, priority })`. Vedi `docs/protocol.md`, sezione "Priorità (§50)", e `docs/security.md` voce #34 per il dettaglio completo (incluso il limite noto e accettato su `packet.priority` non autenticato).

**Bloccato sugli stessi prerequisiti esterni già noti per il resto del progetto:**
- Fonti reali (RSS di editori, bollettini Protezione Civile, feed meteo ufficiali) — l'accesso a internet reale è bloccato dalla policy di rete di questo ambiente (verificato direttamente contro feed RSS reali, respinti con 403). Qualunque ingestor RSS costruito qui è verificabile solo contro un server di test locale.
- Wikinews via ZIM reale — richiede Docker + un'istanza Project NOMAD/Kiwix reale con un dump ZIM caricato, stesso blocco già noto per il resto dell'integrazione Kiwix.
- Digest con un LLM reale — Ollama resta mockato, nessun modello linguistico reale disponibile in questa sandbox.

**Nota architetturale sulla proposta**: descrive contenuti indirizzati per path leggibile (`content://news/2026/08/21/xxxxx`). Oggi Nomad-Net indirizza il contenuto per **content ID** (hash dei byte), non per path — il "path" usato da `KiwixGateway` è solo un'etichetta (`name`) associata al contenuto, non una vera chiave di lookup stabile. Un indirizzamento per path stabile (utile per "l'ultimo digest" o "le notizie di oggi" come riferimenti fissi) richiederebbe una piccola estensione del content store, non specifica alle news — da decidere se è davvero necessaria o se i metadata esistenti (categoria, data di pubblicazione) bastano per il caso d'uso.

**Questioni non tecniche (copyright/paywall/licenze delle fonti, sezione 7 della proposta)**: non risolvibili con codice — sono decisioni editoriali che chi gestisce il gateway reale deve prendere scegliendo le fonti. Bollettini ufficiali open (es. Protezione Civile) restano la scelta più sicura per il caso d'uso rifugio/emergenza che la proposta stessa individua come il più concreto.

**Ordine di implementazione, un pezzo alla volta**: (1) ✅ parser RSS + schema arricchito — fatto, voce #33; (2) ✅ livelli headline/summary — fatto, voce #35; (3) digest AI componendo `NewsGateway`+`AiGateway`; (4) ✅ l'estensione di priorità/broadcast per contenuti — fatta, voce #34 (`MessageType.CONTENT_ANNOUNCE`, parallelo a `SERVICE_ANNOUNCE` come già indicato, sviluppata in parallelo su questo stesso repository da un'altra sessione — vedi nota di processo in fondo alla voce #35 di `docs/security.md`) → resta da fare `service://emergency-news` come conseguenza naturale, ora che il pezzo 4 è pronto. Resta solo il pezzo 3 (digest AI) prima di poter considerare "Nomad News evoluto" completo nella sua parte backend, più `service://emergency-news` stesso. Stesso workflow a doppio check di ogni voce precedente (implementa, testa, `code-review`, correggi, documenta, commit+push su entrambi i branch).

## Opzione J — Sotto-applicazioni: messaggistica (stile BitChat) e tracciamento posizione (valutazione, 21 agosto 2026)

L'utente ha chiesto se sia possibile integrare in Nomad-Net delle "sotto-applicazioni": un sistema di messaggistica per chattare senza Internet (concettualmente come BitChat, ma sopra Nomad-Net invece che una mesh BLE dedicata), e un sistema di segnalazione/tracciamento posizione opportunistico (un dispositivo segnala la propria posizione/i propri spostamenti, la segnalazione si propaga di incontro in incontro fino a un nodo "registro"). Valutazione (non implementata — solo analizzata e documentata):

### Messaggistica

**Chat 1:1 — ✅ fatta (`docs/security.md` voce #36).** `NomadNode.sendPrivateMessage(destination, payload)` (`node/src/node.ts`) era già cifrato end-to-end (X25519 ECDH + AES-256-GCM, `node/src/encryption.ts`), già multi-hop (un relay inoltra il ciphertext senza poterlo leggere), e già delay-tolerant: passa dalla stessa `floodExcept()`/store-and-forward generica di ogni pacchetto unicast (`node/src/store-and-forward.ts`) — un messaggio a un peer offline veniva già accodato e ritentato alla riconnessione. Mancava solo una cronologia messaggi lato gateway (`node/src/message-history.ts`, nuovo) e due endpoint HTTP (`GET`/`POST /api/messages`) più la UI mobile sopra il design "Waypoint" — tutti ora implementati.

**Canali pubblici (bulletin di gruppo, non cifrati)** — mappano bene sul pattern già dimostrato da `NewsGateway`: ogni messaggio pubblicato come `content://` firmato (Ed25519, stesso schema di `content.ts`), scoperto/sincronizzato via catalog sync — un canale chat sarebbe concettualmente "`NewsGateway` al contrario", contenuti scritti dall'utente invece che scaricati da RSS. Nessun nuovo tipo di pacchetto necessario. Vincolo reale: `ContentMetadata` non ha un campo "topic/canale" di primo livello — la categorizzazione oggi vive dentro il corpo JSON del contenuto (come `category` in `NewsHeadline`), non è filtrabile da `/api/search` senza scaricare ogni messaggio. Due strade: una convenzione sul nome (`name: "chat:generale:<id>"`, come già fa `KiwixGateway` coi path) senza toccare il protocollo, oppure un vero campo `tags`/`topic` in `ContentMetadata` — un cambio di protocollo reale, non enorme ma da valutare con attenzione (tocca la firma del contenuto, `contentSigningPayload()`, e ogni punto che legge `ContentMetadata`).

**Gruppi/chat private cifrate (non solo pubbliche)** — qui c'è lavoro genuinamente nuovo, il pezzo più interessante emerso dall'analisi. Oggi esiste solo cifratura punto-a-punto: una chiave condivisa per coppia di nodi (`EncryptionIdentity.sharedKeyWith()`, ECDH), nessun concetto di "chiave di gruppo" distribuita a più membri. Per una chat privata di gruppo (es. "i soccorritori della zona nord") servirebbe un meccanismo di **key-wrapping**: una chiave simmetrica del gruppo, generata da chi crea il canale, cifrata separatamente per ogni membro con la chiave X25519 di quel membro (già nota via `PeerDirectory`, propagata mesh-wide) — ogni membro decifra la propria copia della chiave di gruppo con la propria chiave privata, poi usa quella per leggere/scrivere nel canale. Le primitive crittografiche esistono già in `encryption.ts` (X25519, AES-256-GCM); quello che manca è: un formato per l'"invito" cifrato-per-membro, gestione dell'ingresso/uscita da un gruppo (rotazione della chiave quando qualcuno esce, o accettare che chi è uscito possa comunque decifrare la storia pregressa — una scelta di design da fare esplicitamente, non implicita), e dove/come questi inviti vengono distribuiti (candidato naturale: come `PRIVATE_MESSAGE` 1:1 verso ogni nuovo membro, riusando ciò che già esiste). Fattibile, ma è design crittografico nuovo, da trattare con la stessa cura riservata finora a `encryption.ts`/`peer-directory.ts` (più di una passata di revisione dedicata, non una feature "semplice").

**Gap architetturale condiviso con la proposta news (Opzione I) — ✅ risolto (`docs/security.md` voce #34)**: i canali pubblici avevano lo stesso limite isolato per le notizie di emergenza — la scoperta dei contenuti era pull-based, nessun content-broadcast come `SERVICE_ANNOUNCE`. Il nuovo `CONTENT_ANNOUNCE`/`publishContent(..., { announce: true })` (stesso pezzo di lavoro usato per `service://emergency-news`) è già disponibile per i canali pubblici di chat quando verranno implementati — un nuovo messaggio potrà "spingere" a chi è già connesso invece di aspettare una query esplicita.

### Tracciamento posizione

**La parte difficile è già coperta.** `PeerDirectory` propaga le chiavi di cifratura mesh-wide (stesso meccanismo del catalog sync, non solo tra vicini diretti connessi ora) — un dispositivo può quindi già cifrare `sendPrivateMessage()` per un nodo "registro" a molti hop di distanza, mai incontrato direttamente, e se il registro è irraggiungibile al momento della segnalazione, store-and-forward la mette in coda e la consegna al primo incontro utile lungo il percorso. È esattamente lo scenario "segnalo la posizione, il primo dispositivo mesh che incrocio la porta avanti fino al registro" — nessun nuovo protocollo di consegna da progettare.

**Cosa serve di nuovo:**
1. **Scoperta del registro**: un `service://location-registry` che annuncia il proprio node id/chiave (stesso pattern service discovery già esistente, §35-37), così un dispositivo non deve conoscere l'indirizzo del registro a priori.
2. **Un gateway "registro"**: nuovo componente, ma stesso schema di `NewsGateway`/`AiGateway` — riceve `PRIVATE_MESSAGE`, decifra (è l'unico che può), verifica la firma del reporter, persiste in un log/store. Andrebbe pensato con un limite di dimensione fin dall'inizio (stessa convenzione `BoundedFifoMap` di tutto il resto), non aggiunto dopo come per `ContentStore`.
3. **Lato mobile**: campionamento periodico della posizione (plugin Capacitor Geolocation, richiede permesso OS) — lavoro nuovo, ma può ora appoggiarsi al design "Waypoint" già completato (voci #28-31) invece che nascere nel vecchio impianto minimale.

**Punto architetturale importante**: un report di posizione **non va mai pubblicato con `publishContent()`** — quel percorso è progettato apposta per essere cacheabile/scopribile da chiunque nella mesh (spec §56, "Public content"), l'opposto di cosa serve per un dato personale. Va per forza `sendPrivateMessage()` (categoria "Private messages" della stessa §56), mai il content store.

**Limiti reali, non risolvibili solo con codice:**
- **Traffic analysis**: anche cifrato, un relay lungo il percorso vede "il nodo X manda periodicamente qualcosa al nodo registro" — questo da solo rivela che X sta condividendo la posizione, anche senza leggerne il contenuto. Limite noto e accettato in sistemi analoghi (Signal, Tor); va documentato onestamente come limite residuo, non preteso di essere risolto da questa feature.
- **Consenso ed etica**: qui i dati sono la posizione di persone reali — la specifica stessa elenca esplicitamente "posizione" tra i dati **da minimizzare** (`docs/SPECIFICATION.md` §56: "Da minimizzare: identificatori persistenti, posizione, cronologia dei contatti, contenuti richiesti"). Questo non è un'opinione di design aggiunta ora, è già un principio dichiarato nella specifica. Prima di scrivere codice serve: opt-in esplicito e revocabile lato utente (mai attivo di default), un controllo su chi può interrogare il registro (riuserebbe `TrustLevel`/`TrustManager` già esistente), e una decisione esplicita su quanto a lungo conservare le segnalazioni (minimizzazione nel tempo, non solo nello spazio). Questa è una discussione da fare con l'utente prima dell'implementazione, non una scelta tecnica che si può prendere da soli.

### Come procedere, se si riprende

1. ~~Chat 1:1~~ ✅ Fatta (voce #36).
2. Canali pubblici — dopo (o insieme a) il meccanismo di priorità/broadcast per contenuti condiviso con l'Opzione I, per non costruirlo due volte.
3. Tracciamento posizione — richiede prima una decisione esplicita con l'utente su consenso/conservazione/autorizzazione (non solo codice), poi: `service://location-registry` + gateway registro + lato mobile.
4. Chat private/di gruppo cifrate — l'ultimo, perché richiede il design crittografico nuovo (key-wrapping) più sostanzioso dei tre; conviene affrontarlo dopo aver validato canali pubblici e chat 1:1, non come primo passo.

Stesso workflow a doppio check di ogni voce precedente per qualunque di questi pezzi si scelga di implementare.

## Piano d'insieme (22 agosto 2026, aggiornato dopo #28-35) — come ordinare tutti i candidati aperti

Con l'Opzione I (news evoluto) e l'Opzione J (messaggistica + tracciamento posizione) valutate, e con il debito di design UI mobile, `ContentStore`, i primi due pezzi dell'evoluzione news, il prerequisito architetturale condiviso e la chat 1:1 **già completati** (voci #28-36, `docs/security.md` — vedi "Stato del progetto" in `CLAUDE.md`), questo piano riordina i candidati **rimasti** in un'unica sequenza motivata — per dipendenze reali, non solo per data di scoperta — pensata per essere seguita passo per passo, non per essere fatta tutta insieme. Le fasi "0", "1" e "2" (`ContentStore`, UI mobile, parser RSS, meccanismo di broadcast) sono barrate sotto come riferimento storico di come questo piano è stato pensato, non perché vadano ancora fatte.

~~**Fase 0 — `ContentStore` senza limite di dimensione.**~~ ✅ Fatta (voce #32).

~~**Fase 1 — UI mobile, prerequisito per tutto ciò che segue che tocca il telefono.**~~ ✅ Fatta (voci #28-31, incluso il rebrand "Waypoint") — resta annotata, non pianificata, una richiesta dell'utente di un futuro restyling più moderno (vedi `CLAUDE.md`, "Stato del progetto").

~~**Fase 2 — Il prerequisito architetturale condiviso.**~~ ✅ Fatta (`docs/security.md` voce #34, `MessageType.CONTENT_ANNOUNCE` + `publishContent(..., { announce, priority })`) — un solo pezzo di lavoro, già pronto sia per `service://emergency-news` (Opzione I) sia per i canali pubblici di chat (Opzione J) quando verranno implementati.

**Fase 3 — Feature veloci e in gran parte indipendenti tra loro (parallelizzabili).**
- ~~Chat 1:1 (Opzione J)~~ ✅ Fatta (voce #36).
- ~~Parser RSS + schema arricchito~~ ✅ Fatto (voce #33). ~~Livelli headline/summary~~ ✅ Fatto (voce #35). Resta il digest AI componendo `NewsGateway`+`AiGateway`. Indipendente dalla UI mobile.

**Fase 4 — Costruita sopra il prerequisito della Fase 2.**
- Canali pubblici di chat (Opzione J).
- `service://emergency-news` (Opzione I).

**Fase 5 — Richiede prima una decisione esplicita con l'utente, non solo codice.** Tracciamento posizione (Opzione J): consenso, conservazione, autorizzazione all'interrogazione del registro vanno decisi **con** l'utente prima di scrivere il gateway registro o il lato mobile — la specifica stessa (§56) elenca la posizione tra i dati da minimizzare, non è una scelta tecnica da prendere in autonomia.

**Fase 6 — Il pezzo di design crittografico più sostanzioso, per ultimo.** Chat private/di gruppo cifrate (Opzione J): key-wrapping, gestione ingresso/uscita dal gruppo — conviene affrontarlo dopo aver validato chat 1:1 e canali pubblici, quando il resto dell'infrastruttura di messaggistica è già in produzione e testata.

**Bloccati su prerequisiti esterni, indipendentemente da questo piano**: le forme hardware/Docker reali di BLE e gateway NOMAD (Opzioni A/B), fonti news reali e Wikinews via ZIM reale (Opzione I), la build Android nativa (Opzione H Fase 1) — nessuno di questi ha una data, il piano sopra non li include perché non richiedono una decisione di sequenza, solo la disponibilità del prerequisito.

Questo piano è un ordine **consigliato**, non un impegno: ogni fase resta soggetta allo stesso workflow a doppio check e a un ok esplicito dell'utente prima di iniziare, come ogni lavoro precedente in questo repository.
