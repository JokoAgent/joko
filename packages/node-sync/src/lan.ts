import { createHash, randomBytes } from "node:crypto";
import dgram, { type RemoteInfo, type Socket as DgramSocket } from "node:dgram";
import net, { type Server, type Socket } from "node:net";

import {
  createNodeSyncLanProof,
  isValidNodeSyncPublicKey,
  verifyNodeSyncLanProof,
  type NodeSyncLanAuthContext,
  nodeSyncDomain,
  type NodeSyncPurpose
} from "./crypto.js";
import { isNodeSyncCipherChunkFrame, type NodeSyncCipherChunkFrame } from "./frames.js";

const DEFAULT_MULTICAST_GROUP = "239.255.74.75";
const DEFAULT_BEACON_INTERVAL_MILLISECONDS = 5_000;
const DEFAULT_ENDPOINT_TTL_MILLISECONDS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MILLISECONDS = 1_500;
const DIRECT_RETRY_COOLDOWN_MILLISECONDS = 60_000;
const MAX_PACKET_BYTES = 512 * 1024;
const MAX_CONCURRENT_CONNECTIONS = 32;
const MAX_PEER_ENDPOINTS = 256;

interface NodeSyncLanBeacon {
  readonly magic: string;
  readonly version: 1;
  readonly nodeId: string;
  readonly displayName: string;
  readonly publicKey: string;
  readonly port: number;
}

interface NodeSyncLanPacket {
  readonly version: 1;
  readonly sourceNodeId: string;
  readonly destinationNodeId: string;
  readonly challenge: string;
  readonly proof: string;
  readonly frame: NodeSyncCipherChunkFrame;
}

interface NodeSyncLanAck {
  readonly version: 1;
  readonly sourceNodeId: string;
  readonly destinationNodeId: string;
  readonly challenge: string;
  readonly transferId: string;
  readonly index: number;
  readonly proof: string;
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

/** A document owner must recheck this fence before committing an asynchronous delivery. */
export interface NodeSyncDeliveryContext {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

export class NodeSyncLanTransport {
  readonly #options: Required<Pick<NodeSyncLanTransportOptions,
    "multicastGroup" | "multicastPort" | "beaconIntervalMilliseconds" | "endpointTtlMilliseconds" |
    "connectTimeoutMilliseconds" | "multicastLoopback">> & NodeSyncLanTransportOptions;
  readonly #endpoints = new Map<string, PeerEndpoint>();
  readonly #retryAfter = new Map<string, { readonly until: number; readonly endpoint: PeerEndpoint }>();
  readonly #activeSockets = new Set<Socket>();
  #tcpServer?: Server;
  #udpSocket?: DgramSocket;
  #beaconTimer?: NodeJS.Timeout;
  #tcpPort?: number;
  #generation = 0;
  #abortController = new AbortController();

  constructor(options: NodeSyncLanTransportOptions) {
    this.#options = {
      ...options,
      multicastGroup: options.multicastGroup ?? DEFAULT_MULTICAST_GROUP,
      multicastPort: options.multicastPort ?? nodeSyncDomain(options.purpose).multicastPort,
      beaconIntervalMilliseconds: options.beaconIntervalMilliseconds ?? DEFAULT_BEACON_INTERVAL_MILLISECONDS,
      endpointTtlMilliseconds: options.endpointTtlMilliseconds ?? DEFAULT_ENDPOINT_TTL_MILLISECONDS,
      connectTimeoutMilliseconds: options.connectTimeoutMilliseconds ?? DEFAULT_CONNECT_TIMEOUT_MILLISECONDS,
      multicastLoopback: options.multicastLoopback ?? true
    };
    if (!isPort(this.#options.multicastPort) || this.#options.beaconIntervalMilliseconds < 100 ||
      this.#options.endpointTtlMilliseconds < this.#options.beaconIntervalMilliseconds ||
      this.#options.connectTimeoutMilliseconds < 100) {
      throw new TypeError("Node sync LAN transport options are invalid.");
    }
  }

  async start(): Promise<void> {
    if (this.#tcpServer !== undefined) return;
    const generation = ++this.#generation;
    this.#abortController = new AbortController();
    const server = net.createServer((socket) => this.#handleConnection(socket, generation));
    server.maxConnections = MAX_CONCURRENT_CONNECTIONS;
    this.#tcpServer = server;
    server.on("error", (error) => {
      this.#options.logger.warn("Node sync LAN listener failed.", { code: transportErrorCode(error) });
      if (this.#tcpServer === server) this.stop();
    });
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => reject(error);
      server.once("error", failed);
      server.listen({ host: "0.0.0.0", port: 0, exclusive: false }, () => {
        server.off("error", failed);
        if (generation !== this.#generation || this.#tcpServer !== server) {
          reject(new Error("Node sync LAN start was superseded."));
          return;
        }
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Node sync LAN listener address is unavailable."));
          return;
        }
        this.#tcpPort = address.port;
        resolve();
      });
    });
    server.unref();
    await this.#startDiscovery(generation);
  }

  stop(): void {
    this.#generation += 1;
    this.#abortController.abort(new Error("Node sync transport authority was retired."));
    if (this.#beaconTimer !== undefined) clearInterval(this.#beaconTimer);
    this.#beaconTimer = undefined;
    this.#udpSocket?.close();
    this.#udpSocket = undefined;
    this.#tcpServer?.close();
    this.#tcpServer = undefined;
    for (const socket of this.#activeSockets) socket.destroy();
    this.#activeSockets.clear();
    this.#tcpPort = undefined;
    this.#endpoints.clear();
    this.#retryAfter.clear();
    this.#options.onPresenceChanged?.();
  }

  candidates(now = Date.now()): readonly NodeSyncLanCandidate[] {
    this.#prune(now);
    return [...this.#endpoints.entries()].map(([nodeId, endpoint]) => ({
      nodeId,
      displayName: endpoint.displayName,
      publicKey: endpoint.publicKey,
      fingerprint: fingerprint(endpoint.publicKey),
      address: endpoint.address,
      port: endpoint.port,
      seenAt: endpoint.seenAt
    })).sort((left, right) => left.displayName.localeCompare(right.displayName, "en-US") || left.nodeId.localeCompare(right.nodeId, "en-US"));
  }

  onlinePeerIds(now = Date.now()): readonly string[] {
    this.#prune(now);
    return [...this.#endpoints.entries()].filter(([nodeId, endpoint]) =>
      this.#options.isPeerAllowed(nodeId, endpoint.publicKey) && !this.#retryAfter.has(nodeId)).map(([nodeId]) => nodeId).sort();
  }

  async send(nodeId: string, frame: NodeSyncCipherChunkFrame): Promise<boolean> {
    if (!isNodeSyncCipherChunkFrame(frame)) throw new Error("Node sync LAN frame is invalid.");
    const self = this.#options.getSelf();
    const generation = this.#generation;
    const now = Date.now();
    const retryAfter = this.#retryAfter.get(nodeId);
    if (retryAfter !== undefined && retryAfter.until > now) return false;
    if (retryAfter !== undefined) this.#retryAfter.delete(nodeId);
    const endpoint = this.#endpoints.get(nodeId);
    if (self === undefined || endpoint === undefined || frame.senderPublicKey !== self.publicKey ||
      this.#activeSockets.size >= MAX_CONCURRENT_CONNECTIONS || now - endpoint.seenAt > this.#options.endpointTtlMilliseconds ||
      !this.#isCurrent(generation, self, nodeId, endpoint.publicKey)) {
      if (endpoint !== undefined && now - endpoint.seenAt > this.#options.endpointTtlMilliseconds) this.#endpoints.delete(nodeId);
      return false;
    }
    const isCurrent = (): boolean => this.#isCurrent(generation, self, nodeId, endpoint.publicKey);
    const challenge = randomBytes(24).toString("base64");
    const auth = authContext("request", self.nodeId, nodeId, challenge, frame);
    const body = Buffer.from(JSON.stringify({
      version: 1,
      sourceNodeId: self.nodeId,
      destinationNodeId: nodeId,
      challenge,
      proof: createNodeSyncLanProof(this.#options.purpose, self.privateKey, endpoint.publicKey, auth),
      frame
    } satisfies NodeSyncLanPacket), "utf8");
    if (body.byteLength > MAX_PACKET_BYTES) return false;
    const packet = encodePacket(body);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let response = Buffer.alloc(0);
      let expected: number | undefined;
      const socket = net.createConnection({ host: endpoint.address, port: endpoint.port });
      this.#activeSockets.add(socket);
      const finish = (sent: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const current = isCurrent();
        this.#activeSockets.delete(socket);
        socket.destroy();
        if (current && sent) this.#retryAfter.delete(nodeId);
        else if (current) {
          const latest = this.#endpoints.get(nodeId);
          if (latest === undefined || sameRoute(latest, endpoint)) {
            this.#endpoints.delete(nodeId);
            this.#retryAfter.set(nodeId, { until: Date.now() + DIRECT_RETRY_COOLDOWN_MILLISECONDS, endpoint });
          }
          this.#options.onPresenceChanged?.();
        }
        resolve(current && sent);
      };
      const timer = setTimeout(() => finish(false), this.#options.connectTimeoutMilliseconds);
      timer.unref?.();
      socket.once("error", () => finish(false));
      socket.once("end", () => finish(false));
      socket.once("close", () => finish(false));
      socket.on("data", (chunk: Buffer) => {
        if (!isCurrent() || response.byteLength + chunk.byteLength > 4_100) return finish(false);
        response = Buffer.concat([response, chunk]);
        if (expected === undefined && response.byteLength >= 4) {
          expected = response.readUInt32BE(0);
          response = response.subarray(4);
          if (expected < 1 || expected > 4_096) return finish(false);
        }
        if (expected === undefined || response.byteLength < expected) return;
        if (response.byteLength !== expected) return finish(false);
        let parsed: unknown;
        try { parsed = JSON.parse(response.subarray(0, expected).toString("utf8")); } catch { return finish(false); }
        if (!isAck(parsed) || parsed.sourceNodeId !== nodeId || parsed.destinationNodeId !== self.nodeId ||
          parsed.challenge !== challenge || parsed.transferId !== frame.transferId || parsed.index !== frame.index) return finish(false);
        finish(verifyNodeSyncLanProof(this.#options.purpose, parsed.proof, self.privateKey, endpoint.publicKey, { ...auth, kind: "ack" }));
      });
      socket.once("connect", () => {
        if (!isCurrent()) return finish(false);
        socket.write(packet);
      });
    });
  }

  async #startDiscovery(generation: number): Promise<void> {
    const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.#udpSocket = udp;
    udp.on("error", (error) => {
      this.#options.logger.debug("Node sync LAN discovery is unavailable.", { code: transportErrorCode(error) });
      if (this.#udpSocket === udp) {
        udp.close();
        this.#udpSocket = undefined;
      }
    });
    udp.on("message", (message, remote) => {
      if (generation === this.#generation && this.#udpSocket === udp) this.#handleBeacon(message, remote);
    });
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => reject(error);
      udp.once("error", failed);
      udp.bind(this.#options.multicastPort, "0.0.0.0", () => {
        udp.off("error", failed);
        if (generation !== this.#generation || this.#udpSocket !== udp) {
          reject(new Error("Node sync LAN discovery start was superseded."));
          return;
        }
        try {
          udp.addMembership(this.#options.multicastGroup);
          udp.setMulticastTTL(1);
          udp.setMulticastLoopback(this.#options.multicastLoopback);
        } catch (error) {
          reject(error);
          return;
        }
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
    if (self === undefined || this.#udpSocket === undefined || this.#tcpPort === undefined) return;
    const beacon: NodeSyncLanBeacon = {
      magic: nodeSyncDomain(this.#options.purpose).magic,
      version: 1,
      nodeId: self.nodeId,
      displayName: self.displayName,
      publicKey: self.publicKey,
      port: this.#tcpPort
    };
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
    const endpoint: PeerEndpoint = {
      address: normalizeAddress(remote.address),
      port: parsed.port,
      publicKey: parsed.publicKey,
      displayName: parsed.displayName,
      seenAt: Date.now()
    };
    this.#endpoints.set(parsed.nodeId, endpoint);
    const retryAfter = this.#retryAfter.get(parsed.nodeId);
    if (retryAfter !== undefined && (retryAfter.until <= endpoint.seenAt ||
      (retryAfter.endpoint.publicKey === endpoint.publicKey && !sameRoute(retryAfter.endpoint, endpoint) &&
        this.#options.isPeerAllowed(parsed.nodeId, endpoint.publicKey)))) this.#retryAfter.delete(parsed.nodeId);
    this.#options.onCandidate({
      nodeId: parsed.nodeId,
      displayName: parsed.displayName,
      publicKey: parsed.publicKey,
      fingerprint: fingerprint(parsed.publicKey),
      address: endpoint.address,
      port: endpoint.port,
      seenAt: endpoint.seenAt
    });
    this.#options.onPresenceChanged?.();
  }

  #handleConnection(socket: Socket, generation: number): void {
    if (generation !== this.#generation || this.#activeSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.#activeSockets.add(socket);
    socket.once("close", () => this.#activeSockets.delete(socket));
    socket.setTimeout(this.#options.connectTimeoutMilliseconds, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let expected: number | undefined;
    let handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled || buffer.byteLength + chunk.byteLength > MAX_PACKET_BYTES + 4) return socket.destroy();
      buffer = Buffer.concat([buffer, chunk]);
      if (expected === undefined && buffer.byteLength >= 4) {
        expected = buffer.readUInt32BE(0);
        buffer = buffer.subarray(4);
        if (expected < 1 || expected > MAX_PACKET_BYTES) return socket.destroy();
      }
      if (expected === undefined || buffer.byteLength < expected) return;
      if (buffer.byteLength !== expected) return socket.destroy();
      handled = true;
      void this.#acceptPacket(socket, buffer.subarray(0, expected), generation);
    });
    socket.on("error", () => undefined);
  }

  async #acceptPacket(socket: Socket, body: Buffer, generation: number): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString("utf8")); } catch { socket.destroy(); return; }
    const self = this.#options.getSelf();
    if (self === undefined || !isPacket(parsed) || parsed.destinationNodeId !== self.nodeId ||
      !this.#isCurrent(generation, self, parsed.sourceNodeId, parsed.frame.senderPublicKey)) { socket.destroy(); return; }
    const auth = authContext("request", parsed.sourceNodeId, parsed.destinationNodeId, parsed.challenge, parsed.frame);
    if (!verifyNodeSyncLanProof(this.#options.purpose, parsed.proof, self.privateKey, parsed.frame.senderPublicKey, auth)) { socket.destroy(); return; }
    const isCurrent = (): boolean => !socket.destroyed && this.#isCurrent(generation, self, parsed.sourceNodeId, parsed.frame.senderPublicKey);
    try {
      await this.#options.onFrame(parsed.sourceNodeId, parsed.frame, { signal: this.#abortController.signal, isCurrent });
      if (!isCurrent()) { socket.destroy(); return; }
      const ack: NodeSyncLanAck = {
        version: 1,
        sourceNodeId: self.nodeId,
        destinationNodeId: parsed.sourceNodeId,
        challenge: parsed.challenge,
        transferId: parsed.frame.transferId,
        index: parsed.frame.index,
        proof: createNodeSyncLanProof(this.#options.purpose, self.privateKey, parsed.frame.senderPublicKey, { ...auth, kind: "ack" })
      };
      socket.end(encodePacket(Buffer.from(JSON.stringify(ack), "utf8")));
    } catch {
      socket.destroy();
    }
  }

  #prune(now: number): void {
    let changed = false;
    for (const [nodeId, endpoint] of this.#endpoints) {
      if (now - endpoint.seenAt > this.#options.endpointTtlMilliseconds) {
        this.#endpoints.delete(nodeId);
        changed = true;
      }
    }
    for (const [nodeId, retry] of this.#retryAfter) if (retry.until <= now) {
      this.#retryAfter.delete(nodeId);
      changed = true;
    }
    if (changed) this.#options.onPresenceChanged?.();
  }

  #isCurrent(generation: number, self: NodeSyncLanIdentity, peerId: string, peerKey: string): boolean {
    const current = this.#options.getSelf();
    return generation === this.#generation && this.#tcpServer !== undefined && !this.#abortController.signal.aborted &&
      current?.nodeId === self.nodeId && current.publicKey === self.publicKey && current.privateKey === self.privateKey &&
      this.#options.isPeerAllowed(peerId, peerKey);
  }
}

function authContext(kind: NodeSyncLanAuthContext["kind"], sourceNodeId: string, destinationNodeId: string,
  challenge: string, frame: NodeSyncCipherChunkFrame): NodeSyncLanAuthContext {
  return {
    kind,
    sourceNodeId,
    destinationNodeId,
    challenge,
    senderPublicKey: frame.senderPublicKey,
    transferId: frame.transferId,
    index: frame.index,
    total: frame.total,
    iv: frame.iv,
    tag: frame.tag,
    data: frame.data
  };
}

function sameRoute(first: PeerEndpoint, second: PeerEndpoint): boolean {
  return first.publicKey === second.publicKey && first.address === second.address && first.port === second.port;
}

function isBeacon(value: unknown, purpose: NodeSyncPurpose): value is NodeSyncLanBeacon {
  return isRecord(value) && hasOnlyKeys(value, ["magic", "version", "nodeId", "displayName", "publicKey", "port"]) &&
    value.magic === nodeSyncDomain(purpose).magic && value.version === 1 && isNodeId(value.nodeId) && isDisplayName(value.displayName) &&
    isValidNodeSyncPublicKey(value.publicKey) && isPort(value.port);
}

function isPacket(value: unknown): value is NodeSyncLanPacket {
  return isRecord(value) && hasOnlyKeys(value, ["version", "sourceNodeId", "destinationNodeId", "challenge", "proof", "frame"]) &&
    value.version === 1 && isNodeId(value.sourceNodeId) && isNodeId(value.destinationNodeId) &&
    isExactBase64(value.challenge, 24) && isExactBase64(value.proof, 32) && isNodeSyncCipherChunkFrame(value.frame);
}

function isAck(value: unknown): value is NodeSyncLanAck {
  return isRecord(value) && hasOnlyKeys(value, ["version", "sourceNodeId", "destinationNodeId", "challenge", "transferId", "index", "proof"]) &&
    value.version === 1 && isNodeId(value.sourceNodeId) && isNodeId(value.destinationNodeId) &&
    isExactBase64(value.challenge, 24) && isTransferId(value.transferId) && Number.isSafeInteger(value.index) &&
    (value.index as number) >= 0 && isExactBase64(value.proof, 32);
}

function encodePacket(body: Buffer): Buffer {
  const packet = Buffer.allocUnsafe(body.byteLength + 4);
  packet.writeUInt32BE(body.byteLength, 0);
  body.copy(packet, 4);
  return packet;
}

function fingerprint(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
}

function isExactBase64(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === bytes && decoded.toString("base64") === value;
}

function isNodeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function isDisplayName(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length >= 1 && value.length <= 100 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isTransferId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function normalizeAddress(value: string): string {
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

function transportErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && ["EADDRINUSE", "EACCES", "EADDRNOTAVAIL", "ENETUNREACH", "ECONNREFUSED"].includes(code)
    ? code : "unavailable";
}
