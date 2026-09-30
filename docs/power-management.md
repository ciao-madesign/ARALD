# Gestione alimentazione e blackout (UPS)

Specifica per il comportamento di un nodo ARALD (in particolare **ARALD Box**/**Fixed Relay** alimentati a rete, non a batteria integrata come Card/Portable) durante un'interruzione dell'alimentazione esterna, coperta da un piccolo UPS 5 V. Proposta hardware ricevuta dall'utente il 30 settembre 2026, valutata contro il codice esistente e integrata qui come specifica — **non ancora implementata**, vedi "Stato" in fondo.

**Principio guida**: l'UPS deve essere il più possibile trasparente ad ARALD. Il nodo continua a funzionare normalmente durante un blackout; se può rilevare il passaggio a batteria, riduce solo le attività non essenziali — se non può rilevarlo, non servono altri meccanismi, il nodo continua fino all'esaurimento dell'UPS. Gestione **semplice e low-cost** per design: nessuna percentuale di carica, nessuna stima di autonomia, nessuno sleep, nessuno shutdown preventivo nella V1.

## Caso A — il nodo può distinguere rete esterna da batteria

Richiede che l'UPS esponga un segnale distinguibile (vedi "Opzioni hardware future" sotto) — non garantito dal modulo UPS scelto.

**Alimentazione esterna presente**: il nodo opera normalmente (comportamento di oggi, invariato).

**Passaggio a batteria**: il nodo passa a **BACKUP MODE** senza interrompere il servizio:
- LoRa, Wi-Fi/BLE, rete mesh, SOS e messaggi restano **tutti operativi**, senza eccezioni;
- le attività non essenziali che comportano scritture intensive sullo storage vengono sospese/ridotte;
- eventuali operazioni di manutenzione/aggiornamento vengono rimandate;
- l'evento di perdita dell'alimentazione esterna viene registrato.

Nessuno shutdown automatico all'ingresso in BACKUP MODE.

**Ritorno dell'alimentazione**: il nodo rileva il ritorno, riattiva le attività sospese, registra l'evento, torna a **NORMAL MODE**.

**Batteria dell'UPS esaurita prima del ritorno della rete**: il nodo viene spento dall'UPS stesso, non da ARALD — nessuno shutdown preventivo basato su percentuale di batteria nella V1. Conseguenza accettata: possibile perdita delle ultime operazioni non ancora persistite, rischio minimo di corruzione filesystem/database (mitigato dalla normale gestione Linux/filesystem, non da logica applicativa dedicata).

## Caso B — il nodo non può distinguere rete esterna da batteria

Se l'UPS espone semplicemente 5 V verso il nodo senza alcun segnale aggiuntivo (il caso più comune ed economico), il nodo vede solo "5 V presenti" sia con alimentazione esterna sia a batteria — **non può implementare BACKUP MODE**, per mancanza di un'informazione, non per un limite del software.

Il nodo continua quindi a funzionare normalmente fino allo spegnimento causato dall'esaurimento dell'UPS — comportamento comunque pienamente funzionale, solo senza le precauzioni aggiuntive di BACKUP MODE.

**Per la V1, il Caso B è perfettamente accettabile**: non richiede alcun codice nuovo, è già compatibile con l'architettura esistente così com'è. Il rilevamento del Caso A resta un miglioramento futuro, mai una dipendenza architetturale.

## Cosa significa "attività non essenziali"/"scritture intensive" per ARALD oggi

Punto verificato contro il codice esistente al momento di scrivere questa specifica, non presente nella proposta originale: **`NomadNode` oggi persiste su disco quasi nulla**. Ogni struttura di stato della mesh (content cache, cataloghi, routing table, drop, beacon, ...) è interamente in-memory (`BoundedFifoMap`, `node/src/bounded-map.ts`), mai scritta su storage. L'unica scrittura reale è `node/src/identity.ts` (chiave privata del nodo), e solo *una tantum* al primo avvio — non un'attività ricorrente da poter sospendere.

Questo significa che "sospendere le scritture non essenziali" non ha oggi un bersaglio concreto nel codice — è **provisioning per un futuro** in cui il nodo persisterà più stato su storage reale (es. una cache contenuti su SSD, coerente col profilo hardware ARALD Box), non un comportamento da implementare adesso. Allo stesso modo, "manutenzione/aggiornamenti rimandati durante BACKUP MODE" non ha oggi un meccanismo di auto-update/manutenzione a cui applicarsi (nessun OTA, nessun riavvio automatico per aggiornamento in questo codebase) — è un vincolo da rispettare quando quel meccanismo esisterà, non un cambiamento di comportamento immediato.

**Cosa resterebbe davvero da implementare, quando si deciderà di procedere**, ridotto all'essenziale:
- Un segnale di stato alimentazione **self-declared** — stesso pattern già in uso per `--battery-percent`/`RelayPolicy.getResourceState()` (`node/src/relay-policy.ts`, `node/src/cli.ts`), non un nuovo sottosistema.
- Un evento locale emesso al cambio di stato (`node.emit(...)`, stesso pattern già usato in tutto il codebase per condizioni simili — `relay:reboot-requested`, `store-and-forward:queued`, ecc.) — puro segnale/log, non un cambio di comportamento di rete.
- "Nessuno shutdown automatico" e "LoRa/BLE/rete/SOS sempre attivi" sono **già** il comportamento di oggi per costruzione (nulla nel codice spegne il processo se non un comando esplicito, nulla disattiva un transport in base allo stato di alimentazione) — non richiedono alcun codice nuovo.

## Opzioni hardware future (solo se il Caso A diventa prioritario)

Nessuna decisione presa — puro riferimento per quando/se si vorrà implementare il Caso A:

1. **Rilevamento presenza alimentatore**: un piccolo circuito rileva i 5 V dell'alimentatore *prima* dell'UPS (HIGH→LOW alla perdita di rete) — l'approccio più semplice.
2. **Misurazione della batteria** (ADC sulla tensione di cella): più complesso, richiede interpretare tensione/carico/comportamento del circuito UPS specifico — non consigliato per la V1.
3. **UPS con telemetria propria** (espone già rete/batteria/batteria scarica): se in futuro si sceglierà un UPS di questo tipo, il nodo userebbe direttamente quell'informazione — nessun sensore aggiuntivo necessario.

## Specifica V1 consigliata

| Funzione | Requisito |
|---|---|
| Alimentazione normale | 5 V |
| Backup | UPS 5 V |
| Rilevazione rete persa | Opzionale (Caso A) — Caso B accettabile senza |
| Percentuale batteria | Non richiesta |
| Stima autonomia | Non richiesta |
| Sleep | Non richiesto |
| Shutdown preventivo | Non richiesto |
| LoRa/SOS/networking durante blackout | Sempre attivi |
| Scritture non essenziali | Ridotte/sospese solo se lo stato batteria è noto (Caso A) — oggi senza bersaglio concreto, vedi sopra |
| Aggiornamenti/manutenzione | Sospesi durante BACKUP MODE, quando esisterà un meccanismo di aggiornamento |
| Batteria UPS esaurita | Spegnimento a cura dell'UPS, accettato |
| Integrità filesystem | Mitigata dalla normale gestione Linux/filesystem, non da logica applicativa dedicata |
| Sensori aggiuntivi | Solo se necessari a rilevare il Caso A |

## Stato

**Non implementato.** Bloccato su una decisione hardware non ancora presa (quale modulo UPS, se espone o meno un segnale di stato) — stessa categoria di ogni altra milestone hardware-reale in `docs/roadmap.md`/`docs/next-steps.md`: nessun lavoro di bring-up fisico verrà mai dettagliato qui (convenzione `CLAUDE.md`), solo la specifica di comportamento software e, quando disponibili, i risultati.
