# Cosa si riusa, cosa si costruisce ex novo

Questo documento esiste per una ragione precisa: è facile leggere le sezioni 4-5 e 96-99 della [specifica](./SPECIFICATION.md) e concludere che "gran parte del lavoro è già fatta" perché BitChat e Project NOMAD coprono argomenti simili. Non è così. Questa tabella distingue esplicitamente cosa esiste già e può essere preso a riferimento (o integrato as-is) da cosa Nomad-Net deve progettare e implementare da zero.

## Da Project NOMAD — riusabile as-is (nessuno sviluppo Nomad-Net richiesto)

| Componente | Stato | Note |
|---|---|---|
| Kiwix / Wikipedia offline | Esiste, containerizzato | Consumato tramite gateway (§37) |
| Ollama (LLM locale) | Esiste, containerizzato | Consumato tramite gateway (§37) |
| Qdrant / RAG | Esiste, containerizzato | Interno a NOMAD, non esposto direttamente alla mesh |
| Kolibri | Esiste, containerizzato | Consumato tramite gateway |
| Mappe offline / CyberChef / FlatNotes | Esistono, containerizzati | Consumati tramite gateway |
| Command Center / API di orchestrazione | Esiste | Nomad-Net non lo sostituisce, lo chiama |

**Nomad-Net tratta NOMAD come una "black box" dietro un gateway.** Non è previsto (nella prima fase) di modificare il codice di Project NOMAD.

## Da BitChat — concetti architetturali di riferimento, NON codice riusabile as-is

BitChat è scritto per un dominio applicativo diverso (messaggistica peer-to-peer via BLE) e in uno stack diverso da quello scelto per il primo prototipo Nomad-Net (TypeScript/Node.js). Il riuso è **concettuale**: le idee vanno reimplementate nel contesto content-centric di Nomad-Net.

| Concetto BitChat | Cosa va effettivamente riusato | Cosa Nomad-Net deve costruire ex novo |
|---|---|---|
| BLE mesh, peer discovery | Il modello di discovery/annuncio | Un'astrazione di trasporto (§41) che tratti BLE come uno fra più transport intercambiabili, non l'unico |
| Multi-hop relay, controlled flooding, TTL, dedup | La logica generale (decrementa TTL, droppa duplicati, inoltra) | L'implementazione concreta nel routing engine di Nomad-Net (`node/src/routing.ts`), generalizzata a pacchetti *content-aware*, non solo messaggi |
| Source routing | Riferimento di progettazione | Routing evoluto content/service-aware con funzione di costo (§22) — non presente in BitChat, va progettato da zero |
| Fragmentation | Il concetto di chunking | Il formato chunk e la logica di riassemblaggio per contenuti arbitrari (non solo messaggi brevi) — §26 |
| Store-and-forward, persistent outbox, courier, spray-and-wait | Il modello concettuale DTN | L'implementazione completa: coda di consegne pendenti, copy budget, logica courier — nessuna di queste esiste ancora nel codice Nomad-Net (roadmap milestone 12) |
| Gossip sync, GCS filter | Riferimento per la sincronizzazione | Sync engine per **cataloghi di contenuti/servizi** (non cronologia messaggi) — dominio diverso, da progettare (§33, milestone 13) |
| Identità a chiavi crittografiche, sessioni sicure (Noise) | Il modello di identità Ed25519 | L'intero security manager di Nomad-Net (trust levels, firma dei contenuti, rate limiting) — §52-58, nessuna parte è già implementata |
| Dual transport BLE + Nostr | L'idea di un fallback Internet | Nomad-Net usa un modello di gateway generico (§38), non Nostr; da costruire ex novo |
| `BoardManager` (bacheca locale mesh, `bitchat/Services/Board/BoardManager.swift`, https://github.com/permissionlesstech/bitchat, licenza Unlicense/dominio pubblico) — **non** `LocationNotesManager`, la loro seconda feature con un nome simile: quella dipende da relay Nostr esterni + Tor, quindi non è un riferimento concettuale valido per un progetto senza dipendenza da Internet | Il concetto: un post legato a un luogo, firmato, con scadenza e un flag "urgente" che salta la coda di consegna, propagato via broadcast mesh | La feature "drop"/bacheca di Nomad-Net (`node/src/drops.ts`, `docs/security.md` voce #47) — interamente costruita sopra primitive già esistenti (`content://`/`publishContent()`/`CONTENT_ANNOUNCE`/`Priority.EMERGENCY`, non un nuovo `MessageType`), niente tombstone/cancellazione in questa v1 (a differenza di BitChat, il modello di contenuto di Nomad-Net è immutabile per costruzione ovunque) |
| Rotazione del peer ID (`docs/PEER-ID-ROTATION.md`, https://github.com/permissionlesstech/bitchat, licenza Unlicense/dominio pubblico — solo bozza di design, non ancora spedita nemmeno in BitChat) | Il problema che risolve (un osservatore passivo può costruire un grafo di prossimità da un id stabile trasmesso in chiaro) e il principio della soluzione (id derivato dalla chiave privata, legato a una chiave stabile solo dentro un handshake completato) | **Non implementato, solo riferimento** — nota di direzione futura in `docs/security.md` ("Direzione per l'implementazione futura"): richiede prima un handshake di autenticazione che Nomad-Net non ha ancora (l'HELLO di `transports/tcp.ts` non lo è), e `nodeId` qui è già la chiave pubblica grezza usata come chiave primaria in quasi ogni struttura dati — un porting diretto sarebbe più grande che in BitChat, non equivalente; nessuna decisione di implementazione presa |

**In sintesi: nessuna riga di codice di BitChat viene importata.** Il valore di BitChat per questo progetto è come documento di design (in particolare il Whitepaper 2.0) da studiare prima di implementare routing, TTL, dedup e DTN.

## Componenti interamente ex novo (non hanno equivalente diretto né in BitChat né in NOMAD)

Questi sono il vero lavoro di ingegneria di Nomad-Net — nessuna delle due repository di riferimento li fornisce:

- **Content-centric routing** (`content://...` → provider più vicino) — §23-24, §90-92
- **Catalogo distribuito dei contenuti** (metadata, versioning, scadenza, firma) — §24, §55
- **Cache manager generalizzato** con policy (LRU/TTL/popolarità/scarsità) applicata a contenuti eterogenei (file, servizi, risposte AI) — §27-29
- **Service discovery/registry** (`service://ai`, `service://translation`, ecc.) con annuncio di capability e requisiti — §35-36
- **Integrazione col gateway NOMAD** (traduzione richieste Nomad-Net → API NOMAD) — §37, §70
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
2. Se il componente è nella tabella BitChat → **studia il concetto**, implementa da zero nello stack Nomad-Net.
3. Se il componente è nella lista "interamente ex novo" → **è lavoro originale**, non cercare scorciatoie basate su codice esistente.
