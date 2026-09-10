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

## Checklist: cosa resta da fare quando avrai l'hardware in mano

Tutto quello che segue non è ancora stato fatto — è la lista di cosa serve, in ordine, per passare da "codice scritto ma mai provato" a "funziona davvero". Nessun passo qui è già completato.

1. **Installa Arduino IDE** sul tuo computer (sito ufficiale) + il supporto schede **ESP32** (Strumenti → Scheda → Gestore schede → cerca "esp32").
2. **Collega fisicamente** la seconda XIAO ESP32-S3 al chip/modulo SX1262 (Wio-SX1262 pronto, oppure cablaggio a mano) — servono 6 fili: Chip Select, BUSY, RESET, e i tre SPI (clock, dati-in, dati-out).
3. **Scrivi i 6 numeri di pin veri in `config.h`** al posto dei `-1` — obbligatorio, il programma si rifiuta di compilare finché non lo fai (vedi sopra).
4. **Compila e carica** `sx126x-bridge.ino` su quella schedina. Qui arriva la **prima vera verifica del codice** — finora è stato controllato solo con un compilatore generico e intestazioni Arduino finte scritte da me, mai col vero Arduino IDE/toolchain ESP32. È possibile che il vero compilatore trovi qualcosa che io non ho potuto vedere da qui (es. una firma di funzione della libreria SPI di esp32-arduino-core leggermente diversa da come l'ho scritta a memoria) — se capita, dimmi l'errore esatto che mostra Arduino IDE, lo correggo.
5. **Avvia un nodo ARALD reale** puntato a quella porta seriale:
   ```
   npm run dev -w node -- --id BOX1 --port 9001 --lora-serial-port /dev/ttyACM0 --lora-chip sx1262
   ```
   Se parte senza errori, vuol dire che il chip ha risposto correttamente al primo controllo (`GetStatus`) — il traduttore e il chip si parlano.
6. **Ripeti i passi 2-5 su una seconda schedina** — per un vero test radio servono **almeno due dispositivi** con chip SX1262 che si parlano davvero via etere, non uno solo.
7. **Prova uno scambio reale**: due nodi ARALD (uno per schedina) che si scambiano un messaggio/contenuto attraverso la mesh, con `--lora-chip sx1262` su entrambi — questa è la prima vera prova che l'intero percorso (host → traduttore → chip → aria → chip → traduttore → host) funziona da capo a fondo.

**Se qualcosa non funziona**, alcuni sospetti già noti da controllare per primi (nell'ordine più probabile):
- I 6 numeri di pin in `config.h` sono sbagliati rispetto al collegamento reale — il sospetto più probabile in assoluto.
- I tempi di reset (`RESET_PULSE_LOW_MS`/`RESET_BUSY_TIMEOUT_MS` in `sx126x_spi.cpp`) sono valori prudenti scelti a tavolino, mai confermati contro un chip vero — se il nodo host segnala sempre "RESET failed", è il primo posto da guardare.
- Porta seriale sbagliata, o velocità (baud rate) diversa da 115200 su un lato e non sull'altro.
- Un guasto di cablaggio (es. un filo staccato) **non produce un errore netto** da questo firmware — te lo spiega la nota in `sx126x_spi.h`/`.cpp`: si manifesta come "il nodo sembra partire ma non manda/riceve mai nulla", non come un messaggio d'errore preciso. Utile saperlo per non cercare un errore che il programma non può dare.
- `CHIP_BUFFER_SIZE = 256` (lato host, in `node/src/transports/sx126x-commands.ts`) è il valore pubblicato in ogni datasheet SX1261/62/68, ma non è stato possibile confermarlo contro le due fonti scaricate in questa sessione — se noti problemi solo con pacchetti grandi, è un sospetto secondario.

**Quando tutto funziona**: dimmelo, con quello che hai osservato (anche solo "ha funzionato al primo colpo") — aggiorno `docs/security.md` (voce #73) con l'esito reale, al posto di "mai verificato contro hardware reale".

## Come sono fatti i file (per chi è curioso, non necessario per usarlo)

- `bridge_protocol.h`/`.cpp` — il "vocabolario" di byte usato per parlare col computer via USB.
  Rispecchia esattamente `node/src/transports/sx126x-bridge-protocol.ts` (lato computer) — se
  quel file cambia, questo va aggiornato di conseguenza.
- `sx126x_spi.h`/`.cpp` — la parte che parla davvero, via SPI, col chip radio. Contiene la nota
  tecnica su cosa è stato verificato con la documentazione ufficiale del produttore e cosa no.
- `config.h` — l'unico file che devi modificare tu (i numeri dei piedini).
- `sx126x-bridge.ino` — mette insieme i pezzi sopra: legge dalla USB, decide cosa fare, risponde.
