import type { MobileSupportedLocale } from "./mobile-locale-preference";
const en = { failed: "The card could not save or finish its action. Retry before sending another message.", retry: "Retry", expand: "Expand editor", fields: "Show fields", collapse: "Hide fields",
  preview: "Mail preview", close: "Close", cancel: "Cancel", confirm: "Confirm", openLink: "Open external link?", prompt: "Card input", readOnly: "This card is read-only.", remove: "Remove", insert: "Insert image" };
const zh = { failed: "卡片未能完成保存或操作。请重试后再发送消息。", retry: "重试", expand: "展开编辑器", fields: "展开字段", collapse: "收起字段",
  preview: "邮件预览", close: "关闭", cancel: "取消", confirm: "确认", openLink: "打开外部链接？", prompt: "卡片输入", readOnly: "此卡片仅供查看。", remove: "移除", insert: "插入图片" };
function cardMessages(locale: MobileSupportedLocale): typeof en {
  if (locale === "zh-CN") return zh;
  if (locale === "zh-TW") return { failed: "卡片未能完成儲存或操作。請重試後再傳送訊息。", retry: "重試", expand: "展開編輯器", fields: "展開欄位", collapse: "收起欄位",
    preview: "郵件預覽", close: "關閉", cancel: "取消", confirm: "確認", openLink: "開啟外部連結？", prompt: "卡片輸入", readOnly: "此卡片僅供檢視。", remove: "移除", insert: "插入圖片" };
  if (locale === "ja") return { failed: "カードを保存または操作できませんでした。再試行してからメッセージを送信してください。", retry: "再試行", expand: "編集画面を拡大", fields: "項目を表示", collapse: "項目を隠す",
    preview: "メールのプレビュー", close: "閉じる", cancel: "キャンセル", confirm: "確認", openLink: "外部リンクを開きますか？", prompt: "カードへの入力", readOnly: "このカードは読み取り専用です。", remove: "削除", insert: "画像を挿入" };
  if (locale === "ko") return { failed: "카드를 저장하거나 작업을 완료하지 못했습니다. 다시 시도한 후 메시지를 보내세요.", retry: "다시 시도", expand: "편집기 확장", fields: "필드 표시", collapse: "필드 숨기기",
    preview: "메일 미리보기", close: "닫기", cancel: "취소", confirm: "확인", openLink: "외부 링크를 여시겠습니까?", prompt: "카드 입력", readOnly: "이 카드는 읽기 전용입니다.", remove: "제거", insert: "이미지 삽입" };
  return en;
}

const mail = {
  en: { attachFile: "Attach file", mailFailed: "The message could not be read. Check the plugin account and try again.", mailAmbiguous: "More than one enabled plugin handles this mail link. Choose one in Plugins.", mailPartial: "Some conversation or read-status details are unavailable.", mailOriginal: "Open original message", mailThread: "Conversation", mailTo: "To", mailCc: "Cc", mailBcc: "Bcc", mailSubject: "Subject" },
  "zh-CN": { attachFile: "添加附件", mailFailed: "无法读取邮件。请检查插件账号后重试。", mailAmbiguous: "多个已启用插件可处理此邮件链接。请在插件设置中选择一个。", mailPartial: "部分会话或已读状态信息暂不可用。", mailOriginal: "打开原始邮件", mailThread: "会话", mailTo: "收件人", mailCc: "抄送", mailBcc: "密送", mailSubject: "主题" },
  "zh-TW": { attachFile: "加入附件", mailFailed: "無法讀取郵件。請檢查外掛帳號後重試。", mailAmbiguous: "多個已啟用外掛可處理此郵件連結。請在外掛設定中選擇一個。", mailPartial: "部分對話或已讀狀態資訊暫時無法取得。", mailOriginal: "開啟原始郵件", mailThread: "對話", mailTo: "收件者", mailCc: "副本", mailBcc: "密件副本", mailSubject: "主旨" },
  ja: { attachFile: "ファイルを添付", mailFailed: "メールを読み取れません。プラグインのアカウントを確認して再試行してください。", mailAmbiguous: "複数のプラグインがこのメールリンクを処理します。設定で一つを選択してください。", mailPartial: "会話または既読状態の一部を取得できません。", mailOriginal: "元のメールを開く", mailThread: "スレッド", mailTo: "宛先", mailCc: "Cc", mailBcc: "Bcc", mailSubject: "件名" },
  ko: { attachFile: "파일 첨부", mailFailed: "메일을 읽을 수 없습니다. 플러그인 계정을 확인하고 다시 시도하세요.", mailAmbiguous: "여러 플러그인이 이 메일 링크를 처리합니다. 설정에서 하나를 선택하세요.", mailPartial: "일부 대화 또는 읽음 상태를 확인할 수 없습니다.", mailOriginal: "원본 메일 열기", mailThread: "대화", mailTo: "받는 사람", mailCc: "참조", mailBcc: "숨은 참조", mailSubject: "제목" }
};
export function mobileExtensionCardMessages(locale: MobileSupportedLocale) { return { ...cardMessages(locale), ...mail[locale] }; }
