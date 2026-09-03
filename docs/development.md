# Sviluppo

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §11-13, §17, §62-64, §89, §105.

## Principio di sviluppo bottom-up

Non sviluppare in parallelo BLE, routing, content discovery, AI, NOMAD, mobile, sicurezza e sincronizzazione. Ogni livello va validato prima di aggiungere il successivo (§89):

```
packet -> node -> routing -> content -> cache -> BLE -> smartphone -> NOMAD -> gateway -> DTN -> synchronization -> deployment reale
```

Questo repository, nel suo stato attuale, copre `packet -> node -> routing -> content -> cache` (Milestone 0-5). Vedi [`roadmap.md`](./roadmap.md) per lo stato dettagliato.

## Requisiti

- Node.js ≥ 18 (sviluppato con Node 22)
- npm ≥ 10

## Setup

```bash
npm install
npm test
```

`npm install` alla radice installa le dipendenze del workspace `node/` (npm workspaces) e degli strumenti di test (vitest) alla radice.

## Eseguire un nodo

```bash
npm run dev -w node -- --id A --port 9001
```

In un secondo terminale:

```bash
npm run dev -w node -- --id B --port 9002 --connect 127.0.0.1:9001
```

Output atteso (§13):

```
Nomad-Net Node
Node ID: 7f3a...
Status: ONLINE
```

## Interfaccia web locale (§59)

Spenta di default (apre una seconda porta anche se in ascolto solo su loopback). Per abilitarla:

```bash
npm run dev -w node -- --id A --port 9001 --web-port 8080
```

Poi `http://127.0.0.1:8080` mostra lo stato del nodo (vicini connessi con trust level, servizi conosciuti con provider e capability, percentuale di contenuto in cache, se il relay è attivo) e una ricerca "live" sui contenuti — pagina a card, non più la lista minimale delle prime versioni. Nessuna autenticazione sugli endpoint di lettura: resta volutamente bound solo su `127.0.0.1` per default (`node/src/web-ui.ts`). Endpoint JSON disponibili se serve leggerli programmaticamente: `/api/status`, `/api/peers`, `/api/services`, `/api/content` (tutto il conosciuto), `/api/search?q=...` (filtrato — query vuota restituisce sempre `[]`, per design).

### Raggiungerla da un telefono sulla stessa rete (client mobile, `docs/next-steps.md` Opzione H)

```bash
npm run dev -w node -- --id A --port 9001 --web-port 8080 --web-host 0.0.0.0 --allow-service-calls
```

`--web-host 0.0.0.0` fa il bind su tutte le interfacce (serve l'indirizzo LAN della macchina, es. `192.168.1.x`, non `127.0.0.1`, perché il telefono lo raggiunga) — da usare solo su una rete fidata, dato che gli endpoint di lettura restano senza autenticazione. `--allow-service-calls` attiva `POST /api/call` (l'unico endpoint di scrittura, per invocare un servizio come `service://ai` dal telefono) e stampa in console un **nome rete** e una **password di rete** generati freschi a ogni avvio — stesso modello mentale di una rete Wi-Fi, non un token esadecimale — da inserire una volta nell'app mobile:

```
Mobile network name: NODE-9001
Mobile network password: K7XM-2QRT
```

Entrambi sono visibili anche sulla pagina web del nodo stesso (`http://<host>:<web-port>`, sezione "Collega un telefono") tramite il nuovo endpoint `GET /api/pairing`, deliberatamente non autenticato — leggere la password non può richiedere la password stessa. Si possono anche fissare esplicitamente invece di generarli a ogni avvio, con `--network-name`/`--network-password`. `/api/call` richiede sempre la password di rete (anche in ascolto solo su loopback, come header `Authorization: Bearer <password>`) e accetta solo `serviceId` già noti e disponibili — vedi `docs/security.md` voce #24 (e la #22 per il disegno originale dell'endpoint) per il dettaglio completo delle protezioni.

La stessa sezione "Collega un telefono" mostra anche un **QR code**: inquadrandolo con l'app mobile si compilano da soli indirizzo, nome rete e password, senza digitare nulla (`docs/security.md` voce #25). Il QR codifica l'indirizzo LAN di questo nodo — con `--web-host 0.0.0.0` viene rilevato automaticamente (`node:os.networkInterfaces()`, prima interfaccia non interna), ma su una macchina con più interfacce di rete (VPN, bridge Docker...) può individuare quella sbagliata: usa `--public-host <indirizzo>` per specificarlo esplicitamente in quel caso.

## Gateway NOMAD mockato (§37, seguito audit — voci #9/#10)

Nessuna istanza Docker/Project NOMAD reale necessaria — la demo avvia anche un `FakeNomadServer` e un `FakeOllamaServer` locali, con qualche articolo/risposta d'esempio:

```bash
npm run gateway:demo
```

Espone lo stesso `NomadNode` (transport TCP) con il catalogo NOMAD pubblicato via `syncCatalog()`, `service://kiwix-search` e `service://ai` registrati — connettiti come a qualunque altro nodo (`npm run dev -w node -- --connect 127.0.0.1:<porta>`) per recuperare gli articoli o chiamare i due servizi, ad esempio `node.callService("service://ai", { prompt: "..." })` da un altro nodo o dallo script della sessione. `--nomad-url <url>`/`--ai-url <url>` puntano rispettivamente a un'istanza NOMAD/Kiwix e Ollama reali già in esecuzione, se disponibili, al posto dei fake server. `--max-content-entries <n>` (default 8192) dimensiona quante entry può tenere il `ContentStore` di questo nodo gateway (spec §57) — vedi `docs/security.md` per la voce che ha introdotto il limite: un catalogo NOMAD/una cronologia di notizie più grande del default va dimensionata esplicitamente con questa opzione, altrimenti le entry pubblicate più vecchie iniziano a essere sfrattate. Vedi `gateway/nomad/kiwix-gateway.ts`, `gateway/nomad/ai-gateway.ts` e `docs/next-steps.md` Opzione B per il dettaglio.

## Test (§17-18, §90-92)

```bash
npm test
```

- `tests/unit/` — identità, packet framing, TTL/dedup, content store (hash).
- `tests/integration/` — scenari end-to-end sopra TCP che riproducono esattamente gli obiettivi §90-92 della specifica:
  - `three-node-relay.test.ts`: `A -> B -> C`, nessun collegamento diretto A-C, verifica multi-hop.
  - `content-retrieval.test.ts`: A recupera `content://example/hello` posseduto solo da C, passando per B (primo obiettivo tecnico, §90).
  - `cache-replication.test.ts`: dopo la prima richiesta, un quarto nodo D ottiene lo stesso contenuto da A senza raggiungere C, poi C viene spento e B risponde dalla propria cache (secondo e terzo obiettivo, §91-92).

## Build

```bash
npm run build -w node
```

Compila `node/src` in `node/dist` (TypeScript → JS, target Node ESM).

## Convenzioni

- TypeScript strict mode.
- Nessuna dipendenza runtime oltre ai moduli built-in di Node (`node:crypto`, `node:net`, `node:events`) nel prototipo attuale: il primo MVP deve dimostrare la logica di rete, non introdurre superficie di dipendenze non necessaria (§11).
- Un modulo per responsabilità (identity, packet, peer, routing, content, transport), coerente con la struttura finale della repository (§87).
