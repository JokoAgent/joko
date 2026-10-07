import type { SubagentTranscriptEntry } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

const rows = [
  ["expand", "Expand {name}", "展开{name}", "展開{name}", "{name}を展開", "{name} 펼치기"],
  ["collapse", "Collapse {name}", "收起{name}", "收合{name}", "{name}を折りたたむ", "{name} 접기"],
  ["queued", "Queued", "排队中", "排隊中", "待機中", "대기 중"],
  ["running", "Running", "运行中", "執行中", "実行中", "실행 중"],
  ["waiting", "Waiting", "等待中", "等待中", "応答待ち", "응답 대기 중"],
  ["completed", "Completed", "已完成", "已完成", "完了", "완료"],
  ["failed", "Failed", "失败", "失敗", "失敗", "실패"],
  ["stopped", "Stopped", "已停止", "已停止", "停止済み", "중지됨"],
  ["unknown", "Unknown", "未知", "未知", "不明", "알 수 없음"],
  ["background", "Background task", "后台任务", "背景工作", "バックグラウンドタスク", "백그라운드 작업"],
  ["delegated", "Delegated task", "委派任务", "委派工作", "委任タスク", "위임 작업"],
  ["assignment", "Assignment", "任务要求", "工作要求", "依頼内容", "할당 내용"],
  ["result", "Result", "结果", "結果", "結果", "결과"],
  ["activity", "Activity", "活动", "活動", "アクティビティ", "활동"],
  ["content", "Conversation", "对话内容", "對話內容", "会話", "대화"],
  ["parent", "Parent task", "父任务", "父工作", "親タスク", "상위 작업"],
  ["subagent", "Agent", "子代理", "子代理", "エージェント", "에이전트"],
  ["system", "Notice", "通知", "通知", "通知", "알림"],
  ["allChildren", "All agents", "全部子代理", "全部子代理", "すべてのエージェント", "모든 에이전트"],
  ["children", "Agents ({count})", "子代理（{count}）", "子代理（{count}）", "エージェント ({count})", "에이전트 ({count})"],
  ["tokens", "{count} tokens", "{count} tokens", "{count} tokens", "{count}トークン", "토큰 {count}개"],
  ["tools", "{count} tool uses", "使用工具{count}次", "使用工具{count}次", "ツール使用{count}回", "도구 사용 {count}회"],
  ["readOnly", "Read only", "只读", "唯讀", "読み取り専用", "읽기 전용"],
  ["writeAccess", "Write access", "可写", "可寫入", "書き込み可能", "쓰기 가능"],
  ["awaitingApproval", "Awaiting approval", "等待批准", "等待核准", "承認待ち", "승인 대기 중"],
  ["loading", "Loading task content…", "正在读取任务内容…", "正在讀取工作內容…", "タスク内容を読み込み中…", "작업 내용 불러오는 중…"],
  ["empty", "No recorded content yet.", "暂无记录内容。", "尚無記錄內容。", "記録された内容はまだありません。", "아직 기록된 내용이 없습니다."],
  ["readFailed", "Task content could not be loaded.", "无法读取任务内容。", "無法讀取工作內容。", "タスク内容を読み込めませんでした。", "작업 내용을 불러오지 못했습니다."],
  ["unavailable", "This task does not provide readable content.", "此任务不提供可读取的内容。", "此工作未提供可讀取的內容。", "このタスクの内容は閲覧できません。", "이 작업에는 읽을 수 있는 내용이 없습니다."],
  ["staleGeneration", "This agent generation is no longer available.", "此代理代次已不可用。", "此代理世代已無法使用。", "このエージェントの世代は利用できません。", "이 에이전트 세대를 더 이상 사용할 수 없습니다."],
  ["retry", "Retry", "重试", "重試", "再試行", "다시 시도"],
  ["cancel", "Cancel loading", "取消读取", "取消讀取", "読み込みをキャンセル", "불러오기 취소"],
  ["cancelled", "Loading cancelled.", "已取消读取。", "已取消讀取。", "読み込みをキャンセルしました。", "불러오기가 취소되었습니다."],
  ["loadMore", "Load more", "加载更多", "載入更多", "さらに読み込む", "더 불러오기"],
  ["truncated", "The recorded result is incomplete.", "记录的结果不完整。", "記錄的結果不完整。", "記録された結果は不完全です。", "기록된 결과가 완전하지 않습니다."],
  ["stop-requested", "A stop was requested.", "已请求停止。", "已要求停止。", "停止が要求されました。", "중지가 요청되었습니다."],
  ["control-requested", "A task action was requested.", "已请求任务操作。", "已要求工作操作。", "タスク操作が要求されました。", "작업 동작이 요청되었습니다."],
  ["transcript-truncated", "Some conversation history is unavailable.", "部分对话记录不可用。", "部分對話記錄無法使用。", "会話履歴の一部を利用できません。", "일부 대화 기록을 사용할 수 없습니다."],
  ["turn-ended", "The agent turn ended.", "代理回合已结束。", "代理回合已結束。", "エージェントのターンが終了しました。", "에이전트 턴이 종료되었습니다."],
  ["command-refused", "The requested command was refused.", "请求的命令被拒绝。", "要求的命令遭拒絕。", "要求されたコマンドは拒否されました。", "요청한 명령이 거부되었습니다."],
  ["generation-unreadable", "This agent generation cannot be read.", "无法读取此代理代次。", "無法讀取此代理世代。", "このエージェントの世代は閲覧できません。", "이 에이전트 세대를 읽을 수 없습니다."],
  ["permissionDenied", "Access to this task was denied.", "此任务的访问被拒绝。", "此工作的存取遭拒絕。", "このタスクへのアクセスが拒否されました。", "이 작업에 대한 접근이 거부되었습니다."],
  ["providerUnavailable", "The task provider is unavailable.", "任务提供方不可用。", "工作提供方無法使用。", "タスクのプロバイダーを利用できません。", "작업 공급자를 사용할 수 없습니다."],
  ["rateLimited", "The task reached a service limit.", "任务达到服务限额。", "工作已達服務限額。", "タスクがサービスの上限に達しました。", "작업이 서비스 제한에 도달했습니다."],
  ["timedOut", "The task request timed out.", "任务请求超时。", "工作要求逾時。", "タスクのリクエストがタイムアウトしました。", "작업 요청 시간이 초과되었습니다."]
] as const;

export type MobileDelegatedMessageKey = typeof rows[number][0];
const columns: Readonly<Record<MobileSupportedLocale, number>> = { en: 1, "zh-CN": 2, "zh-TW": 3, ja: 4, ko: 5 };
export function mobileDelegatedTaskMessage(locale: MobileSupportedLocale, key: MobileDelegatedMessageKey,
  values: Readonly<Record<string, string | number>> = {}): string {
  const row = rows.find((candidate) => candidate[0] === key)!;
  return row[columns[locale]]!.replace(/\{([a-z][A-Za-z0-9]*)\}/gu, (token, name: string) => values[name] === undefined ? token : String(values[name]));
}

const systemKeys = new Set<MobileDelegatedMessageKey>(["stop-requested", "control-requested", "transcript-truncated", "turn-ended", "command-refused", "generation-unreadable"]);
export function mobileDelegatedSystemText(entry: SubagentTranscriptEntry, locale: MobileSupportedLocale): string {
  const kind = entry.systemEvent?.kind;
  const key = rows.find((row) => row[0] === kind)?.[0];
  return key && systemKeys.has(key) ? mobileDelegatedTaskMessage(locale, key,
    Object.fromEntries((entry.systemEvent?.params ?? []).map((value) => [value.key, value.value]))) : entry.content;
}
export function mobileDelegatedErrorText(message: string, locale: MobileSupportedLocale): string {
  if (/permission denied|forbidden|\b403\b|not allowed/iu.test(message)) return mobileDelegatedTaskMessage(locale, "permissionDenied");
  if (/\b429\b|rate.?limit|too many requests/iu.test(message)) return mobileDelegatedTaskMessage(locale, "rateLimited");
  if (/timed? ?out|deadline exceeded|timeout/iu.test(message)) return mobileDelegatedTaskMessage(locale, "timedOut");
  if (/provider.{0,60}(?:not connected|not configured|unavailable)|credential|authentication|\b(?:401|500|502|503|504)\b/iu.test(message)) return mobileDelegatedTaskMessage(locale, "providerUnavailable");
  return message;
}
