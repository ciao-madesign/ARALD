import type { Packet } from "./packet.js";

export interface PeerAddress {
  host: string;
  port: number;
}

export type PacketHandler = (packet: Packet, fromPeerId: string) => void;
export type PeerConnectedHandler = (peerId: string, address: PeerAddress | undefined) => void;
export type PeerDisconnectedHandler = (peerId: string) => void;

/**
 * Transport abstraction (spec §41). The routing engine and NomadNode depend
 * only on this interface, never on a concrete transport, so BLE/Wi-Fi
 * transports (spec §42-44, roadmap milestone 8/14) can be added later
 * without touching routing logic (spec §16, §67).
 */
export interface Transport {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Opens a connection to a peer and resolves once the peer's node id is known (handshake complete). */
  connect(address: PeerAddress): Promise<string>;
  send(peerId: string, packet: Packet): Promise<void>;
  onPacket(handler: PacketHandler): void;
  onPeerConnected(handler: PeerConnectedHandler): void;
  onPeerDisconnected(handler: PeerDisconnectedHandler): void;
}
