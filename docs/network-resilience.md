# Test Network Resilience (Failure Simulation)

**Stato**: funzione core del tool di progettazione (`docs/network-design-tool.md` §A), implementata come motore deterministico in `tools/scenario-model/resilience.ts` (nucleo sul grafo + adattatore radio), `resilience-report.ts` (testo) e integrata nella CLI. L'interfaccia grafica (nodo spento sulla mappa, aree disegnate, legenda) è del tool futuro: qui c'è il motore che le fornisce i dati. Tutti i parametri radio, il terreno e le coordinate sono quelli, **non verificati**, degli scenari di `docs/scenario-simulation.md`.

**Cosa risponde**: "cosa succede alla rete se questo nodo (questi nodi, quest'area) smette di funzionare?" e, per una rete intera, "quanto è resiliente?". Dal progetto alla **verifica della resilienza**.

## 1. Come si usa

```bash
# Punteggio e dipendenze critiche di una rete salvata (formato del tool)
npm run scenario-model -- --config tools/scenario-model/examples/eolie-resilienza.json --resilience

# Un guasto, più guasti insieme
npm run scenario-model -- --config <file.json> --resilience --fail PORT
npm run scenario-model -- --config <file.json> --resilience --fail PORT,C4

# Guasto d'area (i nodi dentro si spengono) e area-ostacolo (i link che la attraversano perdono dB)
npm run scenario-model -- --config <file.json> --resilience --fail-area lat,lon,raggioM
npm run scenario-model -- --config <file.json> --resilience --block-area lat,lon,raggioM,perditaDb

# Finestra per i percorsi opportunistici (ore dall'inizio; di default dai percorsi dei dispositivi mobili)
npm run scenario-model -- --config <file.json> --resilience --window 0,3.5,60

# Su uno scenario: una variante, oppure il confronto di tutte le varianti
npm run scenario-model -- --scenario eolie --variant hydrofoil --resilience --fail C4
npm run scenario-model -- --scenario eolie --resilience --variant all --horizon-h 6
```

Aggiungi `--json` per l'output strutturato (`FailureReport` / `ResilienceScore`). I dispositivi mobili si dichiarano nella configurazione con `"route": [{"tS": s, "lat": ..., "lon": ...}, ...]` (esempio: l'aliscafo in `examples/eolie-resilienza.json`).

Da codice (il futuro tool):

```ts
const ctx = prepareResilience({ params, nodes, window, frame });   // una tantum, ~1 s
const report = evaluateFailure(ctx, { nodes: ["BOX"] });           // ~1 ms
const score = resilienceScore(ctx);                                  // ~7 ms
```

`prepareResilience` calcola una volta sola il grafo dei link, gli aloni di copertura e le istantanee nel tempo. Ogni guasto successivo è un'operazione sul grafo e su maschere di bit, quindi interattiva: sull'esempio delle Eolie (8 dispositivi, 2420 celle, 211 istantanee) la preparazione costa ~0,9 s, un guasto ~1 ms, il punteggio completo (8 guasti singoli) ~7 ms.

## 2. Definizioni (tutte derivate dal modello)

- **Infrastruttura (sink)**: i Box e i Portable attivi, dove vivono i servizi.
- **Nodo connesso**: ha un percorso istantaneo, multi-hop e con qualunque tecnologia, verso un'infrastruttura attiva. **Connettività diretta** = il percorso esiste nello stesso istante.
- **Connettività opportunistica**: non esiste un percorso simultaneo, ma esiste una sequenza di contatti nel tempo in ordine crescente (store-carry-forward): \(A \xrightarrow{t_1} X \xrightarrow{t_2} \text{infrastruttura}\), \(t_1 < t_2\). In ogni istantanea un messaggio attraversa tutta la componente connessa di chi lo porta; tra due istantanee resta nel nodo che lo trasporta. **L'ordine conta**: un portatore che incontra l'infrastruttura *prima* del nodo non lo recupera. Si considerano solo i contatti da `max(inizio finestra, istante del guasto)` in poi: ciò che avviene prima del guasto non può trasportare messaggi che non esistono ancora, e gli arrivi si misurano dall'istante del guasto. Un arrivo a 0 s significa che la connessione c'è già all'istante del guasto.
- **Stati dei nodi dopo un guasto**: `failed` (spento, resta sulla mappa), `connected`, `recoverable` (non connesso direttamente ma con un percorso opportunistico), `cut-off` (ha link ma nessun percorso verso l'infrastruttura), `isolated` (nessun link).
- **Tagliati fuori** (`cutOff`): nodi connessi prima del guasto e non più dopo (la perdita causata dal guasto).
- **Copertura radio**: frazione delle celle di terra dell'area di analisi raggiunte dall'alone LoRa di almeno un nodo attivo. **Copertura connessa**: lo stesso, contando solo i nodi connessi a un'infrastruttura (l'alone di una Card isolata non serve a nessuno). L'area di analisi è il riquadro dei dispositivi con un margine, oppure quella passata dal chiamante: **la percentuale dipende dall'area scelta**.
- **Percorsi alternativi**: i nodi ancora connessi con un numero di salti diverso verso l'infrastruttura (`rerouted`).
- **Dipendenza critica** (single point of failure): un nodo che, spegnendosi, taglia fuori almeno un altro nodo **di rete** (Box, Portable, Card, relay). Uno smartphone che dipende dalla propria Card è normale (la Card è il suo adattatore radio) e non rende critica la Card; gli smartphone tagliati fuori compaiono comunque nel report del guasto.
- **Aree rimaste scoperte**: le celle che erano in copertura connessa e non lo sono più (`lostCells`, per la mappa).

## 3. I tre modi di guasto

1. **Guasto singolo**: un nodo `OFFLINE/FAILED`.
2. **Guasto multiplo**: più nodi insieme.
3. **Guasto d'area**: un cerchio o un poligono (in latitudine/longitudine o in metri locali) con due effetti indipendenti: `failNodes` (default sì) spegne i nodi la cui posizione cade dentro, come per un terremoto o un incendio; `blockLossDb` aggiunge una perdita a ogni link il cui segmento attraversa l'area, in qualunque istante, come per una frana o un fronte di fumo. 40 dB o più equivalgono a "impossibile attraversare". Il link attraversato viene **rivalutato** con il modello radio: cade solo se la perdita aggiuntiva supera il suo margine. Senza modello radio (nucleo puro) un'area-ostacolo taglia i link che attraversa.

Le aree si combinano con i nodi esplicitati. Nell'MVP l'utente seleziona a mano nodi e aree, senza scenari predefiniti.

## 4. Resilience Score (0-100)

Media pesata di componenti 0-1, tutte calcolate dal modello. Pesi di default uguali; una componente non calcolabile è **esclusa** e gli altri pesi si ri-normalizzano (succede senza copertura, con `skipCoverage`, o con `window: false`, che disattiva l'analisi temporale). **Mancanza di dati di mobilità vale "nessuna mobilità"**: se non si dichiara alcuna finestra, la si ricava dai percorsi dei nodi; se nessun nodo si muove la rete è statica, la raggiungibilità vale la connettività diretta e il recupero opportunistico vale 0%. In questo modo le reti con e senza mobilità sono confrontabili: l'aliscafo delle Eolie fa salire il punteggio da 56 a 73 rispetto alla stessa rete senza aliscafo. Non è una garanzia generale: un nodo che si sposta può anche smettere di servire chi serviva da fermo, e il punteggio lo registra. I pesi sono un parametro (`ResilienceWeights`): il futuro Optimizer li farà regolare all'utente.

| Componente | Definizione |
|---|---|
| `coverage` | copertura connessa della rete integra (frazione dell'area di analisi) |
| `directConnectivity` | frazione dei nodi di rete (non infrastruttura, non smartphone) con un percorso diretto verso l'infrastruttura |
| `reachability` | frazione dei nodi di rete che raggiungono un'infrastruttura direttamente o, entro la finestra, in modo opportunistico |
| `redundancy` | tra i nodi connessi, quelli che restano connessi dopo **qualunque** guasto singolo di un altro nodo |
| `coverageUnderFailure` | copertura connessa **media** dopo un guasto singolo, in valore assoluto: "se un nodo a caso si guasta, in media la rete copre X% dell'area" |
| `opportunisticRecovery` | tra i nodi che un guasto singolo taglia fuori, quelli recuperabili in modo opportunistico (esclusa se nessun guasto taglia fuori nessuno) |

Note di progetto: `coverageUnderFailure` è assoluta di proposito. Una prima versione la definiva relativa alla copertura di partenza e premiava una rete già inutilizzabile per aver "perso poco" (86% di quasi nulla): il confronto tra varianti l'ha mostrato. Il punteggio riporta inoltre i **nodi critici**, i **gap recuperabili** (nodi tagliati fuori da un guasto singolo ma raggiungibili in modo opportunistico) e il **peggior guasto singolo**, come nella specifica.

## 5. Risultati

### 5.1 Esempio Eolie con l'aliscafo (`examples/eolie-resilienza.json`)

Box a Lipari, Portable a Stromboli, Fixed Relay a Panarea, cinque Card e un aliscafo (C4) Lipari → Panarea → Stromboli e ritorno in 3h30, ambiente tipico, regole al 10%.

**Resilience Score: 73 / 100**

| Componente | Valore | Peso |
|---|---:|---:|
| Copertura connessa (rete integra) | 79% | 1 |
| Connettività diretta | 100% | 1 |
| Raggiungibilità dell'infrastruttura (diretta o opportunistica) | 100% | 1 |
| Percorsi ridondanti | 0% | 1 |
| Copertura connessa media dopo un guasto singolo | 62% | 1 |
| Recupero opportunistico dei nodi tagliati fuori | 100% | 1 |

- **Nodi critici** (single point of failure): 3 — BOX, FR, PORT
- **Gap recuperabili** (tagliati fuori da un guasto singolo ma raggiungibili in modo opportunistico): 6 — C1, C2, C3, C4, C5, FR
- **Peggior guasto singolo**: BOX, taglia fuori 5 nodi

**Guasti singoli, dal più dannoso**

| Guasto singolo | Tipo | Nodi tagliati fuori | Smartphone tagliati fuori | Recuperabili (opportunistico) | Copertura connessa persa | Critico |
|---|---|---|---|---|---:|:---:|
| BOX | box | FR, C1, C2, C3, C4 | — | C1, C2, C3, C4, FR | 74% | sì |
| FR | relay | C2, C3 | — | C2, C3 | 48% | sì |
| PORT | portable | C5 | — | C5 | 3.8% | sì |
| C1 | card | — | — | — | 3.8% | no |
| C2 | card | — | — | — | 2.2% | no |
| C3 | card | — | — | — | 0% | no |
| C4 | card | — | — | — | 0% | no |
| C5 | card | — | — | — | 0% | no |

**Dipendenze critiche della rete integra**

| Nodo | Tipo | Nodi che perde | Smartphone che perde | Copertura persa |
|---|---|---|---|---:|
| BOX | box | FR, C1, C4, C2, C3 | — | 74% |
| FR | relay | C2, C3 | — | 48% |
| PORT | portable | C5 | — | 3.8% |

Il Box è un single point of failure per cinque nodi (74% della copertura connessa), ma **ogni gap è recuperabile in modo opportunistico**: dopo 1,7 h l'aliscafo, avvicinandosi a Stromboli, è ancora nel raggio del relay di Panarea e incontra il Portable, quindi tutta la rete a ovest recapita a un'infrastruttura. Senza l'aliscafo la stessa rete vale **56** invece di 73 (recupero opportunistico 0%): è la distinzione diretto/opportunistico che la specifica chiede.

**Spegnendo il Box**:

**Guasto singolo: BOX**

| Metrica | Prima | Dopo |
|---|---:|---:|
| Nodi attivi | 8 | 7 |
| Connessioni | 9 | 6 |
| Frammenti di rete | 2 | 2 |
| Copertura connessa | 79% | 4.4% |
| Copertura radio | 79% | 79% |
| Nodi isolati (nessun link) | — | 0 |

- **Tagliati fuori dall'infrastruttura** (connessi prima, non più dopo): FR, C1, C2, C3, C4
- **Recuperabili con un percorso opportunistico**: C1 (dopo 1.7 h), C2 (dopo 1.7 h), C3 (dopo 1.7 h), C4 (dopo 1.7 h), FR (dopo 1.7 h)
- **Senza alcun percorso, nemmeno opportunistico**: —
- **Aree rimaste scoperte**: 136 celle di copertura connessa perse
- Stato dei nodi: BOX:failed PORT:connected FR:recoverable C1:recoverable C2:recoverable C3:recoverable C5:connected C4:recoverable

**Dipendenze critiche nella rete residua**

| Nodo | Tipo | Nodi che perde | Smartphone che perde | Copertura persa |
|---|---|---|---|---:|
| PORT | portable | C5 | — | 4.4% |

**Spegnendo il Portable** (C5, sul vulcano, perde l'unica infrastruttura vicina; l'aliscafo la recupera):

**Guasto singolo: PORT**

| Metrica | Prima | Dopo |
|---|---:|---:|
| Nodi attivi | 8 | 7 |
| Connessioni | 9 | 8 |
| Frammenti di rete | 2 | 2 |
| Copertura connessa | 79% | 75% |
| Copertura radio | 79% | 79% |
| Nodi isolati (nessun link) | — | 1 |

- **Tagliati fuori dall'infrastruttura** (connessi prima, non più dopo): C5
- **Isolati** (nessun link): C5
- **Recuperabili con un percorso opportunistico**: C5 (dopo 1.7 h)
- **Senza alcun percorso, nemmeno opportunistico**: —
- **Aree rimaste scoperte**: 7 celle di copertura connessa perse
- Stato dei nodi: BOX:connected PORT:failed FR:connected C1:connected C2:connected C3:connected C5:recoverable C4:connected

**Dipendenze critiche nella rete residua**

| Nodo | Tipo | Nodi che perde | Smartphone che perde | Copertura persa |
|---|---|---|---|---:|
| BOX | box | FR, C1, C4, C2, C3 | — | 75% |
| FR | relay | C2, C3 | — | 48% |

**Guasto multiplo Portable + aliscafo**: C5 non ha più alcuna via, nemmeno opportunistica.

**Guasti multipli: PORT, C4**

| Metrica | Prima | Dopo |
|---|---:|---:|
| Nodi attivi | 8 | 6 |
| Connessioni | 9 | 5 |
| Frammenti di rete | 2 | 2 |
| Copertura connessa | 79% | 75% |
| Copertura radio | 79% | 79% |
| Nodi isolati (nessun link) | — | 1 |

- **Tagliati fuori dall'infrastruttura** (connessi prima, non più dopo): C5
- **Isolati** (nessun link): C5
- **Recuperabili con un percorso opportunistico**: —
- **Senza alcun percorso, nemmeno opportunistico**: C5
- **Aree rimaste scoperte**: 7 celle di copertura connessa perse
- Stato dei nodi: BOX:connected PORT:failed FR:connected C1:connected C2:connected C3:connected C5:isolated C4:failed

**Dipendenze critiche nella rete residua**

| Nodo | Tipo | Nodi che perde | Smartphone che perde | Copertura persa |
|---|---|---|---|---:|
| BOX | box | FR, C1, C2, C3 | — | 75% |
| FR | relay | C2, C3 | — | 52% |

**Guasto d'area** (3 km attorno a Panarea: si spengono relay e Card dell'isola):

**Guasti multipli: FR, C3**

| Metrica | Prima | Dopo |
|---|---:|---:|
| Nodi attivi | 8 | 6 |
| Connessioni | 9 | 4 |
| Frammenti di rete | 2 | 3 |
| Copertura connessa | 79% | 31% |
| Copertura radio | 79% | 52% |
| Nodi isolati (nessun link) | — | 1 |

- **Tagliati fuori dall'infrastruttura** (connessi prima, non più dopo): C2
- **Isolati** (nessun link): C2
- **Recuperabili con un percorso opportunistico**: C2 (dopo 24 min)
- **Senza alcun percorso, nemmeno opportunistico**: —
- **Aree rimaste scoperte**: 87 celle di copertura connessa perse
- Stato dei nodi: BOX:connected PORT:connected FR:failed C1:connected C2:recoverable C3:failed C5:connected C4:connected

**Dipendenze critiche nella rete residua**

| Nodo | Tipo | Nodi che perde | Smartphone che perde | Copertura persa |
|---|---|---|---|---:|
| BOX | box | C1, C4 | — | 27% |
| PORT | portable | C5 | — | 4.4% |

**Ostacolo senza spegnere nodi** (60 dB su 1,5 km di mare tra Lipari e Panarea): il link Box–relay cade, ma il relay resta connesso passando da Vulcano (C1). La rete ha un **percorso alternativo**, e C1 diventa una nuova dipendenza critica che nella rete integra non lo era:

**Nessun nodo spento, percorsi ostruiti**

| Metrica | Prima | Dopo |
|---|---:|---:|
| Nodi attivi | 8 | 8 |
| Connessioni | 9 | 7 |
| Frammenti di rete | 2 | 2 |
| Copertura connessa | 79% | 79% |
| Copertura radio | 79% | 79% |
| Nodi isolati (nessun link) | — | 0 |

- **Tagliati fuori dall'infrastruttura** (connessi prima, non più dopo): —
- **Recuperabili con un percorso opportunistico**: —
- **Senza alcun percorso, nemmeno opportunistico**: —
- **Percorsi allungati o accorciati** verso l'infrastruttura: C2 (2→3 salti), C3 (2→3 salti), FR (1→2 salti)
- **Aree rimaste scoperte**: 0 celle di copertura connessa perse
- Stato dei nodi: BOX:connected PORT:connected FR:connected C1:connected C2:connected C3:connected C5:connected C4:connected

**Dipendenze critiche nella rete residua**

| Nodo | Tipo | Nodi che perde | Smartphone che perde | Copertura persa |
|---|---|---|---|---:|
| BOX | box | C1, C4, FR, C2, C3 | — | 74% |
| C1 | card | FR, C2, C3 | — | 51% |
| FR | relay | C2, C3 | — | 48% |
| PORT | portable | C5 | — | 3.8% |

### 5.2 Kampala, guasto del Box con relay e corriere (`--scenario kampala --variant relay-boda`)

**Guasto singolo: BOX**

| Metrica | Prima | Dopo |
|---|---:|---:|
| Nodi attivi | 13 | 12 |
| Connessioni | 7 | 6 |
| Frammenti di rete | 6 | 6 |
| Copertura connessa | 18% | 0.5% |
| Copertura radio | 20% | 15% |
| Nodi isolati (nessun link) | — | 1 |

- **Tagliati fuori dall'infrastruttura** (connessi prima, non più dopo): FR
- **Isolati** (nessun link): FR
- **Recuperabili con un percorso opportunistico**: C1 (dopo 2.0 h, già non connesso prima), C4 (dopo 2.0 h, già non connesso prima), C5 (dopo 2.0 h, già non connesso prima), FR (dopo 2.0 h), S1 (dopo 2.0 h, già non connesso prima), S4 (dopo 2.0 h, già non connesso prima), S5 (dopo 2.0 h, già non connesso prima)
- **Senza alcun percorso, nemmeno opportunistico**: —
- **Aree rimaste scoperte**: 378 celle di copertura connessa perse
- Stato dei nodi: BOX:failed PORT:connected C1:recoverable C2:cut-off C3:cut-off C4:recoverable C5:recoverable S1:recoverable S2:cut-off S3:cut-off S4:recoverable S5:recoverable FR:recoverable

**Dipendenze critiche nella rete residua**

Nessuna dipendenza critica: nessun nodo, spegnendosi, taglia fuori un altro nodo.

### 5.3 Resilience Score di tutte le varianti degli scenari

Ambiente tipico, regole al 10% (Atacama: AU915), analisi all'istante dell'evento, finestra opportunistica da lì a 6 h. Per gli Scenari 1-2 (senza territorio) la copertura non è calcolata e le sue componenti sono escluse.

#### Scenario 1 — alta Valle Maira — Resilience Score per variante (ambiente tipico, g3, finestra 0–6 h)
| Variante | Score | Copertura | Diretta | Raggiungibile | Ridondanza | Copertura sotto guasto | Recupero opp. | Nodi critici | Gap recuperabili | Peggior guasto |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| static | **70** | — | 100% | 100% | 80% | — | 0% | C4 | — | C4 (1) |
| ferry | **95** | — | 100% | 100% | 80% | — | 100% | C4 | C5 | C4 (1) |
| return | **95** | — | 100% | 100% | 80% | — | 100% | C4 | C5 | C4 (1) |
| card-failure | **83** | — | 75% | 75% | 100% | — | — | — | — | — |
#### Scenario 2 — alpino frammentato (due valli separate da una cresta) — Resilience Score per variante (ambiente tipico, g3, finestra 0–6 h)
| Variante | Score | Copertura | Diretta | Raggiungibile | Ridondanza | Copertura sotto guasto | Recupero opp. | Nodi critici | Gap recuperabili | Peggior guasto |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| static | **40** | — | 80% | 80% | 0% | — | 0% | BOX, PORT | — | BOX (2) |
| col-card | **87** | — | 80% | 80% | 100% | — | — | — | — | — |
| fixed-relay | **89** | — | 83% | 83% | 100% | — | — | — | — | — |
| crossing | **40** | — | 80% | 80% | 0% | — | 0% | BOX, PORT | — | BOX (2) |
| storm | **89** | — | 83% | 83% | 100% | — | — | — | — | — |
| box-failure | **42** | — | 83% | 83% | 0% | — | 0% | PORT, FR | — | PORT (5) |
#### Scenario 3 — Isole Eolie (rete tra isole, aliscafo come data mule) — Resilience Score per variante (ambiente tipico, g3, finestra 0–6 h)
| Variante | Score | Copertura | Diretta | Raggiungibile | Ridondanza | Copertura sotto guasto | Recupero opp. | Nodi critici | Gap recuperabili | Peggior guasto |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| static | **29** | 31% | 60% | 60% | 0% | 26% | 0% | BOX, PORT | — | BOX (2) |
| hydrofoil | **62** | 63% | 80% | 100% | 0% | 47% | 80% | BOX, C4, PORT | C1, C2, C4, C5 | BOX (3) |
| panarea-relay | **57** | 79% | 100% | 100% | 0% | 62% | 0% | BOX, FR, PORT | — | BOX (5) |
| relay-hydrofoil | **75** | 80% | 100% | 100% | 0% | 67% | 100% | BOX, FR, PORT | C1, C2, C3, C4, C5, FR | BOX (5) |
| box-harbour | **64** | 69% | 80% | 100% | 0% | 54% | 80% | BOX, C4, PORT | C1, C2, C4, C5 | BOX (3) |
#### Scenario 4 — Deserto di Atacama (distanze lunghe, fuoristrada come data mule, banda 915-928 MHz) — Resilience Score per variante (ambiente tipico, AU915 30 dBm EIRP, dwell 400 ms, finestra 0–6 h)
| Variante | Score | Copertura | Diretta | Raggiungibile | Ridondanza | Copertura sotto guasto | Recupero opp. | Nodi critici | Gap recuperabili | Peggior guasto |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| static | **11** | 13% | 20% | 20% | 0% | 11% | 0% | BOX | — | BOX (1) |
| vehicle | **35** | 16% | 20% | 60% | 0% | 13% | 100% | PORT | C4 | PORT (1) |
| andes-relay | **47** | 64% | 67% | 67% | 25% | 57% | 0% | FR, BOX | — | FR (2) |
| relay-vehicle | **62** | 65% | 67% | 83% | 50% | 58% | 50% | FR | C3 | FR (2) |
| portable-vehicle | **40** | 22% | 20% | 80% | 0% | 19% | 100% | PORT | C4 | PORT (1) |
#### Scenario 5 — Kampala (città densa su colline, blackout, corriere in boda-boda) — Resilience Score per variante (ambiente tipico, g3, finestra 0–6 h)
| Variante | Score | Copertura | Diretta | Raggiungibile | Ridondanza | Copertura sotto guasto | Recupero opp. | Nodi critici | Gap recuperabili | Peggior guasto |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| static | **2** | 7% | 0% | 0% | 0% | 6% | — | — | — | — |
| boda | **14** | 7% | 0% | 60% | 0% | 6% | — | — | — | — |
| naguru-relay | **11** | 18% | 17% | 17% | 0% | 14% | 0% | BOX | — | BOX (1) |
| relay-boda | **36** | 18% | 17% | 67% | 0% | 14% | 100% | BOX | FR | BOX (1) |
| box-ground | **1** | 2% | 0% | 0% | 0% | 2% | — | — | — | — |
| relay-blackout | **14** | 0% | 0% | 67% | 0% | 0% | — | — | — | — |

## 6. Cosa mostrano

1. **Il punteggio distingue le reti.** Una rete inutilizzabile vale ≈ 0 (Kampala senza relay né corriere: 2; Atacama senza veicolo né relay: 11). Un relay in quota insieme a un portatore mobile porta il valore a 62-75 nelle Eolie e nell'Atacama e a 87-89 negli scenari alpini con un ponte sul colle; a Kampala, dove la portata radio in città resta il limite, a 36.
2. **Il portatore mobile è una componente della resilienza, non un accessorio.** Nelle Eolie l'aliscafo porta `reachability` dal 60% al 100% e `opportunisticRecovery` all'80-100%: il punteggio passa da 29 (nessun aliscafo) a 62; con il relay di Panarea a 75. A Kampala il boda, senza connessione diretta, porta la raggiungibilità da 0 a 60% (punteggio da 2 a 14); con il relay e il boda sale al 67%, a 36.
3. **La ridondanza è il punto debole di quasi tutte le reti.** Nelle Eolie e a Kampala `redundancy` è 0%: se cade l'unica infrastruttura che serve la loro zona, i nodi sono tagliati fuori. Nell'Atacama vale 0-50%; arriva al 100% solo negli scenari alpini con un ponte sul colle (relay o Card), e all'80% nella Valle Maira, dove la catena di Card offre percorsi alternativi. Una seconda infrastruttura con alimentazione indipendente (il Portable) è ciò che salva i nodi: ne è l'esempio il blackout di Kampala.
4. **I gap che un guasto crea non sono tutti uguali.** Un guasto che taglia fuori dei nodi può essere recuperabile se un portatore passa dai dati e raggiunge un'altra infrastruttura (Eolie), oppure definitivo (Portable + aliscafo). La sola connettività diretta non lo distingue.
5. **Un ostacolo può rivelare una dipendenza nascosta.** Dopo l'ostruzione tra Lipari e Panarea la rete resta connessa, ma passa da una sola Card (C1): oggi non critica, domani sì. È informazione che il progettista non avrebbe senza ricalcolare.
6. **Il Box a terra è peggio di un Box sul tetto anche in resilienza** (Kampala `box-ground`: 1 contro 11 della stessa variante sul tetto).

## 7. Limiti noti

- **Il punteggio è una proposta di definizione, non una verità.** Pesi uguali e componenti scelte sono una scelta di progetto, documentata e modificabile; non sono tarate su dati reali.
- **La copertura dipende dall'area di analisi.** La stessa rete ha percentuali diverse se si guarda un riquadro più ampio.
- **Percorsi opportunistici solo per dispositivi con percorsi dichiarati.** Persone o veicoli che si spostano senza saperlo (la "mobilità spontanea" del progetto) non sono modellati: la loro assenza vale "nessuna mobilità", quindi il recupero opportunistico di una rete senza percorsi dichiarati risulta 0%, un valore prudente.
- **Nessun limite di capacità né di tempo nel recupero.** Un percorso opportunistico esiste se i contatti esistono, non se il contenuto fa in tempo: durata del contatto, duty-cycle, coda dei relay e dimensione del file non entrano (lo fa la simulazione temporale di `simulate()`, con i tempi di consegna). Con la coda attuale un messaggio non urgente scade dopo 5 minuti di isolamento: il recupero opportunistico è quindi un limite superiore per tutto ciò che non è un SOS.
- **Il guasto d'area è valutato alla sola ora del guasto.** Un nodo mobile fuori dall'area a quell'ora resta attivo anche se più tardi passa dentro la zona distrutta: il recupero opportunistico può risultare sovrastimato in quel caso. Lo stesso vale per un `route` che non parte dalla posizione fissa del dispositivo: l'analisi usa il percorso, il pannello connessioni la posizione fissa.
- **Tetti sugli input.** La finestra opportunistica ammette al massimo 20000 istanti e un percorso al massimo 10000 punti; oltre, errore esplicito invece di un calcolo che esaurisce la memoria.
- **Link senza stato di carico.** Un relay unico che serve molti nodi non satura nel modello.
- **I guasti sono istantanei e permanenti.** Non ci sono guasti parziali (batteria che si scarica), né guasti che si propagano.
- **Gli smartphone non entrano nel punteggio** (sono clienti della propria Card) ma sono nel grafo e nei report.
- **Le aree-ostacolo sono cerchi o poligoni fermi**, uguali in tutta la finestra.
- **Terreno sintetico e parametri non verificati**, come in tutti gli scenari.

## 8. Cosa serve al tool

- L'interfaccia: nodo spento sulla mappa, selezione di nodi e aree, legenda, colori della rete residua (`residualEdges()` e `edgeQuality()` forniscono archi e qualità per le linee).
- Aree disegnate a mano in coordinate geografiche (il motore le accetta già, con `frame`).
- Per l'Optimizer (`docs/network-design-tool.md` §C): `resilienceScore()` è la valutazione elementare di una configurazione; `rankSingleFailures()` e `criticalDependencies()` alimentano i suggerimenti spiegabili ("questo nodo è critico perché taglia fuori …").
