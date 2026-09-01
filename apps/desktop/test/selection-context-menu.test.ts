import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";

import { DESKTOP_CHANNELS } from "../src/channels.js";
import {
  buildEditableContextMenuTemplate,
  buildSelectionContextMenuTemplate,
  buildSelectionSearchUrl,
  frameSelectionSupportsAddToChat,
  installSelectionContextMenu,
  setSelectionContextMenuLocale
} from "../src/selection-context-menu.js";

const editFlags = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: true
} as ContextMenuParams["editFlags"];

describe("selection context menu", () => {
  it("builds the selection menu shape and localized product action", () => {
    const template = buildSelectionContextMenuTemplate("win32", "zh-CN", {
      canAddToChat: true,
      editFlags,
      selectionText: "selected words"
    }, {
      addToChat: vi.fn(),
      lookUp: vi.fn(),
      searchWeb: vi.fn()
    });

    expect(template.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      "copy",
      "添加到对话",
      "separator",
      "在网页中搜索“selected words”"
    ]);
    expect(template[0]?.label).toBe("复制");
    expect(template.some((item) => item.role === "reload" || item.role === "toggleDevTools")).toBe(false);
  });

  it("omits Add to chat outside an explicit quote context", () => {
    const template = buildSelectionContextMenuTemplate("darwin", "en", {
      canAddToChat: false,
      editFlags,
      selectionText: "selected words"
    }, {
      addToChat: vi.fn(),
      lookUp: vi.fn(),
      searchWeb: vi.fn()
    });

    expect(template.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      "copy",
      "separator",
      "Look Up “selected words”"
    ]);
  });

  it("provides the native editable command set using Chromium enablement", () => {
    const template = buildEditableContextMenuTemplate("win32", "en", {
      editFlags: { ...editFlags, canUndo: false, canPaste: false },
      selectionText: "word"
    }, { lookUp: vi.fn(), searchWeb: vi.fn() });

    expect(template.map((item) => item.role ?? item.type)).toEqual([
      "undo",
      "redo",
      "separator",
      "cut",
      "copy",
      "paste",
      "pasteAndMatchStyle",
      "separator",
      "selectAll",
      "separator",
      undefined
    ]);
    expect(template.find((item) => item.role === "undo")?.enabled).toBe(false);
    expect(template.find((item) => item.role === "paste")?.enabled).toBe(false);
    expect(template.find((item) => item.role === "pasteAndMatchStyle")?.enabled).toBe(false);
  });

  it("fails closed when the renderer cannot confirm one quote context", async () => {
    await expect(frameSelectionSupportsAddToChat(null)).resolves.toBe(false);
    await expect(frameSelectionSupportsAddToChat({
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => true)
    })).resolves.toBe(true);
    await expect(frameSelectionSupportsAddToChat({
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => { throw new Error("gone"); })
    })).resolves.toBe(false);
  });

  it("bounds web-search queries", () => {
    expect(buildSelectionSearchUrl(" a & b ")).toBe("https://www.bing.com/search?q=a%20%26%20b");
    const encoded = buildSelectionSearchUrl("x".repeat(2_500)).split("?q=")[1] ?? "";
    expect(decodeURIComponent(encoded)).toHaveLength(2_000);
  });

  it("sends only an add command back to the invoking main frame", async () => {
    let contextMenuListener: ((event: unknown, params: ContextMenuParams) => void) | undefined;
    let menuTemplate: readonly MenuItemConstructorOptions[] = [];
    const send = vi.fn();
    const frame = {
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => true),
      send
    };
    const webContents = {
      mainFrame: frame,
      on: vi.fn((event: string, listener: (event: unknown, params: ContextMenuParams) => void) => {
        if (event === "context-menu") contextMenuListener = listener;
      }),
      showDefinitionForSelection: vi.fn()
    };
    const window = {
      webContents,
      isDestroyed: () => false
    } as unknown as BrowserWindow;
    const popup = vi.fn();
    setSelectionContextMenuLocale("en");
    installSelectionContextMenu(window, {
      platform: "win32",
      systemLocale: () => "zh-CN",
      buildMenu: (template) => {
        menuTemplate = template;
        return { popup };
      },
      openExternal: vi.fn(async () => undefined)
    });

    expect(contextMenuListener).toBeTypeOf("function");
    contextMenuListener?.({}, {
      editFlags,
      selectionText: "secret selection",
      isEditable: false,
      frame,
      x: 20,
      y: 30
    } as unknown as ContextMenuParams);
    await vi.waitFor(() => expect(popup).toHaveBeenCalledTimes(1));
    const addToChat = menuTemplate.find((item) => item.label === "Add to chat");
    expect(addToChat).toBeDefined();
    (addToChat?.click as (() => void) | undefined)?.();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(DESKTOP_CHANNELS.selectionContextMenuAddToChat);
  });

});
