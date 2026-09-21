import type { MobileSupportedLocale } from "./mobile-locale-preference";

const en = {
  "intent.connectionRequired": "Choose the Joko node that contains this linked task, then open the link again.",
  "intent.profileUnavailable": "The Joko node named by this link is not saved on this phone. Add or choose that exact node, then open the link again.",
  "intent.profileConnectFailed": "Joko could not verify the saved node for this link. Review that saved connection, then open the link again.",
  "intent.sessionUnavailable": "This linked task is not available on the selected Joko node.",
  "intent.messageUnavailable": "The linked message is not available in this task. The task is open at its latest messages.",
  "intent.linkedMessage": "Linked message from {label}"
} as const;

type NativeIntentMessageKey = keyof typeof en;
type NativeIntentMessageCatalog = { readonly [K in NativeIntentMessageKey]: string };

const zhCN: NativeIntentMessageCatalog = {
  "intent.connectionRequired": "请选择包含此链接任务的 Joko 节点，然后再次打开链接。",
  "intent.profileUnavailable": "此链接指定的 Joko 节点未保存在本手机上。请添加或选择该确切节点，然后再次打开链接。",
  "intent.profileConnectFailed": "Joko 无法验证此链接对应的已保存节点。请检查该连接，然后再次打开链接。",
  "intent.sessionUnavailable": "所选 Joko 节点上没有此链接任务。",
  "intent.messageUnavailable": "此任务中没有该链接消息。任务已回到最新消息。",
  "intent.linkedMessage": "来自{label}的链接消息"
};

const zhTW: NativeIntentMessageCatalog = {
  "intent.connectionRequired": "請選擇包含此連結任務的 Joko 節點，然後再次開啟連結。",
  "intent.profileUnavailable": "此連結指定的 Joko 節點未儲存在本手機上。請加入或選擇該確切節點，然後再次開啟連結。",
  "intent.profileConnectFailed": "Joko 無法驗證此連結對應的已儲存節點。請檢查該連線，然後再次開啟連結。",
  "intent.sessionUnavailable": "所選 Joko 節點上沒有此連結任務。",
  "intent.messageUnavailable": "此任務中沒有該連結訊息。任務已回到最新訊息。",
  "intent.linkedMessage": "來自{label}的連結訊息"
};

const ja: NativeIntentMessageCatalog = {
  "intent.connectionRequired": "このリンク先タスクを含む Joko ノードを選択してから、リンクをもう一度開いてください。",
  "intent.profileUnavailable": "このリンクで指定された Joko ノードは、この端末に保存されていません。その正確なノードを追加または選択してから、リンクをもう一度開いてください。",
  "intent.profileConnectFailed": "このリンクの保存済みノードを確認できませんでした。保存済み接続を確認してから、リンクをもう一度開いてください。",
  "intent.sessionUnavailable": "リンク先タスクは、選択した Joko ノードにありません。",
  "intent.messageUnavailable": "リンク先メッセージはこのタスクにありません。タスクの最新メッセージを表示しています。",
  "intent.linkedMessage": "{label} のリンク先メッセージ"
};

const ko: NativeIntentMessageCatalog = {
  "intent.connectionRequired": "이 링크의 작업이 있는 Joko 노드를 선택한 다음 링크를 다시 여세요.",
  "intent.profileUnavailable": "이 링크가 지정한 Joko 노드는 이 휴대전화에 저장되어 있지 않습니다. 정확한 노드를 추가하거나 선택한 다음 링크를 다시 여세요.",
  "intent.profileConnectFailed": "이 링크의 저장된 노드를 확인할 수 없습니다. 저장된 연결을 검토한 다음 링크를 다시 여세요.",
  "intent.sessionUnavailable": "선택한 Joko 노드에서 링크된 작업을 사용할 수 없습니다.",
  "intent.messageUnavailable": "이 작업에서 링크된 메시지를 사용할 수 없습니다. 작업의 최신 메시지를 열었습니다.",
  "intent.linkedMessage": "{label}의 링크된 메시지"
};

export const mobileNativeIntentMessages: Readonly<Record<MobileSupportedLocale, NativeIntentMessageCatalog>> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ko
};
