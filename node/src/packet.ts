import { randomUUID } from "node:crypto";

/** Packet types (spec §49). Only the subset actually implemented so far — see docs/protocol.md. */
export enum MessageType {
  HELLO = "HELLO",
  PING = "PING",
  PONG = "PONG",
  PEER_LIST = "PEER_LIST",
  DATA = "DATA",
  ACK = "ACK",
  CONTENT_QUERY = "CONTENT_QUERY",
  CONTENT_FOUND = "CONTENT_FOUND",
  CONTENT_REQUEST = "CONTENT_REQUEST",
  CONTENT_CHUNK = "CONTENT_CHUNK",
  CONTENT_COMPLETE = "CONTENT_COMPLETE",
  SYNC_REQUEST = "SYNC_REQUEST",
  SYNC_RESPONSE = "SYNC_RESPONSE",
}

/** Traffic priority classes (spec §50). Carried as data only in the prototype — no differentiated scheduling yet. */
export enum Priority {
  EMERGENCY = 0,
  CONTROL = 1,
  MESSAGING = 2,
  SERVICE = 3,
  CONTENT = 4,
  BULK = 5,
}

export const PROTOCOL_VERSION = 1;
export const DEFAULT_TTL = 8;

/** Packet format (spec §15, §48), JSON-encoded for the first prototype. */
export interface Packet<T = unknown> {
  version: number;
  id: string;
  type: MessageType;
  source: string;
  /** Absent = broadcast/flood (e.g. CONTENT_QUERY); present = unicast toward a specific node id. */
  destination?: string;
  ttl: number;
  timestamp: number;
  priority: Priority;
  payload: T;
}

export interface CreatePacketOptions<T> {
  type: MessageType;
  source: string;
  payload: T;
  destination?: string;
  ttl?: number;
  priority?: Priority;
}

export function createPacket<T>(options: CreatePacketOptions<T>): Packet<T> {
  return {
    version: PROTOCOL_VERSION,
    id: randomUUID(),
    type: options.type,
    source: options.source,
    destination: options.destination,
    ttl: options.ttl ?? DEFAULT_TTL,
    timestamp: Date.now(),
    priority: options.priority ?? Priority.MESSAGING,
    payload: options.payload,
  };
}

/** Newline-delimited JSON framing, used by the TCP transport (spec §16). */
export function encodePacket(packet: Packet): string {
  return `${JSON.stringify(packet)}\n`;
}

export function decodePacket(line: string): Packet {
  const parsed: unknown = JSON.parse(line);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Packet).id !== "string" ||
    typeof (parsed as Packet).type !== "string" ||
    typeof (parsed as Packet).source !== "string" ||
    typeof (parsed as Packet).ttl !== "number"
  ) {
    throw new Error("malformed packet");
  }
  return parsed as Packet;
}
