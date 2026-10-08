import type { MobileSupportedLocale } from "./mobile-locale-preference";

type MobilePartnerMessageRow = readonly [
  key: string,
  en: string,
  zhCN: string,
  zhTW: string,
  ja: string,
  ko: string
];

const rows = [
  ["partnerResource.title", "Partner Resources", "伙伴资源", "夥伴資源", "パートナーリソース", "파트너 리소스"],
  ["partnerResource.menuDescription", "Browse Partners and open their canonical tasks", "浏览伙伴并打开其 canonical 任务", "瀏覽夥伴並開啟其 canonical 任務", "パートナーを参照して canonical タスクを開く", "파트너를 탐색하고 canonical 작업 열기"],
  ["partnerResource.search", "Search Partner Resources", "搜索伙伴资源", "搜尋夥伴資源", "パートナーリソースを検索", "파트너 리소스 검색"],
  ["partnerResource.loading", "Loading Partner Resources…", "正在加载伙伴资源…", "正在載入夥伴資源…", "パートナーリソースを読み込み中…", "파트너 리소스 불러오는 중…"],
  ["partnerResource.empty", "No Partner Resources are available on this Joko node.", "此 Joko 节点暂无伙伴资源。", "此 Joko 節點暫無夥伴資源。", "この Joko ノードにはパートナーリソースがありません。", "이 Joko 노드에는 파트너 리소스가 없습니다."],
  ["partnerResource.noResults", "No Partner Resources match this search.", "没有匹配此搜索的伙伴资源。", "沒有符合此搜尋的夥伴資源。", "検索に一致するパートナーリソースはありません。", "검색과 일치하는 파트너 리소스가 없습니다."],
  ["partnerResource.offline", "Reconnect to browse Partner Resources.", "重新连接后可浏览伙伴资源。", "重新連線後可瀏覽夥伴資源。", "再接続してパートナーリソースを参照してください。", "다시 연결하여 파트너 리소스를 탐색하세요."],
  ["partnerResource.error", "Partner Resources could not be loaded.", "无法加载伙伴资源。", "無法載入夥伴資源。", "パートナーリソースを読み込めませんでした。", "파트너 리소스를 불러올 수 없습니다."],
  ["partnerResource.refresh", "Refresh Partner Resources", "刷新伙伴资源", "重新整理夥伴資源", "パートナーリソースを更新", "파트너 리소스 새로고침"],
  ["partnerResource.openAccessibility", "Preview {name}", "预览{name}", "預覽{name}", "{name}をプレビュー", "{name} 미리보기"],
  ["partnerResource.unavailable", "Canonical task unavailable", "Canonical 任务不可用", "Canonical 任務無法使用", "Canonical タスクは利用できません", "Canonical 작업을 사용할 수 없음"],
  ["partnerResource.previewLoading", "Loading Resource preview…", "正在加载资源预览…", "正在載入資源預覽…", "リソースのプレビューを読み込み中…", "리소스 미리보기 불러오는 중…"],
  ["partnerResource.previewError", "This Resource preview is no longer current. Refresh and try again.", "此资源预览已不是当前版本。请刷新后重试。", "此資源預覽已不是目前版本。請重新整理後重試。", "このリソースのプレビューは最新ではありません。更新して再試行してください。", "이 리소스 미리보기는 더 이상 최신이 아닙니다. 새로고침 후 다시 시도하세요."],
  ["partnerResource.backToDirectory", "Back to Partner Resources", "返回伙伴资源", "返回夥伴資源", "パートナーリソースに戻る", "파트너 리소스로 돌아가기"],
  ["partnerResource.canonicalTask", "Canonical task", "Canonical 任务", "Canonical 任務", "Canonical タスク", "Canonical 작업"],
  ["partnerResource.lastActivity", "Last activity {time}", "最近活动 {time}", "最近活動 {time}", "最終アクティビティ {time}", "최근 활동 {time}"],
  ["partnerResource.created", "Created {time}", "创建于 {time}", "建立於 {time}", "作成 {time}", "생성 {time}"],
  ["partnerResource.artifacts", "Canonical Artifacts", "Canonical Artifacts", "Canonical Artifacts", "Canonical Artifacts", "Canonical Artifacts"],
  ["partnerResource.artifactCount", "{count} Artifacts", "{count} 个 Artifacts", "{count} 個 Artifacts", "Artifacts {count} 件", "Artifacts {count}개"],
  ["partnerResource.noArtifacts", "This canonical task has no Artifacts yet.", "此 canonical 任务还没有 Artifacts。", "此 canonical 任務還沒有 Artifacts。", "この canonical タスクにはまだ Artifacts がありません。", "이 canonical 작업에는 아직 Artifacts가 없습니다."],
  ["partnerResource.artifactMeta", "{mediaType} · {size} · {time}", "{mediaType} · {size} · {time}", "{mediaType} · {size} · {time}", "{mediaType} · {size} · {time}", "{mediaType} · {size} · {time}"],
  ["partnerResource.openTask", "Open canonical task", "打开 canonical 任务", "開啟 canonical 任務", "Canonical タスクを開く", "Canonical 작업 열기"],
  ["partnerResource.openingTask", "Opening canonical task…", "正在打开 canonical 任务…", "正在開啟 canonical 任務…", "Canonical タスクを開いています…", "Canonical 작업 여는 중…"],
  ["partnerResource.openFailed", "The canonical task changed or is unavailable. Refresh this preview.", "Canonical 任务已变化或不可用。请刷新此预览。", "Canonical 任務已變更或無法使用。請重新整理此預覽。", "Canonical タスクが変更されたか利用できません。このプレビューを更新してください。", "Canonical 작업이 변경되었거나 사용할 수 없습니다. 이 미리보기를 새로고침하세요."],
  ["partner.title", "Partner chats", "伙伴私聊", "夥伴私聊", "パートナーのチャット", "파트너 채팅"],
  ["partner.menuDescription", "Read private conversations between Partners", "查看伙伴之间的私聊", "查看夥伴之間的私聊", "パートナー間の非公開会話を表示", "파트너 간 비공개 대화 보기"],
  ["partner.openThread", "Open Partner chat", "打开伙伴私聊", "開啟夥伴私聊", "パートナーのチャットを開く", "파트너 채팅 열기"],
  ["partner.readOnly", "Read-only · Partners exchange these messages", "只读 · 消息由伙伴互发", "唯讀 · 訊息由夥伴互傳", "読み取り専用 · パートナー間のメッセージ", "읽기 전용 · 파트너끼리 주고받은 메시지"],
  ["partner.directory", "Partners", "伙伴", "夥伴", "パートナー", "파트너"],
  ["partner.threads", "Conversations", "会话", "對話", "会話", "대화"],
  ["partner.directoryCount", "{count} Partners", "{count} 位伙伴", "{count} 位夥伴", "パートナー {count} 人", "파트너 {count}명"],
  ["partner.threadCount", "{count} conversations", "{count} 个会话", "{count} 個對話", "会話 {count} 件", "대화 {count}개"],
  ["partner.loadingDirectory", "Loading Partners…", "正在加载伙伴…", "正在載入夥伴…", "パートナーを読み込み中…", "파트너 불러오는 중…"],
  ["partner.loadingThreads", "Loading conversations…", "正在加载会话…", "正在載入對話…", "会話を読み込み中…", "대화 불러오는 중…"],
  ["partner.loadingDetail", "Loading conversation…", "正在加载会话详情…", "正在載入對話詳情…", "会話を読み込み中…", "대화 불러오는 중…"],
  ["partner.emptyDirectory", "No Partners are available on this Joko node.", "此 Joko 节点暂无可用伙伴。", "此 Joko 節點暫無可用夥伴。", "この Joko ノードにはパートナーがいません。", "이 Joko 노드에는 사용 가능한 파트너가 없습니다."],
  ["partner.emptyThreads", "No private conversations for this Partner.", "这位伙伴还没有私聊会话。", "這位夥伴還沒有私聊對話。", "このパートナーの非公開会話はありません。", "이 파트너의 비공개 대화가 없습니다."],
  ["partner.emptyMessages", "No messages in this conversation.", "此会话还没有消息。", "此對話還沒有訊息。", "この会話にはメッセージがありません。", "이 대화에는 메시지가 없습니다."],
  ["partner.selectPartner", "Select a Partner to see conversations.", "选择伙伴以查看会话。", "選擇夥伴以查看對話。", "パートナーを選ぶと会話を表示します。", "파트너를 선택하면 대화를 볼 수 있습니다."],
  ["partner.selectThread", "Select a conversation to read it.", "选择会话以阅读消息。", "選擇對話以閱讀訊息。", "会話を選ぶとメッセージを表示します。", "대화를 선택하면 메시지를 볼 수 있습니다."],
  ["partner.offline", "Partner chats need a live Joko connection. Private message content is not saved offline.", "伙伴私聊需要实时连接 Joko。私聊正文不会离线保存。", "夥伴私聊需要即時連線 Joko。私聊內文不會離線儲存。", "パートナーのチャットには Joko への接続が必要です。非公開メッセージはオフライン保存されません。", "파트너 채팅은 Joko 실시간 연결이 필요합니다. 비공개 메시지는 오프라인에 저장되지 않습니다."],
  ["partner.error", "Partner chats could not be loaded.", "无法加载伙伴私聊。", "無法載入夥伴私聊。", "パートナーのチャットを読み込めませんでした。", "파트너 채팅을 불러올 수 없습니다."],
  ["partner.readError", "Read status could not be updated. Retry while this conversation is open.", "无法更新已读状态。保持此会话打开并重试。", "無法更新已讀狀態。保持此對話開啟並重試。", "既読状態を更新できませんでした。この会話を開いたまま再試行してください。", "읽음 상태를 업데이트할 수 없습니다. 대화를 연 상태에서 다시 시도하세요."],
  ["partner.retry", "Retry", "重试", "重試", "再試行", "다시 시도"],
  ["partner.backToDirectory", "Back to Partners", "返回伙伴目录", "返回夥伴目錄", "パートナー一覧に戻る", "파트너 목록으로 돌아가기"],
  ["partner.backToThreads", "Back to conversations", "返回会话列表", "返回對話列表", "会話一覧に戻る", "대화 목록으로 돌아가기"],
  ["partner.openPartnerAccessibility", "View {name}'s conversations", "查看{name}的会话", "查看{name}的對話", "{name}の会話を表示", "{name}의 대화 보기"],
  ["partner.openThreadAccessibility", "Read conversation between {first} and {second}", "阅读{first}与{second}的会话", "閱讀{first}與{second}的對話", "{first}と{second}の会話を読む", "{first}와 {second}의 대화 읽기"],
  ["partner.pair", "{first} · {second}", "{first} · {second}", "{first} · {second}", "{first} · {second}", "{first} · {second}"],
  ["partner.unknownName", "Unknown Partner", "未知伙伴", "未知夥伴", "不明なパートナー", "알 수 없는 파트너"],
  ["partner.lifecycle.active", "Active", "活跃", "使用中", "有効", "활성"],
  ["partner.lifecycle.archived", "Archived", "已归档", "已封存", "アーカイブ済み", "보관됨"],
  ["partner.initialization.pending", "Setting up", "正在设置", "正在設定", "準備中", "설정 중"],
  ["partner.initialization.error", "Setup needs attention", "设置需要处理", "設定需要處理", "設定に対応が必要", "설정 확인 필요"],
  ["partner.thread.active", "Active", "进行中", "進行中", "進行中", "진행 중"],
  ["partner.thread.closed", "Closed", "已关闭", "已關閉", "終了", "종료됨"],
  ["partner.thread.closedLimit", "Closed · message limit reached", "已关闭 · 达到消息上限", "已關閉 · 已達訊息上限", "終了 · メッセージ上限に到達", "종료됨 · 메시지 한도 도달"],
  ["partner.thread.closedIdle", "Closed · inactive for too long", "已关闭 · 闲置超时", "已關閉 · 閒置逾時", "終了 · 無操作で時間切れ", "종료됨 · 비활성 시간 초과"],
  ["partner.messageLimit", "Messages {count}/{limit}", "消息 {count}/{limit}", "訊息 {count}/{limit}", "メッセージ {count}/{limit}", "메시지 {count}/{limit}"],
  ["partner.expiresAt", "Expires {time}", "到期时间 {time}", "到期時間 {time}", "期限 {time}", "만료 {time}"],
  ["partner.blockedUntil", "Blocked until {time}", "阻止发送至 {time}", "阻止傳送至 {time}", "送信制限 {time} まで", "{time}까지 전송 제한"],
  ["partner.updatedAt", "Updated {time}", "更新于 {time}", "更新於 {time}", "更新 {time}", "업데이트 {time}"],
  ["partner.closedAt", "Closed {time}", "关闭于 {time}", "關閉於 {time}", "終了 {time}", "종료 {time}"],
  ["partner.deliveredAt", "Delivered {time}", "送达于 {time}", "送達於 {time}", "配信済み {time}", "전달됨 {time}"],
  ["partner.delivery.pending", "Pending delivery", "等待投递", "等待投遞", "配信待ち", "전달 대기 중"],
  ["partner.delivery.delivered", "Delivered", "已送达", "已送達", "配信済み", "전달됨"],
  ["partner.delivery.failed", "Delivery failed", "投递失败", "投遞失敗", "配信失敗", "전달 실패"],
  ["partner.readThrough", "{name} read through message {sequence}", "{name}已读至第 {sequence} 条消息", "{name}已讀至第 {sequence} 則訊息", "{name}の既読位置: メッセージ {sequence}", "{name}의 읽은 위치: 메시지 {sequence}"],
  ["partner.readUnknown", "Read state unavailable", "已读状态不可用", "已讀狀態無法使用", "既読状態を取得できません", "읽음 상태를 확인할 수 없음"],
  ["partner.messageRead", "Read by {name}", "{name}已读", "{name}已讀", "{name}が既読", "{name} 읽음"],
  ["partner.messageUnread", "Not yet read by {name}", "{name}尚未读", "{name}尚未讀", "{name}は未読", "{name}이(가) 아직 읽지 않음"],
  ["partner.messageNumber", "Message {sequence}", "第 {sequence} 条消息", "第 {sequence} 則訊息", "メッセージ {sequence}", "메시지 {sequence}"],
  ["partner.sentAt", "Sent {time}", "发送于 {time}", "傳送於 {time}", "送信 {time}", "전송 {time}"],
  ["partner.refresh", "Refresh Partner chats", "刷新伙伴私聊", "重新整理夥伴私聊", "パートナーのチャットを更新", "파트너 채팅 새로고침"]
] as const satisfies readonly MobilePartnerMessageRow[];

const duplicateKeys = rows.map(([key]) => key).filter((key, index, keys) => keys.indexOf(key) !== index);
if (duplicateKeys.length > 0) throw new Error(`Duplicate mobile Partner messages: ${duplicateKeys.join(", ")}`);

function catalog(column: 1 | 2 | 3 | 4 | 5): Readonly<Record<(typeof rows)[number][0], string>> {
  return Object.fromEntries(rows.map((row) => [row[0], row[column]])) as Readonly<Record<(typeof rows)[number][0], string>>;
}

export const mobilePartnerMessages: Readonly<Record<MobileSupportedLocale, Readonly<Record<(typeof rows)[number][0], string>>>> = {
  en: catalog(1),
  "zh-CN": catalog(2),
  "zh-TW": catalog(3),
  ja: catalog(4),
  ko: catalog(5)
};
