#pragma once

// ============================================================================================
// DA COMPILARE PRIMA DI CARICARE QUESTO PROGRAMMA -- vedi firmware/sx126x-bridge/README.md.
//
// Questi numeri dicono al programma a quali "piedini" (pin) del microcontrollore è collegato il
// chip radio SX1262: quale filo è il Chip Select, quale il BUSY, quale il RESET, quali i tre fili
// dello SPI (l'"autostrada dati" a 3 fili usata per parlare col chip). Sono lasciati a -1 di
// proposito: il programma si RIFIUTA di compilare finché non li correggi, per non rischiare di far
// partire un caricamento su piedini sbagliati senza che nessuno se ne accorga.
//
// Perché non sono già scritti: questi numeri dipendono da come il chip radio è fisicamente
// collegato al microcontrollore, e quel collegamento fisico non è mai stato verificato in questo
// ambiente (nessun accesso all'hardware reale) -- stessa regola già seguita in tutto il resto di
// questo progetto per qualunque informazione hardware non controllabile da qui (vedi CLAUDE.md).
// Chi ha il dispositivo fisico in mano deve leggerli dalla documentazione ufficiale del modulo
// radio che sta usando (o, se i fili sono stati collegati a mano su una breadboard, semplicemente
// scrivere qui i numeri dei piedini scelti in quel momento).
// ============================================================================================
#define PIN_NSS -1    // Chip Select / NSS (sceglie "sto parlando con te" al chip radio)
#define PIN_BUSY -1   // Linea BUSY (il chip la tiene alta quando è "occupato" internamente)
#define PIN_RESET -1  // Linea di RESET fisico del chip
#define PIN_SCK -1    // SPI: linea di clock (il "metronomo" dei dati)
#define PIN_MISO -1   // SPI: dati dal chip verso il microcontrollore
#define PIN_MOSI -1   // SPI: dati dal microcontrollore verso il chip

#if PIN_NSS < 0 || PIN_BUSY < 0 || PIN_RESET < 0 || PIN_SCK < 0 || PIN_MISO < 0 || PIN_MOSI < 0
#error "config.h: correggi i PIN_* qui sopra con i numeri veri del tuo collegamento prima di caricare — vedi firmware/sx126x-bridge/README.md"
#endif

// Velocità della porta seriale USB verso il computer/host ARALD. Deve corrispondere a
// --lora-baud-rate lato host (il cui default, in node/src/cli.ts, è anch'esso 115200) — se li
// cambi, cambiali insieme su entrambi i lati.
#define SERIAL_BAUD_RATE 115200
