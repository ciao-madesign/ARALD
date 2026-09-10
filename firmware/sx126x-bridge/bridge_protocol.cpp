#include "bridge_protocol.h"

uint8_t computeBridgeChecksum(uint8_t type, const uint8_t* payload, uint8_t len) {
  uint8_t c = type ^ len;
  for (uint8_t i = 0; i < len; i++) c ^= payload[i];
  return c;
}

size_t encodeBridgeFrame(uint8_t type, const uint8_t* payload, uint8_t payloadLen, uint8_t* out) {
  if (payloadLen > MAX_FRAME_PAYLOAD_BYTES) return 0; // see header doc comment -- never hit by this firmware's own call sites
  out[0] = FRAME_SOF;
  out[1] = type;
  out[2] = payloadLen;
  for (uint8_t i = 0; i < payloadLen; i++) out[3 + i] = payload[i];
  out[3 + payloadLen] = computeBridgeChecksum(type, payload, payloadLen);
  return (size_t)FRAME_OVERHEAD_BYTES + payloadLen;
}

BridgeFrameReader::TransitionResult BridgeFrameReader::transition(uint8_t b, BridgeFrame& outFrame) {
  switch (state) {
    case WAIT_SOF:
      if (b == FRAME_SOF) state = WAIT_TYPE;
      return NEED_MORE;

    case WAIT_TYPE:
      type = b;
      state = WAIT_LEN;
      return NEED_MORE;

    case WAIT_LEN:
      len = b;
      payloadIndex = 0;
      state = (len == 0) ? WAIT_CHECKSUM : WAIT_PAYLOAD;
      return NEED_MORE;

    case WAIT_PAYLOAD:
      payload[payloadIndex++] = b;
      if (payloadIndex >= len) state = WAIT_CHECKSUM;
      return NEED_MORE;

    case WAIT_CHECKSUM: {
      uint8_t expected = computeBridgeChecksum(type, payload, len);
      state = WAIT_SOF;
      if (b == expected) {
        outFrame.type = type;
        outFrame.payloadLength = len;
        for (uint8_t i = 0; i < len; i++) outFrame.payload[i] = payload[i];
        return FRAME_COMPLETE;
      }
      return CHECKSUM_MISMATCH;
    }
  }
  return NEED_MORE;
}

bool BridgeFrameReader::pushByte(uint8_t b, BridgeFrame& outFrame) {
  // Snapshot the bytes a checksum failure would need to rescan -- taken BEFORE transition() runs,
  // since transition() only tells us a mismatch happened, it doesn't hand back the record itself.
  // Only meaningful if we're currently sat in WAIT_CHECKSUM (i.e. this byte IS the checksum byte);
  // harmless to compute otherwise, just unused.
  bool wasWaitingForChecksum = (state == WAIT_CHECKSUM);
  uint8_t recordType = type;
  uint8_t recordLen = len;
  uint8_t recordPayload[MAX_FRAME_PAYLOAD_BYTES];
  for (uint8_t i = 0; i < recordLen; i++) recordPayload[i] = payload[i];

  TransitionResult result = transition(b, outFrame);
  if (result == FRAME_COMPLETE) return true;
  if (result != CHECKSUM_MISMATCH || !wasWaitingForChecksum) return false;

  // Checksum mismatch: rescan every byte consumed since the failed frame's own opening SOF --
  // type + len + payload + this failed checksum byte itself -- for an embedded SOF, and replay
  // whatever follows it through the state machine right away. See bridge_protocol.h's own doc
  // comment on BridgeFrameReader for why this is bounded to one level of rescan.
  uint8_t record[2 + MAX_FRAME_PAYLOAD_BYTES + 1];
  uint8_t recordCount = 0;
  record[recordCount++] = recordType;
  record[recordCount++] = recordLen;
  for (uint8_t i = 0; i < recordLen; i++) record[recordCount++] = recordPayload[i];
  record[recordCount++] = b;

  for (uint8_t i = 0; i < recordCount; i++) {
    if (record[i] != FRAME_SOF) continue;
    // Found an embedded SOF at record[i] -- the replay below must resume as if that SOF had just
    // been consumed (WAIT_TYPE), not from `state`'s current value (WAIT_SOF, left there by the
    // CHECKSUM_MISMATCH result above). Missing this line was a real bug caught by this file's own
    // regression test (test in the PR description/commit, exercised against a realistic single-
    // bit-flip corruption of a `len` byte): without it, transition() saw a non-SOF byte while still
    // in WAIT_SOF and did nothing, silently discarding the correctly-found resync point.
    state = WAIT_TYPE;
    for (uint8_t j = i + 1; j < recordCount; j++) {
      TransitionResult replayResult = transition(record[j], outFrame);
      if (replayResult == FRAME_COMPLETE) return true;
      if (replayResult == CHECKSUM_MISMATCH) break; // one level deep only -- see header doc comment
    }
    break; // only the first embedded SOF is tried
  }
  return false;
}
