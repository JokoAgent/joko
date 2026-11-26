import type { GetPartnerGlanceResponse } from "./gen/joko/v1/partner_autonomy_pb.js";
import type { ListPartnerTaskOutputsResponse, PartnerTaskOutput } from "./gen/joko/v1/partner_pb.js";
import type { PartnerNightlyLearningApi } from "./partner-nightly-learning.js";

export const PARTNER_TODO_CHECK_CREATION_REQUEST_ID = "builtin-todo-check-v1";
export interface PartnerAutonomyApi {
  readonly ownerKey: string;
  glance(partnerId: string, signal: AbortSignal, page?: { readonly token: string; readonly offset: number }): Promise<GetPartnerGlanceResponse>;
  outputs(partnerId: string, signal: AbortSignal): Promise<readonly PartnerTaskOutput[]>;
  nightlyLearning?(partnerId: string): PartnerNightlyLearningApi;
}
interface AutonomyRpc {
  getPartnerGlance(request: { partnerId: string; snapshotToken: string; offset: number }, options: { signal: AbortSignal }): Promise<GetPartnerGlanceResponse>;
  listPartnerTaskOutputs(request: { partnerId: string }, options: { signal: AbortSignal }): Promise<ListPartnerTaskOutputsResponse>;
}
/** Web and Mobile share generated payloads and the same connection retirement fence. */
export function createPartnerAutonomyApi(input: { readonly rpc: AutonomyRpc; readonly ownerKey: string;
  readonly assertCurrent: (signal: AbortSignal) => void;
  readonly nightlyLearning?: (partnerId: string) => PartnerNightlyLearningApi }): PartnerAutonomyApi {
  const check = (signal: AbortSignal) => { signal.throwIfAborted(); input.assertCurrent(signal); };
  const invoke = async <T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> => { check(signal); const value = await action(); check(signal); return value; };
  return { ownerKey: input.ownerKey,
    ...(input.nightlyLearning === undefined ? {} : { nightlyLearning: input.nightlyLearning }),
    glance: (partnerId, signal, page) => invoke(signal, async () => {
      const value = await input.rpc.getPartnerGlance({ partnerId, snapshotToken: page?.token ?? "", offset: page?.offset ?? 0 }, { signal });
      if (value.partnerId !== partnerId || !value.partnerRevision || !value.snapshotToken || value.rows.length > 50
        || page && value.snapshotToken !== page.token || value.nextOffset !== undefined && value.nextOffset !== (page?.offset ?? 0) + 50
        || value.rows.some(row => !row.sessionId || !row.targetId || row.generation < 1n || !row.phaseSince)) {
        throw new Error("The task observation page is invalid.");
      }
      return value;
    }),
    outputs: (partnerId, signal) => invoke(signal, async () => {
      const value = await input.rpc.listPartnerTaskOutputs({ partnerId }, { signal });
      if (value.partnerId !== partnerId || value.outputs.some(item => !item.sessionId || !item.sourceId || !item.sourceRevision)) throw new Error("The output owner is invalid.");
      return value.outputs;
    }) };
}

const english = {
  glance: "At a glance", close: "Close", refresh: "Refresh", failed: "Recent activity could not refresh.", loading: "Loading…",
  recent: "Recent tasks", more: "Show more", less: "Show less", unread: "Unread", requests: "Pull requests", openFailed: "The pull request could not be opened.",
  computers: "Computer", outputs: "Outputs", here: "Home computer", online: "Online", offline: "Offline", offlineCount: "{count} offline computers", computersFailed: "Computers could not refresh. Retry."
};
const chinese: typeof english = {
  glance: "近况", close: "关闭", refresh: "刷新", failed: "近期活动刷新失败。", loading: "加载中…",
  recent: "近期任务", more: "查看更多", less: "收起", unread: "未读", requests: "合并请求", openFailed: "无法打开合并请求。",
  computers: "电脑", outputs: "输出内容", here: "主力电脑", online: "在线", offline: "离线", offlineCount: "{count} 台电脑离线", computersFailed: "无法读取电脑，请重试。"
};
export function partnerAutonomyMessages(locale?: string): typeof english { return locale === "zh-CN" ? chinese : english; }
/** RPC rejections that precede a transactional Partner mutation. */
export function partnerMutationWasRejected(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "number" && [3, 5, 6, 7, 9, 10, 11, 16].includes(code);
}
