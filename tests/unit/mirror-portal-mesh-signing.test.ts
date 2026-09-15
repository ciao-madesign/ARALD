import { describe, expect, it } from "vitest";
import {
  MeshIdentity,
  computeContentId,
  contentSigningPayload,
  signDrop,
  dropKindPriority,
  signNodeAppend,
  signRelayCommand,
  DROP_CONTENT_NAME,
  DEFAULT_DROP_TTL_MS,
  MAX_DROP_TTL_MS,
  DEFAULT_NODE_APPEND_TTL_MS,
  MAX_NODE_APPEND_TTL_MS,
} from "../../mirror-portal/lib/mesh-signing.js";
// Real mesh implementations, imported ONLY here (never from mirror-portal's own production code —
// see mesh-signing.ts's own doc comment for why) specifically to prove the vendored copy is
// byte-for-byte compatible with what a real Box actually verifies against.
import { Identity } from "../../node/src/identity.js";
import { verifyContentSignature, computeContentId as realComputeContentId } from "../../node/src/content.js";
import { extractDropPayload } from "../../node/src/drops.js";
import { verifySignedNodeAppendSubmission } from "../../node/src/node-appends.js";
import { verifySignedRelayCommandSubmission } from "../../node/src/relay-registry.js";
import { Priority } from "../../node/src/packet.js";
import {
  DEFAULT_DROP_TTL_MS as REAL_DEFAULT_DROP_TTL_MS,
  MAX_DROP_TTL_MS as REAL_MAX_DROP_TTL_MS,
  DEFAULT_NODE_APPEND_TTL_MS as REAL_DEFAULT_NODE_APPEND_TTL_MS,
  MAX_NODE_APPEND_TTL_MS as REAL_MAX_NODE_APPEND_TTL_MS,
} from "../../node/src/node.js";

/**
 * `mirror-portal/lib/mesh-signing.ts` — vendored/duplicated crypto (not
 * imported from `node/src/*`, see that file's own doc comment for why).
 * The single property that matters most here: a signature this module
 * produces must verify against the REAL `node/src/identity.ts`/
 * `content.ts` a Box actually runs — proven by cross-checking against
 * those real implementations directly, not just against this module's own
 * mirrored logic (which would never catch drift between the two copies).
 */
describe("mirror-portal lib/mesh-signing (cross-verified against node/src/*)", () => {
  it("MeshIdentity.generate()'s signature verifies against the real Identity.verifyWithNodeId()", () => {
    const identity = MeshIdentity.generate();
    const data = Buffer.from("ciao mesh", "utf8");
    const signature = identity.sign(data);

    expect(Identity.verifyWithNodeId(identity.nodeId, data, signature)).toBe(true);
  });

  it("MeshIdentity.fromRawKeys() round-trips through the real Identity.fromRawKeys() with the same nodeId", () => {
    const original = MeshIdentity.generate();
    const publicRaw = original.exportRawPublicKey();
    const privateRaw = original.exportRawPrivateKey();

    const restoredHere = MeshIdentity.fromRawKeys(publicRaw, privateRaw);
    const restoredReal = Identity.fromRawKeys(publicRaw, privateRaw);

    expect(restoredHere.nodeId).toBe(original.nodeId);
    expect(restoredReal.nodeId).toBe(original.nodeId);
  });

  it("computeContentId() matches the real computeContentId() for the same bytes", () => {
    const data = Buffer.from("stesso contenuto", "utf8");
    expect(computeContentId(data)).toBe(realComputeContentId(data));
  });

  it("contentSigningPayload() produces bytes a real Identity's signature over the same fields verifies against", () => {
    const identity = MeshIdentity.generate();
    const fields = { contentId: "abc", name: "bulletin", mimeType: "text/plain", size: 10, publisherId: identity.nodeId, expiresAt: undefined };
    const signature = identity.sign(contentSigningPayload(fields));

    expect(Identity.verifyWithNodeId(identity.nodeId, contentSigningPayload(fields), signature)).toBe(true);
    // Also verify through the real ContentMetadata-shaped path, not just raw bytes.
    const metadata = { contentId: "abc", name: "bulletin", mimeType: "text/plain", size: 10, createdAt: Date.now(), publisherId: identity.nodeId, signature: signature.toString("hex") };
    expect(verifyContentSignature(metadata)).toBe(true);
  });

  it("signDrop() produces a ContentMetadata that verifyContentSignature() (real) accepts, and bytes extractDropPayload() (real) accepts", () => {
    const identity = MeshIdentity.generate();
    const signed = signDrop(identity, { text: "sentiero franato", lat: 45.5, lon: 7.5, kind: "hazard" });

    expect(signed.metadata.name).toBe(DROP_CONTENT_NAME);
    expect(verifyContentSignature(signed.metadata)).toBe(true);
    expect(realComputeContentId(signed.data)).toBe(signed.metadata.contentId);

    const parsedPayload = JSON.parse(signed.data.toString("utf8"));
    const payload = extractDropPayload(parsedPayload);
    expect(payload).toMatchObject({ text: "sentiero franato", lat: 45.5, lon: 7.5, kind: "hazard" });
  });

  it("signDrop() rejects a tampered payload — mutating the bytes after signing breaks verification", () => {
    const identity = MeshIdentity.generate();
    const signed = signDrop(identity, { text: "originale", lat: 1, lon: 1, kind: "info" });
    const tampered = Buffer.from("payload diverso", "utf8");

    expect(verifyContentSignature(signed.metadata)).toBe(true); // the real (untampered) bytes still verify
    expect(realComputeContentId(tampered)).not.toBe(signed.metadata.contentId); // tampered bytes would fail putVerified()'s hash check
  });

  it("dropKindPriority() matches the real Priority enum's numeric values (0=EMERGENCY, 2=MESSAGING, 4=CONTENT)", () => {
    expect(dropKindPriority("emergency")).toBe(Priority.EMERGENCY);
    expect(dropKindPriority("hazard")).toBe(Priority.MESSAGING);
    expect(dropKindPriority("info")).toBe(Priority.CONTENT);
  });

  it("signDrop() clamps expiresInMs to the same 72h max as node.ts's own MAX_DROP_TTL_MS", () => {
    const identity = MeshIdentity.generate();
    const signed = signDrop(identity, { text: "x", lat: 0, lon: 0, kind: "info", expiresInMs: 999 * 60 * 60 * 1000 });
    const maxExpected = Date.now() + 72 * 60 * 60 * 1000;
    expect(signed.metadata.expiresAt).toBeLessThanOrEqual(maxExpected + 1000); // small slack for test execution time
    expect(signed.metadata.expiresAt).toBeGreaterThan(Date.now() + 71 * 60 * 60 * 1000);
  });

  /**
   * Trovato dalla revisione (`docs/security.md` voce #81, punto 8): prima di questo test, la sola
   * sincronizzazione tra le costanti vendored qui e quelle reali in `node/src/node.ts` era un
   * commento — un cambio futuro a una delle due senza toccare l'altra sarebbe passato inosservato.
   * Ora entrambe le implementazioni esportano le proprie costanti e questo test le confronta
   * direttamente, così un domani il test fallisce invece di limitarsi a "drift silenzioso".
   */
  it("DEFAULT_DROP_TTL_MS/MAX_DROP_TTL_MS match node.ts's own real, currently-effective constants exactly", () => {
    expect(DEFAULT_DROP_TTL_MS).toBe(REAL_DEFAULT_DROP_TTL_MS);
    expect(MAX_DROP_TTL_MS).toBe(REAL_MAX_DROP_TTL_MS);
  });

  /**
   * `signNodeAppend()` — "Pezzo 2" del canale di comando (`docs/security.md` voce #82). Same
   * cross-verification discipline as `signDrop()` above: every assertion checks the vendored
   * output against the REAL `node/src/node-appends.ts`'s `verifySignedNodeAppendSubmission()`,
   * never just this module's own logic.
   */
  it("signNodeAppend() produces a submission the real verifySignedNodeAppendSubmission() accepts", () => {
    const identity = MeshIdentity.generate();
    const signed = signNodeAppend(identity, { text: "materiale da recuperare", kind: "hazard", targetNodeId: "box-1" });

    const verified = verifySignedNodeAppendSubmission(signed);
    expect(verified).toBeDefined();
    expect(verified?.publisherId).toBe(identity.nodeId);
    expect(verified?.targetNodeId).toBe("box-1");
    expect(verified?.kind).toBe("hazard");
  });

  it("signNodeAppend() rejects (via the real verifier) a submission tampered after signing", () => {
    const identity = MeshIdentity.generate();
    const signed = signNodeAppend(identity, { text: "originale", kind: "info", targetNodeId: "box-1" });

    expect(verifySignedNodeAppendSubmission({ ...signed, text: "testo diverso" })).toBeUndefined();
    expect(verifySignedNodeAppendSubmission({ ...signed, targetNodeId: "box-2" })).toBeUndefined();
  });

  it("signNodeAppend() clamps expiresInMs to the same 72h max as node.ts's own MAX_NODE_APPEND_TTL_MS", () => {
    const identity = MeshIdentity.generate();
    const signed = signNodeAppend(identity, { text: "x", kind: "info", targetNodeId: "box-1", expiresInMs: 999 * 60 * 60 * 1000 });
    const maxExpected = Date.now() + 72 * 60 * 60 * 1000;
    expect(signed.expiresAt).toBeLessThanOrEqual(maxExpected + 1000);
    expect(signed.expiresAt).toBeGreaterThan(Date.now() + 71 * 60 * 60 * 1000);
  });

  it("DEFAULT_NODE_APPEND_TTL_MS/MAX_NODE_APPEND_TTL_MS match node.ts's own real, currently-effective constants exactly", () => {
    expect(DEFAULT_NODE_APPEND_TTL_MS).toBe(REAL_DEFAULT_NODE_APPEND_TTL_MS);
    expect(MAX_NODE_APPEND_TTL_MS).toBe(REAL_MAX_NODE_APPEND_TTL_MS);
  });

  /**
   * `signRelayCommand()` — "Pezzo 4" del canale di comando (`docs/security.md` voce #83). Stessa
   * disciplina di cross-verifica: ogni assert controlla l'output vendored contro la REALE
   * `node/src/relay-registry.ts`'s `verifySignedRelayCommandSubmission()`.
   */
  it("signRelayCommand() produces a submission the real verifySignedRelayCommandSubmission() accepts", () => {
    const identity = MeshIdentity.generate();
    const signed = signRelayCommand(identity, "box-1");

    const verified = verifySignedRelayCommandSubmission(signed);
    expect(verified).toBeDefined();
    expect(verified?.publisherId).toBe(identity.nodeId);
    expect(verified?.targetNodeId).toBe("box-1");
    expect(verified?.command).toBe("reboot");
  });

  it("signRelayCommand() rejects (via the real verifier) a submission tampered after signing", () => {
    const identity = MeshIdentity.generate();
    const signed = signRelayCommand(identity, "box-1");

    expect(verifySignedRelayCommandSubmission({ ...signed, targetNodeId: "box-2" })).toBeUndefined();
    expect(verifySignedRelayCommandSubmission({ ...signed, timestamp: signed.timestamp + 1 })).toBeUndefined();
  });

  it("signRelayCommand() always uses Date.now() for timestamp, never a caller-supplied value — same replay-protection discipline as sendRelayCommand()", () => {
    const identity = MeshIdentity.generate();
    const before = Date.now();
    const signed = signRelayCommand(identity, "box-1");
    const after = Date.now();

    expect(signed.timestamp).toBeGreaterThanOrEqual(before);
    expect(signed.timestamp).toBeLessThanOrEqual(after);
  });
});
