# Emergency Portal — architettura del portale web (proposta)

**Stato**: documentazione di riferimento/pianificazione per l'insieme della proposta, **più un primo pezzo concreto realizzato** (`arald-backend/`, 4 settembre 2026 — vedi "Primo pezzo realizzato" in fondo): uno script di sincronizzazione one-shot da un nodo ARALD verso un database Postgres reale su Neon. Il resto (frontend, autenticazione, multi-tenant, audit log) resta a livello di proposta, nessuna decisione presa.

## Nota terminologica: "ARALD" — risolta

La proposta che segue, ricevuta dall'utente il 4 settembre 2026, usava sistematicamente il nome **ARALD** (ARALD-Net, ARALD Box, ARALD Backend, Emergency Portal) per i componenti nuovi che descrive. Al momento in cui questa nota fu scritta la prima volta, il resto del repository usava ancora "Nomad-Net"/"NOMAD-NET BOX/PORTABLE"/"NOMAD Card" per gli stessi concetti — segnalato esplicitamente come una duplicazione di terminologia non ancora risolta, non una scelta.

**Risolto lo stesso giorno**, in una sessione parallela: l'intero progetto è stato rinominato in **ARALD** (due-diligence completa in `docs/due-diligence-naming-2026-09-04.md`) — per pura coincidenza, il nome con cui questa proposta era già arrivata è diventato il nome ufficiale del progetto. Nessuna incoerenza residua: "ARALD Box"/"ARALD Card" qui sotto sono ormai gli stessi nomi usati ovunque nel resto della documentazione, non più una terminologia locale a questo solo documento.

## La proposta, in sintesi

Un **Emergency Portal** web per enti/operatori (CNSAS, Protezione Civile, gestori di rifugio, amministratori), separato da un eventuale **Public Portal** puramente informativo, appoggiato su tre livelli distinti:

1. **Emergency Portal** (frontend) — dashboard con mappa dei Fixed Relay/ARALD Box, SOS/HAZARD ricevuti, messaggi, stato dei nodi, gestione utenti, audit log. Riservato dietro login, anche se il dominio che lo serve è pubblicamente raggiungibile ("publicly reachable ≠ publicly accessible").
2. **ARALD Backend** ("cervello Internet-side") — autenticazione/autorizzazione, database, registrazione nodi/organizzazioni, API, un eventuale bridge tra Internet e la mesh.
3. **ARALD Network** — la mesh esistente (Card → Mobile Relay → Fixed Relay → ARALD Box → Internet → Backend), che **deve continuare a funzionare senza che il backend sia raggiungibile**.

Stack ipotizzato: Next.js/React su Vercel per il frontend, un provider di autenticazione esterno (Auth0/Clerk/Supabase Auth/OIDC — mai autenticazione scritta da zero), PostgreSQL (es. Neon) per `users`/`organizations`/`nodes`/`messages`/`observations`/`events`/`audit_logs`, Redis opzionale per cache/codemessaggi temporanei. Modello di accesso multi-tenant per organizzazione (Super Admin ARALD → Admin ente → Operatore → Read-only), mai una singola password condivisa per ente, con audit log su ogni azione sensibile (chi ha inviato un messaggio, chi ha disabilitato un nodo, chi ha effettuato l'accesso). Il portale non deve mai parlare HTTP direttamente con ogni singolo Fixed Relay: il punto di ingresso verso la mesh è un solo componente, l'ARALD Box, che fa da gateway tra IP e la mesh — non gli enti web-facing sparsi.

Principio esplicito della proposta, coerente con la filosofia DTN già seguita in questo progetto: **Internet è un'opportunità di sincronizzazione per il portale, non una dipendenza della rete**. Se il backend/portale non è raggiungibile, SOS, store-and-forward, directed delivery e propagazione locale nella mesh devono continuare a funzionare comunque.

## Valutazione rispetto al codice esistente

La proposta è stata confrontata con quanto già implementato in questo repository, non solo accettata a scatola chiusa. Il principio cardine ("il backend non deve essere necessario perché Card → Relay → Relay → Fixed Relay continui a funzionare") è **già vero architetturalmente oggi**: nessun meccanismo mesh esistente (routing, store-and-forward, `Priority.EMERGENCY`, `Drops`, `EmergencyBeacons`, `NodeAppends`, `RelayRegistry`) dipende da un servizio Internet raggiungibile — è tutta logica peer-to-peer sulla mesh stessa, verificata su TCP locale/transport simulati. Il portale descritto qui sarebbe quindi un **consumatore** di quello stato, mai un prerequisito per farlo funzionare — coerente con la proposta, non in tensione con essa.

Molto di ciò che il portale vorrebbe mostrare **ha già un meccanismo mesh-side corrispondente**, spesso con un gap esplicitamente segnalato in documentazione precedente come "manca solo l'esposizione verso un portale esterno":

| Funzione richiesta dal portale | Meccanismo ARALD già esistente |
|---|---|
| Mappa dei Fixed Relay, stato online/offline, ultimo contatto | `node/src/relay-registry.ts` (`RelayRegistry`, voce #54) — metadati inseriti dall'operatore, stato derivato da `peer:connected`/`peer:disconnected`; già esposto su `mapview.js` come layer di pin **locale al nodo**. `docs/beacon.md` segnalava già esplicitamente questo gap: *"un registro... esposto tramite un portale/mappa ARALD a utenti autorizzati"* — quel "portale" è esattamente ciò che questa proposta descrive, non ancora costruito. |
| SOS ricevuti | `node/src/emergency-beacon.ts` (`EmergencyBeacons`, voce #56) — registro locale delle sighting, con `receivedFrom`/`observedAt` (voce #58) per sapere *quale* relay ha ricevuto un SOS e quando; oggi consultabile solo via `GET /api/emergency-beacons` su un singolo nodo (Emergency Node), non aggregato su più nodi/organizzazioni. |
| HAZARD/avvisi | `node/src/drops.ts` (`DropKind = "hazard"`, voce #57) — stesso schema, stesso limite: visibile solo nodo per nodo via `GET /api/drops`. |
| Messaggi diretti a un relay/nodo specifico ("Send → Destination → RIFUGIO-VALLE-01") | `packet.destination` + `PendingDeliveryQueue` (consegna DIRECTED, esisteva già) + `node/src/node-appends.ts` (`NodeAppends`, voce #59, "Node Append" — deposito locale sul nodo target con gate di fiducia `minTrustForNodeAppend`). Il meccanismo di trasporto/consegna è quindi già pronto; manca solo un client (il backend/portale) che lo invochi da Internet invece che da un altro nodo della mesh. |
| Stato dei nodi, ultimo contatto, batteria | `GET /api/status`/`GET /api/peers` (`node/src/web-ui.ts`) — già espone `relaying`/`canMessage`, ma per un singolo nodo alla volta, mai aggregato. |
| Osservazioni di rete (Observation) | `Drop.receivedFrom`/`observedAt` ed `EmergencyBeaconSighting.receivedFrom`/`observedAt` (voce #58) — la distinzione Packet-vs-Observation che il portale vorrebbe mostrare esiste già lato dati, non ancora lato esposizione aggregata. |

**Il pezzo che manca davvero, e che non ha alcun precedente diretto nel codice**: tutto ciò che serve a portare questi dati **da più nodi mesh distinti** verso un unico posto raggiungibile da Internet — cioè l'intero "ARALD Backend" della proposta (database multi-tenant, autenticazione, API aggregata, audit log) e la funzione di bridge dell'"ARALD Box" (sincronizzare gli endpoint locali sopra verso il backend quando la connettività è disponibile). Ogni endpoint `web-ui.ts` elencato in tabella è oggi **locale a un singolo nodo**, mai pensato per essere aggregato su più organizzazioni/rifugi — un vincolo di design esplicito finora (`WebUiServer` è "interfaccia web locale di stato/ricerca", spec §59, non un servizio multi-tenant).

## Da non confondere con `nomad-hub/` (ARALD Hub Management API)

Questo repository ha già un "backend web" con superficialmente lo stesso ruolo di "amministrare qualcosa da un browser": `nomad-hub/` (voce #52). **Sono due sistemi completamente diversi, per scelta di design già fatta**:

- `nomad-hub/`'s `ManagementServer` amministra **Docker sull'host che esegue Project NOMAD** (avvio/arresto/log dei container) — non ha alcuna nozione di mesh, SOS, relay, o messaggi. Non importa mai `NomadNode`.
- L'"ARALD Backend"/Emergency Portal qui descritto amministrerebbe invece **stato della mesh aggregato su più organizzazioni** — SOS, relay, messaggi diretti, mappe — mai Docker/infrastruttura dell'host.

Un eventuale "ARALD Box" (gateway Internet↔mesh) potrebbe in teoria eseguire entrambi (un `NomadNode` con gateway verso Internet, più magari un'istanza di `nomad-hub/` per amministrare i suoi stessi container Project NOMAD) — ma restano due superfici HTTP indipendenti con scopi diversi, stessa disciplina di separazione controllo/infrastruttura già applicata tra `web-ui.ts` e `hub-control.html`.

## Cosa sarebbe lavoro nuovo (se e quando si deciderà di procedere)

Nessuno di questi punti è deciso o pianificato in dettaglio — sono l'elenco di cosa mancherebbe, non un piano d'esecuzione:

- **Protocollo di sincronizzazione ARALD Box → Backend**: quali endpoint locali (`/api/relays`, `/api/emergency-beacons`, `/api/drops`, `/api/node-appends`, `/api/status`) l'ARALD Box interroga, con quale periodicità, e come autentica se stesso verso il backend (un'identità di gateway distinta dalla password di rete della mesh).
- **Schema del database multi-tenant** (`users`/`organizations`/`nodes`/`messages`/`observations`/`events`/`audit_logs`) e la logica di autorizzazione a più ruoli (Super Admin/Admin ente/Operatore/Read-only) — nessun precedente nel codice, che oggi non ha alcun concetto di "organizzazione" o utente autenticato con ruolo (la password di rete di `web-ui.ts` è un segreto condiviso, non un'identità utente).
- **Il frontend del portale stesso** (mappa aggregata, elenco SOS/HAZARD, invio di un messaggio diretto verso un nodo specifico da un form web).
- **Audit log** — nessuna struttura esistente lo copre; oggi il progetto logga solo lato processo (console), mai in modo persistente/consultabile.
- Una decisione su **dove vive l'identità crittografica dell'operatore** che invia un Node Append dal portale: oggi `minTrustForNodeAppend` (default `VERIFIED`) presuppone un `Identity` Ed25519 nota alla mesh — un utente del portale autenticato via OIDC non ne ha automaticamente una.

## Cosa NON è lavoro nuovo

Il principio "Internet è un'opportunità di sincronizzazione, non una dipendenza" non richiede alcun cambiamento al codice esistente per essere vero: è già la proprietà strutturale dell'intera mesh (nessun modulo in `node/src/` chiama fuori verso Internet per una funzione core — solo i gateway opzionali in `gateway/nomad/` lo fanno, e solo per servizi applicativi opzionali come `service://ai`/`service://internet-fetch`, mai per SOS/routing/store-and-forward). Se in futuro si costruirà l'ARALD Box/Backend, questo principio va rispettato *nel nuovo codice* (il bridge deve essere un consumatore opportunistico, mai un componente da cui la mesh dipende), non imposto retroattivamente su ciò che esiste già.

## Primo pezzo realizzato — script di sincronizzazione (4 settembre 2026)

Confermato con l'utente (due domande mirate prima di scrivere codice): (1) usare risorse cloud **reali**, non simulate come per ogni altro componente esterno di questo progetto finora — questo ambiente ha accesso reale a strumenti Neon/Vercel, diversamente dalle sessioni precedenti che lavoravano solo con server finti; (2) ambito del primo pezzo ristretto a uno **script one-shot**, non un servizio persistente.

**Provisioning reale eseguito**: un progetto Neon (`arald-emergency-portal`, id `gentle-frost-70962179`, database `arald_portal`) con cinque tabelle — `relays`/`emergency_beacons`/`drops`/`node_appends` (chiave primaria = l'id naturale che il nodo già usa per quell'entità — `relayId`/`beaconContentId`/`dropId`/`appendId`, mai un id nuovo coniato qui, colonna `data jsonb` per il record completo, upsert idempotente) e `node_status_snapshots` (append-only, uno snapshot non ha un'identità naturale su cui fare upsert). Schema deliberatamente minimo — non lo schema `users`/`organizations`/`audit_logs` della proposta completa, solo quanto basta per provare che "un nodo → uno script → un database" funziona.

**Codice**: `arald-backend/` (nuova directory, non nel workspace npm — stesso trattamento di `gateway/nomad/`/`nomad-hub/`, ma a differenza di entrambe importa **zero** moduli da `node/src/`: parla solo l'HTTP pubblico di `WebUiServer`, esattamente il vincolo che un vero ARALD Box futuro avrebbe comunque, girando su una macchina diversa dal nodo che legge).

- `node-client.ts` — `fetchNodeSnapshot()`, legge `/api/status`/`/api/drops`/`/api/node-appends` (sempre pubblici) e, se viene passata la network password, anche `/api/relays`/`/api/emergency-beacons` (dietro password sul nodo). Ogni campo di ogni risposta è validato difensivamente prima dell'uso (stessa disciplina di questo repository per qualunque dato che attraversa un confine di fiducia) — una entry malformata viene scartata, mai propagata a una query SQL. Un endpoint mancante/non esposto (`404`) o senza password/con password sbagliata (`401`) produce un motivo distinto in `skipped[]`, mai un crash: stessa filosofia "degrada, non crashare" già applicata alla UI mobile capability-gated.
- `postgres-sync.ts` — `syncSnapshotToPostgres()`, upsert parametrizzato (mai concatenazione di stringhe SQL) per ciascuna tabella; accetta un'interfaccia `SyncClient` minima (`query(text, params)`) invece di importare i tipi di `pg` direttamente, così un test può passargli un client finto che registra le chiamate senza toccare un database reale.
- `sync.ts` — entry CLI (`npm run portal:sync -- --node-url ... --database-url ... [--network-password ...]`, oppure `$DATABASE_URL`/`$ARALD_NETWORK_PASSWORD`). Nessun default per `DATABASE_URL`, mai loggata — stessa disciplina di `--management-password`/`--network-password` altrove nel repository.
- Prima dipendenza esterna reale di questo pezzo: `pg` (client Postgres) — non c'è modo ragionevole di parlare il protocollo wire di Postgres con la sola libreria standard di Node, stessa eccezione già concessa a `@capacitor/geolocation` per l'hardware GPS.

**Verificato**: 8 test nuovi (`tests/unit/arald-backend-postgres-sync.test.ts`, `tests/integration/arald-backend-sync.test.ts`) — questi ultimi contro un `NomadNode`/`WebUiServer` reali su loopback (relay registrato, un SOS reale via `sendEmergencyBeacon()`, un drop, un node append), con un client Postgres finto per il lato database — stesso principio già in uso in questo repository di non dipendere da un servizio esterno reale nella suite automatica (vedi `FakeDockerServer`/`FakeFlatnotesServer` ecc.). 813 → 821 test totali, tutti verdi, ripetuto due volte.

**Limite reale scoperto e documentato, non aggirato**: l'ambiente di sviluppo di questa sessione ha una policy di rete in uscita che **blocca la connessione diretta a Neon** dal proprio sandbox — sia la connessione Postgres nativa (`pg`, TCP) sia una richiesta HTTPS diretta all'host Neon ricevono un rifiuto esplicito della policy (`403` dal proxy di rete, non un timeout ambiguo). Gli strumenti MCP di Neon usati per il provisioning **non** passano da questa stessa restrizione (girano lato server), quindi la creazione del progetto/schema è comunque reale e verificata. Il percorso live "script → Postgres" non è quindi eseguibile *da questa sessione*, ma è stato validato ugualmente: le stesse identiche istruzioni SQL parametrizzate che `postgres-sync.ts` genera sono state eseguite manualmente contro il database reale via lo strumento Neon (inserimento di un relay/drop/status snapshot reali generati dal nodo di test, poi una seconda scrittura sullo stesso `relay_id` per confermare che l'upsert aggiorna la riga invece di duplicarla — verificato con una query di conteggio). In un ambiente normale (una macchina di sviluppo, un vero ARALD Box, una funzione Vercel Node.js) lo script funzionerebbe senza questa restrizione, che è una policy di questo solo sandbox, non un limite del codice.

Repository Neon dedicati **non ripuliti** deliberatamente: `RELAY-MANUAL-1`/`DROP-MANUAL-1` e uno snapshot di stato restano nel database come prova verificabile del funzionamento — cancellarli è un'operazione distruttiva che questa sessione non esegue senza una richiesta esplicita dell'utente.

## Prossimo passo

Con questo primo pezzo fatto, i pezzi successivi restano tutti da pianificare esplicitamente con l'utente uno alla volta, nessuno deciso qui: rendere lo script un piccolo servizio con polling invece di one-shot; iniziare lo schema multi-tenant (`users`/`organizations`/`audit_logs`); un frontend read-only minimo (mappa + elenco SOS) sopra i dati già sincronizzati; l'autenticazione degli operatori. Nessuno di questi ha una decisione presa — stesso trattamento di ogni altra proposta in questo file finora.
