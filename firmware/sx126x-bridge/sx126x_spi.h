#pragma once
#include <Arduino.h>

// Low-level SPI transactions toward a real SX1262 chip -- the C++ counterpart, on this firmware's
// side, of node/src/transports/sx126x-commands.ts on the host side. Deliberate scope: this file
// knows nothing about what any individual opcode or parameter *means* (SetStandby vs. SetTx vs.
// WriteBuffer are all just "some bytes to shift out"). All of that meaning lives on the host, in
// sx126x-commands.ts -- this firmware is a dumb, transparent pipe between the host's bridge-frame
// commands and the chip's SPI pins, exactly mirroring the division of responsibility the bridge
// protocol itself establishes (sx126x-bridge-protocol.ts's own doc comment: EXECUTE/QUERY carry
// raw opcode+parameter bytes, never named commands).
//
// SPI transaction shape below, verified against Semtech's own open-source reference driver
// (github.com/Lora-net/sx126x_driver, src/sx126x.c -- fetched via raw.githubusercontent.com during
// this session, the same provenance already used for sx126x-commands.ts's chip-level constants;
// see that file's own doc comment for why the PDF datasheet wasn't the source here):
//  - A write-type command (SetStandby, SetTx, WriteBuffer, SetRfFrequency, ...): assert NSS, shift
//    out every command byte (opcode + all parameters) back-to-back, release NSS. No extra bytes at
//    all -- confirmed by sx126x_hal_write()'s call sites, which never insert anything beyond the
//    command+data bytes the higher-level command builder already assembled.
//  - A read-type command (GetIrqStatus, GetRxBufferStatus, ReadBuffer, ReadRegister, ...) needs
//    exactly ONE extra 0x00 "NOP" byte shifted out (its own incoming response byte discarded)
//    *between* the command bytes and the start of real response data -- confirmed directly in
//    Semtech's sx126x_get_irq_status(), sx126x_read_buffer(), and sx126x_read_register()
//    implementations, each of which appends a trailing SX126X_NOP byte to its own command array
//    before the data-read phase begins.
//  - `GetStatus` (opcode 0xC0) is the one documented exception to that rule: no parameters and no
//    trailing NOP at all -- its single response byte comes back immediately after the opcode
//    itself. Confirmed directly in sx126x_get_status()'s implementation, whose command array is
//    just the 1-byte opcode. (sx126x-commands.ts's own doc comment already flags this same fact,
//    for the same reason this driver relies on GetStatus rather than a version register.)
//
// What is NOT independently confirmed from a fetched source in this environment (board/GPIO-level
// timing, not something the chip's own command driver code models at all): the exact RESET pulse
// width and how long the post-reset BUSY assertion can last. The constants used below are a
// conservative, commonly-used starting point, generous enough that a real chip should never
// genuinely need longer -- but this is a judgment call, not a verified datasheet value, flagged
// honestly per this project's own convention (same posture as sx126x-commands.ts's own
// CHIP_BUFFER_SIZE). If reset() ever times out against a real chip, that's the first thing to
// double check.

namespace Sx126xSpi {

// Configures pins and starts the SPI peripheral. Call once from setup().
void begin();

// Pulses the hardware RESET line and waits for BUSY to clear (the chip finished its post-reset
// boot/calibration). Returns false on timeout -- no real chip is responding as expected on this
// wiring, or the wiring itself is wrong.
bool reset();

// True if the chip's BUSY line is currently asserted. Callers MUST check this before calling
// executeCommand()/queryCommand() and respond BRIDGE_STATUS_BUSY without touching SPI at all if
// so -- never execute a command while the chip reports busy (see bridge_protocol.h's own doc
// comment on why that distinction matters).
bool isBusy();

// Write-type command: opcode + parameters already assembled in commandBytes[0..commandLen).
bool executeCommand(const uint8_t* commandBytes, uint8_t commandLen);

// Read-type command: opcode (+ parameters) in commandBytes[0..commandLen), reads exactly
// expectedResponseLength bytes into outResponse (caller-owned buffer).
bool queryCommand(const uint8_t* commandBytes, uint8_t commandLen, uint8_t* outResponse, uint8_t expectedResponseLength);

}  // namespace Sx126xSpi
