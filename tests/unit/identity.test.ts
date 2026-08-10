import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Identity } from "../../node/src/identity.js";

describe("Identity", () => {
  it("generates a deterministic node id from the public key", () => {
    const identity = Identity.generate();
    expect(identity.nodeId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different node ids for different identities", () => {
    const a = Identity.generate();
    const b = Identity.generate();
    expect(a.nodeId).not.toBe(b.nodeId);
  });

  it("signs data that verifies with its own public key", () => {
    const identity = Identity.generate();
    const data = Buffer.from("evacuare zona X");
    const signature = identity.sign(data);
    expect(identity.verify(data, signature)).toBe(true);
  });

  it("rejects a signature over tampered data", () => {
    const identity = Identity.generate();
    const signature = identity.sign(Buffer.from("original"));
    expect(identity.verify(Buffer.from("tampered"), signature)).toBe(false);
  });

  it("verifies a signature against a node id without needing the Identity instance", () => {
    const identity = Identity.generate();
    const data = Buffer.from("hello mesh");
    const signature = identity.sign(data);
    expect(Identity.verifyWithNodeId(identity.nodeId, data, signature)).toBe(true);
  });

  it("persists and reloads the same identity from disk", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nomad-net-identity-"));
    try {
      const original = Identity.loadOrCreate(dir);
      const reloaded = Identity.loadOrCreate(dir);
      expect(reloaded.nodeId).toBe(original.nodeId);

      const data = Buffer.from("courier payload");
      const signature = reloaded.sign(data);
      expect(original.verify(data, signature)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
