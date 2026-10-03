import { randomBytes } from "node:crypto";
import net, { type Server, type Socket } from "node:net";

import {
  createNodeSyncLanProof, createNodeSyncProbeProof, isValidNodeSyncPublicKey,
  verifyNodeSyncLanProof, verifyNodeSyncProbeProof,
  type NodeSyncLanAuthContext, type NodeSyncProbeAuthContext, type NodeSyncPurpose
} from "./crypto.js";
import { isNodeSyncCipherChunkFrame, type NodeSyncCipherChunkFrame } from "./frames.js";

const MAX_PACKET_BYTES = 512 * 1024;
const MAX_ACK_BYTES = 4_096;
const MAX_PROBE_BYTES = 1_024;
const MAX_CONCURRENT_CONNECTIONS = 32;

interface CipherPacket {
  readonly version: 1;
  readonly sourceNodeId: string;
  readonly destinationNodeId: string;
  readonly challenge: string;
  readonly proof: string;
  readonly frame: NodeSyncCipherChunkFrame;
}
interface CipherAck {
  readonly version: 1;
  readonly sourceNodeId: string;
  readonly destinationNodeId: string;
  readonly challenge: string;
  readonly transferId: string;
  readonly index: number;
  readonly proof: string;
}
interface ProbePacket {
  readonly version: 1;
  readonly type: "probe" | "probe-ack";
  readonly sourceNodeId: string;
  readonly destinationNodeId: string;
  readonly senderPublicKey: string;
  readonly challenge: string;
  readonly proof: string;
}

export interface NodeSyncTcpEndpoint {
  readonly host: string;
  readonly port: number;
  readonly publicKey: string;
}
export interface NodeSyncTcpIdentity {
  readonly nodeId: string;
  readonly displayName: string;
  readonly publicKey: string;
  readonly privateKey: string;
}
export interface NodeSyncTcpLogger {
  debug(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  warn(message: string, metadata?: Readonly<Record<string, unknown>>): void;
}
/** A document owner must recheck this fence before committing an asynchronous delivery. */
export interface NodeSyncDeliveryContext {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}
export interface NodeSyncTcpTransportOptions {
  readonly purpose: NodeSyncPurpose;
  readonly getSelf: () => NodeSyncTcpIdentity | undefined;
  readonly isPeerAllowed: (nodeId: string, publicKey: string) => boolean;
  readonly onFrame: (sourceNodeId: string, frame: NodeSyncCipherChunkFrame, delivery: NodeSyncDeliveryContext) => void | Promise<void>;
  readonly onPeerAuthenticated?: (sourceNodeId: string, publicKey: string, delivery: NodeSyncDeliveryContext) => void;
  readonly logger: NodeSyncTcpLogger;
  readonly listenPort?: number;
  readonly listenHost?: string;
  readonly connectTimeoutMilliseconds?: number;
}

/** Authenticated TCP exchange shared by discovery and explicit routes. It owns no peer grant or document. */
export class NodeSyncTcpTransport {
  readonly #options: NodeSyncTcpTransportOptions;
  readonly #timeout: number;
  readonly #activeSockets = new Set<Socket>();
  #server?: Server;
  #starting?: Promise<void>;
  #port?: number;
  #generation = 0;
  #abortController = new AbortController();

  constructor(options: NodeSyncTcpTransportOptions) {
    this.#options = options;
    this.#timeout = options.connectTimeoutMilliseconds ?? 1_500;
    const port = options.listenPort ?? 0;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535 ||
      !validHost(options.listenHost ?? "0.0.0.0") || !Number.isSafeInteger(this.#timeout) || this.#timeout < 100 || this.#timeout > 60_000) {
      throw new TypeError("Node sync TCP transport options are invalid.");
    }
  }

  start(): Promise<void> {
    if (this.#starting !== undefined) return this.#starting;
    if (this.#server !== undefined) return Promise.resolve();
    const generation = ++this.#generation;
    this.#abortController = new AbortController();
    const server = net.createServer((socket) => this.#handleConnection(socket, generation));
    server.maxConnections = MAX_CONCURRENT_CONNECTIONS;
    this.#server = server;
    server.on("error", (error) => {
      this.#options.logger.warn("Node sync TCP listener failed.", { code: transportErrorCode(error) });
      if (this.#server === server) this.stop();
    });
    const signal = this.#abortController.signal;
    let abortStart!: () => void;
    const starting = new Promise<void>((resolve, reject) => {
      abortStart = () => reject(new Error("Node sync TCP start was superseded."));
      signal.addEventListener("abort", abortStart, { once: true });
      const failed = (error: Error): void => reject(error);
      server.once("error", failed);
      server.listen({ host: this.#options.listenHost ?? "0.0.0.0", port: this.#options.listenPort ?? 0, exclusive: false }, () => {
        server.off("error", failed);
        if (generation !== this.#generation || this.#server !== server) {
          reject(new Error("Node sync TCP start was superseded."));
          return;
        }
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Node sync TCP listener address is unavailable."));
          return;
        }
        this.#port = address.port;
        server.unref();
        resolve();
      });
    }).finally(() => {
      signal.removeEventListener("abort", abortStart);
      if (this.#starting === starting) this.#starting = undefined;
    });
    this.#starting = starting;
    return starting;
  }

  stop(): void {
    this.#generation += 1;
    this.#abortController.abort(new Error("Node sync transport authority was retired."));
    const server = this.#server;
    this.#server = undefined;
    this.#starting = undefined;
    this.#port = undefined;
    server?.close();
    for (const socket of this.#activeSockets) socket.destroy();
    this.#activeSockets.clear();
  }

  listenerPort(): number | undefined { return this.#port; }

  async send(endpoint: NodeSyncTcpEndpoint, peerId: string, frame: NodeSyncCipherChunkFrame, delivery?: NodeSyncDeliveryContext): Promise<boolean> {
    if (!isNodeSyncCipherChunkFrame(frame)) throw new Error("Node sync TCP frame is invalid.");
    const self = this.#options.getSelf();
    const generation = this.#generation;
    if (self === undefined || frame.senderPublicKey !== self.publicKey || !this.#canRequest(endpoint, peerId, generation, self, delivery)) return false;
    const challenge = randomBytes(24).toString("base64");
    const auth = authContext("request", self.nodeId, peerId, challenge, frame);
    const body = Buffer.from(JSON.stringify({ version: 1, sourceNodeId: self.nodeId, destinationNodeId: peerId, challenge,
      proof: createNodeSyncLanProof(this.#options.purpose, self.privateKey, endpoint.publicKey, auth), frame } satisfies CipherPacket), "utf8");
    return this.#request(endpoint, peerId, self, generation, body, MAX_ACK_BYTES, (parsed) =>
      isAck(parsed) && parsed.sourceNodeId === peerId && parsed.destinationNodeId === self.nodeId && parsed.challenge === challenge &&
      parsed.transferId === frame.transferId && parsed.index === frame.index &&
      verifyNodeSyncLanProof(this.#options.purpose, parsed.proof, self.privateKey, endpoint.publicKey, { ...auth, kind: "ack" }), delivery);
  }

  async probe(endpoint: NodeSyncTcpEndpoint, peerId: string, delivery?: NodeSyncDeliveryContext): Promise<boolean> {
    const self = this.#options.getSelf();
    const generation = this.#generation;
    if (self === undefined || !this.#canRequest(endpoint, peerId, generation, self, delivery)) return false;
    const challenge = randomBytes(24).toString("base64");
    const auth: NodeSyncProbeAuthContext = { kind: "probe-request", sourceNodeId: self.nodeId, destinationNodeId: peerId,
      challenge, requesterPublicKey: self.publicKey, responderPublicKey: endpoint.publicKey };
    const body = Buffer.from(JSON.stringify({ version: 1, type: "probe", sourceNodeId: self.nodeId, destinationNodeId: peerId,
      senderPublicKey: self.publicKey, challenge,
      proof: createNodeSyncProbeProof(this.#options.purpose, self.privateKey, endpoint.publicKey, auth) } satisfies ProbePacket), "utf8");
    if (body.byteLength > MAX_PROBE_BYTES) return false;
    return this.#request(endpoint, peerId, self, generation, body, MAX_PROBE_BYTES, (parsed) =>
      isProbe(parsed, "probe-ack") && parsed.sourceNodeId === peerId && parsed.destinationNodeId === self.nodeId &&
      parsed.senderPublicKey === endpoint.publicKey && parsed.challenge === challenge &&
      verifyNodeSyncProbeProof(this.#options.purpose, parsed.proof, self.privateKey, endpoint.publicKey, { ...auth, kind: "probe-ack" }), delivery);
  }

  #canRequest(endpoint: NodeSyncTcpEndpoint, peerId: string, generation: number, self: NodeSyncTcpIdentity, delivery?: NodeSyncDeliveryContext): boolean {
    return validNodeSyncEndpoint(endpoint.host, endpoint.port) && isValidNodeSyncPublicKey(endpoint.publicKey) && isNodeId(peerId) &&
      this.#activeSockets.size < MAX_CONCURRENT_CONNECTIONS && this.#isCurrent(generation, self, peerId, endpoint.publicKey) &&
      (delivery === undefined || (!delivery.signal.aborted && delivery.isCurrent()));
  }

  #request(endpoint: NodeSyncTcpEndpoint, peerId: string, self: NodeSyncTcpIdentity, generation: number, body: Buffer,
    maxAck: number, accept: (parsed: unknown) => boolean, delivery?: NodeSyncDeliveryContext): Promise<boolean> {
    if (body.byteLength > MAX_PACKET_BYTES) return Promise.resolve(false);
    const isCurrent = (): boolean => this.#isCurrent(generation, self, peerId, endpoint.publicKey) &&
      (delivery === undefined || (!delivery.signal.aborted && delivery.isCurrent()));
    const transportSignal = this.#abortController.signal;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let closed = false;
      let result = false;
      let response = Buffer.alloc(0);
      let expected: number | undefined;
      const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
      this.#activeSockets.add(socket);
      const finish = (sent: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        transportSignal.removeEventListener("abort", aborted);
        delivery?.signal.removeEventListener("abort", aborted);
        result = isCurrent() && sent;
        socket.destroy();
        if (closed) { this.#activeSockets.delete(socket); resolve(result); }
      };
      const aborted = (): void => finish(false);
      const timer = setTimeout(aborted, this.#timeout);
      timer.unref?.();
      transportSignal.addEventListener("abort", aborted, { once: true });
      delivery?.signal.addEventListener("abort", aborted, { once: true });
      socket.once("error", aborted);
      socket.once("end", aborted);
      socket.once("close", () => {
        closed = true;
        finish(false);
        this.#activeSockets.delete(socket);
        resolve(result);
      });
      socket.on("data", (chunk: Buffer) => {
        if (!isCurrent() || response.byteLength + chunk.byteLength > maxAck + 4) return finish(false);
        response = Buffer.concat([response, chunk]);
        if (expected === undefined && response.byteLength >= 4) {
          expected = response.readUInt32BE(0);
          response = response.subarray(4);
          if (expected < 1 || expected > maxAck) return finish(false);
        }
        if (expected === undefined || response.byteLength < expected) return;
        if (response.byteLength !== expected) return finish(false);
        let parsed: unknown;
        try { parsed = JSON.parse(response.toString("utf8")); } catch { return finish(false); }
        finish(accept(parsed));
      });
      socket.once("connect", () => {
        if (!isCurrent()) return finish(false);
        socket.write(encodePacket(body));
      });
      if (!isCurrent()) finish(false);
    });
  }

  #handleConnection(socket: Socket, generation: number): void {
    if (generation !== this.#generation || this.#activeSockets.size >= MAX_CONCURRENT_CONNECTIONS) { socket.destroy(); return; }
    this.#activeSockets.add(socket);
    socket.once("close", () => this.#activeSockets.delete(socket));
    socket.setTimeout(this.#timeout, () => socket.destroy());
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
      const connection = new AbortController();
      const transportSignal = this.#abortController.signal;
      const departed = (): void => connection.abort(new Error("Node sync connection authority was retired."));
      transportSignal.addEventListener("abort", departed, { once: true });
      socket.once("close", () => { departed(); transportSignal.removeEventListener("abort", departed); });
      if (transportSignal.aborted || socket.destroyed) departed();
      void this.#acceptPacket(socket, buffer, generation, connection.signal);
    });
    socket.on("error", () => undefined);
  }

  async #acceptPacket(socket: Socket, body: Buffer, generation: number, signal: AbortSignal): Promise<void> {
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { socket.destroy(); return; }
      const self = this.#options.getSelf();
      if (self === undefined) { socket.destroy(); return; }
      if (isProbe(parsed, "probe")) {
        if (body.byteLength > MAX_PROBE_BYTES || parsed.destinationNodeId !== self.nodeId ||
          !this.#isCurrent(generation, self, parsed.sourceNodeId, parsed.senderPublicKey)) { socket.destroy(); return; }
        const auth: NodeSyncProbeAuthContext = { kind: "probe-request", sourceNodeId: parsed.sourceNodeId, destinationNodeId: self.nodeId,
          challenge: parsed.challenge, requesterPublicKey: parsed.senderPublicKey, responderPublicKey: self.publicKey };
        if (!verifyNodeSyncProbeProof(this.#options.purpose, parsed.proof, self.privateKey, parsed.senderPublicKey, auth)) { socket.destroy(); return; }
        const isCurrent = (): boolean => !signal.aborted && !socket.destroyed && this.#isCurrent(generation, self, parsed.sourceNodeId, parsed.senderPublicKey);
        this.#options.onPeerAuthenticated?.(parsed.sourceNodeId, parsed.senderPublicKey, { signal, isCurrent });
        if (!isCurrent()) { socket.destroy(); return; }
        const ack: ProbePacket = { version: 1, type: "probe-ack", sourceNodeId: self.nodeId, destinationNodeId: parsed.sourceNodeId,
          senderPublicKey: self.publicKey, challenge: parsed.challenge,
          proof: createNodeSyncProbeProof(this.#options.purpose, self.privateKey, parsed.senderPublicKey, { ...auth, kind: "probe-ack" }) };
        if (!this.#isCurrent(generation, self, parsed.sourceNodeId, parsed.senderPublicKey)) { socket.destroy(); return; }
        socket.end(encodePacket(Buffer.from(JSON.stringify(ack), "utf8")));
        return;
      }
      if (!isPacket(parsed) || parsed.destinationNodeId !== self.nodeId ||
        !this.#isCurrent(generation, self, parsed.sourceNodeId, parsed.frame.senderPublicKey)) { socket.destroy(); return; }
      const auth = authContext("request", parsed.sourceNodeId, parsed.destinationNodeId, parsed.challenge, parsed.frame);
      if (!verifyNodeSyncLanProof(this.#options.purpose, parsed.proof, self.privateKey, parsed.frame.senderPublicKey, auth)) { socket.destroy(); return; }
      const isCurrent = (): boolean => !signal.aborted && !socket.destroyed && this.#isCurrent(generation, self, parsed.sourceNodeId, parsed.frame.senderPublicKey);
      this.#options.onPeerAuthenticated?.(parsed.sourceNodeId, parsed.frame.senderPublicKey, { signal, isCurrent });
      if (!isCurrent()) { socket.destroy(); return; }
      await this.#options.onFrame(parsed.sourceNodeId, parsed.frame, { signal, isCurrent });
      if (!isCurrent()) { socket.destroy(); return; }
      const ack: CipherAck = { version: 1, sourceNodeId: self.nodeId, destinationNodeId: parsed.sourceNodeId, challenge: parsed.challenge,
        transferId: parsed.frame.transferId, index: parsed.frame.index,
        proof: createNodeSyncLanProof(this.#options.purpose, self.privateKey, parsed.frame.senderPublicKey, { ...auth, kind: "ack" }) };
      socket.end(encodePacket(Buffer.from(JSON.stringify(ack), "utf8")));
    } catch { socket.destroy(); }
  }

  #isCurrent(generation: number, self: NodeSyncTcpIdentity, peerId: string, peerKey: string): boolean {
    try {
      const current = this.#options.getSelf();
      return generation === this.#generation && this.#server !== undefined && !this.#abortController.signal.aborted &&
        current?.nodeId === self.nodeId && current.publicKey === self.publicKey && current.privateKey === self.privateKey &&
        this.#options.isPeerAllowed(peerId, peerKey);
    } catch { return false; }
  }
}

export function validNodeSyncEndpoint(host: unknown, port: unknown): boolean {
  return validHost(host) && Number.isSafeInteger(port) && (port as number) >= 1 && (port as number) <= 65_535;
}
function validHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 253 || value !== value.trim() || value.includes("%")) return false;
  if (net.isIP(value) !== 0) return true;
  if (value.split(".").every((label) => /^(?:\d+|0x[0-9a-f]+)$/iu.test(label))) return false;
  const host = value.endsWith(".") ? value.slice(0, -1) : value;
  return host.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
}
function authContext(kind: NodeSyncLanAuthContext["kind"], sourceNodeId: string, destinationNodeId: string,
  challenge: string, frame: NodeSyncCipherChunkFrame): NodeSyncLanAuthContext {
  return { kind, sourceNodeId, destinationNodeId, challenge, senderPublicKey: frame.senderPublicKey, transferId: frame.transferId,
    index: frame.index, total: frame.total, iv: frame.iv, tag: frame.tag, data: frame.data };
}
function isPacket(value: unknown): value is CipherPacket {
  return isRecord(value) && hasOnlyKeys(value, ["version", "sourceNodeId", "destinationNodeId", "challenge", "proof", "frame"]) &&
    value.version === 1 && isNodeId(value.sourceNodeId) && isNodeId(value.destinationNodeId) &&
    isExactBase64(value.challenge, 24) && isExactBase64(value.proof, 32) && isNodeSyncCipherChunkFrame(value.frame);
}
function isAck(value: unknown): value is CipherAck {
  return isRecord(value) && hasOnlyKeys(value, ["version", "sourceNodeId", "destinationNodeId", "challenge", "transferId", "index", "proof"]) &&
    value.version === 1 && isNodeId(value.sourceNodeId) && isNodeId(value.destinationNodeId) && isExactBase64(value.challenge, 24) &&
    typeof value.transferId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.transferId) &&
    Number.isSafeInteger(value.index) && (value.index as number) >= 0 && isExactBase64(value.proof, 32);
}
function isProbe(value: unknown, type: ProbePacket["type"]): value is ProbePacket {
  return isRecord(value) && hasOnlyKeys(value, ["version", "type", "sourceNodeId", "destinationNodeId", "senderPublicKey", "challenge", "proof"]) &&
    value.version === 1 && value.type === type && isNodeId(value.sourceNodeId) && isNodeId(value.destinationNodeId) &&
    isValidNodeSyncPublicKey(value.senderPublicKey) && isExactBase64(value.challenge, 24) && isExactBase64(value.proof, 32);
}
function encodePacket(body: Buffer): Buffer {
  const packet = Buffer.allocUnsafe(body.byteLength + 4);
  packet.writeUInt32BE(body.byteLength, 0);
  body.copy(packet, 4);
  return packet;
}
function isExactBase64(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === bytes && decoded.toString("base64") === value;
}
function isNodeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key));
}
function transportErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && ["EADDRINUSE", "EACCES", "EADDRNOTAVAIL", "ENETUNREACH", "ECONNREFUSED"].includes(code) ? code : "unavailable";
}
