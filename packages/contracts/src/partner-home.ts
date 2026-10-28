import type { MessageInitShape } from "@bufbuild/protobuf";
import { MovePartnerHomeRequestSchema, type PartnerHomeDestination, type ListPartnerHomeTargetsResponse,
  type InspectPartnerHomeTargetResponse, type MovePartnerHomeResponse, type GetPartnerHomeMoveResponse,
  type RetryPartnerHomeMoveResponse } from "./gen/joko/v1/partner_home_pb.js";

export type PartnerHomeMoveInput = MessageInitShape<typeof MovePartnerHomeRequestSchema>;
export interface PartnerHomeRpc {
  listPartnerHomeTargets(input: { partnerId: string }, options: { signal: AbortSignal }): Promise<ListPartnerHomeTargetsResponse>;
  inspectPartnerHomeTarget(input: { partnerId: string; destination: PartnerHomeDestination }, options: { signal: AbortSignal }): Promise<InspectPartnerHomeTargetResponse>;
  movePartnerHome(input: PartnerHomeMoveInput, options: { signal: AbortSignal }): Promise<MovePartnerHomeResponse>;
  getPartnerHomeMove(input: { requestId: string }, options: { signal: AbortSignal }): Promise<GetPartnerHomeMoveResponse>;
  retryPartnerHomeMove(input: { requestId: string }, options: { signal: AbortSignal }): Promise<RetryPartnerHomeMoveResponse>;
}
export interface PartnerHomeApi {
  readonly ownerKey: string;
  list(partnerId: string, signal: AbortSignal): Promise<ListPartnerHomeTargetsResponse>;
  inspect(partnerId: string, destination: PartnerHomeDestination, signal: AbortSignal): Promise<InspectPartnerHomeTargetResponse>;
  move(input: PartnerHomeMoveInput, signal: AbortSignal): Promise<MovePartnerHomeResponse>;
  status(requestId: string, signal: AbortSignal): Promise<GetPartnerHomeMoveResponse>;
  retry(requestId: string, signal: AbortSignal): Promise<RetryPartnerHomeMoveResponse>;
}
export function partnerHomeDestinationKey(destination: PartnerHomeDestination | undefined): string | undefined {
  if (destination?.location.case === "serviceNode") return destination.location.value ? "service-node" : undefined;
  if (destination?.location.case === "peer") { const route = destination.location.value; return `peer:${route.targetDeviceId}:${route.routeGeneration}`; }
  return undefined;
}
export function createPartnerHomeApi(options: { readonly ownerKey: string; readonly rpc: PartnerHomeRpc; readonly assertCurrent: () => void }): PartnerHomeApi {
  const call = async <T>(signal: AbortSignal, action: () => Promise<T>) => { signal.throwIfAborted(); options.assertCurrent();
    const value = await action(); signal.throwIfAborted(); options.assertCurrent(); return value; };
  return { ownerKey: options.ownerKey,
    list: (partnerId, signal) => call(signal, () => options.rpc.listPartnerHomeTargets({ partnerId }, { signal })),
    inspect: (partnerId, destination, signal) => call(signal, () => options.rpc.inspectPartnerHomeTarget({ partnerId, destination }, { signal })),
    move: (input, signal) => call(signal, () => options.rpc.movePartnerHome(input, { signal })),
    status: (requestId, signal) => call(signal, () => options.rpc.getPartnerHomeMove({ requestId }, { signal })),
    retry: (requestId, signal) => call(signal, () => options.rpc.retryPartnerHomeMove({ requestId }, { signal })) };
}
export function partnerHomeMessages(locale: string) {
  const traditional = /^(?:zh-TW|zh-HK|zh-Hant)/iu.test(locale), chinese = /^zh/iu.test(locale);
  return traditional ? {
    title: "主力電腦", current: "目前主力電腦", choose: "選擇新主力電腦", model: "新電腦使用的模型", permissions: "權限", plan: "規劃模式",
    change: "切換主力電腦", wait: "等待目前工作完成", stop: "停止目前工作後切換", offline: "原電腦離線時仍繼續切換", retry: "重試原切換", refresh: "重新整理",
    body: "伙伴身份、資料、個人技能、記憶、例行工作和公開對話隨行。原電腦的工作目錄、模型登入、憑證、MCP 與權限設定保留原處。請明確選擇新電腦的可用模型與權限。",
    channel: "模型透過此服務的私人執行通道使用；供應商憑證保留在服務中，不會傳到電腦。", unavailable: "此電腦目前沒有可用的私人執行環境或模型。",
    error: "無法完成此步驟。請重新整理或重試原切換。", ready: "主力電腦已切換", attention: "切換需要處理；未知的原工作不會自動重送。", running: "正在切換主力電腦…", close: "關閉", ask: "每次詢問", edits: "允許編輯", auto: "自動", full: "完整存取",
  } : chinese ? {
    title: "主力电脑", current: "当前主力电脑", choose: "选择新主力电脑", model: "新电脑使用的模型", permissions: "权限", plan: "规划模式",
    change: "切换主力电脑", wait: "等待当前工作完成", stop: "停止当前工作后切换", offline: "原电脑离线时仍继续切换", retry: "重试原切换", refresh: "刷新",
    body: "伙伴身份、资料、个人技能、记忆、例行任务和公开对话随行。原电脑的工作目录、模型登录、凭据、MCP 与权限设置保留原处。请明确选择新电脑的可用模型与权限。",
    channel: "模型通过此服务的私有执行通道使用；供应商凭据保留在服务中，不会传到电脑。", unavailable: "此电脑当前没有可用的私有执行环境或模型。",
    error: "无法完成此步骤。请刷新或重试原切换。", ready: "主力电脑已切换", attention: "切换需要处理；未知的原工作不会自动重发。", running: "正在切换主力电脑…", close: "关闭", ask: "每次询问", edits: "允许编辑", auto: "自动", full: "完整访问",
  } : {
    title: "Main computer", current: "Current main computer", choose: "Choose a new main computer", model: "Model on the new computer", permissions: "Permissions", plan: "Plan mode",
    change: "Change main computer", wait: "Wait for current work", stop: "Stop current work, then change", offline: "Continue if the old computer is offline", retry: "Retry this change", refresh: "Refresh",
    body: "The Partner identity, profile, personal skills, memories, routines and visible conversation follow. Workspace files, model logins, credentials, MCP and permission settings stay on their computer. Select the new computer’s available model and permissions.",
    channel: "Models use this service’s private execution channel; Provider credentials stay at the service and are never sent to the computer.", unavailable: "This computer currently has no available private execution runtime or model.",
    error: "This step could not complete. Refresh or retry the original change.", ready: "Main computer changed", attention: "This change needs attention; unknown old work is never resent automatically.", running: "Changing main computer…", close: "Close", ask: "Ask", edits: "Accept edits", auto: "Auto", full: "Full access",
  };
}
