# Obiettivo finale della simulazione: tool interattivo di progettazione di reti ARALD

**Stato**: obiettivo dichiarato dall'utente il 5 ottobre 2026, durante lo sviluppo della simulazione teorica (`docs/scenario-simulation.md`, `tools/scenario-model/`). Non ancora pianificato né implementato. Serve da **vincolo di progetto** per il lavoro sulla simulazione: ogni scenario e ogni estensione del motore va fatta in modo che resti riusabile dal tool.

**Nota**: il testo originale si interrompe a metà del punto 6 ("…tecnologia utilizzata; distanza; caratteristiche"). Il resto del punto 6 ed eventuali punti successivi vanno completati dall'utente.

## Obiettivo

Al termine della progettazione e validazione della simulazione statistica, il lavoro dovrà essere strutturato in modo da poter trasformare il modello sviluppato in un **tool interattivo per la progettazione di reti ARALD su territorio reale**.

La simulazione statistica rappresenta quindi il **motore matematico/fisico** del tool: le sue regole, distribuzioni, formule e parametri dovranno essere sufficientemente modulari e interpretabili da poter essere successivamente applicati a una mappa reale e a dispositivi posizionati dall'utente.

### 1. Mappa reale

Il tool finale dovrà usare una mappa geografica reale, sulla quale dovranno essere considerati almeno:

- altitudine;
- conformazione del terreno;
- rilievi e depressioni;
- ostacoli naturali rilevanti;
- presenza di aree urbane dense;
- aree naturali / aperte;
- eventuali altri elementi territoriali che possano influenzare la propagazione del segnale.

La copertura non dovrà essere rappresentata come un semplice cerchio geometrico: il modello dovrà modificarla in funzione del territorio e degli ostacoli/interferenze presenti.

### 2. Dispositivi

Un menu a tendina permette di selezionare quattro categorie di dispositivi ARALD:

1. Box
2. Portable
3. Card
4. Smartphone

Ogni dispositivo possiede caratteristiche intrinseche già definite dalla simulazione, tra cui, a seconda del dispositivo: tecnologie radio disponibili, potenza/parametri di trasmissione, portata teorica, comportamento della connessione, velocità di trasmissione, eventuali limitazioni specifiche. **Nella prima versione questi parametri non vengono reinseriti manualmente dall'utente.**

### 3. Posizionamento

L'utente deve poter:

1. selezionare un tipo di dispositivo;
2. cliccare sulla mappa;
3. collocare il dispositivo nel punto selezionato;
4. visualizzare immediatamente la relativa area di copertura.

Numero di dispositivi arbitrario; ogni dispositivo identificabile sulla mappa.

### 4. Visualizzazione della copertura

La copertura di ogni dispositivo è un **alone colorato**, non un cerchio, composto da tre livelli distinti: **LoRa**, **BLE**, **Wi-Fi**. Ogni livello rappresenta l'area nella quale quella tecnologia può potenzialmente stabilire una connessione, calcolata con il modello della simulazione e adattata alla conformazione reale del territorio (un dispositivo dietro un rilievo non produce una copertura circolare uniforme: il terreno può schermare, ridurre o interrompere la propagazione).

### 5. Rilevamento delle connessioni

Quando le aree di copertura di due dispositivi si intersecano, il sistema verifica se tra i due è possibile una connessione e con quale tecnologia. Se la connessione è possibile, viene disegnata una linea tra i due dispositivi. Tecnologia e qualità sono determinate dal modello: **intersezione ≠ stessa qualità di connessione** (un link LoRa può avere velocità molto diverse da un link BLE o Wi-Fi).

### 6. Qualità della connessione

Il colore della linea rappresenta la velocità/qualità stimata, su uno spettro continuo:

- verde brillante → connessione molto buona/veloce
- giallo → connessione intermedia
- rosso → connessione debole/lenta

Alla linea è associato il valore numerico stimato. La velocità è calcolata dal modello considerando almeno:

- tecnologia utilizzata;
- distanza;
- caratteristiche … *(testo interrotto — da completare)*

## Cosa implica già oggi per il motore (`tools/scenario-model/`)

Annotazioni tecniche, non decisioni: servono a non allontanare il motore dall'obiettivo mentre si lavora sui prossimi scenari.

| Requisito del tool | Cosa c'è già nel motore | Cosa manca |
|---|---|---|
| Parametri per tipo di dispositivo, non inseriti dall'utente (§2) | `KIND_DEFAULTS` in `model.ts`: tecnologie, potenza, antenna, perdita da corpo per `box`/`portable`/`card`/`phone` (+ `relay`) | Parametri BLE/Wi-Fi oggi uguali per tutti i dispositivi (portata e velocità fisse in `DEFAULT_SHORT_RANGE`) |
| Copertura che dipende dal territorio (§1, §4) | Link budget con perdita di terreno pluggable: per coppia (`obstructionDb`) o per posizione (`obstructionFn`, Scenario 2 a zone) | Un vero modello di terreno da DEM (profilo tra i due punti, diffrazione) e una classificazione d'uso del suolo (urbano denso / bosco / aperto) al posto delle zone scritte a mano |
| Alone per tecnologia (§4) | Il link budget sa dire se un punto è raggiungibile con LoRa (e con quale SF), BLE o Wi-Fi | Oggi si valuta solo tra due dispositivi: serve una valutazione su una griglia di punti verso un "ricevitore di riferimento" per ogni tecnologia |
| Connessione e tecnologia tra due dispositivi (§5) | `bestLink()` restituisce tecnologia, SF, RSSI e margine | — |
| Qualità/velocità numerica della linea (§6) | Time-on-air e throughput per SF (`loraRawAppBps`, `loraDutyLimitedAppBps`), velocità BLE/Wi-Fi nominali | Una funzione unica "qualità del link → valore numerico e colore", e una velocità BLE/Wi-Fi che dipenda dalla distanza |
| Mappa e dispositivi posizionati dall'utente (§3) | Coordinate locali in metri | Conversione da latitudine/longitudine a coordinate locali, e un'interfaccia web (fuori dal motore) |

Regola di lavoro che ne segue per i prossimi scenari: **ogni nuova regola fisica va nel motore come funzione parametrica riusabile** (come `obstructionFn`, `extraLossDb`, `routingMetric`), mai dentro un singolo file di scenario.
