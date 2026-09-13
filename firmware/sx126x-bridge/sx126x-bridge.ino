// Firmware per il piccolo microcontrollore "ponte" (bridge) tra la porta USB-seriale verso il
// nodo ARALD (lato host, node/src/transports/lora-serial-sx1262.ts) e il vero chip radio SX1262
// collegato via SPI. Vedi firmware/sx126x-bridge/README.md per spiegazioni in parole semplici;
// vedi sx126x_spi.h e bridge_protocol.h per il dettaglio tecnico verificato/non verificato.
//
// Questo programma è deliberatamente "stupido": non sa cosa sia un pacchetto ARALD né cosa
// significhi un singolo comando del chip radio -- riceve dal computer una richiesta già pronta
// (RESET / EXECUTE / QUERY, protocollo in bridge_protocol.h) e la inoltra al chip via SPI, poi
// rimanda indietro la risposta così com'è. Tutta l'intelligenza su "cosa dire al chip e quando"
// resta lato host, in TypeScript -- niente di tutto questo viene duplicato qui.
//
// Mai verificato contro un chip vero in questo ambiente (nessun hardware raggiungibile da qui).

#include "bridge_protocol.h"
#include "sx126x_spi.h"
#include "config.h"

static BridgeFrameReader reader;

static void sendResponse(uint8_t status, const uint8_t* payload, uint8_t payloadLen) {
  uint8_t out[(size_t)FRAME_OVERHEAD_BYTES + MAX_FRAME_PAYLOAD_BYTES];
  size_t n = encodeBridgeFrame(status, payload, payloadLen, out);
  if (n > 0) Serial.write(out, n);
}

static void sendOk(const uint8_t* payload = nullptr, uint8_t payloadLen = 0) {
  sendResponse(BRIDGE_STATUS_OK, payload, payloadLen);
}

static void sendError() {
  sendResponse(BRIDGE_STATUS_ERROR, nullptr, 0);
}

static void sendBusy() {
  sendResponse(BRIDGE_STATUS_BUSY, nullptr, 0);
}

static void handleFrame(const BridgeFrame& frame) {
  switch (frame.type) {
    case BRIDGE_CMD_RESET: {
      if (Sx126xSpi::reset()) sendOk();
      else sendError();
      break;
    }

    case BRIDGE_CMD_EXECUTE: {
      // Deve contenere almeno l'opcode -- un EXECUTE vuoto non avrebbe nulla da mandare al chip.
      if (frame.payloadLength < 1) {
        sendError();
        break;
      }
      if (Sx126xSpi::isBusy()) {
        sendBusy();
        break;
      }
      if (Sx126xSpi::executeCommand(frame.payload, frame.payloadLength)) sendOk();
      else sendError();
      break;
    }

    case BRIDGE_CMD_QUERY: {
      // payload = [expectedResponseLength, opcode, ...params] -- vedi buildQueryPayload() in
      // sx126x-bridge-protocol.ts per la forma originale che questo mirror rispecchia.
      if (frame.payloadLength < 2) {
        sendError();
        break;
      }
      uint8_t expectedResponseLength = frame.payload[0];
      const uint8_t* commandBytes = frame.payload + 1;
      uint8_t commandLen = frame.payloadLength - 1;
      // Nessun controllo a runtime su expectedResponseLength qui: è un uint8_t, quindi non può mai
      // superare MAX_FRAME_PAYLOAD_BYTES (anch'esso 255) per costruzione del tipo -- e `response[]`
      // qui sotto è dimensionato apposta su MAX_FRAME_PAYLOAD_BYTES, quindi ogni valore che questo
      // byte può assumere ci sta sempre. Un controllo "if (expectedResponseLength > 255)" sarebbe
      // sempre falso (segnalato dalla revisione come falsa sicurezza, rimosso) -- se in futuro
      // MAX_FRAME_PAYLOAD_BYTES o il tipo di expectedResponseLength cambiassero in modo indipendente
      // lato host/firmware, va ridiscusso da capo, non riaggiunto come controllo vuoto.
      if (Sx126xSpi::isBusy()) {
        sendBusy();
        break;
      }
      uint8_t response[MAX_FRAME_PAYLOAD_BYTES];
      if (Sx126xSpi::queryCommand(commandBytes, commandLen, response, expectedResponseLength)) {
        sendResponse(BRIDGE_STATUS_OK, response, expectedResponseLength);
      } else {
        sendError();
      }
      break;
    }

    default:
      // Tipo di comando sconosciuto -- non va mai ignorato in silenzio: l'host sta aspettando
      // comunque una risposta, altrimenti resterebbe bloccato fino al proprio timeout.
      sendError();
      break;
  }
}

void setup() {
  Serial.begin(SERIAL_BAUD_RATE);
  Sx126xSpi::begin();
}

void loop() {
  BridgeFrame frame;
  while (Serial.available() > 0) {
    uint8_t b = (uint8_t)Serial.read();
    if (reader.pushByte(b, frame)) {
      handleFrame(frame);
    }
  }
}
