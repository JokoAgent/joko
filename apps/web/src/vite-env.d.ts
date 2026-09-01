/// <reference types="vite/client" />

interface JokoDesktopFile {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

interface JokoDesktopAppInfo {
  readonly name: string;
  readonly version: string;
  readonly platform: string;
  readonly electronVersion: string;
  readonly persistentCredentialStorage: boolean;
}

interface JokoDesktopAttentionKey {
  readonly ownerId: string;
  readonly sessionId: string;
}

interface JokoDesktopDiscoveredNode {
  readonly serverId: string;
  readonly displayName: string;
  readonly origin: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly pairingEnabled: boolean;
  readonly lastSeenAt: number;
}

interface JokoDesktopManagedOrchestratorConnection {
  readonly profileId: string;
  readonly deviceId: string;
  readonly serverId: string;
  readonly name: string;
  readonly origin: string;
}

type JokoDesktopManagedOrchestratorStatus =
  | { readonly state: "disabled" }
  | { readonly state: "starting" }
  | { readonly state: "ready"; readonly connection: JokoDesktopManagedOrchestratorConnection }
  | {
    readonly state: "retryableError";
    readonly reason: "serviceUnavailable" | "startFailed";
  }
  | {
    readonly state: "recoveryRequired";
    readonly reason: "credentialUnavailable" | "credentialRejected" | "identityConflict";
  };

type JokoDesktopUpdateCheckResult =
  | { readonly status: "available"; readonly version: string }
  | { readonly status: "up-to-date" }
  | { readonly status: "failed"; readonly errorKind: JokoDesktopUpdateErrorKind }
  | { readonly status: "unavailable"; readonly reason: JokoDesktopUpdateUnavailableReason }
  | { readonly status: "manual-download"; readonly reason: JokoDesktopUpdateManualDownloadReason };

type JokoDesktopUpdateErrorKind =
  | "configuration"
  | "check"
  | "download"
  | "orchestrator-shutdown"
  | "apply";

type JokoDesktopUpdateUnavailableReason =
  | "development"
  | "feed-unconfigured"
  | "versionless-build"
  | "updater-disabled";

type JokoDesktopUpdateManualDownloadReason =
  | "linux-manual-only"
  | "unsupported-platform";

type JokoDesktopUpdateStatus = (
  | { readonly status: "idle"; readonly availability: "available" }
  | {
    readonly status: "idle";
    readonly availability: "unavailable";
    readonly reason: JokoDesktopUpdateUnavailableReason;
  }
  | { readonly status: "checking" }
  | {
    readonly status: "downloading";
    readonly version: string;
    readonly progress: number;
    readonly transferred: number;
    readonly total: number;
    readonly bytesPerSecond: number;
  }
  | {
    readonly status: "superseding";
    readonly version: string;
    readonly nextVersion: string;
    readonly progress: number;
    readonly transferred: number;
    readonly total: number;
    readonly bytesPerSecond: number;
  }
  | { readonly status: "ready"; readonly version: string }
  | { readonly status: "error"; readonly errorKind: JokoDesktopUpdateErrorKind; readonly version?: string }
  | { readonly status: "manual-download"; readonly reason: JokoDesktopUpdateManualDownloadReason }
) & { readonly startup?: true };

type JokoDesktopUpdateRelaunchResult =
  | { readonly accepted: true }
  | {
    readonly accepted: false;
    readonly reason: "not-ready" | "busy" | "orchestrator-shutdown-failed" | "apply-failed";
  };

interface JokoDesktopAutoRelaunchSettings {
  readonly autoRelaunchOnIdle: boolean;
  readonly isCustomized: boolean;
  readonly defaultAutoRelaunchOnIdle: boolean;
}

interface JokoDesktopUpdateChannelSettings {
  readonly enableBeta: boolean;
  readonly isCustomized: boolean;
  readonly defaultEnableBeta: boolean;
}

type JokoDesktopNativeTaskStatusPhase = "running" | "interaction" | "completed" | "error";
type JokoDesktopNativeTaskStatusDecision = "allow" | "allowForSession" | "deny";
type JokoDesktopNativeTaskStatusSoundId = "none" | "startup-chime" | "ring-chime" | "item-found" |
  "gem-collect" | "item-fanfare" | "victory-fanfare" | "error-buzz" | "secret-chime";
type JokoDesktopNativeTaskStatusSoundChoice =
  | { readonly type: "builtin"; readonly id: JokoDesktopNativeTaskStatusSoundId }
  | { readonly type: "custom"; readonly path: string; readonly name: string };

interface JokoDesktopNativeTaskStatusSettings {
  readonly enabled: boolean;
  readonly display: { readonly mode: "all" } | {
    readonly mode: "display";
    readonly displayId: number;
    readonly displayName?: string;
    readonly displayIndex?: number;
    readonly displayBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  };
  readonly layout: "compact" | "normal";
  readonly sounds: {
    readonly enabled: boolean;
    readonly sounds: Readonly<Record<"start" | "attention" | "complete" | "error" | "select", JokoDesktopNativeTaskStatusSoundChoice>>;
  };
}

interface JokoDesktopNativeTaskStatusDisplay {
  readonly id: number;
  readonly name: string;
  readonly primary: boolean;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

interface JokoDesktopNativeTaskStatusSnapshot {
  readonly ownerId: string;
  readonly revision: string;
  readonly locale: "en" | "zh-CN" | "en-XA";
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly title: string;
    readonly detail: string;
    readonly phase: JokoDesktopNativeTaskStatusPhase;
    readonly interactionKind?: "permission" | "question" | "plan" | "select" | "confirm" | "input" | "editor";
    readonly activityLines: readonly {
      readonly id: string;
      readonly kind: "user" | "assistant" | "status" | "tool";
      readonly text: string;
    }[];
    readonly startedAt?: number;
    readonly updatedAt: number;
    readonly permission?: {
      readonly interactionId: string;
      readonly generation: string;
      readonly allow: boolean;
      readonly allowForSession: boolean;
      readonly deny: boolean;
    };
  }[];
}

type JokoDesktopNativeTaskStatusAction =
  | { readonly kind: "focus"; readonly sessionId: string }
  | {
      readonly kind: "permission";
      readonly sessionId: string;
      readonly interactionId: string;
      readonly generation: string;
      readonly decision: JokoDesktopNativeTaskStatusDecision;
    };

type JokoDesktopCapability =
  | "app.info"
  | "app.update"
  | "attention.badge"
  | "appearance.zoom"
  | "application.menu"
  | "inspector.detach"
  | "layout.reset"
  | "microphone.lifecycle"
  | "native.taskStatus"
  | "navigation.deepLinks"
  | "notifications.session"
  | "page.search"
  | "power.keepAwake"
  | "provider.modelCatalogLifecycle"
  | "runtime.processMonitorWindow"
  | "selection.quote.contextMenu"
  | "session.windows"
  | "voice.globalDictation"
  | "window.activationClick";

type JokoDesktopDeepLinkSettingsSection =
  | "general"
  | "personalization"
  | "providers"
  | "voice"
  | "shortcuts"
  | "taskStatus"
  | "import"
  | "connections"
  | "tools"
  | "automation"
  | "about";

type JokoDesktopDeepLinkNavigation =
  | {
      readonly kind: "session";
      readonly sessionId: string;
      readonly profileId?: string;
      readonly messageId?: string;
      readonly messageEventId?: string;
    }
  | { readonly kind: "settings"; readonly section: JokoDesktopDeepLinkSettingsSection }
  | { readonly kind: "portable"; readonly file?: JokoDesktopFile };

interface JokoDesktopSessionDragPreviewRequest {
  readonly gestureId: string;
  readonly sessionId: string;
  readonly label: string;
  readonly hint: string;
  readonly palette: {
    readonly surface: string;
    readonly border: string;
    readonly text: string;
    readonly muted: string;
    readonly accent: string;
  };
}

interface JokoDesktopGlobalVoiceShortcut {
  readonly code: string;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly fn: boolean;
}

type JokoDesktopGlobalVoiceStatus =
  | { readonly state: "idle" }
  | { readonly state: "starting" }
  | { readonly state: "listening"; readonly transcript: string }
  | { readonly state: "submitting"; readonly transcript: string }
  | { readonly state: "error"; readonly errorKind: "unsupported" | "permission" | "microphone" | "service" | "empty" | "insertion" };

interface JokoDesktopApi {
  readonly platform: string;
  readonly capabilities: readonly JokoDesktopCapability[];
  readonly appInfo: {
    get(): Promise<JokoDesktopAppInfo>;
  };
  readonly window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    setZoomFactor(zoomFactor: number): Promise<void>;
    close(): Promise<void>;
  };
  readonly sessionWindows: {
    open(sessionId: string): Promise<{ readonly focusedExisting: boolean }>;
    beginDragPreview(request: JokoDesktopSessionDragPreviewRequest): Promise<boolean>;
    endDragPreview(gestureId: string): Promise<boolean>;
    openIfDroppedOutside(gestureId: string): Promise<
      { readonly opened: false } | { readonly opened: true; readonly focusedExisting: boolean }
    >;
  };
  readonly runtimeProcessMonitor: {
    open(): Promise<{ readonly focusedExisting: boolean }>;
  };
  readonly layout: {
    reset(): Promise<void>;
    onReset(listener: () => void): () => void;
  };
  readonly windowInteraction: {
    get(): Promise<{ readonly swallowActivationClick: boolean }>;
    setSwallowActivationClick(enabled: boolean): Promise<{ readonly swallowActivationClick: boolean }>;
    onChanged(listener: (settings: { readonly swallowActivationClick: boolean }) => void): () => void;
  };
  readonly pageSearch: {
    start(request: {
      readonly text: string;
      readonly forward: boolean;
      readonly findNext: boolean;
      readonly requestToken: number;
    }): Promise<number>;
    stop(action: "clearSelection" | "keepSelection" | "activateSelection"): Promise<void>;
    onResult(listener: (result: {
      readonly requestId: number;
      readonly requestToken: number;
      readonly matches: number;
      readonly activeMatchOrdinal: number;
      readonly finalUpdate: boolean;
    }) => void): () => void;
  };
  readonly applicationMenu: {
    configure(patch: {
      readonly shortcutRecording?: boolean;
      readonly newSessionAccelerator?: string | null;
      readonly openSettingsAccelerator?: string | null;
      readonly toggleSidebarAccelerator?: string | null;
    }): Promise<void>;
    onCommand(listener: (command: "open-about" | "new-session" | "open-settings" | "open-task-status-settings" | "check-for-updates" | "toggle-sidebar" | "zoom-reset" | "zoom-in" | "zoom-out") => void): () => void;
  };
  readonly inspectorWindow: {
    onClosed(listener: () => void): () => void;
  };
  readonly selectionContextMenu: {
    setLocale(locale: "en" | "zh-CN" | "en-XA"): Promise<void>;
    onAddToChat(listener: () => void): () => void;
  };
  setTrayIcon(dataUrl: string): Promise<void>;
  notify(value: { readonly title: string; readonly body: string; readonly sessionId?: string }): Promise<void>;
  readonly notifications: {
    onFocusSession(listener: (sessionId: string) => void): () => void;
  };
  readonly attention: {
    mark(key: JokoDesktopAttentionKey): Promise<void>;
    clear(key: JokoDesktopAttentionKey): Promise<void>;
  };
  readonly nativeTaskStatus: {
    getSettings(): Promise<JokoDesktopNativeTaskStatusSettings>;
    setSettings(settings: JokoDesktopNativeTaskStatusSettings): Promise<JokoDesktopNativeTaskStatusSettings>;
    getDisplays(): Promise<readonly JokoDesktopNativeTaskStatusDisplay[]>;
    previewSound(sound: JokoDesktopNativeTaskStatusSoundChoice): Promise<void>;
    selectSoundFile(): Promise<{ readonly path: string | null; readonly name: string | null }>;
    publish(snapshot: JokoDesktopNativeTaskStatusSnapshot): Promise<void>;
    setVisibleSessions(sessionIds: readonly string[]): Promise<void>;
    onAction(listener: (action: JokoDesktopNativeTaskStatusAction) => void): () => void;
    onSettingsChanged(listener: (settings: JokoDesktopNativeTaskStatusSettings) => void): () => void;
  };
  readonly power: {
    getKeepAwake(): Promise<{ readonly enabled: boolean }>;
    setKeepAwake(enabled: boolean): Promise<{ readonly enabled: boolean }>;
  };
  readonly modelCatalog: {
    onRefreshLifecycle(listener: (
      hint: "system-resume" | "screen-unlock" | "meaningful-foreground"
    ) => void): () => void;
  };
  readonly microphone: {
    getPermission(): Promise<{ readonly status: "granted" | "denied" | "prompt" | "unknown" }>;
    openSettings(): Promise<boolean>;
    onRelease(listener: (reason: "system-suspend" | "screen-lock") => void): () => void;
  };
  readonly globalVoice: {
    setShortcut(preference: JokoDesktopGlobalVoiceShortcut | "disabled"): Promise<
      { readonly accepted: true; readonly activation: "hold" | "toggle" }
      | { readonly accepted: false; readonly reason: "unsupported" | "in-use" | "permission" }
    >;
    startShortcutCapture(): Promise<boolean>;
    stopShortcutCapture(): Promise<void>;
    onShortcutCaptureKeys(listener: (keys: readonly string[]) => void): () => void;
    onShortcutRecoveryFailed(listener: () => void): () => void;
    onShortcutRecovered(listener: () => void): () => void;
    consumeShortcutRecoveryFailure(): Promise<{ readonly failed: boolean }>;
    setMuteSystemAudio(enabled: boolean): Promise<void>;
    publishStatus(status: JokoDesktopGlobalVoiceStatus): Promise<void>;
    commit(request: { readonly text: string }): Promise<boolean>;
    getAccessibility(): Promise<{ readonly status: "granted" | "denied" | "not-required" | "unknown" }>;
    openAccessibility(): Promise<boolean>;
    getInputMonitoring(): Promise<{ readonly status: "granted" | "denied" | "not-required" | "unknown" }>;
    openInputMonitoring(): Promise<boolean>;
    onCommand(listener: (command: { readonly type: "start" | "submit" | "cancel" | "retry" }) => void): () => void;
  };
  chooseFiles(): Promise<readonly JokoDesktopFile[]>;
  choosePortableSessionFile(): Promise<JokoDesktopFile | undefined>;
  readonly deepLinks: {
    takePending(): Promise<JokoDesktopDeepLinkNavigation | undefined>;
    onNavigate(listener: (navigation: JokoDesktopDeepLinkNavigation) => void): () => void;
  };
  saveFile(file: JokoDesktopFile): Promise<boolean>;
  readonly discovery: {
    scan(): Promise<readonly JokoDesktopDiscoveredNode[]>;
  };
  readonly managedOrchestrator: {
    getConnection(): Promise<JokoDesktopManagedOrchestratorConnection | undefined>;
    getStatus(): Promise<JokoDesktopManagedOrchestratorStatus>;
    retry(): Promise<JokoDesktopManagedOrchestratorStatus>;
    adoptConnection(connection: JokoDesktopManagedOrchestratorConnection): Promise<JokoDesktopManagedOrchestratorStatus>;
    completeLogout(): Promise<JokoDesktopManagedOrchestratorStatus>;
  };
  readonly credentials: {
    get(profileId: string): Promise<string | undefined>;
    set(profileId: string, secret: string): Promise<void>;
    delete(profileId: string): Promise<void>;
  };
  openExternal(url: string): Promise<void>;
  checkForUpdates(): Promise<JokoDesktopUpdateCheckResult>;
  readonly updates: {
    getStatus(): Promise<JokoDesktopUpdateStatus>;
    check(): Promise<JokoDesktopUpdateCheckResult>;
    relaunch(options: { readonly allowBusy: boolean }): Promise<JokoDesktopUpdateRelaunchResult>;
    relaunchStartup(): Promise<JokoDesktopUpdateRelaunchResult>;
    retryStartup(): Promise<JokoDesktopUpdateCheckResult>;
    onStatus(listener: (status: JokoDesktopUpdateStatus) => void): () => void;
    getAutoRelaunchSettings(): Promise<JokoDesktopAutoRelaunchSettings>;
    setAutoRelaunchOnIdle(enabled: boolean): Promise<JokoDesktopAutoRelaunchSettings>;
    resetAutoRelaunchSettings(): Promise<JokoDesktopAutoRelaunchSettings>;
    getChannelSettings(): Promise<JokoDesktopUpdateChannelSettings>;
    setBetaChannelEnabled(enabled: boolean): Promise<JokoDesktopUpdateChannelSettings>;
    resetChannelSettings(): Promise<JokoDesktopUpdateChannelSettings>;
    probeBetaChannel(): Promise<{ readonly available: boolean }>;
    relaunchForChannelChange(options: { readonly allowBusy: boolean }): Promise<JokoDesktopUpdateRelaunchResult>;
    onChannelSettings(listener: (settings: JokoDesktopUpdateChannelSettings) => void): () => void;
  };
}

interface JokoInspectorDesktopApi {
  readonly platform: string;
  readonly window: {
    ready(): Promise<void>;
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
  };
  readonly selectionContextMenu: {
    onAddToChat(listener: () => void): () => void;
  };
}

interface JokoVoiceOverlayApi {
  getStatus(): Promise<JokoDesktopGlobalVoiceStatus>;
  onStatus(listener: (status: JokoDesktopGlobalVoiceStatus) => void): () => void;
  cancel(): Promise<void>;
  retry(): Promise<void>;
}

interface Window {
  readonly jokoDesktop?: JokoDesktopApi;
  readonly jokoInspectorDesktop?: JokoInspectorDesktopApi;
  readonly jokoVoiceOverlay?: JokoVoiceOverlayApi;
}
