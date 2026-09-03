# Deployment

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §8-9, §39-40, §85-86, §103-104.

> Nessuno degli scenari descritti in questo documento è ancora eseguibile in una forma reale/fisica: la logica applicativa di quasi ogni milestone della roadmap (0-7, 12, 13, 15, 16, 20, più i numerosi follow-up in `docs/security.md`) è completa e validata in puro software — store-and-forward, sincronizzazione, cifratura E2E, routing, un gateway NOMAD con più sotto-servizi, un'app mobile, mappe offline, bacheca e chat incluse — ma resta bloccata su forme hardware/Docker/rete reali per le sole milestone 8/9/10/11/14/17/18/19 (BLE fisico, build Android nativa, Project NOMAD via Docker, Wi-Fi Direct, hardware fisico del nodo — vedi [`roadmap.md`](./roadmap.md) per il dettaglio di cosa è bloccato da cosa). Questo documento descrive il *target* di deployment fisico verso cui quel lavoro software è il prerequisito già pronto.

## Principio: nodi infrastrutturali, non "ogni telefono è un router" (§85)

La rete non deve dipendere dalla presenza di migliaia di smartphone sempre attivi come relay. Per ambienti reali devono esistere nodi infrastrutturali fissi (es. in un rifugio: `NODE 1 -> NODE 2 -> NODE 3`); gli smartphone restano nodi opportunistici (client, cache, courier), mai il fondamento dell'infrastruttura.

## Hardware per fase (§9, §86)

| Fase | Hardware | Ruolo |
|---|---|---|
| Prototipo software | Mac / PC | sviluppo, nodo, gateway, simulatore NOMAD tutto sulla stessa macchina |
| Prototipo mobile | Smartphone (Android prioritario, §47) | client, relay opportunistico, courier, cache |
| Nodo permanente | Raspberry Pi | BLE + Wi-Fi + Ethernet, basso consumo, sempre acceso |
| Gateway / NOMAD completo | Mini-PC, **NOMAD-NET PORTABLE** (SSD avviabile) o **NOMAD-NET BOX** (SBC dedicata, vedi sotto) | AI, cache grandi, orchestrazione Docker di Project NOMAD |
| Futuro/ricerca | Hardware radio dedicato (LoRa) | backbone a lunga distanza, fuori scope MVP (§45) |

Il Raspberry Pi **non** è un prerequisito per iniziare (§9): è un'evoluzione, non un punto di partenza.

## Cosa rende un nodo un "gateway" (§8, §38-40)

Un gateway è una funzione software, non un hardware specifico: qualunque nodo con accesso simultaneo a Nomad-Net e a un'altra rete (tipicamente Internet). Nel primo prototipo può essere semplicemente il computer di sviluppo. Non si assume che uno smartphone sia il gateway nel modello di deployment iniziale (§39) per via di consumo batteria, gestione del background da parte del sistema operativo, NAT e instabilità del processo.

## Il modello a due livelli per un rifugio: gateway + "PC" (discussione con l'utente, 30 agosto 2026)

L'obiettivo preferito dall'utente resta un unico dispositivo tutto-in-uno (gateway + rete + servizi + AI locale sullo stesso oggetto, es. un Orange Pi Zero 2W con Ollama incluso), valutato in dettaglio in chat: la CPU delle schede economiche di questa fascia (Cortex-A53, senza NPU/GPU sfruttabile da Ollama) è probabilmente troppo debole per un LLM realmente usabile in modo interattivo, non solo per limiti di RAM — punto non ancora verificato con un benchmark reale, vedi "Non ancora pianificato in dettaglio" più sotto. **Finché questo non è confermato/smentito con una misura concreta**, il modello a due livelli descritto qui resta il piano B di riferimento, già coerente con §8 e §86 della specifica (un gateway è una funzione software, non necessariamente hardware dedicato; il livello "Mini-PC: NOMAD completo, AI, grandi cache" è già distinto dal livello "Raspberry Pi: nodo permanente" fin dalla prima stesura della specifica).

**Cosa fa il gateway** (es. Orange Pi Zero 2W o un router Wi-Fi con OpenWrt, vedi [`guida-hardware-rifugio.md`](./guida-hardware-rifugio.md)): resta acceso 24 ore su 24, crea il Wi-Fi a cui si collegano gli ospiti, fa girare Nomad-Net (routing, cache dei contenuti leggeri, bacheca, mappe, messaggistica), risponde da solo alla quasi totalità delle richieste ordinarie.

**Cosa fa il "PC"** (un mini-PC o computer normale, anche datato — vedi le alternative più economiche sotto): tiene i contenuti pesanti (Kiwix/Wikipedia offline, mappe dettagliate), fa girare Ollama per l'AI locale, e — se il rifugio ha anche una connessione Internet reale — può fare da uscita verso Internet secondo la stessa disciplina già prevista per `service://internet-fetch` (`docs/security.md` voce #45: nessun proxy aperto, allowlist host configurata dall'operatore, rate limiting).

**Dove stanno e come comunicano**: entrambi restano fisicamente al rifugio, sulla stessa rete locale (un cavo o lo stesso Wi-Fi) — non serve mai Internet perché i due si parlino. Il gateway interpella il "PC" solo per le richieste pesanti (una domanda all'AI, un contenuto molto grande); il resto del tempo il "PC" può restare a riposo. Per un ospite con lo smartphone il confine tra i due oggetti è invisibile: si collega a un solo Wi-Fi e vede un solo "Nomad Net del rifugio". Se il "PC" è spento (es. di notte per risparmiare corrente, o un guasto), tutto il resto continua a funzionare — bacheca, mappe, messaggi, contenuti già in cache — solo l'AI e i contenuti che erano *soltanto* sul "PC" non sono disponibili fino a quando non torna acceso.

## Il NOMAD Hub come sistema portatile (SSD avviabile) — valutato dall'utente con il proprio socio, 31 agosto 2026

**Decisione architetturale**: il ruolo "PC"/"NOMAD server" del modello a due livelli sopra non deve legarsi a un computer specifico. L'intero ambiente software di Project NOMAD (sistema operativo, Docker, i suoi container, dati, modelli AI) vive su un **SSD USB esterno avviabile**; qualunque computer compatibile che lo monta ed esegue il boot da quell'unità diventa temporaneamente il NOMAD Hub. Il computer in sé non è "il NOMAD Hub" — è solo l'host hardware che lo esegue in quel momento. Coerente con §8/§86 della specifica, che già distingue "gateway come funzione software" da un hardware dedicato: questa decisione applica lo stesso principio al ruolo "PC" del modello a due livelli, non solo al "gateway".

```
                 NOMAD SSD
        Ubuntu + Docker + NOMAD
                    │
        ┌───────────┼───────────┐
        │           │           │
      Acer       Mini-PC      altro PC
        │           │           │
        └───────────┼───────────┘
                    │
                NOMAD Hub
```

**Due scenari d'uso**:

1. **PC compatibile trovato sul posto** (scenario prioritario): si collega l'SSD via USB, si avvia il PC da quell'unità, Ubuntu/Docker/NOMAD partono in automatico — nessuna installazione sul computer ospite, il suo sistema operativo e i suoi dati restano invariati. Requisiti della prima build: architettura **x86-64/AMD64**, boot da USB supportato, RAM minima richiesta da NOMAD, USB3 preferibile (non bloccante — più lento su USB2), Wi-Fi o Ethernet.
2. **Mini-PC headless dedicato**: SSD + mini-PC compatibile + alimentatore, nessun monitor/tastiera/mouse — amministrato interamente dalla rete locale, con lo smartphone come dispositivo di controllo.

**Nota pratica, non bloccante ma da tenere presente per lo scenario 1**: molti PC moderni hanno il Secure Boot attivo di default, che può impedire l'avvio da un'unità esterna non firmata finché non viene disattivato dal BIOS/UEFI (a volte protetto da password) — un passo che richiede comunque un minimo di competenza tecnica e accesso fisico al menu di boot (F2/F12/Esc a seconda del produttore), quindi "qualsiasi PC compatibile trovato sul posto" nella pratica richiede o un PC con Secure Boot già disattivabile facilmente, o qualcuno capace di farlo. Da tenere distinto dal cambiare permanentemente l'ordine di boot nel BIOS (da evitare: lascerebbe il PC host incapace di avviare il proprio sistema senza l'SSD collegato) — la selezione del dispositivo di boot va fatta una tantum dal menu rapido, non salvata in modo permanente.

**Smartphone come pannello di controllo — sistema distinto dalla UI mobile di Nomad-Net, ora implementato** (`nomad-hub/`, `docs/security.md` voce #52, 1 settembre 2026): la Control UI/**NOMAD Management API** amministra Docker (stato/avvio/arresto/riavvio/log dei container) sull'host su cui gira Project NOMAD, con una password dedicata separata dalla password di rete della mesh — un livello di infrastruttura sotto Project NOMAD stesso, non un servizio della mesh. A differenza del resto di questa sezione (packaging SSD-avviabile, vedi sotto), questo pezzo **non** richiede il sorgente di Project NOMAD né hardware fisico: parla solo con la Docker Engine API (interfaccia esterna stabile) e con funzionalità di sistema operativo, quindi è genuinamente buildabile in questo repository — a differenza di CPU/RAM/storage/AI/radio della v1 della specifica originale, non ancora implementati (candidati per un'estensione futura, non pianificati). È un sistema **separato** dall'app mobile/`WebUiServer` di Nomad-Net (spec §59): quest'ultimo mostra lo stato della *mesh* (vicini, contenuti, servizi via `service://...`) e non ha né deve avere alcun accesso a Docker o al sistema operativo dell'host — la stessa separazione controllo/infrastruttura che la specifica del NOMAD Hub descrive al punto 4 si applica quindi due volte, non una: gateway Nomad-Net e NOMAD Hub restano due sistemi distinti anche nel loro rispettivo pannello di controllo, con pagine mobile separate (`mobile/www/index.html` contro `mobile/www/hub-control.html`, mai linkate l'una dall'altra) e credenziali mai condivise.

**Principi architetturali** (riassunti dalla specifica valutata con il socio): il disco contiene tutto il necessario per essere autonomo (Ubuntu Server, Docker Engine/Compose, NOMAD Core/Gateway/Web UI/DB, configurazioni, dati, modelli AI, software radio, script di bootstrap) sotto una struttura simile a `/opt/nomad/` (`compose/`, `config/`, `data/{database,content,cache,index}/`, `models/`, `radio/`, `logs/`, `backups/`) senza dipendenze da percorsi specifici del computer ospite; ogni componente Project NOMAD è un container Docker separato (`nomad-core`, `nomad-gateway`, `nomad-web`, `nomad-db`, `nomad-storage`, `nomad-ai`, `nomad-radio`, `nomad-monitoring`), con AI e radio moduli opzionali che non impediscono l'avvio del Core se assenti/disattivati; l'avvio automatico (BIOS/UEFI → SSD → Ubuntu → Docker → bootstrap NOMAD → servizi disponibili) verifica rete/spazio/RAM/Docker/container/database/moduli opzionali, segnalando ciò che manca senza bloccare l'avvio di ciò che invece è pronto; la prima build è x86-64 (compatibile con l'Acer e la maggior parte dei PC/mini-PC), con una build ARM64 (Raspberry Pi, Orange Pi, NanoPi e altri SBC) prevista in futuro tramite immagini Docker multi-architecture, quando possibile; un livello concettuale "NOMAD Host" astrae CPU/RAM/storage/rete/USB/hardware opzionale così il Core non deve mai essere sviluppato per un modello di PC specifico, aprendo in futuro anche la strada a un "NOMAD Box" dedicato senza riscrivere il software applicativo.

**Fuori dallo scope di questo repository** (eccetto la Control UI/Management API sopra, ora implementata — `nomad-hub/`): il resto descrive il **confezionamento di Project NOMAD stesso** (sistema operativo, Docker, orchestrazione, driver radio) — un progetto esterno e separato (`docs/reuse-vs-new.md`), di cui questo repository non contiene il codice sorgente e che la specifica stessa definisce "non dichiarato stabile" (§4). Il gateway Nomad-Net (`gateway/nomad/`) continua a funzionare esattamente come oggi verso qualunque istanza NOMAD raggiungibile via HTTP sulla rete locale, a prescindere da come quell'istanza è stata avviata — nessun contratto (`service://ai`, `service://kiwix-search`, ecc.) cambia. Questa sezione resta quindi in gran parte **documentazione di riferimento/pianificazione**, come il resto di questo file: non ci sono script di bootstrap, `docker-compose.yml` o immagini da costruire qui — la differenza rispetto a prima è che la Control UI, verificato non richiedere nessuno di questi, è passata da pianificata a reale.

Questo cambia anche la lettura della tabella "Alternative hardware più economiche" sotto: non è più necessario scegliere in anticipo *quale* dispositivo comprare per il ruolo "PC" — un SSD avviabile funziona su qualunque host x86-64 compatibile già disponibile (l'esempio concreto valutato dall'utente: un SSD Netac da 250 GB, avviato su un PC Acer esistente come piattaforma di sviluppo — non un investimento vincolato a quella specifica macchina, spostabile su un host migliore in futuro senza rifare nulla). Le righe della tabella restano comunque utili per chi deve *anche* comprare l'host (non ne ha già uno compatibile a disposizione), o per valutare l'accelerazione AI.

### NOMAD-NET BOX e PORTABLE — due deployment target paritetici (specifica ricevuta dall'utente, 2 settembre 2026)

L'utente ha fornito una specifica architetturale completa che formalizza quanto sopra sotto due nomi propri e aggiunge un secondo target concreto — analizzata e discussa con l'utente prima di essere integrata qui, restando **documentazione di riferimento**, stesso trattamento della sezione precedente (nessun codice, nessun sorgente Project NOMAD in questo repository).

**Terminologia — da non confondere con `nomad-hub/` di questo repository**: la specifica chiama i due deployment target di Project NOMAD **NOMAD-NET BOX** e **NOMAD-NET PORTABLE**, mai "NOMAD Hub". Il termine "NOMAD Hub" in questo progetto indica invece `nomad-hub/`, la Management API di questo repository (`docs/security.md` voce #52) che amministra Docker su *qualunque* host esegua Project NOMAD — funziona identica sotto BOX o PORTABLE, senza bisogno di alcuna modifica: parla solo con la Docker Engine API, mai con un'assunzione su quale SBC/PC la ospiti.

**NOMAD-NET PORTABLE** — coincide con quanto già descritto sopra ("Il NOMAD Hub come sistema portatile"): stesso Netac Portable SSD 250 GB di riferimento, stesso principio "l'host è hardware sostituibile, l'ambiente NOMAD vive sull'SSD". La specifica non cambia nulla di sostanziale qui, solo il nome formale del target.

**NOMAD-NET BOX** — concetto nuovo: un dispositivo dedicato singolo che esegue l'intero stack (Core/Gateway/Web UI/DB/AI/Radio) in modo permanente, senza SSD esterno né host da "prendere in prestito". Hardware di riferimento per il prototipo, fornito dall'utente:

| Componente | Riferimento |
|---|---|
| SBC | Orange Pi 4 Pro, 4 GB LPDDR5 |
| CPU | Allwinner A733, 2× Cortex-A76 + 6× Cortex-A55 |
| NPU | 3 TOPS |
| Storage principale | NVMe M.2 2280, 256 GB, PCIe 3.0 (M-Key) — riferimento consigliato: Samsung PM981a MZ-VLB256B; per un SSD usato, preferibile ≥90% salute SMART; NAND TLC preferita; budget indicativo 20-30 € — non serve velocità premium, il collegamento PCIe della scheda non la giustifica |
| Rete | Wi-Fi 6, Bluetooth 5.4, Gigabit Ethernet |
| USB | almeno una porta USB 3.0 |
| Alimentazione | USB-C 5V/3A |
| Boot secondario | microSD, se necessaria per bootloader/configurazione iniziale |
| Raffreddamento | dissipatore + ventola consigliati per carichi continui |

Il Netac Portable SSD non serve per il BOX — è l'alternativa PORTABLE, non un componente aggiuntivo.

**Due avvertenze esplicite prima di prendere questo hardware come raccomandazione, non solo come riferimento del prototipo**:

1. **Il chip "Allwinner A733" non è stato verificato in modo indipendente in questa sessione** — nessun accesso a internet reale per confermarne la scheda tecnica esatta (stessa limitazione già segnalata per ogni altro dato hardware in questi file). Documentato come fornito, non come fatto verificato.
2. **BOX riapre, non risolve, la domanda del benchmark AI reale** già segnalata aperta in "Non ancora pianificato in dettaglio" sotto: un NPU da 3 TOPS è nella stessa situazione già descritta per il Rockchip RK3588 nella tabella "Alternative hardware" sotto — **Ollama non lo sa usare nativamente**, servirebbe un runtime specifico del produttore e modelli preparati apposta. BOX è quindi un candidato concreto e più potente del Orange Pi Zero 2W originariamente considerato (CPU big.LITTLE 2×A76+6×A55 contro un semplice Cortex-A53), ma non sostituisce il benchmark reale mai eseguito — solo gli dà un hardware specifico su cui eseguirlo, il giorno in cui sarà disponibile.

**Relazione con gli altri modelli già documentati**: BOX **non sostituisce** il modello a due livelli (gateway + "PC") né la tabella "Alternative hardware" sotto — la riga "Gateway con NPU incorporato" di quella tabella (Orange Pi 5/Radxa Rock 5C, RK3588) resta valida come categoria, e BOX ne è ora un'istanza concreta e completamente specificata. Restano quindi **tre opzioni parallele** per il ruolo "PC"/hardware AI di un deployment, nessuna esclusiva: (a) modello a due livelli con mini-PC usato/ricondizionato, (b) NOMAD-NET PORTABLE (SSD avviabile) su un host x86-64 già disponibile, (c) NOMAD-NET BOX come dispositivo dedicato singolo. La scelta tra le tre resta condizionata dallo stesso benchmark hardware reale mai eseguito.

**Espansione correlata, documentata separatamente**: **NOMAD-NET BEACON** (`docs/beacon.md`, proposta ricevuta dall'utente il 3 settembre 2026) è un terzo ramo del progetto nello stesso spirito di BOX/PORTABLE — dispositivi fisici dedicati per un ecosistema di richiesta soccorso, ora centrati sulla **NOMAD Card** (un unico hardware in formato carta di credito, configurabile via firmware in modalità Beacon/Relay/Beacon+Relay — l'utente ha successivamente scelto di unificare così quanto originariamente proposto come due dispositivi distinti, Beacon e Mobile Relay) più il **Fixed Relay** (stessa architettura, installazione permanente) — ma a differenza di BOX/PORTABLE (confezionamento di Project NOMAD, un progetto esterno) si appoggiano in buona parte a meccanismi già presenti in *questo* repository (priorità EMERGENCY, firma Ed25519, store-and-forward, rate limiting, transport BLE/LoRa simulati). Tenuti in un documento a parte perché descrivono dispositivi diversi (Beacon/Relay/Emergency Node) con un proprio protocollo di messaggio, non un'altra forma di packaging del "NOMAD Hub"/"PC" di questa sezione.

**Hardware Abstraction Layer / Capability Manager** (principio architetturale della specifica, concetto non ancora implementato in Project NOMAD né richiesto a questo repository): il software non deve assumere CPU/RAM/GPU/NPU/rete/USB specifici — un processo di *hardware detection* al boot produce un "NOMAD Hardware Profile" (JSON con architettura, core CPU, RAM, presenza GPU/NPU/Wi-Fi/Bluetooth/Ethernet/USB3/storage) usato per scegliere automaticamente profilo AI e servizi attivi, con degradazione controllata (`missing capability ≠ system failure`: niente Wi-Fi → solo Ethernet, niente NPU → AI su CPU/GPU, niente radio → servizio radio disattivato, RAM bassa → profilo AI ridotto, nessun componente opzionale può impedire l'avvio del Core). Concettualmente coerente con quanto già scritto sopra ("un livello concettuale 'NOMAD Host' astrae CPU/RAM/storage/rete/USB... così il Core non deve mai essere sviluppato per un modello di PC specifico") — la nuova specifica lo rende più esplicito e operativo (un JSON concreto, una matrice di test per capability), ma resta comunque nel perimetro di Project NOMAD, non di questo repository.

### Alternative hardware più economiche di "gateway + PC intero"

Valutate in chat il 30 agosto 2026, nessuna ancora scelta come raccomandazione definitiva:

| Opzione | Costo indicativo | Un solo oggetto? | Note |
|---|---|---|---|
| **Gateway con NPU incorporato** (es. Orange Pi 5 / Radxa Rock 5C, chip Rockchip RK3588, 4-8 GB — ora anche **NOMAD-NET BOX**, Orange Pi 4 Pro/Allwinner A733 3 TOPS, vedi "NOMAD-NET BOX e PORTABLE" sopra per la configurazione completa) | 70-110 € | Sì | Più vicino all'idea "tutto in uno"; **ma Ollama non sa usare l'NPU così com'è** — servirebbe il runtime specifico del produttore (RKLLM o equivalente) e modelli preparati apposta, complessità software reale da valutare, non solo un acquisto diverso |
| **Gateway + mini-PC usato/ricondizionato** (es. un Intel NUC o thin client aziendale dismesso) | 50-100 € per il "PC", più il gateway | No — resta il modello a due livelli, ma la parte cara costa poco | La RAM qui **è davvero espandibile** (slot SO-DIMM reali, a differenza di qualunque SBC economica, dove la RAM è sempre saldata) — un processore x86 anche datato resta più efficiente su carichi come llama.cpp di un Cortex-A53. Stesso Ollama di sempre, nessuna complessità software aggiuntiva |
| **Gateway + accelleratore USB dedicato** (es. Hailo-8) | 100-150 € solo l'accelleratore, più il gateway | Sì | Google Coral **scartato esplicitamente**: pensato per visione artificiale (classificazione immagini), non adatto a un modello di linguaggio. Hailo-8 più adatto in teoria ma il risparmio rispetto alle opzioni sopra si riduce, e resta da configurare/verificare |
| **Solo gateway, AI aggiunta in un secondo momento** | sotto i 100 € oggi | Sì (per ora) | Bacheca, mappe, messaggi, contenuti in cache funzionano comunque da subito; l'AI diventa un pezzo opzionale aggiungibile dopo (con una qualunque delle opzioni sopra), senza dover buttare via nulla di quanto già installato |

## Pilot: rifugio alpino (§103, caso d'uso prioritario §6.2)

Per la componentistica minima e le istruzioni passo passo di installazione/gestione di un singolo nodo fisso (comprensibili anche a un operatore senza competenze informatiche o elettroniche, es. il gestore del rifugio) vedi [`guida-hardware-rifugio.md`](./guida-hardware-rifugio.md).

Configurazione target, nei termini del modello a due livelli sopra:

- 1 "PC"/mini-PC per i contenuti pesanti e l'AI locale (il "NOMAD server" — Docker, corrisponde alla "cucina" della spiegazione sopra; idealmente **NOMAD-NET PORTABLE** — un SSD avviabile con l'intero ambiente NOMAD, così l'host fisico diventa intercambiabile — o **NOMAD-NET BOX** come dispositivo dedicato, vedi "NOMAD-NET BOX e PORTABLE" sopra per entrambe le opzioni)
- 1 gateway sempre acceso rivolto agli ospiti (può coincidere fisicamente con il "PC" solo se si verifica che l'hardware scelto regge entrambi i ruoli, vedi sopra — altrimenti restano due dispositivi distinti sulla stessa rete locale)
- 2-3 nodi fissi (Raspberry Pi / mini-PC) per estendere la copertura BLE/Wi-Fi
- 10-50 smartphone come client opportunistici

Contenuti tipici: mappa, sentieri, informazioni rifugio, numeri utili, manuali, bollettini meteo dell'ultimo aggiornamento, documentazione di sicurezza, AI locale.

Sequenza di test target: Internet attivo → sincronizzazione iniziale → Internet spento → accesso ai contenuti dalla mesh → messaggistica → spostamento utenti tra nodi → riavvio di un nodo → perdita permanente di un nodo → ritorno di Internet → risincronizzazione.

## Pilot: emergenza (§104, caso d'uso §6.1)

Scenario: Internet e rete cellulare assenti, alcuni nodi spenti, alcuni nodi mobili (courier), packet loss elevato, rete divisa in segmenti che si ricollegano nel tempo.

Metriche da raccogliere (vedi anche §76-79): tempo di discovery, percentuale di messaggi consegnati, percentuale di contenuti disponibili, tempo di sincronizzazione tra segmenti, consumo batteria, traffico generato, numero medio di hop.

## Pilot: eventi affollati (§6.4)

A differenza di rifugio ed emergenza, qui la mesh **non sostituisce** la connettività ma la **moltiplica**: lo scenario presuppone un gateway con accesso a Internet reale (spec: "Nodi collegati a Internet + rete locale distribuita"), usato per raggiungere in scala migliaia di dispositivi su un sito con copertura cellulare probabilmente satura, non per sopravvivere alla sua assenza. È il caso d'uso più vicino a ciò che Nomad-Net fa già bene senza modifiche: contenuto statico pubblicato una volta e replicato via `CONTENT_ANNOUNCE` (voce #34) o canali pubblici (voce #40), letto da un numero di client molto più alto (migliaia, non decine) ma per una durata breve (la durata dell'evento, non un deployment permanente).

Configurazione target: 1+ gateway con Internet reale che fa anche da sorgente di sincronizzazione iniziale, alcuni nodi fissi/portatili sparsi sul sito per estendere la copertura Wi-Fi/BLE nelle zone morte, migliaia di smartphone come client opportunistici. Contenuti tipici: programma, mappe del sito, lineup, FAQ, orari, istruzioni, sicurezza — tutti statici, adatti al pattern content-addressed già esistente, nessun nuovo servizio necessario.

## Pilot: scuole (§6.5)

Rispetto a rifugio/eventi, lo scenario è più stabile e meno esigente sul lato rete: un solo edificio, utenti che tornano ogni giorno (stessa base predicibile), nessun bisogno di store-and-forward multi-hop esteso perché tutti i dispositivi restano vicini fisicamente. L'enfasi è sulla dimensione e stabilità nel tempo del catalogo statico (libri, Wikipedia offline, corsi, mappe, documentazione — spec §6.5), non sulla resilienza a partizioni di rete.

Configurazione target: 1 nodo gateway fisso con lo stesso ruolo del "PC"/mini-PC del rifugio (Kiwix/Wikipedia offline via `KiwixGateway`, AI locale via `AiGateway`/Ollama — nessun nuovo servizio necessario), eventualmente 1-2 nodi di estensione per la copertura dell'edificio, decine/centinaia di smartphone e tablet studenteschi come client.

## Pilot: spedizioni / navi / ambienti remoti (§6.6)

Molto vicino al modello già descritto per rifugio ed emergenza (nodo/i autosufficienti, nessuna connettività esterna) — la differenza principale è che qui l'intero cluster di nodi **viaggia** insieme al gruppo, senza il "ritorno di Internet" periodico che un rifugio può avere quando qualcuno scende a valle: l'assenza di connettività va pianificata per l'intera durata della spedizione (settimane/mesi), non come un'interruzione temporanea. Configurazione target: essenzialmente la stessa del pilot rifugio (gateway + "PC" per contenuti pesanti/AI), dimensionata per autosufficienza energetica prolungata (pannello solare/generatore) e con tutti i contenuti caricati una volta prima della partenza, dato che non c'è modo di aggiungerne altri in corsa. Il ruolo "PC" come **NOMAD-NET PORTABLE** (sopra) si adatta particolarmente bene qui: l'unico oggetto da portare per quel ruolo è l'SSD stesso, avviabile su qualunque computer di bordo compatibile già presente sulla nave/spedizione, senza dover trasportare un mini-PC dedicato in più. **NOMAD-NET BOX** resta l'alternativa quando non c'è alcun computer di bordo compatibile da usare: un dispositivo dedicato singolo, più ingombro da trasportare ma senza dipendere dalla disponibilità di un host sul posto.

## Oltre i pilot sopra: scenari applicativi più ampi (`docs/beacon.md`)

L'ecosistema NOMAD-NET BEACON (NOMAD Card — Beacon/Relay/Beacon+Relay Mode —, Fixed Relay, Relay Registry — `docs/beacon.md`) non ha alcuna dipendenza specifica dal contesto alpino dei pilot sopra: la caratteristica che lo rende applicabile è l'assenza di connettività affidabile, non il luogo. `docs/beacon.md` (sezione "Ambito di applicazione: oltre il rifugio alpino") elenca altri scenari coerenti con la stessa architettura senza richiedere lavoro software aggiuntivo — foreste e grandi aree naturali, deserti e aree remote, aree rurali e comunità isolate, disastri naturali, mare/coste/isole, aree di crisi o infrastrutture temporanee — nessuno dei quali è ancora un pilot dedicato in questo file, stesso trattamento già riservato a "Comunità locali" sotto.

## Comunità locali (§6.7) — nessun pilot dedicato per ora

La specifica stessa segnala questo come "caso d'uso più debole come primo prodotto, per l'esistenza di alternative quando Internet funziona" (§6.7) — non un candidato su cui investire lavoro preventivo. Le funzionalità richieste (bacheca, chat, file, documenti, comunicazioni, informazioni locali) sono già tutte disponibili come funzionalità generali della mesh (Bacheca/drops voce #47, Canali pubblici voce #40, Gruppi cifrati voce #42, contenuti via `content://`): un eventuale deployment "di quartiere" userebbe gli stessi nodi già pronti per rifugio/emergenza, senza richiedere alcun lavoro software dedicato. Da riprendere solo se emergesse una richiesta concreta.

## Non ancora pianificato in dettaglio

**Benchmark hardware reale, prerequisito per scegliere tra "tutto in uno" e il modello a due livelli sopra**: non ancora eseguito in questo ambiente (nessun accesso a hardware fisico). Servirebbe far girare un modello Ollama minimo (~0.5-1B parametri, quantizzato) su hardware reale, misurando token/secondo sotto carico concorrente (mentre 2-3 telefoni scaricano contenuti dalla mesh contemporaneamente, non isolato) — è l'unico modo per sapere se l'opzione "tutto in uno" è davvero percorribile o se conviene il modello a due livelli fin da subito. **NOMAD-NET BOX** (Orange Pi 4 Pro/Allwinner A733, sopra) dà ora un candidato concreto e più potente del Orange Pi Zero 2W originariamente considerato — ma il benchmark su di esso resta da fare, non è stato eseguito qui. Il NOMAD Hub portatile su SSD (**NOMAD-NET PORTABLE**, sopra) non elimina questo prerequisito, lo sposta solo: qualunque host x86-64 finisca per eseguire l'SSD (l'Acer di sviluppo o un altro) deve comunque avere CPU/RAM sufficienti per Docker + i container NOMAD attivi contemporaneamente — un problema di dimensionamento reale, indipendente da quale specifico computer viene usato.

**Bootstrap/packaging del NOMAD Hub (Ubuntu+Docker su SSD avviabile, script di avvio automatico, immagini Docker)**: descritto come piano di riferimento sopra, non ancora costruito né testato — richiede sia hardware fisico sia l'accesso al codice sorgente di Project NOMAD (repository esterno, non incluso qui) per scrivere `docker-compose.yml`/script di bootstrap reali, nessuno dei due disponibile in questo ambiente.
