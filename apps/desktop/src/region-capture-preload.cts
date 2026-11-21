import { contextBridge, ipcRenderer } from "electron";

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("jokoRegionCapture", Object.freeze({
    read: () => ipcRenderer.invoke("joko:region-capture:read"),
    select: (rectangle: { left: number; top: number; right: number; bottom: number }) =>
      ipcRenderer.invoke("joko:region-capture:select", rectangle),
    listWindows: () => ipcRenderer.invoke("joko:region-capture:list-windows"),
    selectWindow: (id: string) => ipcRenderer.invoke("joko:region-capture:select-window", id),
    action: (name: "copy" | "save" | "attach" | "pin", bytes: Uint8Array) =>
      ipcRenderer.invoke("joko:region-capture:action", name, bytes),
    cancel: () => ipcRenderer.invoke("joko:region-capture:cancel")
  }));
}
