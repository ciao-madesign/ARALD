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

Poi `http://127.0.0.1:8080` per lo stato del nodo (peer, servizi, percentuale di contenuto in cache) e la ricerca. Nessuna autenticazione: resta volutamente bound solo su `127.0.0.1` (`node/src/web-ui.ts`), non pensata per essere esposta oltre la macchina locale.

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
