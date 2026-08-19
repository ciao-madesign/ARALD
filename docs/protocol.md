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
| `IDENTITY_REQUEST` | annuncio dei node id di cui si conosce già la chiave di cifratura, a un peer appena connesso | Milestone 15 |
| `IDENTITY_RESPONSE` | risposta con gli `IdentityAnnouncement` (autofirmati) che il peer non conosceva ancora | Milestone 15 |
| `PRIVATE_MESSAGE` | payload applicativo cifrato end-to-end (AES-256-GCM su chiave derivata via ECDH X25519), instradato per `destination`; porta con sé l'`IdentityAnnouncement` del mittente | Milestone 15 |
| `ROUTE_ANNOUNCE` | annuncio distance-vector (`{destination, cost}` o `cost: null` per un ritiro) scambiato tra vicini diretti | Milestone 16 |

Non esiste un pacchetto esplicito `CONTENT_NOT_FOUND`: l'assenza di un contenuto è segnalata implicitamente dal timeout lato richiedente (nessun `CONTENT_FOUND` ricevuto entro `contentRequestTimeoutMs` mentre il flood si esaurisce per TTL, §21). Un pacchetto `CONTENT_NOT_FOUND` esplicito è un possibile miglioramento futuro, non necessario per gli obiettivi §90-92.

`SYNC_REQUEST`/`SYNC_RESPONSE`, `IDENTITY_REQUEST`/`IDENTITY_RESPONSE` e `ROUTE_ANNOUNCE` sono tutti scambiati direttamente peer-a-peer (un solo hop, come `HELLO`) — non vengono mai inoltrati/floodati oltre i due nodi coinvolti. I primi due si scambiano ogni volta che due nodi si connettono (vedi `docs/roadmap.md` milestone 13); `ROUTE_ANNOUNCE` in aggiunta ogni volta che la tabella di instradamento locale cambia (triggered update, non solo alla connessione) — vedi `docs/roadmap.md` milestone 16. `PRIVATE_MESSAGE`, a differenza di questi, **è** instradato/floodato come `DATA` (per `destination`, non un solo hop) — un relay lo inoltra senza poterlo decifrare.

Tipi previsti dalla specifica ma **non ancora implementati** (§49): `ANNOUNCE`, `CAPABILITY`, `ROUTE_QUERY`, `ROUTE_REPLY`, `SERVICE_QUERY`, `SERVICE_ANNOUNCE`, `SERVICE_REQUEST`, `SERVICE_RESPONSE`, `STORE`, `FORWARD`, `ERROR`.

## TTL e deduplicazione (§19-21)

- Ogni pacchetto nasce con un TTL (default 8 nel prototipo).
- Ogni nodo che inoltra un pacchetto lo decrementa; a TTL 0 il pacchetto viene scartato.
- Ogni nodo mantiene una cache `seen packet id -> timestamp` (`node/src/routing.ts`, classe `SeenCache`) con eviction dimensionale, per evitare di rielaborare o reinoltrare lo stesso pacchetto (controlled flooding, §21).

## Instradamento per traffico unicast (§22, Milestone 16)

Un pacchetto con `destination` impostato (unicast) viene instradato verso il next hop noto in `node/src/routing-table.ts` quando esiste una rotta — un solo invio, non un flood verso tutti i vicini. Se non esiste ancora una rotta nota (mesh appena connessa) o l'invio instradato fallisce, si ricade sul controlled flooding come nel resto del protocollo. Il flooding resta l'unico meccanismo per il traffico broadcast (`CONTENT_QUERY`, destination assente). Il TTL si decrementa comunque a ogni hop, instradato o floodato che sia — instradare cambia solo *a chi* viene inviato il pacchetto, non la logica di TTL/dedup.

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

Definite in `Priority` (`node/src/packet.ts`): `EMERGENCY(0) > CONTROL(1) > MESSAGING(2) > SERVICE(3) > CONTENT(4) > BULK(5)`.

`TcpTransport` (`node/src/transports/tcp.ts`) applica ora uno scheduling reale per-peer, non solo un campo dati: ogni socket ha una `PriorityQueue` a 6 bucket FIFO (`node/src/priority-queue.ts`) — `send()` mette in coda il pacchetto e restituisce una promise che si risolve solo quando *quel* pacchetto è stato effettivamente scritto sul socket; un loop di drain (`drainQueue()`, con guardia di rientranza `draining`) svuota sempre il bucket non vuoto a priorità più alta prima di passare al successivo, preservando l'ordine di arrivo fra pacchetti della stessa priorità. Effetto pratico: un burst BULK (es. un trasferimento a chunk in corso) non fa più attendere un pacchetto EMERGENCY dietro di sé solo perché è stato accodato prima — a meno che il pacchetto EMERGENCY non arrivi mentre il *primissimo* invio del burst sta già scrivendo (quello parte sempre subito, non c'è ancora nulla in coda con cui riordinarlo). La coda per peer è limitata a `MAX_QUEUED_SENDS_PER_PEER` (500): oltre quella soglia `send()` rifiuta immediatamente invece di crescere senza limite, e alla disconnessione tutti gli invii ancora in coda vengono rifiutati (mai lasciati pending). Vedi `tests/unit/priority-queue.test.ts` e `tests/integration/tcp-priority-scheduling.test.ts`.
