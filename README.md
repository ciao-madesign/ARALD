# Nomad-Net

Rete distribuita, content-centric e delay-tolerant per emergenze, rifugi alpini e ambienti senza connettività.

Nomad-Net permette a dispositivi mobili e nodi edge di condividere comunicazioni, contenuti e servizi senza infrastruttura Internet — mesh locali, store-and-forward, caching opportunistico, replica distribuita e gateway intermittenti verso Internet — sincronizzandosi automaticamente quando una connessione esterna diventa disponibile.

```
GET content://wikipedia/italia
```

L'utente non deve sapere quale dispositivo possiede il contenuto, quanti hop servono, o se è raggiungibile in questo momento: la rete lo determina da sola.

## Documentazione

- [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) — specifica progettuale completa (single source of truth)
- [`docs/reuse-vs-new.md`](docs/reuse-vs-new.md) — cosa si riusa da Project NOMAD / BitChat e cosa va sviluppato ex novo
- [`docs/architecture.md`](docs/architecture.md) — architettura a livelli, ruoli dei componenti
- [`docs/protocol.md`](docs/protocol.md) — formato pacchetto, tipi di messaggio, content ID
- [`docs/transport.md`](docs/transport.md) — astrazione di trasporto, TCP/BLE/Wi-Fi, vincoli iOS/Android
- [`docs/security.md`](docs/security.md) — identità, integrità dei contenuti, cosa manca ancora
- [`docs/development.md`](docs/development.md) — come compilare, eseguire e testare
- [`docs/deployment.md`](docs/deployment.md) — scenari di deployment target (rifugio, emergenza)
- [`docs/beacon.md`](docs/beacon.md) — NOMAD-NET BEACON: espansione proposta, dispositivo fisico di richiesta di soccorso a bassissimo consumo, più NOMAD Mobile Relay, Fixed Relay/Relay Registry e una nota sulla conformità normativa UE (RED, ETSI EN 300 328/300 220, CE) per un'eventuale commercializzazione futura — documentazione di riferimento, nessun codice ancora
- [`docs/emergency-rescue-network.md`](docs/emergency-rescue-network.md) — NOMAD-Net Emergency & Rescue Network: roadmap di validazione a fasi (prototipo, micro pilot, field pilot), effetto di rete/densità e livelli di partecipazione, e possibili partner di campo per l'ecosistema Beacon/Relay — documentazione di riferimento, nessun codice né hardware
- [`docs/roadmap.md`](docs/roadmap.md) — stato delle milestone
- [`docs/next-steps.md`](docs/next-steps.md) — piani d'azione concreti per le milestone candidate come prossimo passo
- [`docs/audit-report.html`](docs/audit-report.html) — report di verifica del progetto (test, sicurezza, prossimi passi in linguaggio semplice), aggiornato a ogni nuovo controllo

## Stato del progetto

Prototipo software con le Milestone 0-7, 12, 13, 15, 16, 20 della roadmap complete: identità crittografica per nodo, protocollo a pacchetti con TTL e deduplicazione, transport TCP, routing multi-hop (controlled flooding + routing a costo distance-vector per il traffico unicast), content discovery e cache, store-and-forward, sincronizzazione dei cataloghi tra segmenti di rete riconnessi, firma dei contenuti, trust levels, rate limiting, cifratura end-to-end dei messaggi privati, relay policy legata a batteria/carica, simulatore di rete a scala — tutto dimostrato su rete locale reale (TCP), senza Internet.

Dopo un audit tecnico completo (vedi [`docs/audit-report.html`](docs/audit-report.html)) sono state realizzate 10 voci più diversi follow-up su richiesta esplicita dell'utente — dettaglio completo in [`docs/security.md`](docs/security.md): retry sui content provider, struttura dati limitata condivisa, eviction pesata sulla fiducia, scheduling reale per priorità, `CONTENT_NOT_FOUND` + scadenza dei contenuti, service discovery, un'interfaccia web locale di stato/ricerca (`node/src/web-ui.ts`), un transport BLE **simulato** (nessun radio reale), un gateway NOMAD **mockato** con tre sotto-servizi — Kiwix (`service://kiwix-search`), AI (`service://ai`, spec §37) e news (`service://news`) — contro server fittizi locali, un'**app mobile** (`mobile/`, Capacitor) verso quel gateway con pairing in stile Wi-Fi (nome rete + password, anche via QR code), e una dashboard mobile in stile "motore di ricerca" con collegamenti rapidi ai servizi. Tutto verificato con test automatici ripetuti e più passate di code-review (bug reali trovati e corretti a ogni voce, documentati in `docs/security.md`).

**Cosa resta bloccato**: le versioni **hardware/Docker reali** di BLE e del gateway NOMAD (serve rispettivamente hardware BLE fisico e Docker + un'istanza Project NOMAD raggiungibile) — le loro controparti simulate/mockate sopra hanno comunque validato tutta la logica applicativa in puro software. **Espansioni proposte, solo documentazione**: NOMAD-NET BOX/PORTABLE (`docs/deployment.md`) e NOMAD-NET BEACON (`docs/beacon.md`, dispositivo di richiesta soccorso a bassissimo consumo, più il NOMAD Mobile Relay, un dispositivo "data mule" di trasporto opportunistico) — nessun codice ancora, tutte richiedono hardware fisico non disponibile in questo ambiente per le parti che vanno oltre la logica applicativa già coperta dal software esistente. **Debito di design della UI mobile: affrontato** — una passata di rebrand completa ("Waypoint", palette topografica, marchio, componenti) più una passata UX dedicata per un pubblico generico e non tecnico sono già state realizzate (vedi `docs/security.md`, voci #28-31 e #48); resta annotato solo un possibile restyling grafico futuro per un aspetto più moderno, non ancora pianificato in dettaglio. Vedi [`docs/roadmap.md`](docs/roadmap.md) per lo stato dettagliato di ogni milestone e [`docs/next-steps.md`](docs/next-steps.md) per i piani d'azione.

## Quick start

```bash
npm install
npm test
```

Avviare un nodo:

```bash
npm run dev -w node -- --id A --port 9001
```

Vedi [`docs/development.md`](docs/development.md) per il flusso completo (multi-nodo, build, test).

## Struttura della repository

```
nomad-net/
+-- docs/         specifica e documentazione tecnica
+-- protocol/     definizioni di protocollo condivise — segnaposto, non contiene codice reale
+-- node/         nomad-node: il runtime di rete (identity, routing, content, transport, web UI) — unico package nel workspace npm
+-- gateway/nomad/ traduzione Nomad-Net <-> Project NOMAD (Kiwix/Ollama/news) — mockata contro server fittizi locali, progetto separato
+-- mobile/       app Capacitor verso un gateway (Wi-Fi/TCP, Passo 1) — verificata via browser, build Android nativa non compilabile in questo ambiente; iOS ancora segnaposto
+-- tests/        unit, integration, network
+-- tools/        simulatore di rete (tools/simulator/)
```

Struttura di riferimento completa: [`docs/SPECIFICATION.md` §87](docs/SPECIFICATION.md#87-struttura-della-repository-finale).

## Riferimenti principali

- Project N.O.M.A.D. — https://github.com/Crosstalk-Solutions/project-nomad
- BitChat — https://github.com/permissionlesstech/bitchat ([whitepaper](https://github.com/permissionlesstech/bitchat/blob/main/WHITEPAPER.md))
- Apple Core Bluetooth — https://developer.apple.com/documentation/corebluetooth
- Android Bluetooth permissions — https://developer.android.com/develop/connectivity/bluetooth/bt-permissions

## Licenza

[MIT](LICENSE)
