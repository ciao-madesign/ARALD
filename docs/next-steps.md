# Prossimi passi

Riferimento: [`docs/roadmap.md`](./roadmap.md) per lo stato di tutte le milestone (0-20) e la tabella del "secondo giro" post-audit — non ripetuti qui. Questo documento elenca solo i candidati **ancora aperti** (bloccati su un prerequisito esterno, o pianificati ma non ancora implementati), più un pointer al documento pertinente per ogni voce completata — invece di ripeterne il contenuto. Per la stessa lista in linguaggio semplice e non tecnico, vedi [`docs/audit-report.html`](./audit-report.html).

---

## Candidati aperti, bloccati su un prerequisito esterno

### Opzione A — BLE transport reale (roadmap Milestone 8)

**Cosa costruire**: `node/src/transports/ble.ts`, che implementa l'interfaccia `Transport` già esistente (`node/src/transport.ts`) — lo stesso contratto già usato da `TcpTransport`, così il routing e il content-centric layer restano invariati (spec §16, §67).

**Decisione preliminare da prendere prima di iniziare**: dove prototipare BLE.
- Su Node.js desktop, con librerie come `@abandonware/noble` (central/scan) e `@abandonware/bleno` (peripheral/advertise) — stesso linguaggio del resto del progetto, ma il supporto per fare *sia* central *sia* peripheral sullo stesso processo è limitato e dipende dal sistema operativo (più fattibile su Linux/BlueZ, limitato su macOS).
- Direttamente in un'app Android nativa (Kotlin, `BluetoothLeScanner`/`BluetoothGattServer`) — la specifica privilegia comunque Android come primo target mobile (§47), quindi questo lavoro confluirebbe comunque nella Milestone 9.

**File coinvolti**: `node/src/transports/ble.ts`; probabilmente anche un livello di fragmentation *a livello di transport* separato dal chunking di contenuto esistente — l'MTU BLE tipico (~20-500 byte) è molto più piccolo di `CHUNK_SIZE` (4096 byte in `node/src/content.ts`), quindi un singolo `CONTENT_CHUNK` andrebbe comunque spezzettato ulteriormente per attraversare un link BLE.

**Prerequisiti**: hardware BLE reale per i test end-to-end. **Stato: bloccata — nessun hardware BLE disponibile in questa sessione.**

**Criteri di accettazione**: gli stessi scenari di `tests/integration/three-node-relay.test.ts` e `content-retrieval.test.ts`, ma con `TcpTransport` sostituito da `BleTransport`, eseguiti su almeno due dispositivi fisici (spec §67 — "il routing non deve essere modificato" nel passaggio di transport).

**Rischi principali**: complessità cross-platform (§46-47, in particolare i vincoli iOS trattati come sperimentali in `docs/transport.md`); l'MTU limitato obbliga a rivedere il framing; una mesh BLE reale è meno affidabile di TCP locale e richiede retry/backoff che oggi non esistono nel codice.

**Sforzo relativo**: **alto** — nuovo dominio tecnico, hardware nel loop, nessuna copertura CI automatica possibile.

**Versione simulata — ✅ fatta** (`docs/security.md` voce #8): `BleSimulatedTransport` dietro la stessa interfaccia `Transport`, con vincoli di MTU/frammentazione realistici applicati in-process, nessun radio reale — valida la logica applicativa in attesa dell'hardware. **Resta bloccata solo la forma hardware reale** descritta sopra.

### Opzione B — Gateway NOMAD reale (roadmap Milestone 10-11)

**Cosa costruire**: `gateway/nomad/`, un processo che espone al mesh ARALD (tramite un `NomadNode` locale, stesso transport TCP già validato) le stesse API `content://...` / `service://...` già testate, risolvendo però le richieste chiamando le API HTTP di un'istanza reale di Project NOMAD (es. Kiwix) invece di leggere da un `ContentStore` locale statico.

**Prerequisiti**: un'istanza di Project NOMAD funzionante e raggiungibile via Docker (richiede un ambiente Docker + sistema Debian-based o container Linux compatibile, spec §4). **Stato: bloccata — nessun ambiente Docker/Project NOMAD disponibile in questa sessione.**

**Criteri di accettazione**: un `NomadNode` con questo gateway attivo risponde a una `CONTENT_QUERY` per un articolo Kiwix reale con lo stesso ciclo `CONTENT_FOUND` → `CONTENT_REQUEST` → `CONTENT_CHUNK`* → `CONTENT_COMPLETE` già coperto dai test esistenti, servendo dati reali invece che contenuto pubblicato via `publishContent()`.

**Rischi principali**: Project NOMAD "non dichiarato stabile" (spec §4) — la sua API potrebbe cambiare sotto i piedi; il setup Docker è un prerequisito ambientale non garantito.

**Versione simulata — ✅ fatta** (`docs/security.md` voci #9/#10): `KiwixGateway`/`AiGateway` verificati contro `FakeNomadServer`/`FakeOllamaServer` locali, stesso adapter e stesso protocollo esposto che punterebbe a un'istanza reale quando disponibile — **resta bloccata solo la forma Docker/Project NOMAD reale**.

### Connettività Bluetooth lato gateway/Clip (Opzione H, Passo 2)

Lato telefono (scan/connect/handshake verso una ARALD Clip/Cover, logica di protocollo unit-testata): fatto, `docs/security.md` voce #62. **Prerequisito ancora aperto**: un dispositivo con hardware BLE reale dal lato gateway/Clip che parli ARALD — stesso blocco dell'Opzione A, nessuna verifica end-to-end possibile finché non è disponibile.

### Relay Bluetooth telefono↔telefono senza Clip — design fatto, resta solo la verifica su hardware reale

Design e implementazione completi (macchina a stati di fallback `mobile/www/ble-role-manager.js`, voce #68; percorso primario dual-role `ble-dual-role-client.js`/`ble-serial-queue.js`, voce #69) — dettaglio tecnico completo, incluso il limite noto del plugin nativo usato, in `mobile/README.md` e `docs/security.md` voci #68/#69. **Resta aperto**: solo la verifica su hardware/emulatore reale (non disponibile in questo ambiente) — se il dual-role simultaneo si rivelasse inaffidabile in pratica, il fallback è collegare `ble-role-manager.js` allo stesso plugin invece del design "sempre entrambi i ruoli".

### Firmware bridge SX1262 (`firmware/sx126x-bridge/`) — scritto, bloccato sulla verifica su hardware reale

Il firmware Arduino/C++ per il microcontrollore-traduttore (seriale↔SPI verso il chip radio SX1262 reale) è scritto e controllato per quanto possibile in questo ambiente (`docs/security.md` voce #73), ma **mai caricato né provato su hardware vero** — nessun dispositivo raggiungibile da questo ambiente. Checklist completa dei passi rimasti in [`firmware/sx126x-bridge/README.md`](../firmware/sx126x-bridge/README.md) — lavoro dell'utente, non pianificabile ulteriormente da qui.

### Come procedere quando i prerequisiti saranno disponibili

Le opzioni sopra restano bloccate sui rispettivi prerequisiti ambientali **solo per la loro forma realistica finale** — dove esiste una versione simulata/mockata, questa ha già validato la logica applicativa come lavoro in puro software. Quando hardware/Docker saranno disponibili, il codice reale si aggiunge dietro la stessa interfaccia già validata dalla versione simulata, senza dover ripartire da zero.

---

## Candidato aperto e pianificato, non ancora implementato

### Terzo/quarto/quinto esempio di "consegna esterna differita" (pianificato, confermato dall'utente, 21 settembre 2026)

Dopo `whatsapp-relay/` (`docs/security.md` voce #79) ed `email-relay/` (voce #85), pianificate con l'utente le tre destinazioni rimaste tra i sei esempi concreti discussi in origine: **post su un canale/bot** (es. Slack/Telegram), **check-in di posizione** verso un servizio di coordinamento esterno, **upload di un report/foto** su una piattaforma esterna.

**Osservazione emersa in fase di pianificazione**: le tre sono la stessa meccanica di fondo — un invio HTTP verso un indirizzo web configurato dall'operatore — quindi il piano concordato è costruire **un solo relay generico "a webhook"** invece di tre relay separati, sullo stesso pattern indipendente di `whatsapp-relay/`/`email-relay/` (fuori mesh, fuori workspace npm).

**Tre decisioni raccolte con l'utente, tutte confermate**:
1. Un relay generico unico per i tre casi, non tre relay separati.
2. Corpo della richiesta HTTP verso il servizio esterno: JSON semplice (testo o file codificato dentro), stesso principio degli altri due relay — niente parser multipart/form-data da scrivere a mano.
3. Autenticazione verso il servizio esterno: un token fisso configurato una tantum dall'operatore (stesso principio della password SMTP di `email-relay/`) — copre la maggior parte dei servizi reali (Slack, Zapier, API generiche); niente di più sofisticato, perché il servizio esterno reale non è ancora noto.

**Lato mobile**: per l'upload di file/foto (il terzo di questi tre esempi) non serve nulla di nuovo — il pannello "Invia a un'organizzazione" accetta già un file allegato oggi. Per il check-in di posizione è consigliato un pulsante dedicato "Invia la mia posizione" che compila automaticamente le coordinate GPS (plugin Geolocation già in uso altrove nell'app, voce #44) più uno stato rapido ("Tutto ok"/"Serve aiuto"), invece di scrivere a mano nel campo testo esistente.

**Nessun codice scritto finora** — piano confermato dall'utente, in attesa di essere ripreso in una sessione futura con lo stesso workflow a doppio check di ogni voce precedente.

### Installer/wizard "ARALD Portable" software-puro — proposto dall'utente, 29 settembre 2026, non ancora implementato

**Idea**: distribuire il solo runtime mesh (`node/src/` — `NomadNode`/`cli.ts`/`web-ui.ts`, nessuna dipendenza da Docker o Project NOMAD) come pacchetto installabile per un utente non tecnico: scarica/riceve un pacchetto, lo installa sul proprio SSD esterno (o direttamente sul proprio PC), un breve wizard di configurazione iniziale, pronto all'uso — variante **Wi-Fi-only**, nessun hardware radio richiesto (il kit LoRa resta un componente opzionale per chi vuole portata lunga, vedi `docs/deployment.md`, "Chiarimento terminologico... due significati di ARALD Portable").

**Perché non è bloccata come le Opzioni A/B sopra**: a differenza del "Bootstrap/packaging del ARALD Hub" (Docker+Project NOMAD, `docs/deployment.md`, tuttora bloccato da prerequisiti esterni), questo pacchetto confeziona solo codice già reale e testato in questo repository — nessun Docker, nessun sorgente NOMAD, nessun hardware radio necessario per la variante base.

**Cosa manca**:
1. Un vero step di packaging — oggi si esegue solo via `npm run dev -w node --` da riga di comando; da valutare uno script di installazione/bundle eseguibile per Windows/macOS/Linux.
2. Un wizard di primo avvio (nome nodo, password di rete, directory dati/SSD, avvio automatico) — non esiste ancora, oggi la configurazione è solo tramite i flag di `cli.ts`.
3. Verifica end-to-end con un utente non tecnico che segue solo le istruzioni del pacchetto, senza assistenza — non ancora fatta.

**Effetto collaterale utile per la campagna Kickstarter**: costo di produzione ~0€ per il progetto nella variante Wi-Fi-only — discusso con l'utente come possibile reward a basso costo in fase di definizione della campagna (29 settembre 2026).

### Ipotesi da approfondire prima di scaricare/installare Project NOMAD — indipendenza per Wikipedia offline/AI locale (29 settembre 2026, non ancora deciso)

**Domanda aperta, sollevata dall'utente esplicitamente come ipotesi**: è possibile ottenere gli stessi servizi oggi previsti tramite Project NOMAD (Wikipedia offline, AI locale, traduzione, notizie, note condivise) **senza dipendere da Project NOMAD come progetto**, integrando direttamente i componenti open source sottostanti — **Kiwix** (server Wikipedia offline) e **Ollama** (runtime AI locale) — entrambi indipendenti da NOMAD, non esclusivi del suo pacchetto? **Se possibile, l'utente preferisce questa strada** — da valutare bene prima di procedere a scaricare/installare Project NOMAD, non dopo.

**Perché è plausibile, verificato nel codice**: `gateway/nomad/kiwix-gateway.ts` parla con l'API HTTP del solo servizio Kiwix di un'istanza NOMAD, non con l'intero stack (Qdrant/RAG, Command Center, ecc.) — architetturalmente indifferente a *chi* risponde a quella API, purché la rispetti (lo stesso `FakeNomadServer` usato nei test lo dimostra). Lo stesso principio vale presumibilmente per `ai-gateway.ts`/Ollama, non ancora verificato con la stessa attenzione. Un'installazione "solo Kiwix + solo Ollama" (senza il resto di Project NOMAD) potrebbe quindi già funzionare oggi, senza modifiche al codice — da verificare, non ancora tentato. Un passo ulteriore, più radicale: leggere i file Wikipedia (formato ZIM) direttamente da `node/src/`, come già avviene per le mappe offline (`map-tiles.ts`, nessun Docker) — eliminerebbe Docker anche per questo servizio, non solo la dipendenza da NOMAD.

**Perché conviene, se verificato**: elimina la dipendenza da un progetto esterno "non dichiarato stabile" (spec §4) — un rischio di roadmap che ARALD non controlla, già segnalato in `docs/reuse-vs-new.md` ("ARALD tratta NOMAD come una black box").

**Tre assi da verificare prima di decidere, nessuno ancora indagato in questo ambiente**:

1. **Licenze e copyright** — verificare la licenza di Kiwix stesso e della libreria che legge i file ZIM (`libzim`): se copyleft (es. GPL), includerla direttamente nel codice di `node/src/` (oggi MIT) può creare vincoli di licenza diversi dal trattarla come processo esterno separato via Docker come oggi — da controllare con attenzione, mai assumere "compatibile" senza verifica. Stesso controllo per Ollama. Verificare inoltre i termini dei contenuti stessi: Wikipedia è distribuita CC BY-SA (richiede attribuzione e stessa licenza per i derivati); i modelli AI reali hanno spesso licenze proprie non uniformi (alcune vietano l'uso commerciale, richiedono attribuzione, o impongono altri vincoli) — da controllare modello per modello scelto, mai genericamente assunto "aperto = senza vincoli".
2. **Requisiti di sistema/hardware** — capire se togliere Docker riduce davvero il fabbisogno hardware o solo la complessità operativa: l'overhead di Docker in sé è modesto, il vero costo di RAM/CPU per l'AI locale dipende dal modello scelto, non dal fatto di girare in un container o no. Probabile che il vantaggio reale sia "meno spazio disco e meno pezzi da installare/mantenere", non un abbattimento drastico dei requisiti hardware — da non promettere come tale finché non verificato.
3. **Sforzo di sviluppo reale** — `kiwix-gateway.ts`/`ai-gateway.ts` sono scritti assumendo l'interfaccia di un'istanza Project NOMAD; andrebbero verificati/adattati contro un Kiwix/Ollama "nudi" (nessun ambiente Docker disponibile in questa sessione per testarlo davvero — bloccata sullo stesso prerequisito dell'Opzione B sopra, ma per una domanda diversa: non "NOMAD funziona reale", ma "serve davvero tutto NOMAD").

**Non ancora deciso**: se procedere, e quale dei due gradini tentare per primo (solo-Kiwix/solo-Ollama dietro il gateway esistente, o lettura diretta ZIM come le mappe) — dipende dall'esito della verifica licenze sopra, il vincolo più probabile a orientare la scelta.

### Mockup pixel-precisi (Figma) — rimandati al lancio della beta, dopo i field test

Il piano di audit UX/UI (Artifact "ARALD — UX/UI Audit & Redesign Plan", mini-team di 4 ruoli, sezione 11) prevedeva 8 fasi. Le Fasi 1-6 sono **✅ complete** (dettaglio in `docs/security.md` voci #86-91: "Le mie attività", stato persistente SOS, migrazione token Waypoint, navigazione a 4 voci + Diagnostica, feed "Richiede attenzione ora" + conferma a due passi, tabella dati densa + badge di ruolo). La Fase 7 (Field User Test sui prototipi con utenti reali, Marco/Elena) è stata **saltata esplicitamente** (21 settembre 2026, decisione dell'utente — nessun utente reale disponibile in questo ambiente); il piano stesso la segnava come prerequisito per considerare chiusa qualunque fase precedente, quindi quel criterio resta consapevolmente non soddisfatto.

La Fase 8 (mockup pixel-precisi in Figma di tutti i flussi — griglie/spaziature esatte, ogni stato di ogni schermata, primo vero uso di Figma in questo progetto: nessun design system Figma esiste ancora, andrebbe ricostruito da zero a partire dai token già in `mobile/www/styles.css`/`mirror-portal/app/globals.css`) era subordinata dal piano stesso al via libera della Fase 7. **Decisione esplicita dell'utente (21 settembre 2026): il piano si chiude qui.** La Fase 8 resta un candidato aperto, da riprendere **al momento del lancio della versione beta di ARALD, dopo che i field test (validazione sul campo, non solo test utente sui prototipi) avranno confermato i flussi** — non prima, per non rifinire al pixel qualcosa che l'uso reale potrebbe ancora rivelare da cambiare.

### IP locale del prototipo Box (Orange Pi 4 Pro) — parzialmente risolto, 28 settembre 2026; resta un rifinimento facoltativo

**Non un problema di codice, una decisione di infrastruttura di rete** — di competenza dell'utente (`CLAUDE.md`, "Priorità per chi riprende questo lavoro"). Annotato qui solo come candidato aperto, non perché richieda lavoro in questo repository.

**Aggiornamento 28 settembre 2026**: il Box è passato da avvio manuale via SSH a **persistente** (servizio `systemd`) e da Ethernet a **solo Wi-Fi**, con un indirizzo IP **fisso impostato direttamente sulla scheda** (non più DHCP dinamico) — risultato pratico dell'osservazione sotto: una collisione reale con un altro dispositivo della rete (che usava un IP fisso configurato sul proprio sistema, non una riserva sul router) ha causato un avviso "host key changed" su SSH, diagnosticato e risolto in sessione. Dettaglio completo in `docs/riavvio-box-prototipo.md`.

**Osservazione originale (25 settembre 2026), ancora rilevante in parte**: un IP fisso impostato *sul dispositivo stesso* (come fatto ora) evita la collisione con quel dispositivo specifico, ma **non è equivalente a una riserva DHCP sul router** — resta teoricamente possibile che il router assegni lo stesso indirizzo a un altro dispositivo in futuro via DHCP, visto che il router non sa che quell'indirizzo è "preso".

**Direzione già decisa, ancora da eseguire quando comodo (rifinimento, non più bloccante)**: una prenotazione DHCP (static lease) sul router, basata sul MAC address dell'interfaccia Wi-Fi del prototipo — elimina anche il rischio residuo sopra. Da verificare che l'indirizzo riservato sia fuori dal range dinamico del pool (o che il router gestisca correttamente le riserve al suo interno).

---

### Pulsante di spegnimento sicuro nella Web UI — pianificato, non ancora implementato (28 settembre 2026)

**Richiesta dell'utente**: poter spegnere in sicurezza il Box (equivalente a `sudo shutdown -h now` + attesa del filesystem sincronizzato) da un pulsante nell'interfaccia web, invece di doversi collegare via SSH ogni volta.

**Decisione architetturale presa prima di iniziare (non ancora implementata)**: questo comando **non va aggiunto a `web-ui.ts`** — quell'interfaccia (stato/interazione della mesh, spec §59) è deliberatamente priva di qualunque accesso all'OS/Docker dell'host, stessa separazione già documentata per `nomad-hub/` contro l'app mobile (`CLAUDE.md`). Il posto corretto è **`nomad-hub/`** (ARALD Hub Management API, già pensata per amministrare l'host con una password propria separata da quella di rete della mesh) — non ancora attivo su questo prototipo Box.

**Cosa servirebbe, quando si riprenderà**: un nuovo endpoint autenticato in `nomad-hub/management-server.ts`, un permesso `sudo` **specifico e limitato** al solo comando di spegnimento per l'utente di sistema (mai sudo generico), un pulsante nel pannello `mobile/www/hub-control.html`/`.js` esistente, test dedicati — stesso workflow a doppio check di ogni feature sostanziale di questo repository. Richiede prima di attivare `nomad-hub/` su questo Box (oggi gira solo il nodo ARALD base).

---

## Milestone/feature completate — pointer al dettaglio in `docs/security.md`

Le Opzioni C-G furono scritte quando le rispettive milestone erano ancora aperte; oggi sono tutte ✅ complete e il loro stato reale vive in `docs/roadmap.md` — tenute qui solo come titolo + pointer:

- **Opzione C — Store-and-forward** (Milestone 12) ✅ — `docs/roadmap.md`, "Milestone 12 — store-and-forward: dettagli e limitazione nota".
- **Opzione D — Partition sync** (Milestone 13) ✅ — `docs/roadmap.md`, "Milestone 13 — partition sync: dettagli".
- **Opzione E — Firma dei contenuti, trust levels, rate limiting, cifratura E2E** (Milestone 15) ✅ — `docs/roadmap.md`, "Milestone 15 — sicurezza: dettagli".
- **Opzione F — Relay policy legata a batteria/carica e routing a costo distance-vector** (Milestone 16) ✅ — `docs/roadmap.md`, "Milestone 16 — relay policy e routing a costo: dettagli".
- **Opzione G — Simulatore di rete** (Milestone 20) ✅ — `docs/roadmap.md`, "Milestone 20 — simulatore: dettagli".

**Opzione H — App mobile**: Passo 1 (client Capacitor verso un gateway via Wi-Fi/TCP) ✅ fatto — `docs/security.md` voci #22/#23/#24; compilazione Android nativa bloccata dalla policy di rete (verificato, non ritentare), progetto Gradle comunque generato e committato. Identità visiva "Waypoint" e tutti i restyling successivi (rebrand, tipografia auto-ospitata, passata UX generalista, mix cromatico "Segnale verde" condiviso con i portali) ✅ fatti — voci #28/#31/#48/#50/#77; restyle dedicato di `mirror-portal/` e `node/src/web-ui.ts` ✅ fatto — voci #75/#76, `docs/emergency-portal.md`. Nessun restyling ulteriore in sospeso. Resta fuori portata in questo ambiente, invariato: la verifica su un telefono reale o un emulatore (nessun hardware/SDK Android disponibile).

Le proposte seguenti sono state valutate, pianificate e implementate per intero — l'analisi che le ha precedute e il dettaglio tecnico completo (bug trovati dalla revisione inclusi) vivono nelle rispettive voci di `docs/security.md`, non ripetuti qui:

- **Opzione I — Nomad News evoluto**: parser RSS/Atom scritto da zero (#33), livelli headline/summary/articolo completo (#35), digest generato componendo `service://ai` (#37), `service://emergency-news` con classificatore di priorità (#39, follow-up #41), il prerequisito architetturale condiviso — `MessageType.CONTENT_ANNOUNCE`, broadcast per contenuto singolo (#34). Completa per intero. Bloccato su prerequisiti esterni indipendentemente da questo piano: fonti RSS/Wikinews reali, un LLM reale per il digest.
- **Opzione J — Messaggistica (stile BitChat) e tracciamento posizione**: chat 1:1 (#36), canali pubblici non cifrati (#40), chat private/di gruppo cifrate a membership fissa — v1 senza uscita/rimozione membro né rotazione chiave, scelta esplicita dell'utente (#42), tracciamento posizione opportunistico con nodo registro dedicato a password propria (#44). Completa per intero.
- **Opzione K — "Internet senza Internet"** (`service://internet-fetch`, `gateway/nomad/internet-gateway.ts`, guardia SSRF in `url-safety.ts`) — #45.
- **Opzione L — Mappe topografiche offline** (`node/src/map-tiles.ts`, `mobile/www/mapview.js`) — #46.
- **Opzione M — Bacheca "drop" mesh-native**, ispirata a `BoardManager` di BitChat (`node/src/drops.ts`) — #47.
- **Opzione N — Transport LoRa simulato**, affiancato a BLE (`node/src/transports/lora.ts`, `transports/simulated-link.ts` estratto da `ble.ts`) — #51.
- **Node Capabilities — profilo dispositivo per discovery**: estensione di `IdentityAnnouncement` con una sola etichetta di classe dispositivo, solo informativa/mesh-wide, mai consultata da routing/trust ✅ fatta — #74.
- **LoRa unificato su SX1262**: driver host-side (`transports/lora-serial-sx1262.ts`, `sx126x-commands.ts`/`-bridge-protocol.ts`) ✅ fatto — #71; firmware embedded del bridge (`firmware/sx126x-bridge/`) scritto, mai provato su hardware — #73, checklist in `firmware/sx126x-bridge/README.md`. Vedi anche `docs/deployment.md`, "LoRa unificato su SX1262".

## Espansioni successive al piano d'insieme, documentate altrove

Le espansioni proposte e realizzate dopo il completamento delle Opzioni A-N — l'ecosistema **ARALD Card** (Beacon/Relay Mode) + Fixed Relay + Relay Registry, l'**Emergency Portal** (`arald-backend/`/`local-portal/`/`mirror-portal/`, incluso il canale di comando Box↔specchio e l'autenticazione operatori, tutto in produzione), la roadmap di validazione sul campo (fasi/budget/partner/effetto di rete), il protocollo di test tecnico (fasi 0-8) — sono documentate rispettivamente in [`docs/beacon.md`](./beacon.md), [`docs/emergency-portal.md`](./emergency-portal.md), [`docs/emergency-rescue-network.md`](./emergency-rescue-network.md), [`docs/test-protocol.md`](./test-protocol.md). Non ripetute qui, coerentemente con il principio "un fatto, una fonte" di questo repository.
