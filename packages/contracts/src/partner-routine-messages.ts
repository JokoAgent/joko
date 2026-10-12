const english = {
  title: "Routines", body: "Run instructions when any trigger matches. Routines continue while this window is closed.",
  add: "New routine", name: "Name", prompt: "Instructions", enabled: "Enabled", quiet: "Stay quiet when there is nothing to report",
  check: "Pre-run check", checkHelp: "Run a command in the trusted home workspace. Exit 0 runs the instructions; exit 2 skips them.",
  timeout: "Timeout (seconds)", triggers: "Triggers (any match)", cron: "Cron", interval: "Interval", once: "Once", event: "Event",
  expression: "Cron expression", timezone: "Time zone", minutes: "Every (minutes)", at: "Local date and time", source: "Event source",
  eventType: "Event type", sourceMissing: "Choose an available event source", sourceOffline: "Disconnected", listening: "Listening",
  filters: "Filters (all match)", field: "Field", value: "Value", equals: "Equals", contains: "Contains", addFilter: "Add filter",
  removeTrigger: "Remove trigger", save: "Save", confirm: "Confirm", discard: "Discard changes", back: "Back", close: "Close", refresh: "Refresh",
  run: "Run now", remove: "Delete routine", deleteBody: "Stop this routine and delete its definition and run history?",
  history: "Run history", more: "Load more", noHistory: "No runs yet", empty: "No routines yet", busy: "Working…",
  failed: "The operation could not be confirmed. Refresh before continuing; a pending run will reuse its request when you run again.",
  pending: "Creation is unconfirmed. Check again or retire this request before creating another routine.",
  recover: "Check creation", retire: "Retire creation request", retireBody: "Retire this request? If it already created a routine, that routine will be recovered.",
  readonly: "This Partner is unavailable for changes.", refreshRequired: "Refresh to use the current Partner and routine revisions.",
  discardBody: "Discard unsaved changes?", invalid: "Complete the name, instructions and trigger fields before saving.",
  states: ["Unknown", "Queued", "Running", "Succeeded", "Failed", "Interrupted", "Cancelled", "Skipped"]
};
export type RoutineMessages = typeof english;
const chinese: RoutineMessages = {
  title: "例行任务", body: "任意触发条件匹配时执行指令。关闭窗口后仍会运行。", add: "新建例行任务", name: "名称", prompt: "执行指令",
  enabled: "启用", quiet: "没有值得报告的内容时保持静默", check: "运行前检查", checkHelp: "在可信 Home 工作区执行命令。退出码 0 执行指令；退出码 2 跳过。",
  timeout: "超时（秒）", triggers: "触发条件（任意匹配）", cron: "Cron", interval: "间隔", once: "单次", event: "事件",
  expression: "Cron 表达式", timezone: "时区", minutes: "每隔（分钟）", at: "本地日期和时间", source: "事件来源", eventType: "事件类型",
  sourceMissing: "选择可用的事件来源", sourceOffline: "已断开", listening: "监听中", filters: "筛选条件（全部匹配）", field: "字段", value: "值",
  equals: "等于", contains: "包含", addFilter: "添加筛选", removeTrigger: "移除触发条件", save: "保存", confirm: "确认", discard: "放弃修改", back: "返回", close: "关闭", refresh: "刷新",
  run: "立即运行", remove: "删除例行任务", deleteBody: "停止这个例行任务，并删除定义和运行历史？", history: "运行历史", more: "加载更多", noHistory: "暂无运行", empty: "暂无例行任务", busy: "处理中…",
  failed: "无法确认操作结果。请刷新后继续；再次运行会复用待确认请求。", pending: "创建结果待确认。请回读检查，或退休此请求后再创建。", recover: "检查创建结果",
  retire: "退休创建请求", retireBody: "退休此请求？如果已创建例行任务，将恢复该任务。", readonly: "此 Partner 当前不可修改。", refreshRequired: "请刷新以读取当前 Partner 和例行任务版本。",
  discardBody: "放弃尚未保存的修改？", invalid: "保存前请填写名称、指令和触发条件。", states: ["未知", "排队中", "运行中", "成功", "失败", "已中断", "已取消", "已跳过"]
};
const traditional: RoutineMessages = { ...chinese, title: "例行任務", body: "任一觸發條件符合時執行指令。關閉視窗後仍會執行。", add: "新增例行任務", name: "名稱", prompt: "執行指令",
  enabled: "啟用", quiet: "沒有值得報告的內容時保持靜默", check: "執行前檢查", checkHelp: "在可信任的 Home 工作區執行命令。結束碼 0 執行指令；結束碼 2 跳過。",
  timeout: "逾時（秒）", triggers: "觸發條件（任一符合）", interval: "間隔", once: "單次", expression: "Cron 運算式", timezone: "時區", minutes: "每隔（分鐘）",
  at: "本地日期和時間", source: "事件來源", eventType: "事件類型", sourceMissing: "選擇可用的事件來源", sourceOffline: "已中斷", listening: "監聽中", filters: "篩選條件（全部符合）",
  field: "欄位", addFilter: "新增篩選", removeTrigger: "移除觸發條件", save: "儲存", confirm: "確認", discard: "放棄修改", back: "返回", close: "關閉", refresh: "重新整理",
  run: "立即執行", remove: "刪除例行任務", deleteBody: "停止此例行任務，並刪除定義和執行記錄？", history: "執行記錄", more: "載入更多", noHistory: "尚無執行", empty: "尚無例行任務", busy: "處理中…",
  failed: "無法確認操作結果。請重新整理後繼續；再次執行會沿用待確認請求。", pending: "建立結果待確認。請查詢，或撤銷此請求後再建立。", recover: "檢查建立結果",
  retire: "撤銷建立請求", retireBody: "撤銷此請求？若已建立例行任務，將恢復該任務。", readonly: "此 Partner 目前無法修改。", refreshRequired: "請重新整理以讀取目前版本。", discardBody: "放棄尚未儲存的修改？", invalid: "儲存前請填寫名稱、指令與觸發條件。", states: ["未知", "排隊中", "執行中", "成功", "失敗", "已中斷", "已取消", "已跳過"] };
const japanese: RoutineMessages = {
  title: "ルーチン", body: "いずれかの条件が一致すると指示を実行します。ウィンドウを閉じても実行を継続します。", add: "ルーチンを追加", name: "名前", prompt: "実行する指示", enabled: "有効", quiet: "報告する内容がなければ通知しない",
  check: "実行前チェック", checkHelp: "信頼された Home ワークスペースでコマンドを実行します。終了コード 0 で指示を実行し、2 でスキップします。", timeout: "タイムアウト（秒）", triggers: "トリガー（いずれか一致）", cron: "Cron", interval: "間隔", once: "一度だけ", event: "イベント", expression: "Cron 式", timezone: "タイムゾーン", minutes: "間隔（分）", at: "ローカル日時", source: "イベントソース", eventType: "イベントの種類", sourceMissing: "利用可能なソースを選択", sourceOffline: "切断", listening: "待機中", filters: "フィルター（すべて一致）", field: "フィールド", value: "値", equals: "等しい", contains: "含む", addFilter: "フィルターを追加", removeTrigger: "トリガーを削除", save: "保存", confirm: "確認", discard: "変更を破棄", back: "戻る", close: "閉じる", refresh: "更新", run: "今すぐ実行", remove: "ルーチンを削除", deleteBody: "このルーチンを停止し、定義と実行履歴を削除しますか？", history: "実行履歴", more: "さらに読み込む", noHistory: "実行履歴はありません", empty: "ルーチンはありません", busy: "処理中…", failed: "結果を確認できません。更新してください。再実行時は未確認のリクエストを再利用します。", pending: "作成結果が未確認です。確認するか、このリクエストを取り消してください。", recover: "作成結果を確認", retire: "作成リクエストを取り消す", retireBody: "取り消しますか？作成済みのルーチンがあれば復元します。", readonly: "この Partner は変更できません。", refreshRequired: "現在のバージョンを読み込むには更新してください。", discardBody: "未保存の変更を破棄しますか？", invalid: "名前、指示、トリガーを入力してください。", states: ["不明", "待機", "実行中", "成功", "失敗", "中断", "キャンセル", "スキップ"]
};
const korean: RoutineMessages = {
  title: "루틴", body: "조건 중 하나가 일치하면 지시를 실행합니다. 창을 닫아도 계속 실행됩니다.", add: "새 루틴", name: "이름", prompt: "실행 지시", enabled: "활성화", quiet: "보고할 내용이 없으면 알리지 않기", check: "실행 전 확인", checkHelp: "신뢰할 수 있는 Home 작업 공간에서 명령을 실행합니다. 종료 코드 0이면 실행하고 2이면 건너뜁니다.", timeout: "시간 제한 (초)", triggers: "트리거 (하나 이상 일치)", cron: "Cron", interval: "간격", once: "한 번", event: "이벤트", expression: "Cron 표현식", timezone: "시간대", minutes: "간격 (분)", at: "현지 날짜 및 시간", source: "이벤트 소스", eventType: "이벤트 유형", sourceMissing: "사용 가능한 소스 선택", sourceOffline: "연결 끊김", listening: "수신 중", filters: "필터 (모두 일치)", field: "필드", value: "값", equals: "같음", contains: "포함", addFilter: "필터 추가", removeTrigger: "트리거 제거", save: "저장", confirm: "확인", discard: "변경 취소", back: "뒤로", close: "닫기", refresh: "새로 고침", run: "지금 실행", remove: "루틴 삭제", deleteBody: "이 루틴을 중지하고 정의와 실행 기록을 삭제할까요?", history: "실행 기록", more: "더 보기", noHistory: "실행 기록 없음", empty: "루틴 없음", busy: "처리 중…", failed: "결과를 확인하지 못했습니다. 새로 고침하세요. 다시 실행하면 미확인 요청을 재사용합니다.", pending: "생성 결과를 확인하거나 생성 요청을 취소하세요.", recover: "생성 결과 확인", retire: "생성 요청 취소", retireBody: "요청을 취소할까요? 이미 생성된 루틴이 있으면 복구합니다.", readonly: "현재 이 Partner를 수정할 수 없습니다.", refreshRequired: "현재 버전을 읽으려면 새로 고침하세요.", discardBody: "저장하지 않은 변경을 취소할까요?", invalid: "이름, 지시 및 트리거를 입력하세요.", states: ["알 수 없음", "대기", "실행 중", "성공", "실패", "중단", "취소", "건너뜀"]
};
export function routineMessages(locale: string): RoutineMessages {
  return locale === "zh-CN" ? chinese : locale === "zh-TW" ? traditional : locale === "ja" ? japanese : locale === "ko" ? korean : english;
}
