# Catalogo servizi e pacchetti per caso d'uso

Riferimento: [`docs/architecture.md`](./architecture.md) (i tre assi Connectivity/Compute/Services) e [`docs/deployment.md`](./deployment.md) (target hardware, pilot per scenario). Questo documento è la lettura complementare di entrambi: non un'architettura nuova, ma un inventario esplicito di *cosa* un nodo può offrire e una raccomandazione di *cosa* pre-caricare per contesto d'uso — nato da una discussione con l'utente il 9 settembre 2026.

## Come leggere questo documento

Due cose distinte, da non confondere:

1. **Il catalogo servizi** (sotto) — ogni cosa che un nodo *può* offrire alla mesh, oggi disponibile nel codice o pianificata.
2. **I pacchetti per caso d'uso** (in fondo) — una raccomandazione di *default* su cosa attivare/pre-caricare per un contesto tipico (alpino, emergenza, ONG, ecc.).

**Nessuno dei due è un vincolo tecnico.** Non esiste nel codice alcun meccanismo che "blocchi" un servizio fuori dal pacchetto scelto — ogni flag di `cli.ts`/`gateway/nomad/cli.ts` resta indipendente dagli altri, un operatore può attivarli in qualunque combinazione. I pacchetti sono un punto di partenza sensato per chi non vuole/deve decidere da zero, non un catalogo chiuso: un admin aggiunge, rimuove o mescola liberamente.

## Asse Compute: chi può ospitare cosa

Richiamo diretto da `docs/architecture.md` ("Un ARALD Card è quasi solo Connectivity. Un ARALD Box può essere Connectivity + Compute + Services sullo stesso dispositivo"):

| Tier hardware | Cosa può ospitare |
|---|---|
| **ARALD Card / Fixed Relay / Mobile Relay** (`docs/beacon.md`) | Nessun servizio applicativo — solo instradamento pacchetti (Connectivity pura). Partecipa comunque al protocollo mesh: può originare/relayare un SOS, comparire nel Registro relay con la propria telemetria. Nessun Docker, nessun NOMAD. |
| **Un `NomadNode` qualunque** (RPi nodo permanente, PC di sviluppo, smartphone) | Tutti i servizi **mesh-native** della prima tabella sotto — nessuno richiede Docker/Project NOMAD, sono tutti built-in in `node/src/`. |
| **ARALD Box / ARALD Portable** (`docs/deployment.md`, "due deployment target paritetici" — **stessa lista di servizi per entrambi**, la differenza è solo hardware/packaging, non capacità software) | Tutto quanto sopra **più** i servizi che richiedono Project NOMAD via Docker (seconda tabella sotto) — sono gli unici due target hardware di questo progetto pensati per far girare NOMAD. |

## Catalogo servizi

### Servizi mesh-native (`node/src/`, nessuna dipendenza da NOMAD/Docker)

| Servizio | Cos'è | Come si attiva |
|---|---|---|
| Contenuti statici (`content://`) | Testo o file binari arbitrari, firmati, distribuiti via `CONTENT_ANNOUNCE` — frammentati automaticamente per transport a MTU basso | sempre disponibile, `publishContent()` |
| Canali pubblici (`chat:<canale>`) | Chat di gruppo non cifrata, sopra `content://` | sempre disponibile |
| Gruppi cifrati | Chat privata multi-membro E2E (AES-256-GCM + firma Ed25519) | sempre disponibile, `createGroup()`/`sendGroupMessage()` |
| Messaggi privati 1:1 | Chat E2E (X25519 + AES-256-GCM) | sempre disponibile |
| Bacheca (Drops) | Segnalazioni geolocalizzate a tre livelli (`info`/`hazard`/`emergency`) | sempre disponibile, `publishDrop()` |
| SOS / Emergency Beacon | Richiesta di soccorso, priorità massima, opzionalmente cifrato con una chiave pre-condivisa Beacon↔Emergency Node | sempre disponibile, anche originato da una Card/telefono via Bluetooth |
| Registro posizione (`service://location-registry`) | Ultima posizione nota per mittente, mai accumulata | ruolo di **un solo nodo designato** per deployment — `--register-as-location-registry`/`--expose-location-registry` |
| Registro relay (`service://relay-registry`) | Stato/telemetria (batteria, online/offline) dei relay dispiegati, comando di riavvio remoto | ruolo di **un solo nodo designato** (tipicamente l'Emergency Node) — `--register-as-relay-registry`/`--expose-relay-registry` |
| Node append | Deposito diretto a un nodo specifico, E2E cifrato, mai ripropagato oltre | sempre disponibile (gate di fiducia, default `VERIFIED`) |
| Mappe offline | Tile MBTiles in sola lettura | `--map-file <percorso.mbtiles>` |
| Interfaccia web locale | Dashboard di stato/ricerca/pairing telefono (spec §59) | `--web-port` |

### Servizi via Project NOMAD (richiedono Docker + `gateway/nomad/`, solo su un host che fa girare NOMAD — quindi BOX/Portable)

| Servizio | Cos'è | Flag (`gateway/nomad/cli.ts`) |
|---|---|---|
| Kiwix (`content://`+`service://kiwix-search`) | Wikipedia/Wikivoyage/altri archivi offline (ZIM) | `--nomad-url` |
| AI locale (`service://ai`) | Domande/risposte via Ollama | `--ai-url` |
| News/digest (`service://news`/`service://emergency-news`) | Ingestione RSS/Atom reale + riassunto generato dall'AI | `--news-url` |
| Traduzione (`service://translation`) | Traduzione assistita, compone `service://ai` | (segue l'AI) |
| Internet fetch curato (`service://internet-fetch`) | Accesso Internet allowlisted (kind `rss`/`text`), guardia SSRF | `--internet-fetch` + `--internet-allowed-hosts` |
| Note collaborative (Flatnotes) (`service://flatnotes-search`/`-create`) | Note/documenti condivisi, scrivibili dalla mesh | `--flatnotes-url` |

### Generi di contenuto pubblicabili via `content://` (nessun meccanismo nuovo — solo convenzione)

Non sono servizi a sé: usano `content://` così com'è (già supporta file binari arbitrari con `mimeType`), zero rischio aggiuntivo di sicurezza/privacy — solo un'abitudine di cosa pubblicare:

- **Bollettini meteo** — già menzionato in `docs/deployment.md` come contenuto tipico del pilot alpino, mai formalizzato: chi ha accesso Internet pubblica l'ultimo bollettino, gli altri lo leggono offline.
- **Calendario/turni** — orari pasti di un rifugio, turni di un team ONG, orario lezioni di una scuola: un `content://` con uno schema semplice, aggiornato quando cambia.
- **Documentazione/manuali/protocolli** — già menzionato per il pilot ONG in `docs/deployment.md`, stesso meccanismo di qualunque contenuto statico.

### Candidati segnalati, non pianificati (richiedono progettazione, non solo documentazione)

Nessuna criticità di sicurezza evidente, ma uno schema dati/ruoli reale da decidere prima di scrivere codice — stesso limite già segnalato in `docs/deployment.md`:

- **Inventario/logistica** — tracciamento scorte/materiali per un deployment ONG/emergenza.
- **Richieste strutturate** — un ticket di soccorso/assistenza strutturato oltre al semplice SOS in testo libero.

### Consegna esterna differita (file store-and-forward verso l'esterno)

Costruito il 9 settembre 2026 (`docs/security.md` voce #70) — un operatore sul campo invia un file (es. un report) attraverso la mesh; il pacchetto arriva a un nodo che ha *anche* accesso Internet reale (tipicamente un BOX/Portable); quel nodo lo tiene in coda finché Internet non torna disponibile, poi lo consegna verso una destinazione esterna (server di un'organizzazione).

**Non è una ricombinazione di meccanismi esistenti, ma un pezzo nuovo** (`node/src/external-delivery.ts`): `content://` supporta già file binari ma è broadcast/pubblico; `node-appends.ts` è diretto a un solo nodo ed E2E cifrato ma si ferma lì (solo testo corto, nessuna nozione di "poi spingilo fuori dalla mesh"); `store-and-forward.ts` mette in coda finché il *prossimo hop mesh* non è raggiungibile, non finché torna *Internet*; `internet-gateway.ts`/`url-safety.ts` ha la disciplina giusta per un accesso esterno curato ma solo in ingresso (fetch) — qui riusata anche in uscita (consegna).

**Come funziona, in breve** (dettaglio tecnico completo in `docs/security.md` voce #70):

1. **E2E fino alla destinazione finale** — il BOX/Portable che tiene il file in coda non può mai leggerlo: cifratura X25519+AES-256-GCM con una coppia effimera generata ad-hoc per ogni invio (`sealExternalDelivery()`), non l'identità mesh a lungo periodo del mittente.
2. **Solo destinazioni in una allowlist privata configurata dall'operatore del BOX** (`--external-delivery-destinations <file.json>`) — mai una destinazione a scelta libera del mittente.
3. **L'operatore sceglie da un'etichetta amichevole** ("Headquarter"), mai un indirizzo tecnico: il BOX pubblica una directory pubblica via `content://` (`{destinationId, label, publicKeyHex, requiresPassword}`, mai l'URL reale né la password) che si propaga mesh-wide tramite la sincronizzazione dei cataloghi già esistente — un mittente non deve mai essere stato in contatto diretto col BOX.
4. **Destinazioni sensibili (es. un centro operativo di soccorso, l'HQ di una ONG) possono richiedere una password semplice condivisa per canale** — una prova (`authProof`, mai la password grezza) viaggia nel pacchetto mesh, calcolata al gateway del mittente; un invio senza prova valida viene scartato in silenzio dal BOX, mai accodato.
5. **Storage in attesa sul BOX**: `ExternalDeliveryQueue`, bounded su due assi (conteggio *e* byte totali — le entry variano molto in dimensione), eviction priority-weighted, TTL assoluto (default 100 entry / 50 MB / 24h, tarabile via flag CLI).
6. **Consegna best-effort, nessun ack** — un ciclo periodico (`--external-delivery-poll-interval-ms`) tenta una `POST` HTTP verso la destinazione quando Internet torna disponibile; un tentativo fallito lascia l'entry in coda per il turno successivo, fino al TTL.

**UI mobile**: pannello "Invia a un'organizzazione" (`mobile/www/`, vedi `mobile/README.md`) — tendina delle sole etichette note, campo password mostrato solo se richiesto, un file, un bottone "Invia". Deliberatamente minimale, non una passata di design.

## Pacchetti per caso d'uso

Ogni pacchetto elenca cosa attivare **di default** — non un tetto massimo. Ricalcano i pilot già descritti in `docs/deployment.md`, qui tradotti in "quali flag/contenuti accendere".

### Quotidiano / comunità locale

Corrisponde al pilot "Comunità locali" di `docs/deployment.md` (oggi senza deployment dedicato, stesso trattamento). Uso non emergenziale, connettività spesso presente.

- **Mesh-native**: canali pubblici, bacheca (solo `info`), messaggi/gruppi, interfaccia web locale.
- **NOMAD**: Kiwix (se disponibile un archivio locale), AI locale — opzionali, non essenziali.
- **Non incluso di default**: registro posizione/relay (non c'è un ruolo "Emergency Node" in questo contesto), emergency beacon esposto (nessuna urgenza strutturale).

### Alpino / rifugio

Pilot "rifugio alpino" di `docs/deployment.md`.

- **Mesh-native**: bacheca (tutti i livelli), canali pubblici, mappe offline (sentieri), interfaccia web locale, registro posizione (opt-in per chi condivide), emergency beacon.
- **NOMAD**: Kiwix (Wikipedia offline, manuali), AI locale, news (bollettini meteo/aggiornamenti).
- **Contenuti tipici**: mappa, sentieri, informazioni rifugio, numeri utili, bollettino meteo, documentazione di sicurezza.

### Emergenza

Pilot "emergenza" di `docs/deployment.md`.

- **Mesh-native**: emergency beacon (priorità massima, cifrato se una chiave pre-condivisa è disponibile), registro relay (Emergency Node designato), registro posizione, bacheca (`hazard`/`emergency` enfatizzati), node append per coordinamento diretto.
- **NOMAD**: AI locale (se disponibile un nodo con abbastanza risorse), Kiwix (procedure/manuali di emergenza già caricati).
- **Consegna esterna differita**: si applica bene anche qui (report verso un'autorità/coordinamento) — vedi sopra.

### ONG / missioni umanitarie

Pilot "ONG e missioni umanitarie" di `docs/deployment.md` — pari dignità con alpino ed emergenza.

- **Mesh-native**: bacheca, canali pubblici/gruppi cifrati (coordinamento tra team), mappe offline, node append.
- **NOMAD**: traduzione (comunicazione con la popolazione locale), Kiwix, AI locale.
- **Consegna esterna differita** — è esattamente lo scenario che ha motivato la feature: un operatore sul campo invia un report cifrato verso il server dell'organizzazione, il BOX/Portable alla base lo tiene finché Internet non torna disponibile.
- **Candidati segnalati ma non pianificati**: inventario/logistica, richieste strutturate (vedi sopra).

### Marittimo / spedizioni

Pilot "spedizioni / navi / ambienti remoti" di `docs/deployment.md` — stesso schema del pilot alpino, dimensionato per autosufficienza prolungata (settimane/mesi, nessun "ritorno di Internet" periodico).

- **Mesh-native**: bacheca, canali pubblici, mappe offline, registro posizione, emergency beacon.
- **NOMAD**: Kiwix, AI locale — **tutti i contenuti caricati una volta prima della partenza**, nessun modo di aggiungerne altri in corsa.
- **ARALD Portable** si adatta particolarmente bene qui (solo l'SSD da portare, avviato su un host di bordo già presente).

### Scuola

Pilot "scuole" di `docs/deployment.md` — scenario stabile, meno esigente sul lato rete (nessun bisogno di store-and-forward multi-hop esteso).

- **Mesh-native**: canali pubblici, contenuti statici, interfaccia web locale.
- **NOMAD**: Kiwix (Wikipedia offline, corsi), AI locale — enfasi sulla dimensione/stabilità nel tempo del catalogo, non sulla resilienza a partizioni.
- **Non incluso di default**: emergency beacon/registro posizione (nessun caso d'uso emergenziale strutturale in questo contesto).

### Eventi affollati

Pilot "eventi affollati" di `docs/deployment.md` — qui la mesh **moltiplica** la connettività esistente, non la sostituisce.

- **Mesh-native**: contenuti statici (programma, mappe del sito, FAQ), canali pubblici.
- **NOMAD**: nessuno strettamente necessario — il gateway ha già Internet reale, può fare da sorgente di sincronizzazione iniziale invece che da unica fonte offline.

### Altro / personalizzato

I sette pacchetti sopra non sono esaustivi — sono i contesti già documentati in `docs/deployment.md`. Un admin può partire da zero mescolando liberamente le voci del catalogo: nessun pacchetto è "chiuso", nessun servizio è vincolato a un solo pacchetto.

## Principio finale

Questo documento descrive **raccomandazioni**, non un meccanismo di provisioning automatico — non esiste (e non è pianificato) alcuno script che "installi il pacchetto X" da solo. Ogni servizio si attiva con il proprio flag CLI già esistente (`node/src/cli.ts`, `gateway/nomad/cli.ts`), ogni contenuto si pubblica con gli strumenti già esistenti (`publishContent()`, l'interfaccia web, ecc.). Il valore di questo documento è dare a chi prepara un deployment un punto di partenza sensato invece di dover riscoprire da zero "cosa serve per un rifugio" — mai un limite a cosa può fare.
