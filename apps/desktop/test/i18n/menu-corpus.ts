export const APPLICATION_MENU_LABELS = {
  simplified: { file: "文件", view: "显示", sidebar: "切换侧边栏" },
  traditional: { view: "顯示方式" },
  japanese: { view: "表示" }
} as const;

export const SELECTION_MENU_LABELS = {
  addToChat: "添加到对话",
  searchSelectedWords: "在网页中搜索“selected words”",
  copy: "复制"
} as const;

export const TRAY_MENU_CASES = [
  ["en", false, "Open Joko", "Quit Joko"],
  ["en", true, "Open Joko", "Quit Joko and local Orchestrator"],
  ["zh-CN", false, "打开 Joko", "退出 Joko"],
  ["zh-CN", true, "打开 Joko", "退出 Joko 和本地 Orchestrator"],
  ["en-XA", false, "［Öpën Jõkõ··］", "［Qüït Jõkõ··］"],
  ["en-XA", true, "［Öpën Jõkõ··］", "［Qüït Jõkõ ànd lõcàl Örchëstràtõr··］"]
] as const;
