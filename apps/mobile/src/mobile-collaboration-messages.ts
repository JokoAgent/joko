import type { MobileSupportedLocale } from "./mobile-locale-preference";
const en = {
  dispatchTitle: "Assign work to {name}", batchTitle: "Assign work to {count} workers", sendTitle: "Send work to worker", reportTitle: "Worker report",
  reportSource: "From worker {name}", expand: "Expand {name}", collapse: "Collapse {name}", openFailed: "Could not open the reporting task. Try again.",
  title: "Collaboration", enable: "Enable collaboration", create: "Create worker", configure: "Configure collaboration", confirmed: "Collaboration configured",
  remove: "Remove configuration", role: "Role", custom: "Custom role", developer: "Developer", designer: "Designer", reviewer: "Reviewer", tester: "Tester", merger: "Merger",
  target: "Project and backend", model: "Model", defaultModel: "Backend default", effort: "Reasoning effort", fast: "Fast mode", permission: "Permissions",
  initialTask: "Initial task (optional)", taskHint: "Leave empty to create a worker that waits for work.",
  loading: "Loading collaboration…", error: "Could not update collaboration.", refresh: "Check team status", unavailable: "No worker route is available.",
  workers: "Workers", capacity: "Workers: {count} · soft limit {soft} · hard limit {hard} · idle release {minutes} min",
  archive: "Archive worker", archiveBody: "Archive {name}? Its active work will stop. The conversation remains available.",
  end: "End collaboration", endBody: "End this team? All active workers will stop; their conversations remain available.",
  lead: "Return to lead", readOnly: "Worker conversations are read-only. Send work from the lead task.",
  full: "Allow full permissions?", fullBody: "This worker may execute commands and change files without asking for approval.",
  confirm: "Confirm", cancel: "Cancel", close: "Close", active: "Active", ended: "Ended", waiting: "Waiting for work",
  provisioning: "Starting", idle: "Idle", queued: "Queued", running: "Running", completed: "Complete", failed: "Failed", stopping: "Stopping", stopped: "Stopped", unknown: "Awaiting confirmation", archived: "Archived"
};
type Copy = { readonly [K in keyof typeof en]: string };
const zhCN: Copy = {
  dispatchTitle: "派活给 {name}", batchTitle: "派活给 {count} 个 Worker", sendTitle: "向 Worker 派活", reportTitle: "Worker 回报",
  reportSource: "来自 Worker {name}", expand: "展开{name}", collapse: "收起{name}", openFailed: "无法打开回报任务，请重试。",
  title: "协作", enable: "开启协作", create: "创建 Worker", configure: "配置协作", confirmed: "已配置协作", remove: "移除配置",
  role: "角色", custom: "自定义角色", developer: "开发", designer: "设计", reviewer: "审查", tester: "测试", merger: "合并",
  target: "项目与后端", model: "模型", defaultModel: "后端默认", effort: "推理强度", fast: "快速模式", permission: "权限",
  initialTask: "初始任务（可选）", taskHint: "留空可创建待命 Worker。", loading: "正在加载协作…", error: "无法更新协作。", refresh: "检查团队状态", unavailable: "当前没有可用的 Worker 路由。",
  workers: "Workers", capacity: "Worker：{count} · 软上限 {soft} · 硬上限 {hard} · 空闲 {minutes} 分钟后释放",
  archive: "归档 Worker", archiveBody: "归档 {name}？正在执行的工作会停止，对话仍会保留。", end: "结束协作", endBody: "结束此团队？所有活跃 Worker 会停止，对话仍会保留。",
  lead: "返回 Lead", readOnly: "Worker 对话为只读，请从 Lead 任务派发工作。", full: "允许完整权限？", fullBody: "此 Worker 可执行命令和修改文件，无需逐次确认。",
  confirm: "确认", cancel: "取消", close: "关闭", active: "进行中", ended: "已结束", waiting: "等待任务", provisioning: "启动中", idle: "空闲", queued: "已排队", running: "运行中", completed: "已完成", failed: "失败", stopping: "停止中", stopped: "已停止", unknown: "等待确认", archived: "已归档"
};
const zhTW: Copy = {
  dispatchTitle: "派工給 {name}", batchTitle: "派工給 {count} 個 Worker", sendTitle: "向 Worker 派工", reportTitle: "Worker 回報",
  reportSource: "來自 Worker {name}", expand: "展開{name}", collapse: "收合{name}", openFailed: "無法開啟回報任務，請重試。",
  title: "協作", enable: "開啟協作", create: "建立 Worker", configure: "設定協作", confirmed: "已設定協作", remove: "移除設定",
  role: "角色", custom: "自訂角色", developer: "開發", designer: "設計", reviewer: "審查", tester: "測試", merger: "合併",
  target: "專案與後端", model: "模型", defaultModel: "後端預設", effort: "推理強度", fast: "快速模式", permission: "權限",
  initialTask: "初始任務（選填）", taskHint: "留空可建立待命 Worker。", loading: "正在載入協作…", error: "無法更新協作。", refresh: "檢查團隊狀態", unavailable: "目前沒有可用的 Worker 路由。",
  workers: "Workers", capacity: "Worker：{count} · 軟上限 {soft} · 硬上限 {hard} · 閒置 {minutes} 分鐘後釋放",
  archive: "封存 Worker", archiveBody: "封存 {name}？執行中的工作會停止，對話仍會保留。", end: "結束協作", endBody: "結束此團隊？所有活躍 Worker 會停止，對話仍會保留。",
  lead: "返回 Lead", readOnly: "Worker 對話為唯讀，請從 Lead 任務派發工作。", full: "允許完整權限？", fullBody: "此 Worker 可執行命令和修改檔案，無需逐次確認。",
  confirm: "確認", cancel: "取消", close: "關閉", active: "進行中", ended: "已結束", waiting: "等待任務", provisioning: "啟動中", idle: "閒置", queued: "已排程", running: "執行中", completed: "已完成", failed: "失敗", stopping: "停止中", stopped: "已停止", unknown: "等待確認", archived: "已封存"
};
const ja: Copy = {
  dispatchTitle: "{name} に作業を割り当て", batchTitle: "{count} 人の Worker に作業を割り当て", sendTitle: "Worker に作業を送信", reportTitle: "Worker の報告",
  reportSource: "Worker {name} から", expand: "{name} を展開", collapse: "{name} を折りたたむ", openFailed: "報告元のタスクを開けませんでした。もう一度お試しください。",
  title: "協働", enable: "協働を有効にする", create: "Worker を作成", configure: "協働を設定", confirmed: "協働設定済み", remove: "設定を削除",
  role: "役割", custom: "カスタム役割", developer: "開発", designer: "デザイン", reviewer: "レビュー", tester: "テスト", merger: "マージ",
  target: "プロジェクトとバックエンド", model: "モデル", defaultModel: "バックエンドの既定", effort: "推論強度", fast: "高速モード", permission: "権限",
  initialTask: "最初のタスク（任意）", taskHint: "空欄にすると Worker は待機します。", loading: "協働を読み込み中…", error: "協働を更新できませんでした。", refresh: "チームの状態を確認", unavailable: "利用可能な Worker ルートがありません。",
  workers: "Workers", capacity: "Worker: {count} · ソフト上限 {soft} · ハード上限 {hard} · 待機 {minutes} 分で解放",
  archive: "Worker をアーカイブ", archiveBody: "{name} をアーカイブしますか？実行中の作業は停止し、会話は保持されます。", end: "協働を終了", endBody: "チームを終了しますか？全 Worker の実行を停止し、会話は保持されます。",
  lead: "Lead に戻る", readOnly: "Worker の会話は読み取り専用です。Lead から作業を送信してください。", full: "完全な権限を許可しますか？", fullBody: "この Worker は確認なしでコマンドを実行しファイルを変更できます。",
  confirm: "確認", cancel: "キャンセル", close: "閉じる", active: "実行中", ended: "終了", waiting: "タスク待機中", provisioning: "起動中", idle: "待機", queued: "キュー", running: "実行中", completed: "完了", failed: "失敗", stopping: "停止中", stopped: "停止済み", unknown: "確認待ち", archived: "アーカイブ済み"
};
const ko: Copy = {
  dispatchTitle: "{name}에게 작업 할당", batchTitle: "Worker {count}명에게 작업 할당", sendTitle: "Worker에게 작업 보내기", reportTitle: "Worker 보고",
  reportSource: "Worker {name}의 보고", expand: "{name} 펼치기", collapse: "{name} 접기", openFailed: "보고한 작업을 열 수 없습니다. 다시 시도하세요.",
  title: "협업", enable: "협업 시작", create: "Worker 만들기", configure: "협업 설정", confirmed: "협업 설정됨", remove: "설정 삭제",
  role: "역할", custom: "사용자 지정 역할", developer: "개발", designer: "디자인", reviewer: "검토", tester: "테스트", merger: "병합",
  target: "프로젝트 및 백엔드", model: "모델", defaultModel: "백엔드 기본값", effort: "추론 강도", fast: "빠른 모드", permission: "권한",
  initialTask: "초기 작업 (선택)", taskHint: "비워 두면 Worker가 작업을 기다립니다.", loading: "협업 불러오는 중…", error: "협업을 업데이트하지 못했습니다.", refresh: "팀 상태 확인", unavailable: "사용 가능한 Worker 경로가 없습니다.",
  workers: "Workers", capacity: "Worker: {count} · 소프트 제한 {soft} · 하드 제한 {hard} · 대기 {minutes}분 후 해제",
  archive: "Worker 보관", archiveBody: "{name}을 보관할까요? 실행 중인 작업은 중지되고 대화는 유지됩니다.", end: "협업 종료", endBody: "팀을 종료할까요? 모든 Worker 작업은 중지되고 대화는 유지됩니다.",
  lead: "Lead로 돌아가기", readOnly: "Worker 대화는 읽기 전용입니다. Lead 작업에서 업무를 보내세요.", full: "전체 권한을 허용할까요?", fullBody: "이 Worker는 확인 없이 명령을 실행하고 파일을 변경할 수 있습니다.",
  confirm: "확인", cancel: "취소", close: "닫기", active: "진행 중", ended: "종료됨", waiting: "작업 대기 중", provisioning: "시작 중", idle: "대기", queued: "대기열", running: "실행 중", completed: "완료", failed: "실패", stopping: "중지 중", stopped: "중지됨", unknown: "확인 대기", archived: "보관됨"
};
export function mobileCollaborationCopy(locale: MobileSupportedLocale): Copy {
  return locale === "zh-CN" ? zhCN : locale === "zh-TW" ? zhTW : locale === "ja" ? ja : locale === "ko" ? ko : en;
}
