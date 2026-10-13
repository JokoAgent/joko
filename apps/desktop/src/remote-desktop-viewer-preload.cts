import type { DesktopRemoteDesktopViewerApi, DesktopRemoteDesktopViewerState, DesktopRemoteDesktopViewerCredentialAction } from "@joko/contracts";
import type { IpcRendererEvent } from "electron";
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
const PREFIX = "joko:remote-desktop-viewer:";
const invoke = (name: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(PREFIX + name, ...args);
const api: DesktopRemoteDesktopViewerApi = Object.freeze({
  platform: process.platform,
  state: () => invoke("state"),
  ready: (generation: number) => invoke("ready", generation),
  request: (generation: number, method: string, bytes: Uint8Array) => invoke("request", generation, method, bytes),
  clipboard: (generation: number, action: "copy" | "paste") => invoke("clipboard", generation, action),
  retryClipboardSync: (generation: number) => invoke("retry-clipboard-sync", generation),
  credential: (generation: number, action: DesktopRemoteDesktopViewerCredentialAction, enabled?: boolean) => invoke("credential", generation, action, enabled),
  preferences: (generation: number, patch?: { readonly audio?: boolean; readonly hostMute?: boolean; readonly lockOnExit?: boolean; readonly clipboardSync?: boolean; readonly privacyScreen?: boolean }) => invoke("preferences", generation, patch),
  resize: (generation: number, width: number, height: number) => invoke("resize", generation, width, height),
  close: (generation: number) => invoke("close", generation),
  minimize: () => invoke("minimize"), fullscreen: () => invoke("fullscreen"),
  onState: (listener: (state: DesktopRemoteDesktopViewerState) => void) => {
    const wrapped = (_event: IpcRendererEvent, state: DesktopRemoteDesktopViewerState): void => listener(state);
    ipcRenderer.on(PREFIX + "state", wrapped); return () => ipcRenderer.removeListener(PREFIX + "state", wrapped);
  },
  onCloseRequested: (listener: (generation: number) => void) => {
    const wrapped = (_event: IpcRendererEvent, generation: number): void => listener(generation);
    ipcRenderer.on(PREFIX + "close-requested", wrapped); return () => ipcRenderer.removeListener(PREFIX + "close-requested", wrapped);
  }
});
contextBridge.exposeInMainWorld("jokoRemoteDesktopViewer", api);
