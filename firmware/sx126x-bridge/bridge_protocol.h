#pragma once
#include <Arduino.h>

// C++ reimplementation, for this firmware, of the exact same wire protocol defined in
// node/src/transports/sx126x-bridge-protocol.ts (the ARALD host side, in TypeScript). See that
// file's own doc comment for the full rationale of the frame shape and the EXECUTE/QUERY split --
// this header only restates the parts this firmware needs to parse/build frames correctly. Kept in
// sync by hand, since there is no shared source between a Node/TypeScript host and an Arduino
// sketch -- if that .ts file's frame shape ever changes, this header must change with it.
//
// Frame shape (identical on the wire in both directions):
//   [SOF=0xAA][type][len][...payload (len bytes)...][checksum]
// checksum = XOR of type, len, and every payload byte.
//
// `type` is a BridgeCommand value on a request (host -> this firmware), a BridgeStatus value on a
// response (this firmware -> host).

static const uint8_t FRAME_SOF = 0xAA;
static const uint8_t FRAME_OVERHEAD_BYTES = 4; // SOF + type + len + checksum
static const uint8_t MAX_FRAME_PAYLOAD_BYTES = 0xFF; // `len` is one byte, so this is a hard wire limit

enum BridgeCommand : uint8_t {
  // No payload. Reset the chip to a known state -- pulse the hardware RESET line and wait out the
  // chip's own post-reset BUSY assertion before answering (see sx126x_spi.h's reset()).
  BRIDGE_CMD_RESET = 0x01,
  // Payload: [opcode, ...params] -- an SX126x command with no response data of its own (SetStandby,
  // SetTx, WriteBuffer, ...). No response payload on success.
  BRIDGE_CMD_EXECUTE = 0x02,
  // Payload: [expectedResponseLength, opcode, ...params] -- an SX126x command that does produce
  // response data (GetStatus, GetIrqStatus, ReadBuffer, ...). Response payload on success: exactly
  // expectedResponseLength bytes read back from the chip.
  BRIDGE_CMD_QUERY = 0x03,
};

enum BridgeStatus : uint8_t {
  BRIDGE_STATUS_OK = 0x00,
  BRIDGE_STATUS_ERROR = 0x01,
  // The chip's BUSY line was already asserted when this command arrived -- not executed at all,
  // the host is expected to retry after a short backoff (Sx126xBridgeClient.sendWithBusyRetry() on
  // the host side does this automatically). Never sent after actually touching the chip while busy.
  BRIDGE_STATUS_BUSY = 0x02,
};

struct BridgeFrame {
  uint8_t type;
  uint8_t payload[MAX_FRAME_PAYLOAD_BYTES];
  uint8_t payloadLength;
};

uint8_t computeBridgeChecksum(uint8_t type, const uint8_t* payload, uint8_t len);

// Encodes one frame into `out` (caller-owned buffer, must have room for
// FRAME_OVERHEAD_BYTES + payloadLen bytes) and returns the number of bytes written. Returns 0
// without writing anything if payloadLen exceeds MAX_FRAME_PAYLOAD_BYTES -- Arduino has no
// exceptions, so this fails silently by contract; every call site in this firmware only ever
// encodes payload lengths it already validated itself (never unvalidated remote input), mirroring
// encodeBridgeFrame()'s synchronous-throw contract on the TS side for the same reason.
size_t encodeBridgeFrame(uint8_t type, const uint8_t* payload, uint8_t payloadLen, uint8_t* out);

// Incrementally parses frames out of an arbitrarily-chunked byte stream, fed one byte at a time
// (this firmware reads Serial one byte per loop() iteration). This is a small state machine, not a
// byte-for-byte port of sx126x-bridge-protocol.ts's own accumulate-and-rescan BridgeFrameReader --
// that design was chosen there for an arbitrarily-chunked Node stream; a state machine is the more
// natural, equally wire-compatible fit for a byte-at-a-time embedded loop.
//
// Resync on a checksum mismatch: a naive "just go back to WAIT_SOF" (this class's first version,
// caught by code review) loses whatever bytes were already consumed as the failed frame's type/
// len/payload -- if what actually happened is a single corrupted `len` byte (e.g. flipped from 5
// to 200), those ~195 extra bytes consumed as bogus "payload" are really the SOF+type+len+... of
// the *next legitimate command*, silently swallowed, forcing the host to time out and retry
// instead of the frame reader recovering immediately. `pushByte()` instead rescans every byte
// consumed since the failed frame's own opening SOF (still held in `type`/`len`/`payload` at the
// moment of failure) for an embedded SOF, and replays whatever comes after it through the state
// machine right away -- **one level deep only**: if that replay itself hits a second checksum
// failure, this falls back to plain resume-from-WAIT_SOF rather than rescanning again. Not a
// perfect match for the TS reference's fully general accumulate-and-rescan, but this is a private
// point-to-point USB-serial link between this bridge and its one host, not attacker-facing -- this
// only needs to recover from a rare real transmission glitch, not adversarial input, and one level
// of rescan already recovers the concrete swallowed-next-command scenario above.
class BridgeFrameReader {
 public:
  // Feeds one byte in. Returns true and fills `outFrame` if this byte just completed a full, valid
  // frame (possibly via the one-level resync described above, still within this same call).
  bool pushByte(uint8_t b, BridgeFrame& outFrame);

 private:
  enum TransitionResult { NEED_MORE, FRAME_COMPLETE, CHECKSUM_MISMATCH };
  enum State { WAIT_SOF, WAIT_TYPE, WAIT_LEN, WAIT_PAYLOAD, WAIT_CHECKSUM };

  State state = WAIT_SOF;
  uint8_t type = 0;
  uint8_t len = 0;
  uint8_t payload[MAX_FRAME_PAYLOAD_BYTES];
  uint8_t payloadIndex = 0;

  // One state-machine step for a single byte. Never itself rescans on a checksum mismatch -- just
  // reports it (resetting to WAIT_SOF regardless), leaving resync to pushByte().
  TransitionResult transition(uint8_t b, BridgeFrame& outFrame);
};
