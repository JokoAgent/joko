import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { groupKey, RevisionConflictError, type ProviderGroupKey, type ProviderGroupUsageRow } from "@joko/store";
import type { ProviderAccountUsageSnapshot } from "@joko/core";
import type { ProviderGroupService } from "./provider-group-service.js";
import type { ProviderGroupUsage } from "./provider-group-usage.js";
import { toProtoModelDescriptor } from "./proto-mapper.js";
import { fromGroupConfig, fromGroupKey, fromGroupUsage, toGroupAccountUsage, toGroupMember, toGroupSnapshot, toGroupUsage } from "./provider-group-wire.js";
import { ProviderGroupUnavailableError } from "./provider-group-failure-policy.js";
import { providerGroupQuota } from "./provider-group-quota.js";
import type { ProviderGroupTaskMember } from "./provider-group-runtime.js";
import { ConnectionAuthenticationError } from "./connection-manager.js";

export interface ProviderGroupPrincipal {
  readonly id: string; readonly trust: "owner"; readonly management: boolean; assertCurrent(): void;
}
export interface ProviderGroupConnectOptions {
  readonly service: ProviderGroupService; readonly usage: ProviderGroupUsage;
  readonly authenticate: (context: HandlerContext) => ProviderGroupPrincipal | Promise<ProviderGroupPrincipal>;
  readonly assertRemoteAllowed: (key: ProviderGroupKey) => void;
  readonly schedulingState: (key: ProviderGroupKey, modelId: string, signal: AbortSignal) => Promise<{ readonly activeTurns: number; readonly accountUsage?: ProviderAccountUsageSnapshot }>;
  readonly memberAccountUsage?: (key: ProviderGroupKey, expectedRevision: bigint, memberKey: string, signal: AbortSignal) => Promise<{
    readonly state: "ready" | "unsupported" | "offline" | "shared"; readonly accountUsage?: ProviderAccountUsageSnapshot;
  }>;
  readonly taskAccountUsage?: (sessionId: string, generation: bigint, signal: AbortSignal) => Promise<{
    readonly member: ProviderGroupTaskMember; readonly snapshot?: ProviderAccountUsageSnapshot;
  } | undefined>;
  readonly now?: () => number;
}
interface PendingReport { readonly sequence: bigint; readonly sinceDay: string; readonly count: number; readonly at: number; readonly parts: Map<number, readonly ProviderGroupUsageRow[]>; }
export function createProviderGroupConnectService(options: ProviderGroupConnectOptions): ServiceImpl<typeof contract.ProviderGroupService> {
  const pending = new Map<string, PendingReport>(), service = options.service;
  const invoke = async <T>(context: HandlerContext, management: boolean, action: (principal: ProviderGroupPrincipal) => Promise<T>): Promise<T> => {
    try {
      context.signal.throwIfAborted(); const principal = await options.authenticate(context); principal.assertCurrent();
      if (principal.trust !== "owner" || management && !principal.management) throw new ConnectError("Only this computer's owner can manage Provider groups.", Code.PermissionDenied);
      const value = await action(principal); principal.assertCurrent(); context.signal.throwIfAborted(); return value;
    } catch (error) {
      if (error instanceof ConnectError) throw error;
      if (error instanceof ConnectionAuthenticationError) throw new ConnectError("Owner authentication is required.", Code.Unauthenticated);
      if (error instanceof ProviderGroupUnavailableError && error.retryAt !== undefined) {
        const delay = Math.ceil(error.retryAt - (options.now?.() ?? Date.now()));
        if (Number.isSafeInteger(delay) && delay > 0 && delay <= 8 * 24 * 60 * 60_000) {
          throw new ConnectError("Provider group quota is waiting for its next available window.", Code.Unavailable, undefined, [{
            desc: contract.ErrorInfoSchema,
            value: create(contract.ErrorInfoSchema, { code: error.code, phase: "provider_group", retryable: true,
              severity: contract.ErrorSeverity.WAITING, queueImpact: contract.StateImpact.UNCHANGED,
              workspaceImpact: contract.StateImpact.UNCHANGED, nativeSessionImpact: contract.StateImpact.UNCHANGED,
              recoveryActions: [{ kind: contract.RecoveryActionKind.WAIT, retryAfter: { seconds: BigInt(Math.floor(delay / 1000)), nanos: delay % 1000 * 1_000_000 } }] })
          }]);
        }
      }
      throw new ConnectError("Provider group request could not be completed.", context.signal.aborted ? Code.Canceled : error instanceof RevisionConflictError ? Code.Aborted
        : error instanceof ProviderGroupUnavailableError ? Code.Unavailable : Code.FailedPrecondition);
    }
  };
  const key = (value: contract.ProviderGroupKey | undefined, principal: ProviderGroupPrincipal) => { const result = fromGroupKey(value); if (!principal.management) options.assertRemoteAllowed(result); return result; };
  return {
    listProviderGroups: (_request, context) => invoke(context, true, async () => create(contract.ListProviderGroupsResponseSchema, { groups: service.list().map(toGroupSnapshot) })),
    getProviderGroup: (request, context) => invoke(context, false, async principal => {
      const group = service.snapshot(key(request.key, principal));
      const members = request.agentKind && request.modelId && group.config ? await service.router.directory.members(group.config.members, { agentKind: request.agentKind, modelId: request.modelId,
        ...(request.logicalModelId === undefined ? {} : { logicalModelId: request.logicalModelId }), ownTask: false, fresh: true }, context.signal) : [];
      return create(contract.GetProviderGroupResponseSchema, { group: toGroupSnapshot(group), members: members.map(member => ({ memberKey: member.member.key, available: member.available,
        reachable: member.reachable, modelId: member.model?.modelId ?? "", quota: member.quota, running: member.running, reason: member.reason ?? "" })) });
    }),
    listProviderGroupCandidates: (request, context) => invoke(context, true, async principal => {
      const candidates = await service.candidates(key(request.key, principal), context.signal);
      return create(contract.ListProviderGroupCandidatesResponseSchema, { candidates: candidates.map(candidate => ({ member: toGroupMember({ key: candidate.key, kind: candidate.kind,
        backendId: candidate.backendId, nativeBackendId: candidate.nativeBackendId, providerId: candidate.providerId, nodeId: candidate.nodeId, displayName: candidate.displayName,
        capacity: 4, weight: 1, paused: false, ...(candidate.received === undefined ? {} : { received: candidate.received }) }), providerName: candidate.providerName,
        agentKind: candidate.agentKind, available: candidate.available, remotelyEnabled: candidate.remotelyEnabled, models: candidate.models.map(model => toProtoModelDescriptor(candidate.backendId, model)) })) });
    }),
    updateProviderGroup: (request, context) => invoke(context, true, async principal => {
      if (request.update.case !== "config" && request.update.case !== "delete") throw new ConnectError("A Provider group update is required.", Code.InvalidArgument);
      const value = await service.update(key(request.key, principal), request.update.case === "delete" ? undefined : fromGroupConfig(request.update.value), request.expectedRevision, context.signal);
      return create(contract.UpdateProviderGroupResponseSchema, { group: toGroupSnapshot(value) });
    }),
    getProviderGroupUsage: (request, context) => invoke(context, false, async principal => create(contract.GetProviderGroupUsageResponseSchema, { rows: options.usage.usage.rows({ group: key(request.key, principal),
      ...(request.fromDay === undefined ? {} : { fromDay: request.fromDay }), ...(request.throughDay === undefined ? {} : { throughDay: request.throughDay }),
      ...(request.partyId === undefined ? {} : { partyId: request.partyId }), ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }), ...(request.modelId === undefined ? {} : { modelId: request.modelId }) }).map(toGroupUsage) })),
    getTaskProviderGroupUsage: (request, context) => invoke(context, true, async () => {
      identity(request.sessionId);
      if (!options.taskAccountUsage) throw new ConnectError("Task Provider group usage is unavailable.", Code.Unavailable);
      const value = await options.taskAccountUsage(request.sessionId, request.generation, context.signal);
      if (!value) return create(contract.GetTaskProviderGroupUsageResponseSchema);
      const { nodeId: _nodeId, ...member } = value.member;
      const snapshot = member.quotaReadable ? value.snapshot : undefined;
      return create(contract.GetTaskProviderGroupUsageResponseSchema, { member,
        ...(snapshot ? { accountUsage: toGroupAccountUsage(snapshot), quota: providerGroupQuota(snapshot, member.providerId, member.modelId, options.now?.() ?? Date.now()) } : {}) });
    }),
    getTaskProviderGroupRebalance: (request, context) => invoke(context, true, async () => {
      identity(request.sessionId);
      const suggestion = await service.rebalanceSuggestion(request.sessionId, request.generation, context.signal);
      return create(contract.GetTaskProviderGroupRebalanceResponseSchema, suggestion ? { suggestion } : {});
    }),
    pickProviderGroupMember: (request, context) => invoke(context, false, async principal => {
      const group = key(request.key, principal); identity(request.sessionId); identity(request.agentKind); identity(request.modelId);
      if (request.excludeMemberKeys.length > 512) throw new ConnectError("Too many excluded group members.", Code.InvalidArgument);
      if (request.fastMode && request.ultrafastMode) throw new ConnectError("Conflicting group speed modes.", Code.InvalidArgument);
      const assignment = await service.router.pick({ sessionId: remoteSession(principal, request.sessionId), group, profile: { ...group, modelId: request.modelId,
        ...(request.effortId === undefined ? {} : { effort: request.effortId }), fastMode: request.ultrafastMode ? "ultrafast" : request.fastMode }, agentKind: request.agentKind,
        ...(request.quotaRebalanceFromMemberKey === undefined ? {} : { quotaRebalanceFrom: request.quotaRebalanceFromMemberKey }),
        modelId: request.modelId, ...(request.logicalModelId === undefined ? {} : { logicalModelId: request.logicalModelId }), ownTask: false, fresh: request.excludeMemberKeys.length > 0,
        exclude: new Set(request.excludeMemberKeys) }, context.signal);
      assignment.assertCurrent(); principal.assertCurrent(); service.router.rememberRemoteSelection(principal.id, request.sessionId, assignment);
      // Keep the 30-second provisional pick until a real full lease report
      // replaces it. It is a soft counter, not a native process reservation.
      return create(contract.PickProviderGroupMemberResponseSchema, { group: toGroupSnapshot(assignment.snapshot), member: toGroupMember(assignment.member), modelId: assignment.profile.modelId,
        quota: assignment.status.quota, running: assignment.status.running });
    }),
    coolProviderGroupMember: (request, context) => invoke(context, false, async principal => {
      const group = key(request.key, principal), member = service.snapshot(group).config?.members.find(member => member.key === request.memberKey);
      if (!member || !["usage-limit", "auth", "overload"].includes(request.cause)) throw new ConnectError("Invalid Provider group cooling target.", Code.InvalidArgument);
      const now = options.now?.() ?? Date.now();
      service.router.cool(group, member, request.modelId, { modelScoped: request.modelScoped && request.cause === "usage-limit",
        ...(request.resetAt === undefined ? {} : { usageResetAt: Math.min(request.resetAt, now + 8 * 24 * 60 * 60_000) }) },
      { action: "switch", cause: request.cause as "usage-limit" | "auth" | "overload", connection: null, cool: true });
      return create(contract.CoolProviderGroupMemberResponseSchema);
    }),
    reportProviderGroupLeases: (request, context) => invoke(context, false, async principal => {
      const members = new Map(service.list().flatMap(group => group.config?.members.map(member => [member.key, { group, member }] as const) ?? []));
      const leases = request.leases.map(lease => { const current = members.get(lease.memberKey); if (!current) throw new ConnectError("Unknown Provider group lease member.", Code.InvalidArgument);
        options.assertRemoteAllowed(current.group); identity(lease.sessionId); return { sessionId: remoteSession(principal, lease.sessionId), memberKey: current.member.key, backendId: current.member.backendId, providerId: current.member.providerId }; });
      const accepted = service.router.leases.report(principal.id, request.sequence, leases);
      return create(contract.ReportProviderGroupLeasesResponseSchema, { accepted });
    }),
    reportProviderGroupUsage: (request, context) => invoke(context, false, async principal => {
      if (!Number.isSafeInteger(request.partCount) || request.partCount < 1 || request.partCount > 1000 || request.partIndex >= request.partCount || request.rows.length > 1000) throw new ConnectError("Invalid usage report part.", Code.InvalidArgument);
      const now = options.now?.() ?? Date.now(); for (const [id, report] of pending) if (now - report.at > 10 * 60_000) pending.delete(id);
      const rows = request.rows.map(fromGroupUsage), previous = pending.get(principal.id);
      if (previous && previous.sequence > request.sequence) return create(contract.ReportProviderGroupUsageResponseSchema, { accepted: false, complete: false });
      let report = previous;
      if (!report || report.sequence < request.sequence) {
        if (pending.size >= 512 && !pending.has(principal.id)) throw new ConnectError("Too many pending usage reports.", Code.ResourceExhausted);
        report = { sequence: request.sequence, sinceDay: request.sinceDay, count: request.partCount, at: now, parts: new Map() }; pending.set(principal.id, report);
      }
      if (report.count !== request.partCount || report.sinceDay !== request.sinceDay) throw new ConnectError("Conflicting usage report.", Code.Aborted);
      const existing = report.parts.get(request.partIndex); if (existing && JSON.stringify(existing) !== JSON.stringify(rows)) throw new ConnectError("Conflicting usage report part.", Code.Aborted);
      report.parts.set(request.partIndex, rows);
      if ([...report.parts.values()].reduce((sum, part) => sum + part.length, 0) > 100_000) { pending.delete(principal.id); throw new ConnectError("The usage report exceeds ledger capacity.", Code.ResourceExhausted); }
      if (report.parts.size !== report.count) return create(contract.ReportProviderGroupUsageResponseSchema, { accepted: true, complete: false });
      const complete = Array.from({ length: report.count }, (_, index) => report!.parts.get(index)!).flat().filter(row => {
        const group = service.snapshot(row.group), member = group.config?.members.find(member => member.key === row.memberKey);
        // This service already records native local relay use. A direct Source
        // native call bypasses that facade and is reported by its Source once.
        return member?.kind !== "share";
      }).map(row => {
        const group = service.snapshot(row.group), member = group.config?.members.find(member => member.key === row.memberKey)
          ?? group.cleanup.flatMap(intent => intent.removedMembers).find(member => member.key === row.memberKey);
        return { ...row, partyId: "owner", partyName: "Owner", ...(member ? { backendId: member.backendId, providerId: member.providerId, nodeId: member.nodeId, nodeName: member.displayName } : {}) };
      });
      const accepted = options.usage.receive(principal.id, { sequence: report.sequence, sinceDay: report.sinceDay, rows: complete }, row => {
        options.assertRemoteAllowed(row.group); const group = service.snapshot(row.group);
        // Removed members retain historical totals. Existing attributed rows
        // remain admissible only for the same group owner and authenticated source.
        if (group.revision === 0n || !row.memberKey || groupKey(row.group) === "") throw new Error("Unknown group usage owner.");
      }); pending.delete(principal.id);
      return create(contract.ReportProviderGroupUsageResponseSchema, { accepted, complete: true });
    }),
    getProviderGroupMemberAccountUsage: (request, context) => invoke(context, true, async principal => {
      identity(request.memberKey);
      if (!options.memberAccountUsage) throw new ConnectError("Member account usage is unavailable.", Code.Unimplemented);
      const value = await options.memberAccountUsage(key(request.key, principal), request.expectedRevision, request.memberKey, context.signal);
      return create(contract.GetProviderGroupMemberAccountUsageResponseSchema, { revision: request.expectedRevision, memberKey: request.memberKey,
        state: value.state, ...(value.accountUsage ? { accountUsage: toGroupAccountUsage(value.accountUsage) } : {}) });
    }),
    getProviderSchedulingState: (request, context) => invoke(context, false, async principal => {
      const state = await options.schedulingState(key(request.key, principal), request.modelId, context.signal);
      if (!Number.isSafeInteger(state.activeTurns) || state.activeTurns < 0) throw new Error("Invalid active turn count.");
      return create(contract.GetProviderSchedulingStateResponseSchema, { activeTurns: state.activeTurns, accountUsage: state.accountUsage === undefined ? undefined : toGroupAccountUsage(state.accountUsage) });
    })
  };
}
function remoteSession(principal: ProviderGroupPrincipal, sessionId: string): string { return JSON.stringify([principal.id, sessionId]); }
function identity(value: string): void { if (!value || value.length > 512 || /[\0\r\n]/u.test(value)) throw new ConnectError("Invalid Provider group identity.", Code.InvalidArgument); }
