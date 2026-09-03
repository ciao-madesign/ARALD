# NOMAD-NET BEACON — ecosistema di richiesta di soccorso a bassissimo consumo

**Stato**: documentazione di riferimento/pianificazione, v0.1 — **nessun codice scritto**. Proposta ricevuta dall'utente il 3 settembre 2026, analizzata e discussa prima di essere integrata qui. Stesso trattamento già riservato a **NOMAD-NET BOX e PORTABLE** (`docs/deployment.md`): un terzo ramo/espansione del progetto, non parte della specifica originale (`docs/SPECIFICATION.md`) né della roadmap (`docs/roadmap.md`), che descrive dispositivi fisici dedicati invece di feature del software di rete. Esteso lo stesso giorno con due specifiche aggiuntive ricevute dall'utente per componenti distinti della stessa famiglia: il **NOMAD Mobile Relay** e, a seguire, **Fixed Relay + Relay Registry** (vedi sezioni dedicate sotto).

## Cos'è e cosa non è

Un piccolo dispositivo fisico a batteria, con una sola funzione: **premendo un pulsante, chiedere aiuto**, anche in totale assenza di rete cellulare, Wi-Fi, Internet, smartphone o SIM. Il messaggio raggiunge la mesh Nomad-Net tramite uno o più relay — smartphone con l'app NOMAD, nodi fissi, o un **NOMAD Mobile Relay** dedicato (vedi sotto) — e arriva infine a un **Emergency Node** (es. presso un rifugio), dove un operatore umano lo vede e può rispondere.

Non è un dispositivo general-purpose: niente navigazione, chiamate, audio, tracciamento continuo. Questo vincolo è anche ciò che rende il dispositivo economico e a bassissimo consumo (mesi/anni di standby, non giorni) — un requisito di progetto, non solo un'ottimizzazione.

**Tre ruoli distinti, hardware diverso per ciascuno** (principio esplicito della proposta, coerente con la separazione già usata nel resto del progetto tra "gateway come funzione software" e hardware dedicato, `docs/deployment.md` §8/§86):

| Ruolo | Cosa fa | Hardware tipico |
|---|---|---|
| **Beacon** | Genera l'emergenza | MCU ultra-low-power + radio (BLE e/o LoRa) + pulsante + LED — pochi euro, nessun sistema operativo generico |
| **Relay** | Trasporta l'emergenza | Smartphone con l'app NOMAD (modalità "NOMAD Relay"), un nodo fisso Nomad-Net qualunque, o un **NOMAD Mobile Relay** dedicato (dispositivo "data mule" passivo, vedi sezione dedicata sotto) |
| **Emergency Node** | Riceve, gestisce, presenta l'emergenza a un operatore | Un nodo Nomad-Net normale (Orange Pi, mini-PC, smartphone del rifugista) con un ruolo software in più |

## Relazione con Nomad-Net: molto più riuso che lavoro nuovo

A differenza di BOX/PORTABLE (che confeziona *Project NOMAD*, un progetto esterno di cui questo repository non ha il sorgente), BEACON è per la sua parte "Relay"/"Emergency Node" **quasi interamente costruibile sopra l'infrastruttura Nomad-Net già esistente**. La proposta originale (vedi cronologia sessione) elenca una serie di requisiti che, verificati contro `node/src/`, risultano già soddisfatti da meccanismi generali del progetto, non da costruire da zero:

| Requisito della proposta (§ del documento originale) | Meccanismo Nomad-Net già esistente |
|---|---|
| Priorità massima per l'emergenza, la rete congestionata deve darle precedenza (§15) | `Priority.EMERGENCY` (`node/src/packet.ts`) — già usato da `service://emergency-news` (voce #39) e dai drop urgenti della Bacheca (voce #47), instradato con scheduling reale per priorità (`priority-queue.ts`, voce #4) |
| Identità crittografica per beacon, firma di ogni messaggio, anti-forgery (§5, §12) | `Identity` Ed25519 (`node/src/identity.ts`) — stesso schema firma/verifica già usato per contenuti (`content.ts`), servizi (`service.ts`), canali (`public-channels.ts`), gruppi (`groups.ts`) |
| Deduplicazione, "se Relay B riceve lo stesso messaggio 5 volte non lo ripropaga indefinitamente" (§6) | `SeenCache` (`node/src/routing.ts`) — dedup per id di pacchetto, cuore del controlled flooding già in produzione |
| Store-and-forward quando il prossimo hop non è raggiungibile (§6, §7) | `store-and-forward.ts` — coda per pacchetti unicast non consegnabili subito |
| Rate limiting anti-flood ("100.000 falsi EMERGENCY", §12) | `rate-limit.ts` (budget per peer/finestra) + il pattern già usato da `service://emergency-news` (`MAX_EMERGENCY_ANNOUNCES_PER_SYNC`, voce #39) e dai drop urgenti (`MAX_URGENT_DROPS_PER_WINDOW`, voce #47) per limitare *l'origine* di un annuncio a priorità EMERGENCY, non solo la ricezione |
| Trust levels, revoca di un dispositivo compromesso (§5, §12) | `trust.ts` (`TrustLevel`/`TrustManager`) |
| Radio BLE e/o LoRa a basso consumo per il collegamento fisico (§3, §16) | `transports/ble.ts` e `transports/lora.ts` (voce #51) — **entrambi simulati**, nessun hardware radio reale disponibile in questo ambiente, ma l'astrazione `Transport` e la logica di connessione/frammentazione (`transports/simulated-link.ts`) sono già pronte e testate |
| Smartphone come relay opportunistico che scansiona, verifica, inoltra (§8) | Concettualmente vicino a un nodo Nomad-Net BLE-connesso esistente — serve però una modalità di scan *senza connessione stabile* (BLE advertising grezzo), diversa dal transport BLE simulato attuale che assume un link punto-a-punto già stabilito (vedi "Cosa manca" sotto) |
| Messaggio breve, campi fissi (TYPE/ID/SEQ/TIME/BATTERY/LOCATION/FLAGS/SIGNATURE, §4) | Pattern già in uso per payload firmati compatti — vedi `extractDropPayload()`/`extractLocationReport()` in `drops.ts`/`location-registry.ts`, stesso schema di validazione difensiva del payload |
| Conferma bidirezionale (ACK, "richiesta ricevuta dalla rete", §7, §11) | Vicino a `PRIVATE_MESSAGE` unicast (già usato per gli inviti di gruppo, `groups.ts`) più il pattern richiesta/risposta di `service.ts` |
| Posizione: da beacon GPS, da relay, o da nodo fisso con posizione nota (§9) | `location-registry.ts` (voce #44) copre già il caso "posizione condivisa opportunisticamente" — con la stessa distinzione già presente lì tra "posizione di chi riporta" e "posizione del soggetto", rilevante qui per non confondere "posizione del beacon" con "posizione del relay" (esplicitamente richiesto al §9 della proposta) |

## Cosa manca davvero (lavoro nuovo, ma in buona parte in puro software)

1. **Un formato di messaggio "beacon" dedicato** — probabilmente un nuovo `MessageType` (es. `EMERGENCY_BEACON`) o, seguendo il precedente di drop/canali (voci #40/#47), una convenzione sopra un meccanismo esistente. Da decidere in fase di design, non ancora fatto.
2. **Un ruolo "Relay opportunistico" senza connessione stabile** — il transport BLE simulato attuale (`transports/ble.ts`) modella un link punto-a-punto con handshake, adatto a un nodo-nodo Nomad-Net pieno. Un vero beacon BLE userebbe *advertising* broadcast non connesso (niente handshake, pacchetto ripetuto periodicamente finché non arriva un ACK) — un modello di trasporto diverso da quello che esiste oggi, anche nella sua forma simulata.
3. **Un "Emergency Node" software** — una vista/servizio dedicato (verosimilmente un'estensione di `web-ui.ts`, sullo schema già usato da `location-registry.ts`: opt-in, endpoint autenticato) che mostra all'operatore beacon ricevuti, percorso, battery, permette ACK/risposta. Non esiste oggi.
4. **Anti-flood specifico per un'identità beacon usa-e-getta** — lo stesso problema già affrontato per l'eviction pesata sulla fiducia (`BoundedFifoMap`, voce #3) e per gli annunci EMERGENCY auto-generati (voci #39/#47), da applicare a un beacon che non ha mai avuto una connessione TCP/mesh precedente su cui costruire fiducia.
5. **Falso allarme / procedura di conferma pressione (§14)**, **cancellazione autenticata (§14)**, **firmware firmato / secure boot (§12)** — questi sono requisiti che vivono nel firmware del beacon stesso, non nel software Nomad-Net: fuori scope per questo repository indipendentemente da tutto il resto.

## Cosa NON è costruibile in questo ambiente (hardware reale)

Come per BOX/PORTABLE, tutto ciò che richiede hardware fisico resta bloccato su un prerequisito esterno, non pianificabile qui:

- MCU/chip radio reali (ESP32, nRF52/nRF53/nRF54, o un MCU con LoRa dedicato) — scelta hardware ancora aperta nella proposta originale (§20, "prossimo passo: hardware"), esplicitamente rimandata dall'utente.
- GPS on-beacon, batteria, enclosure, antenna, certificazioni (varianti EB-GPS/EB-Dual, §17).
- Firmware firmato e secure boot (§12) — dipendono dall'MCU scelto.
- Qualunque validazione "vera" di consumo energetico (mesi/anni di standby, §16) — misurabile solo su hardware reale.

Il transport BLE/LoRa **simulato** già presente in questo repository (voce #8, #51) resta comunque utile: valida la logica di routing/priorità/firma sopra un link a pacchetti piccoli e ad alta latenza, esattamente il tipo di vincolo che un vero beacon avrebbe — ma non sostituisce il hardware reale, come già vero per BLE dal 2026.

## MVP proposto (dalla specifica originale, §18)

La proposta stessa suggerisce di partire da **EB-BLE** (solo BLE, niente LoRa/GPS) per validare l'intero concetto prima della parte RF a lunga distanza:

```
[PULSANTE] → Emergency packet → BLE → Android NOMAD Relay → NOMAD-Net → Emergency Node → Dashboard operatore
```

Per questo repository, l'MVP realisticamente costruibile in puro software (nessun hardware fisico) sarebbe una versione **completamente simulata** del beacon stesso — analoga a come BLE/LoRa sono transport simulati oggi — più il ruolo Emergency Node lato server. Non ancora pianificato in dettaglio: richiede prima le decisioni di design ai punti 1-2 sopra (formato messaggio, modello di trasporto broadcast-non-connesso), che a loro volta meritano una discussione esplicita con l'utente prima del codice, per lo stesso motivo già seguito per il tracciamento posizione (voce #44) e le chat cifrate (voce #42): qui la sicurezza (anti-forgery, anti-flood, anti-replay su un'identità che chiunque potrebbe fabbricare) è più delicata della messaggistica ordinaria.

## Evoluzione prevista (invariata dalla proposta originale, §17/§19)

| Versione | Radio | Uso |
|---|---|---|
| EB-BLE | BLE | economico, urbano/rifugi |
| EB-LoRa | LoRa | escursionismo/outdoor |
| EB-Dual | BLE + LoRa | versione completa |
| EB-GPS | BLE + LoRa + GPS | emergenza con posizione autonoma |

Candidata finale della proposta: **EB-Dual**, senza partire subito da quella — stesso approccio incrementale già seguito per BOX/PORTABLE e per ogni slice di questo progetto.

---

## NOMAD Mobile Relay (Base/Passive) — dispositivo dedicato di trasporto opportunistico

**Stato**: documentazione di riferimento/pianificazione — **nessun codice scritto**. Seconda specifica ricevuta dall'utente il 3 settembre 2026 (stesso giorno di BEACON), analizzata per compatibilità con l'architettura esistente prima di essere integrata qui.

### Cos'è

Un dispositivo fisico a basso costo, trasportato da un vettore mobile qualunque (persona, drone, veicolo, animale, mezzo di soccorso, sistema di monitoraggio), la cui unica funzione è **ricevere → memorizzare → ritrasmettere** messaggi Nomad-Net secondo il modello store-and-forward/"data mule": acquisisce un messaggio quando è fuori copertura e lo consegna quando incontra un altro nodo, senza mai richiedere Internet, GPS, Wi-Fi, SIM, display o input utente. La versione **Base/Passive** non interpreta il contenuto applicativo dei messaggi — usa solo il campo di tipo/priorità per decidere cosa tenere quando la memoria è limitata.

Posizionamento nella catena (§16 della proposta, coerente con la tabella dei ruoli sopra): `Emergency Beacon → Mobile Relay → Fixed NOMAD Node → Emergency Node` — un caso d'uso tra i tanti possibili (Personal/Drone/Vehicle/Monitoring/Animal Relay, §14), il dispositivo non ha bisogno di sapere quale vettore lo trasporta né quale ruolo applicativo hanno i messaggi che porta.

### Verdetto di compatibilità: valida, e più semplice del Beacon stesso

La specifica è **valida e ben allineata** all'architettura Nomad-Net — anzi, verificata contro `node/src/`, risulta il componente hardware più semplice da giustificare dei tre documentati finora (BOX/PORTABLE, BEACON, questo). Il motivo: un Mobile Relay Base descritto qui **non richiede alcun nuovo formato di messaggio o protocollo** — a differenza del Beacon (che ha bisogno di un pacchetto di emergenza dedicato, sezione sopra), il Mobile Relay è per design "cieco" al contenuto che trasporta. Funzionalmente, è **un `NomadNode` esistente, configurato con un profilo minimo**: solo transport BLE/LoRa attivi, nessun servizio applicativo locale (`web-ui`, gateway, ecc.), che fa esattamente quello che `node.ts`/`routing.ts`/`store-and-forward.ts` fanno già per qualunque pacchetto della mesh. Il concetto stesso di "courier device" è già anticipato nella specifica del progetto — vedi il commento in `node/src/store-and-forward.ts`: *"a courier device reconnecting to a different segment of the mesh (spec §32)"* — questa proposta non introduce un'idea nuova, ne formalizza una già prevista come hardware dedicato.

| Requisito della proposta (§) | Meccanismo Nomad-Net già esistente |
|---|---|
| Ricezione, memorizzazione, ritrasmissione (§2, §3, §7) | Comportamento nativo di `NomadNode`/`decideForward()` (`routing.ts`) per ogni pacchetto in transito — non richiede alcuna logica applicativa aggiuntiva |
| Store-and-forward quando il prossimo hop non è raggiungibile (§2, §6) | `PendingDeliveryQueue` (`store-and-forward.ts`) — coda per pacchetti unicast non consegnabili subito, già pensata esplicitamente per un "courier device" (vedi sopra) |
| Deduplicazione per `MESSAGE_ID` (§8) | `SeenCache` (`routing.ts`) — dedup per `packet.id`; nel protocollo attuale `packet.id` è un UUID globale generato alla creazione (`randomUUID()`, `packet.ts`), quindi eccede già il fallback minimo proposto (`SOURCE_ID + SEQUENCE`) |
| TTL/hop limit per evitare che un messaggio circoli indefinitamente (§9) | `packet.ttl` decrementato ad ogni hop (`decideForward()`) — hop-based, esattamente come richiesto; **inoltre** un TTL a orologio indipendente in `PendingDeliveryQueue.ttlMs` (default 5 minuti) per i pacchetti in coda, un livello che la proposta non distingue esplicitamente ma che il codice già ha |
| Priorità minima basata sul campo TYPE, EMERGENCY per primo (§10) | `Priority.EMERGENCY = 0` (`packet.ts`) già la priorità più alta, con scheduling reale per priorità in `TcpTransport` (`priority-queue.ts`, voce #4) |
| Comunicazione BLE, incontro automatico con un altro nodo senza pairing manuale (§5, §7C) | `transports/ble.ts` — **simulato**, nessun hardware BLE reale in questo ambiente; l'handshake HELLO automatico esiste già (`transports/simulated-link.ts`) |
| LoRa, banda EU868 (§5) | `transports/lora.ts` (voce #51) — **simulato**, stessa banda già menzionata nella documentazione esistente del transport LoRa |
| Identità crittografica, autenticazione pacchetti, anti-replay, revoca di un relay compromesso (§11) | `Identity` Ed25519 (`identity.ts`) + `TrustManager` (`trust.ts`) — stesso schema usato ovunque nel progetto; il relay non possiede mai le chiavi dell'autore originale di un contenuto/messaggio firmato, quindi non può falsificarne l'origine, esattamente come richiesto ("riceve → conserva → inoltra" senza poter modificare arbitrariamente un messaggio) |
| Nessuna dipendenza da Internet/Wi-Fi/GPS/SIM/display (§3, §4) | Coerente con un `NomadNode` a cui non viene mai istanziato `WebUiServer` né alcun gateway — non c'è nulla nel codice esistente che *imponga* queste dipendenze, sono già tutte opzionali |

### Differenze reali rispetto al codice esistente (non bloccanti, ma da non ignorare)

La compatibilità è alta ma non totale — tre scostamenti reali tra la proposta e il comportamento odierno, utili se mai si arrivasse a un'implementazione:

1. **Eviction non pesata su priorità in `PendingDeliveryQueue`**: la coda usa `BoundedFifoMap` con eviction FIFO pura (il più vecchio esce per primo). La proposta (§10) si aspetta che, sotto pressione di memoria, i messaggi a priorità inferiore vengano scartati *prima* di quelli EMERGENCY — oggi non è così: un Mobile Relay con poca memoria potrebbe eliminare un messaggio di emergenza in coda da poco a favore di un messaggio ordinario più vecchio. Coerente con lo stesso tipo di gap già risolto altrove nel progetto per altre strutture dati (`RoutingTable`/`PeerDirectory`/`RemoteCatalog`, voci #3/#26) tramite eviction pesata — qui non ancora applicato.
2. **TTL uniforme, non differenziato per priorità**: `PendingDeliveryQueue.ttlMs` è un singolo valore globale (default 5 minuti), mentre la proposta (§9) prevede esplicitamente un TTL più lungo per i messaggi di emergenza rispetto a quelli ordinari.
3. **Nessun "annuncio inventario" per i pacchetti generici in coda**: il modello §7C ("annuncia i messaggi disponibili, trasferisce solo quelli non ancora ricevuti") esiste già per i contenuti pubblicati (`RemoteCatalog`, sync tra segmenti) ma non per i pacchetti generici in `PendingDeliveryQueue` — oggi un incontro tra due nodi ritrasmette per flooding (`decideForward`), con `SeenCache` che scarta i duplicati lato ricevente ma senza negoziare in anticipo *cosa* serve davvero all'altro nodo. Su un link BLE/LoRa a banda stretta e ad alta latenza, questo spreca tempo radio reale — un'ottimizzazione mai necessaria finché il transport è TCP locale.

Nessuno di questi è un difetto di progetto: sono limiti che semplicemente non contavano finché non esisteva un caso d'uso (un relay fisico, a memoria/banda/energia vincolate) che li rende visibili. Stesso trattamento onesto già riservato ad altri limiti noti del progetto (`docs/security.md`, "Binding crittografico").

### Cosa NON è costruibile in questo ambiente (hardware/firmware reale)

Stesso principio già applicato a BOX/PORTABLE e al Beacon: tutto ciò che segue richiede hardware fisico o un firmware embedded dedicato, non pianificabile in questo repository.

- MCU a basso consumo, radio BLE + LoRa reali, memoria non volatile con persistenza attraverso spegnimenti/perdita di alimentazione (§4, §6) — un vero Mobile Relay avrebbe comunque bisogno di un firmware proprio (C/embedded, non questo codice TypeScript), che *implementi lo stesso protocollo* validato qui in simulazione, non che esegua questo codice.
- BLE Long Range/LE Coded specifico (§5) — dettaglio di PHY radio invisibile all'astrazione `Transport` attuale, quindi né validabile né invalidabile in software puro.
- Formato fisico, involucro IP65/IP67, peso <50g, montaggio su drone/zaino/veicolo (§13) — industrial design, fuori scope.
- Validazione reale di autonomia energetica (sleep/listen/transfer, §12) — misurabile solo su hardware reale.

### Prossimo passo

Nessun codice scritto per questa voce. Se l'utente vorrà procedere, il lavoro software puro più naturale sarebbe una configurazione/profilo dedicato di `NomadNode` (transport BLE/LoRa simulati soli, nessun servizio locale) più i tre affinamenti elencati sopra (eviction pesata su priorità e TTL differenziato per `PendingDeliveryQueue`, eventuale negoziazione "inventario" per pacchetti generici) — verificabile end-to-end con gli stessi pattern di test già usati per BLE/LoRa simulati, senza bisogno di alcuna decisione di design nuova paragonabile a quella richiesta dal formato messaggio del Beacon.

---

## NOMAD-Net Emergency & Rescue Relay Network — Fixed Relay e Registro dei relay

**Stato**: documentazione di riferimento/pianificazione — **nessun codice scritto**. Terza specifica ricevuta dall'utente lo stesso giorno (3 settembre 2026), a seguito di una discussione esplicita in cui l'utente ha **rifiutato** una precedente proposta di rebranding (una famiglia hardware unificata "NOMAD Radio Device"): Beacon, Mobile Relay e Fixed Relay restano tre nomi distinti in questo documento, non varianti di un unico prodotto. Resta aperta e non decisa, separatamente da questa sezione, l'idea di "SOS Proximity Detection" (misura RSSI lato relay per una stima di prossimità) discussa nella stessa conversazione ma non ancora integrata in documentazione.

### Cos'è

La specifica introduce una distinzione di **deployment** all'interno del ruolo "Relay" già documentato sopra:

- **Fixed Relay** — installato permanentemente in un punto strategico (sentieri, passi, vie ferrate, rifugi, punti di emergenza), alimentato a pannello solare + batteria dove manca energia elettrica, operativo a lungo termine senza intervento umano.
- **Mobile Relay** — quanto già documentato sopra (persona/drone/veicolo/animale/mezzo di soccorso).

A completare il quadro, un **Relay Registry**: un registro (centralizzato o distribuito) dei Fixed Relay dispiegati, ciascuno con un `Relay ID` univoco e metadati di deployment (posizione geografica, tipo, stato operativo, capacità radio, data di installazione, operatore/organizzazione, ultimo stato/sincronizzazione noti), esposto tramite un portale/mappa NOMAD a utenti autorizzati. La specifica nota un beneficio operativo concreto: sapere *quale* relay ha ricevuto un SOS e *dove* si trova quel relay è già di per sé un'informazione utile per stimare origine e percorso del segnale, prima ancora di qualunque stima di prossimità più sofisticata.

Principio dichiarato esplicitamente nella proposta, coerente con come questo progetto tratta già Nomad-Net rispetto alle infrastrutture di emergenza convenzionali: **non sostituisce** le comunicazioni di emergenza tradizionali, fornisce un **layer di comunicazione secondario e resiliente** dove quelle convenzionali non arrivano o non sono affidabili.

### Compatibilità: Fixed Relay non è un dispositivo nuovo, è un deployment del Mobile Relay

Verificato contro la sezione "NOMAD Mobile Relay" sopra: **Fixed Relay e Mobile Relay sono lo stesso dispositivo dal punto di vista software** — stesso comportamento `NomadNode`/`decideForward()`/`PendingDeliveryQueue`/`SeenCache`/`Identity`/`TrustManager`, stessi transport BLE/LoRa simulati. L'unica differenza reale è l'alimentazione (pannello solare + batteria contro batteria portatile) e il fatto di restare fermo invece di muoversi — nessuna delle due cose cambia una sola riga di logica di rete. Questo conferma, da un angolo diverso, la stessa conclusione già scritta sopra per il Mobile Relay: **non serve alcun nuovo protocollo** per il ruolo di relay in sé, a prescindere da dove/come viene installato.

Il pezzo davvero nuovo è il **Relay Registry**, che invece non ha ancora un equivalente nel codice — la proposta di design (non ancora implementata):

| Aspetto | Progettazione proposta |
|---|---|
| Metadati statici (posizione, tipo Fixed/Mobile, capacità radio, data installazione, operatore) | Inseriti **una tantum dall'operatore** che installa il relay, tramite un nuovo endpoint autenticato sull'Emergency Node (es. `POST /api/relays`) — non auto-annunciati via radio: sono dati che l'installatore conosce già al momento del deployment, farli dedurre al dispositivo aggiungerebbe complessità senza motivo |
| Stato dinamico (operativo/ultimo contatto) | Derivato **automaticamente** dalla connettività mesh reale del relay (visto come peer, ultima consegna riuscita via store-and-forward) — nessun nuovo tipo di pacchetto, pura osservabilità di uno stato che il nodo ha già |
| Esposizione | Nuovo endpoint di lettura (es. `GET /api/relays`), **autenticato** come `GET /api/location-registry` (voce #44) — la specifica dice esplicitamente "utenti autorizzati", diverso dal trattamento pubblico di `GET /api/drops` |
| Visualizzazione | Nuovo layer di pin su `mapview.js`, accanto a quello già esistente per i drop della Bacheca (`#map-pins-layer`, voce #47) — stesso meccanismo di rendering, fonte dati diversa (registro relay invece di drop) |
| Correlazione con un SOS | L'Emergency Node, mostrando un'emergenza ricevuta, può arricchirla con la posizione nota del Fixed Relay che l'ha inoltrata (join tra l'evento e il registro per `Relay ID`) — nessuna nuova logica di rete, solo una vista lato Emergency Node che combina due fonti dati già previste |

### Differenze/lavoro reale rispetto al codice esistente

1. **Il Relay Registry non ha alcun precedente diretto**: `location-registry.ts` è il parente più vicino (registro con scadenza opzionale, opt-in, endpoint autenticato) ma è "solo l'ultima posizione nota" per un singolo campo lat/lon; qui servono più campi eterogenei (alcuni immutabili come la data di installazione, altri che cambiano nel tempo come lo stato) e una via di scrittura pensata per un operatore umano, non per un report firmato via radio — un modulo nuovo, non un riuso diretto di `LocationRegistry`.
2. **La correlazione "quale relay ha ricevuto questo SOS" non esiste ancora nemmeno per il Beacon**: presuppone che il pacchetto di emergenza porti traccia di quale relay lo ha inoltrato per primo/ricevuto — un dettaglio da definire insieme al formato messaggio del Beacon (già segnalato come "cosa manca" più sopra), non specifico di questa sezione ma che questa sezione rende più concreto.
3. **Nessuna decisione ancora presa su dove vive il registro**: un nodo dedicato (come il registro posizioni, opt-in via un flag CLI dedicato) o l'Emergency Node stesso — la specifica non lo impone, è una scelta di deployment da fare in fase di design.

### Cosa NON è costruibile in questo ambiente (hardware/operativo reale)

- Pannello solare, gestione batteria/ricarica, involucro outdoor per un Fixed Relay reale (hardware, stesso trattamento già riservato a Beacon/Mobile Relay).
- La scelta reale dei punti di installazione lungo sentieri/vie ferrate/rifugi — decisione operativa sul campo, non software.
- Qualunque validazione di copertura radio reale (BLE Long Range/LoRa su un percorso montano) — misurabile solo con hardware e un dispiegamento reale.

### Prossimo passo

Nessun codice scritto per questa voce. Se l'utente vorrà procedere, il lavoro software puro sarebbe: un nuovo modulo di registro (schema a due categorie di campi, statico/dinamico, come descritto sopra), gli endpoint `POST`/`GET /api/relays` su `web-ui.ts` dietro autenticazione, e un secondo layer di pin su `mapview.js` — tre pezzi ben delimitati, nessuno dei quali richiede le decisioni di design più delicate ancora aperte per il Beacon (formato messaggio, trasporto broadcast-non-connesso).

---

## Ambito di applicazione: oltre il rifugio alpino

**Stato**: chiarimento di inquadratura ricevuto dall'utente lo stesso giorno — nessuna novità tecnica, nessun codice, nessuna nuova decisione di design.

Tutto quanto descritto sopra (Beacon, Mobile Relay, Fixed Relay, Relay Registry) non ha alcuna dipendenza dall'ambiente alpino, né nel codice esistente (i transport BLE/LoRa simulati e il modello store-and-forward non sanno e non devono sapere dove si trova il nodo che li esegue) né nella specifica stessa (i tre ruoli — genera, trasporta, riceve — sono già descritti come indifferenti al vettore che li ospita). Il rifugio alpino resta lo scenario di riferimento di questo progetto (§6.2 della specifica, pilot dedicato in `docs/deployment.md`), ma **la caratteristica che rende questa architettura applicabile non è il luogo, è l'assenza — temporanea o permanente — di connettività affidabile**, una proprietà che si ritrova in contesti molto diversi:

| Scenario | Cosa cambia rispetto al rifugio | Cosa resta identico |
|---|---|---|
| **Foreste e grandi aree naturali** (escursionisti dispersi, incendi, incidenti outdoor) | Fixed Relay lungo sentieri e punti di passaggio invece che attorno a un edificio | Stessa catena Beacon → Relay → Emergency Node/centro soccorsi |
| **Deserti e aree remote** (es. Sahara, outback australiano, Atacama) | Densità di relay molto più bassa, distanze molto maggiori tra un punto radio e l'altro; consegna non necessariamente immediata | Store-and-forward, TTL, priorità — nessuna di queste proprietà presuppone consegna rapida, sono già pensate per l'attesa |
| **Aree rurali e comunità isolate** | Sorgenti diverse (beacon personali, operatori locali, veicoli, strutture di emergenza) invece di ospiti di un rifugio | Stessi ruoli Beacon/Relay/Fixed Relay, nessuna infrastruttura cellulare completa richiesta |
| **Disastri naturali** (terremoto, alluvione, uragano, incendio) | Relay distribuiti *dopo* l'evento, spesso in modo rapido e provvisorio (persone, veicoli, droni) — proprio quando le infrastrutture convenzionali (antenne, elettricità, Internet) sono già fuori uso | La proprietà "non serve una connessione continua, basta che i nodi si incontrino", già enunciata per il Mobile Relay, è qui più rilevante che mai |
| **Mare, coste e isole** | Un'imbarcazione come Mobile Relay, che raccoglie messaggi in navigazione e li consegna raggiungendo un porto o un altro nodo | Stesso modello "data mule" già documentato per il Mobile Relay generico |
| **Aree di crisi o infrastrutture temporanee** (grandi eventi, campi base, cantieri remoti, spedizioni, protezione civile) | Relay portatili, rete creata rapidamente senza installazione permanente | Nessuna differenza dal Mobile Relay/Fixed Relay già descritti, solo un orizzonte temporale più breve |

Nessuno di questi scenari richiede una decisione tecnica diversa da quelle già discusse nelle sezioni precedenti di questo documento — è un cambio di **inquadratura**, non di architettura: gli stessi tre ruoli (Beacon/Relay/Emergency Node) e lo stesso Relay Registry già proposto per il rifugio si applicano senza modifiche. Il modello dei Fixed Relay solari resta il pezzo che trasforma questa idea da "insieme di dispositivi mobili" a vera e propria **infrastruttura fisica distribuita** — nodi permanenti autonomi, registrabili e visualizzabili su mappa (sezione "Fixed Relay e Relay Registry" sopra) — indipendentemente da quale dei contesti sopra li ospita.

L'unica conseguenza pratica per la documentazione di questo progetto: i "Pilot" già scritti in `docs/deployment.md` (rifugio, emergenza, eventi, scuole, spedizioni) restano gli scenari primari e meglio definiti per questo repository, mentre foreste/deserti/aree rurali/disastri/coste/infrastrutture temporanee sono scenari applicativi più ampi della stessa architettura, non ancora oggetto di un pilot dedicato — stesso trattamento già riservato a "Comunità locali" (§6.7 in `docs/deployment.md`: nessun pilot scritto finché non emerge una richiesta concreta, perché non aggiungerebbe alcun requisito software nuovo rispetto a quanto già coperto qui).

---

## Roadmap di validazione e field test

Come arrivare, per gradi, a validare questi dispositivi **insieme come rete** — fino a un eventuale test sul campo con un ente reale — è documentato separatamente in [`docs/emergency-rescue-network.md`](./emergency-rescue-network.md), su richiesta esplicita dell'utente: quel documento riguarda la rete nel suo insieme (fasi di test, budget indicativo, possibili partner di campo), non i singoli dispositivi descritti qui.

## Prossimo passo (tutte le voci di questo documento)

Nessun codice scritto per nessuna delle voci di questo documento (Beacon, Mobile Relay, Fixed Relay/Registro). Se e quando l'utente vorrà procedere, il primo passo concreto resta una fase di planning esplicita (analoga a quella già fatta per il tracciamento posizione, voce #44, e per le chat cifrate, voce #42) — necessaria soprattutto per il Beacon (formato messaggio, modello di trasporto broadcast-non-connesso), mentre per Mobile Relay e Fixed Relay/Registro il lavoro è già in gran parte definito dal codice esistente, come descritto nelle rispettive sezioni. In ogni caso, prima di scrivere qualunque riga di codice, seguendo lo stesso workflow a doppio check descritto in `CLAUDE.md`.
