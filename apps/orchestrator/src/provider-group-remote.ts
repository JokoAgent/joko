import { createClient, type Client } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { type ProviderGroupStore, type ProviderGroupKey, type ProviderGroupMember, type ProviderGroupSnapshot } from "@joko/store";
import type { HostedAgentSources } from "./hosted-agent-sources.js";
import type { ProviderGroupDirectory, ProviderGroupDirectoryRequest, ProviderGroupMemberStatus } from "./provider-group-directory.js";
import type { ProviderGroupAssignment, ProviderGroupPick, ProviderGroupRemoteRouterPort } from "./provider-group-router.js";
import type { ProviderGroupLeases } from "./provider-group-leases.js";
import { fromGroupConfig, fromGroupMember, fromGroupKey } from "./provider-group-wire.js";
import type { ProviderGroupFailureDecision, ProviderGroupFailureSignals } from "./provider-group-failure-policy.js";
import { ProviderGroupUnavailableError } from "./provider-group-failure-policy.js";

interface CapturedOwner { readonly client: Client<typeof contract.ProviderGroupService>; readonly nativeBackendId: string; readonly ownerNodeId: string; assertCurrent(): void; }
/** The original task asks B to choose, then resolves B's coordinates through
 * its own existing Sources. It never imports B's Backend IDs as local routes
 * or creates a Device relation from a group response. */
export class ProviderGroupRemoteRouter implements ProviderGroupRemoteRouterPort {
  constructor(readonly options: { readonly store: ProviderGroupStore; readonly sources: HostedAgentSources; readonly directory: ProviderGroupDirectory;
    readonly leases: ProviderGroupLeases; readonly localNodeId: string; readonly ownerGeneration: () => string }) {}
  owns(group: ProviderGroupKey): boolean {
    if (this.options.sources.sourceKind(group.backendId) !== "device") return false;
    return this.options.store.snapshot(group).ownerNodeId !== undefined || this.options.sources.groupCatalog().some(source => source.backendId === group.backendId
      && source.catalog.nodeId && source.catalog.providers.some(provider => provider.providerId === group.providerId && provider.group !== undefined));
  }
  capture(group: ProviderGroupKey): CapturedOwner {
    const source = this.options.sources.captureGroupPeer(group.backendId), generation = this.options.ownerGeneration();
    return { ...source, client: createClient(contract.ProviderGroupService, source.transport), assertCurrent: () => {
      source.assertCurrent(); if (generation !== this.options.ownerGeneration()) throw new Error("The Provider group owner changed.");
    } };
  }
  async prepare(group: ProviderGroupKey, signal: AbortSignal): Promise<void> {
    const owner = this.capture(group), response = await owner.client.getProviderGroup({ key: { backendId: owner.nativeBackendId, providerId: group.providerId } }, { signal });
    owner.assertCurrent(); signal.throwIfAborted(); this.#observe(group, owner, response.group);
  }
  async pick(input: ProviderGroupPick, signal: AbortSignal): Promise<ProviderGroupAssignment> {
    const owner = this.capture(input.group); let picked: contract.PickProviderGroupMemberResponse;
    picked = await owner.client.pickProviderGroupMember({ key: { backendId: owner.nativeBackendId, providerId: input.group.providerId }, sessionId: input.sessionId,
      agentKind: input.agentKind, modelId: input.modelId, ...(input.logicalModelId === undefined ? {} : { logicalModelId: input.logicalModelId }), excludeMemberKeys: [...(input.exclude ?? [])] }, { signal });
    owner.assertCurrent(); signal.throwIfAborted(); const snapshot = this.#observe(input.group, owner, picked.group);
    if (!picked.member || !picked.modelId || !snapshot.config) throw new ProviderGroupUnavailableError();
    const original = fromGroupMember(picked.member), member = this.#map(input.group, original);
    if (!snapshot.config.members.some(row => row.key === member.key && row.backendId === member.backendId)) throw new ProviderGroupUnavailableError();
    const source = this.options.directory.sources().find(source => source.backendId === member.backendId && source.providerId === member.providerId);
    const model = source?.models.find(model => model.modelId === picked.modelId || (model.logicalId ?? model.modelId) === input.logicalModelId || model.modelId === input.modelId);
    if (!source?.available || !model) throw new ProviderGroupUnavailableError(); source.assertCurrent();
    const status: ProviderGroupMemberStatus = { member, model, available: true, reachable: true, running: picked.running, quota: picked.quota ? { ...picked.quota } : { limited: false },
      assertCurrent: () => { owner.assertCurrent(); source.assertCurrent(); signal.throwIfAborted(); } };
    const profile = { ...input.profile, backendId: member.backendId, providerId: member.providerId, modelId: member.backendId === input.group.backendId ? input.modelId : model.modelId };
    this.options.sources.prepareGroupMember(input.sessionId, profile.backendId === input.group.backendId && original.kind === "share" ? "" : profile.backendId);
    const reservation = this.options.leases.reserve({ sessionId: input.sessionId, memberKey: member.key, backendId: profile.backendId, providerId: profile.providerId }); let committed = false;
    const assertCurrent = () => { status.assertCurrent(); const current = this.options.store.snapshot(input.group); if (current.revision !== snapshot.revision || current.ownerNodeId !== owner.ownerNodeId) throw new ProviderGroupUnavailableError(); };
    return { group: input.group, snapshot, member, status, profile, assertCurrent, release: reservation.release, commit: () => {
      if (committed) return; assertCurrent(); this.options.store.commitBinding(input.sessionId, { group: input.group, groupRevision: snapshot.revision.toString(), memberKey: member.key,
        backendId: profile.backendId, providerId: profile.providerId, modelId: profile.modelId, ownerNodeId: owner.ownerNodeId }, snapshot.revision); committed = true;
    } };
  }
  async read(group: ProviderGroupKey, member: ProviderGroupMember, request: ProviderGroupDirectoryRequest, signal: AbortSignal): Promise<ProviderGroupMemberStatus> {
    const owner = this.capture(group), response = await owner.client.getProviderGroup({ key: { backendId: owner.nativeBackendId, providerId: group.providerId }, agentKind: request.agentKind,
      modelId: request.modelId, ...(request.logicalModelId === undefined ? {} : { logicalModelId: request.logicalModelId }) }, { signal });
    owner.assertCurrent(); signal.throwIfAborted(); const snapshot = this.#observe(group, owner, response.group), state = response.members.find(state => state.memberKey === member.key);
    const current = snapshot.config?.members.find(row => row.key === member.key);
    const source = current && this.options.directory.sources().find(source => source.backendId === current.backendId && source.providerId === current.providerId);
    const model = source?.models.find(model => model.modelId === state?.modelId || (model.logicalId ?? model.modelId) === request.logicalModelId || model.modelId === request.modelId);
    const available = current !== undefined && state?.available === true && source?.available === true && model !== undefined;
    return { member: current ?? member, available, reachable: state?.reachable === true && source?.available === true,
      ...(model ? { model } : {}), quota: state?.quota ? { ...state.quota } : { limited: false }, running: state?.running ?? 0,
      ...(!available ? { reason: state?.reachable ? "model" as const : "offline" as const } : {}), assertCurrent: () => {
        owner.assertCurrent(); signal.throwIfAborted(); if (!available || !source) throw new ProviderGroupUnavailableError(); source.assertCurrent();
      } };
  }
  cool(group: ProviderGroupKey, member: ProviderGroupMember, modelId: string, signals: ProviderGroupFailureSignals, decision: ProviderGroupFailureDecision): void {
    if (decision.action !== "switch" || !decision.cool) return;
    try {
      const owner = this.capture(group); void owner.client.coolProviderGroupMember({ key: { backendId: owner.nativeBackendId, providerId: group.providerId }, memberKey: member.key,
        modelId, cause: decision.cause, modelScoped: signals.modelScoped === true, ...(signals.usageResetAt === undefined ? {} : { resetAt: signals.usageResetAt }) }, { signal: AbortSignal.timeout(5000) }).catch(() => {});
    } catch { /* A reporting failure must not replay the original native turn. */ }
  }
  #observe(key: ProviderGroupKey, owner: CapturedOwner, wire: contract.ProviderGroupSnapshot | undefined): ProviderGroupSnapshot {
    if (!wire || fromGroupKey(wire.key).backendId !== owner.nativeBackendId || wire.key!.providerId !== key.providerId) throw new ProviderGroupUnavailableError();
    const config = wire.config ? fromGroupConfig(wire.config) : undefined;
    return this.options.store.observeRemote(key, owner.ownerNodeId, wire.revision, config ? { ...config, members: config.members.map(member => this.#map(key, member)) } : undefined);
  }
  #map(group: ProviderGroupKey, member: ProviderGroupMember): ProviderGroupMember {
    const local = member.nodeId === this.options.localNodeId ? this.options.directory.sources().find(source => source.kind === "local" && source.nativeBackendId === member.nativeBackendId && source.providerId === member.providerId) : undefined;
    const direct = member.kind === "share" ? undefined : this.options.sources.resolveGroupMember(member.nodeId, member.nativeBackendId, member.providerId);
    // A share credential belongs to B. C keeps its original authenticated B
    // source; B consumes its own captured selection and performs the relay.
    const backendId = local?.backendId ?? direct ?? group.backendId;
    const { received: _received, ...plain } = member;
    return { ...plain, backendId, providerId: !local && !direct ? group.providerId : member.providerId, kind: local ? "local" : "device" };
  }
}
