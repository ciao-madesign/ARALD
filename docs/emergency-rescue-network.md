# NOMAD-Net Emergency & Rescue Network — roadmap di validazione e possibili partner di campo

**Stato**: documentazione di riferimento/pianificazione, v0.1 — **nessun codice scritto, nessun hardware costruito**. Proposta ricevuta dall'utente il 3 settembre 2026, valutata insieme all'utente prima di essere integrata qui.

Tenuta in un documento **separato** da `docs/beacon.md`, su richiesta esplicita dell'utente: `docs/beacon.md` descrive i dispositivi (Beacon, Mobile Relay, Fixed Relay, Relay Registry) e la loro compatibilità con l'architettura Nomad-Net esistente; questo documento descrive invece come si arriverebbe, per gradi, a validare quei dispositivi **insieme come rete** — fino a un eventuale test sul campo con un ente reale. Per le definizioni dei dispositivi/ruoli, vedi `docs/beacon.md` — qui vengono date per assunte, senza ripeterle.

## Perché un piano a fasi

La proposta evita deliberatamente di costruire subito una rete completa, seguendo la stessa logica incrementale già usata in questo progetto per ogni altra espansione (BOX/PORTABLE, Beacon stesso: prototipo → validazione → scala): dimostrare prima che i singoli componenti funzionano, poi che funzionano insieme come sistema, solo infine proporre un test con un ente esterno. Metodologicamente solido — nessuna riserva tecnica su questa struttura.

**Premessa che vale per l'intero documento**: ogni fase presuppone hardware reale che oggi non esiste — nessun Beacon/Relay/NOMAD-Box è stato costruito, il progetto resta a livello di documentazione. Il bring-up fisico dei prototipi resta inoltre esplicitamente **lavoro privato dell'utente**, non di questo repository — stessa decisione già presa il 2 settembre 2026 per il prototipo BOX ("questa parte la svolgo solo io"). Questo documento descrive quindi un percorso *futuro ed eventuale*, non un piano di lavoro in corso.

## Fase 0 — Prototipazione tecnica

**Obiettivo**: dimostrare che i singoli componenti funzionano.

**Hardware iniziale**: 1× NOMAD-Box (Orange Pi 4 Pro 4GB), 1× Fixed/Mobile Relay prototipale, 1× Emergency Beacon prototipale.

**Test**: BLE Long Range; LoRa; trasmissione/ricezione; autenticazione dei dispositivi; identificazione univoca; messaggi SOS; ACK; deduplicazione; TTL; store-and-forward; misura dei consumi; gestione della batteria; prima prova del relay solare.

**Risultato atteso**: una catena funzionante `Beacon → Relay → NOMAD-Box → operatore`, senza dipendere da Internet.

## Fase 1 — Micro Pilot

Una piccola rete di 11 dispositivi, per dimostrare che **la rete funziona come sistema** — non ancora la copertura di un territorio esteso.

| Dispositivo | Q.tà |
|---|---:|
| NOMAD-Box | 2 |
| NOMAD Portable | 1 |
| Fixed Relay solare | 2 |
| Mobile Relay | 2 |
| Emergency Beacon | 4 |

**Budget indicativo**: ~700-800 €.

**Test principali**: Beacon → Fixed Relay; Beacon → Mobile Relay; Relay → Relay; Relay → NOMAD-Box; Mobile Relay → NOMAD-Box; NOMAD-Box → NOMAD-Box; funzionamento senza Internet; perdita di un nodo; messaggi duplicati; più SOS simultanei; priorità dei messaggi di emergenza; autonomia dei Fixed Relay solari; registrazione ID e posizione dei relay (vedi Relay Registry, `docs/beacon.md`); visualizzazione dei relay sul portale. Include scenari simulati come lo spegnimento deliberato di un relay, per verificare che il messaggio trovi un percorso alternativo — esattamente il tipo di scenario già previsto nei pilot di `docs/deployment.md` (es. "riavvio di un nodo, perdita permanente di un nodo" nel pilot rifugio).

## Fase 2 — Field Pilot

Se il Micro Pilot funziona, una rete dimensionata per un ente partner reale — un **NOMAD-Net Field Pilot Kit**, non più un prototipo.

| Dispositivo | Q.tà |
|---|---:|
| NOMAD-Box | 4 |
| NOMAD Portable | 2 |
| Fixed Relay solare | 8 |
| Mobile Relay | 8 |
| Emergency Beacon | 16 |
| **Totale** | **38** |

**Budget indicativo**: ~1.800-2.400 €, con un budget progettuale prudenziale di ~2.500 €.

### Come dovrebbe essere svolto

Non tutti i 38 dispositivi installati insieme, ma per passi:

- **Step A — Baseline**: 1-2 Box e pochi relay in un'area controllata; si misurano copertura, affidabilità, latenza, packet loss, autonomia, comportamento con ostacoli e con più dispositivi.
- **Step B — Espansione**: installazione progressiva degli 8 Fixed Relay, ciascuno registrato (Relay ID, posizione, configurazione radio, alimentazione, data di installazione, stato, ultimo contatto — stessi campi già proposti per il Relay Registry in `docs/beacon.md`). Il portale produce così una mappa dell'infrastruttura NOMAD-Net.
- **Step C — Scenario operativo**: i 16 Beacon distribuiti tra volontari/tester; si simulano SOS singoli e simultanei, perdita di copertura, persona in movimento, relay fuori servizio, relay mobile, trasporto fisico del messaggio, recupero di un messaggio dopo diverse ore.
- **Step D — Test di emergenza simulata**: uno scenario realistico definito dall'ente partner (es. "escursionista senza rete cellulare attiva il Beacon, un Fixed Relay lo riceve e lo inoltra al NOMAD-Box dell'unità di soccorso"), poi complicato (es. "il Fixed Relay più vicino è indisponibile, il Beacon viene rilevato da un Mobile Relay che trasporta fisicamente il messaggio").

## Possibili partner di campo

**Avvertenza importante**: questa parte non è stata verificata da questa sessione — nessun accesso a internet reale in questo ambiente, stessa limitazione già dichiarata altrove nel progetto (es. il chip Allwinner A733 di NOMAD-NET BOX, mai verificato indipendentemente). Le informazioni sugli enti sotto sono ipotesi di lavoro dell'utente, non fatti confermati qui, e **la scelta di quale ente contattare, quando e come resta una decisione dell'utente**, non una questione tecnica di questo repository — a differenza di tutto il resto di questo documento, che riguarda la validazione del sistema.

Candidati indicati dall'utente, in ordine di priorità suggerita:

1. **CNSAS** (Corpo Nazionale Soccorso Alpino e Speleologico) — indicato come il candidato più naturale per il primo contatto: il problema che NOMAD-Net cerca di risolvere (comunicazione in ambiente montano/impervio senza rete cellulare) coincide con un ambiente operativo quotidiano del CNSAS. Scenario ideale: una singola delegazione/zona operativa, per testare Beacon + Fixed Relay + Mobile Relay ed eventualmente droni come vettori di Mobile Relay.
2. **Protezione Civile** (struttura regionale/provinciale o organizzazione di volontariato, più realistico di un primo contatto con il Dipartimento nazionale) — interessante per scenari non alpini: terremoto, alluvione, incendio, blackout, evacuazioni.
3. **Vigili del Fuoco** (Corpo Nazionale) — partner di interesse per una fase successiva, più come interlocutore tecnologico/istituzionale che come primo partner sperimentale.
4. **AREU Lombardia** (sistema regionale di emergenza-urgenza) — caso d'uso più complesso: NOMAD-Net non sostituirebbe il NUE 112/118, funzionerebbe eventualmente come strato di comunicazione complementare dove la connettività è problematica.

**Strategia di presentazione suggerita dall'utente**: non presentare NOMAD-Net come "un nuovo sistema di soccorso", ma come "una tecnologia sperimentale per il trasporto resiliente di informazioni di emergenza in assenza o indisponibilità delle normali reti di comunicazione" — lasciando all'ente il ruolo di validatore operativo, non quello di dover adottare una nuova infrastruttura critica.

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

## Cosa NON è nello scope di questo repository

- Il bring-up fisico di qualunque prototipo (Fase 0 in su) — lavoro privato dell'utente, coerente con la decisione già presa il 2 settembre 2026 per NOMAD-NET BOX.
- Qualunque contatto reale, accordo o impegno con CNSAS/Protezione Civile/Vigili del Fuoco/AREU o altri enti — relazioni esterne dell'utente, non una questione tecnica.
- La verifica indipendente delle informazioni istituzionali sugli enti sopra — non fatta qui, nessun accesso a internet reale.

## Prossimo passo

Nessun codice scritto, nessun hardware costruito. Il primo passo concreto — se e quando l'utente vorrà procedere — resta la Fase 0 (prototipazione tecnica), che dipende comunque dalla disponibilità di hardware fisico reale (Beacon/Relay/NOMAD-Box), oggi non disponibile in questo ambiente. Fino ad allora, questo documento resta puramente di riferimento/pianificazione, come `docs/beacon.md`.
