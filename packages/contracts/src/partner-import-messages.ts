import { PartnerImportCategory, PartnerImportCheckStatus } from "./gen/joko/v1/partner_import_pb.js";

const en = {
  title: "Import a local agent", empty: "No supported local agents were found on this node.", name: "Partner name", back: "Back", close: "Close",
  selectAll: "Select all", search: "Search items", previous: "Previous", next: "Next", submit: "Save Partner", retry: "Retry missing items",
  refresh: "Check status", continueSetup: "Verify and continue setup", open: "Open task", running: "Saving selected items…", saved: "Saved", partial: "Some selected items need attention",
  takeover: "Take over selected enabled routines after verification. Their original schedules will be paused only after Joko is ready.",
  deferred: "Save first. Verification and schedule takeover continue from the Partner task when you choose to proceed.",
  conflict: "Choose one account from each conflicting group.", dependency: "A required connection is not selected.", paused: "Paused", details: "Details",
  unknown: "The request may have been accepted. Check its saved status before retrying.", absent: "The node confirms this request was not saved. You can choose a source again.",
  reset: "Choose a source again", failed: "Import could not finish. Saved items and the original request are retained.", offline: "Connect to the current node to import.",
  personality: "Identity", memory: "Memory", skills: "Skills", connections: "Connections", automations: "Routines",
  copied: "Saved", verified: "Verified", active: "Active", attention: "Needs attention", setup: "Saved; setup is deferred", changed: "The source or Partner changed. Refresh before continuing.",
  mapping: "The source model or tool policy needs mapping. Ask the Partner to use its current settings for these items.",
  budget: "This source exceeds the supported import budget.", private: "This original requires private access from the Partner task.",
};
const zh: typeof en = {
  title: "导入本机 Agent", empty: "当前节点没有找到支持的本机 Agent。", name: "Partner 名称", back: "返回", close: "关闭",
  selectAll: "全选", search: "搜索项目", previous: "上一页", next: "下一页", submit: "保存 Partner", retry: "重试未完成项目",
  refresh: "检查状态", continueSetup: "验证并继续设置", open: "打开任务", running: "正在保存所选项目…", saved: "已保存", partial: "部分所选项目需要处理",
  takeover: "验证后接管所选已启用日程。只有 Joko 就绪后才会暂停原日程。", deferred: "先保存内容。需要时从 Partner 任务继续验证与日程接管。",
  conflict: "每组冲突账户请选择一个。", dependency: "尚未选择所需连接。", paused: "已暂停", details: "详情",
  unknown: "请求可能已受理，请先检查已保存状态再重试。", absent: "节点确认此请求尚未保存，可以重新选择来源。", reset: "重新选择来源",
  failed: "导入尚未完成，已保存项目与原请求均已保留。", offline: "连接当前节点后可导入。", personality: "身份", memory: "记忆", skills: "技能", connections: "连接", automations: "日程",
  copied: "已保存", verified: "已验证", active: "已激活", attention: "需要处理", setup: "已保存，设置待继续", changed: "来源或 Partner 已改变，请刷新后继续。",
  mapping: "来源模型或工具策略需要映射，可在 Partner 任务中选择采用当前设置。", budget: "来源超出支持的导入预算。", private: "此原件需从 Partner 任务私密访问。",
};
const tw: typeof en = { ...zh, title: "匯入本機 Agent", empty: "目前節點沒有找到支援的本機 Agent。", name: "Partner 名稱", back: "返回", close: "關閉",
  selectAll: "全選", search: "搜尋項目", previous: "上一頁", next: "下一頁", submit: "儲存 Partner", retry: "重試未完成項目", refresh: "檢查狀態", continueSetup: "驗證並繼續設定",
  open: "開啟任務", running: "正在儲存所選項目…", saved: "已儲存", partial: "部分所選項目需要處理", takeover: "驗證後接管所選已啟用排程。只有 Joko 就緒後才會暫停原排程。",
  deferred: "先儲存內容。需要時從 Partner 任務繼續驗證與排程接管。", conflict: "每組衝突帳戶請選擇一個。", dependency: "尚未選擇所需連線。", paused: "已暫停", details: "詳情",
  unknown: "請求可能已受理，請先檢查已儲存狀態再重試。", absent: "節點確認此請求尚未儲存，可以重新選擇來源。", reset: "重新選擇來源", failed: "匯入尚未完成，已儲存項目與原請求均已保留。",
  offline: "連線目前節點後可匯入。", personality: "身分", memory: "記憶", skills: "技能", connections: "連線", automations: "排程", copied: "已儲存", verified: "已驗證", active: "已啟用", attention: "需要處理",
  setup: "已儲存，設定待繼續", changed: "來源或 Partner 已改變，請重新整理後繼續。", mapping: "來源模型或工具策略需要對應，可在 Partner 任務中選擇採用目前設定。", budget: "來源超出支援的匯入預算。", private: "此原件需從 Partner 任務私密存取。" };
export function partnerImportMessages(locale: string): typeof en { return locale === "zh-TW" ? tw : locale.startsWith("zh") ? zh : en; }
export function importCategoryLabel(category: PartnerImportCategory, m: typeof en): string {
  return ({ [PartnerImportCategory.PERSONALITY]: m.personality, [PartnerImportCategory.MEMORY]: m.memory,
    [PartnerImportCategory.SKILLS]: m.skills, [PartnerImportCategory.CONNECTIONS]: m.connections, [PartnerImportCategory.AUTOMATIONS]: m.automations } as Record<number, string>)[category] ?? m.details;
}
export function importCheckLabel(status: PartnerImportCheckStatus, m: typeof en): string {
  return ({ [PartnerImportCheckStatus.COPIED]: m.copied, [PartnerImportCheckStatus.VERIFIED]: m.verified, [PartnerImportCheckStatus.TAKEN_OVER]: m.active,
    [PartnerImportCheckStatus.PAUSED]: m.paused, [PartnerImportCheckStatus.NEEDS_ATTENTION]: m.attention } as Record<number, string>)[status] ?? m.attention;
}
export function importReasonLabel(reason: string | undefined, m: typeof en): string {
  if (reason === "IMPORT_SETUP_DEFERRED") return m.setup;
  if (reason?.includes("NEEDS_MAPPING")) return m.mapping;
  if (reason?.includes("CHANGED") || reason === "PREVIEW_EXPIRED") return m.changed;
  if (reason?.includes("TOO_LARGE") || reason?.includes("TOO_MANY")) return m.budget;
  if (reason?.includes("PRIVATE_ACCESS")) return m.private;
  return m.failed;
}
