import type { MobileSupportedLocale } from "./mobile-locale-preference";
const en = { app: "Application", retry: "Retry", failed: "Unable to load this application. Check the task and server connection, then retry.",
  unavailable: "An interactive application requires the native host and an active task connection.", readOnly: "Shared application history is read-only." };
const zh = { app: "应用", retry: "重试", failed: "应用加载失败。请检查任务及服务器连接后重试。", unavailable: "交互应用需要原生承载层和有效的任务连接。", readOnly: "共享应用历史记录为只读。" };
export function mobileMcpAppMessages(locale: MobileSupportedLocale) {
  if (locale === "zh-CN") return zh;
  if (locale === "zh-TW") return { app: "應用程式", retry: "重試", failed: "應用程式載入失敗。請檢查任務與伺服器連線後重試。", unavailable: "互動應用程式需要原生承載層和有效的任務連線。", readOnly: "共用應用程式歷程記錄為唯讀。" };
  if (locale === "ja") return { app: "アプリ", retry: "再試行", failed: "アプリを読み込めません。タスクとサーバー接続を確認して再試行してください。", unavailable: "対話型アプリにはネイティブホストと有効なタスク接続が必要です。", readOnly: "共有アプリの履歴は読み取り専用です。" };
  if (locale === "ko") return { app: "앱", retry: "다시 시도", failed: "앱을 불러올 수 없습니다. 작업 및 서버 연결을 확인하고 다시 시도하세요.", unavailable: "대화형 앱에는 네이티브 호스트와 활성 작업 연결이 필요합니다.", readOnly: "공유 앱 기록은 읽기 전용입니다." };
  return en;
}
