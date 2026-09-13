import type {
  DesktopDiscoveredNode,
  DesktopManagedOrchestratorConnection,
  DesktopManagedOrchestratorStatus,
  DesktopWindowInteractionSettings
} from "./channels.js";
import type { IpcRendererEvent } from "electron";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

// This secondary window needs service bootstrap plus native frame controls,
// but no file, notification, media, update, or task-window authority.
const CHANNELS = Object.freeze({
  windowMinimize: "joko:window:minimize",
  windowToggleMaximize: "joko:window:toggle-maximize",
  windowSetZoomFactor: "joko:window:set-zoom-factor",
  windowClose: "joko:window:close",
  windowInteractionGet: "joko:window-interaction:get",
  windowInteractionSet: "joko:window-interaction:set",
  windowInteractionChanged: "joko:window-interaction:changed",
  appGetInfo: "joko:app:get-info",
  traySetIcon: "joko:tray:set-icon",
  credentialGet: "joko:credential:get",
  credentialSet: "joko:credential:set",
  credentialDelete: "joko:credential:delete",
  discoveryScan: "joko:discovery:scan",
  managedOrchestratorGetConnection: "joko:managed-orchestrator:get-connection",
  managedOrchestratorGetStatus: "joko:managed-orchestrator:get-status",
  managedOrchestratorRetry: "joko:managed-orchestrator:retry",
  managedOrchestratorAdoptConnection: "joko:managed-orchestrator:adopt-connection",
  managedOrchestratorCompleteLogout: "joko:managed-orchestrator:complete-logout"
});

const api = Object.freeze({
  platform: process.platform,
  capabilities: Object.freeze([
    "app.info",
    "appearance.zoom",
    "window.activationClick"
  ] as const),
  appInfo: Object.freeze({
    get: () => ipcRenderer.invoke(CHANNELS.appGetInfo)
  }),
  window: Object.freeze({
    minimize: (): Promise<void> => ipcRenderer.invoke(CHANNELS.windowMinimize),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.windowToggleMaximize),
    setZoomFactor: (zoomFactor: number): Promise<void> => {
      if (!Number.isFinite(zoomFactor)) return Promise.reject(new TypeError("Desktop zoom factor is invalid."));
      return ipcRenderer.invoke(CHANNELS.windowSetZoomFactor, zoomFactor);
    },
    close: (): Promise<void> => ipcRenderer.invoke(CHANNELS.windowClose)
  }),
  windowInteraction: Object.freeze({
    get: (): Promise<DesktopWindowInteractionSettings> =>
      ipcRenderer.invoke(CHANNELS.windowInteractionGet).then(parseWindowInteractionSettings),
    setSwallowActivationClick: (enabled: boolean): Promise<DesktopWindowInteractionSettings> => {
      if (typeof enabled !== "boolean") return Promise.reject(new TypeError("Desktop activation-click setting is invalid."));
      return ipcRenderer.invoke(CHANNELS.windowInteractionSet, enabled).then(parseWindowInteractionSettings);
    },
    onChanged: (listener: (settings: DesktopWindowInteractionSettings) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Window-interaction listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        try { listener(parseWindowInteractionSettings(value)); } catch { /* A later get remains authoritative. */ }
      };
      ipcRenderer.on(CHANNELS.windowInteractionChanged, wrapped);
      return () => ipcRenderer.removeListener(CHANNELS.windowInteractionChanged, wrapped);
    }
  }),
  setTrayIcon: (dataUrl: string): Promise<void> => {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
      return Promise.reject(new TypeError("Tray icon is invalid."));
    }
    return ipcRenderer.invoke(CHANNELS.traySetIcon, dataUrl);
  },
  discovery: Object.freeze({
    scan: (): Promise<readonly DesktopDiscoveredNode[]> => ipcRenderer.invoke(CHANNELS.discoveryScan)
  }),
  managedOrchestrator: Object.freeze({
    getConnection: (): Promise<DesktopManagedOrchestratorConnection | undefined> =>
      ipcRenderer.invoke(CHANNELS.managedOrchestratorGetConnection),
    getStatus: (): Promise<DesktopManagedOrchestratorStatus> => ipcRenderer.invoke(CHANNELS.managedOrchestratorGetStatus),
    retry: (): Promise<DesktopManagedOrchestratorStatus> => ipcRenderer.invoke(CHANNELS.managedOrchestratorRetry),
    adoptConnection: (connection: DesktopManagedOrchestratorConnection): Promise<DesktopManagedOrchestratorStatus> =>
      ipcRenderer.invoke(CHANNELS.managedOrchestratorAdoptConnection, connection),
    completeLogout: (): Promise<DesktopManagedOrchestratorStatus> =>
      ipcRenderer.invoke(CHANNELS.managedOrchestratorCompleteLogout)
  }),
  credentials: Object.freeze({
    get: (profileId: string): Promise<string | undefined> => {
      if (!validProfileId(profileId)) return Promise.reject(new TypeError("Profile identity is invalid."));
      return ipcRenderer.invoke(CHANNELS.credentialGet, profileId);
    },
    set: (profileId: string, secret: string): Promise<void> => {
      if (!validProfileId(profileId) || !validSecret(secret)) {
        return Promise.reject(new TypeError("Protected connection input is invalid."));
      }
      return ipcRenderer.invoke(CHANNELS.credentialSet, profileId, secret);
    },
    delete: (profileId: string): Promise<void> => {
      if (!validProfileId(profileId)) return Promise.reject(new TypeError("Profile identity is invalid."));
      return ipcRenderer.invoke(CHANNELS.credentialDelete, profileId);
    }
  })
});

contextBridge.exposeInMainWorld("jokoDesktop", api);

function parseWindowInteractionSettings(value: unknown): DesktopWindowInteractionSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).join(",") !== "swallowActivationClick" ||
    typeof (value as Record<string, unknown>)["swallowActivationClick"] !== "boolean") {
    throw new TypeError("Desktop window-interaction settings are invalid.");
  }
  return Object.freeze({
    swallowActivationClick: (value as DesktopWindowInteractionSettings).swallowActivationClick
  });
}

function validProfileId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
}

function validSecret(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && new TextEncoder().encode(value).byteLength <= 64 * 1024;
}
