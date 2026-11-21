const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("jokoRegionCapture", Object.freeze({
    read: () => ipcRenderer.invoke("joko:region-capture:read"),
    select: (rectangle: { left: number; top: number; right: number; bottom: number }) =>
      ipcRenderer.invoke("joko:region-capture:select", rectangle),
    listWindows: () => ipcRenderer.invoke("joko:region-capture:list-windows"),
    selectWindow: (id: string) => ipcRenderer.invoke("joko:region-capture:select-window", id),
    action: (name: "copy" | "save" | "attach" | "pin" | "translate" | "explain" | "extract", bytes: Uint8Array, language?: string) =>
      ipcRenderer.invoke("joko:region-capture:action", name, bytes, language),
    startLive: (mode: "scroll" | "gif" | "video", microphone: boolean, systemAudio: boolean) =>
      ipcRenderer.invoke("joko:region-capture:live:start", mode, microphone, systemAudio),
    showLive: () => ipcRenderer.invoke("joko:region-capture:live:show"),
    endLive: (keepOutput: boolean) => ipcRenderer.invoke("joko:region-capture:live:end", keepOutput),
    recordingAction: (name: "copy" | "save", bytes: Uint8Array) =>
      ipcRenderer.invoke("joko:region-capture:recording:action", name, bytes),
    onShortcutStop: (listener: () => void) => {
      const receive = () => listener();
      ipcRenderer.on("joko:region-capture:live:stop", receive);
      return () => { ipcRenderer.removeListener("joko:region-capture:live:stop", receive); };
    },
    cancel: () => ipcRenderer.invoke("joko:region-capture:cancel")
  }));
}
