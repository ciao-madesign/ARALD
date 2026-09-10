# Il "traduttore" per il chip radio SX1262 — spiegato semplice

## Cos'è questo, in due frasi

ARALD Box e ARALD Portable parlano con la radio LoRa (il chip SX1262) tramite un cavo USB, non
tramite fili saldati direttamente. In mezzo c'è un piccolo microcontrollore (una seconda schedina
XIAO ESP32-S3) che fa da **traduttore**: da un lato ascolta il computer via USB, dall'altro parla
la "lingua" del chip radio (si chiama SPI, un modo di scambiarsi byte con pochi fili). Questo
programma (il "firmware") è quello che deve girare su quella schedina-traduttore.

Il lato computer (in TypeScript, dentro `node/src/`) è già scritto e già testato — sa esattamente
quali frasi mandare al traduttore. Questo programma qui è il traduttore stesso: riceve una frase
dal computer, la ripassa al chip radio via SPI, e rimanda indietro la risposta del chip così
com'è. Non decide nulla da solo, non "capisce" la rete ARALD — è volutamente un pezzo "stupido" e
trasparente, per essere il più semplice possibile da verificare.

## Cosa NON è stato verificato (dillo sempre a chi ti aiuta)

Non ho un chip SX1262 vero, né un microcontrollore vero, collegabili da questo ambiente — quindi
questo programma **non è mai stato caricato su un dispositivo reale né compilato con il vero
programma Arduino** (in questo ambiente non è stato possibile nemmeno scaricare Arduino IDE o i
suoi strumenti da riga di comando: la rete di questa sessione blocca i siti da cui si scaricano).
Ho solo potuto controllare che il codice non abbia errori di scrittura grossolani, usando un
compilatore C++ generico con delle finte "Arduino.h"/"SPI.h" al posto di quelle vere — un controllo
parziale, non la prova che funzioni davvero.

Quello che invece **è stato verificato con una fonte ufficiale** (il codice open-source che
Semtech, il produttore del chip, pubblica loro stessi): il modo esatto in cui i byte vanno scambiati
sul filo SPI per leggere una risposta dal chip (vedi i commenti dentro `sx126x_spi.h`/`.cpp` per il
dettaglio con la fonte citata).

**Se qualcosa non funziona sul dispositivo vero, dimmelo con i dettagli che riesci a osservare**
(es. cosa succede sul monitor seriale, se il chip risponde o resta muto, eventuali messaggi
d'errore) — se serve, correggo il programma.

## Cosa ti serve (lato tuo, fisico)

1. Un computer con **Arduino IDE** installato (si scarica gratis dal sito ufficiale Arduino —
   questa parte, l'installazione sul tuo computer, la fai tu: da questo ambiente non posso
   scaricare programmi).
2. Dentro Arduino IDE, installa il supporto per le schede **ESP32** (menu Strumenti → Scheda →
   Gestore schede, cerca "esp32" di Espressif Systems, installa). Nessun'altra libreria esterna
   serve: questo programma usa solo cose già incluse in Arduino/ESP32.
3. La schedina XIAO ESP32-S3 che farà da traduttore, collegata al chip radio SX1262 (o al modulo
   Wio-SX1262) secondo lo schema di collegamento che hai/ti hanno dato — servono 6 fili in tutto:
   Chip Select, BUSY, RESET, e i tre fili SPI (clock, dati-in, dati-out).

## I passi

1. **Apri** la cartella `firmware/sx126x-bridge/` in Arduino IDE: apri il file
   `sx126x-bridge.ino`, gli altri file della cartella (`bridge_protocol.*`, `sx126x_spi.*`,
   `config.h`) si aprono automaticamente insieme come "schede" della stessa finestra.
2. **Apri `config.h`** e scrivi i numeri veri dei piedini (pin) a cui hai collegato ciascun filo,
   al posto dei `-1` che trovi scritti lì. Il programma è scritto apposta per **rifiutarsi di
   compilare** finché non li correggi — se provi a compilare senza toccarli, vedrai un errore che
   te lo ricorda, non un dispositivo che parte "a caso" su piedini sbagliati.
   - Se stai usando un modulo pronto (es. Wio-SX1262 per XIAO), guarda la documentazione ufficiale
     di quel modulo per sapere quale piedino XIAO corrisponde a NSS/BUSY/RESET/SCK/MISO/MOSI —
     questo dettaglio dipende dal prodotto fisico esatto e da questo ambiente non ho potuto
     controllarlo.
   - Se hai collegato i fili a mano, scrivi semplicemente i numeri che hai scelto tu.
3. Seleziona la scheda giusta in Arduino IDE (Strumenti → Scheda → ESP32 → il modello XIAO
   ESP32-S3, oppure "ESP32S3 Dev Module" se il tuo Arduino IDE non elenca il modello XIAO per
   nome) e la porta USB corretta.
4. Premi **Carica** (la freccia). Se `config.h` è a posto, il programma si carica sulla schedina.
5. **Come verificare che funzioni davvero**: questo programma parla un linguaggio a byte, non
   testo leggibile — aprire il "Monitor seriale" di Arduino IDE non ti mostrerà niente di
   comprensibile. Il modo giusto per verificarlo è avviare un nodo ARALD reale sul computer
   puntato a questa porta seriale:
   ```
   npm run dev -w node -- --id BOX1 --port 9001 --lora-serial-port /dev/ttyACM0 --lora-chip sx1262
   ```
   (sostituisci `/dev/ttyACM0` con la porta seriale vera della tua schedina — su Windows sarà
   qualcosa come `COM5`). Se il traduttore e il chip rispondono correttamente, il nodo si avvia
   senza errori e stampa a schermo che il collegamento LoRa reale è attivo. Se invece qualcosa non
   torna (chip non risposto, collegamento sbagliato, ecc.), il nodo lo segnala con un messaggio
   d'errore — copialo e riportamelo, mi aiuta a capire cosa correggere.

## Come sono fatti i file (per chi è curioso, non necessario per usarlo)

- `bridge_protocol.h`/`.cpp` — il "vocabolario" di byte usato per parlare col computer via USB.
  Rispecchia esattamente `node/src/transports/sx126x-bridge-protocol.ts` (lato computer) — se
  quel file cambia, questo va aggiornato di conseguenza.
- `sx126x_spi.h`/`.cpp` — la parte che parla davvero, via SPI, col chip radio. Contiene la nota
  tecnica su cosa è stato verificato con la documentazione ufficiale del produttore e cosa no.
- `config.h` — l'unico file che devi modificare tu (i numeri dei piedini).
- `sx126x-bridge.ino` — mette insieme i pezzi sopra: legge dalla USB, decide cosa fare, risponde.
