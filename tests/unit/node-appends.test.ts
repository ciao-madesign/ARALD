import { describe, expect, it, vi } from "vitest";
import { NodeAppends, extractNodeAppendPayload, MAX_NODE_APPEND_LABEL_LENGTH, type NodeAppend, type NodeAppendPayload } from "../../node/src/node-appends.js";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../node/src/message-history.js";

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
});
