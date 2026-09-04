# ARALD Emergency & Rescue Network — roadmap di validazione, effetto di rete e possibili partner di campo

**Stato**: documentazione di riferimento/pianificazione, v0.1 — **nessun codice scritto, nessun hardware costruito**. Proposta ricevuta dall'utente il 3 settembre 2026, valutata insieme all'utente prima di essere integrata qui.

Tenuta in un documento **separato** da `docs/beacon.md`, su richiesta esplicita dell'utente: `docs/beacon.md` descrive i dispositivi (la ARALD Card — un unico hardware in tre profili firmware Beacon/Relay/Beacon+Relay Mode —, Fixed Relay, Relay Registry) e la loro compatibilità con l'architettura ARALD esistente; questo documento descrive invece come si arriverebbe, per gradi, a validare quei dispositivi **insieme come rete** — fino a un eventuale test sul campo con un ente reale. Per le definizioni dei dispositivi/ruoli, vedi `docs/beacon.md` — qui vengono date per assunte, senza ripeterle.

**Nota terminologica**: le tabelle sotto elencano ancora "Emergency Beacon" e "Mobile Relay" come voci separate con quantità proprie — riflettono la proposta originale del piano di test, ricevuta prima che l'utente decidesse di unificare l'hardware nella ARALD Card (`docs/beacon.md`). Le quantità restano valide come conteggio di **unità configurate in un profilo firmware o nell'altro** (Beacon Mode / Relay Mode), non più come due prodotti fisici distinti.

**Da non confondere con [`docs/test-protocol.md`](./test-protocol.md)** (proposta distinta ricevuta il 4 settembre 2026): quel documento descrive la **scala tecnica** di validazione (fasi 0-8, test T-number, KPI, criteri PASS/CONDITIONAL/FAIL), indipendente da budget/partner — un asse complementare, non uno che sostituisce le fasi qui sotto.

## Perché un piano a fasi

La proposta evita deliberatamente di costruire subito una rete completa, seguendo la stessa logica incrementale già usata in questo progetto per ogni altra espansione (BOX/PORTABLE, Beacon stesso: prototipo → validazione → scala): dimostrare prima che i singoli componenti funzionano, poi che funzionano insieme come sistema, solo infine proporre un test con un ente esterno. Metodologicamente solido — nessuna riserva tecnica su questa struttura.

**Premessa che vale per l'intero documento**: ogni fase presuppone hardware reale che oggi non esiste — nessun Beacon/Relay/ARALD Box è stato costruito, il progetto resta a livello di documentazione. Il bring-up fisico dei prototipi resta inoltre esplicitamente **lavoro privato dell'utente**, non di questo repository — stessa decisione già presa il 2 settembre 2026 per il prototipo BOX ("questa parte la svolgo solo io"). Questo documento descrive quindi un percorso *futuro ed eventuale*, non un piano di lavoro in corso.

## Fase 0 — Prototipazione tecnica

**Obiettivo**: dimostrare che i singoli componenti funzionano.

**Hardware iniziale**: 1× ARALD Box (Orange Pi 4 Pro 4GB), 1× Fixed/Mobile Relay prototipale, 1× Emergency Beacon prototipale.

**Test**: BLE Long Range; LoRa; trasmissione/ricezione; autenticazione dei dispositivi; identificazione univoca; messaggi SOS; ACK; deduplicazione; TTL; store-and-forward; misura dei consumi; gestione della batteria; prima prova del relay solare.

**Risultato atteso**: una catena funzionante `Beacon → Relay → ARALD Box → operatore`, senza dipendere da Internet.

## Fase 1 — Micro Pilot

Una piccola rete di 11 dispositivi, per dimostrare che **la rete funziona come sistema** — non ancora la copertura di un territorio esteso.

| Dispositivo | Q.tà |
|---|---:|
| ARALD Box | 2 |
| ARALD Portable | 1 |
| Fixed Relay solare | 2 |
| Mobile Relay | 2 |
| Emergency Beacon | 4 |

**Budget indicativo**: ~700-800 €.

**Test principali**: Beacon → Fixed Relay; Beacon → Mobile Relay; Relay → Relay; Relay → ARALD Box; Mobile Relay → ARALD Box; ARALD Box → ARALD Box; funzionamento senza Internet; perdita di un nodo; messaggi duplicati; più SOS simultanei; priorità dei messaggi di emergenza; autonomia dei Fixed Relay solari; registrazione ID e posizione dei relay (vedi Relay Registry, `docs/beacon.md`); visualizzazione dei relay sul portale. Include scenari simulati come lo spegnimento deliberato di un relay, per verificare che il messaggio trovi un percorso alternativo — esattamente il tipo di scenario già previsto nei pilot di `docs/deployment.md` (es. "riavvio di un nodo, perdita permanente di un nodo" nel pilot rifugio).

## Fase 2 — Field Pilot

Se il Micro Pilot funziona, una rete dimensionata per un ente partner reale — un **ARALD Field Pilot Kit**, non più un prototipo.

| Dispositivo | Q.tà |
|---|---:|
| ARALD Box | 4 |
| ARALD Portable | 2 |
| Fixed Relay solare | 8 |
| Mobile Relay | 8 |
| Emergency Beacon | 16 |
| **Totale** | **38** |

**Budget indicativo**: ~1.800-2.400 €, con un budget progettuale prudenziale di ~2.500 €.

### Come dovrebbe essere svolto

Non tutti i 38 dispositivi installati insieme, ma per passi:

- **Step A — Baseline**: 1-2 Box e pochi relay in un'area controllata; si misurano copertura, affidabilità, latenza, packet loss, autonomia, comportamento con ostacoli e con più dispositivi.
- **Step B — Espansione**: installazione progressiva degli 8 Fixed Relay, ciascuno registrato (Relay ID, posizione, configurazione radio, alimentazione, data di installazione, stato, ultimo contatto — stessi campi già proposti per il Relay Registry in `docs/beacon.md`). Il portale produce così una mappa dell'infrastruttura ARALD.
- **Step C — Scenario operativo**: i 16 Beacon distribuiti tra volontari/tester; si simulano SOS singoli e simultanei, perdita di copertura, persona in movimento, relay fuori servizio, relay mobile, trasporto fisico del messaggio, recupero di un messaggio dopo diverse ore.
- **Step D — Test di emergenza simulata**: uno scenario realistico definito dall'ente partner (es. "escursionista senza rete cellulare attiva il Beacon, un Fixed Relay lo riceve e lo inoltra al ARALD Box dell'unità di soccorso"), poi complicato (es. "il Fixed Relay più vicino è indisponibile, il Beacon viene rilevato da un Mobile Relay che trasporta fisicamente il messaggio").

## Possibili partner di campo

**Avvertenza importante**: questa parte non è stata verificata da questa sessione — nessun accesso a internet reale in questo ambiente, stessa limitazione già dichiarata altrove nel progetto (es. il chip Allwinner A733 di ARALD Box, mai verificato indipendentemente). Le informazioni sugli enti sotto sono ipotesi di lavoro dell'utente, non fatti confermati qui, e **la scelta di quale ente contattare, quando e come resta una decisione dell'utente**, non una questione tecnica di questo repository — a differenza di tutto il resto di questo documento, che riguarda la validazione del sistema.

Candidati indicati dall'utente, in ordine di priorità suggerita:

1. **CNSAS** (Corpo Nazionale Soccorso Alpino e Speleologico) — indicato come il candidato più naturale per il primo contatto: il problema che ARALD cerca di risolvere (comunicazione in ambiente montano/impervio senza rete cellulare) coincide con un ambiente operativo quotidiano del CNSAS. Scenario ideale: una singola delegazione/zona operativa, per testare Beacon + Fixed Relay + Mobile Relay ed eventualmente droni come vettori di Mobile Relay.
2. **Protezione Civile** (struttura regionale/provinciale o organizzazione di volontariato, più realistico di un primo contatto con il Dipartimento nazionale) — interessante per scenari non alpini: terremoto, alluvione, incendio, blackout, evacuazioni.
3. **Vigili del Fuoco** (Corpo Nazionale) — partner di interesse per una fase successiva, più come interlocutore tecnologico/istituzionale che come primo partner sperimentale.
4. **AREU Lombardia** (sistema regionale di emergenza-urgenza) — caso d'uso più complesso: ARALD non sostituirebbe il NUE 112/118, funzionerebbe eventualmente come strato di comunicazione complementare dove la connettività è problematica.

**Strategia di presentazione suggerita dall'utente**: non presentare ARALD come "un nuovo sistema di soccorso", ma come "una tecnologia sperimentale per il trasporto resiliente di informazioni di emergenza in assenza o indisponibilità delle normali reti di comunicazione" — lasciando all'ente il ruolo di validatore operativo, non quello di dover adottare una nuova infrastruttura critica.

## Percorso ideale (vista d'insieme)

```
Prototipo (Fase 0)
   ↓
Micro Pilot (~700-800 €)
   ↓
test tecnico
   ↓
partner operativo
   ↓
Field Pilot (~2.500 €)
   ↓
report indipendente dei risultati
   ↓
eventuale pilot esteso
```

## Effetto di rete: la densità conta più delle prestazioni del singolo relay

**Stato**: principio strategico ricevuto dall'utente lo stesso giorno, integrato dopo valutazione — nessuna novità tecnica per il codice esistente, nessun codice scritto.

Il punto centrale, individuato dall'utente: l'efficacia di ARALD non dipende solo da quanto bene funziona un singolo relay, ma dalla **densità** di dispositivi presenti sul territorio e soprattutto dalle **persone che li trasportano**. Un Beacon senza alcun relay nelle vicinanze non serve a nulla; più persone/dispositivi compatibili attraversano un'area, più aumenta la probabilità di consegna. È un classico **effetto di rete**: più NOMAD viene usato, più NOMAD diventa efficace — coerente con quanto già scritto in questo documento sulla necessità di una massa critica di infrastruttura prima di un Field Pilot.

Principio formalizzato dall'utente, riportato qui come dichiarato:

> **ARALD Network Effect**
> The effectiveness of ARALD increases with the density of fixed infrastructure and participating mobile devices. The network should therefore not depend exclusively on dedicated NOMAD hardware. In addition to fixed relays and emergency beacons, NOMAD functionality should progressively be made available through smartphones and, where technically and commercially feasible, embedded directly into outdoor, safety and communication equipment.
>
> The long-term objective is to make NOMAD relay functionality sufficiently ubiquitous that users can contribute to emergency information propagation without consciously operating the network.

### Bivacchi: ARALD Box invece di un semplice relay

Raccomandazione operativa dell'utente per il Relay Registry (`docs/beacon.md`): in un bivacco isolato, preferire un **ARALD Box** (alimentazione solare, batteria, LoRa + BLE Long Range, memoria, identificativo e posizione registrati nel Relay Registry) a un semplice Fixed Relay — chi arriva al bivacco può usarlo direttamente come nodo ARALD senza dover portare o installare nulla. Idealmente sempre attivo grazie al pannello solare; se spento per risparmio energetico, riattivabile con un pulsante. Nessuna implicazione tecnica diversa da quanto già descritto per Fixed Relay/ARALD Box altrove — è una scelta di *quale* hardware installare in un punto specifico, non un meccanismo nuovo.

### Livelli di partecipazione — non puntare tutto sull'app

Osservazione dell'utente, condivisibile: richiedere a tutti l'app NOMAD per partecipare creerebbe una barriera enorme. Meglio più livelli di partecipazione indipendenti, ciascuno già coperto da quanto documentato in questo progetto:

| Livello | Chi/cosa | Riferimento |
|---|---|---|
| 1 — Infrastruttura | Fixed Relay e ARALD Box installati sul territorio | `docs/beacon.md`, sezione Fixed Relay |
| 2 — Smartphone | App NOMAD come relay opportunistico | `docs/beacon.md`, ruolo "Relay" — modalità "NOMAD Relay" |
| 3 — Beacon | Persone che portano una ARALD Card in Beacon Mode | `docs/beacon.md`, sezione ARALD Card |
| 4 — Relay personali | Persone che portano una ARALD Card in Relay Mode | `docs/beacon.md`, sezione ARALD Card |
| 5 — Infrastruttura professionale | Droni, veicoli di soccorso, rifugi, operatori | `docs/beacon.md`, sezione Fixed Relay |

Chi non possiede un Beacon può comunque contribuire alla rete semplicemente portando uno smartphone compatibile (Livello 2) — nessun livello è prerequisito di un altro.

### L'analogia con RECCO

Il modello RECCO (dispositivo passivo, sempre integrato nell'attrezzatura, l'utente non deve fare nulla durante l'emergenza) è un riferimento pertinente per l'obiettivo a lungo termine: non "scarica NOMAD, registrati, compra un Beacon e ricordati di portarlo", ma "NOMAD è già presente nell'attrezzatura che usi". Zaini, imbraghi, caschi, giacche, kit di sicurezza, dispositivi per bambini, attrezzatura da sci/alpinismo, veicoli outdoor sono tutti possibili contenitori per un NOMAD Relay integrato dal produttore — l'utente non deve nemmeno sapere che esiste, lo porta semplicemente con sé.

**Importante**: a differenza della ARALD Card/Fixed Relay documentati sopra (dispositivi NOMAD dedicati), questa integrazione dipende da **accordi con produttori terzi** di attrezzatura outdoor/sicurezza — una decisione commerciale/di partnership, non una questione tecnica di questo repository, nello stesso modo in cui gli enti di soccorso sopra sono una decisione di relazioni esterne dell'utente. L'idea più prossima e realizzabile è integrare NOMAD in dispositivi che hanno **già una batteria propria** (GPS outdoor, comunicatori satellitari, smartwatch, e-bike) — costo energetico marginale basso, NOMAD come strato di comunicazione complementare invece che dispositivo a sé.

### Ruolo del Beacon in questo modello

Conseguenza diretta dei livelli sopra: il Beacon resta il dispositivo più semplice e affidabile specificamente progettato per l'emergenza, ma **non l'unico modo di generare un SOS** — uno smartphone, un dispositivo NOMAD qualunque o un dispositivo professionale potrebbero originare lo stesso tipo di evento, purché usino lo stesso protocollo. Questo è tecnicamente coerente con l'architettura esistente (`Priority.EMERGENCY` non è mai stato legato a un hardware specifico — `service://emergency-news`, voce #39, lo origina già da software puro) e **rende ancora più rilevante** un punto già segnalato come aperto in `docs/beacon.md` ("Cosa manca davvero", punto 1): il formato messaggio dell'emergenza andrebbe progettato come **condiviso tra più tipi di originator** fin dall'inizio, non come specifico del solo hardware Beacon — un vincolo in più da tenere presente quando si arriverà a quella decisione di design, non un lavoro aggiuntivo per ora.

### Fasi di adozione (asse diverso dalle Fasi 0/1/2 sopra)

**Attenzione a non confondere** questo con le Fase 0/Micro Pilot/Field Pilot sopra, che riguardano la **validazione tecnica** di dispositivi già costruiti. Queste sono invece fasi di **adozione/diffusione** nel tempo, un asse complementare:

```
Fase iniziale — infrastruttura proprietaria
  Bivacco → Fixed Relay → Fixed Relay → ARALD Box
       ↓
Fase successiva — + smartphone
  Fixed Relay ↔ smartphone ↔ smartphone ↔ Fixed Relay
       ↓
Fase matura — NOMAD embedded
  zaino, smartphone, veicolo, drone, dispositivo outdoor, Beacon → ARALD
```

Nella fase matura non si parlerebbe più di 10 o 100 relay, ma potenzialmente di migliaia di piccoli nodi mobili che attraversano continuamente il territorio — un orizzonte molto oltre il Field Pilot da 38 dispositivi sopra, incluso qui come visione di lungo periodo, non come prossimo passo operativo.

## Cosa NON è nello scope di questo repository

- Il bring-up fisico di qualunque prototipo (Fase 0 in su) — lavoro privato dell'utente, coerente con la decisione già presa il 2 settembre 2026 per ARALD Box.
- Qualunque contatto reale, accordo o impegno con CNSAS/Protezione Civile/Vigili del Fuoco/AREU o altri enti — relazioni esterne dell'utente, non una questione tecnica.
- La verifica indipendente delle informazioni istituzionali sugli enti sopra — non fatta qui, nessun accesso a internet reale.
- Qualunque accordo con produttori terzi di attrezzatura outdoor/sicurezza per l'integrazione di un NOMAD Relay nei loro prodotti — decisione commerciale/di partnership dell'utente, non tecnica.

## Prossimo passo

Nessun codice scritto, nessun hardware costruito. Il primo passo concreto — se e quando l'utente vorrà procedere — resta la Fase 0 (prototipazione tecnica), che dipende comunque dalla disponibilità di hardware fisico reale (Beacon/Relay/ARALD Box), oggi non disponibile in questo ambiente. Fino ad allora, questo documento resta puramente di riferimento/pianificazione, come `docs/beacon.md`.
