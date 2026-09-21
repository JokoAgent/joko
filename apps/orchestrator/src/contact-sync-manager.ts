import {
  ContactStore,
  contactSyncPublicKeyFingerprint,
  createContactSyncDelta,
  type ContactSyncClock,
  type ContactSyncConfigurationRecord,
  type ContactSyncPeerRecord
} from "@joko/store";

import { type CredentialVault, type EncryptedCredential } from "./credential-vault.js";
import { ContactSyncWorkerCodec } from "./contact-sync-codec.js";
import {
  contactSyncPublicKeyFromPrivate,
  generateContactSyncIdentity,
  isValidContactSyncPrivateKey,
  isValidContactSyncPublicKey
} from "./contact-sync-crypto.js";
import {
  ContactSyncLanTransport,
  type ContactSyncLanCandidate,
  type ContactSyncLanLogger,
  type ContactSyncLanTransportOptions
} from "./contact-sync-lan.js";
import {
  ContactSyncWireDecoder,
  type ContactSyncCipherChunkFrame,
  type ContactSyncCodec
} from "./contact-sync-wire.js";

const PRIVATE_KEY_ASSOCIATION_PREFIX = "joko:contacts-device-sync:x25519-private-key:v1:";
const AUTOMATIC_SYNC_INTERVAL_MILLISECONDS = 30_000;

export type ContactSyncPhase = "off" | "waiting" | "syncing" | "up_to_date" | "error";
export type ContactSyncErrorCode = "identity_unavailable" | "peer_identity_changed" | "sync_failed";

export interface ContactSyncPeerView {
  readonly peerId: string;
  readonly revision: bigint;
  readonly displayName: string;
  readonly fingerprint: string;
  readonly online: boolean;
  readonly state: "pending" | "active";
  readonly grantedAt: number;
  readonly lastSyncAt?: number;
  readonly lastRoute?: "lan";
}

export interface ContactSyncCandidateView {
  readonly nodeId: string;
  readonly displayName: string;
  readonly fingerprint: string;
  readonly seenAt: number;
  readonly granted: boolean;
  readonly keyChanged: boolean;
}

export interface ContactSyncStatus {
  readonly available: boolean;
  readonly configurationRevision: bigint;
  readonly nodeId: string;
  readonly fingerprint: string;
  readonly enabled: boolean;
  readonly phase: ContactSyncPhase;
  readonly onlinePeerCount: number;
  readonly errorCode?: ContactSyncErrorCode;
  readonly lastSyncAt?: number;
  readonly lastSyncPeerId?: string;
  readonly lastSyncPeerName?: string;
  readonly lastRoute?: "lan";
  readonly peers: readonly ContactSyncPeerView[];
  readonly candidates: readonly ContactSyncCandidateView[];
}

export type ContactSyncManagerErrorCode = "UNAVAILABLE" | "DISABLED" | "NOT_FOUND" | "OFFLINE" | "CONFLICT";

export class ContactSyncManagerError extends Error {
  constructor(readonly code: ContactSyncManagerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContactSyncManagerError";
  }
}

interface ContactSyncTransportPort {
  start(): Promise<void>;
  stop(): void;
  send(nodeId: string, frame: ContactSyncCipherChunkFrame): Promise<boolean>;
  candidates(now?: number): readonly ContactSyncLanCandidate[];
  onlinePeerIds(now?: number): readonly string[];
}

interface ManagedContactSyncCodec extends ContactSyncCodec {
  reset?(): void;
  close?(): void;
}

export interface ContactSyncManagerOptions {
  readonly store: ContactStore;
  readonly vault: CredentialVault;
  readonly nodeId: string;
  readonly displayName: string;
  readonly codec?: ManagedContactSyncCodec;
  readonly logger?: ContactSyncLanLogger;
  readonly transportFactory?: (options: ContactSyncLanTransportOptions) => ContactSyncTransportPort;
  readonly onChanged?: () => void;
  readonly now?: () => number;
}

export class ContactSyncManager {
  readonly #store: ContactStore;
  readonly #vault: CredentialVault;
  readonly #nodeId: string;
  readonly #displayName: string;
  readonly #codec: ManagedContactSyncCodec;
  readonly #wireDecoder: ContactSyncWireDecoder;
  readonly #logger: ContactSyncLanLogger;
  readonly #transportFactory: (options: ContactSyncLanTransportOptions) => ContactSyncTransportPort;
  readonly #onChanged: () => void;
  readonly #now: () => number;
  readonly #peerKnownClocks = new Map<string, readonly ContactSyncClock[]>();
  #configuration?: ContactSyncConfigurationRecord;
  #privateKey?: string;
  #transport?: ContactSyncTransportPort;
  #abortController = new AbortController();
  #generation = 0;
  #activeSyncs = 0;
  #automaticSyncTimer?: NodeJS.Timeout;
  #automaticSyncRunning = false;
  #errorCode?: ContactSyncErrorCode;
  #initialized = false;
  #closed = false;

  constructor(options: ContactSyncManagerOptions) {
    this.#store = options.store;
    this.#vault = options.vault;
    this.#nodeId = nodeId(options.nodeId);
    this.#displayName = displayName(options.displayName);
    this.#codec = options.codec ?? new ContactSyncWorkerCodec();
    this.#wireDecoder = new ContactSyncWireDecoder(this.#codec);
    this.#logger = options.logger ?? { debug: () => undefined, warn: () => undefined };
    this.#transportFactory = options.transportFactory ?? ((transportOptions) => new ContactSyncLanTransport(transportOptions));
    this.#onChanged = options.onChanged ?? (() => undefined);
    this.#now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    if (this.#closed) throw new ContactSyncManagerError("UNAVAILABLE", "Contacts sync is closed.");
    if (this.#initialized) return;
    try {
      let configuration = this.#store.contactSyncConfiguration();
      let privateKey: string;
      if (configuration === undefined) {
        const identity = generateContactSyncIdentity();
        const sealed = this.#vault.seal(identity.privateKey, this.#privateKeyAssociation());
        configuration = this.#store.initializeContactSyncConfiguration({
          nodeId: this.#nodeId,
          publicKey: identity.publicKey,
          sealedPrivateKey: JSON.stringify(sealed)
        });
        privateKey = identity.privateKey;
      } else {
        this.#configuration = configuration;
        if (configuration.nodeId !== this.#nodeId) {
          throw new Error("Contacts sync identity belongs to another node.");
        }
        privateKey = this.#vault.open(parseSealedCredential(configuration.sealedPrivateKey), this.#privateKeyAssociation());
      }
      this.#configuration = configuration;
      if (!isValidContactSyncPrivateKey(privateKey) || !isValidContactSyncPublicKey(configuration.publicKey) ||
        contactSyncPublicKeyFromPrivate(privateKey) !== configuration.publicKey) {
        throw new Error("Contacts sync identity is invalid.");
      }
      this.#privateKey = privateKey;
      this.#initialized = true;
      this.#errorCode = undefined;
      if (configuration.enabled) {
        this.#store.readContactSyncState(configuration.nodeId);
        await this.#startTransport();
        this.#scheduleAutomaticSync(500);
      }
      this.#emitChanged();
    } catch (error) {
      this.#initialized = this.#configuration !== undefined;
      this.#errorCode = "identity_unavailable";
      this.#logger.warn("Contacts sync identity is unavailable.", { code: "identity_unavailable" });
      this.#emitChanged();
      throw new ContactSyncManagerError("UNAVAILABLE", "Contacts sync identity is unavailable.", { cause: error });
    }
  }

  status(): ContactSyncStatus {
    const configuration = this.#requireConfiguration();
    const peers = this.#store.listContactSyncPeers();
    const online = new Set(this.#transport?.onlinePeerIds(this.#now()) ?? []);
    const peerViews = peers.map((peer) => this.#peerView(peer, online.has(peer.peerId)));
    const latest = [...peers].filter((peer) => peer.lastSyncAt !== undefined)
      .sort((left, right) => (right.lastSyncAt ?? 0) - (left.lastSyncAt ?? 0))[0];
    const candidates = (this.#transport?.candidates(this.#now()) ?? []).map((candidate) => {
      const peer = peers.find((value) => value.peerId === candidate.nodeId);
      return {
        nodeId: candidate.nodeId,
        displayName: candidate.displayName,
        fingerprint: candidate.fingerprint,
        seenAt: candidate.seenAt,
        granted: peer?.fingerprint === candidate.fingerprint,
        keyChanged: peer !== undefined && peer.fingerprint !== candidate.fingerprint
      };
    });
    return {
      available: this.#initialized && this.#privateKey !== undefined,
      configurationRevision: configuration.revision,
      nodeId: configuration.nodeId,
      fingerprint: contactSyncPublicKeyFingerprint(configuration.publicKey),
      enabled: configuration.enabled,
      phase: this.#phase(configuration, online.size, latest !== undefined),
      onlinePeerCount: peerViews.filter((peer) => peer.online).length,
      ...(this.#errorCode === undefined ? {} : { errorCode: this.#errorCode }),
      ...(latest?.lastSyncAt === undefined ? {} : {
        lastSyncAt: latest.lastSyncAt,
        lastSyncPeerId: latest.peerId,
        lastSyncPeerName: latest.displayName,
        ...(latest.lastRoute === undefined ? {} : { lastRoute: latest.lastRoute })
      }),
      peers: peerViews,
      candidates
    };
  }

  async setEnabled(expectedRevision: bigint, enabled: boolean): Promise<ContactSyncStatus> {
    this.#assertReady();
    this.#configuration = this.#store.setContactSyncEnabled(expectedRevision, enabled);
    if (!enabled) {
      this.#revokeRuntimeAuthority();
      this.#transport?.stop();
      this.#transport = undefined;
      this.#errorCode = undefined;
    } else {
      try {
        this.#store.readContactSyncState(this.#configuration.nodeId);
        await this.#startTransport();
        this.#scheduleAutomaticSync(250);
        this.#errorCode = undefined;
      } catch (error) {
        this.#setError(error);
      }
    }
    this.#emitChanged();
    return this.status();
  }

  async grantCandidate(candidateNodeIdValue: string, expectedFingerprintValue: string): Promise<ContactSyncStatus> {
    this.#assertReady();
    const candidateNodeId = nodeId(candidateNodeIdValue);
    const expectedFingerprint = fingerprint(expectedFingerprintValue);
    const candidate = this.#transport?.candidates(this.#now()).find((value) => value.nodeId === candidateNodeId);
    if (candidate === undefined) throw new ContactSyncManagerError("NOT_FOUND", "The Contacts sync candidate is no longer available.");
    if (candidate.fingerprint !== expectedFingerprint) {
      throw new ContactSyncManagerError("CONFLICT", "The Contacts sync candidate identity changed before it was granted.");
    }
    this.#store.grantContactSyncPeer({
      peerId: candidate.nodeId,
      displayName: candidate.displayName,
      publicKey: candidate.publicKey,
      fingerprint: candidate.fingerprint
    });
    this.#errorCode = undefined;
    this.#scheduleAutomaticSync(100);
    this.#emitChanged();
    return this.status();
  }

  revokePeer(peerIdValue: string, expectedRevision: bigint): ContactSyncStatus {
    this.#assertReady();
    const peerId = nodeId(peerIdValue);
    this.#store.revokeContactSyncPeer(peerId, expectedRevision);
    this.#peerKnownClocks.delete(peerId);
    this.#revokeRuntimeAuthority();
    if (this.#configuration?.enabled === true) this.#scheduleAutomaticSync(500);
    this.#errorCode = undefined;
    this.#emitChanged();
    return this.status();
  }

  async syncNow(peerIdValue?: string): Promise<ContactSyncStatus> {
    this.#assertReady();
    const configuration = this.#requireConfiguration();
    if (!configuration.enabled) throw new ContactSyncManagerError("DISABLED", "Contacts sync is disabled.");
    if (this.#transport === undefined) {
      try {
        await this.#startTransport();
        this.#errorCode = undefined;
        this.#scheduleAutomaticSync(250);
      } catch (error) {
        this.#setError(error);
        this.#emitChanged();
        throw new ContactSyncManagerError("UNAVAILABLE", "Contacts sync transport is unavailable.", { cause: error });
      }
    }
    const online = new Set(this.#transport?.onlinePeerIds(this.#now()) ?? []);
    const peerIds = peerIdValue === undefined
      ? this.#store.listContactSyncPeers().map((peer) => peer.peerId).filter((peerId) => online.has(peerId))
      : [nodeId(peerIdValue)];
    if (peerIds.length === 0 && peerIdValue === undefined) {
      this.#errorCode = undefined;
      this.#emitChanged();
      return this.status();
    }
    if (peerIds.some((peerId) => !online.has(peerId))) {
      throw new ContactSyncManagerError("OFFLINE", "No granted Contacts sync peer is currently reachable.");
    }
    const generation = this.#generation;
    this.#activeSyncs += 1;
    this.#emitChanged();
    try {
      for (const peerId of peerIds) await this.#sendState(peerId, true, generation);
      this.#errorCode = undefined;
    } catch (error) {
      this.#setError(error);
      throw error instanceof ContactSyncManagerError ? error
        : new ContactSyncManagerError("UNAVAILABLE", "Contacts sync failed.", { cause: error });
    } finally {
      this.#activeSyncs = Math.max(0, this.#activeSyncs - 1);
      this.#emitChanged();
    }
    return this.status();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#revokeRuntimeAuthority();
    this.#transport?.stop();
    this.#transport = undefined;
    this.#codec.close?.();
    this.#privateKey = undefined;
  }

  async #startTransport(): Promise<void> {
    if (this.#transport !== undefined) return;
    const transport = this.#transportFactory({
      getSelf: () => {
        const configuration = this.#configuration;
        const privateKey = this.#privateKey;
        return configuration?.enabled === true && privateKey !== undefined ? {
          nodeId: configuration.nodeId,
          displayName: this.#displayName,
          publicKey: configuration.publicKey,
          privateKey
        } : undefined;
      },
      isPeerAllowed: (peerId, publicKey) => {
        const configuration = this.#configuration;
        const peer = this.#store.contactSyncPeer(peerId);
        return configuration?.enabled === true && peer?.publicKey === publicKey;
      },
      onCandidate: () => {
        this.#emitChanged();
        this.#scheduleAutomaticSync(250);
      },
      onPresenceChanged: () => {
        this.#emitChanged();
        this.#scheduleAutomaticSync(250);
      },
      onFrame: (sourceNodeId, frame) => this.#receiveFrame(sourceNodeId, frame),
      logger: this.#logger
    });
    this.#transport = transport;
    try {
      await transport.start();
    } catch (error) {
      if (this.#transport === transport) this.#transport = undefined;
      transport.stop();
      throw error;
    }
  }

  async #sendState(peerId: string, requestReply: boolean, generation: number): Promise<void> {
    this.#assertGeneration(generation);
    const peer = this.#store.contactSyncPeer(peerId);
    if (peer === undefined) throw new ContactSyncManagerError("NOT_FOUND", "The Contacts sync peer is no longer granted.");
    const configuration = this.#requireConfiguration();
    const privateKey = this.#privateKey;
    const transport = this.#transport;
    if (!configuration.enabled || privateKey === undefined || transport === undefined) {
      throw new ContactSyncManagerError("DISABLED", "Contacts sync is not active.");
    }
    const local = this.#store.readContactSyncState(configuration.nodeId);
    if (local.materialized) this.#emitChanged();
    const state = createContactSyncDelta(local.state, this.#peerKnownClocks.get(peerId) ?? []);
    const frames = await this.#codec.encode({
      message: { version: 1, type: "state", state, ...(requestReply ? { requestReply: true } : {}) },
      ownPrivateKey: privateKey,
      ownPublicKey: configuration.publicKey,
      peerPublicKey: peer.publicKey,
      sourceNodeId: configuration.nodeId,
      destinationNodeId: peer.peerId
    }, this.#abortController.signal);
    this.#assertGeneration(generation);
    for (const frame of frames) {
      if (!await transport.send(peer.peerId, frame)) {
        throw new ContactSyncManagerError("OFFLINE", "The Contacts sync peer could not be reached over the authenticated LAN route.");
      }
      this.#assertGeneration(generation);
    }
    this.#peerKnownClocks.set(peer.peerId, local.state.clocks.map((clock) => ({ ...clock })));
    this.#store.recordContactSyncSuccess(peer.peerId, "lan", this.#now());
    this.#emitChanged();
  }

  async #receiveFrame(sourceNodeId: string, frame: ContactSyncCipherChunkFrame): Promise<void> {
    const generation = this.#generation;
    const configuration = this.#requireConfiguration();
    const privateKey = this.#privateKey;
    const peer = this.#store.contactSyncPeer(sourceNodeId);
    if (!configuration.enabled || privateKey === undefined || peer === undefined || peer.publicKey !== frame.senderPublicKey) {
      throw new ContactSyncManagerError("NOT_FOUND", "The Contacts sync sender is not granted.");
    }
    this.#activeSyncs += 1;
    this.#emitChanged();
    try {
      const message = await this.#wireDecoder.accept({
        sourceNodeId,
        destinationNodeId: configuration.nodeId,
        frame,
        ownPrivateKey: privateKey,
        expectedPeerPublicKey: peer.publicKey,
        now: this.#now()
      });
      this.#assertGeneration(generation);
      if (message === null) return;
      const merged = this.#store.mergeContactSyncState(configuration.nodeId, message.state);
      this.#peerKnownClocks.set(peer.peerId, message.state.clocks.map((clock) => ({ ...clock })));
      this.#store.recordContactSyncSuccess(peer.peerId, "lan", this.#now());
      this.#errorCode = undefined;
      if (merged.materialized) this.#emitChanged();
      if (message.requestReply === true) await this.#sendState(peer.peerId, false, generation);
    } catch (error) {
      this.#setError(error);
      throw error;
    } finally {
      this.#activeSyncs = Math.max(0, this.#activeSyncs - 1);
      this.#emitChanged();
    }
  }

  #peerView(peer: ContactSyncPeerRecord, online: boolean): ContactSyncPeerView {
    return {
      peerId: peer.peerId,
      revision: peer.revision,
      displayName: peer.displayName,
      fingerprint: peer.fingerprint,
      online,
      state: peer.lastSyncAt === undefined ? "pending" : "active",
      grantedAt: peer.grantedAt,
      ...(peer.lastSyncAt === undefined ? {} : { lastSyncAt: peer.lastSyncAt }),
      ...(peer.lastRoute === undefined ? {} : { lastRoute: peer.lastRoute })
    };
  }

  #phase(configuration: ContactSyncConfigurationRecord, onlineCount: number, hasSynced: boolean): ContactSyncPhase {
    if (!configuration.enabled) return "off";
    if (this.#activeSyncs > 0) return "syncing";
    if (this.#errorCode !== undefined) return "error";
    if (onlineCount === 0 || !hasSynced) return "waiting";
    return "up_to_date";
  }

  #assertReady(): void {
    if (this.#closed || !this.#initialized || this.#privateKey === undefined) {
      throw new ContactSyncManagerError("UNAVAILABLE", "Contacts sync is unavailable.");
    }
  }

  #requireConfiguration(): ContactSyncConfigurationRecord {
    if (this.#configuration === undefined) throw new ContactSyncManagerError("UNAVAILABLE", "Contacts sync is not initialized.");
    return this.#configuration;
  }

  #assertGeneration(expected: number): void {
    const configuration = this.#configuration;
    if (expected !== this.#generation || this.#abortController.signal.aborted || configuration?.enabled !== true ||
      this.#store.contactSyncConfiguration()?.revision !== configuration.revision) {
      throw new ContactSyncManagerError("CONFLICT", "Contacts sync authority changed while the operation was running.");
    }
  }

  #revokeRuntimeAuthority(): void {
    this.#generation += 1;
    this.#abortController.abort(new ContactSyncManagerError("CONFLICT", "Contacts sync authority was revoked."));
    this.#abortController = new AbortController();
    this.#wireDecoder.reset();
    this.#codec.reset?.();
    this.#activeSyncs = 0;
    if (this.#automaticSyncTimer !== undefined) clearTimeout(this.#automaticSyncTimer);
    this.#automaticSyncTimer = undefined;
    this.#automaticSyncRunning = false;
  }

  #scheduleAutomaticSync(delayMilliseconds: number): void {
    if (this.#closed || this.#configuration?.enabled !== true || this.#transport === undefined || this.#automaticSyncRunning) return;
    if (this.#automaticSyncTimer !== undefined) clearTimeout(this.#automaticSyncTimer);
    this.#automaticSyncTimer = setTimeout(() => {
      this.#automaticSyncTimer = undefined;
      if (this.#closed || this.#configuration?.enabled !== true || this.#automaticSyncRunning) return;
      const generation = this.#generation;
      this.#automaticSyncRunning = true;
      void this.syncNow().catch(() => undefined).finally(() => {
        if (generation !== this.#generation) return;
        this.#automaticSyncRunning = false;
        this.#scheduleAutomaticSync(AUTOMATIC_SYNC_INTERVAL_MILLISECONDS);
      });
    }, delayMilliseconds);
    this.#automaticSyncTimer.unref?.();
  }

  #setError(error: unknown): void {
    const message = error instanceof Error ? error.message : "";
    this.#errorCode = /identity|key changed|key mismatch/iu.test(message) ? "peer_identity_changed" : "sync_failed";
    this.#logger.warn("Contacts sync operation failed.", { code: this.#errorCode });
  }

  #privateKeyAssociation(): string {
    return `${PRIVATE_KEY_ASSOCIATION_PREFIX}${this.#nodeId}`;
  }

  #emitChanged(): void {
    try { this.#onChanged(); } catch {}
  }
}

function parseSealedCredential(value: string): EncryptedCredential {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Sealed Contacts sync private key is invalid."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Sealed Contacts sync private key is invalid.");
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 4 || record["algorithm"] !== "aes-256-gcm" ||
    !isExactBase64(record["nonce"], 12) || !isBoundedBase64(record["ciphertext"], 1, 512) || !isExactBase64(record["tag"], 16)) {
    throw new Error("Sealed Contacts sync private key is invalid.");
  }
  return parsed as EncryptedCredential;
}

function isExactBase64(value: unknown, bytes: number): value is string {
  return isBoundedBase64(value, bytes, bytes);
}

function isBoundedBase64(value: unknown, minimumBytes: number, maximumBytes: number): value is string {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength >= minimumBytes && decoded.byteLength <= maximumBytes && decoded.toString("base64") === value;
}

function nodeId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new ContactSyncManagerError("CONFLICT", "Contacts sync node identity is invalid.");
  }
  return value;
}

function displayName(value: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ContactSyncManagerError("CONFLICT", "Contacts sync display name is invalid.");
  }
  return value;
}

function fingerprint(value: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ContactSyncManagerError("CONFLICT", "Contacts sync fingerprint is invalid.");
  }
  return value;
}
