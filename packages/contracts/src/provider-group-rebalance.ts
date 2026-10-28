import type { ProviderGroupRebalanceSuggestion } from "./gen/joko/v1/provider_group_pb.js";
export interface ProviderGroupRebalanceView {
  readonly suggestionKey: string; readonly fromLabel: string; readonly toLabel: string; readonly automatic: boolean; readonly generation: bigint;
}
export function providerGroupRebalanceMessages(locale: string, from = "", to = "") {
  return locale === "zh-CN" ? {
    title: "先使用即将重置的额度", body: `发送前把对话从「${from}」交接到「${to}」吗？新账号在重置前有更值得先用的额度。交接会携带摘要和最近几轮对话。`,
    remember: "以后这个任务有明显换号收益时自动切换", switchAndSend: "切换并发送", keep: "保留当前账号", cancel: "取消"
  } : {
    title: "Use quota before it resets", body: `Move this conversation from “${from}” to “${to}” before sending? The other account has quota worth using before its reset. A summary and recent turns will be handed off.`,
    remember: "Automatically switch this task when quota balancing is worthwhile", switchAndSend: "Switch and send", keep: "Keep this account", cancel: "Cancel"
  };
}
/** A UI projection carries no account credentials, native history or alternate authority. */
export function projectProviderGroupRebalance(value: ProviderGroupRebalanceSuggestion | undefined, generation: bigint): ProviderGroupRebalanceView | undefined {
  if (!value) return undefined;
  const label = (value: string) => value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!/^rebalance_[a-f0-9]{64}$/u.test(value.suggestionKey) || value.generation !== generation || generation < 1n
    || !label(value.fromLabel) || !label(value.toLabel) || !value.fromMemberKey || !value.toMemberKey || value.fromMemberKey === value.toMemberKey
    || !value.group?.backendId || !value.group.providerId || !value.currentQuota?.pacingWindow || !value.targetQuota?.pacingWindow
    || value.currentQuota.limited || value.targetQuota.limited || value.targetQuota.fiveHourTight) throw new Error("The original quota balancing proposal is invalid.");
  for (const quota of [value.currentQuota, value.targetQuota]) {
    const pace = quota.pacingWindow!;
    if (!Number.isFinite(pace.usedPercent) || pace.usedPercent < 0 || pace.usedPercent > 100 || !Number.isFinite(pace.windowMs) || pace.windowMs <= 0
      || pace.resetAt !== undefined && (!Number.isFinite(pace.resetAt) || pace.resetAt < 0)
      || quota.urgency === undefined || !Number.isFinite(quota.urgency) || quota.urgency < 0) throw new Error("The quota balancing pace is unavailable.");
  }
  return { suggestionKey: value.suggestionKey, fromLabel: value.fromLabel, toLabel: value.toLabel, automatic: value.automatic, generation };
}
