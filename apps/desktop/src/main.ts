import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  nativeImage,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  protocol,
  type IpcMainInvokeEvent,
  type NativeImage,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type WebContents
} from "electron";
import windowStateKeeper from "electron-window-state";
import { toggleApplicationWindowFullscreen } from "./window-fullscreen.js";
import { broadcastDesktopUpdateSettings } from "./update-settings-broadcast.js";
import { promoteExternalWindowActivation } from "./external-window-activation.js";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { release as operatingSystemRelease } from "node:os";
import { appendFileSync, writeFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  DESKTOP_CHANNELS,
  type DesktopApplicationMenuCommand,
  type DesktopDeepLinkDelivery,
  type DesktopDeepLinkNavigation,
  type DesktopDiscoveredNode,
  type DesktopFile,
  type DesktopGlobalVoiceCommand,
  type DesktopGlobalVoiceErrorKind,
  type DesktopGlobalVoiceShortcut,
  type DesktopGlobalVoiceShortcutResult,
  type DesktopGlobalVoiceStatus,
  type DesktopManagedOrchestratorConnection,
  type DesktopManagedOrchestratorRecoveryReason,
  type DesktopManagedOrchestratorStatus,
  type DesktopMainWindowCloseSettings,
  type DesktopLocale,
  type DesktopSystemLocale,
  type DesktopNativeTaskStatusAction,
  type DesktopNativeTaskStatusDisplay,
  type DesktopNativeTaskStatusSoundChoice,
  type DesktopNativeTaskStatusSettings,
  type DesktopPageSearchResult,
  type DesktopRuntimeProcessMonitorOwner,
  type DesktopSaveFileRequest,
  type DesktopSessionDragPreviewRequest,
  type DesktopSessionWindowOwner,
  type DesktopUpdateRelaunchRequest,
  type DesktopUpdateRelaunchResult,
  type DesktopUpdateChannelSettings,
  type DesktopUpdateStatus,
  INSPECTOR_WINDOW_FEATURES,
  INSPECTOR_WINDOW_FRAME_NAME,
  INSPECTOR_WINDOW_URL,
  isDesktopExtensionId,
  isDesktopProjectDirectoryRequest,
  isDesktopSessionDragGestureId,
  isDesktopSessionDragPreviewRequest,
  isDesktopSessionWindowOwner,
  isInspectorWindowOpenRequest,
  isDesktopLocale,
  requireCurrentDesktopMainDocumentOccurrence,
  parseDesktopGlobalVoiceCommitRequest,
  parseDesktopGlobalVoiceStatus,
  parseDesktopPageSearchRequest,
  parseDesktopPageSearchStopAction
} from "./channels.js";
import { readDesktopPreferredSystemLocale } from "./system-locale.js";
import {
  parseDesktopRuntimeProcessSample,
  parseDesktopRuntimeProcessMonitorOpenResult,
  parseDesktopRuntimeProcessMonitorOwner,
  parseDesktopRuntimeProcessMonitorRequest,
  parseDesktopRuntimeProcessMonitorResponse,
  parseDesktopRuntimeProcessMonitorRetirement,
  retireRuntimeProcessMonitorForReplacement,
  RuntimeProcessMonitorBroker,
  RuntimeProcessMonitorRetirementAcknowledgements,
  sameDesktopRuntimeProcessMonitorOwner,
  shouldRecoverRuntimeProcessMonitorRenderer
} from "./runtime-process-monitor.js";
import { InspectorWindowLifecycle } from "./inspector-window-lifecycle.js";
import { DesktopRuntimeProcessSampler } from "./desktop-runtime-processes.js";
import { projectDirectoryAuthorityMatches } from "./project-directory-authority.js";
import {
  DESKTOP_DEEP_LINK_SCHEME,
  DesktopDeepLinkDeliveryBuffer,
  DesktopInboundOpenIntentFence,
  buildDesktopSessionDeepLink,
  desktopDeepLinkDeliveryMatchesAcknowledgement,
  isDesktopMainDocumentReplacementNavigation,
  parseDesktopDeepLinkAcknowledgement,
  parseDesktopDeepLink,
  type DesktopDeepLinkOffer,
  type DesktopInboundOpenIntent
} from "./deep-link.js";
import {
  bindDesktopOpenIntentIngress,
  type DesktopOpenIntentIngressSource
} from "./desktop-open-intents.js";
import {
  clampWindowBoundsToWorkArea,
  pointIsInsideRectangle,
  sessionWindowDropBounds,
  SESSION_DRAG_PREVIEW_SIZE,
  type DesktopPoint,
  type DesktopRectangle
} from "./session-window-drop.js";
import {
  MAXIMUM_SESSION_WINDOWS,
  sessionWindowOwnerKey,
  sessionWindowOwnerMayRequest
} from "./session-window-owner.js";
import {
  sessionDragPreviewDataUrl,
  SessionDragPreviewCoordinator,
  SessionDragNativeResultFence,
  type NativeSessionDragPreviewWindow
} from "./session-drag-preview.js";
import {
  DesktopAttentionBadgeController,
  parseDesktopAttentionKey,
  type DesktopAttentionPresentation
} from "./attention-badge.js";
import {
  DesktopNotificationCoordinator,
  parseDesktopNotification
} from "./desktop-notification.js";
import {
  DesktopMainDocumentOccurrenceAuthority,
  isDesktopMainDocumentClaim
} from "./main-document-occurrence.js";
import {
  installWindowsApplicationIdentity
} from "./desktop-identity.js";
import {
  prepareDesktopUserDataDirectory,
  resolveDesktopUserDataDirectory
} from "./desktop-user-data.js";
import { verifyPackagedWebBundle } from "./bundle.js";
import {
  ApplicationMenuShortcutRecordingLeases,
  createMacApplicationMenuConfigurationState,
  installMacApplicationMenu,
  parseMacApplicationMenuConfigurationPatch
} from "./application-menu.js";
import { scanLanOrchestratorNodes } from "./lan-discovery.js";
import {
  createDesktopKeepAwakeController,
  type DesktopKeepAwakeController
} from "./keep-awake-controller.js";
import {
  SourceAwareVoiceLease,
  type VoicePressLease,
  type VoiceLeaseStopReason
} from "./dedicated-hardware-action/voice-lease.js";
import {
  settleCompleteExitOperations,
  settleGlobalVoiceForExit
} from "./complete-exit-coordination.js";
import { DedicatedHardwareActionRouter } from "./dedicated-hardware-action/router.js";
import {
  DedicatedHardwareTaskFocusFence,
  parseDedicatedHardwareTaskFocusAcknowledgement,
  sendDedicatedHardwareActionDelivery
} from "./dedicated-hardware-action/task-focus-fence.js";
import {
  SystemFrontmostInputController,
  createPlatformSystemFrontmostInput
} from "./dedicated-hardware-action/system-frontmost-input.js";
import { SystemFrontmostVoiceController } from "./dedicated-hardware-action/system-frontmost-voice.js";
import { loadNativeSystemFrontmostInput } from "./native-system-frontmost-input.js";
import {
  createDedicatedHardwareMainActionRuntime,
  type DedicatedHardwareMainActionRuntime
} from "./dedicated-hardware-main-actions.js";
import {
  createDedicatedHardwareMainController,
  type DedicatedHardwareMainController,
  type DedicatedHardwareProjectedState
} from "./dedicated-hardware-main-controller.js";
import {
  dedicatedHardwareSdkStagingDirectory,
  resolveDedicatedHardwareSdkIdentity
} from "./dedicated-hardware-sdk.js";
import {
  DEDICATED_HARDWARE_MODEL_IDS,
  createDedicatedHardwareHostClient,
  createDedicatedHardwareInputController,
  createDedicatedHardwareSettingsStore,
  createDefaultDedicatedHardwareSettings,
  createElectronDedicatedHardwareUtilityFactory,
  isDedicatedHardwareModelId,
  parseDedicatedHardwareSettings,
  parseDedicatedHardwareUtilityMessage,
  type DedicatedHardwareModelId,
  type DedicatedHardwareSettings
} from "./dedicated-hardware/index.js";
import {
  createDesktopKeepAwakeSettingsStore,
  type DesktopKeepAwakeSettingsStore
} from "./keep-awake-settings.js";
import {
  broadcastDesktopKeepAwakeSettings,
  createDesktopKeepAwakeSettingsCoordinator,
  type DesktopKeepAwakeSettingsCoordinator
} from "./keep-awake-settings-coordinator.js";
import {
  broadcastDesktopWindowInteractionSettings,
  createDesktopWindowInteractionSettingsStore,
  type DesktopWindowInteractionSettingsStore
} from "./window-interaction-settings.js";
import {
  createDesktopMainWindowCloseSettingsStore,
  parseMainWindowCloseSettingsChange,
  type DesktopMainWindowCloseSettingsStore
} from "./window-close-settings.js";
import {
  createDesktopNativeTaskStatusSettingsStore,
  type DesktopNativeTaskStatusSettingsStore
} from "./native-task-status-settings.js";
import {
  createDesktopNativeTaskStatusLayoutSettingsStore,
  type DesktopNativeTaskStatusLayoutSettingsStore
} from "./native-task-status-layout-settings.js";
import {
  deliverDesktopNativeTaskStatusAction,
  isNativeTaskStatusAvailable,
  isSilentDesktopNativeTaskStatusSound,
  parseDesktopNativeTaskStatusSettings,
  parseDesktopNativeTaskStatusSoundChoice,
  parseDesktopNativeTaskStatusSnapshot,
  parseDesktopNativeTaskStatusVisibleSessionIds
} from "./native-task-status.js";
import {
  createMacNativeTaskStatusHost,
  NATIVE_TASK_STATUS_WINDOW_INTERACTION,
  type MacNativeTaskStatusHost,
  type NativeTaskStatusWindow,
  type NativeTaskStatusWindowBounds
} from "./mac-native-task-status-host.js";
import {
  isAllowedDesktopClipboardWriteRequest,
  isAllowedDesktopMicrophoneRequest,
  mapDesktopMicrophonePermissionStatus,
  microphoneMainFrameFromPermissionDetails,
  microphoneMediaTypesFromPermissionDetails
} from "./microphone-permission.js";
import { createProviderModelRefreshHostLifecycle } from "./provider-model-refresh-lifecycle.js";
import {
  DesktopGlobalShortcutRegistration,
  desktopGlobalVoiceAccelerator,
  parseDesktopGlobalVoiceShortcut
} from "./global-voice-shortcut.js";
import { DesktopGlobalVoiceShortcutBinding } from "./global-voice-shortcut-binding.js";
import {
  GlobalVoiceShortcutRecovery,
  type GlobalVoiceShortcutRecoveryTarget
} from "./global-voice-shortcut-recovery.js";
import {
  NativeVoiceShortcutListener,
  NativeVoiceShortcutCaptureSubscriptions,
  NativeVoiceShortcutRegistration,
  nativeVoiceShortcutReservationAccelerator,
  nativeVoiceShortcutTarget,
  resolveNativeVoiceShortcutBinaryPath,
  type NativeVoiceInputMonitoringStatus
} from "./native-voice-shortcut.js";
import {
  ExternalTextInsertionCoordinator
} from "./external-text-insertion.js";
import {
  createSystemAudioMuteBackend,
  SystemAudioMuteGuard
} from "./system-audio-mute.js";
import { createManagedExitFence } from "./managed-exit-fence.js";
import { probeManagedRuntimeActivity } from "./managed-runtime-activity.js";
import {
  createPackagedSmokeTask,
  runPackagedSmokeTimelineTurn,
  verifyPackagedSmokeTask,
  type PackagedSmokeTask,
  type PackagedSmokeTaskOptions
} from "./packaged-smoke-task.js";
import {
  cleanupPackagedSmokeClipboard,
  hasOnlyEmptyPackagedSmokeClipboardFormats,
  isPackagedSmokeRestorableClipboardFormat,
  isPackagedSmokeClipboardObservationOwned,
  packagedSmokeSystemClipboardText,
  type PackagedSmokeClipboardObservation
} from "./packaged-smoke-clipboard-cleanup.js";
import {
  canRespawnManagedOrchestratorAfterProbe,
  commitVerifiedManagedOrchestratorAdoption,
  completeVerifiedManagedOrchestratorLogout,
  loadOrCreateManagedOrchestratorDeviceId,
  managedOrchestratorOutboundProxySnapshotEnvironment,
  ManagedOrchestratorAuthorizationUnavailableError,
  persistManagedOrchestratorDeviceId,
  probeManagedOrchestratorConnection,
  resolveManagedOrchestratorEntry,
  selectManagedOrchestratorPorts,
  startManagedOrchestrator,
  startManagedOrchestratorWithAuthorizationFence,
  type ManagedOrchestratorRuntime,
  verifyManagedOrchestratorAdoption
} from "./managed-orchestrator.js";
import { capturePackagedSmokeProcessBirthIdentitySync } from "./packaged-smoke-process-identity.js";
import { DesktopDevicePeerAgentExecutor } from "./device-peer-agent.js";
import { DesktopDevicePeerAgentLifecycle } from "./device-peer-agent-lifecycle.js";
import { createAuditedDesktopDevicePeerTerminalPort } from "./device-peer-terminal.js";
import {
  createAuditedDesktopDevicePeerRuntimeExecutables,
  resolveDesktopDevicePeerRuntimeRoot
} from "./device-peer-runtime-executables.js";
import {
  atomicWritePrivateFile,
  atomicWriteUserSelectedFile,
  deletePrivateFile,
  readPrivateFile,
  readRegularFileSnapshot
} from "./secure-files.js";
import { materializeDesktopDeepLinkNavigation } from "./portable-deep-link-materialization.js";
import {
  atomicCopyExtensionLibraryFile,
  ExtensionLibraryGestureCoordinator,
  parseExtensionLibraryBeginSaveRequest,
  parseExtensionLibraryClipboardRequest,
  parseExtensionLibraryCommitSaveRequest,
  parseExtensionLibraryRevealRequest,
  resolveVerifiedExtensionLibraryFile
} from "./extension-library-gestures.js";
import { installSelectionContextMenu, setSelectionContextMenuLocale } from "./selection-context-menu.js";
import { NativeFileClipboard, type NativeFileActionScope } from "./native-file-clipboard.js";
import { NativeFileOpener } from "./native-file-opener.js";
import { NativeArtifactSourceRevealer } from "./native-artifact-source-revealer.js";
import { resolveManagedArtifactSource } from "./managed-artifact-source.js";
import { bundledElectronUpdater, createElectronUpdateDriver } from "./electron-update-driver.js";
import {
  createDesktopUpdateAutoRelaunchPolicy,
  isDesktopUpdateActivityQuietForAutoRelaunch,
  type DesktopUpdateAutoRelaunchPolicy
} from "./update-auto-relaunch.js";
import { createDesktopUpdateAutoSettingsStore, type DesktopUpdateAutoSettingsStore } from "./update-auto-settings.js";
import {
  createDesktopUpdateChannelSettingsStore,
  type DesktopUpdateChannelSettingsStore
} from "./update-channel-settings.js";
import {
  requestDesktopQuitHandoff,
  requestDesktopUpdateChannelRelaunchHandoff
} from "./update-channel-relaunch.js";
import { resolveDesktopUpdateFeedUrl } from "./update-feed.js";
import { fetchDesktopUpdateManifestVersion } from "./update-manifest.js";
import { createDesktopUpdateService, type DesktopUpdateService } from "./update-service.js";
import { runDesktopUpdateStartupCheck } from "./update-startup.js";
import { popUpDesktopTrayMenu, usesJavaScriptTrayMenuPopup } from "./tray-menu.js";
import { resolveDesktopTrayMenuLabels } from "./i18n/tray-menu.js";
import {
  desktopMainWindowCloseLabels,
  desktopRuntimeResourceWindowTitle,
  desktopWindowLoadFailureLabels
} from "./i18n/window-lifecycle.js";
import {
  canShowDesktopWindow,
  applyDesktopMainWindowCloseBehavior,
  createDesktopMainWindowCloseController,
  hideWindowToAvailableTray,
  onDesktopWindowClosed,
  showWindowFromTray,
  type DesktopMainWindowCloseController
} from "./window-lifecycle.js";
import {
  loadDesktopWindowWithRecovery,
  recoverDesktopWindowAfterFailure,
  type DesktopWindowLoadFailureAction
} from "./window-load-recovery.js";
import {
  broadcastWindowLayoutReset,
  resetDormantManagedWindowState,
  resetManagedWindowGeometry,
  type ManagedWindowGeometry
} from "./window-layout-reset.js";
import {
  canonicalExternalUrl,
  createNavigationPolicy,
  DESKTOP_APP_ENTRY_URL,
  DESKTOP_APP_SCHEME,
  isAllowedExtensionWindowNavigation,
  isAllowedMainFrameNavigation,
  isAllowedPackagedBundleResource,
  isAllowedPrimaryWindowNavigation,
  isAllowedRuntimeProcessMonitorNavigation,
  isAllowedRendererNetworkUrl,
  isAllowedSessionWindowNavigation,
  isSafeExternalUrl,
  isSecureStorageBackend,
  isTrustedIpcSenderIdentity,
  mediaTypeForPath,
  mergeContentSecurityPolicyHeaders,
  resolvePackagedAppResource,
  runtimeProcessMonitorEntryUrl,
  shouldMergeDesktopFrameContentSecurityPolicy,
  validateCredentialSecret,
  validateProfileId
} from "./security.js";

// fileURLToPath(new URL(".", ...)) retains a trailing separator. Normalize it
// once here so the managed-runtime resolver's absolute/canonical input fence
// sees the same path shape in the real Electron entry as it does in tests.
const sourceDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const developmentUrl = process.env["JOKO_WEB_DEV_URL"];
const packagedSmokeRequested = process.env["JOKO_DESKTOP_PACKAGED_SMOKE"] === "1";
const packagedSmokeScope = process.env["JOKO_DESKTOP_SMOKE_SCOPE"] ?? "full";
const externalPackagedE2e = packagedSmokeRequested && packagedSmokeScope === "external";
const packagedSmoke = packagedSmokeRequested && !externalPackagedE2e;
if (packagedSmokeRequested && packagedSmokeScope !== "full" && packagedSmokeScope !== "inspector"
  && packagedSmokeScope !== "draft" && packagedSmokeScope !== "external") {
  throw new Error(`Unsupported packaged smoke scope: ${packagedSmokeScope}`);
}
const packagedSmokeTimeoutCandidate = Number(process.env["JOKO_DESKTOP_SMOKE_TIMEOUT_MS"]);
const packagedSmokeTimeoutMs = Number.isSafeInteger(packagedSmokeTimeoutCandidate)
  && packagedSmokeTimeoutCandidate >= 60_000
  && packagedSmokeTimeoutCandidate <= 180_000
  ? packagedSmokeTimeoutCandidate
  : 90_000;
const packagedSmokeManagedReadyTimeoutMs = Math.min(
  60_000,
  Math.max(30_000, packagedSmokeTimeoutMs - 30_000)
);
const githubActionsPackagedSmoke = packagedSmoke && process.env["GITHUB_ACTIONS"] === "true";
const packagedSmokeConnectOrigin = process.env["JOKO_DESKTOP_SMOKE_CONNECT_ORIGIN"];
const packagedSmokePublicHttpOrigin = process.env["JOKO_DESKTOP_SMOKE_PUBLIC_HTTP_ORIGIN"];
const packagedSmokeProviderOrigin = process.env["JOKO_DESKTOP_SMOKE_PROVIDER_ORIGIN"];
const packagedSmokeClipboardNonce = process.env["JOKO_DESKTOP_SMOKE_CLIPBOARD_NONCE"];
const packagedSmokeResultPath = process.env["JOKO_DESKTOP_SMOKE_RESULT"];
const packagedSmokeUserData = process.env["JOKO_DESKTOP_SMOKE_USER_DATA"];
if (packagedSmoke && packagedSmokeScope === "full" && process.platform === "win32"
  && (packagedSmokeClipboardNonce === undefined || !/^[0-9a-f]{32}$/u.test(packagedSmokeClipboardNonce))) {
  throw new Error("Packaged Desktop clipboard smoke requires an exact per-run owner nonce.");
}
if (externalPackagedE2e && (packagedSmokeUserData === undefined
  || !isAbsolute(packagedSmokeUserData) || resolve(packagedSmokeUserData) !== packagedSmokeUserData)) {
  throw new Error("Packaged Desktop E2E requires an isolated user-data directory.");
}
let packagedSmokeFailNextMainDocumentRequest = false;
let resolvePackagedSmokeFailedMainDocumentRequest: (() => void) | undefined;
const PACKAGED_SMOKE_FAILED_DOCUMENT_HEADER = "x-joko-packaged-smoke-failed-document";
let resolvePackagedSmokeSecondInstanceIntent: ((intent: DesktopInboundOpenIntent) => void) | undefined;
let packagedSmokeSecondInstanceAwaitingAcknowledgement = false;
let packagedSmokeSecondInstanceDelivery: {
  readonly deliveryOccurrence: number;
  readonly documentOccurrence?: string;
} | undefined;
let packagedSmokeSecondInstanceAcknowledged = false;
const packagedSmokeSecondInstanceIntent = new Promise<DesktopInboundOpenIntent>((resolveIntent) => {
  resolvePackagedSmokeSecondInstanceIntent = resolveIntent;
});
const desktopUpdateReleaseFeedUrl = resolveDesktopUpdateFeedUrl(process.env["JOKO_DESKTOP_UPDATE_FEED_URL"]);
const desktopUpdateBetaFeedUrl = resolveDesktopUpdateFeedUrl(process.env["JOKO_DESKTOP_UPDATE_BETA_FEED_URL"]);
const packagedEntryPath = resolve(sourceDirectory, "web", "index.html");
const navigationPolicy = createNavigationPolicy(packagedEntryPath, developmentUrl);
const nativeTaskStatusDevelopmentPreview = !app.isPackaged &&
  process.env["JOKO_DESKTOP_TASK_STATUS_PREVIEW"] === "1";
const nativeTaskStatusSupported = isNativeTaskStatusAvailable({
  platform: process.platform,
  osRelease: operatingSystemRelease(),
  packaged: app.isPackaged,
  developmentPreviewRequested: nativeTaskStatusDevelopmentPreview
});
const desktopAttentionBadgeSupported = process.platform === "darwin" || process.platform === "win32"
  || process.platform === "linux";
let mainWindow: BrowserWindow | undefined;
const mainWindowContentsByWindow = new WeakMap<BrowserWindow, WebContents>();
const mainWindowDocuments = new DesktopMainDocumentOccurrenceAuthority<WebContents>(() => randomUUID());
const desktopDeepLinkDelivery = new DesktopDeepLinkDeliveryBuffer();
const desktopInboundOpenIntentFence = new DesktopInboundOpenIntentFence();
const desktopNotifications = new DesktopNotificationCoordinator<WebContents>({
  isSupported: () => !packagedSmoke && Notification.isSupported(),
  createNotification: (value) => new Notification(value),
  isApplicationForeground: () => isDesktopApplicationForeground(),
  isCurrentOwner: (owner, documentOccurrence) =>
    owner === mainWindow?.webContents && !owner.isDestroyed()
      && mainWindowDocuments.isCurrent(owner, documentOccurrence),
  activateOwner: (owner) => showCurrentMainWindowOwner(owner),
  navigate: (navigation) => handleDesktopInboundOpenIntent(navigation)
});
let inspectorWindow: BrowserWindow | undefined;
let inspectorWindowOwner: WebContents | undefined;
let inspectorWindowLifecycle: InspectorWindowLifecycle<BrowserWindow, BrowserWindow> | undefined;
let inspectorWindowOccurrence: string | undefined;
let runtimeProcessMonitorWindow: BrowserWindow | undefined;
let runtimeProcessMonitorOwnerWindow: BrowserWindow | undefined;
let releaseRuntimeProcessMonitorOwnerLifecycle: (() => void) | undefined;
let runtimeProcessMonitorFocusOwnerOnClose = false;
let runtimeProcessMonitorOpenTail: Promise<void> = Promise.resolve();
const runtimeProcessMonitorBroker = new RuntimeProcessMonitorBroker<WebContents>({
  onTimeout: (target, response) => {
    if (target.isDestroyed() || runtimeProcessMonitorBroker.binding?.monitorEndpoint !== target ||
      !isRuntimeProcessMonitorNavigation(target.getURL())) return;
    try { target.send(DESKTOP_CHANNELS.runtimeProcessDiagnosticsResponse, response); } catch { /* The document retired after validation. */ }
  }
});
const runtimeProcessMonitorRetirementAcknowledgements =
  new RuntimeProcessMonitorRetirementAcknowledgements<WebContents>();
const desktopRuntimeProcessSampler = new DesktopRuntimeProcessSampler({
  getMetrics: () => app.getAppMetrics(),
  describeRenderer: describeDesktopRuntimeRenderer
});
let globalVoiceOverlayWindow: BrowserWindow | undefined;
let globalVoiceShortcutRecoveryFailurePending = false;
type GlobalVoiceInputSource = "shortcut" | "hardware";
type GlobalVoiceStartMode = "start" | "retry";
let globalVoiceActiveGeneration: number | undefined;
let globalVoiceStatus: DesktopGlobalVoiceStatus = Object.freeze({ state: "idle", generation: "0" });
let globalVoiceRetry: {
  readonly source: GlobalVoiceInputSource;
  readonly failedGeneration: number;
} | undefined;
let globalVoiceCommitFence: {
  readonly generation: number;
  state: "open" | "pending" | "consumed";
} | undefined;
let globalVoiceCancellingGeneration: number | undefined;
let globalVoiceExitAdmissionClosed = false;
const globalVoiceStartModes = new Map<number, GlobalVoiceStartMode>();
let globalVoiceShortcutPressLease: VoicePressLease<GlobalVoiceInputSource> | undefined;
let globalVoiceHardwarePressLease: VoicePressLease<GlobalVoiceInputSource> | undefined;
const globalVoiceStopWaiters = new Map<number, {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}>();
const globalVoiceInputLease = new SourceAwareVoiceLease<GlobalVoiceInputSource>({
  backend: {
    start: (request) => startGlobalVoiceInputLease(request.generation, request.source),
    stop: (request) => stopGlobalVoiceInputLease(request.generation, request.source, request.reason)
  }
});
const externalTextInsertionCoordinator = new ExternalTextInsertionCoordinator();
const GLOBAL_VOICE_APPLICATION_SHORTCUT_RECORDING_SUSPENSION = "application-shortcut-recording";
const GLOBAL_VOICE_NATIVE_CAPTURE_SUSPENSION = "native-shortcut-capture";
const globalVoiceNativeShortcut = new NativeVoiceShortcutListener({
  platform: process.platform,
  binaryPath: resolveNativeVoiceShortcutBinaryPath({
    packaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    sourceDirectory
  }),
  onPhase: handleNativeGlobalVoiceShortcutPhase,
  onCaptureKeys: (keys) => {
    for (const contents of globalVoiceShortcutCaptureSubscriptions.subscribers()) {
      if (contents.isDestroyed()) {
        globalVoiceShortcutCaptureSubscriptions.stop(contents);
        continue;
      }
      contents.send(DESKTOP_CHANNELS.globalVoiceShortcutCaptureKeys, keys);
    }
  },
  onMouseUp: handleNativeSessionDragMouseUp,
  onRestartLimitReached: handleGlobalVoiceShortcutRestartLimit
});
const globalVoiceShortcutCaptureSubscriptions = new NativeVoiceShortcutCaptureSubscriptions<WebContents>(
  globalVoiceNativeShortcut,
  {
    beforeStart: () => globalVoiceShortcutBinding.suspend(GLOBAL_VOICE_NATIVE_CAPTURE_SUSPENSION),
    afterStop: () => {
      void restoreGlobalVoiceShortcutAfterSuspension(GLOBAL_VOICE_NATIVE_CAPTURE_SUSPENSION);
      void globalVoiceShortcutRecovery.request();
    }
  }
);
const globalVoiceNativeRegistration = new NativeVoiceShortcutRegistration(globalVoiceNativeShortcut);
const globalVoiceElectronShortcut = new DesktopGlobalShortcutRegistration({
  isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
  register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
  unregister: (accelerator) => globalShortcut.unregister(accelerator)
});
const globalVoiceShortcutBinding = new DesktopGlobalVoiceShortcutBinding({
  platform: process.platform,
  nativeRegistration: globalVoiceNativeRegistration,
  electronRegistration: globalVoiceElectronShortcut,
  nativeTargetAvailable: (shortcut, platform) => nativeVoiceShortcutTarget(shortcut, platform) !== undefined,
  nativeReservationAccelerator: nativeVoiceShortcutReservationAccelerator,
  electronAccelerator: desktopGlobalVoiceAccelerator,
  onElectronTrigger: activateGlobalVoiceShortcut,
  onNativeReservationTrigger: reserveMacGlobalVoiceFunctionKey
});
const globalVoiceShortcutRecovery = new GlobalVoiceShortcutRecovery({
  platform: process.platform,
  getTarget: pendingGlobalVoiceShortcutRecoveryTarget,
  preflight: async () => {
    const status = await globalVoiceNativeShortcut.inputMonitoringStatus();
    return status === "granted" || status === "denied" ? status : "unknown";
  },
  register: recoverGlobalVoiceShortcut,
  onFailure: recordGlobalVoiceShortcutRecoveryFailure,
  onRecovered: completeGlobalVoiceShortcutRecovery
});
const globalVoiceSystemAudio = new SystemAudioMuteGuard<number>(createSystemAudioMuteBackend());
let globalVoiceMuteSystemAudio = true;
let globalVoiceSystemAudioOwner: number | undefined;
let globalVoiceSystemAudioOwnerSequence = 0;
let managedMainWindowState: windowStateKeeper.State | undefined;
let managedInspectorWindowState: windowStateKeeper.State | undefined;
let managedRuntimeProcessMonitorWindowState: windowStateKeeper.State | undefined;
const sessionWindows = new Map<string, BrowserWindow>();
const sessionWindowOwners = new Map<string, DesktopSessionWindowOwner>();
const sessionWindowOwnersByContents = new Map<WebContents, DesktopSessionWindowOwner>();
const extensionWindows = new Map<string, BrowserWindow>();
const extensionWindowIdsByContents = new Map<WebContents, string>();
interface DedicatedHardwareCatalogOwner {
  readonly contents: WebContents;
  readonly documentOccurrence: string;
}
type DedicatedHardwareControllerOwner = WebContents | DedicatedHardwareCatalogOwner;
let dedicatedHardwareController: DedicatedHardwareMainController<DedicatedHardwareControllerOwner> | undefined;
let dedicatedHardwareCatalogOwner: DedicatedHardwareCatalogOwner | undefined;
let dedicatedHardwarePrimaryVisible = false;
let dedicatedHardwareActions: DedicatedHardwareMainActionRuntime<BrowserWindow> | undefined;
let dedicatedHardwareSystemVoiceController: SystemFrontmostVoiceController | undefined;
const dedicatedHardwareTaskFocusFence = new DedicatedHardwareTaskFocusFence<WebContents>();
const dedicatedHardwareWindowLifecycles = new WeakMap<WebContents, { readonly retire: () => void }>();
let dedicatedHardwarePowerLifecycleInstalled = false;
const pageSearchTokensByContents = new WeakMap<WebContents, Map<number, number>>();
const pageSearchResultBindings = new WeakSet<WebContents>();
const sessionWindowStates = new Map<string, windowStateKeeper.State>();
const extensionWindowStates = new Map<string, windowStateKeeper.State>();
const nativeTaskStatusVisibleSessionsByContents = new Map<WebContents, readonly string[]>();
const sessionDragNativeResultFence = new SessionDragNativeResultFence<
  BrowserWindow,
  { readonly focusedExisting: boolean }
>();
const sessionDragPreviewCoordinator = new SessionDragPreviewCoordinator<BrowserWindow>({
  getCursorPoint: () => screen.getCursorScreenPoint(),
  getWorkArea: (point) => screen.getDisplayNearestPoint(point).workArea,
  getVisibleApplicationBounds: visibleSessionDragTargetBounds,
  onStop: () => globalVoiceNativeShortcut.disarmSessionDragRelease()
});
let tray: Tray | undefined;
let trayInitialization: Promise<void> | undefined;
let packagedSmokeTrayVerificationActive = false;
let runtimeTrayIcon: NativeImage | undefined;
let trayContextMenu: Menu | undefined;
const activeTrayContextMenus = new Set<Menu>();
let quitting = false;
let activeDiscoveryScan: Promise<readonly DesktopDiscoveredNode[]> | undefined;
let activeDiscoveryAbort: AbortController | undefined;
let managedOrchestratorRuntime: ManagedOrchestratorRuntime | undefined;
let managedOrchestratorConnection: DesktopManagedOrchestratorConnection | undefined;
let managedOrchestratorRecoveryTarget: DesktopManagedOrchestratorConnection | undefined;
let managedOrchestratorExplicitlyLoggedOut = false;
let managedOrchestratorStatus: DesktopManagedOrchestratorStatus = process.env["JOKO_DESKTOP_MANAGED_ORCHESTRATOR"] === "0"
  ? { state: "disabled" }
  : { state: "starting" };
let managedOrchestratorInitialization: Promise<DesktopManagedOrchestratorStatus> | undefined;
let desktopDevicePeerAgentLifecycle: DesktopDevicePeerAgentLifecycle | undefined;
const managedOrchestratorExitFence = createManagedExitFence({
  getInitialization: () => managedOrchestratorInitialization,
  clearInitialization: (initialization) => {
    if (managedOrchestratorInitialization === initialization) managedOrchestratorInitialization = undefined;
  },
  getRuntime: () => managedOrchestratorRuntime,
  stopRuntime: (runtime) => runtime.stop(),
  clearRuntime: (runtime) => {
    if (managedOrchestratorRuntime === runtime) managedOrchestratorRuntime = undefined;
  }
});
let packagedSmokeFinishing = false;
let preferredSystemLocale: DesktopSystemLocale = "en";
let applicationMenuLocale: DesktopLocale = "en";
const applicationMenuConfigurationState = createMacApplicationMenuConfigurationState({
  shortcutRecording: false,
  newSessionAccelerator: "Command+N",
  openSettingsAccelerator: "Command+,",
  toggleSidebarAccelerator: "Command+B"
});
const applicationMenuShortcutRecordingLeases = new ApplicationMenuShortcutRecordingLeases<number>();
let currentWindowZoomFactor = 1;
let desktopUpdateService: DesktopUpdateService | undefined;
let desktopUpdateAutoSettings: DesktopUpdateAutoSettingsStore | undefined;
let desktopUpdateChannelSettings: DesktopUpdateChannelSettingsStore | undefined;
let desktopKeepAwakeSettings: DesktopKeepAwakeSettingsStore | undefined;
let desktopKeepAwakeController: DesktopKeepAwakeController | undefined;
let desktopKeepAwakeCoordinator: DesktopKeepAwakeSettingsCoordinator | undefined;
let desktopWindowInteractionSettings: DesktopWindowInteractionSettingsStore | undefined;
let desktopMainWindowCloseSettings: DesktopMainWindowCloseSettingsStore | undefined;
let mainWindowCloseController: DesktopMainWindowCloseController | undefined;
let desktopNativeTaskStatusSettings: DesktopNativeTaskStatusSettingsStore | undefined;
let desktopNativeTaskStatusLayoutSettings: DesktopNativeTaskStatusLayoutSettingsStore | undefined;
let macNativeTaskStatusHost: MacNativeTaskStatusHost | undefined;
let nativeTaskStatusDisplayRefresh: (() => void) | undefined;
let desktopAttentionBadgeController: DesktopAttentionBadgeController | undefined;
let microphoneLifecycleInstalled = false;
let providerModelPowerLifecycleInstalled = false;
const providerModelRefreshHostLifecycle = createProviderModelRefreshHostLifecycle({
  publish: broadcastProviderModelRefreshLifecycle
});
let desktopUpdateChannelChangePending = false;
let desktopUpdateChannelRelaunch: Promise<DesktopUpdateRelaunchResult> | undefined;
let desktopUpdateChannelQuitHandoffPending = false;
let desktopUpdateNativeInstallQuitHandoffPending = false;
let desktopCompleteExitQuitHandoffPending = false;
let desktopCompleteExit: Promise<void> | undefined;
let desktopUpdateAutoRelaunchPolicy: DesktopUpdateAutoRelaunchPolicy | undefined;
let desktopUpdateAutoRelaunchPolicyInitialization: Promise<void> | undefined;
let desktopUpdateLifecycleDisposed = false;
type DesktopUpdateStartupPhase =
  | { readonly kind: "checking" }
  | { readonly kind: "ready"; readonly version: string }
  | { readonly kind: "download-failed" };
let desktopUpdateStartupPhase: DesktopUpdateStartupPhase | undefined;
let desktopUpdateStartupCheck: Promise<void> | undefined;
const desktopQuitBlockedListeners = new Set<() => void>();
const volatileCredentials = new Map<string, string>();
const MAXIMUM_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_ATTACHMENT_BATCH_BYTES = 256 * 1024 * 1024;
const MAXIMUM_ATTACHMENT_FILES = 32;
const MAXIMUM_NATIVE_FILE_BYTES = 256 * 1024 * 1024;
let nativeFileClipboard: NativeFileClipboard | undefined;
let nativeFileOpener: NativeFileOpener | undefined;
let nativeArtifactSourceRevealer: NativeArtifactSourceRevealer | undefined;
const nativeFileActionScopes = new WeakMap<WebContents, NativeFileActionScope>();
const extensionLibraryGestures = new ExtensionLibraryGestureCoordinator<WebContents>();
const extensionLibraryGestureScopes = new WeakSet<WebContents>();
const TRAY_ICON_DATA_URL_PREFIX = "data:image/png;base64,";
const MAXIMUM_TRAY_ICON_DATA_URL_LENGTH = 512 * 1024;
const EXPECTED_TRAY_ICON_SIZE = 256;
const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";
const MAIN_WINDOW_DEFAULT_GEOMETRY = Object.freeze({ width: 1280, height: 800 });
const SESSION_WINDOW_DEFAULT_GEOMETRY = Object.freeze({ width: 1100, height: 760 });
const EXTENSION_WINDOW_DEFAULT_GEOMETRY = Object.freeze({ width: 1040, height: 720 });
const INSPECTOR_WINDOW_DEFAULT_GEOMETRY = Object.freeze({ width: 520, height: 860 });
const RUNTIME_PROCESS_MONITOR_WINDOW_DEFAULT_GEOMETRY = Object.freeze({ width: 580, height: 520 });
const SESSION_WINDOW_STATE_PREFIX = "session-window-state-";
const EXTENSION_WINDOW_STATE_PREFIX = "extension-window-state-";
const MAXIMUM_EXTENSION_WINDOWS = 32;
const MAIN_WINDOW_STATE_FILE = "window-state.json";
const RUNTIME_PROCESS_MONITOR_WINDOW_STATE_FILE = "runtime-process-monitor-window-state.json";
const WINDOWS_ATTENTION_OVERLAY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#e5484d"/><circle cx="8" cy="8" r="3" fill="#ffffff"/></svg>';

// Must be registered before Electron's ready event. This gives the packaged UI
// a stable, non-opaque origin without granting it CSP bypass or service workers.
protocol.registerSchemesAsPrivileged([{
  scheme: DESKTOP_APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    codeCache: true
  }
}]);

const desktopUserDataDirectory = resolveDesktopUserDataDirectory({
  packaged: app.isPackaged,
  appDataDirectory: app.getPath("appData"),
  packagedSmoke: packagedSmokeRequested,
  ...(packagedSmokeUserData === undefined ? {} : {
    packagedSmokeDirectory: packagedSmokeUserData
  })
});
if (desktopUserDataDirectory !== undefined) {
  app.setPath("userData", prepareDesktopUserDataDirectory(desktopUserDataDirectory));
}
installWindowsApplicationIdentity(process.platform, (applicationId) => app.setAppUserModelId(applicationId));
registerDesktopDeepLinkProtocolClient();
const desktopOpenIntentIngress = bindDesktopOpenIntentIngress({
  platform: process.platform,
  source: {
    listenOpenUrl: (listener) => { app.on("open-url", listener); },
    listenOpenFile: (listener) => { app.on("open-file", listener); },
    listenSecondInstance: (listener) => { app.on("second-instance", listener); }
  },
  dispatch: (intent, source) => {
    handleDesktopInboundOpenIntent(intent, source);
  },
  showMainWindow
});
recordPackagedSmokeProgress("module_loaded");

if (!app.requestSingleInstanceLock()) {
  recordPackagedSmokeProgress("single_instance_denied");
  app.quit();
} else {
  recordPackagedSmokeProgress("single_instance_acquired");
  desktopOpenIntentIngress.activateSingleInstance(process.argv);
  app.on("before-quit", (event) => {
    nativeFileClipboard?.cancelPending();
    nativeFileOpener?.cancelPending();
    nativeArtifactSourceRevealer?.cancelPending();
    mainWindowCloseController?.cancelPending();
    quitting = true;
    // Route authority ends at quit admission, before renderer beforeunload can
    // delay or cancel the later managed-runtime handoff.
    desktopDevicePeerAgentLifecycle?.setConnection(undefined);
    activeDiscoveryAbort?.abort();
    sessionDragPreviewCoordinator.dispose();
    sessionDragNativeResultFence.dispose();
    // These three paths already own a bounded/native quit handoff. Let their
    // second-stage app.quit proceed without recursively starting complete exit.
    if (desktopUpdateChannelQuitHandoffPending || desktopUpdateNativeInstallQuitHandoffPending ||
      desktopCompleteExitQuitHandoffPending) return;
    event.preventDefault();
    // A channel/native apply operation may already own the managed-exit fence
    // while it is still stopping Orchestrator. Refuse an unrelated quit until that
    // operation either enters its explicit handoff or recovers.
    if (desktopUpdateChannelRelaunch !== undefined || desktopUpdateService?.isRelaunching() === true) {
      quitting = false;
      reconcileDesktopDevicePeerAgentLifecycle();
      return;
    }
    if (desktopCompleteExit !== undefined) return;
    const operation = performDesktopCompleteExit().finally(() => {
      if (desktopCompleteExit === operation) desktopCompleteExit = undefined;
    });
    desktopCompleteExit = operation;
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") ensureTray();
  });
  app.on("activate", () => {
    showMainWindow();
    void globalVoiceShortcutRecovery.request();
  });
  app.on("browser-window-focus", () => {
    desktopAttentionBadgeController?.setForeground(true);
    macNativeTaskStatusHost?.setApplicationFocused(true);
    providerModelRefreshHostLifecycle.syncApplicationFocused(isProviderModelApplicationForeground());
    void globalVoiceShortcutRecovery.request();
  });
  app.on("browser-window-blur", () => {
    setImmediate(() => {
      const foreground = isDesktopApplicationForeground();
      desktopAttentionBadgeController?.setForeground(foreground);
      macNativeTaskStatusHost?.setApplicationFocused(foreground);
      providerModelRefreshHostLifecycle.syncApplicationFocused(isProviderModelApplicationForeground());
    });
  });
  app.on("will-quit", () => {
    dedicatedHardwareTaskFocusFence.clear();
    dedicatedHardwareActions?.cancelAll("suspended");
    dedicatedHardwareActions = undefined;
    const hardwareController = dedicatedHardwareController;
    dedicatedHardwareController = undefined;
    void hardwareController?.dispose().catch(() => undefined);
    void desktopDevicePeerAgentLifecycle?.dispose();
    nativeFileClipboard?.dispose();
    nativeFileOpener?.dispose();
    nativeArtifactSourceRevealer?.dispose();
    globalVoiceShortcutRecovery.dispose();
    unregisterGlobalVoiceShortcut();
    stopGlobalVoiceShortcutCapture();
    const globalVoiceRecording = globalVoiceInputLease.snapshot();
    if (globalVoiceRecording.state !== "idle") {
      sendGlobalVoiceCommand({
        type: "cancel",
        generation: globalVoiceGenerationValue(globalVoiceRecording.generation)
      });
      resetGlobalVoicePresentation(globalVoiceRecording.generation);
    } else {
      resetGlobalVoicePresentation();
    }
    for (const [generation, waiter] of globalVoiceStopWaiters) {
      globalVoiceStopWaiters.delete(generation);
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Application is quitting."));
    }
    globalVoiceNativeShortcut.dispose();
    globalVoiceSystemAudioOwner = undefined;
    void globalVoiceSystemAudio.releaseAll().catch(() => undefined);
    destroyGlobalVoiceOverlay();
    sessionDragPreviewCoordinator.dispose();
    sessionDragNativeResultFence.dispose();
    desktopKeepAwakeController?.release();
    destroyRuntimeProcessMonitorWindow();
    destroyExtensionWindows();
    destroySessionWindows();
    nativeTaskStatusVisibleSessionsByContents.clear();
    macNativeTaskStatusHost?.dispose();
    macNativeTaskStatusHost = undefined;
    if (nativeTaskStatusDisplayRefresh !== undefined) {
      screen.removeListener("display-added", nativeTaskStatusDisplayRefresh);
      screen.removeListener("display-removed", nativeTaskStatusDisplayRefresh);
      screen.removeListener("display-metrics-changed", nativeTaskStatusDisplayRefresh);
      nativeTaskStatusDisplayRefresh = undefined;
    }
    desktopAttentionBadgeController?.dispose();
    desktopAttentionBadgeController = undefined;
    desktopNotifications.dispose();
    // Channel relaunch and native install listeners must observe the actual
    // quit handoff before updater disposal can revoke their listeners.
    if (!desktopUpdateChannelQuitHandoffPending && !desktopUpdateNativeInstallQuitHandoffPending) {
      disposeDesktopUpdateLifecycle();
    }
  });

  // Do not top-level await Electron readiness from the ESM entry module. On
  // some packaged hosts Electron waits for entry-module evaluation before it
  // advances the ready lifecycle, which deadlocks both normal startup and the
  // packaged smoke before `app_ready` can ever be observed.
  void app.whenReady().then(async () => {
    recordPackagedSmokeProgress("app_ready");
    registerPackagedAppProtocol();
    initializeDesktopUpdateChannelSettings();
    await requireDesktopUpdateChannelSettings().initialize();
    initializeDesktopUpdateService();
    initializeDesktopUpdateAutoSettings();
    initializeDesktopAttentionBadge();
    await initializeDesktopWindowInteractionSettings();
    desktopMainWindowCloseSettings = createDesktopMainWindowCloseSettingsStore(
      join(app.getPath("userData"), "main-window-close-settings.json"), process.platform
    );
    await desktopMainWindowCloseSettings.initialize();
    await initializeDesktopNativeTaskStatus();
    if (shouldRunDesktopUpdateStartup()) desktopUpdateStartupPhase = { kind: "checking" };
    await initializeDesktopKeepAwake();
    await initializeDedicatedHardwareInput();
    registerIpc();
    installMicrophoneLifecycle();
    installProviderModelPowerLifecycle();
    preferredSystemLocale = readDesktopPreferredSystemLocale(app);
    applicationMenuLocale = preferredSystemLocale;
    installDesktopApplicationMenu();
    createWindow();
    initializeDesktopDevicePeerAgentLifecycle();
    void beginDesktopUpdateStartup();
    if (!packagedSmoke) ensureTray();
  }, (error: unknown) => {
    const message = safeSmokeError(error);
    recordPackagedSmokeProgress(`app_ready_failed ${message}`);
    process.stderr.write(`JOKO_DESKTOP_APP_READY_FAILED ${message}\n`);
    if (packagedSmoke) {
      finishPackagedSmoke(`JOKO_DESKTOP_APP_READY_FAILED ${message}`, 1);
    } else {
      disposeDesktopUpdateLifecycle();
      app.exit(1);
    }
  });
}

function createWindow(): void {
  const retiredDocument = mainWindowDocuments.retireCurrent();
  if (retiredDocument !== undefined) {
    desktopNotifications.retireOwner(retiredDocument.endpoint, retiredDocument.occurrence);
    retireDedicatedHardwareCatalogOwner(retiredDocument.endpoint, retiredDocument.occurrence);
  }
  desktopDeepLinkDelivery.resetRenderer();
  const frameOptions = process.platform === "darwin"
    ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 16 } }
    : { frame: false };
  const mainWindowState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 800
  });
  const inspectorWindowState = windowStateKeeper({
    defaultWidth: 520,
    defaultHeight: 860,
    file: "inspector-window-state.json"
  });
  managedMainWindowState = mainWindowState;
  managedInspectorWindowState = inspectorWindowState;
  const window = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#f2f2f2",
    title: "Joko",
    autoHideMenuBar: true,
    show: false,
    ...activationClickBrowserWindowOptions(),
    ...frameOptions,
    webPreferences: {
      // Sandboxed Electron preload scripts run in a restricted CommonJS
      // environment. TypeScript emits this `.cts` entry as preload.cjs.
      preload: join(sourceDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false
    }
  });
  const windowContents = onDesktopWindowClosed(window, (contents) => {
    const sourceId = contents.id;
    releaseDesktopAttentionSource(sourceId);
    releaseApplicationMenuShortcutRecording(sourceId);
    clearDesktopNativeTaskStatusVisibility(contents);
    if (mainWindow === window) {
      retireMainWindowDocument(window, contents);
      unregisterGlobalVoiceShortcut();
      stopGlobalVoiceShortcutCapture(contents);
      resetGlobalVoicePresentation();
      destroyInspectorWindow();
      mainWindow = undefined;
    }
  });
  mainWindowContentsByWindow.set(window, windowContents);
  const attentionSourceId = windowContents.id;
  mainWindow = window;
  let mainUiLoadRecovery: Promise<void> | undefined;
  const beginMainUiLoadRecovery = (initialFailure?: unknown): void => {
    if (mainUiLoadRecovery !== undefined || window.isDestroyed() || quitting) return;
    const options = {
      unavailable: () => window.isDestroyed() || quitting,
      load: () => loadUi(window),
      presentFailure: (error: unknown, attempt: number) =>
        presentDesktopWindowLoadFailure("main", error, attempt),
      close: () => {
        if (!window.isDestroyed()) window.destroy();
        if (!quitting) app.quit();
      }
    };
    const recovery = initialFailure === undefined
      ? loadDesktopWindowWithRecovery(options)
      : recoverDesktopWindowAfterFailure(options, initialFailure);
    const operation = recovery
      .then(() => undefined)
      .catch((error: unknown) => {
        process.stderr.write(`JOKO_DESKTOP_WINDOW_RECOVERY_FAILED ${safeSmokeError(error)}\n`);
      })
      .finally(() => {
        if (mainUiLoadRecovery === operation) mainUiLoadRecovery = undefined;
      });
    mainUiLoadRecovery = operation;
  };
  installDesktopNativeTaskStatusVisibilityLifecycle(window);
  window.on("show", () => refreshDedicatedHardwarePrimaryVisibility(window, true));
  window.on("restore", () => refreshDedicatedHardwarePrimaryVisibility(window, true));
  window.on("hide", () => refreshDedicatedHardwarePrimaryVisibility(window));
  window.on("minimize", () => refreshDedicatedHardwarePrimaryVisibility(window));
  mainWindowState.manage(window);
  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isDesktopMainDocumentReplacementNavigation(isMainFrame, isInPlace)) {
      // An attempted navigation is not proof that a replacement Document
      // committed: beforeunload or load failure may leave this preload alive.
      // Inspector intentionally retires on every non-in-place main-frame
      // attempt; main-Document authority rotates only when the next preload
      // synchronously captures its occurrence.
      inspectorWindowLifecycle?.ownerRetired(window);
    }
  });
  window.webContents.on("did-start-loading", () => {
    unregisterGlobalVoiceShortcut();
    stopGlobalVoiceShortcutCapture(window.webContents);
    resetGlobalVoicePresentation();
    resetMainApplicationMenuState(window.webContents);
    clearNativeTaskStatusProjection();
    clearDesktopNativeTaskStatusVisibility(window.webContents);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    retireMainWindowDocument(window, window.webContents);
    inspectorWindowLifecycle?.ownerRetired(window);
    unregisterGlobalVoiceShortcut();
    stopGlobalVoiceShortcutCapture(window.webContents);
    resetGlobalVoicePresentation();
    resetMainApplicationMenuState(window.webContents);
    clearNativeTaskStatusProjection();
    clearDesktopNativeTaskStatusVisibility(window.webContents);
    releaseDesktopAttentionSource(attentionSourceId);
    if (!packagedSmoke && !window.isDestroyed() && !quitting) {
      beginMainUiLoadRecovery(desktopRendererLossError("main", details));
    }
  });
  window.webContents.on("will-prevent-unload", notifyDesktopQuitBlocked);
  installSelectionContextMenu(window, {
    platform: process.platform,
    systemLocale: () => applicationMenuLocale,
    buildMenu: (template) => Menu.buildFromTemplate([...template]),
    openExternal: (url) => shell.openExternal(url)
  });
  const electronSession = window.webContents.session;
  electronSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    isAllowedDesktopMicrophoneRequest({
      permission,
      trustedOwner: webContents !== null && isTrustedApplicationContents(webContents),
      mainFrame: microphoneMainFrameFromPermissionDetails(details),
      trustedFrameUrl: webContents?.getURL() ?? "",
      requestingUrl: requestingUrlFromPermissionDetails(details, requestingOrigin),
      mediaTypes: microphoneMediaTypesFromPermissionDetails(details)
    }) || isAllowedDesktopClipboardWriteRequest({
      permission,
      trustedOwner: webContents !== null && isTrustedClipboardWriteContents(webContents),
      mainFrame: microphoneMainFrameFromPermissionDetails(details),
      trustedFrameUrl: webContents?.getURL() ?? "",
      requestingUrl: requestingUrlFromPermissionDetails(details, requestingOrigin)
    }));
  electronSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isAllowedDesktopMicrophoneRequest({
      permission,
      trustedOwner: isTrustedApplicationContents(webContents),
      mainFrame: microphoneMainFrameFromPermissionDetails(details),
      trustedFrameUrl: webContents.getURL(),
      requestingUrl: requestingUrlFromPermissionDetails(details),
      mediaTypes: microphoneMediaTypesFromPermissionDetails(details)
    }) || isAllowedDesktopClipboardWriteRequest({
      permission,
      trustedOwner: isTrustedClipboardWriteContents(webContents),
      mainFrame: microphoneMainFrameFromPermissionDetails(details),
      trustedFrameUrl: webContents.getURL(),
      requestingUrl: requestingUrlFromPermissionDetails(details)
    }));
  });
  electronSession.setDevicePermissionHandler(() => false);
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  electronSession.on("will-download", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
  });
  window.webContents.setWindowOpenHandler(({ url, frameName, features, postBody }) => {
    if (isInspectorWindowOpenRequest(url, frameName) &&
      features === INSPECTOR_WINDOW_FEATURES && postBody === undefined) {
      if (inspectorWindow !== undefined && !inspectorWindow.isDestroyed()) {
        return { action: "deny" };
      }
      const inspectorFrameOptions = process.platform === "darwin"
        ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 16 } }
        : { frame: false };
      return {
        action: "allow",
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          x: inspectorWindowState.x,
          y: inspectorWindowState.y,
          width: inspectorWindowState.width,
          height: inspectorWindowState.height,
          minWidth: 360,
          minHeight: 480,
          title: "Joko Inspector",
          autoHideMenuBar: true,
          show: false,
          backgroundColor: "#f2f2f2",
          ...activationClickBrowserWindowOptions(),
          ...inspectorFrameOptions,
          webPreferences: {
            preload: join(sourceDirectory, "inspector-preload.cjs"),
            contextIsolation: true,
            devTools: !app.isPackaged,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: false,
            navigateOnDragDrop: false,
            safeDialogs: true,
            spellcheck: false
          }
        }
      };
    }
    if (isSafeExternalUrl(url)) void openExternalSafely(url).catch(() => undefined);
    return { action: "deny" };
  });
  window.webContents.on("did-create-window", (childWindow, details) => {
    if (!isInspectorWindowOpenRequest(details.url, details.frameName) ||
      (inspectorWindow !== undefined && !inspectorWindow.isDestroyed())) {
      childWindow.destroy();
      return;
    }
    inspectorWindowState.manage(childWindow);
    installInspectorWindowSecurity(childWindow, window);
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedPrimaryWindowNavigation(url, navigationPolicy)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) void openExternalSafely(url).catch(() => undefined);
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedPrimaryWindowNavigation(url, navigationPolicy)) event.preventDefault();
  });
  electronSession.webRequest.onBeforeRequest((details, callback) => {
    let protocol: string | undefined;
    try { protocol = new URL(details.url).protocol; } catch { protocol = undefined; }
    if (
      (protocol === "file:" || protocol === `${DESKTOP_APP_SCHEME}:`) &&
      !isAllowedPackagedBundleResource(details.url, navigationPolicy)
    ) {
      callback({ cancel: true });
      return;
    }
    if (
      (protocol === "http:" || protocol === "https:" || protocol === "ws:" || protocol === "wss:") &&
      !isAllowedRendererNetworkUrl(details.url)
    ) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  electronSession.webRequest.onHeadersReceived((details, callback) => {
    if (!shouldMergeDesktopFrameContentSecurityPolicy(details.resourceType, details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: mergeContentSecurityPolicyHeaders(details.responseHeaders)
    });
  });
  const closeController = createDesktopMainWindowCloseController({
    isCurrent: () => mainWindow === window && !window.isDestroyed() && canApplyMainWindowClose(),
    read: () => requireDesktopMainWindowCloseSettings().initialize(),
    currentSettings: () => requireDesktopMainWindowCloseSettings().get(),
    prompt: async (signal) => {
      const labels = desktopMainWindowCloseLabels(applicationMenuLocale);
      const keepRunning = process.platform === "win32" ? "tray" : "minimize";
      const result = await dialog.showMessageBox(window, {
        type: "question", title: labels.title, message: labels.message, detail: labels.detail,
        buttons: [labels.cancel, labels[keepRunning], labels.quit], defaultId: 0, cancelId: 0, noLink: true, signal
      });
      return result.response === 1 ? keepRunning : result.response === 2 ? "quit" : null;
    },
    save: async (behavior, expectedRevision, isCurrent) => {
      const settings = await requireDesktopMainWindowCloseSettings().set({ behavior, expectedRevision }, isCurrent);
      broadcastDesktopMainWindowCloseSettings(settings);
      return settings;
    },
    apply: (behavior, isCurrent) => applyDesktopMainWindowCloseBehavior(window, behavior, {
      isCurrent, quit: () => app.quit(), hideToTray: (current) => closeWindowToTray(window, current)
    }),
    onError: async (signal) => {
      const labels = desktopMainWindowCloseLabels(applicationMenuLocale);
      await dialog.showMessageBox(window, {
        type: "error", title: labels.title, message: labels.failure, buttons: [labels.cancel], cancelId: 0, signal
      });
    }
  });
  mainWindowCloseController = closeController;
  window.once("closed", () => {
    closeController.cancelPending();
    if (mainWindowCloseController === closeController) mainWindowCloseController = undefined;
  });
  window.on("close", (event) => {
    // Electron's macOS autoUpdater emits before-quit only after it has started
    // closing windows. The post-stop native handoff flag is therefore also an
    // authoritative close boundary; dirty beforeunload may still cancel it,
    // in which case the driver's will-quit timeout recovers managed Orchestrator.
    if (quitting || desktopUpdateNativeInstallQuitHandoffPending) return;
    event.preventDefault();
    // All main-window close entrances share the device preference. macOS
    // retains its existing keep-running behavior without a platform override.
    if (process.platform === "darwin") void closeWindowToTray(window,
      () => mainWindow === window && !window.isDestroyed() && canApplyMainWindowClose());
    else void closeController.request();
  });
  window.on("hide", () => inspectorWindowLifecycle?.ownerHidden(window));
  window.on("minimize", () => inspectorWindowLifecycle?.ownerHidden(window));
  window.on("show", () => inspectorWindowLifecycle?.ownerShown(window));
  window.on("restore", () => inspectorWindowLifecycle?.ownerShown(window));
  if (packagedSmoke) {
    const timeout = setTimeout(() => {
      process.stderr.write("JOKO_DESKTOP_SMOKE_TIMEOUT\n");
      finishPackagedSmoke("JOKO_DESKTOP_SMOKE_TIMEOUT", 1);
    }, packagedSmokeTimeoutMs);
    timeout.unref();
    const failInitialPackagedSmokeLoad = (_event: unknown, code: number, description: string): void => {
      clearTimeout(timeout);
      process.stderr.write(`JOKO_DESKTOP_SMOKE_LOAD_FAILED ${code} ${description.slice(0, 500)}\n`);
      finishPackagedSmoke(`JOKO_DESKTOP_SMOKE_LOAD_FAILED ${code} ${description.slice(0, 500)}`, 1);
    };
    window.webContents.once("did-fail-load", failInitialPackagedSmokeLoad);
    window.webContents.once("did-finish-load", () => {
      // This listener owns only the initial bundle load. Later full-journey
      // probes deliberately fail a main-Document request and must observe that
      // failure without a stale startup listener terminating the smoke.
      window.webContents.removeListener("did-fail-load", failInitialPackagedSmokeLoad);
      void window.webContents.executeJavaScript(
        [
          "(async () => {",
          "  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));",
          `  const runFullJourney = ${JSON.stringify(packagedSmokeScope === "full")};`,
          "  let genericConnectionScreenSeen = Boolean(document.querySelector('.connection-screen'));",
          "  const observer = new MutationObserver(() => {",
          "    if (document.querySelector('.connection-screen')) genericConnectionScreenSeen = true;",
          "  });",
          "  observer.observe(document.documentElement, { childList: true, subtree: true });",
          "  try {",
          "    const shellReady = Boolean(",
          "      document.getElementById('root')?.childElementCount > 0 &&",
          "      window.jokoDesktop &&",
          "      typeof window.jokoDesktop.platform === 'string' &&",
          "      typeof window.jokoDesktop.chooseFiles === 'function' &&",
          "      typeof window.jokoDesktop.dedicatedHardware?.getDedicatedHardwareState === 'function' &&",
          "      typeof window.jokoDesktop.extensionLibraries?.pickLocation === 'function' &&",
          "      typeof window.jokoDesktop.extensionLibraries?.reveal === 'function' &&",
          "      typeof window.jokoDesktop.extensionLibraries?.beginSave === 'function' &&",
          "      typeof window.jokoDesktop.extensionLibraries?.commitSave === 'function' &&",
          "      typeof window.jokoDesktop.extensionLibraries?.cancelSave === 'function' &&",
          "      typeof window.jokoDesktop.extensionLibraries?.clipboardWrite === 'function' &&",
          "      typeof window.jokoDesktop.deepLinks?.takePending === 'function' &&",
          "      typeof window.jokoDesktop.deepLinks?.acknowledge === 'function' &&",
          "      typeof window.jokoDesktop.deepLinks?.onNavigate === 'function' &&",
          "      typeof window.jokoDesktop.discovery?.scan === 'function' &&",
          "      typeof window.jokoDesktop.managedOrchestrator?.getConnection === 'function' &&",
          "      typeof window.jokoDesktop.managedOrchestrator?.getStatus === 'function' &&",
          "      typeof window.jokoDesktop.managedOrchestrator?.retry === 'function' &&",
          "      typeof window.jokoDesktop.managedOrchestrator?.adoptConnection === 'function' &&",
          "      typeof window.jokoDesktop.openExternal === 'function' &&",
          "      typeof window.jokoDesktop.updates?.getStatus === 'function' &&",
          "      typeof window.jokoDesktop.updates?.check === 'function' &&",
          "      typeof window.jokoDesktop.updates?.relaunch === 'function' &&",
          "      typeof window.jokoDesktop.updates?.onStatus === 'function' &&",
          "      typeof window.jokoDesktop.window?.minimize === 'function' &&",
          "      typeof window.jokoDesktop.window?.close === 'function' &&",
          "      typeof window.jokoDesktop.sessionWindows?.open === 'function' &&",
          "      typeof window.jokoDesktop.sessionWindows?.beginDragPreview === 'function' &&",
          "      typeof window.jokoDesktop.sessionWindows?.endDragPreview === 'function' &&",
          "      typeof window.jokoDesktop.sessionWindows?.openIfDroppedOutside === 'function' &&",
          "      typeof window.jokoDesktop.runtimeProcessMonitor?.open === 'function' &&",
          "      typeof window.jokoDesktop.credentials?.get === 'function'",
          "    );",
          `    const connectOrigin = ${JSON.stringify(packagedSmokeConnectOrigin ?? "")};`,
          `    const publicHttpOrigin = ${JSON.stringify(packagedSmokePublicHttpOrigin ?? "")};`,
          "    if (!shellReady || location.origin !== 'joko://app' || !globalThis.crypto?.subtle || connectOrigin === '' || publicHttpOrigin === '') {",
          "      throw new Error('Desktop shell or secure renderer primitives are unavailable.');",
          "    }",
          "    const loginDeadline = Date.now() + 15_000;",
          "    while (!genericConnectionScreenSeen && Date.now() < loginDeadline) await sleep(100);",
          "    if (!genericConnectionScreenSeen || !document.querySelector('.connection-screen')) {",
          "      throw new Error('The generic connection screen did not appear before managed connection.');",
          "    }",
          `    const managedDeadline = Date.now() + ${packagedSmokeManagedReadyTimeoutMs};`,
          "    let managedStatus;",
          "    let managedConnection;",
          "    let managedConnectClicked = false;",
          "    do {",
          "      [managedStatus, managedConnection] = await Promise.all([",
          "        window.jokoDesktop.managedOrchestrator.getStatus(),",
          "        window.jokoDesktop.managedOrchestrator.getConnection()",
          "      ]);",
          "      const managedConnect = document.querySelector('button[data-managed-local-connect]');",
          "      if (",
          "        managedStatus?.state === 'ready' &&",
          "        managedConnection &&",
          "        managedStatus.connection?.profileId === managedConnection.profileId &&",
          "        managedConnect instanceof HTMLButtonElement &&",
          "        !managedConnect.disabled",
          "      ) {",
          "        managedConnect.click();",
          "        managedConnectClicked = true;",
          "        break;",
          "      }",
          "      await sleep(100);",
          "    } while (Date.now() < managedDeadline);",
          "    if (managedStatus?.state !== 'ready' || !managedConnection || !managedConnectClicked) {",
          "      throw new Error(`Managed Orchestrator did not expose the local connection action (state=${String(managedStatus?.state ?? 'unknown')}).`);",
          "    }",
          "    const productDeadline = Date.now() + 15_000;",
          "    while (!document.querySelector('.app') && Date.now() < productDeadline) await sleep(100);",
          "    if (!document.querySelector('.app') || document.querySelector('.connection-screen')) {",
          "      throw new Error('The local connection action did not reach the product UI.');",
          "    }",
          "    if (runFullJourney) {",
          "      window.location.hash = '#/settings/about';",
          "      const monitorActionDeadline = Date.now() + 5_000;",
          "      while (!document.querySelector('[data-runtime-process-monitor-open]') && Date.now() < monitorActionDeadline) await sleep(100);",
          "      const monitorOpen = document.querySelector('[data-runtime-process-monitor-open]');",
          "      if (!(monitorOpen instanceof HTMLButtonElement) || monitorOpen.disabled) {",
          "        throw new Error('The standalone runtime resource monitor action is unavailable.');",
          "      }",
          "      monitorOpen.click();",
          "    }",
          "    const response = await fetch(`${connectOrigin}/joko.v1.ConnectionService/GetServerInfo`, {",
          "      method: 'POST',",
          "      mode: 'cors',",
          "      credentials: 'omit',",
          "      cache: 'no-store',",
          "      referrerPolicy: 'no-referrer',",
          "      headers: {",
          "        'content-type': 'application/json',",
          "        'connect-protocol-version': '1',",
          "        'x-joko-client-version': 'desktop-smoke'",
          "      },",
          "      body: '{}'",
          "    });",
          "    if (!response.ok) throw new Error('Loopback CORS request failed.');",
          "    const body = await response.json();",
          "    if (body?.serverId !== 'desktop-smoke') throw new Error('Loopback CORS response identity was invalid.');",
          "    try {",
          "      await fetch(`${publicHttpOrigin}/public-http-must-be-blocked`, {",
          "        mode: 'cors',",
          "        credentials: 'omit',",
          "        headers: { 'x-joko-client-version': 'desktop-smoke' }",
          "      });",
          "      throw new Error('Public HTTP escaped the renderer network policy.');",
          "    } catch (error) {",
          "      if (error instanceof Error && error.message === 'Public HTTP escaped the renderer network policy.') throw error;",
          "    }",
          "    if (!genericConnectionScreenSeen) throw new Error('The generic connection screen was never observed.');",
          "    return true;",
          "  } finally {",
          "    observer.disconnect();",
          "  }",
          "})()"
        ].join("\n"),
        true
      ).then(async (rendered: unknown) => {
        if (rendered !== true) {
          throw new Error("The packaged product renderer did not return its exact ready marker.");
        }
        await verifyPackagedSmokeDedicatedHardwareState(window);
        if (packagedSmokeScope === "draft") {
          await verifyPackagedSmokeNewTaskDraftCrash(window);
        } else {
          if (nativeTaskStatusSupported) await verifyPackagedSmokeNativeTaskStatus(window);
          if (packagedSmokeScope === "full") {
            await verifyPackagedSmokeRuntimeProcessMonitor(window);
            if (process.platform === "win32" || process.platform === "darwin") await verifyPackagedSmokeFullscreen(window);
            await verifyPackagedSmokeSessionWindow(window);
            await verifyPackagedSmokeNewTaskDraftCrash(window);
          } else {
            recordPackagedSmokeProgress("inspector_scope_selected");
          }
          await verifyPackagedSmokeInspectorWindow(window);
        }
      }).then(() => {
        clearTimeout(timeout);
        process.stdout.write("JOKO_DESKTOP_SMOKE_OK\n");
        finishPackagedSmoke("JOKO_DESKTOP_SMOKE_OK", 0);
      }, (error: unknown) => {
        clearTimeout(timeout);
        process.stderr.write(`JOKO_DESKTOP_SMOKE_SCRIPT_FAILED ${safeSmokeError(error)}\n`);
        finishPackagedSmoke(`JOKO_DESKTOP_SMOKE_SCRIPT_FAILED ${safeSmokeError(error)}`, 1);
      });
    });
  } else {
    window.once("ready-to-show", () => window.show());
  }
  if (packagedSmoke) {
    void loadUi(window).catch((error: unknown) => {
      process.stderr.write(`JOKO_DESKTOP_SMOKE_BUNDLE_FAILED ${safeSmokeError(error)}\n`);
      finishPackagedSmoke(`JOKO_DESKTOP_SMOKE_BUNDLE_FAILED ${safeSmokeError(error)}`, 1);
    });
  } else {
    beginMainUiLoadRecovery();
  }
}

async function verifyPackagedSmokeDedicatedHardwareState(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    throw new Error("Packaged smoke owner retired before dedicated hardware verification.");
  }
  const raw: unknown = await window.webContents.executeJavaScript([
    "(async () => {",
    "  if (!document.querySelector('.app') || typeof window.jokoDesktop?.dedicatedHardware?.getDedicatedHardwareState !== 'function') {",
    "    throw new Error('Dedicated hardware state is unavailable in the product renderer.');",
    "  }",
    "  return window.jokoDesktop.dedicatedHardware.getDedicatedHardwareState();",
    "})()"
  ].join("\n"), true);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Packaged smoke dedicated hardware Snapshot was invalid.");
  }
  const snapshot = raw as Record<string, unknown>;
  if (snapshot.models === null || typeof snapshot.models !== "object" || Array.isArray(snapshot.models)) {
    throw new Error("Packaged smoke dedicated hardware models were invalid.");
  }
  const models = snapshot.models as Record<string, unknown>;
  const expectedModels = {} as Record<DedicatedHardwareModelId, unknown>;
  for (const model of DEDICATED_HARDWARE_MODEL_IDS) {
    const state = models[model];
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("Packaged smoke dedicated hardware model state was unavailable.");
    }
    const { settingsError: _settingsError, settings: _settings, taskSlots: _taskSlots, ...connection } =
      state as Record<string, unknown>;
    const parsed = parseDedicatedHardwareUtilityMessage({ version: 1, generation: 1, kind: "state", ...connection });
    if (parsed?.kind !== "state" || parsed.model !== model) {
      throw new Error("Packaged smoke dedicated hardware connection state was invalid.");
    }
    expectedModels[model] = {
      model,
      status: "disabled",
      reason: null,
      devicePresent: null,
      transport: null,
      firmwareVersion: null,
      batteryPercent: null,
      charging: null,
      inputPermission: "unknown",
      keymap: parsed.keymap,
      settingsError: null,
      settings: createDefaultDedicatedHardwareSettings(model),
      taskSlots: Array.from({ length: 6 }, (_, slot) => ({ slot, sessionId: null, title: null }))
    };
  }
  if (!isDeepStrictEqual(raw, { version: 1, models: expectedModels })) {
    throw new Error("Packaged smoke dedicated hardware Snapshot did not match the isolated disabled defaults.");
  }
  recordPackagedSmokeProgress("dedicated_hardware_main_snapshot_verified");
}

async function verifyPackagedSmokeNativeTaskStatus(owner: BrowserWindow): Promise<void> {
  if (owner.isDestroyed() || owner.webContents.isDestroyed()) {
    throw new Error("Packaged smoke owner retired before native Task Status verification.");
  }
  const ready = await owner.webContents.executeJavaScript(`(async () => {
    const bridge = window.jokoDesktop?.nativeTaskStatus;
    if (!window.jokoDesktop?.capabilities.includes("native.taskStatus") || !bridge) return false;
    const settings = await bridge.getSettings();
    await bridge.setSettings({ ...settings, enabled: true });
    await bridge.publish({ ownerId: "desktop-smoke-task-status", revision: "1", locale: "en", sessions: [] });
    return true;
  })()`, true) as unknown;
  if (ready !== true) throw new Error("Native Task Status bridge was unavailable in the product renderer.");
  const deadline = Date.now() + 5_000;
  let ambient: BrowserWindow | undefined;
  while (Date.now() < deadline) {
    ambient = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Joko task status");
    if (ambient !== undefined && !ambient.isDestroyed() && ambient.isVisible()) break;
    await waitForPackagedSmokePoll();
  }
  if (ambient === undefined || ambient.isDestroyed() || !ambient.isVisible()) {
    throw new Error("Native Task Status did not create a visible ambient window.");
  }
  const idleShape = await ambient.webContents.executeJavaScript(`({
    idle: Boolean(document.querySelector('.compact-row--idle')),
    compact: Boolean(document.querySelector('.compact-row')),
    expanded: Boolean(document.querySelector('.expanded-shell')),
    ready: document.readyState
  })`, true) as { readonly idle: boolean; readonly compact: boolean; readonly expanded: boolean; readonly ready: string };
  const compactHeight = ambient.getBounds().height;
  if (!idleShape.idle || compactHeight > 64) {
    throw new Error(`Native Task Status did not render its idle compact state (${JSON.stringify({
      ...idleShape, height: compactHeight
    })}).`);
  }
  const focusedBefore = BrowserWindow.getFocusedWindow();
  const expansionDeadline = Date.now() + 5_000;
  await ambient.webContents.executeJavaScript(
    "document.querySelector('a[href=\"joko-task-status://toggle\"]')?.click(); true", true
  );
  while (Date.now() < expansionDeadline && !ambient.isDestroyed() && ambient.getBounds().height <= compactHeight) {
    await waitForPackagedSmokePoll();
  }
  if (ambient.isDestroyed() || ambient.getBounds().height <= compactHeight ||
    BrowserWindow.getFocusedWindow() !== focusedBefore) {
    throw new Error("Native Task Status did not expand without changing application focus.");
  }
  await owner.webContents.executeJavaScript(`(async () => {
    const bridge = window.jokoDesktop.nativeTaskStatus;
    const settings = await bridge.getSettings();
    await bridge.setSettings({ ...settings, enabled: false });
  })()`, true);
  if (!ambient.isDestroyed()) throw new Error("Native Task Status did not retire after opt-out.");
  recordPackagedSmokeProgress("native_task_status_preview_verified");
}

function safeSmokeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? "unknown error"))
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
}

async function verifyPackagedSmokeInspectorWindow(owner: BrowserWindow): Promise<void> {
  if (owner.isDestroyed() || owner.webContents.isDestroyed()) {
    throw new Error("Packaged smoke owner window retired before Inspector verification.");
  }
  const preexistingInspector = inspectorWindow;
  if (preexistingInspector !== undefined) throw new Error("Packaged smoke Inspector existed before its first detach.");
  if (owner.isMinimized()) owner.restore();
  // The Windows smoke process is launched without an activation grant. Match
  // the real no-focus-theft restore path first, then request activation.
  owner.showInactive();
  owner.focus();
  await waitForPackagedSmokeInspectorCondition(
    () => owner.isVisible() && !owner.isMinimized(),
    "owner reveal before first detach"
  );
  await installPackagedSmokeInspectorCloseObserver(owner);

  const initial = await openPackagedSmokeInspector(owner);
  await requestPackagedSmokeInspectorOpen(owner);
  if (inspectorWindow !== initial || initial.isDestroyed() || initial.isVisible()) {
    throw new Error("Packaged Inspector exposed or replaced its child before portal readiness.");
  }
  recordPackagedSmokeProgress("inspector_pending_reuse_remained_hidden");
  await inspectPackagedSmokeInspectorSurface(initial);
  await waitForPackagedSmokeInspectorState(initial,
    () => initial.isVisible() && !initial.isMinimized(), "initial reveal");
  await waitForPackagedSmokeInspectorCondition(() => initial.isFocused(), "initial focus");
  recordPackagedSmokeProgress("inspector_initial_ready");

  await requestPackagedSmokeInspectorMinimize(initial);
  await waitForPackagedSmokeInspectorState(initial, () => initial.isMinimized(), "pre-reuse minimize");
  owner.show();
  owner.focus();
  await waitForPackagedSmokeInspectorCondition(() => owner.isFocused(), "pre-reuse owner focus");
  if (!await requestPackagedSmokeInspectorActivation(owner)) {
    throw new Error("Packaged Inspector rejected activation from its focused exact owner.");
  }
  const reusedInspector = inspectorWindow;
  if (reusedInspector !== initial) throw new Error("Packaged Inspector did not reuse its exact owner occurrence.");
  await waitForPackagedSmokeInspectorState(initial,
    () => initial.isVisible() && !initial.isMinimized() && initial.isFocused(), "exact-owner activation");
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 300));
  if (initial.isDestroyed() || !initial.isVisible() || initial.isMinimized() || !initial.isFocused()) {
    throw new Error("Packaged Inspector activation did not remain usable after native focus settled.");
  }
  recordPackagedSmokeProgress("inspector_same_owner_reused");

  owner.hide();
  await waitForPackagedSmokeInspectorState(initial, () => !initial.isVisible(), "owner hide");
  owner.showInactive();
  await waitForPackagedSmokeInspectorState(initial, () => initial.isVisible(), "owner show");
  owner.minimize();
  await waitForPackagedSmokeInspectorState(initial, () => !initial.isVisible(), "owner minimize");
  owner.restore();
  owner.showInactive();
  await waitForPackagedSmokeInspectorState(initial, () => initial.isVisible(), "owner restore");
  recordPackagedSmokeProgress("inspector_owner_visibility_verified");

  initial.focus();
  await waitForPackagedSmokeInspectorCondition(() => initial.isFocused(), "user-close focus");
  void initial.webContents.executeJavaScript(
    "(() => { void window.jokoInspectorDesktop?.window.close('user'); return true; })()",
    true
  ).catch(() => undefined);
  recordPackagedSmokeProgress("inspector_user_close_requested");
  await waitForPackagedSmokeInspectorDestroyed(initial, "user close");
  await waitForPackagedSmokeInspectorClosedCount(owner, 1);
  await waitForPackagedSmokeInspectorCondition(() => owner.isFocused(), "safe owner focus return");
  recordPackagedSmokeProgress("inspector_user_close_returned_focus");

  const reloading = await openPackagedSmokeInspector(owner, initial);
  await inspectPackagedSmokeInspectorSurface(reloading);
  const foreground = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false
    }
  });
  await foreground.loadURL(INSPECTOR_WINDOW_URL);
  foreground.show();
  foreground.focus();
  await waitForPackagedSmokeInspectorCondition(() => foreground.isFocused(), "independent focus");
  if (await requestPackagedSmokeInspectorActivation(owner) || !foreground.isFocused() || reloading.isFocused()) {
    throw new Error("Packaged Inspector activation stole focus from a foreground window outside its owner.");
  }
  recordPackagedSmokeProgress("inspector_background_activation_rejected");
  await waitForPackagedSmokeOwnerDocument(owner, "reload", () => owner.reload());
  await waitForPackagedSmokeInspectorDestroyed(reloading, "owner reload");
  if (inspectorWindow !== undefined || inspectorWindowOwner !== undefined || inspectorWindowLifecycle !== undefined ||
    inspectorWindowOccurrence !== undefined) {
    throw new Error("Packaged Inspector retained stale state after owner reload.");
  }
  recordPackagedSmokeProgress("inspector_owner_reload_retired");

  await installPackagedSmokeInspectorCloseObserver(owner);
  owner.show();
  const failing = await openPackagedSmokeInspector(owner, reloading);
  await inspectPackagedSmokeInspectorSurface(failing);
  foreground.show();
  foreground.focus();
  await waitForPackagedSmokeInspectorCondition(() => foreground.isFocused(), "pre-child-failure independent focus");
  const childFailureDispatched = (failing.webContents as unknown as {
    emit(event: string, eventObject: object, details: { readonly reason: "crashed"; readonly exitCode: number }): boolean;
  }).emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  if (!childFailureDispatched) throw new Error("Packaged Inspector child-failure event had no lifecycle listener.");
  await waitForPackagedSmokeInspectorDestroyed(failing, "child renderer failure");
  await waitForPackagedSmokeInspectorClosedCount(owner, 1);
  if (inspectorWindow !== undefined || inspectorWindowOwner !== undefined || inspectorWindowLifecycle !== undefined ||
    inspectorWindowOccurrence !== undefined) {
    throw new Error("Packaged Inspector retained stale state after child renderer failure.");
  }
  if (!foreground.isFocused() || owner.isFocused()) {
    throw new Error("Packaged Inspector child renderer failure stole focus from another application window.");
  }
  recordPackagedSmokeProgress("inspector_child_failure_notified_without_focus_theft");

  owner.show();
  const crashing = await openPackagedSmokeInspector(owner, failing);
  await inspectPackagedSmokeInspectorSurface(crashing);
  foreground.show();
  foreground.focus();
  await waitForPackagedSmokeInspectorCondition(() => foreground.isFocused(), "pre-crash independent focus");
  owner.webContents.forcefullyCrashRenderer();
  await waitForPackagedSmokeInspectorDestroyed(crashing, "owner crash");
  if (inspectorWindow !== undefined || inspectorWindowOwner !== undefined || inspectorWindowLifecycle !== undefined ||
    inspectorWindowOccurrence !== undefined) {
    throw new Error("Packaged Inspector retained stale state after owner crash.");
  }
  foreground.destroy();
  recordPackagedSmokeProgress("inspector_owner_crash_retired");
  recordPackagedSmokeProgress("inspector_lifecycle_verified");
}

async function installPackagedSmokeInspectorCloseObserver(owner: BrowserWindow): Promise<void> {
  const installed = await owner.webContents.executeJavaScript(
    [
      "(() => {",
      "  const desktop = window.jokoDesktop;",
      "  if (typeof desktop?.inspectorWindow?.onClosed !== 'function') return false;",
      "  const state = { closed: 0 };",
      "  globalThis.__jokoInspectorSmoke = state;",
      "  desktop.inspectorWindow.onClosed(() => { state.closed += 1; });",
      "  return true;",
      "})()"
    ].join("\n"),
    true
  );
  if (installed !== true) throw new Error("Packaged Inspector close observer was unavailable.");
}

async function requestPackagedSmokeInspectorOpen(owner: BrowserWindow): Promise<boolean> {
  const opened = await owner.webContents.executeJavaScript(
    `window.open(${JSON.stringify(INSPECTOR_WINDOW_URL)}, ${JSON.stringify(INSPECTOR_WINDOW_FRAME_NAME)}, ${JSON.stringify(INSPECTOR_WINDOW_FEATURES)}) !== null`,
    true
  );
  if (typeof opened !== "boolean") throw new Error("Packaged Inspector open returned an invalid result.");
  return opened;
}

async function requestPackagedSmokeInspectorActivation(owner: BrowserWindow): Promise<boolean> {
  const activated = await owner.webContents.executeJavaScript(
    "window.jokoDesktop?.inspectorWindow?.activate?.()",
    true
  );
  if (typeof activated !== "boolean") throw new Error("Packaged Inspector activation returned an invalid result.");
  return activated;
}

async function requestPackagedSmokeInspectorMinimize(window: BrowserWindow): Promise<void> {
  const minimized = await window.webContents.executeJavaScript(
    "(async () => { await window.jokoInspectorDesktop?.window.minimize(); return true; })()",
    true
  );
  if (minimized !== true) throw new Error("Packaged Inspector minimize bridge returned an invalid result.");
}

async function openPackagedSmokeInspector(owner: BrowserWindow, excluded?: BrowserWindow): Promise<BrowserWindow> {
  if (!await requestPackagedSmokeInspectorOpen(owner)) {
    throw new Error("Packaged Inspector window.open request was rejected.");
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const candidate = inspectorWindow;
    if (candidate !== undefined && candidate !== excluded && !candidate.isDestroyed() &&
      !candidate.webContents.isDestroyed() && inspectorWindowOwner === owner.webContents) return candidate;
    await waitForPackagedSmokePoll();
  }
  throw new Error("Packaged Inspector window did not become available.");
}

async function inspectPackagedSmokeInspectorSurface(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 10_000;
  let serialized: unknown;
  while (Date.now() < deadline && !window.isDestroyed()) {
    try {
      serialized = await window.webContents.executeJavaScript(
        [
          "(async () => {",
          "  const api = window.jokoInspectorDesktop;",
          "  const identity = await api?.window.identity?.();",
          "  return JSON.stringify({",
          "    hasGeneralDesktopBridge: window.jokoDesktop !== undefined,",
          "    keys: api === undefined ? [] : Object.keys(api).sort(),",
          "    windowKeys: api?.window === undefined ? [] : Object.keys(api.window).sort(),",
          "    selectionKeys: api?.selectionContextMenu === undefined ? [] : Object.keys(api.selectionContextMenu).sort(),",
          "    identity,",
          "    platform: api?.platform,",
          "    href: location.href",
          "  });",
          "})()"
        ].join("\n"),
        true
      );
      if (typeof serialized === "string") break;
    } catch { /* The initial about:blank document has not committed yet. */ }
    await waitForPackagedSmokePoll();
  }
  if (typeof serialized !== "string") throw new Error("Packaged Inspector bridge did not serialize its surface.");
  const value = JSON.parse(serialized) as {
    readonly hasGeneralDesktopBridge?: unknown;
    readonly keys?: unknown;
    readonly windowKeys?: unknown;
    readonly selectionKeys?: unknown;
    readonly identity?: unknown;
    readonly platform?: unknown;
    readonly href?: unknown;
  };
  if (value.hasGeneralDesktopBridge !== false || typeof value.platform !== "string" ||
    value.href !== INSPECTOR_WINDOW_URL || value.identity !== inspectorWindowOccurrence || !Array.isArray(value.keys) ||
    value.keys.join(",") !== "platform,selectionContextMenu,window" ||
    !Array.isArray(value.windowKeys) || value.windowKeys.join(",") !== "close,identity,minimize,ready,toggleMaximize" ||
    !Array.isArray(value.selectionKeys) || value.selectionKeys.join(",") !== "onAddToChat") {
    throw new Error("Packaged Inspector exposed a non-minimal preload surface.");
  }
  const ready = await window.webContents.executeJavaScript(
    "(async () => { await window.jokoInspectorDesktop.window.ready(); return true; })()",
    true
  );
  if (ready !== true) throw new Error("Packaged Inspector readiness bridge returned an invalid result.");
}

async function waitForPackagedSmokeInspectorClosedCount(owner: BrowserWindow, expected: number): Promise<void> {
  await waitForPackagedSmokeInspectorCondition(async () => {
    if (owner.isDestroyed() || owner.webContents.isDestroyed()) return false;
    const count = await owner.webContents.executeJavaScript("globalThis.__jokoInspectorSmoke?.closed", true);
    return count === expected;
  }, `close notification ${expected}`);
}

async function waitForPackagedSmokeInspectorState(
  window: BrowserWindow,
  predicate: () => boolean,
  operation: string
): Promise<void> {
  await waitForPackagedSmokeInspectorCondition(
    () => !window.isDestroyed() && predicate(),
    operation
  );
}

async function waitForPackagedSmokeInspectorCondition(
  predicate: () => boolean | Promise<boolean>,
  operation: string
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await waitForPackagedSmokePoll();
  }
  throw new Error(`Packaged Inspector did not finish ${operation}.`);
}

async function waitForPackagedSmokeInspectorDestroyed(window: BrowserWindow, operation: string): Promise<void> {
  await waitForPackagedSmokeInspectorCondition(() => window.isDestroyed(), operation);
}

function waitForPackagedSmokeOwnerDocument(
  window: BrowserWindow,
  operation: string,
  begin: () => void
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const contents = window.webContents;
    const timeout = setTimeout(() => finish(new Error(`Packaged Inspector owner did not finish ${operation}.`)), 20_000);
    const loaded = (): void => finish();
    const failed = (_event: unknown, code: number, description: string): void => {
      finish(new Error(`Packaged Inspector owner ${operation} failed (${code} ${description}).`));
    };
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      contents.removeListener("dom-ready", loaded);
      contents.removeListener("did-fail-load", failed);
      if (error === undefined) resolvePromise(); else rejectPromise(error);
    };
    contents.once("dom-ready", loaded);
    contents.once("did-fail-load", failed);
    try { begin(); } catch (error: unknown) {
      finish(error instanceof Error ? error : new Error(`Packaged Inspector owner could not start ${operation}.`));
    }
  });
}

async function verifyPackagedSmokeRuntimeProcessMonitor(ownerWindow: BrowserWindow): Promise<void> {
  const initial = await waitForPackagedSmokeRuntimeProcessMonitor();
  const owner = runtimeProcessMonitorBroker.ownerForMonitor(initial.webContents);
  await inspectPackagedSmokeRuntimeProcessMonitorSurface(initial, owner);
  recordPackagedSmokeProgress("runtime_process_monitor_initial_ready");

  const sameOwner = parseDesktopRuntimeProcessMonitorOpenResult(
    await openRuntimeProcessMonitorWindow(ownerWindow, owner)
  );
  if (!sameOwner.focusedExisting || runtimeProcessMonitorWindow !== initial) {
    throw new Error("Packaged runtime diagnostics did not reuse its exact owner occurrence.");
  }
  recordPackagedSmokeProgress("runtime_process_monitor_same_owner_reused");

  const wrongOwner = Object.freeze({
    ...owner,
    snapshotGeneration: owner.snapshotGeneration === String(Number.MAX_SAFE_INTEGER)
      ? "1"
      : String(Number(owner.snapshotGeneration) + 1)
  });
  const rejected = await initial.webContents.executeJavaScript(
    [
      "(async () => {",
      "  try {",
      `    await window.jokoRuntimeProcessDiagnostics.request(${JSON.stringify({
        version: 1,
        requestId: "00000000-0000-4000-8000-000000000001",
        owner: wrongOwner,
        action: { kind: "refresh" }
      })});`,
      "    return false;",
      "  } catch { return true; }",
      "})()"
    ].join("\n"),
    true
  );
  if (rejected !== true) throw new Error("Packaged runtime diagnostics accepted a wrong owner occurrence.");
  recordPackagedSmokeProgress("runtime_process_monitor_wrong_owner_fenced");

  await waitForPackagedSmokeRuntimeMonitorDocument(initial, () => initial.reload());
  await inspectPackagedSmokeRuntimeProcessMonitorSurface(initial, owner);
  recordPackagedSmokeProgress("runtime_process_monitor_reload_recovered");

  void initial.webContents.executeJavaScript(
    "(() => { void window.jokoRuntimeProcessDiagnostics.window.close(); return true; })()",
    true
  ).catch(() => undefined);
  recordPackagedSmokeProgress("runtime_process_monitor_close_requested");
  const closeDeadline = Date.now() + 5_000;
  while (initial.isVisible() && Date.now() < closeDeadline) await waitForPackagedSmokePoll();
  if (initial.isDestroyed() || initial.isVisible() || runtimeProcessMonitorWindow !== initial) {
    throw new Error("Packaged runtime diagnostics close did not preserve its hidden cached window.");
  }
  const hiddenSamplingRejected = await initial.webContents.executeJavaScript(
    "(async () => { try { await window.jokoRuntimeProcessDiagnostics.sampleDesktop(); return false; } catch { return true; } })()",
    true
  );
  if (hiddenSamplingRejected !== true) {
    throw new Error("Packaged runtime diagnostics sampled Desktop processes while hidden.");
  }
  recordPackagedSmokeProgress("runtime_process_monitor_hidden_sampling_fenced");
  recordPackagedSmokeProgress("runtime_process_monitor_closed");

  const reopened = parseDesktopRuntimeProcessMonitorOpenResult(
    await openRuntimeProcessMonitorWindow(ownerWindow, owner)
  );
  if (!reopened.focusedExisting || runtimeProcessMonitorWindow !== initial) {
    throw new Error("Packaged runtime diagnostics close did not reuse its exact cached owner occurrence.");
  }
  const reopenedWindow = await waitForPackagedSmokeRuntimeProcessMonitor();
  await inspectPackagedSmokeRuntimeProcessMonitorSurface(reopenedWindow, owner);
  recordPackagedSmokeProgress("runtime_process_monitor_reopened");

  const replaced = parseDesktopRuntimeProcessMonitorOpenResult(
    await openRuntimeProcessMonitorWindow(ownerWindow, wrongOwner)
  );
  if (replaced.focusedExisting) {
    throw new Error("Packaged runtime diagnostics did not retire a different owner occurrence.");
  }
  const wrongOwnerWindow = await waitForPackagedSmokeRuntimeProcessMonitor(reopenedWindow);
  await waitForPackagedSmokeWindowDestroyed(reopenedWindow, "different owner replacement");
  await inspectPackagedSmokeRuntimeProcessMonitorSurface(wrongOwnerWindow, wrongOwner);
  recordPackagedSmokeProgress("runtime_process_monitor_different_owner_replaced");

  const restored = parseDesktopRuntimeProcessMonitorOpenResult(
    await openRuntimeProcessMonitorWindow(ownerWindow, owner)
  );
  if (restored.focusedExisting) {
    throw new Error("Packaged runtime diagnostics did not replace the synthetic owner occurrence.");
  }
  const restoredWindow = await waitForPackagedSmokeRuntimeProcessMonitor(wrongOwnerWindow);
  await waitForPackagedSmokeWindowDestroyed(wrongOwnerWindow, "owner restoration");
  await inspectPackagedSmokeRuntimeProcessMonitorSurface(restoredWindow, owner);
  recordPackagedSmokeProgress("runtime_process_monitor_owner_restored");
  await waitForPackagedSmokeRuntimeMonitorDocument(restoredWindow, () => restoredWindow.webContents.forcefullyCrashRenderer());
  await inspectPackagedSmokeRuntimeProcessMonitorSurface(restoredWindow, owner);
  recordPackagedSmokeProgress("runtime_process_monitor_crash_recovered");
  recordPackagedSmokeProgress("runtime_process_monitor_lifecycle_verified");
}

async function waitForPackagedSmokeRuntimeProcessMonitor(excluded?: BrowserWindow): Promise<BrowserWindow> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const candidate = runtimeProcessMonitorWindow;
    if (candidate !== undefined && candidate !== excluded && !candidate.isDestroyed() &&
      !candidate.webContents.isDestroyed() && isRuntimeProcessMonitorNavigation(candidate.webContents.getURL())) {
      // The packaged smoke host intentionally keeps its primary window hidden.
      // Exercise the same restore/show path as a repeated user open before
      // calling visibility-gated diagnostics from the dedicated window.
      if (!candidate.isVisible() || candidate.isMinimized()) showWindowFromTray(candidate);
      if (candidate.isVisible() && !candidate.isMinimized()) return candidate;
    }
    await waitForPackagedSmokePoll();
  }
  throw new Error("Packaged runtime diagnostics window did not become available.");
}

async function waitForPackagedSmokeWindowDestroyed(window: BrowserWindow, operation: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!window.isDestroyed() && Date.now() < deadline) await waitForPackagedSmokePoll();
  if (!window.isDestroyed()) throw new Error(`Packaged runtime diagnostics did not finish ${operation}.`);
}

async function inspectPackagedSmokeRuntimeProcessMonitorSurface(
  window: BrowserWindow,
  expectedOwner: DesktopRuntimeProcessMonitorOwner
): Promise<void> {
  const serialized = await window.webContents.executeJavaScript(
    [
      "(async () => {",
      "  const api = window.jokoRuntimeProcessDiagnostics;",
      "  return JSON.stringify({",
      "    hasGeneralDesktopBridge: window.jokoDesktop !== undefined,",
      "    keys: api === undefined ? [] : Object.keys(api).sort(),",
      "    windowKeys: api?.window === undefined ? [] : Object.keys(api.window).sort(),",
      "    version: api?.version,",
      "    platform: api?.platform,",
      "    owner: await api?.getOwner?.(),",
      "    desktopSample: await api?.sampleDesktop?.()",
      "  });",
      "})()"
    ].join("\n"),
    true
  );
  if (typeof serialized !== "string") throw new Error("Packaged runtime diagnostics bridge did not serialize its surface.");
  const value = JSON.parse(serialized) as {
    readonly hasGeneralDesktopBridge?: unknown;
    readonly keys?: unknown;
    readonly windowKeys?: unknown;
    readonly version?: unknown;
    readonly platform?: unknown;
    readonly owner?: unknown;
    readonly desktopSample?: unknown;
  };
  if (value.hasGeneralDesktopBridge !== false || value.version !== 1 || typeof value.platform !== "string" ||
    !Array.isArray(value.keys) || value.keys.join(",") !== "getOwner,onResponse,onRetired,platform,request,sampleDesktop,version,window" ||
    !Array.isArray(value.windowKeys) || value.windowKeys.join(",") !== "close,minimize,setZoomFactor,toggleMaximize") {
    throw new Error("Packaged runtime diagnostics exposed a non-minimal preload surface.");
  }
  const actualOwner = parseDesktopRuntimeProcessMonitorOwner(value.owner);
  if (!sameDesktopRuntimeProcessMonitorOwner(actualOwner, expectedOwner)) {
    throw new Error("Packaged runtime diagnostics lost its exact owner occurrence.");
  }
  const desktopSample = parseDesktopRuntimeProcessSample(value.desktopSample);
  if (!desktopSample.processes.some((process) => process.role === "main") ||
    !desktopSample.processes.some((process) => process.role === "renderer")) {
    throw new Error("Packaged runtime diagnostics did not project the active Desktop process roles.");
  }
}

function waitForPackagedSmokeRuntimeMonitorDocument(
  window: BrowserWindow,
  begin: () => void
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const contents = window.webContents;
    const timeout = setTimeout(() => finish(new Error("Packaged runtime diagnostics document did not recover.")), 20_000);
    const loaded = (): void => finish();
    const failed = (_event: unknown, code: number, description: string): void => {
      finish(new Error(`Packaged runtime diagnostics document failed to load (${code} ${description}).`));
    };
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      contents.removeListener("did-finish-load", loaded);
      contents.removeListener("did-fail-load", failed);
      if (error === undefined) resolvePromise(); else rejectPromise(error);
    };
    contents.once("did-finish-load", loaded);
    contents.once("did-fail-load", failed);
    try { begin(); } catch (error: unknown) {
      finish(error instanceof Error ? error : new Error("Packaged runtime diagnostics recovery could not start."));
    }
  });
}

async function verifyPackagedSmokeFullscreen(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || window.isFullScreen()) throw new Error("Packaged fullscreen smoke has no normal application window.");
  const invoke = (): Promise<unknown> => window.webContents.executeJavaScript(
    "window.jokoDesktop?.window?.toggleFullscreen?.()",
    true
  );
  const waitForState = async (expected: boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !window.isDestroyed() && window.isFullScreen() !== expected) {
      await waitForPackagedSmokePoll();
    }
    if (window.isDestroyed() || window.isFullScreen() !== expected) throw new Error("Packaged fullscreen state did not settle.");
  };
  try {
    if (await invoke() !== true) throw new Error("Packaged fullscreen bridge did not request entry.");
    await waitForState(true);
    if (await invoke() !== false) throw new Error("Packaged fullscreen bridge did not request exit.");
    await waitForState(false);
    recordPackagedSmokeProgress("application_fullscreen_round_trip");
  } finally {
    if (!window.isDestroyed() && window.isFullScreen()) window.setFullScreen(false);
  }
}

async function verifyPackagedSmokeSessionWindow(owner: BrowserWindow): Promise<void> {
  if (owner.isDestroyed() || owner.webContents.isDestroyed()) {
    throw new Error("Packaged smoke owner window retired before Task-window verification.");
  }
  const runtime = managedOrchestratorRuntime;
  if (managedOrchestratorStatus.state !== "ready" || runtime === undefined
    || managedOrchestratorConnection === undefined
    || !sameManagedOrchestratorConnection(managedOrchestratorStatus.connection, runtime.connection)
    || !sameManagedOrchestratorConnection(managedOrchestratorConnection, runtime.connection)) {
    throw new Error("Packaged smoke has no exact managed Orchestrator authority.");
  }
  const connection = runtime.connection;
  const taskOptions = {
    connection,
    displayName: "Packaged application-window task",
    providerOrigin: packagedSmokeProviderOrigin,
    readAuthKey: readCredential,
    isAuthorityCurrent: (candidate: DesktopManagedOrchestratorConnection) =>
      managedOrchestratorStatus.state === "ready"
      && managedOrchestratorRuntime === runtime
      && !managedOrchestratorExitFence.shutdownStarted
      && sameManagedOrchestratorConnection(managedOrchestratorStatus.connection, candidate)
      && managedOrchestratorConnection !== undefined
      && sameManagedOrchestratorConnection(managedOrchestratorConnection, candidate)
      && sameManagedOrchestratorConnection(runtime.connection, candidate)
  } satisfies PackagedSmokeTaskOptions;
  const task = await createPackagedSmokeTask(taskOptions);
  const taskOwner = { profileId: connection.profileId, sessionId: task.sessionId } as const;
  const taskOwnerKey = sessionWindowOwnerKey(taskOwner);
  recordPackagedSmokeProgress("durable_task_created");
  if (!await preparePackagedSmokeTaskOwner(owner, task)) {
    throw new Error("Packaged smoke owner did not present the durable Task before drag verification.");
  }
  await verifyPackagedSmokeTaskWindowDrag(owner, task, connection.profileId);
  recordPackagedSmokeProgress("task_window_drag_open_requested");

  const taskWindow = sessionWindows.get(taskOwnerKey);
  const openTaskWindows = [...sessionWindows.values()].filter((window) => !window.isDestroyed());
  if (taskWindow === undefined || taskWindow.isDestroyed() || openTaskWindows.length !== 1
    || openTaskWindows[0] !== taskWindow) {
    throw new Error("Packaged smoke duplicated or lost the Task-window owner.");
  }
  const taskContents = taskWindow.webContents;
  const mappedTaskOwner = sessionWindowOwnersByContents.get(taskContents);
  if (mappedTaskOwner?.profileId !== taskOwner.profileId || mappedTaskOwner.sessionId !== taskOwner.sessionId) {
    throw new Error("Packaged smoke Task window lost its main-process identity.");
  }
  await waitForPackagedSmokeTaskPresentation(taskWindow, task, taskOwner);
  if (process.platform === "win32" || process.platform === "darwin") await verifyPackagedSmokeFullscreen(taskWindow);
  if (sessionWindows.get(taskOwnerKey) !== taskWindow) {
    throw new Error("Packaged smoke Task-window owner changed while its UI was loading.");
  }
  recordPackagedSmokeProgress("task_window_product_ready");
  await verifyPackagedSmokeSystemHandoff(owner, taskWindow, taskOwner);
  await assertPackagedSmokeTaskWindowProfileFence(taskWindow, taskOwner);
  if ([...sessionWindows.values()].filter((candidate) => !candidate.isDestroyed()).length !== 1) {
    throw new Error("Packaged smoke cross-profile request changed the Task-window set.");
  }
  recordPackagedSmokeProgress("task_window_cross_profile_fenced");

  if (nativeTaskStatusSupported) {
    const visibilityDeadline = Date.now() + 5_000;
    while (Date.now() < visibilityDeadline
      && nativeTaskStatusVisibleSessionsByContents.get(taskContents)?.includes(task.sessionId) !== true) {
      await waitForPackagedSmokePoll();
    }
    if (nativeTaskStatusVisibleSessionsByContents.get(taskContents)?.includes(task.sessionId) !== true) {
      throw new Error("Packaged smoke Task window did not publish its visible Task state.");
    }
  }

  taskContents.reload();
  await waitForPackagedSmokeTaskPresentation(taskWindow, task, taskOwner);
  assertPackagedSmokeTaskWindowOwner(taskWindow, taskOwner);
  recordPackagedSmokeProgress("task_window_reloaded_exact_owner");
  if (process.platform === "win32") {
    await runPackagedSmokeTimelineTurn(taskOptions, task);
    recordPackagedSmokeProgress("timeline_generation_completed");
    await verifyPackagedSmokeTimelineSystemClipboard(taskWindow);
  }

  const concurrentTaskOptions = {
    ...taskOptions,
    displayName: "Packaged concurrent application-window task",
    reuseConfiguredProvider: true
  } satisfies PackagedSmokeTaskOptions;
  const concurrentTask = await createPackagedSmokeTask(concurrentTaskOptions);
  const concurrentOwner = { profileId: connection.profileId, sessionId: concurrentTask.sessionId } as const;
  const concurrentOwnerKey = sessionWindowOwnerKey(concurrentOwner);
  if (!await preparePackagedSmokeTaskOwner(owner, concurrentTask)) {
    throw new Error("Packaged smoke owner did not present the concurrent durable Task.");
  }
  if (await focusPackagedSmokeTaskWindow(taskWindow, concurrentTask, connection.profileId)) {
    throw new Error("Packaged smoke concurrent Task unexpectedly reused an existing window.");
  }
  const concurrentWindow = sessionWindows.get(concurrentOwnerKey);
  if (concurrentWindow === undefined || concurrentWindow.isDestroyed() || concurrentWindow === taskWindow) {
    throw new Error("Packaged smoke did not create an independent concurrent Task window.");
  }
  await Promise.all([
    waitForPackagedSmokeTaskPresentation(taskWindow, task, taskOwner),
    waitForPackagedSmokeTaskPresentation(concurrentWindow, concurrentTask, concurrentOwner)
  ]);
  assertPackagedSmokeTaskWindowOwner(taskWindow, taskOwner);
  assertPackagedSmokeTaskWindowOwner(concurrentWindow, concurrentOwner);
  if ([...sessionWindows.values()].filter((candidate) => !candidate.isDestroyed()).length !== 2
    || !await focusPackagedSmokeTaskWindow(owner, concurrentTask, connection.profileId)) {
    throw new Error("Packaged smoke concurrent Task singleton state was inconsistent.");
  }
  recordPackagedSmokeProgress("task_windows_concurrent_exact_owners");

  const crashDraftText = "Joko task draft survives renderer recovery";
  await writePackagedSmokeTaskDraft(taskWindow, connection, task.sessionId, crashDraftText);
  const rendererLost = new Promise<void>((resolveLoss) => taskContents.once("render-process-gone", () => resolveLoss()));
  const rendererReloaded = new Promise<void>((resolveLoad) => taskContents.once("did-finish-load", () => resolveLoad()));
  taskContents.forcefullyCrashRenderer();
  await waitForPackagedSmokeDeadline(rendererLost, 10_000, "Task renderer crash");
  await waitForPackagedSmokeDeadline(rendererReloaded, 20_000, "Task renderer recovery load");
  await Promise.all([
    waitForPackagedSmokeTaskPresentation(taskWindow, task, taskOwner),
    waitForPackagedSmokeTaskPresentation(concurrentWindow, concurrentTask, concurrentOwner)
  ]);
  await waitForPackagedSmokeTaskDraft(taskWindow, crashDraftText, false);
  assertPackagedSmokeTaskWindowOwner(taskWindow, taskOwner);
  assertPackagedSmokeTaskWindowOwner(concurrentWindow, concurrentOwner);
  recordPackagedSmokeProgress("task_window_crash_recovered_exact_owner");
  recordPackagedSmokeProgress("task_draft_recovered_after_renderer_crash");

  await closePackagedSmokeTaskWindow(taskWindow, taskOwner);
  await waitForPackagedSmokeTaskPresentation(concurrentWindow, concurrentTask, concurrentOwner);
  assertPackagedSmokeTaskWindowOwner(concurrentWindow, concurrentOwner);
  if (owner.isDestroyed() || owner.webContents.isDestroyed()) {
    throw new Error("Closing one packaged Task window retired another application window.");
  }
  recordPackagedSmokeProgress("task_window_closed_without_peer_loss");

  await Promise.all([
    verifyPackagedSmokeTask(taskOptions, task),
    verifyPackagedSmokeTask(concurrentTaskOptions, concurrentTask)
  ]);
  if (!await preparePackagedSmokeTaskOwner(owner, task)
    || !await preparePackagedSmokeTaskOwner(owner, concurrentTask)) {
    throw new Error("Closing a packaged Task window removed accepted durable Tasks from the owner product UI.");
  }
  await closePackagedSmokeTaskWindow(concurrentWindow, concurrentOwner);
  if ([...sessionWindows.values()].some((candidate) => !candidate.isDestroyed())) {
    throw new Error("Packaged smoke retained a Task window after isolated cleanup.");
  }
  recordPackagedSmokeProgress("task_windows_closed_cleanly");
  recordPackagedSmokeProgress("durable_task_reverified");
}

const PACKAGED_SMOKE_PNG_SIGNATURE = "89504e470d0a1a0a";

interface PackagedSmokeClipboardSnapshot {
  readonly formats: readonly string[];
  readonly text: string;
  readonly html: string;
  readonly rtf: string;
  readonly bookmark: Readonly<{ title: string; url: string }>;
  readonly image?: NativeImage;
}

interface PackagedSmokeClipboardFingerprint {
  readonly text: string;
  readonly imageSha256: string;
}

async function verifyPackagedSmokeTimelineSystemClipboard(window: BrowserWindow): Promise<void> {
  const fixture = packagedSmokeTimelineClipboardFixture();
  const systemClipboardFixture = Object.freeze({
    codeText: packagedSmokeSystemClipboardText(fixture.codeText, process.platform),
    mermaidText: packagedSmokeSystemClipboardText(fixture.mermaidSource, process.platform),
    tableText: packagedSmokeSystemClipboardText(fixture.tableText, process.platform),
    mathText: packagedSmokeSystemClipboardText(fixture.mathText, process.platform)
  });
  await waitForPackagedSmokeTimelineClipboardBlocks(window, fixture);
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    throw new Error("Packaged smoke Timeline clipboard owner retired before verification.");
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  const focusDeadline = Date.now() + 5_000;
  while (!window.isFocused() && Date.now() < focusDeadline) await waitForPackagedSmokePoll();
  if (!window.isFocused()) throw new Error("Packaged smoke Timeline clipboard owner did not become focused.");

  const writerContents = window.webContents;
  const snapshot = capturePackagedSmokeClipboard();
  const sentinel = `joko-packaged-smoke-clipboard-${randomUUID()}`;
  let mermaidFingerprint: PackagedSmokeClipboardFingerprint | undefined;
  let tableFingerprint: PackagedSmokeClipboardFingerprint | undefined;
  let mathFingerprint: PackagedSmokeClipboardFingerprint | undefined;
  let copyActionsSettled = false;
  try {
    clipboard.writeText(sentinel, "clipboard");
    if (clipboard.readText("clipboard") !== sentinel || !clipboard.readImage("clipboard").isEmpty()) {
      throw new Error("Packaged smoke could not establish its system clipboard sentinel.");
    }
    await clickPackagedSmokeTimelineCopy(window, ".timeline-code-block", ":scope > button.timeline-code-block__copy");
    await waitForPackagedSmokeTimelineTextClipboard(
      window,
      ".timeline-code-block",
      ":scope > button.timeline-code-block__copy",
      systemClipboardFixture.codeText
    );
    recordPackagedSmokeProgress("timeline_code_system_clipboard_verified");

    assertPackagedSmokeTextClipboard(systemClipboardFixture.codeText);
    await clickPackagedSmokeTimelineCopy(
      window,
      ".timeline-mermaid",
      ":scope > .timeline-mermaid__toolbar > button.timeline-mermaid__copy"
    );
    mermaidFingerprint = await waitForPackagedSmokeTimelineClipboard(
      window,
      ".timeline-mermaid",
      ":scope > .timeline-mermaid__toolbar > button.timeline-mermaid__copy",
      systemClipboardFixture.mermaidText
    );
    recordPackagedSmokeProgress("timeline_mermaid_system_clipboard_verified");

    assertPackagedSmokeClipboardFingerprint(mermaidFingerprint);
    await clickPackagedSmokeTimelineCopy(
      window,
      ".timeline-copy-block--table",
      ":scope > button.timeline-copy-block__button:not(.timeline-copy-block__annotate)"
    );
    tableFingerprint = await waitForPackagedSmokeTimelineClipboard(
      window,
      ".timeline-copy-block--table",
      ":scope > button.timeline-copy-block__button:not(.timeline-copy-block__annotate)",
      systemClipboardFixture.tableText
    );
    recordPackagedSmokeProgress("timeline_table_system_clipboard_verified");

    assertPackagedSmokeClipboardFingerprint(tableFingerprint);
    await clickPackagedSmokeTimelineCopy(
      window,
      ".timeline-copy-block--math",
      ":scope > button.timeline-copy-block__button:not(.timeline-copy-block__annotate)"
    );
    mathFingerprint = await waitForPackagedSmokeTimelineClipboard(
      window,
      ".timeline-copy-block--math",
      ":scope > button.timeline-copy-block__button:not(.timeline-copy-block__annotate)",
      systemClipboardFixture.mathText
    );
    copyActionsSettled = true;
    if (new Set([
      mermaidFingerprint.imageSha256,
      tableFingerprint.imageSha256,
      mathFingerprint.imageSha256
    ]).size !== 3) {
      throw new Error("Packaged smoke Timeline image Copy actions did not produce distinct PNG payloads.");
    }
    recordPackagedSmokeProgress("timeline_math_system_clipboard_verified");
  } finally {
    await cleanupPackagedSmokeClipboard({
      writesKnownSettled: copyActionsSettled,
      waitForWritesToSettle: () => waitForPackagedSmokeTimelineCopyActionsToSettle(window),
      retireWriter: () => retirePackagedSmokeTimelineClipboardWriter(window, writerContents),
      ownsCurrentClipboard: () => packagedSmokeClipboardIsOwned(
        sentinel,
        [systemClipboardFixture.mermaidText, systemClipboardFixture.tableText, systemClipboardFixture.mathText],
        [systemClipboardFixture.codeText]
      ),
      restorePreviousClipboard: () => restorePackagedSmokeClipboard(snapshot, () => (
        packagedSmokeClipboardIsOwned(
          sentinel,
          [systemClipboardFixture.mermaidText, systemClipboardFixture.tableText, systemClipboardFixture.mathText],
          [systemClipboardFixture.codeText]
        )
      ))
    });
  }
}

async function retirePackagedSmokeTimelineClipboardWriter(
  window: BrowserWindow,
  writerContents: WebContents
): Promise<void> {
  const contentsDestroyed = writerContents.isDestroyed()
    ? Promise.resolve()
    : new Promise<void>((resolveDestroyed) => writerContents.once("destroyed", resolveDestroyed));
  const windowClosed = window.isDestroyed()
    ? Promise.resolve()
    : new Promise<void>((resolveClosed) => window.once("closed", resolveClosed));
  if (!window.isDestroyed()) window.destroy();
  await Promise.all([contentsDestroyed, windowClosed]);
}

function packagedSmokeTimelineClipboardFixture(): Readonly<{
  codeText: string;
  mermaidSource: string;
  tableText: string;
  mathSource: string;
  mathText: string;
}> {
  if (packagedSmokeClipboardNonce === undefined) {
    throw new Error("Packaged smoke Timeline clipboard owner nonce is unavailable.");
  }
  const codeSource = [
    `const owner = "${packagedSmokeClipboardNonce}";`,
    "console.log(owner);"
  ].join("\n");
  const mermaidSource = [
    "flowchart LR",
    `  A["${packagedSmokeClipboardNonce}"] --> B["Clipboard"]`
  ].join("\n");
  const mathSource = `x_{${packagedSmokeClipboardNonce}}=1`;
  return Object.freeze({
    codeText: `${codeSource}\n`,
    mermaidSource,
    tableText: `Kind\tValue\nAlpha\tBeta\nOwner\t${packagedSmokeClipboardNonce}`,
    mathSource,
    mathText: `$$\n${mathSource}\n$$`
  });
}

async function waitForPackagedSmokeTimelineClipboardBlocks(
  window: BrowserWindow,
  fixture: ReturnType<typeof packagedSmokeTimelineClipboardFixture>
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastObservation = "unavailable";
  while (Date.now() < deadline) {
    const value = await window.webContents.executeJavaScript([
      "(() => {",
      "  const assistant = [...document.querySelectorAll('.message-assistant')].filter((node) =>",
      "    node.querySelector('.timeline-code-block, .timeline-mermaid, .timeline-copy-block--table, .timeline-copy-block--math'));",
      "  const codeBlocks = document.querySelectorAll('.message-assistant__body .timeline-code-block');",
      "  const mermaidBlocks = document.querySelectorAll('.message-assistant__body .timeline-mermaid');",
      "  const tableBlocks = document.querySelectorAll('.message-assistant__body .timeline-copy-block--table');",
      "  const mathBlocks = document.querySelectorAll('.message-assistant__body .timeline-copy-block--math');",
      "  const codeText = codeBlocks.length === 1 ? codeBlocks[0].querySelector('code')?.textContent ?? '' : '';",
      "  const mermaidReady = mermaidBlocks.length === 1 && Boolean(mermaidBlocks[0].querySelector('.timeline-mermaid__diagram svg'));",
      "  const table = tableBlocks.length === 1 ? tableBlocks[0].querySelector('table') : null;",
      "  const tableText = table ? [...table.querySelectorAll('tr')].map((row) =>",
      "    [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim() ?? '').join('\\t')).join('\\n') : '';",
      "  const mathSource = mathBlocks.length === 1",
      "    ? mathBlocks[0].querySelector('annotation[encoding=\"application/x-tex\"]')?.textContent?.trim() ?? '' : '';",
      "  return {",
      "    assistantCount: assistant.length, codeCount: codeBlocks.length, mermaidCount: mermaidBlocks.length,",
      "    tableCount: tableBlocks.length, mathCount: mathBlocks.length, codeText, mermaidReady, tableText, mathSource,",
      "    streaming: Boolean(assistant[0]?.querySelector('.streaming-cursor'))",
      "  };",
      "})()"
    ].join("\n"), true) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const observation = value as Record<string, unknown>;
      lastObservation = JSON.stringify(observation);
      if (observation["assistantCount"] === 1
        && observation["codeCount"] === 1
        && observation["mermaidCount"] === 1
        && observation["tableCount"] === 1
        && observation["mathCount"] === 1
        && observation["codeText"] === fixture.codeText
        && observation["mermaidReady"] === true
        && observation["tableText"] === fixture.tableText
        && observation["mathSource"] === fixture.mathSource
        && observation["streaming"] === false) return;
    }
    await waitForPackagedSmokePoll();
  }
  throw new Error(`Packaged smoke Timeline clipboard blocks did not settle (${lastObservation}).`);
}

async function clickPackagedSmokeTimelineCopy(
  window: BrowserWindow,
  blockSelector: string,
  buttonSelector: string
): Promise<void> {
  const clicked = await window.webContents.executeJavaScript([
    "(() => {",
    `  const blocks = document.querySelectorAll(${JSON.stringify(`.message-assistant__body ${blockSelector}`)});`,
    "  if (blocks.length !== 1) return false;",
    `  const buttons = blocks[0].querySelectorAll(${JSON.stringify(buttonSelector)});`,
    "  if (buttons.length !== 1) return false;",
    "  const button = buttons[0];",
    "  if (!(button instanceof HTMLButtonElement) || button.disabled || button.getAttribute('aria-busy') === 'true') return false;",
    "  button.click();",
    "  return true;",
    "})()"
  ].join("\n"), true) as unknown;
  if (clicked !== true) throw new Error(`Packaged smoke could not dispatch one Copy action for ${blockSelector}.`);
}

async function waitForPackagedSmokeTimelineTextClipboard(
  window: BrowserWindow,
  blockSelector: string,
  buttonSelector: string,
  expectedText: string
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastObservation = "unavailable";
  while (Date.now() < deadline) {
    const state = await packagedSmokeTimelineCopyActionState(window, blockSelector, buttonSelector);
    if (state === "failed") throw new Error(`Packaged smoke ${blockSelector} Copy action failed.`);
    const text = clipboard.readText("clipboard");
    const imageEmpty = clipboard.readImage("clipboard").isEmpty();
    lastObservation = JSON.stringify({
      state,
      textMatches: text === expectedText,
      textLength: text.length,
      textSha256: createHash("sha256").update(text).digest("hex"),
      expectedTextSha256: createHash("sha256").update(expectedText).digest("hex"),
      imageEmpty,
      formats: clipboard.availableFormats("clipboard")
    });
    if (state === "settled" && text === expectedText && imageEmpty) return;
    await waitForPackagedSmokePoll();
  }
  throw new Error(
    `Packaged smoke ${blockSelector} system clipboard did not contain only the exact text (${lastObservation}).`
  );
}

async function waitForPackagedSmokeTimelineClipboard(
  window: BrowserWindow,
  blockSelector: string,
  buttonSelector: string,
  expectedText: string
): Promise<PackagedSmokeClipboardFingerprint> {
  const deadline = Date.now() + 20_000;
  let lastObservation = "unavailable";
  while (Date.now() < deadline) {
    const state = await packagedSmokeTimelineCopyActionState(window, blockSelector, buttonSelector);
    if (state === "failed") throw new Error(`Packaged smoke ${blockSelector} Copy action failed.`);
    const image = clipboard.readImage("clipboard");
    const text = clipboard.readText("clipboard");
    const size = image.getSize();
    const png = image.isEmpty() ? Buffer.alloc(0) : image.toPNG();
    const validPng = !image.isEmpty() && size.width >= 1 && size.height >= 1 && png.byteLength > 8
      && png.subarray(0, 8).toString("hex") === PACKAGED_SMOKE_PNG_SIGNATURE
      && !nativeImage.createFromBuffer(png).isEmpty();
    lastObservation = JSON.stringify({
      state,
      textMatches: text === expectedText,
      textLength: text.length,
      textSha256: createHash("sha256").update(text).digest("hex"),
      expectedTextSha256: createHash("sha256").update(expectedText).digest("hex"),
      imageEmpty: image.isEmpty(),
      imageSize: size,
      pngBytes: png.byteLength,
      validPng,
      formats: clipboard.availableFormats("clipboard")
    });
    if (state === "settled" && text === expectedText && !image.isEmpty()) {
      if (!validPng) {
        throw new Error(`Packaged smoke ${blockSelector} system clipboard PNG was invalid.`);
      }
      return Object.freeze({
        text: expectedText,
        imageSha256: createHash("sha256").update(png).digest("hex")
      });
    }
    await waitForPackagedSmokePoll();
  }
  throw new Error(
    `Packaged smoke ${blockSelector} system clipboard did not contain the exact PNG and text (${lastObservation}).`
  );
}

async function packagedSmokeTimelineCopyActionState(
  window: BrowserWindow,
  blockSelector: string,
  buttonSelector: string
): Promise<"pending" | "settled" | "failed" | "unavailable"> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return "unavailable";
  const state = await window.webContents.executeJavaScript([
    "(() => {",
    `  const block = document.querySelector(${JSON.stringify(`.message-assistant__body ${blockSelector}`)});`,
    "  if (!block) return 'unavailable';",
    "  if (block.querySelector('[role=\"alert\"]')) return 'failed';",
    `  const button = block.querySelector(${JSON.stringify(buttonSelector)});`,
    "  if (!(button instanceof HTMLButtonElement)) return 'unavailable';",
    "  return button.getAttribute('aria-busy') === 'true' ? 'pending' : 'settled';",
    "})()"
  ].join("\n"), true) as unknown;
  return state === "pending" || state === "settled" || state === "failed" ? state : "unavailable";
}

async function waitForPackagedSmokeTimelineCopyActionsToSettle(window: BrowserWindow): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const states = await Promise.all([
      packagedSmokeTimelineCopyActionState(window, ".timeline-code-block", ":scope > button.timeline-code-block__copy"),
      packagedSmokeTimelineCopyActionState(
        window,
        ".timeline-mermaid",
        ":scope > .timeline-mermaid__toolbar > button.timeline-mermaid__copy"
      ),
      packagedSmokeTimelineCopyActionState(
        window,
        ".timeline-copy-block--table",
        ":scope > button.timeline-copy-block__button:not(.timeline-copy-block__annotate)"
      ),
      packagedSmokeTimelineCopyActionState(
        window,
        ".timeline-copy-block--math",
        ":scope > button.timeline-copy-block__button:not(.timeline-copy-block__annotate)"
      )
    ]);
    if (states.every((state) => state === "settled" || state === "failed")) return true;
    if (states.includes("unavailable")) return false;
    await waitForPackagedSmokePoll();
  }
  return false;
}

function assertPackagedSmokeClipboardFingerprint(expected: PackagedSmokeClipboardFingerprint): void {
  if (!packagedSmokeClipboardMatchesFingerprint(expected)) {
    throw new Error("Packaged smoke will not replace a newer system clipboard owner.");
  }
}

function assertPackagedSmokeTextClipboard(expectedText: string): void {
  if (clipboard.readText("clipboard") !== expectedText || !clipboard.readImage("clipboard").isEmpty()) {
    throw new Error("Packaged smoke will not replace a newer system clipboard owner.");
  }
}

function packagedSmokeClipboardMatchesFingerprint(expected: PackagedSmokeClipboardFingerprint): boolean {
  if (clipboard.readText("clipboard") !== expected.text) return false;
  const image = clipboard.readImage("clipboard");
  return !image.isEmpty()
    && createHash("sha256").update(image.toPNG()).digest("hex") === expected.imageSha256;
}

function packagedSmokeClipboardIsOwned(
  sentinel: string,
  expectedImageOutputTexts: readonly string[],
  expectedTextOnlyOutputs: readonly string[] = []
): boolean {
  return isPackagedSmokeClipboardObservationOwned(
    readPackagedSmokeClipboardObservation(),
    sentinel,
    expectedImageOutputTexts,
    expectedTextOnlyOutputs
  );
}

function readPackagedSmokeClipboardObservation(): PackagedSmokeClipboardObservation {
  const text = clipboard.readText("clipboard");
  const image = clipboard.readImage("clipboard");
  if (image.isEmpty()) return Object.freeze({ text });
  const size = image.getSize();
  const png = image.toPNG();
  if (size.width < 1 || size.height < 1 || png.byteLength <= 8
    || png.subarray(0, 8).toString("hex") !== PACKAGED_SMOKE_PNG_SIGNATURE
    || nativeImage.createFromBuffer(png).isEmpty()) return Object.freeze({ text });
  return Object.freeze({ text, imageSha256: createHash("sha256").update(png).digest("hex") });
}

function capturePackagedSmokeClipboard(): PackagedSmokeClipboardSnapshot {
  const image = clipboard.readImage("clipboard");
  const formats = Object.freeze([...new Set(clipboard.availableFormats("clipboard"))]);
  const unsupportedFormats = formats.filter((format) => !isPackagedSmokeRestorableClipboardFormat(format));
  if (unsupportedFormats.length > 0) {
    throw new Error(
      `Packaged smoke will not replace clipboard formats that cannot be restored atomically: ${unsupportedFormats.join(", ")}`
    );
  }
  const snapshot = Object.freeze({
    formats,
    text: clipboard.readText("clipboard"),
    html: clipboard.readHTML("clipboard"),
    rtf: clipboard.readRTF("clipboard"),
    bookmark: Object.freeze(clipboard.readBookmark()),
    ...(image.isEmpty() ? {} : { image })
  });
  if (formats.length > 0 && packagedSmokeClipboardWriteData(snapshot) === undefined) {
    if (hasOnlyEmptyPackagedSmokeClipboardFormats(
      formats,
      (format) => clipboard.readBuffer(format).byteLength
    )) return Object.freeze({ ...snapshot, formats: Object.freeze([]) });
    throw new Error("Packaged smoke cannot represent the current system clipboard in one restore transaction.");
  }
  return snapshot;
}

async function restorePackagedSmokeClipboard(
  snapshot: PackagedSmokeClipboardSnapshot,
  ownsCurrentClipboard: () => boolean
): Promise<void> {
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!ownsCurrentClipboard()) {
      if (attempt === 0) return;
      throw new Error(`Packaged smoke lost clipboard ownership while restoring: ${safeSmokeError(lastFailure)}`);
    }
    try {
      const data = packagedSmokeClipboardWriteData(snapshot);
      if (data === undefined) clipboard.clear("clipboard");
      else clipboard.write(data, "clipboard");
      if (packagedSmokeClipboardMatchesSnapshot(snapshot)) return;
      lastFailure = new Error("restored clipboard did not match the captured snapshot");
    } catch (error) {
      lastFailure = error;
    }
    if (attempt < 2) await waitForPackagedSmokePoll();
  }
  throw new Error(`Packaged smoke could not restore the system clipboard: ${safeSmokeError(lastFailure)}`);
}

function packagedSmokeClipboardMatchesSnapshot(snapshot: PackagedSmokeClipboardSnapshot): boolean {
  if (clipboard.readText("clipboard") !== snapshot.text
    || clipboard.readHTML("clipboard") !== snapshot.html
    || clipboard.readRTF("clipboard") !== snapshot.rtf
    || !isDeepStrictEqual(clipboard.readBookmark(), snapshot.bookmark)) return false;
  const image = clipboard.readImage("clipboard");
  if (snapshot.image === undefined) return image.isEmpty();
  return !image.isEmpty() && createHash("sha256").update(image.toPNG()).digest("hex")
    === createHash("sha256").update(snapshot.image.toPNG()).digest("hex");
}

function packagedSmokeClipboardWriteData(snapshot: PackagedSmokeClipboardSnapshot): Readonly<{
  text?: string;
  html?: string;
  rtf?: string;
  bookmark?: string;
  image?: NativeImage;
}> | undefined {
  const data = Object.freeze({
    ...(snapshot.text !== "" ? { text: snapshot.text } : snapshot.bookmark.url === "" ? {} : { text: snapshot.bookmark.url }),
    ...(snapshot.html === "" ? {} : { html: snapshot.html }),
    ...(snapshot.rtf === "" ? {} : { rtf: snapshot.rtf }),
    ...(snapshot.bookmark.url === "" ? {} : { bookmark: snapshot.bookmark.title || snapshot.bookmark.url }),
    ...(snapshot.image === undefined ? {} : { image: snapshot.image })
  });
  return Object.keys(data).length === 0 ? undefined : data;
}

function assertPackagedSmokeTaskWindowOwner(
  window: BrowserWindow,
  owner: DesktopSessionWindowOwner
): void {
  const ownerKey = sessionWindowOwnerKey(owner);
  const mapped = sessionWindowOwnersByContents.get(window.webContents);
  if (window.isDestroyed() || sessionWindows.get(ownerKey) !== window
    || sessionWindowOwners.get(ownerKey)?.profileId !== owner.profileId
    || sessionWindowOwners.get(ownerKey)?.sessionId !== owner.sessionId
    || mapped?.profileId !== owner.profileId || mapped?.sessionId !== owner.sessionId) {
    throw new Error("Packaged smoke Task window changed its exact main-process owner.");
  }
}

function armPackagedSmokeFailedMainDocumentRequest(): Promise<void> {
  if (!packagedSmoke || packagedSmokeFailNextMainDocumentRequest
    || resolvePackagedSmokeFailedMainDocumentRequest !== undefined) {
    throw new Error("Packaged smoke failed-Document request probe was already armed.");
  }
  packagedSmokeFailNextMainDocumentRequest = true;
  return new Promise((resolveRequest) => {
    resolvePackagedSmokeFailedMainDocumentRequest = resolveRequest;
  });
}

function disarmPackagedSmokeFailedMainDocumentRequest(): void {
  packagedSmokeFailNextMainDocumentRequest = false;
  resolvePackagedSmokeFailedMainDocumentRequest = undefined;
}

async function waitForPackagedSmokeFailedDocumentLoadStop(contents: WebContents): Promise<void> {
  const deadline = Date.now() + 5_000;
  let stableStoppedSamples = 0;
  while (Date.now() < deadline) {
    if (contents.isDestroyed()) {
      throw new Error("Packaged smoke primary Document was destroyed after its failed request.");
    }
    if (contents.isLoadingMainFrame()) {
      stableStoppedSamples = 0;
    } else {
      stableStoppedSamples += 1;
      // The protocol handler has already returned its no-content response. Two
      // separate main-loop observations with no active main-frame load prove
      // the provisional load settled without relying on Electron's optional
      // did-fail-provisional-load delivery.
      if (stableStoppedSamples >= 2) return;
    }
    await waitForPackagedSmokePoll();
  }
  throw new Error("Packaged smoke failed primary Document load did not stop.");
}

async function verifyPackagedSmokeCancelledMainNavigation(
  owner: BrowserWindow,
  documentOccurrence: string
): Promise<void> {
  const contents = owner.webContents;
  const attention = requireDesktopAttentionBadgeController();
  const attentionBaseline = attention.count;
  const attentionKey = Object.freeze({
    ownerId: "packaged-smoke-cancelled-navigation",
    sessionId: "surviving-primary-document"
  });
  await contents.executeJavaScript(
    `window.jokoDesktop.attention.mark(${JSON.stringify(attentionKey)})`,
    true
  );
  if (attention.count !== attentionBaseline + 1) {
    throw new Error("Packaged smoke could not establish attention owned by the primary Document.");
  }
  let resolveNavigationPrevented: (() => void) | undefined;
  const prevented = new Promise<void>((resolvePromise) => {
    resolveNavigationPrevented = resolvePromise;
  });
  const observePrevented = (): void => resolveNavigationPrevented?.();
  contents.once("will-prevent-unload", observePrevented);
  await contents.executeJavaScript([
    "(() => {",
    "  const key = '__jokoPackagedSmokeBeforeUnload';",
    "  const previous = globalThis[key];",
    "  if (typeof previous === 'function') window.removeEventListener('beforeunload', previous);",
    "  const handler = (event) => { event.preventDefault(); event.returnValue = ''; };",
    "  Object.defineProperty(globalThis, key, { value: handler, configurable: true });",
    "  window.addEventListener('beforeunload', handler);",
    "  return true;",
    "})()"
  ].join("\n"), true);
  try {
    const reload = contents.executeJavaScript("window.location.reload(); true", true);
    await waitForPackagedSmokeDeadline(prevented, 5_000, "cancelled primary navigation");
    await waitForPackagedSmokeDeadline(reload, 5_000, "cancelled primary navigation script").catch(() => undefined);
    await waitForPackagedSmokePoll();
    if (owner.isDestroyed() || contents.isDestroyed() || contents.isLoadingMainFrame()
      || currentMainWindowDocumentOccurrence() !== documentOccurrence
      || attention.count !== attentionBaseline + 1) {
      throw new Error("Packaged smoke cancelled navigation retired the surviving primary Document.");
    }
    recordPackagedSmokeProgress("system_handoff_cancelled_navigation_preserved");

    await contents.executeJavaScript([
      "(() => {",
      "  const key = '__jokoPackagedSmokeBeforeUnload';",
      "  const handler = globalThis[key];",
      "  if (typeof handler === 'function') window.removeEventListener('beforeunload', handler);",
      "  delete globalThis[key];",
      "})()"
    ].join("\n"), true);

    const originalUrl = contents.getURL();
    const failedDocumentRequestInjected = armPackagedSmokeFailedMainDocumentRequest();
    try {
      // A request-local, smoke-only POST cannot reuse the existing GET
      // Document from Chromium's custom-scheme cache. The exact method and
      // sentinel header are both required by the protocol handler, so no
      // unrelated request can consume this one-shot failure authority.
      const failedLoad = contents.loadURL(originalUrl, {
        extraHeaders: `${PACKAGED_SMOKE_FAILED_DOCUMENT_HEADER}: 1\nContent-Type: application/octet-stream\n`,
        postData: [{ type: "rawData", bytes: Buffer.from([0]) }]
      }).then(() => false, () => true);
      await waitForPackagedSmokeDeadline(
        failedDocumentRequestInjected,
        5_000,
        "failed primary Document request injection"
      );
      const loadRejected = await waitForPackagedSmokeDeadline(
        failedLoad,
        5_000,
        "failed primary Document load rejection"
      );
      await waitForPackagedSmokeFailedDocumentLoadStop(contents);
      recordPackagedSmokeProgress("system_handoff_failed_document_load_stopped");
      if (!loadRejected || owner.isDestroyed() || contents.isDestroyed() || contents.getURL() !== originalUrl
        || currentMainWindowDocumentOccurrence() !== documentOccurrence
        || attention.count !== attentionBaseline + 1) {
        throw new Error("Packaged smoke failed navigation retired the surviving primary Document.");
      }
    } finally {
      disarmPackagedSmokeFailedMainDocumentRequest();
    }
    recordPackagedSmokeProgress("system_handoff_failed_navigation_preserved");
  } finally {
    contents.removeListener("will-prevent-unload", observePrevented);
    if (!owner.isDestroyed() && !contents.isDestroyed()) {
      await contents.executeJavaScript(
        `window.jokoDesktop.attention.clear(${JSON.stringify(attentionKey)})`,
        true
      ).catch(() => undefined);
      await contents.executeJavaScript([
        "(() => {",
        "  const key = '__jokoPackagedSmokeBeforeUnload';",
        "  const handler = globalThis[key];",
        "  if (typeof handler === 'function') window.removeEventListener('beforeunload', handler);",
        "  delete globalThis[key];",
        "})()"
      ].join("\n"), true).catch(() => undefined);
    }
  }
  if (attention.count !== attentionBaseline) {
    throw new Error("Packaged smoke cancelled navigation did not preserve exact attention ownership.");
  }
}

async function verifyPackagedSmokeSystemHandoff(
  owner: BrowserWindow,
  taskWindow: BrowserWindow,
  taskOwner: DesktopSessionWindowOwner
): Promise<void> {
  if (owner.isDestroyed() || owner.webContents.isDestroyed() || mainWindow !== owner) {
    throw new Error("Packaged smoke system handoff lost the primary application window.");
  }
  const documentOccurrence = currentMainWindowDocumentOccurrence();
  if (documentOccurrence === undefined) {
    throw new Error("Packaged smoke system handoff has no current primary Document occurrence.");
  }

  await verifyPackagedSmokeCancelledMainNavigation(owner, documentOccurrence);

  recordPackagedSmokeProgress("system_handoff_second_instance_ready");
  const secondInstanceIntent = await waitForPackagedSmokeSecondInstanceIntent();
  if (secondInstanceIntent.kind !== "settings" || secondInstanceIntent.section !== "providers") {
    throw new Error("Packaged smoke second-instance handoff delivered an unexpected intent.");
  }
  const secondInstanceDeadline = Date.now() + 10_000;
  let secondInstanceHash = "";
  while (Date.now() < secondInstanceDeadline && !owner.isDestroyed()) {
    secondInstanceHash = await owner.webContents.executeJavaScript("window.location.hash", true) as unknown as string;
    if (secondInstanceHash === "#/settings/providers"
      && currentMainWindowDocumentOccurrence() === documentOccurrence
      && packagedSmokeSecondInstanceAcknowledged) break;
    await waitForPackagedSmokePoll();
  }
  if (owner.isDestroyed() || secondInstanceHash !== "#/settings/providers"
    || currentMainWindowDocumentOccurrence() !== documentOccurrence
    || !packagedSmokeSecondInstanceAcknowledged) {
    throw new Error(`Packaged smoke second-instance handoff was not acknowledged exactly (${secondInstanceHash}).`);
  }
  recordPackagedSmokeProgress("system_handoff_second_instance_acknowledged");

  await owner.webContents.executeJavaScript("window.location.hash = '#/settings/about'", true);
  const deepLink = buildDesktopSessionDeepLink({
    profileId: taskOwner.profileId,
    sessionId: taskOwner.sessionId
  });
  const expectedHash = `#/tasks/${encodeURIComponent(taskOwner.sessionId)}?${new URLSearchParams({
    profile: taskOwner.profileId
  }).toString()}`;
  owner.hide();
  if (owner.isVisible()) throw new Error("Packaged smoke could not hide the primary window before a public handoff.");
  if (!handleDesktopDeepLinkUrl(deepLink)) {
    throw new Error("Packaged smoke public Task deep link was rejected.");
  }
  const navigationDeadline = Date.now() + 10_000;
  let currentHash = "";
  while (Date.now() < navigationDeadline && !owner.isDestroyed()) {
    currentHash = await owner.webContents.executeJavaScript("window.location.hash", true) as unknown as string;
    if (owner.isVisible() && !owner.isMinimized() && owner.isFocused()
      && currentHash === expectedHash
      && currentMainWindowDocumentOccurrence() === documentOccurrence
      && desktopDeepLinkDelivery.takeAfterRendererReady(documentOccurrence) === undefined) break;
    await waitForPackagedSmokePoll();
  }
  if (owner.isDestroyed() || !owner.isVisible() || owner.isMinimized() || !owner.isFocused()
    || currentHash !== expectedHash || currentMainWindowDocumentOccurrence() !== documentOccurrence
    || desktopDeepLinkDelivery.takeAfterRendererReady(documentOccurrence) !== undefined) {
    throw new Error(`Packaged smoke public Task handoff did not reveal, route, and acknowledge exactly (${currentHash}).`);
  }
  recordPackagedSmokeProgress("system_handoff_deep_link_acknowledged");

  const attention = requireDesktopAttentionBadgeController();
  const attentionBaseline = attention.count;
  packagedSmokeTrayVerificationActive = true;
  try {
    const primaryResult = await owner.webContents.executeJavaScript([
      "(async () => {",
      "  const desktop = window.jokoDesktop;",
      "  if (!desktop) throw new Error('Primary Desktop bridge is unavailable.');",
      "  const canvas = document.createElement('canvas');",
      "  canvas.width = 256; canvas.height = 256;",
      "  const context = canvas.getContext('2d');",
      "  if (!context) throw new Error('Tray smoke canvas is unavailable.');",
      "  context.fillStyle = '#171717'; context.fillRect(0, 0, 256, 256);",
      "  context.fillStyle = '#ff9800'; context.fillRect(48, 48, 160, 160);",
      "  await desktop.setTrayIcon(canvas.toDataURL('image/png'));",
      `  const key = ${JSON.stringify({ ownerId: "packaged-smoke-system-handoff", sessionId: taskOwner.sessionId })};`,
      "  await desktop.attention.mark(key);",
      `  await desktop.notify(${JSON.stringify({
        title: "Packaged handoff foreground fence",
        body: "This notification must remain suppressed while Joko is foreground.",
        navigation: { kind: "session", profileId: taskOwner.profileId, sessionId: taskOwner.sessionId }
      })});`,
      "  return true;",
      "})()"
    ].join("\n"), true) as unknown;
    if (primaryResult !== true) throw new Error("Packaged smoke primary system bridge returned an invalid result.");
    const initialization = trayInitialization;
    if (initialization !== undefined) await initialization;
  } finally {
    packagedSmokeTrayVerificationActive = false;
  }
  if (tray === undefined || tray.isDestroyed() || runtimeTrayIcon === undefined || runtimeTrayIcon.isEmpty()
    || trayContextMenu === undefined) {
    throw new Error("Packaged smoke did not create the native Tray and its retained menu.");
  }
  if (attention.count !== attentionBaseline + 1 || desktopNotifications.size !== 0) {
    throw new Error("Packaged smoke foreground attention or notification projection escaped its fence.");
  }
  await owner.webContents.executeJavaScript([
    "window.jokoDesktop.attention.clear(",
    `  ${JSON.stringify({ ownerId: "packaged-smoke-system-handoff", sessionId: taskOwner.sessionId })}`,
    ")"
  ].join("\n"), true);
  if (attention.count !== attentionBaseline) {
    throw new Error("Packaged smoke did not clear the exact primary attention key.");
  }
  recordPackagedSmokeProgress("system_handoff_primary_surfaces_verified");

  await assertPackagedSmokeSystemHandoffOwnerFence(taskWindow, taskOwner);
  recordPackagedSmokeProgress("system_handoff_auxiliary_owner_fenced");

  owner.hide();
  (tray as unknown as { emit(event: string): boolean }).emit("click");
  const trayDeadline = Date.now() + 5_000;
  while (Date.now() < trayDeadline && !owner.isDestroyed()
    && (!owner.isVisible() || owner.isMinimized() || !owner.isFocused())) {
    await waitForPackagedSmokePoll();
  }
  if (owner.isDestroyed() || !owner.isVisible() || owner.isMinimized() || !owner.isFocused()) {
    throw new Error("Packaged smoke Tray reopen did not explicitly activate the primary window.");
  }
  recordPackagedSmokeProgress("system_handoff_tray_reopened");
}

async function assertPackagedSmokeSystemHandoffOwnerFence(
  window: BrowserWindow,
  owner: DesktopSessionWindowOwner
): Promise<void> {
  const result = await window.webContents.executeJavaScript([
    "(async () => {",
    "  const desktop = window.jokoDesktop;",
    "  if (!desktop) throw new Error('Task-window Desktop bridge is unavailable.');",
    "  const canvas = document.createElement('canvas');",
    "  canvas.width = 256; canvas.height = 256;",
    "  const key = { ownerId: 'packaged-smoke-forbidden-owner', sessionId: " + JSON.stringify(owner.sessionId) + " };",
    "  const attempts = [",
    "    desktop.setTrayIcon(canvas.toDataURL('image/png')) ,",
    "    desktop.notify({ title: 'Forbidden', body: 'Forbidden auxiliary notification.' }),",
    "    desktop.attention.mark(key),",
    "    desktop.attention.clear(key),",
    "    desktop.deepLinks.takePending()",
    "  ];",
    "  return Promise.all(attempts.map((attempt) => attempt.then(() => false, () => true)));",
    "})()"
  ].join("\n"), true) as unknown;
  if (!Array.isArray(result) || result.length !== 5 || result.some((blocked) => blocked !== true)) {
    throw new Error("Packaged smoke auxiliary Task document reached a primary system surface.");
  }
}

async function assertPackagedSmokeTaskWindowProfileFence(
  window: BrowserWindow,
  owner: DesktopSessionWindowOwner
): Promise<void> {
  const forbiddenProfileId = owner.profileId === "packaged-smoke-other-profile"
    ? "packaged-smoke-other-profile-2"
    : "packaged-smoke-other-profile";
  const value = await window.webContents.executeJavaScript([
    "(async () => {",
    "  const bridge = window.jokoDesktop?.sessionWindows;",
    "  if (!bridge) throw new Error('Task-window preload bridge is unavailable.');",
    `  const forbiddenProfileId = ${JSON.stringify(forbiddenProfileId)};`,
    `  const sessionId = ${JSON.stringify(owner.sessionId)};`,
    "  const openBlocked = await bridge.open({ profileId: forbiddenProfileId, sessionId }).then(() => false, () => true);",
    "  const gestureId = 'smoke_profile_fence_0004';",
    "  let dragBlocked = false;",
    "  let dragStarted = false;",
    "  try {",
    "    dragStarted = await bridge.beginDragPreview({",
    "      gestureId, profileId: forbiddenProfileId, sessionId,",
    "      label: 'Forbidden profile task', hint: 'Must remain bound',",
    "      palette: { surface: '#ffffff', border: '#d8d8d8', text: '#0d0d0d', muted: '#5f5f5f', accent: '#ff9800' }",
    "    });",
    "    if (dragStarted) await bridge.endDragPreview(gestureId);",
    "  } catch {",
    "    dragBlocked = true;",
    "  }",
    "  return { openBlocked, dragBlocked, dragStarted };",
    "})()"
  ].join("\n"), true) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (value as Record<string, unknown>)["openBlocked"] !== true
    || (value as Record<string, unknown>)["dragBlocked"] !== true
    || (value as Record<string, unknown>)["dragStarted"] !== false) {
    throw new Error("Packaged smoke Task window escaped its bound profile.");
  }
}

async function closePackagedSmokeTaskWindow(
  window: BrowserWindow,
  owner: DesktopSessionWindowOwner
): Promise<void> {
  const ownerKey = sessionWindowOwnerKey(owner);
  const contents = window.webContents;
  try {
    await contents.executeJavaScript("window.jokoDesktop.window.close()", true);
  } catch (error) {
    if (!window.isDestroyed()) throw error;
  }
  const closeDeadline = Date.now() + 10_000;
  while (Date.now() < closeDeadline && (!window.isDestroyed() || sessionWindows.has(ownerKey))) {
    await waitForPackagedSmokePoll();
  }
  if (!window.isDestroyed() || sessionWindows.has(ownerKey)
    || sessionWindowOwners.has(ownerKey)
    || sessionWindowOwnersByContents.has(contents)
    || sessionWindowStates.has(ownerKey)
    || nativeTaskStatusVisibleSessionsByContents.has(contents)) {
    throw new Error("Packaged smoke Task-window retirement left owned or visible state behind.");
  }
}

async function waitForPackagedSmokeDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function preparePackagedSmokeTaskOwner(
  owner: BrowserWindow,
  task: PackagedSmokeTask
): Promise<boolean> {
  const value = await owner.webContents.executeJavaScript([
    "(async () => {",
    `  const sessionId = ${JSON.stringify(task.sessionId)};`,
    `  const displayName = ${JSON.stringify(task.displayName)};`,
    "  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));",
    "  const taskPane = () => {",
    "    const timeline = [...document.querySelectorAll('[data-timeline-session-id]')].find((element) =>",
    "      element.getAttribute('data-timeline-session-id') === sessionId);",
    "    const pane = timeline?.closest('.session-pane');",
    "    return pane instanceof HTMLElement && pane.getAttribute('aria-label') === displayName ? pane : undefined;",
    "  };",
    "  const taskHash = `#/tasks/${encodeURIComponent(sessionId)}`;",
    "  location.hash = taskHash;",
    "  const deadline = Date.now() + 20_000;",
    "  while (taskPane() === undefined && Date.now() < deadline) {",
    "    // The service accepts the Task before the owner's event stream must",
    "    // project it. App routing correctly rejects an identity absent from",
    "    // its current snapshot, so retry the requested route until that same",
    "    // owner has observed the durable Task.",
    "    if (location.hash !== taskHash) location.hash = taskHash;",
    "    await sleep(100);",
    "  }",
    "  const mainTaskReady = Boolean(document.querySelector('.app')) &&",
    "    !document.querySelector('.connection-screen') && taskPane() !== undefined;",
    "  if (!mainTaskReady || typeof window.jokoDesktop?.sessionWindows?.open !== 'function' ||",
    "    typeof window.jokoDesktop?.sessionWindows?.beginDragPreview !== 'function' ||",
    "    typeof window.jokoDesktop?.sessionWindows?.endDragPreview !== 'function' ||",
    "    typeof window.jokoDesktop?.sessionWindows?.openIfDroppedOutside !== 'function') {",
    "    const diagnostic = {",
    "      hash: location.hash,",
    "      app: Boolean(document.querySelector('.app')),",
    "      connectionScreen: Boolean(document.querySelector('.connection-screen')),",
    "      timelineSessionIds: [...document.querySelectorAll('[data-timeline-session-id]')]",
    "        .map((element) => element.getAttribute('data-timeline-session-id')),",
    "      paneLabels: [...document.querySelectorAll('.session-pane')]",
    "        .map((element) => element.getAttribute('aria-label')),",
    "      alerts: [...document.querySelectorAll('[role=\"alert\"]')]",
    "        .map((element) => element.textContent?.trim().slice(0, 160) ?? '').filter(Boolean).slice(0, 4)",
    "    };",
    "    throw new Error(`The owner product UI did not observe the durable Task: ${JSON.stringify(diagnostic)}`);",
    "  }",
    "  return mainTaskReady;",
    "})()"
  ].join("\n"), true) as unknown;
  if (typeof value !== "boolean") {
    throw new Error("Packaged smoke Task owner preparation returned an invalid result.");
  }
  return value;
}

async function verifyPackagedSmokeTaskWindowDrag(
  owner: BrowserWindow,
  task: PackagedSmokeTask,
  profileId: string
): Promise<void> {
  const taskOwner = { profileId, sessionId: task.sessionId } as const;
  const taskOwnerKey = sessionWindowOwnerKey(taskOwner);
  if (sessionWindows.has(taskOwnerKey)) {
    throw new Error("Packaged smoke Task window existed before the drag gesture.");
  }
  const cancelled = await invokePackagedSmokeTaskDrag(owner, task, profileId, "smoke_cancel_0001", true);
  if (!cancelled.started || !cancelled.ended || cancelled.opened || sessionWindows.has(taskOwnerKey)) {
    throw new Error("Packaged smoke cancelled drag retained a preview or opened a Task window.");
  }
  recordPackagedSmokeProgress("task_drag_cancelled");

  const savedWindows = [...new Set([
    ...applicationWindows(),
    ...(inspectorWindow === undefined || inspectorWindow.isDestroyed() ? [] : [inspectorWindow])
  ])].map((window) => ({ window, visible: window.isVisible(), bounds: window.getBounds() }));
  try {
    const cursor = screen.getCursorScreenPoint();
    owner.setBounds(screen.getDisplayNearestPoint(cursor).bounds, false);
    owner.showInactive();
    if (!owner.isVisible() || owner.isMinimized() || !pointIsInsideRectangle(cursor, owner.getBounds())) {
      throw new Error("Packaged smoke could not place a visible owner around the system cursor.");
    }
    const inside = await invokePackagedSmokeTaskDrag(owner, task, profileId, "smoke_inside_0002", false);
    if (!inside.started || inside.ended || inside.opened || sessionWindows.has(taskOwnerKey)) {
      throw new Error("Packaged smoke inside-window drag opened a Task window.");
    }
    recordPackagedSmokeProgress("task_drag_inside_rejected");

    for (const entry of savedWindows) {
      if (!entry.window.isDestroyed()) entry.window.hide();
    }
    if (visibleSessionDragTargetBounds().length !== 0) {
      throw new Error("Packaged smoke could not establish an outside-all-application-windows release.");
    }
    const outside = await invokePackagedSmokeTaskDrag(owner, task, profileId, "smoke_outside_0003", false);
    if (!outside.started || outside.ended || !outside.opened || outside.focusedExisting !== false) {
      throw new Error("Packaged smoke outside-window drag did not open the exact Task singleton.");
    }
    const taskWindow = sessionWindows.get(taskOwnerKey);
    if (taskWindow === undefined || taskWindow.isDestroyed()) {
      throw new Error("Packaged smoke outside-window drag lost the opened Task window.");
    }
    await waitForPackagedSmokeTaskPresentation(taskWindow, task, taskOwner);
    if (!await focusPackagedSmokeTaskWindow(owner, task, profileId)
      || sessionWindows.get(taskOwnerKey) !== taskWindow
      || [...sessionWindows.values()].filter((candidate) => !candidate.isDestroyed()).length !== 1) {
      throw new Error("Packaged smoke outside-window drag did not refocus the exact Task singleton.");
    }
    const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const bounds = taskWindow.getBounds();
    if (!pointIsInsideRectangle({ x: bounds.x, y: bounds.y }, workArea)
      || !pointIsInsideRectangle({ x: bounds.x + bounds.width - 1, y: bounds.y + bounds.height - 1 }, workArea)) {
      throw new Error(
        `Packaged smoke outside-window drag placed the Task window outside its work area: ${JSON.stringify({ bounds, workArea })}.`
      );
    }
    recordPackagedSmokeProgress("task_drag_outside_opened");
  } finally {
    for (const entry of savedWindows) {
      if (entry.window.isDestroyed()) continue;
      entry.window.setBounds(entry.bounds, false);
      if (entry.visible) entry.window.showInactive();
      else entry.window.hide();
    }
  }
}

async function invokePackagedSmokeTaskDrag(
  owner: BrowserWindow,
  task: PackagedSmokeTask,
  profileId: string,
  gestureId: string,
  cancel: boolean
): Promise<{
  readonly started: boolean;
  readonly ended: boolean;
  readonly opened: boolean;
  readonly focusedExisting: boolean | null;
}> {
  const value = await owner.webContents.executeJavaScript([
    "(async () => {",
    `  const sessionId = ${JSON.stringify(task.sessionId)};`,
    `  const profileId = ${JSON.stringify(profileId)};`,
    `  const gestureId = ${JSON.stringify(gestureId)};`,
    `  const cancel = ${JSON.stringify(cancel)};`,
    "  const bridge = window.jokoDesktop?.sessionWindows;",
    "  if (!bridge) throw new Error('Task-window preload bridge is unavailable.');",
    "  const started = await bridge.beginDragPreview({",
    "    gestureId, profileId, sessionId, label: 'Packaged drag task', hint: 'Open in new window',",
    "    palette: { surface: '#ffffff', border: '#d8d8d8', text: '#0d0d0d', muted: '#5f5f5f', accent: '#ff9800' }",
    "  });",
    "  const ended = cancel ? await bridge.endDragPreview(gestureId) : false;",
    "  const drop = await bridge.openIfDroppedOutside(gestureId);",
    "  return {",
    "    started: started === true, ended: ended === true, opened: drop?.opened === true,",
    "    focusedExisting: drop?.opened === true ? drop.focusedExisting === true : null",
    "  };",
    "})()"
  ].join("\n"), true) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Packaged smoke Task drag returned an invalid result.");
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(",") !== "ended,focusedExisting,opened,started"
    || typeof result["started"] !== "boolean" || typeof result["ended"] !== "boolean"
    || typeof result["opened"] !== "boolean"
    || (result["focusedExisting"] !== null && typeof result["focusedExisting"] !== "boolean")) {
    throw new Error("Packaged smoke Task drag returned an invalid result.");
  }
  return {
    started: result["started"],
    ended: result["ended"],
    opened: result["opened"],
    focusedExisting: result["focusedExisting"]
  };
}

async function focusPackagedSmokeTaskWindow(
  owner: BrowserWindow,
  task: PackagedSmokeTask,
  profileId: string
): Promise<boolean> {
  const value = await owner.webContents.executeJavaScript([
    "(async () => {",
    "  const bridge = window.jokoDesktop?.sessionWindows;",
    "  if (!bridge) throw new Error('Task-window preload bridge is unavailable.');",
    `  const result = await bridge.open({ profileId: ${JSON.stringify(profileId)}, sessionId: ${JSON.stringify(task.sessionId)} });`,
    "  return result?.focusedExisting === true;",
    "})()"
  ].join("\n"), true) as unknown;
  if (typeof value !== "boolean") {
    throw new Error("Packaged smoke Task-window focus returned an invalid result.");
  }
  return value;
}

async function writePackagedSmokeTaskDraft(
  window: BrowserWindow,
  connection: DesktopManagedOrchestratorConnection,
  sessionId: string,
  text: string
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(
      "Boolean(document.querySelector('.session-pane .composer-rich-editor__content[contenteditable=\"true\"]'))",
      true
    ) as unknown;
    if (ready === true) break;
    await waitForPackagedSmokePoll();
  }
  const inserted = await window.webContents.executeJavaScript([
    "(() => {",
    "  const editor = document.querySelector('.session-pane .composer-rich-editor__content[contenteditable=\"true\"]');",
    "  if (!(editor instanceof HTMLElement) || editor.textContent?.trim()) return false;",
    "  editor.focus();",
    "  const selection = window.getSelection();",
    "  selection?.selectAllChildren(editor);",
    "  selection?.collapseToEnd();",
    `  return document.execCommand('insertText', false, ${JSON.stringify(text)});`,
    "})()"
  ].join("\n"), true) as unknown;
  if (inserted !== true) throw new Error("Packaged smoke could not edit the Task composer.");
  await waitForPackagedSmokeTaskDraft(window, text, true);
  await waitForPackagedSmokeIndexedDraft(
    window,
    JSON.stringify([connection.serverId, connection.profileId, sessionId]),
    text,
    "task"
  );
}

async function waitForPackagedSmokeTaskDraft(window: BrowserWindow, text: string, requireSaved: boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const observation = await window.webContents.executeJavaScript([
      "(() => {",
      "  const pane = document.querySelector('.session-pane');",
      "  const editor = pane?.querySelector('.composer-rich-editor__content');",
      "  return { text: editor?.textContent ?? '', saved: Boolean(pane?.querySelector('.draft-saved')) };",
      "})()"
    ].join("\n"), true) as unknown;
    if (typeof observation === "object" && observation !== null && !Array.isArray(observation)) {
      const result = observation as { readonly text?: unknown; readonly saved?: unknown };
      if (result.text === text && (!requireSaved || result.saved === true)) return;
    }
    await waitForPackagedSmokePoll();
  }
  throw new Error(requireSaved
    ? "Packaged smoke Task draft was not confirmed durable before the renderer crash."
    : "Packaged smoke Task draft was not restored after the renderer crash.");
}

async function waitForPackagedSmokeIndexedDraft(
  window: BrowserWindow,
  key: string,
  text: string,
  kind: "task" | "new-task"
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const durable = await window.webContents.executeJavaScript([
      "(async () => {",
      "  const database = await new Promise((resolve, reject) => {",
      "    const request = indexedDB.open('joko-ui', 1);",
      "    request.onsuccess = () => resolve(request.result);",
      "    request.onerror = () => reject(request.error);",
      "  });",
      "  try {",
      "    return await new Promise((resolve, reject) => {",
      "      const request = database.transaction('drafts', 'readonly').objectStore('drafts')",
      `        .get(${JSON.stringify(key)});`,
      `      request.onsuccess = () => resolve(${kind === "task" ? "request.result?.draft?.text" : "request.result?.text"} === ${JSON.stringify(text)});`,
      "      request.onerror = () => reject(request.error);",
      "    });",
      "  } finally { database.close(); }",
      "})()"
    ].join("\n"), true) === true;
    if (durable) return;
    await waitForPackagedSmokePoll();
  }
  throw new Error(`Packaged smoke ${kind} draft was not durable before the renderer crash.`);
}

async function verifyPackagedSmokeNewTaskDraftCrash(window: BrowserWindow): Promise<void> {
  const connection = await window.webContents.executeJavaScript(
    "window.jokoDesktop.managedOrchestrator.getConnection()",
    true
  ) as unknown;
  if (typeof connection !== "object" || connection === null || Array.isArray(connection)
    || typeof (connection as Record<string, unknown>)["serverId"] !== "string"
    || typeof (connection as Record<string, unknown>)["profileId"] !== "string") {
    throw new Error("Packaged smoke new-task draft has no managed connection owner.");
  }
  const { serverId, profileId } = connection as DesktopManagedOrchestratorConnection;
  const draftKey = `new-session\u0000${serverId}\u0000${profileId}`;
  const draftText = "Joko new-task draft survives renderer recovery";
  await window.webContents.executeJavaScript("location.hash = '#/tasks/new'; true", true);
  const readyDeadline = Date.now() + 20_000;
  let editorReady = false;
  while (Date.now() < readyDeadline) {
    editorReady = await window.webContents.executeJavaScript(
      "Boolean(document.querySelector('.new-task-page .composer-rich-editor__content[contenteditable=\"true\"]'))",
      true
    ) === true;
    if (editorReady) break;
    await waitForPackagedSmokePoll();
  }
  if (!editorReady) throw new Error("Packaged smoke new-task composer did not become editable.");
  const inserted = await window.webContents.executeJavaScript([
    "(() => {",
    "  const editor = document.querySelector('.new-task-page .composer-rich-editor__content[contenteditable=\"true\"]');",
    "  if (!(editor instanceof HTMLElement) || editor.textContent?.trim()) return false;",
    "  editor.focus();",
    "  const selection = window.getSelection();",
    "  selection?.selectAllChildren(editor);",
    "  selection?.collapseToEnd();",
    `  return document.execCommand('insertText', false, ${JSON.stringify(draftText)});`,
    "})()"
  ].join("\n"), true) as unknown;
  if (inserted !== true) throw new Error("Packaged smoke could not edit the new-task composer.");
  await waitForPackagedSmokeIndexedDraft(window, draftKey, draftText, "new-task");
  const contents = window.webContents;
  const lost = new Promise<void>((resolveLoss) => contents.once("render-process-gone", () => resolveLoss()));
  contents.forcefullyCrashRenderer();
  await waitForPackagedSmokeDeadline(lost, 10_000, "new-task renderer crash");
  await waitForPackagedSmokeOwnerDocument(window, "new-task crash reload", () => window.reload());
  const restoreDeadline = Date.now() + 20_000;
  while (Date.now() < restoreDeadline) {
    const restored = await window.webContents.executeJavaScript([
      "(() => {",
      "  const editor = document.querySelector('.new-task-page .composer-rich-editor__content');",
      `  return editor?.textContent === ${JSON.stringify(draftText)};`,
      "})()"
    ].join("\n"), true) as unknown;
    if (restored === true) {
      recordPackagedSmokeProgress("new_task_draft_recovered_after_renderer_crash");
      return;
    }
    await waitForPackagedSmokePoll();
  }
  throw new Error("Packaged smoke new-task draft was not restored after the renderer crash.");
}

async function waitForPackagedSmokeTaskPresentation(
  window: BrowserWindow,
  task: PackagedSmokeTask,
  owner: DesktopSessionWindowOwner
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastLocation = "unloaded";
  while (Date.now() < deadline) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      throw new Error("Packaged smoke Task window retired before its product UI loaded.");
    }
    try {
      const value = await waitForPackagedSmokeDeadline(window.webContents.executeJavaScript([
        "(async () => {",
        `  const sessionId = ${JSON.stringify(task.sessionId)};`,
        "  const taskOwner = await window.jokoDesktop?.sessionWindows?.getOwner?.();",
        "  const timelines = [...document.querySelectorAll('[data-timeline-session-id]')];",
        "  const timeline = timelines.find((element) => element.getAttribute('data-timeline-session-id') === sessionId);",
        "  const pane = timeline?.closest('.session-pane');",
        "  return {",
        "    href: location.href,",
        "    origin: location.origin,",
        "    hash: location.hash,",
        "    product: Boolean(document.querySelector('.app')),",
        "    connectionScreen: Boolean(document.querySelector('.connection-screen')),",
        "    preload: typeof window.jokoDesktop?.window?.close === 'function' &&",
        "      typeof window.jokoDesktop?.sessionWindows?.open === 'function' &&",
        "      typeof window.jokoDesktop?.sessionWindows?.getOwner === 'function',",
        "    ownerProfileId: taskOwner?.profileId ?? '',",
        "    ownerSessionId: taskOwner?.sessionId ?? '',",
        "    nodeGlobalsAbsent: typeof require === 'undefined' && typeof process === 'undefined',",
        "    timelineCount: timelines.length,",
        "    sessionId: timeline?.getAttribute('data-timeline-session-id') ?? '',",
        "    displayName: pane instanceof HTMLElement ? pane.getAttribute('aria-label') ?? '' : ''",
        "  };",
        "})()"
      ].join("\n"), true) as Promise<unknown>, 2_000, "Task product presentation probe");
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const observation = value as Record<string, unknown>;
        if (typeof observation["href"] === "string") lastLocation = observation["href"];
        if (observation["product"] === true
          && observation["connectionScreen"] === false
          && observation["preload"] === true
          && observation["nodeGlobalsAbsent"] === true
          && observation["ownerProfileId"] === owner.profileId
          && observation["ownerSessionId"] === owner.sessionId
          && observation["timelineCount"] === 1
          && observation["sessionId"] === task.sessionId
          && observation["displayName"] === task.displayName) {
          const href = String(observation["href"]);
          const url = new URL(href);
          if (observation["origin"] !== "joko://app"
            || url.protocol !== "joko:" || url.hostname !== "app" || url.port !== ""
            || url.username !== "" || url.password !== ""
            || [...url.searchParams.keys()].sort().join(",") !== "bootSession,sessionWindow"
            || url.searchParams.get("sessionWindow") !== "1"
            || url.searchParams.get("bootSession") !== task.sessionId
            || url.hash !== `#/tasks/${encodeURIComponent(task.sessionId)}`) {
            throw new Error("Packaged smoke Task window loaded an untrusted or inexact entry URL.");
          }
          return;
        }
      }
    } catch (error) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) throw error;
    }
    await waitForPackagedSmokePoll();
  }
  throw new Error(`Packaged smoke Task product UI did not become ready (${lastLocation}).`);
}

function waitForPackagedSmokePoll(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
}

function finishPackagedSmoke(result: string, exitCode: number): void {
  if (packagedSmokeFinishing) return;
  packagedSmokeFinishing = true;
  recordPackagedSmokeProgress("finish_started");
  disposeDesktopUpdateLifecycle();
  if (packagedSmokeResultPath !== undefined) {
    try {
      writeFileSync(packagedSmokeResultPath, `${result}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      // The process exit still makes a duplicate or unwritable result fail in
      // the parent harness; never overwrite an existing marker.
    }
  }
  const runtime = managedOrchestratorRuntime;
  managedOrchestratorRuntime = undefined;
  const retirePeerAgent = desktopDevicePeerAgentLifecycle?.dispose() ?? Promise.resolve();
  if (runtime === undefined) {
    recordPackagedSmokeProgress("finish_without_runtime");
    void retirePeerAgent.finally(() => exitPackagedSmokeProcess(exitCode));
    return;
  }
  recordPackagedSmokeProgress("runtime_stop_started");
  void retirePeerAgent.then(() => runtime.stop()).then(
    () => {
      recordPackagedSmokeProgress("runtime_stop_completed");
      exitPackagedSmokeProcess(exitCode);
    },
    () => {
      recordPackagedSmokeProgress("runtime_stop_failed");
      process.stderr.write("JOKO_DESKTOP_SMOKE_MANAGED_ORCHESTRATOR_STOP_FAILED\n");
      exitPackagedSmokeProcess(1);
    }
  );
}

function recordPackagedSmokeProgress(step: string): void {
  if (!packagedSmoke || packagedSmokeResultPath === undefined) return;
  try {
    appendFileSync(`${packagedSmokeResultPath}.progress`, `${step}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // The terminal result remains authoritative.
  }
}

function observePackagedSmokeDesktopOpenIntent(
  intent: DesktopInboundOpenIntent,
  source: DesktopOpenIntentIngressSource
): boolean {
  if (!packagedSmoke || packagedSmokeScope !== "full") return false;
  if (source === "coldArgv") {
    if (intent.kind === "focus" && intent.source === "packaged-smoke-cold") {
      recordPackagedSmokeProgress("system_handoff_cold_argv_ingress");
    }
    return false;
  }
  if (source !== "secondInstance") return false;
  const resolveIntent = resolvePackagedSmokeSecondInstanceIntent;
  if (resolveIntent === undefined) return false;
  resolvePackagedSmokeSecondInstanceIntent = undefined;
  packagedSmokeSecondInstanceAwaitingAcknowledgement = true;
  packagedSmokeSecondInstanceDelivery = undefined;
  packagedSmokeSecondInstanceAcknowledged = false;
  recordPackagedSmokeProgress("system_handoff_second_instance_ingress");
  resolveIntent(intent);
  return true;
}

function waitForPackagedSmokeSecondInstanceIntent(): Promise<DesktopInboundOpenIntent> {
  return new Promise((resolveIntent, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Packaged smoke did not receive the second-instance open intent."));
    }, 30_000);
    timeout.unref();
    void packagedSmokeSecondInstanceIntent.then((intent) => {
      clearTimeout(timeout);
      resolveIntent(intent);
    });
  });
}

type DesktopUiWindowIdentity =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "extension"; readonly id: string };

async function loadUi(window: BrowserWindow, identity?: DesktopUiWindowIdentity): Promise<void> {
  const withWindowIdentity = (value: string): string => {
    if (identity === undefined) return value;
    const url = new URL(value);
    url.search = "";
    if (identity.kind === "session") {
      url.searchParams.set("sessionWindow", "1");
      url.searchParams.set("bootSession", identity.id);
      url.hash = `#/tasks/${encodeURIComponent(identity.id)}`;
    } else {
      url.searchParams.set("extensionWindow", "1");
      url.searchParams.set("bootExtension", identity.id);
      url.hash = `#/extensions/${encodeURIComponent(identity.id)}`;
    }
    return url.href;
  };
  if (navigationPolicy.developmentUrl !== undefined) {
    await window.loadURL(withWindowIdentity(navigationPolicy.developmentUrl));
    return;
  }
  await verifyPackagedWebBundle(packagedEntryPath);
  await window.loadURL(withWindowIdentity(DESKTOP_APP_ENTRY_URL));
}

function desktopRendererLossError(
  kind: "main" | "session" | "extension" | "runtime",
  details: { readonly reason: string; readonly exitCode: number }
): Error {
  const surface = kind === "main"
    ? "application"
    : kind === "runtime" ? "runtime resource window" : kind === "extension" ? "Extension window" : "task window";
  return new Error(
    `The ${surface} renderer stopped unexpectedly (${details.reason}, exit ${details.exitCode}).`
  );
}

async function presentDesktopWindowLoadFailure(
  kind: "main" | "session" | "extension" | "runtime",
  error: unknown,
  attempt: number,
  preferredOwner?: BrowserWindow
): Promise<DesktopWindowLoadFailureAction> {
  const labels = desktopWindowLoadFailureLabels(applicationMenuLocale, kind, attempt);
  const main = kind === "main";
  const options: MessageBoxOptions = {
    type: "error",
    title: labels.title,
    message: labels.message,
    detail: `${safeSmokeError(error)}${labels.attemptDetail}`,
    buttons: labels.buttons,
    defaultId: 0,
    cancelId: 1,
    noLink: true
  };
  const dialogOwner = preferredOwner !== undefined && !preferredOwner.isDestroyed() && preferredOwner.isVisible()
    ? preferredOwner
    : !main && mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isVisible()
      ? mainWindow
      : undefined;
  const result = dialogOwner === undefined
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(dialogOwner, options);
  return result.response === 0 ? "retry" : "close";
}

async function loadGlobalVoiceOverlayUi(window: BrowserWindow): Promise<void> {
  const value = new URL(navigationPolicy.developmentUrl ?? DESKTOP_APP_ENTRY_URL);
  value.search = "";
  value.searchParams.set("globalVoiceOverlay", "1");
  value.hash = "";
  if (navigationPolicy.developmentUrl === undefined) await verifyPackagedWebBundle(packagedEntryPath);
  await window.loadURL(value.href);
}

async function registerGlobalVoiceShortcut(value: unknown): Promise<DesktopGlobalVoiceShortcutResult> {
  const shortcut = parseDesktopGlobalVoiceShortcut(value);
  clearGlobalVoiceShortcutRecoveryFailure();
  return globalVoiceShortcutBinding.register(shortcut);
}

function reserveMacGlobalVoiceFunctionKey(): void {
  // Electron owns the bare accelerator so the native listen-only observer does not leak it forward.
}

function pendingGlobalVoiceShortcutRecoveryTarget(): GlobalVoiceShortcutRecoveryTarget {
  if (process.platform !== "darwin" || globalVoiceShortcutRecordingActive()) return { kind: "none" };
  const contents = mainWindow?.webContents;
  if (contents === undefined || contents.isDestroyed()) return { kind: "none" };
  const desired = globalVoiceShortcutBinding.desiredSnapshot();
  const shortcut = desired.shortcut;
  if (shortcut === "disabled" || nativeVoiceShortcutTarget(shortcut, "darwin") === undefined) {
    return { kind: "none" };
  }
  const registered = globalVoiceNativeRegistration.current();
  if (registered !== undefined && globalVoiceShortcutsEqual(registered, shortcut)
    && globalVoiceNativeShortcut.isReady()) return { kind: "none" };
  if (globalVoiceNativeShortcut.isStarting()) return { kind: "wait" };
  return {
    kind: "register",
    revision: desired.revision,
    shortcut
  };
}

async function recoverGlobalVoiceShortcut(
  shortcut: DesktopGlobalVoiceShortcut,
  revision: number
): Promise<"registered" | "permission" | "failed" | "superseded"> {
  return globalVoiceShortcutBinding.recover(shortcut, revision, () => !globalVoiceShortcutRecordingActive());
}

function completeGlobalVoiceShortcutRecovery(): void {
  clearGlobalVoiceShortcutRecoveryFailure();
  const contents = mainWindow?.webContents;
  if (contents === undefined || contents.isDestroyed()) return;
  contents.send(DESKTOP_CHANNELS.globalVoiceShortcutRecovered);
}

function recordGlobalVoiceShortcutRecoveryFailure(): void {
  if (globalVoiceShortcutRecoveryFailurePending) return;
  globalVoiceShortcutRecoveryFailurePending = true;
  const contents = mainWindow?.webContents;
  if (contents === undefined || contents.isDestroyed()) return;
  contents.send(DESKTOP_CHANNELS.globalVoiceShortcutRecoveryFailed);
}

function clearGlobalVoiceShortcutRecoveryFailure(): void {
  globalVoiceShortcutRecoveryFailurePending = false;
}

function consumeGlobalVoiceShortcutRecoveryFailure(_contents: WebContents): { readonly failed: boolean } {
  return { failed: globalVoiceShortcutRecoveryFailurePending };
}

function globalVoiceShortcutsEqual(
  left: DesktopGlobalVoiceShortcut,
  right: DesktopGlobalVoiceShortcut
): boolean {
  return left.code === right.code
    && left.meta === right.meta
    && left.ctrl === right.ctrl
    && left.alt === right.alt
    && left.shift === right.shift
    && left.fn === right.fn;
}

function unregisterGlobalVoiceShortcut(): void {
  globalVoiceShortcutBinding.clear();
}

function activateGlobalVoiceShortcut(): void {
  const pressed = pressGlobalVoiceInput("shortcut");
  if (!pressed.accepted) return;
  globalVoiceInputLease.release(pressed.lease, "tap");
}

function pressGlobalVoiceInput(source: GlobalVoiceInputSource) {
  if (globalVoiceAdmissionUnavailable() || externalTextInsertionCoordinator.busy()) {
    return Object.freeze({ accepted: false as const, reason: "recording-transition" as const });
  }
  const recording = globalVoiceInputLease.snapshot();
  if (recording.state !== "idle" && recording.source !== source) {
    return Object.freeze({
      accepted: false as const,
      reason: recording.state === "uncertain"
        ? "recording-uncertain" as const
        : "recording-transition" as const
    });
  }
  return globalVoiceInputLease.press(source);
}

function globalVoiceAdmissionUnavailable(): boolean {
  return quitting || globalVoiceExitAdmissionClosed || managedOrchestratorExitFence.shutdownStarted;
}

async function cancelGlobalVoiceForExit(): Promise<void> {
  const recording = globalVoiceInputLease.snapshot();
  if (recording.state === "idle") {
    resetGlobalVoicePresentation();
    return;
  }
  await settleGlobalVoiceForExit(globalVoiceInputLease);
}

function startGlobalVoiceInputLease(
  generation: number,
  source: GlobalVoiceInputSource
): boolean {
  const mode = globalVoiceStartModes.get(generation) ?? "start";
  globalVoiceStartModes.delete(generation);
  if (globalVoiceAdmissionUnavailable() || globalVoiceShortcutRecordingActive()
    || externalTextInsertionCoordinator.busy()) return false;
  const recording = globalVoiceInputLease.snapshot();
  if (recording.state === "idle" || recording.generation !== generation || recording.source !== source
    || globalVoiceActiveGeneration !== undefined) return false;
  const generationValue = globalVoiceGenerationValue(generation);
  globalVoiceActiveGeneration = generation;
  globalVoiceRetry = undefined;
  globalVoiceCancellingGeneration = undefined;
  globalVoiceCommitFence = { generation, state: "open" };
  beginGlobalVoiceSystemAudio();
  setGlobalVoiceStatus({ state: "starting", generation: generationValue });
  try {
    showGlobalVoiceOverlay();
  } catch {
    failGlobalVoiceGeneration(generation, "service");
    return false;
  }
  if (sendGlobalVoiceCommand({ type: mode, generation: generationValue })) return true;
  failGlobalVoiceGeneration(generation, "service");
  return false;
}

function stopGlobalVoiceInputLease(
  generation: number,
  source: GlobalVoiceInputSource,
  reason: VoiceLeaseStopReason
): void | Promise<void> {
  const recording = globalVoiceInputLease.snapshot();
  if (recording.state === "idle" || recording.generation !== generation || recording.source !== source) return;
  if (globalVoiceActiveGeneration !== generation) {
    failGlobalVoiceGeneration(generation, "service");
    return;
  }
  const stopped = new Promise<void>((resolve, reject) => {
    const prior = globalVoiceStopWaiters.get(generation);
    if (prior !== undefined) {
      clearTimeout(prior.timeout);
      prior.reject(new Error("Global voice stop was superseded."));
    }
    const timeout = setTimeout(() => {
      if (globalVoiceStopWaiters.get(generation)?.timeout !== timeout) return;
      globalVoiceStopWaiters.delete(generation);
      markGlobalVoiceStopUncertain(generation);
      reject(new Error("Global voice stop was not acknowledged."));
    }, 30_000);
    timeout.unref();
    globalVoiceStopWaiters.set(generation, { resolve, reject, timeout });
  });
  if (reason === "cancel") {
    globalVoiceCancellingGeneration = generation;
    if (globalVoiceCommitFence?.generation === generation) globalVoiceCommitFence.state = "consumed";
    if (!sendGlobalVoiceCommand({
      type: "cancel",
      generation: globalVoiceGenerationValue(generation)
    })) rejectGlobalVoiceStop(generation, new Error("Global voice cancellation could not be delivered."));
  } else {
    submitGlobalVoiceShortcut(generation);
  }
  return stopped;
}

function rejectGlobalVoiceStop(generation: number, error: Error): void {
  const waiter = globalVoiceStopWaiters.get(generation);
  if (waiter === undefined) return;
  globalVoiceStopWaiters.delete(generation);
  clearTimeout(waiter.timeout);
  markGlobalVoiceStopUncertain(generation);
  waiter.reject(error);
}

function acknowledgeGlobalVoiceInputStopped(generation: number): boolean {
  const snapshot = globalVoiceInputLease.snapshot();
  if (snapshot.state === "idle" || snapshot.generation !== generation
    || !globalVoiceInputLease.acknowledgeStopped(generation)) return false;
  const waiter = globalVoiceStopWaiters.get(generation);
  if (waiter === undefined) return true;
  globalVoiceStopWaiters.delete(generation);
  clearTimeout(waiter.timeout);
  waiter.resolve();
  return true;
}

function submitGlobalVoiceShortcut(generation: number): boolean {
  const recording = globalVoiceInputLease.snapshot();
  if (globalVoiceActiveGeneration !== generation || recording.state === "idle"
    || recording.generation !== generation) return false;
  const generationValue = globalVoiceGenerationValue(generation);
  setGlobalVoiceStatus({
    state: "submitting",
    generation: generationValue,
    transcript: globalVoiceStatus.generation === generationValue && globalVoiceStatus.state === "listening"
      ? globalVoiceStatus.transcript
      : ""
  });
  if (sendGlobalVoiceCommand({ type: "submit", generation: generationValue })) return true;
  failGlobalVoiceGeneration(generation, "service");
  return false;
}

function handleNativeGlobalVoiceShortcutPhase(phase: "start" | "tap" | "end"): void {
  if (phase === "start") {
    const pressed = pressGlobalVoiceInput("shortcut");
    if (pressed.accepted) globalVoiceShortcutPressLease = pressed.lease;
    return;
  }
  const lease = globalVoiceShortcutPressLease;
  globalVoiceShortcutPressLease = undefined;
  if (lease !== undefined) globalVoiceInputLease.release(lease, phase === "tap" ? "tap" : "hold");
}

function globalVoiceShortcutRecordingActive(): boolean {
  return globalVoiceShortcutCaptureSubscriptions.recording()
    || applicationMenuConfigurationState.snapshot().configuration.shortcutRecording;
}

async function startGlobalVoiceShortcutCapture(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed()) return false;
  const started = await globalVoiceShortcutCaptureSubscriptions.start(contents);
  if (!started) return false;
  if (!contents.isDestroyed()) return true;
  globalVoiceShortcutCaptureSubscriptions.stop(contents);
  return false;
}

function stopGlobalVoiceShortcutCapture(contents?: WebContents): void {
  globalVoiceShortcutCaptureSubscriptions.stop(contents);
}

async function restoreGlobalVoiceShortcutAfterSuspension(owner: string): Promise<void> {
  try {
    const result = await globalVoiceShortcutBinding.resume(owner);
    if (result === "failed") recordGlobalVoiceShortcutRecoveryFailure();
    else if (result === "registered" && globalVoiceShortcutRecoveryFailurePending) {
      completeGlobalVoiceShortcutRecovery();
    }
  } catch {
    recordGlobalVoiceShortcutRecoveryFailure();
  }
}

function handleGlobalVoiceShortcutRestartLimit(): void {
  const registered = globalVoiceShortcutBinding.invalidateNativeBinding();
  stopGlobalVoiceShortcutCapture();
  globalVoiceShortcutPressLease = undefined;
  globalVoiceInputLease.cancelSource("shortcut");
  if (registered) recordGlobalVoiceShortcutRecoveryFailure();
}

function sendGlobalVoiceCommand(command: DesktopGlobalVoiceCommand): boolean {
  const contents = mainWindow?.webContents;
  if (contents === undefined || contents.isDestroyed()) return false;
  try {
    contents.send(DESKTOP_CHANNELS.globalVoiceCommand, command);
    return true;
  } catch {
    return false;
  }
}

function beginGlobalVoiceSystemAudio(): void {
  const previous = globalVoiceSystemAudioOwner;
  const owner = ++globalVoiceSystemAudioOwnerSequence;
  globalVoiceSystemAudioOwner = owner;
  if (globalVoiceMuteSystemAudio) void globalVoiceSystemAudio.acquire(owner).catch(() => undefined);
  if (previous !== undefined) void globalVoiceSystemAudio.release(previous).catch(() => undefined);
}

function stopGlobalVoiceSystemAudio(): void {
  const owner = globalVoiceSystemAudioOwner;
  globalVoiceSystemAudioOwner = undefined;
  if (owner !== undefined) void globalVoiceSystemAudio.release(owner).catch(() => undefined);
}

function setGlobalVoiceMuteSystemAudio(enabled: boolean): void {
  globalVoiceMuteSystemAudio = enabled;
  const owner = globalVoiceSystemAudioOwner;
  if (owner === undefined) return;
  if (enabled) void globalVoiceSystemAudio.acquire(owner).catch(() => undefined);
  else void globalVoiceSystemAudio.release(owner).catch(() => undefined);
}

function showGlobalVoiceOverlay(): void {
  const existing = globalVoiceOverlayWindow;
  if (existing !== undefined && !existing.isDestroyed()) {
    positionGlobalVoiceOverlay(existing);
    existing.showInactive();
    existing.webContents.send(DESKTOP_CHANNELS.globalVoiceStatus, globalVoiceStatus);
    return;
  }
  const window = new BrowserWindow({
    width: 532,
    height: 196,
    minWidth: 532,
    minHeight: 196,
    maxWidth: 532,
    maxHeight: 196,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    title: "Joko Voice Input",
    webPreferences: {
      preload: join(sourceDirectory, "voice-overlay-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  globalVoiceOverlayWindow = window;
  positionGlobalVoiceOverlay(window);
  window.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "pop-up-menu");
  if (process.platform === "darwin") window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isGlobalVoiceOverlayNavigation(url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isGlobalVoiceOverlayNavigation(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
  });
  window.once("ready-to-show", () => {
    if (globalVoiceStatus.state !== "idle" && !window.isDestroyed()) window.showInactive();
  });
  window.webContents.on("did-finish-load", () => {
    if (!window.isDestroyed()) window.webContents.send(DESKTOP_CHANNELS.globalVoiceStatus, globalVoiceStatus);
  });
  window.webContents.on("render-process-gone", () => {
    if (globalVoiceOverlayWindow !== window || quitting) return;
    globalVoiceOverlayWindow = undefined;
    if (!window.isDestroyed()) window.destroy();
    const generation = currentGlobalVoiceGeneration();
    if (generation !== undefined) failGlobalVoiceGeneration(generation, "service");
  });
  window.on("closed", () => {
    if (globalVoiceOverlayWindow === window) globalVoiceOverlayWindow = undefined;
  });
  void loadGlobalVoiceOverlayUi(window).catch(() => {
    if (!window.isDestroyed()) window.destroy();
    const generation = currentGlobalVoiceGeneration();
    if (generation !== undefined) failGlobalVoiceGeneration(generation, "service");
  });
}

function positionGlobalVoiceOverlay(window: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const bounds = window.getBounds();
  window.setPosition(
    Math.round(area.x + (area.width - bounds.width) / 2),
    Math.round(area.y + area.height * 0.86 - bounds.height / 2),
    false
  );
}

function exitPackagedSmokeProcess(exitCode: number): never {
  // The isolated smoke has already synchronously committed its result and
  // awaited managed-Orchestrator termination. Avoid depending on Electron's native
  // shutdown pump, which is not part of this forced test-only exit path.
  recordPackagedSmokeProgress("process_exit_started");
  const reallyExit = (process as NodeJS.Process & {
    readonly reallyExit?: (code?: number) => never;
  }).reallyExit;
  if (reallyExit !== undefined) reallyExit.call(process, exitCode);
  process.exit(exitCode);
}

function isGlobalVoiceOverlayNavigation(value: string): boolean {
  if (!isAllowedMainFrameNavigation(value, navigationPolicy)) return false;
  try {
    const url = new URL(value);
    return [...url.searchParams.keys()].join(",") === "globalVoiceOverlay"
      && url.searchParams.get("globalVoiceOverlay") === "1"
      && url.hash === "";
  } catch {
    return false;
  }
}

function setGlobalVoiceStatus(status: DesktopGlobalVoiceStatus): void {
  if (status.state === "idle" || status.state === "error") stopGlobalVoiceSystemAudio();
  globalVoiceStatus = Object.freeze(status);
  const overlay = globalVoiceOverlayWindow;
  if (overlay !== undefined && !overlay.isDestroyed()) {
    overlay.webContents.send(DESKTOP_CHANNELS.globalVoiceStatus, globalVoiceStatus);
  }
}

function mayAcceptGlobalVoiceStatus(status: DesktopGlobalVoiceStatus): boolean {
  if (status.state === "idle" || status.state === "error") return true;
  if (globalVoiceStatus.generation !== status.generation) return status.state === "starting";
  if (status.state === "starting") return globalVoiceStatus.state === "starting";
  if (status.state === "listening") {
    return globalVoiceStatus.state === "starting" || globalVoiceStatus.state === "listening";
  }
  return globalVoiceStatus.state === "starting"
    || globalVoiceStatus.state === "listening"
    || globalVoiceStatus.state === "submitting";
}

function globalVoiceGenerationValue(generation: number): string {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new TypeError("Global voice generation is invalid.");
  }
  return String(generation);
}

function currentGlobalVoiceGeneration(): number | undefined {
  const recording = globalVoiceInputLease.snapshot();
  if (recording.state !== "idle") return recording.generation;
  if (globalVoiceActiveGeneration !== undefined) return globalVoiceActiveGeneration;
  return globalVoiceStatus.generation === "0" ? undefined : Number(globalVoiceStatus.generation);
}

function globalVoiceGenerationIsCurrent(generation: number): boolean {
  const recording = globalVoiceInputLease.snapshot();
  if (recording.state !== "idle") return recording.generation === generation;
  if (globalVoiceActiveGeneration !== undefined) return globalVoiceActiveGeneration === generation;
  return globalVoiceStatus.generation === globalVoiceGenerationValue(generation);
}

function failGlobalVoiceGeneration(
  generation: number,
  errorKind: DesktopGlobalVoiceErrorKind
): boolean {
  const recording = globalVoiceInputLease.snapshot();
  if (recording.state === "idle" || recording.generation !== generation
    || (globalVoiceActiveGeneration !== undefined && globalVoiceActiveGeneration !== generation)) return false;
  const generationValue = globalVoiceGenerationValue(generation);
  globalVoiceActiveGeneration = undefined;
  if (globalVoiceCancellingGeneration === generation) globalVoiceCancellingGeneration = undefined;
  globalVoiceStartModes.delete(generation);
  if (globalVoiceCommitFence?.generation === generation) globalVoiceCommitFence.state = "consumed";
  globalVoiceRetry = { source: recording.source, failedGeneration: generation };
  if (globalVoiceShortcutPressLease?.recordingGeneration === generation) globalVoiceShortcutPressLease = undefined;
  if (globalVoiceHardwarePressLease?.recordingGeneration === generation) globalVoiceHardwarePressLease = undefined;
  if (recording.source === "hardware") dedicatedHardwareSystemVoiceController?.retire();
  setGlobalVoiceStatus({ state: "error", generation: generationValue, errorKind });
  acknowledgeGlobalVoiceInputStopped(generation);
  return true;
}

function markGlobalVoiceStopUncertain(generation: number): boolean {
  const recording = globalVoiceInputLease.snapshot();
  if (recording.state === "idle" || recording.generation !== generation) return false;
  globalVoiceActiveGeneration = undefined;
  globalVoiceRetry = undefined;
  globalVoiceStartModes.delete(generation);
  if (globalVoiceCommitFence?.generation === generation) globalVoiceCommitFence.state = "consumed";
  if (globalVoiceShortcutPressLease?.recordingGeneration === generation) globalVoiceShortcutPressLease = undefined;
  if (globalVoiceHardwarePressLease?.recordingGeneration === generation) globalVoiceHardwarePressLease = undefined;
  if (recording.source === "hardware") dedicatedHardwareSystemVoiceController?.retire();
  setGlobalVoiceStatus({
    state: "error",
    generation: globalVoiceGenerationValue(generation),
    errorKind: "service"
  });
  return true;
}

function resetGlobalVoicePresentation(expectedGeneration?: number): boolean {
  const recording = globalVoiceInputLease.snapshot();
  const generation = expectedGeneration
    ?? (recording.state === "idle" ? currentGlobalVoiceGeneration() : recording.generation);
  if (generation !== undefined && !globalVoiceGenerationIsCurrent(generation)) return false;
  if (expectedGeneration !== undefined && generation === undefined) return false;

  if (generation === undefined) {
    globalVoiceActiveGeneration = undefined;
    globalVoiceRetry = undefined;
    globalVoiceCommitFence = undefined;
    globalVoiceCancellingGeneration = undefined;
    globalVoiceStartModes.clear();
    globalVoiceShortcutPressLease = undefined;
    globalVoiceHardwarePressLease = undefined;
    dedicatedHardwareSystemVoiceController?.retire();
    setGlobalVoiceStatus({ state: "idle", generation: "0" });
  } else {
    const generationValue = globalVoiceGenerationValue(generation);
    if (globalVoiceActiveGeneration === generation) globalVoiceActiveGeneration = undefined;
    if (globalVoiceRetry?.failedGeneration === generation) globalVoiceRetry = undefined;
    if (globalVoiceCancellingGeneration === generation) globalVoiceCancellingGeneration = undefined;
    if (globalVoiceCommitFence?.generation === generation) globalVoiceCommitFence.state = "consumed";
    globalVoiceStartModes.delete(generation);
    if (globalVoiceShortcutPressLease?.recordingGeneration === generation) globalVoiceShortcutPressLease = undefined;
    if (globalVoiceHardwarePressLease?.recordingGeneration === generation) globalVoiceHardwarePressLease = undefined;
    dedicatedHardwareSystemVoiceController?.retire();
    acknowledgeGlobalVoiceInputStopped(generation);
    setGlobalVoiceStatus({ state: "idle", generation: generationValue });
  }
  const overlay = globalVoiceOverlayWindow;
  if (overlay !== undefined && !overlay.isDestroyed()) overlay.hide();
  return true;
}

function destroyGlobalVoiceOverlay(): void {
  const overlay = globalVoiceOverlayWindow;
  globalVoiceOverlayWindow = undefined;
  if (overlay !== undefined && !overlay.isDestroyed()) overlay.destroy();
}

function globalVoiceAccessibilitySnapshot(): { readonly status: "granted" | "denied" | "not-required" | "unknown" } {
  if (process.platform !== "darwin") return { status: "not-required" };
  try {
    return { status: systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied" };
  } catch {
    return { status: "unknown" };
  }
}

async function openGlobalVoiceAccessibilitySettings(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    return true;
  } catch {
    return false;
  }
}

async function globalVoiceInputMonitoringSnapshot(): Promise<{ readonly status: NativeVoiceInputMonitoringStatus }> {
  return { status: await globalVoiceNativeShortcut.inputMonitoringStatus() };
}

async function openGlobalVoiceInputMonitoringSettings(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const status = await globalVoiceNativeShortcut.inputMonitoringStatus(true);
  if (status === "granted") {
    void globalVoiceShortcutRecovery.request();
    return true;
  }
  try {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent");
    return true;
  } catch {
    return false;
  }
}

function runBoundedHostCommand(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, [...args], { stdio: "ignore", windowsHide: true });
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 2_500);
    timeout.unref();
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

function createNativeSessionDragPreview(
  owner: BrowserWindow,
  request: DesktopSessionDragPreviewRequest
): NativeSessionDragPreviewWindow {
  const preview = new BrowserWindow({
    width: SESSION_DRAG_PREVIEW_SIZE.width,
    height: SESSION_DRAG_PREVIEW_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false
    }
  });
  preview.setIgnoreMouseEvents(true, { forward: true });
  preview.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "pop-up-menu");
  if (process.platform === "darwin") preview.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  let ready = false;
  let showRequested = false;
  let cleaned = false;
  const ownerContents = owner.webContents;
  const cancelForOwnerLoss = (): void => { sessionDragPreviewCoordinator.endOwner(owner); };
  const markReady = (): void => {
    ready = true;
    if (showRequested && !preview.isDestroyed()) preview.showInactive();
  };
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    owner.removeListener("closed", cancelForOwnerLoss);
    ownerContents.removeListener("destroyed", cancelForOwnerLoss);
    ownerContents.removeListener("render-process-gone", cancelForOwnerLoss);
    ownerContents.removeListener("did-start-loading", cancelForOwnerLoss);
    if (!preview.webContents.isDestroyed()) preview.webContents.removeListener("did-finish-load", markReady);
  };
  owner.once("closed", cancelForOwnerLoss);
  ownerContents.once("destroyed", cancelForOwnerLoss);
  ownerContents.once("render-process-gone", cancelForOwnerLoss);
  ownerContents.once("did-start-loading", cancelForOwnerLoss);
  preview.webContents.once("did-finish-load", markReady);
  preview.once("closed", cleanup);

  const dataUrl = sessionDragPreviewDataUrl(request);
  preview.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  preview.webContents.on("will-navigate", (event, url) => {
    if (url !== dataUrl) event.preventDefault();
  });
  void preview.loadURL(dataUrl).catch(() => {
    if (!preview.isDestroyed()) preview.destroy();
  });

  return Object.freeze({
    isDestroyed: () => preview.isDestroyed(),
    setBounds: (bounds: DesktopRectangle) => {
      if (!preview.isDestroyed()) preview.setBounds(bounds, false);
    },
    showInactive: () => {
      showRequested = true;
      if (ready && !preview.isDestroyed()) preview.showInactive();
    },
    hide: () => {
      showRequested = false;
      if (!preview.isDestroyed() && preview.isVisible()) preview.hide();
    },
    destroy: () => {
      cleanup();
      if (preview.isDestroyed()) return;
      preview.hide();
      preview.setOpacity(0);
      preview.destroy();
    }
  });
}

function handleNativeSessionDragMouseUp(): void {
  const completion = sessionDragPreviewCoordinator.finishNativeRelease();
  if (completion?.kind !== "outside") return;
  const owner = completion.owner;
  if (owner.isDestroyed() || owner.webContents.isDestroyed()) return;
  const releaseOwnerCleanup = registerNativeSessionDragResultOwnerCleanup(owner);
  const open = (): Promise<{ readonly focusedExisting: boolean }> =>
    openSessionApplicationWindow({
      profileId: completion.profileId,
      sessionId: completion.sessionId
    }, completion.point);
  sessionDragNativeResultFence.start({
    owner,
    gestureId: completion.gestureId,
    firstAttempt: open,
    retry: open,
    onClear: releaseOwnerCleanup
  });
}

function registerNativeSessionDragResultOwnerCleanup(owner: BrowserWindow): () => void {
  const contents = owner.webContents;
  let cleared = false;
  const clear = (): void => { sessionDragNativeResultFence.endOwner(owner); };
  const release = (): void => {
    if (cleared) return;
    cleared = true;
    owner.removeListener("closed", clear);
    contents.removeListener("destroyed", clear);
    contents.removeListener("render-process-gone", clear);
    contents.removeListener("did-start-loading", clear);
  };
  owner.once("closed", clear);
  contents.once("destroyed", clear);
  contents.once("render-process-gone", clear);
  contents.once("did-start-loading", clear);
  return release;
}

async function openSessionApplicationWindow(
  owner: DesktopSessionWindowOwner,
  dropPoint?: DesktopPoint
): Promise<{ readonly focusedExisting: boolean }> {
  if (!isDesktopSessionWindowOwner(owner)) throw new TypeError("Task window owner is invalid.");
  const { sessionId } = owner;
  const ownerKey = sessionWindowOwnerKey(owner);
  const existing = sessionWindows.get(ownerKey);
  if (existing !== undefined && !existing.isDestroyed()) {
    showWindowFromTray(existing);
    return { focusedExisting: true };
  }
  if (existing !== undefined) {
    sessionWindows.delete(ownerKey);
    sessionWindowOwners.delete(ownerKey);
    sessionWindowStates.delete(ownerKey);
    for (const [contents, candidate] of sessionWindowOwnersByContents) {
      if (sessionWindowOwnerKey(candidate) !== ownerKey) continue;
      sessionWindowOwnersByContents.delete(contents);
      clearDesktopNativeTaskStatusVisibility(contents);
    }
  }
  if ([...sessionWindows.values()].filter((candidate) => !candidate.isDestroyed()).length >= MAXIMUM_SESSION_WINDOWS) {
    throw new Error("Task window capacity reached.");
  }
  if (!canShowDesktopWindow({
    quitting,
    channelQuitHandoffPending: desktopUpdateChannelQuitHandoffPending,
    nativeInstallQuitHandoffPending: desktopUpdateNativeInstallQuitHandoffPending,
    completeExitQuitHandoffPending: desktopCompleteExitQuitHandoffPending
  })) throw new Error("Task windows are unavailable while the application is exiting.");

  const frameOptions = process.platform === "darwin"
    ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 16 } }
    : { frame: false };
  const state = windowStateKeeper({
    defaultWidth: SESSION_WINDOW_DEFAULT_GEOMETRY.width,
    defaultHeight: SESSION_WINDOW_DEFAULT_GEOMETRY.height,
    file: sessionWindowStateFile(owner)
  });
  const dropWorkArea = dropPoint === undefined ? undefined : screen.getDisplayNearestPoint(dropPoint).workArea;
  const dropBounds = dropPoint === undefined || dropWorkArea === undefined ? undefined : sessionWindowDropBounds({
    point: dropPoint,
    workArea: dropWorkArea,
    windowSize: { width: state.width, height: state.height }
  });
  const window = new BrowserWindow({
    x: dropBounds?.x ?? state.x,
    y: dropBounds?.y ?? state.y,
    width: dropBounds?.width ?? state.width,
    height: dropBounds?.height ?? state.height,
    minWidth: Math.min(800, dropBounds?.width ?? 800),
    minHeight: Math.min(600, dropBounds?.height ?? 600),
    backgroundColor: "#f2f2f2",
    title: "Joko",
    autoHideMenuBar: true,
    show: false,
    ...activationClickBrowserWindowOptions(),
    ...frameOptions,
    webPreferences: {
      preload: join(sourceDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  const windowContents = window.webContents;
  const attentionSourceId = windowContents.id;
  let containingDroppedWindow = false;
  const containDroppedWindow = (): void => {
    if (dropWorkArea === undefined || dropBounds === undefined || window.isDestroyed() || containingDroppedWindow) return;
    containingDroppedWindow = true;
    try {
      let realizedBounds = window.getBounds();
      const widthOverage = Math.max(0, realizedBounds.width - dropBounds.width);
      const heightOverage = Math.max(0, realizedBounds.height - dropBounds.height);
      if (widthOverage > 0 || heightOverage > 0) {
        const requestedWidth = Math.max(1, dropBounds.width - widthOverage);
        const requestedHeight = Math.max(1, dropBounds.height - heightOverage);
        const [minimumWidth = 1, minimumHeight = 1] = window.getMinimumSize();
        window.setMinimumSize(
          Math.min(minimumWidth, requestedWidth),
          Math.min(minimumHeight, requestedHeight)
        );
        window.setBounds({
          x: realizedBounds.x,
          y: realizedBounds.y,
          width: requestedWidth,
          height: requestedHeight
        }, false);
        realizedBounds = window.getBounds();
      }
      const containedBounds = clampWindowBoundsToWorkArea(realizedBounds, dropWorkArea);
      if (realizedBounds.width !== containedBounds.width || realizedBounds.height !== containedBounds.height) {
        window.setBounds(containedBounds, false);
      } else if (realizedBounds.x !== containedBounds.x || realizedBounds.y !== containedBounds.y) {
        window.setPosition(containedBounds.x, containedBounds.y, false);
      }
    } finally {
      containingDroppedWindow = false;
    }
  };
  containDroppedWindow();
  if (dropWorkArea !== undefined) window.on("resize", containDroppedWindow);
  const retainedOwner = Object.freeze({ ...owner });
  sessionWindows.set(ownerKey, window);
  sessionWindowOwners.set(ownerKey, retainedOwner);
  sessionWindowOwnersByContents.set(windowContents, retainedOwner);
  sessionWindowStates.set(ownerKey, state);
  installDesktopNativeTaskStatusVisibilityLifecycle(window);
  state.manage(window);
  window.webContents.setZoomFactor(currentWindowZoomFactor);
  let sessionUiLoadRecovery: Promise<void> | undefined;
  const beginSessionUiLoadRecovery = (initialFailure?: unknown): void => {
    if (sessionUiLoadRecovery !== undefined || window.isDestroyed() || quitting) return;
    const options = {
      unavailable: () => window.isDestroyed() || quitting,
      load: () => loadUi(window, { kind: "session", id: sessionId }),
      presentFailure: (error: unknown, attempt: number) => packagedSmoke
        ? Promise.resolve(attempt <= 2 ? "retry" as const : "close" as const)
        : presentDesktopWindowLoadFailure("session", error, attempt),
      close: () => {
        if (!window.isDestroyed()) window.destroy();
      }
    };
    const recovery = initialFailure === undefined
      ? loadDesktopWindowWithRecovery(options)
      : recoverDesktopWindowAfterFailure(options, initialFailure);
    const operation = recovery
      .then(() => undefined)
      .catch((error: unknown) => {
        process.stderr.write(`JOKO_DESKTOP_TASK_WINDOW_RECOVERY_FAILED ${safeSmokeError(error)}\n`);
      })
      .finally(() => {
        if (sessionUiLoadRecovery === operation) sessionUiLoadRecovery = undefined;
      });
    sessionUiLoadRecovery = operation;
  };
  window.webContents.on("did-start-loading", () => {
    stopGlobalVoiceShortcutCapture(window.webContents);
    releaseApplicationMenuShortcutRecording(window.webContents.id);
    releaseDesktopAttentionSource(attentionSourceId);
    clearDesktopNativeTaskStatusVisibility(window.webContents);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    stopGlobalVoiceShortcutCapture(window.webContents);
    releaseApplicationMenuShortcutRecording(window.webContents.id);
    releaseDesktopAttentionSource(attentionSourceId);
    clearDesktopNativeTaskStatusVisibility(window.webContents);
    if (!window.isDestroyed() && !quitting) {
      beginSessionUiLoadRecovery(desktopRendererLossError("session", details));
    }
  });
  window.webContents.on("will-prevent-unload", notifyDesktopQuitBlocked);
  installSelectionContextMenu(window, {
    platform: process.platform,
    systemLocale: () => applicationMenuLocale,
    buildMenu: (template) => Menu.buildFromTemplate([...template]),
    openExternal: (url) => shell.openExternal(url)
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void openExternalSafely(url).catch(() => undefined);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedSessionWindowNavigation(url, sessionId, navigationPolicy)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) void openExternalSafely(url).catch(() => undefined);
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedSessionWindowNavigation(url, sessionId, navigationPolicy)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
  });
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    window.show();
    containDroppedWindow();
    if (dropWorkArea !== undefined) {
      setImmediate(() => {
        containDroppedWindow();
        if (!window.isDestroyed()) window.off("resize", containDroppedWindow);
      });
    }
  });
  window.once("closed", () => {
    releaseDesktopAttentionSource(attentionSourceId);
    stopGlobalVoiceShortcutCapture(windowContents);
    releaseApplicationMenuShortcutRecording(attentionSourceId);
    if (sessionWindows.get(ownerKey) === window) {
      sessionWindows.delete(ownerKey);
      sessionWindowOwners.delete(ownerKey);
      sessionWindowStates.delete(ownerKey);
    }
    sessionWindowOwnersByContents.delete(windowContents);
    clearDesktopNativeTaskStatusVisibility(windowContents);
  });
  beginSessionUiLoadRecovery();
  return { focusedExisting: false };
}

async function openExtensionApplicationWindow(
  extensionId: string
): Promise<{ readonly focusedExisting: boolean }> {
  if (!isDesktopExtensionId(extensionId)) throw new TypeError("Extension identity is invalid.");
  const existing = extensionWindows.get(extensionId);
  if (existing !== undefined && !existing.isDestroyed()) {
    showWindowFromTray(existing);
    return { focusedExisting: true };
  }
  if (existing !== undefined) {
    extensionWindows.delete(extensionId);
    for (const [contents, ownerId] of extensionWindowIdsByContents) {
      if (ownerId === extensionId) extensionWindowIdsByContents.delete(contents);
    }
    extensionWindowStates.delete(extensionId);
  }
  if ([...extensionWindows.values()].filter((candidate) => !candidate.isDestroyed()).length >= MAXIMUM_EXTENSION_WINDOWS) {
    throw new Error("Extension window capacity reached.");
  }
  if (!canShowDesktopWindow({
    quitting,
    channelQuitHandoffPending: desktopUpdateChannelQuitHandoffPending,
    nativeInstallQuitHandoffPending: desktopUpdateNativeInstallQuitHandoffPending,
    completeExitQuitHandoffPending: desktopCompleteExitQuitHandoffPending
  })) throw new Error("Extension windows are unavailable while the application is exiting.");

  const frameOptions = process.platform === "darwin"
    ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 16 } }
    : { frame: false };
  const state = windowStateKeeper({
    defaultWidth: EXTENSION_WINDOW_DEFAULT_GEOMETRY.width,
    defaultHeight: EXTENSION_WINDOW_DEFAULT_GEOMETRY.height,
    file: extensionWindowStateFile(extensionId)
  });
  const window = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#f2f2f2",
    title: "Joko",
    autoHideMenuBar: true,
    show: false,
    ...activationClickBrowserWindowOptions(),
    ...frameOptions,
    webPreferences: {
      preload: join(sourceDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  const windowContents = window.webContents;
  const attentionSourceId = windowContents.id;
  extensionWindows.set(extensionId, window);
  extensionWindowIdsByContents.set(windowContents, extensionId);
  extensionWindowStates.set(extensionId, state);
  state.manage(window);
  windowContents.setZoomFactor(currentWindowZoomFactor);

  let extensionUiLoadRecovery: Promise<void> | undefined;
  const beginExtensionUiLoadRecovery = (initialFailure?: unknown): void => {
    if (extensionUiLoadRecovery !== undefined || window.isDestroyed() || quitting) return;
    const options = {
      unavailable: () => window.isDestroyed() || quitting,
      load: () => loadUi(window, { kind: "extension", id: extensionId }),
      presentFailure: (error: unknown, attempt: number) =>
        presentDesktopWindowLoadFailure("extension", error, attempt),
      close: () => {
        if (!window.isDestroyed()) window.destroy();
      }
    };
    const recovery = initialFailure === undefined
      ? loadDesktopWindowWithRecovery(options)
      : recoverDesktopWindowAfterFailure(options, initialFailure);
    const operation = recovery
      .then(() => undefined)
      .catch((error: unknown) => {
        process.stderr.write(`JOKO_DESKTOP_EXTENSION_WINDOW_RECOVERY_FAILED ${safeSmokeError(error)}\n`);
      })
      .finally(() => {
        if (extensionUiLoadRecovery === operation) extensionUiLoadRecovery = undefined;
      });
    extensionUiLoadRecovery = operation;
  };
  windowContents.on("did-start-loading", () => {
    stopGlobalVoiceShortcutCapture(windowContents);
    releaseApplicationMenuShortcutRecording(windowContents.id);
    releaseDesktopAttentionSource(attentionSourceId);
    clearDesktopNativeTaskStatusVisibility(windowContents);
  });
  windowContents.on("render-process-gone", (_event, details) => {
    stopGlobalVoiceShortcutCapture(windowContents);
    releaseApplicationMenuShortcutRecording(windowContents.id);
    releaseDesktopAttentionSource(attentionSourceId);
    clearDesktopNativeTaskStatusVisibility(windowContents);
    if (!window.isDestroyed() && !quitting) {
      beginExtensionUiLoadRecovery(desktopRendererLossError("extension", details));
    }
  });
  windowContents.on("will-prevent-unload", notifyDesktopQuitBlocked);
  windowContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void openExternalSafely(url).catch(() => undefined);
    return { action: "deny" };
  });
  windowContents.on("will-navigate", (event, url) => {
    if (!isAllowedExtensionWindowNavigation(url, extensionId, navigationPolicy)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) void openExternalSafely(url).catch(() => undefined);
    }
  });
  windowContents.on("will-redirect", (event, url) => {
    if (!isAllowedExtensionWindowNavigation(url, extensionId, navigationPolicy)) event.preventDefault();
  });
  windowContents.on("will-attach-webview", (event) => event.preventDefault());
  windowContents.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
  });
  windowContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  window.once("closed", () => {
    releaseDesktopAttentionSource(attentionSourceId);
    stopGlobalVoiceShortcutCapture(windowContents);
    releaseApplicationMenuShortcutRecording(attentionSourceId);
    if (extensionWindows.get(extensionId) === window) extensionWindows.delete(extensionId);
    extensionWindowIdsByContents.delete(windowContents);
    extensionWindowStates.delete(extensionId);
    clearDesktopNativeTaskStatusVisibility(windowContents);
  });
  beginExtensionUiLoadRecovery();
  return { focusedExisting: false };
}

async function loadRuntimeProcessMonitorUi(window: BrowserWindow): Promise<void> {
  if (navigationPolicy.developmentUrl !== undefined) {
    await window.loadURL(runtimeProcessMonitorEntryUrl(navigationPolicy.developmentUrl));
    return;
  }
  await verifyPackagedWebBundle(packagedEntryPath);
  await window.loadURL(runtimeProcessMonitorEntryUrl(DESKTOP_APP_ENTRY_URL));
}

function openRuntimeProcessMonitorWindow(
  owner: BrowserWindow,
  monitorOwner: DesktopRuntimeProcessMonitorOwner
): Promise<{ readonly version: 1; readonly focusedExisting: boolean }> {
  const operation = runtimeProcessMonitorOpenTail.then(() => openRuntimeProcessMonitorWindowNow(owner, monitorOwner));
  runtimeProcessMonitorOpenTail = operation.then(() => undefined, () => undefined);
  return operation;
}

async function openRuntimeProcessMonitorWindowNow(
  owner: BrowserWindow,
  monitorOwner: DesktopRuntimeProcessMonitorOwner
): Promise<{ readonly version: 1; readonly focusedExisting: boolean }> {
  const existing = runtimeProcessMonitorWindow;
  if (existing !== undefined) {
    if (!existing.isDestroyed() && runtimeProcessMonitorBroker.matchesOwner(owner.webContents, monitorOwner)) {
      showWindowFromTray(existing);
      return { version: 1, focusedExisting: true };
    }
    await destroyRuntimeProcessMonitorWindowAndWait(existing, false);
  }
  if (owner.isDestroyed() || owner.webContents.isDestroyed()) {
    throw new Error("Runtime process monitor owner retired during replacement.");
  }
  if (!canShowDesktopWindow({
    quitting,
    channelQuitHandoffPending: desktopUpdateChannelQuitHandoffPending,
    nativeInstallQuitHandoffPending: desktopUpdateNativeInstallQuitHandoffPending,
    completeExitQuitHandoffPending: desktopCompleteExitQuitHandoffPending
  })) throw new Error("Runtime process monitor is unavailable while the application is exiting.");

  const frameOptions = process.platform === "darwin"
    ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 16 } }
    : { frame: false };
  const state = windowStateKeeper({
    defaultWidth: RUNTIME_PROCESS_MONITOR_WINDOW_DEFAULT_GEOMETRY.width,
    defaultHeight: RUNTIME_PROCESS_MONITOR_WINDOW_DEFAULT_GEOMETRY.height,
    file: RUNTIME_PROCESS_MONITOR_WINDOW_STATE_FILE
  });
  const window = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 380,
    minHeight: 320,
    backgroundColor: "#f2f2f2",
    title: runtimeProcessMonitorWindowTitle(),
    autoHideMenuBar: true,
    show: false,
    ...activationClickBrowserWindowOptions(),
    ...frameOptions,
    webPreferences: {
      preload: join(sourceDirectory, "runtime-process-monitor-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false
    }
  });
  const monitorContents = window.webContents;
  runtimeProcessMonitorWindow = window;
  runtimeProcessMonitorOwnerWindow = owner;
  runtimeProcessMonitorFocusOwnerOnClose = true;
  runtimeProcessMonitorBroker.bind({
    owner: monitorOwner,
    ownerEndpoint: owner.webContents,
    monitorEndpoint: window.webContents
  });
  const releaseOwnerLifecycle = installRuntimeProcessMonitorOwnerLifecycle(owner, window);
  releaseRuntimeProcessMonitorOwnerLifecycle = releaseOwnerLifecycle;
  managedRuntimeProcessMonitorWindowState = state;
  state.manage(window);
  window.webContents.setZoomFactor(currentWindowZoomFactor);
  let runtimeUiLoadRecovery: Promise<"loaded" | "closed"> | undefined;
  const beginRuntimeUiLoadRecovery = (initialFailure?: unknown): Promise<"loaded" | "closed"> => {
    if (runtimeUiLoadRecovery !== undefined) return runtimeUiLoadRecovery;
    if (window.isDestroyed() || quitting) return Promise.resolve("closed");
    const options = {
      unavailable: () => window.isDestroyed() || quitting,
      load: () => loadRuntimeProcessMonitorUi(window),
      presentFailure: (error: unknown, attempt: number) => packagedSmoke
        ? Promise.resolve(attempt <= 2 ? "retry" as const : "close" as const)
        : presentDesktopWindowLoadFailure("runtime", error, attempt, owner),
      close: () => {
        if (!window.isDestroyed()) window.destroy();
      }
    };
    const recovery = initialFailure === undefined
      ? loadDesktopWindowWithRecovery(options)
      : recoverDesktopWindowAfterFailure(options, initialFailure);
    const operation = recovery.finally(() => {
      if (runtimeUiLoadRecovery === operation) runtimeUiLoadRecovery = undefined;
    });
    runtimeUiLoadRecovery = operation;
    return operation;
  };
  window.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    if (!window.isDestroyed()) window.setTitle(runtimeProcessMonitorWindowTitle());
  });
  window.webContents.on("will-prevent-unload", notifyDesktopQuitBlocked);
  window.webContents.on("render-process-gone", (_event, details) => {
    if (!shouldRecoverRuntimeProcessMonitorRenderer(
      runtimeProcessMonitorWindow,
      window,
      window.isDestroyed(),
      quitting
    )) return;
    runtimeProcessMonitorBroker.clearMonitorDocument(window.webContents);
    void beginRuntimeUiLoadRecovery(desktopRendererLossError("runtime", details)).catch((error: unknown) => {
      process.stderr.write(`JOKO_DESKTOP_RUNTIME_WINDOW_RECOVERY_FAILED ${safeSmokeError(error)}\n`);
    });
  });
  installSelectionContextMenu(window, {
    platform: process.platform,
    systemLocale: () => applicationMenuLocale,
    buildMenu: (template) => Menu.buildFromTemplate([...template]),
    openExternal: (url) => shell.openExternal(url)
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void openExternalSafely(url).catch(() => undefined);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isRuntimeProcessMonitorNavigation(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void openExternalSafely(url).catch(() => undefined);
  });
  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) runtimeProcessMonitorBroker.clearMonitorDocument(window.webContents);
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isRuntimeProcessMonitorNavigation(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
  });
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  window.once("ready-to-show", () => {
    if (runtimeProcessMonitorWindow === window && !window.isDestroyed()) {
      window.show();
      window.focus();
    }
  });
  window.once("closed", () => {
    const wasCurrent = runtimeProcessMonitorWindow === window;
    const focusOwner = runtimeProcessMonitorFocusOwnerOnClose;
    const previousOwner = runtimeProcessMonitorOwnerWindow;
    releaseOwnerLifecycle();
    // BrowserWindow is no longer usable after `closed`; keep the endpoint
    // identity captured at construction so this listener cannot abort later
    // retirement observers by re-entering the destroyed native wrapper.
    runtimeProcessMonitorBroker.retireEndpoint(monitorContents);
    if (wasCurrent) {
      runtimeProcessMonitorFocusOwnerOnClose = false;
      runtimeProcessMonitorOwnerWindow = undefined;
      runtimeProcessMonitorWindow = undefined;
      if (releaseRuntimeProcessMonitorOwnerLifecycle === releaseOwnerLifecycle) {
        releaseRuntimeProcessMonitorOwnerLifecycle = undefined;
      }
    }
    if (managedRuntimeProcessMonitorWindowState === state) managedRuntimeProcessMonitorWindowState = undefined;
    if (wasCurrent && focusOwner && previousOwner !== undefined && !previousOwner.isDestroyed() && previousOwner.isVisible() &&
      !previousOwner.isMinimized() && !quitting) previousOwner.focus();
  });
  try {
    const result = await beginRuntimeUiLoadRecovery();
    if (result === "closed") throw new Error("Runtime resource usage was closed before it loaded.");
  } catch (error: unknown) {
    if (runtimeProcessMonitorWindow === window) destroyRuntimeProcessMonitorWindow(false);
    else if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  return { version: 1, focusedExisting: false };
}

function installRuntimeProcessMonitorOwnerLifecycle(owner: BrowserWindow, monitor: BrowserWindow): () => void {
  const contents = owner.webContents;
  let released = false;
  const retire = (): void => {
    if (runtimeProcessMonitorOwnerWindow !== owner || runtimeProcessMonitorWindow !== monitor) return;
    destroyRuntimeProcessMonitorWindow(false);
  };
  const navigate = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame && !isInPlace) retire();
  };
  const hide = (): void => {
    if (runtimeProcessMonitorOwnerWindow === owner && runtimeProcessMonitorWindow === monitor && !monitor.isDestroyed()) monitor.hide();
  };
  const restore = (): void => {
    if (runtimeProcessMonitorOwnerWindow === owner && runtimeProcessMonitorWindow === monitor && !monitor.isDestroyed() &&
      owner.isVisible() && !owner.isMinimized()) monitor.showInactive();
  };
  owner.once("closed", retire);
  owner.on("hide", hide);
  owner.on("minimize", hide);
  owner.on("show", restore);
  owner.on("restore", restore);
  contents.on("did-start-navigation", navigate);
  contents.once("render-process-gone", retire);
  contents.once("destroyed", retire);
  return () => {
    if (released) return;
    released = true;
    owner.removeListener("closed", retire);
    owner.removeListener("hide", hide);
    owner.removeListener("minimize", hide);
    owner.removeListener("show", restore);
    owner.removeListener("restore", restore);
    contents.removeListener("did-start-navigation", navigate);
    contents.removeListener("render-process-gone", retire);
    contents.removeListener("destroyed", retire);
  };
}

function runtimeProcessMonitorWindowTitle(): string {
  return desktopRuntimeResourceWindowTitle(applicationMenuLocale);
}

function isRuntimeProcessMonitorNavigation(value: string): boolean {
  return isAllowedRuntimeProcessMonitorNavigation(value, navigationPolicy);
}

function destroyRuntimeProcessMonitorWindow(focusOwner = false): void {
  finishRuntimeProcessMonitorWindowRetirement(beginRuntimeProcessMonitorWindowRetirement(focusOwner));
}

interface RetiredRuntimeProcessMonitorWindow {
  readonly window: BrowserWindow | undefined;
  readonly focusOwner: BrowserWindow | undefined;
  readonly rendererRetirement: RuntimeProcessMonitorRendererRetirement | undefined;
}

interface RuntimeProcessMonitorRendererRetirement {
  readonly contents: WebContents;
  readonly message: { readonly version: 1; readonly retirementOccurrence: string };
  readonly acknowledged: Promise<boolean>;
  readonly cancel: () => void;
}

function beginRuntimeProcessMonitorWindowRetirement(
  focusOwner = false,
  waitForRendererAcknowledgement = false
): RetiredRuntimeProcessMonitorWindow {
  const window = runtimeProcessMonitorWindow;
  const previousOwner = runtimeProcessMonitorOwnerWindow;
  runtimeProcessMonitorFocusOwnerOnClose = false;
  runtimeProcessMonitorWindow = undefined;
  runtimeProcessMonitorOwnerWindow = undefined;
  managedRuntimeProcessMonitorWindowState = undefined;
  const releaseOwnerLifecycle = releaseRuntimeProcessMonitorOwnerLifecycle;
  releaseRuntimeProcessMonitorOwnerLifecycle = undefined;
  releaseOwnerLifecycle?.();
  const retired = runtimeProcessMonitorBroker.retire();
  const retirementMessage = Object.freeze({ version: 1 as const, retirementOccurrence: randomUUID() });
  const rendererRetirement = waitForRendererAcknowledgement && window !== undefined && !window.isDestroyed() &&
    retired !== undefined && !window.webContents.isDestroyed()
    ? beginRuntimeProcessMonitorRendererRetirement(window.webContents, retirementMessage)
    : undefined;
  if (window !== undefined && !window.isDestroyed()) {
    if (retired !== undefined && !window.webContents.isDestroyed()) {
      try {
        window.webContents.send(DESKTOP_CHANNELS.runtimeProcessDiagnosticsRetired, retirementMessage);
      } catch {
        rendererRetirement?.cancel();
      }
    }
  }
  return Object.freeze({
    window,
    focusOwner: focusOwner ? previousOwner : undefined,
    rendererRetirement
  });
}

function finishRuntimeProcessMonitorWindowRetirement(retirement: RetiredRuntimeProcessMonitorWindow): void {
  destroyRetiredRuntimeProcessMonitorWindow(retirement);
  focusRetiredRuntimeProcessMonitorOwner(retirement);
}

function destroyRetiredRuntimeProcessMonitorWindow(retirement: RetiredRuntimeProcessMonitorWindow): void {
  const window = retirement.window;
  if (window !== undefined && !window.isDestroyed()) {
    // This remains an independent native top-level window. Its opener binding,
    // visibility and lifetime are enforced by the exact owner lifecycle above;
    // using an Electron native parent can deadlock Windows teardown during an
    // owner replacement or renderer recovery.
    window.destroy();
  }
}

function focusRetiredRuntimeProcessMonitorOwner(retirement: RetiredRuntimeProcessMonitorWindow): void {
  const focusOwner = retirement.focusOwner;
  if (focusOwner !== undefined && !focusOwner.isDestroyed() && focusOwner.isVisible() &&
    !focusOwner.isMinimized() && !quitting) {
    focusOwner.focus();
  }
}

async function destroyRuntimeProcessMonitorWindowAndWait(
  expectedWindow: BrowserWindow,
  focusOwner = false
): Promise<void> {
  const expectedContents = expectedWindow.webContents;
  const nativeRetirement = beginRuntimeProcessMonitorWindowRetirementObservation(
    expectedWindow,
    expectedContents
  );
  let retirement: RetiredRuntimeProcessMonitorWindow | undefined;
  let ipcDrainCount = 0;
  await retireRuntimeProcessMonitorForReplacement({
    retireAuthority: () => {
      if (runtimeProcessMonitorWindow === expectedWindow) {
        retirement = beginRuntimeProcessMonitorWindowRetirement(focusOwner, true);
      }
    },
    waitForRendererRetirement: async () => {
      if (retirement !== undefined) await waitForRuntimeProcessMonitorRendererRetirement(retirement);
    },
    drainRetiredIpc: async () => {
      ipcDrainCount += 1;
      await waitForRuntimeProcessMonitorIpcTurn();
      recordPackagedSmokeProgress(`runtime_process_monitor_retirement_ipc_drain_${ipcDrainCount}`);
    },
    destroyNativeWindow: () => {
      // BrowserWindow.destroy() synchronously owns teardown of its exact
      // WebContents. Calling WebContents.close() first and then destroying the
      // host window freezes Electron's Windows message pump between the two
      // retirement postconditions.
      if (retirement !== undefined) destroyRetiredRuntimeProcessMonitorWindow(retirement);
      else if (!expectedWindow.isDestroyed()) expectedWindow.destroy();
      recordPackagedSmokeProgress("runtime_process_monitor_native_destroy_requested");
    },
    waitForNativeRetirement: async () => {
      recordPackagedSmokeProgress("runtime_process_monitor_native_retirement_wait_started");
      await nativeRetirement.wait();
      recordPackagedSmokeProgress("runtime_process_monitor_native_retirement_observed");
    }
  });
  if (retirement !== undefined) focusRetiredRuntimeProcessMonitorOwner(retirement);
}

function waitForRuntimeProcessMonitorIpcTurn(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

function beginRuntimeProcessMonitorRendererRetirement(
  contents: WebContents,
  message: { readonly version: 1; readonly retirementOccurrence: string }
): RuntimeProcessMonitorRendererRetirement {
  const pending = runtimeProcessMonitorRetirementAcknowledgements.begin(contents, message.retirementOccurrence);
  return Object.freeze({
    contents,
    message,
    acknowledged: pending.acknowledged,
    cancel: pending.cancel
  });
}

async function waitForRuntimeProcessMonitorRendererRetirement(
  retirement: RetiredRuntimeProcessMonitorWindow
): Promise<void> {
  const rendererRetirement = retirement.rendererRetirement;
  if (rendererRetirement === undefined) return;
  const acknowledged = await new Promise<boolean>((resolvePromise) => {
    const timeout = setTimeout(() => resolvePromise(false), 1_000);
    void rendererRetirement.acknowledged.then((value) => {
      clearTimeout(timeout);
      resolvePromise(value);
    });
  });
  rendererRetirement.cancel();
  if (acknowledged) {
    recordPackagedSmokeProgress("runtime_process_monitor_renderer_retirement_acknowledged");
    return;
  }
  if (rendererRetirement.contents.isDestroyed()) {
    recordPackagedSmokeProgress("runtime_process_monitor_renderer_retirement_already_destroyed");
    return;
  }
  recordPackagedSmokeProgress("runtime_process_monitor_renderer_retirement_ack_timeout");
}

function beginRuntimeProcessMonitorWindowRetirementObservation(
  window: BrowserWindow,
  contents: WebContents
): { readonly wait: () => Promise<void> } {
  let windowRetired = window.isDestroyed();
  let contentsRetired = contents.isDestroyed();
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  let resolveRetirement!: () => void;
  let rejectRetirement!: (error: Error) => void;
  const retirement = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveRetirement = resolvePromise;
    rejectRetirement = rejectPromise;
  });
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    window.removeListener("closed", closed);
    contents.removeListener("destroyed", destroyed);
    if (error === undefined) resolveRetirement(); else rejectRetirement(error);
  };
  const check = (): void => {
    if (windowRetired && contentsRetired) finish();
  };
  const closed = (): void => {
    windowRetired = true;
    recordPackagedSmokeProgress("runtime_process_monitor_native_window_closed_event");
    check();
  };
  const destroyed = (): void => {
    contentsRetired = true;
    recordPackagedSmokeProgress("runtime_process_monitor_web_contents_destroyed_event");
    check();
  };
  if (!windowRetired) window.once("closed", closed);
  if (!contentsRetired) contents.once("destroyed", destroyed);
  check();
  return Object.freeze({
    wait: () => {
      if (!settled && timeout === undefined) {
        timeout = setTimeout(() => finish(new Error(
          `Runtime process monitor did not finish retiring (windowDestroyed=${windowRetired}, contentsDestroyed=${contentsRetired}).`
        )), 5_000);
      }
      return retirement;
    }
  });
}

function hideRuntimeProcessMonitorWindow(window: BrowserWindow, focusOwner: boolean): void {
  if (runtimeProcessMonitorWindow !== window || window.isDestroyed()) return;
  const owner = runtimeProcessMonitorOwnerWindow;
  const shouldFocusOwner = focusOwner && owner !== undefined && !owner.isDestroyed() && owner.isVisible() &&
    !owner.isMinimized() && !quitting;
  window.hide();
  if (shouldFocusOwner && owner !== undefined) owner.focus();
}

function applicationWindows(): readonly BrowserWindow[] {
  return [
    ...(mainWindow === undefined || mainWindow.isDestroyed() ? [] : [mainWindow]),
    ...(runtimeProcessMonitorWindow === undefined || runtimeProcessMonitorWindow.isDestroyed()
      ? []
      : [runtimeProcessMonitorWindow]),
    ...[...sessionWindows.values()].filter((window) => !window.isDestroyed()),
    ...[...extensionWindows.values()].filter((window) => !window.isDestroyed())
  ];
}

function visibleSessionDragTargetBounds(): readonly DesktopRectangle[] {
  const windows = [
    ...applicationWindows(),
    ...(inspectorWindow === undefined || inspectorWindow.isDestroyed() ? [] : [inspectorWindow])
  ];
  return windows
    .filter((window) => window.isVisible() && !window.isMinimized())
    .map((window) => window.getBounds());
}

function initializeDesktopAttentionBadge(): void {
  if (!desktopAttentionBadgeSupported || desktopAttentionBadgeController !== undefined) return;
  desktopAttentionBadgeController = new DesktopAttentionBadgeController(createDesktopAttentionPresentation());
  desktopAttentionBadgeController.setForeground(isDesktopApplicationForeground());
}

function requireDesktopAttentionBadgeController(): DesktopAttentionBadgeController {
  if (!desktopAttentionBadgeSupported || desktopAttentionBadgeController === undefined) {
    throw new Error("Desktop attention badges are not supported on this system.");
  }
  return desktopAttentionBadgeController;
}

function releaseDesktopAttentionSource(sourceId: number): void {
  desktopAttentionBadgeController?.releaseSource(sourceId);
}

function isDesktopApplicationForeground(): boolean {
  return BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused());
}

function isProviderModelApplicationForeground(): boolean {
  return [
    mainWindow,
    inspectorWindow,
    runtimeProcessMonitorWindow,
    ...sessionWindows.values(),
    ...extensionWindows.values()
  ].some((window) => window !== undefined && !window.isDestroyed() && window.isFocused());
}

function createDesktopAttentionPresentation(): DesktopAttentionPresentation {
  let windowsOverlay: NativeImage | undefined;
  const overlay = (): NativeImage => {
    windowsOverlay ??= nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(WINDOWS_ATTENTION_OVERLAY_SVG, "utf8").toString("base64")}`
    );
    return windowsOverlay;
  };
  return {
    clear: () => {
      if (process.platform === "darwin") {
        try {
          app.setBadgeCount(0);
        } finally {
          app.dock?.setBadge("");
        }
        return;
      }
      if (process.platform === "linux") {
        if (!app.setBadgeCount(0)) throw new Error("Desktop attention badge could not be cleared.");
        return;
      }
      if (process.platform !== "win32") return;
      let failed = false;
      for (const window of applicationWindows()) {
        try {
          window.setOverlayIcon(null, "");
          window.flashFrame(false);
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error("Desktop attention presentation could not be cleared.");
    },
    show: (count, signal) => {
      if (process.platform === "darwin") {
        try {
          app.setBadgeCount(count);
        } finally {
          app.dock?.setBadge(String(count));
        }
        return;
      }
      if (process.platform === "linux") {
        if (!app.setBadgeCount(count)) throw new Error("Desktop attention badge could not be shown.");
        return;
      }
      if (process.platform !== "win32") return;
      const icon = overlay();
      if (icon.isEmpty()) throw new Error("Desktop attention overlay could not be created.");
      const description = count === 1 ? "1 task needs attention" : `${count} tasks need attention`;
      let failed = false;
      for (const window of applicationWindows()) {
        try {
          window.setOverlayIcon(icon, description);
          if (signal && !window.isFocused()) window.flashFrame(true);
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error("Desktop attention presentation could not be shown.");
    }
  };
}

async function resetDesktopApplicationLayout(initiatingContents: WebContents): Promise<void> {
  const targets: ManagedWindowGeometry[] = [];
  if (managedMainWindowState !== undefined) {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      targets.push({ window: mainWindow, state: managedMainWindowState, defaults: MAIN_WINDOW_DEFAULT_GEOMETRY });
    } else {
      resetDormantManagedWindowState(managedMainWindowState);
    }
  }
  for (const [ownerKey, window] of sessionWindows) {
    const state = sessionWindowStates.get(ownerKey);
    if (state === undefined) continue;
    if (window.isDestroyed()) resetDormantManagedWindowState(state);
    else targets.push({ window, state, defaults: SESSION_WINDOW_DEFAULT_GEOMETRY });
  }
  for (const [extensionId, window] of extensionWindows) {
    const state = extensionWindowStates.get(extensionId);
    if (state === undefined) continue;
    if (window.isDestroyed()) resetDormantManagedWindowState(state);
    else targets.push({ window, state, defaults: EXTENSION_WINDOW_DEFAULT_GEOMETRY });
  }
  if (managedInspectorWindowState !== undefined) {
    if (inspectorWindow !== undefined && !inspectorWindow.isDestroyed()) {
      targets.push({ window: inspectorWindow, state: managedInspectorWindowState, defaults: INSPECTOR_WINDOW_DEFAULT_GEOMETRY });
    } else {
      resetDormantManagedWindowState(managedInspectorWindowState);
    }
  }
  if (managedRuntimeProcessMonitorWindowState !== undefined) {
    if (runtimeProcessMonitorWindow !== undefined && !runtimeProcessMonitorWindow.isDestroyed()) {
      targets.push({
        window: runtimeProcessMonitorWindow,
        state: managedRuntimeProcessMonitorWindowState,
        defaults: RUNTIME_PROCESS_MONITOR_WINDOW_DEFAULT_GEOMETRY
      });
    } else {
      resetDormantManagedWindowState(managedRuntimeProcessMonitorWindowState);
    }
  }
  await resetManagedWindowGeometry(targets);

  const openSessionStateFiles = new Set([...sessionWindows]
    .filter(([, window]) => !window.isDestroyed())
    .flatMap(([ownerKey]) => {
      const owner = sessionWindowOwners.get(ownerKey);
      return owner === undefined ? [] : [sessionWindowStateFile(owner)];
    }));
  const openExtensionStateFiles = new Set([...extensionWindows]
    .filter(([, window]) => !window.isDestroyed())
    .map(([extensionId]) => extensionWindowStateFile(extensionId)));
  const entries = await readdir(app.getPath("userData"), { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.flatMap((entry) => entry.isFile() && entry.name.startsWith(SESSION_WINDOW_STATE_PREFIX) &&
    entry.name.endsWith(".json") && !openSessionStateFiles.has(entry.name)
    ? [unlink(join(app.getPath("userData"), entry.name)).catch(() => undefined)]
    : entry.isFile() && entry.name.startsWith(EXTENSION_WINDOW_STATE_PREFIX) &&
      entry.name.endsWith(".json") && !openExtensionStateFiles.has(entry.name)
    ? [unlink(join(app.getPath("userData"), entry.name)).catch(() => undefined)]
    : []));
  if (inspectorWindow === undefined || inspectorWindow.isDestroyed()) {
    await unlink(join(app.getPath("userData"), "inspector-window-state.json")).catch(() => undefined);
  }
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    await unlink(join(app.getPath("userData"), MAIN_WINDOW_STATE_FILE)).catch(() => undefined);
  }
  if (runtimeProcessMonitorWindow === undefined || runtimeProcessMonitorWindow.isDestroyed()) {
    await unlink(join(app.getPath("userData"), RUNTIME_PROCESS_MONITOR_WINDOW_STATE_FILE)).catch(() => undefined);
  }

  broadcastWindowLayoutReset([
    ...(mainWindow === undefined ? [] : [mainWindow]),
    ...(runtimeProcessMonitorWindow === undefined ? [] : [runtimeProcessMonitorWindow]),
    ...sessionWindows.values(),
    ...extensionWindows.values(),
    ...(inspectorWindow === undefined ? [] : [inspectorWindow])
  ], initiatingContents);
}

function sessionWindowStateFile(owner: DesktopSessionWindowOwner): string {
  return `${SESSION_WINDOW_STATE_PREFIX}${createHash("sha256").update(sessionWindowOwnerKey(owner)).digest("hex").slice(0, 24)}.json`;
}

function extensionWindowStateFile(extensionId: string): string {
  return `${EXTENSION_WINDOW_STATE_PREFIX}${createHash("sha256").update(extensionId).digest("hex").slice(0, 24)}.json`;
}

function destroySessionWindows(): void {
  const windows = [...sessionWindows.values()];
  sessionWindows.clear();
  sessionWindowOwners.clear();
  sessionWindowOwnersByContents.clear();
  sessionWindowStates.clear();
  for (const window of windows) {
    if (!window.isDestroyed()) window.destroy();
  }
}

function registerPackagedAppProtocol(): void {
  if (navigationPolicy.developmentUrl !== undefined || protocol.isProtocolHandled(DESKTOP_APP_SCHEME)) return;
  protocol.handle(DESKTOP_APP_SCHEME, (request) => {
    if (packagedSmoke && packagedSmokeFailNextMainDocumentRequest
      && request.method === "POST"
      && request.headers.get(PACKAGED_SMOKE_FAILED_DOCUMENT_HEADER) === "1"
      && isAllowedPrimaryWindowNavigation(request.url, navigationPolicy)) {
      packagedSmokeFailNextMainDocumentRequest = false;
      recordPackagedSmokeProgress("system_handoff_failed_document_request_injected");
      const resolveRequest = resolvePackagedSmokeFailedMainDocumentRequest;
      resolvePackagedSmokeFailedMainDocumentRequest = undefined;
      resolveRequest?.();
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store" }
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed.", {
        status: 405,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
      });
    }
    const resourcePath = resolvePackagedAppResource(request.url, navigationPolicy);
    if (resourcePath === undefined) {
      return new Response("Not found.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
      });
    }
    return net.fetch(pathToFileURL(resourcePath).href, { bypassCustomProtocolHandlers: true });
  });
}

function registerDesktopDeepLinkProtocolClient(): void {
  if (packagedSmokeRequested) return;
  try {
    if (process.defaultApp && process.argv[1] !== undefined) {
      app.setAsDefaultProtocolClient(DESKTOP_DEEP_LINK_SCHEME, process.execPath, [resolve(process.argv[1])]);
      return;
    }
    app.setAsDefaultProtocolClient(DESKTOP_DEEP_LINK_SCHEME);
  } catch {
    // Packaged protocol metadata remains authoritative. A host that refuses
    // runtime registration must not prevent the application from starting.
  }
}

function captureMainWindowDocument(contents: WebContents, claim: string): string | undefined {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed() || window.webContents !== contents || contents.isDestroyed()) {
    return undefined;
  }
  const capture = mainWindowDocuments.capture(contents, claim);
  if (capture.created) {
    if (capture.retired !== undefined) {
      desktopNotifications.retireOwner(capture.retired.endpoint, capture.retired.occurrence);
      releaseDesktopAttentionSource(capture.retired.endpoint.id);
    }
    desktopDeepLinkDelivery.resetRenderer();
  }
  if (dedicatedHardwareCatalogOwner?.contents !== contents ||
      dedicatedHardwareCatalogOwner.documentOccurrence !== capture.current.occurrence) {
    if (dedicatedHardwareCatalogOwner !== undefined) {
      dedicatedHardwareController?.retireOwner(dedicatedHardwareCatalogOwner);
    }
    dedicatedHardwareCatalogOwner = Object.freeze({ contents, documentOccurrence: capture.current.occurrence });
    dedicatedHardwarePrimaryVisible = false;
  }
  refreshDedicatedHardwarePrimaryVisibility(window);
  return capture.current.occurrence;
}

function retireMainWindowDocument(window: BrowserWindow, contents: WebContents): void {
  // The captured endpoint remains exact after BrowserWindow.closed, when
  // Electron's webContents getter itself throws Object has been destroyed.
  if (mainWindow !== window || mainWindowContentsByWindow.get(window) !== contents) return;
  const retired = mainWindowDocuments.retire(contents);
  if (retired !== undefined) {
    desktopNotifications.retireOwner(retired.endpoint, retired.occurrence);
    retireDedicatedHardwareCatalogOwner(retired.endpoint, retired.occurrence);
  }
  desktopDeepLinkDelivery.resetRenderer();
}

function handleDesktopDeepLinkUrl(value: unknown): boolean {
  const intent = parseDesktopDeepLink(value);
  if (intent === undefined) return false;
  handleDesktopInboundOpenIntent(intent);
  return true;
}

function handleDesktopInboundOpenIntent(
  intent: DesktopInboundOpenIntent,
  source?: DesktopOpenIntentIngressSource
): void {
  if (app.isReady()) showMainWindow();
  const packagedSmokeSecondInstance = source === undefined
    ? false
    : observePackagedSmokeDesktopOpenIntent(intent, source);
  const claim = desktopInboundOpenIntentFence.begin(intent);
  if (claim === undefined) return;
  desktopDeepLinkDelivery.retirePendingForNewNavigation();
  void materializeDesktopDeepLinkNavigation(claim.intent, readRegularFileSnapshot).then((navigation) => {
    if (!desktopInboundOpenIntentFence.isCurrent(claim)) return;
    deliverDesktopDeepLinkNavigation(navigation, packagedSmokeSecondInstance
      ? bindPackagedSmokeSecondInstanceDelivery
      : undefined);
  });
}

function deliverDesktopDeepLinkNavigation(
  navigation: DesktopDeepLinkNavigation,
  observeOffer?: (offer: DesktopDeepLinkOffer) => void
): void {
  const offer = desktopDeepLinkDelivery.offerWithOccurrence(navigation);
  observeOffer?.(offer);
  const claim = offer.delivery;
  if (packagedSmokeSecondInstanceAwaitingAcknowledgement) {
    recordPackagedSmokeProgress(claim === undefined
      ? "system_handoff_second_instance_delivery_not_ready"
      : "system_handoff_second_instance_delivery_ready");
  }
  if (claim === undefined) return;
  if (sendDesktopDeepLinkNavigation(claim)) {
    if (packagedSmokeSecondInstanceAwaitingAcknowledgement) {
      recordPackagedSmokeProgress("system_handoff_second_instance_delivery_sent");
    }
    return;
  }
  if (packagedSmokeSecondInstanceAwaitingAcknowledgement) {
    recordPackagedSmokeProgress("system_handoff_second_instance_delivery_send_failed");
  }
}

function bindPackagedSmokeSecondInstanceDelivery(offer: DesktopDeepLinkOffer): void {
  if (!packagedSmokeSecondInstanceAwaitingAcknowledgement) return;
  packagedSmokeSecondInstanceDelivery = Object.freeze({
    deliveryOccurrence: offer.deliveryOccurrence,
    ...(offer.delivery === undefined ? {} : { documentOccurrence: offer.delivery.documentOccurrence })
  });
}

function sendDesktopDeepLinkNavigation(claim: DesktopDeepLinkDelivery): boolean {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed()) {
    return false;
  }
  if (!mainWindowDocuments.isCurrent(window.webContents, claim.documentOccurrence)) return false;
  try {
    window.webContents.send(DESKTOP_CHANNELS.deepLinkNavigate, claim);
    return true;
  } catch {
    return false;
  }
}

function showMainWindow(): boolean {
  if (!canShowDesktopWindow({
    quitting,
    channelQuitHandoffPending: desktopUpdateChannelQuitHandoffPending,
    nativeInstallQuitHandoffPending: desktopUpdateNativeInstallQuitHandoffPending,
    completeExitQuitHandoffPending: desktopCompleteExitQuitHandoffPending
  })) return false;
  mainWindowCloseController?.cancelPending();
  if (mainWindow === undefined || mainWindow.isDestroyed()) createWindow();
  if (mainWindow === undefined || mainWindow.isDestroyed()) return false;
  showWindowFromTray(mainWindow);
  promoteExternalWindowActivation(process.platform, app, mainWindow);
  return true;
}

function showCurrentMainWindowOwner(owner: WebContents): boolean {
  if (owner !== mainWindow?.webContents || owner.isDestroyed()) return false;
  return showMainWindow() && owner === mainWindow?.webContents && !owner.isDestroyed();
}

function installInspectorWindowSecurity(childWindow: BrowserWindow, owner: BrowserWindow): void {
  const occurrence = randomUUID();
  inspectorWindow = childWindow;
  inspectorWindowOwner = owner.webContents;
  inspectorWindowOccurrence = occurrence;
  const lifecycle = new InspectorWindowLifecycle({
    owner,
    child: childWindow,
    isCurrent: (candidateOwner, candidateChild) =>
      mainWindow === candidateOwner &&
      inspectorWindowOwner === candidateOwner.webContents &&
      inspectorWindow === candidateChild &&
      inspectorWindowOccurrence === occurrence,
    retire: (_candidateOwner, candidateChild) => retireInspectorWindow(candidateChild)
  });
  inspectorWindowLifecycle = lifecycle;
  childWindow.webContents.setZoomFactor(currentWindowZoomFactor);

  installSelectionContextMenu(childWindow, {
    platform: process.platform,
    systemLocale: () => applicationMenuLocale,
    buildMenu: (template) => Menu.buildFromTemplate([...template]),
    openExternal: (url) => shell.openExternal(url)
  });

  // The child hosts only DOM owned by the main renderer's React portal. It
  // must never become a second application renderer or navigation surface.
  childWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  childWindow.webContents.on("will-prevent-unload", notifyDesktopQuitBlocked);
  childWindow.on("close", () => {
    inspectorWindowLifecycle?.markUserClosing(childWindow);
  });
  childWindow.webContents.on("render-process-gone", () => {
    if (inspectorWindowLifecycle?.markChildFailed(childWindow) === true && !childWindow.isDestroyed()) {
      childWindow.destroy();
    }
  });
  childWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  childWindow.webContents.on("will-redirect", (event) => event.preventDefault());
  childWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  childWindow.webContents.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
  });
  childWindow.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  childWindow.once("closed", () => {
    const activeLifecycle = inspectorWindowLifecycle;
    const decision = activeLifecycle?.closeDecision(childWindow);
    if (decision === undefined) return;
    inspectorWindow = undefined;
    const notifyOwner = inspectorWindowOwner;
    inspectorWindowOwner = undefined;
    inspectorWindowLifecycle = undefined;
    inspectorWindowOccurrence = undefined;
    if (notifyOwner === undefined || notifyOwner.isDestroyed() || notifyOwner !== owner.webContents || mainWindow !== owner) return;
    if (decision.notifyOwner && decision.reason !== undefined && !quitting) {
      try {
        notifyOwner.send(DESKTOP_CHANNELS.inspectorWindowClosed, Object.freeze({ occurrence, reason: decision.reason }));
      } catch { /* The owner retired after validation. */ }
    }
    if (decision.returnFocus && !quitting && !owner.isDestroyed() && BrowserWindow.getFocusedWindow() === owner) owner.focus();
  });
}

function destroyInspectorWindow(expectedWindow?: BrowserWindow): void {
  if (expectedWindow !== undefined && inspectorWindow !== expectedWindow) return;
  const childWindow = inspectorWindow;
  inspectorWindow = undefined;
  inspectorWindowOwner = undefined;
  inspectorWindowLifecycle = undefined;
  inspectorWindowOccurrence = undefined;
  if (childWindow !== undefined && !childWindow.isDestroyed()) childWindow.destroy();
}

function retireInspectorWindow(expectedWindow: BrowserWindow): void {
  if (inspectorWindow !== expectedWindow) return;
  inspectorWindow = undefined;
  inspectorWindowOwner = undefined;
  inspectorWindowLifecycle = undefined;
  inspectorWindowOccurrence = undefined;
  // Destroying a window.open guest synchronously from did-start-navigation can
  // cancel the owner's own navigation. Fence the occurrence immediately, then
  // let Chromium finish dispatching the navigation before retiring the guest.
  setImmediate(() => {
    if (!expectedWindow.isDestroyed()) expectedWindow.destroy();
  });
}

function ensureTray(icon?: NativeImage): void {
  if (packagedSmoke && !packagedSmokeTrayVerificationActive) return;
  if (tray?.isDestroyed() === true) {
    tray = undefined;
    trayContextMenu = undefined;
  }
  if (icon !== undefined && !icon.isEmpty()) {
    runtimeTrayIcon = resizeTrayIcon(icon);
    if (tray !== undefined) {
      tray.setImage(runtimeTrayIcon);
      return;
    }
  }
  if (tray !== undefined || trayInitialization !== undefined || !app.isReady() || quitting) return;
  trayInitialization = initializeTray()
    .catch(() => {
      process.stderr.write("JOKO_DESKTOP_TRAY_INITIALIZATION_FAILED\n");
    })
    .finally(() => {
      trayInitialization = undefined;
    });
}

async function ensureTrayAvailable(): Promise<boolean> {
  ensureTray();
  const initialization = trayInitialization;
  if (initialization !== undefined) await initialization;
  return tray !== undefined && !tray.isDestroyed();
}

async function closeWindowToTray(window: BrowserWindow, isCurrent: () => boolean = () => true): Promise<void> {
  const result = await hideWindowToAvailableTray(window, ensureTrayAvailable, isCurrent);
  if (result === "unavailable") {
    if (!window.isDestroyed() && isCurrent()) {
      window.show();
      window.focus();
      void dialog.showMessageBox(window, {
        type: "error",
        title: "Joko could not close to the tray",
        message: "The system tray icon is unavailable.",
        detail: "The window was kept open so Joko and the local Joko service remain reachable."
      });
    }
  }
}

async function initializeTray(): Promise<void> {
  let fallbackIcon: NativeImage | undefined;
  if (runtimeTrayIcon === undefined) {
    try {
      fallbackIcon = await app.getFileIcon(process.execPath, { size: "small" });
    } catch {
      // The renderer will provide the themed Joko icon as soon as its SVG is loaded.
    }
  }
  if (quitting || tray !== undefined) return;
  const icon = runtimeTrayIcon ?? (fallbackIcon === undefined || fallbackIcon.isEmpty()
    ? undefined
    : resizeTrayIcon(fallbackIcon));
  if (icon === undefined || icon.isEmpty()) {
    process.stderr.write("JOKO_DESKTOP_TRAY_ICON_UNAVAILABLE\n");
    return;
  }
  createTray(icon);
}

function resizeTrayIcon(icon: NativeImage): NativeImage {
  const traySize = process.platform === "darwin" ? 20 : 32;
  return icon.resize({ width: traySize, height: traySize, quality: "best" });
}

function createTray(icon: NativeImage): void {
  const candidate = new Tray(icon);
  try {
    candidate.setToolTip("Joko");
    candidate.on("click", showMainWindow);
    if (usesJavaScriptTrayMenuPopup(process.platform)) {
      candidate.on("right-click", openTrayContextMenu);
    }
    tray = candidate;
    refreshTrayContextMenu();
  } catch (error) {
    if (tray === candidate) tray = undefined;
    trayContextMenu = undefined;
    try {
      candidate.destroy();
    } catch {
      // A partially initialized native tray may already have been destroyed.
    }
    throw error;
  }
}

function refreshTrayContextMenu(): void {
  if (tray === undefined || tray.isDestroyed()) return;
  const menu = buildTrayContextMenu();
  trayContextMenu = menu;
  if (!usesJavaScriptTrayMenuPopup(process.platform)) tray.setContextMenu(menu);
}

function buildTrayContextMenu(): Menu {
  const labels = resolveDesktopTrayMenuLabels(
    applicationMenuLocale,
    managedOrchestratorStatus.state !== "disabled" || managedOrchestratorRuntime !== undefined
  );
  return Menu.buildFromTemplate([
    { label: labels.open, click: showMainWindow },
    { type: "separator" },
    { label: labels.quit, click: () => app.quit() }
  ]);
}

function openTrayContextMenu(): void {
  popUpDesktopTrayMenu<Menu>({
    tray,
    menu: trayContextMenu,
    buildMenu: buildTrayContextMenu,
    retainMenu: (menu) => { trayContextMenu = menu; },
    retainActiveMenu: (menu) => { activeTrayContextMenus.add(menu); },
    releaseActiveMenu: (menu) => { activeTrayContextMenus.delete(menu); },
    onUnavailable: (reason) => {
      process.stderr.write(`JOKO_DESKTOP_TRAY_MENU_UNAVAILABLE ${reason}\n`);
    },
    onError: () => {
      process.stderr.write("JOKO_DESKTOP_TRAY_MENU_POPUP_FAILED\n");
    }
  });
}

function trayIconFromDataUrl(value: unknown): NativeImage {
  if (typeof value !== "string" || value.length > MAXIMUM_TRAY_ICON_DATA_URL_LENGTH ||
    !value.startsWith(TRAY_ICON_DATA_URL_PREFIX)) {
    throw new TypeError("Desktop tray icon must be a bounded PNG data URL.");
  }
  const encoded = value.slice(TRAY_ICON_DATA_URL_PREFIX.length);
  if (encoded.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new TypeError("Desktop tray icon must contain valid base64 data.");
  }
  const png = Buffer.from(encoded, "base64");
  if (png.byteLength < 24 || png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE_HEX ||
    png.readUInt32BE(8) !== 13 || png.subarray(12, 16).toString("ascii") !== "IHDR" ||
    png.readUInt32BE(16) !== EXPECTED_TRAY_ICON_SIZE || png.readUInt32BE(20) !== EXPECTED_TRAY_ICON_SIZE) {
    throw new TypeError(`Desktop tray icon must be a ${EXPECTED_TRAY_ICON_SIZE}x${EXPECTED_TRAY_ICON_SIZE} PNG.`);
  }
  const icon = nativeImage.createFromBuffer(png);
  const size = icon.getSize();
  if (icon.isEmpty() || size.width !== EXPECTED_TRAY_ICON_SIZE || size.height !== EXPECTED_TRAY_ICON_SIZE) {
    throw new TypeError(`Desktop tray icon must decode to ${EXPECTED_TRAY_ICON_SIZE}x${EXPECTED_TRAY_ICON_SIZE} pixels.`);
  }
  return icon;
}

function installDesktopApplicationMenu(): void {
  const { configuration, ready } = applicationMenuConfigurationState.snapshot();
  installMacApplicationMenu(process.platform, {
    buildFromTemplate: (template) => Menu.buildFromTemplate(template),
    setApplicationMenu: (menu) => Menu.setApplicationMenu(menu)
  }, applicationMenuLocale, app.isPackaged, {
    ...configuration,
    shortcutRecording: configuration.shortcutRecording || !ready,
    onCommand: dispatchApplicationMenuCommand,
    roleLabel: nativeMenuRoleLabel
  });
}

function resetMainApplicationMenuState(contents: WebContents): void {
  const transition = applicationMenuShortcutRecordingLeases.set(contents.id, false);
  let menuChanged = applicationMenuConfigurationState.resetForRendererLoad();
  const result = applicationMenuConfigurationState.apply({ shortcutRecording: transition.active });
  menuChanged = menuChanged || result.menuChanged;
  if (menuChanged) installDesktopApplicationMenu();
  if (transition.active) {
    // Binding.clear() runs before this reset. Re-establish the process-wide
    // suspension when another renderer still owns a recording lease so the
    // next preference sync cannot physically register and swallow that key.
    void globalVoiceShortcutBinding.suspend(GLOBAL_VOICE_APPLICATION_SHORTCUT_RECORDING_SUSPENSION);
  } else if (transition.wasActive) {
    void restoreGlobalVoiceShortcutAfterSuspension(GLOBAL_VOICE_APPLICATION_SHORTCUT_RECORDING_SUSPENSION);
  }
  if (globalVoiceShortcutCaptureSubscriptions.recording()) {
    // The main renderer lifecycle clear also drops suspension ownership. A
    // surviving task-window capture must retain its independent native lease.
    void globalVoiceShortcutBinding.suspend(GLOBAL_VOICE_NATIVE_CAPTURE_SUSPENSION);
  }
}

function releaseApplicationMenuShortcutRecording(ownerId: number): void {
  const transition = applicationMenuShortcutRecordingLeases.set(ownerId, false);
  if (transition.wasActive === transition.active) return;
  const result = applicationMenuConfigurationState.apply({ shortcutRecording: transition.active });
  if (result.menuChanged) installDesktopApplicationMenu();
  if (!transition.active) {
    void restoreGlobalVoiceShortcutAfterSuspension(GLOBAL_VOICE_APPLICATION_SHORTCUT_RECORDING_SUSPENSION);
    void globalVoiceShortcutRecovery.request();
  }
}

function nativeMenuRoleLabel(role: "resetZoom" | "zoomIn" | "zoomOut"): string {
  try {
    return Menu.buildFromTemplate([{ role }]).items[0]?.label ?? role;
  } catch {
    return role;
  }
}

function dispatchApplicationMenuCommand(command: DesktopApplicationMenuCommand): void {
  if (desktopUpdateStartupPhase !== undefined) return;
  if (command === "open-about" || command === "new-session" || command === "open-settings" || command === "open-task-status-settings" || command === "toggle-sidebar") {
    showMainWindow();
  }
  const [accepted] = applicationMenuConfigurationState.acceptCommand(command);
  if (accepted === undefined) return;
  const window = mainWindow;
  if (window === undefined || window.isDestroyed()) return;
  const send = (): void => {
    if (!window.isDestroyed()) window.webContents.send(DESKTOP_CHANNELS.applicationMenuCommand, accepted);
  };
  if (window.webContents.isLoading()) {
    window.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function initializeDesktopUpdateService(): void {
  if (desktopUpdateService !== undefined) return;
  const feedUrl = selectedDesktopUpdateFeedUrl();
  const service = createDesktopUpdateService({
    driver: createElectronUpdateDriver(bundledElectronUpdater(), {
      once: (_event, listener) => nativeAutoUpdater.once("before-quit-for-update", listener),
      removeListener: (_event, listener) =>
        nativeAutoUpdater.removeListener("before-quit-for-update", listener),
      getUpdateDownloadedListeners: () => nativeAutoUpdater.listeners("update-downloaded"),
      removeUpdateDownloadedListener: (listener) =>
        nativeAutoUpdater.removeListener("update-downloaded", listener as never)
    }, {
      quitHandoff: {
        once: (_event, listener) => app.once("will-quit", listener),
        removeListener: (_event, listener) => app.removeListener("will-quit", listener),
        quit: () => app.quit(),
        onQuitBlocked: subscribeDesktopQuitBlocked
      }
    }),
    isPackaged: app.isPackaged,
    platform: process.platform,
    currentVersion: app.getVersion(),
    appImagePath: process.env["APPIMAGE"],
    feedUrl,
    enableBackgroundPolling: false,
    prepareToApply: stopManagedOrchestratorForUpdateApply,
    recoverAfterApplyFailure: recoverManagedOrchestratorAfterUpdateApplyFailure
  });
  service.onStatus((status) => {
    broadcastDesktopUpdateStatus(status);
    if (desktopUpdateStartupPhase === undefined && status.status === "ready") {
      void desktopUpdateAutoRelaunchPolicy?.evaluate("status-ready");
    }
  });
  desktopUpdateService = service;
}

function initializeDesktopUpdateAutoSettings(): void {
  if (desktopUpdateAutoSettings !== undefined) return;
  desktopUpdateAutoSettings = createDesktopUpdateAutoSettingsStore(
    join(app.getPath("userData"), "auto-update-settings.json")
  );
}

function initializeDesktopUpdateChannelSettings(): void {
  if (desktopUpdateChannelSettings !== undefined) return;
  desktopUpdateChannelSettings = createDesktopUpdateChannelSettingsStore(
    join(app.getPath("userData"), "update-channel-settings.json")
  );
}

async function initializeDesktopKeepAwake(): Promise<void> {
  if (desktopKeepAwakeSettings === undefined) {
    desktopKeepAwakeSettings = createDesktopKeepAwakeSettingsStore(
      join(app.getPath("userData"), "keep-awake-settings.json")
    );
  }
  if (desktopKeepAwakeController === undefined) {
    desktopKeepAwakeController = createDesktopKeepAwakeController(powerSaveBlocker);
  }
  if (desktopKeepAwakeCoordinator === undefined) {
    desktopKeepAwakeCoordinator = createDesktopKeepAwakeSettingsCoordinator(
      desktopKeepAwakeSettings,
      desktopKeepAwakeController,
      (settings) => broadcastDesktopKeepAwakeSettings(
        applicationWindows(),
        DESKTOP_CHANNELS.keepAwakeChanged,
        settings
      )
    );
  }
  await desktopKeepAwakeCoordinator.initialize();
}

async function initializeDesktopWindowInteractionSettings(): Promise<void> {
  if (desktopWindowInteractionSettings === undefined) {
    desktopWindowInteractionSettings = createDesktopWindowInteractionSettingsStore(
      join(app.getPath("userData"), "window-interaction-settings.json")
    );
  }
  await desktopWindowInteractionSettings.initialize();
}

async function initializeDesktopNativeTaskStatus(): Promise<void> {
  if (!nativeTaskStatusSupported) return;
  if (desktopNativeTaskStatusSettings === undefined) {
    desktopNativeTaskStatusSettings = createDesktopNativeTaskStatusSettingsStore(
      join(app.getPath("userData"), "native-task-status-settings.json")
    );
  }
  if (desktopNativeTaskStatusLayoutSettings === undefined) {
    desktopNativeTaskStatusLayoutSettings = createDesktopNativeTaskStatusLayoutSettingsStore(
      join(app.getPath("userData"), "native-task-status-layout.json")
    );
  }
  const [settings] = await Promise.all([
    desktopNativeTaskStatusSettings.initialize(),
    desktopNativeTaskStatusLayoutSettings.initialize()
  ]);
  if (macNativeTaskStatusHost === undefined) {
    macNativeTaskStatusHost = createMacNativeTaskStatusHost({
      supported: nativeTaskStatusSupported,
      getDisplays: desktopNativeTaskStatusDisplays,
      getCursorPoint: () => screen.getCursorScreenPoint(),
      getVisibleSessionIds: desktopNativeTaskStatusVisibleSessionIds,
      getLayoutPreferences: () => desktopNativeTaskStatusLayoutSettings?.get() ?? [],
      createWindow: createNativeTaskStatusWindow,
      onAction: dispatchNativeTaskStatusAction,
      onNewTask: () => dispatchApplicationMenuCommand("new-session"),
      onOpenSettings: () => dispatchApplicationMenuCommand("open-task-status-settings"),
      onToggleSounds: async () => {
        const current = requireDesktopNativeTaskStatusSettings().get();
        await commitDesktopNativeTaskStatusSettings({
          ...current,
          sounds: { ...current.sounds, enabled: !current.sounds.enabled }
        });
      },
      onLayoutPreference: async (preference) => {
        await desktopNativeTaskStatusLayoutSettings?.set(preference);
      },
      playSound: playDesktopNativeTaskStatusSound
    });
  }
  macNativeTaskStatusHost.setSettings(settings);
  macNativeTaskStatusHost.setApplicationFocused(isDesktopApplicationForeground());
  if (nativeTaskStatusDisplayRefresh === undefined) {
    nativeTaskStatusDisplayRefresh = () => macNativeTaskStatusHost?.refreshDisplays();
    screen.on("display-added", nativeTaskStatusDisplayRefresh);
    screen.on("display-removed", nativeTaskStatusDisplayRefresh);
    screen.on("display-metrics-changed", nativeTaskStatusDisplayRefresh);
  }
}

function createNativeTaskStatusWindow(bounds: NativeTaskStatusWindowBounds): NativeTaskStatusWindow {
  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    ...NATIVE_TASK_STATUS_WINDOW_INTERACTION,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    ...(process.platform === "darwin" ? {
      roundedCorners: true,
      vibrancy: "popover" as const,
      visualEffectState: "active" as const
    } : {}),
    title: "Joko task status",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true
    }
  });
  if (process.platform === "darwin") {
    window.setAlwaysOnTop(true, "screen-saver", 1);
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setWindowButtonVisibility(false);
  } else {
    window.setAlwaysOnTop(true, "pop-up-menu");
  }
  window.webContents.on("render-process-gone", () => {
    if (!window.isDestroyed()) window.destroy();
  });
  return Object.freeze({
    isDestroyed: () => window.isDestroyed(),
    setBounds: (next: NativeTaskStatusWindowBounds) => window.setBounds(next, false),
    loadDocument: (dataUrl: string) => window.loadURL(dataUrl),
    showInactive: () => window.showInactive(),
    destroy: () => window.destroy(),
    onClosed: (listener: () => void) => window.on("closed", listener),
    onWillNavigate: (listener: (url: string) => void) => window.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      listener(url);
    }),
    onBoundsChanged: (listener: (next: NativeTaskStatusWindowBounds) => void) => {
      const notify = (): void => {
        if (window.isDestroyed()) return;
        const next = window.getBounds();
        listener(Object.freeze({ x: next.x, y: next.y, width: next.width, height: next.height }));
      };
      window.on("moved", notify);
      window.on("resized", notify);
    },
    denyNewWindows: () => {
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    }
  });
}

function desktopNativeTaskStatusDisplays(): readonly DesktopNativeTaskStatusDisplay[] {
  if (!nativeTaskStatusSupported) return [];
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => Object.freeze({
    id: display.id,
    name: display.label.trim() || `Display ${index + 1}`,
    primary: display.id === primaryId,
    bounds: Object.freeze({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height
    })
  }));
}

function desktopNativeTaskStatusVisibleSessionIds(): readonly string[] {
  const sessionIds = new Set<string>();
  for (const [contents, visibleSessionIds] of nativeTaskStatusVisibleSessionsByContents) {
    if (contents.isDestroyed()) continue;
    const window = BrowserWindow.fromWebContents(contents);
    if (window === null || window.isDestroyed() || !window.isVisible() || window.isMinimized()) continue;
    for (const sessionId of visibleSessionIds) sessionIds.add(sessionId);
  }
  return Object.freeze([...sessionIds]);
}

function setDesktopNativeTaskStatusVisibility(
  contents: WebContents,
  visibleSessionIds: readonly string[]
): void {
  nativeTaskStatusVisibleSessionsByContents.set(contents, visibleSessionIds);
  macNativeTaskStatusHost?.refreshVisibility();
}

function clearDesktopNativeTaskStatusVisibility(contents: WebContents): void {
  if (!nativeTaskStatusVisibleSessionsByContents.delete(contents)) return;
  macNativeTaskStatusHost?.refreshVisibility();
}

function installDesktopNativeTaskStatusVisibilityLifecycle(window: BrowserWindow): void {
  const refresh = (): void => macNativeTaskStatusHost?.refreshVisibility();
  window.on("show", refresh);
  window.on("hide", refresh);
  window.on("minimize", refresh);
  window.on("restore", refresh);
  window.once("closed", () => {
    window.removeListener("show", refresh);
    window.removeListener("hide", refresh);
    window.removeListener("minimize", refresh);
    window.removeListener("restore", refresh);
  });
}

async function playDesktopNativeTaskStatusSound(sound: DesktopNativeTaskStatusSoundChoice): Promise<void> {
  if (process.platform !== "darwin" || isSilentDesktopNativeTaskStatusSound(sound)) return;
  const path = sound.type === "custom"
    ? sound.path
    : join(app.isPackaged ? process.resourcesPath : app.getAppPath(),
      ...(app.isPackaged ? ["native-task-status-sounds"] : ["resources", "native-task-status-sounds"]),
      `${sound.id}.mp3`);
  if (!isAbsolute(path) || (sound.type === "custom" && ![".mp3", ".wav", ".wave", ".aiff", ".aif", ".m4a", ".caf"]
    .includes(extname(path).toLowerCase()))) throw new TypeError("Native task-status sound path is invalid.");
  const info = await stat(path);
  if (!info.isFile()) throw new TypeError("Native task-status sound must be a regular file.");
  await new Promise<void>((resolvePlayback, rejectPlayback) => {
    const child = spawn("/usr/bin/afplay", [path], { stdio: "ignore", windowsHide: true });
    child.once("error", rejectPlayback);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        resolvePlayback();
        return;
      }
      rejectPlayback(new Error(signal === null
        ? `Native task-status sound playback exited with code ${code ?? "unknown"}.`
        : `Native task-status sound playback was terminated by ${signal}.`));
    });
  });
}

function dispatchNativeTaskStatusAction(action: DesktopNativeTaskStatusAction): void {
  if (!nativeTaskStatusSupported) return;
  deliverDesktopNativeTaskStatusAction(action, {
    revealMainWindow: showMainWindow,
    currentMainWindow: () => mainWindow,
    isWindowAvailable: (window) => !window.isDestroyed() && !window.webContents.isDestroyed(),
    dispatch: (window, currentAction) => {
      const send = (): void => {
        if (mainWindow !== window || window.isDestroyed() || window.webContents.isDestroyed()) return;
        window.webContents.send(DESKTOP_CHANNELS.nativeTaskStatusAction, currentAction);
      };
      if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
      else send();
    }
  });
}

function clearNativeTaskStatusProjection(): void {
  macNativeTaskStatusHost?.publish({
    ownerId: "desktop-renderer-unavailable",
    revision: "0",
    locale: isDesktopLocale(applicationMenuLocale) ? applicationMenuLocale : "en",
    sessions: []
  });
}

function requireDesktopNativeTaskStatusSettings(): DesktopNativeTaskStatusSettingsStore {
  if (!nativeTaskStatusSupported || desktopNativeTaskStatusSettings === undefined) {
    throw new Error("Native task status is not supported on this system.");
  }
  return desktopNativeTaskStatusSettings;
}

async function commitDesktopNativeTaskStatusSettings(
  input: DesktopNativeTaskStatusSettings
): Promise<DesktopNativeTaskStatusSettings> {
  const next = parseDesktopNativeTaskStatusSettings(input);
  const settings = await requireDesktopNativeTaskStatusSettings().set(next);
  macNativeTaskStatusHost?.setSettings(settings);
  broadcastDesktopNativeTaskStatusSettings(settings);
  return settings;
}

function activationClickBrowserWindowOptions(): Readonly<{ acceptFirstMouse: boolean }> | Readonly<Record<string, never>> {
  if (process.platform !== "darwin") return Object.freeze({});
  return Object.freeze({
    acceptFirstMouse: !requireDesktopWindowInteractionSettings().get().swallowActivationClick
  });
}

function selectedDesktopUpdateFeedUrl(): string | undefined {
  return requireDesktopUpdateChannelSettings().get().enableBeta
    ? desktopUpdateBetaFeedUrl
    : desktopUpdateReleaseFeedUrl;
}

function shouldRunDesktopUpdateStartup(): boolean {
  const status = requireDesktopUpdateService().getStatus();
  return app.isPackaged && selectedDesktopUpdateFeedUrl() !== undefined &&
    status.status === "idle" && status.availability === "available";
}

function beginDesktopUpdateStartup(): Promise<void> {
  if (desktopUpdateStartupCheck !== undefined) return desktopUpdateStartupCheck;
  if (desktopUpdateStartupPhase === undefined) {
    releaseDesktopUpdateStartup();
    return Promise.resolve();
  }
  desktopUpdateStartupPhase = { kind: "checking" };
  broadcastDesktopUpdateStatus(requireDesktopUpdateService().getStatus());
  const operation = runDesktopUpdateStartupCheck({
    service: requireDesktopUpdateService(),
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    fetchManifestVersion: () => {
      const feedUrl = selectedDesktopUpdateFeedUrl();
      return feedUrl === undefined
        ? Promise.resolve(null)
        : fetchDesktopUpdateManifestVersion({
          feedUrl,
          platform: process.platform,
          architecture: process.arch,
          fetch: net.fetch
        });
    }
  }).then((result) => {
    if (result.kind === "ready") {
      const status = requireDesktopUpdateService().getStatus();
      if (status.status === "ready" && status.version === result.version) {
        desktopUpdateStartupPhase = { kind: "ready", version: result.version };
        broadcastDesktopUpdateStatus(status);
        return;
      }
    } else if (result.kind === "download-failed") {
      desktopUpdateStartupPhase = { kind: "download-failed" };
      broadcastDesktopUpdateStatus(requireDesktopUpdateService().getStatus());
      return;
    }
    releaseDesktopUpdateStartup();
  }).catch(() => {
    desktopUpdateStartupPhase = { kind: "download-failed" };
    broadcastDesktopUpdateStatus(requireDesktopUpdateService().getStatus());
  }).finally(() => {
    if (desktopUpdateStartupCheck === operation) desktopUpdateStartupCheck = undefined;
  });
  desktopUpdateStartupCheck = operation;
  return operation;
}

async function checkDesktopUpdateFromRenderer(): Promise<Awaited<ReturnType<DesktopUpdateService["check"]>>> {
  const phase = desktopUpdateStartupPhase;
  if (phase === undefined) return requireDesktopUpdateService().check();
  if (phase.kind === "ready") return { status: "available", version: phase.version };
  await beginDesktopUpdateStartup();
  const after = desktopUpdateStartupPhase;
  if (after?.kind === "ready") return { status: "available", version: after.version };
  if (after?.kind === "download-failed") return { status: "failed", errorKind: "download" };
  const status = requireDesktopUpdateService().getStatus();
  if (status.status === "error") return { status: "failed", errorKind: status.errorKind };
  if (status.status === "manual-download") return { status: "manual-download", reason: status.reason };
  if (status.status === "idle" && status.availability === "unavailable") {
    return { status: "unavailable", reason: status.reason };
  }
  return { status: "up-to-date" };
}

function desktopUpdateStatusForRenderer(status: DesktopUpdateStatus): DesktopUpdateStatus {
  const phase = desktopUpdateStartupPhase;
  if (phase === undefined) return status;
  if (phase.kind === "ready") return Object.freeze({ status: "ready", version: phase.version, startup: true });
  if (phase.kind === "download-failed") {
    return Object.freeze({ status: "error", errorKind: "download", startup: true });
  }
  if (phase.kind === "checking" &&
    status.status !== "downloading" && status.status !== "superseding" && status.status !== "error") {
    return Object.freeze({ status: "checking", startup: true });
  }
  return Object.freeze({ ...status, startup: true });
}

function broadcastDesktopUpdateStatus(status: DesktopUpdateStatus): void {
  const window = mainWindow;
  if (window !== undefined && !window.isDestroyed()) {
    try {
      window.webContents.send(DESKTOP_CHANNELS.updateStatus, desktopUpdateStatusForRenderer(status));
    } catch {
      // A renderer reload/crash is an observer failure, never an updater state
      // transition. getStatus provides the authoritative snapshot on remount.
    }
  }
}

function destroyExtensionWindows(): void {
  const windows = [...extensionWindows.values()];
  extensionWindows.clear();
  extensionWindowIdsByContents.clear();
  extensionWindowStates.clear();
  for (const window of windows) {
    if (!window.isDestroyed()) window.destroy();
  }
}

function canApplyMainWindowClose(): boolean {
  return canShowDesktopWindow({
    quitting,
    channelQuitHandoffPending: desktopUpdateChannelQuitHandoffPending,
    nativeInstallQuitHandoffPending: desktopUpdateNativeInstallQuitHandoffPending,
    completeExitQuitHandoffPending: desktopCompleteExitQuitHandoffPending
  }) && desktopUpdateChannelRelaunch === undefined && desktopUpdateService?.isRelaunching() !== true;
}

function broadcastDesktopMainWindowCloseSettings(settings: DesktopMainWindowCloseSettings): void {
  for (const window of applicationWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      try { window.webContents.send(DESKTOP_CHANNELS.mainWindowCloseSettingsChanged, settings); }
      catch { /* Renderer availability does not change the committed device setting. */ }
    }
  }
}

function broadcastDesktopNativeTaskStatusSettings(settings: DesktopNativeTaskStatusSettings): void {
  for (const window of applicationWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(DESKTOP_CHANNELS.nativeTaskStatusSettingsChanged, settings);
    }
  }
}

function broadcastDesktopUpdateChannelSettings(settings: DesktopUpdateChannelSettings): void {
  broadcastDesktopUpdateSettings(applicationWindows(), DESKTOP_CHANNELS.updateChannelSettingsChanged, settings);
}

function releaseDesktopUpdateStartup(): void {
  const wasActive = desktopUpdateStartupPhase !== undefined;
  desktopUpdateStartupPhase = undefined;
  if (wasActive && desktopUpdateService !== undefined) {
    broadcastDesktopUpdateStatus(desktopUpdateService.getStatus());
  }
  desktopUpdateService?.startBackgroundPolling();
  void ensureDesktopUpdateAutoRelaunchPolicy();
  void beginManagedOrchestratorInitialization();
}

function ensureDesktopUpdateAutoRelaunchPolicy(): Promise<void> {
  if (desktopUpdateAutoRelaunchPolicy !== undefined) return Promise.resolve();
  if (desktopUpdateAutoRelaunchPolicyInitialization !== undefined) {
    return desktopUpdateAutoRelaunchPolicyInitialization;
  }
  const operation = (async () => {
    const settings = desktopUpdateAutoSettings;
    if (settings === undefined || quitting || desktopUpdateLifecycleDisposed) return;
    await settings.initialize();
    if (quitting || desktopUpdateLifecycleDisposed || desktopUpdateAutoRelaunchPolicy !== undefined) return;
    const service = requireDesktopUpdateService();
    desktopUpdateAutoRelaunchPolicy = createDesktopUpdateAutoRelaunchPolicy({
      isPackaged: app.isPackaged,
      getEnabled: () => settings.get().autoRelaunchOnIdle,
      getStatus: service.getStatus,
      isRelaunching: service.isRelaunching,
      probeActivity: probeCurrentManagedRuntimeActivity,
      readIdleTimeSeconds: () => powerMonitor.getSystemIdleTime(),
      readIdleState: () => powerMonitor.getSystemIdleState(10 * 60),
      requestRelaunch: () => requestDesktopUpdateRelaunch(false, true),
      powerEvents: {
        on: (event, listener) => {
          if (event === "resume") return powerMonitor.on("resume", listener);
          if (event === "unlock-screen") return powerMonitor.on("unlock-screen", listener);
          return powerMonitor.on("user-did-become-active", listener);
        },
        removeListener: (event, listener) => {
          if (event === "resume") return powerMonitor.removeListener("resume", listener);
          if (event === "unlock-screen") return powerMonitor.removeListener("unlock-screen", listener);
          return powerMonitor.removeListener("user-did-become-active", listener);
        }
      }
    });
    if (service.getStatus().status === "ready") {
      void desktopUpdateAutoRelaunchPolicy.evaluate("policy-started-ready");
    }
  })().finally(() => {
    if (desktopUpdateAutoRelaunchPolicyInitialization === operation) {
      desktopUpdateAutoRelaunchPolicyInitialization = undefined;
    }
  });
  desktopUpdateAutoRelaunchPolicyInitialization = operation;
  return operation;
}

async function requestDesktopUpdateRelaunch(
  allowBusy: boolean,
  requireQuietActivity = false
): Promise<DesktopUpdateRelaunchResult> {
  if (desktopUpdateStartupPhase !== undefined || desktopUpdateChannelChangePending ||
    desktopUpdateChannelRelaunch !== undefined || quitting) return { accepted: false, reason: "not-ready" };
  const service = requireDesktopUpdateService();
  const snapshot = service.getStatus();
  if (snapshot.status !== "ready" || service.isRelaunching()) return { accepted: false, reason: "not-ready" };
  if (managedOrchestratorStatus.state !== "disabled" && managedOrchestratorStatus.state === "ready" &&
    managedOrchestratorRuntime === undefined && managedOrchestratorInitialization === undefined) {
    return { accepted: false, reason: "busy" };
  }
  if (!allowBusy) {
    const activity = await probeCurrentManagedRuntimeActivity().catch(() => undefined);
    if (activity === undefined || activity.blocksShutdown) return { accepted: false, reason: "busy" };
    if (requireQuietActivity && !isDesktopUpdateActivityQuietForAutoRelaunch(activity, Date.now())) {
      return { accepted: false, reason: "busy" };
    }
    const current = service.getStatus();
    if (desktopUpdateStartupPhase !== undefined || desktopUpdateChannelChangePending ||
      desktopUpdateChannelRelaunch !== undefined || quitting || current.status !== "ready" ||
      current.version !== snapshot.version || service.isRelaunching()) {
      return { accepted: false, reason: "not-ready" };
    }
  }
  return service.relaunch();
}

async function requestDesktopStartupRelaunch(): Promise<DesktopUpdateRelaunchResult> {
  const phase = desktopUpdateStartupPhase;
  const service = requireDesktopUpdateService();
  if (phase?.kind !== "ready" || service.isRelaunching() || desktopUpdateChannelChangePending ||
    desktopUpdateChannelRelaunch !== undefined || quitting) return { accepted: false, reason: "not-ready" };
  const snapshot = service.getStatus();
  if (snapshot.status !== "ready" || snapshot.version !== phase.version) {
    releaseDesktopUpdateStartup();
    return { accepted: false, reason: "not-ready" };
  }
  const busy = await probeDesktopStartupManagedRuntimeActivity().catch(() => true);
  const currentPhase = desktopUpdateStartupPhase;
  const current = service.getStatus();
  if (busy || currentPhase?.kind !== "ready" || currentPhase.version !== phase.version ||
    desktopUpdateChannelChangePending || desktopUpdateChannelRelaunch !== undefined || quitting ||
    current.status !== "ready" || current.version !== phase.version || service.isRelaunching()) {
    releaseDesktopUpdateStartup();
    return { accepted: false, reason: busy ? "busy" : "not-ready" };
  }
  const result = await service.relaunch();
  if (!result.accepted) releaseDesktopUpdateStartup();
  return result;
}

async function probeDesktopBetaUpdateChannel(): Promise<boolean> {
  if (!app.isPackaged) return true;
  const feedUrl = desktopUpdateBetaFeedUrl;
  if (feedUrl === undefined) return false;
  return await fetchDesktopUpdateManifestVersion({
    feedUrl,
    platform: process.platform,
    architecture: process.arch,
    fetch: net.fetch
  }) !== null;
}

async function writeDesktopUpdateChannelSettings(
  operation: (store: DesktopUpdateChannelSettingsStore) => Promise<DesktopUpdateChannelSettings>
): Promise<DesktopUpdateChannelSettings> {
  const service = requireDesktopUpdateService();
  if (desktopUpdateChannelChangePending || desktopUpdateChannelRelaunch !== undefined ||
    desktopUpdateStartupPhase !== undefined || service.isRelaunching() ||
    service.isFeedChangePending() || quitting) {
    throw new Error("Desktop update channel is busy.");
  }
  const store = requireDesktopUpdateChannelSettings();
  const previous = store.get();
  desktopUpdateChannelChangePending = true;
  try {
    const settings = await operation(store);
    broadcastDesktopUpdateChannelSettings(settings);
    if (settings.enableBeta !== previous.enableBeta) {
      const feedUrl = settings.enableBeta ? desktopUpdateBetaFeedUrl : desktopUpdateReleaseFeedUrl;
      if (feedUrl !== undefined) await service.changeFeed(feedUrl);
      service.startBackgroundPolling();
    }
    return settings;
  } finally {
    desktopUpdateChannelChangePending = false;
  }
}

function requestDesktopUpdateChannelRelaunch(
  allowBusy: boolean
): Promise<DesktopUpdateRelaunchResult> {
  if (desktopUpdateChannelRelaunch !== undefined) return desktopUpdateChannelRelaunch;
  const operation = performDesktopUpdateChannelRelaunch(allowBusy).finally(() => {
    if (desktopUpdateChannelRelaunch === operation) desktopUpdateChannelRelaunch = undefined;
  });
  desktopUpdateChannelRelaunch = operation;
  return operation;
}

async function performDesktopUpdateChannelRelaunch(
  allowBusy: boolean
): Promise<DesktopUpdateRelaunchResult> {
  if (desktopUpdateChannelChangePending || desktopUpdateStartupPhase !== undefined ||
    requireDesktopUpdateService().isRelaunching() || quitting) {
    return { accepted: false, reason: "not-ready" };
  }
  if (!allowBusy) {
    const activity = await probeCurrentManagedRuntimeActivity().catch(() => undefined);
    if (activity === undefined || activity.blocksShutdown) return { accepted: false, reason: "busy" };
    if (desktopUpdateStartupPhase !== undefined || desktopUpdateChannelChangePending ||
      requireDesktopUpdateService().isRelaunching() || quitting) {
      return { accepted: false, reason: "not-ready" };
    }
  }
  try {
    await stopManagedOrchestratorForCompleteExit();
  } catch {
    await recoverManagedOrchestratorAfterUpdateApplyFailure().catch(() => undefined);
    reconcileDesktopDevicePeerAgentLifecycle();
    return { accepted: false, reason: "orchestrator-shutdown-failed" };
  }
  let handedOff = false;
  desktopUpdateChannelQuitHandoffPending = true;
  try {
    handedOff = await requestDesktopUpdateChannelRelaunchHandoff({
      app,
      onQuitBlocked: subscribeDesktopQuitBlocked
    });
  } finally {
    desktopUpdateChannelQuitHandoffPending = false;
  }
  if (handedOff) {
    disposeDesktopUpdateLifecycle();
    return { accepted: true };
  }
  // before-quit raises this flag before renderer beforeunload can cancel the
  // exit. Clear it before recovery so the stopped managed authority and its
  // exit fence are restored, and a later unrelated will-quit cannot relaunch.
  quitting = false;
  await recoverManagedOrchestratorAfterUpdateApplyFailure().catch(() => undefined);
  showMainWindow();
  return { accepted: false, reason: "apply-failed" };
}

async function probeCurrentManagedRuntimeActivity(): Promise<{
  readonly blocksShutdown: boolean;
  readonly lastBlockingActivityAtMs?: number;
}> {
  // A configured-disabled host has no local runtime. An explicitly signed-out
  // host still owns its child until complete exit but no longer has authority
  // to inspect it, so update activity must remain fail-closed.
  if (managedOrchestratorStatus.state === "disabled") {
    if (managedOrchestratorRuntime !== undefined) {
      throw new Error("A signed-out managed runtime is still owned until complete exit.");
    }
    return { blocksShutdown: false, lastBlockingActivityAtMs: 0 };
  }
  if (managedOrchestratorStatus.state !== "ready" || managedOrchestratorRuntime === undefined ||
    managedOrchestratorExitFence.shutdownStarted) throw new Error("Managed runtime authority is unavailable.");
  const connection = managedOrchestratorStatus.connection;
  const runtime = managedOrchestratorRuntime;
  if (!sameManagedOrchestratorConnection(connection, runtime.connection)) {
    throw new Error("Managed runtime ownership is unavailable.");
  }
  return probeManagedRuntimeActivity({
    connection,
    readAuthKey: readCredential,
    isAuthorityCurrent: (candidate) => managedOrchestratorStatus.state === "ready" &&
      managedOrchestratorRuntime === runtime && !managedOrchestratorExitFence.shutdownStarted &&
      sameManagedOrchestratorConnection(managedOrchestratorStatus.connection, candidate) &&
      sameManagedOrchestratorConnection(runtime.connection, candidate)
  });
}

async function probeDesktopStartupManagedRuntimeActivity(): Promise<boolean> {
  if (managedOrchestratorStatus.state === "disabled") return managedOrchestratorRuntime !== undefined;
  if (managedOrchestratorRuntime !== undefined || managedOrchestratorInitialization !== undefined) return true;
  const path = join(app.getPath("userData"), "managed-orchestrator-host", "connection.json");
  const saved = await readManagedOrchestratorConnectionState(path);
  if (saved.kind === "missing") return false;
  if (saved.kind !== "connection") return true;
  const probe = await probeManagedOrchestratorConnection({
    connection: saved.connection,
    readAuthKey: readCredential
  });
  const unchanged = async (): Promise<boolean> => {
    const current = await readManagedOrchestratorConnectionState(path);
    return current.kind === "connection" && sameManagedOrchestratorConnection(current.connection, saved.connection) &&
      managedOrchestratorRuntime === undefined && managedOrchestratorInitialization === undefined;
  };
  if (probe === "absent") return !await unchanged();
  if (probe !== "authenticated" || !await unchanged()) return true;
  await probeManagedRuntimeActivity({
    connection: saved.connection,
    readAuthKey: readCredential,
    isAuthorityCurrent: () => unchanged()
  });
  // A live daemon cannot be stopped through the fresh process's child handle.
  // Even when it reports idle, ownership is indeterminate, so startup apply
  // remains fail-closed and normal initialization adopts it instead.
  return true;
}

function sameManagedOrchestratorConnection(
  left: DesktopManagedOrchestratorConnection,
  right: DesktopManagedOrchestratorConnection
): boolean {
  return left.profileId === right.profileId && left.deviceId === right.deviceId &&
    left.serverId === right.serverId && left.name === right.name && left.origin === right.origin;
}

function initializeDesktopDevicePeerAgentLifecycle(): void {
  if (desktopDevicePeerAgentLifecycle !== undefined) return;
  let terminalPort: ReturnType<typeof createAuditedDesktopDevicePeerTerminalPort> | undefined;
  let runtimeExecutables: ReturnType<typeof createAuditedDesktopDevicePeerRuntimeExecutables> | undefined;
  desktopDevicePeerAgentLifecycle = new DesktopDevicePeerAgentLifecycle({
    async createExecutor() {
      const runtimeRoot = resolveDesktopDevicePeerRuntimeRoot({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        sourceDirectory
      });
      terminalPort ??= createAuditedDesktopDevicePeerTerminalPort({
        runtimeRoot,
        platform: process.platform,
        arch: process.arch,
        environment: process.env
      });
      runtimeExecutables ??= createAuditedDesktopDevicePeerRuntimeExecutables({
        runtimeRoot,
        electronExecutable: process.execPath,
        platform: process.platform,
        arch: process.arch,
        environment: process.env
      });
      const [terminals, locatedExecutables] = await Promise.all([terminalPort, runtimeExecutables]);
      return new DesktopDevicePeerAgentExecutor({
        recentDirectoriesPath: join(
          app.getPath("userData"),
          "device-peer-agent",
          "recent-directories.json"
        ),
        terminals,
        runtimeExecutables: locatedExecutables
      });
    },
    readAuthKey: readCredential,
    readRouteAuthorization: readDesktopDevicePeerAgentRouteAuthorization,
    isAuthorityCurrent: isDesktopDevicePeerAgentAuthorityCurrent
  });
  reconcileDesktopDevicePeerAgentLifecycle();
}

function reconcileDesktopDevicePeerAgentLifecycle(): void {
  const connection = managedOrchestratorStatus.state === "ready"
    && managedOrchestratorConnection !== undefined
    && sameManagedOrchestratorConnection(
      managedOrchestratorStatus.connection,
      managedOrchestratorConnection
    )
    && isDesktopDevicePeerAgentAuthorityCurrent(managedOrchestratorConnection)
    ? managedOrchestratorConnection
    : undefined;
  desktopDevicePeerAgentLifecycle?.setConnection(connection);
}

function isDesktopDevicePeerAgentAuthorityCurrent(
  candidate: DesktopManagedOrchestratorConnection
): boolean {
  const runtime = managedOrchestratorRuntime;
  return !quitting
    && !desktopUpdateLifecycleDisposed
    && !managedOrchestratorExitFence.shutdownStarted
    && runtime !== undefined
    && managedOrchestratorStatus.state === "ready"
    && managedOrchestratorConnection !== undefined
    && sameManagedOrchestratorConnection(managedOrchestratorStatus.connection, candidate)
    && sameManagedOrchestratorConnection(managedOrchestratorConnection, candidate)
    && sameManagedOrchestratorConnection(runtime.connection, candidate);
}

async function readDesktopDevicePeerAgentRouteAuthorization(
  profileId: string
): Promise<string | undefined> {
  const runtime = managedOrchestratorRuntime;
  const connection = managedOrchestratorConnection;
  if (runtime === undefined || connection === undefined || connection.profileId !== profileId
    || !isDesktopDevicePeerAgentAuthorityCurrent(connection)
    || !sameManagedOrchestratorConnection(runtime.connection, connection)) return undefined;
  try {
    return runtime.readDesktopHostAuthKey();
  } catch {
    return undefined;
  }
}

function disposeDesktopUpdateLifecycle(): void {
  desktopUpdateLifecycleDisposed = true;
  desktopUpdateStartupPhase = undefined;
  desktopUpdateAutoRelaunchPolicy?.dispose();
  desktopUpdateAutoRelaunchPolicy = undefined;
  desktopUpdateService?.dispose();
}

async function performDesktopCompleteExit(): Promise<void> {
  try {
    // Raising the fence even without a current child covers disabled/remote
    // authority and prevents a concurrent managed initialization during quit.
    await stopManagedOrchestratorForCompleteExit();
  } catch {
    quitting = false;
    await recoverManagedOrchestratorAfterUpdateApplyFailure().catch(() => undefined);
    reconcileDesktopDevicePeerAgentLifecycle();
    reportDesktopCompleteExitFailure("orchestrator-shutdown-failed");
    return;
  }

  let handedOff = false;
  desktopCompleteExitQuitHandoffPending = true;
  try {
    handedOff = await requestDesktopQuitHandoff({
      app,
      onQuitBlocked: subscribeDesktopQuitBlocked
    });
  } finally {
    desktopCompleteExitQuitHandoffPending = false;
  }
  if (handedOff) return;

  // before-quit raises this before renderer beforeunload can cancel app.quit.
  // Clear it before recovery so the exit fence and managed authority restart.
  quitting = false;
  await recoverManagedOrchestratorAfterUpdateApplyFailure().catch(() => undefined);
  reportDesktopCompleteExitFailure("quit-handoff-failed");
}

function reportDesktopCompleteExitFailure(
  reason: "orchestrator-shutdown-failed" | "quit-handoff-failed"
): void {
  const orchestratorShutdownFailed = reason === "orchestrator-shutdown-failed";
  process.stderr.write(orchestratorShutdownFailed
    ? "JOKO_DESKTOP_MANAGED_ORCHESTRATOR_STOP_FAILED\n"
    : "JOKO_DESKTOP_QUIT_HANDOFF_FAILED\n");
  showMainWindow();
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  void dialog.showMessageBox(mainWindow, {
    type: "error",
    title: "Joko could not quit",
    message: orchestratorShutdownFailed
      ? "Joko could not safely finish preparing to quit."
      : "A window did not finish closing.",
    detail: orchestratorShutdownFailed
      ? "Joko was kept open because an active input or local service could not be stopped safely. Resolve the reported issue, then retry complete exit."
      : "Joko was kept open and the local Joko service was restarted. Save or discard pending work, then retry complete exit."
  });
}

function requireDesktopUpdateService(): DesktopUpdateService {
  if (desktopUpdateService === undefined) throw new Error("Desktop update service is not initialized.");
  return desktopUpdateService;
}

async function stopManagedOrchestratorForUpdateApply(): Promise<void> {
  try {
    await stopManagedOrchestratorForCompleteExit();
    // Only the post-stop driver call owns an actual native quit handoff.
    desktopUpdateNativeInstallQuitHandoffPending = true;
  } catch (error) {
    desktopUpdateNativeInstallQuitHandoffPending = false;
    await recoverManagedOrchestratorAfterUpdateApplyFailure().catch(() => undefined);
    reconcileDesktopDevicePeerAgentLifecycle();
    throw error;
  }
}

async function stopManagedOrchestratorForCompleteExit(): Promise<void> {
  globalVoiceExitAdmissionClosed = true;
  globalVoiceSystemAudioOwner = undefined;
  await settleCompleteExitOperations([
    cancelGlobalVoiceForExit,
    () => desktopDevicePeerAgentLifecycle?.stop() ?? Promise.resolve(),
    () => managedOrchestratorExitFence.stop(),
    stopDedicatedHardwareForQuitHandoff,
    () => externalTextInsertionCoordinator.waitForIdle(),
    () => globalVoiceSystemAudio.releaseAll().catch(() => undefined)
  ]);
}

async function recoverManagedOrchestratorAfterUpdateApplyFailure(): Promise<void> {
  const nativeInstallQuitWasPending = desktopUpdateNativeInstallQuitHandoffPending;
  desktopUpdateNativeInstallQuitHandoffPending = false;
  if (nativeInstallQuitWasPending) quitting = false;
  if (quitting || desktopUpdateLifecycleDisposed) return;
  await recoverDedicatedHardwareAfterQuitFailure();
  managedOrchestratorExitFence.releaseForRecovery();
  globalVoiceExitAdmissionClosed = false;
  if (nativeInstallQuitWasPending) showMainWindow();
  if (managedOrchestratorStatus.state === "disabled") return;
  managedOrchestratorConnection = undefined;
  managedOrchestratorStatus = { state: "retryableError", reason: "serviceUnavailable" };
  reconcileDesktopDevicePeerAgentLifecycle();
  await beginManagedOrchestratorInitialization(true, true);
}

function subscribeDesktopQuitBlocked(listener: () => void): () => void {
  desktopQuitBlockedListeners.add(listener);
  return () => desktopQuitBlockedListeners.delete(listener);
}

function notifyDesktopQuitBlocked(): void {
  for (const listener of [...desktopQuitBlockedListeners]) {
    try {
      listener();
    } catch {
      // A failed quit observer cannot force a dirty renderer to unload.
    }
  }
}

function parseDesktopSaveFileRequest(value: unknown): DesktopSaveFileRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Native file save requires an exact request object.");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "bytes,mediaType,name" ||
    typeof candidate["name"] !== "string" ||
    candidate["name"].length < 1 || candidate["name"].length > 255 ||
    candidate["name"].trim() !== candidate["name"] ||
    /[\u0000-\u001f\u007f<>:"\/\\|?*]/u.test(candidate["name"]) ||
    typeof candidate["mediaType"] !== "string" ||
    candidate["mediaType"].length < 1 || candidate["mediaType"].length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(candidate["mediaType"]) ||
    !(candidate["bytes"] instanceof Uint8Array) ||
    candidate["bytes"].byteLength > MAXIMUM_NATIVE_FILE_BYTES) {
    throw new TypeError("Native file save request fields are invalid.");
  }
  return {
    name: candidate["name"],
    mediaType: candidate["mediaType"],
    bytes: new Uint8Array(candidate["bytes"])
  };
}

function desktopFileExtension(name: string): string | undefined {
  const separator = name.lastIndexOf(".");
  if (separator <= 0 || separator === name.length - 1) return undefined;
  const extension = name.slice(separator + 1);
  return /^[a-z0-9]{1,24}$/iu.test(extension) ? extension : undefined;
}

function installMicrophoneLifecycle(): void {
  if (microphoneLifecycleInstalled) return;
  microphoneLifecycleInstalled = true;
  const broadcast = (reason: "system-suspend" | "screen-lock"): void => {
    globalVoiceNativeShortcut.releaseActiveTrigger();
    const contents = mainWindow?.webContents;
    if (contents === undefined || contents.isDestroyed()) return;
    contents.send(DESKTOP_CHANNELS.microphoneRelease, reason);
  };
  const onSuspend = (): void => broadcast("system-suspend");
  const onLockScreen = (): void => broadcast("screen-lock");
  powerMonitor.on("suspend", onSuspend);
  powerMonitor.on("lock-screen", onLockScreen);
  app.once("will-quit", () => {
    powerMonitor.removeListener("suspend", onSuspend);
    powerMonitor.removeListener("lock-screen", onLockScreen);
    microphoneLifecycleInstalled = false;
  });
}

function installProviderModelPowerLifecycle(): void {
  if (providerModelPowerLifecycleInstalled) return;
  providerModelPowerLifecycleInstalled = true;
  const onResume = (): void => providerModelRefreshHostLifecycle.systemResumed();
  const onUnlock = (): void => providerModelRefreshHostLifecycle.screenUnlocked();
  powerMonitor.on("resume", onResume);
  powerMonitor.on("unlock-screen", onUnlock);
  app.once("will-quit", () => {
    powerMonitor.removeListener("resume", onResume);
    powerMonitor.removeListener("unlock-screen", onUnlock);
    providerModelPowerLifecycleInstalled = false;
  });
}

function broadcastProviderModelRefreshLifecycle(
  hint: "system-resume" | "screen-unlock" | "meaningful-foreground"
): void {
  const contents = mainWindow?.webContents;
  if (contents === undefined || contents.isDestroyed()) return;
  contents.send(DESKTOP_CHANNELS.providerModelRefreshLifecycle, hint);
}

function desktopMicrophonePermissionSnapshot(): { readonly status: "granted" | "denied" | "prompt" | "unknown" } {
  if (process.platform !== "darwin" && process.platform !== "win32") return { status: "unknown" };
  try {
    return { status: mapDesktopMicrophonePermissionStatus(systemPreferences.getMediaAccessStatus("microphone")) };
  } catch {
    return { status: "unknown" };
  }
}

async function openDesktopMicrophoneSettings(): Promise<boolean> {
  const url = process.platform === "darwin"
    ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    : process.platform === "win32"
      ? "ms-settings:privacy-microphone"
      : undefined;
  if (url === undefined) return false;
  await shell.openExternal(url);
  return true;
}

function requestingUrlFromPermissionDetails(details: unknown, fallback = ""): string {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return fallback;
  const requestingUrl = (details as Record<string, unknown>)["requestingUrl"];
  if (typeof requestingUrl === "string") return requestingUrl;
  const securityOrigin = (details as Record<string, unknown>)["securityOrigin"];
  return typeof securityOrigin === "string" ? securityOrigin : fallback;
}

function bindDesktopPageSearchResults(contents: WebContents): Map<number, number> {
  const existing = pageSearchTokensByContents.get(contents);
  if (existing !== undefined) return existing;
  const tokens = new Map<number, number>();
  pageSearchTokensByContents.set(contents, tokens);
  if (!pageSearchResultBindings.has(contents)) {
    pageSearchResultBindings.add(contents);
    contents.on("found-in-page", (_event, result) => {
      const requestToken = tokens.get(result.requestId);
      if (requestToken === undefined || contents.isDestroyed() ||
        !Number.isSafeInteger(result.requestId) || result.requestId < 0 ||
        !Number.isSafeInteger(result.matches) || result.matches < 0 ||
        !Number.isSafeInteger(result.activeMatchOrdinal) || result.activeMatchOrdinal < 0) return;
      const projection: DesktopPageSearchResult = {
        requestId: result.requestId,
        requestToken,
        matches: result.matches,
        activeMatchOrdinal: result.activeMatchOrdinal,
        finalUpdate: result.finalUpdate
      };
      contents.send(DESKTOP_CHANNELS.pageSearchResult, projection);
      if (result.finalUpdate) tokens.delete(result.requestId);
    });
    contents.once("destroyed", () => {
      tokens.clear();
      pageSearchTokensByContents.delete(contents);
      pageSearchResultBindings.delete(contents);
    });
  }
  return tokens;
}

function registerIpc(): void {
  ipcMain.on(DESKTOP_CHANNELS.preferredSystemLocaleGet, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) {
      throw new TypeError("Preferred system locale does not accept parameters.");
    }
    event.returnValue = preferredSystemLocale;
  });
  ipcMain.on(DESKTOP_CHANNELS.mainDocumentOccurrenceGet, (event, ...parameters: unknown[]) => {
    event.returnValue = parameters.length === 1 && isDesktopMainDocumentClaim(parameters[0])
      ? captureMainApplicationDocumentOccurrenceForSender(event, parameters[0])
      : undefined;
  });
  ipcMain.handle(DESKTOP_CHANNELS.deepLinkTakePending, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 1) {
      throw new TypeError("Desktop deep-link pull requires its captured Document occurrence.");
    }
    const documentOccurrence = assertCurrentMainApplicationDocumentSender(event, parameters[0]);
    const claim = desktopDeepLinkDelivery.takeAfterRendererReady(documentOccurrence);
    if (claim !== undefined && packagedSmokeSecondInstanceAwaitingAcknowledgement
      && packagedSmokeSecondInstanceDelivery?.deliveryOccurrence === claim.deliveryOccurrence) {
      packagedSmokeSecondInstanceDelivery = Object.freeze({
        deliveryOccurrence: claim.deliveryOccurrence,
        documentOccurrence: claim.documentOccurrence
      });
      recordPackagedSmokeProgress("system_handoff_second_instance_delivery_ready");
    }
    return claim;
  });
  ipcMain.handle(DESKTOP_CHANNELS.deepLinkAcknowledge, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 1) throw new TypeError("Desktop deep-link acknowledgement requires one exact object.");
    const acknowledgement = parseDesktopDeepLinkAcknowledgement(parameters[0]);
    assertCurrentMainApplicationDocumentSender(event, acknowledgement.documentOccurrence);
    const accepted = desktopDeepLinkDelivery.acknowledge(acknowledgement);
    if (accepted && packagedSmokeSecondInstanceAwaitingAcknowledgement
      && packagedSmokeSecondInstanceDelivery?.documentOccurrence !== undefined
      && desktopDeepLinkDeliveryMatchesAcknowledgement(packagedSmokeSecondInstanceDelivery, acknowledgement)) {
      packagedSmokeSecondInstanceAwaitingAcknowledgement = false;
      packagedSmokeSecondInstanceDelivery = undefined;
      packagedSmokeSecondInstanceAcknowledged = true;
      recordPackagedSmokeProgress("system_handoff_second_instance_delivery_acknowledged");
    }
    return accepted;
  });
  ipcMain.handle(DESKTOP_CHANNELS.selectionContextMenuSetLocale, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || !isDesktopLocale(parameters[0])) {
      throw new TypeError("Selection context-menu locale must be en, zh-CN, or en-XA.");
    }
    const locale = parameters[0];
    const localeChanged = applicationMenuLocale !== locale;
    setSelectionContextMenuLocale(locale);
    applicationMenuLocale = locale;
    const overlay = globalVoiceOverlayWindow;
    if (localeChanged && overlay !== undefined && !overlay.isDestroyed() && !overlay.webContents.isDestroyed()) {
      try {
        overlay.webContents.send(DESKTOP_CHANNELS.globalVoiceOverlayLocaleChanged, applicationMenuLocale);
      } catch {
        // Locale is still committed for native surfaces; a retiring overlay cannot observe it.
      }
    }
    if (runtimeProcessMonitorWindow !== undefined && !runtimeProcessMonitorWindow.isDestroyed()) {
      runtimeProcessMonitorWindow.setTitle(runtimeProcessMonitorWindowTitle());
    }
    installDesktopApplicationMenu();
    refreshTrayContextMenu();
  });
  ipcMain.handle(DESKTOP_CHANNELS.applicationMenuConfigure, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Application-menu configuration requires one patch object.");
    const patch = parseMacApplicationMenuConfigurationPatch(parameters[0]);
    const recordingTransition = patch.shortcutRecording === undefined
      ? undefined
      : applicationMenuShortcutRecordingLeases.set(event.sender.id, patch.shortcutRecording);
    const result = applicationMenuConfigurationState.apply(recordingTransition === undefined
      ? patch
      : { ...patch, shortcutRecording: recordingTransition.active });
    if (result.menuChanged) installDesktopApplicationMenu();
    for (const command of result.commands) dispatchApplicationMenuCommand(command);
    if (recordingTransition !== undefined && !recordingTransition.wasActive && recordingTransition.active) {
      await globalVoiceShortcutBinding.suspend(GLOBAL_VOICE_APPLICATION_SHORTCUT_RECORDING_SUSPENSION);
    } else if (recordingTransition !== undefined && recordingTransition.wasActive && !recordingTransition.active) {
      await restoreGlobalVoiceShortcutAfterSuspension(GLOBAL_VOICE_APPLICATION_SHORTCUT_RECORDING_SUSPENSION);
      void globalVoiceShortcutRecovery.request();
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.appGetInfo, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop app info does not accept parameters.");
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      electronVersion: process.versions.electron,
      persistentCredentialStorage: secureStorageAvailable()
    };
  });
  ipcMain.handle(DESKTOP_CHANNELS.sessionWindowOpen, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || !isDesktopSessionWindowOwner(parameters[0])) {
      throw new TypeError("Task window open requires one bounded owner identity.");
    }
    const senderOwner = sessionWindowOwnersByContents.get(event.sender);
    if (!sessionWindowOwnerMayRequest(senderOwner, parameters[0])) {
      throw new Error("Task windows cannot cross their bound profile.");
    }
    return openSessionApplicationWindow(parameters[0]);
  });
  ipcMain.handle(DESKTOP_CHANNELS.sessionWindowGetOwner, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Task window owner does not accept parameters.");
    const owner = sessionWindowOwnersByContents.get(event.sender);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (owner === undefined || window === null || sessionWindows.get(sessionWindowOwnerKey(owner)) !== window) {
      throw new Error("Task window owner is unavailable outside its exact application window.");
    }
    return owner;
  });
  ipcMain.handle(DESKTOP_CHANNELS.extensionWindowOpen, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || !isDesktopExtensionId(parameters[0])) {
      throw new TypeError("Extension window open requires one exact Extension identity.");
    }
    return openExtensionApplicationWindow(parameters[0]);
  });
  ipcMain.handle(DESKTOP_CHANNELS.extensionLibraryPickLocation, async (event, ...parameters: unknown[]) => {
    const owner = assertFocusedTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Extension Library location selection does not accept parameters.");
    const selection = await dialog.showOpenDialog(owner, {
      title: "Choose an Extension Library location",
      properties: ["openDirectory"]
    });
    const selected = selection.canceled ? undefined : selection.filePaths[0];
    return selected === undefined
      ? { cancelled: true as const }
      : { cancelled: false as const, path: resolve(selected) };
  });
  ipcMain.handle(DESKTOP_CHANNELS.projectPickDirectory, async (event, ...parameters: unknown[]) => {
    const owner = assertFocusedTrustedIpcSender(event);
    if (parameters.length !== 1 || !isDesktopProjectDirectoryRequest(parameters[0])) {
      throw new TypeError("Project directory selection requires one managed service identity.");
    }
    const request = parameters[0];
    const ownsWindow = (): boolean => event.sender === mainWindow?.webContents
      || sessionWindowOwnersByContents.get(event.sender)?.profileId === request.profileId;
    const ownsService = (): boolean => projectDirectoryAuthorityMatches(
      request, managedOrchestratorStatus, managedOrchestratorRuntime?.connection,
      managedOrchestratorConnection, managedOrchestratorExitFence.shutdownStarted
    );
    if (!ownsWindow() || !ownsService()) throw new Error("Project directory selection requires the current local service.");
    const selection = await dialog.showOpenDialog(owner, {
      title: "Choose a project directory",
      properties: ["openDirectory"]
    });
    assertTrustedIpcSender(event);
    if (owner.isDestroyed() || !ownsWindow() || !ownsService()) throw new Error("Project directory selection expired.");
    const selected = selection.canceled ? undefined : selection.filePaths[0];
    return selected === undefined
      ? { cancelled: true as const }
      : { cancelled: false as const, path: resolve(selected) };
  });
  ipcMain.handle(DESKTOP_CHANNELS.extensionLibraryReveal, async (event, ...parameters: unknown[]) => {
    assertFocusedTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Extension Library reveal requires one request.");
    const request = parseExtensionLibraryRevealRequest(parameters[0]);
    extensionLibraryGestures.attempt(request.extensionId, "reveal");
    const file = await resolveVerifiedExtensionLibraryFile(request.root, request.path);
    assertFocusedTrustedIpcSender(event);
    shell.showItemInFolder(file.absolutePath);
    return true;
  });
  ipcMain.handle(DESKTOP_CHANNELS.extensionLibraryBeginSave, async (event, ...parameters: unknown[]) => {
    const owner = assertFocusedTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Extension Library save requires one request.");
    const request = parseExtensionLibraryBeginSaveRequest(parameters[0]);
    extensionLibraryGestures.attempt(request.extensionId, "saveAs");
    extensionLibraryGestures.beginSaveDialog();
    let selection: Awaited<ReturnType<typeof dialog.showSaveDialog>>;
    try {
      selection = await dialog.showSaveDialog(owner, {
        title: "Save an Extension Library file",
        defaultPath: request.name,
        ...(desktopFileExtension(request.name) === undefined
          ? {}
          : { filters: [{ name: "Extension Library file", extensions: [desktopFileExtension(request.name)!] }] })
      });
    } finally {
      extensionLibraryGestures.endSaveDialog();
    }
    if (selection.canceled || selection.filePath === undefined) return { cancelled: true as const };
    assertTrustedIpcSender(event);
    trackExtensionLibraryGestureScope(event.sender);
    return {
      cancelled: false as const,
      ticketId: extensionLibraryGestures.issueSaveTicket(event.sender, request.extensionId, resolve(selection.filePath))
    };
  });
  ipcMain.handle(DESKTOP_CHANNELS.extensionLibraryCommitSave, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Extension Library save commit requires one request.");
    const request = parseExtensionLibraryCommitSaveRequest(parameters[0]);
    const destination = extensionLibraryGestures.takeSaveTicket(event.sender, request.extensionId, request.ticketId);
    return atomicCopyExtensionLibraryFile(request.root, request.path, destination);
  });
  ipcMain.handle(DESKTOP_CHANNELS.extensionLibraryCancelSave, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "string") {
      throw new TypeError("Extension Library save cancellation requires one ticket identity.");
    }
    extensionLibraryGestures.cancelSaveTicket(event.sender, parameters[0]);
  });
  ipcMain.handle(DESKTOP_CHANNELS.extensionLibraryClipboardWrite, (event, ...parameters: unknown[]) => {
    assertFocusedTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Extension Library clipboard write requires one request.");
    const request = parseExtensionLibraryClipboardRequest(parameters[0]);
    extensionLibraryGestures.attempt(request.extensionId, "clipboardWrite");
    const image = nativeImage.createFromBuffer(Buffer.from(request.bytes));
    if (image.isEmpty()) throw new TypeError("Extension Library clipboard PNG could not be decoded.");
    assertFocusedTrustedIpcSender(event);
    clipboard.writeImage(image);
    return request.bytes.byteLength;
  });
  ipcMain.handle(DESKTOP_CHANNELS.sessionDragPreviewBegin, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || !isDesktopSessionDragPreviewRequest(parameters[0])) {
      throw new TypeError("Task drag preview requires one exact bounded request.");
    }
    const source = trustedApplicationWindowForContents(event.sender);
    if (source === undefined || source === runtimeProcessMonitorWindow) {
      throw new Error("Task drag preview requires a primary task application window.");
    }
    const senderOwner = sessionWindowOwnersByContents.get(event.sender);
    if (!sessionWindowOwnerMayRequest(senderOwner, {
      profileId: parameters[0].profileId,
      sessionId: parameters[0].sessionId
    })) {
      throw new Error("Task drag preview cannot cross its bound profile.");
    }
    const preview = createNativeSessionDragPreview(source, parameters[0]);
    const started = sessionDragPreviewCoordinator.begin(source, parameters[0], preview);
    if (!started) preview.destroy();
    if (started && process.platform === "darwin") {
      void globalVoiceNativeShortcut.armSessionDragRelease().catch(() => undefined);
    }
    return started;
  });
  ipcMain.handle(DESKTOP_CHANNELS.sessionDragPreviewEnd, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || !isDesktopSessionDragGestureId(parameters[0])) {
      throw new TypeError("Task drag preview end requires one bounded gesture identity.");
    }
    const source = trustedApplicationWindowForContents(event.sender);
    if (source === undefined || source === runtimeProcessMonitorWindow) {
      throw new Error("Task drag preview end requires its primary task application window.");
    }
    return sessionDragPreviewCoordinator.end(source, parameters[0]);
  });
  ipcMain.handle(DESKTOP_CHANNELS.sessionWindowOpenIfDroppedOutside, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || !isDesktopSessionDragGestureId(parameters[0])) {
      throw new TypeError("Task window drop requires one bounded gesture identity.");
    }
    const source = trustedApplicationWindowForContents(event.sender);
    if (source === undefined || source === runtimeProcessMonitorWindow) {
      throw new Error("Task window drop requires its primary task application window.");
    }
    const nativeResult = await sessionDragNativeResultFence.consume(source, parameters[0]);
    if (nativeResult !== undefined) {
      return { opened: true, focusedExisting: nativeResult.focusedExisting } as const;
    }
    const completion = sessionDragPreviewCoordinator.finish(source, parameters[0]);
    if (completion === undefined || completion.kind === "inside") return { opened: false } as const;
    const opened = await openSessionApplicationWindow({
      profileId: completion.profileId,
      sessionId: completion.sessionId
    }, completion.point);
    return { opened: true, focusedExisting: opened.focusedExisting } as const;
  });
  ipcMain.handle(DESKTOP_CHANNELS.runtimeProcessMonitorOpen, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Runtime process monitor open requires one exact owner.");
    const monitorOwner = parseDesktopRuntimeProcessMonitorOwner(parameters[0]);
    const owner = trustedApplicationWindowForContents(event.sender);
    const sessionOwner = sessionWindowOwnersByContents.get(event.sender);
    const allowedOwner = owner === mainWindow || (sessionOwner !== undefined && owner !== undefined &&
      sessionWindows.get(sessionWindowOwnerKey(sessionOwner)) === owner);
    if (!allowedOwner || owner === undefined || owner === runtimeProcessMonitorWindow ||
      (sessionOwner !== undefined && sessionOwner.profileId !== monitorOwner.profileId)) {
      throw new Error("Runtime process monitor can only be opened by a primary application window.");
    }
    return openRuntimeProcessMonitorWindow(owner, monitorOwner);
  });
  ipcMain.handle(DESKTOP_CHANNELS.runtimeProcessMonitorSampleDesktop, async (event, ...parameters: unknown[]) => {
    if (parameters.length !== 0) throw new TypeError("Desktop runtime process sampling does not accept parameters.");
    const source = assertTrustedWindowControlSender(event);
    if (source.isDestroyed() || !source.isVisible() || source.isMinimized()) {
      throw new Error("Desktop runtime process sampling is inactive while its window is hidden.");
    }
    return parseDesktopRuntimeProcessSample(desktopRuntimeProcessSampler.sample());
  });
  ipcMain.handle(DESKTOP_CHANNELS.runtimeProcessDiagnosticsGetOwner, async (event, ...parameters: unknown[]) => {
    assertRuntimeProcessDiagnosticsSender(event);
    if (parameters.length !== 0) throw new TypeError("Runtime diagnostics owner lookup does not accept parameters.");
    return runtimeProcessMonitorBroker.ownerForMonitor(event.sender);
  });
  ipcMain.handle(DESKTOP_CHANNELS.runtimeProcessDiagnosticsRequest, async (event, ...parameters: unknown[]) => {
    assertRuntimeProcessDiagnosticsSender(event);
    if (parameters.length !== 1) throw new TypeError("Runtime diagnostics requires one exact request.");
    const monitorWindow = runtimeProcessMonitorWindowForEvent(event);
    if (monitorWindow === undefined || !monitorWindow.isVisible() || monitorWindow.isMinimized()) {
      throw new Error("Runtime diagnostics sampling is inactive while its window is hidden.");
    }
    const request = parseDesktopRuntimeProcessMonitorRequest(parameters[0]);
    const ownerContents = runtimeProcessMonitorBroker.acceptRequest(event.sender, request);
    if (ownerContents.isDestroyed() || trustedApplicationWindowForContents(ownerContents) === undefined) {
      runtimeProcessMonitorBroker.clearMonitorDocument(event.sender);
      throw new Error("Runtime diagnostics owner is no longer available.");
    }
    try {
      ownerContents.send(DESKTOP_CHANNELS.runtimeProcessMonitorRequest, request);
    } catch (error: unknown) {
      runtimeProcessMonitorBroker.cancelRequest(event.sender, request.requestId);
      throw error;
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.runtimeProcessMonitorRespond, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Runtime process monitor requires one exact response.");
    const response = parseDesktopRuntimeProcessMonitorResponse(parameters[0]);
    const monitorContents = runtimeProcessMonitorBroker.acceptResponse(event.sender, response);
    if (monitorContents.isDestroyed() || runtimeProcessMonitorWindow?.webContents !== monitorContents ||
      !isRuntimeProcessMonitorNavigation(monitorContents.getURL())) {
      throw new Error("Runtime diagnostics window is no longer available.");
    }
    monitorContents.send(DESKTOP_CHANNELS.runtimeProcessDiagnosticsResponse, response);
  });
  ipcMain.on(DESKTOP_CHANNELS.runtimeProcessDiagnosticsRetiredAcknowledge, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 1) return;
    let retirement: ReturnType<typeof parseDesktopRuntimeProcessMonitorRetirement>;
    try { retirement = parseDesktopRuntimeProcessMonitorRetirement(parameters[0]); } catch { return; }
    if (event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed() ||
      !isRuntimeProcessMonitorNavigation(event.sender.getURL())) {
      return;
    }
    const contents = event.sender;
    setImmediate(() => {
      runtimeProcessMonitorRetirementAcknowledgements.acknowledge(
        contents,
        retirement.retirementOccurrence
      );
    });
  });
  ipcMain.handle(DESKTOP_CHANNELS.runtimeProcessMonitorRetire, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Runtime process monitor retirement requires one exact owner.");
    const owner = parseDesktopRuntimeProcessMonitorOwner(parameters[0]);
    const binding = runtimeProcessMonitorBroker.binding;
    if (binding === undefined) return;
    if (binding.ownerEndpoint !== event.sender || !sameDesktopRuntimeProcessMonitorOwner(binding.owner, owner)) {
      throw new Error("Runtime process monitor retirement crossed its owner occurrence.");
    }
    destroyRuntimeProcessMonitorWindow(false);
  });
  ipcMain.handle(DESKTOP_CHANNELS.layoutReset, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Layout reset does not accept parameters.");
    await resetDesktopApplicationLayout(event.sender);
  });
  ipcMain.handle(DESKTOP_CHANNELS.windowInteractionGet, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Window-interaction get does not accept parameters.");
    const store = requireDesktopWindowInteractionSettings();
    await store.initialize();
    return store.get();
  });
  ipcMain.handle(DESKTOP_CHANNELS.mainWindowCloseSettingsGet, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Main-window close settings get does not accept parameters.");
    const store = requireDesktopMainWindowCloseSettings();
    await store.initialize();
    return store.get();
  });
  ipcMain.handle(DESKTOP_CHANNELS.mainWindowCloseSettingsSet, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Main-window close settings set requires one request.");
    const change = parseMainWindowCloseSettingsChange(parameters[0], process.platform);
    const settings = await requireDesktopMainWindowCloseSettings().set(change,
      () => !event.sender.isDestroyed() && canApplyMainWindowClose());
    mainWindowCloseController?.cancelPending();
    broadcastDesktopMainWindowCloseSettings(settings);
    return settings;
  });
  ipcMain.handle(DESKTOP_CHANNELS.windowInteractionSet, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "boolean") {
      throw new TypeError("Window-interaction set requires one boolean.");
    }
    const settings = await requireDesktopWindowInteractionSettings()
      .setSwallowActivationClick(parameters[0]);
    broadcastDesktopWindowInteractionSettings([
      ...applicationWindows(),
      ...(inspectorWindow === undefined ? [] : [inspectorWindow])
    ], DESKTOP_CHANNELS.windowInteractionChanged, settings);
    return settings;
  });
  ipcMain.handle(DESKTOP_CHANNELS.pageSearchStart, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Desktop page search requires one request.");
    const request = parseDesktopPageSearchRequest(parameters[0]);
    const requestTokens = bindDesktopPageSearchResults(event.sender);
    const requestId = event.sender.findInPage(request.text, {
      forward: request.forward,
      findNext: request.findNext
    });
    requestTokens.set(requestId, request.requestToken);
    return requestId;
  });
  ipcMain.handle(DESKTOP_CHANNELS.pageSearchStop, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Desktop page search stop requires one action.");
    const action = parseDesktopPageSearchStopAction(parameters[0]);
    pageSearchTokensByContents.get(event.sender)?.clear();
    event.sender.stopFindInPage(action);
  });
  ipcMain.handle(DESKTOP_CHANNELS.windowMinimize, (event) => {
    assertTrustedWindowControlSender(event).minimize();
  });
  ipcMain.handle(DESKTOP_CHANNELS.windowToggleMaximize, (event) => {
    const window = assertTrustedWindowControlSender(event);
    if (window.isMaximized()) window.unmaximize(); else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle(DESKTOP_CHANNELS.windowToggleFullscreen, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop fullscreen does not accept parameters.");
    const owner = sessionWindowOwnersByContents.get(event.sender);
    const sessionWindow = owner === undefined ? undefined : sessionWindows.get(sessionWindowOwnerKey(owner));
    return toggleApplicationWindowFullscreen(event.sender, BrowserWindow.fromWebContents(event.sender), mainWindow, sessionWindow);
  });
  ipcMain.handle(DESKTOP_CHANNELS.windowClose, async (event, ...parameters: unknown[]) => {
    const window = assertTrustedWindowControlSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop close does not accept parameters.");
    if (window === mainWindow) {
      window.close();
      return;
    }
    if (window === runtimeProcessMonitorWindow) {
      recordPackagedSmokeProgress("runtime_process_monitor_close_ipc_received");
      hideRuntimeProcessMonitorWindow(window, true);
      return;
    }
    const sessionOwner = sessionWindowOwnersByContents.get(event.sender);
    if (sessionOwner !== undefined && sessionWindows.get(sessionWindowOwnerKey(sessionOwner)) === window) {
      window.close();
      return;
    }
    const extensionId = extensionWindowIdsByContents.get(event.sender);
    if (extensionId !== undefined && extensionWindows.get(extensionId) === window) {
      window.close();
      return;
    }
    throw new Error("Desktop close requests are restricted to application windows.");
  });
  ipcMain.handle(DESKTOP_CHANNELS.inspectorWindowActivate, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 0) throw new TypeError("Inspector activation does not accept parameters.");
    assertTrustedIpcSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner === null || owner !== mainWindow || event.sender !== owner.webContents) {
      throw new Error("Inspector activation did not originate from the trusted primary application window.");
    }
    const child = inspectorWindow;
    const lifecycle = inspectorWindowLifecycle;
    if (child === undefined || child.isDestroyed() || inspectorWindowOwner !== owner.webContents ||
      lifecycle === undefined || !lifecycle.owns(owner, child) || BrowserWindow.getFocusedWindow() !== owner) return false;
    return lifecycle.activate(owner, child);
  });
  ipcMain.handle(DESKTOP_CHANNELS.inspectorWindowIdentity, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 0) throw new TypeError("Inspector identity does not accept parameters.");
    assertTrustedInspectorWindowSender(event);
    if (inspectorWindowOccurrence === undefined) {
      throw new Error("Inspector identity is unavailable for a retired occurrence.");
    }
    return inspectorWindowOccurrence;
  });
  ipcMain.handle(DESKTOP_CHANNELS.inspectorWindowReady, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 0) throw new TypeError("Inspector readiness does not accept parameters.");
    const window = assertTrustedInspectorWindowSender(event);
    const lifecycle = inspectorWindowLifecycle;
    if (lifecycle === undefined || !lifecycle.markReady(window)) {
      throw new Error("Inspector readiness did not originate from the current detached Inspector.");
    }
    if (lifecycle.canReveal(window)) {
      window.show();
      window.focus();
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.inspectorWindowMinimize, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 0) throw new TypeError("Inspector minimize does not accept parameters.");
    assertTrustedInspectorWindowSender(event).minimize();
  });
  ipcMain.handle(DESKTOP_CHANNELS.inspectorWindowToggleMaximize, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 0) throw new TypeError("Inspector maximize does not accept parameters.");
    const window = assertTrustedInspectorWindowSender(event);
    if (window.isMaximized()) window.unmaximize(); else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle(DESKTOP_CHANNELS.windowSetZoomFactor, (event, ...parameters: unknown[]) => {
    assertTrustedWindowControlSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "number" || !Number.isFinite(parameters[0])) {
      throw new TypeError("Desktop zoom factor must be one finite number.");
    }
    const zoomFactor = parameters[0];
    if (zoomFactor < 0.5 || zoomFactor > 3 || Math.abs(zoomFactor * 10 - Math.round(zoomFactor * 10)) > Number.EPSILON * 10) {
      throw new RangeError("Desktop zoom factor must be from 0.5 through 3 in 0.1 increments.");
    }
    currentWindowZoomFactor = zoomFactor;
    for (const applicationWindow of applicationWindows()) applicationWindow.webContents.setZoomFactor(zoomFactor);
    if (inspectorWindow !== undefined && !inspectorWindow.isDestroyed()) {
      inspectorWindow.webContents.setZoomFactor(zoomFactor);
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.inspectorWindowClose, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 1 || (parameters[0] !== "user" && parameters[0] !== "passive")) {
      throw new TypeError("Inspector close requires one current-v1 close kind.");
    }
    const window = assertTrustedInspectorWindowSender(event);
    const lifecycle = inspectorWindowLifecycle;
    if (lifecycle === undefined || (parameters[0] === "user"
      ? !lifecycle.markUserClosing(window)
      : !lifecycle.markPassiveClosing(window))) {
      throw new Error("Inspector close did not originate from the current detached Inspector.");
    }
    window.close();
  });
  ipcMain.handle(DESKTOP_CHANNELS.traySetIcon, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 2) {
      throw new TypeError("Desktop tray icon requires one captured occurrence and data URL.");
    }
    assertCurrentMainApplicationDocumentSender(event, parameters[0]);
    ensureTray(trayIconFromDataUrl(parameters[1]));
  });
  ipcMain.handle(DESKTOP_CHANNELS.notify, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 2) {
      throw new TypeError("Desktop notification requires one captured occurrence and notification object.");
    }
    const documentOccurrence = assertCurrentMainApplicationDocumentSender(event, parameters[0]);
    desktopNotifications.show(event.sender, documentOccurrence, parseDesktopNotification(parameters[1]));
  });
  ipcMain.handle(DESKTOP_CHANNELS.attentionMark, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 2) {
      throw new TypeError("Desktop attention mark requires one captured occurrence and exact key.");
    }
    assertCurrentMainApplicationDocumentSender(event, parameters[0]);
    requireDesktopAttentionBadgeController().mark(event.sender.id, parseDesktopAttentionKey(parameters[1]));
  });
  ipcMain.handle(DESKTOP_CHANNELS.attentionClear, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 2) {
      throw new TypeError("Desktop attention clear requires one captured occurrence and exact key.");
    }
    assertCurrentMainApplicationDocumentSender(event, parameters[0]);
    requireDesktopAttentionBadgeController().clear(event.sender.id, parseDesktopAttentionKey(parameters[1]));
  });
  ipcMain.handle(DESKTOP_CHANNELS.dedicatedHardwareGetState, (event, ...parameters: unknown[]) => {
    assertDedicatedHardwareSender(event);
    if (parameters.length !== 0) throw new TypeError("Dedicated hardware state does not accept parameters.");
    return requireDedicatedHardwareController().snapshot();
  });
  ipcMain.handle(DESKTOP_CHANNELS.dedicatedHardwareSetSettings, async (event, ...parameters: unknown[]) => {
    assertDedicatedHardwareSender(event, { focused: true });
    if (parameters.length !== 1) throw new TypeError("Dedicated hardware settings require one request.");
    const request = parseDedicatedHardwareSettingsRequest(parameters[0]);
    dedicatedHardwareTaskFocusFence.clear();
    return requireDedicatedHardwareController().setSettings(request.model, request.settings);
  });
  ipcMain.handle(DESKTOP_CHANNELS.dedicatedHardwareResetSettings, async (event, ...parameters: unknown[]) => {
    assertDedicatedHardwareSender(event, { focused: true });
    if (parameters.length !== 1) throw new TypeError("Dedicated hardware reset requires one request.");
    const request = parseDedicatedHardwareResetRequest(parameters[0]);
    dedicatedHardwareTaskFocusFence.clear();
    return requireDedicatedHardwareController().resetSettings(request.model, request.scope);
  });
  ipcMain.handle(DESKTOP_CHANNELS.dedicatedHardwareProbe, (event, ...parameters: unknown[]) => {
    assertDedicatedHardwareSender(event, { focused: true });
    if (parameters.length !== 1) throw new TypeError("Dedicated hardware probe requires one request.");
    const model = parseDedicatedHardwareModelRequest(parameters[0]);
    const controller = requireDedicatedHardwareController();
    controller.probe(model);
    return controller.snapshot();
  });
  ipcMain.handle(DESKTOP_CHANNELS.dedicatedHardwareRecoverKeymap, async (event, ...parameters: unknown[]) => {
    assertDedicatedHardwareSender(event, { focused: true });
    if (parameters.length !== 1) throw new TypeError("Dedicated hardware keymap recovery requires one request.");
    const model = parseDedicatedHardwareKeymapRecoveryRequest(parameters[0]);
    dedicatedHardwareTaskFocusFence.clear();
    return requireDedicatedHardwareController().recoverKeymap(model);
  });
  ipcMain.handle(DESKTOP_CHANNELS.dedicatedHardwareSetPreview, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 1) throw new TypeError("Dedicated hardware preview requires one request.");
    const request = parseDedicatedHardwarePreviewRequest(parameters[0]);
    assertDedicatedHardwareSender(event, { focused: request.enabled });
    dedicatedHardwareTaskFocusFence.clear();
    requireDedicatedHardwareController().setPreview(request.model, event.sender, request.enabled);
  });
  ipcMain.handle(DESKTOP_CHANNELS.dedicatedHardwarePublishTasks, (event, ...parameters: unknown[]) => {
    assertDedicatedHardwareSender(event, { mainOnly: true });
    if (parameters.length !== 2) throw new TypeError("Dedicated hardware tasks require their current Document and catalog.");
    const documentOccurrence = assertCurrentMainApplicationDocumentSender(event, parameters[0]);
    const owner = dedicatedHardwareCatalogOwner;
    if (owner === undefined || owner.contents !== event.sender || owner.documentOccurrence !== documentOccurrence) {
      throw new Error("Dedicated hardware tasks require their current Document owner.");
    }
    requireDedicatedHardwareController().publishTasks(parameters[1], owner);
  });
  ipcMain.handle(DESKTOP_CHANNELS.dedicatedHardwareAcknowledgeTaskFocus, (event, ...parameters: unknown[]) => {
    const owner = assertDedicatedHardwareSender(event, { mainOnly: true });
    if (parameters.length !== 1) throw new TypeError("Dedicated hardware task focus requires one acknowledgement.");
    const acknowledgement = parseDedicatedHardwareTaskFocusAcknowledgement(parameters[0]);
    if (!dedicatedHardwareTaskFocusFence.consume(
      event.sender,
      acknowledgement.focusRequestId,
      acknowledgement.task
    )) return false;
    if (!isDedicatedHardwareActionWindowReady(owner) || owner !== mainWindow) return false;
    owner.show();
    owner.focus();
    return true;
  });
  ipcMain.handle(DESKTOP_CHANNELS.dedicatedHardwareOpenInputSettings, (event, ...parameters: unknown[]) => {
    assertDedicatedHardwareSender(event, { focused: true });
    if (parameters.length !== 0) throw new TypeError("Dedicated hardware input settings do not accept parameters.");
    return openGlobalVoiceInputMonitoringSettings();
  });
  ipcMain.on(DESKTOP_CHANNELS.nativeTaskStatusGetAvailability, (event) => {
    event.returnValue = nativeTaskStatusSupported;
  });
  ipcMain.handle(DESKTOP_CHANNELS.nativeTaskStatusGetSettings, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Native task-status settings get does not accept parameters.");
    const store = requireDesktopNativeTaskStatusSettings();
    await store.initialize();
    return store.get();
  });
  ipcMain.handle(DESKTOP_CHANNELS.nativeTaskStatusSetSettings, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Native task-status settings require one exact object.");
    return commitDesktopNativeTaskStatusSettings(parseDesktopNativeTaskStatusSettings(parameters[0]));
  });
  ipcMain.handle(DESKTOP_CHANNELS.nativeTaskStatusGetDisplays, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Native task-status displays do not accept parameters.");
    if (!nativeTaskStatusSupported) throw new Error("Native task status is not supported on this system.");
    return desktopNativeTaskStatusDisplays();
  });
  ipcMain.handle(DESKTOP_CHANNELS.nativeTaskStatusPreviewSound, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Native task-status sound preview requires one exact choice.");
    if (!nativeTaskStatusSupported) throw new Error("Native task status is not supported on this system.");
    await playDesktopNativeTaskStatusSound(parseDesktopNativeTaskStatusSoundChoice(parameters[0]));
  });
  ipcMain.handle(DESKTOP_CHANNELS.nativeTaskStatusSelectSoundFile, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Native task-status sound selection does not accept parameters.");
    if (!nativeTaskStatusSupported) throw new Error("Native task status is not supported on this system.");
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const options: OpenDialogOptions = {
      properties: ["openFile"],
      filters: [{ name: "Audio", extensions: ["mp3", "wav", "wave", "aiff", "aif", "m4a", "caf"] }]
    };
    const result = owner === undefined || owner.isDestroyed()
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(owner, options);
    const path = result.canceled ? null : result.filePaths[0] ?? null;
    return Object.freeze({ path, name: path === null ? null : basename(path) });
  });
  ipcMain.handle(DESKTOP_CHANNELS.nativeTaskStatusPublish, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (event.sender !== mainWindow?.webContents) {
      throw new Error("Native task-status publication is restricted to the owner window.");
    }
    if (parameters.length !== 1) throw new TypeError("Native task-status publication requires one snapshot.");
    if (!nativeTaskStatusSupported || macNativeTaskStatusHost === undefined) {
      throw new Error("Native task status is not supported on this system.");
    }
    macNativeTaskStatusHost.publish(parseDesktopNativeTaskStatusSnapshot(parameters[0]));
  });
  ipcMain.handle(DESKTOP_CHANNELS.nativeTaskStatusSetVisibleSessions, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (event.sender !== mainWindow?.webContents && !sessionWindowOwnersByContents.has(event.sender)) {
      throw new Error("Native task-status visibility is restricted to application task windows.");
    }
    if (parameters.length !== 1) {
      throw new TypeError("Native task-status visibility requires one task-identity list.");
    }
    if (!nativeTaskStatusSupported || macNativeTaskStatusHost === undefined) {
      throw new Error("Native task status is not supported on this system.");
    }
    setDesktopNativeTaskStatusVisibility(
      event.sender,
      parseDesktopNativeTaskStatusVisibleSessionIds(parameters[0])
    );
  });
  ipcMain.handle(DESKTOP_CHANNELS.keepAwakeGet, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop keep-awake get does not accept parameters.");
    return requireDesktopKeepAwakeCoordinator().get();
  });
  ipcMain.handle(DESKTOP_CHANNELS.keepAwakeSet, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "boolean") {
      throw new TypeError("Desktop keep-awake set requires one boolean.");
    }
    const result = await requireDesktopKeepAwakeCoordinator().setEnabled(parameters[0]);
    return result.settings;
  });
  ipcMain.handle(DESKTOP_CHANNELS.microphoneGetPermission, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop microphone permission does not accept parameters.");
    return desktopMicrophonePermissionSnapshot();
  });
  ipcMain.handle(DESKTOP_CHANNELS.microphoneOpenSettings, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop microphone settings do not accept parameters.");
    return openDesktopMicrophoneSettings();
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceSetShortcut, (event, ...parameters: unknown[]) => {
    assertGlobalVoiceSettingsSender(event);
    if (parameters.length !== 1) throw new TypeError("Global voice shortcut requires one preference.");
    return registerGlobalVoiceShortcut(parameters[0]);
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceShortcutCaptureStart, (event, ...parameters: unknown[]) => {
    assertGlobalVoiceSettingsSender(event);
    if (parameters.length !== 0) throw new TypeError("Global voice shortcut capture does not accept parameters.");
    return startGlobalVoiceShortcutCapture(event.sender);
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceShortcutCaptureStop, (event, ...parameters: unknown[]) => {
    assertGlobalVoiceSettingsSender(event);
    if (parameters.length !== 0) throw new TypeError("Global voice shortcut capture does not accept parameters.");
    stopGlobalVoiceShortcutCapture(event.sender);
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceConsumeShortcutRecoveryFailure, (event, ...parameters: unknown[]) => {
    assertGlobalVoiceOwnerSender(event);
    if (parameters.length !== 0) throw new TypeError("Global voice shortcut recovery status does not accept parameters.");
    return consumeGlobalVoiceShortcutRecoveryFailure(event.sender);
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceSetMuteSystemAudio, (event, ...parameters: unknown[]) => {
    assertGlobalVoiceOwnerSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "boolean") {
      throw new TypeError("System audio preference requires one boolean.");
    }
    setGlobalVoiceMuteSystemAudio(parameters[0]);
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoicePublishStatus, (event, ...parameters: unknown[]) => {
    assertGlobalVoiceOwnerSender(event);
    if (parameters.length !== 1) throw new TypeError("Global voice status requires one projection.");
    const status = parseDesktopGlobalVoiceStatus(parameters[0]);
    const generation = Number(status.generation);
    if (status.state === "idle") {
      if (generation > 0) resetGlobalVoicePresentation(generation);
      return;
    }
    const recording = globalVoiceInputLease.snapshot();
    if (recording.state === "idle" || recording.generation !== generation
      || globalVoiceActiveGeneration !== generation) return;
    if (status.state === "error") {
      if (failGlobalVoiceGeneration(generation, status.errorKind)) showGlobalVoiceOverlay();
      return;
    }
    if (globalVoiceCancellingGeneration === generation) return;
    if (!mayAcceptGlobalVoiceStatus(status)) return;
    setGlobalVoiceStatus(status);
    showGlobalVoiceOverlay();
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceCommit, async (event, ...parameters: unknown[]) => {
    assertGlobalVoiceOwnerSender(event);
    if (parameters.length !== 1) throw new TypeError("Global voice commit requires one result.");
    const request = parseDesktopGlobalVoiceCommitRequest(parameters[0]);
    if (globalVoiceAdmissionUnavailable()) return false;
    const generation = Number(request.generation);
    const recording = globalVoiceInputLease.snapshot();
    const fence = globalVoiceCommitFence;
    if (globalVoiceActiveGeneration !== generation || recording.state === "idle"
      || recording.generation !== generation || fence?.generation !== generation
      || fence.state !== "open") return false;
    fence.state = "pending";
    const hardwareVoice = recording.source === "hardware";
    const systemVoice = dedicatedHardwareSystemVoiceController;
    if (hardwareVoice && (systemVoice === undefined || !systemVoice.hasTargetForActiveRecording())) {
      fence.state = "consumed";
      failGlobalVoiceGeneration(generation, "insertion");
      return false;
    }
    setGlobalVoiceStatus({
      state: "submitting",
      generation: request.generation,
      transcript: request.text.slice(0, 4_096)
    });
    try {
      const result = hardwareVoice
        ? await externalTextInsertionCoordinator.insertCaptured(request.text, {
          clipboard,
          paste: () => systemVoice!.postPasteForActiveRecording()
        })
        : await externalTextInsertionCoordinator.insertForeground(request.text, {
          clipboard,
          platform: process.platform,
          runCommand: runBoundedHostCommand
        });
      // A paste is not complete until the process-wide clipboard transaction
      // either restores the prior owner or observes that a new owner replaced
      // it. Restoration failure keeps the coordinator unavailable.
      await result.restored;
      if (!globalVoiceGenerationIsCurrent(generation)
        || globalVoiceActiveGeneration !== generation
        || globalVoiceCommitFence !== fence
        || fence.state !== "pending") return false;
      if (!result.inserted) {
        fence.state = "consumed";
        failGlobalVoiceGeneration(generation, "insertion");
        return false;
      }
      fence.state = "consumed";
      return resetGlobalVoicePresentation(generation);
    } catch {
      if (globalVoiceGenerationIsCurrent(generation)
        && globalVoiceActiveGeneration === generation
        && globalVoiceCommitFence === fence
        && fence.state === "pending") {
        fence.state = "consumed";
        failGlobalVoiceGeneration(generation, "insertion");
      }
      return false;
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceGetAccessibility, (event, ...parameters: unknown[]) => {
    assertGlobalVoiceSettingsSender(event);
    if (parameters.length !== 0) throw new TypeError("Global voice accessibility status does not accept parameters.");
    return globalVoiceAccessibilitySnapshot();
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceOpenAccessibility, async (event, ...parameters: unknown[]) => {
    assertGlobalVoiceSettingsSender(event);
    if (parameters.length !== 0) throw new TypeError("Global voice accessibility settings do not accept parameters.");
    return openGlobalVoiceAccessibilitySettings();
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceGetInputMonitoring, (event, ...parameters: unknown[]) => {
    assertGlobalVoiceSettingsSender(event);
    if (parameters.length !== 0) throw new TypeError("Global voice input monitoring status does not accept parameters.");
    return globalVoiceInputMonitoringSnapshot();
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceOpenInputMonitoring, (event, ...parameters: unknown[]) => {
    assertFocusedGlobalVoiceSettingsSender(event);
    if (parameters.length !== 0) throw new TypeError("Global voice input monitoring settings do not accept parameters.");
    return openGlobalVoiceInputMonitoringSettings();
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceGetStatus, (event, ...parameters: unknown[]) => {
    assertGlobalVoiceOverlaySender(event);
    if (parameters.length !== 0) throw new TypeError("Global voice overlay status does not accept parameters.");
    return globalVoiceStatus;
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceOverlayGetLocale, (event, ...parameters: unknown[]) => {
    assertGlobalVoiceOverlaySender(event);
    if (parameters.length !== 0) throw new TypeError("Global voice overlay locale does not accept parameters.");
    return applicationMenuLocale;
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceOverlayAction, (event, ...parameters: unknown[]) => {
    assertGlobalVoiceOverlaySender(event);
    if (parameters.length !== 1 || (parameters[0] !== "cancel" && parameters[0] !== "retry")) {
      throw new TypeError("Global voice overlay action is invalid.");
    }
    if (parameters[0] === "cancel") {
      const recording = globalVoiceInputLease.snapshot();
      if (recording.state !== "idle") {
        globalVoiceInputLease.cancelAll();
      } else {
        const generation = currentGlobalVoiceGeneration();
        if (generation !== undefined) resetGlobalVoicePresentation(generation);
      }
      return;
    }
    const retry = globalVoiceRetry;
    if (retry === undefined || retry.source !== "shortcut"
      || globalVoiceStatus.state !== "error"
      || globalVoiceStatus.generation !== globalVoiceGenerationValue(retry.failedGeneration)
      || globalVoiceInputLease.snapshot().state !== "idle") return;
    const pressed = pressGlobalVoiceInput("shortcut");
    if (!pressed.accepted || pressed.effect !== "start") return;
    globalVoiceStartModes.set(pressed.lease.recordingGeneration, "retry");
    globalVoiceInputLease.release(pressed.lease, "tap");
  });
  ipcMain.handle(DESKTOP_CHANNELS.chooseFiles, async (event) => {
    assertTrustedIpcSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = { properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections"> };
    const selection = owner === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(owner, options);
    if (selection.canceled) return [];
    if (selection.filePaths.length > MAXIMUM_ATTACHMENT_FILES) {
      throw new Error(`No more than ${MAXIMUM_ATTACHMENT_FILES} attachments may be selected at once.`);
    }
    const files = [];
    let batchBytes = 0;
    for (const path of selection.filePaths) {
      const bytes = await readRegularFileSnapshot(path, MAXIMUM_ATTACHMENT_BYTES);
      batchBytes += bytes.byteLength;
      if (batchBytes > MAXIMUM_ATTACHMENT_BATCH_BYTES) {
        throw new Error("The selected attachment batch exceeds 256 MiB.");
      }
      files.push({
        name: basename(path) || "attachment",
        mediaType: mediaTypeForPath(path),
        bytes
      });
    }
    return files;
  });
  ipcMain.handle(DESKTOP_CHANNELS.choosePortableSessionFile, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Portable task package selection does not accept parameters.");
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = {
      properties: ["openFile"] as Array<"openFile">,
      filters: [{ name: "Joko task package", extensions: ["jshare"] }]
    };
    const selection = owner === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(owner, options);
    const path = selection.canceled ? undefined : selection.filePaths[0];
    if (path === undefined) return undefined;
    return {
      name: basename(path) || "task.jshare",
      mediaType: "application/vnd.joko.session",
      bytes: await readRegularFileSnapshot(path, MAXIMUM_NATIVE_FILE_BYTES)
    };
  });
  ipcMain.handle(DESKTOP_CHANNELS.saveFile, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Native file save requires one request object.");
    const request = parseDesktopSaveFileRequest(parameters[0]);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const extension = desktopFileExtension(request.name);
    const options = {
      defaultPath: request.name,
      ...(extension === undefined ? {} : { filters: [{ name: "Joko file", extensions: [extension] }] })
    };
    const selection = owner === undefined
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(owner, options);
    if (selection.canceled || selection.filePath === undefined) return false;
    await atomicWriteUserSelectedFile(selection.filePath, request.bytes, MAXIMUM_NATIVE_FILE_BYTES);
    return true;
  });
  ipcMain.handle(DESKTOP_CHANNELS.copyFile, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Native file copy requires one request object.");
    nativeFileClipboard ??= new NativeFileClipboard({ directory: join(app.getPath("userData"), "clipboard-files"), platform: process.platform });
    return nativeFileClipboard.copy(parameters[0], nativeFileActionScope(event));
  });
  ipcMain.handle(DESKTOP_CHANNELS.cancelFileCopy, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "string") throw new TypeError("Native file copy cancellation requires one identity.");
    const scope = nativeFileActionScopes.get(event.sender);
    if (scope !== undefined) nativeFileClipboard?.cancel(parameters[0], scope.id);
  });
  ipcMain.handle(DESKTOP_CHANNELS.openFile, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Native file open requires one request object.");
    nativeFileOpener ??= new NativeFileOpener({
      directory: join(app.getPath("userData"), "opened-files"),
      openPath: (path) => shell.openPath(path)
    });
    return nativeFileOpener.open(parameters[0], nativeFileActionScope(event));
  });
  ipcMain.handle(DESKTOP_CHANNELS.cancelFileOpen, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "string") throw new TypeError("Native file open cancellation requires one identity.");
    const scope = nativeFileActionScopes.get(event.sender);
    if (scope !== undefined) nativeFileOpener?.cancel(parameters[0], scope.id);
  });
  ipcMain.handle(DESKTOP_CHANNELS.revealArtifactSource, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Artifact source reveal requires one request object.");
    nativeArtifactSourceRevealer ??= new NativeArtifactSourceRevealer({
      resolvePath: async (request, signal) => {
        const runtime = managedOrchestratorRuntime;
        const connection = managedOrchestratorConnection;
        if (runtime === undefined || connection === undefined || managedOrchestratorStatus.state !== "ready" ||
          request.profileId !== connection.profileId || request.serverId !== connection.serverId ||
          !sameManagedOrchestratorConnection(runtime.connection, connection) ||
          managedOrchestratorExitFence.shutdownStarted) {
          throw new Error("Managed Artifact source authority is unavailable.");
        }
        return resolveManagedArtifactSource({
          connection,
          sessionId: request.sessionId,
          artifactId: request.artifactId,
          signal,
          readAuthKey: readCredential,
          readDesktopHostAuthKey: runtime.readDesktopHostAuthKey,
          isAuthorityCurrent: (candidate) => managedOrchestratorStatus.state === "ready" &&
            managedOrchestratorRuntime === runtime && managedOrchestratorConnection === connection &&
            !managedOrchestratorExitFence.shutdownStarted &&
            sameManagedOrchestratorConnection(managedOrchestratorStatus.connection, candidate) &&
            sameManagedOrchestratorConnection(connection, candidate) &&
            sameManagedOrchestratorConnection(runtime.connection, candidate)
        });
      },
      revealPath: (path) => shell.showItemInFolder(path)
    });
    return nativeArtifactSourceRevealer.reveal(parameters[0], nativeFileActionScope(event));
  });
  ipcMain.handle(DESKTOP_CHANNELS.cancelArtifactSourceReveal, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "string") {
      throw new TypeError("Artifact source reveal cancellation requires one identity.");
    }
    const scope = nativeFileActionScopes.get(event.sender);
    if (scope !== undefined) nativeArtifactSourceRevealer?.cancel(parameters[0], scope.id);
  });
  ipcMain.handle(DESKTOP_CHANNELS.discoveryScan, async (event) => {
    assertTrustedIpcSender(event);
    return runDiscoveryScan();
  });
  ipcMain.handle(DESKTOP_CHANNELS.managedOrchestratorGetConnection, (event) => {
    assertTrustedIpcSender(event);
    return managedOrchestratorConnection;
  });
  ipcMain.handle(DESKTOP_CHANNELS.managedOrchestratorGetStatus, (event) => {
    assertTrustedIpcSender(event);
    return managedOrchestratorStatus;
  });
  ipcMain.handle(DESKTOP_CHANNELS.managedOrchestratorRetry, async (event) => {
    assertTrustedIpcSender(event);
    // Renderer transport failures can occur after Desktop previously reached
    // ready. A user retry must therefore re-probe/respawn the managed service,
    // not merely echo a stale ready snapshot.
    return beginManagedOrchestratorInitialization(true);
  });
  ipcMain.handle(DESKTOP_CHANNELS.managedOrchestratorAdoptConnection, async (event, connection: DesktopManagedOrchestratorConnection) => {
    assertTrustedIpcSender(event);
    return adoptManagedOrchestratorConnection(connection);
  });
  ipcMain.handle(DESKTOP_CHANNELS.managedOrchestratorCompleteLogout, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Managed Orchestrator logout completion does not accept parameters.");
    return completeCurrentManagedOrchestratorLogout();
  });
  ipcMain.handle(DESKTOP_CHANNELS.credentialGet, async (event, profileId: string) => {
    assertTrustedIpcSender(event);
    return readCredential(profileId);
  });
  ipcMain.handle(DESKTOP_CHANNELS.credentialSet, async (event, profileId: string, secret: string) => {
    assertTrustedIpcSender(event);
    validateProfileId(profileId);
    validateCredentialSecret(secret);
    if (!secureStorageAvailable()) {
      volatileCredentials.set(profileId, secret);
      return;
    }
    volatileCredentials.delete(profileId);
    const encrypted = safeStorage.encryptString(secret);
    try {
      await atomicWritePrivateFile(credentialPath(profileId), encrypted);
    } finally {
      encrypted.fill(0);
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.credentialDelete, async (event, profileId: string) => {
    assertTrustedIpcSender(event);
    validateProfileId(profileId);
    if (managedOrchestratorConnection?.profileId === profileId) {
      desktopDevicePeerAgentLifecycle?.setConnection(undefined);
    }
    try {
      await deleteCredential(profileId);
    } catch (error) {
      reconcileDesktopDevicePeerAgentLifecycle();
      throw error;
    }
    if (managedOrchestratorConnection?.profileId === profileId) {
      managedOrchestratorRecoveryTarget = managedOrchestratorConnection;
      managedOrchestratorConnection = undefined;
      managedOrchestratorStatus = managedOrchestratorRecovery("credentialUnavailable");
      reconcileDesktopDevicePeerAgentLifecycle();
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.openExternal, async (event, value: string) => {
    assertTrustedIpcSender(event);
    await openExternalSafely(value);
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateGetStatus, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop update status does not accept parameters.");
    return desktopUpdateStatusForRenderer(requireDesktopUpdateService().getStatus());
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateCheck, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop update check does not accept parameters.");
    return checkDesktopUpdateFromRenderer();
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateRelaunch, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Desktop update relaunch requires one policy object.");
    const request = parseDesktopUpdateRelaunchRequest(parameters[0]);
    return requestDesktopUpdateRelaunch(request.allowBusy);
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateStartupRelaunch, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop startup update relaunch does not accept parameters.");
    return requestDesktopStartupRelaunch();
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateStartupRetry, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop startup update retry does not accept parameters.");
    if (desktopUpdateStartupPhase === undefined) return { status: "up-to-date" };
    return checkDesktopUpdateFromRenderer();
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateAutoRelaunchSettingsGet, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop auto relaunch settings get does not accept parameters.");
    const store = requireDesktopUpdateAutoSettings();
    await store.initialize();
    return store.get();
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateAutoRelaunchSettingsSet, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "object" || parameters[0] === null ||
      Array.isArray(parameters[0]) || Object.keys(parameters[0]).join(",") !== "autoRelaunchOnIdle" ||
      typeof (parameters[0] as Record<string, unknown>)["autoRelaunchOnIdle"] !== "boolean") {
      throw new TypeError("Desktop auto relaunch settings require one exact boolean object.");
    }
    const result = await requireDesktopUpdateAutoSettings().setAutoRelaunchOnIdle(
      (parameters[0] as { readonly autoRelaunchOnIdle: boolean }).autoRelaunchOnIdle
    );
    broadcastDesktopUpdateSettings(applicationWindows(), DESKTOP_CHANNELS.updateAutoRelaunchSettingsChanged, result);
    void desktopUpdateAutoRelaunchPolicy?.evaluate("settings-set");
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateAutoRelaunchSettingsReset, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop auto relaunch settings reset does not accept parameters.");
    const result = await requireDesktopUpdateAutoSettings().reset();
    broadcastDesktopUpdateSettings(applicationWindows(), DESKTOP_CHANNELS.updateAutoRelaunchSettingsChanged, result);
    void desktopUpdateAutoRelaunchPolicy?.evaluate("settings-reset");
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateChannelSettingsGet, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop update channel settings get does not accept parameters.");
    const store = requireDesktopUpdateChannelSettings();
    await store.initialize();
    return store.get();
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateChannelSettingsSet, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "object" || parameters[0] === null ||
      Array.isArray(parameters[0]) || Object.keys(parameters[0]).join(",") !== "enableBeta" ||
      typeof (parameters[0] as Record<string, unknown>)["enableBeta"] !== "boolean") {
      throw new TypeError("Desktop beta-channel settings require one exact boolean object.");
    }
    const enableBeta = (parameters[0] as { readonly enableBeta: boolean }).enableBeta;
    if (app.isPackaged && (enableBeta ? desktopUpdateBetaFeedUrl : desktopUpdateReleaseFeedUrl) === undefined) {
      throw new Error("The selected Desktop update channel is not configured.");
    }
    return writeDesktopUpdateChannelSettings((store) => store.setEnableBeta(enableBeta));
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateChannelSettingsReset, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop update channel settings reset does not accept parameters.");
    if (app.isPackaged && desktopUpdateReleaseFeedUrl === undefined) {
      throw new Error("The release Desktop update channel is not configured.");
    }
    return writeDesktopUpdateChannelSettings((store) => store.reset());
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateChannelProbeBeta, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop beta-channel probe does not accept parameters.");
    return Object.freeze({ available: await probeDesktopBetaUpdateChannel() });
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateChannelRelaunch, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Desktop update channel relaunch requires one policy object.");
    const request = parseDesktopUpdateRelaunchRequest(parameters[0]);
    return requestDesktopUpdateChannelRelaunch(request.allowBusy);
  });
}

function parseDesktopUpdateRelaunchRequest(value: unknown): DesktopUpdateRelaunchRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).join(",") !== "allowBusy" ||
    typeof (value as Record<string, unknown>)["allowBusy"] !== "boolean") {
    throw new TypeError("Desktop update relaunch policy must be an exact boolean object.");
  }
  return { allowBusy: (value as { readonly allowBusy: boolean }).allowBusy };
}

function requireDesktopUpdateAutoSettings(): DesktopUpdateAutoSettingsStore {
  if (desktopUpdateAutoSettings === undefined) throw new Error("Desktop update settings are not initialized.");
  return desktopUpdateAutoSettings;
}

function requireDesktopUpdateChannelSettings(): DesktopUpdateChannelSettingsStore {
  if (desktopUpdateChannelSettings === undefined) {
    throw new Error("Desktop update channel settings are not initialized.");
  }
  return desktopUpdateChannelSettings;
}

function requireDesktopKeepAwakeCoordinator(): DesktopKeepAwakeSettingsCoordinator {
  if (desktopKeepAwakeCoordinator === undefined) {
    throw new Error("Desktop keep-awake settings are not initialized.");
  }
  return desktopKeepAwakeCoordinator;
}

function requireDesktopWindowInteractionSettings(): DesktopWindowInteractionSettingsStore {
  if (desktopWindowInteractionSettings === undefined) {
    throw new Error("Desktop window-interaction settings are not initialized.");
  }
  return desktopWindowInteractionSettings;
}

function requireDesktopMainWindowCloseSettings(): DesktopMainWindowCloseSettingsStore {
  if (desktopMainWindowCloseSettings === undefined) throw new Error("Main-window close settings are not initialized.");
  return desktopMainWindowCloseSettings;
}

async function runDiscoveryScan(): Promise<readonly DesktopDiscoveredNode[]> {
  if (activeDiscoveryScan !== undefined) return activeDiscoveryScan;
  const controller = new AbortController();
  const scan = scanLanOrchestratorNodes({ signal: controller.signal });
  activeDiscoveryAbort = controller;
  activeDiscoveryScan = scan;
  try {
    return await scan;
  } finally {
    if (activeDiscoveryScan === scan) {
      activeDiscoveryScan = undefined;
      activeDiscoveryAbort = undefined;
    }
  }
}

function beginManagedOrchestratorInitialization(
  forceProbe = false,
  controlledStopConfirmed = false
): Promise<DesktopManagedOrchestratorStatus> {
  if (quitting || desktopUpdateLifecycleDisposed) return Promise.resolve(managedOrchestratorStatus);
  if (managedOrchestratorExplicitlyLoggedOut) return Promise.resolve({ state: "disabled" });
  if (managedOrchestratorStatus.state === "disabled") return Promise.resolve(managedOrchestratorStatus);
  if (desktopUpdateStartupPhase !== undefined && !controlledStopConfirmed) {
    return Promise.resolve(managedOrchestratorStatus);
  }
  if (managedOrchestratorInitialization !== undefined) return managedOrchestratorInitialization;
  try {
    managedOrchestratorExitFence.assertInitializationAllowed();
  } catch (error) {
    return Promise.reject(error);
  }
  if (managedOrchestratorStatus.state === "ready" && !forceProbe) return Promise.resolve(managedOrchestratorStatus);
  managedOrchestratorConnection = undefined;
  managedOrchestratorStatus = { state: "starting" };
  reconcileDesktopDevicePeerAgentLifecycle();
  const attempt = initializeManagedOrchestrator(controlledStopConfirmed).then<DesktopManagedOrchestratorStatus>(() => {
    const connection = managedOrchestratorConnection;
    if (connection === undefined) return { state: "retryableError", reason: "startFailed" };
    return { state: "ready", connection };
  }).catch((error: unknown): DesktopManagedOrchestratorStatus => {
    if (error instanceof ManagedOrchestratorInitializationError) return error.status;
    if (error instanceof ManagedOrchestratorAuthorizationUnavailableError) {
      return managedOrchestratorRecovery("credentialUnavailable");
    }
    return { state: "retryableError", reason: "startFailed" };
  }).then((status) => {
    managedOrchestratorStatus = status;
    reconcileDesktopDevicePeerAgentLifecycle();
    refreshTrayContextMenu();
    if (status.state !== "ready") {
      process.stderr.write(`JOKO_DESKTOP_MANAGED_ORCHESTRATOR_UNAVAILABLE ${status.state}:${"reason" in status ? status.reason : "unknown"}\n`);
    }
    return status;
  });
  managedOrchestratorInitialization = attempt;
  void attempt.finally(() => {
    if (managedOrchestratorInitialization === attempt) managedOrchestratorInitialization = undefined;
  });
  return attempt;
}

async function adoptManagedOrchestratorConnection(
  connection: DesktopManagedOrchestratorConnection
): Promise<DesktopManagedOrchestratorStatus> {
  if (managedOrchestratorInitialization !== undefined) await managedOrchestratorInitialization;
  if (managedOrchestratorStatus.state !== "recoveryRequired") {
    throw new Error("Managed Orchestrator is not awaiting an owner-authorized recovery Connection.");
  }
  if (!validManagedOrchestratorConnection(connection)) throw new Error("Managed Orchestrator recovery metadata is invalid.");
  const previous = managedOrchestratorRecoveryTarget;
  if (previous === undefined || connection.serverId !== previous.serverId) {
    throw new Error("Managed Orchestrator recovery did not match the saved service identity.");
  }
  const ownedRuntime = managedOrchestratorRuntime;
  if (ownedRuntime === undefined || !sameManagedOrchestratorConnection(ownedRuntime.connection, previous)) {
    throw new Error("Managed Orchestrator recovery requires the currently owned local runtime.");
  }
  if (!secureStorageAvailable()) throw new Error("The operating-system credential store is unavailable.");
  const hostDirectory = join(app.getPath("userData"), "managed-orchestrator-host");
  const deviceIdPath = join(hostDirectory, "device-id");
  const connectionPath = join(hostDirectory, "connection.json");
  desktopDevicePeerAgentLifecycle?.setConnection(undefined);
  const authorityIsCurrent = async (): Promise<boolean> => {
    if (managedOrchestratorStatus.state !== "recoveryRequired" || managedOrchestratorRuntime !== ownedRuntime ||
      managedOrchestratorRecoveryTarget === undefined ||
      !sameManagedOrchestratorConnection(managedOrchestratorRecoveryTarget, previous)) return false;
    const saved = await readManagedOrchestratorConnection(connectionPath);
    return saved !== undefined && sameManagedOrchestratorConnection(saved, previous);
  };
  const transition = (async (): Promise<DesktopManagedOrchestratorStatus> => {
    const verification = await verifyManagedOrchestratorAdoption({
      expectedServerId: previous.serverId,
      connection,
      readAuthKey: readCredential
    });
    if (verification !== "verified" || !await authorityIsCurrent()) {
      throw new Error(`Managed Orchestrator recovery verification failed: ${verification}.`);
    }
    const activity = await probeManagedRuntimeActivity({
      connection,
      readAuthKey: readCredential,
      isAuthorityCurrent: authorityIsCurrent
    });
    if (activity.blocksShutdown) {
      throw new Error("Managed Orchestrator recovery cannot rotate while local work is active.");
    }
    const runtime = await commitVerifiedManagedOrchestratorAdoption({
      candidate: connection,
      previousDeviceId: previous.deviceId,
      stopCurrentRuntime: async () => {
        if (!await authorityIsCurrent()) throw new Error("Managed Orchestrator recovery authority changed.");
        await ownedRuntime.stop();
        if (managedOrchestratorRuntime === ownedRuntime) managedOrchestratorRuntime = undefined;
      },
      startWithCandidateProof: (candidate) => launchManagedOrchestratorBootstrap(candidate, candidate.deviceId),
      persistDeviceId: (deviceId) => persistManagedOrchestratorDeviceId(deviceIdPath, deviceId),
      restorePreviousDeviceId: (deviceId) => persistManagedOrchestratorDeviceId(deviceIdPath, deviceId),
      restorePreviousConnection: () => writeManagedOrchestratorConnection(connectionPath, previous),
      storeCredential,
      persistConnection: (value) => writeManagedOrchestratorConnection(connectionPath, value),
      deleteCredential,
      onStaleCredentialCleanupFailure: () => {
        process.stderr.write("JOKO_DESKTOP_RECOVERY_CREDENTIAL_CLEANUP_FAILED\n");
      }
    });
    managedOrchestratorRuntime = runtime;
    managedOrchestratorRecoveryTarget = undefined;
    managedOrchestratorConnection = runtime.connection;
    managedOrchestratorStatus = { state: "ready", connection: runtime.connection };
    reconcileDesktopDevicePeerAgentLifecycle();
    if (previous.profileId !== connection.profileId && previous.profileId !== runtime.connection.profileId) {
      await deleteCredential(previous.profileId).catch(() => {
        process.stderr.write("JOKO_DESKTOP_STALE_MANAGED_CREDENTIAL_CLEANUP_FAILED\n");
      });
    }
    refreshTrayContextMenu();
    return managedOrchestratorStatus;
  })();
  managedOrchestratorInitialization = transition;
  try {
    return await transition;
  } finally {
    if (managedOrchestratorInitialization === transition) managedOrchestratorInitialization = undefined;
  }
}

async function completeCurrentManagedOrchestratorLogout(): Promise<DesktopManagedOrchestratorStatus> {
  if (quitting || desktopUpdateLifecycleDisposed) {
    throw new Error("Managed Orchestrator logout cannot complete while Desktop is exiting.");
  }
  if (managedOrchestratorInitialization !== undefined) await managedOrchestratorInitialization;
  const expected = managedOrchestratorStatus.state === "ready" ? managedOrchestratorStatus.connection : undefined;
  if (expected === undefined) {
    throw new Error("Desktop has no current managed Orchestrator authority to retire.");
  }
  const connectionPath = join(app.getPath("userData"), "managed-orchestrator-host", "connection.json");
  desktopDevicePeerAgentLifecycle?.setConnection(undefined);
  const transition = (async (): Promise<DesktopManagedOrchestratorStatus> => {
    await completeVerifiedManagedOrchestratorLogout({
      verifyRevocation: () => probeManagedOrchestratorConnection({
        connection: expected,
        readAuthKey: readCredential
      }),
      completion: {
        expected,
        readSavedConnection: async () => managedOrchestratorStatus.state === "ready" &&
          sameManagedOrchestratorConnection(managedOrchestratorStatus.connection, expected)
          ? readManagedOrchestratorConnection(connectionPath)
          : undefined,
        deleteSavedConnection: () => deletePrivateFile(connectionPath),
        deleteCredential,
        onCredentialCleanupFailure: () => {
          process.stderr.write("JOKO_DESKTOP_LOGGED_OUT_CREDENTIAL_CLEANUP_FAILED\n");
        }
      }
    });
    managedOrchestratorExplicitlyLoggedOut = true;
    managedOrchestratorConnection = undefined;
    managedOrchestratorRecoveryTarget = undefined;
    managedOrchestratorStatus = { state: "disabled" };
    reconcileDesktopDevicePeerAgentLifecycle();
    refreshTrayContextMenu();
    return managedOrchestratorStatus;
  })();
  managedOrchestratorInitialization = transition;
  try {
    return await transition;
  } finally {
    if (managedOrchestratorInitialization === transition) managedOrchestratorInitialization = undefined;
    reconcileDesktopDevicePeerAgentLifecycle();
  }
}

async function initializeManagedOrchestrator(controlledStopConfirmed = false): Promise<void> {
  if (process.env["JOKO_DESKTOP_MANAGED_ORCHESTRATOR"] === "0") return;
  const hostDirectory = join(app.getPath("userData"), "managed-orchestrator-host");
  const deviceIdPath = join(hostDirectory, "device-id");
  const previous = await readManagedOrchestratorConnection(join(hostDirectory, "connection.json"));
  managedOrchestratorRecoveryTarget = previous;
  // A durable daemon must never be committed with a credential that exists
  // only in this UI process. That would make the next Desktop launch
  // deterministically lose authority while the service keeps running. The
  // isolated GitHub Actions smoke owns and stops its ephemeral runtime before
  // process exit, so it may exercise this path with the volatile store.
  if (!secureStorageAvailable() && !githubActionsPackagedSmoke) throw new ManagedOrchestratorInitializationError(
    managedOrchestratorRecovery("credentialUnavailable")
  );
  if (previous !== undefined) {
    const existing = await probeManagedOrchestratorConnection({
      connection: previous,
      readAuthKey: readCredential
    });
    if (existing === "authenticated") {
      managedOrchestratorConnection = previous;
      managedOrchestratorRecoveryTarget = undefined;
      return;
    }
    if (existing === "serviceUnavailable" && !canRespawnManagedOrchestratorAfterProbe(existing, controlledStopConfirmed)) {
      throw new ManagedOrchestratorInitializationError({
      state: "retryableError",
      reason: "serviceUnavailable"
      });
    }
    if (existing === "identityConflict") throw new ManagedOrchestratorInitializationError(
      managedOrchestratorRecovery("identityConflict")
    );
    if (existing === "credentialUnavailable") throw new ManagedOrchestratorInitializationError(
      managedOrchestratorRecovery("credentialUnavailable")
    );
    if (existing === "credentialRejected") throw new ManagedOrchestratorInitializationError(
      managedOrchestratorRecovery("credentialRejected")
    );
  }
  const deviceId = previous?.deviceId ?? await loadOrCreateManagedOrchestratorDeviceId(deviceIdPath);
  let runtime: ManagedOrchestratorRuntime | undefined;
  let authKey: string | undefined;
  try {
    runtime = await launchManagedOrchestratorBootstrap(previous, deviceId);
    writePackagedSmokeManagedRuntimeProcess(runtime);
    authKey = runtime.takeAuthKey();
    await storeCredential(runtime.connection.profileId, authKey);
    try {
      await writeManagedOrchestratorConnection(join(hostDirectory, "connection.json"), runtime.connection);
    } catch (error) {
      await deleteCredential(runtime.connection.profileId).catch(() => undefined);
      throw error;
    }
    await runtime.commit();
    managedOrchestratorConnection = runtime.connection;
    managedOrchestratorRecoveryTarget = undefined;
    managedOrchestratorRuntime = runtime;
    if (previous !== undefined && previous.profileId !== runtime.connection.profileId) {
      // The new bootstrap has already revoked this Device's old active
      // connections. Remove the now-useless encrypted credential as cleanup.
      await deleteCredential(previous.profileId).catch(() => {
        process.stderr.write("JOKO_DESKTOP_STALE_MANAGED_CREDENTIAL_CLEANUP_FAILED\n");
      });
    }
  } catch (error) {
    managedOrchestratorConnection = undefined;
    if (runtime !== undefined) await runtime.stop().catch(() => undefined);
    throw error;
  } finally {
    authKey = undefined;
  }
}

function writePackagedSmokeManagedRuntimeProcess(runtime: ManagedOrchestratorRuntime): void {
  if (!packagedSmoke || packagedSmokeResultPath === undefined) return;
  const processId = runtime.processId;
  if (processId === undefined || !Number.isSafeInteger(processId) || processId < 1 || processId > 0xffff_ffff) {
    throw new Error("Packaged smoke managed Orchestrator has no valid runtime process ID.");
  }
  const processIdentity = capturePackagedSmokeProcessBirthIdentitySync(processId);
  if (processIdentity === undefined) {
    throw new Error("Packaged smoke managed Orchestrator birth identity could not be captured.");
  }
  writeFileSync(
    `${packagedSmokeResultPath}.managed-process.json`,
    `${JSON.stringify({
      version: 1,
      pid: processId,
      processIdentity,
      serverId: runtime.connection.serverId
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" }
  );
}

async function launchManagedOrchestratorBootstrap(
  previous: DesktopManagedOrchestratorConnection | undefined,
  deviceId: string
): Promise<ManagedOrchestratorRuntime> {
  const ports = await selectManagedOrchestratorPorts();
  const outboundProxySnapshotEnvironment = await managedOrchestratorOutboundProxySnapshotEnvironment(
    process.env,
    (upstreamUrl) => session.defaultSession.resolveProxy(upstreamUrl)
  );
  return startManagedOrchestratorWithAuthorizationFence({
    previous,
    readAuthKey: readCredential,
    start: (previousConnection) => startManagedOrchestrator({
      orchestratorEntryPath: resolveManagedOrchestratorEntry(sourceDirectory, {
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        developmentWorkspace: !app.isPackaged
      }),
      ...(!app.isPackaged
        ? { nodeImportPath: fileURLToPath(import.meta.resolve("tsx")) }
        : {}),
      resourcesDirectory: app.isPackaged
        ? process.resourcesPath
        : resolve(sourceDirectory, "..", "resources"),
      dataDirectory: join(app.getPath("userData"), "orchestrator"),
      workspaceRoot: app.getPath("documents"),
      deviceId,
      deviceName: `${app.getName()} Desktop`,
      appVersion: app.getVersion(),
      platform: process.platform,
      publicPort: ports.publicPort,
      internalPort: ports.internalPort,
      environment: { ...process.env, ...outboundProxySnapshotEnvironment,
        JOKO_DOCUMENT_PDF_ELECTRON_EXECUTABLE: process.execPath,
        ...(!app.isPackaged ? { JOKO_DOCUMENT_PDF_ELECTRON_APP: resolve(sourceDirectory, "..") } : {}) },
      // The Desktop process remains alive while its window is in the tray,
      // and owns the managed service lease until explicit complete exit.
      ephemeral: true,
      ...(previousConnection === undefined ? {} : { previousConnection })
    })
  });
}

type ManagedOrchestratorFailureStatus = Extract<DesktopManagedOrchestratorStatus, {
  readonly state: "retryableError" | "recoveryRequired";
}>;

class ManagedOrchestratorInitializationError extends Error {
  constructor(readonly status: ManagedOrchestratorFailureStatus) {
    super(`Managed local Orchestrator initialization requires ${status.state}.`);
    this.name = "ManagedOrchestratorInitializationError";
  }
}

function managedOrchestratorRecovery(
  reason: DesktopManagedOrchestratorRecoveryReason
): Extract<DesktopManagedOrchestratorStatus, { readonly state: "recoveryRequired" }> {
  return { state: "recoveryRequired", reason };
}

async function readCredential(profileId: string): Promise<string | undefined> {
  validateProfileId(profileId);
  const volatile = volatileCredentials.get(profileId);
  if (volatile !== undefined) return volatile;
  if (!secureStorageAvailable()) return undefined;
  const encrypted = await readPrivateFile(credentialPath(profileId));
  if (encrypted === undefined) return undefined;
  const ciphertext = Buffer.from(encrypted);
  encrypted.fill(0);
  try {
    return safeStorage.decryptString(ciphertext);
  } finally {
    ciphertext.fill(0);
  }
}

async function storeCredential(profileId: string, secret: string): Promise<void> {
  validateProfileId(profileId);
  validateCredentialSecret(secret);
  if (!secureStorageAvailable()) {
    volatileCredentials.set(profileId, secret);
    return;
  }
  const encrypted = safeStorage.encryptString(secret);
  try {
    await atomicWritePrivateFile(credentialPath(profileId), encrypted);
  } finally {
    encrypted.fill(0);
  }
}

async function deleteCredential(profileId: string): Promise<void> {
  validateProfileId(profileId);
  volatileCredentials.delete(profileId);
  await deletePrivateFile(credentialPath(profileId));
}

async function readManagedOrchestratorConnection(path: string): Promise<DesktopManagedOrchestratorConnection | undefined> {
  const state = await readManagedOrchestratorConnectionState(path);
  return state.kind === "connection" ? state.connection : undefined;
}

type ManagedOrchestratorConnectionFileState =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "connection"; readonly connection: DesktopManagedOrchestratorConnection };

async function readManagedOrchestratorConnectionState(path: string): Promise<ManagedOrchestratorConnectionFileState> {
  const bytes = await readPrivateFile(path);
  if (bytes === undefined) return { kind: "missing" };
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return validManagedOrchestratorConnection(parsed)
      ? { kind: "connection", connection: parsed }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  } finally {
    bytes.fill(0);
  }
}

async function writeManagedOrchestratorConnection(path: string, connection: DesktopManagedOrchestratorConnection): Promise<void> {
  if (!validManagedOrchestratorConnection(connection)) throw new Error("Managed Orchestrator metadata is invalid.");
  const bytes = Buffer.from(`${JSON.stringify(connection)}\n`, "utf8");
  try {
    await atomicWritePrivateFile(path, bytes);
  } finally {
    bytes.fill(0);
  }
}

function validManagedOrchestratorConnection(value: unknown): value is DesktopManagedOrchestratorConnection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "deviceId,name,origin,profileId,serverId") return false;
  try {
    if (typeof record["profileId"] !== "string") return false;
    validateProfileId(record["profileId"]);
    if (typeof record["deviceId"] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record["deviceId"])) return false;
    if (typeof record["serverId"] !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(record["serverId"])) return false;
    if (typeof record["name"] !== "string" || record["name"].trim() !== record["name"] ||
      record["name"].length < 1 || record["name"].length > 128) return false;
    if (typeof record["origin"] !== "string") return false;
    const origin = new URL(record["origin"]);
    const hostname = origin.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (origin.protocol !== "http:" || record["origin"] !== origin.origin ||
      !(hostname === "localhost" || hostname === "::1" || hostname.startsWith("127."))) return false;
    return true;
  } catch {
    return false;
  }
}

function credentialDirectory(): string {
  return join(app.getPath("userData"), "credentials");
}

function credentialPath(profileId: string): string {
  return join(credentialDirectory(), `${profileId}.bin`);
}

function secureStorageAvailable(): boolean {
  const selectedBackend = process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : undefined;
  return isSecureStorageBackend(process.platform, safeStorage.isEncryptionAvailable(), selectedBackend);
}

async function openExternalSafely(value: string): Promise<void> {
  await shell.openExternal(canonicalExternalUrl(value));
}

async function initializeDedicatedHardwareInput(): Promise<void> {
  dedicatedHardwareTaskFocusFence.clear();
  dedicatedHardwareSystemVoiceController?.retire();
  dedicatedHardwareSystemVoiceController = undefined;
  const nativeHelper = loadNativeSystemFrontmostInput({
    directory: app.isPackaged
      ? resolve(process.resourcesPath, "native-system-frontmost-input")
      : resolve(sourceDirectory, "native-system-frontmost-input"),
    platform: process.platform,
    architecture: process.arch
  });
  const systemFrontmost = createPlatformSystemFrontmostInput({
    platform: process.platform,
    linuxSession: {
      sessionType: process.env.XDG_SESSION_TYPE,
      waylandDisplay: process.env.WAYLAND_DISPLAY
    },
    ...(nativeHelper === undefined ? {} : process.platform === "win32"
      ? { windowsHelper: nativeHelper }
      : process.platform === "darwin" ? { macHelper: nativeHelper }
      : process.platform === "linux" ? { linuxHelper: nativeHelper } : {})
  });
  if (packagedSmoke && (process.platform === "win32" || process.platform === "darwin" || process.platform === "linux")) {
    if (systemFrontmost.status !== "available") throw new Error("Native foreground sampler was not admitted by Main.");
    process.stdout.write("JOKO_DESKTOP_FRONTMOST_INPUT_READY\n");
  }
  const systemInput = systemFrontmost.status === "available"
    ? new SystemFrontmostInputController(systemFrontmost.runner, { wheelNotch: systemFrontmost.wheelNotch })
    : undefined;
  const systemVoice = systemFrontmost.status === "available"
    ? new SystemFrontmostVoiceController(systemFrontmost.runner, {
      snapshot: () => globalVoiceInputLease.snapshot(),
      press: () => {
        const pressed = pressGlobalVoiceInput("hardware");
        if (pressed.accepted) globalVoiceHardwarePressLease = pressed.lease;
        return pressed;
      },
      release: (lease, kind) => {
        if (globalVoiceHardwarePressLease?.activation === lease.activation
          && globalVoiceHardwarePressLease.recordingGeneration === lease.recordingGeneration) {
          globalVoiceHardwarePressLease = undefined;
        }
        return globalVoiceInputLease.release(lease, kind);
      },
      cancelHardware: () => {
        const lease = globalVoiceHardwarePressLease;
        globalVoiceHardwarePressLease = undefined;
        return lease !== undefined
          ? globalVoiceInputLease.release(lease, "cancel")
          : globalVoiceInputLease.cancelSource("hardware");
      }
    })
    : undefined;
  dedicatedHardwareSystemVoiceController = systemVoice;
  const router = new DedicatedHardwareActionRouter<BrowserWindow>({
    getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
    getPrimaryWindow: () => mainWindow ?? null,
    isJokoActionWindow: isDedicatedHardwareActionWindow,
    isWindowReady: isDedicatedHardwareActionWindowReady,
    getSystemFrontmostCapabilities: () => ({
      voice: systemVoice !== undefined && isDedicatedHardwareGlobalVoiceReady() ? "available" : "unsupported",
      return: systemInput === undefined ? "unsupported" : "available",
      scroll: systemInput === undefined ? "unsupported" : "available"
    })
  });
  const actions = createDedicatedHardwareMainActionRuntime({
    router,
    sendWindow: (window, event) => {
      const taskPress = event.kind === "button" && event.phase === "press" && event.action.kind === "task";
      if (!isDedicatedHardwareActionWindowReady(window)) {
        if (taskPress) dedicatedHardwareTaskFocusFence.clear();
        return false;
      }
      if (taskPress && event.action.focusWindow && window !== mainWindow) {
        dedicatedHardwareTaskFocusFence.clear();
        return false;
      }
      installDedicatedHardwareWindowLifecycle(window);
      return sendDedicatedHardwareActionDelivery({
        fence: dedicatedHardwareTaskFocusFence,
        owner: window.webContents,
        event,
        send: (delivery) => window.webContents.send(DESKTOP_CHANNELS.dedicatedHardwareAction, delivery)
      });
    },
    ...(systemInput === undefined ? {} : { systemInput }),
    systemVoice: systemVoice ?? { handle: () => false, cancel: () => undefined }
  });
  const input = createDedicatedHardwareInputController({
    emitAction: (_model, event) => {
      if (!actions.handle(_model, event)) throw new Error("Dedicated hardware action was not admitted.");
    }
  });
  const store = createDedicatedHardwareSettingsStore({
    directory: join(app.getPath("userData"), "hardware-input")
  });
  const host = createDedicatedHardwareHostClient({
    factory: createElectronDedicatedHardwareUtilityFactory({
      entryPath: resolve(sourceDirectory, "dedicated-hardware", "utility-entry.js")
    }),
    resolveSdkIdentity: () => resolveDedicatedHardwareSdkIdentity({
      stagingDirectory: dedicatedHardwareSdkStagingDirectory(process.resourcesPath)
    }),
    keymapBackupDirectory: join(app.getPath("userData"), "hardware-input", "private-keymap")
  });
  const controller = createDedicatedHardwareMainController<DedicatedHardwareControllerOwner>({
    store,
    host,
    input,
    onStateChanged: (state) => {
      dedicatedHardwareTaskFocusFence.clear();
      broadcastDedicatedHardwareState(state);
    },
    onPreviewInput: (owner, previewInput) => {
      const contents = "documentOccurrence" in owner ? owner.contents : owner;
      const window = dedicatedHardwareWindowForContents(contents);
      if (window === undefined || !isDedicatedHardwareActionWindowReady(window)) return;
      contents.send(DESKTOP_CHANNELS.dedicatedHardwarePreviewInput, previewInput);
    }
  });
  dedicatedHardwareActions = actions;
  try {
    const state = await controller.initialize();
    dedicatedHardwareController = controller;
    if (mainWindow !== undefined) refreshDedicatedHardwarePrimaryVisibility(mainWindow);
    broadcastDedicatedHardwareState(state);
  } catch (error) {
    dedicatedHardwareTaskFocusFence.clear();
    dedicatedHardwareController = undefined;
    dedicatedHardwareActions = undefined;
    if (dedicatedHardwareSystemVoiceController === systemVoice) {
      systemVoice?.retire();
      dedicatedHardwareSystemVoiceController = undefined;
    }
    actions.cancelAll("host-crashed");
    await controller.dispose().catch(() => undefined);
    process.stderr.write(`JOKO_DEDICATED_HARDWARE_INIT_FAILED ${safeSmokeError(error)}\n`);
  }
  if (!dedicatedHardwarePowerLifecycleInstalled) {
    dedicatedHardwarePowerLifecycleInstalled = true;
    powerMonitor.on("suspend", suspendDedicatedHardwareInput);
    powerMonitor.on("lock-screen", suspendDedicatedHardwareInput);
  }
}

async function stopDedicatedHardwareForQuitHandoff(): Promise<void> {
  dedicatedHardwareTaskFocusFence.clear();
  dedicatedHardwareActions?.cancelAll("suspended");
  dedicatedHardwareActions = undefined;
  dedicatedHardwareSystemVoiceController?.retire();
  dedicatedHardwareSystemVoiceController = undefined;
  const controller = dedicatedHardwareController;
  dedicatedHardwareController = undefined;
  await controller?.dispose();
}

async function recoverDedicatedHardwareAfterQuitFailure(): Promise<void> {
  if (quitting || dedicatedHardwareController !== undefined) return;
  await initializeDedicatedHardwareInput();
}

function suspendDedicatedHardwareInput(): void {
  dedicatedHardwareTaskFocusFence.clear();
  dedicatedHardwareActions?.cancelAll("suspended");
}

function retireDedicatedHardwareCatalogOwner(contents: WebContents, documentOccurrence: string): void {
  const owner = dedicatedHardwareCatalogOwner;
  if (owner === undefined || owner.contents !== contents || owner.documentOccurrence !== documentOccurrence) return;
  dedicatedHardwareController?.retireOwner(owner);
  dedicatedHardwareCatalogOwner = undefined;
  dedicatedHardwarePrimaryVisible = false;
}

function refreshDedicatedHardwarePrimaryVisibility(window: BrowserWindow, reveal = false): void {
  const owner = dedicatedHardwareCatalogOwner;
  if (window !== mainWindow || window.isDestroyed() || owner === undefined || owner.contents.isDestroyed() ||
      mainWindowContentsByWindow.get(window) !== owner.contents ||
      !mainWindowDocuments.isCurrent(owner.contents, owner.documentOccurrence)) return;
  const visible = window.isVisible() && !window.isMinimized();
  dedicatedHardwareController?.setPrimaryWindowVisible(owner, visible);
  if (reveal && visible && !dedicatedHardwarePrimaryVisible) {
    dedicatedHardwareController?.playWindowReveal(owner);
  }
  dedicatedHardwarePrimaryVisible = visible;
}

function requireDedicatedHardwareController(): DedicatedHardwareMainController<DedicatedHardwareControllerOwner> {
  if (dedicatedHardwareController === undefined) {
    throw new Error("Dedicated hardware input is unavailable.");
  }
  return dedicatedHardwareController;
}

function broadcastDedicatedHardwareState(state: DedicatedHardwareProjectedState): void {
  for (const window of dedicatedHardwareActionWindows()) {
    if (!isDedicatedHardwareActionWindowReady(window)) continue;
    try { window.webContents.send(DESKTOP_CHANNELS.dedicatedHardwareStateChanged, state); } catch { /* Best effort. */ }
  }
}

function dedicatedHardwareActionWindows(): readonly BrowserWindow[] {
  const windows: BrowserWindow[] = [];
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) windows.push(mainWindow);
  for (const window of sessionWindows.values()) {
    if (!window.isDestroyed() && !windows.includes(window)) windows.push(window);
  }
  return windows;
}

function dedicatedHardwareWindowForContents(contents: WebContents): BrowserWindow | undefined {
  const owner = BrowserWindow.fromWebContents(contents);
  if (owner === null || owner.isDestroyed() || owner.webContents !== contents) return undefined;
  if (owner === mainWindow) {
    return isAllowedMainFrameNavigation(contents.getURL(), navigationPolicy) ? owner : undefined;
  }
  const sessionOwner = sessionWindowOwnersByContents.get(contents);
  return sessionOwner !== undefined
    && sessionWindows.get(sessionWindowOwnerKey(sessionOwner)) === owner
    && isAllowedSessionWindowNavigation(contents.getURL(), sessionOwner.sessionId, navigationPolicy)
    ? owner
    : undefined;
}

function isDedicatedHardwareActionWindow(window: BrowserWindow): boolean {
  return !window.isDestroyed() && dedicatedHardwareWindowForContents(window.webContents) === window;
}

function isDedicatedHardwareActionWindowReady(window: BrowserWindow): boolean {
  if (!isDedicatedHardwareActionWindow(window)) return false;
  const contents = window.webContents;
  return !contents.isDestroyed() && !contents.isCrashed() && !contents.isLoadingMainFrame();
}

function isDedicatedHardwareGlobalVoiceReady(): boolean {
  const window = mainWindow;
  return window !== undefined && isDedicatedHardwareActionWindowReady(window);
}

function installDedicatedHardwareWindowLifecycle(window: BrowserWindow): void {
  const contents = window.webContents;
  if (dedicatedHardwareWindowLifecycles.has(contents)) return;
  let retired = false;
  const onNavigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame && !isInPlace) retire();
  };
  const onProcessGone = (): void => retire();
  const onDestroyed = (): void => retire();
  const retire = (): void => {
    if (retired) return;
    retired = true;
    contents.removeListener("did-start-navigation", onNavigation);
    contents.removeListener("render-process-gone", onProcessGone);
    contents.removeListener("destroyed", onDestroyed);
    if (dedicatedHardwareWindowLifecycles.get(contents)?.retire === retire) {
      dedicatedHardwareWindowLifecycles.delete(contents);
    }
    dedicatedHardwareController?.retireOwner(contents);
    dedicatedHardwareActions?.retireWindow(window);
    dedicatedHardwareTaskFocusFence.retireOwner(contents);
  };
  dedicatedHardwareWindowLifecycles.set(contents, { retire });
  contents.on("did-start-navigation", onNavigation);
  contents.once("render-process-gone", onProcessGone);
  contents.once("destroyed", onDestroyed);
}

function assertDedicatedHardwareSender(
  event: IpcMainInvokeEvent,
  options: { readonly focused?: boolean; readonly mainOnly?: boolean } = {}
): BrowserWindow {
  assertTrustedIpcSender(event);
  const owner = dedicatedHardwareWindowForContents(event.sender);
  if (owner === undefined || (options.mainOnly === true && owner !== mainWindow)) {
    throw new Error("Dedicated hardware IPC is restricted to an exact Joko application window.");
  }
  if (options.focused === true && !owner.isFocused()) {
    throw new Error("Dedicated hardware user gestures require a focused Joko application window.");
  }
  installDedicatedHardwareWindowLifecycle(owner);
  return owner;
}

function parseDedicatedHardwareModelRequest(value: unknown): DedicatedHardwareModelId {
  if (!dedicatedHardwareExactRecord(value, ["model"]) || !isDedicatedHardwareModelId(value.model)) {
    throw new TypeError("Dedicated hardware model request is invalid.");
  }
  return value.model;
}

function parseDedicatedHardwareSettingsRequest(value: unknown): {
  readonly model: DedicatedHardwareModelId;
  readonly settings: DedicatedHardwareSettings;
} {
  if (!dedicatedHardwareExactRecord(value, ["model", "settings"]) || !isDedicatedHardwareModelId(value.model)) {
    throw new TypeError("Dedicated hardware settings request is invalid.");
  }
  const settings = parseDedicatedHardwareSettings(value.settings);
  if (settings === undefined) throw new TypeError("Dedicated hardware settings request is invalid.");
  return { model: value.model, settings };
}

function parseDedicatedHardwareKeymapRecoveryRequest(value: unknown): "creator-micro-2" {
  if (!dedicatedHardwareExactRecord(value, ["model"]) || value.model !== "creator-micro-2") {
    throw new TypeError("Dedicated hardware keymap recovery request is invalid.");
  }
  return value.model;
}

function parseDedicatedHardwareResetRequest(value: unknown): {
  readonly model: DedicatedHardwareModelId;
  readonly scope: "layout" | "all";
} {
  if (!dedicatedHardwareExactRecord(value, ["model", "scope"]) || !isDedicatedHardwareModelId(value.model)
    || (value.scope !== "layout" && value.scope !== "all")) {
    throw new TypeError("Dedicated hardware reset request is invalid.");
  }
  return { model: value.model, scope: value.scope };
}

function parseDedicatedHardwarePreviewRequest(value: unknown): {
  readonly model: DedicatedHardwareModelId;
  readonly enabled: boolean;
} {
  if (!dedicatedHardwareExactRecord(value, ["model", "enabled"]) || !isDedicatedHardwareModelId(value.model)
    || typeof value.enabled !== "boolean") {
    throw new TypeError("Dedicated hardware preview request is invalid.");
  }
  return { model: value.model, enabled: value.enabled };
}

function dedicatedHardwareExactRecord(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}


function isTrustedDesktopIpcSender(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): boolean {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const senderFrame = event.senderFrame;
  const expectedWindow = trustedApplicationWindowForContents(event.sender);
  return isTrustedIpcSenderIdentity({
    owner,
    expectedWindow,
    sender: event.sender,
    ownerContents: owner?.webContents,
    senderFrame,
    mainFrame: event.sender.mainFrame,
    frameUrl: senderFrame?.url
  }, navigationPolicy);
}

function assertTrustedIpcSender(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): void {
  if (!isTrustedDesktopIpcSender(event)) {
    throw new Error("Desktop IPC request did not originate from the trusted Joko application frame.");
  }
}

function currentMainWindowDocumentOccurrence(): string | undefined {
  const window = mainWindow;
  return window === undefined || window.isDestroyed()
    ? undefined
    : mainWindowDocuments.currentFor(window.webContents);
}

function captureMainApplicationDocumentOccurrenceForSender(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  claim: string
): string | undefined {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed() || event.sender !== window.webContents) return undefined;
  if (!isTrustedDesktopIpcSender(event)) {
    retireMainWindowDocument(window, event.sender);
    releaseDesktopAttentionSource(event.sender.id);
    return undefined;
  }
  return captureMainWindowDocument(event.sender, claim);
}

function assertCurrentMainApplicationDocumentSender(
  event: IpcMainInvokeEvent,
  capturedOccurrence: unknown
): string {
  assertTrustedIpcSender(event);
  const documentOccurrence = mainWindowDocuments.currentFor(event.sender);
  if (event.sender !== mainWindow?.webContents || documentOccurrence === undefined) {
    throw new Error("Desktop IPC is restricted to the current owner application document.");
  }
  return requireCurrentDesktopMainDocumentOccurrence(capturedOccurrence, documentOccurrence);
}

function describeDesktopRuntimeRenderer(pid: number): string | null {
  for (const window of BrowserWindow.getAllWindows().sort((left, right) => left.id - right.id)) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    try {
      if (window.webContents.getOSProcessId() === pid) return window.getTitle();
    } catch {
      // A renderer may retire between enumeration and process lookup.
    }
  }
  return null;
}

function assertRuntimeProcessDiagnosticsSender(event: IpcMainInvokeEvent): void {
  if (runtimeProcessMonitorWindowForEvent(event) === undefined) {
    throw new Error("Runtime diagnostics IPC did not originate from the bound monitor document.");
  }
}

function assertTrustedWindowControlSender(event: IpcMainInvokeEvent): BrowserWindow {
  const monitor = runtimeProcessMonitorWindowForEvent(event);
  if (monitor !== undefined) return monitor;
  assertTrustedIpcSender(event);
  const window = trustedApplicationWindowForContents(event.sender);
  if (window === undefined) throw new Error("Desktop window control has no trusted application window.");
  return window;
}

function runtimeProcessMonitorWindowForEvent(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  const window = runtimeProcessMonitorWindow;
  const senderFrame = event.senderFrame;
  if (window === undefined || window.isDestroyed() || event.sender !== window.webContents ||
    runtimeProcessMonitorBroker.binding?.monitorEndpoint !== event.sender ||
    BrowserWindow.fromWebContents(event.sender) !== window || window.webContents !== event.sender ||
    senderFrame === undefined || senderFrame !== event.sender.mainFrame ||
    !isRuntimeProcessMonitorNavigation(senderFrame.url) ||
    !isRuntimeProcessMonitorNavigation(event.sender.getURL())) return undefined;
  return window;
}

function assertFocusedTrustedIpcSender(event: IpcMainInvokeEvent): BrowserWindow {
  assertTrustedIpcSender(event);
  const owner = trustedApplicationWindowForContents(event.sender);
  if (owner === undefined || owner.isDestroyed() || !owner.isFocused()) {
    throw new Error("Desktop user gesture requires a focused trusted Joko application window.");
  }
  return owner;
}

function nativeFileActionScope(event: IpcMainInvokeEvent): NativeFileActionScope {
  const contents = event.sender;
  const existing = nativeFileActionScopes.get(contents);
  if (existing !== undefined) return existing;
  const frame = event.senderFrame;
  let active = true;
  const scope: NativeFileActionScope = {
    id: randomUUID(),
    isCurrent: () => active && !quitting && !contents.isDestroyed() && contents.mainFrame === frame && trustedApplicationWindowForContents(contents) !== undefined
  };
  const retire = (): void => {
    if (!active) return;
    active = false;
    nativeFileClipboard?.retireScope(scope.id);
    nativeFileOpener?.retireScope(scope.id);
    nativeArtifactSourceRevealer?.retireScope(scope.id);
    if (nativeFileActionScopes.get(contents) === scope) nativeFileActionScopes.delete(contents);
    contents.removeListener("did-start-navigation", navigate);
    contents.removeListener("destroyed", retire);
  };
  const navigate = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => { if (isMainFrame && !isInPlace) retire(); };
  contents.on("did-start-navigation", navigate);
  contents.once("destroyed", retire);
  nativeFileActionScopes.set(contents, scope);
  return scope;
}

function trackExtensionLibraryGestureScope(contents: WebContents): void {
  if (extensionLibraryGestureScopes.has(contents)) return;
  extensionLibraryGestureScopes.add(contents);
  const retire = (): void => {
    extensionLibraryGestures.retireScope(contents);
    extensionLibraryGestureScopes.delete(contents);
    contents.removeListener("did-start-navigation", navigate);
    contents.removeListener("destroyed", retire);
  };
  const navigate = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame && !isInPlace) retire();
  };
  contents.on("did-start-navigation", navigate);
  contents.once("destroyed", retire);
}

function trustedApplicationWindowForContents(contents: WebContents): BrowserWindow | undefined {
  const owner = BrowserWindow.fromWebContents(contents);
  if (owner === null || owner.isDestroyed() || owner.webContents !== contents) return undefined;
  if (owner === mainWindow) return isAllowedPrimaryWindowNavigation(contents.getURL(), navigationPolicy) ? owner : undefined;
  const sessionOwner = sessionWindowOwnersByContents.get(contents);
  if (sessionOwner !== undefined && sessionWindows.get(sessionWindowOwnerKey(sessionOwner)) === owner
    && isAllowedSessionWindowNavigation(contents.getURL(), sessionOwner.sessionId, navigationPolicy)) return owner;
  const extensionId = extensionWindowIdsByContents.get(contents);
  return extensionId !== undefined && extensionWindows.get(extensionId) === owner
    && isAllowedExtensionWindowNavigation(contents.getURL(), extensionId, navigationPolicy) ? owner : undefined;
}

function isTrustedApplicationContents(contents: WebContents): boolean {
  const owner = trustedApplicationWindowForContents(contents);
  return owner !== undefined && isAllowedMainFrameNavigation(contents.getURL(), navigationPolicy);
}

function isTrustedClipboardWriteContents(contents: WebContents): boolean {
  const owner = trustedApplicationWindowForContents(contents);
  return owner !== undefined
    && (owner === mainWindow || sessionWindowOwnersByContents.has(contents))
    && isAllowedMainFrameNavigation(contents.getURL(), navigationPolicy);
}

function assertGlobalVoiceOwnerSender(event: IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event);
  if (event.sender !== mainWindow?.webContents) {
    throw new Error("Global voice control is restricted to the owner application window.");
  }
}

function assertGlobalVoiceSettingsSender(event: IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event);
  if (event.sender === mainWindow?.webContents || sessionWindowOwnersByContents.has(event.sender)) return;
  throw new Error("Global voice settings are restricted to a trusted application window.");
}

function assertFocusedGlobalVoiceSettingsSender(event: IpcMainInvokeEvent): void {
  assertGlobalVoiceSettingsSender(event);
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (owner === null || owner.isDestroyed() || !owner.isFocused()) {
    throw new Error("Global voice permission requests require the application window to be focused.");
  }
}

function assertGlobalVoiceOverlaySender(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null
    || window !== globalVoiceOverlayWindow
    || window.isDestroyed()
    || event.sender !== window.webContents
    || event.senderFrame !== event.sender.mainFrame
    || !isGlobalVoiceOverlayNavigation(event.senderFrame?.url ?? "")) {
    throw new Error("Global voice overlay IPC did not originate from the trusted overlay frame.");
  }
  return window;
}

function assertTrustedInspectorWindowSender(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (
    window === null ||
    window !== inspectorWindow ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    event.sender.getURL() !== INSPECTOR_WINDOW_URL ||
    inspectorWindowOwner === undefined ||
    inspectorWindowOwner.isDestroyed() ||
    inspectorWindowOwner !== mainWindow?.webContents
  ) {
    throw new Error("Inspector IPC did not originate from the trusted detached Inspector main frame.");
  }
  return window;
}
