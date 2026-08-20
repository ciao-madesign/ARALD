import { randomUUID } from "node:crypto";
import { BoundedFifoMap } from "../bounded-map.js";
import { MessageType, createPacket, decodePacket, encodePacket, type Packet } from "../packet.js";
import type {
  PacketHandler,
  PeerAddress,
  PeerConnectedHandler,
  PeerDisconnectedHandler,
  Transport,
} from "../transport.js";

/**
 * BLE's un-negotiated ATT MTU: 23 bytes total, 3 of which are protocol
 * header, leaving 20 usable. A real connection can negotiate up to 247
 * bytes (BLE 4.2+ Data Length Extension), but 20 is the value every device
 * must support without negotiation — deliberately used as the default here
 * so this transport genuinely exercises fragmentation (a single
 * `CONTENT_CHUNK`, 4096 content bytes plus JSON envelope, needs hundreds of
 * fragments at this MTU) rather than only working because the simulated
 * value happened to be generous. See `docs/next-steps.md` Option A.
 */
const DEFAULT_MTU = 20;

/** Commonly-cited typical simultaneous GATT connection limit for a BLE peripheral (varies by chipset/stack; this is a representative, not a spec-mandated, number). Enforced against *identified* peers only — see `MAX_PENDING_CONNECTIONS`. */
const DEFAULT_MAX_CONNECTIONS = 7;

/**
 * Ceiling on simultaneous *pending* (not-yet-identified) connections —
 * deliberately independent of, and much more generous than,
 * `maxConnections`. A handshake in flight can't yet be told apart from a
 * reconnect that's about to displace a stale entry at net-zero cost to the
 * identified-peer count (spec's own courier/reconnect scenario, §32), so
 * enforcing the real cap this early would wrongly refuse legitimate
 * reconnects whenever already at capacity. A pending connection is also
 * inherently self-expiring (`CONNECT_TIMEOUT_MS`), so this exists purely as
 * an anti-DoS bound (spec §57) against a flood of handshakes that never
 * complete, not a value meant to be tuned per deployment.
 */
const MAX_PENDING_CONNECTIONS = 32;

/** How long `connect()` waits for the peer to identify itself before giving up — mirrors `TcpTransport`'s `CONNECT_TIMEOUT_MS`. Nothing here can hang indefinitely the way a real dropped radio link could, but a torn-down connection or an unresponsive peer should still fail the caller's promise rather than leave it pending forever. */
const CONNECT_TIMEOUT_MS = 5000;

/** Small but nonzero simulated per-fragment link delay, so delivery is genuinely asynchronous relative to send() rather than resolving in the same tick — real BLE has materially higher per-packet latency than local TCP. */
const DEFAULT_LATENCY_MS = 5;

/** Bounds memory: a connection reassembling more distinct in-flight messages than this evicts the oldest one first (spec §57 resource limits, same posture as `ChunkAssembler` in content.ts). */
const MAX_CONCURRENT_REASSEMBLIES = 32;

/** Bounds memory: a fragment claiming more total pieces than this is rejected outright, before anything is stored — generous headroom over what any legitimate packet at the default MTU would ever produce. */
const MAX_FRAGMENTS_PER_MESSAGE = 8192;

interface Fragment {
  connectionId: string;
  msgId: string;
  index: number;
  total: number;
  bytes: Buffer;
}

interface ReassemblyEntry {
  chunks: Map<number, Buffer>;
  total: number;
}

/**
 * Reassembles fragmented packets for one simulated BLE connection.
 * Deliberately mirrors `ChunkAssembler`'s (content.ts) bounding discipline
 * even though today's "remote" is a trusted in-process object, not real
 * untrusted network input — the point of this transport is validating
 * logic shaped the way a real BLE implementation behind the same interface
 * would have to be, fragment reassembly included.
 */
class FragmentReassembler {
  private readonly entries = new BoundedFifoMap<string, ReassemblyEntry>({ maxSize: MAX_CONCURRENT_REASSEMBLIES });

  /** Returns the reassembled bytes once every fragment for `fragment.msgId` has arrived, otherwise undefined. */
  addFragment(fragment: Fragment): Buffer | undefined {
    const { msgId, index, total, bytes } = fragment;
    if (
      !Number.isInteger(total) ||
      total <= 0 ||
      total > MAX_FRAGMENTS_PER_MESSAGE ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= total
    ) {
      return undefined; // malformed or out-of-bounds claim — never trust it (spec §57)
    }

    let entry = this.entries.get(msgId);
    if (!entry) {
      entry = { chunks: new Map(), total };
      this.entries.set(msgId, entry);
    }
    entry.chunks.set(index, bytes);
    if (entry.chunks.size < entry.total) return undefined;

    const parts: Buffer[] = [];
    for (let i = 0; i < entry.total; i++) {
      const part = entry.chunks.get(i);
      if (!part) return undefined; // shouldn't happen given the bounds check above, but stay defensive
      parts.push(part);
    }
    this.entries.delete(msgId);
    return Buffer.concat(parts);
  }
}

/**
 * Shared "air" simulated BLE transports advertise on and discover each
 * other through — there is no real radio, so something has to stand in for
 * physical proximity. Most callers can share the default medium (every
 * `BleSimulatedTransport` not given one explicitly uses the same
 * process-wide instance); construct a fresh `BleMedium` to simulate two
 * meshes genuinely out of range of each other (mirrors the partition
 * scenario `tests/integration/partition-sync.test.ts` exercises over TCP).
 */
export class BleMedium {
  private readonly devices = new Map<string, BleSimulatedTransport>();

  register(deviceId: string, transport: BleSimulatedTransport): void {
    if (this.devices.has(deviceId)) {
      throw new Error(`a device is already advertising as ${deviceId} on this medium`);
    }
    this.devices.set(deviceId, transport);
  }

  unregister(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  find(deviceId: string): BleSimulatedTransport | undefined {
    return this.devices.get(deviceId);
  }
}

const DEFAULT_MEDIUM = new BleMedium();

export interface BleSimulatedTransportOptions {
  /** ATT MTU in bytes for this transport's connections — see `DEFAULT_MTU` for why 20 is the default. */
  mtu?: number;
  /** Max simultaneous connections this transport accepts or initiates — see `DEFAULT_MAX_CONNECTIONS`. */
  maxConnections?: number;
  /** Simulated per-fragment link latency in ms — see `DEFAULT_LATENCY_MS`. */
  latencyMs?: number;
  /** Which `BleMedium` this transport advertises/discovers on. Defaults to a single process-wide medium shared by every transport that doesn't specify one. */
  medium?: BleMedium;
}

interface ConnectionEntry {
  connectionId: string;
  remote: BleSimulatedTransport;
  remoteDeviceId: string;
  reassembler: FragmentReassembler;
  peerId?: string;
  /**
   * Set only on the initiating side while `connect()` is still pending —
   * resolved once the first packet reveals the peer's node id, or rejected
   * (and cleared) if the connection is closed or the timeout fires first.
   * Cleared once settled, so a later, unrelated close of this same entry
   * (e.g. its `stop()`) never touches an already-settled promise.
   */
  pendingConnect?: { resolve: (peerId: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
  /** Whether this side has already sent its own HELLO for this connection — see `sendHelloOnce()`. */
  helloSent: boolean;
}

/**
 * Simulated BLE transport (roadmap Milestone 8, `docs/next-steps.md`
 * Option A): implements the same `Transport` interface `TcpTransport` does,
 * so routing/content-centric/service-discovery logic above it is completely
 * unaware which one it's talking to (spec §16, §67) — but with no radio, no
 * `noble`/`bleno`, nothing behind it except JS objects and `setTimeout`.
 * Validates that this codebase's logic survives a link with BLE's real
 * shape (small MTU forcing transport-level fragmentation, a low concurrent
 * connection cap, nonzero per-packet latency) before any real BLE hardware
 * is involved — see `docs/next-steps.md` for why "a loopback BLE simulated
 * transport for automated tests" was always the planned first step here.
 *
 * Deliberate simplifications versus real BLE, all out of scope for what
 * this transport needs to prove:
 * - No central/peripheral role asymmetry — `connect()`/`start()` behave
 *   symmetrically on both sides, like `TcpTransport`. A real implementation
 *   behind this same interface would need to model GATT central vs.
 *   peripheral roles; this one doesn't need to, since NomadNode never
 *   depends on that distinction.
 * - No priority-based send scheduling (`PriorityQueue`, already proven at
 *   the TCP layer in Slice 4) — `send()` fires all of a packet's fragments
 *   independently rather than queuing behind a peer's in-flight traffic.
 *   Real BLE would benefit from it at least as much as TCP does, but
 *   proving the *fragmentation* story doesn't require it too.
 *
 * Handshake mirrors `TcpTransport` exactly: on connect, both ends send a
 * HELLO (fragmented like any other packet) whose `source` reveals their
 * node id; whichever packet arrives first identifies the connection.
 */
export class BleSimulatedTransport implements Transport {
  readonly id = "ble-simulated";

  private readonly medium: BleMedium;
  private readonly mtu: number;
  private readonly maxConnections: number;
  private readonly latencyMs: number;

  /** Every connection, pending or identified, keyed by the connectionId shared with the remote side — the canonical map fragments are routed through. */
  private readonly connectionsById = new Map<string, ConnectionEntry>();
  /** Only identified connections, keyed by peer node id — what `send()` and reconnect-displacement look up. */
  private readonly connectionsByPeerId = new Map<string, ConnectionEntry>();
  private readonly packetHandlers: PacketHandler[] = [];
  private readonly connectedHandlers: PeerConnectedHandler[] = [];
  private readonly disconnectedHandlers: PeerDisconnectedHandler[] = [];
  private started = false;

  constructor(
    private readonly localNodeId: string,
    /** This transport's own advertised address on its `medium` — reused as `PeerAddress.host` (spec's `PeerAddress` is TCP-shaped; `port` is always 0 here and otherwise ignored, rather than widening that interface for one transport). */
    private readonly deviceId: string,
    options: BleSimulatedTransportOptions = {},
  ) {
    this.medium = options.medium ?? DEFAULT_MEDIUM;
    this.mtu = Math.max(1, options.mtu ?? DEFAULT_MTU);
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.latencyMs = options.latencyMs ?? DEFAULT_LATENCY_MS;
  }

  async start(): Promise<void> {
    this.medium.register(this.deviceId, this);
    this.started = true;
  }

  async stop(): Promise<void> {
    for (const entry of [...this.connectionsById.values()]) this.closeConnection(entry, true);
    this.medium.unregister(this.deviceId);
    this.started = false;
  }

  private pendingConnectionCount(): number {
    return this.connectionsById.size - this.connectionsByPeerId.size;
  }

  connect(address: PeerAddress): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.started) {
        reject(new Error("BLE transport not started"));
        return;
      }
      const remote = this.medium.find(address.host);
      if (!remote) {
        reject(new Error(`no BLE device advertising as ${address.host}`));
        return;
      }
      if (this.pendingConnectionCount() >= MAX_PENDING_CONNECTIONS) {
        reject(new Error(`too many pending BLE connection attempts (${MAX_PENDING_CONNECTIONS})`));
        return;
      }

      const connectionId = randomUUID();
      if (!remote.acceptConnection(connectionId, this, this.deviceId)) {
        reject(new Error(`${address.host} refused the connection (its own connection limit reached, or not started)`));
        return;
      }

      const timer = setTimeout(() => {
        const pending = this.connectionsById.get(connectionId);
        if (pending && !pending.peerId) {
          this.closeConnection(pending, true, new Error(`connect timeout: ${address.host}`));
        }
      }, CONNECT_TIMEOUT_MS);

      const entry: ConnectionEntry = {
        connectionId,
        remote,
        remoteDeviceId: address.host,
        reassembler: new FragmentReassembler(),
        pendingConnect: { resolve, reject, timer },
        helloSent: false,
      };
      this.connectionsById.set(connectionId, entry);
      this.sendHelloOnce(entry).catch((err) => this.closeConnection(entry, true, err as Error));
    });
  }

  /**
   * Accepts an incoming connection request from `remote` — called on the
   * target transport by the initiating one, not part of the public
   * `Transport` interface. Returns false (refused) if this transport isn't
   * started or already has too many *pending* handshakes in flight — the
   * real `maxConnections` cap on distinct identified peers is enforced
   * later, in `handleIdentified()`, once it's actually known whether this
   * connection is a brand new peer or a reconnect that will displace a
   * stale entry at no net cost (see `MAX_PENDING_CONNECTIONS`).
   *
   * Deliberately does **not** send this side's own HELLO yet (unlike the
   * initiator's `connect()`, which sends eagerly) — until `handleIdentified()`
   * actually commits to accepting the connection, sending one here would let
   * the initiator successfully identify *this* side and resolve its
   * `connect()` promise even in a run where this side is about to refuse
   * the connection for being over `maxConnections`, a real race that
   * existed before this method deferred its reply.
   */
  private acceptConnection(connectionId: string, remote: BleSimulatedTransport, remoteDeviceId: string): boolean {
    if (!this.started || this.pendingConnectionCount() >= MAX_PENDING_CONNECTIONS) return false;
    const entry: ConnectionEntry = {
      connectionId,
      remote,
      remoteDeviceId,
      reassembler: new FragmentReassembler(),
      helloSent: false,
    };
    this.connectionsById.set(connectionId, entry);
    return true;
  }

  private async sendHelloOnce(entry: ConnectionEntry): Promise<void> {
    if (entry.helloSent) return;
    entry.helloSent = true;
    const hello = createPacket({ type: MessageType.HELLO, source: this.localNodeId, payload: {}, ttl: 1 });
    await this.transmit(entry, hello);
  }

  /**
   * Queues nothing (see the class doc's "deliberate simplifications") —
   * every fragment for this packet is scheduled for delivery independently
   * and concurrently, resolving once all of them have been handed to the
   * remote side's `receiveFragment()`.
   */
  async send(peerId: string, packet: Packet): Promise<void> {
    const entry = this.connectionsByPeerId.get(peerId);
    if (!entry) throw new Error(`no active BLE connection to peer ${peerId}`);
    await this.transmit(entry, packet);
  }

  private async transmit(entry: ConnectionEntry, packet: Packet): Promise<void> {
    const encoded = Buffer.from(encodePacket(packet), "utf8");
    const msgId = randomUUID();
    const total = Math.max(1, Math.ceil(encoded.length / this.mtu));
    const deliveries: Promise<void>[] = [];
    for (let index = 0; index < total; index++) {
      const bytes = Buffer.from(encoded.subarray(index * this.mtu, (index + 1) * this.mtu));
      const fragment: Fragment = { connectionId: entry.connectionId, msgId, index, total, bytes };
      deliveries.push(this.deliverFragment(entry, fragment));
    }
    await Promise.all(deliveries);
  }

  private deliverFragment(entry: ConnectionEntry, fragment: Fragment): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        entry.remote.receiveFragment(fragment);
        resolve();
      }, this.latencyMs);
    });
  }

  /** Called by the remote side once a fragment has "arrived" — looks up this transport's own connection entry by the connectionId shared between both ends. */
  private receiveFragment(fragment: Fragment): void {
    const entry = this.connectionsById.get(fragment.connectionId);
    if (!entry) return; // connection already torn down on this side — nothing to reassemble into

    const reassembled = entry.reassembler.addFragment(fragment);
    if (!reassembled) return;

    let packet: Packet;
    try {
      packet = decodePacket(reassembled.toString("utf8"));
    } catch {
      return; // malformed once fully reassembled — never trust it, same posture as TcpTransport's decodePacket try/catch
    }

    if (!entry.peerId) this.handleIdentified(entry, packet.source);
    for (const handler of this.packetHandlers) handler(packet, entry.peerId!);
  }

  private handleIdentified(entry: ConnectionEntry, peerId: string): void {
    const existing = this.connectionsByPeerId.get(peerId);
    if (!existing) {
      // First time we've heard from this peer — enforce the real cap only here, for a genuinely
      // new distinct peer. A reconnect (the branch below) always displaces at net-zero cost to
      // this count, so it must never be refused for being "at capacity".
      if (this.connectionsByPeerId.size >= this.maxConnections) {
        this.closeConnection(entry, true, new Error(`connection limit reached (${this.maxConnections})`));
        return;
      }
    } else {
      // A peer reconnecting before its old, now-stale connection was torn down (same reasoning as
      // TcpTransport's wireSocket — courier-style reconnects are exactly what this software exists
      // to tolerate). Prefer the new connection; tear the stale one all the way down, including
      // telling its own remote, so nothing is left orphaned on either side.
      this.closeConnection(existing, true);
    }

    entry.peerId = peerId;
    this.connectionsByPeerId.set(peerId, entry);
    if (entry.pendingConnect) {
      clearTimeout(entry.pendingConnect.timer);
      entry.pendingConnect.resolve(peerId);
      entry.pendingConnect = undefined;
    }
    // The accepting side's first chance to reply — a no-op if this side is the one that initiated
    // (it already sent its HELLO eagerly in connect()).
    void this.sendHelloOnce(entry);
    for (const handler of this.connectedHandlers) handler(peerId, { host: entry.remoteDeviceId, port: 0 });
  }

  /**
   * Tears down `entry`. Idempotent — a no-op if it's already gone from
   * `connectionsById` — so a close reaching the same entry twice (e.g. via
   * both `stop()`'s loop and a concurrent `handleRemoteClose()`) can never
   * double-fire `disconnectedHandlers` or settle an already-settled
   * `pendingConnect`. `reason`, if given, is what a still-pending
   * `connect()` rejects with; omitted, it gets a generic "closed before
   * identifying" error instead of hanging forever.
   */
  private closeConnection(entry: ConnectionEntry, notifyRemote: boolean, reason?: Error): void {
    if (this.connectionsById.get(entry.connectionId) !== entry) return;
    this.connectionsById.delete(entry.connectionId);

    if (entry.pendingConnect) {
      clearTimeout(entry.pendingConnect.timer);
      entry.pendingConnect.reject(
        reason ?? new Error(`BLE connection to ${entry.remoteDeviceId} closed before it could identify the peer`),
      );
      entry.pendingConnect = undefined;
    }

    if (entry.peerId) {
      if (this.connectionsByPeerId.get(entry.peerId) === entry) this.connectionsByPeerId.delete(entry.peerId);
      for (const handler of this.disconnectedHandlers) handler(entry.peerId);
    }
    if (notifyRemote) entry.remote.handleRemoteClose(entry.connectionId, reason);
  }

  /** Called by the remote side when *it* closes this connection (its own `stop()`, a reconnect displacing it, or a capacity refusal) — tears down the local half without bouncing a close notification back (the remote already knows), but still propagates `reason` so a pending `connect()` on this side rejects with the *actual* cause rather than a generic one. */
  private handleRemoteClose(connectionId: string, reason?: Error): void {
    const entry = this.connectionsById.get(connectionId);
    if (!entry) return;
    this.closeConnection(entry, false, reason);
  }

  onPacket(handler: PacketHandler): void {
    this.packetHandlers.push(handler);
  }

  onPeerConnected(handler: PeerConnectedHandler): void {
    this.connectedHandlers.push(handler);
  }

  onPeerDisconnected(handler: PeerDisconnectedHandler): void {
    this.disconnectedHandlers.push(handler);
  }
}
