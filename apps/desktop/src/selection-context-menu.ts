import type {
  BrowserWindow,
  ContextMenuParams,
  MenuItemConstructorOptions,
  WebFrameMain
} from "electron";

import { DESKTOP_CHANNELS, type DesktopLocale } from "./channels.js";

const SEARCH_URL = "https://www.bing.com/search?q=";
const LABEL_PREVIEW_CHARACTERS = 48;
const SEARCH_QUERY_MAXIMUM_CHARACTERS = 2_000;

type SupportedPlatform = "darwin" | "win32";
type MenuLocale = "en" | "zh-CN";

let currentLocale: DesktopLocale | undefined;

interface SelectionMenuActions {
  readonly addToChat: () => void;
  readonly lookUp: () => void;
  readonly searchWeb: () => void;
}

interface ContextMenuDependencies {
  readonly platform: NodeJS.Platform;
  readonly systemLocale: () => string;
  readonly buildMenu: (template: readonly MenuItemConstructorOptions[]) => {
    popup(options: { readonly window: BrowserWindow; readonly x: number; readonly y: number }): void;
  };
  readonly openExternal: (url: string) => Promise<unknown>;
}

const QUOTE_CONTEXT_QUERY = `(() => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return false;
  const elementFor = (node) => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const anchorContext = elementFor(selection.anchorNode)?.closest('[data-selection-quote-context]');
  const focusContext = elementFor(selection.focusNode)?.closest('[data-selection-quote-context]');
  return Boolean(anchorContext && anchorContext === focusContext);
})()`;

const EDIT_LABELS = {
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

function resolveMenuLocale(locale: string): MenuLocale {
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function compactSelectionLabel(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > LABEL_PREVIEW_CHARACTERS
    ? `${compact.slice(0, LABEL_PREVIEW_CHARACTERS)}…`
    : compact;
}

function localizedActionLabel(
  action: "addToChat" | "copy" | "lookUp" | "searchWeb",
  locale: string,
  selectionText: string
): string {
  const resolvedLocale = resolveMenuLocale(locale);
  const preview = compactSelectionLabel(selectionText);
  if (action === "addToChat") return resolvedLocale === "zh-CN" ? "添加到对话" : "Add to chat";
  if (action === "copy") return EDIT_LABELS[resolvedLocale].copy;
  if (action === "lookUp") return resolvedLocale === "zh-CN" ? `查询“${preview}”` : `Look Up “${preview}”`;
  return resolvedLocale === "zh-CN"
    ? `在网页中搜索“${preview}”`
    : `Search the web for “${preview}”`;
}

export function setSelectionContextMenuLocale(locale: DesktopLocale): void {
  currentLocale = locale;
}

export function buildSelectionSearchUrl(selectionText: string): string {
  const query = selectionText.trim().slice(0, SEARCH_QUERY_MAXIMUM_CHARACTERS);
  return `${SEARCH_URL}${encodeURIComponent(query)}`;
}

export function buildSelectionContextMenuTemplate(
  platform: SupportedPlatform,
  locale: string,
  params: Pick<ContextMenuParams, "editFlags" | "selectionText"> & { readonly canAddToChat: boolean },
  actions: SelectionMenuActions
): MenuItemConstructorOptions[] {
  const copy: MenuItemConstructorOptions = {
    role: "copy",
    label: localizedActionLabel("copy", locale, params.selectionText),
    enabled: params.editFlags.canCopy
  };
  const addToChat: MenuItemConstructorOptions[] = params.canAddToChat
    ? [{ label: localizedActionLabel("addToChat", locale, params.selectionText), click: actions.addToChat }]
    : [];
  const platformAction: MenuItemConstructorOptions = platform === "darwin"
    ? { label: localizedActionLabel("lookUp", locale, params.selectionText), click: actions.lookUp }
    : { label: localizedActionLabel("searchWeb", locale, params.selectionText), click: actions.searchWeb };
  return [copy, ...addToChat, { type: "separator" }, platformAction];
}

export function buildEditableContextMenuTemplate(
  platform: SupportedPlatform,
  locale: string,
  params: Pick<ContextMenuParams, "editFlags" | "selectionText">,
  actions: Pick<SelectionMenuActions, "lookUp" | "searchWeb">
): MenuItemConstructorOptions[] {
  const labels = EDIT_LABELS[resolveMenuLocale(locale)];
  const { editFlags } = params;
  const template: MenuItemConstructorOptions[] = [
    { role: "undo", label: labels.undo, enabled: editFlags.canUndo },
    { role: "redo", label: labels.redo, enabled: editFlags.canRedo },
    { type: "separator" },
    { role: "cut", label: labels.cut, enabled: editFlags.canCut },
    { role: "copy", label: labels.copy, enabled: editFlags.canCopy },
    { role: "paste", label: labels.paste, enabled: editFlags.canPaste }
  ];
  if (editFlags.canEditRichly) {
    template.push({
      role: "pasteAndMatchStyle",
      label: labels.pasteAsPlainText,
      enabled: editFlags.canPaste
    });
  }
  template.push(
    { type: "separator" },
    { role: "selectAll", label: labels.selectAll, enabled: editFlags.canSelectAll }
  );
  const selectionText = params.selectionText.trim();
  if (selectionText) {
    template.push(
      { type: "separator" },
      platform === "darwin"
        ? { label: localizedActionLabel("lookUp", locale, selectionText), click: actions.lookUp }
        : { label: localizedActionLabel("searchWeb", locale, selectionText), click: actions.searchWeb }
    );
  }
  return template;
}

export async function frameSelectionSupportsAddToChat(
  frame: Pick<WebFrameMain, "executeJavaScript" | "isDestroyed"> | null
): Promise<boolean> {
  if (frame === null || frame.isDestroyed()) return false;
  try {
    return await frame.executeJavaScript(QUOTE_CONTEXT_QUERY) === true;
  } catch {
    return false;
  }
}

export function installSelectionContextMenu(
  window: BrowserWindow,
  dependencies: ContextMenuDependencies
): void {
  window.webContents.on("context-menu", (_event, params) => {
    void showSelectionContextMenu(window, params, dependencies);
  });
}

async function showSelectionContextMenu(
  window: BrowserWindow,
  params: ContextMenuParams,
  dependencies: ContextMenuDependencies
): Promise<void> {
  if (dependencies.platform !== "darwin" && dependencies.platform !== "win32") return;
  const platform = dependencies.platform;
  const locale = currentLocale ?? dependencies.systemLocale();
  if (params.isEditable) {
    const template = buildEditableContextMenuTemplate(platform, locale, params, {
      lookUp: () => {
        if (!window.isDestroyed()) window.webContents.showDefinitionForSelection();
      },
      searchWeb: () => {
        void dependencies.openExternal(buildSelectionSearchUrl(params.selectionText));
      }
    });
    dependencies.buildMenu(template).popup({ window, x: params.x, y: params.y });
    return;
  }

  const selectionText = params.selectionText.trim();
  if (!selectionText) return;
  const sourceFrame = params.frame;
  const isMainFrame = sourceFrame !== null && sourceFrame === window.webContents.mainFrame;
  const canAddToChat = isMainFrame && await frameSelectionSupportsAddToChat(sourceFrame);
  if (window.isDestroyed()) return;
  const template = buildSelectionContextMenuTemplate(platform, locale, {
    canAddToChat,
    editFlags: params.editFlags,
    selectionText
  }, {
    addToChat: () => {
      if (sourceFrame !== null && !sourceFrame.isDestroyed()) {
        sourceFrame.send(DESKTOP_CHANNELS.selectionContextMenuAddToChat);
      }
    },
    lookUp: () => {
      if (!window.isDestroyed()) window.webContents.showDefinitionForSelection();
    },
    searchWeb: () => {
      void dependencies.openExternal(buildSelectionSearchUrl(selectionText));
    }
  });
  dependencies.buildMenu(template).popup({ window, x: params.x, y: params.y });
}
