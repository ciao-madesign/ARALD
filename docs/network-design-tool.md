# Obiettivo finale della simulazione: tool interattivo di progettazione di reti ARALD

**Stato**: specifica di destinazione dichiarata dall'utente il 5 ottobre 2026, durante lo sviluppo della simulazione teorica (`docs/scenario-simulation.md`, `tools/scenario-model/`). Non ancora pianificato né implementato. Serve da **vincolo di progetto** per il lavoro sulla simulazione (scope ampliato lo stesso giorno a resilienza e ottimizzazione, vedi "Precisazione sullo scope" sotto): ogni scenario e ogni estensione del motore va fatta in modo che resti riusabile dal tool.

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

## Precisazione sullo scope: resilienza e ottimizzazione (5 ottobre 2026)

Precisazione dell'utente, che amplia lo scope del tool oltre la progettazione. Due funzioni **core**, non secondarie: la **verifica della resilienza** e l'**ottimizzazione** della rete.

### A. Test Network Resilience (Failure Simulation)

Permette di passare dalla semplice progettazione alla **verifica della resilienza** della rete.

**Cosa deve fare**: l'utente seleziona un nodo e lo mette in stato **OFFLINE / FAILED**. Il nodo resta sulla mappa ma appare chiaramente spento/non operativo, e il modello ricalcola immediatamente:

- connessioni radio;
- copertura residua;
- percorsi opportunistici;
- nodi isolati;
- eventuali alternative;
- aree rimaste scoperte;
- dipendenze critiche.

Esempio: Box A collegato via LoRa a tre Card. Spento il Box, il tool evidenzia "Nodi: 4 → 3 attivi, Connessioni: 3 → 0, Nodi isolati: 2, Copertura: 87% → 31%, Dipendenza critica: BOX A". Il progettista capisce subito che **quel Box è un single point of failure**.

**Deve distinguere connettività diretta e opportunistica**: spento un nodo, il sistema può scoprire che la **connettività diretta è persa** ma che **esiste un percorso opportunistico** (es. un sentiero percorso da chi porta una Card tra due aree), quindi la rete non è del tutto isolata. Questa distinzione è centrale per valutare la resilienza reale di ARALD.

**Tre modalità di test**:

1. **Single Node Failure** — spengo un singolo dispositivo: "cosa succede se questo nodo smette di funzionare?".
2. **Multiple Failure** — spengo più dispositivi insieme: "cosa succede se una parte dell'infrastruttura viene compromessa?" (utile soprattutto negli scenari di emergenza).
3. **Area Failure** — l'utente seleziona un'area e simula perdita di nodi, interruzione di percorsi, impossibilità di attraversamento, perdita simultanea di infrastrutture (es. "simula un terremoto"). Nell'MVP basta poter selezionare manualmente nodi e ostacoli da disattivare, senza scenari predefiniti.

**Resilience Score**: un punteggio numerico (es. "86 / 100") con le sue componenti, ad esempio:

- copertura;
- connettività diretta;
- percorsi ridondanti;
- nodi critici;
- gap recuperabili;
- aree isolate dopo un guasto.

**Il valore va definito sulla base del modello, mai inventato nell'interfaccia.**

### B. Le quattro dimensioni del tool

1. **Territorio** — dove posso mettere i nodi?
2. **Connettività** — come possono comunicare?
3. **Mobilità** — posso colmare un gap trasportando fisicamente un relay?
4. **Resilienza** — cosa succede se qualcosa smette di funzionare?

Definizione completa del progetto:

> **ARALD Network Designer è uno strumento per progettare, analizzare, ottimizzare e sottoporre a stress test reti di comunicazione resilienti su territorio reale, considerando infrastruttura esistente, nuovi nodi, propagazione radio, caratteristiche del territorio, percorsi fisici e mobilità opportunistica dei relay.**

### C. Network Optimizer

Il tool può passare da simulatore a **ottimizzatore**: l'utente indica **quali nodi vuole installare** e **quali obiettivi vuole ottenere**, e il motore prova diverse posizioni sul territorio e propone le configurazioni con il miglior rapporto tra copertura, connettività, resilienza e mobilità.

**Flusso**:

1. **L'utente sceglie i nodi** (es. 2 Box, 4 Portable, 8 Card, 10 smartphone) e indica eventualmente:
   - aree dove i nodi **devono** essere presenti;
   - aree dove **non possono** essere installati;
   - nodi già esistenti da sfruttare.
2. **Il motore genera posizioni candidate**, non punti casuali, considerando:
   - morfologia, quota, ostacoli, edifici;
   - strade, sentieri, aree accessibili;
   - copertura radio e nodi esistenti;
   - possibilità di collegamento opportunistico;
   - costi e difficoltà di raggiungimento.

   Ad esempio: "questi 17 punti sono buoni candidati per un Box".
3. **Simula le configurazioni** calcolando:
   - area coperta;
   - connessioni dirette e opportunistiche;
   - aree isolate;
   - single point of failure;
   - percorsi alternativi;
   - gap critici;
   - Resilience Score.
4. **Classifica le soluzioni**, non necessariamente una sola. Ad esempio:
   - "A — massima resilienza";
   - "B — minimo numero di nodi";
   - "C — minimo costo";

   ciascuna con punteggio, composizione, copertura e gap.

**Non deve ottimizzare solo la copertura**: un algoritmo che cerca la massima copertura può produrre una rete fragile. Serve una **funzione obiettivo multi-parametrica**, concettualmente:

```text
Score = copertura + connettività + ridondanza + resilienza + accessibilità + mobilità opportunistica
        − nodi inutilmente concentrati − single point of failure − aree irraggiungibili − costo/difficoltà di installazione
```

con **priorità regolabili dall'utente** (resilienza, copertura, costo, accessibilità, mobilità) e ricalcolo delle posizioni migliori.

**Suggerimenti incrementali**: su una rete già esistente il motore propone il prossimo passo. Ad esempio: "installa un Portable nell'area evidenziata", con l'impatto stimato:

- +14% copertura;
- +3 connessioni;
- elimina un gap radio;
- crea un percorso alternativo per Box A e ne riduce la dipendenza;
- priorità: alta.

**Planner senza AI**: input (territorio + nodi esistenti + nodi disponibili + vincoli + obiettivi) → motore di ottimizzazione (genera candidati → simula → valuta → confronta → scarta le configurazioni inefficienti → ripete) → output (configurazione ottimale: tipo di nodo → punto), con la possibilità di **accettare/rifiutare ogni suggerimento** e vedere subito come cambia la rete.

**Ogni suggerimento deve essere spiegabile**: non "metti un Box qui", ma *perché*. Ad esempio: "questo punto collega 4 nodi esistenti, copre una zona oggi scoperta e crea una seconda via verso il rifugio B; in caso di guasto del Portable 02 la rete resta connessa". Coerente con l'obiettivo di ARALD: **non un generatore automatico di posizioni, ma uno strumento che aiuta un operatore a progettare una rete resiliente sul territorio**.

### Cosa implica per il motore (annotazione tecnica, non una decisione)

| Funzione | Cosa c'è già | Cosa manca |
|---|---|---|
| Nodo OFFLINE, ricalcolo di connessioni, copertura, isolati, alternative, dipendenze critiche (§A) | **Fatto**: `tools/scenario-model/resilience.ts` (`evaluateFailure`, `criticalDependencies`, `rankSingleFailures`), ~1 ms per guasto dopo una preparazione di ~1 s; dettagli e risultati in `docs/network-resilience.md` | L'interfaccia (nodo spento sulla mappa, selezione di nodi e aree) |
| Failure Modes: guasto singolo, multiplo, d'area e ostacoli (§A) | **Fatto** (cerchi e poligoni in lat/lon o metri; spegnimento dei nodi e perdita sui link attraversati) | Disegno delle aree sulla mappa |
| Resilience Score (§A) | **Fatto**: media pesata di componenti definite dal modello, pesi regolabili (`ResilienceWeights`) | Taratura su dati reali; pesi scelti dall'utente nell'Optimizer |
| Diretto vs opportunistico (§A) | **Fatto** per i nodi con percorsi dichiarati (`route`); un percorso opportunistico richiede contatti in ordine temporale | Mobilità spontanea (persone che si spostano senza saperlo); capacità e tempo dei contatti |
| Optimizer | `assessLink()`/`coverageGrid()` sono le valutazioni elementari riusabili | Generazione di posizioni candidate dal territorio, funzione obiettivo multi-parametrica, ricerca, spiegazione dei suggerimenti |

## Cosa implica già oggi per il motore (`tools/scenario-model/`)

Annotazioni tecniche, non decisioni: servono a non allontanare il motore dall'obiettivo mentre si lavora sui prossimi scenari.

Aggiornato al termine dello Scenario 5 (`docs/scenario-simulation.md` §17 risponde punto per punto al §12).

| Requisito del tool | Cosa c'è nel motore | Cosa manca |
|---|---|---|
| Parametri per tipo di dispositivo, non inseriti dall'utente (§2) | `KIND_DEFAULTS` in `model.ts`: tecnologie, potenza LoRa, antenna, perdita da corpo, potenza BLE, EIRP Wi-Fi, altezza tipica dal suolo per `box`/`portable`/`card`/`phone` (+ `relay`) | Valori da verificare su hardware reale |
| Copertura che dipende dal territorio (§1, §4) | Interfaccia `Terrain` (`terrain.ts`: quota e uso del suolo per punto), diffrazione sul profilo con curvatura terrestre, clutter per classe di suolo | Un caricatore di DEM e di uso del suolo reali che implementi `Terrain` (oggi solo terreni sintetici); diffrazione su più ostacoli |
| Alone per tecnologia (§4) | `coverageGrid()` in `assess.ts`: celle coperte per LoRa/BLE/Wi-Fi verso un ricevitore di riferimento | Velocità di calcolo adatta all'interazione (griglia adattiva o per raggi) |
| Connessione e tecnologia tra due dispositivi (§5) | `assessLink()`: le tre tecnologie valutate, la migliore scelta per velocità | — |
| Qualità/velocità numerica della linea (§6) | `rateBps`, `sustainedBps` (LoRa con duty-cycle), `quality` 0-1 su scala logaritmica, `qualityLabel()`; BLE/Wi-Fi a link budget, velocità dipendente da distanza e territorio | Validazione delle soglie dei colori sul campo |
| Pannello connessioni (§7) | `assessNetwork()` e `--config <file>` (tabella o `--json`) | — |
| Altezza di installazione (tetto, palo, terra) | `heightAglM` per dispositivo; clutter ridotto per antenne alte sul suolo (`Terrain.clutterHeightRelief`); in Scenario 5 un Box sul tetto copre 4 volte l'area di uno a terra | Altezza degli edifici da dati reali (oggi l'utente la indica) |
| Condizioni di propagazione per territorio | `Terrain.propagation`: ogni dataset porta le proprie condizioni (tabella generica per terreni aperti, tabella urbana calibrata su Okumura-Hata per l'abitato, Scenario 5); l'abitato denso non è calibrato | Esponente ricavato dall'uso del suolo lungo il percorso; calibrazione su misure |
| Regole radio della regione (potenza, duty-cycle, dwell time, frequenza) | `RegulatoryProfile` con ERP, duty-cycle, frequenza centrale e dwell time; profili `EU868_G1`, `EU868_G3`, `AU915`; `"regulatory"` nella configurazione salvata (Scenario 4) | Profili verificati sulla normativa delle regioni di interesse e altri piani (US915, AS923, IN865, …) |
| Mappa e dispositivi posizionati dall'utente (§3) | `toLocal()`/`toGeo()` tra latitudine/longitudine e metri | L'interfaccia web (fuori dal motore) |
| Interrogazione "A in X, B in Y, su questo territorio → connessione e prestazioni" (§10) | `assessLink()` deterministica e senza stato, separata da simulazione e CLI | — |
| Configurazione salvabile (§9) | `NetworkConfig` versionata, `parseNetworkConfig()` con validazione, esempio `tools/scenario-model/examples/eolie.json` | Screenshot/export della mappa (lato interfaccia) |

Regole di lavoro che ne seguono per i prossimi scenari:

- **ogni nuova regola fisica va nel motore come funzione parametrica riusabile** (come `obstructionFn`, `extraLossDb`, `routingMetric`), mai dentro un singolo file di scenario;
- `model.ts` non deve mai dipendere da CLI, Markdown o qualunque forma di visualizzazione;
- la risposta ai 10 punti del §12 va mantenuta aggiornata in `docs/scenario-simulation.md` man mano che il modello cresce, e consegnata completa a fine validazione.


## Pagina del tool — prima versione (7 ottobre 2026)

Esiste una prima pagina interattiva in `tools/network-design/` (vedi il suo README): mappa disegnata dal terreno sintetico, dispositivi trascinabili/aggiungibili/rimovibili, alone LoRa/BLE/Wi-Fi del dispositivo selezionato, collegamenti colorati per qualità con pannello e legenda, scheda Resilienza (punteggio, guasto di un nodo o di un'area, guasti singoli ordinati), configurazione copiabile come JSON, tema chiaro/scuro, uso da telefono. Interna: non linkata da sito, portali o app (decisione sul dove pubblicarla in `docs/next-steps.md`). Mancano ancora: mappa reale e rilievi, Network Optimizer, confronto fianco a fianco di due configurazioni, percorsi dei mobili animati nel tempo.
