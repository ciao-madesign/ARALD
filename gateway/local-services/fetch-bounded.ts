/**
 * Fetches `url` and reads its body as text, aborting as soon as more than
 * `maxBytes` have arrived rather than buffering an unbounded response in
 * full first — `res.text()` alone would download the entire body before any
 * caller-side size check ever got a chance to reject it, so a
 * hostile/misbehaving backend (spec §57) could still force this node to
 * hold an arbitrarily large response in memory. Mirrors
 * `node/src/loopback-http-server.ts`'s `readRequestBody()`/`BodyTooLargeError`
 * pattern, applied to an outbound fetch instead of an inbound request.
 * Falls back to buffering the whole response only if the runtime doesn't
 * expose a streaming body (`res.body` undefined) — not expected under
 * Node's `fetch()`, kept only as a defensive fallback.
 *
 * Extracted from `news-gateway.ts` (its original, sole caller) once
 * `internet-gateway.ts` needed the exact same "bounded outbound fetch"
 * behavior — same reasoning `bounded-map.ts`/`loopback-http-server.ts`
 * already established for shared boilerplate in this codebase.
 */
export async function fetchTextBounded(url: string, maxBytes: number): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed (HTTP ${res.status})`);
  if (!res.body) {
    // Not expected from Node's fetch() for a normal response with a body — kept only as a
    // defensive fallback (e.g. a future runtime/polyfill difference). Still bounded: this can only
    // ever buffer whatever the backend actually sent, then reject it after the fact, rather than
    // silently accepting an unbounded body the way an unchecked res.text() would.
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`response exceeded ${maxBytes} bytes`);
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
