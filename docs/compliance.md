# ARALD — specifica di progettazione orientata alla conformità

**Provenienza**: testo fornito integralmente dall'utente l'8 settembre 2026 ("ARALD — Specifica di progettazione orientata alla conformità", 23 punti), adattato qui alla situazione reale del progetto — nessuna verifica indipendente delle citazioni normative specifiche in questa sessione (nessun accesso a internet reale), stessa cautela già dichiarata in `docs/beacon.md` §"Conformità normativa e sicurezza (UE)" per informazioni istituzionali/hardware non verificabili qui.

**Cosa NON è questo documento**: non è una certificazione, non è una dichiarazione di conformità, non descrive hardware già costruito. È un **metodo di progettazione** da seguire quando (e se) il bring-up fisico della ARALD Card/Clip/Fixed Relay inizierà — lavoro esplicitamente privato dell'utente, mai documentato come procedimento in questo repository (vedi `CLAUDE.md`, "Priorità per chi riprende questo lavoro"). Questo documento esiste per avere la struttura e il metodo pronti **prima** che quel lavoro inizi, non per raccontarlo mentre avviene.

**Relazione con `docs/beacon.md`**: quel documento resta la fonte per cos'è l'ecosistema ARALD Card/Clip/Fixed Relay e il suo stato reale (nessun hardware costruito, vedi la sua sezione "Cosa NON è costruibile in questo ambiente"); questo documento è il metodo/processo da applicare quando quello stato cambierà. La sezione "Conformità normativa e sicurezza (UE)" di `docs/beacon.md` resta la fonte per il **quadro normativo** (RED 2014/53/UE, ETSI EN 300 328/300 220, RoHS/RAEE) — qui non ripetuto, solo referenziato dove serve.

## 1. Obiettivi di design

Ogni decisione hardware/RF di questo progetto (quando comincerà) dovrebbe essere valutata su quattro assi, in quest'ordine:

1. **Funzionalità** — il dispositivo fa quello che deve fare (mesh, radio, alimentazione).
2. **Robustezza** — funziona in condizioni di campo reali (montagna, emergenza), non solo in laboratorio.
3. **Testabilità** — è possibile misurare/verificare il comportamento RF con strumenti ripetibili.
4. **Compliance-by-design** — la conformità normativa (RED/CE) è considerata da subito, non aggiunta a posteriori sul prodotto finito.

Il punto 4 è il motivo di questo documento: evitare che scelte prese "per far funzionare il prototipo" (antenna improvvisata, layout PCB senza considerazioni RF, parametri radio hard-coded) diventino un ostacolo costoso da disfare quando si arriverà a una valutazione di conformità.

## 2. Architettura ARALD Card: un solo PCB

**Non sviluppare due PCB differenti salvo necessità tecnica dimostrata.** Le configurazioni **Standalone** e **Clip** (vedi `docs/beacon.md`, "ARALD Cover e ARALD Clip") condividono lo stesso PCB — la differenza è meccanica (involucro) e di firmware (quale profilo attivo), non elettrica. Due PCB distinti raddoppierebbero il lavoro di validazione RF/EMC senza un motivo tecnico che oggi non esiste.

## 3. Documentazione dei componenti radio

Ogni modulo radio usato (reale o candidato) va documentato con gli stessi campi, indipendentemente dal fornitore:

- **LoRa (banda EU868)**: frequenze/canali effettivamente usati, potenza di trasmissione, larghezza di banda, spreading factor, coding rate, duty-cycle applicato (vedi la nota già in `docs/beacon.md` sulla necessità di scegliere la sotto-banda EN 300 220-2 corretta, non ancora fatta).
- **BLE**: chipset e versione dello stack Bluetooth, potenza di trasmissione, canali usati, tipo di antenna.

Il primo driver LoRa reale del progetto (`node/src/transports/lora-serial.ts`) parla con il chip via bridge seriale, mai via SPI/GPIO diretto — questo documento riguarda la parte RF/hardware a monte di quel driver (il modulo radio stesso, la sua antenna, il suo layout), non il protocollo software del bridge.

## 4. L'antenna è un progetto RF, non un accessorio

Va trattata con lo stesso rigore ingegneristico del resto del circuito RF: impedenza, rete di adattamento (matching network), traccia RF, piano di massa, zona di clearance, distanze da batteria/componenti digitali/involucro. Un'antenna scelta o posizionata "perché ci stava" è la causa più comune di problemi RF/EMC scoperti tardi.

## 5. ARALD Clip: l'ambiente RF è lo smartphone

Quando la Card opera in configurazione Clip (agganciata a un telefono), l'ambiente RF intorno all'antenna cambia: lo smartphone stesso (schermo, batteria, telaio metallico) diventa parte del sistema RF, non un contenitore neutro. Va definita e rispettata una **RF Clearance Area** — nessun metallo, magnete o vite metallica vicino all'antenna entro la zona definita dal progetto RF.

## 6. Materiale prototipo Clip

Per i prototipi: stampa 3D in PLA, con uno spaziatore dielettrico di 1–3 mm tra antenna e telefono — valore di partenza, da affinare sperimentalmente (misure reali, non solo calcolo), non un numero definitivo.

## 7. Documentazione batteria

Va documentata anche dal punto di vista RF/EMC/sicurezza, non solo capacità/autonomia: la batteria è tra i componenti da tenere a distanza dall'antenna (punto 5) ed è soggetta a requisiti di sicurezza propri (RoHS/batterie, già citati in `docs/beacon.md`).

## 8. Layout PCB RF/EMC e punti di test

Il layout PCB va progettato considerando RF/EMC fin dall'inizio (non solo densità/costo dei componenti), con punti di test accessibili per misure ripetibili (RSSI, potenza irradiata, verifica del matching network) senza dover disassemblare il dispositivo.

## 9. Parametri radio firmware: centralizzati e versionati

I parametri radio (potenza, canali, duty-cycle, spreading factor, ecc.) non vanno sparsi nel codice firmware come costanti isolate — un unico punto di configurazione, versionato, con almeno due profili distinti: **sviluppo** (permissivo, per test in laboratorio) e **produzione** (conforme ai limiti normativi della banda/regione target). Stesso principio già seguito nel software esistente per parametri sensibili (es. `NomadNodeOptions` centralizza le opzioni di `node.ts` invece di sparse costanti globali) — qui applicato al firmware radio, non ancora scritto.

## 10. Considerazioni EMC

Compatibilità elettromagnetica: emissioni irradiate/condotte, immunità a interferenze esterne — da considerare nel layout (punto 8) e verificare nel protocollo di test (punto 11), non solo alla fine.

## 11. L'involucro è parte del sistema RF

Il case/involucro (ARALD Box, Portable, Clip, Fixed Relay) non è neutro dal punto di vista RF — materiale, spessore, presenza di parti metalliche influenzano propagazione e schermatura. Va documentato come parte del sistema, non separatamente.

## 12. Protocollo di test RF

Quattro configurazioni di misura, incrementali:

- **Test A** — Card da sola (banco di prova, nessun involucro/telefono).
- **Test B** — Card + cover/involucro.
- **Test C** — Card + cover + telefono (configurazione Clip reale).
- **Test D** — varianti di configurazione (posizione, orientamento, distanza dal corpo).

Metriche per ciascun test: RSSI, SNR, packet loss, portata, stabilità nel tempo. Nota di coordinamento: `docs/test-protocol.md` definisce già un protocollo di test tecnico a fasi (0-8, T-number, KPI) per la validazione di rete nel suo insieme — i Test A-D qui sono un livello più basso (RF del singolo dispositivo, prerequisito implicito prima che abbia senso misurare la rete), non un doppione.

## 13. Fase di pre-compliance

Prima del Design Freeze (punto 15): una fase esplicita di test pre-compliance (misure indicative, non ancora test di laboratorio accreditato) per intercettare problemi RF/EMC macroscopici quando sono ancora economici da correggere.

## 14. Schema di versioning

Ogni combinazione HW+FW+RF+Antenna+Involucro va versionata esplicitamente insieme, non i singoli componenti separatamente — esempio dal testo originale:

```
HW: Rev B / FW: 0.7.2 / RF: EU868-03 / ANT: ANT-02 / CASE: Clip Rev A
```

Coerente con la convenzione già in uso per il codice software di questo progetto (numerazione voci in `docs/security.md`, versioning Node/npm) — qui estesa a hardware/RF/firmware/involucro insieme, perché un cambio isolato di uno solo di questi elementi può invalidare la caratterizzazione RF fatta sulla combinazione precedente.

## 15. Technical File — struttura scaffoldata, contenuto da popolare

Struttura di directory creata fin da subito sotto `docs/compliance/` (vedi elenco sotto), anche se la maggior parte dei file resterà vuota/assente finché non esisterà hardware reale — esattamente come richiesto dal testo originale ("non è necessario che tutti i file siano presenti immediatamente, la struttura deve però esistere fin dall'inizio"):

```
docs/compliance/
├─ hardware/
│  ├─ schematics/
│  ├─ pcb/
│  ├─ bom/
│  └─ datasheets/
├─ radio/
│  ├─ lora/
│  ├─ ble/
│  ├─ antennas/
│  └─ rf_parameters/
├─ firmware/
├─ enclosure/
├─ testing/
│  ├─ rf/
│  ├─ emc/
│  └─ safety/
├─ risk_assessment/
├─ applicable_standards/
└─ declaration_of_conformity/
```

Ogni cartella contiene per ora solo un `README.md` segnaposto che spiega cosa dovrà finire lì.

## 16. Registro Risk Assessment

Formato tabellare: `ID | Rischio | Probabilità | Impatto | Mitigazione | Stato`. Esempio di righe iniziali (dal testo originale, come punto di partenza — non un'analisi già fatta):

| ID | Rischio | Probabilità | Impatto | Mitigazione | Stato |
|---|---|---|---|---|---|
| RF-001 | Antenna disadattata (impedenza non verificata) | Media | Alto (portata ridotta, possibile non conformità EMC) | Progetto antenna dedicato + misura matching network in fase di test | Aperto |
| BAT-001 | Batteria vicina all'antenna oltre la clearance minima | Media | Medio (degrado RF, possibile rischio sicurezza) | Rispetto della RF Clearance Area (punto 5) fin dal layout PCB | Aperto |

Il registro vive in `docs/compliance/risk_assessment/` quando avrà contenuto reale — questa tabella resta solo l'esempio/punto di partenza indicato dal testo originale.

## 17. Classificazione dei requisiti: MUST / SHOULD / TEST

Ogni requisito di questo documento (e di quelli che lo popoleranno) va etichettato:

- **MUST** — vincolante, non negoziabile senza una revisione esplicita del design.
- **SHOULD** — raccomandato, deviazioni possibili se motivate e documentate.
- **TEST** — non un vincolo di design ma un punto di verifica misurabile (va controllato, non "rispettato" in astratto).

Non applicato retroattivamente ai punti 1-14 sopra (sono la trascrizione del testo originale, non ancora riclassificati) — da fare quando si passerà dalla metodologia generale a requisiti specifici di un design reale.

## 18. Governance del Design Freeze

**Cosa va congelato** prima di procedere a test di conformità reali: PCB, componenti, BOM, antenna, parametri RF, firmware, involucro, batteria, alimentazione, configurazione BLE, configurazione LoRa.

**Regola permanente**: qualunque modifica post-freeze ad antenna, modulo radio, PCB, alimentazione, firmware radio, involucro o batteria deve attivare una valutazione d'impatto esplicita — mai un cambio silenzioso "tanto è una modifica piccola". Stesso principio già in uso nel software di questo progetto per i cambi post-freeze di un protocollo versionato, applicato qui all'hardware.

## 19. Roadmap M0 → M9

Fasi previste (nessuna iniziata — bring-up fisico è lavoro privato dell'utente, vedi `CLAUDE.md`):

| Fase | Contenuto |
|---|---|
| M0-M2 | Architettura (schema a blocchi, scelta componenti, PCB singolo per Standalone/Clip) |
| M2-M4 | Primo hardware (prototipo funzionante, non ancora ottimizzato RF) |
| M4-M5 | Ottimizzazione RF (antenna, matching network, layout) |
| M5-M6 | Integrazione Clip (RF Clearance Area, materiali, spaziatore dielettrico) |
| M6-M7 | Test RF/EMC (protocollo Test A-D, punto 12) |
| M7-M8 | Correzioni sulla base dei risultati di test |
| M8-M9 | Design Freeze |

**Output di M9**: "ARALD Card/Clip Candidate for Compliance Testing" — una piattaforma funzionante, documentata, riproducibile, progettata in modo da poter affrontare una valutazione di conformità senza un ridisegno sostanziale. **Non** è la certificazione stessa, che resta uno stadio successivo non pianificato qui (stessa distinzione già fatta in `docs/beacon.md` tra Prototype/Field Pilot/Commercial product).

## 20. ARALD Box e ARALD Portable: stesso principio

Anche se l'hardware sottostante è diverso (Box = Orange Pi + NVMe + LoRa; Portable = PC + storage + modulo LoRa + software ARALD), entrambi sono "nodi ARALD completi" nello stesso senso — il principio di compliance-by-design di questo documento si applica identicamente a entrambi quando arriverà il loro turno, non solo alla Card/Clip.

## 21. Domanda standard per ogni decisione RF/hardware

Per ogni decisione su antenna, PCB, batteria, alimentazione, involucro, firmware radio o comunicazioni, la domanda da porsi esplicitamente è:

> **Questa soluzione funziona soltanto nel prototipo, oppure è una soluzione che possiamo ragionevolmente portare fino al prodotto commerciale?**

Se la risposta è "solo nel prototipo", va marcata esplicitamente come provvisoria (non lasciata implicita) — stesso principio di onestà già applicato ovunque in questo progetto per lo stato "simulato vs reale" (es. `docs/next-steps.md`, marcatura sistematica "✅ fatta (simulata)" vs "bloccata su hardware reale").

## 22. Criterio di successo per M9

Una piattaforma funzionante, documentata, riproducibile — progettata in modo da poter andare a valutazione di conformità **senza** un ridisegno sostanziale. Non è la certificazione stessa (quella arriva dopo, come iter separato).

## Stato attuale

**M0 non ancora iniziato.** Nessun hardware ARALD Card/Clip/Fixed Relay/Box/Portable esiste fisicamente in questo momento (vedi `docs/beacon.md`, "Cosa NON è costruibile in questo ambiente"). Questo documento è pronto per quando il bring-up fisico comincerà — lavoro privato dell'utente, mai da documentare qui come procedimento passo-passo, solo nei risultati (vedi `CLAUDE.md`).
