# mobile/android/

Non ancora implementato — Milestone 9 ([`docs/roadmap.md`](../../docs/roadmap.md)).

Prima app mobile: node identity, peer discovery, connessione, ricerca, richiesta contenuti, cache, relay di base ([`docs/SPECIFICATION.md` §68](../../docs/SPECIFICATION.md#62-74-fasi-di-sviluppo)). Android è il target mobile prioritario rispetto a iOS per i test di rete persistente, perché offre maggiore flessibilità per scenari BLE (§47) — richiede comunque gestione esplicita dei permessi runtime (`BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT` su Android 12+).

Riferimento: https://developer.android.com/develop/connectivity/bluetooth/bt-permissions
