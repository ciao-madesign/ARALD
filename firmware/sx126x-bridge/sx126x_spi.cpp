#include "sx126x_spi.h"
#include <SPI.h>
#include "config.h"

namespace {
// The one query opcode with no trailing NOP byte -- see sx126x_spi.h's own doc comment.
const uint8_t GET_STATUS_OPCODE = 0xC0;

// Conservative, not independently verified against a datasheet in this environment -- see
// sx126x_spi.h's own doc comment on why and what to check first if reset() ever times out.
const unsigned long RESET_PULSE_LOW_MS = 2;
const unsigned long RESET_BUSY_TIMEOUT_MS = 1000;

// 2 MHz: comfortably under every SX126x SPI clock ceiling published in any datasheet variant.
// This bridge is not throughput-critical (a LoRa link itself is far slower than any SPI speed
// worth tuning for), so a conservative, always-safe value was chosen over a faster one.
const uint32_t SPI_CLOCK_HZ = 2000000;
}  // namespace

void Sx126xSpi::begin() {
  pinMode(PIN_NSS, OUTPUT);
  digitalWrite(PIN_NSS, HIGH);
  pinMode(PIN_RESET, OUTPUT);
  digitalWrite(PIN_RESET, HIGH);
  pinMode(PIN_BUSY, INPUT);
  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_NSS);
}

bool Sx126xSpi::isBusy() {
  return digitalRead(PIN_BUSY) == HIGH;
}

bool Sx126xSpi::reset() {
  digitalWrite(PIN_RESET, LOW);
  delay(RESET_PULSE_LOW_MS);
  digitalWrite(PIN_RESET, HIGH);

  unsigned long start = millis();
  // `millis() - start` (unsigned subtraction) rather than comparing against a precomputed
  // `start + timeout` deadline -- the subtraction form stays correct across millis()'s own
  // ~49.7-day overflow (wraps back to 0 and keeps counting), the precomputed-deadline form found
  // by code review does not: right when `start` is within RESET_BUSY_TIMEOUT_MS of wrapping, the
  // deadline itself wraps to a small value while millis() keeps climbing, making the comparison
  // fire almost instantly and report a spurious RESET failure with no real chip problem at all.
  while (isBusy()) {
    if (millis() - start > RESET_BUSY_TIMEOUT_MS) return false;
    delay(1);
  }
  return true;
}

// **Known, accepted limitation (flagged by code review, not fixed because there is no reliable fix
// available from software alone on this hardware)**: both functions below always return true.
// Arduino's blocking `SPI.transfer()` has no error signal of its own -- it always "succeeds" and
// simply returns whatever bit pattern was on MISO during that clock, real chip response or
// electrical noise alike. That means `BRIDGE_STATUS_ERROR` can never actually be produced by
// either of these two functions today, regardless of whether a real, working SX1262 is on the
// other end of the wires. A genuinely absent/miswired chip does NOT go undetected forever, though:
// `start()` on the host side (lora-serial-sx1262.ts) issues one `GetStatus` right after `RESET`
// and checks the chip-mode field of the response, which is the one place this firmware's honest
// "I successfully clocked some bytes" is cross-checked against "and they made sense" -- but that
// check only runs once, at startup. A wiring fault appearing later (a loose connector, say) will
// not raise BRIDGE_STATUS_ERROR from here; it will instead make the *mesh* link look alive but
// silently stop actually sending/receiving anything, surfacing eventually as TX timeouts on the
// host side (GetIrqStatus never reporting TX_DONE) rather than as a crisp error at the source. See
// firmware/sx126x-bridge/README.md for what this looks like in practice and what to check first.
bool Sx126xSpi::executeCommand(const uint8_t* commandBytes, uint8_t commandLen) {
  SPI.beginTransaction(SPISettings(SPI_CLOCK_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(PIN_NSS, LOW);
  for (uint8_t i = 0; i < commandLen; i++) SPI.transfer(commandBytes[i]);
  digitalWrite(PIN_NSS, HIGH);
  SPI.endTransaction();
  return true;
}

bool Sx126xSpi::queryCommand(const uint8_t* commandBytes, uint8_t commandLen, uint8_t* outResponse, uint8_t expectedResponseLength) {
  SPI.beginTransaction(SPISettings(SPI_CLOCK_HZ, MSBFIRST, SPI_MODE0));
  digitalWrite(PIN_NSS, LOW);
  for (uint8_t i = 0; i < commandLen; i++) SPI.transfer(commandBytes[i]);

  // GetStatus alone skips the NOP byte -- see this file's header doc comment for the citation.
  bool isGetStatus = (commandLen == 1 && commandBytes[0] == GET_STATUS_OPCODE);
  if (!isGetStatus) SPI.transfer(0x00);

  for (uint8_t i = 0; i < expectedResponseLength; i++) outResponse[i] = SPI.transfer(0x00);
  digitalWrite(PIN_NSS, HIGH);
  SPI.endTransaction();
  return true;
}
