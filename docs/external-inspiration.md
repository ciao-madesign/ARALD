# Idee da repository esterni

Appunto leggero di piccoli spunti/possibili migliorie per ARALD — sia notati confrontando il progetto con repository esterni (analisi fatta **a comando**, non un monitoraggio automatico permanente), sia da un brainstorm su richiesta esplicita dell'utente (ruolo consulente/stakeholder/investitore, ottica di diffusione/praticità del prodotto, non monetizzazione). Non sono candidati pianificati — per quelli vedi [`docs/next-steps.md`](./next-steps.md). Questo file è solo una lista grezza da cui eventualmente promuovere una voce a `next-steps.md` quando/se si decide di lavorarci.

| Data | Fonte | Idea | Perché potenzialmente utile per ARALD | Stato |
|---|---|---|---|---|
| 2026-09-29 | [Crosstalk-Solutions/project-nomad](https://github.com/Crosstalk-Solutions/project-nomad) (v1.34.1, commit `85da928`) | Auto-update "sicuro": update minor/patch automatici solo dentro una finestra oraria configurabile, dopo un periodo di cool-off, con pre-flight check (spazio disco sufficiente, nessun download/installazione in corso); major version sempre manuali. Comando dry-run dedicato che simula l'intera pipeline di decisione senza mai eseguire un update reale. | `nomad-hub/` (ARALD Hub Management API) non ha ancora nessuna logica di auto-update per sé stesso o per i container che gestisce. | Da valutare |
| 2026-09-29 | project-nomad | "Collections" curate per dominio (es. hanno appena aggiunto "FDA Drug Reference" sotto "Medicine > Standard") | Concettualmente identico ai "pacchetti pre-confezionati per caso d'uso" già previsti in [`docs/service-catalog.md`](./service-catalog.md) — utile tenerlo d'occhio per capire quali contenuti curano loro, se in futuro si vuole espandere il catalogo ARALD via `gateway/local-services/kiwix-gateway.ts`. | Da valutare |
| 2026-09-29 | project-nomad | Test di connettività "a cascata": prova prima `https://1.1.1.1/cdn-cgi/trace` (Cloudflare), poi fallback su altri endpoint già contattati (GitHub API, API propria) se il primo è bloccato dalla rete | Pattern minore ma pulito, applicabile se in futuro serve un check "c'è davvero internet" in un gateway ARALD (es. `internet-gateway.ts` o un futuro controllo per `external-delivery.ts`) | Da valutare |
| 2026-09-22 | [NawfalMotii79/PLFM_RADAR](https://github.com/NawfalMotii79/PLFM_RADAR) | Doppia licenza: hardware sotto CERN-OHL-P (Permissive), software/firmware sotto MIT | Schema di riferimento pulito se in futuro si decidesse di pubblicare i design hardware di ARALD Box/Card/Relay (schematici, PCB, Gerber) separatamente dal codice | Da valutare |

## Proposte prodotto/hardware (brainstorm su richiesta, non da confronto con repository esterni)

Richiesta esplicita dell'utente il 29 settembre 2026: proposte per aggiungere o semplificare funzionalità ARALD, sia software sia hardware, con lente da consulente/stakeholder/potenziale investitore orientato a diffusione e praticità (non monetizzazione). Verificate prima contro `docs/beacon.md`/`docs/reuse-vs-new.md`/`docs/next-steps.md` per non riproporre cose già decise (solare per Fixed Relay: già pianificato; più SKU hardware: già scartati a favore della Card unica multi-profilo; OTA firmware da remoto sui relay: già valutato ed esplicitamente escluso dall'utente per rischio).

| Data | Ambito | Idea | Perché potenzialmente utile | Stato |
|---|---|---|---|---|
| 2026-09-29 | SW | **Ponte/gateway verso Meshtastic**: un gateway ARALD che parla anche il formato pacchetto Meshtastic (pubblico, da reimplementare da zero — nessun riuso di codice GPL-3.0, stesso trattamento già riservato a Meshtastic in `docs/reuse-vs-new.md`), traducendo messaggi testo/posizione/allarme tra i due mondi. | Meshtastic ha già centinaia di migliaia di nodi LoRa economici (~30€) in circolazione, con forte community proprio nell'escursionismo/outdoor — lo stesso pubblico del pilot rifugio. Un ponte renderebbe chi possiede già un nodo Meshtastic raggiungibile dalla rete ARALD senza comprare nulla: il modo più economico per allargare la rete oltre chi ha una ARALD Card. `docs/reuse-vs-new.md` conferma che ARALD non compete sul terreno hardware-economico-di-massa dove Meshtastic è già maturo. | **Promossa** a `docs/next-steps.md` (30 settembre 2026) — accessorio opzionale per fase successiva alla validazione dei prototipi, subordinato a una seconda antenna LoRa dedicata, sviluppo su branch a sé |
| 2026-09-29 | SW | **File di configurazione per `cli.ts`** (`--config box.json` opzionale, i flag CLI restano come override) invece di soli flag. | La lista flag di `cli.ts` è già lunga (`--identity-dir`, `--lora-serial-port`, `--external-delivery-destinations`, ecc.) e cresce a ogni feature — un file di config è più gestibile per chi deve installare un Box sul campo senza essere uno sviluppatore. Zero nuove dipendenze. | Da valutare |
| 2026-09-29 | SW | **Vista "salute rete" aggregata**: una vista che aggrega tutti i relay/Card noti (batteria bassa, ultimo contatto, chi rischia di uscire dalla mesh), non solo il pannello per singolo relay che esiste oggi. | I dati esistono già in `RelayRegistry` (batteria, `lastSeenAt`, stato online/offline) — manca solo l'aggregazione per un coordinatore che gestisce più nodi durante un'emergenza reale. | Da valutare |
| 2026-09-29 | HW | **Modalità "SOS confermato" con segnalazione visiva** (LED a strobo intenso, distinto dal blink diagnostico) sulla ARALD Card, attivata solo quando parte un SOS. | La Card ha già un LED di stato previsto in `docs/beacon.md` — un secondo profilo dedicato permette a un soccorritore di individuare a vista chi ha lanciato l'SOS anche senza alcun nodo ricevente nelle vicinanze. Costo marginale nullo, beneficio SAR indipendente dalla mesh. | Da valutare |
| 2026-10-01 | HW | **ARALD Watch**: tre livelli di priorità, riordinati su richiesta dell'utente — (1) app/interfaccia ARALD per smartwatch commerciali esistenti (Wear OS, Apple Watch, Garmin...), (2) firmware ARALD su hardware LoRa aperto esistente (es. LILYGO T-Watch Ultra, stesso ESP32-S3+SX1262 già usato da ARALD), (3) Watch proprietario — retrocesso a opzione lontana, solo se estremamente low-cost. Vedi sezione dedicata sotto. | Sfrutta installato esistente invece di costruire hardware nuovo, stesso principio già applicato al ponte Meshtastic e al confronto Card+cinturino. | Proposta completa, non promossa — `Priority: Post-prototype / da validare`, stesso stato dichiarato dall'utente |

### ARALD Watch — proposta completa, riordinata per priorità (1 ottobre 2026)

**Status**: Proposal · **Type**: Hardware / Product Extension · **Related**: ARALD Card · **Priority**: Post-prototype / da validare.

**Aggiornamento 1 ottobre 2026, riordino su richiesta esplicita dell'utente**: la direzione primaria non è più "progettare un Watch proprietario" — è sfruttare smartwatch commerciali già esistenti e diffusi, che hanno già GPS, Bluetooth e in alcuni casi Wi-Fi, facendoli parlare il protocollo ARALD e/o usandoli come interfaccia verso ARALD. Stesso principio già applicato al ponte Meshtastic e al confronto Card+cinturino: sfruttare installato esistente prima di costruire hardware nuovo. Tre livelli di priorità, dal più concreto al più lontano:

#### Livello 1 (priorità massima) — ARALD come app/interfaccia per smartwatch commerciali esistenti

Nessun hardware nuovo: un'app che gira sullo smartwatch che la persona già possiede, usando i suoi sensori/radio di fabbrica.

- **Wear OS (Android)** — il candidato più promettente nel breve termine. Un'app Wear OS è sostanzialmente un'app Android: potrebbe riusare gran parte della logica già scritta e provata per il telefono (`mobile/www/ble-client.js`/`ble-sos.js`/`ble-dual-role-client.js` — firma SOS, relay Bluetooth dual-role), cambiando principalmente l'interfaccia per uno schermo piccolo/rotondo, non il protocollo. Da validare: GPS e Bluetooth di fabbrica, Wi-Fi presente su alcuni modelli.
- **Apple Watch (watchOS)** — più restrittivo su Bluetooth in background rispetto ad Android (Apple limita di più scanning/peripheral continuo). **Non verificato in questa sessione contro la documentazione Apple aggiornata** — da controllare prima di assumere fattibilità equivalente a Wear OS.
- **Garmin/Amazfit ed ecosistemi proprietari** — SDK più chiusi, probabilmente limitati a mostrare notifiche ricevute dal telefono piuttosto che far girare logica ARALD o un relay BLE autonomo sul dispositivo stesso.

#### Livello 2 — Firmware ARALD su hardware LoRa aperto già esistente

Per chi vuole la portata LoRa (non disponibile sui comuni smartwatch commerciali) senza progettare un Watch proprietario da zero.

**Trovato con ricerca web reale in questa sessione**: esiste già una categoria di smartwatch LoRa open-hardware, e uno in particolare è notevolmente allineato ad ARALD — il **LILYGO T-Watch Ultra**: ESP32-S3 + **SX1262** (lo stesso chip LoRa già standard per Box/Portable/Card) + GNSS + display AMOLED 2,01" + IP65, ~95$, piattaforma aperta/maker-friendly (stesso lignaggio del T-Watch S3 precedente). Un passo oltre il riuso del solo contenitore Takachi (Livello 3 sotto): riuso dell'intero dispositivo, non solo dell'enclosure — portare il firmware ARALD su un hardware aperto già esistente invece di progettare un PCB proprietario.

Esiste anche un mercato adiacente di smartwatch **LoRaWAN per "lone worker"** (sicurezza per lavoratori isolati — es. ED20W, prodotti Harotechs/lpwanspace) — protocollo diverso da quello usato da ARALD (LoRaWAN, non LoRa P2P), stesso trattamento già riservato a Meshtastic: solo riferimento concettuale/di mercato, mai riuso di codice o compatibilità diretta. Conferma comunque che il segmento "smartwatch LoRa per la sicurezza personale" esiste già come mercato validato.

**Non ancora verificato**: compatibilità firmware reale del T-Watch Ultra/S3 con i driver SX1262 già scritti in questo repository (`sx126x-commands.ts`/`sx126x-bridge-protocol.ts`), ingombro/autonomia reali, costo totale confrontato con l'opzione Livello 3.

#### Livello 3 (opzione più lontana, solo se estremamente low-cost) — Watch proprietario

Resta documentato per intero sotto, ma retrocesso: plausibile solo se i Livelli 1-2 si rivelano insufficienti **e** il costo risultante è estremamente basso — non più la direzione di default.

##### 1. Concept

ARALD Watch propone una variante wearable della **ARALD Card**, con l'obiettivo di ottenere un dispositivo da polso mantenendo il massimo riutilizzo possibile dell'architettura ARALD.

Il Watch non deve essere considerato automaticamente come un secondo dispositivo hardware indipendente. Il concetto preliminare è:

> **ARALD Watch = ARALD Card Core + display + wearable enclosure**

con GPS/GNSS opzionale.

Tuttavia, il riutilizzo dell'hardware **non è ancora una decisione acquisita**: la piattaforma MCU della Card deve essere stabilita prima di poter definire quale hardware costituisca realmente il "Core condiviso".

##### 2. Situazione attuale della piattaforma Card

La Card dispone attualmente di due piattaforme hardware in fase di valutazione, con ruoli differenti.

**Card V1 — piattaforma attualmente prevista**: **Arduino Nano ESP32 ABX00092 + modulo SX1262 separato** — footprint Nano ESP32 circa 45×18mm, scelta MCU definita per la Card l'8 settembre 2026, SX1262 come modulo radio separato.

**Piattaforma alternativa di sviluppo**: **XIAO ESP32-S3 + Wio-SX1262** — footprint complessivo circa 21×18mm, introdotta il 9 settembre 2026 come seconda piattaforma di sviluppo, utilizzata per validare il firmware su un'integrazione fisica più compatta, non introdotta originariamente come sostituzione della scelta MCU della Card, presenta ancora un rischio di certificazione aperto, registrato come **CERT-002** (`docs/compliance.md`).

Di conseguenza, il Watch non deve assumere a priori che XIAO+Wio costituisca il Core ARALD condiviso.

##### 3. Opportunità introdotta dal Watch

Il vincolo dimensionale del Watch costituisce un nuovo elemento di valutazione della scelta hardware: il footprint significativamente inferiore di XIAO ESP32-S3 + Wio-SX1262 potrebbe renderlo particolarmente adatto a un dispositivo wearable. Questo apre una possibile decisione architetturale:

**Opzione A — mantenere due piattaforme**: Card V1 → Arduino Nano ESP32 + SX1262; Watch → XIAO ESP32-S3 + Wio-SX1262. In questo scenario Card e Watch condividono principalmente firmware/protocolli, architettura software, componenti funzionali, batteria e power architecture ove compatibili — ma non necessariamente la stessa piattaforma elettronica.

**Opzione B — convergere su XIAO + Wio**: se la validazione tecnica, dimensionale e di certificazione è positiva, il Watch potrebbe diventare uno dei fattori che motivano la convergenza dell'intera famiglia personale ARALD verso XIAO ESP32-S3 + Wio-SX1262 — in questo caso Card e Watch potrebbero condividere realmente lo stesso Core hardware.

La scelta deve essere presa esplicitamente dopo la validazione e non assunta come conseguenza automatica di questa proposta.

##### 3bis. Requisito: contenitore commerciale esistente prima di un'enclosure proprietaria (1 ottobre 2026, aggiunto dall'utente)

Coerente con la filosofia di riuso di ARALD (stessa logica già applicata a MCU/radio: riusare componenti esistenti, concentrare lo sviluppo su elettronica/firmware/rete invece che reinventare un componente meccanico che il mercato offre già): il primo prototipo Watch dovrebbe **valutare un contenitore commerciale IP67 esistente prima di progettare un'enclosure proprietaria**.

**Candidato proposto: Takachi SMW-50W** — verificato con ricerca web reale in questa sessione (due fonti indipendenti concordanti), non assunto: Takachi lo commercializza letteralmente come **"IP67 SMARTWATCH TYPE ENCLOSURE"** (serie SMW) — pensato esattamente per questo uso, non un contenitore generico riadattato.

| Campo | Valore (verificato) |
|---|---|
| Dimensioni esterne | 44 × 50 × 13,8 mm |
| Dimensioni interne | 23,9 × 26,9 × 10,4 mm |
| Grado di protezione | IP67 (1m di profondità / 30 min) |
| Materiale | ABS/ASA |
| Peso | 30,5 g |
| Colore | Off-white |

**Perché è un candidato credibile**: abbastanza piccolo da rendere credibile un Watch da polso, abbastanza grande da lasciare margine per batteria + PCB + display — a differenza di un contenitore generico, è già pensato per questo bilanciamento.

**Prossimo passo concreto, prima di fissare qualunque dimensione del Watch**: verificare se XIAO ESP32-S3 + Wio-SX1262 (impilati) + Li-Po 3,7V ~500mAh + display entrano davvero nel volume interno disponibile, usando le dimensioni **reali** dei singoli componenti (non solo quelle dell'enclosure). **Osservazione onesta, non verificata in questa sessione**: l'altezza interna di soli **10,4mm** è probabilmente il vincolo più stretto di tutto il contenitore — uno stack XIAO+Wio ha tipicamente più di pochi millimetri di spessore già da solo, prima di aggiungere batteria e display sopra — va controllato con i datasheet reali dei tre componenti prima di considerare la SMW-50W una scelta **confermata**, non solo plausibile. Se l'altezza non basta, resta comunque un riferimento dimensionale utile per calibrare l'ordine di grandezza di un'enclosure proprietaria.

##### 4. Obiettivo del Watch

Creare un dispositivo da polso dedicato ad ARALD che permetta di: visualizzare l'ora; visualizzare lo stato della rete ARALD; ricevere e mostrare messaggi; segnalare eventi SOS; inviare un SOS tramite pulsante fisico; fornire feedback tramite LED e, se introdotto, vibrazione; mantenere la comunicazione LoRa autonoma dallo smartphone; opzionalmente acquisire e trasmettere la posizione GPS/GNSS. Il Watch deve rimanere un **terminale ARALD minimale**, non uno smartwatch general purpose.

##### 5. GPS opzionale

Il GPS/GNSS deve rimanere un componente opzionale e non diventare un requisito del Core ARALD — coerente con il principio già stabilito per la Card: nessun GPS integrato nel dispositivo personale di base, la posizione viene associata dall'esterno quando disponibile (`location-registry.ts`). Nel Watch, il GPS può quindi essere introdotto esclusivamente come estensione hardware: quando presente, può acquisire la posizione localmente, associarla a un SOS, trasmetterla tramite LoRa, essere attivato solo quando necessario per contenere il consumo. Quando assente, il Watch deve mantenere tutte le funzionalità ARALD fondamentali.

##### 6. Display

Il display deve avere una funzione esclusivamente informativa e di controllo del dispositivo: ora, stato ARALD, stato della rete, messaggi ricevuti, SOS inviati/ricevuti, identificativo del nodo, batteria, eventuale posizione, eventuali informazioni ARALD future. La UI deve rimanere minimale, leggibile outdoor e orientata al basso consumo. Il display non deve trasformare il Watch in un dispositivo general purpose.

##### 7. Alimentazione e budget energetico

Il Watch dovrebbe riutilizzare, ove possibile, la stessa architettura energetica della Card. Configurazione preliminare: Li-Po 3,7V ~500mAh protetta, ricarica USB-C, gestione batteria compatibile con la piattaforma MCU scelta. Non introdurre inizialmente mini UPS, seconda batteria, supercapacitore, convertitori aggiuntivi non necessari. Un condensatore di bulk/low-ESR va aggiunto esclusivamente se i test dimostrano che i picchi di consumo del sistema ESP32+SX1262 provocano instabilità.

**Budget energetico del display**: l'aggiunta del display costituisce un cambiamento sostanziale rispetto alla Card, progettata attorno a un comportamento fortemente orientato al risparmio energetico (deep sleep aggressivo → wake-up → operazione → ritorno allo sleep). Un display attivo introduce un consumo aggiuntivo da valutare rispetto al target di autonomia della Card. Prima di congelare il Watch è necessario stimare: consumo del display acceso, durata media di ogni attivazione, numero di attivazioni giornaliere, consumo in standby, consumo dell'eventuale touch controller, consumo dell'eventuale vibrazione, consumo del GPS se presente, autonomia risultante con la stessa Li-Po da 500mAh.

**Requisito preliminare**: il Watch non deve richiedere automaticamente una batteria più grande — prima deve essere verificato se il budget energetico della Card può essere mantenuto con un display usato in modo intermittente. Solo se il budget non è compatibile con l'obiettivo di autonomia si valuterà una batteria di capacità superiore.

##### 8. Certificazione e utilizzo al polso

Il passaggio da Card a dispositivo wearable introduce un'ulteriore area di verifica: l'utilizzo vicino al corpo e la diversa posizione dell'antenna rispetto alla Card possono influire sui requisiti e sulle modalità di verifica della conformità RF. La certificazione non deve essere considerata automaticamente ereditata dal Core della Card. È necessario verificare esplicitamente: requisiti RF applicabili, configurazione dell'antenna, potenza di trasmissione, distanza dal corpo, eventuali requisiti SAR o valutazioni equivalenti applicabili alla configurazione finale, impatto della cassa e del cinturino, differenze tra le due piattaforme MCU/radio. **Il rischio CERT-002 relativo alla piattaforma XIAO+Wio deve essere risolto prima di utilizzare questa piattaforma come base definitiva della famiglia.**

##### 9. Alternativa: Card + cinturino

Prima di sviluppare un Watch completo va valutata un'alternativa a costo e complessità molto inferiori: **ARALD Card + cinturino/accessorio da polso**. Permetterebbe di ottenere subito il principale beneficio wearable (SOS sempre al polso, LoRa autonoma) senza nuovo display, nuovo firmware significativo, nuova piattaforma elettronica, nuova progettazione hardware sostanziale, con minore costo e minore complessità di certificazione.

| Funzione | Card + cinturino | Watch |
|---|---|---|
| SOS al polso | ✓ | ✓ |
| LoRa autonoma | ✓ | ✓ |
| Ora | — | ✓ |
| Messaggi visibili | — | ✓ |
| Stato rete | — | ✓ |
| Feedback vibrazione | possibile | ✓ |
| GPS autonomo | — | opzionale |
| Nuova elettronica | minima | necessaria |
| Nuova certificazione da valutare | minima | ✓ |
| Costo aggiuntivo | molto basso | maggiore |

**Criterio di validazione Fase 2**: determinare quali esigenze dell'utente richiedono effettivamente display, vibrazione o GPS e non possono essere soddisfatte dalla Card indossata tramite semplice cinturino. Il Watch completo è giustificato solo se le funzioni aggiuntive introducono un valore concreto che il semplice cinturino non può fornire.

##### 10. Espandibilità della Card — condizionata alla scelta di piattaforma (Fase 2)

**Corretto rispetto alla prima stesura della proposta** (la formulazione originale valeva "indipendentemente dalla piattaforma MCU", un'incoerenza: se si mantengono due piattaforme separate, la Card non ha motivo di riservare spazio per componenti che non ospiterà mai). Questo punto si applica **solo se in Fase 2 si sceglierà l'Opzione B (convergenza su XIAO+Wio)**. Se invece si manterranno due piattaforme separate (Opzione A), Watch e Card restano indipendenti anche nel layout PCB, e questo punto decade.

Se si convergerà su un Core condiviso, allora la progettazione della PCB dovrebbe considerare fin dall'inizio le possibili estensioni future — dove tecnicamente conveniente, riservare: punti di espansione, interfacce digitali disponibili, alimentazione, connessioni per display, eventuale interfaccia GNSS, eventuale feedback aptico. Questi elementi non devono necessariamente essere popolati sulla Card V1. Principio: riservare oggi le possibilità di espansione che hanno costo marginale basso, evitando un redesign completo in futuro.

##### 11. Sequenziamento

Il Watch non deve precedere la validazione del Core Card.

- **Fase 1 — Card**: validazione di MCU, SX1262, LoRa, SOS, autonomia, gestione batteria, picchi di consumo, affidabilità. Contestualmente, confrontare Arduino Nano ESP32+SX1262 con XIAO ESP32-S3+Wio-SX1262 rispetto a dimensioni, consumi, affidabilità, disponibilità, costo, firmware, certificazione.
- **Fase 2 — decisione piattaforma**: decidere se mantenere le due piattaforme o convergere su XIAO+Wio per l'intera famiglia personale ARALD. Il Watch costituisce uno dei criteri di questa decisione, soprattutto per il vincolo dimensionale.
- **Fase 3 — Watch prototype**: solo dopo la validazione del Core — display, cassa, cinturino, eventuale vibrazione.
- **Fase 4 — GPS**: validare separatamente modulo GNSS, consumo, autonomia, acquisizione/trasmissione posizione, dimensioni, impatto sulla certificazione.

##### 12. Architettura target

```text
                  ARALD PLATFORM
                        │
                ┌───────┴───────┐
                │   ARALD CORE  │
                │               │
                │ MCU           │
                │ SX1262        │
                │ LoRa          │
                │ Power         │
                │ Battery       │
                │ SOS           │
                │ Status LED    │
                └───────┬───────┘
                        │
              ┌─────────┴─────────┐
              │                   │
              ▼                   ▼
        ARALD CARD          ARALD WATCH
                              │
                         + Display
                         + Wearable
                         + optional GPS
                         + optional vibration
```

La natura effettivamente condivisa del Core dipenderà dalla decisione tra le piattaforme Arduino Nano ESP32+SX1262 e XIAO ESP32-S3+Wio-SX1262 (Fase 2 sopra) — il diagramma mostra l'intento architetturale, non un fatto già deciso.

##### 13. Decisione preliminare

**Proposal**: mantenere ARALD Watch come possibile estensione della ARALD Card, ma non congelare ancora una specifica hardware indipendente. Principio progettuale: **un Core ARALD personale, più form factor possibili** — con la prima decisione da validare essendo quale piattaforma elettronica debba costituire questo Core. Il vincolo dimensionale del Watch rappresenta un motivo concreto per rivalutare XIAO ESP32-S3+Wio-SX1262 come possibile piattaforma comune, senza ignorare il rischio di certificazione CERT-002.

Prima di costruire il Watch devono essere superati due gate: **(1) Hardware/RF** — validazione della piattaforma e dei requisiti di certificazione wearable; **(2) Energia/Product** — verifica che display e altre funzioni aggiuntive siano compatibili con il target di autonomia della Card. Infine, va effettuato un confronto preliminare con la soluzione Card + cinturino, baseline a costo e complessità minimi.

Il Watch va quindi sviluppato solo se le funzioni aggiuntive — in particolare display, feedback aptico e/o GPS — dimostrano un valore operativo che giustifichi il maggiore costo e la maggiore complessità rispetto alla Card indossabile.

## Repository confrontati finora

- [Crosstalk-Solutions/project-nomad](https://github.com/Crosstalk-Solutions/project-nomad) — il progetto NOMAD esterno a cui ARALD si ispira per il ruolo di "service provider" locale (vedi `docs/reuse-vs-new.md`). Nessun automatismo attivo: si ri-analizza solo quando l'utente lo chiede esplicitamente.
- [NawfalMotii79/PLFM_RADAR](https://github.com/NawfalMotii79/PLFM_RADAR) — radar phased-array open source; dominio troppo distante da ARALD (rilevamento RF attivo vs. rete mesh di comunicazione passiva) per feature dirette, solo lo spunto di licenza sopra.
