import { createHash, randomUUID } from "node:crypto";
import { create, fromBinary, isMessage, toBinary } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { decryptNodeSyncBytes, encryptNodeSyncBytes, generateNodeSyncIdentity, isValidNodeSyncPrivateKey,
  isValidNodeSyncPublicKey, nodeSyncPublicKeyFromPrivate } from "@joko/node-sync";
import type { OperationalStore } from "@joko/store";
import type { CredentialVault, EncryptedCredential } from "./credential-vault.js";
import type { DevicePeerOwner } from "./device-peer-owner.js";
import type { ExtensionCatalogManager } from "./extension-catalog.js";
import type { PiResourceManager } from "./resource-manager.js";

export const EXTENSION_DEVICE_SYNC_MAX_BYTES = 64 * 1024;
const MAX_FRAME = 96 * 1024, DEADLINE = 30_000, SCOPE = "extension-device-sync.v1";
interface PluginIdentity { readonly namespace: string; readonly id: string; }
interface PluginCapture { readonly extensionId: string; readonly identity: PluginIdentity; readonly epoch: string; assertCurrent(): void; }
interface Packet { readonly version: 1; readonly kind: "request" | "response"; readonly id: string; readonly plugin: PluginIdentity; readonly data?: unknown; readonly errorCode?: string; }
interface Peer { readonly id: string; readonly name: string; readonly epoch: string; assertCurrent(): void; exchange(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array>; }
interface Incoming { readonly plugin: PluginCapture; readonly peer: string; readonly signal: AbortSignal; readonly current: () => void; resolve(value: unknown): void; }
interface Reception { readonly hash: string; readonly epoch: string; readonly expiresAt: number; readonly result: Promise<Packet>; }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const failure = (code: string): never => { throw Object.assign(new Error("Plugin device exchange is unavailable."), { code }); };
const code = (reason: unknown) => typeof (reason as { code?: unknown })?.code === "string" ? (reason as { code: string }).code : "SYNC_RESULT_UNKNOWN";
const encode = (value: unknown): Buffer => {
  let text: string | undefined; try { text = JSON.stringify(value); } catch { return failure("INVALID_PARAMS"); }
  if (text === undefined || Buffer.byteLength(text) > EXTENSION_DEVICE_SYNC_MAX_BYTES) return failure("SYNC_TOO_LARGE"); return Buffer.from(text);
};
const same = (a: PluginIdentity, b: PluginIdentity) => a.namespace === b.namespace && a.id === b.id;
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); signal.throwIfAborted(); } let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(Object.assign(new Error("Plugin exchange expired."), { code: "SYNC_RESULT_UNKNOWN" })); signal.addEventListener("abort", cancel, { once: true }); });
  try { return await Promise.race([work, cancelled]); } finally { signal.removeEventListener("abort", cancel); }
}

/** Opaque request/reply only. Plugins own merge rules and durable idempotency;
 * no model, arbitrary file access, Library write or general remote RPC is exposed. */
export class ExtensionDeviceSync {
  #lifetime = new AbortController();
  #active = false;
  readonly #epochs = new Map<string, number>();
  readonly #incoming = new Map<string, Incoming>();
  readonly #outgoing = new Map<string, { readonly extensionId: string; readonly abort: AbortController }>();
  readonly #received = new Map<string, Reception>();
  readonly #peerKeys = new Map<string, string>();
  readonly #incomingPeers = new Map<string, AbortController>();
  constructor(readonly options: {
    readonly store: OperationalStore; readonly vault: CredentialVault; readonly peers: DevicePeerOwner;
    readonly catalog: Pick<ExtensionCatalogManager, "get" | "snapshot">; readonly resources: Pick<PiResourceManager, "get">;
    readonly deliver: (extensionId: string, event: unknown, signal: AbortSignal, assertCurrent: () => void) => Promise<boolean>;
    readonly peerDirectory?: () => readonly Peer[];
  }) {}

  #capture(extensionId: string): PluginCapture {
    const read = () => {
      this.#lifetime.signal.throwIfAborted(); if (!this.#active) return failure("SYNC_OFFLINE"); const extension = this.options.catalog.get(extensionId);
      if (!extension.installed || !extension.enabled || extension.owner.kind !== "resource" || !extension.runtime?.deviceSync
        || !["ready", "not_required"].includes(extension.setup.state) || extension.permissions.some(permission => permission.required && !permission.granted)
        || !extension.permissions.some(permission => permission.id === "runtime-device-sync" && permission.granted)) return failure("SYNC_NOT_ALLOWED");
      const resource = this.options.resources.get(extension.owner.resourceId);
      if (resource.kind !== "package" || resource.scope !== "managed" || !resource.enabled || !resource.packageIdentity
        || !["installed", "loaded", "update_available"].includes(resource.state) || resource.versionNumber !== extension.owner.resourceVersion
        || resource.discoveredRevision !== extension.owner.discoveredRevision) return failure("SYNC_NOT_ALLOWED");
      const identity = { namespace: hash(resource.sourceKind === "local" ? "local" : resource.sourceIdentity),
        id: hash(JSON.stringify([resource.packageIdentity, extension.runtime.extensionEntry])) };
      const epoch = hash(JSON.stringify([extension.id, extension.revision.toString(), extension.owner, resource.versionNumber.toString(), resource.discoveredRevision,
        identity, this.#epochs.get(extensionId) ?? 0], (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
      return { identity, epoch };
    };
    const captured = read(); return { extensionId, ...captured, assertCurrent: () => { if (read().epoch !== captured.epoch) failure("SYNC_NOT_ALLOWED"); } };
  }
  #identity() {
    this.#lifetime.signal.throwIfAborted();
    const stored = this.options.store.findSetting<{ readonly format: 1; readonly publicKey: string; readonly sealedPrivateKey: EncryptedCredential }>("service", SCOPE, "identity");
    let record = stored?.value;
    if (stored === undefined) {
      const generated = generateNodeSyncIdentity();
      record = { format: 1, publicKey: generated.publicKey, sealedPrivateKey: this.options.vault.seal(generated.privateKey, SCOPE) };
      this.options.store.setSetting("service", SCOPE, "identity", record);
    }
    if (!record || record.format !== 1 || !isValidNodeSyncPublicKey(record.publicKey)) return failure("SYNC_SECURE_STORAGE_UNAVAILABLE");
    let privateKey: string;
    try { privateKey = this.options.vault.open(record.sealedPrivateKey, SCOPE); } catch { return failure("SYNC_SECURE_STORAGE_UNAVAILABLE"); }
    if (!isValidNodeSyncPrivateKey(privateKey) || nodeSyncPublicKeyFromPrivate(privateKey) !== record.publicKey) return failure("SYNC_SECURE_STORAGE_UNAVAILABLE");
    return { publicKey: record.publicKey, privateKey };
  }
  #peers(): readonly Peer[] {
    if (this.options.peerDirectory) return this.options.peerDirectory();
    const result = new Map<string, Peer>();
    for (const relation of this.options.store.listDeviceControlRelations()) {
      if (!relation.outboundEnabled || !relation.inboundAllowed || result.has(relation.targetDeviceId)) continue;
      try {
        const target = this.options.store.getDevice(relation.targetDeviceId); if (target.kind !== "desktop") continue;
        const authority = this.options.peers.captureBinding(relation.controllerDeviceId, target.id, ["extension_sync"]);
        const current = () => authority.assertCurrent(["extension_sync"]);
        result.set(target.id, { id: target.id, name: target.name,
          epoch: JSON.stringify([authority.controllerDeviceId, authority.identity], (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value),
          assertCurrent: current, exchange: async (bytes, signal) => {
            current(); signal.throwIfAborted();
            const response = await this.options.peers.dispatch(authority, { capability: "extension_sync", effectKind: "side_effect", action: "invokeHostedAgent", signal,
              payload: create(contract.DevicePeerCommandSchema, { capability: contract.DevicePeerCapabilityKind.EXTENSION_SYNC, effect: contract.DevicePeerEffectKind.SIDE_EFFECT,
                action: { case: "invokeHostedAgent", value: { method: contract.HostedAgentPeerMethod.EXTENSION_SYNC, requestBytes: bytes } } }) });
            current(); signal.throwIfAborted();
            if (response.outcome !== "completed") return failure("SYNC_RESULT_UNKNOWN");
            const payload = response.value as { readonly case?: string; readonly value?: unknown } | undefined;
            if (payload?.case !== "hostedAgent" || !isMessage(payload.value, contract.DevicePeerHostedAgentResultSchema)
              || payload.value.responseBytes.byteLength > MAX_FRAME) return failure("SYNC_RESULT_UNKNOWN");
            return payload.value.responseBytes;
          } });
      } catch { /* Only currently authorized, supported Desktop routes are candidates. */ }
    }
    return [...result.values()];
  }
  async request(extensionId: string, raw: unknown, signal: AbortSignal, assertCaller: () => void): Promise<unknown> {
    try {
      const plugin = this.#capture(extensionId); assertCaller(); signal.throwIfAborted();
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failure("INVALID_PARAMS");
      const request = raw as Record<string, unknown>;
      if (request.op === "status") return { ok: true, version: 1, online: !this.#lifetime.signal.aborted,
        peers: this.#peers().map(peer => ({ deviceId: peer.id, deviceName: peer.name })), maxBytes: EXTENSION_DEVICE_SYNC_MAX_BYTES };
      if (request.op === "reply") {
        if (typeof request.requestId !== "string") return failure("INVALID_PARAMS");
        const pending = this.#incoming.get(request.requestId);
        if (!pending || pending.plugin.extensionId !== extensionId || pending.plugin.epoch !== plugin.epoch) return failure("SYNC_REQUEST_EXPIRED");
        pending.current(); encode(request.data); this.#incoming.delete(request.requestId); pending.resolve(request.data); return { ok: true };
      }
      if (request.op !== "request" || typeof request.peer !== "string") return failure("INVALID_PARAMS");
      const peer = this.#peers().find(peer => peer.id === request.peer); if (!peer) return failure("SYNC_OFFLINE");
      this.#capacity(extensionId); encode(request.data);
      const own = this.#identity(), abort = new AbortController(), id = randomUUID();
      const active = AbortSignal.any([signal, abort.signal, this.#lifetime.signal, AbortSignal.timeout(DEADLINE)]);
      const current = () => { active.throwIfAborted(); assertCaller(); plugin.assertCurrent(); peer.assertCurrent(); };
      current(); this.#outgoing.set(id, { extensionId, abort });
      const timer = setInterval(() => { try { current(); } catch (reason) { abort.abort(reason); } }, 100); timer.unref();
      try {
        const hello = await bounded(peer.exchange(toBinary(contract.ExtensionDeviceSyncEnvelopeSchema, create(contract.ExtensionDeviceSyncEnvelopeSchema, { format: 1, publicKey: own.publicKey })), active), active);
        current(); const remote = this.#frame(hello); if (remote.data.byteLength || remote.iv || remote.tag || remote.transferId) return failure("SYNC_INVALID_REPLY");
        this.#pin(`out:${peer.epoch}`, remote.publicKey);
        const packet: Packet = { version: 1, kind: "request", id, plugin: plugin.identity, data: request.data };
        const bytes = this.#encrypt(packet, own, remote.publicKey);
        current(); const response = this.#frame(await bounded(peer.exchange(bytes, active), active)); current();
        if (response.publicKey !== remote.publicKey || response.transferId !== id) return failure("SYNC_INVALID_REPLY");
        const result = this.#decrypt(response, own);
        if (result.kind !== "response" || result.id !== id || !same(result.plugin, plugin.identity)) return failure("SYNC_INVALID_REPLY");
        return result.errorCode ? { ok: false, errorCode: result.errorCode } : { ok: true, data: result.data };
      } finally { clearInterval(timer); this.#outgoing.delete(id); }
    } catch (reason) { return { ok: false, errorCode: code(reason) }; }
  }
  async invoke(peerScope: string, bytes: Uint8Array, signal: AbortSignal, assertPeer: () => void): Promise<Uint8Array> {
    assertPeer(); signal.throwIfAborted(); this.#lifetime.signal.throwIfAborted();
    if (!this.#active) return failure("SYNC_OFFLINE");
    const own = this.#identity(), envelope = this.#frame(bytes);
    this.#pin(`in:${peerScope}`, envelope.publicKey);
    if (!envelope.data.byteLength && !envelope.transferId && !envelope.iv && !envelope.tag) return toBinary(contract.ExtensionDeviceSyncEnvelopeSchema,
      create(contract.ExtensionDeviceSyncEnvelopeSchema, { format: 1, publicKey: own.publicKey }));
    let peerAbort = this.#incomingPeers.get(peerScope);
    if (!peerAbort) { if (this.#incomingPeers.size >= 1024) return failure("SYNC_BUSY"); peerAbort = new AbortController(); this.#incomingPeers.set(peerScope, peerAbort); }
    const active = AbortSignal.any([signal, peerAbort.signal, this.#lifetime.signal, AbortSignal.timeout(DEADLINE)]);
    const packet = this.#decrypt(envelope, own); if (packet.kind !== "request") return failure("INVALID_PARAMS");
    const match = this.options.catalog.snapshot().entries.flatMap(extension => {
      try { const plugin = this.#capture(extension.id); return same(plugin.identity, packet.plugin) ? [plugin] : []; } catch { return []; }
    });
    if (match.length !== 1) return failure("SYNC_NOT_ALLOWED"); const plugin = match[0]!;
    const current = () => { active.throwIfAborted(); assertPeer(); plugin.assertCurrent(); };
    current();
    for (const [key, receipt] of this.#received) if (receipt.expiresAt <= Date.now()) this.#received.delete(key);
    const key = `${peerScope}:${packet.id}`, fingerprint = hash(encode(packet).toString("utf8"));
    let receipt = this.#received.get(key);
    if (receipt && receipt.hash !== fingerprint) return failure("SYNC_REQUEST_CONFLICT");
    if (receipt && receipt.epoch !== plugin.epoch) return failure("SYNC_REQUEST_EXPIRED");
    if (!receipt) {
      this.#capacity(plugin.extensionId); if (this.#received.size >= 1024) return failure("SYNC_BUSY");
      const result = this.#receive(peerScope, plugin, packet, active, current);
      receipt = { hash: fingerprint, epoch: plugin.epoch, expiresAt: Date.now() + DEADLINE * 2, result }; this.#received.set(key, receipt);
    }
    const response = await bounded(receipt.result, active); current(); return this.#encrypt(response, own, envelope.publicKey);
  }
  async #receive(peer: string, plugin: PluginCapture, packet: Packet, signal: AbortSignal, current: () => void): Promise<Packet> {
    const requestId = randomUUID(); let abortListener!: () => void, timer: ReturnType<typeof setInterval> | undefined;
    try {
      const answer = new Promise<unknown>((resolve, reject) => {
        abortListener = () => reject(Object.assign(new Error("Plugin sync expired."), { code: "SYNC_RESULT_UNKNOWN" }));
        signal.addEventListener("abort", abortListener, { once: true });
        this.#incoming.set(requestId, { plugin, peer, signal, current, resolve });
      });
      void answer.catch(() => {});
      timer = setInterval(() => { try { current(); } catch { abortListener(); } }, 100); timer.unref();
      current();
      if (!await bounded(this.options.deliver(plugin.extensionId, { type: "device-sync-request", version: 1, requestId, peer: hash(peer), data: packet.data }, signal, current), signal)) return failure("SYNC_PLUGIN_UNAVAILABLE");
      current(); const data = await answer; current(); encode(data);
      return { version: 1, kind: "response", id: packet.id, plugin: packet.plugin, data };
    } catch (reason) { return { version: 1, kind: "response", id: packet.id, plugin: packet.plugin, errorCode: code(reason) }; }
    finally { clearInterval(timer); signal.removeEventListener("abort", abortListener); this.#incoming.delete(requestId); }
  }
  #capacity(extensionId: string): void {
    if (this.#incoming.size + this.#outgoing.size >= 32 || [...this.#incoming.values()].filter(item => item.plugin.extensionId === extensionId).length
      + [...this.#outgoing.values()].filter(item => item.extensionId === extensionId).length >= 2) failure("SYNC_BUSY");
  }
  #pin(scope: string, key: string): void {
    const prior = this.#peerKeys.get(scope); if (prior && prior !== key) return failure("SYNC_PEER_IDENTITY_CHANGED");
    if (!prior && this.#peerKeys.size >= 2048) return failure("SYNC_BUSY"); this.#peerKeys.set(scope, key);
  }
  #frame(bytes: Uint8Array): contract.ExtensionDeviceSyncEnvelope {
    if (bytes.byteLength > MAX_FRAME) return failure("SYNC_TOO_LARGE");
    const value = fromBinary(contract.ExtensionDeviceSyncEnvelopeSchema, bytes);
    if (value.format !== 1 || !isValidNodeSyncPublicKey(value.publicKey) || value.data.byteLength > EXTENSION_DEVICE_SYNC_MAX_BYTES
      || value.transferId && !/^[a-f0-9-]{36}$/u.test(value.transferId)) return failure("INVALID_PARAMS"); return value;
  }
  #encrypt(packet: Packet, own: { readonly publicKey: string; readonly privateKey: string }, peerKey: string): Uint8Array {
    const encrypted = encryptNodeSyncBytes("plugin-data", encode(packet), own.privateKey, peerKey,
      { sourceNodeId: hash(own.publicKey), destinationNodeId: hash(peerKey), transferId: packet.id, totalChunks: 1 });
    return toBinary(contract.ExtensionDeviceSyncEnvelopeSchema, create(contract.ExtensionDeviceSyncEnvelopeSchema, {
      format: 1, publicKey: own.publicKey, transferId: packet.id, iv: encrypted.iv, tag: encrypted.tag, data: encrypted.ciphertext }));
  }
  #decrypt(envelope: contract.ExtensionDeviceSyncEnvelope, own: { readonly publicKey: string; readonly privateKey: string }): Packet {
    const bytes = decryptNodeSyncBytes("plugin-data", { iv: envelope.iv, tag: envelope.tag, ciphertext: Buffer.from(envelope.data) }, own.privateKey, envelope.publicKey,
      { sourceNodeId: hash(envelope.publicKey), destinationNodeId: hash(own.publicKey), transferId: envelope.transferId, totalChunks: 1 });
    if (bytes.byteLength > EXTENSION_DEVICE_SYNC_MAX_BYTES) return failure("SYNC_TOO_LARGE");
    const packet: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!packet || typeof packet !== "object" || Array.isArray(packet)) return failure("INVALID_PARAMS");
    const value = packet as Packet;
    if (value.version !== 1 || !["request", "response"].includes(value.kind) || value.id !== envelope.transferId || !value.plugin
      || !/^[a-f0-9]{64}$/u.test(value.plugin.id) || !/^[a-f0-9]{64}$/u.test(value.plugin.namespace)
      || value.errorCode !== undefined && (value.kind !== "response" || !/^SYNC_[A-Z_]{1,80}$/u.test(value.errorCode))
      || Object.keys(value).some(key => !["version", "kind", "id", "plugin", "data", "errorCode"].includes(key))) return failure("INVALID_PARAMS"); return value;
  }
  retire(prefix: string): void {
    for (const [scope, abort] of this.#incomingPeers) if (scope.startsWith(prefix)) { abort.abort(); this.#incomingPeers.delete(scope); }
    for (const key of this.#peerKeys.keys()) if (key.startsWith(`in:${prefix}`)) this.#peerKeys.delete(key);
    for (const key of this.#received.keys()) if (key.startsWith(prefix)) this.#received.delete(key);
  }
  invalidatePlugin(extensionId: string): void {
    this.#epochs.set(extensionId, (this.#epochs.get(extensionId) ?? 0) + 1);
    for (const pending of this.#outgoing.values()) if (pending.extensionId === extensionId) pending.abort.abort();
  }
  setActive(active: boolean): void {
    if (active && !this.#active) { this.#lifetime = new AbortController(); this.#active = true; }
    else if (!active) this.close();
  }
  close(): void { this.#active = false; this.#lifetime.abort(); for (const value of this.#outgoing.values()) value.abort.abort(); for (const abort of this.#incomingPeers.values()) abort.abort();
    this.#incoming.clear(); this.#received.clear(); this.#outgoing.clear(); this.#incomingPeers.clear(); this.#peerKeys.clear(); }
}
