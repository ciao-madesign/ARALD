# Transport

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §16, §41-47.

## Principio: il routing non conosce il transport

```ts
interface Transport {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  connect(address: PeerAddress): Promise<string>; // resolves with the remote peer's node id
  send(peerId: string, packet: Packet): Promise<void>;
  onPacket(handler: (packet: Packet, fromPeerId: string) => void): void;
  onPeerConnected(handler: (peerId: string, address: PeerAddress | undefined) => void): void;
  onPeerDisconnected(handler: (peerId: string) => void): void;
}
```

Definita in `node/src/transport.ts`. Il routing engine (`node/src/routing.ts`) e il nodo (`node/src/node.ts`) dipendono solo da questa interfaccia, mai da un transport concreto — questo è ciò che permette di sostituire TCP con BLE senza toccare la logica di routing (§16, §67).

## Transport implementati

| Transport | Stato | File |
|---|---|---|
| TCP | Implementato (Milestone 1-5) | `node/src/transports/tcp.ts` |
| WebSocket | Non implementato — alternativa equivalente a TCP per il prototipo, non necessaria avendo già TCP | — |
| BLE (simulato) | Implementato — Milestone 8, seguito audit, voce #8 (vedi sotto) | `node/src/transports/ble.ts` |
| BLE (hardware reale) | Non implementato — bloccato su hardware fisico | `node/src/transports/ble.ts` (stesso file, un adapter reale andrebbe dietro la stessa interfaccia `Transport`) |
| Wi-Fi (LAN / Direct) | Non implementato — Milestone 14 | `node/src/transports/wifi.ts` (da creare) |
| LoRa (simulato) | Implementato — Opzione N, `docs/next-steps.md` (vedi sotto) — affianca BLE, non lo sostituisce | `node/src/transports/lora.ts` |
| LoRa (hardware reale) | Non implementato — bloccato su hardware fisico | `node/src/transports/lora.ts` (stesso file, un adapter reale andrebbe dietro la stessa interfaccia `Transport`) |

## Base condivisa per i transport radio simulati (`node/src/transports/simulated-link.ts`)

Estratta quando `lora.ts` ha avuto bisogno esattamente della stessa meccanica già scritta per `ble.ts` (voce #8) — connessione simulata punto-a-punto su un "medium" in-process, handshake, frammentazione/riassemblaggio a MTU — con solo i numeri (MTU/latenza/limite connessioni) e l'etichetta usata nei messaggi di errore (`radioLabel`, es. `"BLE"`/`"LoRa"`) diversi da radio a radio. Copiare quella logica in un secondo file avrebbe duplicato ~300 righe già testate — stessa classe di duplicazione già corretta una volta in questo codebase (`bounded-map.ts`). Espone `SimulatedMedium` (il registro condiviso "prossimità fisica") e `SimulatedLinkTransport implements Transport` (tutta la meccanica), configurati da ogni radio concreta.

`BleMedium`/`LoraMedium` sono sottoclassi di `SimulatedMedium` con un campo privato proprio ciascuna (mai letto) — non sottoclassi vuote: senza quel campo, TypeScript le tratterebbe come strutturalmente intercambiabili (nessun errore di compilazione passando un `BleMedium` dove serve un `LoraMedium`), fondendo silenziosamente due "mesh" pensate per essere fuori portata l'una dall'altra — trovato dalla revisione, vedi `docs/security.md`.

## Transport BLE simulato (`node/src/transports/ble.ts`)

Nessun radio reale, nessuna libreria `noble`/`bleno`: `BleSimulatedTransport` (una `SimulatedLinkTransport` configurata con i numeri BLE) implementa la stessa interfaccia `Transport` di sopra usando solo oggetti JS e `setTimeout` in-process, con le proprietà reali di BLE che contano per validare la logica applicativa:

- **MTU piccola con frammentazione a livello di transport**: 20 byte di default (l'MTU ATT non negoziata — il caso peggiore reale, non un valore comodo scelto per far funzionare i test), ben sotto `CHUNK_SIZE` (4096 byte, `content.ts`) — un singolo `CONTENT_CHUNK` richiede centinaia di frammenti. Ogni pacchetto viene frammentato e riassemblato da una `FragmentReassembler` per connessione (stesso schema di bounding di `ChunkAssembler`, riusando `BoundedFifoMap`) — meccanica generica, vive in `simulated-link.ts`.
- **Limite di connessioni simultanee** (`maxConnections`, default 7): applicato solo ai peer effettivamente identificati — un tentativo di handshake in corso non conta contro il limite, altrimenti un legittimo *reconnect* da un peer già connesso (courier, spec §32) verrebbe rifiutato solo perché la sua vecchia connessione non era ancora stata chiusa. Vedi `docs/security.md` per il bug reale trovato dalla revisione su questo punto.
- **Latenza per-frammento simulata** (`latencyMs`, default 5ms): la consegna è genuinamente asincrona rispetto a `send()`, non nello stesso tick.
- **`BleMedium`**: un registro condiviso in-process che simula la "prossimità fisica" — un `BleMedium` dedicato per due gruppi di transport simula due mesh BLE fuori portata l'una dall'altra (stesso concetto del partition sync su TCP).

Semplificazioni deliberate rispetto a BLE reale (fuori scope per ciò che questo transport deve dimostrare, condivise con `lora.ts` — vedi sotto): nessuna asimmetria di ruolo central/peripheral (`connect()`/`start()` si comportano simmetricamente, come `TcpTransport`); nessuno scheduling per priorità lato invio (`PriorityQueue`, già validato a livello TCP nella voce #4).

Handshake identico a `TcpTransport`: entrambi i lati inviano un `HELLO` (anch'esso frammentato) il cui `source` rivela il proprio node id — con una differenza voluta: il lato che *accetta* una connessione ritarda l'invio del proprio `HELLO` finché non ha effettivamente deciso di accettarla (dopo aver verificato il limite di connessioni), altrimenti chi si connette potrebbe identificare l'altro lato e risolvere `connect()` con successo anche in un caso in cui l'altro lato sta per rifiutare la connessione — vedi `docs/security.md` per il dettaglio.

## Transport LoRa simulato (`node/src/transports/lora.ts`)

`LoraSimulatedTransport` — una `SimulatedLinkTransport` configurata con i numeri LoRa — **affianca** `BleSimulatedTransport`, non lo sostituisce: un `NomadNode` può avere entrambi attivi insieme via `addTransport()` (vedi `tests/integration/mixed-transport.test.ts`). Stessa assenza di hardware reale/libreria (nessun modulo SX126x/SX127x, nessuna libreria seriale) — solo `SimulatedLinkTransport` configurata diversamente da BLE:

- **MTU realistica, deliberatamente non minuscola come quella del BLE**: 200 byte di default, rappresentativa del payload fisico utile di un pacchetto LoRa grezzo (max fisico ~255 byte, meno overhead di framing) — la storia "MTU piccola forza la frammentazione multi-pacchetto" è già dimostrata da BLE, non va ripetuta qui con un numero artificialmente più piccolo.
- **Latenza per-frammento molto più alta del BLE** (`latencyMs`, default 250ms contro i 5ms del BLE — due ordini di grandezza): è **questo** il parametro che deve raccontare "LoRa è molto più lento", non l'MTU — scelta esplicita concordata con l'utente durante la progettazione. Rappresentativo di un profilo spreading-factor/banda intermedio; un profilo a lungo raggio reale (SF12) può richiedere diversi secondi per pacchetto — un test che vuole modellare quell'estremo passa un `latencyMs` esplicito più alto.
- **Limite di connessioni più permissivo del BLE** (`maxConnections`, default 16 contro 7): LoRa non ha un vincolo fisico "GATT" sul numero di connessioni simultanee — resta comunque un tetto anti-DoS/memoria (spec §57), non un tentativo di modellare un limite fisico che per questa radio non esiste.
- **Limite noto, non modellato in questa versione**: il vero vincolo di una rete LoRa reale è l'airtime del canale condiviso (in banda 868 MHz EU, un duty cycle limitato per legge, ~1% per sotto-banda) — non simulato qui, stesso trattamento di altri limiti dichiarati esplicitamente in questo codebase (es. `packet.source` non autenticato, `CLAUDE.md`).

Vedi `docs/security.md` per il dettaglio completo del lavoro (estrazione + nuovo transport) e i problemi reali trovati dalla revisione.

## Perché si parte da TCP e non da BLE (§16)

Il problema della *rete* (routing, TTL, dedup, content discovery, cache) va separato dal problema del *radio stack* (BLE ha discovery, range, gestione connessioni e comportamento cross-platform molto più complessi di un socket TCP). Sequenza:

```
A <-> B   (Milestone 1: connessione diretta)
A -> B -> C   (Milestone 2: multi-hop su TCP)
A --BLE--> B --BLE--> C   (Milestone 8: stesso routing, transport sostituito)
```

Se un test fallisce nella fase BLE, la causa è isolata al transport, non al routing — perché il routing è già stato validato in Milestone 1-5 su TCP.

## Combinazione BLE + Wi-Fi prevista (§42-44)

- **BLE**: discovery, control, piccoli messaggi, metadata, relay, richieste. Non adatto a grandi contenuti.
- **Wi-Fi**: file, mappe, documenti, database, contenuti voluminosi, sincronizzazioni.

```
Phone --BLE--> Node --Wi-Fi--> NOMAD
```

## Vincoli piattaforma mobile

### iOS (§46) — trattato come vincolo sperimentale, non come garanzia

Apple Core Bluetooth (https://developer.apple.com/documentation/corebluetooth) supporta BLE in background con meccanismi specifici. Da iOS 26, Apple documenta la possibilità di mantenere alcune attività BLE in background quando l'app ha una **Live Activity** attiva e un `CBManager` istanziato. Questo **non implica** che un iPhone possa fungere da nodo mesh infrastrutturale sempre attivo.

Scenari da verificare sperimentalmente prima di fare qualunque assunzione nel routing:

1. App in foreground
2. App in background
3. App in background con Live Activity attiva
4. App sospesa dal sistema
5. App terminata

Fino a misurazione empirica su dispositivi reali, il ruolo assegnato a iOS nel modello di deployment resta: client, nodo opportunistico, relay solo quando l'app è attiva, cache, courier — mai nodo infrastrutturale permanente (quel ruolo resta di computer/server, §85).

### Android (§47)

Più flessibile, ma richiede permessi runtime espliciti su Android 12+: `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT` (https://developer.android.com/develop/connectivity/bluetooth/bt-permissions). Disponibile anche Companion Device Manager per alcuni scenari di associazione. La strategia mobile iniziale privilegia Android per i test di rete persistente; iOS resta secondo target.
