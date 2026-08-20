# mobile/

Client mobile leggero per Nomad-Net — **Fase 1** del piano in `docs/next-steps.md` Opzione H (roadmap Milestone 9): un'app che si connette via Wi-Fi/TCP a un nodo Nomad-Net gateway già esistente, senza reimplementare il protocollo sul telefono. Non è nel workspace npm della radice, stesso precedente di `gateway/nomad/` e `tools/simulator/`.

**Decisioni prese con l'utente** (vedi `docs/next-steps.md` Opzione H per il ragionamento completo): client leggero verso un gateway, non un nodo completo; framework ibrido ([Capacitor](https://capacitorjs.com/)), non nativo puro — adeguato perché il telefono si connette *a* un gateway (ruolo BLE centrale, quando arriverà la Fase 2) e non deve mai farsi scoprire da altri telefoni (ruolo periferica, che l'ibrido supporta male).

## Cosa c'è

- `www/` — l'app vera e propria: `index.html` + `styles.css` + `app.js`, vanilla JS senza framework (stessa disciplina di `node/src/web-ui.ts`: ogni valore che arriva dalla rete passa da `textContent`, mai `innerHTML`, perché il nome di un contenuto o l'id di un servizio dichiarati da un peer sono input non fidato). Due schermate:
  - **Setup/pairing, pensato per sembrare una rete Wi-Fi**: al primo avvio chiede l'indirizzo del gateway (`host:porta`, una tantum) e la "password di rete" (nome rete + password mostrati sulla pagina web del gateway stesso, sezione "Collega un telefono", oppure stampati in console — vedi `docs/development.md`). Verifica la raggiungibilità con una `GET /api/status` e la correttezza della password con una sonda dedicata (`POST /api/call` con un `serviceId` fittizio, per leggere solo lo status code senza invocare nulla) prima di salvare, mostrando un errore chiaro altrimenti. Ai riavvii successivi l'indirizzo resta nascosto (richiesto solo la password, dietro un link "Cambia indirizzo" per chi deve davvero puntare a un gateway diverso) e la dashboard non mostra mai più l'indirizzo grezzo, solo "Connesso a: `<nome rete>`". Se una password cambia (es. il gateway riparte e ne genera una nuova) una chiamata che fallisce con 401 riporta automaticamente qui, indirizzo preservato — vedi `docs/security.md` voce #24 per il dettaglio completo. Un bottone "Scansiona QR" (mostrato solo se il browser supporta `BarcodeDetector` — Chrome/Android WebView, non Firefox/Safari) inquadra il QR sulla pagina del gateway e compila da solo indirizzo/nome/password, azzerando la digitazione anche del primo accesso — vedi `docs/security.md` voce #25.
  - **Dashboard**: stato del nodo (vicini, servizi, cache, relay), lista vicini con trust level, lista servizi con pulsante "Chiama" per quelli disponibili (form dedicato per `service://ai` — un campo prompt — generico JSON per gli altri), contenuti sfogliabili/cercabili. Auto-refresh ogni 5s, come la dashboard desktop.
- `capacitor.config.json`, `package.json` — configurazione del progetto Capacitor.
- `android/` — progetto nativo Android generato da `npx cap add android` (Capacitor 8.5.0). Vedi "Stato della build" sotto.
- `ios/` — ancora solo il segnaposto originale: Android resta il target mobile prioritario per questa fase (spec §47, `mobile/ios/README.md`).

## Come provarla senza un telefono

L'app web sotto `www/` è stata verificata end-to-end con un browser reale (Playwright, viewport 390×844) contro un vero `NomadNode`+`WebUiServer`: schermata di setup → pairing riuscito → dashboard con vicini/servizi/contenuti reali → chiamata a `service://ai` con risposta mostrata a schermo → gestione dell'errore quando il gateway non è raggiungibile. Per riprodurlo manually in un browser desktop (utile per iterare sull'interfaccia senza build nativa):

```bash
# terminale 1 — un gateway con dati di prova
npm run dev -w node -- --id A --port 9001 --web-port 8080 --web-host 127.0.0.1 --allow-service-calls

# terminale 2 — serve l'app come una pagina qualsiasi (qualunque static server va bene)
cd mobile/www && python3 -m http.server 8090
```

Poi apri `http://127.0.0.1:8090`, inserisci `127.0.0.1:8080` come indirizzo e la password stampata dal terminale 1 (o visibile su `http://127.0.0.1:8080`, sezione "Collega un telefono").

**Nota CORS**: l'app gira su un'origine diversa dal gateway (per design — sarà una WebView Capacitor, non una pagina servita dallo stesso processo), quindi le sue `fetch()` sono cross-origin. `WebUiServer` risponde con `Access-Control-Allow-Origin: *` solo quando `allowServiceCalls` è attivo (vedi `docs/security.md` voce #22) — senza `--allow-service-calls` l'app non riesce a leggere nemmeno gli endpoint di sola lettura da un'altra origine.

**Nota sulla persistenza della password**: `app.js` salva indirizzo del gateway e password di rete in `localStorage`, in chiaro — scelta deliberata per questo primo prototipo (nessun meccanismo di storage cifrato aggiunto), non un oversight. Su un dispositivo condiviso o compromesso, chiunque abbia accesso allo storage della WebView (es. `adb backup`/`adb shell run-as` su un dispositivo debuggabile o rootato) può recuperare una password valida e chiamare `POST /api/call` per conto dell'app. Accettabile per un prototipo di validazione; da rivedere (es. `@capacitor/preferences` con storage cifrato via Android Keystore, o una password con scadenza) prima di un uso reale su un dispositivo non fidato.

**Nota sulla scansione QR**: usa la Shape Detection API nativa del browser (`BarcodeDetector`), zero dipendenze — ma **non disponibile** nel Chromium headless sandboxato di questa sessione di sviluppo, quindi il percorso di scansione live via fotocamera reale non è mai stato verificato end-to-end in questo ambiente (né lo sarà finché non gira su un vero Chrome/Android WebView). Verificato invece: il bottone resta correttamente nascosto quando l'API manca (nessun elemento rotto in pagina), `parsePairingUri()` con input sintetico, e l'intero percorso post-scansione (`applyScannedPairing()` → stessa validazione del form manuale) chiamando quelle funzioni direttamente. Stesso limite di principio della build Android nativa sotto — scritto secondo spec, non eseguibile end-to-end qui.

## Stato della build nativa Android

`npx cap add android` genera correttamente il progetto Gradle (verificato in questa sessione). **La compilazione reale (`./gradlew assembleDebug`) non è stata completabile in questo ambiente**: richiede l'Android Gradle Plugin da `dl.google.com`, un host bloccato dalla policy di rete della sessione remota (`403 Forbidden` dal proxy — non un problema di codice, un limite dell'ambiente). Su una macchina di sviluppo normale con [Android Studio](https://developer.android.com/studio) installato (che porta con sé l'SDK):

```bash
cd mobile
npm install
npx cap sync android
cd android && ./gradlew assembleDebug   # oppure apri android/ in Android Studio
```

## Nota sulle dipendenze

`npm install` segnala 3 vulnerabilità di severità moderata, tutte nella stessa catena transitiva: `uuid` (bound check mancante in v3/v5/v6) → `xcode` → `@capacitor/cli`. Sono tutte **dipendenze di sviluppo** (l'interfaccia a riga di comando di Capacitor, usata solo in fase di build, mai spedita nell'app) e `xcode` in particolare manipola progetti Xcode/iOS, non toccati da questa fase Android-first. Rischio reale basso; risolvibile con un futuro aggiornamento di `@capacitor/cli` quando disponibile, non affrontato ora per non introdurre un downgrade non necessario (`npm audit fix --force` cambierebbe la versione di `@capacitor/cli`).

## Cosa manca ancora (Fase 2, `docs/next-steps.md` Opzione H)

Connettività Bluetooth dal telefono — bloccata sullo stesso prerequisito hardware dell'Opzione A (BLE reale), non un blocco nuovo.
