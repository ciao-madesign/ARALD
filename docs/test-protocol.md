# ARALD — Protocollo di test e validazione tecnica

**Stato**: documento di riferimento/pianificazione — nessun codice scritto per questo documento in sé (a parte la voce #58, `docs/security.md`, un prerequisito tecnico costruito appositamente, vedi sotto). Proposta ricevuta dall'utente il 4 settembre 2026, valutata insieme prima di scrivere qualunque cosa: quattro punti di disallineamento tra la proposta e il codice reale sono stati identificati e decisi con l'utente (vedi "Note metodologiche" sotto) prima di trascrivere il documento.

## Relazione con `docs/emergency-rescue-network.md`

Due documenti complementari, assi diversi — da non confondere:

- **`docs/emergency-rescue-network.md`** — fasi di validazione **budget/partner** (Fase 0 prototipazione → Micro Pilot ~700-800€/11 dispositivi → Field Pilot ~2.500€/38 dispositivi con un ente partner), enti partner possibili, principio "ARALD Network Effect", conformità normativa UE.
- **Questo documento** — la **scala tecnica** di validazione: cosa deve funzionare, con quale configurazione minima di dispositivi, con quali test puntuali (T-number) e quali criteri di superamento, indipendentemente dal budget o da un ente partner. Le fasi qui sotto sono più granulari di "Fase 0/Micro Pilot/Field Pilot" e ne costituiscono, in un certo senso, il "come" tecnico — la Fase 8 di questo documento (Field Test) è dimensionalmente vicina al Field Pilot dell'altro documento (19-24 nodi contro 38 dispositivi), ma i due non sono la stessa cosa e non vanno fusi.

## Note metodologiche — quattro punti chiariti con l'utente prima di scrivere questo documento

La proposta originale dell'utente (riportata più sotto, adattata) usava una terminologia in parte diversa da quella già consolidata nel codice. Quattro punti sono stati discussi esplicitamente e decisi prima di trascrivere il protocollo:

### 1. Mappatura tipo-messaggio → priorità

La proposta assumeva una catena di priorità a sé (`SOS > EMERGENCY > HAZARD > INFO > SERVICE`), con "SOS" come livello sopra "EMERGENCY". Nel codice non esiste un tipo-messaggio separato dalla priorità — i quattro tipi corrispondono a meccanismi già costruiti, con la propria mappatura reale su `Priority` (`node/src/packet.ts`, spec §50):

| Tipo (proposta) | Meccanismo ARALD | `Priority` effettiva | Voce |
|---|---|---|---|
| **SOS** (personale, "sono in pericolo") | `NomadNode.sendEmergencyBeacon()` | `EMERGENCY` (0) | #56 |
| **HAZARD** (pericolo d'area, es. "crepaccio sul sentiero") | `NomadNode.publishDrop({ kind: "hazard" })` | `MESSAGING` (2) | #57 |
| **INFO** | `NomadNode.publishDrop({ kind: "info" })` o un canale pubblico (`public-channels.ts`) | `CONTENT` (4) | #47/#40/#57 |
| **SERVICE** | `NomadNode.callService("service://...")` | `SERVICE` (3) | #6 |

Nessun codice necessario per questa mappatura — è già tutta disponibile. Due nuance reali emerse verificando il codice, non presenti nella proposta originale:

- `DropKind` (voce #57) ha in realtà **tre** livelli, non due: oltre a `"hazard"`/`"info"` esiste `"emergency"` (allerta d'area ad alta priorità, es. valanga — non un SOS personale, che resta `sendEmergencyBeacon()`), mappato su `Priority.EMERGENCY` come il SOS personale. Un test che genera un HAZARD "grave" dovrebbe quindi usare `kind: "emergency"`, non `kind: "hazard"`.
- L'ordine di priorità reale sul wire (`enum Priority`, numero più basso = priorità più alta) è `EMERGENCY(0) > CONTROL(1) > MESSAGING(2) > SERVICE(3) > CONTENT(4) > BULK(5)` — **SERVICE ha priorità più alta di INFO**, non più bassa come assumeva implicitamente la proposta originale (`HAZARD → INFO → SERVICE`). L'ordine atteso corretto per un test T7.3 (vedi Fase 7 sotto) è quindi: SOS/HAZARD-emergency > HAZARD-messaging > SERVICE > INFO > BULK.

### 2. "Observation" multi-relay (T7.4)

**Costruita**: `docs/security.md` voce #58 — `Drop`/`EmergencyBeaconSighting` guadagnano `receivedFrom` (un solo hop, mai un percorso multi-hop completo — limite dichiarato, per non ridisegnare il modello di firma immutabile) e `observedAt` (quando *questo* nodo ha registrato l'evento). Ogni nodo che riceve un pacchetto (SOS, HAZARD o INFO) ne tiene una propria Observation locale, distinta dal Packet stesso — che resta deduplicato una sola volta per nodo (`SeenCache`/`ContentStore`, invariati). T7.4 (sotto, Fase 7) è quindi eseguibile oggi.

Questa voce si sovrapponeva parzialmente a un pezzo pianificato (non ancora iniziato) da una sessione parallela lo stesso giorno ("Packet-vs-Observation/RSSI", terzo pezzo di un piano diverso) — riconciliato con l'utente: la parte "Observation" è coperta per intero da questa voce, quel pezzo futuro resta scoperto solo per la cifratura del payload verso il relay e per RSSI/SNR reali (vedi punto 3 sotto e `docs/security.md` voce #58 per il dettaglio completo).

### 3. RSSI/SNR

**Limite noto, confermato**: i transport BLE/LoRa simulati (`transports/simulated-link.ts`) modellano solo latenza/MTU, mai la potenza del segnale. Ogni test o metrica che richiede RSSI/SNR reali (Fase 2, "ARALD Test Record") è eseguibile **solo con hardware radio fisico**, non in questo ambiente — stesso trattamento già riservato al duty-cycle LoRa non modellato e ad altri limiti noti del progetto.

### 4. Multi-processo su radio simulata

**Limite noto, confermato**: `BleMedium`/`LoraMedium` (`transports/ble.ts`/`lora.ts`) sono singleton di modulo (`DEFAULT_MEDIUM`) — un registro condiviso *in-process*, non un canale che attraversa processi separati. Due processi `node` lanciati da terminali diversi con transport BLE/LoRa **non si vedono tra loro**: nessun socket, nessun IPC li collega. `cli.ts` non cablaggia mai BLE/LoRa/broadcast, solo TCP (`node.addTransport(new TcpTransport(...))`, l'unica riga di transport in tutto il file).

Conseguenza pratica: le fasi di questo documento che usano radio simulata (Fase 2 in su) sono eseguibili **solo** come test automatici (`tests/integration/`, `npx vitest run`) o come harness ad-hoc in un solo processo Node (stesso pattern usato per la verifica end-to-end della voce #56 — uno script che crea più `NomadNode` nello stesso script, mai come processi/terminali separati lanciati a mano). Le fasi con solo TCP (Fase 0-1) restano invece eseguibili anche come processi/terminali separati, come per ogni altro nodo ARALD. Costruire un vero canale cross-processo per la radio simulata (un bridge TCP/IPC dietro le quinte) resterebbe una scelta possibile in futuro, ma è stata esplicitamente **non costruita ora** — l'utente ha scelto di limitarsi a dichiarare il limite nel documento.

---

## Configurazioni progressive

| Fase | Box | Portable | Card | Smartphone | Obiettivo |
| ---- | --: | -------: | ---: | ---------: | --------- |
| 0 | 1 | 0 | 0 | 0 | Setup infrastruttura |
| 1 | 1 | 0 | 0 | 1 | App ↔ Box |
| 2 | 1 | 0 | 1 | 1 | Primo nodo radio |
| 3 | 1 | 1 | 1 | 1 | Store-and-forward |
| 4 | 1 | 2 | 3 | 1 | Multi-hop |
| 5 | 1 | 2 | 3 | 3 | Smartphone relay |
| 6 | 2 | 2 | 3 | 3 | Rete ridondante |
| 7 | 2 | 2 | 6 | 3 | Pre-field test |
| 8 | 2 | 2 | 6 | 10–15 | **Field test** |

La configurazione "1 Box + 2 Portable + 3 Card + 3 smartphone" (Fase 4-6) è una milestone intermedia. **Box**/**Portable**/**Card** = `docs/deployment.md`/`docs/beacon.md` (ARALD Box/PORTABLE, ARALD Card); Smartphone = l'app mobile (`mobile/www/`) verso un gateway.

---

## Fase 0 — Infrastructure Bring-Up

**Configurazione**: 1 ARALD Box, nessun nodo radio.

**Obiettivo**: verificare che l'infrastruttura software di base funzioni prima di introdurre la radio.

- **T0.1 — Boot**: avvio Box, servizi NOMAD avviati automaticamente, nessun errore critico, riavvio automatico dopo power-cycle.
- **T0.2 — Storage**: creare, memorizzare e recuperare un oggetto NOMAD; verificare Packet ID, timestamp, TTL, priority, integrità, persistenza dopo reboot.
- **T0.3 — API**: `create → authenticate → store → retrieve → delete/expire`.
- **T0.4 — Logging**: ogni operazione produce un evento di log.

**Pass criteria**: il Box funziona autonomamente per almeno 24h senza errori critici.

---

## Fase 1 — Smartphone ↔ ARALD Box

**Configurazione**: Smartphone — Wi-Fi/IP → ARALD Box.

**Obiettivo**: validare la prima versione dell'applicazione e del modello dati.

- **T1.1 — Creazione messaggio**: creare INFO, HAZARD, SOS dal telefono (vedi mappatura al punto 1 sopra per il meccanismo reale dietro ciascun tipo).
- **T1.2 — Metadata**: verificare Packet ID univoco, timestamp, posizione quando disponibile, tipo, priorità, TTL, autore pseudonimo (nodeId, mai un nickname trasmesso — vedi `docs/security.md`, la rubrica locale di nickname della voce #48 resta solo-client).
- **T1.3 — Delivery**: App → Box, il Box riceve e conserva il contenuto.
- **T1.4 — Retrieval**: Box → App, il telefono recupera il contenuto.
- **T1.5 — Offline**: creare un messaggio senza Internet — resta `PENDING` (localmente, lato app) e si sincronizza al ritorno della connessione (Wi-Fi locale verso il Box, non Internet — ARALD stesso non richiede mai Internet).

**Pass criteria**: il modello content-centric funziona indipendentemente dal mezzo di trasporto.

---

## Fase 2 — Introduzione della prima Card

**Configurazione**: Smartphone → BLE → Card → LoRa → Box.

**Obiettivo**: dimostrare il primo collegamento radio NOMAD completo.

> Radio simulata: eseguibile solo come test automatico/harness in-process (vedi nota metodologica 4 sopra) — non come tre processi separati su tre terminali.

- **T2.1 — BLE pairing**: Smartphone ↔ Card — discovery, autenticazione, connessione, disconnessione, riconnessione.
- **T2.2 — LoRa transmission**: Smartphone → BLE → Card → LoRa → Box.
- **T2.3 — Reverse path**: Box → LoRa → Card → BLE → Smartphone.
- **T2.4 — Packet integrity**: Packet TX deve coincidere con Packet RX.
- **T2.5 — Perdita pacchetto**: introdurre artificialmente perdita/ripetizione, verificare deduplicazione (`SeenCache`, `routing.ts`).

**Metriche**: RSSI, SNR (solo hardware reale — nota metodologica 3), packet loss, latency, numero retransmission, energia consumata.

**Pass criteria**: il percorso App → BLE → Card → LoRa → Box è ripetibile.

---

## Fase 3 — Store-and-Forward

**Configurazione**: Card — Portable — Box, smartphone associato alla Card.

**Obiettivo**: dimostrare che ARALD non richiede una connessione end-to-end continua (`PendingDeliveryQueue`, `store-and-forward.ts`).

- **T3.1 — Delayed delivery**: Card crea SOS → Portable non raggiungibile → Card conserva il pacchetto → Portable entra nel range → Card trasferisce → Portable conserva → Portable incontra Box → Box riceve. Sequenza: `t0 SOS → STORE → STORE → DELIVER`.
- **T3.2 — Nodo spento**: ripetere con Portable spento durante la creazione del messaggio; accenderlo successivamente — il messaggio deve essere trasferito.
- **T3.3 — TTL**: creare un messaggio con TTL breve, verificare l'eliminazione dopo la scadenza (`PendingDeliveryQueue.ttlMs`/`emergencyTtlMs`, voce #55).
- **T3.4 — Deduplication**: trasmettere più volte lo stesso Packet ID — il destinatario conserva una sola copia logica.

**Pass criteria**: dimostrare concretamente `Receive → Authenticate → Store → Forward` anche senza connessione continua.

---

## Fase 4 — Multi-hop

**Configurazione**: 3 Card + 2 Portable + 1 Box (Card A → Portable A → Card B → Portable B → Card C → Box). Non è richiesto che tutti i passaggi siano fisicamente contemporanei — il test deve poter creare partizioni e incontri successivi.

**Obiettivo**: validare il comportamento multi-hop.

- **T4.1 — 2 hop**: Card → Portable → Box.
- **T4.2 — 3 hop**: Card → Node → Node → Box.
- **T4.3 — Network partition**: separare fisicamente una parte della rete, creare un messaggio in una partizione, ricongiungere le due parti — il messaggio deve propagarsi (partition sync, `catalog.ts`/`RemoteCatalog`).
- **T4.4 — Intermittent connectivity**: sequenza `CONNECTED → DISCONNECTED → CONNECTED → DISCONNECTED → CONNECTED` — verificare che ARALD sfrutti le opportunità di contatto.

**Pass criteria**: la rete dimostra capacità DTN/store-and-forward multi-hop.

---

## Fase 5 — Smartphone come Mobile Relay

**Configurazione**: 3 Card + 3 smartphone + 2 Portable + 1 Box.

**Obiettivo**: dimostrare che smartphone esistenti possono aumentare la densità della rete (principio "ARALD Network Effect", `docs/emergency-rescue-network.md`).

- **T5.1 — Smartphone relay**: uno smartphone riceve un pacchetto NOMAD e lo conserva.
- **T5.2 — Forward**: lo smartphone lo inoltra a un altro nodo.
- **T5.3 — Background**: comportamento dell'app in foreground/background/schermo spento/telefono bloccato/app non utilizzata — **limite noto**: `mobile/www/` non ha mai avuto una build nativa Android verificabile in questo ambiente (Android Gradle Plugin bloccato dalla policy di rete, vedi `mobile/README.md`), quindi il comportamento reale in background su un dispositivo fisico resta da verificare fuori da questa sandbox.
- **T5.4 — Opportunistic relay**: due smartphone entrano nel range BLE, verificare sincronizzazione automatica.
- **T5.5 — Smartphone senza posizione**: disabilitare la condivisione posizione — il relay deve continuare a `receive/authenticate/store/forward` (la posizione condivisa è opt-in, `location-registry.ts`, voce #44, indipendente dal relay di pacchetti).
- **T5.6 — Blind forwarding**: payload cifrato (es. un messaggio 1:1/di gruppo, `encryption.ts`/`groups.ts`) — il relay non deve poter leggere il contenuto ma deve poterlo inoltrare comunque (già vero oggi: un relay inoltra pacchetti a livello di `routing.ts`, mai decifrando il payload applicativo).

**Pass criteria**: lo smartphone dimostra di poter essere un relay software opportunistico, senza diventare obbligatoriamente un dispositivo di localizzazione.

---

## Fase 6 — Ridondanza e resilienza

**Configurazione**: 3 Card + 3 smartphone + 2 Portable + 2 Box.

**Obiettivo**: dimostrare che la rete non dipende da un singolo nodo.

- **T6.1 — Multiple paths**: Card → (Smartphone A → Box A) e (Portable A → Box B) — verificare che il contenuto arrivi attraverso percorsi differenti.
- **T6.2 — Node failure**: ripetere spegnendo uno smartphone, un Portable, una Card, un Box — registrare se il messaggio arriva comunque.
- **T6.3 — Progressive failure**: spegnere progressivamente 9→8→7→6→5 nodi, misurare il punto in cui la rete non riesce più a consegnare il messaggio ("Network Resilience Curve").

---

## Fase 7 — Pre-Field Test

**Configurazione**: 6 Card + 3 smartphone + 2 Portable + 2 Box (più Card che smartphone, per verificare il comportamento con maggiore densità di nodi radio dedicati).

- **T7.1 — SOS**: generare 20 SOS, misurare delivery rate/time, hop count, duplicate rate, packet loss. Target iniziale: 100% delivery in condizioni controllate, salvo test deliberatamente degradati.
- **T7.2 — HAZARD**: generare un messaggio tipo "Crepaccio sul sentiero" (`kind: "hazard"`, mappatura al punto 1) con posizione, timestamp, autore, TTL, categoria — verificare propagazione locale.
- **T7.3 — Priority**: generare contemporaneamente SOS/HAZARD/INFO/SERVICE, verificare che il sistema rispetti l'ordine reale sul wire (**corretto rispetto alla proposta originale**, vedi nota metodologica 1): `EMERGENCY (SOS, HAZARD grave) > MESSAGING (HAZARD) > SERVICE > CONTENT (INFO) > BULK`, in condizioni di congestione.
- **T7.4 — Deduplication vs Observation**: tre relay ricevono lo stesso SOS/HAZARD — devono produrre `Packet: <id>` + `Observation A/B/C`, ma **una sola copia logica del Packet** per ciascun nodo. **Eseguibile oggi** — vedi nota metodologica 2 e `docs/security.md` voce #58 (`Drop.receivedFrom`/`observedAt`, `EmergencyBeaconSighting.receivedFrom`/`observedAt`). Verifica concreta: tre nodi connessi allo stesso relay intermedio devono avere ciascuno, nella propria `EmergencyBeacons.list()`/`Drops.list()`, esattamente una entry con `receivedFrom` uguale a chi gliel'ha effettivamente consegnata — non un percorso condiviso, non una entry duplicata.
- **T7.5 — Privacy**: quattro relay A-D con posizione ON/OFF indipendente dal forward (sempre YES) — verificare che l'assenza di posizione su A/C non impedisca la propagazione (`shareLocation()` è opt-in e indipendente dal relay di pacchetti, stessa nota di T5.5).

---

## Fase 8 — Primo vero Field Test

**Configurazione finale**: 6 Card, 10-15 smartphone, 2 Portable, 2 Box — 19-24 nodi potenziali. Configurazione da usare per dichiarare formalmente **"ARALD Field Test v1"**.

### Scenario A — SOS da area isolata

Un tester porta una Card in un'area senza connettività cellulare, genera SOS. Percorso atteso: Card → opportunistic relay → mobile relay → Portable → Fixed Box. Misurare: tempo di consegna, numero hop, numero relay, packet loss, RSSI/SNR (solo hardware reale), osservazioni radio, posizione disponibile/non disponibile, stato della rete.

### Scenario B — Network fragmentation

Dividere fisicamente il gruppo (3 Card + 5 smartphone + 1 Portable per parte), generare messaggi nel gruppo A, poi creare un incontro tra A e B — verificare sincronizzazione.

### Scenario C — Node failure

Durante il test: spegnere uno smartphone, una Card, un Portable, simulare Box non disponibile — verificare se il messaggio raggiunge comunque un punto di raccolta.

### Scenario D — Hazard locale

Un tester crea "HAZARD — Crepaccio — posizione GPS" — il messaggio deve essere distribuito preferenzialmente ai nodi vicini, senza richiedere un flooding indiscriminato dell'intera rete (nota: il flooding mesh-wide via `CONTENT_ANNOUNCE` è oggi il comportamento reale per tutti e tre i livelli di `DropKind`, voce #57 — un raggio/TTL ridotto per HAZARD/INFO è dichiarato esplicitamente fuori scope in quella voce; questo scenario resta quindi valido come test di comportamento *desiderato* futuro, non del comportamento *attuale*).

### Scenario E — Directed delivery

Un operatore autorizzato invia un messaggio con `Destination: RIFUGIO-01`, `Routing: DIRECTED`, `Type: INFO` — deve attraversare la rete fino al Box/Rifugio specifico, poi da lì diffondersi localmente (Box → cache locale → utenti vicini), **senza richiedere un flooding dell'intera rete**. Nota: la parte "instradamento diretto verso un Node ID" esiste già (`packet.destination` + `PendingDeliveryQueue`, unicast); la parte "ridistribuzione locale da parte del nodo target" ("Node Append") non è ancora costruita — vedi `CLAUDE.md`, "Cinque nuove proposte ricevute il 4 settembre 2026", punto (3), non ancora pianificata in dettaglio.

### Scenario F — Relay privacy

Card → Smartphone A (GPS OFF) → Smartphone B (GPS ON) → Box — verificare che A inoltri, B possa produrre un'Observation geolocalizzata, il messaggio arrivi, A non venga tracciato (stessa logica di T5.5/T7.5).

---

## Metriche da raccogliere in tutte le fasi — ARALD Test Record

Per ciascun evento: Test ID, Date/time, Node ID, Node type, Firmware version, Hardware revision, Packet ID, Packet type, Priority, Source, Destination, Hop count, RSSI*, SNR*, Timestamp RX, Timestamp TX, Battery level, GPS available, GPS coordinates*, Observation ID, Result, Failure reason.

\* Solo quando previsto dal test e dalla policy privacy; RSSI/SNR solo su hardware reale (nota metodologica 3).

## KPI principali

1. **Delivery Rate** — `delivered packets / transmitted packets`.
2. **Delivery Time** — TX → ricezione finale.
3. **Average Hop Count**.
4. **Duplicate Rate** — traffico ridondante generato.
5. **Observation Coverage** — quanti pacchetti hanno almeno 0/1/2+ observation geolocalizzate (eseguibile oggi, voce #58 — richiede aggregazione manuale delle viste locali di ciascun nodo, `EmergencyBeacons.list()`/`Drops.list()`, dato che `receivedFrom` resta un solo hop locale per nodo, mai propagato/aggregato mesh-wide).
6. **Resilience** — % messaggi consegnati dopo la perdita di 1/2/3/... nodi.
7. **Smartphone Relay Effectiveness** — confronto rete senza/con smartphone.

## Criterio di avanzamento

- **PASS** — tutti i requisiti fondamentali funzionano → si passa alla fase successiva.
- **CONDITIONAL PASS** — funziona con problemi documentati → si procede se il problema non blocca la milestone successiva.
- **FAIL** — il requisito architetturale fondamentale non funziona → si torna alla fase precedente.

## Struttura complessiva

```
Fase 0 Infrastructure → Fase 1 Content/App → Fase 2 Radio → Fase 3 Store & Forward
→ Fase 4 Multi-hop → Fase 5 Smartphone Relay → Fase 6 Resilience → Fase 7 Pre-field → Fase 8 FIELD TEST
```

Ogni fase produce evidenza documentata (`ARALD Test Record`), non solo "un prototipo che funziona" — coerente con l'approccio già seguito nel resto della documentazione di questo progetto (workflow a doppio check, voci numerate in `docs/security.md`).

## Cosa NON è nello scope di questo documento

- Il bring-up fisico di qualunque prototipo — lavoro privato dell'utente, stessa decisione già presa per ARALD Box (`CLAUDE.md`) ed estesa a Beacon/Card (`docs/emergency-rescue-network.md`).
- Budget, enti partner, strategia di presentazione — `docs/emergency-rescue-network.md`.
- RSSI/SNR reali, comportamento firmware su hardware fisico — bloccati su hardware non disponibile in questo ambiente.

Nessun codice scritto per questo documento (a parte il prerequisito tecnico della voce #58, già completato prima di scriverlo). Nessun hardware costruito.
