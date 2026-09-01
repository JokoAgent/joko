import type {
  DesktopAppInfo,
  DesktopAttentionKey,
  DesktopApplicationMenuCommand,
  DesktopApplicationMenuConfigurationPatch,
  DesktopDiscoveredNode,
  DesktopDeepLinkNavigation,
  DesktopDeepLinkSettingsSection,
  DesktopFile,
  DesktopGlobalVoiceAccessibilitySnapshot,
  DesktopGlobalVoiceInputMonitoringSnapshot,
  DesktopGlobalVoiceShortcutRecoverySnapshot,
  DesktopGlobalVoiceCommand,
  DesktopGlobalVoiceCommitRequest,
  DesktopGlobalVoiceShortcutPreference,
  DesktopGlobalVoiceShortcutResult,
  DesktopGlobalVoiceStatus,
  DesktopKeepAwakeSettings,
  DesktopLocale,
  DesktopManagedOrchestratorConnection,
  DesktopManagedOrchestratorStatus,
  DesktopMicrophonePermissionSnapshot,
  DesktopMicrophoneReleaseReason,
  DesktopNativeTaskStatusAction,
  DesktopNativeTaskStatusDisplay,
  DesktopNativeTaskStatusSoundChoice,
  DesktopNativeTaskStatusSoundFileSelection,
  DesktopNativeTaskStatusSoundId,
  DesktopNativeTaskStatusSettings,
  DesktopNativeTaskStatusSnapshot,
  DesktopNotification,
  DesktopPageSearchRequest,
  DesktopPageSearchResult,
  DesktopPageSearchStopAction,
  DesktopProviderModelRefreshLifecycleHint,
  DesktopSaveFileRequest,
  DesktopRuntimeProcessMonitorOpenResult,
  DesktopSessionDragPreviewRequest,
  DesktopSessionWindowDropResult,
  DesktopSessionWindowOpenResult,
  DesktopUpdateAutoRelaunchSettings,
  DesktopUpdateCheckResult,
  DesktopUpdateChannelProbeResult,
  DesktopUpdateChannelSettings,
  DesktopUpdateRelaunchRequest,
  DesktopUpdateRelaunchResult,
  DesktopUpdateStatus,
  DesktopWindowInteractionSettings
} from "./channels.js";
import type { IpcRendererEvent } from "electron";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

// Keep the sandbox preload self-contained at runtime: sandboxed preloads use
// Electron's restricted CommonJS loader and cannot require the ESM channels
// module. The `satisfies` check makes channel drift a compile-time failure.
const DESKTOP_CHANNELS = {
  windowMinimize: "joko:window:minimize",
  windowToggleMaximize: "joko:window:toggle-maximize",
  windowSetZoomFactor: "joko:window:set-zoom-factor",
  windowClose: "joko:window:close",
  sessionWindowOpen: "joko:session-window:open",
  sessionDragPreviewBegin: "joko:session-drag-preview:begin",
  sessionDragPreviewEnd: "joko:session-drag-preview:end",
  sessionWindowOpenIfDroppedOutside: "joko:session-window:open-if-dropped-outside",
  runtimeProcessMonitorOpen: "joko:runtime-process-monitor:open",
  layoutReset: "joko:layout:reset",
  layoutResetBroadcast: "joko:layout:reset-broadcast",
  windowInteractionGet: "joko:window-interaction:get",
  windowInteractionSet: "joko:window-interaction:set",
  windowInteractionChanged: "joko:window-interaction:changed",
  pageSearchStart: "joko:page-search:start",
  pageSearchStop: "joko:page-search:stop",
  pageSearchResult: "joko:page-search:result",
  appGetInfo: "joko:app:get-info",
  applicationMenuCommand: "joko:application-menu:command",
  applicationMenuConfigure: "joko:application-menu:configure",
  selectionContextMenuAddToChat: "joko:selection-context-menu:add-to-chat",
  selectionContextMenuSetLocale: "joko:selection-context-menu:set-locale",
  inspectorWindowReady: "joko:inspector-window:ready",
  inspectorWindowMinimize: "joko:inspector-window:minimize",
  inspectorWindowToggleMaximize: "joko:inspector-window:toggle-maximize",
  inspectorWindowClose: "joko:inspector-window:close",
  inspectorWindowClosed: "joko:inspector-window:closed",
  traySetIcon: "joko:tray:set-icon",
  notify: "joko:notify",
  notificationFocusSession: "joko:notification:focus-session",
  attentionMark: "joko:attention:mark",
  attentionClear: "joko:attention:clear",
  nativeTaskStatusGetAvailability: "joko:native-task-status:availability:get",
  nativeTaskStatusGetSettings: "joko:native-task-status:settings:get",
  nativeTaskStatusSetSettings: "joko:native-task-status:settings:set",
  nativeTaskStatusSettingsChanged: "joko:native-task-status:settings:changed",
  nativeTaskStatusGetDisplays: "joko:native-task-status:displays:get",
  nativeTaskStatusPreviewSound: "joko:native-task-status:sound:preview",
  nativeTaskStatusSelectSoundFile: "joko:native-task-status:sound:select-file",
  nativeTaskStatusPublish: "joko:native-task-status:publish",
  nativeTaskStatusSetVisibleSessions: "joko:native-task-status:visible-sessions:set",
  nativeTaskStatusAction: "joko:native-task-status:action",
  keepAwakeGet: "joko:power:keep-awake:get",
  keepAwakeSet: "joko:power:keep-awake:set",
  providerModelRefreshLifecycle: "joko:provider-models:refresh-lifecycle",
  microphoneGetPermission: "joko:microphone:permission:get",
  microphoneOpenSettings: "joko:microphone:settings:open",
  microphoneRelease: "joko:microphone:release",
  globalVoiceSetShortcut: "joko:global-voice:shortcut:set",
  globalVoiceShortcutCaptureStart: "joko:global-voice:shortcut-capture:start",
  globalVoiceShortcutCaptureStop: "joko:global-voice:shortcut-capture:stop",
  globalVoiceShortcutCaptureKeys: "joko:global-voice:shortcut-capture:keys",
  globalVoiceShortcutRecoveryFailed: "joko:global-voice:shortcut:recovery-failed",
  globalVoiceShortcutRecovered: "joko:global-voice:shortcut:recovered",
  globalVoiceConsumeShortcutRecoveryFailure: "joko:global-voice:shortcut:recovery-failure:consume",
  globalVoiceSetMuteSystemAudio: "joko:global-voice:system-audio:set-muted",
  globalVoiceCommand: "joko:global-voice:command",
  globalVoicePublishStatus: "joko:global-voice:status:publish",
  globalVoiceGetStatus: "joko:global-voice:status:get",
  globalVoiceStatus: "joko:global-voice:status",
  globalVoiceCommit: "joko:global-voice:commit",
  globalVoiceOverlayAction: "joko:global-voice:overlay-action",
  globalVoiceGetAccessibility: "joko:global-voice:accessibility:get",
  globalVoiceOpenAccessibility: "joko:global-voice:accessibility:open",
  globalVoiceGetInputMonitoring: "joko:global-voice:input-monitoring:get",
  globalVoiceOpenInputMonitoring: "joko:global-voice:input-monitoring:open",
  chooseFiles: "joko:files:choose",
  choosePortableSessionFile: "joko:portable-session:choose",
  deepLinkTakePending: "joko:deep-link:take-pending",
  deepLinkNavigate: "joko:deep-link:navigate",
  saveFile: "joko:files:save",
  credentialGet: "joko:credential:get",
  credentialSet: "joko:credential:set",
  credentialDelete: "joko:credential:delete",
  discoveryScan: "joko:discovery:scan",
  managedOrchestratorGetConnection: "joko:managed-orchestrator:get-connection",
  managedOrchestratorGetStatus: "joko:managed-orchestrator:get-status",
  managedOrchestratorRetry: "joko:managed-orchestrator:retry",
  managedOrchestratorAdoptConnection: "joko:managed-orchestrator:adopt-connection",
  managedOrchestratorCompleteLogout: "joko:managed-orchestrator:complete-logout",
  openExternal: "joko:external:open",
  updateGetStatus: "joko:update:get-status",
  updateStatus: "joko:update:status",
  updateCheck: "joko:update:check",
  updateRelaunch: "joko:update:relaunch",
  updateStartupRelaunch: "joko:update:startup-relaunch",
  updateStartupRetry: "joko:update:startup-retry",
  updateAutoRelaunchSettingsGet: "joko:update:auto-relaunch-settings:get",
  updateAutoRelaunchSettingsSet: "joko:update:auto-relaunch-settings:set",
  updateAutoRelaunchSettingsReset: "joko:update:auto-relaunch-settings:reset",
  updateChannelSettingsGet: "joko:update:channel-settings:get",
  updateChannelSettingsSet: "joko:update:channel-settings:set",
  updateChannelSettingsReset: "joko:update:channel-settings:reset",
  updateChannelSettingsChanged: "joko:update:channel-settings:changed",
  updateChannelProbeBeta: "joko:update:channel:probe-beta",
  updateChannelRelaunch: "joko:update:channel:relaunch"
} as const satisfies typeof import("./channels.js").DESKTOP_CHANNELS;

const nativeTaskStatusSupported = ipcRenderer.sendSync(
  DESKTOP_CHANNELS.nativeTaskStatusGetAvailability
) === true;
const attentionBadgeSupported = process.platform === "darwin" || process.platform === "win32";
const desktopCapabilities = Object.freeze([
  "app.info",
  "navigation.deepLinks",
  "app.update",
  "appearance.zoom",
  "application.menu",
  "inspector.detach",
  "layout.reset",
  "microphone.lifecycle",
  "notifications.session",
  "page.search",
  "provider.modelCatalogLifecycle",
  ...(attentionBadgeSupported ? ["attention.badge" as const] : []),
  ...(nativeTaskStatusSupported ? ["native.taskStatus" as const] : []),
  "power.keepAwake",
  "selection.quote.contextMenu",
  "runtime.processMonitorWindow",
  "session.windows",
  "voice.globalDictation",
  "window.activationClick"
] as const);

const desktopApi = Object.freeze({
  platform: process.platform,
  capabilities: desktopCapabilities,
  appInfo: Object.freeze({
    get: (): Promise<DesktopAppInfo> => ipcRenderer.invoke(DESKTOP_CHANNELS.appGetInfo)
  }),
  window: Object.freeze({
    minimize: (): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.windowMinimize),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(DESKTOP_CHANNELS.windowToggleMaximize),
    setZoomFactor: (zoomFactor: number): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.windowSetZoomFactor, zoomFactor),
    close: (): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.windowClose)
  }),
  sessionWindows: Object.freeze({
    open: (sessionId: string): Promise<DesktopSessionWindowOpenResult> => {
      if (!isDesktopNotificationSessionId(sessionId)) return Promise.reject(new TypeError("Task identity is invalid."));
      return ipcRenderer.invoke(DESKTOP_CHANNELS.sessionWindowOpen, sessionId).then(parseDesktopSessionWindowOpenResult);
    },
    beginDragPreview: (request: DesktopSessionDragPreviewRequest): Promise<boolean> => {
      if (!isDesktopSessionDragPreviewRequest(request)) {
        return Promise.reject(new TypeError("Task drag preview request is invalid."));
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.sessionDragPreviewBegin, request).then(parseDesktopBoolean);
    },
    endDragPreview: (gestureId: string): Promise<boolean> => {
      if (!isDesktopSessionDragGestureId(gestureId)) {
        return Promise.reject(new TypeError("Task drag gesture identity is invalid."));
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.sessionDragPreviewEnd, gestureId).then(parseDesktopBoolean);
    },
    openIfDroppedOutside: (gestureId: string): Promise<DesktopSessionWindowDropResult> => {
      if (!isDesktopSessionDragGestureId(gestureId)) {
        return Promise.reject(new TypeError("Task drag gesture identity is invalid."));
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.sessionWindowOpenIfDroppedOutside, gestureId)
        .then(parseDesktopSessionWindowDropResult);
    }
  }),
  runtimeProcessMonitor: Object.freeze({
    open: (): Promise<DesktopRuntimeProcessMonitorOpenResult> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.runtimeProcessMonitorOpen)
        .then(parseDesktopRuntimeProcessMonitorOpenResult)
  }),
  layout: Object.freeze({
    reset: (): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.layoutReset),
    onReset: (listener: () => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Layout reset listener must be a function.");
      const wrapped = (): void => listener();
      ipcRenderer.on(DESKTOP_CHANNELS.layoutResetBroadcast, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.layoutResetBroadcast, wrapped);
    }
  }),
  windowInteraction: Object.freeze({
    get: (): Promise<DesktopWindowInteractionSettings> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.windowInteractionGet).then(parseDesktopWindowInteractionSettings),
    setSwallowActivationClick: (enabled: boolean): Promise<DesktopWindowInteractionSettings> => {
      if (typeof enabled !== "boolean") {
        return Promise.reject(new TypeError("Desktop activation-click setting must be boolean."));
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.windowInteractionSet, enabled)
        .then(parseDesktopWindowInteractionSettings);
    },
    onChanged: (listener: (settings: DesktopWindowInteractionSettings) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Window-interaction listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        try {
          listener(parseDesktopWindowInteractionSettings(value));
        } catch {
          // Ignore malformed host messages; the next get remains authoritative.
        }
      };
      ipcRenderer.on(DESKTOP_CHANNELS.windowInteractionChanged, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.windowInteractionChanged, wrapped);
    }
  }),
  pageSearch: Object.freeze({
    start: (request: DesktopPageSearchRequest): Promise<number> => {
      if (!isDesktopPageSearchRequest(request)) {
        return Promise.reject(new TypeError("Desktop page search request is invalid."));
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.pageSearchStart, request).then(parseDesktopSafeInteger);
    },
    stop: (action: DesktopPageSearchStopAction): Promise<void> => {
      if (!isDesktopPageSearchStopAction(action)) {
        return Promise.reject(new TypeError("Desktop page search stop action is invalid."));
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.pageSearchStop, action).then(() => undefined);
    },
    onResult: (listener: (result: DesktopPageSearchResult) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Desktop page search listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        const result = parseDesktopPageSearchResult(value);
        if (result !== undefined) listener(result);
      };
      ipcRenderer.on(DESKTOP_CHANNELS.pageSearchResult, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.pageSearchResult, wrapped);
    }
  }),
  applicationMenu: Object.freeze({
    configure: (patch: DesktopApplicationMenuConfigurationPatch): Promise<void> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.applicationMenuConfigure, patch),
    onCommand: (listener: (command: DesktopApplicationMenuCommand) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Application-menu listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, command: unknown): void => {
        if (isDesktopApplicationMenuCommand(command)) listener(command);
      };
      ipcRenderer.on(DESKTOP_CHANNELS.applicationMenuCommand, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.applicationMenuCommand, wrapped);
    }
  }),
  inspectorWindow: Object.freeze({
    onClosed: (listener: () => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Inspector window listener must be a function.");
      const wrapped = (): void => listener();
      ipcRenderer.on(DESKTOP_CHANNELS.inspectorWindowClosed, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.inspectorWindowClosed, wrapped);
    }
  }),
  selectionContextMenu: Object.freeze({
    setLocale: (locale: DesktopLocale): Promise<void> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.selectionContextMenuSetLocale, locale),
    onAddToChat: (listener: () => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Selection context-menu listener must be a function.");
      const wrapped = (): void => listener();
      ipcRenderer.on(DESKTOP_CHANNELS.selectionContextMenuAddToChat, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.selectionContextMenuAddToChat, wrapped);
    }
  }),
  setTrayIcon: (dataUrl: string): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.traySetIcon, dataUrl),
  notify: (notification: DesktopNotification): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.notify, notification),
  notifications: Object.freeze({
    onFocusSession: (listener: (sessionId: string) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Desktop notification focus listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        if (isDesktopNotificationSessionId(value)) listener(value);
      };
      ipcRenderer.on(DESKTOP_CHANNELS.notificationFocusSession, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.notificationFocusSession, wrapped);
    }
  }),
  attention: Object.freeze({
    mark: (key: DesktopAttentionKey): Promise<void> => invokeDesktopAttention(
      DESKTOP_CHANNELS.attentionMark,
      key
    ),
    clear: (key: DesktopAttentionKey): Promise<void> => invokeDesktopAttention(
      DESKTOP_CHANNELS.attentionClear,
      key
    )
  }),
  nativeTaskStatus: Object.freeze({
    getSettings: (): Promise<DesktopNativeTaskStatusSettings> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.nativeTaskStatusGetSettings).then(parseDesktopNativeTaskStatusSettings),
    setSettings: (settings: DesktopNativeTaskStatusSettings): Promise<DesktopNativeTaskStatusSettings> => {
      let parsed: DesktopNativeTaskStatusSettings;
      try {
        parsed = parseDesktopNativeTaskStatusSettings(settings);
      } catch (error) {
        return Promise.reject(error);
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.nativeTaskStatusSetSettings, parsed)
        .then(parseDesktopNativeTaskStatusSettings);
    },
    getDisplays: (): Promise<readonly DesktopNativeTaskStatusDisplay[]> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.nativeTaskStatusGetDisplays).then(parseDesktopNativeTaskStatusDisplays),
    previewSound: (sound: DesktopNativeTaskStatusSoundChoice): Promise<void> => {
      let parsed: DesktopNativeTaskStatusSoundChoice;
      try {
        parsed = parseNativeTaskStatusSoundChoice(sound);
      } catch (error) {
        return Promise.reject(error);
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.nativeTaskStatusPreviewSound, parsed).then(() => undefined);
    },
    selectSoundFile: (): Promise<DesktopNativeTaskStatusSoundFileSelection> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.nativeTaskStatusSelectSoundFile).then(parseNativeTaskStatusSoundFileSelection),
    publish: (snapshot: DesktopNativeTaskStatusSnapshot): Promise<void> => {
      let parsed: DesktopNativeTaskStatusSnapshot;
      try {
        parsed = parseDesktopNativeTaskStatusSnapshot(snapshot);
      } catch (error) {
        return Promise.reject(error);
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.nativeTaskStatusPublish, parsed);
    },
    setVisibleSessions: (sessionIds: readonly string[]): Promise<void> => {
      let parsed: readonly string[];
      try {
        parsed = parseNativeTaskStatusVisibleSessionIds(sessionIds);
      } catch (error) {
        return Promise.reject(error);
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.nativeTaskStatusSetVisibleSessions, parsed).then(() => undefined);
    },
    onAction: (listener: (action: DesktopNativeTaskStatusAction) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Native task-status action listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        const action = parseDesktopNativeTaskStatusAction(value);
        if (action !== undefined) listener(action);
      };
      ipcRenderer.on(DESKTOP_CHANNELS.nativeTaskStatusAction, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.nativeTaskStatusAction, wrapped);
    },
    onSettingsChanged: (listener: (settings: DesktopNativeTaskStatusSettings) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Native task-status settings listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        try {
          listener(parseDesktopNativeTaskStatusSettings(value));
        } catch {
          // Ignore malformed host messages; getSettings remains authoritative.
        }
      };
      ipcRenderer.on(DESKTOP_CHANNELS.nativeTaskStatusSettingsChanged, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.nativeTaskStatusSettingsChanged, wrapped);
    }
  }),
  power: Object.freeze({
    getKeepAwake: (): Promise<DesktopKeepAwakeSettings> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.keepAwakeGet).then(parseDesktopKeepAwakeSettings),
    setKeepAwake: (enabled: boolean): Promise<DesktopKeepAwakeSettings> => {
      if (typeof enabled !== "boolean") return Promise.reject(new TypeError("Desktop keep-awake state must be boolean."));
      return ipcRenderer.invoke(DESKTOP_CHANNELS.keepAwakeSet, enabled).then(parseDesktopKeepAwakeSettings);
    }
  }),
  modelCatalog: Object.freeze({
    onRefreshLifecycle: (
      listener: (hint: DesktopProviderModelRefreshLifecycleHint) => void
    ): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Provider model refresh listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        if (value === "system-resume" || value === "screen-unlock" || value === "meaningful-foreground") {
          listener(value);
        }
      };
      ipcRenderer.on(DESKTOP_CHANNELS.providerModelRefreshLifecycle, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.providerModelRefreshLifecycle, wrapped);
    }
  }),
  microphone: Object.freeze({
    getPermission: (): Promise<DesktopMicrophonePermissionSnapshot> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.microphoneGetPermission).then(parseDesktopMicrophonePermissionSnapshot),
    openSettings: (): Promise<boolean> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.microphoneOpenSettings).then(parseDesktopBoolean),
    onRelease: (listener: (reason: DesktopMicrophoneReleaseReason) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Desktop microphone release listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        if (value === "system-suspend" || value === "screen-lock") listener(value);
      };
      ipcRenderer.on(DESKTOP_CHANNELS.microphoneRelease, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.microphoneRelease, wrapped);
    }
  }),
  globalVoice: Object.freeze({
    setShortcut: (preference: DesktopGlobalVoiceShortcutPreference): Promise<DesktopGlobalVoiceShortcutResult> => {
      let parsed: DesktopGlobalVoiceShortcutPreference;
      try {
        parsed = parseDesktopGlobalVoiceShortcutPreference(preference);
      } catch (error) {
        return Promise.reject(error);
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.globalVoiceSetShortcut, parsed)
        .then(parseDesktopGlobalVoiceShortcutResult);
    },
    startShortcutCapture: (): Promise<boolean> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.globalVoiceShortcutCaptureStart).then(parseDesktopBoolean),
    stopShortcutCapture: (): Promise<void> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.globalVoiceShortcutCaptureStop).then(() => undefined),
    onShortcutCaptureKeys: (listener: (keys: readonly string[]) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Shortcut capture listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        const keys = parseDesktopGlobalVoiceShortcutCaptureKeys(value);
        if (keys !== undefined) listener(keys);
      };
      ipcRenderer.on(DESKTOP_CHANNELS.globalVoiceShortcutCaptureKeys, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.globalVoiceShortcutCaptureKeys, wrapped);
    },
    onShortcutRecoveryFailed: (listener: () => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Shortcut recovery listener must be a function.");
      const wrapped = (): void => listener();
      ipcRenderer.on(DESKTOP_CHANNELS.globalVoiceShortcutRecoveryFailed, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.globalVoiceShortcutRecoveryFailed, wrapped);
    },
    onShortcutRecovered: (listener: () => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Shortcut recovery listener must be a function.");
      const wrapped = (): void => listener();
      ipcRenderer.on(DESKTOP_CHANNELS.globalVoiceShortcutRecovered, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.globalVoiceShortcutRecovered, wrapped);
    },
    consumeShortcutRecoveryFailure: (): Promise<DesktopGlobalVoiceShortcutRecoverySnapshot> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.globalVoiceConsumeShortcutRecoveryFailure)
        .then(parseDesktopGlobalVoiceShortcutRecoverySnapshot),
    setMuteSystemAudio: (enabled: boolean): Promise<void> => {
      if (typeof enabled !== "boolean") return Promise.reject(new TypeError("System audio preference must be boolean."));
      return ipcRenderer.invoke(DESKTOP_CHANNELS.globalVoiceSetMuteSystemAudio, enabled).then(() => undefined);
    },
    publishStatus: (status: DesktopGlobalVoiceStatus): Promise<void> => {
      let parsed: DesktopGlobalVoiceStatus;
      try {
        parsed = parseDesktopGlobalVoiceStatus(status);
      } catch (error) {
        return Promise.reject(error);
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.globalVoicePublishStatus, parsed).then(() => undefined);
    },
    commit: (request: DesktopGlobalVoiceCommitRequest): Promise<boolean> => {
      let parsed: DesktopGlobalVoiceCommitRequest;
      try {
        parsed = parseDesktopGlobalVoiceCommitRequest(request);
      } catch (error) {
        return Promise.reject(error);
      }
      return ipcRenderer.invoke(DESKTOP_CHANNELS.globalVoiceCommit, parsed).then(parseDesktopBoolean);
    },
    getAccessibility: (): Promise<DesktopGlobalVoiceAccessibilitySnapshot> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.globalVoiceGetAccessibility).then(parseDesktopGlobalVoiceAccessibilitySnapshot),
    openAccessibility: (): Promise<boolean> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.globalVoiceOpenAccessibility).then(parseDesktopBoolean),
    getInputMonitoring: (): Promise<DesktopGlobalVoiceInputMonitoringSnapshot> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.globalVoiceGetInputMonitoring)
        .then(parseDesktopGlobalVoiceInputMonitoringSnapshot),
    openInputMonitoring: (): Promise<boolean> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.globalVoiceOpenInputMonitoring).then(parseDesktopBoolean),
    onCommand: (listener: (command: DesktopGlobalVoiceCommand) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Global voice command listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        const command = parseDesktopGlobalVoiceCommand(value);
        if (command !== undefined) listener(command);
      };
      ipcRenderer.on(DESKTOP_CHANNELS.globalVoiceCommand, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.globalVoiceCommand, wrapped);
    }
  }),
  chooseFiles: (): Promise<readonly DesktopFile[]> => ipcRenderer.invoke(DESKTOP_CHANNELS.chooseFiles),
  choosePortableSessionFile: (): Promise<DesktopFile | undefined> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.choosePortableSessionFile),
  deepLinks: Object.freeze({
    takePending: (): Promise<DesktopDeepLinkNavigation | undefined> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.deepLinkTakePending).then((value: unknown) =>
        value === undefined ? undefined : parseDesktopDeepLinkNavigation(value)),
    onNavigate: (listener: (navigation: DesktopDeepLinkNavigation) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Desktop deep-link listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        try {
          listener(parseDesktopDeepLinkNavigation(value));
        } catch {
          // Ignore malformed host messages; the pending pull remains authoritative after a reload.
        }
      };
      ipcRenderer.on(DESKTOP_CHANNELS.deepLinkNavigate, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.deepLinkNavigate, wrapped);
    }
  }),
  saveFile: (request: DesktopSaveFileRequest): Promise<boolean> => {
    if (!isDesktopSaveFileRequest(request)) return Promise.reject(new TypeError("The file save request is invalid."));
    return ipcRenderer.invoke(DESKTOP_CHANNELS.saveFile, request).then(parseDesktopBoolean);
  },
  discovery: Object.freeze({
    scan: (): Promise<readonly DesktopDiscoveredNode[]> => ipcRenderer.invoke(DESKTOP_CHANNELS.discoveryScan)
  }),
  managedOrchestrator: Object.freeze({
    getConnection: (): Promise<DesktopManagedOrchestratorConnection | undefined> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.managedOrchestratorGetConnection),
    getStatus: (): Promise<DesktopManagedOrchestratorStatus> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.managedOrchestratorGetStatus),
    retry: (): Promise<DesktopManagedOrchestratorStatus> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.managedOrchestratorRetry),
    adoptConnection: (connection: DesktopManagedOrchestratorConnection): Promise<DesktopManagedOrchestratorStatus> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.managedOrchestratorAdoptConnection, connection),
    completeLogout: (): Promise<DesktopManagedOrchestratorStatus> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.managedOrchestratorCompleteLogout)
  }),
  credentials: Object.freeze({
    get: (profileId: string): Promise<string | undefined> => ipcRenderer.invoke(DESKTOP_CHANNELS.credentialGet, profileId),
    set: (profileId: string, secret: string): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.credentialSet, profileId, secret),
    delete: (profileId: string): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.credentialDelete, profileId)
  }),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.openExternal, url),
  checkForUpdates: (): Promise<DesktopUpdateCheckResult> => ipcRenderer.invoke(DESKTOP_CHANNELS.updateCheck),
  updates: Object.freeze({
    getStatus: (): Promise<DesktopUpdateStatus> => ipcRenderer.invoke(DESKTOP_CHANNELS.updateGetStatus),
    check: (): Promise<DesktopUpdateCheckResult> => ipcRenderer.invoke(DESKTOP_CHANNELS.updateCheck),
    relaunch: (request: DesktopUpdateRelaunchRequest): Promise<DesktopUpdateRelaunchResult> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.updateRelaunch, request),
    relaunchStartup: (): Promise<DesktopUpdateRelaunchResult> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.updateStartupRelaunch),
    retryStartup: (): Promise<DesktopUpdateCheckResult> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.updateStartupRetry),
    getAutoRelaunchSettings: (): Promise<DesktopUpdateAutoRelaunchSettings> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.updateAutoRelaunchSettingsGet).then(parseDesktopUpdateAutoRelaunchSettings),
    setAutoRelaunchOnIdle: (autoRelaunchOnIdle: boolean): Promise<DesktopUpdateAutoRelaunchSettings> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.updateAutoRelaunchSettingsSet, { autoRelaunchOnIdle })
        .then(parseDesktopUpdateAutoRelaunchSettings),
    resetAutoRelaunchSettings: (): Promise<DesktopUpdateAutoRelaunchSettings> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.updateAutoRelaunchSettingsReset).then(parseDesktopUpdateAutoRelaunchSettings),
    getChannelSettings: (): Promise<DesktopUpdateChannelSettings> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.updateChannelSettingsGet).then(parseDesktopUpdateChannelSettings),
    setBetaChannelEnabled: (enableBeta: boolean): Promise<DesktopUpdateChannelSettings> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.updateChannelSettingsSet, { enableBeta })
        .then(parseDesktopUpdateChannelSettings),
    resetChannelSettings: (): Promise<DesktopUpdateChannelSettings> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.updateChannelSettingsReset).then(parseDesktopUpdateChannelSettings),
    probeBetaChannel: (): Promise<DesktopUpdateChannelProbeResult> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.updateChannelProbeBeta).then(parseDesktopUpdateChannelProbeResult),
    relaunchForChannelChange: (request: DesktopUpdateRelaunchRequest): Promise<DesktopUpdateRelaunchResult> =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.updateChannelRelaunch, request).then(parseDesktopUpdateRelaunchResult),
    onChannelSettings: (listener: (settings: DesktopUpdateChannelSettings) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Desktop update channel listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        try {
          listener(parseDesktopUpdateChannelSettings(value));
        } catch {
          // Ignore malformed host messages; the next get remains authoritative.
        }
      };
      ipcRenderer.on(DESKTOP_CHANNELS.updateChannelSettingsChanged, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.updateChannelSettingsChanged, wrapped);
    },
    onStatus: (listener: (status: DesktopUpdateStatus) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Desktop update status listener must be a function.");
      const wrapped = (_event: IpcRendererEvent, value: unknown): void => {
        if (isDesktopUpdateStatus(value)) listener(value);
      };
      ipcRenderer.on(DESKTOP_CHANNELS.updateStatus, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.updateStatus, wrapped);
    }
  })
});

contextBridge.exposeInMainWorld("jokoDesktop", desktopApi);

function isDesktopApplicationMenuCommand(value: unknown): value is DesktopApplicationMenuCommand {
  return value === "open-about"
    || value === "new-session"
    || value === "open-settings"
    || value === "open-task-status-settings"
    || value === "check-for-updates"
    || value === "toggle-sidebar"
    || value === "zoom-reset"
    || value === "zoom-in"
    || value === "zoom-out";
}

function isDesktopNotificationSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isDesktopPageSearchRequest(value: unknown): value is DesktopPageSearchRequest {
  return nativeRecord(value) && nativeKeys(value) === "findNext,forward,requestToken,text" &&
    typeof value["text"] === "string" && value["text"].length >= 1 && value["text"].length <= 4_096 &&
    typeof value["forward"] === "boolean" && typeof value["findNext"] === "boolean" &&
    Number.isSafeInteger(value["requestToken"]) && (value["requestToken"] as number) >= 1;
}

function isDesktopPageSearchStopAction(value: unknown): value is DesktopPageSearchStopAction {
  return value === "clearSelection" || value === "keepSelection" || value === "activateSelection";
}

function parseDesktopPageSearchResult(value: unknown): DesktopPageSearchResult | undefined {
  if (!nativeRecord(value) || nativeKeys(value) !== "activeMatchOrdinal,finalUpdate,matches,requestId,requestToken" ||
    !Number.isSafeInteger(value["requestId"]) || (value["requestId"] as number) < 0 ||
    !Number.isSafeInteger(value["requestToken"]) || (value["requestToken"] as number) < 1 ||
    !Number.isSafeInteger(value["matches"]) || (value["matches"] as number) < 0 ||
    !Number.isSafeInteger(value["activeMatchOrdinal"]) || (value["activeMatchOrdinal"] as number) < 0 ||
    typeof value["finalUpdate"] !== "boolean") return undefined;
  return Object.freeze({
    requestId: value["requestId"] as number,
    requestToken: value["requestToken"] as number,
    matches: value["matches"] as number,
    activeMatchOrdinal: value["activeMatchOrdinal"] as number,
    finalUpdate: value["finalUpdate"]
  });
}

function parseDesktopSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Desktop integer result is invalid.");
  return value as number;
}

const DESKTOP_SESSION_DRAG_GESTURE_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/u;
const DESKTOP_SESSION_DRAG_COLOR_PATTERN = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?)\([0-9a-z+.,%/\s-]+\))$/iu;

function isDesktopSessionDragGestureId(value: unknown): value is string {
  return typeof value === "string" && DESKTOP_SESSION_DRAG_GESTURE_PATTERN.test(value);
}

function isDesktopSessionDragPreviewRequest(value: unknown): value is DesktopSessionDragPreviewRequest {
  if (!nativeRecord(value) || nativeKeys(value) !== "gestureId,hint,label,palette,sessionId" ||
    !isDesktopSessionDragGestureId(value["gestureId"]) || !nativeDragText(value["sessionId"], 256) ||
    !nativeDragText(value["label"], 160) || !nativeDragText(value["hint"], 160)) return false;
  const palette = value["palette"];
  return nativeRecord(palette) && nativeKeys(palette) === "accent,border,muted,surface,text" &&
    Object.values(palette).every((color) => typeof color === "string" && color.length <= 128 &&
      DESKTOP_SESSION_DRAG_COLOR_PATTERN.test(color.trim()));
}

function nativeDragText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

const DESKTOP_DEEP_LINK_SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  "general", "personalization", "providers", "voice", "shortcuts", "taskStatus",
  "import", "connections", "tools", "automation", "about"
] as const satisfies readonly DesktopDeepLinkSettingsSection[]);

function parseDesktopDeepLinkNavigation(value: unknown): DesktopDeepLinkNavigation {
  if (!nativeRecord(value) || typeof value["kind"] !== "string") {
    throw new TypeError("Desktop deep-link navigation is invalid.");
  }
  if (value["kind"] === "session") {
    if (!nativeOnlyKeys(value, ["kind", "sessionId", "profileId", "messageId", "messageEventId"]) ||
      !isDesktopNotificationSessionId(value["sessionId"]) ||
      (value["profileId"] !== undefined && !isDesktopNotificationSessionId(value["profileId"])) ||
      (value["messageId"] !== undefined && !isDesktopNotificationSessionId(value["messageId"])) ||
      (value["messageEventId"] !== undefined && !isDesktopNotificationSessionId(value["messageEventId"])) ||
      (value["messageEventId"] !== undefined && value["messageId"] === undefined)) {
      throw new TypeError("Desktop task deep-link navigation is invalid.");
    }
    return Object.freeze({
      kind: "session",
      sessionId: value["sessionId"],
      ...(value["profileId"] === undefined ? {} : { profileId: value["profileId"] as string }),
      ...(value["messageId"] === undefined ? {} : { messageId: value["messageId"] as string }),
      ...(value["messageEventId"] === undefined ? {} : { messageEventId: value["messageEventId"] as string })
    });
  }
  if (value["kind"] === "settings") {
    if (nativeKeys(value) !== "kind,section" || typeof value["section"] !== "string" ||
      !DESKTOP_DEEP_LINK_SETTINGS_SECTIONS.has(value["section"])) {
      throw new TypeError("Desktop settings deep-link navigation is invalid.");
    }
    return Object.freeze({ kind: "settings", section: value["section"] as DesktopDeepLinkSettingsSection });
  }
  if (value["kind"] === "portable") {
    if (nativeKeys(value) === "kind") return Object.freeze({ kind: "portable" });
    const file = value["file"];
    if (nativeKeys(value) !== "file,kind" || !nativeRecord(file) || nativeKeys(file) !== "bytes,mediaType,name" ||
      typeof file["name"] !== "string" || file["name"].length < 1 || file["name"].length > 255 ||
      file["name"].trim() !== file["name"] || /[\u0000-\u001f\u007f/\\]/u.test(file["name"]) ||
      typeof file["mediaType"] !== "string" || file["mediaType"] !== "application/vnd.joko.session" ||
      !(file["bytes"] instanceof Uint8Array) || file["bytes"].byteLength > 256 * 1024 * 1024) {
      throw new TypeError("Desktop portable-task deep-link navigation is invalid.");
    }
    return Object.freeze({
      kind: "portable",
      file: Object.freeze({ name: file["name"], mediaType: file["mediaType"], bytes: file["bytes"] })
    });
  }
  throw new TypeError("Desktop deep-link navigation kind is invalid.");
}

function invokeDesktopAttention(channel: string, key: DesktopAttentionKey): Promise<void> {
  let parsed: DesktopAttentionKey;
  try {
    parsed = parseDesktopAttentionKey(key);
  } catch (error) {
    return Promise.reject(error);
  }
  return ipcRenderer.invoke(channel, parsed);
}

function parseDesktopAttentionKey(value: unknown): DesktopAttentionKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Desktop attention key must be an exact object.");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "ownerId,sessionId" ||
    !isDesktopNotificationSessionId(candidate["ownerId"]) ||
    !isDesktopNotificationSessionId(candidate["sessionId"])) {
    throw new TypeError("Desktop attention key must contain bounded exact ownerId and sessionId strings.");
  }
  return Object.freeze({ ownerId: candidate["ownerId"], sessionId: candidate["sessionId"] });
}

function parseDesktopNativeTaskStatusSettings(value: unknown): DesktopNativeTaskStatusSettings {
  if (!nativeRecord(value) || nativeKeys(value) !== "display,enabled,layout,sounds" ||
    typeof value["enabled"] !== "boolean" || (value["layout"] !== "compact" && value["layout"] !== "normal")) {
    throw new TypeError("Native task-status settings are invalid.");
  }
  const display = value["display"];
  const parsedDisplay = nativeRecord(display) && nativeKeys(display) === "mode" && display["mode"] === "all"
    ? { mode: "all" as const }
    : nativeRecord(display) && nativeOnlyKeys(display, ["displayBounds", "displayId", "displayIndex", "displayName", "mode"]) &&
      Object.hasOwn(display, "displayId") && Object.hasOwn(display, "mode") && display["mode"] === "display" &&
      typeof display["displayId"] === "number" && Number.isSafeInteger(display["displayId"]) &&
      (display["displayName"] === undefined || typeof display["displayName"] === "string" && display["displayName"].length <= 160) &&
      (display["displayIndex"] === undefined || typeof display["displayIndex"] === "number" &&
        Number.isSafeInteger(display["displayIndex"]) && display["displayIndex"] >= 0)
      ? {
          mode: "display" as const,
          displayId: display["displayId"],
          ...(display["displayName"] === undefined ? {} : { displayName: display["displayName"] }),
          ...(display["displayIndex"] === undefined ? {} : { displayIndex: display["displayIndex"] }),
          ...(display["displayBounds"] === undefined ? {} : { displayBounds: parseNativeDisplayBounds(display["displayBounds"]) })
        }
      : undefined;
  const sounds = value["sounds"];
  if (parsedDisplay === undefined || !nativeRecord(sounds) || nativeKeys(sounds) !== "enabled,sounds" ||
    typeof sounds["enabled"] !== "boolean" || !nativeRecord(sounds["sounds"]) ||
    nativeKeys(sounds["sounds"]) !== "attention,complete,error,select,start") {
    throw new TypeError("Native task-status settings are invalid.");
  }
  const choices = sounds["sounds"];
  return Object.freeze({
    enabled: value["enabled"],
    display: Object.freeze(parsedDisplay),
    layout: value["layout"],
    sounds: Object.freeze({
      enabled: sounds["enabled"],
      sounds: Object.freeze({
        start: parseNativeTaskStatusSoundChoice(choices["start"]),
        attention: parseNativeTaskStatusSoundChoice(choices["attention"]),
        complete: parseNativeTaskStatusSoundChoice(choices["complete"]),
        error: parseNativeTaskStatusSoundChoice(choices["error"]),
        select: parseNativeTaskStatusSoundChoice(choices["select"])
      })
    })
  });
}

const NATIVE_TASK_STATUS_SOUND_IDS = Object.freeze([
  "none", "startup-chime", "ring-chime", "item-found", "gem-collect", "item-fanfare",
  "victory-fanfare", "error-buzz", "secret-chime"
] as const);

function parseNativeTaskStatusSoundChoice(value: unknown): DesktopNativeTaskStatusSoundChoice {
  if (!nativeRecord(value)) throw new TypeError("Native task-status sound choice is invalid.");
  if (nativeKeys(value) === "id,type" && value["type"] === "builtin" && typeof value["id"] === "string" &&
    (NATIVE_TASK_STATUS_SOUND_IDS as readonly string[]).includes(value["id"])) {
    return Object.freeze({ type: "builtin", id: value["id"] as DesktopNativeTaskStatusSoundId });
  }
  if (nativeKeys(value) === "name,path,type" && value["type"] === "custom" &&
    typeof value["path"] === "string" && value["path"].length >= 1 && value["path"].length <= 2048 &&
    value["path"].trim() === value["path"] && !/[\u0000-\u001f\u007f]/u.test(value["path"]) &&
    typeof value["name"] === "string" && value["name"].trim().length >= 1 && value["name"].length <= 256) {
    return Object.freeze({ type: "custom", path: value["path"], name: value["name"].trim() });
  }
  throw new TypeError("Native task-status sound choice is invalid.");
}

function parseNativeTaskStatusSoundFileSelection(value: unknown): DesktopNativeTaskStatusSoundFileSelection {
  if (!nativeRecord(value) || nativeKeys(value) !== "name,path" ||
    (value["path"] !== null && (typeof value["path"] !== "string" || value["path"].length < 1 || value["path"].length > 2048)) ||
    (value["name"] !== null && (typeof value["name"] !== "string" || value["name"].trim().length < 1 || value["name"].length > 256)) ||
    (value["path"] === null) !== (value["name"] === null)) {
    throw new TypeError("Native task-status sound-file selection is invalid.");
  }
  return Object.freeze({ path: value["path"], name: value["name"] });
}

function parseNativeDisplayBounds(value: unknown): DesktopNativeTaskStatusDisplay["bounds"] {
  if (!nativeRecord(value) || nativeKeys(value) !== "height,width,x,y") {
    throw new TypeError("Native task-status display bounds are invalid.");
  }
  const coordinates = [value["x"], value["y"], value["width"], value["height"]];
  if (!coordinates.every((coordinate) => typeof coordinate === "number" && Number.isSafeInteger(coordinate)) ||
    (value["width"] as number) <= 0 || (value["height"] as number) <= 0) {
    throw new TypeError("Native task-status display bounds are invalid.");
  }
  return Object.freeze({
    x: value["x"] as number,
    y: value["y"] as number,
    width: value["width"] as number,
    height: value["height"] as number
  });
}

function parseDesktopNativeTaskStatusDisplays(value: unknown): readonly DesktopNativeTaskStatusDisplay[] {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError("Native task-status displays are invalid.");
  return Object.freeze(value.map((entry) => {
    if (!nativeRecord(entry) || nativeKeys(entry) !== "bounds,id,name,primary" ||
      typeof entry["id"] !== "number" || !Number.isSafeInteger(entry["id"]) ||
      typeof entry["name"] !== "string" || entry["name"].length < 1 || entry["name"].length > 160 ||
      typeof entry["primary"] !== "boolean" || !nativeRecord(entry["bounds"]) ||
      nativeKeys(entry["bounds"]) !== "height,width,x,y") {
      throw new TypeError("Native task-status display is invalid.");
    }
    const bounds = entry["bounds"];
    const coordinates = [bounds["x"], bounds["y"], bounds["width"], bounds["height"]];
    if (!coordinates.every((coordinate) => typeof coordinate === "number" && Number.isSafeInteger(coordinate)) ||
      (bounds["width"] as number) <= 0 || (bounds["height"] as number) <= 0) {
      throw new TypeError("Native task-status display bounds are invalid.");
    }
    return Object.freeze({
      id: entry["id"], name: entry["name"], primary: entry["primary"],
      bounds: Object.freeze({
        x: bounds["x"] as number, y: bounds["y"] as number,
        width: bounds["width"] as number, height: bounds["height"] as number
      })
    });
  }));
}

function parseDesktopNativeTaskStatusSnapshot(value: unknown): DesktopNativeTaskStatusSnapshot {
  if (!nativeRecord(value) || nativeKeys(value) !== "locale,ownerId,revision,sessions" ||
    !nativeIdentity(value["ownerId"]) || !nativeDecimal(value["revision"]) ||
    (value["locale"] !== "en" && value["locale"] !== "zh-CN" && value["locale"] !== "en-XA") ||
    !Array.isArray(value["sessions"]) || value["sessions"].length > 64) {
    throw new TypeError("Native task-status snapshot is invalid.");
  }
  const seen = new Set<string>();
  const sessions = value["sessions"].map((entry) => {
    if (!nativeRecord(entry) || !nativeOnlyKeys(entry, ["activityLines", "detail", "interactionKind", "permission", "phase", "sessionId", "startedAt", "title", "updatedAt"]) ||
      !Object.hasOwn(entry, "activityLines") || !Object.hasOwn(entry, "detail") || !Object.hasOwn(entry, "phase") || !Object.hasOwn(entry, "sessionId") ||
      !Object.hasOwn(entry, "title") || !Object.hasOwn(entry, "updatedAt") || !nativeIdentity(entry["sessionId"]) ||
      typeof entry["title"] !== "string" || entry["title"].length > 160 || typeof entry["detail"] !== "string" ||
      entry["detail"].length > 600 || !nativePhase(entry["phase"]) || !nativeTimestamp(entry["updatedAt"]) ||
      (entry["startedAt"] !== undefined && !nativeTimestamp(entry["startedAt"])) ||
      (entry["interactionKind"] !== undefined && !nativeInteractionKind(entry["interactionKind"])) ||
      !Array.isArray(entry["activityLines"]) || entry["activityLines"].length > 3 || seen.has(entry["sessionId"])) {
      throw new TypeError("Native task-status task is invalid.");
    }
    seen.add(entry["sessionId"]);
    const activityLines = entry["activityLines"].map((line) => {
      if (!nativeRecord(line) || nativeKeys(line) !== "id,kind,text" || !nativeIdentity(line["id"]) ||
        typeof line["text"] !== "string" || line["text"].length > 300 ||
        (line["kind"] !== "user" && line["kind"] !== "assistant" && line["kind"] !== "status" && line["kind"] !== "tool")) {
        throw new TypeError("Native task-status activity line is invalid.");
      }
      return Object.freeze({ id: line["id"], kind: line["kind"], text: line["text"] });
    });
    const permission = entry["permission"] === undefined ? undefined : parseNativeTaskStatusPermission(entry["permission"]);
    if (permission !== undefined && entry["phase"] !== "interaction") {
      throw new TypeError("Native task-status permission is invalid.");
    }
    return Object.freeze({
      sessionId: entry["sessionId"], title: entry["title"], detail: entry["detail"], phase: entry["phase"],
      ...(entry["interactionKind"] === undefined ? {} : { interactionKind: entry["interactionKind"] }),
      activityLines: Object.freeze(activityLines),
      ...(entry["startedAt"] === undefined ? {} : { startedAt: entry["startedAt"] as number }),
      updatedAt: entry["updatedAt"], ...(permission === undefined ? {} : { permission })
    });
  });
  return Object.freeze({
    ownerId: value["ownerId"], revision: value["revision"], locale: value["locale"], sessions: Object.freeze(sessions)
  });
}

function parseNativeTaskStatusVisibleSessionIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new TypeError("Native task-status visible task identities are invalid.");
  }
  const seen = new Set<string>();
  const sessionIds = value.map((sessionId) => {
    if (!nativeIdentity(sessionId) || seen.has(sessionId)) {
      throw new TypeError("Native task-status visible task identities are invalid.");
    }
    seen.add(sessionId);
    return sessionId;
  });
  return Object.freeze(sessionIds);
}

function parseNativeTaskStatusPermission(value: unknown): NonNullable<DesktopNativeTaskStatusSnapshot["sessions"][number]["permission"]> {
  if (!nativeRecord(value) || nativeKeys(value) !== "allow,allowForSession,deny,generation,interactionId" ||
    !nativeIdentity(value["interactionId"]) || !nativeDecimal(value["generation"]) ||
    typeof value["allow"] !== "boolean" || typeof value["allowForSession"] !== "boolean" ||
    typeof value["deny"] !== "boolean") {
    throw new TypeError("Native task-status permission is invalid.");
  }
  return Object.freeze({
    interactionId: value["interactionId"], generation: value["generation"],
    allow: value["allow"], allowForSession: value["allowForSession"], deny: value["deny"]
  });
}

function parseDesktopNativeTaskStatusAction(value: unknown): DesktopNativeTaskStatusAction | undefined {
  if (!nativeRecord(value) || !nativeIdentity(value["sessionId"])) return undefined;
  if (value["kind"] === "focus" && nativeKeys(value) === "kind,sessionId") {
    return Object.freeze({ kind: "focus", sessionId: value["sessionId"] });
  }
  if (value["kind"] !== "permission" || nativeKeys(value) !== "decision,generation,interactionId,kind,sessionId" ||
    !nativeIdentity(value["interactionId"]) || !nativeDecimal(value["generation"]) ||
    (value["decision"] !== "allow" && value["decision"] !== "allowForSession" && value["decision"] !== "deny")) {
    return undefined;
  }
  return Object.freeze({
    kind: "permission", sessionId: value["sessionId"], interactionId: value["interactionId"],
    generation: value["generation"], decision: value["decision"]
  });
}

function nativeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeKeys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(",");
}

function nativeOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function nativeIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function nativeDecimal(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function nativeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nativePhase(value: unknown): value is DesktopNativeTaskStatusSnapshot["sessions"][number]["phase"] {
  return value === "running" || value === "interaction" || value === "completed" || value === "error";
}

function nativeInteractionKind(value: unknown): value is NonNullable<DesktopNativeTaskStatusSnapshot["sessions"][number]["interactionKind"]> {
  return value === "permission" || value === "question" || value === "plan" || value === "select" ||
    value === "confirm" || value === "input" || value === "editor";
}

function parseDesktopSessionWindowOpenResult(value: unknown): DesktopSessionWindowOpenResult {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).join(",") !== "focusedExisting" ||
    typeof (value as Record<string, unknown>)["focusedExisting"] !== "boolean") {
    throw new TypeError("Task window result is invalid.");
  }
  return Object.freeze({ focusedExisting: (value as DesktopSessionWindowOpenResult).focusedExisting });
}

function parseDesktopSessionWindowDropResult(value: unknown): DesktopSessionWindowDropResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Task window drop result is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).join(",") === "opened" && candidate["opened"] === false) {
    return Object.freeze({ opened: false });
  }
  if (Object.keys(candidate).join(",") === "opened,focusedExisting" && candidate["opened"] === true &&
    typeof candidate["focusedExisting"] === "boolean") {
    return Object.freeze({ opened: true, focusedExisting: candidate["focusedExisting"] });
  }
  throw new TypeError("Task window drop result is invalid.");
}

function parseDesktopRuntimeProcessMonitorOpenResult(value: unknown): DesktopRuntimeProcessMonitorOpenResult {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).join(",") !== "focusedExisting" ||
    typeof (value as Record<string, unknown>)["focusedExisting"] !== "boolean") {
    throw new TypeError("Runtime process monitor result is invalid.");
  }
  return Object.freeze({ focusedExisting: (value as DesktopRuntimeProcessMonitorOpenResult).focusedExisting });
}

function parseDesktopKeepAwakeSettings(value: unknown): DesktopKeepAwakeSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).join(",") !== "enabled" ||
    typeof (value as Record<string, unknown>)["enabled"] !== "boolean") {
    throw new TypeError("Desktop keep-awake settings are invalid.");
  }
  return Object.freeze({ enabled: (value as { readonly enabled: boolean }).enabled });
}

function parseDesktopWindowInteractionSettings(value: unknown): DesktopWindowInteractionSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).join(",") !== "swallowActivationClick" ||
    typeof (value as Record<string, unknown>)["swallowActivationClick"] !== "boolean") {
    throw new TypeError("Desktop window-interaction settings are invalid.");
  }
  return Object.freeze({
    swallowActivationClick: (value as DesktopWindowInteractionSettings).swallowActivationClick
  });
}

function parseDesktopMicrophonePermissionSnapshot(value: unknown): DesktopMicrophonePermissionSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).join(",") !== "status") {
    throw new TypeError("Desktop microphone permission snapshot is invalid.");
  }
  const status = (value as Record<string, unknown>)["status"];
  if (status !== "granted" && status !== "denied" && status !== "prompt" && status !== "unknown") {
    throw new TypeError("Desktop microphone permission status is invalid.");
  }
  return Object.freeze({ status });
}

function isDesktopSaveFileRequest(value: unknown): value is DesktopSaveFileRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).sort().join(",") === "bytes,mediaType,name"
    && typeof candidate["name"] === "string"
    && candidate["name"].length >= 1
    && candidate["name"].length <= 255
    && candidate["name"].trim() === candidate["name"]
    && !/[\u0000-\u001f\u007f<>:"\/\\|?*]/u.test(candidate["name"])
    && typeof candidate["mediaType"] === "string"
    && candidate["mediaType"].length >= 1
    && candidate["mediaType"].length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(candidate["mediaType"])
    && candidate["bytes"] instanceof Uint8Array
    && candidate["bytes"].byteLength <= 256 * 1024 * 1024;
}

function parseDesktopBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("Desktop boolean response is invalid.");
  return value;
}

function isDesktopUpdateStatus(value: unknown): value is DesktopUpdateStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate["status"] === "checking") {
    return hasExactDesktopUpdateStatusKeys(candidate, ["status"]);
  }
  if (candidate["status"] === "idle") {
    if (candidate["availability"] === "available") {
      return hasExactDesktopUpdateStatusKeys(candidate, ["status", "availability"]);
    }
    return candidate["availability"] === "unavailable"
      && isDesktopUpdateUnavailableReason(candidate["reason"])
      && hasExactDesktopUpdateStatusKeys(candidate, ["status", "availability", "reason"]);
  }
  if (candidate["status"] === "downloading") {
    return isDesktopUpdateVersion(candidate["version"])
      && isDesktopUpdateProgress(candidate)
      && hasExactDesktopUpdateStatusKeys(candidate, [
        "status", "version", "progress", "transferred", "total", "bytesPerSecond"
      ]);
  }
  if (candidate["status"] === "superseding") {
    return isDesktopUpdateVersion(candidate["version"])
      && isDesktopUpdateVersion(candidate["nextVersion"])
      && isDesktopUpdateProgress(candidate)
      && hasExactDesktopUpdateStatusKeys(candidate, [
        "status", "version", "nextVersion", "progress", "transferred", "total", "bytesPerSecond"
      ]);
  }
  if (candidate["status"] === "ready") {
    return isDesktopUpdateVersion(candidate["version"])
      && hasExactDesktopUpdateStatusKeys(candidate, ["status", "version"]);
  }
  if (candidate["status"] === "manual-download") {
    return (candidate["reason"] === "linux-manual-only" || candidate["reason"] === "unsupported-platform")
      && hasExactDesktopUpdateStatusKeys(candidate, ["status", "reason"]);
  }
  if (candidate["status"] === "error") {
    return isDesktopUpdateErrorKind(candidate["errorKind"])
      && (candidate["version"] === undefined || isDesktopUpdateVersion(candidate["version"]))
      && hasExactDesktopUpdateStatusKeys(candidate, [
        "status", "errorKind", ...(candidate["version"] === undefined ? [] : ["version"])
      ]);
  }
  return false;
}

function isDesktopUpdateProgress(candidate: Record<string, unknown>): boolean {
  return typeof candidate["progress"] === "number"
    && Number.isFinite(candidate["progress"])
    && candidate["progress"] >= 0
    && candidate["progress"] <= 100
    && isDesktopUpdateCounter(candidate["transferred"])
    && isDesktopUpdateCounter(candidate["total"])
    && isDesktopUpdateCounter(candidate["bytesPerSecond"])
    && candidate["transferred"] <= candidate["total"]
    && (candidate["progress"] !== 100 || candidate["total"] === 0 || candidate["transferred"] === candidate["total"]);
}

function isDesktopUpdateCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExactDesktopUpdateStatusKeys(
  candidate: Record<string, unknown>,
  requiredKeys: readonly string[]
): boolean {
  if (candidate["startup"] !== undefined && candidate["startup"] !== true) return false;
  const expectedKeys = candidate["startup"] === true ? [...requiredKeys, "startup"] : requiredKeys;
  const actualKeys = Object.keys(candidate);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(candidate, key));
}

function isDesktopUpdateVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isDesktopUpdateUnavailableReason(value: unknown): boolean {
  return value === "development" || value === "feed-unconfigured" || value === "versionless-build" ||
    value === "updater-disabled";
}

function isDesktopUpdateErrorKind(value: unknown): boolean {
  return value === "configuration"
    || value === "check"
    || value === "download"
    || value === "orchestrator-shutdown"
    || value === "apply";
}

function parseDesktopUpdateAutoRelaunchSettings(value: unknown): DesktopUpdateAutoRelaunchSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Desktop auto relaunch settings are invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "autoRelaunchOnIdle,defaultAutoRelaunchOnIdle,isCustomized" ||
    typeof candidate["autoRelaunchOnIdle"] !== "boolean" ||
    typeof candidate["isCustomized"] !== "boolean" ||
    typeof candidate["defaultAutoRelaunchOnIdle"] !== "boolean") {
    throw new TypeError("Desktop auto relaunch settings are invalid.");
  }
  return Object.freeze({
    autoRelaunchOnIdle: candidate["autoRelaunchOnIdle"],
    isCustomized: candidate["isCustomized"],
    defaultAutoRelaunchOnIdle: candidate["defaultAutoRelaunchOnIdle"]
  });
}

function parseDesktopUpdateChannelSettings(value: unknown): DesktopUpdateChannelSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Desktop update channel settings are invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort().join(",");
  if (keys !== "defaultEnableBeta,enableBeta,isCustomized" ||
    typeof candidate["enableBeta"] !== "boolean" ||
    typeof candidate["isCustomized"] !== "boolean" ||
    typeof candidate["defaultEnableBeta"] !== "boolean") {
    throw new TypeError("Desktop update channel settings are invalid.");
  }
  return Object.freeze({
    enableBeta: candidate["enableBeta"],
    isCustomized: candidate["isCustomized"],
    defaultEnableBeta: candidate["defaultEnableBeta"]
  });
}

function parseDesktopUpdateChannelProbeResult(value: unknown): DesktopUpdateChannelProbeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).join(",") !== "available" ||
    typeof (value as Record<string, unknown>)["available"] !== "boolean") {
    throw new TypeError("Desktop beta-channel probe result is invalid.");
  }
  return Object.freeze({ available: (value as { readonly available: boolean }).available });
}

function parseDesktopUpdateRelaunchResult(value: unknown): DesktopUpdateRelaunchResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Desktop update relaunch result is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate["accepted"] === true && Object.keys(candidate).join(",") === "accepted") {
    return Object.freeze({ accepted: true });
  }
  const reason = candidate["reason"];
  if (candidate["accepted"] !== false || Object.keys(candidate).sort().join(",") !== "accepted,reason" ||
    (reason !== "not-ready" && reason !== "busy" && reason !== "orchestrator-shutdown-failed" && reason !== "apply-failed")) {
    throw new TypeError("Desktop update relaunch result is invalid.");
  }
  return Object.freeze({ accepted: false, reason });
}

function parseDesktopGlobalVoiceShortcutPreference(value: unknown): DesktopGlobalVoiceShortcutPreference {
  if (value === "disabled") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Global voice shortcut is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "alt,code,ctrl,fn,meta,shift"
    || typeof candidate["code"] !== "string"
    || candidate["code"].length === 0
    || candidate["code"].length > 32
    || typeof candidate["meta"] !== "boolean"
    || typeof candidate["ctrl"] !== "boolean"
    || typeof candidate["alt"] !== "boolean"
    || typeof candidate["shift"] !== "boolean"
    || typeof candidate["fn"] !== "boolean") {
    throw new TypeError("Global voice shortcut is invalid.");
  }
  return Object.freeze({
    code: candidate["code"],
    meta: candidate["meta"],
    ctrl: candidate["ctrl"],
    alt: candidate["alt"],
    shift: candidate["shift"],
    fn: candidate["fn"]
  });
}

function parseDesktopGlobalVoiceShortcutResult(value: unknown): DesktopGlobalVoiceShortcutResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Global voice shortcut result is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate["accepted"] === true
    && (candidate["activation"] === "toggle" || candidate["activation"] === "hold")
    && Object.keys(candidate).sort().join(",") === "accepted,activation") {
    return Object.freeze({ accepted: true, activation: candidate["activation"] });
  }
  const reason = candidate["reason"];
  if (candidate["accepted"] === false
    && (reason === "unsupported" || reason === "in-use" || reason === "permission")
    && Object.keys(candidate).sort().join(",") === "accepted,reason") {
    return Object.freeze({ accepted: false, reason });
  }
  throw new TypeError("Global voice shortcut result is invalid.");
}

function parseDesktopGlobalVoiceCommand(value: unknown): DesktopGlobalVoiceCommand | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).join(",") !== "type") return undefined;
  const type = (value as Record<string, unknown>)["type"];
  return type === "start" || type === "submit" || type === "cancel" || type === "retry"
    ? Object.freeze({ type })
    : undefined;
}

function parseDesktopGlobalVoiceStatus(value: unknown): DesktopGlobalVoiceStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Global voice status is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const state = candidate["state"];
  if ((state === "idle" || state === "starting") && Object.keys(candidate).join(",") === "state") {
    return Object.freeze({ state });
  }
  if (state === "listening" || state === "submitting") {
    if (Object.keys(candidate).sort().join(",") !== "state,transcript"
      || typeof candidate["transcript"] !== "string"
      || candidate["transcript"].length > 4_096
      || /\u0000/u.test(candidate["transcript"])) {
      throw new TypeError("Global voice status is invalid.");
    }
    return Object.freeze({ state, transcript: candidate["transcript"] });
  }
  const errorKind = candidate["errorKind"];
  if (state === "error"
    && Object.keys(candidate).sort().join(",") === "errorKind,state"
    && (errorKind === "unsupported" || errorKind === "permission" || errorKind === "microphone"
      || errorKind === "service" || errorKind === "empty" || errorKind === "insertion")) {
    return Object.freeze({ state, errorKind });
  }
  throw new TypeError("Global voice status is invalid.");
}

function parseDesktopGlobalVoiceCommitRequest(value: unknown): DesktopGlobalVoiceCommitRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).join(",") !== "text") {
    throw new TypeError("Global voice result is invalid.");
  }
  const text = (value as Record<string, unknown>)["text"];
  if (typeof text !== "string" || text.length === 0 || text.length > 64 * 1024 || /\u0000/u.test(text)) {
    throw new TypeError("Global voice result is invalid.");
  }
  return Object.freeze({ text });
}

function parseDesktopGlobalVoiceAccessibilitySnapshot(value: unknown): DesktopGlobalVoiceAccessibilitySnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).join(",") !== "status") {
    throw new TypeError("Global voice accessibility status is invalid.");
  }
  const status = (value as Record<string, unknown>)["status"];
  if (status !== "granted" && status !== "denied" && status !== "not-required" && status !== "unknown") {
    throw new TypeError("Global voice accessibility status is invalid.");
  }
  return Object.freeze({ status });
}

function parseDesktopGlobalVoiceInputMonitoringSnapshot(value: unknown): DesktopGlobalVoiceInputMonitoringSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).join(",") !== "status") {
    throw new TypeError("Global voice input monitoring status is invalid.");
  }
  const status = (value as Record<string, unknown>)["status"];
  if (status !== "granted" && status !== "denied" && status !== "not-required" && status !== "unknown") {
    throw new TypeError("Global voice input monitoring status is invalid.");
  }
  return Object.freeze({ status });
}

function parseDesktopGlobalVoiceShortcutRecoverySnapshot(value: unknown): DesktopGlobalVoiceShortcutRecoverySnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).join(",") !== "failed"
    || typeof (value as Record<string, unknown>)["failed"] !== "boolean") {
    throw new TypeError("Global voice shortcut recovery status is invalid.");
  }
  return Object.freeze({ failed: (value as Record<string, boolean>)["failed"] as boolean });
}

function parseDesktopGlobalVoiceShortcutCaptureKeys(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const keys = value.filter((entry): entry is string => typeof entry === "string" && entry.length <= 32);
  return keys.length === value.length ? Object.freeze([...keys]) : undefined;
}
