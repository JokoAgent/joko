import type { MessageInitShape } from "@bufbuild/protobuf";
import type { GetPartnerGlanceResponse, GetPartnerAutonomySettingsResponse, PartnerAutonomySettings,
  UpdatePartnerAutonomySettingsResponse, UpdatePartnerAutonomySettingsRequestSchema } from "./gen/joko/v1/partner_autonomy_pb.js";

export type PartnerAutonomySettingChoice = NonNullable<MessageInitShape<typeof UpdatePartnerAutonomySettingsRequestSchema>["choice"]>;
export interface PartnerAutonomyApi {
  readonly ownerKey: string;
  newOperationId(): string;
  settings(signal: AbortSignal): Promise<PartnerAutonomySettings>;
  save(operationId: string, revision: bigint, choice: PartnerAutonomySettingChoice, signal: AbortSignal): Promise<PartnerAutonomySettings>;
  glance(partnerId: string, signal: AbortSignal, page?: { readonly token: string; readonly offset: number }): Promise<GetPartnerGlanceResponse>;
}
interface AutonomyRpc {
  getPartnerAutonomySettings(request: object, options: { signal: AbortSignal }): Promise<GetPartnerAutonomySettingsResponse>;
  updatePartnerAutonomySettings(request: MessageInitShape<typeof UpdatePartnerAutonomySettingsRequestSchema>, options: { signal: AbortSignal }): Promise<UpdatePartnerAutonomySettingsResponse>;
  getPartnerGlance(request: { partnerId: string; snapshotToken: string; offset: number }, options: { signal: AbortSignal }): Promise<GetPartnerGlanceResponse>;
}
/** Web and Mobile share generated payloads and the same connection retirement fence. */
export function createPartnerAutonomyApi(input: { readonly rpc: AutonomyRpc; readonly ownerKey: string;
  readonly newOperationId: () => string; readonly assertCurrent: (signal: AbortSignal) => void }): PartnerAutonomyApi {
  const check = (signal: AbortSignal) => { signal.throwIfAborted(); input.assertCurrent(signal); };
  const invoke = async <T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> => { check(signal); const value = await action(); check(signal); return value; };
  const settings = (value: PartnerAutonomySettings | undefined): PartnerAutonomySettings => {
    if (!value?.revision || value.revision.value < 1n || value.schedulerPartnerId !== undefined && !value.schedulerPartnerId
      || new Set(value.schedulerFallbackPartnerIds).size !== value.schedulerFallbackPartnerIds.length) throw new Error("Follow-up settings are invalid.");
    return value;
  };
  return { ownerKey: input.ownerKey, newOperationId: input.newOperationId,
    settings: signal => invoke(signal, async () => settings((await input.rpc.getPartnerAutonomySettings({}, { signal })).settings)),
    save: (operationId, revision, choice, signal) => invoke(signal, async () => settings((await input.rpc.updatePartnerAutonomySettings({ operationId,
      expectedRevision: { value: revision }, choice }, { signal })).settings)),
    glance: (partnerId, signal, page) => invoke(signal, async () => {
      const value = await input.rpc.getPartnerGlance({ partnerId, snapshotToken: page?.token ?? "", offset: page?.offset ?? 0 }, { signal });
      if (value.partnerId !== partnerId || !value.partnerRevision || !value.snapshotToken || value.rows.length > 50
        || page && value.snapshotToken !== page.token || value.nextOffset !== undefined && value.nextOffset !== (page?.offset ?? 0) + 50
        || value.rows.some(row => !row.sessionId || !row.targetId || row.generation < 1n || row.phase === 0 || !row.phaseSince)) {
        throw new Error("The task observation page is invalid.");
      }
      return value;
    }) };
}

const english = {
  glance: "At a glance", invite: "Let this Partner follow up on your tasks?", start: "Start following up", notNow: "Not now", cancel: "Cancel", close: "Close",
  consent: "{name} will read the status, titles and pending questions of tasks on this Joko node and use your configured model allowance to summarize what needs your attention. Authorized remote tasks are displayed for you to open on their original computer. Observation does not allow answering questions, approving requests, sending task messages or changing task state. Other Partners keep responsibility for their own tasks unless you explicitly allow fallback.",
  follow: "Automatic follow-up", enabled: "This Partner follows tasks on this node.", disabled: "Following all tasks is off for this Partner.", stop: "Stop following all tasks",
  fallback: "Allow the scheduler Partner to observe my tasks while I am paused", reset: "Restore defaults", refresh: "Refresh", retrySave: "Retry the original save",
  saveUnknown: "The save receipt was lost. Retry the same request to recover its result.", failed: "Task observation could not refresh. Retry.", loading: "Loading…", more: "Show more",
  all: "All tasks on this node", own: "Tasks this Partner created or took over", waiting: "Waiting for you", working: "Working", done: "{count} done today",
  empty: "None", permission: "Waiting for permission", limit: "Waiting for usage reset", task: "Open the original task", minutes: "min"
};
const chinese: typeof english = {
  glance: "近况", invite: "让这位伙伴帮你跟进任务？", start: "开始跟进", notNow: "暂时不用", cancel: "取消", close: "关闭",
  consent: "{name} 将读取此 Joko 节点任务的状态、标题和待答问题，并使用你配置的模型额度总结需要你关注的情况。已授权远端任务仅供你打开其原电脑查看。观察不授权回答问题、批准请求、向任务发消息或改变任务状态。其他伙伴仍负责自己的任务，除非你明确允许总调度代为观察。",
  follow: "自动跟进", enabled: "这位伙伴正在跟进本节点任务。", disabled: "这位伙伴未开启全部任务跟进。", stop: "停止跟进全部任务",
  fallback: "我暂停时，允许总调度伙伴观察我的任务", reset: "恢复默认", refresh: "刷新", retrySave: "重试原保存请求",
  saveUnknown: "保存回执丢失，请重试原请求取回结果。", failed: "近况刷新失败，请重试。", loading: "加载中…", more: "查看更多",
  all: "本节点全部任务", own: "这位伙伴创建或明确接手的任务", waiting: "等你", working: "在做", done: "今天完成 {count} 件",
  empty: "暂无", permission: "等待权限确认", limit: "等待用量恢复", task: "打开原任务", minutes: "分钟"
};
export function partnerAutonomyMessages(locale?: string): typeof english { return locale === "zh-CN" ? chinese : english; }
