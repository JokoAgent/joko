import type { MobileSupportedLocale } from "./mobile-locale-preference";

const copy = {
  en: { create: "Ask in a side chat", list: "Side chats", back: "Return to main task", context: "Independent follow-up. Inherited history is reference material; the main task continues separately.", readOnly: "This side chat uses a read-only workspace.", unknown: "The side chat result is not confirmed. Check its original operation before creating another." },
  "zh-CN": { create: "在侧边追问", list: "侧边话题", back: "返回主任务", context: "独立追问：继承的历史仅作为参考，主任务继续独立运行。", readOnly: "此侧边话题使用只读工作区。", unknown: "侧边话题结果尚未确认。请先查询原操作，再创建新话题。" },
  "zh-TW": { create: "在側邊追問", list: "側邊話題", back: "返回主任務", context: "獨立追問：繼承的歷史僅作為參考，主任務繼續獨立執行。", readOnly: "此側邊話題使用唯讀工作區。", unknown: "側邊話題結果尚未確認。請先查詢原操作，再建立新話題。" },
  ja: { create: "サイドチャットで質問", list: "サイドチャット", back: "元のタスクに戻る", context: "独立した追加質問です。継承した履歴は参考資料であり、元のタスクは別に続行します。", readOnly: "このサイドチャットのワークスペースは読み取り専用です。", unknown: "作成結果が未確定です。新しく作成する前に元の操作を確認してください。" },
  ko: { create: "사이드 채팅에서 질문", list: "사이드 채팅", back: "원래 작업으로 돌아가기", context: "독립적인 후속 질문입니다. 상속한 기록은 참고 자료이며 원래 작업은 별도로 계속됩니다.", readOnly: "이 사이드 채팅은 읽기 전용 작업 공간을 사용합니다.", unknown: "생성 결과가 확인되지 않았습니다. 새로 만들기 전에 원래 작업을 확인하세요." }
};
export function mobileSideChatCopy(locale: MobileSupportedLocale) { return copy[locale]; }
