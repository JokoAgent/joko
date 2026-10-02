import { createHash } from "node:crypto";

import {
  generateNodeSyncIdentity, isValidNodeSyncPrivateKey, isValidNodeSyncPublicKey, nodeSyncPublicKeyFromPrivate,
  type NodeSyncCipherChunkFrame, type NodeSyncDeliveryContext,
  type NodeSyncLanLogger, type NodeSyncLanTransportOptions
} from "@joko/node-sync";
import { VoiceDictionaryPeerStore, type VoiceDictionaryPeerGrant, type VoiceDictionaryPeerListener } from "@joko/store";
import { readVoiceDictionaryPeerInvitation } from "@joko/contracts";
import { buildStateVersionVector, type VoiceDictionarySyncState } from "@joko/voice-input";

import { CredentialVault } from "./credential-vault.js";
import { VoiceDictionaryPeerWorkerCodec } from "./voice-dictionary-sync-codec.js";
import { VoiceDictionarySyncRepository } from "./voice-dictionary-sync-repository.js";
import { VoiceDictionaryPeerWireDecoder, type VoiceDictionaryPeerCodec } from "./voice-dictionary-sync-wire.js";
import { createVoiceDictionaryPeerTransport, type VoiceDictionaryPeerTransport as PeerTransport } from "./voice-dictionary-peer-transport.js";

interface ManagedCodec extends VoiceDictionaryPeerCodec { reset?(): void; close?(): void; }
interface PendingExchange {
  readonly requestReply: boolean;
  readonly force: boolean;
  readonly delivery?: NodeSyncDeliveryContext;
}
export class VoiceDictionaryPeerManagerError extends Error {
  constructor(readonly code: "INVALID" | "UNAVAILABLE" | "DISABLED" | "CONFLICT" | "OFFLINE", message: string) {
    super(message);
    this.name = "VoiceDictionaryPeerManagerError";
  }
}
export interface VoiceDictionaryPeerStatus {
  readonly available: boolean;
  readonly configurationRevision: bigint;
  readonly nodeId: string;
  readonly fingerprint: string;
  readonly enabled: boolean;
  readonly phase: "off" | "waiting" | "syncing" | "up_to_date" | "error";
  readonly errorCode?: "identity_unavailable" | "dictionary_unavailable" | "sync_failed";
  readonly listener?: VoiceDictionaryPeerListener;
  readonly peers: readonly {
    readonly peerId: string; readonly revision: bigint; readonly displayName: string;
    readonly fingerprint: string; readonly online: boolean; readonly grantedAt: number; readonly lastSyncAt?: number;
    readonly route?: { readonly host: string; readonly port: number };
  }[];
  readonly candidates: readonly {
    readonly nodeId: string; readonly displayName: string; readonly fingerprint: string;
    readonly seenAt: number; readonly granted: boolean; readonly keyChanged: boolean;
  }[];
}

/** Owns only independent sharing authority and exchange, never a second dictionary or enabled setting. */
export class VoiceDictionaryPeerManager {
  readonly #store: VoiceDictionaryPeerStore;
  readonly #dictionary: VoiceDictionarySyncRepository;
  readonly #vault: CredentialVault;
  readonly #nodeId: string;
  readonly #displayName: string;
  readonly #codec: ManagedCodec;
  readonly #decoder: VoiceDictionaryPeerWireDecoder;
  readonly #transportFactory: (options: NodeSyncLanTransportOptions) => PeerTransport;
  readonly #logger: NodeSyncLanLogger;
  readonly #onChanged: () => void;
  readonly #debounce: number;
  readonly #fallback: number;
  readonly #unsubscribe: Array<() => void> = [];
  readonly #listeners = new Set<() => void>();
  readonly #peerKnown = new Map<string, string>();
  readonly #online = new Map<string, string>();
  readonly #sending = new Map<string, Promise<void>>();
  readonly #pendingExchange = new Map<string, PendingExchange>();
  #privateKey?: string;
  #transport?: PeerTransport;
  #starting?: Promise<void>;
  #changeTimer?: NodeJS.Timeout;
  #fallbackTimer?: NodeJS.Timeout;
  #abortController = new AbortController();
  #generation = 0;
  #enabled = false;
  #initialized = false;
  #closed = false;
  #errorCode?: VoiceDictionaryPeerStatus["errorCode"];

  constructor(options: {
    readonly store: VoiceDictionaryPeerStore; readonly dictionary: VoiceDictionarySyncRepository;
    readonly vault: CredentialVault; readonly nodeId: string; readonly displayName: string;
    readonly codec?: ManagedCodec; readonly transportFactory?: (options: NodeSyncLanTransportOptions) => PeerTransport;
    readonly logger?: NodeSyncLanLogger; readonly onChanged?: () => void;
    readonly debounceMilliseconds?: number; readonly fallbackMilliseconds?: number;
    readonly enableLan?: boolean;
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(options.nodeId) || options.displayName !== options.displayName.trim() ||
      options.displayName.length < 1 || options.displayName.length > 100 || /[\u0000-\u001f\u007f]/u.test(options.displayName)) throw new TypeError("Dictionary peer node metadata is invalid.");
    this.#store = options.store; this.#dictionary = options.dictionary; this.#vault = options.vault;
    this.#nodeId = options.nodeId; this.#displayName = options.displayName;
    this.#codec = options.codec ?? new VoiceDictionaryPeerWorkerCodec();
    this.#decoder = new VoiceDictionaryPeerWireDecoder(this.#codec);
    this.#transportFactory = options.transportFactory ?? ((value) => createVoiceDictionaryPeerTransport(value, this.#store, options.enableLan ?? true));
    this.#logger = options.logger ?? { debug: () => undefined, warn: () => undefined };
    this.#onChanged = options.onChanged ?? (() => undefined);
    this.#debounce = options.debounceMilliseconds ?? 8_000;
    this.#fallback = options.fallbackMilliseconds ?? 30 * 60_000;
    for (const timeout of [this.#debounce, this.#fallback]) if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30 * 60_000) throw new TypeError("Dictionary peer timing is invalid.");
  }

  async initialize(): Promise<void> {
    if (this.#closed) throw unavailable();
    if (this.#initialized) return;
    try {
      let identity = this.#store.identity();
      if (identity === undefined) {
        const generated = generateNodeSyncIdentity();
        identity = this.#store.initializeIdentity({ nodeId: this.#nodeId, publicKey: generated.publicKey,
          sealedKey: this.#vault.seal(generated.privateKey, this.#association()) });
      }
      const privateKey = this.#vault.open(identity.sealedKey, this.#association());
      if (identity.nodeId !== this.#nodeId || !isValidNodeSyncPrivateKey(privateKey) || nodeSyncPublicKeyFromPrivate(privateKey) !== identity.publicKey) throw unavailable();
      this.#privateKey = privateKey;
      this.#initialized = true;
      this.#unsubscribe.push(this.#dictionary.subscribe(() => this.#dictionaryChanged()), this.#store.subscribe(() => this.#grantsChanged()));
      this.#enabled = this.#dictionary.snapshot().enabled;
      if (this.#enabled) await this.#ensureTransport();
      this.#errorCode = undefined;
      this.#emit();
    } catch {
      this.#errorCode = this.#privateKey === undefined ? "identity_unavailable" : "sync_failed";
      this.#report();
      throw unavailable();
    }
  }

  status(): VoiceDictionaryPeerStatus {
    if (this.#closed) throw unavailable();
    const identity = this.#store.identity();
    const grants = this.#store.peers();
    let enabled = false;
    let dictionaryAvailable = true;
    try { enabled = this.#dictionary.snapshot().enabled; } catch { dictionaryAvailable = false; }
    const errorCode = dictionaryAvailable ? this.#errorCode : "dictionary_unavailable";
    const online = new Set(this.#transport?.onlinePeerIds() ?? []);
    const peers = grants.map((peer) => ({ peerId: peer.peerId, revision: peer.revision, displayName: peer.displayName,
      fingerprint: peer.fingerprint, online: online.has(peer.peerId), grantedAt: peer.grantedAt,
      ...(peer.route === undefined ? {} : { route: peer.route }),
      ...(peer.lastSyncAt === undefined ? {} : { lastSyncAt: peer.lastSyncAt }) }));
    return { available: !this.#closed && this.#initialized && this.#privateKey !== undefined && dictionaryAvailable,
      configurationRevision: this.#store.configurationRevision(), nodeId: this.#nodeId,
      fingerprint: identity === undefined ? "" : fingerprint(identity.publicKey), enabled,
      ...(this.#store.listener() === undefined ? {} : { listener: this.#store.listener() }),
      phase: !enabled ? "off" : errorCode !== undefined ? "error" : this.#sending.size > 0 ? "syncing"
        : peers.some((peer) => peer.online && peer.lastSyncAt !== undefined) ? "up_to_date" : "waiting",
      ...(errorCode === undefined ? {} : { errorCode }), peers,
      candidates: (this.#transport?.candidates() ?? []).map((candidate) => {
        const peer = grants.find((value) => value.peerId === candidate.nodeId);
        return { nodeId: candidate.nodeId, displayName: candidate.displayName, fingerprint: candidate.fingerprint,
          seenAt: candidate.seenAt, granted: peer?.publicKey === candidate.publicKey,
          keyChanged: peer !== undefined && peer.publicKey !== candidate.publicKey };
      }) };
  }

  grantCandidate(expectedRevision: bigint, peerId: string, expectedFingerprint: string): VoiceDictionaryPeerStatus {
    this.#assertReady();
    const candidate = this.#transport?.candidates().find((value) => value.nodeId === peerId);
    if (candidate === undefined || candidate.fingerprint !== expectedFingerprint) throw new VoiceDictionaryPeerManagerError("CONFLICT", "The dictionary peer candidate identity is no longer current.");
    this.#store.grantPeer({ expectedRevision, peerId, displayName: candidate.displayName, publicKey: candidate.publicKey, fingerprint: expectedFingerprint });
    return this.status();
  }

  configureListener(expectedRevision: bigint, listener: VoiceDictionaryPeerListener | undefined): VoiceDictionaryPeerStatus {
    this.#assertReady();
    this.#store.configureListener(expectedRevision, listener);
    return this.status();
  }

  async invitation(): Promise<string> {
    this.#assertReady();
    if (!this.#enabled) throw new VoiceDictionaryPeerManagerError("DISABLED", "Dictionary sharing is disabled.");
    const generation = this.#generation;
    await this.#ensureTransport();
    this.#assertSyncCurrent(generation);
    const listener = this.#store.listener();
    const identity = this.#store.identity()!;
    if (listener === undefined || this.#transport?.listenerPort?.() !== listener.listenPort) throw unavailable();
    return JSON.stringify({ version: 1, nodeId: this.#nodeId, displayName: this.#displayName,
      publicKey: identity.publicKey, fingerprint: fingerprint(identity.publicKey), host: listener.host, port: listener.port });
  }

  grantDirectPeer(expectedRevision: bigint, raw: string, expectedFingerprint: string): VoiceDictionaryPeerStatus {
    this.#assertReady();
    let invitation: ReturnType<typeof readVoiceDictionaryPeerInvitation>;
    try { invitation = readVoiceDictionaryPeerInvitation(raw); }
    catch { throw new VoiceDictionaryPeerManagerError("INVALID", "The dictionary peer invitation is invalid."); }
    if (!isValidNodeSyncPublicKey(invitation.publicKey) || fingerprint(invitation.publicKey) !== invitation.fingerprint ||
      expectedFingerprint !== invitation.fingerprint) throw new VoiceDictionaryPeerManagerError("INVALID", "The dictionary peer invitation is invalid.");
    this.#store.grantDirectPeer({ expectedRevision, peerId: invitation.nodeId, displayName: invitation.displayName,
      publicKey: invitation.publicKey, fingerprint: expectedFingerprint, route: { host: invitation.host, port: invitation.port } });
    return this.status();
  }

  clearPeerRoute(expectedRevision: bigint, peerId: string): VoiceDictionaryPeerStatus {
    this.#assertReady();
    this.#store.clearPeerRoute(expectedRevision, peerId);
    return this.status();
  }

  subscribe(listener: () => void): () => void {
    if (this.#closed) throw unavailable();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  revokePeer(peerId: string, expectedRevision: bigint): VoiceDictionaryPeerStatus {
    this.#assertReady();
    this.#store.revokePeer(peerId, expectedRevision);
    return this.status();
  }

  async setEnabled(expectedDictionaryRevision: number, enabled: boolean): Promise<void> {
    this.#assertReady();
    this.#dictionary.setEnabled(expectedDictionaryRevision, enabled);
    if (enabled) { await this.#ensureTransport(); await this.syncNow(); }
  }

  async syncNow(peerId?: string, delivery?: NodeSyncDeliveryContext): Promise<void> {
    this.#assertReady();
    if (!this.#dictionary.snapshot().enabled) throw new VoiceDictionaryPeerManagerError("DISABLED", "Dictionary sharing is disabled.");
    const generation = this.#generation;
    assertDelivery(delivery);
    await this.#ensureTransport();
    this.#assertSyncCurrent(generation);
    assertDelivery(delivery);
    const eligible = this.#transport?.eligiblePeerIds?.() ?? this.#transport?.onlinePeerIds() ?? [];
    const peers = peerId === undefined ? this.#store.peers().filter((peer) => eligible.includes(peer.peerId)) : [this.#store.peer(peerId)];
    if (peerId !== undefined && (peers[0] === undefined || !eligible.includes(peerId))) throw offline();
    let failure: unknown;
    let failed = false;
    for (const peer of peers) if (peer !== undefined) {
      this.#assertSyncCurrent(generation);
      assertDelivery(delivery);
      try {
        if (this.#transport?.probe !== undefined && !await this.#transport.probe(peer.peerId, delivery)) throw offline();
        this.#assertSyncCurrent(generation);
        assertDelivery(delivery);
        await this.#send(peer, true, true, delivery);
      }
      catch (error) {
        this.#assertSyncCurrent(generation);
        assertDelivery(delivery);
        if (peerId !== undefined) throw error;
        if (!failed) failure = error;
        failed = true;
      }
      this.#assertSyncCurrent(generation);
      assertDelivery(delivery);
    }
    if (failed) { this.#failed(); throw failure; }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#retire();
    this.#codec.close?.();
    this.#privateKey = undefined;
    this.#emit();
    this.#listeners.clear();
  }

  #dictionaryChanged(): void {
    if (this.#closed) return;
    try {
      const enabled = this.#dictionary.snapshot().enabled;
      if (enabled !== this.#enabled) {
        this.#enabled = enabled;
        this.#retire();
        if (enabled) this.#startAfterChange();
      } else if (enabled) this.#scheduleChanges();
    } catch { this.#retire(); this.#errorCode = "dictionary_unavailable"; }
    this.#emit();
  }

  #grantsChanged(): void {
    if (this.#closed) return;
    this.#retire();
    this.#errorCode = undefined;
    if (this.#enabled) this.#startAfterChange();
    this.#emit();
  }

  #ensureTransport(): Promise<void> {
    if (this.#starting !== undefined) return this.#starting;
    if (this.#transport !== undefined) return Promise.resolve();
    this.#assertReady();
    if (!this.#enabled) return Promise.reject(unavailable());
    const generation = this.#generation;
    const transport = this.#transportFactory({ purpose: "voice-dictionary", getSelf: () => {
      const identity = this.#store.identity();
      return !this.#closed && this.#enabled && this.#privateKey !== undefined && identity !== undefined
        ? { nodeId: this.#nodeId, displayName: this.#displayName, publicKey: identity.publicKey, privateKey: this.#privateKey } : undefined;
    }, isPeerAllowed: (peerId, key) => this.#enabled && !this.#closed && this.#store.peer(peerId)?.publicKey === key,
    onCandidate: () => this.#presenceChanged(), onPresenceChanged: () => this.#presenceChanged(),
    onFrame: (source, frame, delivery) => this.#receive(source, frame, delivery), logger: this.#logger });
    this.#transport = transport;
    const starting = transport.start().then(() => {
      if (generation !== this.#generation || this.#closed || !this.#enabled || this.#transport !== transport) throw unavailable();
      this.#errorCode = undefined;
      this.#fallbackTimer = setInterval(() => { void this.syncNow().catch(() => undefined); }, this.#fallback);
      this.#fallbackTimer.unref?.();
      this.#presenceChanged();
    }).catch((error: unknown) => {
      if (this.#transport === transport) { this.#transport = undefined; transport.stop(); }
      throw unavailable();
    }).finally(() => { if (this.#starting === starting) this.#starting = undefined; });
    this.#starting = starting;
    return starting;
  }

  #startAfterChange(): void {
    const generation = this.#generation;
    void this.#ensureTransport().catch(() => {
      if (generation === this.#generation && this.#enabled && !this.#closed) this.#failed();
    });
  }

  #presenceChanged(): void {
    const transport = this.#transport;
    if (transport === undefined || !this.#enabled || this.#closed) return;
    const online = new Set(transport.onlinePeerIds());
    const candidates = transport.candidates().filter((value) => online.has(value.nodeId));
    for (const peerId of this.#online.keys()) if (!online.has(peerId)) this.#online.delete(peerId);
    for (const candidate of candidates) {
      const occurrence = `${candidate.publicKey}\u0000${candidate.address}\u0000${candidate.port}`;
      if (this.#online.get(candidate.nodeId) === occurrence) continue;
      this.#online.set(candidate.nodeId, occurrence);
      const peer = this.#store.peer(candidate.nodeId);
      if (peer !== undefined) void this.#send(peer, true, true).catch(() => undefined);
    }
    this.#emit();
  }

  #scheduleChanges(): void {
    if (this.#changeTimer !== undefined) clearTimeout(this.#changeTimer);
    const generation = this.#generation;
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = undefined;
      if (generation !== this.#generation || !this.#enabled || this.#closed) return;
      const online = new Set(this.#transport?.onlinePeerIds() ?? []);
      for (const peer of this.#store.peers()) if (online.has(peer.peerId)) void this.#send(peer, false, false).catch(() => undefined);
    }, this.#debounce);
    this.#changeTimer.unref?.();
  }

  #send(peer: VoiceDictionaryPeerGrant, requestReply: boolean, force: boolean, delivery?: NodeSyncDeliveryContext): Promise<void> {
    const existing = this.#sending.get(peer.peerId);
    if (existing !== undefined) {
      const pending = this.#pendingExchange.get(peer.peerId);
      const pendingDelivery = pending === undefined ? delivery
        : pending.delivery === undefined || delivery === undefined ? undefined : delivery;
      this.#pendingExchange.set(peer.peerId, { requestReply: requestReply || pending?.requestReply === true,
        force: force || pending?.force === true,
        ...(pendingDelivery === undefined ? {} : { delivery: pendingDelivery }) });
      return existing;
    }
    const generation = this.#generation;
    const promise = (async () => {
      let exchange: PendingExchange | undefined = { requestReply, force, ...(delivery === undefined ? {} : { delivery }) };
      while (exchange !== undefined) {
        try { await this.#exchange(peer, generation, exchange); }
        catch (error) {
          this.#assertPeer(generation, peer);
          const pending = this.#pendingExchange.get(peer.peerId);
          if (deliveryCurrent(exchange.delivery) && (pending === undefined || !deliveryCurrent(pending.delivery))) throw error;
        }
        this.#assertPeer(generation, peer);
        exchange = this.#pendingExchange.get(peer.peerId);
        this.#pendingExchange.delete(peer.peerId);
      }
    })().catch((error: unknown) => {
      if (generation === this.#generation && !this.#closed) this.#failed();
      throw error;
    }).finally(() => {
      if (this.#sending.get(peer.peerId) === promise) {
        this.#sending.delete(peer.peerId);
        this.#pendingExchange.delete(peer.peerId);
      }
      if (generation === this.#generation && !this.#closed) this.#emit();
    });
    this.#sending.set(peer.peerId, promise);
    this.#emit();
    return promise;
  }

  async #exchange(peer: VoiceDictionaryPeerGrant, generation: number, exchange: PendingExchange): Promise<void> {
    this.#assertPeer(generation, peer);
    assertDelivery(exchange.delivery);
    const state = this.#dictionary.stateForSync();
    const marker = stateMarker(state);
    if (!exchange.force && this.#peerKnown.get(peer.peerId) === marker) return;
    const identity = this.#store.identity()!;
    const transport = this.#transport;
    if (transport === undefined) throw offline();
    const frames = await this.#codec.encode({ message: { frameVersion: 1, state, ...(exchange.requestReply ? { requestReply: true } : {}) },
      ownPrivateKey: this.#privateKey!, ownPublicKey: identity.publicKey, peerPublicKey: peer.publicKey,
      sourceNodeId: this.#nodeId, destinationNodeId: peer.peerId }, this.#abortController.signal);
    this.#assertPeer(generation, peer);
    assertDelivery(exchange.delivery);
    for (const frame of frames) {
      if (!await transport.send(peer.peerId, frame, exchange.delivery)) throw offline();
      this.#assertPeer(generation, peer);
      assertDelivery(exchange.delivery);
    }
    if (!this.#store.recordSuccess(peer.peerId, peer.revision, Date.now())) throw unavailable();
    this.#peerKnown.set(peer.peerId, marker);
    this.#errorCode = undefined;
    if (stateMarker(this.#dictionary.stateForSync()) !== marker) this.#scheduleChanges();
  }

  async #receive(source: string, frame: NodeSyncCipherChunkFrame, delivery: NodeSyncDeliveryContext): Promise<void> {
    const peer = this.#store.peer(source);
    const generation = this.#generation;
    if (peer === undefined || peer.publicKey !== frame.senderPublicKey || !delivery.isCurrent()) throw unavailable();
    this.#assertPeer(generation, peer);
    const message = await this.#decoder.accept({ sourceNodeId: source, destinationNodeId: this.#nodeId,
      ownPrivateKey: this.#privateKey!, expectedPeerPublicKey: peer.publicKey, frame,
      delivery: { signal: delivery.signal, isCurrent: () => delivery.isCurrent() && this.#isCurrent(generation, peer) } });
    this.#assertPeer(generation, peer);
    if (!delivery.isCurrent()) throw unavailable();
    if (message === null) return;
    this.#dictionary.mergeRemote(message.state);
    this.#assertPeer(generation, peer);
    if (!this.#store.recordSuccess(peer.peerId, peer.revision, Date.now())) throw unavailable();
    this.#peerKnown.set(peer.peerId, stateMarker(message.state));
    this.#errorCode = undefined;
    // Reply separately: the original transfer ACK must not wait for a second transfer.
    if (message.requestReply === true) void this.#send(peer, false, true).catch(() => undefined);
    this.#emit();
  }

  #isCurrent(generation: number, peer: VoiceDictionaryPeerGrant): boolean {
    if (generation !== this.#generation || this.#closed || !this.#enabled || this.#privateKey === undefined) return false;
    const current = this.#store.peer(peer.peerId);
    return this.#dictionary.snapshot().enabled && current?.revision === peer.revision && current.publicKey === peer.publicKey;
  }
  #assertPeer(generation: number, peer: VoiceDictionaryPeerGrant): void { if (!this.#isCurrent(generation, peer)) throw unavailable(); }
  #assertSyncCurrent(generation: number): void {
    this.#assertReady();
    if (generation !== this.#generation || !this.#enabled || !this.#dictionary.snapshot().enabled) throw unavailable();
  }
  #assertReady(): void { if (this.#closed || !this.#initialized || this.#privateKey === undefined) throw unavailable(); }
  #retire(): void {
    this.#generation += 1;
    this.#abortController.abort(new Error("Dictionary peer authority was retired."));
    this.#abortController = new AbortController();
    this.#decoder.reset(); this.#codec.reset?.();
    if (this.#changeTimer !== undefined) clearTimeout(this.#changeTimer);
    if (this.#fallbackTimer !== undefined) clearInterval(this.#fallbackTimer);
    this.#changeTimer = undefined; this.#fallbackTimer = undefined;
    const transport = this.#transport;
    this.#transport = undefined; this.#starting = undefined;
    transport?.stop();
    this.#peerKnown.clear(); this.#online.clear(); this.#sending.clear(); this.#pendingExchange.clear();
  }
  #failed(): void { this.#errorCode = "sync_failed"; this.#report(); }
  #report(): void { this.#logger.warn("Dictionary peer operation failed.", { code: this.#errorCode }); this.#emit(); }
  #emit(): void {
    try { this.#onChanged(); } catch {}
    for (const listener of this.#listeners) { try { listener(); } catch {} }
  }
  #association(): string { return `joko:voice-dictionary-device-sync:x25519-private-key:v1:${this.#nodeId}`; }
}

function fingerprint(key: string): string { return createHash("sha256").update(Buffer.from(key, "base64")).digest("hex"); }
function stateMarker(state: VoiceDictionarySyncState): string { return JSON.stringify(Object.entries(buildStateVersionVector(state)).sort(([a], [b]) => a.localeCompare(b, "en-US"))); }
function unavailable(): VoiceDictionaryPeerManagerError { return new VoiceDictionaryPeerManagerError("UNAVAILABLE", "Dictionary peer authority is unavailable."); }
function offline(): VoiceDictionaryPeerManagerError { return new VoiceDictionaryPeerManagerError("OFFLINE", "The authorized dictionary peer is not reachable."); }
function deliveryCurrent(delivery: NodeSyncDeliveryContext | undefined): boolean {
  return delivery === undefined || (!delivery.signal.aborted && delivery.isCurrent());
}
function assertDelivery(delivery: NodeSyncDeliveryContext | undefined): void { if (!deliveryCurrent(delivery)) throw unavailable(); }
