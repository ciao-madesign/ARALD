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
- [`docs/roadmap.md`](docs/roadmap.md) — stato delle milestone

## Stato del progetto

Prototipo software (Milestone 0-7 della roadmap): identità crittografica per nodo, protocollo a pacchetti con TTL e deduplicazione, transport TCP, routing multi-hop, content discovery e cache — tutto dimostrato su rete locale, **senza Internet e senza BLE**, per validare la logica di rete prima di introdurre i radio transport. Vedi [`docs/roadmap.md`](docs/roadmap.md) per lo stato dettagliato di ogni milestone.

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
+-- protocol/     definizioni di protocollo condivise (packet/content/service/sync) — segnaposto, vedi protocol/README.md
+-- node/         nomad-node: il runtime di rete (identity, routing, content, transport)
+-- gateway/      traduzione Nomad-Net <-> Project NOMAD / Internet — non ancora implementato
+-- mobile/       app Android/iOS — non ancora implementato
+-- tests/        unit, integration, network, dtn
+-- tools/        simulatore e benchmark — non ancora implementato
```

Struttura di riferimento completa: [`docs/SPECIFICATION.md` §87](docs/SPECIFICATION.md#87-struttura-della-repository-finale).

## Riferimenti principali

- Project N.O.M.A.D. — https://github.com/Crosstalk-Solutions/project-nomad
- BitChat — https://github.com/permissionlesstech/bitchat ([whitepaper](https://github.com/permissionlesstech/bitchat/blob/main/WHITEPAPER.md))
- Apple Core Bluetooth — https://developer.apple.com/documentation/corebluetooth
- Android Bluetooth permissions — https://developer.android.com/develop/connectivity/bluetooth/bt-permissions

## Licenza

[MIT](LICENSE)
