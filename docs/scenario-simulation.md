# Simulazione teorica di efficienza della rete ARALD — modello parametrico

**Stato**: Scenario 1 (alta Valle Maira) e Scenario 2 (alpino frammentato, due valli separate da una cresta) completati. Scenari successivi (Eolie, Atacama, Kampala, …) da aggiungere come nuovi file di scenario sullo stesso motore.

**Obiettivo finale**: questo modello è il motore di un futuro tool interattivo di progettazione di reti ARALD su mappa reale — vedi [`docs/network-design-tool.md`](network-design-tool.md), da rispettare come vincolo di progetto.

**Cosa è e cosa non è.** È un modello **teorico e parametrico** (`tools/scenario-model/`, `npm run scenario-model`) per confrontare scenari e ordini di grandezza. **Non** è una misura: nessun parametro radio di questo documento è stato verificato su hardware o sul terreno (nessun accesso a hardware né a internet reale in questo ambiente). Coordinate, quote, ostruzioni e sensibilità sono ipotesi dichiarate qui sotto, da sostituire con misure (Fase 2 di `docs/test-protocol.md`) quando disponibili. È separato da `tools/simulator/`, che invece esegue istanze reali di `NomadNode` su TCP locale senza alcuna fisica radio.

## 1. Modello

Rete dinamica \(G(t) = (V, E(t))\), simulata a passo discreto (10 s).

- **Nodi** \(v_i = (p_i(t), T_i, P_i, A_i)\): posizione da traiettoria a waypoint (interpolazione lineare), tecnologie (LoRa/BLE/Wi-Fi per tipo), potenza, guadagno d'antenna e perdita da corpo. Un nodo può spegnersi a un istante dato (robustezza).
- **Link LoRa** — link budget:
  \(RSSI_{ij} = EIRP + G_r - L_{corpo} - L_{path}(d, n) - L_{ostruzione,ij} - L_{interferenza}\), con \(EIRP = \min(P_{tx}^{hw} + G_t,\ ERP_{max}^{reg} + 2{,}15)\) (limite sia hardware sia normativo). Il link utile è bidirezionale: si calcolano entrambe le direzioni (EIRP del trasmettitore + guadagno d'antenna del ricevitore) e vale la più debole. \(L_{ostruzione}\) è una perdita fissa per coppia di nodi (Scenario 1) oppure una funzione delle posizioni per zone di terreno (Scenario 2, chi valica una cresta cambia zona); una perdita aggiuntiva dipendente dal tempo modella eventi meteo,
  con \(L_{path} = FSPL(1\,m) + 10\,n \log_{10} d\) a 868 MHz. Il link esiste se \(RSSI - M_{fading} \ge S(SF)\) per qualche SF; si sceglie **lo SF più veloce che chiude il link** (logica ADR).
- **Link corti**: Wi-Fi solo verso Box/Portable (access point) entro 80 m, 8 Mbps applicativi; BLE entro 30 m, 200 kbps applicativi. Mezzo preferito: Wi-Fi > BLE > LoRa.
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


**ARALD attuale — coda relay 30 min SOS / 5 min resto · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1 | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | ✗ (71%) | 4.0 h | ✗ | ✗ | 100% | 7.7 min |
| static | tipico | 30 s | ✗ (40%) | ✗ | ✗ | ✗ | 100% | 21.1 min |
| static | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 13% | 1.6 min |
| ferry | favorevole | 10 s | 3.7 h | 4.2 h | ✗ (20%) | ✗ | 100% | 11.4 min |
| ferry | tipico | 30 s | 3.7 h | ✗ (22%) | ✗ (16%) | ✗ | 100% | 22.0 min |
| ferry | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 13% | 2.3 min |
| return | favorevole | 10 s | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 100% | 7.7 min |
| return | tipico | 30 s | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 100% | 10.1 min |
| return | severo | 1.7 h | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 62% | 5.4 min |
| card-failure | favorevole | 10 s | ✗ (71%) | 4.0 h | ✗ | ✗ | 100% | 7.7 min |
| card-failure | tipico | ✗ | ✗ | ✗ | ✗ | ✗ | 30% | 2.6 min |
| card-failure | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 13% | 1.6 min |

**ARALD attuale — coda relay 30 min SOS / 5 min resto · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1 | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | 13 min | 19 min | ✗ (18%) | ✗ | 100% | 49.5 min |
| static | tipico | 1.5 min | ✗ (52%) | 5.9 h | ✗ | ✗ | 100% | 130.6 min |
| static | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 7.6 min |
| ferry | favorevole | 10 s | 13 min | 19 min | ✗ (54%) | ✗ | 100% | 85.6 min |
| ferry | tipico | 1.5 min | 2.4 h | 1.6 h | ✗ (31%) | ✗ | 100% | 119.4 min |
| ferry | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 8.7 min |
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


**Metrica airtime · ARALD attuale — coda relay 30 min SOS / 5 min resto · profilo radio g1 14 dBm ERP/1%**

| Variante | Ambiente | F1 | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | ✗ (71%) | 4.0 h | ✗ | ✗ | 100% | 7.7 min |
| static | tipico | 30 s | ✗ (40%) | ✗ | ✗ | ✗ | 100% | 16.9 min |
| static | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 13% | 1.6 min |
| ferry | favorevole | 10 s | 3.7 h | 4.2 h | 3.8 h | 4.0 h | 100% | 7.9 min |
| ferry | tipico | 30 s | 3.7 h | ✗ (46%) | 3.8 h | 4.0 h | 100% | 16.3 min |
| ferry | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 13% | 2.3 min |
| return | favorevole | 10 s | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 100% | 7.7 min |
| return | tipico | 30 s | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 100% | 9.3 min |
| return | severo | 1.7 h | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 62% | 5.6 min |
| card-failure | favorevole | 10 s | ✗ (71%) | 4.0 h | ✗ | ✗ | 100% | 7.7 min |
| card-failure | tipico | ✗ | ✗ | ✗ | ✗ | ✗ | 30% | 2.6 min |
| card-failure | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 13% | 1.6 min |

**Metrica airtime · ARALD attuale — coda relay 30 min SOS / 5 min resto · profilo radio g3 27 dBm ERP/10%**

| Variante | Ambiente | F1 | F5 | F2 | F4 | F3 | C5→BOX connesso (istantaneo) | Airtime LoRa |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| static | favorevole | 10 s | 13 min | 19 min | ✗ (18%) | ✗ | 100% | 49.5 min |
| static | tipico | 30 s | 41 min | 59 min | ✗ (16%) | ✗ | 100% | 142.5 min |
| static | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 7.6 min |
| ferry | favorevole | 10 s | 13 min | 19 min | 3.8 h | 4.0 h | 100% | 50.6 min |
| ferry | tipico | 30 s | 41 min | 59 min | 3.8 h | 4.0 h | 100% | 83.6 min |
| ferry | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 8.7 min |
| return | favorevole | 10 s | 13 min | 19 min | 2.2 h | 2.2 h | 100% | 45.3 min |
| return | tipico | 30 s | 41 min | 59 min | 2.2 h | 2.2 h | 100% | 65.3 min |
| return | severo | 1.6 h | 2.0 h | 2.2 h | 2.2 h | 2.2 h | 64% | 25.3 min |
| card-failure | favorevole | 10 s | 13 min | 19 min | ✗ (18%) | ✗ | 100% | 49.5 min |
| card-failure | tipico | ✗ | ✗ | ✗ | ✗ | ✗ | 30% | 7.6 min |
| card-failure | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 7.6 min |

Legenda D: F1 = SOS + coordinate (1 KB) (C5→BOX); F5 = GPS + audio 10 s (150 KB) (S5→BOX); F2 = Articolo Wiki (200 KB → ~70 KB compresso) (BOX→S5); F4 = Rapporto 5 pag. + 3 JPEG (5 MB) (S5→BOX); F3 = 8 JPEG (12 MB) (S5→BOX). "✗ (x%)" = non consegnato entro l'orizzonte, x% arrivato; "—" = destinazione non raggiunta. "C5→BOX connesso" = frazione del tempo con un percorso simultaneo (connettività istantanea): una consegna avvenuta con questo valore < 100% è passata (anche) per contatti opportunistici. "Airtime LoRa" = tempo di trasmissione LoRa consumato da tutti i file, tutte le copie. Varianti: static = gruppo fermo dopo l'arrivo (C5 verso Barenghi, C4 al rifugio); ferry = C3 sale fino a C5 (data mule) e rientra al Campo Base; return = C5+S5 scendono al Campo Base (rientro del gruppo); card-failure = come 'static', ma la Card C4 (rifugio) si spegne a 3h.

Con `--horizon-h 30` (quasi 27 h dopo l'evento), nella variante `static` in condizioni tipiche: in g1 (1%) F5 arriva in 18,2 h, la Wiki al 95%, F4 allo 0,6%, F3 a 0; in g3 (10%), con l'instradamento attuale a numero di salti, F5 arriva in 13,4 h, la Wiki in 5,9 h e F4 al 3%; con la metrica `airtime` F5 arriva in 41 min, la Wiki in 59 min e F4 al 71%.

## 4. Scenario 1 — cosa dice il modello

1. **L'SOS funziona bene in ogni caso in cui esista un percorso, anche multi-hop**: 10 s - 1,5 min nella rete connessa, perfino agli SF lenti. È il caso d'uso naturale di LoRa e la valutazione dell'analisi di partenza (★★★★★) regge.
2. **I throughput "10-20 kbps" dell'analisi di partenza sono irrealistici in EU868.** Al netto dell'overhead ARALD, LoRa SF7/125 kHz rende ~3,2 kbps *a canale libero*; con il duty-cycle legale si scende a **~32 bps (1%) o ~320 bps (10%)** sostenuti per nodo. Di conseguenza 12 MB via LoRa richiedono **giorni o settimane** (3,6 giorni nel caso migliore SF7/10% su un solo hop, ~37 giorni all'1%), non 1-22 ore. Anche 70-150 KB (Wiki, audio) arrivano in minuti/decine di minuti solo in g3 (10%); in g1 (1%) richiedono ore.
3. **Per i file grandi l'unico canale che conta è fisico: la persona che porta il telefono vicino al Box.** Nella variante `return` tutti i file arrivano in ~2,2 h (= tempo di cammino + qualche secondo di Wi-Fi), in qualunque condizione radio. La rete "Wi-Fi/BLE locale + mobilità" batte LoRa di 2-3 ordini di grandezza per F3/F4. Conferma la conclusione architetturale di partenza (LoRa = controllo e piccoli dati; mobilità = estensione temporale), ma con un divario molto più netto.
4. **La scelta della sotto-banda conta molto per i dati medi, poco per l'SOS**: passare da g1 (1%) a g3 (10%) porta F5 (150 KB) da "non arriva in 6h45" a 13 min in condizioni favorevoli; in tipico a 41 min, ma solo con la metrica `airtime` (punto 8). Il guadagno viene **soprattutto dal duty-cycle**, non dalla potenza: con l'SX1262 a +22 dBm il Box guadagna ~9 dB di EIRP passando a g3, ma una Card con antenna −3 dBi solo ~3 dB, quindi i link Card–Card cambiano poco. In tipico l'unico link aggiuntivo è Box–C4, che però chiude solo a SF11 (lento: vedi punto 8).
5. **Il "data mule" oggi non funziona davvero nel codice ARALD.** Nella variante `ferry` in condizioni severe (unico caso in cui il mulo è l'unico ponte), con la coda attuale di `PendingDeliveryQueue` (30 min EMERGENCY, 5 min resto) **anche l'SOS va perso**: il mulo resta isolato ~2 h tra il contatto con C5 e il rientro, e la copia scade prima. Con una coda in stile DTN lo stesso mulo consegna l'SOS in ~3,4 h (g1) / ~2,7 h (g3) e i file grandi in ~3,7 h (via Wi-Fi al rientro). Questo è il risultato più concreto per il codice: il TTL di 30 min per gli SOS dichiarato per il "courier" è più corto di un tipico attraversamento a piedi di un gap alpino.
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


**ARALD attuale — coda relay 30 min SOS / 5 min resto · profilo radio g1 14 dBm ERP/1%**

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
| crossing | tipico | 10 s | — | ✗ | ✗ (1%) | ✗ | ✗ | 33% | 4.7 min |
| crossing | severo | 29 min | — | ✗ | ✗ | ✗ | ✗ | 10% | 1.7 min |
| storm | favorevole | 10 s | 30 s | ✗ (38%) | ✗ (62%) | ✗ | ✗ | 100% | 12.5 min |
| storm | tipico | 40 s | 3.0 h | ✗ | ✗ | ✗ | ✗ | 70% | 1.9 min |
| storm | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| box-failure | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |

**ARALD attuale — coda relay 30 min SOS / 5 min resto · profilo radio g3 27 dBm ERP/10%**

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
| crossing | tipico | 10 s | — | ✗ | ✗ (17%) | ✗ | ✗ | 33% | 19.2 min |
| crossing | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 24% | 13.1 min |
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


**Metrica airtime · ARALD attuale — coda relay 30 min SOS / 5 min resto · profilo radio g1 14 dBm ERP/1%**

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
| crossing | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 33% | 3.8 min |
| crossing | severo | 29 min | — | ✗ | ✗ | ✗ | ✗ | 10% | 1.7 min |
| storm | favorevole | 10 s | 30 s | ✗ (64%) | ✗ | ✗ | ✗ | 100% | 11.5 min |
| storm | tipico | 40 s | 3.0 h | ✗ | ✗ | ✗ | ✗ | 70% | 1.9 min |
| storm | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |
| box-failure | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | severo | — | — | ✗ | ✗ | ✗ | ✗ | 10% | 0.0 min |

**Metrica airtime · ARALD attuale — coda relay 30 min SOS / 5 min resto · profilo radio g3 27 dBm ERP/10%**

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
| crossing | tipico | 10 s | — | ✗ | ✗ (55%) | ✗ | ✗ | 33% | 19.3 min |
| crossing | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 24% | 13.1 min |
| storm | favorevole | 10 s | 30 s | 26 min | 49 min | ✗ (12%) | ✗ | 100% | 70.5 min |
| storm | tipico | 10 s | 50 s | 3.0 h | 3.5 h | ✗ (7%) | ✗ | 100% | 113.9 min |
| storm | severo | 3.0 h | — | ✗ | ✗ | ✗ | ✗ | 34% | 3.3 min |
| box-failure | favorevole | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | tipico | 10 s | — | ✗ | ✗ | ✗ | ✗ | 39% | 0.0 min |
| box-failure | severo | 40 s | — | ✗ | ✗ | ✗ | ✗ | 34% | 0.6 min |

Legenda D: F1 = SOS + coordinate (1 KB) (C5→PORT e BOX); F5 = GPS + audio 10 s (150 KB) (S5→BOX); F2 = Articolo Wiki (200 KB → ~70 KB compresso) (BOX→S5); F4 = Rapporto 5 pag. + 3 JPEG (5 MB) (S5→BOX); F3 = 8 JPEG (12 MB) (S5→BOX). "✗ (x%)" = non consegnato entro l'orizzonte, x% arrivato; "—" = destinazione non raggiunta. "C5→BOX connesso" = frazione del tempo con un percorso simultaneo (connettività istantanea): una consegna avvenuta con questo valore < 100% è passata (anche) per contatti opportunistici. "Airtime LoRa" = tempo di trasmissione LoRa consumato da tutti i file, tutte le copie. Varianti: static = nessun ponte sul colle: tre isole radio (valle A, vallone laterale, valle B); col-card = C3 sale al colle e ci resta: una persona con la Card fa da ponte tra le valli; fixed-relay = ARALD Fixed Relay installato al colle (13° dispositivo), C3 resta all'alpe; crossing = nessun ponte; C4 raggiunge l'infortunato e poi rivalica fino al Box (data mule); storm = come 'fixed-relay', con una perturbazione (+12 dB su ogni link LoRa) dalle 4h alle 7h; box-failure = come 'fixed-relay', ma il Box va offline a 3h54 (prima dell'evento).

## 7. Scenario 2 — cosa dice il modello

1. **La frammentazione è reale e la cresta la decide.** Senza ponte, in condizioni tipiche, la valle B è un'isola: l'SOS raggiunge il Portable in 10 s ma **non raggiunge mai il Box**, con qualunque sotto-banda e coda. C5→Box è connesso solo il 29% del tempo, cioè prima che C5 valichi. In condizioni severe e in g1 nemmeno il Portable, a 2 km nella stessa valle, viene raggiunto; in g3 sì (40 s).
2. **Un ponte sul colle ricuce la rete per i messaggi.** Con un Fixed Relay l'SOS arriva al Box in 30 s (tipico, entrambe le sotto-bande); con una persona e la sua Card al colle in 2,7 min (g1) / 30 s (g3): il Fixed Relay rende di più grazie all'antenna esterna e all'assenza del corpo. **Ma in condizioni severe nessun ponte funziona**: i link del colle (3,6-4,3 km) non chiudono, e resta solo la mobilità.
3. **Anche con il ponte, il colle diventa il collo di bottiglia.** Tutto il traffico tra le valli passa da un solo dispositivo, e il suo budget di duty-cycle (36 s/h in g1) è la capacità dell'intero collegamento: in g1 né l'audio (150 KB) né la Wiki arrivano in 6 h. In g3 (tipico) l'audio arriva in 26 min e la Wiki in 49 min.
4. **Il data mule che rivalica è l'unico modo di portare l'SOS al Box senza ponte, e oggi fallisce come nello Scenario 1.** Con la coda attuale l'SOS verso il Box va perso (tipico e severo). Con una coda DTN arriva in 2,5 h / 3,7 h (g1) e in 2,1 h / 2,5 h (g3), e rapporto e foto arrivano in 4 h via Wi-Fi al rientro: l'unico caso in tutto lo scenario in cui F3/F4 arrivano.
5. **Il meteo pesa molto meno in g3.** Con la perturbazione (+12 dB per 3 h) e il Fixed Relay, in tipico l'SOS al Box impiega 3 h in g1 (deve aspettare la fine della perturbazione) e 50 s in g3: i ~9 dB di EIRP in più del Box e del relay valgono come margine contro il maltempo.
6. **Il guasto del Box non ferma l'SOS, ma ferma tutto il resto.** Con il Box offline l'SOS raggiunge comunque il Portable in 10 s (tipico): avere due infrastrutture in valli diverse dà ridondanza all'emergenza. Ogni altro file però non ha una destinazione alternativa (la Wiki vive solo sul Box, i report sono indirizzati al Box) e resta fermo.
7. **Metrica airtime: aiuta, ma sposta il problema sul relay.** Con la metrica `airtime` l'audio passa dal 3% al 64% (favorevole, g1) e, con la Card al colle in g3 tipico, da non consegnato (51%) a 1,0 h. Ma con il Fixed Relay in g1 tipico la Wiki scende dal 14% a 0: più audio attraversa il relay del colle, il cui duty-cycle è condiviso tra i due versi e servito per priorità, così la Wiki (meno urgente) resta indietro. Una metrica migliore dovrebbe tenere conto anche del carico (budget residuo del duty-cycle), non solo dell'airtime.

## 8. Implicazioni proposte (non implementate — da valutare con l'utente)

- **TTL di custodia per il ruolo "courier"**: rendere configurabile (o molto più lungo, ore) il TTL di `PendingDeliveryQueue` per `Priority.EMERGENCY` sui nodi mobili (Card in Relay Mode, telefoni), oppure introdurre un vero bundle-store DTN separato dalla coda di retry. Oggi il ruolo "mobile relay" di `docs/beacon.md` non sopravvive a un attraversamento di ~2 h.
- **Policy di trasporto per dimensione**: impedire che contenuti oltre una soglia (es. 50-100 KB) usino LoRa e instradarli solo su Wi-Fi/BLE/contatto fisico, per non sprecare il budget di duty-cycle che serve agli SOS e ai messaggi.
- **Sotto-banda g3 (869,4-869,65 MHz, 27 dBm ERP/10%)** come candidata principale per i link infrastrutturali (Box/Portable/Fixed Relay), da decidere nella specifica radio (`docs/compliance.md`).
- **Ridondanza della catena** (Scenario 1): in un rifugio, un Fixed Relay in quota (o il Portable posizionato al rifugio) elimina il punto singolo di guasto C4.
- **Costo di instradamento consapevole dell'airtime** (entrambi gli scenari): `routing-table.ts` usa oggi il numero di salti, che preferisce link diretti lenti a percorsi multi-hop veloci. Un costo basato sullo SF/airtime del link (e idealmente sul budget di duty-cycle residuo del next hop, per non saturare un solo relay) riduce i tempi dei dati medi anche di un ordine di grandezza. La specifica prevede già un costo composito (`Cost = α·hops + β·latency + γ·loss + δ·energy + ε·congestion`), finora implementato solo nel termine `hops`.
- **Fixed Relay sui colli** come elemento di progetto per i rifugi in valli adiacenti: ricuce la rete per l'SOS in decine di secondi in condizioni tipiche; per i dati medi conviene g3, perché il relay del colle porta il traffico di entrambe le valli.
- **Seconda destinazione / failover**: un SOS indirizzato a più infrastrutture sopravvive al guasto del Box; per contenuti e report servirebbe un mirror (es. il Portable che replica le parti essenziali della Wiki e accetta i report quando il Box è irraggiungibile).

## 9. Limiti noti del modello

- Nessun modello del terreno (DEM): le creste sono perdite fisse per coppia di nodi (Scenario 1) o per zona (Scenario 2); il passo successivo naturale è un profilo terrain-aware (Longley-Rice/ITM o diffrazione knife-edge su DEM).
- Lo Scenario 2 è una geometria sintetica, non un luogo reale.
- Nessun failover di destinazione per i contenuti (variante `box-failure`): i file indirizzati al Box restano fermi per costruzione.
- Canale LoRa come unico dominio di collisione con efficienza fissa; nessuna collisione/hidden-terminal esplicita, nessun retry/ACK a livello di frame (implicito nell'efficienza 50%).
- Fading statico (margine fisso), nessuna variabilità temporale del link oltre alla mobilità.
- Trasferimento di contenuti modellato come "push" verso la destinazione; in ARALD è "pull" (`CONTENT_QUERY` → chunk), con overhead di richiesta non incluso.
- Il modello "DTN" non ha limite di memoria nei relay; quello "ARALD attuale" approssima la combinazione `floodExcept()` + `PendingDeliveryQueue` + `SeenCache` (in particolare: un relay connesso inoltra senza scadenza tramite le code del transport).
- Throughput BLE/Wi-Fi sono valori nominali prudenziali, non misurati.

## 10. Come estendere

Un nuovo scenario è un file accanto a `tools/scenario-model/valle-maira.ts` che esporta un oggetto `Scenario` (`tools/scenario-model/scenario.ts`: nodi con traiettorie, ambienti, messaggi, varianti, eventuale perdita dipendente dal tempo) e si registra in `cli.ts`; `model.ts` resta invariato. Parametri da riga di comando: `--scenario valle-maira|alpino-frammentato`, `--max-sf`, `--horizon-h`, `--policy custody|epidemic`.
