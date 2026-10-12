const en = { changed: "Execution changed", resumed: "Resumed the previous runtime" };
const messages: Readonly<Record<string, Readonly<typeof en>>> = {
  en,
  "zh-CN": { changed: "已切换执行器", resumed: "已恢复之前的原生会话" },
  "zh-TW": { changed: "已切換執行器", resumed: "已恢復先前的原生對話" },
  ja: { changed: "実行エンジンを切り替えました", resumed: "以前のセッションを再開しました" },
  ko: { changed: "실행 엔진이 변경됨", resumed: "이전 세션을 재개함" }
};
export function sessionHandoffMessages(locale: string): Readonly<typeof en> { return messages[locale] ?? en; }
