import { randomBytes } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

import {
  LAN_DISCOVERY_GROUP,
  LAN_DISCOVERY_MAX_DATAGRAM_BYTES,
  LAN_DISCOVERY_NONCE_BYTES,
  LAN_DISCOVERY_PORT,
  decodeLanDiscoveryDatagram,
  encodeLanDiscoveryAnnouncement,
  encodeLanDiscoveryQuery,
  isPrivateLanDiscoveryHost,
  type DiscoveredNodeRecord
} from "@joko/contracts";

export {
  LAN_DISCOVERY_GROUP,
  LAN_DISCOVERY_MAGIC,
  LAN_DISCOVERY_MAX_DATAGRAM_BYTES,
  LAN_DISCOVERY_NONCE_BYTES,
  LAN_DISCOVERY_PORT,
  LAN_DISCOVERY_PROTOCOL_VERSION,
  decodeLanDiscoveryDatagram,
  encodeLanDiscoveryAnnouncement,
  encodeLanDiscoveryQuery,
  isPrivateLanDiscoveryHost,
  validateDiscoveredNode,
  type DecodedLanDiscoveryDatagram,
  type DiscoveredNodeRecord
} from "@joko/contracts";

export const LAN_DISCOVERY_PEER_TTL_MS = 90_000;
export const LAN_DISCOVERY_ANNOUNCE_INTERVAL_MS = 30_000;

const MAX_PEERS = 256;
const MAX_RECENT_QUERIES = 512;
const QUERY_RESPONSE_WINDOW_MS = 1_000;

interface LanDiscoverySocket {
  bind(port: number, address: string, callback: () => void): void;
  addMembership(multicastAddress: string): void;
  setMulticastTTL(ttl: number): void;
  setMulticastLoopback(flag: boolean): void;
  send(message: Uint8Array, port: number, address: string, callback?: (error: Error | null) => void): void;
  close(callback?: () => void): void;
  on(event: "message", listener: (message: Buffer, remote: RemoteInfo) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
}

export interface LanDiscoveryServiceOptions {
  readonly self: () => DiscoveredNodeRecord;
  readonly now?: () => number;
  readonly peerTtlMs?: number;
  readonly announceIntervalMs?: number;
  readonly socketFactory?: () => LanDiscoverySocket;
  readonly onError?: (message: string) => void;
}

/**
 * A credential-free, process-local LAN bootstrap cache. UDP input is treated
 * as untrusted and never persisted. It only tells a UI which origin it may ask
 * for GetServerInfo/pairing; it grants no authority by itself.
 */
export class LanDiscoveryService {
  readonly #self: () => DiscoveredNodeRecord;
  readonly #now: () => number;
  readonly #peerTtlMs: number;
  readonly #announceIntervalMs: number;
  readonly #socketFactory: () => LanDiscoverySocket;
  readonly #onError: ((message: string) => void) | undefined;
  readonly #peers = new Map<string, DiscoveredNodeRecord>();
  readonly #recentQueries = new Map<string, number>();
  #socket: LanDiscoverySocket | undefined;
  #timer: NodeJS.Timeout | undefined;
  #started = false;

  constructor(options: LanDiscoveryServiceOptions) {
    this.#self = options.self;
    this.#now = options.now ?? Date.now;
    this.#peerTtlMs = boundedDuration(options.peerTtlMs ?? LAN_DISCOVERY_PEER_TTL_MS, 1_000, 10 * 60_000, "peer TTL");
    this.#announceIntervalMs = boundedDuration(
      options.announceIntervalMs ?? LAN_DISCOVERY_ANNOUNCE_INTERVAL_MS,
      1_000,
      this.#peerTtlMs,
      "announce interval"
    );
    this.#socketFactory = options.socketFactory ?? (() => createSocket({ type: "udp4", reuseAddr: true }) as Socket);
    this.#onError = options.onError;
  }

  get started(): boolean {
    return this.#started;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    const socket = this.#socketFactory();
    this.#socket = socket;
    socket.on("message", (message, remote) => this.#handle(message, remote));
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        socket.off("error", fail);
        reject(error);
      };
      socket.once("error", fail);
      socket.bind(LAN_DISCOVERY_PORT, "0.0.0.0", () => {
        socket.off("error", fail);
        try {
          socket.addMembership(LAN_DISCOVERY_GROUP);
          socket.setMulticastTTL(1);
          socket.setMulticastLoopback(true);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    }).catch((error: unknown) => {
      this.#socket = undefined;
      try { socket.close(); } catch { /* a failed bind may already own no handle */ }
      throw error;
    });
    socket.on("error", () => this.#onError?.("LAN discovery socket reported an I/O error."));
    this.#started = true;
    this.query();
    this.announce();
    this.#timer = setInterval(() => {
      this.#prune();
      this.announce();
    }, this.#announceIntervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#started = false;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket === undefined) return;
    await new Promise<void>((resolve) => {
      try { socket.close(resolve); } catch { resolve(); }
    });
  }

  /** Ask live peers to answer. Safe to call repeatedly; responses are deduplicated. */
  query(): void {
    this.#send(encodeLanDiscoveryQuery(randomBytes(LAN_DISCOVERY_NONCE_BYTES)), LAN_DISCOVERY_PORT, LAN_DISCOVERY_GROUP);
  }

  announce(): void {
    const node = { ...this.#self(), lastSeen: this.#now() };
    this.#send(encodeLanDiscoveryAnnouncement(randomBytes(LAN_DISCOVERY_NONCE_BYTES), node), LAN_DISCOVERY_PORT, LAN_DISCOVERY_GROUP);
  }

  /** The current node is always first, followed by live peers in stable order. */
  list(): readonly DiscoveredNodeRecord[] {
    this.#prune();
    const self = { ...this.#self(), lastSeen: this.#now() };
    return [
      self,
      ...[...this.#peers.values()]
        .filter((peer) => peer.serverId !== self.serverId)
        .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.serverId.localeCompare(right.serverId))
    ];
  }

  #handle(message: Buffer, remote: RemoteInfo): void {
    if (!isPrivateLanDiscoveryHost(remote.address)) return;
    const decoded = decodeLanDiscoveryDatagram(message, this.#now());
    if (decoded === undefined) return;
    if (decoded.kind === "query") {
      // Bound amplification by source, not by attacker-controlled nonce.
      const key = `${remote.address}:${remote.port}`;
      const now = this.#now();
      this.#pruneRecentQueries(now);
      if (this.#recentQueries.has(key) || this.#recentQueries.size >= MAX_RECENT_QUERIES) return;
      this.#recentQueries.set(key, now);
      const node = { ...this.#self(), lastSeen: now };
      this.#send(encodeLanDiscoveryAnnouncement(decoded.nonce, node), remote.port, remote.address);
      return;
    }
    const selfId = this.#self().serverId;
    if (decoded.node.serverId === selfId) return;
    if (!this.#peers.has(decoded.node.serverId) && this.#peers.size >= MAX_PEERS) this.#prune();
    if (!this.#peers.has(decoded.node.serverId) && this.#peers.size >= MAX_PEERS) return;
    this.#peers.set(decoded.node.serverId, { ...decoded.node, lastSeen: this.#now() });
  }

  #send(message: Uint8Array, port: number, address: string): void {
    const socket = this.#socket;
    if (socket === undefined || message.byteLength > LAN_DISCOVERY_MAX_DATAGRAM_BYTES) return;
    socket.send(message, port, address, (error) => {
      if (error !== null) this.#onError?.("LAN discovery datagram could not be sent.");
    });
  }

  #prune(): void {
    const cutoff = this.#now() - this.#peerTtlMs;
    for (const [serverId, node] of this.#peers) if (node.lastSeen < cutoff) this.#peers.delete(serverId);
    this.#pruneRecentQueries(this.#now());
  }

  #pruneRecentQueries(now: number): void {
    const cutoff = now - QUERY_RESPONSE_WINDOW_MS;
    for (const [key, seenAt] of this.#recentQueries) if (seenAt < cutoff) this.#recentQueries.delete(key);
  }
}

function boundedDuration(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError(`LAN discovery ${label} is invalid.`);
  return value;
}
