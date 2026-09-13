import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EncryptionIdentity } from "../../node/src/encryption.js";
import { loadOrCreateDestinationKeypair } from "../../whatsapp-relay/keypair.js";

describe("loadOrCreateDestinationKeypair (whatsapp-relay/keypair.ts)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "arald-whatsapp-relay-keypair-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates and persists a new identity when the file doesn't exist yet", () => {
    const file = path.join(dir, "mario.json");

    const identity = loadOrCreateDestinationKeypair(file);

    const persisted = JSON.parse(readFileSync(file, "utf8")) as { publicKeyHex: string; privateKeyHex: string };
    expect(persisted.publicKeyHex).toBe(identity.publicKeyHex);
    expect(persisted.privateKeyHex).toBe(identity.exportRawPrivateKey().toString("hex"));
  });

  it("loads the same identity on a second call instead of generating a new one", () => {
    const file = path.join(dir, "mario.json");

    const first = loadOrCreateDestinationKeypair(file);
    const second = loadOrCreateDestinationKeypair(file);

    expect(second.publicKeyHex).toBe(first.publicKeyHex);
  });

  it("creates parent directories that don't exist yet", () => {
    const file = path.join(dir, "nested", "keys", "mario.json");

    expect(() => loadOrCreateDestinationKeypair(file)).not.toThrow();
    expect(readFileSync(file, "utf8")).toContain("publicKeyHex");
  });

  it("the reconstructed identity can actually derive a shared key matching a peer's own computation", () => {
    const file = path.join(dir, "mario.json");
    const identity = loadOrCreateDestinationKeypair(file);
    const reloaded = loadOrCreateDestinationKeypair(file);
    const peer = EncryptionIdentity.generate();

    expect(reloaded.sharedKeyWith(peer.publicKeyHex)).toEqual(identity.sharedKeyWith(peer.publicKeyHex));
  });
});
