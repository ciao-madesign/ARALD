# Prossimi passi

Riferimento: [`docs/roadmap.md`](./roadmap.md) per lo stato di tutte le milestone (0-20) e la tabella del "secondo giro" post-audit — non ripetuti qui. Questo documento elenca solo i candidati **ancora aperti** più un pointer a `docs/security.md` per ogni voce completata (dettaglio tecnico: cosa è stato fatto, perché, bug trovati dalla revisione), invece di ripeterne il contenuto. Per la stessa lista in linguaggio semplice e non tecnico, vedi [`docs/audit-report.html`](./audit-report.html).

## Come leggere questo documento

Per ciascuna opzione ancora aperta: cosa costruire, file coinvolti, prerequisiti, criteri di accettazione (come si verifica che è fatta), rischi principali, sforzo relativo.

---

## Opzione A — BLE transport (roadmap Milestone 8)

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

---

## Opzione B — Gateway NOMAD (roadmap Milestone 10-11)

**Cosa costruire**: `gateway/nomad/`, un processo che espone al mesh ARALD (tramite un `NomadNode` locale, stesso transport TCP già validato) le stesse API `content://...` / `service://...` già testate, risolvendo però le richieste chiamando le API HTTP di un'istanza reale di Project NOMAD (es. Kiwix) invece di leggere da un `ContentStore` locale statico.

**Prerequisiti**: un'istanza di Project NOMAD funzionante e raggiungibile via Docker (richiede un ambiente Docker + sistema Debian-based o container Linux compatibile, spec §4). **Stato: bloccata — nessun ambiente Docker/Project NOMAD disponibile in questa sessione.**

**Criteri di accettazione**: un `NomadNode` con questo gateway attivo risponde a una `CONTENT_QUERY` per un articolo Kiwix reale con lo stesso ciclo `CONTENT_FOUND` → `CONTENT_REQUEST` → `CONTENT_CHUNK`* → `CONTENT_COMPLETE` già coperto dai test esistenti, servendo dati reali invece che contenuto pubblicato via `publishContent()`.

**Rischi principali**: Project NOMAD "non dichiarato stabile" (spec §4) — la sua API potrebbe cambiare sotto i piedi; il setup Docker è un prerequisito ambientale non garantito.

**Versione simulata — ✅ fatta** (`docs/security.md` voci #9/#10): `KiwixGateway`/`AiGateway` verificati contro `FakeNomadServer`/`FakeOllamaServer` locali, stesso adapter e stesso protocollo esposto che punterebbe a un'istanza reale quando disponibile — **resta bloccata solo la forma Docker/Project NOMAD reale**.

---

## Milestone completate con un piano d'azione dedicato a suo tempo

Le Opzioni C-G furono scritte quando le rispettive milestone erano ancora aperte; oggi sono tutte ✅ complete e il loro stato reale vive in `docs/roadmap.md` — tenute qui solo come titolo + pointer, per non duplicarne il contenuto:

- **Opzione C — Store-and-forward** (Milestone 12) ✅ — `docs/roadmap.md`, "Milestone 12 — store-and-forward: dettagli e limitazione nota".
- **Opzione D — Partition sync** (Milestone 13) ✅ — `docs/roadmap.md`, "Milestone 13 — partition sync: dettagli".
- **Opzione E — Firma dei contenuti, trust levels, rate limiting, cifratura E2E** (Milestone 15) ✅ — `docs/roadmap.md`, "Milestone 15 — sicurezza: dettagli".
- **Opzione F — Relay policy legata a batteria/carica e routing a costo distance-vector** (Milestone 16) ✅ — `docs/roadmap.md`, "Milestone 16 — relay policy e routing a costo: dettagli".
- **Opzione G — Simulatore di rete** (Milestone 20) ✅ — `docs/roadmap.md`, "Milestone 20 — simulatore: dettagli".

---

## Opzione H — App mobile (roadmap Milestone 9) — pianificazione, su richiesta esplicita dell'utente

**Decisioni già prese con l'utente** (non da rimettere in discussione senza un motivo nuovo):
1. **Client leggero verso un gateway**, non un nodo ARALD completo sul telefono: l'app non reimplementa routing/cache/firma — si connette a un nodo ARALD già esistente (il computer che oggi fa da gateway, con la web UI di spec §59 già costruita) e ne è un'interfaccia, più uno stack di connettività.
2. **Raggiungibilità sia via Wi-Fi/rete locale sia via Bluetooth** — non solo Wi-Fi.
3. **Framework ibrido** (Capacitor), non nativo Android puro — adeguato perché il telefono si connette *a* un gateway (ruolo BLE centrale, il gateway è la periferica), mai il contrario; la scelta andrebbe rivista solo se in futuro due telefoni dovessero parlarsi direttamente senza gateway in mezzo.

### Passo 1 — Client Wi-Fi/TCP verso un gateway esistente — ✅ fatto

App Capacitor (`mobile/`, vedi `mobile/README.md`) verso `WebUiServer`/`POST /api/call`, verificata end-to-end con un browser reale (pairing Wi-Fi-style, dashboard, chiamata servizi, ricerca). **Prerequisito residuo**: la compilazione Android nativa (`./gradlew assembleDebug`) non è completabile in questo ambiente — richiede l'Android Gradle Plugin da `dl.google.com`, bloccato dalla policy di rete (verificato, non ritentare); il progetto Gradle è comunque generato e committato. Dettaglio completo: `docs/security.md` voci #22/#23/#24.

### Passo 2 — Connettività Bluetooth dal telefono — lato telefono ✅ fatto, lato gateway/Clip bloccato su hardware reale

Lato telefono (scan/connect/handshake verso una ARALD Clip/Cover, logica di protocollo unit-testata): fatto, `docs/security.md` voce #62. **Prerequisito ancora aperto**: un dispositivo con hardware BLE reale dal lato gateway/Clip che parli ARALD — stesso blocco dell'Opzione A, nessuna verifica end-to-end possibile finché non è disponibile.

### Debito di design della UI mobile — ✅ affrontato, con affinamenti successivi

Passata di design completa (icone SVG, gerarchia visiva, transizioni, accessibilità — voce #28), poi un rebrand "Waypoint" (#31), un affinamento con tipografia auto-ospitata/elevazione/animazioni (#50), e una passata UX per un pubblico generico e non tecnico (#48). Nessun restyling ulteriore in sospeso. Resta fuori portata in questo ambiente, invariato: la verifica su un telefono reale o un emulatore (nessun hardware/SDK Android disponibile).

## Cosa resta possibile in puro software, se si vuole andare oltre

Le versioni **hardware/Docker reali** di BLE (Opzione A) e del gateway NOMAD (Opzione B) restano gli unici due candidati bloccati su prerequisiti esterni — le rispettive versioni simulate/mockate sono complete (vedi sopra). Un candidato reale emerso dalla revisione di una voce passata — **`ContentStore` senza limite di dimensione** — è stato risolto con una voce dedicata (`docs/security.md` voce #32, `BoundedFifoMap` con eviction pesata sulla fiducia).

## Come procedere

Le opzioni A (BLE) e B (gateway NOMAD) restano bloccate sui prerequisiti ambientali originali (hardware fisico; Docker + Project NOMAD) **solo per la loro forma realistica finale** — le rispettive versioni simulate hanno nel frattempo validato la logica applicativa come lavoro in puro software. Quando hardware/Docker saranno disponibili, il codice del transport/gateway reale si aggiunge dietro la stessa interfaccia già validata dalla versione simulata, senza dover ripartire da zero.

---

## Feature completate — pointer al dettaglio in `docs/security.md`

Le proposte sotto sono state valutate, pianificate e implementate per intero. L'analisi che le ha precedute e il dettaglio tecnico completo (bug trovati dalla revisione inclusi) vivono nelle rispettive voci di `docs/security.md`, non ripetuti qui.

- **Opzione I — Nomad News evoluto**: parser RSS/Atom scritto da zero (#33), livelli headline/summary/articolo completo (#35), digest generato componendo `service://ai` (#37), `service://emergency-news` con classificatore di priorità (#39, follow-up #41), il prerequisito architetturale condiviso — `MessageType.CONTENT_ANNOUNCE`, broadcast per contenuto singolo (#34). Completa per intero. Bloccato su prerequisiti esterni indipendentemente da questo piano: fonti RSS/Wikinews reali, un LLM reale per il digest.
- **Opzione J — Messaggistica (stile BitChat) e tracciamento posizione**: chat 1:1 (#36), canali pubblici non cifrati (#40), chat private/di gruppo cifrate a membership fissa (#42), tracciamento posizione opportunistico con nodo registro dedicato (#44). Completa per intero.
- **Opzione K — "Internet senza Internet"** (`service://internet-fetch`, `gateway/nomad/internet-gateway.ts`, guardia SSRF in `url-safety.ts`) — #45.
- **Opzione L — Mappe topografiche offline** (`node/src/map-tiles.ts`, `mobile/www/mapview.js`) — #46.
- **Opzione M — Bacheca "drop" mesh-native**, ispirata a `BoardManager` di BitChat (`node/src/drops.ts`) — #47.
- **Opzione N — Transport LoRa simulato**, affiancato a BLE (`node/src/transports/lora.ts`, `transports/simulated-link.ts` estratto da `ble.ts`) — #51.

## Espansioni successive al piano d'insieme, documentate altrove

Le espansioni proposte e realizzate dopo il completamento delle Opzioni A-N — l'ecosistema **ARALD Card** (Beacon/Relay Mode) + Fixed Relay + Relay Registry, l'**Emergency Portal** (`arald-backend/`/`local-portal/`/`mirror-portal/`), la roadmap di validazione sul campo (fasi/budget/partner/effetto di rete), il protocollo di test tecnico (fasi 0-8) — sono documentate rispettivamente in [`docs/beacon.md`](./beacon.md), [`docs/emergency-portal.md`](./emergency-portal.md), [`docs/emergency-rescue-network.md`](./emergency-rescue-network.md), [`docs/test-protocol.md`](./test-protocol.md). Non ripetute qui, coerentemente con il principio "un fatto, una fonte" di questo repository.

## Relay Bluetooth telefono↔telefono senza Clip — candidato aperto, non ancora pianificato

**Richiesta esplicita dell'utente, 8 settembre 2026**: gli smartphone devono poter fare da relay Bluetooth l'uno per l'altro senza bisogno di una ARALD Clip di mezzo, con il vincolo esplicito che non ci siano blocchi tra i dispositivi (pena l'interruzione della mesh). Non ancora pianificato: la richiesta espone un vincolo tecnico reale, non aggirabile in codice — `@capacitor-community/bluetooth-le` (in uso oggi) è central-only, e due telefoni entrambi "solo centrale" non possono collegarsi direttamente via BLE reale.

Ricerca di approfondimento fatta su richiesta dell'utente ("solo ricerca/design per ora", nessuna implementazione): vedi `mobile/README.md`, sezione "Lato periferica: indagato, non costruito" → follow-up dell'8 settembre 2026, per il dettaglio completo (candidato `@capgo/capacitor-bluetooth-low-energy`, punto critico irrisolto sulla contemporaneità reale dei due ruoli, alternativa strutturale — framework mesh dedicati — non approfondita), e conferma che Card/Clip/Fixed Relay **non** hanno questo problema (BLE sempre periferica verso il telefono, traffico Card↔Card via LoRa).

**Design definito** (stesso documento, sezione "Design proposto"): switch evento-guidato centrale/periferica basato su necessità di invio (non un duty-cycle a tempo fisso) — a riposo sempre periferica, qualunque invio locale passa a centrale accettando il drop delle connessioni periferica attive, backoff randomizzato 30-45s se nessun peer trovato, ciclo di retry limitato con fallback alla coda passiva esistente oltre il limite. Decisioni prese con l'utente, nessun codice scritto. Prerequisito prima di implementare: ok esplicito dell'utente, stesso workflow a doppio check di ogni altra voce — nessun hardware/emulatore disponibile in questo ambiente per una verifica end-to-end anche una volta implementato.

## Node Capabilities — candidato aperto, non ancora pianificato

**Nuova espansione proposta, 7 settembre 2026, non ancora parte di questo piano**: valutata una proposta esterna dell'utente per allargare il posizionamento di ARALD oltre il solo ambito alpino (vedi `docs/architecture.md`, sezione "Posizionamento: tre assi concettuali"). La maggior parte della proposta è naming/hardware/business (tier di ARALD Box, kit commerciali, categorie di deployment) e non richiede documentazione tecnica dedicata — trattamento identico a BOX/PORTABLE, nessun codice. L'unico pezzo genuinamente tecnico e nuovo è **Node Capabilities**: un nodo annuncia le proprie capacità (radio disponibili, capacità di calcolo, servizi offerti — sullo schema già esistente di `SERVICE_ANNOUNCE`/`service-directory.ts`, ma a grana più larga: l'intero profilo del nodo, non un singolo servizio) così che il routing possa rispondere non solo a "quale nodo è più vicino" ma anche a "quale nodo può fare X" (es. instradare una richiesta di traduzione verso un nodo Compute invece che verso il primo Relay disponibile). Nessuna decisione di implementazione presa: richiederebbe (1) un formato di annuncio (`packet.payload` di un nuovo tipo o un'estensione di `IdentityAnnouncement`?), (2) una policy di quanto fidarsi di un profilo auto-dichiarato (`packet.source` non è mai autenticato, stessa cautela già applicata altrove — vedi "Convenzioni consolidate" in `CLAUDE.md`), (3) dove il routing dovrebbe effettivamente consultarlo (`routing.ts`/`routing-table.ts` oggi decidono solo su prossimità/costo, mai su capacità). Prerequisito prima di aprire un candidato pianificato vero e proprio: una sessione di planning esplicita con l'utente, stesso workflow a doppio check di ogni altra voce.
