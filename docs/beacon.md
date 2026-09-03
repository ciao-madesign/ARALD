# NOMAD-NET BEACON — sistema di richiesta di soccorso a bassissimo consumo

**Stato**: documentazione di riferimento/pianificazione, v0.1 — **nessun codice scritto**. Proposta ricevuta dall'utente il 3 settembre 2026, analizzata e discussa prima di essere integrata qui. Stesso trattamento già riservato a **NOMAD-NET BOX e PORTABLE** (`docs/deployment.md`): un terzo ramo/espansione del progetto, non parte della specifica originale (`docs/SPECIFICATION.md`) né della roadmap (`docs/roadmap.md`), che descrive un dispositivo fisico dedicato invece di una feature del software di rete.

## Cos'è e cosa non è

Un piccolo dispositivo fisico a batteria, con una sola funzione: **premendo un pulsante, chiedere aiuto**, anche in totale assenza di rete cellulare, Wi-Fi, Internet, smartphone o SIM. Il messaggio raggiunge la mesh Nomad-Net tramite uno o più relay (smartphone con l'app NOMAD, o nodi fissi) e arriva infine a un **Emergency Node** (es. presso un rifugio), dove un operatore umano lo vede e può rispondere.

Non è un dispositivo general-purpose: niente navigazione, chiamate, audio, tracciamento continuo. Questo vincolo è anche ciò che rende il dispositivo economico e a bassissimo consumo (mesi/anni di standby, non giorni) — un requisito di progetto, non solo un'ottimizzazione.

**Tre ruoli distinti, hardware diverso per ciascuno** (principio esplicito della proposta, coerente con la separazione già usata nel resto del progetto tra "gateway come funzione software" e hardware dedicato, `docs/deployment.md` §8/§86):

| Ruolo | Cosa fa | Hardware tipico |
|---|---|---|
| **Beacon** | Genera l'emergenza | MCU ultra-low-power + radio (BLE e/o LoRa) + pulsante + LED — pochi euro, nessun sistema operativo generico |
| **Relay** | Trasporta l'emergenza | Smartphone con l'app NOMAD (modalità "NOMAD Relay"), o un nodo fisso Nomad-Net qualunque |
| **Emergency Node** | Riceve, gestisce, presenta l'emergenza a un operatore | Un nodo Nomad-Net normale (Orange Pi, mini-PC, smartphone del rifugista) con un ruolo software in più |

## Relazione con Nomad-Net: molto più riuso che lavoro nuovo

A differenza di BOX/PORTABLE (che confeziona *Project NOMAD*, un progetto esterno di cui questo repository non ha il sorgente), BEACON è per la sua parte "Relay"/"Emergency Node" **quasi interamente costruibile sopra l'infrastruttura Nomad-Net già esistente**. La proposta originale (vedi cronologia sessione) elenca una serie di requisiti che, verificati contro `node/src/`, risultano già soddisfatti da meccanismi generali del progetto, non da costruire da zero:

| Requisito della proposta (§ del documento originale) | Meccanismo Nomad-Net già esistente |
|---|---|
| Priorità massima per l'emergenza, la rete congestionata deve darle precedenza (§15) | `Priority.EMERGENCY` (`node/src/packet.ts`) — già usato da `service://emergency-news` (voce #39) e dai drop urgenti della Bacheca (voce #47), instradato con scheduling reale per priorità (`priority-queue.ts`, voce #4) |
| Identità crittografica per beacon, firma di ogni messaggio, anti-forgery (§5, §12) | `Identity` Ed25519 (`node/src/identity.ts`) — stesso schema firma/verifica già usato per contenuti (`content.ts`), servizi (`service.ts`), canali (`public-channels.ts`), gruppi (`groups.ts`) |
| Deduplicazione, "se Relay B riceve lo stesso messaggio 5 volte non lo ripropaga indefinitamente" (§6) | `SeenCache` (`node/src/routing.ts`) — dedup per id di pacchetto, cuore del controlled flooding già in produzione |
| Store-and-forward quando il prossimo hop non è raggiungibile (§6, §7) | `store-and-forward.ts` — coda per pacchetti unicast non consegnabili subito |
| Rate limiting anti-flood ("100.000 falsi EMERGENCY", §12) | `rate-limit.ts` (budget per peer/finestra) + il pattern già usato da `service://emergency-news` (`MAX_EMERGENCY_ANNOUNCES_PER_SYNC`, voce #39) e dai drop urgenti (`MAX_URGENT_DROPS_PER_WINDOW`, voce #47) per limitare *l'origine* di un annuncio a priorità EMERGENCY, non solo la ricezione |
| Trust levels, revoca di un dispositivo compromesso (§5, §12) | `trust.ts` (`TrustLevel`/`TrustManager`) |
| Radio BLE e/o LoRa a basso consumo per il collegamento fisico (§3, §16) | `transports/ble.ts` e `transports/lora.ts` (voce #51) — **entrambi simulati**, nessun hardware radio reale disponibile in questo ambiente, ma l'astrazione `Transport` e la logica di connessione/frammentazione (`transports/simulated-link.ts`) sono già pronte e testate |
| Smartphone come relay opportunistico che scansiona, verifica, inoltra (§8) | Concettualmente vicino a un nodo Nomad-Net BLE-connesso esistente — serve però una modalità di scan *senza connessione stabile* (BLE advertising grezzo), diversa dal transport BLE simulato attuale che assume un link punto-a-punto già stabilito (vedi "Cosa manca" sotto) |
| Messaggio breve, campi fissi (TYPE/ID/SEQ/TIME/BATTERY/LOCATION/FLAGS/SIGNATURE, §4) | Pattern già in uso per payload firmati compatti — vedi `extractDropPayload()`/`extractLocationReport()` in `drops.ts`/`location-registry.ts`, stesso schema di validazione difensiva del payload |
| Conferma bidirezionale (ACK, "richiesta ricevuta dalla rete", §7, §11) | Vicino a `PRIVATE_MESSAGE` unicast (già usato per gli inviti di gruppo, `groups.ts`) più il pattern richiesta/risposta di `service.ts` |
| Posizione: da beacon GPS, da relay, o da nodo fisso con posizione nota (§9) | `location-registry.ts` (voce #44) copre già il caso "posizione condivisa opportunisticamente" — con la stessa distinzione già presente lì tra "posizione di chi riporta" e "posizione del soggetto", rilevante qui per non confondere "posizione del beacon" con "posizione del relay" (esplicitamente richiesto al §9 della proposta) |

## Cosa manca davvero (lavoro nuovo, ma in buona parte in puro software)

1. **Un formato di messaggio "beacon" dedicato** — probabilmente un nuovo `MessageType` (es. `EMERGENCY_BEACON`) o, seguendo il precedente di drop/canali (voci #40/#47), una convenzione sopra un meccanismo esistente. Da decidere in fase di design, non ancora fatto.
2. **Un ruolo "Relay opportunistico" senza connessione stabile** — il transport BLE simulato attuale (`transports/ble.ts`) modella un link punto-a-punto con handshake, adatto a un nodo-nodo Nomad-Net pieno. Un vero beacon BLE userebbe *advertising* broadcast non connesso (niente handshake, pacchetto ripetuto periodicamente finché non arriva un ACK) — un modello di trasporto diverso da quello che esiste oggi, anche nella sua forma simulata.
3. **Un "Emergency Node" software** — una vista/servizio dedicato (verosimilmente un'estensione di `web-ui.ts`, sullo schema già usato da `location-registry.ts`: opt-in, endpoint autenticato) che mostra all'operatore beacon ricevuti, percorso, battery, permette ACK/risposta. Non esiste oggi.
4. **Anti-flood specifico per un'identità beacon usa-e-getta** — lo stesso problema già affrontato per l'eviction pesata sulla fiducia (`BoundedFifoMap`, voce #3) e per gli annunci EMERGENCY auto-generati (voci #39/#47), da applicare a un beacon che non ha mai avuto una connessione TCP/mesh precedente su cui costruire fiducia.
5. **Falso allarme / procedura di conferma pressione (§14)**, **cancellazione autenticata (§14)**, **firmware firmato / secure boot (§12)** — questi sono requisiti che vivono nel firmware del beacon stesso, non nel software Nomad-Net: fuori scope per questo repository indipendentemente da tutto il resto.

## Cosa NON è costruibile in questo ambiente (hardware reale)

Come per BOX/PORTABLE, tutto ciò che richiede hardware fisico resta bloccato su un prerequisito esterno, non pianificabile qui:

- MCU/chip radio reali (ESP32, nRF52/nRF53/nRF54, o un MCU con LoRa dedicato) — scelta hardware ancora aperta nella proposta originale (§20, "prossimo passo: hardware"), esplicitamente rimandata dall'utente.
- GPS on-beacon, batteria, enclosure, antenna, certificazioni (varianti EB-GPS/EB-Dual, §17).
- Firmware firmato e secure boot (§12) — dipendono dall'MCU scelto.
- Qualunque validazione "vera" di consumo energetico (mesi/anni di standby, §16) — misurabile solo su hardware reale.

Il transport BLE/LoRa **simulato** già presente in questo repository (voce #8, #51) resta comunque utile: valida la logica di routing/priorità/firma sopra un link a pacchetti piccoli e ad alta latenza, esattamente il tipo di vincolo che un vero beacon avrebbe — ma non sostituisce il hardware reale, come già vero per BLE dal 2026.

## MVP proposto (dalla specifica originale, §18)

La proposta stessa suggerisce di partire da **EB-BLE** (solo BLE, niente LoRa/GPS) per validare l'intero concetto prima della parte RF a lunga distanza:

```
[PULSANTE] → Emergency packet → BLE → Android NOMAD Relay → NOMAD-Net → Emergency Node → Dashboard operatore
```

Per questo repository, l'MVP realisticamente costruibile in puro software (nessun hardware fisico) sarebbe una versione **completamente simulata** del beacon stesso — analoga a come BLE/LoRa sono transport simulati oggi — più il ruolo Emergency Node lato server. Non ancora pianificato in dettaglio: richiede prima le decisioni di design ai punti 1-2 sopra (formato messaggio, modello di trasporto broadcast-non-connesso), che a loro volta meritano una discussione esplicita con l'utente prima del codice, per lo stesso motivo già seguito per il tracciamento posizione (voce #44) e le chat cifrate (voce #42): qui la sicurezza (anti-forgery, anti-flood, anti-replay su un'identità che chiunque potrebbe fabbricare) è più delicata della messaggistica ordinaria.

## Evoluzione prevista (invariata dalla proposta originale, §17/§19)

| Versione | Radio | Uso |
|---|---|---|
| EB-BLE | BLE | economico, urbano/rifugi |
| EB-LoRa | LoRa | escursionismo/outdoor |
| EB-Dual | BLE + LoRa | versione completa |
| EB-GPS | BLE + LoRa + GPS | emergenza con posizione autonoma |

Candidata finale della proposta: **EB-Dual**, senza partire subito da quella — stesso approccio incrementale già seguito per BOX/PORTABLE e per ogni slice di questo progetto.

## Prossimo passo

Nessun codice scritto per questa voce. Se e quando l'utente vorrà procedere, il primo passo concreto sarebbe una fase di planning esplicita (analoga a quella già fatta per il tracciamento posizione, voce #44, e per le chat cifrate, voce #42) per fissare: formato del messaggio beacon, modello di trasporto broadcast-non-connesso per il ruolo Relay, e ambito dell'MVP simulato — prima di scrivere qualunque riga di codice, seguendo lo stesso workflow a doppio check descritto in `CLAUDE.md`.
