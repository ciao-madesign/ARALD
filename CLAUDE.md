# ARALD — contesto per Claude Code

Questo file viene letto automaticamente a ogni nuova sessione in questo repository. Obiettivo: far ripartire un nuovo sviluppatore (umano o Claude) senza dover rileggere l'intera cronologia della chat. **Questo file è un manuale operativo, non un changelog**: descrive struttura, convenzioni, workflow e regole permanenti. La cronologia di cosa è stato fatto, quando e perché vive altrove — vedi "Stato del progetto e dove trovarlo" sotto — e non va ripetuta qui.

**Nota sul naming**: il progetto si chiama **ARALD** dal 4 settembre 2026 — rinominato da "Nomad-Net" a valle di una due-diligence tecnica/legale (conflitto di nome reale con NomadNet/Mark Qvist, GPL-3.0, e ambiguità col Project NOMAD esterno a cui il gateway si collega; dettaglio completo in `docs/reuse-vs-new.md`). La narrativa storica nei documenti di `docs/` (scritta via via nel tempo, giorno per giorno) **non è stata riscritta** — usa ancora "Nomad-Net"/"NOMAD-Net" dove quello era il nome del progetto nel momento in cui il testo fu scritto, per preservare l'accuratezza storica di chi ha detto/deciso cosa e quando. Lavorando sul codice, usa sempre **ARALD** in ogni contenuto nuovo (documentazione, UI, messaggi, commenti forward-looking); la classe interna `NomadNode` e la directory `gateway/nomad/` restano invariate deliberatamente — la prima è un identificatore di codice mai visibile all'esterno, la seconda si riferisce correttamente al Project NOMAD esterno (Crosstalk Solutions), non al nome del nostro progetto. Terminologia ufficiale per l'ecosistema di emergenza: **ARALD Card** (profili Beacon Mode/Relay Mode/Beacon+Relay Mode), **ARALD Fixed Relay**, **ARALD Box**/**ARALD Portable** — i simboli di codice storici che usano nomi precedenti (es. `emergency-beacon.ts`, commenti che parlano di "profilo corriere") **non vengono rinominati retroattivamente**: sono nomi storici per lo stesso codice, non un'ambiguità tecnica da risolvere.

## Cos'è questo progetto

ARALD è un prototipo software di rete distribuita, **content-centric** e **delay-tolerant**: dispositivi condividono contenuti, servizi e messaggi senza infrastruttura Internet, tramite mesh locali, store-and-forward, caching opportunistico e sincronizzazione automatica al ritorno della connettività. Ispirato concettualmente a BitChat (mesh BLE) e pensato per integrarsi con Project NOMAD come "service provider" locale (Kiwix, Ollama, ecc.), ma senza dipendere da nessuno dei due.

Tre assi concettuali utili per orientarsi (dettaglio in `docs/architecture.md`): **Connectivity** (come un nodo raggiunge un altro — transport), **Compute** (quanta capacità di elaborazione ha un nodo), **Services** (cosa un nodo può offrire alla mesh). Montagna/rifugio, emergenza/disastri e ONG/missioni umanitarie sono i tre ambienti di validazione primari, a pari dignità (`docs/deployment.md`) — non l'unico perimetro del progetto.

**Specifica completa e single source of truth**: [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) (in italiano, numerata per paragrafi §N — tutti i riferimenti nel codice e nei commenti usano questa numerazione). Se qualcosa nel codice sembra contraddire questo file, la specifica vince; se manca un dettaglio, cercalo lì prima di indovinare.

**Repository GitHub**: `ciao-madesign/ARALD` (rinominato da `ciao-madesign/nomad-net` il 4 settembre 2026, contestualmente al rename del progetto). **Branch di lavoro**: `claude/nomad-net-project-spec-lcnbqt` (nome del branch invariato deliberatamente — un identificatore Git interno, mai visibile all'esterno, rinominarlo comporterebbe solo rischio senza alcun beneficio di branding).

## Regola permanente: push su main

**Istruzione permanente data dall'utente in questa sessione: ogni commit va pushato sia sul branch di lavoro sia direttamente su `main`.** Non è implicita nel workflow standard di Claude Code (che normalmente lavora solo sul branch dedicato) — è stata data esplicitamente e va rispettata per ogni futuro commit, non solo per quelli già fatti. Verifica sempre che `main` sia allo stesso commit del branch di lavoro prima di pushare (fast-forward), altrimenti chiedi come procedere invece di forzare.

## Stato del progetto e dove trovarlo

Il piano d'insieme originario (milestone 0-20 + i follow-up post-audit) è completo; gli ultimi ampliamenti sono l'ecosistema ARALD Card/Beacon/Relay/Relay Registry, l'Emergency Portal (`arald-backend/`/`local-portal/`/`mirror-portal/`, quest'ultimo in produzione su Vercel), un primo driver LoRa reale (`lora-serial.ts`) e il ruolo di relay Bluetooth lato smartphone. Non c'è un fatto storico raccontato in questo file: ogni dettaglio — cosa è stato fatto, quando, perché, quali bug ha trovato la revisione — vive in uno di questi documenti, ciascuno fonte unica per il proprio argomento:

| Cosa cerchi | Dove vive |
|---|---|
| Stato delle milestone 0-20, cosa resta bloccato e su cosa | [`docs/roadmap.md`](docs/roadmap.md) |
| Storia feature-per-feature: cosa è stato costruito, perché, bug trovati dalla revisione (voci numerate #1-66+) | [`docs/security.md`](docs/security.md) |
| Candidati aperti/non ancora pianificati | [`docs/next-steps.md`](docs/next-steps.md) |
| Ecosistema ARALD Card (Beacon/Relay Mode), Fixed Relay, Relay Registry | [`docs/beacon.md`](docs/beacon.md) |
| Metodo di progettazione hardware/RF orientato alla conformità (PCB, antenna, Technical File, Design Freeze, roadmap M0-M9) | [`docs/compliance.md`](docs/compliance.md) |
| Roadmap di validazione sul campo, budget, partner, effetto di rete | [`docs/emergency-rescue-network.md`](docs/emergency-rescue-network.md) |
| Protocollo di test tecnico (fasi 0-8, T-number, KPI) | [`docs/test-protocol.md`](docs/test-protocol.md) |
| Emergency Portal (`arald-backend/`, `local-portal/`, `mirror-portal/`) | [`docs/emergency-portal.md`](docs/emergency-portal.md) |
| Deployment target (ARALD Box/Portable), pilot per scenario d'uso | [`docs/deployment.md`](docs/deployment.md) |
| Cosa è riusato da Project NOMAD/BitChat vs. costruito ex novo | [`docs/reuse-vs-new.md`](docs/reuse-vs-new.md) |

**Leggi la voce/il documento pertinente prima di toccare il codice corrispondente** — spiegano non solo cosa è stato fatto ma perché, inclusi i bug trovati dalla revisione prima di considerare ogni voce conclusa.

## Priorità per chi riprende questo lavoro

Non c'è un prossimo passo predeterminato: `docs/next-steps.md` è la fonte di verità per i candidati aperti — leggilo prima di iniziare qualunque lavoro nuovo. Oltre a quello, alcune **regole/vincoli permanenti** che valgono per ogni lavoro futuro, non fatti storici da ricordare:

- Il bring-up fisico di qualunque prototipo (ARALD Box, Card, Relay) resta **lavoro privato dell'utente** — mai documentato come procedimento in questo repository, solo i risultati quando saranno disponibili (es. un futuro benchmark AI reale).
- `docs/deployment.md`/`docs/guida-hardware-rifugio.md` contengono **solo** indicazioni per chi *riceve* un ARALD Box/Portable già pronto e deve farlo funzionare — mai passaggi di bring-up (flash SD/NVMe, installazione Docker/Ollama dal nulla, benchmark).
- Contatti con enti partner (CNSAS, Protezione Civile, ecc.) o produttori terzi per l'integrazione hardware sono decisioni dell'utente, mai una questione tecnica di questo repository.
- Informazioni istituzionali o hardware non verificabili in questo ambiente (nessun accesso a internet reale) vanno sempre segnalate esplicitamente come tali, mai presentate come verificate.
- Le uniche milestone rimaste in `docs/roadmap.md` in forma *reale* (non simulata/mockata) richiedono un prerequisito esterno non disponibile in questo ambiente (hardware fisico, Docker + Project NOMAD raggiungibile, accesso a internet reale) — non pianificabili qui finché quel prerequisito non cambia.

Qualunque lavoro sostanziale futuro (nuova feature, passata di qualità, restyling) resta comunque soggetto al workflow a doppio check sotto e a un ok esplicito dell'utente prima di iniziare.

## Workflow da riusare per lavoro futuro (voce, feature, o passata di qualità)

Il workflow concordato con l'utente, usato per ogni voce sostanziale fatta finora in questo repository (`docs/security.md`) e da riapplicare identico a qualunque lavoro futuro:

1. Implementa la feature.
2. Scrivi/aggiorna i test (unit + integration, seguendo le convenzioni esistenti — vedi sotto).
3. Fai girare l'intera suite più volte di fila (`npx vitest run`, ripetuto 3-15x a seconda della sensibilità a timing/race) per scovare flakiness prima che la trovi la revisione.
4. Invoca la skill `code-review` con un prompt dettagliato che spiega cosa è cambiato e dove concentrare l'attenzione — non un generico "rivedi questo diff".
5. Correggi i problemi reali trovati (non solo quelli comodi), aggiungi test di regressione dedicati per ciascuno, ri-verifica.
6. Aggiorna `docs/security.md` (nuova voce numerata, con il dettaglio tecnico completo) e `docs/protocol.md`/il doc dedicato pertinente (`docs/beacon.md`, `docs/deployment.md`, ecc.). **Non** ri-raccontare la voce anche in questo file: `CLAUDE.md` si aggiorna solo per cambi strutturali (vedi "Cosa NON fare" sotto).
7. `npx tsc --noEmit -p node/tsconfig.json` e `npm run build -w node` puliti.
8. Commit con messaggio dettagliato (cosa, perché, cosa ha trovato la revisione), push su **sia** `claude/nomad-net-project-spec-lcnbqt` **sia** `main`.
9. Report all'utente in italiano, **poi fermati e aspetta un "ok" esplicito prima di iniziare il prossimo pezzo di lavoro** — istruzione esplicita data dall'utente, non legata a una singola serie di voci: vale per qualunque lavoro sostanziale futuro allo stesso modo.

Non saltare il passaggio di code-review nemmeno quando il codice "sembra ovviamente corretto": in ogni voce fatta finora ha trovato almeno un problema reale (spesso più di uno) prima di considerare la voce conclusa — inclusi crash-DoS reali (accesso non protetto a un campo di payload potenzialmente assente) e diverse race condition/edge case di conteggio.

## Struttura del repository

```
nomad-net/
├─ docs/            specifica (SPECIFICATION.md) e documentazione tecnica
├─ node/src/        nomad-node: il runtime di rete (unico package con codice reale)
├─ tests/           unit/, integration/, network/ (vitest)
├─ tools/simulator/ simulatore di rete a scala (usato anche da `npm run simulate`)
├─ gateway/nomad/   gateway NOMAD: KiwixGateway, AiGateway, NewsGateway, TranslateGateway, InternetGateway, FlatnotesGateway — mockato, non nel workspace npm
├─ nomad-hub/       ARALD Hub Management API: amministra Docker sull'host che esegue Project NOMAD — mai la mesh; non nel workspace npm, come gateway/nomad/
├─ mobile/          client mobile Capacitor verso un gateway — vedi mobile/README.md; mobile/ios/ ancora solo segnaposto; mobile/www/hub-control.html+.js è la Control UI (nomad-hub/), pagina separata da index.html/app.js
├─ arald-backend/   sincronizzazione Box → specchio Postgres (Emergency Portal) — vedi docs/emergency-portal.md
├─ local-portal/    dashboard operativa servita via LAN dal Box (Emergency Portal) — vedi docs/emergency-portal.md
├─ mirror-portal/   frontend Next.js sullo specchio Postgres, in produzione su Vercel — vedi docs/emergency-portal.md
└─ protocol/        segnaposto definizioni di protocollo condivise — non contiene codice reale
```

Tutto il codice reale vive sotto `node/src/`. `gateway/nomad/`, `nomad-hub/`, `arald-backend/`, `local-portal/`, `mirror-portal/` e `mobile/` (Android) hanno codice reale ma non sono nel workspace npm della radice (progetti separati con proprio `package.json` — `nomad-hub/` nemmeno quello, importa `node/src/*` con percorsi relativi come `gateway/nomad/`). `protocol/` e `mobile/ios/` restano placeholder dalla specifica, non toccarli aspettandosi codice.

L'app mobile (`mobile/www/`, JS/TS vanilla senza framework) è un client verso un `WebUiServer` esistente via HTTP: setup/pairing (Wi-Fi-style con QR opzionale) poi dashboard (vicini/servizi/contenuti/chat/canali/gruppi/posizione/mappa/bacheca/node-appends, chiamata servizi). Il pannello Relay mostra anche telemetria batteria (badge colorato sotto soglia) e un bottone "Riavvia" (comando remoto, `relayCommandStatus` module-level per persistere lo stato del bottone attraverso i refresh periodici, si auto-pulisce dopo `RELAY_COMMAND_STATUS_RESET_MS`). Verificata end-to-end con Playwright contro `NomadNode` reali, mai su un telefono fisico (non disponibile in questo ambiente). La build Android nativa (`mobile/android/`) non compila in questa sessione: richiede l'Android Gradle Plugin da `dl.google.com`, bloccato dalla policy di rete (verificato, non ritentare) — `npx cap sync android` invece funziona. `mobile/www/ble-link.js`/`ble-client.js`/`ble-relay.js` implementano il lato telefono della connettività Bluetooth verso una ARALD Clip/Cover e il ruolo di relay Bluetooth dello smartphone stesso — vedi `mobile/README.md` e `docs/security.md` voci #62/#63 per il dettaglio tecnico completo (nessuna verifica end-to-end contro hardware reale possibile qui). Ha ricevuto più passate di design dedicate (identità "Waypoint", poi un affinamento con tipografia auto-ospitata/elevazione/animazioni, poi una passata UX per un pubblico generico e non tecnico) — vedi `docs/security.md` per il dettaglio di ciascuna.

### File chiave in `node/src/` e a cosa servono

- `identity.ts` — `Identity` Ed25519 per nodo, firma/verifica.
- `packet.ts` — `MessageType` enum, formato pacchetto, `Priority` enum (spec §50), encode/decode newline-JSON.
- `transport.ts` — interfaccia `Transport` astratta. Reali: `transports/tcp.ts`, `transports/lora-serial.ts` (driver SX127x via bridge seriale). Simulate (nessun radio reale): `transports/ble.ts`, `transports/lora.ts` — entrambe thin wrapper su `transports/simulated-link.ts`, affiancabili sullo stesso `NomadNode` via `addTransport()`. `transports/beacon-broadcast.ts` è deliberatamente **fuori** da questa interfaccia — un dispositivo che non accetta mai connessioni non ha senso forzato in `connect()`.
- `transports/simulated-link.ts` — `SimulatedMedium` (registro condiviso in-process) + `SimulatedLinkTransport` (connessione punto-a-punto simulata, handshake HELLO, frammentazione a MTU); guadagna anche un registro broadcast separato (`broadcast()`/`registerBroadcastListener()`) con rate limit globale per-transport, non per mittente — un'identità usa-e-getta lo aggirerebbe altrimenti.
- `transports/beacon-broadcast.ts` — `BeaconBroadcastTransport`, non implementa `Transport`. Wired via `NomadNode.setBroadcastTransport()`, separato da `addTransport()` — non deve mai entrare in `this.peers`.
- `transports/lora.ts` — `LoraSimulatedTransport`/`LoraMedium`: MTU 200 byte, latenza 250ms/frammento (vs 5ms BLE — il parametro scelto per differenziare le due radio), 16 connessioni max. Duty-cycle del canale non modellato, limite noto.
- `transports/lora-serial.ts` + `sx127x-registers.ts` + `sx127x-bridge-protocol.ts` — primo driver LoRa **reale**: parla con un chip SX127x tramite un bridge seriale inventato da questo progetto (non SPI/GPIO diretto, per restare portabile sia su ARALD Box sia su Portable). Verificato solo contro `tests/helpers/fake-sx127x-serial-device.ts`, mai hardware vero. Nessun wiring su `cli.ts`.
- `routing.ts` — `SeenCache` (dedup) + `decideForward()`, controlled flooding (spec §21).
- `routing-table.ts` — routing a costo distance-vector (spec §22), traffico unicast.
- `content.ts` — `ContentStore` (`BoundedFifoMap`, limitata per dimensione con eviction pesata sulla fiducia), firma/verifica contenuti, `ChunkAssembler`, scadenza pigra.
- `catalog.ts` — `RemoteCatalog`, sync di metadata tra segmenti di rete riconnessi.
- `service.ts` / `service-directory.ts` — service discovery (spec §35-37), stesso schema di firma di `content.ts`.
- `store-and-forward.ts` — `PendingDeliveryQueue`, coda per pacchetti unicast non consegnabili subito. Eviction pesata su priorità (`priorityRank()` clampa `packet.priority`, mai validato da `decodePacket()`) e TTL differenziato più lungo per `Priority.EMERGENCY`; `requeue()` porta avanti l'`expiresAt` originale invece di resettarlo ad ogni ri-accodamento.
- `trust.ts` — `TrustLevel`/`TrustManager` (spec §54).
- `rate-limit.ts` — `RateLimiter`, budget di pacchetti per peer/finestra; `windows` è una `BoundedFifoMap` — un mittente broadcast con identità usa-e-getta rotanti farebbe altrimenti crescere la mappa senza limite.
- `relay-policy.ts` — relay `off`/`always`/`when-charging`/`battery-above`. `getCurrentResourceState()` espone lo stesso stato self-dichiarato anche a `NomadNode.reportRelayTelemetry()` — un solo posto dove configurare "qual è la mia batteria".
- `encryption.ts` — E2E per messaggi privati (X25519 + AES-256-GCM), `IdentityAnnouncement`.
- `peer-directory.ts` — propagazione delle chiavi di cifratura tra peer.
- `message-history.ts` — `MessageHistory`, cronologia locale 1:1 (mai firmata/propagata), bounded. Esporta `MAX_MESSAGE_TEXT_LENGTH`, il limite canonico riusato anche da `web-ui.ts`/`public-channels.ts`.
- `public-channels.ts` — `PublicChannels`, canali pubblici non cifrati sopra `content://` (convenzione nome `chat:<canale>`), bounded con eviction pesata sul **massimo** tra le fiducie degli autori visti nel canale.
- `drops.ts` — `Drops` (bacheca "drop" mesh-native, concetto ispirato a `BoardManager` di BitChat — Unlicense, vedi `docs/reuse-vs-new.md`). `DropKind = "info" | "hazard" | "emergency"`, mappato su `Priority`. Guadagna `receivedFrom?`/`observedAt` — un'"Observation" locale a un solo hop, distinta dal Packet deduplicato una volta per nodo.
- `bounded-map.ts` — `BoundedFifoMap<K,V>`, struttura condivisa con eviction opzionale pesata su uno score (es. la fiducia), usata da quasi tutte le strutture sopra alimentate dalla rete. Esporta anche `pushBounded()` (guardia esplicita contro un `maxLength` negativo).
- `groups.ts` — `Groups`, chat private/di gruppo E2E (membership fissa alla creazione, nessuna uscita/rimozione membro né rotazione chiave in v1 — scelta esplicita dell'utente). AES-256-GCM con la chiave di gruppo + firma Ed25519 del mittente (necessaria: una chiave condivisa rende l'auth tag GCM da solo insufficiente contro l'impersonificazione interna al gruppo). `GroupMessage.messageId` = la firma del mittente, per dedup per contenuto oltre a `SeenCache`.
- `location-registry.ts` — `LocationRegistry`, ultima posizione nota per mittente (mai accumula). Sovrascrive solo se il nuovo report ha un timestamp strettamente più recente (guardia anti-fuori-ordine), con clamp contro un timestamp futuro fabbricato. Scadenza pigra opzionale.
- `relay-registry.ts` — `RelayRegistry`, metadati statici (posizione, tipo, capacità radio) inseriti dall'operatore via endpoint autenticato + stato online/offline derivato da `peer:connected`/`peer:disconnected` (`peerConnectionCounts` per gestire più transport verso lo stesso peer). Nessuna scadenza pigra, nessun `trustRank` — la scrittura è già autenticata dalla password di rete. `batteryPercent?`/`lastTelemetryAt?` (telemetria auto-dichiarata) + `recordTelemetry()` — no-op se il relay non è già registrato (mai un canale di scrittura non autenticato), stesso guard anti-fuori-ordine di `LocationRegistry.record()`; `upsert()` porta sempre avanti i campi telemetria da `existing`, mai solo `online`/`lastSeenAt`.
- `emergency-beacon.ts` — `EmergencyBeacons`, sighting SOS ricevute. Deliberatamente senza scadenza pigra né `trustRank` (un'identità mai vista prima è il caso atteso, la difesa anti-flood vive a monte). Payload cifrabile con `NomadNodeOptions.emergencyBeaconKey` (AES-256-GCM pre-condivisa) — un relay senza chiave continua a inoltrare/cache-are i byte cifrati senza mai poterli leggere ("blind forwarding").
- `node-appends.ts` — `NodeAppends`, deposito locale a un solo nodo target via `NomadNode.appendToNode()`, mai ripropagato oltre. Gate di fiducia (`minTrustForNodeAppend`, default `VERIFIED`) prima di `record()` — FIFO puro, il gate fa il lavoro difensivo.
- `map-tiles.ts` — `MbtilesReader`, lettura in sola lettura di un file MBTiles (SQLite) via `node:sqlite` built-in.
- `priority-queue.ts` — coda a bucket per priorità (6 livelli), usata da `transports/tcp.ts` per lo scheduling reale.
- `qrcode.ts` — encoder QR (ISO/IEC 18004) scritto da zero, nessuna dipendenza esterna.
- `web-ui.ts` — interfaccia web locale di stato/ricerca (spec §59). Endpoint sempre pubblici: `/api/status`, `/api/peers`, `/api/services`, `/api/content`, `/api/search`, `/api/pairing`, `/api/channels`, `/api/drops`, `/api/node-appends`, `/api/map-info`+`/api/map-tiles/:z/:x/:y`. Endpoint dietro password di rete: `/api/call`, `/api/messages`, `/api/groups`+`/api/group-messages`, `/api/location-registry`+`/api/location-report`, `/api/relays`, `/api/relay-command` (comando di riavvio remoto), `/api/emergency-beacons` (solo lettura), `/api/node-append` (scrittura). Blocco captive-portal-probe sempre attivo (redirect `302`). Gate CORS/preflight **incondizionato** su ogni risposta.
- `loopback-http-server.ts` — bootstrap HTTP condiviso (`start()`/`stop()`/`sendJson()`/`sendBinary()`/`readRequestBody()`), riusato da `web-ui.ts`, `gateway/nomad/`, `nomad-hub/`.
- `node.ts` — `NomadNode`, l'orchestratore: handler dei pacchetti (`handleContentQuery`, `handleServiceRequest`, `handleGroupMessage`, ...) e metodi pubblici (`getContent`, `callService`, `publishContent`, `createGroup`, `sendGroupMessage`, `publishDrop`, `sendEmergencyBeacon`, `appendToNode`, `shareLocation`, `registerRelay`, `reportRelayTelemetry`, `sendRelayCommand`, ...). Convenzione ricorrente: ogni claim che condiziona un comportamento sensibile su un mittente usa sempre il `senderId` autenticato del pacchetto, mai un campo auto-dichiarato dentro il payload. `sendRelayCommand()`/`considerRelayCommand()` (comando di riavvio remoto per un relay) sono gated su `minTrustForRelayCommand` — default `TrustLevel.ADMIN`, il gate più severo del codebase, mai assegnato dal gossip ordinario — e protetti da replay con un `timestamp` per-mittente strettamente crescente (`SeenCache` da solo non basta, è bounded/evictable). Sull'accettazione, solo `emit("relay:reboot-requested")` — mai `process.exit()` dentro questa classe.
- `cli.ts` — entry point (`npm run dev -w node --`). Flag principali: `--register-as-location-registry`/`--expose-location-registry`, `--map-file`, `--expose-relay-registry`, `--expose-emergency-beacons`, `--register-as-relay-registry`, `--trust-admin`/`--allow-remote-reboot` (comando di riavvio remoto, due opt-in indipendenti — trust lato mittente accettato + azione lato processo ricevente), `--battery-percent`/`--report-relay-telemetry-interval-ms`.

`gateway/nomad/` (non nel workspace npm, importa `node/src/*` con percorsi relativi): `kiwix-gateway.ts` (`content://`/`service://kiwix-search`), `ai-gateway.ts` (`service://ai`), `news-gateway.ts` (`service://news`/`service://emergency-news`, ingerisce RSS/Atom reale via `rss-feed.ts`, genera un digest via `service://ai`), `translate-gateway.ts` (`service://translation`, compone `service://ai`), `internet-gateway.ts` (`service://internet-fetch`, due `kind` curati "rss"/"text", guardia SSRF in `url-safety.ts`), `flatnotes-gateway.ts` (`service://flatnotes-search`/`-create`, primo gateway che scrive verso NOMAD), più `fetch-bounded.ts`/`concurrency.ts` (utility condivise) e un fake server per ciascun backend esterno (`fake-nomad-server.ts`, `fake-ollama-server.ts`, `fake-flatnotes-server.ts`) usati da test/demo al posto di un'istanza reale. `cli.ts` è la demo eseguibile (`npm run gateway:demo`).

`nomad-hub/` (non nel workspace npm, non nemmeno `gateway/nomad/` — importa solo `loopback-http-server.ts`/`bounded-map.ts` da `node/src/`, mai `NomadNode`): `docker-client.ts` (`DockerClient`, client HTTP-su-Unix-Domain-Socket verso la Docker Engine API, nessuna dipendenza `dockerode`), `fake-docker-server.ts` (stand-in per test/demo), `capability-manager.ts` (`getHardwareProfile()` via `node:os`/`node:fs`, deliberatamente indipendente da Docker — `gpu`/`npu`/`bluetooth`/`usb3` sempre `null`, mai indovinati), `management-server.ts` (`ManagementServer`, password di gestione propria separata da quella di rete della mesh, mai esposta via HTTP), `cli.ts` (`npm run hub`, default Docker reale, `--fake-docker` opt-in per demo/test).

## Convenzioni consolidate (da rispettare per coerenza, non da riscoprire)

- **Ogni struttura dati alimentata dalla rete è limitata per dimensione** (spec §57): usa `BoundedFifoMap` con `maxSize`, e quando la fiducia dell'origine è nota passa `evictionScore`/`trustRank` così l'eviction preferisce rimuovere la voce meno fidata invece della più vecchia — altrimenti un peer può fabbricare identità usa-e-getta per sfrattare voci legittime (vedi bug #13 in `security.md`). Strutture puramente locali (mai alimentate da pacchetti di rete, es. `localServices` in `node.ts`) non hanno bisogno di questo limite.
- **Ogni claim che arriva dalla rete e verrà ri-propagato ad altri peer viene firmato dal suo autore** (Ed25519, stesso pattern in `content.ts`/`encryption.ts`/`service.ts`): un campo `SignableXFields`, una funzione `xSigningPayload()` con ordine esplicito dei campi, una `verifyX()` che riverifica contro la chiave pubblica dichiarata. Un relay non fidato può inoltrare ma mai fabbricare un claim valido per un'identità che non controlla.
- **Il payload di un pacchetto non è mai fidato quanto il suo tipo dichiarato**: `decodePacket()` valida solo l'involucro (id/type/source/ttl), mai la forma del payload — ogni handler deve accedere ai campi del payload in modo difensivo (`packet.payload?.campo`, controlli `typeof`/`Array.isArray`), perché un singolo pacchetto malformato da un peer connesso non deve mai poter far crashare il processo. Questo ha causato almeno un vero DoS non autenticato scoperto dalla revisione (voce #6, bug #16) — vedi `tests/integration/malformed-packet-robustness.test.ts` per il pattern di test dedicato, da estendere per ogni nuovo tipo di pacchetto.
- **Scadenza "pigra", mai un timer di sweep in background**: `ContentStore`/`RemoteCatalog`/`ServiceDirectory` trattano una voce scaduta come assente ed eliminano al momento dell'accesso (`get`/`has`/`list`/`size`), non con un `setInterval`.
- **`packet.source` non è mai autenticato crittograficamente** (limite noto e documentato in `security.md` sotto "Binding crittografico") — chiunque può dichiararsi qualunque node id nel campo `source`. Ciò che *non* può fare è produrre una firma valida per un'identità che non controlla. Ogni nuovo meccanismo che si affida a `packet.source` per decidere qualcosa di sensibile (es. quale risposta accettare per una richiesta pendente) deve comunque vincolarsi al mittente atteso (es. `packet.source === entry.activeProvider`), non fidarsi ciecamente — pattern già usato in `handleContentChunk`/`handleContentComplete`/`handleServiceResponse`.
- **Nessuna nuova dipendenza esterna senza necessità reale**: `web-ui.ts` usa `node:http` puro invece di aggiungere Express; `tcp.ts` non usa framework di parsing. Il solo devDependency oltre a TypeScript/vitest/tsx è quanto già presente.
- **Test**: unit in `tests/unit/` (logica pura, nessuna rete reale), integration in `tests/integration/` (istanze reali di `NomadNode`/`TcpTransport` su localhost, a volte con socket grezzi via `node:net` per controllo deterministico del timing quando serve simulare un comportamento avversariale/di rete inaffidabile — vedi `content-provider-retry.test.ts` per il pattern). Non usare mock per `NomadNode` stesso: la suite esistente preferisce nodi reali connessi via TCP reale su porta `0` (assegnata dal SO), anche nei test più intricati.
- **Race di timing nota e ricorrente nei test**: `connect()` che si risolve garantisce solo che il lato che ha iniziato la connessione abbia identificato il peer, non che l'altro lato abbia già processato l'HELLO in arrivo. Se un test fa qualcosa sul lato "server" subito dopo che `connect()` si risolve sul lato "client" (es. registrare un servizio e aspettarsi che venga floodato al peer appena connesso), potrebbe fallire in modo intermittente — aggiungere un `waitFor()` esplicito sullo stato effettivamente osservabile (es. `provider.node.peers.has(caller.node.nodeId)`) prima di procedere.

## Comandi utili

```bash
npm install                                    # alla radice, installa anche il workspace node/
npx vitest run                                 # intera suite di test
npx vitest run tests/integration/xyz.test.ts   # un file specifico
npx tsc --noEmit -p node/tsconfig.json         # typecheck senza emettere output
npm run build -w node                          # build del package node/
npm run dev -w node -- --id A --port 9001      # avvia un nodo (aggiungi --web-port 8080 per l'UI web)
npm run simulate -- --nodes 50 --topology random  # simulatore di rete a scala
npm run hub -- --port 8420                     # avvia la ARALD Hub Management API (aggiungi --fake-docker senza Docker reale)
```

## Cosa NON fare

- Non commitare/pushare senza che i test passino ripetutamente, il typecheck e la build siano puliti.
- Non saltare il passaggio di code-review su una voce "perché sembra semplice".
- Non procedere alla voce successiva senza l'ok esplicito dell'utente, anche se la precedente sembra ovviamente completa.
- Non introdurre dipendenze esterne per problemi risolvibili con la libreria standard di Node.
- Non fidarsi di `packet.source` o della forma del `payload` di un pacchetto in arrivo senza validazione difensiva.
- Non ri-raccontare in questo file una feature/voce completata — vive in `docs/security.md`/`docs/roadmap.md`/nel doc dedicato pertinente. Questo file si aggiorna solo per cambi strutturali: una nuova convenzione, un nuovo file chiave in `node/src/`, una nuova regola permanente.
