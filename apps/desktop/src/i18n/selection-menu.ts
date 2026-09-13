type MenuLocale = "en" | "zh-CN";

export const EDIT_LABELS = {
  en: {
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    pasteAsPlainText: "Paste and Match Style",
    selectAll: "Select All"
  },
  "zh-CN": {
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    pasteAsPlainText: "粘贴为纯文本",
    selectAll: "全选"
  }
} as const;

export function resolveMenuLocale(locale: string): MenuLocale {
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function selectionActionLabel(
  action: "addToChat" | "copy" | "lookUp" | "searchWeb",
  locale: string,
  preview: string
): string {
  const resolvedLocale = resolveMenuLocale(locale);
  if (action === "addToChat") return resolvedLocale === "zh-CN" ? "添加到对话" : "Add to chat";
  if (action === "copy") return EDIT_LABELS[resolvedLocale].copy;
  if (action === "lookUp") return resolvedLocale === "zh-CN" ? `查询“${preview}”` : `Look Up “${preview}”`;
  return resolvedLocale === "zh-CN"
    ? `在网页中搜索“${preview}”`
    : `Search the web for “${preview}”`;
}
