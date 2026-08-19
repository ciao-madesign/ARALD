import { BoundedFifoMap } from "./bounded-map.js";
import type { IdentityAnnouncement } from "./encryption.js";

export interface PeerDirectoryOptions {
  /**
   * Bounds memory (spec §57): once full, the oldest entry is evicted to
   * make room for a new node id, matching `RemoteCatalog`/`RoutingTable`.
   * Known trade-off: unlike `TrustManager` (which evicts its lowest-trust
   * entry first specifically to resist this), a peer can cheaply mint
   * throwaway keypairs and self-sign fresh `IdentityAnnouncement`s to evict
   * legitimately-learned entries — see docs/security.md.
   */
  maxSize?: number;
}

const DEFAULT_MAX_SIZE = 4096;

/**
 * Known bindings of node id -> encryption public key (spec §52), each
 * backed by a self-signed `IdentityAnnouncement` (encryption.ts) so it can
 * be safely re-shared with other peers without this node vouching for it
 * itself — the signature is the vouching. Propagated between directly
 * connected peers the same way `RemoteCatalog` propagates content
 * metadata (catalog.ts): request/response on every new connection,
 * verify-then-record, never trust an unsigned or forged claim.
 *
 * An identity's encryption key is treated as immutable once recorded —
 * this prototype never rotates `EncryptionIdentity`, so the first validly
 * signed binding for a node id is authoritative for that node's lifetime.
 */
export class PeerDirectory {
  private readonly entries: BoundedFifoMap<string, IdentityAnnouncement>;

  constructor(options: PeerDirectoryOptions = {}) {
    this.entries = new BoundedFifoMap({ maxSize: options.maxSize ?? DEFAULT_MAX_SIZE });
  }

  /** Records a (caller-verified) announcement. Returns false only if it was already known (a no-op, not an error). */
  record(announcement: IdentityAnnouncement): boolean {
    if (this.entries.has(announcement.nodeId)) return false;
    this.entries.set(announcement.nodeId, announcement);
    return true;
  }

  get(nodeId: string): IdentityAnnouncement | undefined {
    return this.entries.get(nodeId);
  }

  getKey(nodeId: string): string | undefined {
    return this.entries.get(nodeId)?.encryptionPublicKey;
  }

  has(nodeId: string): boolean {
    return this.entries.has(nodeId);
  }

  list(): IdentityAnnouncement[] {
    return Array.from(this.entries.values());
  }

  get size(): number {
    return this.entries.size;
  }
}
