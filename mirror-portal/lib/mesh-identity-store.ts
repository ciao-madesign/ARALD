import { getPool } from "./db";
import { withTransaction, type ConnectablePool } from "./auth-db";
import { MeshIdentity } from "./mesh-signing";
import { encryptMeshPrivateKey, decryptMeshPrivateKey } from "./mesh-key-encryption";

/**
 * Custody of each operator's dedicated mesh Ed25519 identity (Pezzo 1 del
 * canale di comando, `docs/emergency-portal.md`) — the real cost of the
 * "ogni operatore ha una propria identità mesh" decision: a private key
 * that the mesh's own security model normally never leaves a single
 * device now lives, encrypted, on this server. Generated lazily (on an
 * operator's first remote command, not at account creation) so an
 * operator who never sends one never has key material to custody at all.
 *
 * `SELECT ... FOR UPDATE` inside a transaction, same pattern already used
 * by `assignNode()` (`lib/auth-db.ts`) for the same class of race: two
 * concurrent first-commands from an operator with no identity yet must
 * never both generate-and-store a *different* identity, the second write
 * silently winning — the mesh would then know this operator by whichever
 * key happened to be written last, and any command already delivered
 * signed by the other key becomes permanently unattributable.
 */
export async function getOrCreateMeshIdentity(userId: string, pool: ConnectablePool = getPool()): Promise<MeshIdentity> {
  return withTransaction(async (client) => {
    const res = await client.query(
      `SELECT mesh_public_key_hex, mesh_private_key_encrypted FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const row = res.rows[0] as { mesh_public_key_hex: string | null; mesh_private_key_encrypted: string | null } | undefined;
    if (!row) throw new Error(`operatore ${userId} non trovato`);

    if (row.mesh_private_key_encrypted && row.mesh_public_key_hex) {
      const privateKeyRaw = decryptMeshPrivateKey(row.mesh_private_key_encrypted);
      const publicKeyRaw = Buffer.from(row.mesh_public_key_hex, "hex");
      return MeshIdentity.fromRawKeys(publicKeyRaw, privateKeyRaw);
    }

    const identity = MeshIdentity.generate();
    const publicKeyHex = identity.exportRawPublicKey().toString("hex");
    const encrypted = encryptMeshPrivateKey(identity.exportRawPrivateKey());
    await client.query(`UPDATE users SET mesh_node_id = $1, mesh_public_key_hex = $2, mesh_private_key_encrypted = $3 WHERE id = $4`, [
      identity.nodeId,
      publicKeyHex,
      encrypted,
      userId,
    ]);
    return identity;
  }, pool);
}
