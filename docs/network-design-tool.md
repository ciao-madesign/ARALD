# Obiettivo finale della simulazione: tool interattivo di progettazione di reti ARALD

**Stato**: specifica di destinazione dichiarata dall'utente il 5 ottobre 2026, durante lo sviluppo della simulazione teorica (`docs/scenario-simulation.md`, `tools/scenario-model/`). Non ancora pianificato né implementato. Serve da **vincolo di progetto** per il lavoro sulla simulazione: ogni scenario e ogni estensione del motore va fatta in modo che resti riusabile dal tool.

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
- caratteristiche dei dispositivi;
- conformazione del territorio;
- ostacoli;
- interferenze;
- eventuali altri fattori già introdotti nella simulazione statistica.

### 7. Informazioni sulla rete

Il tool mostra le informazioni essenziali sulla rete generata:

- una **piccola legenda** sulla mappa: simboli dei dispositivi, colori dei tre livelli di copertura, spettro cromatico delle connessioni, eventuali altre convenzioni grafiche;
- un **pannello informativo** con le connessioni create, ad esempio:

| Connessione | Tecnologia | Velocità stimata | Qualità |
|---|---|---:|---|
| Box → Card | LoRa | XX kbps | Buona |
| Card → Smartphone | BLE | XX Mbps | Ottima |
| Box → Portable | Wi-Fi | XX Mbps | Ottima |

I valori derivano dal modello, mai hardcoded.

### 8. Progettazione della rete

Il tool non è una semplice visualizzazione della simulazione: deve permettere di **progettare e valutare una rete ARALD reale**. L'utente sperimenta liberamente posizione, numero e combinazioni di dispositivi, distanze, topologie, ambienti naturali e urbani, presenza di ostacoli; coperture e connessioni si aggiornano dinamicamente a ogni modifica.

### 9. Salvataggio e condivisione

L'MVP prevede:

- screenshot/esportazione della mappa;
- salvataggio di una configurazione;
- riapertura successiva di una configurazione salvata, con ripristino di dispositivi, posizioni e connessioni.

La configurazione va salvata in forma strutturata, riutilizzabile dal software.

### 10. Requisito architetturale

Durante lo sviluppo della simulazione, evitare un modello legato alla visualizzazione finale. Separare:

- **MODELLO** → caratteristiche dei dispositivi, propagazione, territorio, ostacoli, interferenze, probabilità di connessione, tecnologia utilizzabile, velocità stimata, qualità della connessione;
- **INTERFACCIA** → mappa, dispositivi, aloni di copertura, linee di connessione, colori, legenda, pannelli informativi.

Il modello deve poter essere interrogato così:

> "Dato il dispositivo A nella posizione X e il dispositivo B nella posizione Y, considerando questo territorio, quale connessione è possibile e quali sono le sue prestazioni stimate?"

Il risultato deve essere sufficientemente deterministico e strutturato da poter essere rappresentato graficamente.

### 11. Priorità MVP

Base solida prima di tutto:

**Mappa reale → dispositivi → coperture LoRa/BLE/Wi-Fi → territorio/ostacoli → rilevamento connessioni → velocità stimata → visualizzazione cromatica.**

Simulazioni temporali, ottimizzazione automatica della rete, scenari complessi, analisi avanzate, routing evoluto e altri strumenti di progettazione vengono dopo.

### 12. Requisito per il lavoro attuale

La simulazione va sviluppata tenendo presente questo uso. Al termine del lavoro deve essere chiaro:

1. quali sono tutti i parametri del modello;
2. quali sono gli input necessari;
3. quali sono gli output prodotti;
4. quali formule/regole determinano gli output;
5. quali parametri sono specifici dei dispositivi;
6. quali parametri dipendono dal territorio;
7. come viene determinata la possibilità di connessione;
8. come viene determinata la tecnologia utilizzata;
9. come viene stimata la velocità;
10. come viene trasformato il risultato matematico in una rappresentazione geografica.

**Non progettare la simulazione come un esperimento isolato**, ma come il **motore di calcolo di un futuro ARALD Network Design Tool**, con modello, dati e visualizzazione separati. La domanda a cui il tool deve rispondere visivamente, su una porzione reale di territorio:

> **"Se posiziono questi dispositivi ARALD in questi punti, che rete ottengo e con quali prestazioni?"**

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

| Interrogazione "A in X, B in Y, su questo territorio → connessione e prestazioni" (§10) | `bestLink()`/`loraLink()` sono già funzioni pure (dispositivo, posizione, parametri → tecnologia, SF, RSSI, margine) separate da `simulate()` e dalla CLI | Un tipo di risultato unico e documentato (tecnologia, velocità stimata, qualità normalizzata 0-1) e un "territorio" passato come input esplicito invece che dentro `Environment` |
| Configurazione salvabile (§9) | — | Uno schema JSON di configurazione (dispositivi, posizioni, territorio, parametri) |

Regole di lavoro che ne seguono per i prossimi scenari:

- **ogni nuova regola fisica va nel motore come funzione parametrica riusabile** (come `obstructionFn`, `extraLossDb`, `routingMetric`), mai dentro un singolo file di scenario;
- `model.ts` non deve mai dipendere da CLI, Markdown o qualunque forma di visualizzazione;
- la risposta ai 10 punti del §12 va mantenuta aggiornata in `docs/scenario-simulation.md` man mano che il modello cresce, e consegnata completa a fine validazione.
