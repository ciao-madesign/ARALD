import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { getOrCreateMeshIdentity } from "../../mirror-portal/lib/mesh-identity-store.js";
import { encryptMeshPrivateKey } from "../../mirror-portal/lib/mesh-key-encryption.js";
import { MeshIdentity } from "../../mirror-portal/lib/mesh-signing.js";
import type { ConnectablePool } from "../../mirror-portal/lib/auth-db.js";

/** Same fake-pool convention as `mirror-portal-auth-db.test.ts` — resolves canned rows by SQL prefix, records every query. */
function createFakeClient(rowsByPrefix: Record<string, unknown[]> = {}) {
  const calls: { text: string; params: unknown[] }[] = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      const trimmed = text.trim();
      for (const prefix of Object.keys(rowsByPrefix)) {
        if (trimmed.startsWith(prefix)) return { rows: rowsByPrefix[prefix] };
      }
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;
  return { calls, pool: { connect: async () => client } satisfies ConnectablePool };
}

describe("mirror-portal lib/mesh-identity-store getOrCreateMeshIdentity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("generates and stores a new identity, inside a transaction, with a row locked via FOR UPDATE, when the user has none yet", async () => {
    vi.stubEnv("MESH_IDENTITY_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    const fake = createFakeClient({
      "SELECT mesh_public_key_hex": [{ mesh_public_key_hex: null, mesh_private_key_encrypted: null }],
    });

    const identity = await getOrCreateMeshIdentity("user-1", fake.pool);

    expect(identity.nodeId).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.calls.map((c) => c.text)).toEqual(["BEGIN", expect.stringContaining("FOR UPDATE"), expect.stringContaining("UPDATE users"), "COMMIT"]);
    const selectCall = fake.calls[1];
    expect(selectCall.params).toEqual(["user-1"]);
    const updateCall = fake.calls[2];
    expect(updateCall.params[0]).toBe(identity.nodeId); // mesh_node_id
    expect(updateCall.params[3]).toBe("user-1");
  });

  it("returns the SAME identity on a second call, decrypted from storage, without writing anything", async () => {
    vi.stubEnv("MESH_IDENTITY_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    const original = MeshIdentity.generate();
    const fake = createFakeClient({
      "SELECT mesh_public_key_hex": [
        {
          mesh_public_key_hex: original.exportRawPublicKey().toString("hex"),
          mesh_private_key_encrypted: encryptMeshPrivateKey(original.exportRawPrivateKey()),
        },
      ],
    });

    const identity = await getOrCreateMeshIdentity("user-1", fake.pool);

    expect(identity.nodeId).toBe(original.nodeId);
    expect(fake.calls.map((c) => c.text)).toEqual(["BEGIN", expect.stringContaining("FOR UPDATE"), "COMMIT"]); // no UPDATE
    // Signs the same way the original would — proves the private key round-tripped, not just the public half.
    const data = Buffer.from("prova", "utf8");
    expect(identity.sign(data)).toEqual(original.sign(data));
  });

  it("throws when the user id doesn't exist", async () => {
    vi.stubEnv("MESH_IDENTITY_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    const fake = createFakeClient({ "SELECT mesh_public_key_hex": [] });

    await expect(getOrCreateMeshIdentity("ghost", fake.pool)).rejects.toThrow(/non trovato/);
  });
});
