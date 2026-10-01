# ARALD — Specifica UX/UI

Specifica fornita per intero dall'utente (1 ottobre 2026), come direzione per il "nuovo giro di rifinimento UX" annotato in `docs/next-steps.md`. **Source of truth per questo lavoro** — ogni mockup/implementazione futura si misura contro questo documento, non il contrario. Conservata qui testualmente (non riassunta) per non perdere dettaglio nel tempo, con la stessa disciplina già usata per `docs/power-management.md`/`docs/beacon.md`.

**Nota sul rapporto con l'identità "Waypoint" esistente** (`mobile/www/styles.css`, `docs/security.md` voci #31/#50/#77/#88): questa specifica propone famiglie tipografiche (Inter/SF Pro/Geist) e una mappatura cromatica semantica (verde/ambra/rosso/blu) diverse da quelle attualmente implementate (Fraunces/Overpass auto-ospitati, ambra come accento primario non legato a "degradato", nessun blu informativo nella palette). La riconciliazione tra le due — sostituzione completa, o applicazione dei principi strutturali di questa specifica sopra ai token Waypoint esistenti — è una decisione aperta, da chiarire con l'utente prima dell'implementazione (vedi `docs/next-steps.md`).

---

## 1. Obiettivo

Rifinire l'attuale UX/UI di ARALD rendendola:

* più moderna;
* più visivamente piacevole;
* più immediata;
* più leggibile outdoor e in condizioni di stress;
* più coerente tra Mobile, Mirror Portal e Web UI del nodo;
* meno simile a una dashboard SaaS;
* più simile a uno **strumento operativo affidabile**.

L'interfaccia non deve richiedere all'utente di "capire ARALD": deve essere ARALD a comunicare immediatamente **cosa sta succedendo, cosa è disponibile e cosa deve fare l'utente**.

---

## 2. Principio UX principale

> **Non devo capire ARALD. ARALD mi fa capire cosa sta succedendo.**

Ridurre quindi la quantità di testo esplicativo necessario.

Preferire:

**icona → stato → informazione breve → eventuale dettaglio**

rispetto a:

**titolo testuale → descrizione → spiegazione → azione**.

Il testo rimane fondamentale per informazioni critiche, ma non deve essere l'unico linguaggio dell'interfaccia.

---

## 3. Icone come linguaggio visivo

Integrare un sistema coerente di icone in tutta l'interfaccia.

Le icone devono essere utilizzate per:

* rappresentare stati;
* identificare funzioni;
* facilitare la scansione visiva;
* accompagnare informazioni tecniche;
* distinguere rapidamente categorie diverse;
* ridurre la dipendenza dal testo.

### Esempi

| Concetto        | Icona suggerita        |
| --------------- | ---------------------- |
| SOS / emergenza | simbolo SOS / sirena   |
| Nodo ARALD      | radio / antenna / node |
| Connessione     | link / signal          |
| Offline         | cloud-off / wifi-off   |
| Messaggio       | message / send         |
| Ricezione       | inbox / radio          |
| Posizione       | map-pin                |
| Percorso        | route / navigation     |
| Batteria        | battery                |
| LoRa / radio    | radio                  |
| Sicurezza       | shield                 |
| Utente          | person                 |
| Configurazione  | settings               |
| Informazioni    | info                   |
| Successo        | check                  |
| Attenzione      | triangle-alert         |
| Errore          | circle-x               |
| Tempo           | clock                  |
| Distanza        | ruler / route          |
| Visibilità nodo | eye                    |
| Relay           | repeat / network        |

Preferire un **icon set unico** e coerente, ad esempio stile:

* outline;
* geometrico;
* leggermente rounded;
* stroke uniforme;
* molto leggibile anche a piccole dimensioni.

Evitare di mischiare stili differenti.

Le icone non devono diventare decorative: devono avere una funzione informativa.

---

## 4. Legenda

Integrare una **legenda compatta e contestuale**.

La legenda deve spiegare rapidamente il significato delle principali icone e degli stati utilizzati da ARALD.

Non deve essere sempre invasiva.

Possibili modalità:

### Mobile

Piccola voce `ⓘ Legenda` accessibile dalla schermata principale o dal menu informazioni.

Apertura di un pannello/bottom sheet contenente:

* icona;
* significato;
* eventuale colore;
* breve spiegazione.

### Mirror Portal

La legenda può essere più visibile, soprattutto perché il portale ha una funzione di monitoraggio.

Esempio:

`● Nodo online   ◐ Collegamento debole   ○ Offline   ! Emergenza`

### Web UI nodo

La legenda può essere integrata vicino alla rappresentazione dello stato della rete.

La legenda deve essere **semplice**, non una documentazione tecnica.

---

## 5. Stati come elemento centrale dell'interfaccia

Progettare l'interfaccia principalmente intorno agli **stati del sistema**, non intorno alle pagine.

Stati principali:

### NORMAL

Sistema operativo.

Visualizzare:

* connessione;
* nodo disponibile;
* batteria;
* eventuali messaggi;
* posizione/percorso quando rilevante.

### DEGRADED

La rete funziona ma presenta limitazioni.

Esempi:

* segnale debole;
* pochi nodi disponibili;
* collegamento intermittente.

L'utente deve capire immediatamente:

> "Funziona, ma non completamente."

### OFFLINE

Nessuna connessione disponibile.

Non mostrare semplicemente "Offline".

Spiegare visivamente:

**Offline → ricerca nodi → nessun nodo disponibile**

quando possibile.

### EMERGENCY

SOS attivo.

Questa deve essere una modalità visivamente distinta e persistente.

### RESOLVED

Emergenza terminata / messaggio chiuso.

---

## 6. Gerarchia visiva

Ogni schermata deve avere una gerarchia estremamente chiara.

Priorità:

1. **Stato attuale**
2. **Azione primaria**
3. **Informazioni operative**
4. **Azioni secondarie**
5. **Informazioni tecniche**

Non rendere tutti gli elementi visivamente equivalenti.

Evitare l'effetto:

> "20 card tutte ugualmente importanti."

ARALD deve comunicare una gerarchia.

---

## 7. Mobile — priorità assoluta

Il Mobile è il punto in cui l'utente può trovarsi in una situazione di stress.

La schermata principale deve essere immediatamente comprensibile.

### SOS

Il pulsante SOS deve essere:

* molto evidente;
* facilmente raggiungibile con una mano;
* sempre riconoscibile;
* chiaramente distinto dalle altre azioni;
* associato a un'icona forte;
* accompagnato da testo breve.

Il rosso deve essere riservato principalmente a:

**emergenza / azione critica / stato critico.**

Non utilizzare il rosso come colore decorativo generale.

---

## 8. Stato SOS

Dopo l'attivazione SOS non lasciare l'utente sulla normale home.

Passare a una **Emergency State Screen** dedicata.

Visualizzare immediatamente:

* SOS attivo;
* stato della trasmissione;
* ora di attivazione;
* nodo utilizzato;
* eventuale posizione;
* eventuale numero di relay/hop;
* possibilità di annullare/concludere l'emergenza.

Utilizzare una combinazione di:

**icona + colore + testo + stato**

per rendere immediatamente comprensibile la situazione.

Esempio concettuale:

`[SOS] EMERGENZA ATTIVA`

`✓ Messaggio ricevuto dal nodo`

`↗ Trasmissione in corso`

`◎ Posizione disponibile`

Non affidarsi esclusivamente al testo.

---

## 9. Mirror Portal

Il Mirror Portal deve essere progettato principalmente come strumento di **situational awareness**.

La mappa deve assumere maggiore importanza rispetto alle card.

Priorità:

1. mappa;
2. emergenze;
3. stato dei nodi;
4. messaggi;
5. dettagli.

Utilizzare simboli visivi sulla mappa per:

* nodi;
* relay;
* utenti/emergenze;
* collegamenti;
* stato della rete.

Gli elementi devono poter essere riconosciuti anche senza leggere il testo.

---

## 10. Mappa

La mappa deve comunicare la rete in modo visivo.

Esempio concettuale:

* nodo online → simbolo nodo + stato positivo;
* nodo degradato → simbolo nodo + stato warning;
* nodo offline → simbolo nodo attenuato;
* emergenza → simbolo SOS chiaramente distinguibile;
* collegamento → linea tra nodi;
* percorso → linea dedicata.

Non sovraccaricare la mappa.

La rappresentazione deve privilegiare:

**cosa sta succedendo adesso**

rispetto alla quantità di informazioni visualizzabili.

---

## 11. Web UI del nodo

Separare chiaramente:

### Operational

Ciò che sta succedendo ora:

* stato;
* rete;
* messaggi;
* relay;
* connessioni;
* emergenze.

### Configuration

Configurazione tecnica:

* ID nodo;
* rete;
* radio;
* impostazioni;
* diagnostica;
* aggiornamenti;
* log.

Non mischiare continuamente configurazione e operatività.

La Web UI deve sembrare uno **strumento di gestione di un dispositivo**, non una dashboard aziendale.

---

## 12. Sistema cromatico

Utilizzare il colore principalmente come linguaggio semantico.

### Base

* fondo chiaro / warm white;
* bianco;
* near-black;
* grigi neutri.

### Semantica

* verde → operativo / OK;
* ambra → attenzione / degradato;
* rosso → emergenza / errore critico;
* blu → informazione / comunicazione.

Il colore principale del brand ARALD non deve competere con il rosso dell'SOS.

Non usare troppi colori contemporaneamente.

---

## 13. Icone + colore + testo

Per gli stati importanti non utilizzare mai il solo colore.

Esempio da evitare:

`● verde`

Meglio:

`[✓] Nodo online`

Oppure:

`[antenna] ONLINE`

con colore verde come ulteriore livello informativo.

Questo migliora:

* accessibilità;
* leggibilità;
* comprensione immediata;
* utilizzo in condizioni di scarsa visibilità.

---

## 14. Tipografia

Utilizzare una tipografia moderna e altamente leggibile.

Possibili famiglie:

* Inter;
* SF Pro;
* Geist.

Gerarchia indicativa:

* Display: 32–40 px;
* H1: 24–28 px;
* H2: 18–20 px;
* body: 15–17 px;
* label: 12–13 px.

Evitare testo operativo troppo piccolo.

Il testo secondario può essere più discreto, ma deve rimanere leggibile.

---

## 15. Card

Ridurre l'utilizzo delle card quando non aggiungono reale valore.

Non trasformare ogni informazione in una card separata.

Preferire:

* sezioni;
* righe informative;
* gruppi;
* pannelli;
* indicatori;
* elementi inline.

Le card devono essere utilizzate quando servono realmente a raggruppare informazioni.

Obiettivo:

**meno "dashboard", più "strumento".**

---

## 16. Micro-interazioni

Utilizzare micro-interazioni molto leggere per rendere percepibile lo stato del sistema.

Esempi:

* nodo appena connesso → breve animazione;
* messaggio trasmesso → feedback visivo;
* SOS inviato → transizione evidente;
* relay trovato → aggiornamento della rete;
* connessione persa → stato che cambia progressivamente.

Evitare animazioni decorative.

Ogni animazione deve comunicare:

> qualcosa è cambiato.

---

## 17. Visual language

ARALD deve avere un linguaggio visivo riconoscibile.

Direzione:

**minimal + operational + outdoor + reliable**

Evitare:

* estetica cyberpunk;
* sci-fi;
* eccesso di neon;
* dashboard enterprise;
* troppe card;
* eccesso di gradient;
* interfacce troppo "tech";
* decorazioni prive di funzione.

L'interfaccia può comunque essere **visually appealing**.

La piacevolezza deve derivare da:

* proporzioni;
* spazio;
* tipografia;
* icone;
* gerarchia;
* animazioni discrete;
* mappe;
* composizione;
* consistenza.

Non dalla quantità di elementi grafici.

---

## 18. Sistema di componenti

Creare un piccolo design system ARALD coerente.

Definire almeno:

* Button;
* SOS Button;
* Status Indicator;
* Status Badge;
* Node Indicator;
* Network Indicator;
* Icon Button;
* Navigation;
* Map Marker;
* Message Row;
* Alert;
* Bottom Sheet;
* Legend;
* Section;
* Data Row.

Ogni componente deve avere stati coerenti:

* default;
* hover;
* active;
* disabled;
* loading;
* success;
* warning;
* critical.

---

## 19. Coerenza tra piattaforme

Mobile, Mirror Portal e Web UI non devono essere copie identiche.

Devono però condividere:

* colori;
* icone;
* terminologia;
* stati;
* simboli;
* linguaggio visivo;
* gerarchia;
* pattern di interazione.

L'utente deve percepire immediatamente che appartengono allo stesso sistema.

---

## 20. Regola finale

Ogni elemento dell'interfaccia deve rispondere ad almeno una di queste domande:

**Cosa sta succedendo?**

**Cosa posso fare?**

**Cosa devo sapere?**

**Cosa devo fare adesso?**

Se un elemento non contribuisce a nessuna delle quattro, valutarne la rimozione.

### Obiettivo finale

ARALD deve risultare:

**semplice da capire, rapido da usare, visivamente moderno, riconoscibile e affidabile.**

Non deve sembrare un prodotto "semplificato".

Deve sembrare un prodotto **intenzionalmente semplice**.
