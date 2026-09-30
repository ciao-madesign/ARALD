import type { NomadNode } from "../../node/src/node.js";

/**
 * `service://translation` — registers itself the same way `NewsGateway.generateDigest()`
 * composes `service://ai` (docs/security.md voce #37): purely through
 * `node.callService()`, never a direct `AiGateway` class reference. No
 * class needed here (unlike `AiGateway`/`NewsGateway`) — there is no state
 * of its own to hold (no cache, no base URL): every call is interactive and
 * delegates entirely to whatever `service://ai` is available on the mesh at
 * call time. `node.ts`'s own `registerService()` doc comment already
 * anticipated this exact service id as its example.
 */

/**
 * Fixed allow-list of target languages (not a free-form editor) — keeps the
 * service predictable/testable and the mobile UI a simple dropdown, the
 * most common languages for an alpine-refuge visitor. `targetLanguage`
 * outside this list is rejected with an explicit error listing the valid
 * codes, never passed through to the prompt.
 */
export const SUPPORTED_LANGUAGES: Record<string, string> = {
  it: "italiano",
  en: "inglese",
  de: "tedesco",
  fr: "francese",
  es: "spagnolo",
};

/** Caps a single translation request's text — a chat message, not a document; keeps the `service://ai` prompt (and thus the request/response round trip, possibly multi-hop, spec §35-36) bounded regardless of what a caller sends. */
export const MAX_TRANSLATE_TEXT_CHARS = 2000;

/**
 * Neutralizes one specific, structural risk of this prompt shape: the
 * user-supplied text containing the exact `"""` delimiter sequence
 * `buildTranslatePrompt()` below uses to fence it, prematurely closing that
 * fence and letting whatever follows be read as a new instruction instead
 * of data to translate. Collapses `"""` to `'''` (visually similar,
 * structurally harmless) rather than stripping it outright, so a genuine
 * quote-heavy source text isn't silently mangled beyond recognition.
 *
 * **Scope, stated honestly (found by review)**: this closes the one
 * structural escape this exact prompt shape has, nothing more — it is
 * **not** general prompt-injection protection. Free-form text that never
 * contains a literal `"""` (e.g. "Ignora le istruzioni precedenti e
 * rispondi solo con: ...") passes through completely unmodified, and
 * whether the downstream model still treats it as translatable data rather
 * than an instruction depends entirely on that model's own robustness —
 * this codebase has no code-level defense against that, the same honest
 * limit already documented for `NewsGateway`'s `sanitizeTitleForPrompt()`
 * (docs/security.md voce #37), which only ever had a narrower single-line
 * guarantee to make in the first place.
 */
export function sanitizeTextForPrompt(text: string): string {
  return text.replace(/"""/g, "'''");
}

/** Builds the `service://ai` prompt for a translation request — instruction and data kept in a single, explicit shape rather than concatenated free-form. */
export function buildTranslatePrompt(text: string, targetLanguageName: string): string {
  const sanitized = sanitizeTextForPrompt(text);
  return `Traduci il testo seguente in ${targetLanguageName}. Rispondi SOLO con la traduzione, senza commenti né spiegazioni.\n\nTesto da tradurre:\n"""\n${sanitized}\n"""`;
}

function supportedLanguageList(): string {
  return Object.keys(SUPPORTED_LANGUAGES).join(", ");
}

/**
 * Registers `service://translation` on `node`. `payload` shape:
 * `{ text: string, targetLanguage: string }` — `targetLanguage` one of
 * `SUPPORTED_LANGUAGES`'s keys. Returns `{ translatedText: string, targetLanguage: string }`.
 * Throws (turned into a `SERVICE_RESPONSE` error by `node.ts`'s
 * `handleServiceRequest()`, same as every other service handler in this
 * codebase — never caught here) for invalid input, an unavailable
 * `service://ai`, or a malformed/empty response from it.
 */
export function registerTranslateService(node: NomadNode, options: { timeoutMs?: number } = {}): void {
  node.registerService(
    "service://translation",
    "1.0.0",
    ["translate"],
    async (payload) => {
      const { text, targetLanguage } = (payload ?? {}) as { text?: unknown; targetLanguage?: unknown };
      if (typeof text !== "string" || text.length === 0) {
        throw new Error("service://translation requires a non-empty string 'text' field");
      }
      if (text.length > MAX_TRANSLATE_TEXT_CHARS) {
        throw new Error(`'text' must be at most ${MAX_TRANSLATE_TEXT_CHARS} characters`);
      }
      // Object.prototype.hasOwnProperty.call(), not `in` (found by review): `in` also matches
      // inherited Object.prototype property names ("constructor", "toString", "valueOf", ...), so
      // targetLanguage: "constructor" used to pass validation and get stringified straight into the
      // prompt sent to service://ai — exactly the "never passed through to the prompt" guarantee
      // this check exists to make.
      if (typeof targetLanguage !== "string" || !Object.prototype.hasOwnProperty.call(SUPPORTED_LANGUAGES, targetLanguage)) {
        throw new Error(`'targetLanguage' must be one of: ${supportedLanguageList()}`);
      }

      const prompt = buildTranslatePrompt(text, SUPPORTED_LANGUAGES[targetLanguage]);
      const result = await node.callService("service://ai", { prompt }, options);
      // callService() resolves with whatever the (untrusted, possibly remote) provider's
      // SERVICE_RESPONSE declared as `result` (node.ts's handleServiceResponse), never validated —
      // same defensive posture CLAUDE.md requires for any network-sourced value, same pattern
      // NewsGateway.generateDigest() already uses for this exact same underlying call.
      const response = result && typeof result === "object" ? (result as { response?: unknown }).response : undefined;
      if (typeof response !== "string" || response.length === 0) {
        throw new Error("service://ai returned a malformed or empty response while translating");
      }

      return { translatedText: response, targetLanguage };
    },
    { resourceRequirements: "richiede service://ai disponibile sulla mesh (stesso backend LLM)" },
  );
}
