# mobile/ios/

Non ancora implementato — Milestone 9, secondo target dopo Android ([`docs/roadmap.md`](../../docs/roadmap.md)).

**Vincolo da verificare sperimentalmente prima di ogni decisione di design**, vedi [`docs/SPECIFICATION.md` §46](../../docs/SPECIFICATION.md#46-ios) e [`docs/transport.md`](../../docs/transport.md#ios-46--trattato-come-vincolo-sperimentale-non-come-garanzia):

Apple Core Bluetooth (https://developer.apple.com/documentation/corebluetooth) supporta BLE in background. Da iOS 26, Apple documenta la possibilità di mantenere alcune attività BLE in background quando l'app ha una Live Activity attiva e un `CBManager` istanziato — ma questo **non rende un iPhone equivalente a un nodo mesh sempre attivo**. Prima di implementare qualunque logica di relay per iOS, vanno misurati empiricamente questi scenari:

1. App in foreground
2. App in background
3. App in background con Live Activity attiva
4. App sospesa dal sistema
5. App terminata

Fino a verifica sperimentale, il ruolo di iOS in questo progetto è: client, nodo opportunistico, relay solo ad app attiva, cache, courier — mai nodo infrastrutturale permanente.
