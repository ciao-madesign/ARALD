# Cosa si riusa, cosa si costruisce ex novo

Questo documento esiste per una ragione precisa: è facile leggere le sezioni 4-5 e 96-99 della [specifica](./SPECIFICATION.md) e concludere che "gran parte del lavoro è già fatta" perché BitChat e Project NOMAD coprono argomenti simili. Non è così. Questa tabella distingue esplicitamente cosa esiste già e può essere preso a riferimento (o integrato as-is) da cosa ARALD deve progettare e implementare da zero.

## Da Project NOMAD — riusabile as-is (nessuno sviluppo ARALD richiesto)

| Componente | Stato | Note |
|---|---|---|
| Kiwix / Wikipedia offline | Esiste, containerizzato | Consumato tramite gateway (§37) |
| Ollama (LLM locale) | Esiste, containerizzato | Consumato tramite gateway (§37) |
| Qdrant / RAG | Esiste, containerizzato | Interno a NOMAD, non esposto direttamente alla mesh |
| Kolibri | Esiste, containerizzato | Consumato tramite gateway |
| Mappe offline / CyberChef / FlatNotes | Esistono, containerizzati | Consumati tramite gateway |
| Command Center / API di orchestrazione | Esiste | ARALD non lo sostituisce, lo chiama |

**ARALD tratta NOMAD come una "black box" dietro un gateway.** Non è previsto (nella prima fase) di modificare il codice di Project NOMAD.

## Da BitChat — concetti architetturali di riferimento, NON codice riusabile as-is

BitChat è scritto per un dominio applicativo diverso (messaggistica peer-to-peer via BLE) e in uno stack diverso da quello scelto per il primo prototipo ARALD (TypeScript/Node.js). Il riuso è **concettuale**: le idee vanno reimplementate nel contesto content-centric di ARALD.

| Concetto BitChat | Cosa va effettivamente riusato | Cosa ARALD deve costruire ex novo |
|---|---|---|
| BLE mesh, peer discovery | Il modello di discovery/annuncio | Un'astrazione di trasporto (§41) che tratti BLE come uno fra più transport intercambiabili, non l'unico |
| Multi-hop relay, controlled flooding, TTL, dedup | La logica generale (decrementa TTL, droppa duplicati, inoltra) | L'implementazione concreta nel routing engine di ARALD (`node/src/routing.ts`), generalizzata a pacchetti *content-aware*, non solo messaggi |
| Source routing | Riferimento di progettazione | Routing evoluto content/service-aware con funzione di costo (§22) — non presente in BitChat, va progettato da zero |
| Fragmentation | Il concetto di chunking | Il formato chunk e la logica di riassemblaggio per contenuti arbitrari (non solo messaggi brevi) — §26 |
| Store-and-forward, persistent outbox, courier, spray-and-wait | Il modello concettuale DTN | L'implementazione completa: coda di consegne pendenti, copy budget, logica courier — nessuna di queste esiste ancora nel codice ARALD (roadmap milestone 12) |
| Gossip sync, GCS filter | Riferimento per la sincronizzazione | Sync engine per **cataloghi di contenuti/servizi** (non cronologia messaggi) — dominio diverso, da progettare (§33, milestone 13) |
| Identità a chiavi crittografiche, sessioni sicure (Noise) | Il modello di identità Ed25519 | L'intero security manager di ARALD (trust levels, firma dei contenuti, rate limiting) — §52-58, nessuna parte è già implementata |
| Dual transport BLE + Nostr | L'idea di un fallback Internet | ARALD usa un modello di gateway generico (§38), non Nostr; da costruire ex novo |
| `BoardManager` (bacheca locale mesh, `bitchat/Services/Board/BoardManager.swift`, https://github.com/permissionlesstech/bitchat, licenza Unlicense/dominio pubblico) — **non** `LocationNotesManager`, la loro seconda feature con un nome simile: quella dipende da relay Nostr esterni + Tor, quindi non è un riferimento concettuale valido per un progetto senza dipendenza da Internet | Il concetto: un post legato a un luogo, firmato, con scadenza e un flag "urgente" che salta la coda di consegna, propagato via broadcast mesh | La feature "drop"/bacheca di ARALD (`node/src/drops.ts`, `docs/security.md` voce #47) — interamente costruita sopra primitive già esistenti (`content://`/`publishContent()`/`CONTENT_ANNOUNCE`/`Priority.EMERGENCY`, non un nuovo `MessageType`), niente tombstone/cancellazione in questa v1 (a differenza di BitChat, il modello di contenuto di ARALD è immutabile per costruzione ovunque) |
| Rotazione del peer ID (`docs/PEER-ID-ROTATION.md`, https://github.com/permissionlesstech/bitchat, licenza Unlicense/dominio pubblico — solo bozza di design, non ancora spedita nemmeno in BitChat) | Il problema che risolve (un osservatore passivo può costruire un grafo di prossimità da un id stabile trasmesso in chiaro) e il principio della soluzione (id derivato dalla chiave privata, legato a una chiave stabile solo dentro un handshake completato) | **Non implementato, solo riferimento** — nota di direzione futura in `docs/security.md` ("Direzione per l'implementazione futura"): richiede prima un handshake di autenticazione che ARALD non ha ancora (l'HELLO di `transports/tcp.ts` non lo è), e `nodeId` qui è già la chiave pubblica grezza usata come chiave primaria in quasi ogni struttura dati — un porting diretto sarebbe più grande che in BitChat, non equivalente; nessuna decisione di implementazione presa |

**In sintesi: nessuna riga di codice di BitChat viene importata.** Il valore di BitChat per questo progetto è come documento di design (in particolare il Whitepaper 2.0) da studiare prima di implementare routing, TTL, dedup e DTN.

## Codice di terze parti vendorizzato (non un riferimento concettuale — codice reale incluso as-is)

A differenza di ogni voce sopra (dove il riuso è solo concettuale, mai codice), un'eccezione deliberata: **TweetNaCl.js** (`mobile/www/vendor/nacl.js`, `docs/security.md` voce #65) è codice di terze parti incluso as-is, invariato sotto il proprio header di provenienza.

| Cosa | Perché un'eccezione a "scrivilo da zero" | Verifica eseguita prima di fidarsene |
|---|---|---|
| TweetNaCl.js v1.0.3 (`nacl.js`, build "portabile" non ottimizzata — https://tweetnacl.js.org, Unlicense/dominio pubblico, porting di TweetNaCl di D. J. Bernstein et al.) | Il telefono (`mobile/www/ble-identity.js`) ha bisogno di firmare davvero con Ed25519 per rendere un SOS originato dal telefono verificabile da un `NomadNode` reale (`verifyContentSignature()`) — ma Web Crypto (`crypto.subtle`), che offrirebbe la stessa cosa, è disponibile solo in un contesto sicuro (HTTPS/`localhost`), non sulla LAN in HTTP semplice che è lo scenario più comune di questa app. Scrivere Ed25519 (aritmetica a curva ellittica) da zero sotto pressione di tempo è stato giudicato un rischio reale per un primitivo crittografico — categoricamente diverso da un encoder QR (`node/src/qrcode.ts`) o un parser RSS (`gateway/nomad/rss-feed.ts`), dove un bug è cosmetico, non una vulnerabilità di firma. | Scaricato da `registry.npmjs.org` (shasum del pacchetto e del file verificati contro il registry stesso); 40+ prove randomizzate di firma/verifica incrociata contro `node:crypto` in entrambe le direzioni (stesso motore usato da `Identity`, `node/src/identity.ts`) più rilevamento di manomissione; una firma prodotta in una vera pagina Chromium servita su un indirizzo stile-LAN in HTTP semplice (contesto non sicuro) verificata da Node — esattamente lo scenario reale da risolvere. Solo `nacl.sign.*` (Ed25519) è usato; `nacl.box`/`nacl.secretbox` (X25519 e altri primitivi presenti nello stesso file) restano codice morto per questo progetto — il file è vendorizzato per intero, mai ritagliato a mano (ritagliare una libreria crittografica a mano rischia di comprometterla in modo sottile). |

## Altri progetti "Nomad"/mesh correlati verificati per la due-diligence sul naming (4 settembre 2026)

Il progetto era precedentemente sviluppato con il nome di lavoro "Nomad-Net" — rinominato in **ARALD** proprio a valle di questa due-diligence, per eliminare ogni possibile confusione con i progetti seguenti. Nessuno dei tre è integrato in questo repository, né come codice né come dipendenza: la verifica sotto è stata fatta leggendo LICENSE/README ufficiali via accesso web reale in questa sessione (non un'ipotesi di lavoro, a differenza di altre informazioni istituzionali segnalate altrove in questa documentazione come non verificabili).

| Progetto | Autore/organizzazione | Repository | Licenza | Relazione con ARALD |
|---|---|---|---|---|
| **NomadNet** | Mark Qvist | https://github.com/markqvist/NomadNet | GPL-3.0 | Piattaforma di comunicazione mesh off-grid cifrata — concettualmente vicina ad ARALD (mesh, delay-tolerant, nessuna dipendenza da Internet) e con un nome quasi identico al precedente "Nomad-Net" di questo progetto. **Nessun codice riusato.** Il nome era il rischio reale, non il codice — da qui la scelta di rinominare. |
| **Reticulum** | Mark Qvist | https://github.com/markqvist/Reticulum | Modified MIT | Il livello di rete/crittografia su cui è costruito NomadNet (routing mesh, identità crittografiche). Licenza permissiva di base ma con due clausole aggiuntive non standard: vietato l'uso in sistemi progettati per danneggiare intenzionalmente persone, e vietato l'uso — diretto o indiretto — nella creazione di dataset di addestramento per intelligenza artificiale/machine learning/modelli linguistici. **Nessun codice riusato**, nessuna dipendenza. |
| **LXMF** | Mark Qvist | https://github.com/markqvist/LXMF | Modified MIT | Il livello di messaggistica sopra Reticulum. Stessa licenza modificata di Reticulum (stesse due clausole aggiuntive). **Nessun codice riusato**, nessuna dipendenza. |

**Non eseguito in questa sessione**: un confronto tecnico approfondito tra il design di Reticulum/LXMF (announce/routing table, modalità di consegna LXMF, ecc.) e quello di ARALD — la verifica qui si è fermata a licenza/branding/README, non a una lettura del codice sorgente di questi progetti. Se in futuro si volesse un confronto tecnico più approfondito (spunti di design, non codice — la licenza di Reticulum/LXMF lo permetterebbe comunque solo come riferimento concettuale, mai come codice importato, stesso trattamento già riservato a BitChat sopra), va trattato come un lavoro a sé, non assunto qui.

## Meshtastic — due-diligence più ampia (analogie/sovrapposizioni/conflitti/plagio, non solo naming), 9 settembre 2026

Richiesta esplicita dell'utente, più ampia della sola verifica di naming fatta sopra per NomadNet/Reticulum/LXMF: analogie, sovrapposizioni, conflitti, plagio rispetto a `meshtastic/firmware`. A differenza di quelle tre voci (verificate solo su LICENSE/README), qui è stato clonato e letto il sorgente reale (`git clone --depth 1 https://github.com/meshtastic/firmware`) — router (`FloodingRouter.h`/`NextHopRouter.h`/`ReliableRouter.h`), cifratura (`CryptoEngine.cpp`), canali (`Channels.h`), `StoreForwardModule.h`, l'elenco completo dei portnum/moduli.

| Progetto | Autore/organizzazione | Repository | Licenza | Relazione con ARALD |
|---|---|---|---|---|
| **Meshtastic firmware** | Meshtastic LLC / community | https://github.com/meshtastic/firmware | GPL-3.0 | Firmware LoRa mesh open-source per centinaia di board embedded (ESP32/nRF52/RP2040/STM32...), focalizzato su messaggistica/posizione/telemetria a pacchetto piccolo (~237 byte/pacchetto LoRa). **Nessun codice riusato** — stessa famiglia di licenza copyleft di NomadNet, stesso trattamento: solo riferimento concettuale, mai import diretto. Nessun conflitto di naming/trademark trovato (nessuna menzione di "ARALD"/"Nomad" nel loro repository). |

**Sovrapposizioni concettuali reali, nessuna sospetta** (tecniche da manuale, non originali di nessuno dei due progetti): flooding controllato + dedup + TTL (`FloodingRouter` ~ `routing.ts`'s `SeenCache`/`decideForward()` — ARALD l'ha già derivato concettualmente da BitChat, non da Meshtastic, vedi sopra); cifratura DM via X25519/Curve25519 DH → chiave simmetrica (`CryptoEngine::encryptCurve25519` ~ `encryption.ts`) — stesso primitivo standard scelto indipendentemente da entrambi.

**Differenze di design reali, non sovrapposizioni** (spunto di studio, non un problema da correggere): i canali broadcast di Meshtastic usano una PSK condivisa da tutti i membri del canale (nessuna firma per-autore all'interno del canale); i gruppi/canali privati di ARALD (`groups.ts`) hanno sia la chiave di gruppo sia la firma Ed25519 del singolo mittente — un punto dove il design di ARALD è già più robusto. Il routing unicast di Meshtastic (`NextHopRouter`) è **reattivo** (impara il next-hop origliando il percorso di un ACK andato a buon fine, con health/TTL del percorso e fallback a flooding) contro il distance-vector **proattivo** di ARALD (`routing-table.ts`, spec §22) — design diverso, non sovrapposto.

**Ambiti dove Meshtastic non ha alcun equivalente** (il vero lavoro originale di ARALD, confermato anche da questo confronto): nessun content-addressing, nessun servizio AI/enciclopedia offline/traduzione dietro un gateway, nessuna consegna differita verso una destinazione esterna. Il loro "Store-and-Forward" (`StoreForwardModule`) è limitato al replay della cronologia degli ultimi messaggi di testo per un client che si riconnette — ambito molto più stretto della coppia `store-and-forward.ts`/`external-delivery.ts` di ARALD (file arbitrari, consegna verso l'esterno via Internet). L'emergenza in Meshtastic è un tipo di messaggio prioritario tra tanti (`ALERT_APP`/`GROUPALARM_APP`), non un ecosistema a sé come `emergency-beacon.ts` + Card/Fixed Relay/Relay Registry di ARALD (`docs/beacon.md`).

**Dove Meshtastic è oggettivamente più avanti**: maturità RF/firmware/hardware — 12 famiglie di MCU supportate, 84+ configurazioni di board già in produzione commerciale nel loro repository, community consolidata. Non è un asse su cui ARALD sta cercando di competere: è un firmware di messaggistica a pacchetto piccolo per hardware economico di terze parti, mentre ARALD è un sistema content-centric pensato per un Box/gateway con più risorse, con LoRa come uno dei transport possibili, non l'unico.

**Riferimento di design, non ancora pianificato** (solo concetto, mai codice — stesso trattamento già riservato a BitChat/Reticulum/LXMF sopra):

1. Ritardo casuale (0-10s) prima del re-broadcast per evitare collisioni sul canale LoRa condiviso, usato da `FloodingRouter` — `transports/lora.ts`/`transports/lora-serial.ts` non modellano oggi alcun duty-cycle/fairness del canale (limite già noto, dichiarato in quei file/`CLAUDE.md`). Rilevante solo se/quando si vorrà affinare il transport LoRa reale.
2. Instradamento reattivo (next-hop imparato dal percorso di un ACK, con health/TTL del percorso) come possibile alternativa/complemento al distance-vector proattivo attuale — solo se in futuro emergesse un problema concreto di overhead da annunci periodici su un link LoRa a bassa banda.

**Non eseguito in questa sessione**: un confronto a livello di codice del formato di pacchetto (`meshtastic_MeshPacket`, protobuf via nanopb) o della logica di frammentazione/riassemblaggio radio — la verifica si è fermata al livello architetturale (routing, cifratura, moduli/portnum), sufficiente a rispondere alla domanda di posizionamento posta dall'utente. `meshtastic.org/docs` (documentazione ufficiale) non è stato raggiungibile da questo ambiente (proxy di rete) — quanto sopra è verificato solo contro il sorgente reale su GitHub, non contro la loro documentazione pubblica.

## Componenti interamente ex novo (non hanno equivalente diretto né in BitChat né in NOMAD)

Questi sono il vero lavoro di ingegneria di ARALD — nessuna delle due repository di riferimento li fornisce:

- **Content-centric routing** (`content://...` → provider più vicino) — §23-24, §90-92
- **Catalogo distribuito dei contenuti** (metadata, versioning, scadenza, firma) — §24, §55
- **Cache manager generalizzato** con policy (LRU/TTL/popolarità/scarsità) applicata a contenuti eterogenei (file, servizi, risposte AI) — §27-29
- **Service discovery/registry** (`service://ai`, `service://translation`, ecc.) con annuncio di capability e requisiti — §35-36
- **Integrazione col gateway NOMAD** (traduzione richieste ARALD → API NOMAD) — §37, §70
- **Gateway Internet intermittente** con logica di sync al ritorno della connettività — §38, §71, §74
- **Sync engine per partition tolerance** applicato a cataloghi di contenuti/servizi (non a una chat) — §33-34
- **Resource-aware / energy-aware routing** con funzione di costo multi-metrica — §22, §51
- **Web interface "Internet offline"** (§59-60)

## Vincoli trattati come sperimentali, non come garanzie

- **iOS in background** (§46): iOS 26 introduce la possibilità di attività BLE in background con Live Activity + `CBManager` istanziato, ma questo **non equivale** a un nodo mesh sempre attivo. Ogni scenario (foreground, background, Live Activity, sospeso, app terminata) va misurato empiricamente prima di assumere un comportamento nella progettazione del routing. Fino a verifica, iOS è trattato come client/nodo opportunistico, mai come nodo infrastrutturale.
- **Smartphone come gateway** (§39): teoricamente possibile, ma il primo modello di deployment assume gateway su computer/mini-PC sempre acceso, non su telefono.

## Regola pratica per chi contribuisce

Prima di scrivere codice che "sembra già risolto altrove", controllare questa tabella:

1. Se il componente è nella prima tabella (Project NOMAD as-is) → **non riscriverlo**, integralo dietro il gateway.
2. Se il componente è nella tabella BitChat → **studia il concetto**, implementa da zero nello stack ARALD.
3. Se il componente è nella lista "interamente ex novo" → **è lavoro originale**, non cercare scorciatoie basate su codice esistente.
