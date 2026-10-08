import type { MobileSupportedLocale } from "./mobile-locale-preference";

const messages = {
  en: {
    title: "Thinking", active: "Thinking · {seconds}s elapsed", completed: "Thinking · duration unknown",
    hidden: "Thinking hidden", hiddenBody: "The model returned no thinking to display.", empty: "No thinking yet",
    expand: "Expand thinking", collapse: "Collapse thinking",
    workTitle: "Work process", workActive: "Working", expandWork: "Expand work process", collapseWork: "Collapse work process"
  },
  "zh-CN": {
    title: "思考", active: "思考中 · 已过 {seconds} 秒", completed: "思考 · 时长未知",
    hidden: "思考已隐藏", hiddenBody: "模型未提供可展示的思考内容。", empty: "暂无思考内容",
    expand: "展开思考", collapse: "收起思考",
    workTitle: "工作过程", workActive: "工作中", expandWork: "展开工作过程", collapseWork: "收起工作过程"
  },
  "zh-TW": {
    title: "思考", active: "思考中 · 已過 {seconds} 秒", completed: "思考 · 時長未知",
    hidden: "思考已隱藏", hiddenBody: "模型未提供可顯示的思考內容。", empty: "尚無思考內容",
    expand: "展開思考", collapse: "收起思考",
    workTitle: "工作過程", workActive: "工作中", expandWork: "展開工作過程", collapseWork: "收起工作過程"
  },
  ja: {
    title: "思考", active: "思考中 · {seconds}秒経過", completed: "思考 · 所要時間不明",
    hidden: "思考は非表示", hiddenBody: "モデルから表示できる思考内容が返されませんでした。", empty: "思考内容はまだありません",
    expand: "思考を展開", collapse: "思考を折りたたむ",
    workTitle: "作業過程", workActive: "作業中", expandWork: "作業過程を展開", collapseWork: "作業過程を折りたたむ"
  },
  ko: {
    title: "생각", active: "생각 중 · {seconds}초 경과", completed: "생각 · 소요 시간 알 수 없음",
    hidden: "생각 숨김", hiddenBody: "모델이 표시할 생각 내용을 반환하지 않았습니다.", empty: "아직 생각 내용 없음",
    expand: "생각 펼치기", collapse: "생각 접기",
    workTitle: "작업 과정", workActive: "작업 중", expandWork: "작업 과정 펼치기", collapseWork: "작업 과정 접기"
  }
} satisfies Record<MobileSupportedLocale, Record<string, string>>;

export type MobileThinkingMessageKey = keyof typeof messages.en;
export function mobileThinkingMessage(locale: MobileSupportedLocale, key: MobileThinkingMessageKey, seconds?: number): string {
  return messages[locale][key].replace("{seconds}", String(seconds ?? 0));
}
