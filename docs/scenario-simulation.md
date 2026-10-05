# Simulazione teorica di efficienza della rete ARALD — modello parametrico

**Stato**: Scenario 1 (alta Valle Maira) completato come prima applicazione del modello. Scenari successivi (secondo alpino più frammentato, Eolie, Atacama, Kampala, …) da aggiungere come nuovi file di scenario sullo stesso motore.

**Cosa è e cosa non è.** È un modello **teorico e parametrico** (`tools/scenario-model/`, `npm run scenario-model`) per confrontare scenari e ordini di grandezza. **Non** è una misura: nessun parametro radio di questo documento è stato verificato su hardware o sul terreno (nessun accesso a hardware né a internet reale in questo ambiente). Coordinate, quote, ostruzioni e sensibilità sono ipotesi dichiarate qui sotto, da sostituire con misure (Fase 2 di `docs/test-protocol.md`) quando disponibili. È separato da `tools/simulator/`, che invece esegue istanze reali di `NomadNode` su TCP locale senza alcuna fisica radio.

## 1. Modello

Rete dinamica \(G(t) = (V, E(t))\), simulata a passo discreto (10 s).

- **Nodi** \(v_i = (p_i(t), T_i, P_i, A_i)\): posizione da traiettoria a waypoint (interpolazione lineare), tecnologie (LoRa/BLE/Wi-Fi per tipo), potenza, guadagno d'antenna e perdita da corpo. Un nodo può spegnersi a un istante dato (robustezza).
- **Link LoRa** — link budget:
  \(RSSI_{ij} = EIRP + G_r - L_{corpo} - L_{path}(d, n) - L_{ostruzione,ij} - L_{interferenza}\), con \(EIRP = \min(P_{tx}^{hw} + G_t,\ ERP_{max}^{reg} + 2{,}15)\) (limite sia hardware sia normativo; link simmetrico, si usa l'EIRP del più debole dei due),
  con \(L_{path} = FSPL(1\,m) + 10\,n \log_{10} d\) a 868 MHz. Il link esiste se \(RSSI - M_{fading} \ge S(SF)\) per qualche SF; si sceglie **lo SF più veloce che chiude il link** (logica ADR).
- **Link corti**: Wi-Fi solo verso Box/Portable (access point) entro 80 m, 8 Mbps applicativi; BLE entro 30 m, 200 kbps applicativi. Mezzo preferito: Wi-Fi > BLE > LoRa.
- **Capacità LoRa reale**: time-on-air dalla formula Semtech (BW 125 kHz, CR 4/5, preambolo 8, header esplicito, CRC, LDRO a SF11/12), frame 222 B di cui 22 B di framing; overhead applicativo ARALD ×1,45 (i `CONTENT_CHUNK` viaggiano in base64 dentro JSON, più envelope e firme — `node.ts`). **Duty-cycle legale per nodo** come token bucket (finestra 1 h) e **canale condiviso** come unico dominio di collisione con efficienza 50% (conservativo); il credito del canale si accumula tra un passo e l'altro, così anche un frame SF12 (~8 s) può essere trasmesso.
- **Code e instradamento** (policy `custody`, ricalca `floodExcept()` in `node.ts`): se esiste un percorso istantaneo il nodo inoltra a **un solo next hop** (più vicino in hop, a parità il mezzo più veloce); altrimenti consegna a tutti i vicini, che trattengono e ri-inoltrano (store-carry-forward). Priorità stretta per mittente sul LoRa (come `priority-queue.ts`): un messaggio meno urgente non consuma il budget lasciato da uno più urgente bloccato. Granularità a byte: un relay può inoltrare solo la parte già ricevuta (chunk progressivi).
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

## 3. Risultati

Output integrale di `npm run scenario-model` (default: policy `custody`, SF max 12, orizzonte 10 h dalla partenza, cioè 6h45 dopo la generazione dei file).

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

### C. Link LoRa stimati a t = 3h15 (gruppo distribuito), SF minimo che chiude il link

| Link | Distanza | favorevole g1 14 dBm ERP/1% | favorevole g3 27 dBm ERP/10% | tipico g1 14 dBm ERP/1% | tipico g3 27 dBm ERP/10% | severo g1 14 dBm ERP/1% | severo g3 27 dBm ERP/10% |
|---|---:|:---:|:---:|:---:|:---:|:---:|:---:|
| BOX–C2 | 1.0 km | SF7 | SF7 | SF7 | SF7 | SF9 | SF8 |
| BOX–C3 | 2.1 km | SF7 | SF7 | SF7 | SF7 | ✗ | SF12 |
| BOX–C4 | 3.9 km | SF7 | SF7 | ✗ | ✗ | ✗ | ✗ |
| BOX–C5 | 5.5 km | SF7 | SF7 | ✗ | ✗ | ✗ | ✗ |
| C2–C3 | 1.1 km | SF7 | SF7 | SF7 | SF7 | SF12 | SF10 |
| C3–C4 | 1.8 km | SF7 | SF7 | SF8 | SF7 | ✗ | ✗ |
| C4–C5 | 1.7 km | SF7 | SF7 | SF7 | SF7 | ✗ | ✗ |
| C3–C5 | 3.5 km | SF7 | SF7 | ✗ | ✗ | ✗ | ✗ |
| PORT–C3 | 0.4 km | SF7 | SF7 | SF7 | SF7 | SF7 | SF7 |
| PORT–C4 | 2.2 km | SF7 | SF7 | SF10 | SF9 | ✗ | ✗ |
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
| static | tipico | 30 s | 41 min | 1.4 h | ✗ (16%) | ✗ | 100% | 151.8 min |
| static | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 6.1 min |
| ferry | favorevole | 10 s | 13 min | 19 min | ✗ (54%) | ✗ | 100% | 85.6 min |
| ferry | tipico | 30 s | 1.5 h | 1.7 h | ✗ (31%) | ✗ | 100% | 125.9 min |
| ferry | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 7.1 min |
| return | favorevole | 10 s | 13 min | 19 min | 2.2 h | 2.2 h | 100% | 45.3 min |
| return | tipico | 30 s | 1.1 h | 1.5 h | 2.2 h | 2.2 h | 100% | 67.4 min |
| return | severo | 1.6 h | 2.2 h | 2.2 h | 2.2 h | 2.2 h | 64% | 24.6 min |
| card-failure | favorevole | 10 s | 13 min | 19 min | ✗ (18%) | ✗ | 100% | 49.5 min |
| card-failure | tipico | ✗ | ✗ | ✗ | ✗ | ✗ | 30% | 7.6 min |
| card-failure | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 6.1 min |

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
| static | tipico | 30 s | 41 min | 1.4 h | ✗ (16%) | ✗ | 100% | 151.8 min |
| static | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 12.4 min |
| ferry | favorevole | 10 s | 13 min | 19 min | ✗ (54%) | ✗ | 100% | 85.6 min |
| ferry | tipico | 30 s | 1.5 h | 1.7 h | ✗ (31%) | ✗ | 100% | 125.9 min |
| ferry | severo | 2.9 h | 3.6 h | 1.7 h | 3.7 h | 3.7 h | 15% | 51.6 min |
| return | favorevole | 10 s | 13 min | 19 min | 2.2 h | 2.2 h | 100% | 45.3 min |
| return | tipico | 30 s | 1.1 h | 1.5 h | 2.2 h | 2.2 h | 100% | 67.4 min |
| return | severo | 1.7 h | 2.2 h | 1.7 h | 2.2 h | 2.2 h | 64% | 45.6 min |
| card-failure | favorevole | 10 s | 13 min | 19 min | ✗ (18%) | ✗ | 100% | 49.5 min |
| card-failure | tipico | ✗ | ✗ | ✗ | ✗ | ✗ | 30% | 9.1 min |
| card-failure | severo | ✗ | ✗ | ✗ | ✗ | ✗ | 15% | 12.4 min |

Legenda D: F1 = SOS + coordinate (1 KB) (C5→BOX); F5 = GPS + audio 10 s (150 KB) (S5→BOX); F2 = Articolo Wiki (200 KB → ~70 KB compresso) (BOX→S5); F4 = Rapporto 5 pag. + 3 JPEG (5 MB) (S5→BOX); F3 = 8 JPEG (12 MB) (S5→BOX). "✗ (x%)" = non consegnato entro l'orizzonte, x% arrivato. "C5→BOX connesso" = frazione del tempo con un percorso simultaneo (connettività istantanea): una consegna avvenuta con questo valore < 100% è passata (anche) per contatti opportunistici. "Airtime LoRa" = tempo di trasmissione LoRa consumato da tutti i file, tutte le copie. Varianti: static = gruppo fermo dopo l'arrivo (C5 verso Barenghi, C4 al rifugio); ferry = C3 sale fino a C5 (data mule) e rientra al Campo Base; return = C5+S5 scendono al Campo Base (rientro del gruppo); card-failure = come 'static', ma la Card C4 (rifugio) si spegne a 3h.

Con `--horizon-h 30` (quasi 27 h dopo l'evento), nella variante `static` in condizioni tipiche: in g1 (1%) F5 arriva in 18,2 h, la Wiki al 95%, F4 allo 0,6%, F3 a 0; in g3 (10%) F4 arriva al 71%, F3 ancora a 0.

## 4. Cosa dice il modello

1. **L'SOS funziona bene in ogni caso in cui esista un percorso, anche multi-hop**: 10-30 s nella rete connessa, perfino agli SF lenti. È il caso d'uso naturale di LoRa e la valutazione dell'analisi di partenza (★★★★★) regge.
2. **I throughput "10-20 kbps" dell'analisi di partenza sono irrealistici in EU868.** Al netto dell'overhead ARALD, LoRa SF7/125 kHz rende ~3,2 kbps *a canale libero*; con il duty-cycle legale si scende a **~32 bps (1%) o ~320 bps (10%)** sostenuti per nodo. Di conseguenza 12 MB via LoRa richiedono **giorni o settimane** (3,6 giorni nel caso migliore SF7/10% su un solo hop, ~37 giorni all'1%), non 1-22 ore. Anche 70-150 KB (Wiki, audio) arrivano in minuti/decine di minuti solo in g3 (10%); in g1 (1%) richiedono ore.
3. **Per i file grandi l'unico canale che conta è fisico: la persona che porta il telefono vicino al Box.** Nella variante `return` tutti i file arrivano in ~2,2 h (= tempo di cammino + qualche secondo di Wi-Fi), in qualunque condizione radio. La rete "Wi-Fi/BLE locale + mobilità" batte LoRa di 2-3 ordini di grandezza per F3/F4. Conferma la conclusione architetturale di partenza (LoRa = controllo e piccoli dati; mobilità = estensione temporale), ma con un divario molto più netto.
4. **La scelta della sotto-banda conta molto per i dati medi, poco per l'SOS**: passare da g1 (1%) a g3 (10%) porta F5 (150 KB) da "non arriva in 6h45" a 13 min (favorevole) / 41 min (tipico), e la Wiki da "non arriva" a 1,4 h in tipico. Il guadagno viene **soprattutto dal duty-cycle**, non dalla potenza: con l'SX1262 a +22 dBm il Box guadagna ~9 dB di EIRP passando a g3, ma una Card con antenna −3 dBi solo ~3 dB, quindi i link Card–Card cambiano poco (nessun link aggiuntivo verso C4/C5 in tipico).
5. **Il "data mule" oggi non funziona davvero nel codice ARALD.** Nella variante `ferry` in condizioni severe (unico caso in cui il mulo è l'unico ponte), con la coda attuale di `PendingDeliveryQueue` (30 min EMERGENCY, 5 min resto) **anche l'SOS va perso**: il mulo resta isolato ~2 h tra il contatto con C5 e il rientro, e la copia scade prima. Con una coda in stile DTN lo stesso mulo consegna l'SOS in ~3,4 h (g1) / ~2,9 h (g3) e i file grandi in ~3,7 h (via Wi-Fi al rientro). Questo è il risultato più concreto per il codice: il TTL di 30 min per gli SOS dichiarato per il "courier" è più corto di un tipico attraversamento a piedi di un gap alpino.
6. **Robustezza: la catena di Card è fragile.** In condizioni tipiche la sola Card C4 al rifugio è punto singolo di guasto: spenta lei, C5 resta isolata (connettività istantanea C5→Box dal 100% al 30%, solo prima delle 3h) e nulla viene consegnato. In condizioni severe la rete fissa non raggiunge mai C5 (connettività 13-15%, solo nella fase di salita) e serve sempre la mobilità.
7. **Connettività istantanea ≠ capacità.** In condizioni tipiche C5→Box è connessa il 100% del tempo, eppure F5 (150 KB) arriva solo al 40% in 6h45 in g1 (1%): il collo di bottiglia è l'airtime legale, non la topologia.

## 5. Implicazioni proposte (non implementate — da valutare con l'utente)

- **TTL di custodia per il ruolo "courier"**: rendere configurabile (o molto più lungo, ore) il TTL di `PendingDeliveryQueue` per `Priority.EMERGENCY` sui nodi mobili (Card in Relay Mode, telefoni), oppure introdurre un vero bundle-store DTN separato dalla coda di retry. Oggi il ruolo "mobile relay" di `docs/beacon.md` non sopravvive a un attraversamento di ~2 h.
- **Policy di trasporto per dimensione**: impedire che contenuti oltre una soglia (es. 50-100 KB) usino LoRa e instradarli solo su Wi-Fi/BLE/contatto fisico, per non sprecare il budget di duty-cycle che serve agli SOS e ai messaggi.
- **Sotto-banda g3 (869,4-869,65 MHz, 27 dBm ERP/10%)** come candidata principale per i link infrastrutturali (Box/Portable/Fixed Relay), da decidere nella specifica radio (`docs/compliance.md`).
- **Ridondanza della catena**: in un rifugio, un Fixed Relay in quota (o il Portable posizionato al rifugio) elimina il punto singolo di guasto C4.

## 6. Limiti noti del modello

- Nessun modello del terreno (DEM): le creste sono perdite fisse per coppia di nodi; il passo successivo naturale è un profilo terrain-aware (Longley-Rice/ITM o diffrazione knife-edge su DEM).
- Canale LoRa come unico dominio di collisione con efficienza fissa; nessuna collisione/hidden-terminal esplicita, nessun retry/ACK a livello di frame (implicito nell'efficienza 50%).
- Fading statico (margine fisso), nessuna variabilità temporale del link oltre alla mobilità.
- Trasferimento di contenuti modellato come "push" verso la destinazione; in ARALD è "pull" (`CONTENT_QUERY` → chunk), con overhead di richiesta non incluso.
- Il modello "DTN" non ha limite di memoria nei relay; quello "ARALD attuale" approssima la combinazione `floodExcept()` + `PendingDeliveryQueue` + `SeenCache` (in particolare: un relay connesso inoltra senza scadenza tramite le code del transport).
- Throughput BLE/Wi-Fi sono valori nominali prudenziali, non misurati.

## 7. Come estendere

Un nuovo scenario è un file accanto a `tools/scenario-model/valle-maira.ts` che esporta nodi (con traiettorie), ambienti e messaggi; `model.ts` resta invariato. Parametri principali da riga di comando: `--max-sf`, `--horizon-h`, `--policy custody|epidemic`.
