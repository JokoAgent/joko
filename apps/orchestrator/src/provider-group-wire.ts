import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { ProviderAccountUsageSnapshot, ProviderAccountUsageWindow } from "@joko/core";
import { assertProviderGroupConfig, parseProviderGroupUsageRow, type ProviderGroupConfig, type ProviderGroupKey, type ProviderGroupMember,
  type ProviderGroupSnapshot, type ProviderGroupStrategy, type ProviderGroupUsageRow } from "@joko/store";
import { fromProtoTimestamp, toProtoTimestamp } from "./proto-mapper.js";

export function toGroupStrategy(value: ProviderGroupStrategy): contract.ProviderGroupStrategy {
  return { least_busy: contract.ProviderGroupStrategy.LEAST_BUSY, round_robin: contract.ProviderGroupStrategy.ROUND_ROBIN,
    ordered: contract.ProviderGroupStrategy.ORDERED, weighted: contract.ProviderGroupStrategy.WEIGHTED }[value];
}
export function fromGroupStrategy(value: contract.ProviderGroupStrategy): ProviderGroupStrategy {
  switch (value) {
    case contract.ProviderGroupStrategy.LEAST_BUSY: return "least_busy";
    case contract.ProviderGroupStrategy.ROUND_ROBIN: return "round_robin";
    case contract.ProviderGroupStrategy.ORDERED: return "ordered";
    case contract.ProviderGroupStrategy.WEIGHTED: return "weighted";
    default: throw new Error("Invalid Provider group strategy.");
  }
}
export function toGroupMember(value: ProviderGroupMember): contract.ProviderGroupMember {
  return create(contract.ProviderGroupMemberSchema, { ...value, kind: { local: contract.ProviderGroupMemberKind.LOCAL, device: contract.ProviderGroupMemberKind.DEVICE,
    share: contract.ProviderGroupMemberKind.SHARE }[value.kind], received: value.received === undefined ? undefined : { ...value.received, generation: BigInt(value.received.generation) } });
}
export function fromGroupMember(value: contract.ProviderGroupMember): ProviderGroupMember {
  const kind = value.kind === contract.ProviderGroupMemberKind.LOCAL ? "local" : value.kind === contract.ProviderGroupMemberKind.DEVICE ? "device" : value.kind === contract.ProviderGroupMemberKind.SHARE ? "share" : undefined;
  if (!kind) throw new Error("Invalid Provider group member kind.");
  const received = value.received;
  const member: ProviderGroupMember = { key: value.key, kind, backendId: value.backendId, nativeBackendId: value.nativeBackendId, providerId: value.providerId, nodeId: value.nodeId, displayName: value.displayName,
    capacity: value.capacity, weight: value.weight, paused: value.paused, ...(received ? { received: { joinId: received.joinId, shareId: received.shareId, memberId: received.memberId,
      generation: exactNumber(received.generation), hostServerId: received.hostServerId, nativeBackendId: received.nativeBackendId, providerId: received.providerId } } : {}) };
  assertProviderGroupConfig({ strategy: "ordered", autoSwitch: true, members: [member] }); return member;
}
export function toGroupSnapshot(value: ProviderGroupSnapshot): contract.ProviderGroupSnapshot {
  return create(contract.ProviderGroupSnapshotSchema, { key: { backendId: value.backendId, providerId: value.providerId }, revision: value.revision,
    config: value.config === undefined ? undefined : { strategy: toGroupStrategy(value.config.strategy), autoSwitch: value.config.autoSwitch, members: value.config.members.map(toGroupMember) } });
}
export function fromGroupConfig(value: contract.ProviderGroupConfig): ProviderGroupConfig {
  const config = { strategy: fromGroupStrategy(value.strategy), autoSwitch: value.autoSwitch, members: value.members.map(fromGroupMember) }; assertProviderGroupConfig(config); return config;
}
export function fromGroupKey(value: contract.ProviderGroupKey | undefined): ProviderGroupKey {
  if (!value || !identity(value.backendId) || !identity(value.providerId)) throw new Error("Invalid Provider group identity."); return { backendId: value.backendId, providerId: value.providerId };
}
export function toGroupUsage(value: ProviderGroupUsageRow): contract.ProviderGroupUsageRow {
  return create(contract.ProviderGroupUsageRowSchema, { ...value, turns: BigInt(value.turns), inputTokens: BigInt(value.inputTokens), outputTokens: BigInt(value.outputTokens),
    cacheReadTokens: BigInt(value.cacheReadTokens), cacheWriteTokens: BigInt(value.cacheWriteTokens), totalTokens: BigInt(value.totalTokens), costMicros: BigInt(value.costMicros) });
}
export function fromGroupUsage(value: contract.ProviderGroupUsageRow): ProviderGroupUsageRow {
  return parseProviderGroupUsageRow({ group: fromGroupKey(value.group), memberKey: value.memberKey, nodeId: value.nodeId, nodeName: value.nodeName, partyId: value.partyId, partyName: value.partyName,
    agentKind: value.agentKind, backendId: value.backendId, providerId: value.providerId, modelId: value.modelId, day: value.day, turns: exactNumber(value.turns), inputTokens: exactNumber(value.inputTokens),
    outputTokens: exactNumber(value.outputTokens), cacheReadTokens: exactNumber(value.cacheReadTokens), cacheWriteTokens: exactNumber(value.cacheWriteTokens), totalTokens: exactNumber(value.totalTokens),
    costMicros: exactNumber(value.costMicros), currencyCode: value.currencyCode, estimated: value.estimated, tokensComplete: value.tokensComplete, costComplete: value.costComplete, lastAt: value.lastAt });
}
export function toGroupAccountUsage(value: ProviderAccountUsageSnapshot): contract.ProviderAccountUsageSnapshot {
  const window = (value: ProviderAccountUsageWindow | undefined) => value === undefined ? undefined : { ...value, resetAt: value.resetAt === undefined ? undefined : toProtoTimestamp(value.resetAt) };
  const credits = (value: ProviderAccountUsageSnapshot["credits"]) => value === undefined ? undefined : { ...value, observedAt: toProtoTimestamp(value.observedAt) };
  return create(contract.ProviderAccountUsageSnapshotSchema, { ...value, primaryWindow: window(value.primaryWindow), secondaryWindow: window(value.secondaryWindow), observedAt: toProtoTimestamp(value.observedAt),
    credits: credits(value.credits), buckets: value.buckets?.map(bucket => ({ ...bucket, primaryWindow: window(bucket.primaryWindow), secondaryWindow: window(bucket.secondaryWindow), credits: credits(bucket.credits) })),
    modelWindows: value.modelWindows?.map(scoped => ({ ...scoped, window: window(scoped.window) })), resetCredits: value.resetCredits === undefined ? undefined : { ...value.resetCredits,
      earliestExpiryAt: value.resetCredits.earliestExpiryAt === undefined ? undefined : toProtoTimestamp(value.resetCredits.earliestExpiryAt) } });
}
export function fromGroupAccountUsage(value: contract.ProviderAccountUsageSnapshot | undefined): ProviderAccountUsageSnapshot | undefined {
  const observedAt = fromProtoTimestamp(value?.observedAt); if (!value || observedAt === undefined) return undefined;
  const window = (value: contract.ProviderAccountUsageWindow | undefined): ProviderAccountUsageWindow | undefined => value === undefined ? undefined : { usedPercent: value.usedPercent,
    ...(value.windowMinutes === undefined ? {} : { windowMinutes: value.windowMinutes }), ...(value.severity === undefined ? {} : { severity: value.severity }),
    ...(value.resetAt === undefined ? {} : { resetAt: fromProtoTimestamp(value.resetAt)! }) };
  return { providerId: value.providerId, observedAt, ...(value.primaryWindow ? { primaryWindow: window(value.primaryWindow)! } : {}), ...(value.secondaryWindow ? { secondaryWindow: window(value.secondaryWindow)! } : {}),
    ...(value.limitReached === undefined ? {} : { limitReached: value.limitReached }),
    modelWindows: value.modelWindows.flatMap(scoped => scoped.window ? [{ displayName: scoped.displayName, ...(scoped.modelId === undefined ? {} : { modelId: scoped.modelId }), window: window(scoped.window)! }] : []) };
}
export function exactNumber(value: bigint): number { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) throw new Error("Provider group number exceeds exact capacity."); return result; }
function identity(value: string): boolean { return value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value); }
