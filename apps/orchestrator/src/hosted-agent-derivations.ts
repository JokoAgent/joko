import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AdapterContext, BackendAdapter, HostedExecution, NativeSessionBinding, NativeSessionDerivationLifecycle } from "@joko/core";
import type { HostedNativeDerivationLifecycle } from "@joko/adapter-hosted";
import type { HostedAgentStore, HostedNativeSessionOwner, HostedNativeSessionRecord } from "@joko/store";
import type { HostedAgentPrincipal } from "./hosted-agent-host.js";
import { HostedAgentSessionSlots, type HostedAgentSlot } from "./hosted-agent-limits.js";
import { createHostedAgentToolChannel, type HostedAgentToolChannel } from "./hosted-agent-tool-channel.js";

interface NativeCreation {
  readonly home: string; readonly signal: AbortSignal; readonly execution: HostedExecution;
  readonly nativeOwner: { readonly sessionId: string; readonly targetId: string; readonly generation: number; readonly backendInstanceGeneration: number };
}
export interface HostedAgentDerivationsOptions {
  readonly root: string; readonly store: HostedAgentStore; readonly slots: HostedAgentSessionSlots; readonly artifactCapacityBytes: number;
  readonly isRunning: (sourceKey: string, operationId: string) => boolean;
  readonly createAdapter: (record: HostedNativeSessionRecord, creation: NativeCreation, assertCurrent: () => void) => BackendAdapter | Promise<BackendAdapter>;
  readonly assertAdoption: (principal: HostedAgentPrincipal, record: HostedNativeSessionRecord) => void;
}

/** Durable native-side counterpart of the Product derivation receipt. Recovery
 * addresses exact Source/child aliases and never repeats fork or clone. */
export class HostedAgentDerivations {
  readonly #flights = new Map<string, Promise<void>>();
  readonly #cleanups = new Map<string, { readonly leaseId: string; readonly channel: HostedAgentToolChannel; readonly slot: HostedAgentSlot;
    adapter?: BackendAdapter; nativeDeleted: boolean }>();
  constructor(readonly options: HostedAgentDerivationsOptions) {}
  hasPhysicalOwner(key: string): boolean { return this.#cleanups.has(key); }
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#flights.values()]);
    const results = await Promise.allSettled([...this.#cleanups.keys()].map(key => this.#finishCleanup(key)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Native derivation cleanup could not be confirmed.");
  }
  async #finishCleanup(key: string): Promise<boolean> {
    const cleanup = this.#cleanups.get(key); if (!cleanup) return false;
    await cleanup.adapter?.dispose(); cleanup.adapter = undefined; await cleanup.channel.close();
    if (cleanup.nativeDeleted) this.options.store.updateDerivation(key, cleanup.leaseId, { state: "cleaned" });
    cleanup.slot.release(); this.#cleanups.delete(key);
    return cleanup.nativeDeleted;
  }
  manage(principal: HostedAgentPrincipal, command: HostedNativeDerivationLifecycle, signal: AbortSignal): Promise<void> {
    const owner = this.#owner(principal, command), key = this.options.store.key(owner);
    const previous = this.#flights.get(key);
    const next = (previous ?? Promise.resolve()).catch(() => {}).then(() => this.#manage(principal, command, owner, signal))
      .finally(() => { if (this.#flights.get(key) === next) this.#flights.delete(key); });
    this.#flights.set(key, next); return next;
  }
  #owner(principal: HostedAgentPrincipal, command: HostedNativeDerivationLifecycle): HostedNativeSessionOwner {
    principal.assertCurrent(); principal.providerGrant?.assertCurrent();
    return { authorityId: principal.id, deviceId: principal.deviceId, trust: principal.trust, backendId: command.backendId,
      sessionId: command.sessionId, targetId: command.targetId, nativeSessionId: command.nativeSessionId,
      ...(principal.providerGrant?.cleanupOwner ? { providerGrant: principal.providerGrant.cleanupOwner } : {}) };
  }
  async #manage(principal: HostedAgentPrincipal, command: HostedNativeDerivationLifecycle, owner: HostedNativeSessionOwner, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const store = this.options.store, key = store.key(owner), sourceOwner = { ...owner, sessionId: command.sourceSessionId,
      targetId: command.sourceTargetId, nativeSessionId: command.sourceNativeSessionId }, sourceKey = store.key(sourceOwner);
    if (sourceKey === key || owner.targetId !== sourceOwner.targetId) throw new Error("The native derivation source and child authority conflicts.");
    let record = store.find(key);
    if (!record) {
      if (command.action !== "cleanup") throw new Error("The original native derivation has not been confirmed.");
      const source = store.find(sourceKey);
      if (!source || JSON.stringify(source.owner.providerGrant) !== JSON.stringify(owner.providerGrant)) throw new Error("The native derivation source owner is unavailable.");
      // Fence even an as-yet undelivered original request. Absence alone must
      // never allow a late network delivery to create an unowned child.
      store.cancelUnstartedDerivation(owner, source, command.operationId, command.derivationKind); return;
    }
    const derivation = record.derivation;
    if (JSON.stringify(record.owner.providerGrant) !== JSON.stringify(owner.providerGrant) || !derivation || derivation.sourceKey !== sourceKey
      || derivation.operationId !== command.operationId || derivation.kind !== command.derivationKind) throw new Error("The native derivation lifecycle owner conflicts.");
    if (command.action === "adopt") {
      this.options.assertAdoption(principal, record);
      if (derivation.adopted) return;
      if (!record.binding || derivation.cleanupRequested || derivation.state !== "settled" || !derivation.nativeAdopted) throw new Error("The original native derivation outcome remains unknown.");
      store.updateDerivation(key, record.leaseId, { adopted: true }); return;
    }
    if (derivation.state === "cleaned") return;
    if (derivation.adopted) throw new Error("The Product has already adopted this native child; derivation cleanup cannot delete it.");
    if (await this.#finishCleanup(key)) return;
    record = store.updateDerivation(key, record.leaseId, { cleanupRequested: true });
    if (this.options.isRunning(sourceKey, command.operationId)) throw new Error("The exact native derivation is still settling; cleanup remains pending.");
    const leaseId = record.leaseId;
    const assertCurrent = () => {
      signal.throwIfAborted(); principal.assertCurrent(); principal.providerGrant?.assertCurrent();
      const current = store.assertLease(key, leaseId);
      if (!current.derivation?.cleanupRequested || current.derivation.adopted) throw new Error("The native derivation cleanup authority changed.");
    };
    const lineage = record.storageKey ?? record.key, root = join(this.options.root, lineage), workspace = join(root, "workspace");
    if (resolve(this.options.root) !== this.options.root) throw new Error("Native derivation storage root is invalid.");
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root || await realpath(workspace) !== workspace) throw new Error("Native derivation storage authority changed.");
    assertCurrent();
    const channel = await createHostedAgentToolChannel({ assertCurrent, execute: async () => { throw new Error("Native derivation cleanup has no Source tool authority."); } });
    let slot: HostedAgentSlot;
    try { slot = this.options.slots.reserve(owner.deviceId); } catch (error) { await channel.close(); throw error; }
    const cleanup = { leaseId, channel, slot, nativeDeleted: false, adapter: undefined as BackendAdapter | undefined };
    this.#cleanups.set(key, cleanup);
    let adapter: BackendAdapter | undefined;
    try {
      const nativeOwner = { sessionId: `hosted-session:${key}`, targetId: `hosted-target:${lineage}`,
        generation: record.binding?.generation ?? 1, backendInstanceGeneration: 1 };
      const hosted: HostedExecution = { source: { sessionId: owner.sessionId, targetId: owner.targetId, generation: 1 },
        workspace: { root: workspace, additionalRoots: [], platform: process.platform as "win32" | "darwin" | "linux", shell: "native", isGitRepository: false }, channel, assertCurrent,
        ...(owner.trust === "owner" ? { trust: "owner" as const } : { trust: "guest" as const, guestHome: root,
          providerId: derivation.providerId, modelIds: [derivation.modelId] }) };
      adapter = await this.options.createAdapter(record, { home: join(root, "native"), signal, execution: hosted, nativeOwner }, assertCurrent);
      cleanup.adapter = adapter;
      assertCurrent();
      if (adapter.id !== owner.backendId || adapter.hostedExecutionCapabilities?.toolsOnSource !== true
        || owner.trust === "guest" && adapter.hostedExecutionCapabilities.isolatedGuests !== true) throw new Error("The original native cleanup Adapter is unavailable.");
      const target = { id: nativeOwner.targetId, backendId: owner.backendId, displayName: "Hosted Agent", workspaceRoot: workspace, trusted: false, managed: true };
      const lifecycle: NativeSessionDerivationLifecycle = { operationId: command.operationId, kind: command.derivationKind,
        sourceSessionId: `hosted-session:${sourceKey}`, sourceBinding: derivation.sourceBinding, sessionId: nativeOwner.sessionId, sourceTarget: target, target,
        ...(record.binding ? { binding: record.binding } : {}) };
      if (!derivation.nativeAdopted && await adapter.ownsNativeSessionDerivationLifecycle?.(lifecycle) === true) {
        if (!adapter.cleanupNativeSessionDerivation) throw new Error("The original native derivation cleanup implementation is unavailable.");
        await adapter.cleanupNativeSessionDerivation(lifecycle, signal);
      } else {
        if (!record.binding) throw new Error("The native child outcome is unknown; its original operation was not repeated.");
        const context: AdapterContext = { ...nativeOwner, target, binding: record.binding, hostedExecution: hosted, signal,
          operationId: command.operationId, modelSelection: { providerId: derivation.providerId, modelId: derivation.modelId },
          artifactCapacityBytes: this.options.artifactCapacityBytes, emit: async () => {},
          requestInteraction: async () => { throw new Error("Native cleanup cannot request an interaction."); },
          storeArtifact: async () => { throw new Error("Native cleanup cannot create an Artifact."); } };
        if (adapter.supportsDetachedSessionDeletion?.(context) !== true) throw new Error("This native Backend cannot confirm detached child deletion.");
        await adapter.deleteSession(record.binding as NativeSessionBinding, context);
      }
      cleanup.nativeDeleted = true; assertCurrent();
    } finally {
      // Cleanup failures keep the persistent child and the exact physical
      // owner. The native Adapter must positively confirm disposal first.
      try { await this.#finishCleanup(key); }
      catch { throw new Error("The native derivation cleanup process could not confirm closure."); }
    }
  }
}
