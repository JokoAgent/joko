export const DESKTOP_CHANNELS = {
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
} as const;

export const INSPECTOR_WINDOW_FRAME_NAME = "joko-inspector-window";
export const INSPECTOR_WINDOW_URL = "about:blank";
export const INSPECTOR_WINDOW_FEATURES = "popup,width=520,height=860";

export function isInspectorWindowOpenRequest(url: unknown, frameName: unknown): boolean {
  return url === INSPECTOR_WINDOW_URL && frameName === INSPECTOR_WINDOW_FRAME_NAME;
}

export type DesktopLocale = "en" | "zh-CN" | "en-XA";

export const DESKTOP_PAGE_SEARCH_MAX_TEXT_LENGTH = 4_096;

export interface DesktopPageSearchRequest {
  readonly text: string;
  readonly forward: boolean;
  readonly findNext: boolean;
  /** Renderer-owned identity used to reject late native result events. */
  readonly requestToken: number;
}

export interface DesktopPageSearchResult {
  readonly requestId: number;
  readonly requestToken: number;
  readonly matches: number;
  readonly activeMatchOrdinal: number;
  readonly finalUpdate: boolean;
}

export type DesktopPageSearchStopAction = "clearSelection" | "keepSelection" | "activateSelection";

export function parseDesktopPageSearchRequest(value: unknown): DesktopPageSearchRequest {
  if (!plainRecordWithKeys(value, ["text", "forward", "findNext", "requestToken"]) ||
    typeof value.text !== "string" || value.text.length < 1 || value.text.length > DESKTOP_PAGE_SEARCH_MAX_TEXT_LENGTH ||
    typeof value.forward !== "boolean" || typeof value.findNext !== "boolean" ||
    !Number.isSafeInteger(value.requestToken) || (value.requestToken as number) < 1) {
    throw new TypeError("Desktop page search request is invalid.");
  }
  return {
    text: value.text,
    forward: value.forward,
    findNext: value.findNext,
    requestToken: value.requestToken as number
  };
}

export function parseDesktopPageSearchStopAction(value: unknown): DesktopPageSearchStopAction {
  if (value !== "clearSelection" && value !== "keepSelection" && value !== "activateSelection") {
    throw new TypeError("Desktop page search stop action is invalid.");
  }
  return value;
}

export function isDesktopLocale(value: unknown): value is DesktopLocale {
  return value === "en" || value === "zh-CN" || value === "en-XA";
}

export type DesktopApplicationMenuCommand =
  | "open-about"
  | "new-session"
  | "open-settings"
  | "open-task-status-settings"
  | "check-for-updates"
  | "toggle-sidebar"
  | "zoom-reset"
  | "zoom-in"
  | "zoom-out";

export interface DesktopApplicationMenuConfiguration {
  readonly shortcutRecording: boolean;
  readonly newSessionAccelerator: string | null;
  readonly openSettingsAccelerator: string | null;
  readonly toggleSidebarAccelerator: string | null;
}

export type DesktopApplicationMenuConfigurationPatch = Partial<DesktopApplicationMenuConfiguration>;

export type DesktopUpdateCheckResult =
  | { readonly status: "available"; readonly version: string }
  | { readonly status: "up-to-date" }
  | { readonly status: "failed"; readonly errorKind: DesktopUpdateErrorKind }
  | { readonly status: "unavailable"; readonly reason: DesktopUpdateUnavailableReason }
  | { readonly status: "manual-download"; readonly reason: DesktopUpdateManualDownloadReason };

export type DesktopUpdateErrorKind =
  | "configuration"
  | "check"
  | "download"
  | "orchestrator-shutdown"
  | "apply";

export type DesktopUpdateUnavailableReason =
  | "development"
  | "feed-unconfigured"
  | "versionless-build"
  | "updater-disabled";

export type DesktopUpdateManualDownloadReason =
  | "linux-manual-only"
  | "unsupported-platform";

/**
 * Credential-free, bounded lifecycle projection exposed to the renderer.
 * Raw updater errors and release URLs intentionally never cross the IPC fence.
 */
export type DesktopUpdateLifecycleStatus =
  | {
    readonly status: "idle";
    readonly availability: "available";
  }
  | {
    readonly status: "idle";
    readonly availability: "unavailable";
    readonly reason: DesktopUpdateUnavailableReason;
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
    /** Previously staged version that remains safe to apply until replacement succeeds. */
    readonly version: string;
    readonly nextVersion: string;
    readonly progress: number;
    readonly transferred: number;
    readonly total: number;
    readonly bytesPerSecond: number;
  }
  | { readonly status: "ready"; readonly version: string }
  | {
    readonly status: "error";
    readonly errorKind: DesktopUpdateErrorKind;
    readonly version?: string;
  }
  | {
    readonly status: "manual-download";
    readonly reason: DesktopUpdateManualDownloadReason;
  };

/** Main decorates the same lifecycle projection while the cold-start gate owns the UI. */
export type DesktopUpdateStatus = DesktopUpdateLifecycleStatus & {
  readonly startup?: true;
};

export interface DesktopUpdateAutoRelaunchSettings {
  readonly autoRelaunchOnIdle: boolean;
  readonly isCustomized: boolean;
  readonly defaultAutoRelaunchOnIdle: boolean;
}

export interface DesktopUpdateChannelSettings {
  readonly enableBeta: boolean;
  readonly isCustomized: boolean;
  readonly defaultEnableBeta: boolean;
}

export interface DesktopUpdateChannelProbeResult {
  readonly available: boolean;
}

export interface DesktopUpdateRelaunchRequest {
  /** True only after the trusted renderer presents and receives manual confirmation. */
  readonly allowBusy: boolean;
}

export type DesktopUpdateRelaunchResult =
  | { readonly accepted: true }
  | {
    readonly accepted: false;
    readonly reason: "not-ready" | "busy" | "orchestrator-shutdown-failed" | "apply-failed";
  };

export interface DesktopAppInfo {
  readonly name: string;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly electronVersion: string;
  /** True only when credentials survive a process restart in protected storage. */
  readonly persistentCredentialStorage: boolean;
}

export interface DesktopSessionWindowOpenResult {
  readonly focusedExisting: boolean;
}

export interface DesktopSessionDragPreviewPalette {
  readonly surface: string;
  readonly border: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
}

export interface DesktopSessionDragPreviewRequest {
  readonly gestureId: string;
  readonly sessionId: string;
  readonly label: string;
  readonly hint: string;
  readonly palette: DesktopSessionDragPreviewPalette;
}

export type DesktopSessionWindowDropResult =
  | { readonly opened: false }
  | { readonly opened: true; readonly focusedExisting: boolean };

const DESKTOP_SESSION_DRAG_GESTURE_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/u;
const DESKTOP_SESSION_DRAG_COLOR_PATTERN = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?)\([0-9a-z+.,%/\s-]+\))$/iu;

export function isDesktopSessionDragGestureId(value: unknown): value is string {
  return typeof value === "string" && DESKTOP_SESSION_DRAG_GESTURE_PATTERN.test(value);
}

export function isDesktopSessionDragPreviewRequest(value: unknown): value is DesktopSessionDragPreviewRequest {
  if (!plainRecordWithKeys(value, ["gestureId", "sessionId", "label", "hint", "palette"])) return false;
  if (!isDesktopSessionDragGestureId(value.gestureId) || !boundedDragText(value.sessionId, 256) ||
    !boundedDragText(value.label, 160) || !boundedDragText(value.hint, 160) ||
    !plainRecordWithKeys(value.palette, ["surface", "border", "text", "muted", "accent"])) return false;
  return Object.values(value.palette).every((color) => typeof color === "string" && color.length <= 128 &&
    DESKTOP_SESSION_DRAG_COLOR_PATTERN.test(color.trim()));
}

function boundedDragText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function plainRecordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export interface DesktopRuntimeProcessMonitorOpenResult {
  readonly focusedExisting: boolean;
}

export function isDesktopApplicationMenuCommand(value: unknown): value is DesktopApplicationMenuCommand {
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

export interface DesktopFile {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export const DESKTOP_DEEP_LINK_SETTINGS_SECTIONS = [
  "general",
  "personalization",
  "providers",
  "voice",
  "shortcuts",
  "taskStatus",
  "import",
  "connections",
  "tools",
  "automation",
  "about"
] as const;

export type DesktopDeepLinkSettingsSection = typeof DESKTOP_DEEP_LINK_SETTINGS_SECTIONS[number];

export function isDesktopDeepLinkSettingsSection(value: unknown): value is DesktopDeepLinkSettingsSection {
  return typeof value === "string" && (DESKTOP_DEEP_LINK_SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export type DesktopDeepLinkNavigation =
  | {
      readonly kind: "session";
      readonly sessionId: string;
      readonly profileId?: string;
      readonly messageId?: string;
      readonly messageEventId?: string;
    }
  | { readonly kind: "settings"; readonly section: DesktopDeepLinkSettingsSection }
  | { readonly kind: "portable"; readonly file?: DesktopFile };

export interface DesktopSaveFileRequest {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface DesktopNotification {
  readonly title: string;
  readonly body: string;
  readonly sessionId?: string;
}

export interface DesktopAttentionKey {
  readonly ownerId: string;
  readonly sessionId: string;
}

export type DesktopNativeTaskStatusPhase = "running" | "interaction" | "completed" | "error";

export type DesktopNativeTaskStatusDecision = "allow" | "allowForSession" | "deny";

export type DesktopNativeTaskStatusInteractionKind =
  | "permission"
  | "question"
  | "plan"
  | "select"
  | "confirm"
  | "input"
  | "editor";

export interface DesktopNativeTaskStatusActivityLine {
  readonly id: string;
  readonly kind: "user" | "assistant" | "status" | "tool";
  readonly text: string;
}

export interface DesktopNativeTaskStatusPermission {
  readonly interactionId: string;
  /** Decimal interaction generation. Kept as text so every IPC/HTML boundary is lossless. */
  readonly generation: string;
  readonly allow: boolean;
  readonly allowForSession: boolean;
  readonly deny: boolean;
}

export interface DesktopNativeTaskStatusSession {
  readonly sessionId: string;
  readonly title: string;
  readonly detail: string;
  readonly phase: DesktopNativeTaskStatusPhase;
  readonly interactionKind?: DesktopNativeTaskStatusInteractionKind;
  readonly activityLines: readonly DesktopNativeTaskStatusActivityLine[];
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly permission?: DesktopNativeTaskStatusPermission;
}

export interface DesktopNativeTaskStatusSnapshot {
  readonly ownerId: string;
  /** Decimal owner-snapshot revision. */
  readonly revision: string;
  readonly locale: DesktopLocale;
  readonly sessions: readonly DesktopNativeTaskStatusSession[];
}

export type DesktopNativeTaskStatusDisplayTarget =
  | { readonly mode: "all" }
  | {
      readonly mode: "display";
      readonly displayId: number;
      readonly displayName?: string;
      readonly displayIndex?: number;
      readonly displayBounds?: DesktopNativeTaskStatusDisplay["bounds"];
    };

export type DesktopNativeTaskStatusLayout = "compact" | "normal";

export type DesktopNativeTaskStatusSoundEvent = "start" | "attention" | "complete" | "error" | "select";

export type DesktopNativeTaskStatusSoundId =
  | "none"
  | "startup-chime"
  | "ring-chime"
  | "item-found"
  | "gem-collect"
  | "item-fanfare"
  | "victory-fanfare"
  | "error-buzz"
  | "secret-chime";

export type DesktopNativeTaskStatusSoundChoice =
  | { readonly type: "builtin"; readonly id: DesktopNativeTaskStatusSoundId }
  | { readonly type: "custom"; readonly path: string; readonly name: string };

export interface DesktopNativeTaskStatusSounds {
  readonly enabled: boolean;
  readonly sounds: Readonly<Record<DesktopNativeTaskStatusSoundEvent, DesktopNativeTaskStatusSoundChoice>>;
}

export interface DesktopNativeTaskStatusSoundFileSelection {
  readonly path: string | null;
  readonly name: string | null;
}

export interface DesktopNativeTaskStatusSettings {
  readonly enabled: boolean;
  readonly display: DesktopNativeTaskStatusDisplayTarget;
  readonly layout: DesktopNativeTaskStatusLayout;
  readonly sounds: DesktopNativeTaskStatusSounds;
}

export interface DesktopNativeTaskStatusDisplay {
  readonly id: number;
  readonly name: string;
  readonly primary: boolean;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export type DesktopNativeTaskStatusAction =
  | { readonly kind: "focus"; readonly sessionId: string }
  | {
      readonly kind: "permission";
      readonly sessionId: string;
      readonly interactionId: string;
      readonly generation: string;
      readonly decision: DesktopNativeTaskStatusDecision;
    };

export interface DesktopKeepAwakeSettings {
  readonly enabled: boolean;
}

export type DesktopProviderModelRefreshLifecycleHint =
  | "system-resume"
  | "screen-unlock"
  | "meaningful-foreground";

export interface DesktopWindowInteractionSettings {
  readonly swallowActivationClick: boolean;
}

export type DesktopMicrophonePermissionStatus = "granted" | "denied" | "prompt" | "unknown";

export interface DesktopMicrophonePermissionSnapshot {
  readonly status: DesktopMicrophonePermissionStatus;
}

export type DesktopMicrophoneReleaseReason = "system-suspend" | "screen-lock";

export interface DesktopGlobalVoiceShortcut {
  readonly code: string;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly fn: boolean;
}

export type DesktopGlobalVoiceShortcutPreference = DesktopGlobalVoiceShortcut | "disabled";

export type DesktopGlobalVoiceShortcutResult =
  | { readonly accepted: true; readonly activation: "hold" | "toggle" }
  | { readonly accepted: false; readonly reason: "unsupported" | "in-use" | "permission" };

export type DesktopGlobalVoiceCommand =
  | { readonly type: "start" }
  | { readonly type: "submit" }
  | { readonly type: "cancel" }
  | { readonly type: "retry" };

export type DesktopGlobalVoiceErrorKind =
  | "unsupported"
  | "permission"
  | "microphone"
  | "service"
  | "empty"
  | "insertion";

export type DesktopGlobalVoiceStatus =
  | { readonly state: "idle" }
  | { readonly state: "starting" }
  | { readonly state: "listening"; readonly transcript: string }
  | { readonly state: "submitting"; readonly transcript: string }
  | { readonly state: "error"; readonly errorKind: DesktopGlobalVoiceErrorKind };

export interface DesktopGlobalVoiceCommitRequest {
  readonly text: string;
}

export interface DesktopGlobalVoiceAccessibilitySnapshot {
  readonly status: "granted" | "denied" | "not-required" | "unknown";
}

export interface DesktopGlobalVoiceInputMonitoringSnapshot {
  readonly status: "granted" | "denied" | "not-required" | "unknown";
}

export interface DesktopGlobalVoiceShortcutRecoverySnapshot {
  readonly failed: boolean;
}

/** Credential-free discovery metadata returned by the trusted Desktop shell. */
export interface DesktopDiscoveredNode {
  readonly serverId: string;
  readonly displayName: string;
  readonly origin: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly pairingEnabled: boolean;
  readonly lastSeenAt: number;
}

/** Metadata only. The Auth Key remains behind the credential IPC channel. */
export interface DesktopManagedOrchestratorConnection {
  readonly profileId: string;
  readonly deviceId: string;
  readonly serverId: string;
  readonly name: string;
  readonly origin: string;
}

export type DesktopManagedOrchestratorRecoveryReason =
  | "credentialUnavailable"
  | "credentialRejected"
  | "identityConflict";

export type DesktopManagedOrchestratorStatus =
  | { readonly state: "disabled" }
  | { readonly state: "starting" }
  | { readonly state: "ready"; readonly connection: DesktopManagedOrchestratorConnection }
  | {
    readonly state: "retryableError";
    readonly reason: "serviceUnavailable" | "startFailed";
  }
  | {
    readonly state: "recoveryRequired";
    readonly reason: DesktopManagedOrchestratorRecoveryReason;
  };
