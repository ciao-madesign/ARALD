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

### Opzione B — Verifica del gateway contro istanze reali (roadmap Milestone 10-11) — scope corretto il 30 settembre 2026

**Scope originario, superato**: questa voce prevedeva di far girare un'istanza reale di **Project NOMAD** via Docker e verificare il gateway contro di essa. **Non è più il piano**: `KiwixGateway`/`AiGateway`/`FlatnotesGateway` parlano tutti con le vere API dirette dei rispettivi backend (Kiwix, Ollama, Flatnotes), mai con un'API di Project NOMAD (`docs/security.md` voci #97/#98/#100) — Project NOMAD come pacchetto non è più un prerequisito per nessuna forma reale di questo gateway.

**Cosa resta da fare**: verificare gli stessi tre gateway contro istanze **realmente in esecuzione** di `kiwix-serve`/Ollama/Flatnotes — `service-stack/docker-compose.yml` (nuovo, `docs/security.md` voce #99/#101) le avvia già con le loro immagini Docker ufficiali pubbliche, sintassi validata staticamente ma **mai un `docker compose up` reale**: nessun demone Docker raggiungibile in questa sessione (`docker info` fallisce sul socket). **Stato: bloccata solo su questo** — non più su Project NOMAD/Docker in generale, solo su un demone Docker raggiungibile in una sessione futura.

**Criteri di accettazione**: un `NomadNode` con questo gateway attivo risponde a una `CONTENT_QUERY` per un articolo Kiwix reale (o una nota Flatnotes, o una risposta Ollama reale) con lo stesso ciclo già coperto dai test esistenti, servendo dati reali invece che contenuto pubblicato via `publishContent()`/una `FakeKiwixServer`/`FakeOllamaServer`/`FakeFlatnotesServer`.

**Rischi principali, aggiornati**: nessuno legato a Project NOMAD più (non dipende più da un progetto "non dichiarato stabile", spec §4) — resta solo il rischio generico che kiwix-serve/Ollama/Flatnotes cambino la propria API in una versione futura, mai verificato oltre le versioni consultate il 30 settembre 2026.

### Ponte verso Meshtastic — accessorio opzionale, fase successiva alla validazione dei prototipi (proposto dall'utente, 30 settembre 2026)

**Non una milestone core**: a differenza delle Opzioni sopra, questo è pensato esplicitamente come **accessorio** del progetto — utile per chi vorrà dotare il proprio Box/Portable/Fixed Relay di una **seconda antenna LoRa dedicata a questo solo scopo**, non un requisito per usare ARALD. Verrà sviluppato **su un branch dedicato separato**, non sul branch di lavoro principale, proprio per la sua natura di componente opzionale/staccabile dal core — merge solo quando maturo.

**Perché non ora**: subordinato al completamento della fase di validazione dei prototipi attuali (mesh reale, Box, Card) — non ha senso investire in un ponte verso un ecosistema esterno prima che il nucleo ARALD sia validato sul campo. Candidato per una fase successiva, non pianificato a breve termine.

**Idea**: un gateway che riceve/traduce pacchetti Meshtastic (LoRa) verso le strutture dati ARALD e viceversa — dettaglio del design discusso con l'utente (livello radio, protocollo, mapping, fiducia) in `docs/external-inspiration.md`. Punti chiave:
- **Vincolo hardware esplicito — subordinato alla presenza di un'antenna dedicata**: richiede un secondo radio LoRa fisico sul nodo-ponte, sintonizzato sui parametri di modulazione di Meshtastic (banda/SF/coding rate del loro preset — da verificare contro `meshtastic/firmware`/documentazione ufficiale prima di implementare, non assunti qui). Il radio ARALD esistente resta dedicato alla propria mesh; **senza questa seconda antenna il ponte non è utilizzabile** — non è un'opzione software pura.
- Decodifica del `MeshPacket` (protobuf pubblico) reimplementata da zero — nessun riuso di codice Meshtastic (GPL-3.0), stesso trattamento già riservato in `docs/reuse-vs-new.md`.
- Mapping proposto: `TEXT_MESSAGE_APP` → `PublicChannels`/`Drops`; `POSITION_APP` → `LocationRegistry` (fiducia minima); `ALERT_APP`/`GROUPALARM_APP` → `EmergencyBeacons` (si incastra bene: `emergency-beacon.ts` è già senza `trustRank`, un'identità mai vista è il caso atteso per un SOS).
- Non implementa l'interfaccia `Transport` esistente (non è un link punto-a-punto) — stesso trattamento architetturale di `transports/beacon-broadcast.ts`, un modulo a sé wired su `NomadNode` con un hook dedicato.

**Prerequisiti**: (1) validazione dei prototipi completata, (2) hardware reale — un secondo radio LoRa dedicato sul nodo-ponte, non disponibile in questo ambiente. **Stato: non pianificata a breve, accessorio per una fase successiva.**

**Rischi principali**: parametri di modulazione Meshtastic da verificare con fonte primaria prima di iniziare (non assunti); un pacchetto tradotto entra sempre a fiducia nulla/minima, va marcato chiaramente come fonte esterna non verificata nell'interfaccia utente per non confonderlo con un peer ARALD autenticato.

**Sforzo relativo**: **medio-alto** — hardware aggiuntivo nel loop, reimplementazione di un parser protobuf minimo, ma la logica di traduzione verso le strutture dati ARALD riusa componenti già esistenti (content/drops/beacon/location).

### Connettività Bluetooth lato gateway/Clip (Opzione H, Passo 2)

Lato telefono (scan/connect/handshake verso una ARALD Clip/Cover, logica di protocollo unit-testata): fatto, `docs/security.md` voce #62. **Prerequisito ancora aperto**: un dispositivo con hardware BLE reale dal lato gateway/Clip che parli ARALD — stesso blocco dell'Opzione A, nessuna verifica end-to-end possibile finché non è disponibile.

### Relay Bluetooth telefono↔telefono senza Clip — design fatto, resta solo la verifica su hardware reale

Design e implementazione completi (macchina a stati di fallback `mobile/www/ble-role-manager.js`, voce #68; percorso primario dual-role `ble-dual-role-client.js`/`ble-serial-queue.js`, voce #69) — dettaglio tecnico completo, incluso il limite noto del plugin nativo usato, in `mobile/README.md` e `docs/security.md` voci #68/#69. **Resta aperto**: solo la verifica su hardware/emulatore reale (non disponibile in questo ambiente) — se il dual-role simultaneo si rivelasse inaffidabile in pratica, il fallback è collegare `ble-role-manager.js` allo stesso plugin invece del design "sempre entrambi i ruoli".

### Firmware bridge SX1262 (`firmware/sx126x-bridge/`) — scritto, bloccato sulla verifica su hardware reale

Il firmware Arduino/C++ per il microcontrollore-traduttore (seriale↔SPI verso il chip radio SX1262 reale) è scritto e controllato per quanto possibile in questo ambiente (`docs/security.md` voce #73), ma **mai caricato né provato su hardware vero** — nessun dispositivo raggiungibile da questo ambiente. Checklist completa dei passi rimasti in [`firmware/sx126x-bridge/README.md`](../firmware/sx126x-bridge/README.md) — lavoro dell'utente, non pianificabile ulteriormente da qui.

### Gestione alimentazione/blackout (UPS) — specifica scritta, bloccata sulla scelta hardware

Specifica completa in [`docs/power-management.md`](./power-management.md) (proposta hardware dell'utente, 30 settembre 2026, valutata contro il codice esistente e integrata come documento a sé). **Non implementata**: bloccata su una decisione hardware non ancora presa (quale modulo UPS, se espone o meno un segnale distinguibile rete/batteria). Il Caso B (nessun segnale, il nodo continua a funzionare normalmente fino allo spegnimento dell'UPS) è già pienamente compatibile con l'architettura esistente senza alcun codice nuovo — resta la sola forma accettabile per la V1 finché l'hardware non cambia questo vincolo.

### Validazione di ARALD su una seconda piattaforma hardware reale — bloccata sulla disponibilità di un secondo dispositivo

**Non ancora soddisfatta dalla mesh reale a due macchine del 28 settembre** (`docs/deployment.md`): quel traguardo ha validato `TcpTransport`/l'handshake crittografico tra due processi ARALD su macchine fisiche separate (Orange Pi + un Mac) — un risultato reale e distinto, ma senza scrivere un nuovo `Transport`, dato che entrambi i lati usano lo stesso trasporto TCP di sempre. Quello che questa voce chiede è diverso e più specifico: aggiungere un **nuovo** adapter hardware/trasporto (anche solo un secondo dispositivo che parli LoRa seriale, o più in generale un hardware/OS genuinamente diverso, non necessariamente un candidato Box "ufficiale") per verificare che farlo richieda *solo* un nuovo adapter dietro l'interfaccia `Transport` già esistente (`node/src/transport.ts`), senza toccare `node.ts`/`routing.ts`/`content.ts`/ecc. Se così fosse, è una prova diretta che l'astrazione hardware attuale regge davvero un caso nuovo, non solo sulla carta. Se invece richiedesse modifiche al Core, avrebbe individuato esattamente dove serve rendere quell'interfaccia più pulita — informazione preziosa prima di considerare un giorno l'estrazione di un SDK separato dal Core (vedi la nuova convenzione in `CLAUDE.md`, "Convenzioni consolidate", sulla stessa disciplina applicata a ogni nuovo componente fin da ora). **Stato: bloccata — nessun secondo dispositivo/trasporto hardware nuovo disponibile in questa sessione**, nessuna decisione presa su quale piattaforma.

### Come procedere quando i prerequisiti saranno disponibili

Le opzioni sopra restano bloccate sui rispettivi prerequisiti ambientali **solo per la loro forma realistica finale** — dove esiste una versione simulata/mockata, questa ha già validato la logica applicativa come lavoro in puro software. Quando hardware/Docker saranno disponibili, il codice reale si aggiunge dietro la stessa interfaccia già validata dalla versione simulata, senza dover ripartire da zero.

---

## Candidato aperto e pianificato, non ancora implementato

### Pulsante dedicato "Invia la mia posizione" per il check-in verso un webhook — non ancora implementato

Terzo/quarto/quinto esempio di "consegna esterna differita" — post su un canale/bot, check-in di posizione, upload di un report/foto (pianificati con l'utente il 21 settembre 2026) — coperti da un solo relay generico costruito il 29 settembre 2026: `webhook-relay/` (`docs/security.md` voce #94, `docs/service-catalog.md`). L'upload di file/foto non ha richiesto nulla di nuovo lato mobile — il pannello "Invia a un'organizzazione" accetta già un file allegato oggi.

**Resta aperto solo un rifinimento UX lato mobile, non backend**: per il check-in di posizione è consigliato un pulsante dedicato "Invia la mia posizione" che compili automaticamente le coordinate GPS (plugin Geolocation già in uso altrove nell'app, voce #44) più uno stato rapido ("Tutto ok"/"Serve aiuto"), invece di scrivere a mano nel campo testo esistente del pannello "Invia a un'organizzazione". Nessun codice scritto per questo rifinimento finora — da riprendere in una sessione futura con lo stesso workflow a doppio check, solo se/quando richiesto dall'utente.

### Installer/wizard "ARALD Portable" software-puro — proposto dall'utente il 29 settembre 2026, piano tecnico rivalutato e confermato il 30 settembre 2026, non ancora implementato

**Idea**: distribuire il solo runtime mesh (`node/src/` — `NomadNode`/`cli.ts`/`web-ui.ts`, nessuna dipendenza da Docker o Project NOMAD) come pacchetto installabile per un utente non tecnico — variante **Wi-Fi-only**, nessun hardware radio richiesto (il kit LoRa resta un componente opzionale per chi vuole portata lunga, vedi `docs/deployment.md`, "Chiarimento terminologico... due significati di ARALD Portable").

**Perché non è bloccata come le Opzioni A/B sopra**: a differenza del "Bootstrap/packaging del ARALD Hub" (`docs/deployment.md`, tuttora bloccato — non più su Project NOMAD, il cui sorgente non serve più, ma su un demone Docker reale raggiungibile, `service-stack/`), questo pacchetto confeziona solo codice già reale e testato in questo repository — nessun Docker, nessun hardware radio necessario per la variante base.

**Decisione presa il 30 settembre 2026, esplicitamente dell'utente**: forma "app" (installer nativo, gira in background mentre il PC resta utilizzabile normalmente), **non** un'immagine avviabile da SSD/USB — alternativa valutata e scartata (avrebbe reso il PC un'appliance dedicata finché acceso da quella chiavetta, un trade-off di forma-prodotto giudicato peggiore per questo caso).

**Piano tecnico concreto, punto per punto**:

1. **Packaging — Node SEA (Single Executable Applications)**, la feature nativa di Node 20+: zero nuove dipendenze esterne (coerente con la convenzione del repository), un binario autonomo per piattaforma che include già il runtime Node — l'utente non deve avere Node installato. Build separate per `win-x64`, `macos-x64`, `macos-arm64`, `linux-x64`, `linux-arm64`, via matrice CI (GitHub Actions), non da una singola macchina. **Limite noto di questo ambiente**: qui è costruibile e verificabile solo il binario Linux — Windows/macOS richiedono build e verifica sulle rispettive piattaforme reali, stesso tipo di limite già documentato per la build Android nativa (`CLAUDE.md`).
2. **Persistenza in background** — nessun tray icon nativo per la v1 (eviterebbe Electron o binding nativi solo per quello, costo/complessità sproporzionati rispetto al beneficio). Ogni piattaforma registra l'avvio automatico col proprio meccanismo nativo: LaunchAgent su macOS, Task Scheduler/servizio su Windows, systemd user unit su Linux — stesso principio già validato sul Box reale (`--identity-dir` + avvio persistente via systemd), solo esteso a tre piattaforme.
3. **Wizard di primo avvio** — nessuna UI nuova da costruire: l'installer, al primo avvio, apre il browser di sistema puntato sulla pagina di setup **già esistente** in `web-ui.ts` (stesso pairing Wi-Fi-style con QR già costruito per altri ruoli). Da lì in poi quella stessa pagina resta il pannello di controllo, niente app nativa con interfaccia propria da mantenere. Si incastra con la proposta "file di configurazione per `cli.ts`" già annotata in `docs/external-inspiration.md`: il wizard scriverebbe quel file invece dei soli flag.
4. **Directory dati** — una directory standard per OS scelta in automatico dal wizard (`~/.arald/` o l'equivalente `AppData`/`Application Support`), con un'opzione avanzata per chi vuole comunque puntare a un disco esterno. Non più legata a un SSD esterno come nella formulazione originale, dato che la forma scelta è "app" non "immagine avviabile".
5. **Verifica end-to-end con un utente non tecnico** — resta bloccata, nessun utente reale disponibile in questo ambiente, stesso limite di ogni verifica "sul campo" di questo repository.
6. **Effetto Kickstarter** — framing "costo di produzione ~0€" resta pulito con questa forma (zero hardware da procurarsi, solo scaricare ed eseguire) — anzi migliora rispetto all'ipotesi immagine-avviabile, che avrebbe comunque richiesto un SSD/chiavetta propria.

### Coda SOS persistente sul telefono, in attesa di un peer BLE — emerso da una domanda dell'utente, 30 settembre 2026, non ancora implementato

**Priorità: media** — migliora un caso limite di una feature già funzionante (l'SOS via Bluetooth dal telefono, voce #65), non blocca un percorso d'acquisto/onboarding.

**Stato attuale, verificato nel codice**: `mobile/www/ble-client.js`'s `sendEmergencyBeaconViaRelay()` attiva il relay Bluetooth del telefono se non è già attivo, poi ripete l'invio dell'SOS per `SOS_BROADCAST_REPEAT_COUNT` volte a intervalli brevi (pochi secondi in tutto) — cattura un peer che si connette subito dopo il tap, ma se nessuno è a portata in quella finestra, l'SOS non resta in attesa oltre.

**Idea**: tenere l'SOS "pronto" e farlo partire automaticamente il momento in cui il telefono incrocia un qualunque dispositivo ARALD via Bluetooth, anche minuti o ore dopo — non solo nella finestra immediata dopo il tap. Coerente con l'obiettivo dichiarato del progetto di sfruttare qualunque canale disponibile, incluso "il primo che capita, quando capita".

**Cosa servirebbe**: una coda locale sul telefono (persistita, sopravvive alla chiusura dell'app) con l'SOS già costruito e firmato (`ble-sos.js`), un listener sulla scoperta di nuovi peer Bluetooth che, se la coda non è vuota, tenta l'invio subito; un modo per l'utente di vedere "SOS in attesa di essere trasmesso" invece del solo "SOS trasmesso" attuale, e di annullarlo. Da progettare: per quanto tempo tenerlo in coda (batteria/rilevanza del messaggio scadono), e se ripetere l'invio anche dopo il primo successo (un solo peer raggiunto non garantisce che il messaggio arrivi a un Emergency Node reale, la mesh sottostante gestisce già l'inoltro una volta entrato, ma vale la pena chiarirlo esplicitamente quando si progetterà).

### Internet come trasporto opzionale tra nodi mesh lontani — emerso da una domanda dell'utente, 30 settembre 2026, non ancora implementato

**Priorità: da valutare** — a differenza delle due voci sopra, questa non sblocca un percorso d'acquisto né corregge un caso limite di una feature esistente: è un'estensione infrastrutturale della portata della mesh stessa, coerente con l'obiettivo dichiarato del progetto di sfruttare qualunque canale disponibile (BLE, LoRa, Wi-Fi/LAN locale — e Internet, quando c'è, non solo come sotto-servizio ma come collegamento diretto tra due nodi mesh distanti).

**Chiarimento sulla premessa**: ARALD **già usa** Internet quando disponibile, ma solo in tre forme specifiche, mai come trasporto diretto nodo-a-nodo: `internet-gateway.ts` (un nodo recupera contenuti online per conto della mesh), `external-delivery.ts`/i relay WhatsApp-email-webhook (un Box consegna messaggi verso l'esterno appena torna online), `arald-backend`→`mirror-portal` (sincronizzazione di stato verso il portale di coordinamento). Non ancora esplorato: far parlare direttamente due nodi mesh fisicamente lontani (es. due Box in due rifugi diversi) come se fossero sulla stessa rete locale, quando entrambi hanno Internet.

**Perché non è già così, e cosa manca davvero**: il trasporto TCP che ARALD usa già funzionerebbe anche su Internet **oggi, senza modifiche**, se un nodo conosce l'indirizzo raggiungibile dell'altro (`--connect`, lo stesso flag già usato per la prima connessione mesh reale tra due macchine, `docs/deployment.md`). Il pezzo mancante è la **scoperta automatica**: la maggior parte dei dispositivi sta dietro un router che nasconde il proprio indirizzo reale (NAT) e lo cambia nel tempo, quindi senza un piccolo servizio di "elenco telefonico" condiviso dove i nodi si registrano e si trovano (o un meccanismo di attraversamento NAT), due Box non si troverebbero da soli su Internet, anche se entrambi online.

**Tensione da risolvere prima di progettare**: un servizio di discovery condiviso è esattamente il tipo di infrastruttura centrale sempre accesa che ARALD evita come **requisito** per il proprio funzionamento di base — va progettato esplicitamente come **opzionale**, mai come dipendenza, coerente con `internet-gateway.ts`/`external-delivery.ts` che seguono già lo stesso principio (Internet arricchisce, non è mai richiesto).

**Cosa servirebbe, in linea di massima**: un servizio di discovery minimo (dove un nodo con Internet può registrare il proprio indirizzo raggiungibile, opt-in esplicito), un nuovo modo per `cli.ts` di risolvere un peer remoto tramite quel servizio invece del solo `--connect <ip:porta>` manuale, e una riflessione su attraversamento NAT per i nodi senza indirizzo pubblico/porta inoltrata (fuori scope per una prima versione, che potrebbe limitarsi a chi ha già un indirizzo raggiungibile). Nessun codice scritto finora, idea ancora da approfondire.

### Mockup pixel-precisi (Figma) — rimandati al lancio della beta, dopo i field test

Il piano di audit UX/UI (Artifact "ARALD — UX/UI Audit & Redesign Plan", mini-team di 4 ruoli, sezione 11) prevedeva 8 fasi. Le Fasi 1-6 sono **✅ complete** (dettaglio in `docs/security.md` voci #86-91: "Le mie attività", stato persistente SOS, migrazione token Waypoint, navigazione a 4 voci + Diagnostica, feed "Richiede attenzione ora" + conferma a due passi, tabella dati densa + badge di ruolo). La Fase 7 (Field User Test sui prototipi con utenti reali, Marco/Elena) è stata **saltata esplicitamente** (21 settembre 2026, decisione dell'utente — nessun utente reale disponibile in questo ambiente); il piano stesso la segnava come prerequisito per considerare chiusa qualunque fase precedente, quindi quel criterio resta consapevolmente non soddisfatto.

La Fase 8 (mockup pixel-precisi in Figma di tutti i flussi — griglie/spaziature esatte, ogni stato di ogni schermata, primo vero uso di Figma in questo progetto: nessun design system Figma esiste ancora, andrebbe ricostruito da zero a partire dai token già in `mobile/www/styles.css`/`mirror-portal/app/globals.css`) era subordinata dal piano stesso al via libera della Fase 7. **Decisione esplicita dell'utente (21 settembre 2026): il piano si chiude qui.** La Fase 8 resta un candidato aperto, da riprendere **al momento del lancio della versione beta di ARALD, dopo che i field test (validazione sul campo, non solo test utente sui prototipi) avranno confermato i flussi** — non prima, per non rifinire al pixel qualcosa che l'uso reale potrebbe ancora rivelare da cambiare.

### IP locale del prototipo Box (Orange Pi 4 Pro) — parzialmente risolto, 28 settembre 2026; resta un rifinimento facoltativo

**Non un problema di codice, una decisione di infrastruttura di rete** — di competenza dell'utente (`CLAUDE.md`, "Priorità per chi riprende questo lavoro"). Annotato qui solo come candidato aperto, non perché richieda lavoro in questo repository.

**Aggiornamento 28 settembre 2026**: il Box è passato da avvio manuale via SSH a **persistente** (servizio `systemd`) e da Ethernet a **solo Wi-Fi**, con un indirizzo IP **fisso impostato direttamente sulla scheda** (non più DHCP dinamico) — risultato pratico dell'osservazione sotto: una collisione reale con un altro dispositivo della rete (che usava un IP fisso configurato sul proprio sistema, non una riserva sul router) ha causato un avviso "host key changed" su SSH, diagnosticato e risolto in sessione. Dettaglio completo in `docs/riavvio-box-prototipo.md`.

**Osservazione originale (25 settembre 2026), ancora rilevante in parte**: un IP fisso impostato *sul dispositivo stesso* (come fatto ora) evita la collisione con quel dispositivo specifico, ma **non è equivalente a una riserva DHCP sul router** — resta teoricamente possibile che il router assegni lo stesso indirizzo a un altro dispositivo in futuro via DHCP, visto che il router non sa che quell'indirizzo è "preso".

**Direzione già decisa, ancora da eseguire quando comodo (rifinimento, non più bloccante)**: una prenotazione DHCP (static lease) sul router, basata sul MAC address dell'interfaccia Wi-Fi del prototipo — elimina anche il rischio residuo sopra. Da verificare che l'indirizzo riservato sia fuori dal range dinamico del pool (o che il router gestisca correttamente le riserve al suo interno).

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
- **Opzione K — "Internet senza Internet"** (`service://internet-fetch`, `gateway/local-services/internet-gateway.ts`, guardia SSRF in `url-safety.ts`) — #45.
- **Opzione L — Mappe topografiche offline** (`node/src/map-tiles.ts`, `mobile/www/mapview.js`) — #46.
- **Opzione M — Bacheca "drop" mesh-native**, ispirata a `BoardManager` di BitChat (`node/src/drops.ts`) — #47.
- **Opzione N — Transport LoRa simulato**, affiancato a BLE (`node/src/transports/lora.ts`, `transports/simulated-link.ts` estratto da `ble.ts`) — #51.
- **Node Capabilities — profilo dispositivo per discovery**: estensione di `IdentityAnnouncement` con una sola etichetta di classe dispositivo, solo informativa/mesh-wide, mai consultata da routing/trust ✅ fatta — #74.
- **LoRa unificato su SX1262**: driver host-side (`transports/lora-serial-sx1262.ts`, `sx126x-commands.ts`/`-bridge-protocol.ts`) ✅ fatto — #71; firmware embedded del bridge (`firmware/sx126x-bridge/`) scritto, mai provato su hardware — #73, checklist in `firmware/sx126x-bridge/README.md`. Vedi anche `docs/deployment.md`, "LoRa unificato su SX1262".
- **Indipendenza da Project NOMAD** (Kiwix/Ollama/Flatnotes diretti, `gateway/local-services/`, `service-stack/`) — richiesta esplicita dell'utente, 29-30 settembre 2026. `KiwixGateway`/`AiGateway`/`FlatnotesGateway` riscritti contro le vere API dirette dei rispettivi backend (mai un'API di Project NOMAD, verificate con accesso web reale) — #97/#98/#100; `service://kiwix-fetch`/`service://flatnotes-fetch` risolvono l'assenza di un endpoint di listing bulk in entrambi i backend — #98/#100; `service-stack/docker-compose.yml` li avvia con le loro immagini Docker ufficiali pubbliche, sostituendo la dipendenza dal sorgente Project NOMAD (mai reso disponibile) — #99/#101; `gateway/nomad/` rinominata `gateway/local-services/` a completamento — #101. **Resta bloccata solo la verifica contro istanze realmente in esecuzione** (nessun demone Docker raggiungibile in questa sessione) — vedi "Opzione B" sopra.
- **Provisioning Wi-Fi via Bluetooth per un Box senza cavo Ethernet** — priorità alta, sbloccava un percorso d'acquisto reale per chi riceve un Box senza cavo Ethernet a disposizione. Metà lato Box (`nomad-hub/wifi-provisioning.ts`, wrapper `sudo nmcli`) — #102. Server GATT BlueZ reale lato Box (`nomad-hub/wifi-gatt-server.ts`/`wifi-gatt-protocol.ts`, via `dbus-next`, cifratura `nacl.box`) + estensione lato app (`mobile/www/ble-wifi-provisioning.js`, pannello minimale sulla schermata di setup) — #103, completata dopo che l'utente ha reso disponibile un Box fisico reale su cui verificare (stesso trattamento già dato al driver LoRa SX1262/`firmware/sx126x-bridge/`: scritta per intero, verificata solo contro fake/unit test qui). **Resta bloccata solo la verifica end-to-end contro un Box e un telefono reali** — lavoro esclusivo dell'utente, mai eseguibile in questo ambiente.

## Espansioni successive al piano d'insieme, documentate altrove

Le espansioni proposte e realizzate dopo il completamento delle Opzioni A-N — l'ecosistema **ARALD Card** (Beacon/Relay Mode) + Fixed Relay + Relay Registry, l'**Emergency Portal** (`arald-backend/`/`local-portal/`/`mirror-portal/`, incluso il canale di comando Box↔specchio e l'autenticazione operatori, tutto in produzione), la roadmap di validazione sul campo (fasi/budget/partner/effetto di rete), il protocollo di test tecnico (fasi 0-8) — sono documentate rispettivamente in [`docs/beacon.md`](./beacon.md), [`docs/emergency-portal.md`](./emergency-portal.md), [`docs/emergency-rescue-network.md`](./emergency-rescue-network.md), [`docs/test-protocol.md`](./test-protocol.md). Non ripetute qui, coerentemente con il principio "un fatto, una fonte" di questo repository.
