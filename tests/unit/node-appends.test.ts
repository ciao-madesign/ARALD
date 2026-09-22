import { describe, expect, it, vi } from "vitest";
import {
  NodeAppends,
  extractNodeAppendPayload,
  nodeAppendSigningPayload,
  verifySignedNodeAppendSubmission,
  MAX_NODE_APPEND_LABEL_LENGTH,
  type NodeAppend,
  type NodeAppendPayload,
  type SignableNodeAppendFields,
} from "../../node/src/node-appends.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";
import { Identity } from "../../node/src/identity.js";

function validPayload(overrides: Partial<NodeAppendPayload> = {}): NodeAppendPayload {
  return { type: "node-append", text: "Sentiero 4 chiuso per frana.", kind: "info", timestamp: 100, expiresAt: Date.now() + 100000, ...overrides };
}

function append(overrides: Partial<NodeAppend> = {}): NodeAppend {
  return { appendId: "packet-1", author: "node-a", ...validPayload(), ...overrides };
}

describe("extractNodeAppendPayload", () => {
  it("accepts a well-formed payload without a label", () => {
    const payload = validPayload();
    expect(extractNodeAppendPayload(payload)).toEqual(payload);
  });

  it("accepts a well-formed payload with a label", () => {
    const payload = validPayload({ label: "Info" });
    expect(extractNodeAppendPayload(payload)).toEqual(payload);
  });

  it("rejects a wrong or missing type discriminator", () => {
    expect(extractNodeAppendPayload({ ...validPayload(), type: "chat" })).toBeUndefined();
    const { type: _type, ...withoutType } = validPayload();
    expect(extractNodeAppendPayload(withoutType)).toBeUndefined();
  });

  it("rejects a missing/non-string/empty/oversized text, same bound as MAX_MESSAGE_TEXT_LENGTH everywhere else", () => {
    expect(extractNodeAppendPayload({ ...validPayload(), text: undefined })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), text: 123 })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), text: "" })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1) })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH) })).toBeDefined();
  });

  it("rejects a missing/non-string/empty/oversized label, but tolerates a fully absent one", () => {
    expect(extractNodeAppendPayload({ ...validPayload(), label: 123 })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), label: "" })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), label: "x".repeat(MAX_NODE_APPEND_LABEL_LENGTH + 1) })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), label: "x".repeat(MAX_NODE_APPEND_LABEL_LENGTH) })).toBeDefined();
    expect(extractNodeAppendPayload(validPayload())).toBeDefined(); // no label field at all
  });

  it("rejects a missing/invalid kind, but accepts each of the three valid values", () => {
    expect(extractNodeAppendPayload({ ...validPayload(), kind: undefined })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), kind: "urgent" })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), kind: "info" })).toBeDefined();
    expect(extractNodeAppendPayload({ ...validPayload(), kind: "hazard" })).toBeDefined();
    expect(extractNodeAppendPayload({ ...validPayload(), kind: "emergency" })).toBeDefined();
  });

  it("rejects a missing/non-number/non-finite timestamp", () => {
    expect(extractNodeAppendPayload({ ...validPayload(), timestamp: undefined })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), timestamp: "12345" })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), timestamp: Number.NaN })).toBeUndefined();
  });

  it("rejects a missing/non-number/non-finite expiresAt", () => {
    expect(extractNodeAppendPayload({ ...validPayload(), expiresAt: undefined })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), expiresAt: "later" })).toBeUndefined();
    expect(extractNodeAppendPayload({ ...validPayload(), expiresAt: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("rejects a payload that isn't even an object, without throwing", () => {
    expect(extractNodeAppendPayload(undefined)).toBeUndefined();
    expect(extractNodeAppendPayload(null)).toBeUndefined();
    expect(extractNodeAppendPayload("append")).toBeUndefined();
    expect(extractNodeAppendPayload(42)).toBeUndefined();
    expect(extractNodeAppendPayload(["append"])).toBeUndefined();
  });
});

describe("NodeAppends", () => {
  it("records and lists appends, newest first", () => {
    const appends = new NodeAppends();
    appends.record(append({ appendId: "1", timestamp: 100, text: "primo" }));
    appends.record(append({ appendId: "2", timestamp: 300, text: "terzo" }));
    appends.record(append({ appendId: "3", timestamp: 200, text: "secondo" }));

    expect(appends.list().map((a) => a.text)).toEqual(["terzo", "secondo", "primo"]);
  });

  it("list() returns an empty array when nothing has been recorded, never undefined/throwing", () => {
    expect(new NodeAppends().list()).toEqual([]);
  });

  it("ignores a second record() for the same appendId — no duplicate entry", () => {
    const appends = new NodeAppends();
    appends.record(append({ appendId: "same-id", text: "hello" }));
    appends.record(append({ appendId: "same-id", text: "hello" }));

    expect(appends.list()).toHaveLength(1);
  });

  it("treats an expired append as absent from list(), and evicts it lazily rather than on a timer", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const appends = new NodeAppends();
      appends.record(append({ appendId: "expired", expiresAt: 500 }));
      appends.record(append({ appendId: "live", expiresAt: 100000 }));

      const listed = appends.list();
      expect(listed.map((a) => a.appendId)).toEqual(["live"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest append (plain FIFO) once maxNodeAppends is exceeded", () => {
    const appends = new NodeAppends({ maxNodeAppends: 2 });
    appends.record(append({ appendId: "1", timestamp: 1 }));
    appends.record(append({ appendId: "2", timestamp: 2 }));
    appends.record(append({ appendId: "3", timestamp: 3 })); // pushes out "1", the oldest

    const ids = appends.list().map((a) => a.appendId);
    expect(ids).toContain("2");
    expect(ids).toContain("3");
    expect(ids).not.toContain("1");
  });

  /**
   * `trustRank` wiring — trovato necessario dalla revisione ("Pezzo 2" del canale di comando,
   * `docs/security.md` voce #82): `NomadNode.ingestSignedNodeAppend()` registra entry senza passare
   * dal gate di fiducia mesh (`minTrustForNodeAppend`), quindi senza questo un burst di identità
   * mai vagliate poteva sfrattare entry legittime arrivate dal percorso mesh reale (già ≥VERIFIED).
   */
  it("with trustRank set, evicts the least-trusted entry first, never a higher-trust one, regardless of insertion order", () => {
    const trustOf: Record<string, number> = { alice: 10, bob: 0 };
    const appends = new NodeAppends({ maxNodeAppends: 2, trustRank: (author) => trustOf[author] ?? 0 });

    appends.record(append({ appendId: "trusted", author: "alice", timestamp: 1 }));
    appends.record(append({ appendId: "untrusted-1", author: "bob", timestamp: 2 }));
    appends.record(append({ appendId: "untrusted-2", author: "bob", timestamp: 3 })); // over capacity — must evict "untrusted-1" (bob, lower rank tie broken by insertion order), never "trusted" (alice)

    const ids = appends.list().map((a) => a.appendId);
    expect(ids).toContain("trusted");
    expect(ids).toContain("untrusted-2");
    expect(ids).not.toContain("untrusted-1");
  });

  it("without trustRank (the default), behaves exactly as plain FIFO even when authors have very different trust in principle", () => {
    // Same scenario as the plain-FIFO test above, just asserting that omitting trustRank keeps the
    // original behavior byte-for-byte — no accidental behavior change for every existing caller
    // that doesn't pass this new option.
    const appends = new NodeAppends({ maxNodeAppends: 2 });
    appends.record(append({ appendId: "1", author: "trusted-author", timestamp: 1 }));
    appends.record(append({ appendId: "2", author: "untrusted-author", timestamp: 2 }));
    appends.record(append({ appendId: "3", author: "untrusted-author", timestamp: 3 }));

    const ids = appends.list().map((a) => a.appendId);
    expect(ids).not.toContain("1"); // evicted purely by insertion order, trust never consulted
  });

  /**
   * Limite residuo, documentato onestamente (trovato da un secondo giro di revisione,
   * `docs/security.md` voce #82, stesso trattamento di `packet.source` in "Binding crittografico"):
   * su un PAREGGIO di trustRank, `bounded-map.ts`'s own tie-break (il più vecchio evitato per primo)
   * può comunque sfrattare un'entry legittima se la sua entry HTTP-ingested pareggia lo stesso rank
   * per qualche altra via (es. la stessa identità ha ottenuto VERIFIED anche come vero peer mesh —
   * `TrustLevel.VERIFIED` è documentato in `trust.ts` come economico da ottenere). `trustRank` da
   * solo non distingue "come" un'entry è arrivata, solo la fiducia attuale del suo autore — questo
   * test fissa il comportamento attuale (non ideale, ma noto) invece di lasciarlo silenzioso.
   */
  it("on a trustRank tie, still falls back to evicting the oldest entry — a known, accepted residual limitation", () => {
    const appends = new NodeAppends({ maxNodeAppends: 2, trustRank: () => 2 /* everyone ties at the same rank */ });

    appends.record(append({ appendId: "older-legitimate", author: "mesh-sourced-verified", timestamp: 1 }));
    appends.record(append({ appendId: "newer", author: "http-ingested-also-verified", timestamp: 2 }));
    appends.record(append({ appendId: "newest", author: "http-ingested-also-verified-2", timestamp: 3 }));

    const ids = appends.list().map((a) => a.appendId);
    // Documents the actual (imperfect) behavior: the older entry is evicted on a tie, even though
    // it's the "legitimate" one in this scenario — not the guarantee a reader might assume from
    // NodeAppends' own doc comment without reading its "known residual gap" paragraph.
    expect(ids).not.toContain("older-legitimate");
  });
});

/**
 * `nodeAppendSigningPayload()`/`verifySignedNodeAppendSubmission()` — "Pezzo 2" del canale di
 * comando Box↔specchio (`docs/security.md` voce #82), the remote-ingest counterpart of
 * `extractNodeAppendPayload()` above. Same combined shape+signature verification style as
 * `verifyGroupMessage()` (`groups.ts`).
 */
describe("verifySignedNodeAppendSubmission", () => {
  function validFields(overrides: Partial<SignableNodeAppendFields> = {}): Omit<SignableNodeAppendFields, "publisherId"> & { publisherId?: string } {
    return {
      text: "Materiale da recuperare",
      kind: "info",
      timestamp: 1000,
      expiresAt: Date.now() + 100000,
      targetNodeId: "box-1",
      ...overrides,
    };
  }

  function signedSubmission(identity: Identity, overrides: Partial<SignableNodeAppendFields> = {}) {
    const fields: SignableNodeAppendFields = { ...validFields(), publisherId: identity.nodeId, ...overrides };
    const signature = identity.sign(nodeAppendSigningPayload(fields)).toString("hex");
    return { ...fields, signature };
  }

  it("accepts a validly signed submission and returns its fields unchanged", () => {
    const identity = Identity.generate();
    const submission = signedSubmission(identity);

    expect(verifySignedNodeAppendSubmission(submission)).toEqual(submission);
  });

  it("accepts a submission with a label", () => {
    const identity = Identity.generate();
    const submission = signedSubmission(identity, { label: "Logistica" });

    expect(verifySignedNodeAppendSubmission(submission)?.label).toBe("Logistica");
  });

  it("rejects a submission whose signature doesn't match its fields (tampered after signing)", () => {
    const identity = Identity.generate();
    const submission = signedSubmission(identity);

    expect(verifySignedNodeAppendSubmission({ ...submission, text: "testo diverso" })).toBeUndefined();
    expect(verifySignedNodeAppendSubmission({ ...submission, kind: "emergency" })).toBeUndefined();
    expect(verifySignedNodeAppendSubmission({ ...submission, targetNodeId: "box-2" })).toBeUndefined();
    expect(verifySignedNodeAppendSubmission({ ...submission, expiresAt: submission.expiresAt + 1 })).toBeUndefined();
  });

  it("rejects a submission signed by one identity but claiming another's publisherId", () => {
    const identity = Identity.generate();
    const impostor = Identity.generate();
    const fields: SignableNodeAppendFields = { ...validFields(), publisherId: impostor.nodeId };
    // Signed by `identity`, but claims to be `impostor` — the signature won't verify against
    // impostor's public key.
    const signature = identity.sign(nodeAppendSigningPayload(fields)).toString("hex");

    expect(verifySignedNodeAppendSubmission({ ...fields, signature })).toBeUndefined();
  });

  it("rejects malformed signature hex or a publisherId that isn't a valid Ed25519 key, without throwing", () => {
    const identity = Identity.generate();
    const submission = signedSubmission(identity);

    expect(verifySignedNodeAppendSubmission({ ...submission, signature: "not-hex-!!" })).toBeUndefined();
    expect(verifySignedNodeAppendSubmission({ ...submission, publisherId: "not-a-valid-node-id" })).toBeUndefined();
  });

  it("rejects a missing/non-string/empty/oversized text, same bound as extractNodeAppendPayload()", () => {
    const identity = Identity.generate();
    expect(verifySignedNodeAppendSubmission({ ...signedSubmission(identity), text: undefined })).toBeUndefined();
    expect(verifySignedNodeAppendSubmission(signedSubmission(identity, { text: "" }))).toBeUndefined();
    expect(verifySignedNodeAppendSubmission(signedSubmission(identity, { text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1) }))).toBeUndefined();
  });

  it("rejects a missing/non-string/empty/oversized label, but tolerates a fully absent one and an at-the-limit one", () => {
    const identity = Identity.generate();
    expect(verifySignedNodeAppendSubmission(signedSubmission(identity, { label: "" }))).toBeUndefined();
    expect(verifySignedNodeAppendSubmission(signedSubmission(identity, { label: "x".repeat(MAX_NODE_APPEND_LABEL_LENGTH + 1) }))).toBeUndefined();
    expect(verifySignedNodeAppendSubmission(signedSubmission(identity, { label: "x".repeat(MAX_NODE_APPEND_LABEL_LENGTH) }))).toBeDefined();
    expect(verifySignedNodeAppendSubmission(signedSubmission(identity))).toBeDefined(); // no label field at all
  });

  it("rejects a missing/invalid kind", () => {
    const identity = Identity.generate();
    const submission = signedSubmission(identity);
    expect(verifySignedNodeAppendSubmission({ ...submission, kind: "urgent" })).toBeUndefined();
  });

  it("rejects a missing/empty targetNodeId or publisherId", () => {
    const identity = Identity.generate();
    const submission = signedSubmission(identity);
    expect(verifySignedNodeAppendSubmission({ ...submission, targetNodeId: "" })).toBeUndefined();
    expect(verifySignedNodeAppendSubmission({ ...submission, publisherId: "" })).toBeUndefined();
  });

  it("rejects a payload that isn't even an object, without throwing", () => {
    expect(verifySignedNodeAppendSubmission(undefined)).toBeUndefined();
    expect(verifySignedNodeAppendSubmission(null)).toBeUndefined();
    expect(verifySignedNodeAppendSubmission("submission")).toBeUndefined();
    expect(verifySignedNodeAppendSubmission(42)).toBeUndefined();
  });
});
