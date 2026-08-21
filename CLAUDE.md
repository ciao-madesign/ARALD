# Nomad-Net — contesto per Claude Code

Questo file viene letto automaticamente a ogni nuova sessione in questo repository. Obiettivo: far ripartire un nuovo sviluppatore (umano o Claude) senza dover rileggere l'intera cronologia della chat.

## Cos'è questo progetto

Nomad-Net è un prototipo software di rete distribuita, **content-centric** e **delay-tolerant**: dispositivi condividono contenuti, servizi e messaggi senza infrastruttura Internet, tramite mesh locali, store-and-forward, caching opportunistico e sincronizzazione automatica al ritorno della connettività. Ispirato concettualmente a BitChat (mesh BLE) e pensato per integrarsi con Project NOMAD come "service provider" locale (Kiwix, Ollama, ecc.), ma senza dipendere da nessuno dei due.

**Specifica completa e single source of truth**: [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) (in italiano, numerata per paragrafi §N — tutti i riferimenti nel codice e nei commenti usano questa numerazione). Se qualcosa nel codice sembra contraddire questo file, la specifica vince; se manca un dettaglio, cercalo lì prima di indovinare.

**Repository GitHub**: `ciao-madesign/nomad-net`. **Branch di lavoro**: `claude/nomad-net-project-spec-lcnbqt`.

## Regola permanente: push su main

**Istruzione permanente data dall'utente in questa sessione: ogni commit va pushato sia sul branch di lavoro sia direttamente su `main`.** Non è implicita nel workflow standard di Claude Code (che normalmente lavora solo sul branch dedicato) — è stata data esplicitamente e va rispettata per ogni futuro commit, non solo per quelli già fatti. Verifica sempre che `main` sia allo stesso commit del branch di lavoro prima di pushare (fast-forward), altrimenti chiedi come procedere invece di forzare.

## Stato del progetto

Milestone 0-7, 12, 13, 15, 16, 20 della roadmap sono complete (identità crittografica, protocollo a pacchetti, transport TCP, routing multi-hop con controlled flooding + distance-vector a costo, content discovery/cache, store-and-forward, partition sync, firma dei contenuti, trust levels, rate limiting, E2E encryption, relay policy legata a batteria, simulatore di rete). Dettaglio completo in [`docs/roadmap.md`](docs/roadmap.md).

Dopo il completamento delle milestone sopra è stato eseguito un **audit tecnico completo** (test, sicurezza, qualità del codice — vedi [`docs/audit-report.html`](docs/audit-report.html), un Artifact pubblicato e aggiornabile) che ha identificato ulteriori miglioramenti realizzabili in puro software. Sono stati realizzati come una sequenza di **9 slice pianificate, più una decima aggiunta successivamente su richiesta esplicita dell'utente**, ciascuna con lo stesso workflow a "doppio check" (vedi sotto), tracciate in `docs/security.md` sotto "Bug corretti nel seguito dell'audit":

| # | Slice | Stato |
|---|---|---|
| 1 | Retry al prossimo content provider quando quello attivo tace | ✅ Fatto |
| 2 | `BoundedFifoMap` condivisa (rimossa duplicazione 5x) | ✅ Fatto |
| 3 | Eviction pesata sulla fiducia per `PeerDirectory`/`RemoteCatalog` | ✅ Fatto |
| 4 | Scheduling reale basato su priorità in `TcpTransport` | ✅ Fatto |
| 5 | Pacchetto `CONTENT_NOT_FOUND` + scadenza dei contenuti | ✅ Fatto |
| 6 | Protocollo di service discovery (`SERVICE_*`) | ✅ Fatto |
| 7 | Interfaccia web locale di stato/ricerca (spec §59) | ✅ Fatto |
| 8 | Transport BLE simulato | ✅ Fatto |
| 9 | Gateway NOMAD mockato (contro un fake server locale) | ✅ Fatto |
| 10 | Gateway AI mockato (`service://ai`, spec §37 — contro un fake Ollama locale) | ✅ Fatto |

**Le 9 slice pianificate sono tutte completate, più la decima.** Ogni slice è documentata in dettaglio in `docs/security.md` (numerate progressivamente, bug #11-20) e spesso anche in `docs/protocol.md`. **Leggi quelle voci prima di toccare il codice corrispondente** — spiegano non solo cosa è stato fatto ma perché, inclusi i bug trovati dalla revisione e corretti prima di considerare ogni slice conclusa.

Dopo la chiusura delle 10 slice, il lavoro è proseguito con una serie di follow-up sempre su richiesta esplicita dell'utente, stesso workflow a doppio check, tutti documentati in `docs/security.md` con voci numerate progressive (#21-28): interfaccia web ampliata (#21), endpoint di scrittura `POST /api/call` (#22), app mobile Fase 1 (#23), pairing in stile Wi-Fi (#24), pairing via QR code (#25), una passata libera di qualità/sicurezza su `node/src/` che ha corretto un DoS non autenticato reale (#26), `service://news` (`NewsGateway`) + una dashboard mobile in stile "motore di ricerca" (#27), e una passata di design completa sulla UI mobile (#28, icone SVG coerenti, gerarchia visiva, transizioni, skeleton, feedback tattile, layout tablet, accessibilità). **Leggi la voce corrispondente in `docs/security.md` prima di toccare il codice relativo** — stessa raccomandazione di sopra, vale per tutte le voci, non solo le prime 10.

Lo stato ad oggi (21 agosto 2026): non ci sono candidati aperti realizzabili in puro software rimasti "in sospeso a metà" — ogni pezzo iniziato è stato portato a termine col workflow completo. Il primo dei tre punti aperti (debito di design della UI mobile) è stato affrontato nella voce #28. Restano invece, esplicitamente documentati come lavoro futuro non ancora iniziato: (1) una **valutazione** (non implementazione) di una proposta dell'utente per evolvere `service://news` verso un vero servizio di notizie offline-first (RSS reale, priorità di emergenza, digest AI) — dettaglio completo in `docs/next-steps.md` Opzione I; (2) `ContentStore` (`node/src/content.ts`) senza limite di dimensione pur essendo alimentato dalla rete, candidato isolato dalla revisione della voce #27 ma non corretto lì per portata troppo ampia. Le uniche milestone ancora aperte nella loro forma *reale* (8/9/10/11/14/17/18/19, vedi `docs/roadmap.md`) restano bloccate su prerequisiti esterni (hardware fisico, Docker + Project NOMAD raggiungibile, accesso a internet reale) non disponibili in questo ambiente.

## Priorità per chi riprende questo lavoro (handoff)

Due punti aperti, in ordine di quanto sono già stati isolati/pronti per essere ripresi (il terzo, il debito di design della UI mobile, è stato affrontato nella voce #28 di `docs/security.md`):

1. **Proposta "Nomad News evoluto"**: l'utente ha proposto una specifica dettagliata (Wikinews via Kiwix, ingestor RSS, priorità di emergenza P0-P4, digest AI, livelli headline/summary/articolo) per evolvere `service://news`. Valutata in dettaglio, non implementata — vedi `docs/next-steps.md` Opzione I per cosa è già coperto dall'architettura esistente, cosa è realizzabile in puro software, e il pezzo di lavoro architetturale genuinamente nuovo che servirebbe (un meccanismo di priorità/broadcast per singolo contenuto, oggi assente — la priorità è fissa per tipo di pacchetto).
2. **`ContentStore` senza limite di dimensione**: `node/src/content.ts`, alimentato dalla rete via `putVerified()` ma senza `BoundedFifoMap`, a differenza di ogni altra struttura dati di rete nel progetto. Non corretto nella voce #27 per portata troppo ampia (struttura centrale, usata sia dal percorso locale sia da quello di rete) — merita una propria slice dedicata.

Nessuno dei tre è urgente/bloccante — sono scelte aperte per la prossima sessione, non bug che rompono qualcosa oggi.

## Workflow da riusare per lavoro futuro (slice, feature, o passate di qualità)

Il workflow concordato con l'utente, usato per ognuna delle 10 slice sopra e da riapplicare identico a qualunque lavoro sostanziale futuro in questo repository:

1. Implementa la feature.
2. Scrivi/aggiorna i test (unit + integration, seguendo le convenzioni esistenti — vedi sotto).
3. Fai girare l'intera suite più volte di fila (`npx vitest run`, ripetuto 3-15x a seconda della sensibilità a timing/race) per scovare flakiness prima che la trovi la revisione.
4. Invoca la skill `code-review` con un prompt dettagliato che spiega cosa è cambiato e dove concentrare l'attenzione — non un generico "rivedi questo diff".
5. Correggi i problemi reali trovati (non solo quelli comodi), aggiungi test di regressione dedicati per ciascuno, ri-verifica.
6. Aggiorna `docs/security.md` (nuova voce numerata) e `docs/protocol.md`/altri doc pertinenti.
7. `npx tsc --noEmit -p node/tsconfig.json` e `npm run build -w node` puliti.
8. Commit con messaggio dettagliato (cosa, perché, cosa ha trovato la revisione), push su **sia** `claude/nomad-net-project-spec-lcnbqt` **sia** `main`.
9. Report all'utente in italiano, **poi fermati e aspetta un "ok" esplicito prima di iniziare il prossimo pezzo di lavoro** — istruzione esplicita data dall'utente all'inizio dell'arco di 9 slice ("Dopo ogni step aggiornami e chiedimi ok per proseguire"), non legata alla singola serie di slice ormai conclusa: vale per qualunque lavoro sostanziale futuro allo stesso modo.

Non saltare il passaggio di code-review nemmeno quando il codice "sembra ovviamente corretto": in ogni slice fatta finora ha trovato almeno un problema reale (spesso più di uno) prima di considerare la slice conclusa — inclusi almeno due crash-DoS reali (accesso non protetto a un campo di payload potenzialmente assente) e diverse race condition/edge case di conteggio.

## Struttura del repository

```
nomad-net/
├─ docs/            specifica (SPECIFICATION.md) e documentazione tecnica
├─ node/src/        nomad-node: il runtime di rete (unico package con codice reale)
├─ tests/           unit/, integration/, network/ (vitest)
├─ tools/simulator/ simulatore di rete a scala (usato anche da `npm run simulate`)
├─ gateway/nomad/   gateway NOMAD (Slice 9-10 + voce #27): KiwixGateway, AiGateway, NewsGateway, fake server, cli.ts — mockato, non nel workspace npm
├─ mobile/          client mobile Capacitor verso un gateway (Opzione H Fase 1) — vedi mobile/README.md; mobile/ios/ ancora solo segnaposto
└─ protocol/        segnaposto definizioni di protocollo condivise — non contiene codice reale
```

Tutto il codice reale vive sotto `node/src/`. `gateway/nomad/` e `mobile/` (Android) hanno codice reale ma non sono nel workspace npm della radice (progetti separati con proprio `package.json`, come sopra). `protocol/` e `mobile/ios/` restano placeholder dalla specifica, non toccarli aspettandosi codice.

### App mobile (`mobile/`, Opzione H Fase 1)

Client Capacitor (JS/TS vanilla, no framework) verso un `WebUiServer` esistente via HTTP: setup/pairing poi dashboard (vicini/servizi/contenuti, chiamata servizi). Verificato end-to-end con un browser reale (Playwright) contro un `NomadNode` vero — non su un telefono fisico o un emulatore, entrambi non disponibili in questo ambiente. La build Android nativa (`mobile/android/`, generata da `npx cap add android`) **non compila in questa sessione**: richiede l'Android Gradle Plugin da `dl.google.com`, bloccato dalla policy di rete (403 dal proxy, verificato — non un problema di codice, non ritentare). Revisione dedicata con 6 problemi reali trovati e corretti (incluso un bug bloccante mai osservabile in un browser desktop: Android blocca di default il traffico HTTP non cifrato, corretto con un `network_security_config.xml`) — vedi `docs/security.md` voce #23 e `mobile/README.md` per il dettaglio completo.

Su richiesta esplicita dell'utente, il pairing è stato poi rifatto per sembrare una rete Wi-Fi invece di "indirizzo + token": "nome rete" (SSID-like) + "password" breve e digitabile (`generateNetworkPassword()`), indirizzo del gateway inserito una tantum e mai più mostrato in UI, credenziali esposte anche sulla pagina web del gateway (`GET /api/pairing`, deliberatamente non autenticato) oltre che in console. Stesso workflow a doppio check, 4 problemi reali trovati e corretti dalla revisione (incluso un bias reale nell'alfabeto della password, 31 simboli invece dei 32 dichiarati) — vedi `docs/security.md` voce #24.

Sempre su richiesta esplicita dell'utente ("implementa anche opzione con QR code"), aggiunta un'opzione di pairing via QR: `node/src/qrcode.ts` è un encoder QR (ISO/IEC 18004) scritto da zero — nessuna libreria QR nel progetto, coerente con la convenzione "niente dipendenze esterne non necessarie" — verificato durante lo sviluppo e la revisione contro un decoder indipendente (`jsQR`, solo in una directory di scratch, mai come dipendenza) su 100+ round-trip, trovando e correggendo 2 bug reali nel posizionamento di format/version-info (mai nella logica dati/Reed-Solomon). La dashboard del gateway mostra ora un QR accanto a nome-rete/password (`GET /api/pairing` esteso con `qrDataUri`, nuovo `WebUiOptions.publicHost` con auto-rilevamento LAN via `node:os.networkInterfaces()`); l'app mobile ha un bottone "Scansiona QR" dietro feature-detection di `BarcodeDetector` (nativo del browser, Chrome/Android WebView — non verificabile end-to-end in questa sessione, che gira su un Chromium headless senza quell'API). Stesso workflow a doppio check, 2 problemi reali trovati e corretti dalla revisione (una race di cancellazione durante `getUserMedia()` in sospeso che poteva lasciare la fotocamera accesa dopo "Annulla"; un campo estratto ma mai usato) — vedi `docs/security.md` voce #25.

Su richiesta esplicita dell'utente ("passata di qualità/sicurezza sul codice esistente", non seguito di una feature specifica), eseguita una revisione libera (`code-review --level xhigh`, senza un diff da rivedere) sull'intero `node/src/`. Ha trovato 3 problemi reali, tutti corretti: **un DoS non autenticato reale** — ogni handler `CONTENT_*` in `node.ts` accedeva a `packet.payload` senza alcuna guardia (a differenza di ogni altro handler), un singolo pacchetto malformato da un peer connesso bastava a crashare il processo, riprodotto empiricamente prima del fix; lo stesso bug nel case `PEER_LIST`; e `RoutingTable` senza eviction pesata sulla fiducia (a differenza di `PeerDirectory`/`RemoteCatalog`, Slice 3), corretta con un nuovo `RoutingTableOptions.trustRank` più un tetto `MAX_ROUTES_PER_ANNOUNCE` sulle entry di un singolo pacchetto. Stesso workflow a doppio check (inclusa una seconda revisione sul fix stesso, che ha trovato l'aggiornamento mancante di questo file/docs/security.md prima che venisse fatto) — vedi `docs/security.md` voce #26.

Su richiesta esplicita dell'utente ("un interfaccia che mostri i servizi disponibili come fosse un motore di ricerca, stile Google, con collegamenti rapidi ai servizi principali [...] esiste un servizio per le news?"), aggiunti `service://news` (`gateway/nomad/news-gateway.ts`, `NewsGateway` — terzo sotto-servizio NOMAD accanto a Kiwix/Ollama, senza fake server per scelta esplicita dell'utente, e non verificabile contro un backend reale in questa sandbox: confermato che l'accesso a internet reale è bloccato dalla policy di rete) e una dashboard mobile ristrutturata in stile "motore di ricerca" (wordmark + barra di ricerca + collegamenti rapidi ai servizi disponibili, `mobile/www/`). Stesso workflow a doppio check, 5 problemi reali trovati e corretti dalla revisione (il più serio: `publishedById` era una `Map` semplice illimitata, corretta con `BoundedFifoMap` — `ContentStore` stesso ha lo stesso limite ma non è stato toccato in questa slice, portata troppo ampia, resta candidato aperto in `docs/next-steps.md`) — vedi `docs/security.md` voce #27.

### File chiave in `node/src/` e a cosa servono

- `identity.ts` — identità Ed25519 per nodo (`Identity`), firma/verifica.
- `packet.ts` — `MessageType` enum, formato pacchetto, `Priority` enum (spec §50), encode/decode newline-JSON.
- `transport.ts` — interfaccia `Transport` astratta; `transports/tcp.ts` è l'unica implementazione reale finora; `transports/ble.ts` (Slice 8) ne è una simulata, zero radio reale, dietro la stessa interfaccia.
- `routing.ts` — `SeenCache` (dedup) + `decideForward()`, il cuore del controlled flooding (spec §21).
- `routing-table.ts` — routing a costo distance-vector (spec §22), alternativa/complemento al flooding per traffico unicast.
- `content.ts` — `ContentStore`, firma/verifica dei contenuti, `ChunkAssembler`, scadenza (`expiresAt`).
- `catalog.ts` — `RemoteCatalog`, contenuto noto ma non ancora scaricato (sync tra segmenti di rete).
- `service.ts` / `service-directory.ts` — service discovery (spec §35-37), stesso schema di firma di `content.ts`.
- `store-and-forward.ts` — coda per pacchetti unicast non consegnabili subito.
- `trust.ts` — `TrustLevel`/`TrustManager` (spec §54).
- `rate-limit.ts` — budget di pacchetti per peer per finestra temporale.
- `relay-policy.ts` — quando un nodo fa da relay in base a batteria/carica auto-dichiarata.
- `encryption.ts` — E2E per messaggi privati (X25519 + AES-256-GCM), `IdentityAnnouncement`.
- `peer-directory.ts` — propagazione delle chiavi di cifratura tra peer.
- `bounded-map.ts` — `BoundedFifoMap<K,V>`, struttura dati limitata condivisa (con eviction opzionale pesata su uno score, es. la fiducia) usata da quasi tutte le strutture sopra che vengono alimentate dalla rete.
- `priority-queue.ts` — coda a bucket per priorità (6 livelli), usata da `transports/tcp.ts` per lo scheduling reale degli invii.
- `qrcode.ts` — encoder QR (ISO/IEC 18004) scritto da zero, nessuna dipendenza esterna: solo byte mode, versioni 1-10, EC level M con fallback a L. `encodeQr(text)` (`QrCode | undefined`) + `qrToSvg(qr, opts)`. Usato da `web-ui.ts` per `GET /api/pairing`'s `qrDataUri`. Verificato durante lo sviluppo contro un decoder indipendente (`jsQR`, solo in scratch, mai una dipendenza) — vedi `docs/security.md` voce #25 per i 2 bug reali trovati così (posizionamento format/version-info, non logica dati).
- `web-ui.ts` — interfaccia web locale di stato/ricerca (spec §59), server `node:http` minimale. Endpoint di sola lettura: `/api/status` (include `relaying`, da `NomadNode.canRelayNow()`), `/api/peers`, `/api/services`, `/api/content` (tutto il conosciuto), `/api/search?q=...` (filtrato), `/api/pairing` (nome rete/password/indirizzo/QR di pairing, non autenticato). Più `POST /api/call` (unico endpoint di scrittura, disattivato di default, dietro password di rete — base server-side per l'app mobile, `docs/next-steps.md` Opzione H, vedi `docs/security.md` voci #22/#24/#25).
- `loopback-http-server.ts` — bootstrap HTTP condiviso (`start()`/`stop()`/`port` getter, `sendJson()`, `readRequestBody()`/`BodyTooLargeError` con timeout opzionale) estratto da `web-ui.ts` e `gateway/nomad/fake-nomad-server.ts` (Slice 9), poi riusato anche da `gateway/nomad/fake-ollama-server.ts` (Slice 10) e di nuovo da `web-ui.ts`'s `/api/call` (Opzione H) man mano che ciascun pezzo di boilerplate HTTP è comparso una volta di troppo.
- `node.ts` — `NomadNode`, la classe che orchestra tutto il resto; qui vivono i pacchetti-handler (`handleContentQuery`, `handleServiceRequest`, ecc.) e i metodi pubblici (`getContent`, `callService`, `publishContent`, ...).
- `cli.ts` — entry point eseguibile (`npm run dev -w node --`).

`gateway/nomad/` (Slice 9-10 + voce #27, non nel workspace npm — importa `node/src/*` con percorsi relativi, stesso precedente di `tools/simulator/`): `kiwix-gateway.ts` (`KiwixGateway`, traduce `content://...`/`service://kiwix-search` verso l'HTTP di NOMAD), `fake-nomad-server.ts` (`FakeNomadServer`, sostituisce Project NOMAD/Docker reale nei test/demo), `ai-gateway.ts` (`AiGateway`, registra `service://ai` — spec §37, proxy live a un backend Ollama), `fake-ollama-server.ts` (`FakeOllamaServer`, sostituisce un'istanza Ollama reale nei test/demo), `news-gateway.ts` (`NewsGateway`, registra `service://news` rispondendo sempre dalla cache, mai da una chiamata live — pubblica anche ogni notizia come contenuto via `publishContent()`; nessun fake server per scelta esplicita dell'utente, `docs/security.md` voce #27), `cli.ts` (demo eseguibile, `npm run gateway:demo`, registra `service://news` solo se `--news-url` è dato).

## Convenzioni consolidate (da rispettare per coerenza, non da riscoprire)

- **Ogni struttura dati alimentata dalla rete è limitata per dimensione** (spec §57): usa `BoundedFifoMap` con `maxSize`, e quando la fiducia dell'origine è nota passa `evictionScore`/`trustRank` così l'eviction preferisce rimuovere la voce meno fidata invece della più vecchia — altrimenti un peer può fabbricare identità usa-e-getta per sfrattare voci legittime (vedi bug #13 in `security.md`). Strutture puramente locali (mai alimentate da pacchetti di rete, es. `localServices` in `node.ts`) non hanno bisogno di questo limite.
- **Ogni claim che arriva dalla rete e verrà ri-propagato ad altri peer viene firmato dal suo autore** (Ed25519, stesso pattern in `content.ts`/`encryption.ts`/`service.ts`): un campo `SignableXFields`, una funzione `xSigningPayload()` con ordine esplicito dei campi, una `verifyX()` che riverifica contro la chiave pubblica dichiarata. Un relay non fidato può inoltrare ma mai fabbricare un claim valido per un'identità che non controlla.
- **Il payload di un pacchetto non è mai fidato quanto il suo tipo dichiarato**: `decodePacket()` valida solo l'involucro (id/type/source/ttl), mai la forma del payload — ogni handler deve accedere ai campi del payload in modo difensivo (`packet.payload?.campo`, controlli `typeof`/`Array.isArray`), perché un singolo pacchetto malformato da un peer connesso non deve mai poter far crashare il processo. Questo ha causato almeno un vero DoS non autenticato scoperto dalla revisione (Slice 6, bug #16) — vedi `tests/integration/malformed-packet-robustness.test.ts` per il pattern di test dedicato, da estendere per ogni nuovo tipo di pacchetto.
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
```

## Cosa NON fare

- Non commitare/pushare senza che i test passino ripetutamente, il typecheck e la build siano puliti.
- Non saltare la fase di code-review su una slice "perché sembra semplice".
- Non procedere alla slice successiva senza l'ok esplicito dell'utente, anche se la precedente sembra ovviamente completa.
- Non introdurre dipendenze esterne per problemi risolvibili con la libreria standard di Node.
- Non fidarsi di `packet.source` o della forma del `payload` di un pacchetto in arrivo senza validazione difensiva.
