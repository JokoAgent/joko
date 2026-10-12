import { PartnerSessionTaskStatus, PartnerSessionTaskControl, PartnerSessionTaskAction, type PartnerSessionTask } from "./gen/joko/v1/partner_pb.js";
export interface PartnerSessionTaskView {
  readonly id: string; readonly partnerId: string; readonly sessionId?: string; readonly title: string;
  readonly status: "preparing" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "timed-out" | "unknown";
  readonly control: "active" | "pausing" | "paused" | "cancelling"; readonly revision: bigint; readonly deadlineAt: number;
  readonly result: string; readonly error: string;
}
const statuses = new Map<number, PartnerSessionTaskView["status"]>([[PartnerSessionTaskStatus.PREPARING, "preparing"], [PartnerSessionTaskStatus.QUEUED, "queued"],
  [PartnerSessionTaskStatus.RUNNING, "running"], [PartnerSessionTaskStatus.WAITING, "waiting"], [PartnerSessionTaskStatus.COMPLETED, "completed"],
  [PartnerSessionTaskStatus.FAILED, "failed"], [PartnerSessionTaskStatus.CANCELLED, "cancelled"], [PartnerSessionTaskStatus.TIMED_OUT, "timed-out"], [PartnerSessionTaskStatus.UNKNOWN, "unknown"]]);
const controls = new Map<number, PartnerSessionTaskView["control"]>([[PartnerSessionTaskControl.ACTIVE, "active"], [PartnerSessionTaskControl.PAUSING, "pausing"], [PartnerSessionTaskControl.PAUSED, "paused"], [PartnerSessionTaskControl.CANCELLING, "cancelling"]]);
export function projectPartnerSessionTask(value: PartnerSessionTask, partnerId: string): PartnerSessionTaskView {
  const status = statuses.get(value.status), control = controls.get(value.control), revision = value.revision?.value;
  const deadlineAt = value.deadlineAt === undefined ? NaN : Number(value.deadlineAt.seconds) * 1_000 + value.deadlineAt.nanos / 1_000_000;
  if (value.partnerId !== partnerId || !value.id || !value.title || !status || !control || revision === undefined || revision < 1n || !Number.isSafeInteger(deadlineAt) || deadlineAt < 1
    || value.title.length > 120 || value.result.length > 12_000 || value.error.length > 4_000) throw new Error("The independent task response is inconsistent.");
  return { id: value.id, partnerId, ...(value.sessionId ? { sessionId: value.sessionId } : {}), title: value.title, status, control, revision, deadlineAt, result: value.result, error: value.error };
}
export function partnerSessionTaskAction(action: "pause" | "resume" | "cancel") {
  return { pause: PartnerSessionTaskAction.PAUSE, resume: PartnerSessionTaskAction.RESUME, cancel: PartnerSessionTaskAction.CANCEL }[action];
}
export function partnerSessionTaskActive(task: PartnerSessionTaskView) { return ["preparing", "queued", "running", "waiting"].includes(task.status); }
const en = { title: "Independent tasks", open: "Open task", pause: "Pause", resume: "Resume", cancel: "Stop task", refresh: "Refresh tasks", empty: "No independent tasks yet.", failed: "Task control could not be confirmed. Refresh before another action.",
  states: { preparing: "Preparing", queued: "Queued", running: "Working", waiting: "Waiting", completed: "Completed", failed: "Failed", cancelled: "Stopped", "timed-out": "Time budget reached", unknown: "Unconfirmed", active: "Active", pausing: "Pausing", paused: "Paused", cancelling: "Stopping" } };
type Messages = typeof en;
const messages: Record<string, Messages> = { en,
  "zh-CN": { title: "独立任务", open: "打开任务", pause: "暂停", resume: "继续", cancel: "停止任务", refresh: "刷新任务", empty: "还没有独立任务。", failed: "任务控制结果尚未确认，请刷新后再操作。", states: { preparing: "准备中", queued: "排队中", running: "工作中", waiting: "等待中", completed: "已完成", failed: "失败", cancelled: "已停止", "timed-out": "已达时间预算", unknown: "未确认", active: "活动", pausing: "暂停中", paused: "已暂停", cancelling: "停止中" } },
  "zh-TW": { title: "獨立任務", open: "開啟任務", pause: "暫停", resume: "繼續", cancel: "停止任務", refresh: "重新整理任務", empty: "尚無獨立任務。", failed: "任務控制結果尚未確認，請重新整理後再操作。", states: { preparing: "準備中", queued: "排隊中", running: "工作中", waiting: "等待中", completed: "已完成", failed: "失敗", cancelled: "已停止", "timed-out": "已達時間預算", unknown: "未確認", active: "活動", pausing: "暫停中", paused: "已暫停", cancelling: "停止中" } },
  ja: { title: "独立タスク", open: "タスクを開く", pause: "一時停止", resume: "再開", cancel: "タスクを停止", refresh: "タスクを更新", empty: "独立タスクはまだありません。", failed: "操作結果を確認できません。更新してから操作してください。", states: { preparing: "準備中", queued: "待機中", running: "作業中", waiting: "応答待ち", completed: "完了", failed: "失敗", cancelled: "停止済み", "timed-out": "制限時間に到達", unknown: "未確認", active: "実行中", pausing: "一時停止中", paused: "一時停止済み", cancelling: "停止中" } },
  ko: { title: "독립 작업", open: "작업 열기", pause: "일시 중지", resume: "계속", cancel: "작업 중지", refresh: "작업 새로 고침", empty: "아직 독립 작업이 없습니다.", failed: "작업 제어 결과를 확인할 수 없습니다. 새로 고친 후 다시 진행하세요.", states: { preparing: "준비 중", queued: "대기 중", running: "작업 중", waiting: "응답 대기", completed: "완료", failed: "실패", cancelled: "중지됨", "timed-out": "시간 한도 도달", unknown: "미확인", active: "활성", pausing: "일시 중지 중", paused: "일시 중지됨", cancelling: "중지 중" } }
};
export function partnerSessionTaskMessages(locale: string): Messages { return messages[locale] ?? en; }
