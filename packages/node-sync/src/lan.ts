import { createHash } from "node:crypto";
import dgram, { type RemoteInfo, type Socket as DgramSocket } from "node:dgram";

import { isValidNodeSyncPublicKey, nodeSyncDomain, type NodeSyncPurpose } from "./crypto.js";
import { type NodeSyncCipherChunkFrame } from "./frames.js";
import { NodeSyncTcpTransport, type NodeSyncDeliveryContext } from "./tcp.js";
export type { NodeSyncDeliveryContext } from "./tcp.js";

const DEFAULT_MULTICAST_GROUP = "239.255.74.75";
const DEFAULT_BEACON_INTERVAL_MILLISECONDS = 5_000;
const DEFAULT_ENDPOINT_TTL_MILLISECONDS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MILLISECONDS = 1_500;
const DIRECT_RETRY_COOLDOWN_MILLISECONDS = 60_000;
const MAX_PEER_ENDPOINTS = 256;

interface NodeSyncLanBeacon {
  readonly magic: string;
  readonly version: 1;
  readonly nodeId: string;
  readonly displayName: string;
  readonly publicKey: string;
  readonly port: number;
}
interface PeerEndpoint {
  readonly address: string;
  readonly port: number;
  readonly publicKey: string;
  readonly displayName: string;
  readonly seenAt: number;
}
export interface NodeSyncLanCandidate {
  readonly nodeId: string;
  readonly displayName: string;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly address: string;
  readonly port: number;
  readonly seenAt: number;
}
export interface NodeSyncLanIdentity {
  readonly nodeId: string;
  readonly displayName: string;
  readonly publicKey: string;
  readonly privateKey: string;
}
export interface NodeSyncLanLogger {
  debug(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  warn(message: string, metadata?: Readonly<Record<string, unknown>>): void;
}
export interface NodeSyncLanTransportOptions {
  readonly purpose: NodeSyncPurpose;
  readonly getSelf: () => NodeSyncLanIdentity | undefined;
  readonly isPeerAllowed: (nodeId: string, publicKey: string) => boolean;
  readonly onCandidate: (candidate: NodeSyncLanCandidate) => void;
  readonly onFrame: (sourceNodeId: string, frame: NodeSyncCipherChunkFrame, delivery: NodeSyncDeliveryContext) => void | Promise<void>;
  readonly onPresenceChanged?: () => void;
  readonly logger: NodeSyncLanLogger;
  readonly multicastGroup?: string;
  readonly multicastPort?: number;
  readonly beaconIntervalMilliseconds?: number;
  readonly endpointTtlMilliseconds?: number;
  readonly connectTimeoutMilliseconds?: number;
  readonly multicastLoopback?: boolean;
}

export class NodeSyncLanTransport {
  readonly #options: Required<Pick<NodeSyncLanTransportOptions,
    "multicastGroup" | "multicastPort" | "beaconIntervalMilliseconds" | "endpointTtlMilliseconds" |
    "connectTimeoutMilliseconds" | "multicastLoopback">> & NodeSyncLanTransportOptions;
  readonly #tcp: NodeSyncTcpTransport;
  readonly #endpoints = new Map<string, PeerEndpoint>();
  readonly #retryAfter = new Map<string, { readonly until: number; readonly endpoint: PeerEndpoint }>();
  #udpSocket?: DgramSocket;
  #beaconTimer?: NodeJS.Timeout;
  #starting?: Promise<void>;
  #running = false;
  #generation = 0;

  constructor(options: NodeSyncLanTransportOptions) {
    this.#options = { ...options,
      multicastGroup: options.multicastGroup ?? DEFAULT_MULTICAST_GROUP,
      multicastPort: options.multicastPort ?? nodeSyncDomain(options.purpose).multicastPort,
      beaconIntervalMilliseconds: options.beaconIntervalMilliseconds ?? DEFAULT_BEACON_INTERVAL_MILLISECONDS,
      endpointTtlMilliseconds: options.endpointTtlMilliseconds ?? DEFAULT_ENDPOINT_TTL_MILLISECONDS,
      connectTimeoutMilliseconds: options.connectTimeoutMilliseconds ?? DEFAULT_CONNECT_TIMEOUT_MILLISECONDS,
      multicastLoopback: options.multicastLoopback ?? true };
    if (!isPort(this.#options.multicastPort) || this.#options.beaconIntervalMilliseconds < 100 ||
      this.#options.endpointTtlMilliseconds < this.#options.beaconIntervalMilliseconds || this.#options.connectTimeoutMilliseconds < 100) {
      throw new TypeError("Node sync LAN transport options are invalid.");
    }
    this.#tcp = new NodeSyncTcpTransport({ purpose: options.purpose, getSelf: options.getSelf, isPeerAllowed: options.isPeerAllowed,
      onFrame: options.onFrame, logger: { debug: (message, metadata) => options.logger.debug(message, metadata),
        warn: (message, metadata) => { options.logger.warn(message, metadata); this.stop(); } },
      connectTimeoutMilliseconds: this.#options.connectTimeoutMilliseconds });
  }

  start(): Promise<void> {
    if (this.#starting !== undefined) return this.#starting;
    if (this.#running) return Promise.resolve();
    const generation = ++this.#generation;
    this.#running = true;
    const starting = this.#tcp.start().then(async () => {
      if (generation !== this.#generation || !this.#running) throw new Error("Node sync LAN start was superseded.");
      await this.#startDiscovery(generation);
    }).catch((error: unknown) => { if (generation === this.#generation) this.stop(); throw error; })
      .finally(() => { if (this.#starting === starting) this.#starting = undefined; });
    this.#starting = starting;
    return starting;
  }

  stop(): void {
    this.#generation += 1;
    this.#running = false;
    this.#starting = undefined;
    if (this.#beaconTimer !== undefined) clearInterval(this.#beaconTimer);
    this.#beaconTimer = undefined;
    this.#udpSocket?.close();
    this.#udpSocket = undefined;
    this.#tcp.stop();
    this.#endpoints.clear();
    this.#retryAfter.clear();
    this.#options.onPresenceChanged?.();
  }

  listenerPort(): number | undefined { return this.#tcp.listenerPort(); }
  candidates(now = Date.now()): readonly NodeSyncLanCandidate[] {
    this.#prune(now);
    return [...this.#endpoints.entries()].map(([nodeId, endpoint]) => ({ nodeId, displayName: endpoint.displayName,
      publicKey: endpoint.publicKey, fingerprint: fingerprint(endpoint.publicKey), address: endpoint.address,
      port: endpoint.port, seenAt: endpoint.seenAt }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "en-US") || left.nodeId.localeCompare(right.nodeId, "en-US"));
  }
  onlinePeerIds(now = Date.now()): readonly string[] {
    this.#prune(now);
    return [...this.#endpoints.entries()].filter(([nodeId, endpoint]) =>
      this.#options.isPeerAllowed(nodeId, endpoint.publicKey) && !this.#retryAfter.has(nodeId)).map(([nodeId]) => nodeId).sort();
  }

  async send(nodeId: string, frame: NodeSyncCipherChunkFrame, delivery?: NodeSyncDeliveryContext): Promise<boolean> {
    const generation = this.#generation;
    const now = Date.now();
    const retryAfter = this.#retryAfter.get(nodeId);
    if (retryAfter !== undefined && retryAfter.until > now) return false;
    if (retryAfter !== undefined) this.#retryAfter.delete(nodeId);
    const endpoint = this.#endpoints.get(nodeId);
    if (endpoint === undefined || now - endpoint.seenAt > this.#options.endpointTtlMilliseconds) {
      if (endpoint !== undefined) this.#endpoints.delete(nodeId);
      return false;
    }
    const current = (): boolean => generation === this.#generation && this.#running &&
      this.#options.isPeerAllowed(nodeId, endpoint.publicKey) &&
      (delivery === undefined || (!delivery.signal.aborted && delivery.isCurrent()));
    const sent = await this.#tcp.send({ host: endpoint.address, port: endpoint.port, publicKey: endpoint.publicKey }, nodeId, frame, delivery);
    if (!current()) return false;
    if (sent) this.#retryAfter.delete(nodeId);
    else {
      const latest = this.#endpoints.get(nodeId);
      if (latest === undefined || sameRoute(latest, endpoint)) {
        this.#endpoints.delete(nodeId);
        this.#retryAfter.set(nodeId, { until: Date.now() + DIRECT_RETRY_COOLDOWN_MILLISECONDS, endpoint });
      }
      this.#options.onPresenceChanged?.();
    }
    return sent;
  }

  async #startDiscovery(generation: number): Promise<void> {
    const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.#udpSocket = udp;
    udp.on("error", (error) => {
      this.#options.logger.debug("Node sync LAN discovery is unavailable.", { code: transportErrorCode(error) });
      if (this.#udpSocket === udp) { udp.close(); this.#udpSocket = undefined; }
    });
    udp.on("message", (message, remote) => {
      if (generation === this.#generation && this.#udpSocket === udp) this.#handleBeacon(message, remote);
    });
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => reject(error);
      udp.once("error", failed);
      udp.bind(this.#options.multicastPort, "0.0.0.0", () => {
        udp.off("error", failed);
        if (generation !== this.#generation || this.#udpSocket !== udp) { reject(new Error("Node sync LAN discovery start was superseded.")); return; }
        try { udp.addMembership(this.#options.multicastGroup); udp.setMulticastTTL(1); udp.setMulticastLoopback(this.#options.multicastLoopback); }
        catch (error) { reject(error); return; }
        resolve();
      });
    });
    udp.unref();
    this.#sendBeacon();
    this.#beaconTimer = setInterval(() => this.#sendBeacon(), this.#options.beaconIntervalMilliseconds);
    this.#beaconTimer.unref?.();
  }
  #sendBeacon(): void {
    const self = this.#options.getSelf();
    const port = this.#tcp.listenerPort();
    if (self === undefined || this.#udpSocket === undefined || port === undefined) return;
    const beacon: NodeSyncLanBeacon = { magic: nodeSyncDomain(this.#options.purpose).magic, version: 1, nodeId: self.nodeId,
      displayName: self.displayName, publicKey: self.publicKey, port };
    const bytes = Buffer.from(JSON.stringify(beacon), "utf8");
    if (bytes.byteLength > 2_048) return;
    this.#udpSocket.send(bytes, this.#options.multicastPort, this.#options.multicastGroup, (error) => {
      if (error !== null) this.#options.logger.debug("Node sync LAN beacon failed.", { code: transportErrorCode(error) });
    });
  }
  #handleBeacon(message: Buffer, remote: RemoteInfo): void {
    if (message.byteLength > 2_048) return;
    let parsed: unknown;
    try { parsed = JSON.parse(message.toString("utf8")); } catch { return; }
    if (!isBeacon(parsed, this.#options.purpose)) return;
    const self = this.#options.getSelf();
    if (self === undefined || parsed.nodeId === self.nodeId) return;
    this.#prune(Date.now());
    if (!this.#endpoints.has(parsed.nodeId) && this.#endpoints.size >= MAX_PEER_ENDPOINTS) return;
    const endpoint: PeerEndpoint = { address: normalizeAddress(remote.address), port: parsed.port,
      publicKey: parsed.publicKey, displayName: parsed.displayName, seenAt: Date.now() };
    this.#endpoints.set(parsed.nodeId, endpoint);
    const retryAfter = this.#retryAfter.get(parsed.nodeId);
    if (retryAfter !== undefined && (retryAfter.until <= endpoint.seenAt ||
      (retryAfter.endpoint.publicKey === endpoint.publicKey && !sameRoute(retryAfter.endpoint, endpoint) &&
        this.#options.isPeerAllowed(parsed.nodeId, endpoint.publicKey)))) this.#retryAfter.delete(parsed.nodeId);
    this.#options.onCandidate({ nodeId: parsed.nodeId, displayName: parsed.displayName, publicKey: parsed.publicKey,
      fingerprint: fingerprint(parsed.publicKey), address: endpoint.address, port: endpoint.port, seenAt: endpoint.seenAt });
    this.#options.onPresenceChanged?.();
  }
  #prune(now: number): void {
    let changed = false;
    for (const [nodeId, endpoint] of this.#endpoints) if (now - endpoint.seenAt > this.#options.endpointTtlMilliseconds) {
      this.#endpoints.delete(nodeId); changed = true;
    }
    for (const [nodeId, retry] of this.#retryAfter) if (retry.until <= now) { this.#retryAfter.delete(nodeId); changed = true; }
    if (changed) this.#options.onPresenceChanged?.();
  }
}
function sameRoute(first: PeerEndpoint, second: PeerEndpoint): boolean { return first.publicKey === second.publicKey && first.address === second.address && first.port === second.port; }
function isBeacon(value: unknown, purpose: NodeSyncPurpose): value is NodeSyncLanBeacon {
  return isRecord(value) && hasOnlyKeys(value, ["magic", "version", "nodeId", "displayName", "publicKey", "port"]) &&
    value.magic === nodeSyncDomain(purpose).magic && value.version === 1 && isNodeId(value.nodeId) && isDisplayName(value.displayName) &&
    isValidNodeSyncPublicKey(value.publicKey) && isPort(value.port);
}
function fingerprint(publicKey: string): string { return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex"); }
function isNodeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value); }
function isDisplayName(value: unknown): value is string { return typeof value === "string" && value === value.trim() && value.length >= 1 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value); }
function isPort(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key)); }
function normalizeAddress(value: string): string { return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value; }
function transportErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && ["EADDRINUSE", "EACCES", "EADDRNOTAVAIL", "ENETUNREACH", "ECONNREFUSED"].includes(code) ? code : "unavailable";
}
