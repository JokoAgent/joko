export const DESKTOP_CHANNELS = {
  windowMinimize: "joko:window:minimize",
  windowToggleMaximize: "joko:window:toggle-maximize",
  windowToggleFullscreen: "joko:window:toggle-fullscreen",
  windowSetZoomFactor: "joko:window:set-zoom-factor",
  windowClose: "joko:window:close",
  sessionWindowOpen: "joko:session-window:open",
  sessionWindowGetOwner: "joko:session-window:owner:get",
  extensionWindowOpen: "joko:extension-window:open",
  extensionLibraryPickLocation: "joko:extension-library:pick-location",
  projectPickDirectory: "joko:project:pick-directory",
  extensionLibraryReveal: "joko:extension-library:reveal",
  extensionLibraryBeginSave: "joko:extension-library:save:begin",
  extensionLibraryCommitSave: "joko:extension-library:save:commit",
  extensionLibraryCancelSave: "joko:extension-library:save:cancel",
  extensionLibraryClipboardWrite: "joko:extension-library:clipboard-write",
  sessionDragPreviewBegin: "joko:session-drag-preview:begin",
  sessionDragPreviewEnd: "joko:session-drag-preview:end",
  sessionWindowOpenIfDroppedOutside: "joko:session-window:open-if-dropped-outside",
  runtimeProcessMonitorOpen: "joko:runtime-process-monitor:open",
  runtimeProcessMonitorRequest: "joko:runtime-process-monitor:request",
  runtimeProcessMonitorRespond: "joko:runtime-process-monitor:respond",
  runtimeProcessMonitorRetire: "joko:runtime-process-monitor:retire",
  runtimeProcessMonitorSampleDesktop: "joko:runtime-process-monitor:sample-desktop",
  runtimeProcessDiagnosticsGetOwner: "joko:runtime-process-diagnostics:owner:get",
  runtimeProcessDiagnosticsRequest: "joko:runtime-process-diagnostics:request",
  runtimeProcessDiagnosticsResponse: "joko:runtime-process-diagnostics:response",
  runtimeProcessDiagnosticsRetired: "joko:runtime-process-diagnostics:retired",
  runtimeProcessDiagnosticsRetiredAcknowledge: "joko:runtime-process-diagnostics:retired:acknowledge",
  layoutReset: "joko:layout:reset",
  layoutResetBroadcast: "joko:layout:reset-broadcast",
  windowInteractionGet: "joko:window-interaction:get",
  windowInteractionSet: "joko:window-interaction:set",
  windowInteractionChanged: "joko:window-interaction:changed",
  mainWindowCloseSettingsGet: "joko:main-window-close-settings:get",
  mainWindowCloseSettingsSet: "joko:main-window-close-settings:set",
  mainWindowCloseSettingsChanged: "joko:main-window-close-settings:changed",
  pageSearchStart: "joko:page-search:start",
  pageSearchStop: "joko:page-search:stop",
  pageSearchResult: "joko:page-search:result",
  appGetInfo: "joko:app:get-info",
  preferredSystemLocaleGet: "joko:locale:preferred-system:get",
  applicationMenuCommand: "joko:application-menu:command",
  applicationMenuConfigure: "joko:application-menu:configure",
  selectionContextMenuAddToChat: "joko:selection-context-menu:add-to-chat",
  selectionContextMenuSetLocale: "joko:selection-context-menu:set-locale",
  inspectorWindowReady: "joko:inspector-window:ready",
  inspectorWindowIdentity: "joko:inspector-window:identity",
  inspectorWindowActivate: "joko:inspector-window:activate",
  inspectorWindowMinimize: "joko:inspector-window:minimize",
  inspectorWindowToggleMaximize: "joko:inspector-window:toggle-maximize",
  inspectorWindowClose: "joko:inspector-window:close",
  inspectorWindowClosed: "joko:inspector-window:closed",
  traySetIcon: "joko:tray:set-icon",
  notify: "joko:notify",
  attentionMark: "joko:attention:mark",
  attentionClear: "joko:attention:clear",
  mainDocumentOccurrenceGet: "joko:main-document:occurrence:get",
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
  keepAwakeChanged: "joko:power:keep-awake:changed",
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
  globalVoiceOverlayGetLocale: "joko:global-voice:overlay-locale:get",
  globalVoiceOverlayLocaleChanged: "joko:global-voice:overlay-locale:changed",
  globalVoiceCommit: "joko:global-voice:commit",
  globalVoiceOverlayAction: "joko:global-voice:overlay-action",
  globalVoiceGetAccessibility: "joko:global-voice:accessibility:get",
  globalVoiceOpenAccessibility: "joko:global-voice:accessibility:open",
  globalVoiceGetInputMonitoring: "joko:global-voice:input-monitoring:get",
  globalVoiceOpenInputMonitoring: "joko:global-voice:input-monitoring:open",
  dedicatedHardwareGetState: "joko:hardware-input:state:get",
  dedicatedHardwareSetSettings: "joko:hardware-input:settings:set",
  dedicatedHardwareResetSettings: "joko:hardware-input:settings:reset",
  dedicatedHardwareProbe: "joko:hardware-input:probe",
  dedicatedHardwareRecoverKeymap: "joko:hardware-input:keymap:recover",
  dedicatedHardwareOpenInputSettings: "joko:hardware-input:input-settings:open",
  dedicatedHardwarePublishTasks: "joko:hardware-input:tasks:publish",
  dedicatedHardwareAcknowledgeTaskFocus: "joko:hardware-input:task-focus:acknowledge",
  dedicatedHardwareSetPreview: "joko:hardware-input:preview:set",
  dedicatedHardwareStateChanged: "joko:hardware-input:state:changed",
  dedicatedHardwareAction: "joko:hardware-input:action",
  dedicatedHardwarePreviewInput: "joko:hardware-input:preview:input",
  nativeGamepadCaptureDocument: "joko:native-gamepad:document:capture",
  nativeGamepadGetSnapshot: "joko:native-gamepad:snapshot:get",
  nativeGamepadSetClientState: "joko:native-gamepad:client-state:set",
  nativeGamepadProbe: "joko:native-gamepad:probe",
  nativeGamepadSnapshot: "joko:native-gamepad:snapshot",
  chooseFiles: "joko:files:choose",
  choosePortableSessionFile: "joko:portable-session:choose",
  deepLinkTakePending: "joko:deep-link:take-pending",
  deepLinkAcknowledge: "joko:deep-link:acknowledge",
  deepLinkNavigate: "joko:deep-link:navigate",
  saveFile: "joko:files:save",
  copyFile: "joko:files:copy",
  cancelFileCopy: "joko:files:copy-cancel",
  openFile: "joko:files:open",
  cancelFileOpen: "joko:files:open-cancel",
  openWithCaptureDocument: "joko:files:open-with:document:capture",
  listOpenWithApps: "joko:files:open-with:list",
  retireOpenWithApps: "joko:files:open-with:retire",
  openFileWithApp: "joko:files:open-with:open",
  revealArtifactSource: "joko:files:reveal-artifact-source",
  cancelArtifactSourceReveal: "joko:files:reveal-artifact-source-cancel",
  credentialGet: "joko:credential:get",
  credentialSet: "joko:credential:set",
  credentialDelete: "joko:credential:delete",
  discoveryScan: "joko:discovery:scan",
  managedOrchestratorGetConnection: "joko:managed-orchestrator:get-connection",
  managedOrchestratorGetStatus: "joko:managed-orchestrator:get-status",
  managedOrchestratorRetry: "joko:managed-orchestrator:retry",
  managedOrchestratorAdoptConnection: "joko:managed-orchestrator:adopt-connection",
  managedOrchestratorCompleteLogout: "joko:managed-orchestrator:complete-logout",
  remoteDesktopGetState: "joko:remote-desktop:get-state",
  remoteDesktopSetEnabled: "joko:remote-desktop:set-enabled",
  remoteDesktopDisconnect: "joko:remote-desktop:disconnect",
  remoteDesktopGetPermissions: "joko:remote-desktop:get-permissions",
  remoteDesktopShowPermissionGuide: "joko:remote-desktop:show-permission-guide",
  remoteDesktopStateChanged: "joko:remote-desktop:state-changed",
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
  updateAutoRelaunchSettingsChanged: "joko:update:auto-relaunch-settings:changed",
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
export type DesktopSystemLocale = Exclude<DesktopLocale, "en-XA">;

export type DesktopRemoteDesktopPermissionStatus =
  | "granted"
  | "missing"
  | "unknown"
  | "notRequired";

export interface DesktopRemoteDesktopPermissions {
  readonly screenRecording: DesktopRemoteDesktopPermissionStatus;
  readonly accessibility: DesktopRemoteDesktopPermissionStatus;
}

export interface DesktopRemoteDesktopSnapshot {
  readonly enabled: boolean;
  readonly active: boolean;
  readonly controlling: boolean;
  readonly controllerDeviceId?: string;
  readonly displayId?: string;
  readonly permissions: DesktopRemoteDesktopPermissions;
}

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

export function isDesktopSystemLocale(value: unknown): value is DesktopSystemLocale {
  return value === "en" || value === "zh-CN";
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
  readonly defaultDeviceName: string;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly electronVersion: string;
  /** True only when credentials survive a process restart in protected storage. */
  readonly persistentCredentialStorage: boolean;
}

export interface DesktopSessionWindowOpenResult {
  readonly focusedExisting: boolean;
}

export interface DesktopSessionWindowOwner {
  readonly profileId: string;
  readonly sessionId: string;
}

export function isDesktopSessionWindowOwner(value: unknown): value is DesktopSessionWindowOwner {
  return plainRecordWithKeys(value, ["profileId", "sessionId"])
    && boundedDragText(value.profileId, 256)
    && boundedDragText(value.sessionId, 256);
}

export interface DesktopExtensionWindowOpenResult {
  readonly focusedExisting: boolean;
}

export type DesktopExtensionLibraryLocationSelection =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly path: string };

export interface DesktopProjectDirectoryRequest {
  readonly profileId: string;
  readonly deviceId: string;
  readonly serverId: string;
  readonly origin: string;
}

export type DesktopProjectDirectorySelection = DesktopExtensionLibraryLocationSelection;

export function isDesktopProjectDirectoryRequest(value: unknown): value is DesktopProjectDirectoryRequest {
  return plainRecordWithKeys(value, ["profileId", "deviceId", "serverId", "origin"])
    && boundedDragText(value.profileId, 256) && boundedDragText(value.deviceId, 256)
    && boundedDragText(value.serverId, 256) && boundedDragText(value.origin, 2048);
}

export interface DesktopExtensionLibraryRevealRequest {
  readonly extensionId: string;
  readonly root: string;
  readonly path: string;
}

export interface DesktopExtensionLibraryBeginSaveRequest {
  readonly extensionId: string;
  readonly name: string;
}

export type DesktopExtensionLibrarySaveSelection =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly ticketId: string };

export interface DesktopExtensionLibraryCommitSaveRequest {
  readonly extensionId: string;
  readonly ticketId: string;
  readonly root: string;
  readonly path: string;
}

export interface DesktopExtensionLibraryClipboardRequest {
  readonly extensionId: string;
  readonly bytes: Uint8Array;
}

export function isDesktopExtensionId(value: unknown): value is string {
  return typeof value === "string" && /^extension_[a-f0-9]{32}$/u.test(value);
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
  readonly profileId: string;
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
  if (!plainRecordWithKeys(value, ["gestureId", "profileId", "sessionId", "label", "hint", "palette"])) return false;
  if (!isDesktopSessionDragGestureId(value.gestureId) || !boundedDragText(value.profileId, 256) ||
    !boundedDragText(value.sessionId, 256) ||
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

export interface DesktopDeepLinkDelivery {
  readonly documentOccurrence: string;
  readonly deliveryOccurrence: number;
  readonly navigation: DesktopDeepLinkNavigation;
}

export interface DesktopDeepLinkAcknowledgement {
  readonly documentOccurrence: string;
  readonly deliveryOccurrence: number;
}

export function requireCurrentDesktopMainDocumentOccurrence(
  captured: unknown,
  current: string | undefined
): string {
  if (!isDesktopMainDocumentOccurrence(captured)
    || !isDesktopMainDocumentOccurrence(current)
    || captured !== current) {
    throw new Error("Desktop IPC did not originate from the current main application Document occurrence.");
  }
  return captured;
}

export interface DesktopSaveFileRequest {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface DesktopNotification {
  readonly title: string;
  readonly body: string;
  readonly navigation?: {
    readonly kind: "session";
    readonly profileId: string;
    readonly sessionId: string;
  };
}

export interface DesktopAttentionKey {
  readonly ownerId: string;
  readonly sessionId: string;
}

function isDesktopMainDocumentOccurrence(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
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

export type DesktopNativeGamepadFamily = "xbox" | "playstation" | "nintendo" | "generic";
export type DesktopNativeGamepadTransport = "usb" | "bluetooth" | "unknown";
export type DesktopNativeGamepadBatteryState = "unknown" | "discharging" | "charging" | "full";
export type DesktopNativeGamepadStatus = "idle" | "starting" | "waiting" | "connected" | "unavailable" | "error";

export interface DesktopNativeGamepadDevice {
  readonly family: DesktopNativeGamepadFamily;
  readonly name: string | null;
  readonly category: string | null;
  readonly transport: DesktopNativeGamepadTransport;
  readonly batteryPercentage: number | null;
  readonly batteryState: DesktopNativeGamepadBatteryState;
  readonly buttons: readonly number[];
  readonly axes: readonly number[];
}

export interface DesktopNativeGamepadSnapshot {
  readonly version: 1;
  readonly revision: number;
  readonly status: DesktopNativeGamepadStatus;
  readonly devices: readonly DesktopNativeGamepadDevice[];
}

export interface DesktopNativeGamepadClientState {
  readonly version: 1;
  readonly enabled: boolean;
  readonly preview: boolean;
}

export function parseDesktopNativeGamepadClientState(value: unknown): DesktopNativeGamepadClientState {
  if (!plainRecordWithKeys(value, ["version", "enabled", "preview"]) || value.version !== 1 ||
    typeof value.enabled !== "boolean" || typeof value.preview !== "boolean") {
    throw new TypeError("Desktop native gamepad client state is invalid.");
  }
  return Object.freeze({ version: 1, enabled: value.enabled, preview: value.preview });
}

export function parseDesktopNativeGamepadSnapshot(value: unknown): DesktopNativeGamepadSnapshot {
  if (!plainRecordWithKeys(value, ["version", "revision", "status", "devices"]) || value.version !== 1 ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    !isDesktopNativeGamepadStatus(value.status) || !Array.isArray(value.devices) || value.devices.length > 4) {
    throw new TypeError("Desktop native gamepad snapshot is invalid.");
  }
  const devices = value.devices.map(parseDesktopNativeGamepadDevice);
  if (new Set(devices.map((device) => device.family)).size !== devices.length) {
    throw new TypeError("Desktop native gamepad snapshot is invalid.");
  }
  return Object.freeze({
    version: 1,
    revision: value.revision as number,
    status: value.status,
    devices: Object.freeze(devices)
  });
}

function parseDesktopNativeGamepadDevice(value: unknown): DesktopNativeGamepadDevice {
  if (!plainRecordWithKeys(value, [
    "family", "name", "category", "transport", "batteryPercentage", "batteryState", "buttons", "axes"
  ]) || !isDesktopNativeGamepadFamily(value.family) || !boundedNativeGamepadText(value.name) ||
    !boundedNativeGamepadText(value.category) || !isDesktopNativeGamepadTransport(value.transport) ||
    (value.batteryPercentage !== null && (typeof value.batteryPercentage !== "number" ||
      !Number.isInteger(value.batteryPercentage) || value.batteryPercentage < 0 || value.batteryPercentage > 100)) ||
    !isDesktopNativeGamepadBatteryState(value.batteryState)) {
    throw new TypeError("Desktop native gamepad device is invalid.");
  }
  const buttons = parseNativeGamepadNumberArray(value.buttons, 17, 0, 1);
  const axes = parseNativeGamepadNumberArray(value.axes, 4, -1, 1);
  return Object.freeze({
    family: value.family,
    name: value.name,
    category: value.category,
    transport: value.transport,
    batteryPercentage: value.batteryPercentage,
    batteryState: value.batteryState,
    buttons,
    axes
  });
}

function parseNativeGamepadNumberArray(value: unknown, length: number, minimum: number, maximum: number): readonly number[] {
  if (!Array.isArray(value) || value.length !== length || !value.every((entry) =>
    typeof entry === "number" && Number.isFinite(entry) && entry >= minimum && entry <= maximum)) {
    throw new TypeError("Desktop native gamepad input values are invalid.");
  }
  return Object.freeze([...value] as number[]);
}

function boundedNativeGamepadText(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value));
}

function isDesktopNativeGamepadFamily(value: unknown): value is DesktopNativeGamepadFamily {
  return value === "xbox" || value === "playstation" || value === "nintendo" || value === "generic";
}

function isDesktopNativeGamepadTransport(value: unknown): value is DesktopNativeGamepadTransport {
  return value === "usb" || value === "bluetooth" || value === "unknown";
}

function isDesktopNativeGamepadBatteryState(value: unknown): value is DesktopNativeGamepadBatteryState {
  return value === "unknown" || value === "discharging" || value === "charging" || value === "full";
}

function isDesktopNativeGamepadStatus(value: unknown): value is DesktopNativeGamepadStatus {
  return value === "idle" || value === "starting" || value === "waiting" || value === "connected" ||
    value === "unavailable" || value === "error";
}

export type DesktopProviderModelRefreshLifecycleHint =
  | "system-resume"
  | "screen-unlock"
  | "meaningful-foreground";

export interface DesktopWindowInteractionSettings {
  readonly swallowActivationClick: boolean;
}

export type {
  DesktopRuntimeProcessMetric,
  DesktopRuntimeProcessMonitorAction,
  DesktopRuntimeProcessMonitorBackend,
  DesktopRuntimeProcessMonitorOpenResult,
  DesktopRuntimeProcessMonitorOwner,
  DesktopRuntimeProcessMonitorProcess,
  DesktopRuntimeProcessMonitorRequest,
  DesktopRuntimeProcessMonitorResponse,
  DesktopRuntimeProcessMonitorResult,
  DesktopRuntimeProcessMonitorSession,
  DesktopRuntimeProcessMonitorSnapshot,
  DesktopRuntimeProcessRole,
  DesktopRuntimeProcessSample
} from "./runtime-process-monitor.js";

export interface DesktopCopyFileRequest {
  readonly requestId: string;
  readonly file: DesktopFile;
}

export type DesktopCopyFileResult =
  | { readonly status: "copied" | "cancelled" | "unknown" | "unavailable" | "blocked" }
  | { readonly status: "failed"; readonly reason: "capacity" | "storage" | "helper" };

export interface DesktopOpenFileRequest {
  readonly requestId: string;
  readonly file: DesktopFile;
}

export type DesktopOpenFileResult =
  | { readonly status: "opened" | "cancelled" | "unknown" | "unavailable" }
  | { readonly status: "failed"; readonly reason: "capacity" | "storage" | "open" };

export interface DesktopOpenWithApp {
  readonly appId: string;
  readonly label: string;
  readonly iconDataUrl?: string;
}

export interface DesktopListOpenWithAppsRequest {
  readonly listOccurrence: string;
  readonly name: string;
}

export interface DesktopListOpenWithAppsIpcRequest extends DesktopListOpenWithAppsRequest {
  readonly documentOccurrence: string;
}

export type DesktopListOpenWithAppsResult =
  | {
      readonly status: "listed";
      readonly listOccurrence: string;
      readonly apps: readonly DesktopOpenWithApp[];
    }
  | { readonly status: "cancelled" | "unavailable" | "failed" };

export interface DesktopRetireOpenWithAppsIpcRequest {
  readonly documentOccurrence: string;
  readonly listOccurrence: string;
}

export interface DesktopOpenFileWithAppRequest extends DesktopOpenFileRequest {
  readonly listOccurrence: string;
  readonly appId: string;
}

export interface DesktopOpenFileWithAppIpcRequest extends DesktopOpenFileWithAppRequest {
  readonly documentOccurrence: string;
}

export interface DesktopRevealArtifactSourceRequest {
  readonly requestId: string;
  readonly profileId: string;
  readonly serverId: string;
  readonly sessionId: string;
  readonly artifactId: string;
}

export type DesktopRevealArtifactSourceResult =
  | { readonly status: "revealed" | "cancelled" | "unknown" | "unavailable" }
  | { readonly status: "failed"; readonly reason: "capacity" | "reveal" };

export type DesktopMainWindowCloseBehavior = "tray" | "minimize" | "quit";

export interface DesktopMainWindowCloseSettings {
  readonly behavior: DesktopMainWindowCloseBehavior | null;
  readonly revision: number;
}

export interface DesktopMainWindowCloseSettingsChange {
  readonly behavior: DesktopMainWindowCloseBehavior | null;
  readonly expectedRevision: number;
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

export type DesktopGlobalVoiceGeneration = string;

export type DesktopGlobalVoiceCommand =
  | { readonly type: "start"; readonly generation: DesktopGlobalVoiceGeneration }
  | { readonly type: "submit"; readonly generation: DesktopGlobalVoiceGeneration }
  | { readonly type: "cancel"; readonly generation: DesktopGlobalVoiceGeneration }
  | { readonly type: "retry"; readonly generation: DesktopGlobalVoiceGeneration };

export type DesktopGlobalVoiceErrorKind =
  | "unsupported"
  | "permission"
  | "microphone"
  | "service"
  | "empty"
  | "insertion";

export type DesktopGlobalVoiceStatus =
  | { readonly state: "idle"; readonly generation: DesktopGlobalVoiceGeneration }
  | { readonly state: "starting"; readonly generation: DesktopGlobalVoiceGeneration }
  | {
    readonly state: "listening";
    readonly generation: DesktopGlobalVoiceGeneration;
    readonly transcript: string;
  }
  | {
    readonly state: "submitting";
    readonly generation: DesktopGlobalVoiceGeneration;
    readonly transcript: string;
  }
  | {
    readonly state: "error";
    readonly generation: DesktopGlobalVoiceGeneration;
    readonly errorKind: DesktopGlobalVoiceErrorKind;
  };

export interface DesktopGlobalVoiceCommitRequest {
  readonly generation: DesktopGlobalVoiceGeneration;
  readonly text: string;
}

function hasExactGlobalVoiceKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isExactGlobalVoiceRecord(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && hasExactGlobalVoiceKeys(value as Record<string, unknown>, keys);
}

function isDesktopGlobalVoiceErrorKind(value: unknown): value is DesktopGlobalVoiceErrorKind {
  return value === "unsupported"
    || value === "permission"
    || value === "microphone"
    || value === "service"
    || value === "empty"
    || value === "insertion";
}

function invalidGlobalVoiceProtocol(): TypeError {
  return new TypeError("Global voice protocol value is invalid.");
}

export function isDesktopGlobalVoiceGeneration(value: unknown, allowIdle = false): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16
    || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  if (!allowIdle && value === "0") return false;
  return BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}

export function parseDesktopGlobalVoiceCommand(value: unknown): DesktopGlobalVoiceCommand {
  if (!isExactGlobalVoiceRecord(value, ["type", "generation"])) throw invalidGlobalVoiceProtocol();
  const type = value.type;
  if ((type !== "start" && type !== "submit" && type !== "cancel" && type !== "retry")
    || !isDesktopGlobalVoiceGeneration(value.generation)) throw invalidGlobalVoiceProtocol();
  return Object.freeze({ type, generation: value.generation });
}

export function parseDesktopGlobalVoiceStatus(value: unknown): DesktopGlobalVoiceStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidGlobalVoiceProtocol();
  const candidate = value as Record<string, unknown>;
  const state = candidate["state"];
  const generation = candidate["generation"];
  if (!isDesktopGlobalVoiceGeneration(generation, true)) throw invalidGlobalVoiceProtocol();
  if (generation === "0" && state !== "idle") throw invalidGlobalVoiceProtocol();
  if ((state === "idle" || state === "starting")
    && hasExactGlobalVoiceKeys(candidate, ["state", "generation"])) {
    return Object.freeze({ state, generation });
  }
  if ((state === "listening" || state === "submitting")
    && hasExactGlobalVoiceKeys(candidate, ["state", "generation", "transcript"])
    && typeof candidate["transcript"] === "string"
    && candidate["transcript"].length <= 4_096
    && !/\u0000/u.test(candidate["transcript"])) {
    return Object.freeze({ state, generation, transcript: candidate["transcript"] });
  }
  const errorKind = candidate["errorKind"];
  if (state === "error"
    && hasExactGlobalVoiceKeys(candidate, ["state", "generation", "errorKind"])
    && isDesktopGlobalVoiceErrorKind(errorKind)) {
    return Object.freeze({ state, generation, errorKind });
  }
  throw invalidGlobalVoiceProtocol();
}

export function parseDesktopGlobalVoiceCommitRequest(value: unknown): DesktopGlobalVoiceCommitRequest {
  if (!isExactGlobalVoiceRecord(value, ["generation", "text"])
    || !isDesktopGlobalVoiceGeneration(value.generation)
    || typeof value.text !== "string"
    || value.text.length === 0
    || value.text.length > 64 * 1024
    || /\u0000/u.test(value.text)) throw invalidGlobalVoiceProtocol();
  return Object.freeze({ generation: value.generation, text: value.text });
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
