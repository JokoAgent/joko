import { createHash } from "node:crypto";

import { isValidNodeSyncPublicKey, type NodeSyncPurpose } from "./crypto.js";
import { isNodeSyncCipherChunkFrame, type NodeSyncCipherChunkFrame } from "./frames.js";
import type { NodeSyncLanCandidate } from "./lan.js";
import {
  NodeSyncTcpTransport,
  validNodeSyncEndpoint,
  type NodeSyncDeliveryContext,
  type NodeSyncTcpIdentity,
  type NodeSyncTcpLogger
} from "./tcp.js";

const MAX_ENDPOINTS = 128;
const MAX_CONCURRENT_PROBES = 8;
const MIN_PROBE_INTERVAL_MILLISECONDS = 5_000;

export interface NodeSyncDirectEndpoint {
  readonly nodeId: string;
  readonly displayName: string;
  readonly publicKey: string;
  readonly host: string;
  readonly port: number;
  readonly revision: bigint;
}

export interface NodeSyncDirectTransportOptions {
  readonly purpose: NodeSyncPurpose;
  readonly getSelf: () => NodeSyncTcpIdentity | undefined;
  readonly isPeerAllowed: (nodeId: string, publicKey: string) => boolean;
  readonly getEndpoints: () => readonly NodeSyncDirectEndpoint[];
  readonly onCandidate: (candidate: NodeSyncLanCandidate) => void;
  readonly onFrame: (sourceNodeId: string, frame: NodeSyncCipherChunkFrame, delivery: NodeSyncDeliveryContext) => void | Promise<void>;
  readonly onPresenceChanged?: () => void;
  readonly logger: NodeSyncTcpLogger;
  readonly listenPort: number;
  readonly listenHost?: string;
  readonly connectTimeoutMilliseconds?: number;
  readonly probeIntervalMilliseconds?: number;
  readonly presenceTtlMilliseconds?: number;
  readonly retryCooldownMilliseconds?: number;
}

interface PendingProbe {
  readonly promise: Promise<boolean>;
  readonly resolve: (success: boolean) => void;
  readonly delivery?: NodeSyncDeliveryContext;
  started: boolean;
}

interface DirectRoute {
  endpoint: NodeSyncDirectEndpoint;
  readonly self: NodeSyncTcpIdentity;
  readonly generation: number;
  readonly controller: AbortController;
  nextProbeAt: number;
  authenticatedAt: number;
  onlineUntil: number;
  pending?: PendingProbe;
}

/** Explicit routes are eligible destinations; only a current authenticated probe establishes presence. */
export class NodeSyncDirectTransport {
  readonly #options: NodeSyncDirectTransportOptions;
  readonly #tcp: NodeSyncTcpTransport;
  readonly #probeInterval: number;
  readonly #presenceTtl: number;
  readonly #retryCooldown: number;
  readonly #routes = new Map<string, DirectRoute>();
  #queue: DirectRoute[] = [];
  #runningProbes = 0;
  #generation = 0;
  #started = false;
  #ready = false;
  #starting?: Promise<void>;
  #timer?: NodeJS.Timeout;
  #reconciling = false;
  #pumping = false;

  constructor(options: NodeSyncDirectTransportOptions) {
    this.#options = options;
    this.#probeInterval = options.probeIntervalMilliseconds ?? MIN_PROBE_INTERVAL_MILLISECONDS;
    this.#presenceTtl = options.presenceTtlMilliseconds ?? Math.max(60_000, this.#probeInterval);
    this.#retryCooldown = options.retryCooldownMilliseconds ?? 60_000;
    if (!Number.isSafeInteger(options.listenPort) || options.listenPort < 1 || options.listenPort > 65_535 ||
      !validNodeSyncEndpoint(options.listenHost ?? "0.0.0.0", options.listenPort) ||
      !Number.isSafeInteger(this.#probeInterval) || this.#probeInterval < MIN_PROBE_INTERVAL_MILLISECONDS ||
      !Number.isSafeInteger(this.#presenceTtl) || this.#presenceTtl < this.#probeInterval ||
      !Number.isSafeInteger(this.#retryCooldown) || this.#retryCooldown < 0) {
      throw new TypeError("Node sync direct transport options are invalid.");
    }
    this.#readEndpoints();
    this.#tcp = new NodeSyncTcpTransport({
      purpose: options.purpose,
      getSelf: options.getSelf,
      isPeerAllowed: options.isPeerAllowed,
      onFrame: options.onFrame,
      onPeerAuthenticated: (peerId, publicKey, delivery) => this.#authenticatedIngress(peerId, publicKey, delivery),
      logger: options.logger,
      listenHost: options.listenHost,
      listenPort: options.listenPort,
      connectTimeoutMilliseconds: options.connectTimeoutMilliseconds
    });
  }

  start(): Promise<void> {
    if (this.#starting !== undefined) return this.#starting;
    if (this.#started) return Promise.resolve();
    this.#started = true;
    const generation = ++this.#generation;
    const starting = this.#start(generation);
    this.#starting = starting;
    void starting.finally(() => {
      if (this.#starting === starting) this.#starting = undefined;
    }).catch(() => undefined);
    return starting;
  }

  async #start(generation: number): Promise<void> {
    try {
      await this.#tcp.start();
      if (!this.#started || generation !== this.#generation) throw new Error("Node sync direct start was superseded.");
      this.#ready = true;
      this.#tick();
      this.#timer = setInterval(() => this.#tick(), 1_000);
      this.#timer.unref();
    } catch (error) {
      if (generation === this.#generation) this.stop();
      throw error;
    }
  }

  stop(): void {
    const hadRoutes = this.#routes.size > 0;
    this.#started = false;
    this.#ready = false;
    this.#starting = undefined;
    this.#generation += 1;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    const routes = [...this.#routes.values()];
    this.#routes.clear();
    for (const route of routes) this.#retire(route);
    this.#queue = [];
    this.#tcp.stop();
    if (hadRoutes) this.#options.onPresenceChanged?.();
  }

  listenerPort(): number | undefined {
    return this.#tcp.listenerPort();
  }

  eligiblePeerIds(): readonly string[] {
    this.#reconcile();
    return [...this.#routes.keys()].sort();
  }

  onlinePeerIds(now = Date.now()): readonly string[] {
    this.#reconcile(now);
    return [...this.#routes.entries()].filter(([, route]) => route.onlineUntil > now).map(([nodeId]) => nodeId).sort();
  }

  candidates(now = Date.now()): readonly NodeSyncLanCandidate[] {
    this.#reconcile(now);
    return [...this.#routes.values()].filter((route) => route.onlineUntil > now).map((route) => this.#candidate(route))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "en-US") || left.nodeId.localeCompare(right.nodeId, "en-US"));
  }

  probe(peerId: string, delivery?: NodeSyncDeliveryContext): Promise<boolean> {
    if (!callerIsCurrent(delivery)) return Promise.resolve(false);
    this.#reconcile();
    const route = this.#routes.get(peerId);
    if (route === undefined || !this.#ready) return Promise.resolve(false);
    if (route.pending !== undefined) return waitForProbe(route.pending.promise, delivery);
    const now = Date.now();
    if (route.onlineUntil > now) return Promise.resolve(true);
    if (route.nextProbeAt > now) return Promise.resolve(false);
    return waitForProbe(this.#enqueue(route, delivery), delivery);
  }

  async send(peerId: string, frame: NodeSyncCipherChunkFrame, delivery?: NodeSyncDeliveryContext): Promise<boolean> {
    if (!isNodeSyncCipherChunkFrame(frame)) throw new Error("Node sync direct frame is invalid.");
    if (!callerIsCurrent(delivery)) return false;
    this.#reconcile();
    const route = this.#routes.get(peerId);
    if (route === undefined || frame.senderPublicKey !== route.self.publicKey) return false;
    if (route.onlineUntil <= Date.now()) {
      if (route.pending === undefined || !await this.probe(peerId, delivery)) return false;
      if (!this.#isCurrent(route) || !callerIsCurrent(delivery) || route.onlineUntil <= Date.now()) return false;
    }
    const sent = await this.#tcp.send(route.endpoint, peerId, frame, this.#delivery(route, delivery));
    if (!this.#isCurrent(route) || !callerIsCurrent(delivery)) return false;
    if (!sent) this.#failed(route, Date.now());
    return sent;
  }

  #authenticatedIngress(peerId: string, publicKey: string, delivery: NodeSyncDeliveryContext): void {
    if (!callerIsCurrent(delivery)) return;
    this.#reconcile();
    const route = this.#routes.get(peerId);
    if (route === undefined || route.endpoint.publicKey !== publicKey || !this.#isCurrent(route) || !callerIsCurrent(delivery) ||
      route.onlineUntil > Date.now() || route.pending !== undefined) return;
    // A newly reachable authenticated peer may wake a failed route; only the outgoing probe establishes presence.
    route.nextProbeAt = 0;
    this.#enqueue(route);
  }

  #readEndpoints(): readonly NodeSyncDirectEndpoint[] {
    const endpoints = this.#options.getEndpoints();
    if (!Array.isArray(endpoints) || endpoints.length > MAX_ENDPOINTS) throw new TypeError("Node sync direct endpoints are invalid.");
    const seen = new Set<string>();
    return endpoints.map((endpoint) => {
      if (typeof endpoint !== "object" || endpoint === null ||
        typeof endpoint.nodeId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(endpoint.nodeId) ||
        typeof endpoint.displayName !== "string" || endpoint.displayName !== endpoint.displayName.trim() ||
        endpoint.displayName.length < 1 || endpoint.displayName.length > 100 || /[\u0000-\u001f\u007f]/u.test(endpoint.displayName) ||
        !isValidNodeSyncPublicKey(endpoint.publicKey) || !validNodeSyncEndpoint(endpoint.host, endpoint.port) ||
        typeof endpoint.revision !== "bigint" || endpoint.revision <= 0n || seen.has(endpoint.nodeId)) {
        throw new TypeError("Node sync direct endpoint is invalid.");
      }
      seen.add(endpoint.nodeId);
      return { nodeId: endpoint.nodeId, displayName: endpoint.displayName, publicKey: endpoint.publicKey,
        host: endpoint.host, port: endpoint.port, revision: endpoint.revision };
    });
  }

  #reconcile(now = Date.now()): void {
    if (!this.#started || this.#reconciling) return;
    this.#reconciling = true;
    let changed = false;
    const added: DirectRoute[] = [];
    try {
      const self = this.#options.getSelf();
      const endpoints = new Map(this.#readEndpoints().filter((endpoint) => self !== undefined && endpoint.nodeId !== self.nodeId &&
        this.#options.isPeerAllowed(endpoint.nodeId, endpoint.publicKey)).map((endpoint) => [endpoint.nodeId, endpoint]));
      for (const [peerId, route] of this.#routes) {
        const endpoint = endpoints.get(peerId);
        if (self === undefined || !sameIdentity(route.self, self) || endpoint === undefined || !sameEndpoint(route.endpoint, endpoint)) {
          this.#routes.delete(peerId);
          this.#retire(route);
          changed = true;
        } else {
          route.endpoint = endpoint;
          if (route.onlineUntil > 0 && route.onlineUntil <= now) {
            route.onlineUntil = 0;
            changed = true;
          }
        }
      }
      if (self !== undefined) for (const [peerId, endpoint] of endpoints) {
        if (this.#routes.has(peerId)) continue;
        const route: DirectRoute = { endpoint, self: { ...self }, generation: this.#generation,
          controller: new AbortController(), nextProbeAt: 0, authenticatedAt: 0, onlineUntil: 0 };
        this.#routes.set(peerId, route);
        added.push(route);
        changed = true;
      }
    } finally {
      this.#reconciling = false;
    }
    if (changed) this.#options.onPresenceChanged?.();
    if (this.#ready) for (const route of added) if (this.#routes.get(route.endpoint.nodeId) === route) this.#enqueue(route);
  }

  #tick(): void {
    try {
      const now = Date.now();
      this.#reconcile(now);
      for (const route of this.#routes.values()) if (route.pending === undefined && route.nextProbeAt <= now) this.#enqueue(route);
      this.#pump();
    } catch {
      // An invalid replacement configuration retires authority rather than retaining a trusted old route.
      const routes = [...this.#routes.values()];
      this.#routes.clear();
      for (const route of routes) this.#retire(route);
      if (routes.length > 0) this.#options.onPresenceChanged?.();
      this.#options.logger.warn("Node sync direct endpoint configuration is unavailable.");
    }
  }

  #enqueue(route: DirectRoute, delivery?: NodeSyncDeliveryContext): Promise<boolean> {
    if (route.pending !== undefined) return route.pending.promise;
    let resolve!: (success: boolean) => void;
    const promise = new Promise<boolean>((complete) => { resolve = complete; });
    route.pending = { promise, resolve, started: false, delivery };
    this.#queue.push(route);
    this.#pump();
    return promise;
  }

  #pump(): void {
    if (!this.#ready || this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#runningProbes < MAX_CONCURRENT_PROBES && this.#queue.length > 0) {
        const route = this.#queue.shift()!;
        const pending = route.pending;
        if (pending === undefined) continue;
        if (!this.#isCurrent(route) || !callerIsCurrent(pending.delivery)) {
          pending.resolve(false);
          route.pending = undefined;
          continue;
        }
        pending.started = true;
        this.#runningProbes += 1;
        void this.#runProbe(route, pending).finally(() => {
          this.#runningProbes -= 1;
          this.#pump();
        });
      }
    } finally { this.#pumping = false; }
  }

  async #runProbe(route: DirectRoute, pending: PendingProbe): Promise<void> {
    let success = false;
    try {
      success = await this.#tcp.probe(route.endpoint, route.endpoint.nodeId, this.#delivery(route, pending.delivery));
      if (!this.#isCurrent(route) || !callerIsCurrent(pending.delivery)) success = false;
      else {
        const now = Date.now();
        if (success) {
          const becameOnline = route.onlineUntil <= now;
          route.authenticatedAt = now;
          route.onlineUntil = now + this.#presenceTtl;
          route.nextProbeAt = now + this.#probeInterval;
          if (becameOnline) {
            this.#options.onCandidate(this.#candidate(route));
            this.#options.onPresenceChanged?.();
          }
        } else this.#failed(route, now);
      }
    } catch {
      success = false;
      if (this.#isCurrent(route) && callerIsCurrent(pending.delivery)) this.#failed(route, Date.now());
    } finally {
      if (route.pending === pending) route.pending = undefined;
      pending.resolve(success && this.#isCurrent(route) && callerIsCurrent(pending.delivery));
    }
  }

  #failed(route: DirectRoute, now: number): void {
    const wasOnline = route.onlineUntil > 0;
    route.onlineUntil = 0;
    route.nextProbeAt = now + Math.max(this.#probeInterval, this.#retryCooldown);
    if (wasOnline) this.#options.onPresenceChanged?.();
  }

  #isCurrent(route: DirectRoute): boolean {
    try { this.#reconcile(); } catch { return false; }
    return this.#ready && this.#started && route.generation === this.#generation && !route.controller.signal.aborted &&
      this.#routes.get(route.endpoint.nodeId) === route;
  }

  #delivery(route: DirectRoute, caller?: NodeSyncDeliveryContext): NodeSyncDeliveryContext {
    return { signal: caller === undefined ? route.controller.signal : AbortSignal.any([route.controller.signal, caller.signal]),
      isCurrent: () => this.#isCurrent(route) && callerIsCurrent(caller) };
  }

  #retire(route: DirectRoute): void {
    route.controller.abort(new Error("Node sync direct route authority was retired."));
    if (route.pending !== undefined && !route.pending.started) {
      route.pending.resolve(false);
      route.pending = undefined;
    }
    this.#queue = this.#queue.filter((queued) => queued !== route);
  }

  #candidate(route: DirectRoute): NodeSyncLanCandidate {
    return { nodeId: route.endpoint.nodeId, displayName: route.endpoint.displayName, publicKey: route.endpoint.publicKey,
      fingerprint: createHash("sha256").update(Buffer.from(route.endpoint.publicKey, "base64")).digest("hex"),
      address: route.endpoint.host, port: route.endpoint.port, seenAt: route.authenticatedAt };
  }
}

function sameIdentity(left: NodeSyncTcpIdentity, right: NodeSyncTcpIdentity): boolean {
  return left.nodeId === right.nodeId && left.publicKey === right.publicKey && left.privateKey === right.privateKey;
}

function sameEndpoint(left: NodeSyncDirectEndpoint, right: NodeSyncDirectEndpoint): boolean {
  return left.nodeId === right.nodeId && left.publicKey === right.publicKey && left.host === right.host &&
    left.port === right.port && left.revision === right.revision;
}

function callerIsCurrent(delivery?: NodeSyncDeliveryContext): boolean {
  try { return delivery === undefined || !delivery.signal.aborted && delivery.isCurrent(); } catch { return false; }
}

function waitForProbe(promise: Promise<boolean>, delivery?: NodeSyncDeliveryContext): Promise<boolean> {
  if (delivery === undefined) return promise;
  return new Promise<boolean>((resolve) => {
    const aborted = (): void => { delivery.signal.removeEventListener("abort", aborted); resolve(false); };
    delivery.signal.addEventListener("abort", aborted, { once: true });
    if (!callerIsCurrent(delivery)) { aborted(); return; }
    void promise.then((success) => {
      delivery.signal.removeEventListener("abort", aborted);
      resolve(success && callerIsCurrent(delivery));
    }, aborted);
  });
}
