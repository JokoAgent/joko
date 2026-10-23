import type { GetTaskProviderGroupUsageResponse } from "@joko/contracts";

export interface TaskProviderGroupUsageView {
  readonly group: { readonly backendId: string; readonly providerId: string };
  readonly memberRoute?: { readonly backendId: string; readonly providerId: string };
  readonly nodeName: string;
  readonly quotaReadable: boolean;
  readonly usedPercent?: number;
  readonly resetAt?: number;
}

export function projectTaskProviderGroupUsage(value: GetTaskProviderGroupUsageResponse): TaskProviderGroupUsageView | undefined {
  const member = value.member;
  if (!member) return undefined;
  if (!member.group?.backendId || !member.group.providerId || !member.memberKey || !member.nodeName || !member.backendId || !member.providerId) {
    throw new Error("The task Provider group member is incomplete.");
  }
  const percent = member.quotaReadable ? value.quota?.usagePercent : undefined;
  const resetAt = member.quotaReadable ? value.quota?.resetAt : undefined;
  return { group: { backendId: member.group.backendId, providerId: member.group.providerId }, nodeName: member.nodeName,
    memberRoute: { backendId: member.backendId, providerId: member.providerId },
    quotaReadable: member.quotaReadable,
    ...(percent !== undefined && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? { usedPercent: percent } : {}),
    ...(resetAt !== undefined && Number.isFinite(resetAt) && resetAt > 0 ? { resetAt } : {}) };
}
