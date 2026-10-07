# Simulazione teorica di efficienza della rete ARALD — modello parametrico

**Stato**: Scenario 1 (alta Valle Maira), Scenario 2 (alpino frammentato, due valli separate da una cresta) e Scenario 3 (Isole Eolie, primo costruito nel formato del futuro tool) e Scenario 4 (deserto di Atacama, prima regione radio fuori dall'Europa) e Scenario 5 (Kampala, città densa su colline) completati. Altri scenari: da aggiungere come nuovi file di scenario sullo stesso motore.

**Aggiornamento sul comportamento della coda (5 ottobre 2026)**: dopo che questi tre scenari sono stati calcolati, `PendingDeliveryQueue` è stata corretta (`docs/security.md` voce #120). I pacchetti `Priority.EMERGENCY` non scadono più; gli altri mantengono il TTL di 5 minuti. Le tabelle "ARALD attuale" sono state **rigenerate** con il comportamento corretto (`ARALD_QUEUE_TTL_S` in `model.ts`); quello precedente resta disponibile come `LEGACY_QUEUE_TTL_S`, per confronto e per i test storici. Il problema che la prima versione aveva messo in luce, l'SOS perso dal data mule, è proprio quello che la correzione risolve. I punti "cosa dice il modello" sotto descrivono entrambi i comportamenti dove la differenza conta.

**Obiettivo finale**: questo modello è il motore di un futuro tool interattivo di progettazione di reti ARALD su mappa reale — vedi [`docs/network-design-tool.md`](network-design-tool.md), da rispettare come vincolo di progetto.

**Cosa è e cosa non è.** È un modello **teorico e parametrico** (`tools/scenario-model/`, `npm run scenario-model`) per confrontare scenari e ordini di grandezza. **Non** è una misura: nessun parametro radio di questo documento è stato verificato su hardware o sul terreno (nessun accesso a hardware né a internet reale in questo ambiente). Coordinate, quote, ostruzioni e sensibilità sono ipotesi dichiarate qui sotto, da sostituire con misure (Fase 2 di `docs/test-protocol.md`) quando disponibili. È separato da `tools/simulator/`, che invece esegue istanze reali di `NomadNode` su TCP locale senza alcuna fisica radio.

## 1. Modello

Rete dinamica \(G(t) = (V, E(t))\), simulata a passo discreto (10 s).

- **Nodi** \(v_i = (p_i(t), T_i, P_i, A_i)\): posizione da traiettoria a waypoint (interpolazione lineare), tecnologie (LoRa/BLE/Wi-Fi per tipo), potenza, guadagno d'antenna e perdita da corpo. Un nodo può spegnersi a un istante dato (robustezza).
- **Link LoRa** — link budget:
  \(RSSI_{ij} = EIRP + G_r - L_{corpo} - L_{path}(d, n) - L_{ostruzione,ij} - L_{interferenza}\), con \(EIRP = \min(P_{tx}^{hw} + G_t,\ ERP_{max}^{reg} + 2{,}15)\) (limite sia hardware sia normativo). Il link utile è bidirezionale: si calcolano entrambe le direzioni (EIRP del trasmettitore + guadagno d'antenna del ricevitore) e vale la più debole. \(L_{ostruzione}\) è una perdita fissa per coppia di nodi (Scenario 1) oppure una funzione delle posizioni per zone di terreno (Scenario 2, chi valica una cresta cambia zona); una perdita aggiuntiva dipendente dal tempo modella eventi meteo,
  con \(L_{path} = FSPL(1\,m) + 10\,n \log_{10} d\) a 868 MHz. Il link esiste se \(RSSI - M_{fading} \ge S(SF)\) per qualche SF; si sceglie **lo SF più veloce che chiude il link** (logica ADR).
- **Link corti**: Wi-Fi solo verso Box/Portable (access point). Due modelli: `fixed` (Scenari 1-2: Wi-Fi entro 80 m a 8 Mbps, BLE entro 30 m a 200 kbps) e `budget` (dallo Scenario 3: link budget a 2,44 GHz come per LoRa, con velocità a gradini in funzione dell'RSSI: BLE 2M/1M/Coded PHY, Wi-Fi 802.11n MCS7…MCS0 e 802.11b). Mezzo scelto: quello con la velocità istantanea più alta tra quelli possibili.
- **Territorio** (dallo Scenario 3, `terrain.ts`): se l'ambiente ha un `Terrain`, ogni link aggiunge la diffrazione knife-edge sull'ostacolo dominante del profilo del terreno (ITU-R P.526, curvatura terrestre a k = 4/3) e il clutter dell'uso del suolo ai due estremi, scalato con la distanza fino a 200 m. Le posizioni sono allora quote assolute dell'antenna (suolo + altezza del dispositivo).
- **Capacità LoRa reale**: time-on-air dalla formula Semtech (BW 125 kHz, CR 4/5, preambolo 8, header esplicito, CRC, LDRO a SF11/12), frame 222 B di cui 22 B di framing; overhead applicativo ARALD ×1,45 (i `CONTENT_CHUNK` viaggiano in base64 dentro JSON, più envelope e firme — `node.ts`). **Duty-cycle legale per nodo** come token bucket (finestra 1 h) e **canale condiviso** come unico dominio di collisione con efficienza 50% (conservativo); il credito del canale si accumula tra un passo e l'altro, così anche un frame SF12 (~8 s) può essere trasmesso.
- **Code e instradamento** (policy `custody`, ricalca `floodExcept()` in `node.ts`): se esiste un percorso istantaneo il nodo inoltra a **un solo next hop** (più vicino in hop, a parità il mezzo più veloce); altrimenti consegna a tutti i vicini, che trattengono e ri-inoltrano (store-carry-forward). Priorità stretta per mittente sul LoRa (come `priority-queue.ts`): un messaggio meno urgente non consuma il budget lasciato da uno più urgente bloccato. Granularità a byte: un relay può inoltrare solo la parte già ricevuta (chunk progressivi).
- **Metrica di instradamento**: `hops` (numero di salti, come `routing-table.ts` oggi: "Cost is hop count") oppure `airtime` (tempo di trasmissione di un frame su ogni link: uno SF lento costa molto più di uno veloce) — la seconda è un'alternativa da valutare, non il comportamento attuale.
- **Destinazioni multiple**: un messaggio (es. l'SOS) può puntare a più infrastrutture; si misura il tempo per ciascuna, e ogni destinazione raggiunta continua a inoltrare verso le altre.
- **Due modelli di coda dei relay** confrontati:
  1. **ARALD attuale** — un relay isolato dalla destinazione mette la copia in `PendingDeliveryQueue`, che la scarta dopo 30 min (`Priority.EMERGENCY`) o 5 min (resto), e `SeenCache` impedisce di riaccettarla (`node/src/store-and-forward.ts`).
  2. **DTN** — il relay trattiene la copia finché non la consegna.
- **Metriche**: \(T_{delivery}\) per file (dalla generazione), percentuale arrivata entro l'orizzonte, airtime LoRa totale consumato, connettività istantanea (frazione del tempo con percorso simultaneo C5→Box). Una consegna avvenuta con connettività istantanea < 100% è passata (anche) per contatti opportunistici.

## 2. Scenario 1 — alta Valle Maira (Chiappera → Piana di Stroppia → Rifugio Stroppia → verso Bivacco Barenghi)

**12 dispositivi**: 1 Box (Campo Base, ~1650 m), 1 Portable (Piana di Stroppia alta), 5 Card (C1-C5), 5 smartphone (S1-S5, ciascuno a pochi metri dalla propria Card, collegato via BLE). Coordinate locali **indicative**, ricostruite dalle distanze dell'analisi di partenza (Box–C2 1,0 km, Box–C3 2,1, Box–C4 3,9, Box–C5 5,5, C4–C5 ~1,7, C3–C5 ~3,5), quote da ~1650 a ~2815 m — non rilevate su cartografia.

**Linea temporale**: t=0 tutti al Campo Base; C2+Portable si fermano alla Piana (30-45 min), C3 sotto le cascate (45 min), C4 al Rifugio Stroppia (2 h), C5 sale verso Barenghi (3 h). A **3h15** vengono generati i 5 file benchmark. Varianti di mobilità dopo l'evento:

| Variante | Cosa succede |
|---|---|
| `static` | gruppo fermo dopo l'arrivo |
| `ferry` | C3 (+S3) sale fino a C5 (arrivo 5h, sosta 10 min) e rientra al Campo Base (7h) — "data mule" |
| `return` | C5+S5 scendono al Campo Base (arrivo 5h30) |
| `card-failure` | come `static`, ma la Card C4 al rifugio si spegne a 3h |

**File benchmark** (dimensione sul filo dopo la compressione Zstd automatica, voce #119 — il testo comprime, JPEG/audio no): F1 SOS 1 KB (C5→Box, priorità EMERGENCY), F5 GPS+audio 150 KB (S5→Box), F2 articolo Wiki 200 KB → ~70 KB (Box→S5), F4 rapporto 5 MB (S5→Box), F3 8 JPEG 12 MB (S5→Box).

**Ipotesi radio** (tutte non verificate): sensibilità SX1262 a 125 kHz −124 (SF7) … −137 dBm (SF12), da datasheet ricostruito da conoscenza; antenne Box +3 dBi, Portable 0 dBi, Card −3 dBi; perdita da corpo Card 4 dB, Portable 2 dB. Ambienti: favorevole \(n=2{,}2\), margine 8 dB, ostruzioni ×0,3; tipico \(n=2{,}6\), 10 dB, ostruzioni ×1, interferenza 2 dB; severo \(n=3{,}0\), 12 dB, ostruzioni ×1,6, interferenza 5 dB. Ostruzioni (tipico): Box–C4 15 dB, Box–C5 25, C2–C4 12, C2–C5 22, Portable–C4 8, Portable–C5 18, C3–C5 12, C3–C4 4 (gradino delle Cascate di Stroppia e vallone alto incassato — ipotesi). Due profili regolatori EU868 (EN 300 220-2, `docs/beacon.md`): **g1** 868,0-868,6 MHz, 14 dBm ERP, 1%; **g3** 869,4-869,65 MHz, 27 dBm ERP, 10%. L'SX1262 senza amplificatore esterno arriva a +22 dBm: in g3 il limite reale è l'hardware (Box 25 dBm EIRP, Card 19 dBm EIRP), non la norma. La scelta della sotto-banda resta aperta (`docs/compliance.md`) — il modello mostra quanto pesa.

## 3. Scenario 1 — risultati

Output integrale di `npm run scenario-model` (default: policy `custody`, SF max 12, orizzonte 10 h dalla partenza, cioè 6h45 dopo la generazione dei file). Le sezioni A e B non dipendono dallo scenario.

**Nota di revisione (Scenario 2)**: la prima versione calcolava il link budget usando il guadagno d'antenna di un solo lato, quindi il risultato cambiava con l'ordine dei due nodi. Corretto (vale la direzione più debole): cambiano solo alcuni risultati nella sotto-banda g3. Ad esempio Box–C4 in tipico ora chiude a SF11, e proprio questo link lento peggiora alcuni tempi per effetto dell'instradamento a numero di salti (punto 8 sotto).

### A. Capacità LoRa per spreading factor (singolo hop, BW 125 kHz, CR 4/5, frame 222 B, overhead ARALD ×1,45)

| SF | ToA frame | Throughput a canale libero | Sostenuto 1% (g1) | Sostenuto 10% (g3) |
|---|---:|---:|---:|---:|
| SF7 | 348 ms | 3.17 kbps | 32 bps | 317 bps |
| SF8 | 615 ms | 1.79 kbps | 18 bps | 179 bps |
| SF9 | 1107 ms | 1.00 kbps | 10 bps | 100 bps |
| SF10 | 2009 ms | 0.55 kbps | 5 bps | 55 bps |
| SF11 | 4428 ms | 0.25 kbps | 2 bps | 25 bps |
| SF12 | 8036 ms | 0.14 kbps | 1 bps | 14 bps |

### B. Tempo di trasferimento su un singolo hop LoRa, con duty-cycle legale

| File | SF7 · 1% | SF7 · 10% | SF10 · 1% | SF10 · 10% | SF12 · 10% |
|---|---:|---:|---:|---:|---:|
| SOS 1 KB | 3 s | 3 s | 15 s | 15 s | 60 s |
| Wiki ~70 KB | 4.0 h | 3.0 min | 28.0 h | 2.0 h | 10.7 h |
| GPS+audio 150 KB | 9.8 h | 11 min | 2.5 giorni | 5.3 h | 24.0 h |
| Report 5 MB | 15.3 giorni | 35.9 h | 88.3 giorni | 8.8 giorni | 35.3 giorni |
| 8 JPEG 12 MB | 36.7 giorni | 3.6 giorni | 212.1 giorni | 21.2 giorni | 84.8 giorni |

### C. Scenario 1 — alta Valle Maira — link LoRa stimati a t = 3h15 (variante `static`), SF minimo che chiude il link

| Link | Distanza | favorevole g1 14 dBm ERP/1% | favorevole g3 27 dBm ERP/10% | tipico g1 14 dBm ERP/1% | tipico g3 27 dBm ERP/10% | severo g1 14 dBm ERP/1% | severo g3 27 dBm ERP/10% |
|---|---:|:---:|:---:|:---:|:---:|:---:|:---:|
| BOX–C2 | 1.0 km | SF7 | SF7 | SF7 | SF7 | SF9 | SF7 |
| BOX–C3 | 2.1 km | SF7 | SF7 | SF7 | SF7 | ✗ | SF10 |
| BOX–C4 | 3.9 km | SF7 | SF7 | ✗ | SF11 | ✗ | ✗ |
| BOX–C5 | 5.5 km | SF7 | SF7 | ✗ | ✗ | ✗ | ✗ |
| C2–C3 | 1.1 km | SF7 | SF7 | SF7 | SF7 | SF12 | SF10 |
| C3–C4 | 1.8 km | SF7 | SF7 | SF8 | SF7 | ✗ | ✗ |
| C4–C5 | 1.7 km | SF7 | SF7 | SF7 | SF7 | ✗ | ✗ |
| C3–C5 | 3.5 km | SF7 | SF7 | ✗ | ✗ | ✗ | ✗ |
| PORT–C3 | 0.4 km | SF7 | SF7 | SF7 | SF7 | SF7 | SF7 |
| PORT–C4 | 2.2 km | SF7 | SF7 | SF10 | SF8 | ✗ | ✗ |
| PORT–C5 | 3.9 km | SF7 | SF7 | ✗ | ✗ | ✗ | ✗ |

### D. Tempi di consegna end-to-end (policy custody, SF max 12, orizzonte 10 h dalla partenza; file generati a 3h15)


**ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1 | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | ✗ (71%) | 4.0 h | ✗ | ✗ | 100% | 7.7 min |
| static | tipico | 30 s | ✗ (40%) | ✗ | ✗ | ✗ | 100% | 21.1 min |
| static | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 13% | 1.6 min |
| ferry | favorevole | 10 s | 3.7 h | 4.2 h | ✗ (20%) | ✗ | 100% | 11.4 min |
| ferry | tipico | 30 s | 3.7 h | ✗ (22%) | ✗ (16%) | ✗ | 100% | 22.0 min |
| ferry | severo | 3.2 h | ✗ | ✗ | ✗ | ✗ | 13% | 3.7 min |
| return | favorevole | 10 s | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 100% | 7.7 min |
| return | tipico | 30 s | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 100% | 10.1 min |
| return | severo | 1.7 h | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 62% | 5.4 min |
| card-failure | favorevole | 10 s | ✗ (71%) | 4.0 h | ✗ | ✗ | 100% | 7.7 min |
| card-failure | tipico | ✗ | ✗ | ✗ | ✗ | ✗ | 30% | 2.6 min |
| card-failure | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 13% | 1.6 min |

**ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1 | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | 13 min | 19 min | ✗ (18%) | ✗ | 100% | 49.5 min |
| static | tipico | 1.5 min | ✗ (52%) | 5.9 h | ✗ | ✗ | 100% | 130.6 min |
| static | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 7.6 min |
| ferry | favorevole | 10 s | 13 min | 19 min | ✗ (54%) | ✗ | 100% | 85.6 min |
| ferry | tipico | 1.5 min | 2.4 h | 1.6 h | ✗ (31%) | ✗ | 100% | 119.4 min |
| ferry | severo | 2.6 h | ✗ | ✗ | ✗ | ✗ | 15% | 10.9 min |
| return | favorevole | 10 s | 13 min | 19 min | 2.2 h | 2.2 h | 100% | 45.3 min |
| return | tipico | 1.5 min | 1.8 h | 1.7 h | 2.2 h | 2.2 h | 100% | 67.4 min |
| return | severo | 1.6 h | 2.0 h | 2.2 h | 2.2 h | 2.2 h | 64% | 25.5 min |
| card-failure | favorevole | 10 s | 13 min | 19 min | ✗ (18%) | ✗ | 100% | 49.5 min |
| card-failure | tipico | ✗ | ✗ | ✗ | ✗ | ✗ | 30% | 7.6 min |
| card-failure | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 7.6 min |

**DTN — il relay trattiene la copia fino alla consegna · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1 | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | ✗ (71%) | 4.0 h | ✗ | ✗ | 100% | 7.7 min |
| static | tipico | 30 s | ✗ (40%) | ✗ | ✗ | ✗ | 100% | 21.1 min |
| static | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 13% | 17.0 min |
| ferry | favorevole | 10 s | 3.7 h | 4.2 h | ✗ (20%) | ✗ | 100% | 11.4 min |
| ferry | tipico | 30 s | 3.7 h | ✗ (22%) | ✗ (16%) | ✗ | 100% | 22.0 min |
| ferry | severo | 3.4 h | 3.7 h | ✗ (8%) | 3.7 h | 3.7 h | 13% | 19.6 min |
| return | favorevole | 10 s | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 100% | 7.7 min |
| return | tipico | 30 s | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 100% | 10.1 min |
| return | severo | 1.7 h | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 62% | 10.1 min |
| card-failure | favorevole | 10 s | ✗ (71%) | 4.0 h | ✗ | ✗ | 100% | 7.7 min |
| card-failure | tipico | ✗ | ✗ | ✗ | ✗ | ✗ | 30% | 9.2 min |
| card-failure | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 13% | 17.0 min |

**DTN — il relay trattiene la copia fino alla consegna · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1 | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | 13 min | 19 min | ✗ (18%) | ✗ | 100% | 49.5 min |
| static | tipico | 1.5 min | ✗ (52%) | 5.9 h | ✗ | ✗ | 100% | 130.6 min |
| static | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 10.7 min |
| ferry | favorevole | 10 s | 13 min | 19 min | ✗ (54%) | ✗ | 100% | 85.6 min |
| ferry | tipico | 1.5 min | 2.4 h | 1.6 h | ✗ (31%) | ✗ | 100% | 119.4 min |
| ferry | severo | 2.7 h | 3.5 h | 1.7 h | 3.7 h | 3.7 h | 15% | 47.5 min |
| return | favorevole | 10 s | 13 min | 19 min | 2.2 h | 2.2 h | 100% | 45.3 min |
| return | tipico | 1.5 min | 1.8 h | 1.7 h | 2.2 h | 2.2 h | 100% | 67.4 min |
| return | severo | 1.6 h | 2.0 h | 1.7 h | 2.2 h | 2.2 h | 64% | 44.2 min |
| card-failure | favorevole | 10 s | 13 min | 19 min | ✗ (18%) | ✗ | 100% | 49.5 min |
| card-failure | tipico | ✗ | ✗ | ✗ | ✗ | ✗ | 30% | 9.1 min |
| card-failure | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 10.7 min |

### E. Stessa simulazione con instradamento a costo "airtime" invece che a numero di salti (coda relay ARALD attuale)


**Metrica airtime · ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1 | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | ✗ (71%) | 4.0 h | ✗ | ✗ | 100% | 7.7 min |
| static | tipico | 30 s | ✗ (40%) | ✗ | ✗ | ✗ | 100% | 16.9 min |
| static | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 13% | 1.6 min |
| ferry | favorevole | 10 s | 3.7 h | 4.2 h | 3.8 h | 4.0 h | 100% | 7.9 min |
| ferry | tipico | 30 s | 3.7 h | ✗ (46%) | 3.8 h | 4.0 h | 100% | 16.3 min |
| ferry | severo | 3.2 h | ✗ | ✗ | ✗ | ✗ | 13% | 3.7 min |
| return | favorevole | 10 s | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 100% | 7.7 min |
| return | tipico | 30 s | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 100% | 9.3 min |
| return | severo | 1.7 h | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 62% | 5.6 min |
| card-failure | favorevole | 10 s | ✗ (71%) | 4.0 h | ✗ | ✗ | 100% | 7.7 min |
| card-failure | tipico | ✗ | ✗ | ✗ | ✗ | ✗ | 30% | 2.6 min |
| card-failure | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 13% | 1.6 min |

**Metrica airtime · ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1 | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | 13 min | 19 min | ✗ (18%) | ✗ | 100% | 49.5 min |
| static | tipico | 30 s | 41 min | 59 min | ✗ (16%) | ✗ | 100% | 142.5 min |
| static | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 7.6 min |
| ferry | favorevole | 10 s | 13 min | 19 min | 3.8 h | 4.0 h | 100% | 50.6 min |
| ferry | tipico | 30 s | 41 min | 59 min | 3.8 h | 4.0 h | 100% | 83.6 min |
| ferry | severo | 2.6 h | ✗ | ✗ | ✗ | ✗ | 15% | 10.9 min |
| return | favorevole | 10 s | 13 min | 19 min | 2.2 h | 2.2 h | 100% | 45.3 min |
| return | tipico | 30 s | 41 min | 59 min | 2.2 h | 2.2 h | 100% | 65.3 min |
| return | severo | 1.6 h | 2.0 h | 2.2 h | 2.2 h | 2.2 h | 64% | 25.3 min |
| card-failure | favorevole | 10 s | 13 min | 19 min | ✗ (18%) | ✗ | 100% | 49.5 min |
| card-failure | tipico | ✗ | ✗ | ✗ | ✗ | ✗ | 30% | 7.6 min |
| card-failure | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 7.6 min |

Legenda D/E: F1 = SOS + coordinate (1 KB) (C5→BOX); F5 = GPS + audio 10 s (150 KB) (S5→BOX); F2 = Articolo Wiki (200 KB → ~70 KB compresso) (BOX→S5); F4 = Rapporto 5 pag. + 3 JPEG (5 MB) (S5→BOX); F3 = 8 JPEG (12 MB) (S5→BOX). "✗ (x%)" = non consegnato entro l'orizzonte, x% arrivato; "—" = destinazione non raggiunta. "C5→BOX connesso" = frazione del tempo con un percorso simultaneo (connettività istantanea): una consegna avvenuta con questo valore < 100% è passata (anche) per contatti opportunistici. "Airtime LoRa" = tempo di trasmissione LoRa consumato da tutti i file, tutte le copie. Varianti: static = gruppo fermo dopo l'arrivo (C5 verso Barenghi, C4 al rifugio); ferry = C3 sale fino a C5 (data mule) e rientra al Campo Base; return = C5+S5 scendono al Campo Base (rientro del gruppo); card-failure = come 'static', ma la Card C4 (rifugio) si spegne a 3h.

Con `--horizon-h 30` (quasi 27 h dopo l'evento), nella variante `static` in condizioni tipiche: in g1 (1%) F5 arriva in 18,2 h, la Wiki al 95%, F4 allo 0,6%, F3 a 0; in g3 (10%), con l'instradamento attuale a numero di salti, F5 arriva in 13,4 h, la Wiki in 5,9 h e F4 al 3%; con la metrica `airtime` F5 arriva in 41 min, la Wiki in 59 min e F4 al 71%.

## 4. Scenario 1 — cosa dice il modello

1. **L'SOS funziona bene in ogni caso in cui esista un percorso, anche multi-hop**: 10 s - 1,5 min nella rete connessa, perfino agli SF lenti. È il caso d'uso naturale di LoRa e la valutazione dell'analisi di partenza (★★★★★) regge.
2. **I throughput "10-20 kbps" dell'analisi di partenza sono irrealistici in EU868.** Al netto dell'overhead ARALD, LoRa SF7/125 kHz rende ~3,2 kbps *a canale libero*; con il duty-cycle legale si scende a **~32 bps (1%) o ~320 bps (10%)** sostenuti per nodo. Di conseguenza 12 MB via LoRa richiedono **giorni o settimane** (3,6 giorni nel caso migliore SF7/10% su un solo hop, ~37 giorni all'1%), non 1-22 ore. Anche 70-150 KB (Wiki, audio) arrivano in minuti/decine di minuti solo in g3 (10%); in g1 (1%) richiedono ore.
3. **Per i file grandi l'unico canale che conta è fisico: la persona che porta il telefono vicino al Box.** Nella variante `return` tutti i file arrivano in ~2,2 h (= tempo di cammino + qualche secondo di Wi-Fi), in qualunque condizione radio. La rete "Wi-Fi/BLE locale + mobilità" batte LoRa di 2-3 ordini di grandezza per F3/F4. Conferma la conclusione architetturale di partenza (LoRa = controllo e piccoli dati; mobilità = estensione temporale), ma con un divario molto più netto.
4. **La scelta della sotto-banda conta molto per i dati medi, poco per l'SOS**: passare da g1 (1%) a g3 (10%) porta F5 (150 KB) da "non arriva in 6h45" a 13 min in condizioni favorevoli; in tipico a 41 min, ma solo con la metrica `airtime` (punto 8). Il guadagno viene **soprattutto dal duty-cycle**, non dalla potenza: con l'SX1262 a +22 dBm il Box guadagna ~9 dB di EIRP passando a g3, ma una Card con antenna −3 dBi solo ~3 dB, quindi i link Card–Card cambiano poco. In tipico l'unico link aggiuntivo è Box–C4, che però chiude solo a SF11 (lento: vedi punto 8).
5. **Il "data mule" ora porta l'SOS, ma non ancora i dati.** Nella variante `ferry` in condizioni severe, il mulo è l'unico ponte e resta isolato ~2 h tra il contatto con C5 e il rientro.
   - Prima della correzione della coda (`docs/security.md` voce #120) **anche l'SOS andava perso**: il TTL di 30 minuti per `Priority.EMERGENCY` era più corto dell'attraversamento a piedi del gap. Questo risultato ha motivato la correzione.
   - Con la coda corretta l'SOS arriva in 3,2 h (g1) / 2,6 h (g3).
   - Rapporto e foto scadono ancora dopo 5 minuti di isolamento e si perdono. Con una coda in stile DTN arriverebbero in ~3,7 h, via Wi-Fi al rientro.
6. **Robustezza: la catena di Card è fragile.** In condizioni tipiche la sola Card C4 al rifugio è punto singolo di guasto: spenta lei, C5 resta isolata (connettività istantanea C5→Box dal 100% al 30%, solo prima delle 3h) e nulla viene consegnato. In condizioni severe la rete fissa non raggiunge mai C5 (connettività 13-15%, solo nella fase di salita) e serve sempre la mobilità.
7. **Connettività istantanea ≠ capacità.** In condizioni tipiche C5→Box è connessa il 100% del tempo, eppure F5 (150 KB) arriva solo al 40% in 6h45 in g1 (1%): il collo di bottiglia è l'airtime legale, non la topologia.
8. **L'instradamento a numero di salti spreca airtime.** `routing-table.ts` sceglie il percorso con meno salti; quando esiste un link diretto lento (es. Box–C4 a SF11 in g3) lo preferisce a due o tre salti a SF7, anche se costa ~10-20 volte più tempo di trasmissione. In g3 tipico, passando alla metrica `airtime` (sezione E), F5 scende da 13,4 h a 41 min e la Wiki da 5,9 h a 59 min. In g1 i dati medi cambiano poco (i link lenti lì quasi non chiudono), ma nella variante `ferry` rapporto e foto (F4/F3), in condizioni tipiche, passano da non consegnati (in g1 16% e 0%, in g3 31% e 0%) a 3,8 h / 4,0 h: quando il mulo è accanto a C5 il percorso a costo minimo preferisce il BLE verso di lui al LoRa lento, e i file arrivano col mulo al Campo Base.

## 5. Scenario 2 — alpino frammentato (due valli separate da una cresta)

**Obiettivo**: verificare quanto ARALD regge quando la topografia spezza la rete in più isole radio e diversi link cadono insieme. **Geometria sintetica**, ispirata alle Alpi Cozie ma **non un luogo rilevato**: coordinate locali con origine al Box. Se si vuole ancorarla a un luogo reale (es. due valloni adiacenti di una valle cuneese), basta sostituire coordinate e zone in `tools/scenario-model/alpino-frammentato.ts`.

```text
         VALLE A                     CRESTA ~2700-2800 m            VALLE B
                                          COLLE (2750 m)
  vallone laterale        alpe              ●  ← unico passaggio
  (dietro sperone)      C3 ● ───────────────┤                       ● PORT (rifugio)
        C2 ●               \                │                        \
                   BOX ●────                │                         ● C5 (infortunio)
```

**Zone di terreno** (perdita aggiuntiva in condizione tipica, ipotesi): valle A ↔ valle B 40 dB (cresta), valle A ↔ vallone laterale 25 dB (sperone), vallone laterale ↔ valle B 50 dB, valle A ↔ colle 6 dB, valle B ↔ colle 4 dB, stessa zona 0 dB. Scala: favorevole ×0,5, tipico ×1, severo ×1,4. Il colle è la fascia alta della cresta (sopra ~2550 m): chi ci sta vede entrambe le valli.

**Dispositivi**: lo stesso set dello Scenario 1 (Box nel borgo di fondovalle A, Portable al rifugio in valle B gestito dal custode, 5 Card + 5 smartphone), più un **ARALD Fixed Relay** al colle solo nelle varianti che lo prevedono (13° dispositivo: antenna esterna +3 dBi, nessuna perdita da corpo). **Linea temporale**: tutti partono dal Box; C2 entra nel vallone laterale (2h), C3 si ferma all'alpe (1h30), C4 e C5 valicano il colle (2h45) e scendono in valle B: C4 al rifugio, C5 in una conca in quota dove si infortuna. A **4h** vengono generati i file. L'**SOS punta a entrambe le infrastrutture** (Portable e Box): quella più vicina per il soccorso immediato, il Box perché è il punto di coordinamento con i servizi (Kiwix, consegna esterna).

| Variante | Cosa succede |
|---|---|
| `static` | nessun ponte sul colle: tre isole radio (valle A, vallone laterale, valle B) |
| `col-card` | C3 sale al colle (3h) e ci resta: una persona con la Card fa da ponte |
| `fixed-relay` | Fixed Relay al colle, C3 resta all'alpe |
| `crossing` | nessun ponte; C4 raggiunge l'infortunato (4h45), resta 15 min, rivalica e arriva al Box alle 8h (data mule) |
| `storm` | come `fixed-relay`, con una perturbazione (+12 dB su ogni link LoRa) dalle 4h alle 7h |
| `box-failure` | come `fixed-relay`, ma il Box va offline a 3h54, prima dell'evento |

## 6. Scenario 2 — risultati

Output di `npm run scenario-model -- --scenario alpino-frammentato` (stessi parametri di default; le sezioni A e B sono identiche allo Scenario 1 e qui omesse). Le colonne `F1→PORT`/`F1→BOX` riportano il tempo dell'SOS verso ciascuna infrastruttura.

### C. Scenario 2 — alpino frammentato (due valli separate da una cresta) — link LoRa stimati a t = 4h (variante `fixed-relay`), SF minimo che chiude il link

| Link | Distanza | favorevole g1 14 dBm ERP/1% | favorevole g3 27 dBm ERP/10% | tipico g1 14 dBm ERP/1% | tipico g3 27 dBm ERP/10% | severo g1 14 dBm ERP/1% | severo g3 27 dBm ERP/10% |
|---|---:|:---:|:---:|:---:|:---:|:---:|:---:|
| BOX–C3 | 2.7 km | SF7 | SF7 | SF7 | SF7 | ✗ | SF11 |
| BOX–C2 | 3.5 km | SF7 | SF7 | ✗ | ✗ | ✗ | ✗ |
| BOX–FR | 4.3 km | SF7 | SF7 | SF8 | SF7 | ✗ | ✗ |
| C3–FR | 1.7 km | SF7 | SF7 | SF7 | SF7 | ✗ | SF12 |
| FR–PORT | 3.6 km | SF7 | SF7 | SF8 | SF7 | ✗ | ✗ |
| FR–C5 | 3.8 km | SF7 | SF7 | SF10 | SF7 | ✗ | ✗ |
| PORT–C5 | 2.0 km | SF7 | SF7 | SF7 | SF7 | ✗ | SF11 |
| BOX–PORT | 7.5 km | SF10 | SF7 | ✗ | ✗ | ✗ | ✗ |
| BOX–C5 | 7.0 km | SF12 | SF8 | ✗ | ✗ | ✗ | ✗ |
| C3–C5 | 4.9 km | SF12 | SF11 | ✗ | ✗ | ✗ | ✗ |

### D. Tempi di consegna end-to-end (policy custody, SF max 12, orizzonte 10 h dalla partenza; file generati a 4h)


**ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | 40 s | ✗ (3%) | ✗ (6%) | ✗ | ✗ | 100% | 8.6 min |
| static | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 29% | 2.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| col-card | favorevole | 10 s | 40 s | ✗ (3%) | ✗ (6%) | ✗ | ✗ | 100% | 8.6 min |
| col-card | tipico | 10 s | 2.7 min | ✗ (3%) | ✗ (2%) | ✗ | ✗ | 100% | 13.1 min |
| col-card | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| fixed-relay | favorevole | 10 s | 40 s | ✗ (3%) | ✗ (6%) | ✗ | ✗ | 100% | 8.6 min |
| fixed-relay | tipico | 10 s | 30 s | ✗ (11%) | ✗ (14%) | ✗ | ✗ | 100% | 12.6 min |
| fixed-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| crossing | favorevole | 10 s | 40 s | 4.0 h | ✗ (6%) | 4.1 h | 4.2 h | 100% | 10.0 min |
| crossing | tipico | 10 s | 2.5 h | ✗ | ✗ | ✗ | ✗ | 33% | 4.8 min |
| crossing | severo | 29 min | 3.6 h | ✗ | ✗ | ✗ | ✗ | 10% | 2.8 min |
| storm | favorevole | 10 s | 30 s | ✗ (38%) | ✗ (62%) | ✗ | ✗ | 100% | 12.5 min |
| storm | tipico | 40 s | 3.0 h | ✗ | ✗ | ✗ | ✗ | 70% | 1.9 min |
| storm | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| box-failure | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |

**ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | 20 s | 55 min | 28 min | ✗ (8%) | ✗ | 100% | 47.4 min |
| static | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 29% | 4.7 min |
| static | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 24% | 5.7 min |
| col-card | favorevole | 10 s | 20 s | 55 min | 28 min | ✗ (8%) | ✗ | 100% | 47.4 min |
| col-card | tipico | 10 s | 30 s | ✗ (51%) | ✗ (83%) | ✗ | ✗ | 100% | 88.2 min |
| col-card | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 25% | 4.6 min |
| fixed-relay | favorevole | 10 s | 20 s | 55 min | 28 min | ✗ (8%) | ✗ | 100% | 47.4 min |
| fixed-relay | tipico | 10 s | 30 s | 26 min | 49 min | ✗ (14%) | ✗ | 100% | 85.8 min |
| fixed-relay | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 34% | 5.7 min |
| crossing | favorevole | 10 s | 20 s | 46 min | 28 min | 4.0 h | 4.2 h | 100% | 61.9 min |
| crossing | tipico | 10 s | 2.1 h | ✗ | ✗ (16%) | ✗ | ✗ | 33% | 19.3 min |
| crossing | severo | 40 s | 2.5 h | ✗ | ✗ | ✗ | ✗ | 24% | 14.2 min |
| storm | favorevole | 10 s | 1.5 min | 3.5 h | 46 min | ✗ (9%) | ✗ | 100% | 84.9 min |
| storm | tipico | 10 s | 50 s | 3.8 h | 4.1 h | ✗ (5%) | ✗ | 100% | 92.4 min |
| storm | severo | 3.0 h | — | ✗ | ✗ | ✗ | ✗ | 34% | 3.3 min |
| box-failure | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 34% | 0.6 min |

**DTN — il relay trattiene la copia fino alla consegna · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | 40 s | ✗ (3%) | ✗ (6%) | ✗ | ✗ | 100% | 8.6 min |
| static | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 29% | 8.8 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| col-card | favorevole | 10 s | 40 s | ✗ (3%) | ✗ (6%) | ✗ | ✗ | 100% | 8.6 min |
| col-card | tipico | 10 s | 2.7 min | ✗ (3%) | ✗ (2%) | ✗ | ✗ | 100% | 13.1 min |
| col-card | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| fixed-relay | favorevole | 10 s | 40 s | ✗ (3%) | ✗ (6%) | ✗ | ✗ | 100% | 8.6 min |
| fixed-relay | tipico | 10 s | 30 s | ✗ (11%) | ✗ (14%) | ✗ | ✗ | 100% | 12.6 min |
| fixed-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| crossing | favorevole | 10 s | 40 s | 4.0 h | ✗ (6%) | 4.1 h | 4.2 h | 100% | 10.0 min |
| crossing | tipico | 10 s | 2.5 h | 4.0 h | ✗ | 4.0 h | 4.0 h | 33% | 13.2 min |
| crossing | severo | 29 min | 3.7 h | 4.0 h | ✗ | 4.0 h | 4.0 h | 10% | 5.1 min |
| storm | favorevole | 10 s | 30 s | ✗ (38%) | ✗ (62%) | ✗ | ✗ | 100% | 12.5 min |
| storm | tipico | 40 s | 3.0 h | ✗ (7%) | ✗ (7%) | ✗ | ✗ | 70% | 15.7 min |
| storm | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| box-failure | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |

**DTN — il relay trattiene la copia fino alla consegna · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | 20 s | 55 min | 28 min | ✗ (8%) | ✗ | 100% | 47.4 min |
| static | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 29% | 45.0 min |
| static | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 24% | 80.4 min |
| col-card | favorevole | 10 s | 20 s | 55 min | 28 min | ✗ (8%) | ✗ | 100% | 47.4 min |
| col-card | tipico | 10 s | 30 s | ✗ (51%) | ✗ (83%) | ✗ | ✗ | 100% | 88.2 min |
| col-card | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 25% | 42.0 min |
| fixed-relay | favorevole | 10 s | 20 s | 55 min | 28 min | ✗ (8%) | ✗ | 100% | 47.4 min |
| fixed-relay | tipico | 10 s | 30 s | 26 min | 49 min | ✗ (14%) | ✗ | 100% | 85.8 min |
| fixed-relay | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 34% | 118.8 min |
| crossing | favorevole | 10 s | 20 s | 46 min | 28 min | 4.0 h | 4.2 h | 100% | 61.9 min |
| crossing | tipico | 10 s | 2.1 h | 3.1 h | ✗ | 4.0 h | 4.0 h | 33% | 85.4 min |
| crossing | severo | 40 s | 2.5 h | 4.0 h | ✗ | 4.0 h | 4.0 h | 24% | 113.2 min |
| storm | favorevole | 10 s | 1.5 min | 3.5 h | 46 min | ✗ (9%) | ✗ | 100% | 84.9 min |
| storm | tipico | 10 s | 50 s | 3.8 h | 4.1 h | ✗ (5%) | ✗ | 100% | 92.4 min |
| storm | severo | 3.0 h | — | ✗ | ✗ | ✗ | ✗ | 34% | 67.0 min |
| box-failure | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 34% | 0.6 min |

### E. Stessa simulazione con instradamento a costo "airtime" invece che a numero di salti (coda relay ARALD attuale)


**Metrica airtime · ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | 50 s | ✗ (11%) | ✗ | ✗ | ✗ | 100% | 12.6 min |
| static | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 29% | 2.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| col-card | favorevole | 10 s | 30 s | ✗ (64%) | ✗ | ✗ | ✗ | 100% | 11.5 min |
| col-card | tipico | 10 s | 2.8 min | ✗ (4%) | ✗ | ✗ | ✗ | 100% | 16.6 min |
| col-card | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| fixed-relay | favorevole | 10 s | 30 s | ✗ (64%) | ✗ | ✗ | ✗ | 100% | 11.5 min |
| fixed-relay | tipico | 10 s | 30 s | ✗ (36%) | ✗ | ✗ | ✗ | 100% | 16.8 min |
| fixed-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| crossing | favorevole | 10 s | 50 s | 4.0 h | ✗ (22%) | 4.0 h | 4.2 h | 100% | 13.9 min |
| crossing | tipico | 10 s | 2.1 h | ✗ | ✗ | ✗ | ✗ | 33% | 4.1 min |
| crossing | severo | 29 min | 3.6 h | ✗ | ✗ | ✗ | ✗ | 10% | 2.8 min |
| storm | favorevole | 10 s | 30 s | ✗ (64%) | ✗ | ✗ | ✗ | 100% | 11.5 min |
| storm | tipico | 40 s | 3.0 h | ✗ | ✗ | ✗ | ✗ | 70% | 1.9 min |
| storm | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| box-failure | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |

**Metrica airtime · ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | 20 s | 55 min | 28 min | ✗ (8%) | ✗ | 100% | 47.4 min |
| static | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 29% | 4.7 min |
| static | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 24% | 5.7 min |
| col-card | favorevole | 10 s | 20 s | 55 min | 28 min | ✗ (8%) | ✗ | 100% | 47.4 min |
| col-card | tipico | 10 s | 30 s | 1.0 h | 1.9 h | ✗ (6%) | ✗ | 100% | 130.1 min |
| col-card | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 25% | 4.6 min |
| fixed-relay | favorevole | 10 s | 20 s | 55 min | 28 min | ✗ (8%) | ✗ | 100% | 47.4 min |
| fixed-relay | tipico | 10 s | 30 s | 26 min | 49 min | ✗ (14%) | ✗ | 100% | 85.8 min |
| fixed-relay | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 34% | 5.7 min |
| crossing | favorevole | 10 s | 20 s | 46 min | 28 min | 4.0 h | 4.2 h | 100% | 61.8 min |
| crossing | tipico | 10 s | 2.1 h | ✗ | ✗ (54%) | ✗ | ✗ | 33% | 19.3 min |
| crossing | severo | 40 s | 2.5 h | ✗ | ✗ | ✗ | ✗ | 24% | 14.2 min |
| storm | favorevole | 10 s | 30 s | 26 min | 49 min | ✗ (12%) | ✗ | 100% | 70.5 min |
| storm | tipico | 10 s | 50 s | 3.0 h | 3.5 h | ✗ (7%) | ✗ | 100% | 113.9 min |
| storm | severo | 3.0 h | — | ✗ | ✗ | ✗ | ✗ | 34% | 3.3 min |
| box-failure | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 34% | 0.6 min |

Legenda D/E: F1 = SOS + coordinate (1 KB) (C5→PORT e BOX); F5 = GPS + audio 10 s (150 KB) (S5→BOX); F2 = Articolo Wiki (200 KB → ~70 KB compresso) (BOX→S5); F4 = Rapporto 5 pag. + 3 JPEG (5 MB) (S5→BOX); F3 = 8 JPEG (12 MB) (S5→BOX). "✗ (x%)" = non consegnato entro l'orizzonte, x% arrivato; "—" = destinazione non raggiunta. "C5→BOX connesso" = frazione del tempo con un percorso simultaneo (connettività istantanea): una consegna avvenuta con questo valore < 100% è passata (anche) per contatti opportunistici. "Airtime LoRa" = tempo di trasmissione LoRa consumato da tutti i file, tutte le copie. Varianti: static = nessun ponte sul colle: tre isole radio (valle A, vallone laterale, valle B); col-card = C3 sale al colle e ci resta: una persona con la Card fa da ponte tra le valli; fixed-relay = ARALD Fixed Relay installato al colle (13° dispositivo), C3 resta all'alpe; crossing = nessun ponte; C4 raggiunge l'infortunato e poi rivalica fino al Box (data mule); storm = come 'fixed-relay', con una perturbazione (+12 dB su ogni link LoRa) dalle 4h alle 7h; box-failure = come 'fixed-relay', ma il Box va offline a 3h54 (prima dell'evento).


## 7. Scenario 2 — cosa dice il modello

1. **La frammentazione è reale e la cresta la decide.** Senza ponte, in condizioni tipiche, la valle B è un'isola: l'SOS raggiunge il Portable in 10 s ma **non raggiunge mai il Box**, con qualunque sotto-banda e coda. C5→Box è connesso solo il 29% del tempo, cioè prima che C5 valichi. In condizioni severe e in g1 nemmeno il Portable, a 2 km nella stessa valle, viene raggiunto; in g3 sì (40 s).
2. **Un ponte sul colle ricuce la rete per i messaggi.** Con un Fixed Relay l'SOS arriva al Box in 30 s (tipico, entrambe le sotto-bande); con una persona e la sua Card al colle in 2,7 min (g1) / 30 s (g3): il Fixed Relay rende di più grazie all'antenna esterna e all'assenza del corpo. **Ma in condizioni severe nessun ponte funziona**: i link del colle (3,6-4,3 km) non chiudono, e resta solo la mobilità.
3. **Anche con il ponte, il colle diventa il collo di bottiglia.** Tutto il traffico tra le valli passa da un solo dispositivo, e il suo budget di duty-cycle (36 s/h in g1) è la capacità dell'intero collegamento: in g1 né l'audio (150 KB) né la Wiki arrivano in 6 h. In g3 (tipico) l'audio arriva in 26 min e la Wiki in 49 min.
4. **Il data mule che rivalica è l'unico modo di portare l'SOS al Box senza ponte.**
   - Con la coda precedente alla correzione l'SOS si perdeva, come nello Scenario 1.
   - Con la coda corretta arriva in 2,5 h / 3,6 h (g1, tipico / severo) e in 2,1 h / 2,5 h (g3).
   - Rapporto e foto (F4/F3) arrivano in 4 h via Wi-Fi al rientro **solo con una coda DTN**: l'unico caso in tutto lo scenario. Con la coda attuale scadono dopo 5 minuti.
5. **Il meteo pesa molto meno in g3.** Con la perturbazione (+12 dB per 3 h) e il Fixed Relay, in tipico l'SOS al Box impiega 3 h in g1 (deve aspettare la fine della perturbazione) e 50 s in g3: i ~9 dB di EIRP in più del Box e del relay valgono come margine contro il maltempo.
6. **Il guasto del Box non ferma l'SOS, ma ferma tutto il resto.** Con il Box offline l'SOS raggiunge comunque il Portable in 10 s (tipico): avere due infrastrutture in valli diverse dà ridondanza all'emergenza. Ogni altro file però non ha una destinazione alternativa (la Wiki vive solo sul Box, i report sono indirizzati al Box) e resta fermo.
7. **Metrica airtime: aiuta, ma sposta il problema sul relay.** Con la metrica `airtime` l'audio passa dal 3% al 64% (favorevole, g1) e, con la Card al colle in g3 tipico, da non consegnato (51%) a 1,0 h. Ma con il Fixed Relay in g1 tipico la Wiki scende dal 14% a 0: più audio attraversa il relay del colle, il cui duty-cycle è condiviso tra i due versi e servito per priorità, così la Wiki (meno urgente) resta indietro. Una metrica migliore dovrebbe tenere conto anche del carico (budget residuo del duty-cycle), non solo dell'airtime.

## 8. Scenario 3 — Isole Eolie (rete tra isole, aliscafo come data mule)

**Perché questo scenario**: oltre a testare la rete su mare aperto (link lunghi 5-45 km, curvatura terrestre, isole vulcaniche alte), è il **primo scenario costruito come lo userà il tool** (`docs/network-design-tool.md`):

- dispositivi posizionati su **latitudine/longitudine**, con l'altezza dal suolo del proprio tipo (Box 4 m sul tetto, Portable 1,5 m, Card e telefono 1,2 m, Fixed Relay 6 m su palo, Card a bordo 3 m sul mare);
- **territorio interrogabile** (`terrain.ts`, interfaccia `Terrain`): quota e uso del suolo in ogni punto. Ogni link calcola la **diffrazione sul profilo del terreno** (con curvatura terrestre) e il **clutter** dell'uso del suolo ai due estremi (centro abitato denso, abitato, bosco, aperto, mare);
- **BLE e Wi-Fi con link budget** (`model: "budget"`): portata e velocità dipendono da distanza, dispositivo e territorio, a gradini (BLE 2M/1M/Coded PHY, Wi-Fi MCS7…MCS0 e 802.11b);
- per ogni coppia, una **valutazione strutturata** (`assess.ts`): tecnologia, modo radio, velocità istantanea e sostenibile, qualità 0-1. Per ogni dispositivo, un **alone di copertura** per tecnologia.

**Terreno sintetico e coordinate non verificate**: in questo ambiente non c'è accesso a un DEM reale (una richiesta a un servizio pubblico di quote è stata bloccata dalla policy di rete). Le cinque isole sono coni con la quota di vetta indicativa (Lipari ~600 m, Vulcano ~500, Salina ~960, Panarea ~420, Stromboli ~920) e le coordinate dei luoghi sono **approssimative, non verificate su cartografia**. Il tool sostituirà `EOLIE_TERRAIN` con un DEM reale senza toccare il resto.

**Dispositivi**: Box nel centro di Lipari (abitato denso), Portable nel paese di Stromboli, C1 Vulcano Porto, C2 Santa Marina Salina, C3 San Pietro (Panarea), C4 a bordo dell'aliscafo (C4 parte da Lipari alle 0h15, Panarea 1h00, Stromboli 1h45-2h00, Panarea 2h40, rientro a Lipari 3h30), C5 escursionista sul versante di Stromboli (~350 m), ciascuna con il proprio telefono. A **0h30** l'escursionista genera i file; l'SOS punta al Portable (paese) e al Box (Lipari).

| Variante | Cosa succede |
|---|---|
| `static` | aliscafo fermo al porto di Lipari |
| `hydrofoil` | C4 a bordo dell'aliscafo (data mule) |
| `panarea-relay` | ARALD Fixed Relay sulla vetta di Panarea, aliscafo fermo |
| `relay-hydrofoil` | Fixed Relay su Panarea e aliscafo in servizio |
| `box-harbour` | come `hydrofoil`, ma il Box è sul molo di Lipari (dove attracca l'aliscafo) invece che nel centro abitato |

Ambienti: con il territorio esplicito l'esponente di path loss resta vicino allo spazio libero (2,0 / 2,2 / 2,5), con margine di fading 8 / 10 / 12 dB e interferenza 0 / 2 / 5 dB (`TERRAIN_ENVIRONMENTS` in `network-config.ts`).

## 9. Scenario 3 — risultati

Output di `npm run scenario-model -- --scenario eolie --horizon-h 6`. Le sezioni A e B sono identiche agli altri scenari. Le sezioni **F, G e H** sono nuove e hanno già la forma dei dati del tool: pannello connessioni, alone LoRa su scala d'arcipelago, i tre livelli dell'alone attorno al Box.

### C. Scenario 3 — Isole Eolie (rete tra isole, aliscafo come data mule) — link LoRa stimati a t = 0h30 (variante `panarea-relay`), SF minimo che chiude il link

| Link | Distanza | favorevole g1 14 dBm ERP/1% | favorevole g3 27 dBm ERP/10% | tipico g1 14 dBm ERP/1% | tipico g3 27 dBm ERP/10% | severo g1 14 dBm ERP/1% | severo g3 27 dBm ERP/10% |
|---|---:|:---:|:---:|:---:|:---:|:---:|:---:|
| BOX–C1 | 5.4 km | SF9 | SF7 | ✗ | SF10 | ✗ | ✗ |
| BOX–C2 | 12.3 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| BOX–C3 | 21.3 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| BOX–PORT | 44.3 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| BOX–C5 | 43.3 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| C2–C3 | 19.2 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| C3–PORT | 23.1 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| C3–C5 | 22.0 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| PORT–C5 | 1.4 km | SF7 | SF7 | SF7 | SF7 | SF9 | SF7 |
| FR–BOX | 21.1 km | SF7 | SF7 | SF12 | SF8 | ✗ | ✗ |
| FR–PORT | 23.5 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| FR–C5 | 22.4 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

### D. Tempi di consegna end-to-end (policy custody, SF max 12, orizzonte 6 h dalla partenza; file generati a 0h30)


**ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.5 min |
| static | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.9 min |
| static | severo | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.3 min |
| hydrofoil | favorevole | 10 s | 2.7 h | ✗ | ✗ | ✗ | ✗ | 0% | 4.6 min |
| hydrofoil | tipico | 10 s | 3.0 h | ✗ | ✗ | ✗ | ✗ | 0% | 3.1 min |
| hydrofoil | severo | 10 s | 3.2 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.9 min |
| panarea-relay | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 2.6 min |
| panarea-relay | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 2.2 min |
| panarea-relay | severo | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.3 min |
| relay-hydrofoil | favorevole | 10 s | 1.2 h | ✗ | ✗ | ✗ | ✗ | 1% | 3.9 min |
| relay-hydrofoil | tipico | 10 s | 2.4 h | ✗ | ✗ | ✗ | ✗ | 0% | 4.0 min |
| relay-hydrofoil | severo | 10 s | 3.1 h | ✗ | ✗ | ✗ | ✗ | 0% | 3.1 min |
| box-harbour | favorevole | 10 s | 1.2 h | ✗ | ✗ | ✗ | ✗ | 1% | 3.5 min |
| box-harbour | tipico | 10 s | 2.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.9 min |
| box-harbour | severo | 10 s | 2.9 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.3 min |

**ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 5.8 min |
| static | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 5.7 min |
| static | severo | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.3 min |
| hydrofoil | favorevole | 10 s | 1.6 h | ✗ | ✗ | ✗ | ✗ | 1% | 7.1 min |
| hydrofoil | tipico | 10 s | 2.5 h | ✗ | ✗ | ✗ | ✗ | 0% | 8.9 min |
| hydrofoil | severo | 10 s | 2.9 h | ✗ | ✗ | ✗ | ✗ | 0% | 8.6 min |
| panarea-relay | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 8.5 min |
| panarea-relay | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 8.4 min |
| panarea-relay | severo | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.3 min |
| relay-hydrofoil | favorevole | 10 s | 1.2 h | ✗ | ✗ | ✗ | ✗ | 6% | 9.8 min |
| relay-hydrofoil | tipico | 10 s | 1.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 6.9 min |
| relay-hydrofoil | severo | 10 s | 2.9 h | ✗ | ✗ | ✗ | ✗ | 0% | 8.8 min |
| box-harbour | favorevole | 10 s | 1.2 h | ✗ | ✗ | ✗ | ✗ | 2% | 6.6 min |
| box-harbour | tipico | 10 s | 1.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 6.9 min |
| box-harbour | severo | 10 s | 2.5 h | ✗ | ✗ | ✗ | ✗ | 0% | 5.8 min |

**DTN — il relay trattiene la copia fino alla consegna · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 9.5 min |
| static | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 10.8 min |
| static | severo | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 7.8 min |
| hydrofoil | favorevole | 10 s | 2.7 h | ✗ (3%) | ✗ (7%) | ✗ | ✗ | 0% | 13.7 min |
| hydrofoil | tipico | 10 s | 3.0 h | ✗ (3%) | ✗ | ✗ | ✗ | 0% | 9.7 min |
| hydrofoil | severo | 10 s | 3.2 h | ✗ (3%) | ✗ | ✗ | ✗ | 0% | 9.0 min |
| panarea-relay | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 16.1 min |
| panarea-relay | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 12.9 min |
| panarea-relay | severo | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 7.8 min |
| relay-hydrofoil | favorevole | 10 s | 1.3 h | ✗ (5%) | ✗ (13%) | ✗ | ✗ | 1% | 21.1 min |
| relay-hydrofoil | tipico | 10 s | 2.8 h | ✗ (3%) | ✗ (2%) | ✗ | ✗ | 0% | 15.0 min |
| relay-hydrofoil | severo | 10 s | 3.2 h | ✗ (3%) | ✗ | ✗ | ✗ | 0% | 9.4 min |
| box-harbour | favorevole | 10 s | 1.7 h | ✗ (4%) | ✗ (7%) | ✗ | ✗ | 1% | 13.0 min |
| box-harbour | tipico | 10 s | 2.6 h | ✗ (3%) | ✗ (1%) | ✗ | ✗ | 0% | 12.8 min |
| box-harbour | severo | 10 s | 2.9 h | ✗ (3%) | ✗ (0.2%) | ✗ | ✗ | 0% | 8.6 min |

**DTN — il relay trattiene la copia fino alla consegna · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 81.6 min |
| static | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 65.5 min |
| static | severo | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 42.0 min |
| hydrofoil | favorevole | 10 s | 1.7 h | 3.4 h | ✗ (77%) | ✗ (0.6%) | ✗ | 1% | 97.1 min |
| hydrofoil | tipico | 10 s | 2.6 h | 3.9 h | ✗ | ✗ (0.4%) | ✗ | 0% | 95.2 min |
| hydrofoil | severo | 10 s | 2.9 h | 3.7 h | ✗ | ✗ (0.3%) | ✗ | 0% | 66.2 min |
| panarea-relay | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 62.2 min |
| panarea-relay | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 87.1 min |
| panarea-relay | severo | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 42.0 min |
| relay-hydrofoil | favorevole | 10 s | 1.2 h | 3.2 h | ✗ (20%) | ✗ (1%) | ✗ | 6% | 91.5 min |
| relay-hydrofoil | tipico | 10 s | 1.6 h | 2.6 h | ✗ (2%) | ✗ (0.1%) | ✗ | 0% | 113.8 min |
| relay-hydrofoil | severo | 10 s | 3.0 h | 4.1 h | ✗ | ✗ (0.3%) | ✗ | 0% | 75.6 min |
| box-harbour | favorevole | 10 s | 1.2 h | 2.6 h | ✗ (73%) | ✗ (0.6%) | ✗ | 2% | 77.9 min |
| box-harbour | tipico | 10 s | 1.6 h | 3.0 h | 1.5 h | ✗ (0.2%) | ✗ | 0% | 72.4 min |
| box-harbour | severo | 10 s | 2.5 h | 3.8 h | ✗ (0.2%) | ✗ (0.3%) | ✗ | 0% | 101.6 min |

### E. Stessa simulazione con instradamento a costo "airtime" invece che a numero di salti (coda relay ARALD attuale)


**Metrica airtime · ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.5 min |
| static | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.9 min |
| static | severo | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.3 min |
| hydrofoil | favorevole | 10 s | 2.7 h | ✗ | ✗ | ✗ | ✗ | 0% | 4.7 min |
| hydrofoil | tipico | 10 s | 3.0 h | ✗ | ✗ | ✗ | ✗ | 0% | 3.1 min |
| hydrofoil | severo | 10 s | 3.2 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.9 min |
| panarea-relay | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 2.6 min |
| panarea-relay | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 2.2 min |
| panarea-relay | severo | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.3 min |
| relay-hydrofoil | favorevole | 10 s | 1.2 h | ✗ | ✗ | ✗ | ✗ | 1% | 3.9 min |
| relay-hydrofoil | tipico | 10 s | 2.4 h | ✗ | ✗ | ✗ | ✗ | 0% | 4.0 min |
| relay-hydrofoil | severo | 10 s | 3.1 h | ✗ | ✗ | ✗ | ✗ | 0% | 3.1 min |
| box-harbour | favorevole | 10 s | 1.2 h | ✗ | ✗ | ✗ | ✗ | 1% | 3.4 min |
| box-harbour | tipico | 10 s | 2.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.9 min |
| box-harbour | severo | 10 s | 2.9 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.3 min |

**Metrica airtime · ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 5.8 min |
| static | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 5.7 min |
| static | severo | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.3 min |
| hydrofoil | favorevole | 10 s | 1.6 h | ✗ | ✗ | ✗ | ✗ | 1% | 7.1 min |
| hydrofoil | tipico | 10 s | 2.5 h | ✗ | ✗ | ✗ | ✗ | 0% | 8.9 min |
| hydrofoil | severo | 10 s | 2.9 h | ✗ | ✗ | ✗ | ✗ | 0% | 8.6 min |
| panarea-relay | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 8.5 min |
| panarea-relay | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 8.4 min |
| panarea-relay | severo | 10 s | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.3 min |
| relay-hydrofoil | favorevole | 10 s | 1.2 h | ✗ | ✗ | ✗ | ✗ | 6% | 9.4 min |
| relay-hydrofoil | tipico | 10 s | 1.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 6.9 min |
| relay-hydrofoil | severo | 10 s | 2.9 h | ✗ | ✗ | ✗ | ✗ | 0% | 8.8 min |
| box-harbour | favorevole | 10 s | 1.2 h | ✗ | ✗ | ✗ | ✗ | 2% | 6.6 min |
| box-harbour | tipico | 10 s | 1.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 6.9 min |
| box-harbour | severo | 10 s | 2.5 h | ✗ | ✗ | ✗ | ✗ | 0% | 5.8 min |

Legenda D/E: F1 = SOS + coordinate (1 KB) (C5→PORT e BOX); F5 = GPS + audio 10 s (150 KB) (S5→BOX); F2 = Articolo Wiki (200 KB → ~70 KB compresso) (BOX→S5); F4 = Rapporto 5 pag. + 3 JPEG (5 MB) (S5→BOX); F3 = 8 JPEG (12 MB) (S5→BOX). "✗ (x%)" = non consegnato entro l'orizzonte, x% arrivato; "—" = destinazione non raggiunta. "C5→BOX connesso" = frazione del tempo con un percorso simultaneo (connettività istantanea): una consegna avvenuta con questo valore < 100% è passata (anche) per contatti opportunistici. "Airtime LoRa" = tempo di trasmissione LoRa consumato da tutti i file, tutte le copie. Varianti: static = aliscafo fermo: C4 resta al porto di Lipari; hydrofoil = C4 è a bordo dell'aliscafo Lipari → Panarea → Stromboli → Panarea → Lipari (data mule); panarea-relay = ARALD Fixed Relay sulla vetta di Panarea (~420 m), aliscafo fermo; relay-hydrofoil = Fixed Relay a Panarea e aliscafo in servizio; box-harbour = come 'hydrofoil', ma il Box è sul molo di Lipari (dove attracca l'aliscafo) invece che nel centro abitato denso.

### F. Pannello connessioni a t = 0h30 (variante `panarea-relay`, ambiente tipico) — formato del futuro tool


**Profilo radio g1 14 dBm ERP/1%**

| Connessione | Tecnologia | Distanza | Velocità stimata | Sostenuta | Qualità | Linea di vista |
|---|---|---:|---:|---:|---|:---:|
| C1 → S1 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C2 → S2 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C3 → S3 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C4 → S4 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C5 → S5 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| BOX → C4 | LoRa (SF7) | 928 m | 3.2 kbps | 32 bps | Discreta (0.39) | sì |
| PORT → C5 | LoRa (SF7) | 1.4 km | 3.2 kbps | 32 bps | Discreta (0.39) | sì |
| C3 → FR | LoRa (SF7) | 1.4 km | 3.2 kbps | 32 bps | Discreta (0.39) | sì |
| C4 → FR | LoRa (SF10) | 20.3 km | 549 bps | 5 bps | Debole (0.27) | sì |
| C1 → C4 | LoRa (SF11) | 5.8 km | 249 bps | 2 bps | Debole (0.22) | sì |
| BOX → FR | LoRa (SF12) | 21.1 km | 137 bps | 1 bps | Debole (0.18) | sì |
| C2 → FR | LoRa (SF12) | 18.3 km | 137 bps | 1 bps | Debole (0.18) | sì |

**Profilo radio g3 27 dBm ERP/10%**

| Connessione | Tecnologia | Distanza | Velocità stimata | Sostenuta | Qualità | Linea di vista |
|---|---|---:|---:|---:|---|:---:|
| C1 → S1 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C2 → S2 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C3 → S3 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C4 → S4 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C5 → S5 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| BOX → C4 | LoRa (SF7) | 928 m | 3.2 kbps | 317 bps | Discreta (0.39) | sì |
| PORT → C5 | LoRa (SF7) | 1.4 km | 3.2 kbps | 317 bps | Discreta (0.39) | sì |
| C3 → FR | LoRa (SF7) | 1.4 km | 3.2 kbps | 317 bps | Discreta (0.39) | sì |
| C4 → FR | LoRa (SF7) | 20.3 km | 3.2 kbps | 317 bps | Discreta (0.39) | sì |
| BOX → FR | LoRa (SF8) | 21.1 km | 1.8 kbps | 179 bps | Debole (0.35) | sì |
| C1 → C4 | LoRa (SF9) | 5.8 km | 997 bps | 100 bps | Debole (0.31) | sì |
| C2 → FR | LoRa (SF9) | 18.3 km | 997 bps | 100 bps | Debole (0.31) | sì |
| BOX → C1 | LoRa (SF10) | 5.4 km | 549 bps | 55 bps | Debole (0.27) | sì |
| C1 → FR | LoRa (SF10) | 25.8 km | 549 bps | 55 bps | Debole (0.27) | sì |

### G. Alone di copertura LoRa del Box (ricevitore di riferimento: Card), ambiente tipico, celle da 1 km

Legenda: `#` terra coperta, `+` mare coperto, `.` terra non coperta, spazio = mare non coperto, `B` posizione del Box.


**g1 14 dBm ERP/1%** — celle coperte: 94 su 2040

```text


                                ..
                               ....
                              ......
                              ......
                               ....
                                ..












                    .
                   ...
                   ...
                   ..


...
....
.....
.....
.....
.....
....
...
..    ....
     ......
    ........  ++
    ........ ++++
    ....##..+++++
    ....####+++++
    ....##B#+++++
     ....##++++++
      ..##+++++++
       ++++++++++
      ++++++++++
      ++++++++++
       ++####.+
         #####
        .####..
        .......
        .......
```

**g3 27 dBm ERP/10%** — celle coperte: 335 su 2040

```text


                                ..
                               ....
                              ......
                              ......
                               ....
                                ..












                    .
                   ...
                   ...
                   ..


...
....
.....
.....             +++
.....            +++++
.....           +++++++
....           ++++++++
...           ++++++++++
..    ....    ++++++++++
     ......  ++++++++++++
    ........+++++++++++++
    ........+++++++++++++
    ....####++++++++++++++
    ....####++++++++++++++
    ....##B#++++++++++++++
     ...###+++++++++++++++
      .###++++++++++++++++
      ++++++++++++++++++++
    +++++++++++++++++++++
   ++++++++++++++++++++++
  +++++++#####+++++++++++
 ++++++++#####++++++++++
 +++++++#######+++++++++
++++++++.......++++++++
++++++++.......+++++++
```

### H. I tre livelli dell'alone del Box, uno per tecnologia (celle da 40 m, ±1 km, ambiente tipico, g1 14 dBm ERP/1%)

Ogni livello è calcolato separatamente verso il proprio ricevitore di riferimento (Wi-Fi e BLE → smartphone, LoRa → Card). `#` = coperto, `.` = non coperto, `B` = Box. Con celle da 40 m, una copertura di poche celle attorno al Box indica una portata di qualche decina di metri o meno: la risoluzione non permette di dire di più. La forma dell'alone che segue il territorio si vede su LoRa, sezione G.

```text
Wi-Fi                                                BLE                                                  LoRa
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
........................##........................   ........................##........................   ##################################################
.......................#BB#.......................   .......................#BB#.......................   ########################BB########################
.......................#BB#.......................   .......................#BB#.......................   ########################BB########################
........................##........................   ........................##........................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
```
- Wi-Fi: 12 celle coperte su 2500 (19200 m²)
- BLE: 12 celle coperte su 2500 (19200 m²)
- LoRa: 2500 celle coperte su 2500 (4000000 m²)

## 10. Scenario 3 — cosa dice il modello

1. **Stromboli è un'isola anche per la radio.** L'SOS arriva al Portable del paese in 10 s, ma **non arriva mai al Box di Lipari** senza l'aliscafo, in ogni ambiente, sotto-banda e coda. Il paese e l'escursionista sono sul versante nord-est di Stromboli, **dietro il cono del vulcano** rispetto a Lipari: 35-41 dB di diffrazione, con l'ostacolo a meno di 2 km da loro. Anche su mare aperto, comunque, 43 km tra dispositivi a pochi metri sul livello del mare costerebbero diversi dB di curvatura terrestre (~8 dB nel modello).
2. **Un relay in quota non basta se è sul lato sbagliato.** Il Fixed Relay sulla vetta di Panarea vede Lipari (21 km, SF12 in g1 / SF8 in g3) e Salina, ma **non il paese né l'escursionista di Stromboli**: il cono del vulcano è in mezzo (36-42 dB di diffrazione, ostacolo a ~21,7 km dal relay). Da solo non cambia nulla per l'SOS. È l'esempio concreto di copertura che non è un cerchio, ed è ciò che il tool deve mostrare (§4 di `docs/network-design-tool.md`).
3. **L'aliscafo è il vero ponte.** Con la coda corretta l'SOS raccolto a Stromboli arriva al Box in 3,0 h (g1) / 2,5 h (g3) in condizioni tipiche. Con la coda precedente alla correzione scadeva prima che l'aliscafo tornasse in copertura di Lipari, come negli Scenari 1 e 2.
4. **Il relay di Panarea accorcia l'attesa del mulo.** Al ritorno l'aliscafo rientra in copertura già all'altezza di Panarea: l'SOS arriva in 2,4 h invece di 3,0 h (g1) e in 1,6 h invece di 2,5 h (g3). Qui il relay non serve a coprire Stromboli ma ad accorciare il percorso del mulo: un ruolo diverso da quello che ci si aspetterebbe guardando solo la mappa. Con la coda precedente era l'unico modo di non perdere l'SOS.
5. **La posizione del Box conta quanto la sua potenza.** Nel centro abitato denso il Box paga ~15 dB di clutter a 868 MHz. Spostato sul molo, riceve l'SOS dall'aliscafo in arrivo prima: 2,6 h invece di 3,0 h (g1) e 1,6 h invece di 2,5 h (g3), in condizioni tipiche. Nel centro denso Wi-Fi e BLE del Box raggiungono un telefono in strada fino a 60 m in condizioni tipiche (85 m favorevoli, 35 m severe; misurato lungo un raggio, non letto dalla griglia della sezione H); sul molo, in g3 con coda DTN, anche la Wiki raggiunge l'escursionista (1,5 h) passando per l'aliscafo.
6. **I file grandi non arrivano: il mulo deve passare dove sono i dati.** L'escursionista non incontra mai l'aliscafo né il Portable, quindi foto e rapporto restano sul suo telefono; solo l'audio (150 KB) arriva, in g3 con coda DTN (2,6-4,1 h), a pezzi via LoRa. Un'indicazione di progetto, non verificata nel modello: mettere il Portable al molo dove attracca l'aliscafo permetterebbe ai telefoni a bordo di sincronizzarsi via Wi-Fi a ogni passaggio.
7. **Il pannello del tool è già calcolabile** (sezione F e `npm run scenario-model -- --config tools/scenario-model/examples/eolie.json`): per ogni coppia tecnologia, modo radio, velocità istantanea e sostenibile, qualità. Ad esempio Card ↔ telefono BLE 2M PHY 1,0 Mbps (qualità 0,77), Box ↔ relay di Panarea LoRa SF8 1,8 kbps istantanei / 179 bps sostenuti in g3 (0,35).

## 11. Scenario 4 — Deserto di Atacama (distanze lunghe, fuoristrada come data mule, banda 915-928 MHz)

**Perché questo scenario**:
- **Distanze di decine di chilometri** su un deserto aperto ad alta quota, dove i nodi sono pochi e lontani. Le persone si spostano in fuoristrada (~60 km/h), non a piedi, quindi il data mule è molto più veloce che negli altri scenari.
- **Prima regione radio fuori dall'Europa**: in Cile LoRa usa la banda 915-928 MHz. Il modello applica il piano "AU915" dei parametri regionali LoRaWAN: 30 dBm EIRP, **nessun duty-cycle**, ma un **dwell time di 400 ms** per singola trasmissione. È ricostruito da conoscenza generale e **non verificato sulla normativa cilena** in questo ambiente. Il dwell time accorcia i frame agli SF lenti e rende inutilizzabili SF11 e SF12.
- **Selezionare le regole della regione** è un'informazione indispensabile per il tool: oltre a potenza e duty-cycle cambiano gli SF utilizzabili e quindi la portata. Il motore ora la supporta (`RegulatoryProfile.maxDwellS`, `centerFreqHz`; profilo `AU915`; `"regulatory": "au915"` nella configurazione salvata).

**Terreno sintetico** (`syntheticLandscape` in `terrain.ts`, nuovo builder generico):
- un salar piatto a ~2300 m che sale verso l'altopiano andino (~4200 m) a est;
- la cresta della Cordillera de la Sal tra San Pedro e la Valle de la Luna;
- i coni del Licancabur e del Láscar;
- un rilievo panoramico **ipotetico** sopra il salar, dove nelle varianti con relay si colloca il Fixed Relay.

Coordinate e quote sono **approssimative, non verificate su cartografia**.

**Dispositivi**:
- Box nel paese di San Pedro de Atacama;
- Portable a Toconao (~36 km);
- C1 nella Valle de la Luna (~9 km, dietro la cresta);
- C2 alla Laguna Chaxa nel salar (~42 km);
- C3 a Socaire (~80 km);
- C4 sul fuoristrada di un tour;
- C5 con un gruppo fermo alla Laguna Miscanti (~4140 m, ~100 km dal Box);
- ciascuna Card con il proprio telefono.

Il fuoristrada parte da San Pedro, passa da Toconao (0h45) e Socaire (1h35), arriva alla laguna alle 2h05, resta 15 minuti e torna a San Pedro alle 4h25. A **0h30** il gruppo alla laguna genera i file. L'SOS punta al Portable e al Box.

| Variante | Cosa succede |
|---|---|
| `static` | fuoristrada fermo a San Pedro |
| `vehicle` | fuoristrada in servizio (data mule) |
| `andes-relay` | Fixed Relay sul rilievo panoramico, fuoristrada fermo |
| `relay-vehicle` | Fixed Relay e fuoristrada in servizio |
| `portable-vehicle` | come `vehicle`, ma il Portable viaggia sul fuoristrada invece di restare a Toconao |

Le tabelle confrontano **AU915** (le regole della regione) con **EU868 g3** (le regole europee al 10%) a parità di tutto il resto.

## 12. Scenario 4 — risultati

Output di `npm run scenario-model -- --scenario atacama --horizon-h 6`. Le sezioni A e B sono identiche agli altri scenari (profili europei); la **B2** confronta la capacità per SF con i profili di questo scenario.

### B2. Capacità LoRa per SF con i profili regolatori di questo scenario

Con un dwell time massimo il frame si accorcia agli SF lenti; "—" = SF inutilizzabile (nemmeno un frame minimo sta nel dwell time).

| SF | AU915 30 dBm EIRP, dwell 400 ms: frame · istantanea · sostenuta | EU868 g3 (confronto): frame · istantanea · sostenuta |
|---|---:|---:|
| SF7 | 222 B · 3.2 kbps · 3.2 kbps | 222 B · 3.2 kbps · 317 bps |
| SF8 | 138 B · 1.6 kbps · 1.6 kbps | 222 B · 1.8 kbps · 179 bps |
| SF9 | 66 B · 622 bps · 622 bps | 222 B · 997 bps · 100 bps |
| SF10 | 24 B · 30 bps · 30 bps | 222 B · 549 bps · 55 bps |
| SF11 | — | 222 B · 249 bps · 25 bps |
| SF12 | — | 222 B · 137 bps · 14 bps |

### C. Scenario 4 — Deserto di Atacama (distanze lunghe, fuoristrada come data mule, banda 915-928 MHz) — link LoRa stimati a t = 0h30 (variante `andes-relay`), SF minimo che chiude il link

| Link | Distanza | favorevole AU915 30 dBm EIRP, dwell 400 ms | favorevole EU868 g3 (confronto) | tipico AU915 30 dBm EIRP, dwell 400 ms | tipico EU868 g3 (confronto) | severo AU915 30 dBm EIRP, dwell 400 ms | severo EU868 g3 (confronto) |
|---|---:|:---:|:---:|:---:|:---:|:---:|:---:|
| BOX–C1 | 8.8 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| BOX–C2 | 42.0 km | ✗ | SF11 | ✗ | ✗ | ✗ | ✗ |
| BOX–PORT | 36.5 km | SF9 | SF8 | ✗ | ✗ | ✗ | ✗ |
| BOX–C3 | 81.5 km | ✗ | SF12 | ✗ | ✗ | ✗ | ✗ |
| PORT–C2 | 21.2 km | SF8 | SF8 | ✗ | ✗ | ✗ | ✗ |
| PORT–C3 | 46.1 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| C3–C5 | 19.8 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| PORT–C5 | 64.7 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| FR–BOX | 62.3 km | SF7 | SF7 | SF10 | SF10 | ✗ | ✗ |
| FR–PORT | 26.6 km | SF7 | SF7 | SF9 | SF8 | ✗ | ✗ |
| FR–C3 | 19.5 km | SF7 | SF7 | SF9 | SF9 | ✗ | ✗ |
| FR–C5 | 38.4 km | ✗ | SF11 | ✗ | ✗ | ✗ | ✗ |

### D. Tempi di consegna end-to-end (policy custody, SF max 12, orizzonte 6 h dalla partenza; file generati a 0h30)


**ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio AU915 30 dBm EIRP, dwell 400 ms**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.0 min |
| static | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.4 min |
| vehicle | favorevole | 2.1 h | 2.1 h | ✗ | ✗ | ✗ | ✗ | 3% | 11.3 min |
| vehicle | tipico | 3.0 h | 3.7 h | ✗ | ✗ | ✗ | ✗ | 0% | 8.7 min |
| vehicle | severo | 3.1 h | 3.9 h | ✗ | ✗ | ✗ | ✗ | 0% | 4.4 min |
| andes-relay | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.5 min |
| andes-relay | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.0 min |
| andes-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.4 min |
| relay-vehicle | favorevole | 1.4 h | 1.4 h | ✗ | ✗ | ✗ | ✗ | 8% | 7.4 min |
| relay-vehicle | tipico | 2.1 h | 2.2 h | ✗ | ✗ | ✗ | ✗ | 0% | 13.9 min |
| relay-vehicle | severo | 3.1 h | 3.9 h | ✗ | ✗ | ✗ | ✗ | 0% | 5.9 min |
| portable-vehicle | favorevole | 1.3 h | 1.3 h | ✗ | ✗ | ✗ | ✗ | 7% | 4.8 min |
| portable-vehicle | tipico | 1.4 h | 3.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 12.4 min |
| portable-vehicle | severo | 1.5 h | 3.8 h | ✗ | ✗ | ✗ | ✗ | 0% | 5.0 min |

**ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio EU868 g3 (confronto)**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 7.6 min |
| static | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.4 min |
| vehicle | favorevole | 1.3 h | 1.3 h | ✗ | ✗ | ✗ | ✗ | 9% | 9.0 min |
| vehicle | tipico | 2.8 h | 3.5 h | ✗ | ✗ | ✗ | ✗ | 0% | 8.0 min |
| vehicle | severo | 3.1 h | 3.8 h | ✗ | ✗ | ✗ | ✗ | 0% | 6.1 min |
| andes-relay | favorevole | 1.2 min | 1.0 min | ✗ (47%) | ✗ (85%) | ✗ | ✗ | 100% | 79.6 min |
| andes-relay | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.0 min |
| andes-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.4 min |
| relay-vehicle | favorevole | 1.2 min | 1.0 min | 3.6 h | ✗ (90%) | 4.0 h | 4.1 h | 100% | 90.9 min |
| relay-vehicle | tipico | 1.4 h | 1.4 h | ✗ | ✗ | ✗ | ✗ | 3% | 4.6 min |
| relay-vehicle | severo | 3.1 h | 3.8 h | ✗ | ✗ | ✗ | ✗ | 0% | 7.2 min |
| portable-vehicle | favorevole | 1.2 h | 1.2 h | ✗ | ✗ | ✗ | ✗ | 14% | 8.7 min |
| portable-vehicle | tipico | 1.4 h | 2.4 h | ✗ | ✗ | ✗ | ✗ | 0% | 7.1 min |
| portable-vehicle | severo | 1.5 h | 3.8 h | ✗ | ✗ | ✗ | ✗ | 0% | 5.8 min |

**DTN — il relay trattiene la copia fino alla consegna · profilo radio AU915 30 dBm EIRP, dwell 400 ms**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 21.3 min |
| static | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.4 min |
| vehicle | favorevole | 2.1 h | 2.1 h | 3.0 h | 1.6 h | 3.9 h | 3.9 h | 3% | 96.6 min |
| vehicle | tipico | 3.0 h | 3.7 h | 3.9 h | ✗ | 3.9 h | 3.9 h | 0% | 33.3 min |
| vehicle | severo | 3.1 h | 3.9 h | 3.9 h | ✗ | 3.9 h | 4.0 h | 0% | 10.7 min |
| andes-relay | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 27.4 min |
| andes-relay | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 165.3 min |
| andes-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.4 min |
| relay-vehicle | favorevole | 1.4 h | 1.4 h | 2.6 h | 1.6 h | 3.9 h | 3.9 h | 8% | 102.7 min |
| relay-vehicle | tipico | 2.1 h | 2.2 h | 3.9 h | ✗ | 3.9 h | 3.9 h | 0% | 165.3 min |
| relay-vehicle | severo | 3.1 h | 3.9 h | 3.9 h | ✗ | 3.9 h | 4.0 h | 0% | 21.2 min |
| portable-vehicle | favorevole | 1.3 h | 1.3 h | 2.4 h | 1.6 h | 3.9 h | 3.9 h | 7% | 81.0 min |
| portable-vehicle | tipico | 1.4 h | 3.6 h | 3.9 h | ✗ | 3.9 h | 3.9 h | 0% | 45.7 min |
| portable-vehicle | severo | 1.5 h | 3.8 h | 3.9 h | ✗ | 3.9 h | 4.0 h | 0% | 9.5 min |

**DTN — il relay trattiene la copia fino alla consegna · profilo radio EU868 g3 (confronto)**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 61.2 min |
| static | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.4 min |
| vehicle | favorevole | 1.3 h | 1.3 h | 3.3 h | 1.6 h | 3.9 h | 3.9 h | 9% | 82.2 min |
| vehicle | tipico | 2.9 h | 3.6 h | 3.9 h | ✗ | 3.9 h | 3.9 h | 0% | 30.8 min |
| vehicle | severo | 3.1 h | 3.8 h | 3.9 h | ✗ | 3.9 h | 4.0 h | 0% | 15.2 min |
| andes-relay | favorevole | 1.2 min | 1.0 min | ✗ (47%) | ✗ (85%) | ✗ | ✗ | 100% | 79.6 min |
| andes-relay | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 40.9 min |
| andes-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.4 min |
| relay-vehicle | favorevole | 1.2 min | 1.0 min | 3.6 h | ✗ (90%) | 4.0 h | 4.1 h | 100% | 90.9 min |
| relay-vehicle | tipico | 1.4 h | 1.5 h | 3.9 h | ✗ (60%) | 3.9 h | 3.9 h | 3% | 104.9 min |
| relay-vehicle | severo | 3.1 h | 3.8 h | 3.9 h | ✗ | 3.9 h | 4.0 h | 0% | 18.7 min |
| portable-vehicle | favorevole | 1.2 h | 1.2 h | 2.4 h | 1.6 h | 3.9 h | 3.9 h | 14% | 75.0 min |
| portable-vehicle | tipico | 1.4 h | 2.4 h | 3.9 h | ✗ (25%) | 3.9 h | 3.9 h | 0% | 77.7 min |
| portable-vehicle | severo | 1.5 h | 3.8 h | 3.9 h | ✗ | 3.9 h | 4.0 h | 0% | 13.6 min |

### E. Stessa simulazione con instradamento a costo "airtime" invece che a numero di salti (coda relay ARALD attuale)


**Metrica airtime · ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio AU915 30 dBm EIRP, dwell 400 ms**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.0 min |
| static | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.4 min |
| vehicle | favorevole | 2.0 h | 2.1 h | ✗ | ✗ | ✗ | ✗ | 3% | 11.2 min |
| vehicle | tipico | 3.0 h | 3.7 h | ✗ | ✗ | ✗ | ✗ | 0% | 8.7 min |
| vehicle | severo | 3.1 h | 3.9 h | ✗ | ✗ | ✗ | ✗ | 0% | 4.4 min |
| andes-relay | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.5 min |
| andes-relay | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.0 min |
| andes-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.4 min |
| relay-vehicle | favorevole | 1.4 h | 1.4 h | ✗ | ✗ | ✗ | ✗ | 8% | 7.3 min |
| relay-vehicle | tipico | 2.1 h | 2.2 h | ✗ | ✗ | ✗ | ✗ | 0% | 13.9 min |
| relay-vehicle | severo | 3.1 h | 3.9 h | ✗ | ✗ | ✗ | ✗ | 0% | 5.9 min |
| portable-vehicle | favorevole | 1.3 h | 1.3 h | ✗ | ✗ | ✗ | ✗ | 7% | 4.8 min |
| portable-vehicle | tipico | 1.4 h | 3.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 12.4 min |
| portable-vehicle | severo | 1.5 h | 3.8 h | ✗ | ✗ | ✗ | ✗ | 0% | 5.0 min |

**Metrica airtime · ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio EU868 g3 (confronto)**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 7.6 min |
| static | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.4 min |
| vehicle | favorevole | 1.3 h | 1.3 h | ✗ | ✗ | ✗ | ✗ | 9% | 9.0 min |
| vehicle | tipico | 2.8 h | 3.5 h | ✗ | ✗ | ✗ | ✗ | 0% | 8.0 min |
| vehicle | severo | 3.1 h | 3.8 h | ✗ | ✗ | ✗ | ✗ | 0% | 6.1 min |
| andes-relay | favorevole | 1.2 min | 1.0 min | ✗ (47%) | ✗ (85%) | ✗ | ✗ | 100% | 79.6 min |
| andes-relay | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.0 min |
| andes-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.4 min |
| relay-vehicle | favorevole | 1.2 min | 1.0 min | 2.7 h | ✗ (86%) | 3.9 h | 3.9 h | 100% | 100.4 min |
| relay-vehicle | tipico | 1.4 h | 1.4 h | ✗ | ✗ | ✗ | ✗ | 3% | 4.6 min |
| relay-vehicle | severo | 3.1 h | 3.8 h | ✗ | ✗ | ✗ | ✗ | 0% | 7.2 min |
| portable-vehicle | favorevole | 1.2 h | 1.2 h | ✗ | ✗ | ✗ | ✗ | 14% | 8.7 min |
| portable-vehicle | tipico | 1.4 h | 2.4 h | ✗ | ✗ | ✗ | ✗ | 0% | 7.1 min |
| portable-vehicle | severo | 1.5 h | 3.8 h | ✗ | ✗ | ✗ | ✗ | 0% | 5.8 min |

Legenda D/E: F1 = SOS + coordinate (1 KB) (C5→PORT e BOX); F5 = GPS + audio 10 s (150 KB) (S5→BOX); F2 = Articolo Wiki (200 KB → ~70 KB compresso) (BOX→S5); F4 = Rapporto 5 pag. + 3 JPEG (5 MB) (S5→BOX); F3 = 8 JPEG (12 MB) (S5→BOX). "✗ (x%)" = non consegnato entro l'orizzonte, x% arrivato; "—" = destinazione non raggiunta. "C5→BOX connesso" = frazione del tempo con un percorso simultaneo (connettività istantanea): una consegna avvenuta con questo valore < 100% è passata (anche) per contatti opportunistici. "Airtime LoRa" = tempo di trasmissione LoRa consumato da tutti i file, tutte le copie. Varianti: static = fuoristrada fermo a San Pedro; vehicle = fuoristrada (C4) San Pedro → Toconao → Socaire → Laguna Miscanti e ritorno (data mule); andes-relay = ARALD Fixed Relay sul rilievo panoramico sopra il salar, fuoristrada fermo; relay-vehicle = Fixed Relay e fuoristrada in servizio; portable-vehicle = come 'vehicle', ma il Portable viaggia sul fuoristrada invece di restare a Toconao.

### F. Pannello connessioni a t = 0h30 (variante `andes-relay`, ambiente tipico) — formato del futuro tool


**Profilo radio AU915 30 dBm EIRP, dwell 400 ms**

| Connessione | Tecnologia | Distanza | Velocità stimata | Sostenuta | Qualità | Linea di vista |
|---|---|---:|---:|---:|---|:---:|
| BOX → S4 | Wi-Fi (MCS2) | 43 m | 11.0 Mbps | 11.0 Mbps | Ottima (0.93) | sì |
| C1 → S1 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C2 → S2 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C3 → S3 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C4 → S4 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C5 → S5 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| BOX → C4 | BLE (Coded S2) | 40 m | 120 kbps | 120 kbps | Buona (0.63) | sì |
| C2 → FR | LoRa (SF8) | 28.5 km | 1.6 kbps | 1.6 kbps | Debole (0.34) | sì |
| PORT → FR | LoRa (SF9) | 26.6 km | 622 bps | 622 bps | Debole (0.28) | sì |
| C3 → FR | LoRa (SF9) | 19.5 km | 622 bps | 622 bps | Debole (0.28) | sì |
| BOX → FR | LoRa (SF10) | 62.3 km | 30 bps | 30 bps | Debole (0.07) | sì |

**Profilo radio EU868 g3 (confronto)**

| Connessione | Tecnologia | Distanza | Velocità stimata | Sostenuta | Qualità | Linea di vista |
|---|---|---:|---:|---:|---|:---:|
| BOX → S4 | Wi-Fi (MCS2) | 43 m | 11.0 Mbps | 11.0 Mbps | Ottima (0.93) | sì |
| C1 → S1 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C2 → S2 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C3 → S3 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C4 → S4 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C5 → S5 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| BOX → C4 | BLE (Coded S2) | 40 m | 120 kbps | 120 kbps | Buona (0.63) | sì |
| PORT → FR | LoRa (SF8) | 26.6 km | 1.8 kbps | 179 bps | Debole (0.35) | sì |
| C2 → FR | LoRa (SF8) | 28.5 km | 1.8 kbps | 179 bps | Debole (0.35) | sì |
| C3 → FR | LoRa (SF9) | 19.5 km | 997 bps | 100 bps | Debole (0.31) | sì |
| BOX → FR | LoRa (SF10) | 62.3 km | 549 bps | 55 bps | Debole (0.27) | sì |

### G. Alone di copertura LoRa del Box (ricevitore di riferimento: Card), ambiente tipico, celle da 2 km

Legenda: `#` terra coperta, `.` terra non coperta, `B` posizione del Box.


**AU915 30 dBm EIRP, dwell 400 ms** — celle coperte: 121 su 1550

```text
...##########..####............
...##########..#####...........
...###B######..#####...........
...##########..####............
...##########..####............
...#########...####............
..##########....###............
..#########.....##.............
..#.#####........#.............
..#............................
..#............................
..#............................
..#............................
.#.............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
```

**EU868 g3 (confronto)** — celle coperte: 362 su 1550

```text
...#####################.##....
...########################....
...###B####################....
...########################....
...#######################.....
..########################.....
..########################.....
..########################.....
..########################.....
..########################.....
..###########..###########.....
..##########...###########.....
..#######......###########.....
.##.............##########.....
.##.............##########.....
................##########.....
................#########......
.................#######.......
.................######........
..................####.........
..................###..........
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
...............................
```

### H. I tre livelli dell'alone del Box, uno per tecnologia (celle da 40 m, ±1 km, ambiente tipico, AU915 30 dBm EIRP, dwell 400 ms)

Ogni livello è calcolato separatamente verso il proprio ricevitore di riferimento (Wi-Fi e BLE → smartphone, LoRa → Card). `#` = coperto, `.` = non coperto, `B` = Box. Con celle da 40 m, una copertura di poche celle attorno al Box indica una portata di qualche decina di metri o meno: la risoluzione non permette di dire di più. La forma dell'alone che segue il territorio si vede su LoRa, sezione G.

```text
Wi-Fi                                                BLE                                                  LoRa
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
.......................####.......................   .......................####.......................   ##################################################
.......................#BB#.......................   .......................#BB#.......................   ########################BB########################
.......................####.......................   .......................####.......................   ##################################################
.......................####.......................   .......................####.......................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
..................................................   ..................................................   ##################################################
```
- Wi-Fi: 16 celle coperte su 2500 (25600 m²)
- BLE: 16 celle coperte su 2500 (25600 m²)
- LoRa: 2500 celle coperte su 2500 (4000000 m²)

## 13. Scenario 4 — cosa dice il modello

1. **Il deserto è troppo grande per una rete fissa di pochi nodi.** Senza fuoristrada e senza relay (variante `static`) l'SOS dalla Laguna Miscanti non raggiunge né il Portable (~65 km) né il Box (~100 km), in nessun ambiente e con nessuna delle due regole. Con il Fixed Relay ci riesce solo in condizioni favorevoli e con le regole europee (punto 4). Anche a 9 km la Cordillera de la Sal nasconde la Valle de la Luna al Box: nessun link nemmeno in condizioni favorevoli.
2. **Il fuoristrada è il ponte, ed è veloce.** Con la coda attuale l'SOS arriva in 3,0 h al Portable e 3,7 h al Box (AU915, tipico).
   - Con il Fixed Relay il fuoristrada rientra in copertura prima: 2,1 h / 2,2 h.
   - Con il Portable a bordo l'SOS raggiunge il Portable in 1,4 h, mentre il fuoristrada si avvicina alla laguna. Una presenza di infrastruttura mobile vicino all'evento.
3. **Foto e rapporto arrivano solo se il mulo passa dai dati, e solo con una coda DTN.** Durante la sosta alla laguna i telefoni si scambiano i file via BLE. Al rientro il telefono sul fuoristrada li consegna al Box via Wi-Fi: rapporto e foto in ~3,9 h, audio in 3,9 h (2,4-3,0 h in condizioni favorevoli). Con la coda attuale scadono dopo 5 minuti di isolamento, come negli altri scenari.
4. **Il dwell time pesa più del duty-cycle.**
   - Senza duty-cycle LoRa sostiene in AU915 tutta la sua velocità istantanea (3,2 kbps a SF7, contro 317 bps in EU g3).
   - Ma SF11 e SF12 sono vietati, e a SF10 il frame scende a 24 byte, di cui 22 di intestazione ARALD: restano ~30 bit/s utili, contro 549 bit/s in Europa allo stesso SF.
   - L'alone LoRa del Box copre circa un terzo dell'area in AU915 rispetto a EU g3 (121 contro 362 celle da 2 km).
   - Con il Fixed Relay, in condizioni favorevoli, la regola europea chiude il link relay–laguna a SF11 e l'SOS arriva al Box in ~1 minuto. Con le regole cilene quel link non esiste.
5. **L'intestazione dei frame ARALD è il vero costo nelle regioni con dwell time.** I 22 byte di framing per frame e l'overhead ×1,45 del base64 nel JSON sono trascurabili a SF7, ma a SF9-SF10 si mangiano la maggior parte del frame. Esempio: nella variante con relay e coda DTN, in condizioni tipiche, 165 minuti di airtime LoRa non consegnano nulla, spesi a inondare la Wiki a SF10 verso un destinatario irraggiungibile. Ridurre il framing (header binario, niente base64 sul canale LoRa) avrebbe qui un effetto diretto sulla portata utile.
6. **Il pannello del tool cambia con la regione.** Per Box ↔ relay a 62 km risulta SF10, 30 bit/s, qualità 0,07 in AU915 e SF10, 549 bit/s istantanei / 55 sostenuti, qualità 0,27 in EU g3 (sezione F). La stessa geometria con regole diverse dà linee di colore diverso: il tool deve rendere visibile la regione scelta.

## 14. Scenario 5 — Kampala (città densa su colline, blackout, corriere in boda-boda)

**Perché questo scenario**: è il contrario degli scenari alpini e del deserto, ed è il terzo ambiente di validazione (missioni umanitarie in contesti urbani).
- **Distanze brevi (2-8 km) ma ostruzione continua**: edifici, un centro densissimo, colline di 50-100 m.
- **Spostamenti lenti**: il corriere è un motociclo "boda-boda" nel traffico (15-20 km/h).
- **Blackout elettrici**: il Box può restare senza corrente.
- **Posizione del Box decisiva**: in città decide l'altezza dell'antenna (tetto o strada).

Nuovo nel motore (`terrain.ts`): il clutter a un estremo scala con l'**altezza dell'antenna dal suolo** (`Terrain.clutterHeightRelief`, `CLUTTER_HEIGHT_M`: 20 m nel centro denso, 10 m nell'abitato, 15 m nel bosco; frazione residua 20% sopra i tetti). È attivo solo nei terreni che lo dichiarano: gli Scenari 1-4 non lo usano e non cambiano.

**Terreno sintetico e coordinate non verificate**: pianura che sale da 1135 m (lago Vittoria, a sud) a ~1195 m, sette colline di 50-100 m (Namirembe, Makerere, Kololo, Naguru, Nakasero, Kibuli, Muyenga), tre zone di abitato denso (centro d'affari, Kawempe, Katwe/Kisenyi), una corona urbana di 9 km, periferia a "bosco". Il lago non è modellato come classe di suolo. Quote, posizioni e il profilo regolatorio per l'Uganda (qui EU868 g1/g3) sono **ipotesi non verificate**.

**Calibrazione dell'ambiente urbano**: un primo tentativo con esponente di path loss 3,2 sommato al clutter agli estremi contava due volte l'effetto della città (in quel tentativo praticamente nessun link chiudeva, nemmeno a 2 km). L'esponente è stato calibrato sul modello **Okumura-Hata** per città grandi a 868 MHz, con antenna del Box a 12 m e terminale a 1,5 m (Hata è valido per antenne base da 30 a 200 m: qui è estrapolato). **La calibrazione vale per la classe "abitato"**: con esponente 3,0 il modello resta entro 5 dB da Hata da 0,5 a 6 km, scarto da 0 a −4 dB, cioè al più 4 dB più ottimista (test dedicato). **Non vale per le zone "abitato denso"** (centro d'affari, Kawempe, Katwe): lì il clutter è 15 dB contro 8 e il modello risulta 8-12 dB più pessimista di Hata, un'ipotesi non verificata. Le conclusioni su un dispositivo dentro quelle zone (il Portable a Kawempe, le Card nel centro) sono quindi prudenti. Ambienti: 2,6 / 3,0 / 3,4 con margine di fading 8 / 10 / 12 dB e interferenza 2 / 4 / 6 dB, portati dal territorio (`Terrain.propagation`).

**Dispositivi** (altezze di installazione tipiche del contesto):
- Box sul tetto di un edificio di 3 piani a Kololo (12 m);
- Portable al primo piano della clinica di Kawempe (6 m, ~6 km, quartiere denso);
- C1 nel centro d'affari, C2 a Makerere, C3 a Namirembe, C5 a Bweyogerere (periferia est, ~7 km), tutte a terra (1,2 m);
- C4 sul corriere in boda-boda;
- ciascuna Card con il proprio telefono.

Il Fixed Relay sta su un traliccio di 25 m sulla collina di Naguru, in alcune varianti. A **0h30** l'operatore a Bweyogerere genera i file; l'SOS punta alla clinica e alla sede. Il boda parte dal centro alle 0h45, passa da Naguru (1h00) e Bweyogerere (1h27-1h42, sosta), torna da Naguru (2h09), poi alla clinica di Kawempe (2h30-2h40) e arriva alla sede alle 3h06.

| Variante | Cosa succede |
|---|---|
| `static` | boda fermo, nessun relay |
| `boda` | il corriere compie il giro (data mule nel traffico) |
| `naguru-relay` | Fixed Relay sul traliccio, boda fermo |
| `relay-boda` | Fixed Relay e corriere in servizio |
| `box-ground` | come `naguru-relay`, ma il Box è a terra (1,5 m) invece che sul tetto |
| `relay-blackout` | come `relay-boda`, ma il Box resta senza corrente a 0h15 (nessun UPS) |

## 15. Scenario 5 — risultati

Output di `npm run scenario-model -- --scenario kampala --horizon-h 6`. Le sezioni A e B sono identiche agli altri scenari. Le mappe di copertura hanno celle da 250 m (nuovo `Scenario.coverageCellM`).

### C. Scenario 5 — Kampala (città densa su colline, blackout, corriere in boda-boda) — link LoRa stimati a t = 0h30 (variante `naguru-relay`), SF minimo che chiude il link

| Link | Distanza | favorevole g1 14 dBm ERP/1% | favorevole g3 27 dBm ERP/10% | tipico g1 14 dBm ERP/1% | tipico g3 27 dBm ERP/10% | severo g1 14 dBm ERP/1% | severo g3 27 dBm ERP/10% |
|---|---:|:---:|:---:|:---:|:---:|:---:|:---:|
| BOX–C1 | 1.8 km | SF11 | SF8 | ✗ | ✗ | ✗ | ✗ |
| BOX–C2 | 3.0 km | SF10 | SF7 | ✗ | ✗ | ✗ | ✗ |
| BOX–C3 | 4.7 km | ✗ | SF9 | ✗ | ✗ | ✗ | ✗ |
| BOX–PORT | 6.1 km | ✗ | SF9 | ✗ | ✗ | ✗ | ✗ |
| BOX–C5 | 6.8 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| C1–C2 | 2.5 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| PORT–C2 | 4.1 km | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| FR–BOX | 2.3 km | SF7 | SF7 | SF10 | SF7 | ✗ | ✗ |
| FR–PORT | 7.4 km | ✗ | SF10 | ✗ | ✗ | ✗ | ✗ |
| FR–C1 | 4.0 km | ✗ | SF11 | ✗ | ✗ | ✗ | ✗ |
| FR–C5 | 4.5 km | SF12 | SF8 | ✗ | ✗ | ✗ | ✗ |

### D. Tempi di consegna end-to-end (policy custody, SF max 12, orizzonte 6 h dalla partenza; file generati a 0h30)


**ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.7 min |
| static | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| boda | favorevole | 2.0 h | 1.7 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.9 min |
| boda | tipico | 2.0 h | 2.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.2 min |
| boda | severo | 2.0 h | 2.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 1.9 min |
| naguru-relay | favorevole | — | 48 min | ✗ (2%) | ✗ (5%) | ✗ | ✗ | 100% | 11.6 min |
| naguru-relay | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.6 min |
| naguru-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| relay-boda | favorevole | 2.0 h | 48 min | ✗ (38%) | ✗ (2%) | ✗ | ✗ | 100% | 12.7 min |
| relay-boda | tipico | 2.0 h | 1.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.6 min |
| relay-boda | severo | 2.0 h | 2.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.2 min |
| box-ground | favorevole | — | 49 min | ✗ (2%) | ✗ (5%) | ✗ | ✗ | 100% | 11.6 min |
| box-ground | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| box-ground | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| relay-blackout | favorevole | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 4% | 2.1 min |
| relay-blackout | tipico | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.5 min |
| relay-blackout | severo | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.2 min |

**ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 7.7 min |
| static | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| boda | favorevole | 1.7 h | 1.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 9.3 min |
| boda | tipico | 2.0 h | 2.5 h | ✗ | ✗ | ✗ | ✗ | 0% | 5.3 min |
| boda | severo | 2.0 h | 2.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.6 min |
| naguru-relay | favorevole | 40 s | 20 s | 55 min | 1.4 h | ✗ (7%) | ✗ | 100% | 72.0 min |
| naguru-relay | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.0 min |
| naguru-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| relay-boda | favorevole | 40 s | 20 s | 55 min | 1.6 h | 2.6 h | 2.7 h | 100% | 69.3 min |
| relay-boda | tipico | 2.0 h | 1.5 h | ✗ | ✗ | ✗ | ✗ | 0% | 8.4 min |
| relay-boda | severo | 2.0 h | 2.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 3.4 min |
| box-ground | favorevole | 1.0 min | 20 s | 55 min | 1.4 h | ✗ (7%) | ✗ | 100% | 72.1 min |
| box-ground | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| box-ground | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| relay-blackout | favorevole | 20 s | — | ✗ | ✗ | ✗ | ✗ | 4% | 0.3 min |
| relay-blackout | tipico | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 0% | 2.3 min |
| relay-blackout | severo | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.3 min |

**DTN — il relay trattiene la copia fino alla consegna · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 4.3 min |
| static | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| boda | favorevole | 2.0 h | 1.7 h | 2.6 h | ✗ (2%) | 2.6 h | 2.6 h | 0% | 6.3 min |
| boda | tipico | 2.0 h | 2.6 h | 2.6 h | ✗ (2%) | 2.6 h | ✗ (7%) | 0% | 3.3 min |
| boda | severo | 2.0 h | 2.6 h | ✗ (27%) | ✗ | ✗ | ✗ | 0% | 5.8 min |
| naguru-relay | favorevole | — | 48 min | ✗ (2%) | ✗ (5%) | ✗ | ✗ | 100% | 11.6 min |
| naguru-relay | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.9 min |
| naguru-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| relay-boda | favorevole | 2.0 h | 48 min | 2.6 h | ✗ (4%) | 2.6 h | 2.6 h | 100% | 11.3 min |
| relay-boda | tipico | 2.0 h | 1.8 h | 2.6 h | ✗ (5%) | 2.6 h | ✗ (7%) | 0% | 8.2 min |
| relay-boda | severo | 2.0 h | 2.6 h | ✗ (27%) | ✗ | ✗ | ✗ | 0% | 6.0 min |
| box-ground | favorevole | — | 49 min | ✗ (2%) | ✗ (5%) | ✗ | ✗ | 100% | 11.6 min |
| box-ground | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| box-ground | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| relay-blackout | favorevole | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 4% | 2.1 min |
| relay-blackout | tipico | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.5 min |
| relay-blackout | severo | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.2 min |

**DTN — il relay trattiene la copia fino alla consegna · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 31.7 min |
| static | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| boda | favorevole | 1.7 h | 1.6 h | 2.4 h | ✗ (14%) | 2.6 h | 2.6 h | 0% | 55.0 min |
| boda | tipico | 2.0 h | 2.5 h | 2.6 h | ✗ (63%) | 2.6 h | ✗ (8%) | 0% | 25.2 min |
| boda | severo | 2.0 h | 2.6 h | 3.2 h | ✗ (6%) | ✗ (6%) | ✗ | 0% | 39.2 min |
| naguru-relay | favorevole | 40 s | 20 s | 55 min | 1.4 h | ✗ (7%) | ✗ | 100% | 72.0 min |
| naguru-relay | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.0 min |
| naguru-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| relay-boda | favorevole | 40 s | 20 s | 55 min | 1.6 h | 2.6 h | 2.7 h | 100% | 69.3 min |
| relay-boda | tipico | 2.0 h | 1.5 h | 1.9 h | 57 min | 2.6 h | ✗ (8%) | 0% | 42.2 min |
| relay-boda | severo | 2.0 h | 2.6 h | 3.3 h | ✗ (6%) | ✗ (6%) | ✗ | 0% | 42.8 min |
| box-ground | favorevole | 1.0 min | 20 s | 55 min | 1.4 h | ✗ (7%) | ✗ | 100% | 72.1 min |
| box-ground | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| box-ground | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| relay-blackout | favorevole | 20 s | — | ✗ | ✗ | ✗ | ✗ | 4% | 0.3 min |
| relay-blackout | tipico | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 0% | 2.3 min |
| relay-blackout | severo | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.3 min |

### E. Stessa simulazione con instradamento a costo "airtime" invece che a numero di salti (coda relay ARALD attuale)


**Metrica airtime · ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.7 min |
| static | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| boda | favorevole | 2.0 h | 1.7 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.9 min |
| boda | tipico | 2.0 h | 2.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.2 min |
| boda | severo | 2.0 h | 2.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 1.9 min |
| naguru-relay | favorevole | — | 48 min | ✗ (2%) | ✗ (5%) | ✗ | ✗ | 100% | 11.6 min |
| naguru-relay | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.6 min |
| naguru-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| relay-boda | favorevole | 2.0 h | 48 min | ✗ (2%) | ✗ (5%) | ✗ | ✗ | 100% | 12.5 min |
| relay-boda | tipico | 2.0 h | 1.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.6 min |
| relay-boda | severo | 2.0 h | 2.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.2 min |
| box-ground | favorevole | — | 49 min | ✗ (2%) | ✗ (5%) | ✗ | ✗ | 100% | 11.6 min |
| box-ground | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| box-ground | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| relay-blackout | favorevole | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 4% | 2.1 min |
| relay-blackout | tipico | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.5 min |
| relay-blackout | severo | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.2 min |

**Metrica airtime · ARALD attuale — coda relay: SOS senza scadenza / resto 5 min · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1→PORT | F1→BOX | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 7.7 min |
| static | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| static | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| boda | favorevole | 1.7 h | 1.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 9.3 min |
| boda | tipico | 2.0 h | 2.5 h | ✗ | ✗ | ✗ | ✗ | 0% | 5.3 min |
| boda | severo | 2.0 h | 2.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 2.6 min |
| naguru-relay | favorevole | 40 s | 20 s | 55 min | 1.4 h | ✗ (7%) | ✗ | 100% | 72.0 min |
| naguru-relay | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 3.0 min |
| naguru-relay | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| relay-boda | favorevole | 40 s | 20 s | 55 min | 1.4 h | ✗ (7%) | ✗ | 100% | 72.0 min |
| relay-boda | tipico | 2.0 h | 1.5 h | ✗ | ✗ | ✗ | ✗ | 0% | 8.4 min |
| relay-boda | severo | 2.0 h | 2.6 h | ✗ | ✗ | ✗ | ✗ | 0% | 3.4 min |
| box-ground | favorevole | 1.0 min | 20 s | 55 min | 1.4 h | ✗ (7%) | ✗ | 100% | 72.1 min |
| box-ground | tipico | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| box-ground | severo | — | — | ✗ | ✗ | ✗ | ✗ | 0% | 0.0 min |
| relay-blackout | favorevole | 20 s | — | ✗ | ✗ | ✗ | ✗ | 4% | 0.3 min |
| relay-blackout | tipico | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 0% | 2.3 min |
| relay-blackout | severo | 2.0 h | — | ✗ | ✗ | ✗ | ✗ | 0% | 1.3 min |

Legenda D/E: F1 = SOS + coordinate (1 KB) (C5→PORT e BOX); F5 = GPS + audio 10 s (150 KB) (S5→BOX); F2 = Articolo Wiki (200 KB → ~70 KB compresso) (BOX→S5); F4 = Rapporto 5 pag. + 3 JPEG (5 MB) (S5→BOX); F3 = 8 JPEG (12 MB) (S5→BOX). "✗ (x%)" = non consegnato entro l'orizzonte, x% arrivato; "—" = destinazione non raggiunta. "C5→BOX connesso" = frazione del tempo con un percorso simultaneo (connettività istantanea): una consegna avvenuta con questo valore < 100% è passata (anche) per contatti opportunistici. "Airtime LoRa" = tempo di trasmissione LoRa consumato da tutti i file, tutte le copie. Varianti: static = motocicli fermi, nessun relay: il Box sul tetto, il resto a terra; boda = il corriere C4 in boda-boda: centro → Bweyogerere → Kawempe → Kololo (data mule nel traffico); naguru-relay = ARALD Fixed Relay su un traliccio di 25 m a Naguru, corriere fermo; relay-boda = Fixed Relay a Naguru e corriere in servizio; box-ground = come 'naguru-relay', ma il Box è a terra (1,5 m) invece che sul tetto; relay-blackout = come 'relay-boda', ma il Box resta senza corrente a 0h15 (blackout, nessun UPS).

### F. Pannello connessioni a t = 0h30 (variante `naguru-relay`, ambiente tipico) — formato del futuro tool


**Profilo radio g1 14 dBm ERP/1%**

| Connessione | Tecnologia | Distanza | Velocità stimata | Sostenuta | Qualità | Linea di vista |
|---|---|---:|---:|---:|---|:---:|
| C1 → S1 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C2 → S2 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C3 → S3 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C4 → S4 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C5 → S5 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C1 → C4 | LoRa (SF7) | 40 m | 3.2 kbps | 32 bps | Discreta (0.39) | sì |
| BOX → FR | LoRa (SF10) | 2.3 km | 549 bps | 5 bps | Debole (0.27) | sì |

**Profilo radio g3 27 dBm ERP/10%**

| Connessione | Tecnologia | Distanza | Velocità stimata | Sostenuta | Qualità | Linea di vista |
|---|---|---:|---:|---:|---|:---:|
| C1 → S1 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C2 → S2 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C3 → S3 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C4 → S4 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| C5 → S5 | BLE (2M PHY) | 4 m | 1.0 Mbps | 1.0 Mbps | Ottima (0.77) | sì |
| BOX → FR | LoRa (SF7) | 2.3 km | 3.2 kbps | 317 bps | Discreta (0.39) | sì |
| C1 → C4 | LoRa (SF7) | 40 m | 3.2 kbps | 317 bps | Discreta (0.39) | sì |

### G. Alone di copertura LoRa del Box (ricevitore di riferimento: Card), ambiente tipico, celle da 250 m

Legenda: `#` terra coperta, `.` terra non coperta, `B` posizione del Box.


**g1 14 dBm ERP/1%** — celle coperte: 33 su 2214

```text
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
..................###.................................
.................######...............................
...................#####..............................
...................##B##..............................
...................######.............................
.....................####.............................
......................###.............................
......................#...............................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
```

**g3 27 dBm ERP/10%** — celle coperte: 134 su 2214

```text
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
................###...................................
...............####...................................
..............######..................................
..............######..................................
.............########.................................
.............##########...............................
.............##########...............................
............##..#########.............................
............#...#####B###.............................
.................#########............................
.................###########..........................
..................############........................
...................###########........................
......................#######.........................
......................######..........................
.....................######...........................
.....................####.............................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
......................................................
```

### H. I tre livelli dell'alone del Box, uno per tecnologia (celle da 40 m, ±1 km, ambiente tipico, g1 14 dBm ERP/1%)

Ogni livello è calcolato separatamente verso il proprio ricevitore di riferimento (Wi-Fi e BLE → smartphone, LoRa → Card). `#` = coperto, `.` = non coperto, `B` = Box. Con celle da 40 m, una copertura di poche celle attorno al Box indica una portata di qualche decina di metri o meno: la risoluzione non permette di dire di più. La forma dell'alone che segue il territorio si vede su LoRa, sezione G.

```text
Wi-Fi                                                 BLE                                                   LoRa
...................................................   ...................................................   ...................................................
...................................................   ...................................................   ...................................................
...................................................   ...................................................   ...................................................
...................................................   ...................................................   ...................................................
...................................................   ...................................................   ...##..............................................
...................................................   ...................................................   ..#####............................................
...................................................   ...................................................   ..#######..........................................
...................................................   ...................................................   .############......................................
...................................................   ...................................................   ##################.................................
...................................................   ...................................................   ######################.............................
...................................................   ...................................................   #########################..........................
...................................................   ...................................................   ############################.......................
...................................................   ...................................................   ##############################.....................
...................................................   ...................................................   ###############################....................
...................................................   ...................................................   ################################...................
...................................................   ...................................................   ##################################.................
...................................................   ...................................................   ###################################................
...................................................   ...................................................   ###################################................
...................................................   ...................................................   ####################################...............
...................................................   ...................................................   #####################################..............
...................................................   ...................................................   ..####################################.............
...................................................   ...................................................   .....#################################.............
...................................................   ...................................................   .......################################............
...................................................   ...................................................   ........###############################............
........................BB.........................   ........................BB.........................   ........################BB#############............
........................BB.........................   ........................BB.........................   ........################BB##############...........
...................................................   ...................................................   ........################################...........
...................................................   ...................................................   ........################################...........
...................................................   ...................................................   ........#################################..........
...................................................   ...................................................   ........#################################..........
...................................................   ...................................................   .........################################..........
...................................................   ...................................................   .........################################..........
...................................................   ...................................................   .........#################################.........
...................................................   ...................................................   ..........################################.........
...................................................   ...................................................   ...........###############################.........
...................................................   ...................................................   ...........###############################.........
...................................................   ...................................................   ............##############################.........
...................................................   ...................................................   .............##############################........
...................................................   ...................................................   ..............#############################........
...................................................   ...................................................   ................###########################........
...................................................   ...................................................   .................##########################........
...................................................   ...................................................   ....................########################.......
...................................................   ...................................................   .........................###################.......
...................................................   ...................................................   .........................###################.......
...................................................   ...................................................   .........................####################......
...................................................   ...................................................   ..........................##################.......
...................................................   ...................................................   ..........................#################........
...................................................   ...................................................   ..........................###################......
...................................................   ...................................................   ..........................#################........
...................................................   ...................................................   ..........................################.........
```
- Wi-Fi: 4 celle coperte su 2550 (6400 m²)
- BLE: 4 celle coperte su 2550 (6400 m²)
- LoRa: 1216 celle coperte su 2550 (1945600 m²)

## 16. Scenario 5 — cosa dice il modello

1. **In città la portata LoRa è breve e dipende dall'altezza.**
   - In condizioni tipiche nessun collegamento diretto tra dispositivi a terra, a 2-3 km o più, chiude: né Card–Card né Box–Card, in entrambe le sotto-bande.
   - Il Box sul tetto (12 m) vede il relay su traliccio (25 m) a 2,3 km (SF10 all'1%, SF7 al 10%) ma nessuna Card.
   - L'alone LoRa del Box è un'area irregolare modellata da colline e clutter, non un cerchio (sezione G).
2. **La posizione del Box vale più della potenza.** Sul tetto copre 8,4 km² (al 10%, tipico), a terra 2,0 km²: un fattore 4. In condizioni favorevoli 114 contro 29,5 km². All'1% il rapporto è simile: 2,1 contro 0,6 km² in tipico (3,4 volte). Il clutter dominante è quello attorno all'antenna: un Box a terra lo paga per intero, uno sul tetto ne vede solo la frazione residua.
3. **Senza corriere la rete è inutilizzabile in condizioni tipiche.** Anche con il relay, l'SOS da Bweyogerere non arriva né alla clinica né alla sede: il relay a 25 m copre bene il Box (2,3 km) ma non la periferia a 4,5 km né Kawempe a 7,4 km. Solo in condizioni favorevoli e con le regole al 10% l'SOS arriva alla sede in 20 s.
4. **Il boda è il ponte e funziona nonostante il traffico.** Con la coda attuale l'SOS arriva alla clinica in 2,0 h e alla sede in 2,5-2,6 h (tipico). Con il relay la sede lo riceve in 1,5 h (tipico, al 10%) o 1,6 h (all'1%): il boda entra in copertura del traliccio poco prima di Naguru, nel ritorno da Bweyogerere.
5. **Il relay tiene in vita le copie del corriere.** In condizioni favorevoli e al 10%, con la coda attuale (5 minuti per i dati non urgenti) rapporto e foto (F4/F3) arrivano alla sede in 2,6-2,7 h *con* il relay e non arrivano affatto senza. In quelle condizioni il traliccio raggiunge anche Bweyogerere (4,5 km, SF8): nessun dispositivo risulta mai isolato, e la scadenza dei 5 minuti parte solo quando un relay non ha più alcun percorso. Un relay fisso non allarga solo la copertura, estende la durata utile del ruolo di corriere. Anche in questa variante, nelle condizioni tipiche e severe, foto e rapporto si perdono con la coda attuale.
6. **Il Box è un punto singolo di guasto.** Con il blackout a 0h15 l'SOS raggiunge ancora la clinica (il Portable a batteria), mai la sede, e ogni file destinato al Box è perso. Argomenti concreti per l'UPS (`docs/power-management.md`) e per una seconda destinazione per i contenuti, in linea con la funzione Failure Simulation del tool. In questo scenario il blackout non toglie il Portable: avere due infrastrutture in zone distinte con alimentazioni distinte è ciò che salva l'SOS.
7. **BLE e Wi-Fi sono locali ovunque.** Telefono e propria Card: BLE 2M PHY a 1,0 Mbps. Il Box sul tetto raggiunge un telefono in strada fino a 35 m in condizioni tipiche (80 m favorevoli, 15 m severe), con Wi-Fi e BLE alla stessa portata: il clutter attorno al telefono domina. Il Box non è un access point per un quartiere. (La mappa della sezione H, a celle da 40 m, ne mostra solo il centro: la portata è stata misurata lungo un raggio, non letta dalla griglia.)
8. **Un'osservazione per il tool: la condizione "tipico" non può essere globale.** La stessa configurazione salvata, valutata con la tabella ambientale generica (esponente 2,2), mostra 14 link LoRa fino a 7,4 km (SF7, SF9 e SF11). Con la tabella urbana calibrata ne resta uno solo, Box–relay a 2,3 km, oltre ai due BLE telefono–Card. Ogni dataset di territorio porta con sé la propria tabella (`Terrain.propagation`, usata da `assessNetwork()` senza che il chiamante debba ricordarsene: questo punto è stato corretto dopo la revisione, che aveva trovato la tabella come parametro separato e dimenticabile). L'alternativa, ricavare l'esponente dall'uso del suolo lungo il percorso, è un lavoro futuro.

## 17. Il modello visto dal tool (risposta ai 10 punti del §12 di `docs/network-design-tool.md`)

Stato al termine dello Scenario 5. Va aggiornato a ogni estensione del motore.

1. **Parametri del modello**
   - *Per tipo di dispositivo*: `KIND_DEFAULTS` in `model.ts` (tecnologie, potenza LoRa, guadagno d'antenna, perdita da corpo, potenza BLE, EIRP Wi-Fi, altezza tipica dal suolo).
   - *Radio LoRa*: sensibilità SX1262 per SF (`SX1262_SENSITIVITY_125K`), parametri PHY (`DEFAULT_PHY`: 125 kHz, CR 4/5, preambolo 8), frame 222 B con 22 B di framing, overhead applicativo ×1,45, SF massimo.
   - *Profili regolatori*: `EU868_G1` (14 dBm ERP, 1%), `EU868_G3` (27 dBm ERP, 10%), `AU915` (30 dBm EIRP, nessun duty-cycle, dwell 400 ms, 920 MHz). Un profilo ha ERP massimo, duty-cycle, frequenza centrale e dwell time opzionale.
   - *2,4 GHz*: `BLE_RATE_STEPS`, `WIFI_RATE_STEPS`, modello `fixed`/`budget`.
   - *Ambiente*: esponente di path loss, margine di fading, interferenza. Una tabella (favorevole/tipico/severo) **per dataset di territorio**: `TERRAIN_ENVIRONMENTS` per terreni aperti (2,0/2,2/2,5), `Terrain.propagation` per un territorio che ne porta una propria, come Kampala (2,6/3,0/3,4, calibrati su Okumura-Hata per l'abitato; `EnvironmentTable` per forzarne una diversa).
   - *Territorio*: `Terrain` (quota e uso del suolo), `CLUTTER_LOSS_DB` per classe e banda, `CLUTTER_DEPTH_M`, fattore k = 4/3 della curvatura terrestre; opzionalmente `clutterHeightRelief` con `CLUTTER_HEIGHT_M` e `CLUTTER_RESIDUAL` (clutter ridotto per antenne in alto).
   - *Installazione del dispositivo*: altezza dal suolo (tipica per tipo, sovrascrivibile: tetto, palo, terra).
   - *Solo simulazione temporale, non necessari al primo tool*: passo, coda dei relay, metrica di instradamento, priorità, canale condiviso.
2. **Input**: una `NetworkConfig` (`network-config.ts`: dispositivi con tipo, latitudine, longitudine, altezza opzionale; ambiente; profilo regolatorio della regione — `g1`, `g3`, `au915`; riferimento al territorio) più un `Terrain` (che porta le proprie condizioni di propagazione).
3. **Output**: per ogni coppia una `LinkAssessment` (`assess.ts`): distanza, linea di vista e diffrazione, valutazione di Wi-Fi, BLE e LoRa (applicabile, possibile, RSSI, margine, modo radio, velocità istantanea e sostenibile, qualità) e la migliore. Per ogni dispositivo e tecnologia una `CoverageGrid` (celle con possibile/velocità/qualità). La simulazione temporale aggiunge i tempi di consegna, oltre il primo tool.
4. **Formule e regole**:
   - link budget \(RSSI = EIRP_{tx} + G_{rx} - L_{corpo} - L_{path}(d,n,f) - L_{diffrazione} - L_{clutter} - L_{interferenza}\), direzione più debole;
   - \(L_{path}\) log-distance alla frequenza LoRa della regione (868 MHz in EU868, 920 MHz in AU915) e a 2,44 GHz per BLE/Wi-Fi; la stessa frequenza LoRa è usata per la diffrazione;
   - diffrazione knife-edge sull'ostacolo dominante del profilo, ITU-R P.526 con curvatura terrestre a k = 4/3;
   - clutter per classe di suolo, scalato con la distanza fino a 200 m e, dove il terreno lo prevede, con l'altezza dell'antenna sul clutter (un'antenna sul tetto vede ~20% del clutter di una a terra);
   - time-on-air LoRa dalla formula Semtech, SF in logica ADR tra quelli ammessi dalla regione (con dwell time il frame si accorcia; uno SF in cui non sta nemmeno un byte utile è escluso);
   - gradini BLE/Wi-Fi per RSSI;
   - qualità su scala logaritmica 10 bit/s → 30 Mbit/s.
5. **Parametri specifici dei dispositivi**: quelli di `KIND_DEFAULTS` (punto 1), mai inseriti dall'utente nella prima versione.
6. **Parametri che dipendono dal territorio**: quota (→ diffrazione e altezza effettiva delle antenne), uso del suolo (→ clutter), l'altezza dell'antenna sul suolo, la condizione ambientale scelta (esponente, margine, interferenza: la tabella dipende dal territorio) e la **regione** (→ profilo regolatorio: potenza, duty-cycle, frequenza, dwell time).
7. **Possibilità di connessione**: per ogni tecnologia, i due dispositivi devono averla (il Wi-Fi richiede un Box o Portable come access point). Inoltre l'RSSI meno il margine di fading deve superare la soglia: la sensibilità dello SF più lento ammesso per LoRa, il gradino più basso per BLE/Wi-Fi.
8. **Tecnologia usata**: tra quelle possibili, quella con la velocità istantanea più alta (in pratica Wi-Fi > BLE > LoRa).
9. **Velocità**:
   - LoRa: byte utili per frame (ridotti dal dwell time dove c'è) diviso time-on-air allo SF scelto (istantanea), moltiplicato per il duty-cycle (sostenibile; uguale all'istantanea senza duty-cycle);
   - BLE/Wi-Fi: il gradino corrispondente all'RSSI.
10. **Dal risultato alla mappa**:
    - le coordinate geografiche diventano locali con `toLocal()` (equirettangolare attorno all'origine `frame`, precisa entro ~100 km) e tornano geografiche con `toGeo()`;
    - una linea tra due dispositivi ha il colore di `quality` (0 rosso → 0,5 giallo → 1 verde) e l'etichetta della velocità;
    - l'alone di una tecnologia sono le celle `possible` di `coverageGrid()` verso un ricevitore di riferimento (LoRa → Card, BLE/Wi-Fi → smartphone), da disegnare come area o contorno.

**Cosa manca ancora per il tool**:
- un caricatore di DEM e di uso del suolo reali che implementi `Terrain`;
- un modo di ricavare l'esponente di path loss dall'uso del suolo lungo il percorso, invece di una tabella per territorio, e la calibrazione su misure reali (oggi Okumura-Hata come unico riferimento);
- profili regolatori verificati per le regioni di interesse (oggi EU868 g1/g3 e AU915, quest'ultimo non verificato sulla normativa cilena) e altri piani (US915, AS923, IN865, …);
- la diffrazione su più ostacoli in serie (oggi si considera solo il dominante);
- un calcolo dell'alone abbastanza veloce per l'interazione: oggi ~0,1 s per mille celle su scala d'arcipelago. Una mappa fine (es. celle da 30 m su 40 × 40 km, ~1,8 milioni di celle) richiederebbe minuti: servirà una griglia adattiva o un calcolo per raggi;
- l'interfaccia stessa.

## 18. Implicazioni proposte (non implementate — da valutare con l'utente)

- **TTL di custodia per il ruolo "courier"**: per l'SOS è **fatto** (`docs/security.md` voce #120: `Priority.EMERGENCY` non scade più in `PendingDeliveryQueue`). Resta aperto per gli altri contenuti. Report, foto e audio scadono dopo 5 minuti di isolamento, e in ogni scenario sono arrivati via mulo solo con una coda DTN. Serve un vero bundle-store DTN per i nodi mobili, separato dalla coda di retry e con limiti propri di memoria.

- **Policy di trasporto per dimensione**: impedire che contenuti oltre una soglia (es. 50-100 KB) usino LoRa e instradarli solo su Wi-Fi/BLE/contatto fisico, per non sprecare il budget di duty-cycle che serve agli SOS e ai messaggi.
- **Sotto-banda g3 (869,4-869,65 MHz, 27 dBm ERP/10%)** come candidata principale per i link infrastrutturali (Box/Portable/Fixed Relay), da decidere nella specifica radio (`docs/compliance.md`).
- **Ridondanza della catena** (Scenario 1): in un rifugio, un Fixed Relay in quota (o il Portable posizionato al rifugio) elimina il punto singolo di guasto C4.
- **Costo di instradamento consapevole dell'airtime** (entrambi gli scenari): `routing-table.ts` usa oggi il numero di salti, che preferisce link diretti lenti a percorsi multi-hop veloci. Un costo basato sullo SF/airtime del link (e idealmente sul budget di duty-cycle residuo del next hop, per non saturare un solo relay) riduce i tempi dei dati medi anche di un ordine di grandezza. La specifica prevede già un costo composito (`Cost = α·hops + β·latency + γ·loss + δ·energy + ε·congestion`), finora implementato solo nel termine `hops`.
- **Fixed Relay sui colli** come elemento di progetto per i rifugi in valli adiacenti: ricuce la rete per l'SOS in decine di secondi in condizioni tipiche; per i dati medi conviene g3, perché il relay del colle porta il traffico di entrambe le valli.
- **Seconda destinazione / failover**: un SOS indirizzato a più infrastrutture sopravvive al guasto del Box; per contenuti e report servirebbe un mirror (es. il Portable che replica le parti essenziali della Wiki e accetta i report quando il Box è irraggiungibile).
- **Framing LoRa più compatto per le regioni con dwell time** (Scenario 4): con un dwell di 400 ms i 22 byte di intestazione ARALD per frame e il base64 nel JSON dei chunk lasciano pochi byte utili agli SF lenti (~1-2 byte a SF10). Un header binario compatto e il payload binario sul canale LoRa aumenterebbero direttamente portata utile e velocità.
- **Fixed Relay e corriere insieme** (Scenario 5): un relay su traliccio non serve solo a coprire, tiene in copertura il corriere e quindi in vita le sue copie con la coda attuale. In progetto, il Fixed Relay si colloca lungo la rotta del corriere più che al centro dell'area.
- **Alimentazione e ridondanza del Box** (Scenario 5): in contesti con blackout un Box senza UPS è un punto singolo di guasto per ogni contenuto a lui destinato. Serve una seconda destinazione con alimentazione indipendente (il Portable a batteria, che ha salvato l'SOS) e, per i contenuti, un mirror.


## 19. Limiti noti del modello

- Nessun modello del terreno (DEM): le creste sono perdite fisse per coppia di nodi (Scenario 1) o per zona (Scenario 2); il passo successivo naturale è un profilo terrain-aware (Longley-Rice/ITM o diffrazione knife-edge su DEM).
- Lo Scenario 2 è una geometria sintetica, non un luogo reale.
- Nessun failover di destinazione per i contenuti (variante `box-failure`): i file indirizzati al Box restano fermi per costruzione.
- Scenario 5: terreno sintetico, coordinate e profilo EU868 per l'Uganda non verificati; calibrazione su Okumura-Hata solo per la classe "abitato", non per l'"abitato denso" (8-12 dB più pessimista di Hata); l'antenna del Box a 12 m è fuori dalla validità di Hata (30-200 m); il lago non è una classe di suolo; solo cinque telefoni, mentre in una città densa i telefoni sono migliaia e potrebbero formare essi stessi una mesh BLE (relay Bluetooth dello smartphone): qui non modellato; il clutter a 868 MHz è una tabella per classe di suolo, non misure in strada; nessuna variazione nel tempo del traffico (solo velocità media del boda).
- Scenario 4: terreno sintetico, coordinate e profilo AU915 per il Cile non verificati; nessun modello del salto di frequenza (hopping) né dell'occupazione dei canali nella banda 915-928 MHz, solo il vincolo di dwell time e l'efficienza del canale condiviso.
- Scenario 3: terreno sintetico (isole a cono) e coordinate non verificate. La diffrazione considera un solo ostacolo dominante, quindi più creste in serie sono sottostimate. Con antenne molto basse la perdita del suolo può essere in parte contata due volte, nell'esponente di path loss e nella diffrazione sulla curvatura. Il clutter è una tabella per classe, non un modello di edifici. Gradini e velocità BLE/Wi-Fi sono valori tipici, non misurati su dispositivi ARALD.
- Canale LoRa come unico dominio di collisione con efficienza fissa; nessuna collisione/hidden-terminal esplicita, nessun retry/ACK a livello di frame (implicito nell'efficienza 50%).
- Fading statico (margine fisso), nessuna variabilità temporale del link oltre alla mobilità.
- Trasferimento di contenuti modellato come "push" verso la destinazione; in ARALD è "pull" (`CONTENT_QUERY` → chunk), con overhead di richiesta non incluso.
- Il modello "DTN" non ha limite di memoria nei relay; quello "ARALD attuale" approssima la combinazione `floodExcept()` + `PendingDeliveryQueue` + `SeenCache` (in particolare: un relay connesso inoltra senza scadenza tramite le code del transport).
- Throughput BLE/Wi-Fi sono valori nominali prudenziali, non misurati.

## 20. Come estendere

Un nuovo scenario è un file accanto a `tools/scenario-model/valle-maira.ts` che esporta un oggetto `Scenario` (`tools/scenario-model/scenario.ts`: nodi con traiettorie, ambienti, messaggi, varianti, eventuale perdita dipendente dal tempo) e si registra in `cli.ts`; `model.ts` resta invariato. Parametri da riga di comando: `--scenario valle-maira|alpino-frammentato|eolie|atacama|kampala`, `--max-sf`, `--horizon-h`, `--policy custody|epidemic`. Uno scenario su territorio reale fornisce un `Terrain` negli ambienti e `shortRangeModel: "budget"`. Una configurazione salvata nel formato del tool si valuta con `--config <file.json>` (aggiungi `--json` per l'output strutturato); esempi in `tools/scenario-model/examples/` (Eolie, Atacama con `"regulatory": "au915"`, Kampala con l'altezza di installazione dei dispositivi). Uno scenario fuori dall'Europa indica i propri profili con `regulatoryProfiles`; il terreno sintetico generico (altopiano, coni, creste) si costruisce con `syntheticLandscape`.
