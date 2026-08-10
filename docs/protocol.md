# Protocollo

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §15, §18-26, §48-51.

## Formato pacchetto (prototipo, JSON — §15, §48)

```ts
interface Packet<T = unknown> {
  version: number;       // protocol version, oggi = 1
  id: string;             // UUID, usato per la deduplicazione (§20)
  type: MessageType;
  source: string;          // node id (hex della public key)
  destination?: string;    // assente = broadcast/flood
  ttl: number;              // decrementato a ogni hop (§19)
  timestamp: number;
  priority?: Priority;      // §50, default MESSAGING
  payload: T;
}
```

Implementato in `node/src/packet.ts`. Framing su TCP: un pacchetto JSON per riga (newline-delimited), vedi `node/src/transports/tcp.ts`.

## Tipi di pacchetto implementati

| Tipo | Uso | Fase |
|---|---|---|
| `HELLO` | annuncio all'apertura di una connessione | Milestone 1 |
| `PING` / `PONG` | liveness check | Milestone 1 |
| `PEER_LIST` | scambio dei peer conosciuti | Milestone 1-2 |
| `DATA` | payload applicativo generico, instradato per `destination` | Milestone 2 (multi-hop) |
| `ACK` | conferma di ricezione di un `DATA` | Milestone 2 |
| `CONTENT_QUERY` | "chi ha `content_id`?" | Milestone 4 |
| `CONTENT_FOUND` | risposta positiva alla query, dal nodo che possiede il contenuto | Milestone 4 |
| `CONTENT_REQUEST` | richiesta esplicita del contenuto trovato | Milestone 4 |
| `CONTENT_CHUNK` | un chunk del contenuto (§26) | Milestone 4 |
| `CONTENT_COMPLETE` | fine trasferimento, contiene l'hash finale da verificare | Milestone 4 |
| `SYNC_REQUEST` | annuncio del proprio catalogo (content id conosciuti) a un peer appena connesso | Milestone 13 |
| `SYNC_RESPONSE` | risposta con le voci di catalogo che il peer non conosceva ancora (solo metadata, mai i byte) | Milestone 13 |

Non esiste un pacchetto esplicito `CONTENT_NOT_FOUND`: l'assenza di un contenuto è segnalata implicitamente dal timeout lato richiedente (nessun `CONTENT_FOUND` ricevuto entro `contentRequestTimeoutMs` mentre il flood si esaurisce per TTL, §21). Un pacchetto `CONTENT_NOT_FOUND` esplicito è un possibile miglioramento futuro, non necessario per gli obiettivi §90-92.

`SYNC_REQUEST`/`SYNC_RESPONSE` sono scambiati direttamente peer-a-peer (un solo hop, come `HELLO`) ogni volta che due nodi si connettono — non vengono inoltrati/floodati oltre i due nodi coinvolti. Vedi `docs/roadmap.md` milestone 13 per il flusso completo.

Tipi previsti dalla specifica ma **non ancora implementati** (§49): `ANNOUNCE`, `CAPABILITY`, `ROUTE_QUERY`, `ROUTE_REPLY`, `SERVICE_QUERY`, `SERVICE_ANNOUNCE`, `SERVICE_REQUEST`, `SERVICE_RESPONSE`, `STORE`, `FORWARD`, `ERROR`.

## TTL e deduplicazione (§19-21)

- Ogni pacchetto nasce con un TTL (default 8 nel prototipo).
- Ogni nodo che inoltra un pacchetto lo decrementa; a TTL 0 il pacchetto viene scartato.
- Ogni nodo mantiene una cache `seen packet id -> timestamp` (`node/src/routing.ts`, classe `SeenCache`) con eviction dimensionale, per evitare di rielaborare o reinoltrare lo stesso pacchetto (controlled flooding, §21).

## Content ID (§24)

```
content_id = sha256(payload)
```

esadecimale, calcolato da `node/src/content.ts`. Metadata associati nel prototipo: `contentId, name, mimeType, size, createdAt, publisherId, signature`. Firma del publisher (§55) è implementata — vedi [`security.md`](./security.md); expiry non è ancora implementata.

## Flusso di content discovery (§25, Milestone 4)

```
A --CONTENT_QUERY(id)--> B --CONTENT_QUERY(id)--> C
C possiede il contenuto:
C --CONTENT_FOUND(id)--> B --CONTENT_FOUND(id)--> A
A --CONTENT_REQUEST(id)--> B --CONTENT_REQUEST(id)--> C
C --CONTENT_CHUNK(id, 0..n)--> B --CONTENT_CHUNK--> A
C --CONTENT_COMPLETE(id, hash)--> B --> A
A verifica sha256(chunk riassemblati) == hash
```

Ogni hop lungo il percorso di ritorno **verifica se possiede già il contenuto in cache locale** prima di continuare a propagare la query: questo è ciò che rende possibile la cache trasparente del Milestone 5 (§27-29, §90-92 obiettivo 2 e 3).

## Priorità (§50)

Definite in `Priority` (`node/src/packet.ts`): `EMERGENCY(0) > CONTROL(1) > MESSAGING(2) > SERVICE(3) > CONTENT(4) > BULK(5)`. Nel prototipo la priorità è solo un campo dati; non c'è ancora scheduling differenziato in coda (roadmap milestone 15-16).
