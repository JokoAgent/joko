import { createHash } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { ProviderAccountUsageSnapshot, ProviderModel } from "@joko/core";
import { ProviderGroupStore, ProviderGroupUsageStore, type OperationalStore, type ProviderGroupKey, type ProviderGroupMember } from "@joko/store";
import type { BackendInstanceRegistry } from "./backend-instance-registry.js";
import type { HostedAgentSources } from "./hosted-agent-sources.js";
import { ProviderGroupDirectory, type ProviderGroupDirectorySource } from "./provider-group-directory.js";
import { ProviderGroupQuotaReader } from "./provider-group-quota.js";
import { ProviderGroupLeases } from "./provider-group-leases.js";
import { ProviderGroupRouter } from "./provider-group-router.js";
import { ProviderGroupService, type ProviderGroupSessionPort } from "./provider-group-service.js";
import { ProviderGroupUsage } from "./provider-group-usage.js";
import type { ProviderGroupConnectOptions } from "./provider-group-connect-service.js";
import type { ProviderSharingDirectoryPort, ProviderSharingRecipient } from "./provider-sharing-ports.js";
import { fromGroupAccountUsage, toGroupStrategy } from "./provider-group-wire.js";
import { toProtoCapability, toProtoModelDescriptor } from "./proto-mapper.js";
import { ProviderGroupGuestSwitch } from "./provider-group-guest-switch.js";
import type { HostedAgentPrincipal } from "./hosted-agent-host.js";
import type { ProviderGroupNativeCapture } from "./provider-group-hosted.js";
import { ProviderGroupRemoteRouter } from "./provider-group-remote.js";
import { ProviderGroupReporter } from "./provider-group-reporter.js";

export interface ProviderGroupRuntimeOptions {
  readonly store: OperationalStore; readonly registry: BackendInstanceRegistry; readonly sources: HostedAgentSources;
  readonly nodeId: string; readonly nodeName: () => string; readonly sessions: ProviderGroupSessionPort;
  readonly ownerGeneration: () => string;
  readonly readAccountUsage: (backendId: string, providerId: string, signal: AbortSignal) => Promise<ProviderAccountUsageSnapshot | undefined>;
  /** Count active turns on the native execution node, including direct and
   * hosted use. This is not the count of open native sessions. */
  readonly activeTurns: (backendId: string, providerId: string) => number;
  readonly assertRemoteAllowed: (key: ProviderGroupKey) => void;
  readonly refreshSources?: (signal: AbortSignal) => Promise<void>;
  readonly sharing?: ProviderSharingDirectoryPort;
  readonly ownedRecipients?: (group: ProviderGroupKey) => readonly ProviderSharingRecipient[];
  readonly now?: () => number; readonly log?: (event: Readonly<Record<string, unknown>>) => void;
}
export interface ProviderGroupTaskMember {
  readonly group: ProviderGroupKey; readonly memberKey: string; readonly nodeId: string; readonly nodeName: string;
  readonly backendId: string; readonly providerId: string; readonly modelId: string; readonly quotaReadable: boolean;
}
export class ProviderGroupRuntime {
  readonly store: ProviderGroupStore; readonly usage: ProviderGroupUsage; readonly service: ProviderGroupService;
  readonly directory: ProviderGroupDirectory; readonly router: ProviderGroupRouter; readonly leases: ProviderGroupLeases;
  readonly guestSwitch: ProviderGroupGuestSwitch;
  readonly remote: ProviderGroupRemoteRouter;
  readonly reporter: ProviderGroupReporter;
  readonly #remoteRunning = new Map<string, number>();
  readonly #options: ProviderGroupRuntimeOptions;
  nodeName(): string { return this.#options.nodeName(); }
  taskMember(sessionId: string): ProviderGroupTaskMember | undefined {
    const binding = this.store.binding(sessionId); if (!binding) return undefined;
    const member = this.store.snapshot(binding.group).config?.members.find(member => member.key === binding.memberKey); if (!member) return undefined;
    const source = this.sources().find(source => source.backendId === binding.backendId && source.providerId === binding.providerId);
    return { group: binding.group, memberKey: member.key, nodeId: member.nodeId, nodeName: member.displayName, backendId: binding.backendId,
      providerId: binding.providerId, modelId: binding.modelId, quotaReadable: source !== undefined && source.kind !== "share" && source.nodeId === member.nodeId && source.nativeBackendId === member.nativeBackendId };
  }
  async taskAccountUsage(sessionId: string, signal: AbortSignal): Promise<{ readonly member: ProviderGroupTaskMember; readonly snapshot?: ProviderAccountUsageSnapshot } | undefined> {
    const member = this.taskMember(sessionId); if (!member) return undefined; if (!member.quotaReadable) return { member };
    const source = this.sources().find(source => source.backendId === member.backendId && source.providerId === member.providerId); if (!source) return { member };
    source.assertCurrent(); const snapshot = source.kind === "local" ? await this.#options.readAccountUsage(member.backendId, member.providerId, signal) : await (async () => {
      const captured = this.#options.sources.captureGroupPeer(member.backendId), client = createClient(contract.ProviderGroupService, captured.transport);
      const state = await client.getProviderSchedulingState({ key: { backendId: captured.nativeBackendId, providerId: member.providerId }, modelId: member.modelId }, { signal }); captured.assertCurrent(); return fromGroupAccountUsage(state.accountUsage);
    })();
    signal.throwIfAborted(); source.assertCurrent(); const current = this.taskMember(sessionId);
    if (!current || JSON.stringify(current) !== JSON.stringify(member)) throw new Error("The task Provider group member changed.");
    return { member, ...(snapshot ? { snapshot } : {}) };
  }
  constructor(options: ProviderGroupRuntimeOptions) {
    this.#options = options; const now = options.now ?? Date.now;
    this.guestSwitch = new ProviderGroupGuestSwitch(now); options.sources.installGroupSwitch(this.guestSwitch);
    this.store = new ProviderGroupStore(options.store, options.nodeId);
    options.sources.installGroupStore(this.store);
    this.usage = new ProviderGroupUsage(this.store, new ProviderGroupUsageStore(options.store, options.nodeId), now);
    const quotas = new ProviderGroupQuotaReader({ now,
      readLocal: (member, signal) => options.readAccountUsage(member.backendId, member.providerId, signal),
      readRemote: async (member, signal) => {
        const captured = options.sources.captureGroupPeer(member.backendId);
        const client = createClient(contract.ProviderGroupService, captured.transport);
        const state = await client.getProviderSchedulingState({ key: { backendId: captured.nativeBackendId, providerId: member.providerId }, modelId: "" }, { signal });
        captured.assertCurrent(); this.#remoteRunning.set(member.key, state.activeTurns); return fromGroupAccountUsage(state.accountUsage);
      } });
    this.directory = new ProviderGroupDirectory({ sources: () => this.sources(), quotas, ownerGeneration: options.ownerGeneration,
      running: source => source.kind === "local" ? options.activeTurns(source.backendId, source.providerId) : this.#remoteRunning.get(source.key) ?? 0,
      ...(options.refreshSources ? { refresh: options.refreshSources } : {}), ...(options.sharing ? { sharing: options.sharing } : {}) });
    this.leases = new ProviderGroupLeases(now);
    this.remote = new ProviderGroupRemoteRouter({ store: this.store, sources: options.sources, directory: this.directory, leases: this.leases,
      localNodeId: options.nodeId, ownerGeneration: options.ownerGeneration });
    this.router = new ProviderGroupRouter(this.store, this.directory, this.leases, now, Math.random, this.remote);
    this.service = new ProviderGroupService({ router: this.router, sessions: options.sessions, ...(options.sharing ? { sharing: options.sharing } : {}),
      ...(options.ownedRecipients ? { ownedRecipients: options.ownedRecipients } : {}), ...(options.log ? { log: options.log } : {}) });
    this.reporter = new ProviderGroupReporter({ groups: this.store, remote: this.remote, leases: this.leases, usage: this.usage, now });
  }
  sources(): readonly ProviderGroupDirectorySource[] {
    const options = this.#options, remote = options.sources.groupCatalog(), remoteIds = new Set(remote.map(source => source.backendId)), result: ProviderGroupDirectorySource[] = [];
    for (const backend of options.registry.descriptors()) {
      if (remoteIds.has(backend.id) || !backend.capabilities.get("turn.stream")?.supported || !backend.capabilities.get("input.text")?.supported) continue;
      const generation = backend.instanceGeneration;
      const providerIds = new Set([...(backend.providers?.map(provider => provider.providerId) ?? []), ...backend.models.map(model => model.providerId)]);
      for (const providerId of providerIds) {
        const provider = backend.providers?.find(provider => provider.providerId === providerId);
        const models = backend.models.filter(model => model.providerId === providerId);
        result.push({ backendId: backend.id, nativeBackendId: backend.id, nativeBackendInstanceGeneration: generation, providerId, key: providerGroupMemberKey(options.nodeId, backend.id, providerId), kind: "local", nodeId: options.nodeId,
          displayName: options.nodeName(), providerName: provider?.displayName ?? providerId, agentKind: backend.adapterKind,
          available: backend.health !== "unavailable" && models.length > 0 && (!provider || ["authenticated", "not_required"].includes(provider.authenticationState)), remotelyEnabled: true, models,
          ...providerBrand(provider?.accessKind, provider?.accessProduct),
          assertCurrent: () => { const current = options.registry.get(backend.id); if (current.generation !== generation || current.state !== "available") throw new Error("The Provider Backend incarnation changed."); } });
      }
    }
    for (const entry of remote) for (const provider of entry.catalog.providers) {
      if (!entry.catalog.nodeId) continue;
      const models = options.registry.descriptors().find(backend => backend.id === entry.backendId)?.models.filter(model => model.providerId === provider.providerId) ?? [];
      const executionNodeId = entry.catalog.nodeId;
      result.push({ key: providerGroupMemberKey(executionNodeId, entry.source.backendId, provider.providerId, entry.received?.joinId),
        backendId: entry.backendId, nativeBackendId: entry.source.backendId, nativeBackendInstanceGeneration: Number(entry.catalog.instanceGeneration),
        providerId: provider.providerId, kind: entry.received ? "share" : "device", nodeId: executionNodeId,
        displayName: entry.name, providerName: provider.displayName, agentKind: entry.catalog.nativeAdapterKind, available: entry.available && provider.connected,
        remotelyEnabled: provider.remoteInvocationEnabled, models, ...(entry.received ? { received: entry.received } : {}), ...providerBrand(provider.accessKind, provider.accessProduct),
        assertCurrent: () => {
          if (entry.received) { if (!options.sharing) throw new Error("The Provider share directory is unavailable."); options.sharing.assertReceived(entry.received); }
          else options.sources.captureGroupPeer(entry.backendId).assertCurrent();
          const current = options.sources.groupCatalog().find(source => source.backendId === entry.backendId), currentProvider = current?.catalog.providers.find(item => item.providerId === provider.providerId);
          if (!current?.catalog.nativeAdapterKind || current.catalog.instanceGeneration !== entry.catalog.instanceGeneration
            || !current.available || !currentProvider?.connected || !currentProvider.remoteInvocationEnabled) throw new Error("The Provider source is unavailable.");
        } });
    }
    return result;
  }
  captureHosted(member: ProviderGroupMember, principal: HostedAgentPrincipal, modelIds: readonly string[], assertCurrent: () => void): ProviderGroupNativeCapture {
    const options = this.#options;
    if (member.kind === "share") {
      const sharing = options.sharing; if (!sharing || !member.received) throw new Error("The original Provider share authority is unavailable.");
      const capture = sharing.captureNative(member.received, sharing.localSourceDeviceId, principal.providerGrant?.recipient);
      const current = () => { assertCurrent(); capture.assertCurrent(); };
      return { client: capture.client, assertCurrent: current, close: capture.close };
    }
    if (principal.trust === "guest") {
      const recipient = principal.providerGrant?.recipient; if (!recipient) throw new Error("The original guest recipient is unavailable.");
      return options.sources.captureGuestForGroup(member.backendId, recipient, member.providerId, modelIds, assertCurrent, principal.providerGrant?.purgeRequested);
    }
    const captures = new Map<string, ReturnType<HostedAgentSources["captureNativeForGroup"]>>();
    const first = options.sources.captureNativeForGroup(member.backendId, "group-capture");
    return { client: { open: (input, signal) => { const captured = options.sources.captureNativeForGroup(member.backendId, input.runId); captures.set(input.runId, captured); return captured.client.open(input, signal); },
      call: (...args) => first.client.call(...args), infer: (request, signal) => { assertCurrent(); first.assertCurrent(); return first.client.infer(request, signal); },
      poll: (...args) => first.client.poll(...args), reply: (...args) => first.client.reply(...args), readArtifact: (...args) => first.client.readArtifact(...args) },
      poller: first.pool.poller, assertCurrent: () => { assertCurrent(); first.assertCurrent(); }, close: async (runId, signal) => { const captured = captures.get(runId); if (!captured) throw new Error("The original group cleanup was not captured."); await captured.close(signal); } };
  }
  connectOptions(authenticate: ProviderGroupConnectOptions["authenticate"]): ProviderGroupConnectOptions {
    return { service: this.service, usage: this.usage, authenticate, assertRemoteAllowed: this.#options.assertRemoteAllowed,
      schedulingState: async (key, _modelId, signal) => {
        this.#options.assertRemoteAllowed(key);
        const accountUsage = await this.#options.readAccountUsage(key.backendId, key.providerId, signal);
        return { activeTurns: this.#options.activeTurns(key.backendId, key.providerId), ...(accountUsage ? { accountUsage } : {}) };
      }, ...(this.#options.now ? { now: this.#options.now } : {}) };
  }
  decorateCatalog(catalog: contract.GetHostedAgentCatalogResponse): contract.GetHostedAgentCatalogResponse {
    return { ...catalog, backends: catalog.backends.map(backend => ({ ...backend, providers: backend.providers.map(provider => {
      const group = this.store.snapshot({ backendId: backend.backendId, providerId: provider.providerId }).config;
      const grouped = group ? this.sharedProvider(backend.backendId, provider.providerId) : undefined;
      return { ...provider, ...(grouped ? { models: grouped.models.map(model => toProtoModelDescriptor(backend.backendId, model)) } : {}),
        group: group ? { $typeName: "joko.v1.ProviderGroupSummary" as const, strategy: toGroupStrategy(group.strategy), autoSwitch: group.autoSwitch,
        memberCount: new Set(group.members.map(member => member.nodeId)).size } : undefined };
    }) })) };
  }
  sharedProvider(backendId: string, providerId: string): { readonly catalog: contract.HostedAgentBackendCatalog; readonly models: readonly ProviderModel[]; assertCurrent(): void } | undefined {
    const group = this.store.snapshot({ backendId, providerId }); if (!group.config) return undefined;
    const backend = this.#options.registry.get(backendId).descriptor, sources = this.sources();
    const members = group.config.members.flatMap(member => {
      const source = sources.find(source => source.key === member.key);
      if (!source?.available || member.paused || source.kind !== "local" && !source.remotelyEnabled) return [];
      try { source.assertCurrent(); } catch { return []; } return [source];
    });
    const models = [...new Map(members.flatMap(member => member.models.map(model => ({ ...model, providerId }))).map(model => [model.logicalId ?? model.modelId, model])).values()];
    const provider = backend.providers?.find(provider => provider.providerId === providerId);
    const assertCurrent = () => {
      const current = this.store.snapshot({ backendId, providerId });
      if (current.revision !== group.revision || !current.config || !this.sources().some(source => members.some(member => member.key === source.key) && source.available)) throw new Error("The shared Provider group changed.");
    };
    return { models, assertCurrent, catalog: create(contract.HostedAgentBackendCatalogSchema, { backendId, instanceGeneration: BigInt(backend.instanceGeneration), displayName: backend.displayName, nativeAdapterKind: backend.adapterKind, nodeId: this.#options.nodeId,
      capabilities: [...backend.capabilities.values()].map(toProtoCapability), version: backend.version,
      providers: [{ providerId, displayName: provider?.displayName ?? providerId, connected: models.length > 0, remoteInvocationEnabled: true,
        accessKind: provider?.accessKind ?? "", accessProduct: provider?.accessProduct ?? "", models: models.map(model => toProtoModelDescriptor(backendId, model)),
        group: { strategy: toGroupStrategy(group.config.strategy), autoSwitch: group.config.autoSwitch, memberCount: new Set(group.config.members.map(member => member.nodeId)).size } }] }) };
  }
  async close(): Promise<void> { this.guestSwitch.clear(); await this.reporter.close(); await this.service.close(); }
}
export function providerGroupMemberKey(nodeId: string, nativeBackendId: string, providerId: string, joinId?: string): string {
  return "member-" + createHash("sha256").update(JSON.stringify([nodeId, nativeBackendId, providerId, joinId ?? null])).digest("hex").slice(0, 32);
}
export function providerGroupDefaultMember(source: ProviderGroupDirectorySource): ProviderGroupMember {
  return { key: source.key, kind: source.kind, backendId: source.backendId, nativeBackendId: source.nativeBackendId, providerId: source.providerId, nodeId: source.nodeId, displayName: source.displayName,
    capacity: 4, weight: 1, paused: false, ...(source.received ? { received: source.received } : {}) };
}
function providerBrand(accessKind: string | undefined, product: string | undefined): { readonly brand?: string } {
  if (accessKind !== "subscription") return {};
  switch (product?.trim().toLowerCase()) {
    case "claude": case "claude code": return { brand: "anthropic" };
    case "chatgpt": case "codex": return { brand: "openai" };
    default: return {};
  }
}
