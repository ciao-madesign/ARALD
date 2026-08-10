import type { PeerAddress } from "./transport.js";

export interface PeerInfo {
  id: string;
  address?: PeerAddress;
  connectedAt: number;
  lastSeen: number;
}

/** Known-peers table (spec §7 "Peer Discovery"). Minimal in-memory version for the prototype. */
export class PeerTable {
  private readonly peers = new Map<string, PeerInfo>();

  upsert(id: string, address?: PeerAddress): PeerInfo {
    const existing = this.peers.get(id);
    const now = Date.now();
    if (existing) {
      existing.lastSeen = now;
      if (address) existing.address = address;
      return existing;
    }
    const info: PeerInfo = { id, address, connectedAt: now, lastSeen: now };
    this.peers.set(id, info);
    return info;
  }

  touch(id: string): void {
    const info = this.peers.get(id);
    if (info) info.lastSeen = Date.now();
  }

  remove(id: string): void {
    this.peers.delete(id);
  }

  get(id: string): PeerInfo | undefined {
    return this.peers.get(id);
  }

  has(id: string): boolean {
    return this.peers.has(id);
  }

  list(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  get size(): number {
    return this.peers.size;
  }
}
