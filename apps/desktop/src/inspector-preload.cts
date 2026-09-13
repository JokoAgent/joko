const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

// This preload belongs only to the detached Inspector. It intentionally has
// no credential, filesystem, network, discovery, notification, or external
// navigation bridge. The Inspector UI is a React portal owned by the trusted
// main renderer. The selection callback is receive-only and carries no text;
// the portal re-reads and validates the live selection in this document.
const INSPECTOR_WINDOW_CHANNELS = {
  ready: "joko:inspector-window:ready",
  minimize: "joko:inspector-window:minimize",
  toggleMaximize: "joko:inspector-window:toggle-maximize",
  close: "joko:inspector-window:close",
  selectionContextMenuAddToChat: "joko:selection-context-menu:add-to-chat"
} as const;

contextBridge.exposeInMainWorld("jokoInspectorDesktop", Object.freeze({
  platform: process.platform,
  window: Object.freeze({
    ready: (): Promise<void> => ipcRenderer.invoke(INSPECTOR_WINDOW_CHANNELS.ready),
    minimize: (): Promise<void> => ipcRenderer.invoke(INSPECTOR_WINDOW_CHANNELS.minimize),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(INSPECTOR_WINDOW_CHANNELS.toggleMaximize),
    close: (): Promise<void> => ipcRenderer.invoke(INSPECTOR_WINDOW_CHANNELS.close)
  }),
  selectionContextMenu: Object.freeze({
    onAddToChat: (listener: () => void): (() => void) => {
      const wrapped = (): void => listener();
      ipcRenderer.on(INSPECTOR_WINDOW_CHANNELS.selectionContextMenuAddToChat, wrapped);
      return () => ipcRenderer.removeListener(INSPECTOR_WINDOW_CHANNELS.selectionContextMenuAddToChat, wrapped);
    }
  })
}));
