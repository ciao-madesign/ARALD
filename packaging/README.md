# packaging/

"ARALD Portable" software-puro (`docs/next-steps.md`, "Installer/wizard ARALD Portable software-puro") — packages the real mesh runtime (`node/src/cli.ts`) as a standalone, single-file executable for a non-technical user: no Node.js install required, no Docker, no radio hardware needed for the Wi-Fi-only profile this package targets. Not in the npm workspace (same pattern as `tools/simulator/`, `gateway/local-services/`, `nomad-hub/`), run via `tsx`/`npm run build:portable`.

## Cosa fa davvero (verificato in questa sessione, non solo scritto)

```bash
npm run build:portable
```

produce `packaging/build/arald-portable` (`.exe` su Windows) — un singolo file eseguibile che include l'intero runtime Node.js **e** il codice ARALD (`node/src/cli.ts` e tutto ciò che importa), costruito con la feature nativa di Node 20+ "Single Executable Applications" (SEA). **Verificato end-to-end in questa sessione**: il binario generato gira da solo, copiato in una directory isolata senza accesso al resto del repository/a `node_modules`, avvia un `NomadNode`/`WebUiServer` reali, persiste identità/config, e risponde su `GET /api/status` esattamente come `tsx node/src/cli.ts` farebbe.

```bash
./packaging/build/arald-portable --id MioNodo --portable true
```

(`--portable true`, non solo `--portable` — stesso schema booleano già usato da ogni altro switch on/off di `cli.ts`, es. `--allow-service-calls true`.)

`--portable` (nuovo flag di `node/src/cli.ts`) fa tutto da solo: risolve una directory dati standard per il sistema operativo (`node/src/data-dir.ts` — `~/.local/share/arald` su Linux, `~/Library/Application Support/ARALD` su macOS, `%APPDATA%\ARALD` su Windows), crea/carica un file di configurazione persistito lì (`node/src/portable-config.ts` — identità, porta web, password di rete, generati una sola volta e riusati a ogni riavvio), abilita il pairing Wi-Fi-style già esistente (`--allow-service-calls`), e — solo al primo avvio genuino — apre il browser di sistema sulla pagina di setup già esistente in `web-ui.ts` (`node/src/open-browser.ts`). Nessuna nuova UI: la pagina di setup è la stessa già usata da ogni altro ruolo mobile-facing di questo progetto.

## Due problemi tecnici reali trovati costruendo questa pipeline (non assunti, verificati)

1. **La documentazione ufficiale SEA più recente descrive un flag `--build-sea` che questo ambiente non ha** (`node --help` su Node 22.22.2 qui disponibile mostra solo `--experimental-sea-config`) — verificato empiricamente prima di scrivere `build-sea.ts`, che usa quindi il processo in due passi (genera il blob, poi `postject` per iniettarlo), l'unico realmente presente ed eseguibile qui.
2. **Un SEA iniettato non può `require()`/`import` altri file**, solo i moduli built-in di Node — verificato riproducendo l'errore esatto (`ERR_UNKNOWN_BUILTIN_MODULE`) con un esempio minimale a due file prima di procedere. `node/dist/cli.js` importa decine di altri file compilati sotto `node/dist/` — `build-sea.ts` li raggruppa prima in un unico file con `esbuild` (già presente nel toolchain, ora dipendenza esplicita). `@serialport/bindings-cpp`/`@serialport/stream` (un addon nativo compilato, mai impacchettabile da un bundler/da SEA) sono marcati `--external`: `node/src/cli.ts`'s `--lora-serial-port` li importa già in modo dinamico (`await import()`, non più import statico in cima al file) proprio per questo motivo — il binario Wi-Fi-only non ha mai bisogno di risolverli, a meno che qualcuno non chieda esplicitamente `--lora-serial-port` (non supportato su questo profilo).
3. **Un bug reale trovato solo eseguendo il binario**, non dal code-review: `node/src/map-tiles.ts` caricava `node:sqlite` con `createRequire(import.meta.url)(...)` — `import.meta.url` è vuoto una volta che il file è raggruppato in CommonJS (limite documentato di esbuild), facendo crashare `createRequire(undefined)` al primissimo avvio, prima ancora di toccare qualunque codice relativo alle mappe. **Fix**: usa il `require` reale già presente nel contesto CommonJS quando c'è, cadendo su `createRequire(import.meta.url)` solo nel vero contesto ESM (`tsx`/`node dist/cli.js`) — vedi il commento in quel file.

## Cosa è verificato, cosa no

- **Linux x64, costruito e verificato in questo stesso ambiente**: build completa, binario eseguito in isolamento, Web UI raggiunta via `curl` reale. Il modulo `autostart-linux.ts`'s generatore di unit systemd è verificato come testo corretto; `systemctl --user`/`loginctl` non sono eseguibili qui (nessun bus utente in questo sandbox, `systemctl --user status` fallisce con "Failed to connect to bus").
- **macOS, Windows, Linux arm64 — mai costruiti né eseguiti in questo ambiente** (nessun host di quel tipo disponibile). `autostart-macos.ts`/`autostart-windows.ts` generano testo verificato contro la documentazione ufficiale Apple/Microsoft (non assunto), ma mai eseguito contro un sistema reale. `.github/workflows/build-portable.yml` (matrice a 5 piattaforme) non è mai stato eseguito su runner reali da questa sessione.
- **Verifica end-to-end con un utente non tecnico**: resta bloccata, nessun utente reale disponibile in questo ambiente (`docs/next-steps.md`).

## File

- `build-sea.ts` — costruisce il binario per la piattaforma/architettura corrente (mai cross-compilazione — la matrice CI costruisce le altre 4 combinazioni sui rispettivi runner).
- `autostart-linux.ts` / `autostart-macos.ts` / `autostart-windows.ts` — generano (e, per Linux/macOS, scrivono su disco) il file di avvio automatico per sistema operativo; non eseguono mai `systemctl`/`launchctl`/`schtasks` da sole — attivare un servizio persistente in background resta un'azione che la persona esegue di proposito, mai silenziosa.
- `../.github/workflows/build-portable.yml` — matrice CI a 5 piattaforme (win-x64, macos-x64, macos-arm64, linux-x64, linux-arm64).

## Cosa resta (non in questa voce)

Packaging dell'installer vero e proprio (un file `.app`/`.exe`/pacchetto che include anche la registrazione dell'avvio automatico in un solo doppio click, invece dei due passi separati "costruisci il binario" + "genera/installa il file di avvio automatico" di oggi) — non pianificato, candidato per una sessione futura se richiesto.
