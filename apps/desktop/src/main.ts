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
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { release as operatingSystemRelease } from "node:os";
import { appendFileSync, writeFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DESKTOP_CHANNELS,
  type DesktopApplicationMenuCommand,
  type DesktopDeepLinkNavigation,
  type DesktopDiscoveredNode,
  type DesktopFile,
  type DesktopGlobalVoiceCommitRequest,
  type DesktopGlobalVoiceCommand,
  type DesktopGlobalVoiceShortcut,
  type DesktopGlobalVoiceShortcutResult,
  type DesktopGlobalVoiceStatus,
  type DesktopManagedOrchestratorConnection,
  type DesktopManagedOrchestratorRecoveryReason,
  type DesktopManagedOrchestratorStatus,
  type DesktopNativeTaskStatusAction,
  type DesktopNativeTaskStatusDisplay,
  type DesktopNativeTaskStatusSoundChoice,
  type DesktopNativeTaskStatusSettings,
  type DesktopNotification,
  type DesktopPageSearchResult,
  type DesktopSaveFileRequest,
  type DesktopSessionDragPreviewRequest,
  type DesktopWindowInteractionSettings,
  type DesktopUpdateRelaunchRequest,
  type DesktopUpdateRelaunchResult,
  type DesktopUpdateChannelSettings,
  type DesktopUpdateStatus,
  INSPECTOR_WINDOW_FEATURES,
  INSPECTOR_WINDOW_URL,
  isDesktopSessionDragGestureId,
  isDesktopSessionDragPreviewRequest,
  isInspectorWindowOpenRequest,
  isDesktopLocale,
  parseDesktopPageSearchRequest,
  parseDesktopPageSearchStopAction
} from "./channels.js";
import {
  DESKTOP_DEEP_LINK_SCHEME,
  DesktopDeepLinkDeliveryBuffer,
  DesktopInboundOpenIntentFence,
  desktopInboundOpenIntentFromArgv,
  isPortableSessionPath,
  parseDesktopDeepLink,
  type DesktopInboundOpenIntent
} from "./deep-link.js";
import { sessionWindowDropBounds, SESSION_DRAG_PREVIEW_SIZE, type DesktopPoint, type DesktopRectangle } from "./session-window-drop.js";
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
  createDesktopKeepAwakeSettingsStore,
  type DesktopKeepAwakeSettingsStore
} from "./keep-awake-settings.js";
import {
  createDesktopWindowInteractionSettingsStore,
  type DesktopWindowInteractionSettingsStore
} from "./window-interaction-settings.js";
import {
  createDesktopNativeTaskStatusSettingsStore,
  type DesktopNativeTaskStatusSettingsStore
} from "./native-task-status-settings.js";
import {
  createDesktopNativeTaskStatusLayoutSettingsStore,
  type DesktopNativeTaskStatusLayoutSettingsStore
} from "./native-task-status-layout-settings.js";
import {
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
  insertTextIntoForegroundApplication
} from "./external-text-insertion.js";
import {
  createSystemAudioMuteBackend,
  SystemAudioMuteGuard
} from "./system-audio-mute.js";
import { createManagedExitFence } from "./managed-exit-fence.js";
import { probeManagedRuntimeActivity } from "./managed-runtime-activity.js";
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
import {
  atomicWritePrivateFile,
  atomicWriteUserSelectedFile,
  deletePrivateFile,
  readPrivateFile,
  readRegularFileSnapshot
} from "./secure-files.js";
import { installSelectionContextMenu, setSelectionContextMenuLocale } from "./selection-context-menu.js";
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
import { popUpDesktopTrayMenu, resolveDesktopTrayMenuLabels, usesJavaScriptTrayMenuPopup } from "./tray-menu.js";
import {
  canShowDesktopWindow,
  hideWindowToAvailableTray,
  onDesktopWindowClosed,
  showWindowFromTray
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
  isAllowedMainFrameNavigation,
  isAllowedPackagedBundleResource,
  isAllowedRendererNetworkUrl,
  isSafeExternalUrl,
  isSecureStorageBackend,
  isTrustedIpcSenderIdentity,
  mediaTypeForPath,
  mergeContentSecurityPolicyHeaders,
  resolvePackagedAppResource,
  runtimeProcessMonitorEntryUrl,
  validateCredentialSecret,
  validateProfileId
} from "./security.js";

// fileURLToPath(new URL(".", ...)) retains a trailing separator. Normalize it
// once here so the managed-runtime resolver's absolute/canonical input fence
// sees the same path shape in the real Electron entry as it does in tests.
const sourceDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const developmentUrl = process.env["JOKO_WEB_DEV_URL"];
const packagedSmoke = process.env["JOKO_DESKTOP_PACKAGED_SMOKE"] === "1";
const githubActionsPackagedSmoke = packagedSmoke && process.env["GITHUB_ACTIONS"] === "true";
const packagedSmokeConnectOrigin = process.env["JOKO_DESKTOP_SMOKE_CONNECT_ORIGIN"];
const packagedSmokePublicHttpOrigin = process.env["JOKO_DESKTOP_SMOKE_PUBLIC_HTTP_ORIGIN"];
const packagedSmokeResultPath = process.env["JOKO_DESKTOP_SMOKE_RESULT"];
const packagedSmokeUserData = process.env["JOKO_DESKTOP_SMOKE_USER_DATA"];
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
const desktopAttentionBadgeSupported = process.platform === "darwin" || process.platform === "win32";
let mainWindow: BrowserWindow | undefined;
const desktopDeepLinkDelivery = new DesktopDeepLinkDeliveryBuffer();
const desktopInboundOpenIntentFence = new DesktopInboundOpenIntentFence();
let inspectorWindow: BrowserWindow | undefined;
let inspectorWindowOwner: WebContents | undefined;
let inspectorWindowReady = false;
let runtimeProcessMonitorWindow: BrowserWindow | undefined;
let globalVoiceOverlayWindow: BrowserWindow | undefined;
let globalVoiceNativePressOwnsSession = false;
let globalVoiceShortcutRecoveryFailurePending = false;
let globalVoiceActive = false;
let globalVoiceStatus: DesktopGlobalVoiceStatus = Object.freeze({ state: "idle" });
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
const sessionWindowIdsByContents = new Map<WebContents, string>();
const pageSearchTokensByContents = new WeakMap<WebContents, Map<number, number>>();
const pageSearchResultBindings = new WeakSet<WebContents>();
const sessionWindowStates = new Map<string, windowStateKeeper.State>();
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
let applicationMenuLocale = "en";
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
let desktopWindowInteractionSettings: DesktopWindowInteractionSettingsStore | undefined;
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
const activeDesktopNotifications = new Set<Notification>();
const volatileCredentials = new Map<string, string>();
const MAXIMUM_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_ATTACHMENT_BATCH_BYTES = 256 * 1024 * 1024;
const MAXIMUM_ATTACHMENT_FILES = 32;
const MAXIMUM_NATIVE_FILE_BYTES = 256 * 1024 * 1024;
const TRAY_ICON_DATA_URL_PREFIX = "data:image/png;base64,";
const MAXIMUM_TRAY_ICON_DATA_URL_LENGTH = 512 * 1024;
const EXPECTED_TRAY_ICON_SIZE = 256;
const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";
const MAXIMUM_NOTIFICATION_TITLE_CHARACTERS = 160;
const MAXIMUM_NOTIFICATION_BODY_CHARACTERS = 2_000;
const MAXIMUM_NOTIFICATION_SESSION_ID_CHARACTERS = 256;
const MAIN_WINDOW_DEFAULT_GEOMETRY = Object.freeze({ width: 1280, height: 800 });
const SESSION_WINDOW_DEFAULT_GEOMETRY = Object.freeze({ width: 1100, height: 760 });
const INSPECTOR_WINDOW_DEFAULT_GEOMETRY = Object.freeze({ width: 520, height: 860 });
const RUNTIME_PROCESS_MONITOR_WINDOW_DEFAULT_GEOMETRY = Object.freeze({ width: 580, height: 520 });
const SESSION_WINDOW_STATE_PREFIX = "session-window-state-";
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
  packagedSmoke,
  ...(packagedSmokeUserData === undefined ? {} : {
    packagedSmokeDirectory: packagedSmokeUserData
  })
});
if (desktopUserDataDirectory !== undefined) {
  app.setPath("userData", prepareDesktopUserDataDirectory(desktopUserDataDirectory));
}
installWindowsApplicationIdentity(process.platform, (applicationId) => app.setAppUserModelId(applicationId));
registerDesktopDeepLinkProtocolClient();
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDesktopDeepLinkUrl(url);
});
app.on("open-file", (event, path) => {
  if (!isPortableSessionPath(path, process.platform)) return;
  event.preventDefault();
  handleDesktopInboundOpenIntent({ kind: "portableFile", path });
});
recordPackagedSmokeProgress("module_loaded");

if (!app.requestSingleInstanceLock()) {
  recordPackagedSmokeProgress("single_instance_denied");
  app.quit();
} else {
  recordPackagedSmokeProgress("single_instance_acquired");
  const coldOpenIntent = desktopInboundOpenIntentFromArgv(process.argv, process.platform);
  if (coldOpenIntent !== undefined) handleDesktopInboundOpenIntent(coldOpenIntent);
  app.on("second-instance", (_event, argv) => {
    showMainWindow();
    const intent = desktopInboundOpenIntentFromArgv(argv, process.platform);
    if (intent !== undefined) handleDesktopInboundOpenIntent(intent);
  });
  app.on("before-quit", (event) => {
    quitting = true;
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
    globalVoiceShortcutRecovery.dispose();
    unregisterGlobalVoiceShortcut();
    stopGlobalVoiceShortcutCapture();
    globalVoiceNativeShortcut.dispose();
    globalVoiceSystemAudioOwner = undefined;
    void globalVoiceSystemAudio.releaseAll().catch(() => undefined);
    destroyGlobalVoiceOverlay();
    sessionDragPreviewCoordinator.dispose();
    sessionDragNativeResultFence.dispose();
    desktopKeepAwakeController?.release();
    destroyRuntimeProcessMonitorWindow();
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
    disposeDesktopNotifications();
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
    await initializeDesktopNativeTaskStatus();
    if (shouldRunDesktopUpdateStartup()) desktopUpdateStartupPhase = { kind: "checking" };
    await initializeDesktopKeepAwake();
    registerIpc();
    installMicrophoneLifecycle();
    installProviderModelPowerLifecycle();
    applicationMenuLocale = app.getLocale();
    installDesktopApplicationMenu();
    createWindow();
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
      unregisterGlobalVoiceShortcut();
      stopGlobalVoiceShortcutCapture(contents);
      resetGlobalVoicePresentation();
      destroyInspectorWindow();
      mainWindow = undefined;
    }
  });
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
  mainWindowState.manage(window);
  window.webContents.on("did-start-loading", () => {
    desktopDeepLinkDelivery.resetRenderer();
    unregisterGlobalVoiceShortcut();
    stopGlobalVoiceShortcutCapture(window.webContents);
    resetGlobalVoicePresentation();
    resetMainApplicationMenuState(window.webContents);
    clearNativeTaskStatusProjection();
    clearDesktopNativeTaskStatusVisibility(window.webContents);
    releaseDesktopAttentionSource(attentionSourceId);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
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
    systemLocale: () => app.getLocale(),
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
    }));
  electronSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isAllowedDesktopMicrophoneRequest({
      permission,
      trustedOwner: isTrustedApplicationContents(webContents),
      mainFrame: microphoneMainFrameFromPermissionDetails(details),
      trustedFrameUrl: webContents.getURL(),
      requestingUrl: requestingUrlFromPermissionDetails(details),
      mediaTypes: microphoneMediaTypesFromPermissionDetails(details)
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
        if (inspectorWindow.isMinimized()) inspectorWindow.restore();
        inspectorWindow.show();
        inspectorWindow.focus();
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
    installInspectorWindowSecurity(childWindow, window.webContents);
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedMainFrameNavigation(url, navigationPolicy)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) void openExternalSafely(url).catch(() => undefined);
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedMainFrameNavigation(url, navigationPolicy)) event.preventDefault();
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
    if (details.resourceType !== "mainFrame" && details.resourceType !== "subFrame") {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: mergeContentSecurityPolicyHeaders(details.responseHeaders)
    });
  });
  window.on("close", (event) => {
    // Electron's macOS autoUpdater emits before-quit only after it has started
    // closing windows. The post-stop native handoff flag is therefore also an
    // authoritative close boundary; dirty beforeunload may still cancel it,
    // in which case the driver's will-quit timeout recovers managed Orchestrator.
    if (quitting || desktopUpdateNativeInstallQuitHandoffPending) return;
    // Development launches must release the single-instance lock and the
    // managed service so the next rebuilt launch cannot reopen stale code.
    if (!app.isPackaged) {
      event.preventDefault();
      app.quit();
      return;
    }
    event.preventDefault();
    // Native close, Alt+F4, taskbar close, and the renderer X all mean the
    // same thing: keep Desktop/Orchestrator alive and hide only the main window.
    void closeWindowToTray(window);
  });
  window.on("hide", () => {
    if (inspectorWindow !== undefined && !inspectorWindow.isDestroyed()) inspectorWindow.hide();
  });
  window.on("show", () => {
    if (inspectorWindowReady && inspectorWindow !== undefined && !inspectorWindow.isDestroyed()) {
      inspectorWindow.showInactive();
    }
  });
  if (packagedSmoke) {
    const timeout = setTimeout(() => {
      process.stderr.write("JOKO_DESKTOP_SMOKE_TIMEOUT\n");
      finishPackagedSmoke("JOKO_DESKTOP_SMOKE_TIMEOUT", 1);
    }, 45_000);
    timeout.unref();
    window.webContents.once("did-finish-load", () => {
      void window.webContents.executeJavaScript(
        [
          "(async () => {",
          "  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));",
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
          "      typeof window.jokoDesktop.deepLinks?.takePending === 'function' &&",
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
          "    const managedDeadline = Date.now() + 15_000;",
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
          "    const monitorWindow = await window.jokoDesktop.runtimeProcessMonitor.open();",
          "    if (monitorWindow?.focusedExisting !== false) {",
          "      throw new Error('The standalone runtime resource monitor did not open a fresh application window.');",
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
      ).then((rendered: unknown) => {
        clearTimeout(timeout);
        if (rendered !== true) {
          process.stderr.write("JOKO_DESKTOP_SMOKE_EMPTY_ROOT\n");
          finishPackagedSmoke("JOKO_DESKTOP_SMOKE_EMPTY_ROOT", 1);
          return;
        }
        process.stdout.write("JOKO_DESKTOP_SMOKE_OK\n");
        finishPackagedSmoke("JOKO_DESKTOP_SMOKE_OK", 0);
      }, (error: unknown) => {
        clearTimeout(timeout);
        process.stderr.write(`JOKO_DESKTOP_SMOKE_SCRIPT_FAILED ${safeSmokeError(error)}\n`);
        finishPackagedSmoke(`JOKO_DESKTOP_SMOKE_SCRIPT_FAILED ${safeSmokeError(error)}`, 1);
      });
    });
    window.webContents.once("did-fail-load", (_event, code, description) => {
      clearTimeout(timeout);
      process.stderr.write(`JOKO_DESKTOP_SMOKE_LOAD_FAILED ${code} ${description.slice(0, 500)}\n`);
      finishPackagedSmoke(`JOKO_DESKTOP_SMOKE_LOAD_FAILED ${code} ${description.slice(0, 500)}`, 1);
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

function safeSmokeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? "unknown error"))
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
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
  if (runtime === undefined) {
    recordPackagedSmokeProgress("finish_without_runtime");
    exitPackagedSmokeProcess(exitCode);
    return;
  }
  recordPackagedSmokeProgress("runtime_stop_started");
  void runtime.stop().then(
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

async function loadUi(window: BrowserWindow, bootSessionId?: string): Promise<void> {
  const withWindowIdentity = (value: string): string => {
    if (bootSessionId === undefined) return value;
    const url = new URL(value);
    url.search = "";
    url.searchParams.set("sessionWindow", "1");
    url.searchParams.set("bootSession", bootSessionId);
    url.hash = `#/tasks/${encodeURIComponent(bootSessionId)}`;
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
  kind: "main" | "session" | "runtime",
  details: { readonly reason: string; readonly exitCode: number }
): Error {
  const surface = kind === "main"
    ? "application"
    : kind === "runtime" ? "runtime resource window" : "task window";
  return new Error(
    `The ${surface} renderer stopped unexpectedly (${details.reason}, exit ${details.exitCode}).`
  );
}

async function presentDesktopWindowLoadFailure(
  kind: "main" | "session" | "runtime",
  error: unknown,
  attempt: number,
  preferredOwner?: BrowserWindow
): Promise<DesktopWindowLoadFailureAction> {
  const chinese = app.getLocale().toLowerCase().startsWith("zh");
  const main = kind === "main";
  const runtime = kind === "runtime";
  const options: MessageBoxOptions = {
    type: "error",
    title: chinese
      ? main ? "Joko 无法启动" : runtime ? "Joko 无法打开运行时资源用量" : "Joko 无法打开任务窗口"
      : main ? "Joko could not start" : runtime ? "Joko could not open runtime resource usage" : "Joko could not open the task window",
    message: chinese
      ? main ? "Joko 用户界面无法加载。" : runtime ? "运行时资源用量无法加载。" : "任务窗口无法加载。"
      : main ? "The Joko user interface could not be loaded." : runtime ? "Runtime resource usage could not be loaded." : "The task window could not be loaded.",
    detail: `${safeSmokeError(error)}${attempt > 1
      ? chinese ? `\n\n第 ${attempt} 次加载失败。` : `\n\nLoad attempt ${attempt} failed.`
      : ""}`,
    buttons: chinese
      ? ["重试", main ? "退出" : "关闭"]
      : ["Retry", main ? "Quit" : "Close"],
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
  if (globalVoiceShortcutRecordingActive()) return;
  if (globalVoiceActive) {
    submitGlobalVoiceShortcut();
    return;
  }
  globalVoiceActive = true;
  beginGlobalVoiceSystemAudio();
  setGlobalVoiceStatus({ state: "starting" });
  showGlobalVoiceOverlay();
  sendGlobalVoiceCommand({ type: "start" });
}

function submitGlobalVoiceShortcut(): void {
  if (!globalVoiceActive) return;
  setGlobalVoiceStatus({
    state: "submitting",
    transcript: globalVoiceStatus.state === "listening" ? globalVoiceStatus.transcript : ""
  });
  sendGlobalVoiceCommand({ type: "submit" });
}

function handleNativeGlobalVoiceShortcutPhase(phase: "start" | "tap" | "end"): void {
  if (phase === "start") {
    if (globalVoiceShortcutRecordingActive()) return;
    const wasActive = globalVoiceActive;
    activateGlobalVoiceShortcut();
    globalVoiceNativePressOwnsSession = !wasActive && globalVoiceActive;
    return;
  }
  if (phase === "tap") {
    globalVoiceNativePressOwnsSession = false;
    return;
  }
  const shouldSubmit = globalVoiceNativePressOwnsSession;
  globalVoiceNativePressOwnsSession = false;
  if (shouldSubmit) submitGlobalVoiceShortcut();
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
  globalVoiceNativePressOwnsSession = false;
  if (registered) recordGlobalVoiceShortcutRecoveryFailure();
}

function sendGlobalVoiceCommand(command: DesktopGlobalVoiceCommand): void {
  const contents = mainWindow?.webContents;
  if (contents === undefined || contents.isDestroyed()) {
    globalVoiceActive = false;
    setGlobalVoiceStatus({ state: "error", errorKind: "service" });
    return;
  }
  contents.send(DESKTOP_CHANNELS.globalVoiceCommand, command);
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
    if (globalVoiceActive && !window.isDestroyed()) window.showInactive();
  });
  window.webContents.on("did-finish-load", () => {
    if (!window.isDestroyed()) window.webContents.send(DESKTOP_CHANNELS.globalVoiceStatus, globalVoiceStatus);
  });
  window.webContents.on("render-process-gone", () => {
    if (globalVoiceOverlayWindow !== window || quitting) return;
    globalVoiceOverlayWindow = undefined;
    if (!window.isDestroyed()) window.destroy();
    globalVoiceActive = false;
    setGlobalVoiceStatus({ state: "error", errorKind: "service" });
  });
  window.on("closed", () => {
    if (globalVoiceOverlayWindow === window) globalVoiceOverlayWindow = undefined;
  });
  void loadGlobalVoiceOverlayUi(window).catch(() => {
    if (!window.isDestroyed()) window.destroy();
    globalVoiceActive = false;
    setGlobalVoiceStatus({ state: "error", errorKind: "service" });
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

function resetGlobalVoicePresentation(): void {
  globalVoiceActive = false;
  globalVoiceNativePressOwnsSession = false;
  setGlobalVoiceStatus({ state: "idle" });
  const overlay = globalVoiceOverlayWindow;
  if (overlay !== undefined && !overlay.isDestroyed()) overlay.hide();
}

function destroyGlobalVoiceOverlay(): void {
  const overlay = globalVoiceOverlayWindow;
  globalVoiceOverlayWindow = undefined;
  if (overlay !== undefined && !overlay.isDestroyed()) overlay.destroy();
}

function parseGlobalVoiceStatus(value: unknown): DesktopGlobalVoiceStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Global voice status is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const state = candidate["state"];
  if ((state === "idle" || state === "starting") && Object.keys(candidate).join(",") === "state") {
    return { state };
  }
  if (state === "listening" || state === "submitting") {
    if (Object.keys(candidate).sort().join(",") !== "state,transcript"
      || typeof candidate["transcript"] !== "string"
      || candidate["transcript"].length > 4_096
      || /\u0000/u.test(candidate["transcript"])) {
      throw new TypeError("Global voice status is invalid.");
    }
    return { state, transcript: candidate["transcript"] };
  }
  const errorKind = candidate["errorKind"];
  if (state === "error" && Object.keys(candidate).sort().join(",") === "errorKind,state"
    && (errorKind === "unsupported" || errorKind === "permission" || errorKind === "microphone"
      || errorKind === "service" || errorKind === "empty" || errorKind === "insertion")) {
    return { state, errorKind };
  }
  throw new TypeError("Global voice status is invalid.");
}

function parseGlobalVoiceCommit(value: unknown): DesktopGlobalVoiceCommitRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).join(",") !== "text") {
    throw new TypeError("Global voice result is invalid.");
  }
  const text = (value as Record<string, unknown>)["text"];
  if (typeof text !== "string" || text.length === 0 || text.length > 64 * 1024 || /\u0000/u.test(text)) {
    throw new TypeError("Global voice result is invalid.");
  }
  return { text };
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
    openSessionApplicationWindow(completion.sessionId, completion.point);
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
  sessionId: string,
  dropPoint?: DesktopPoint
): Promise<{ readonly focusedExisting: boolean }> {
  if (!isDesktopNotificationSessionId(sessionId)) throw new TypeError("Task identity is invalid.");
  const existing = sessionWindows.get(sessionId);
  if (existing !== undefined && !existing.isDestroyed()) {
    showWindowFromTray(existing);
    return { focusedExisting: true };
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
    file: sessionWindowStateFile(sessionId)
  });
  const dropBounds = dropPoint === undefined ? undefined : sessionWindowDropBounds({
    point: dropPoint,
    workArea: screen.getDisplayNearestPoint(dropPoint).workArea,
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
  sessionWindows.set(sessionId, window);
  sessionWindowIdsByContents.set(windowContents, sessionId);
  sessionWindowStates.set(sessionId, state);
  installDesktopNativeTaskStatusVisibilityLifecycle(window);
  state.manage(window);
  window.webContents.setZoomFactor(currentWindowZoomFactor);
  let sessionUiLoadRecovery: Promise<void> | undefined;
  const beginSessionUiLoadRecovery = (initialFailure?: unknown): void => {
    if (sessionUiLoadRecovery !== undefined || window.isDestroyed() || quitting) return;
    const options = {
      unavailable: () => window.isDestroyed() || quitting,
      load: () => loadUi(window, sessionId),
      presentFailure: (error: unknown, attempt: number) =>
        presentDesktopWindowLoadFailure("session", error, attempt),
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
    systemLocale: () => app.getLocale(),
    buildMenu: (template) => Menu.buildFromTemplate([...template]),
    openExternal: (url) => shell.openExternal(url)
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void openExternalSafely(url).catch(() => undefined);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedMainFrameNavigation(url, navigationPolicy)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) void openExternalSafely(url).catch(() => undefined);
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedMainFrameNavigation(url, navigationPolicy)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
  });
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  window.once("closed", () => {
    releaseDesktopAttentionSource(attentionSourceId);
    stopGlobalVoiceShortcutCapture(windowContents);
    releaseApplicationMenuShortcutRecording(attentionSourceId);
    if (sessionWindows.get(sessionId) === window) sessionWindows.delete(sessionId);
    sessionWindowIdsByContents.delete(windowContents);
    sessionWindowStates.delete(sessionId);
    clearDesktopNativeTaskStatusVisibility(windowContents);
  });
  beginSessionUiLoadRecovery();
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

async function openRuntimeProcessMonitorWindow(owner: BrowserWindow): Promise<{ readonly focusedExisting: boolean }> {
  const existing = runtimeProcessMonitorWindow;
  if (existing !== undefined && !existing.isDestroyed()) {
    showWindowFromTray(existing);
    return { focusedExisting: true };
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
  runtimeProcessMonitorWindow = window;
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
      presentFailure: (error: unknown, attempt: number) =>
        presentDesktopWindowLoadFailure("runtime", error, attempt, owner),
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
    if (window.isDestroyed() || quitting) return;
    void beginRuntimeUiLoadRecovery(desktopRendererLossError("runtime", details)).catch((error: unknown) => {
      process.stderr.write(`JOKO_DESKTOP_RUNTIME_WINDOW_RECOVERY_FAILED ${safeSmokeError(error)}\n`);
    });
  });
  installSelectionContextMenu(window, {
    platform: process.platform,
    systemLocale: () => app.getLocale(),
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
    if (runtimeProcessMonitorWindow === window) runtimeProcessMonitorWindow = undefined;
    if (managedRuntimeProcessMonitorWindowState === state) managedRuntimeProcessMonitorWindowState = undefined;
  });
  try {
    const result = await beginRuntimeUiLoadRecovery();
    if (result === "closed") throw new Error("Runtime resource usage was closed before it loaded.");
  } catch (error: unknown) {
    if (runtimeProcessMonitorWindow === window) runtimeProcessMonitorWindow = undefined;
    if (managedRuntimeProcessMonitorWindowState === state) managedRuntimeProcessMonitorWindowState = undefined;
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  return { focusedExisting: false };
}

function runtimeProcessMonitorWindowTitle(): string {
  return applicationMenuLocale.toLowerCase().startsWith("zh")
    ? "Joko · 运行时资源用量"
    : "Joko · Runtime resource usage";
}

function isRuntimeProcessMonitorNavigation(value: string): boolean {
  if (!isAllowedMainFrameNavigation(value, navigationPolicy)) return false;
  try {
    const url = new URL(value);
    return [...url.searchParams.keys()].join(",") === "runtimeProcessMonitor" &&
      url.searchParams.get("runtimeProcessMonitor") === "1";
  } catch {
    return false;
  }
}

function destroyRuntimeProcessMonitorWindow(): void {
  const window = runtimeProcessMonitorWindow;
  runtimeProcessMonitorWindow = undefined;
  managedRuntimeProcessMonitorWindowState = undefined;
  if (window !== undefined && !window.isDestroyed()) window.destroy();
}

function applicationWindows(): readonly BrowserWindow[] {
  return [
    ...(mainWindow === undefined || mainWindow.isDestroyed() ? [] : [mainWindow]),
    ...(runtimeProcessMonitorWindow === undefined || runtimeProcessMonitorWindow.isDestroyed()
      ? []
      : [runtimeProcessMonitorWindow]),
    ...[...sessionWindows.values()].filter((window) => !window.isDestroyed())
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
    ...sessionWindows.values()
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
  for (const [sessionId, window] of sessionWindows) {
    const state = sessionWindowStates.get(sessionId);
    if (state === undefined) continue;
    if (window.isDestroyed()) resetDormantManagedWindowState(state);
    else targets.push({ window, state, defaults: SESSION_WINDOW_DEFAULT_GEOMETRY });
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

  const openStateFiles = new Set([...sessionWindows]
    .filter(([, window]) => !window.isDestroyed())
    .map(([sessionId]) => sessionWindowStateFile(sessionId)));
  const entries = await readdir(app.getPath("userData"), { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.flatMap((entry) => entry.isFile() && entry.name.startsWith(SESSION_WINDOW_STATE_PREFIX) &&
    entry.name.endsWith(".json") && !openStateFiles.has(entry.name)
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
    ...(inspectorWindow === undefined ? [] : [inspectorWindow])
  ], initiatingContents);
}

function sessionWindowStateFile(sessionId: string): string {
  return `${SESSION_WINDOW_STATE_PREFIX}${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}.json`;
}

function destroySessionWindows(): void {
  const windows = [...sessionWindows.values()];
  sessionWindows.clear();
  sessionWindowIdsByContents.clear();
  sessionWindowStates.clear();
  for (const window of windows) {
    if (!window.isDestroyed()) window.destroy();
  }
}

function registerPackagedAppProtocol(): void {
  if (navigationPolicy.developmentUrl !== undefined || protocol.isProtocolHandled(DESKTOP_APP_SCHEME)) return;
  protocol.handle(DESKTOP_APP_SCHEME, (request) => {
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
  if (packagedSmoke) return;
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

function handleDesktopDeepLinkUrl(value: unknown): boolean {
  const intent = parseDesktopDeepLink(value);
  if (intent === undefined) return false;
  handleDesktopInboundOpenIntent(intent);
  return true;
}

function handleDesktopInboundOpenIntent(intent: DesktopInboundOpenIntent): void {
  if (app.isReady()) showMainWindow();
  const claim = desktopInboundOpenIntentFence.begin(intent);
  if (claim === undefined) return;
  void materializeDesktopDeepLinkNavigation(claim.intent).then((navigation) => {
    if (!desktopInboundOpenIntentFence.isCurrent(claim)) return;
    deliverDesktopDeepLinkNavigation(navigation);
  });
}

async function materializeDesktopDeepLinkNavigation(
  intent: Exclude<DesktopInboundOpenIntent, { readonly kind: "focus" }>
): Promise<DesktopDeepLinkNavigation> {
  if (intent.kind === "session" || intent.kind === "settings") return intent;
  if (intent.kind === "portable") return Object.freeze({ kind: "portable" });
  let file: DesktopFile | undefined;
  try {
    file = Object.freeze({
      name: basename(intent.path) || "task.jshare",
      mediaType: "application/vnd.joko.session",
      bytes: await readRegularFileSnapshot(intent.path, MAXIMUM_NATIVE_FILE_BYTES)
    });
  } catch {
    // Preserve a recoverable import surface without exposing the local path or
    // native filesystem error to the renderer.
  }
  return Object.freeze({ kind: "portable", ...(file === undefined ? {} : { file }) });
}

function deliverDesktopDeepLinkNavigation(navigation: DesktopDeepLinkNavigation): void {
  const immediate = desktopDeepLinkDelivery.offer(navigation);
  if (immediate === undefined) return;
  if (sendDesktopDeepLinkNavigation(immediate)) return;
  desktopDeepLinkDelivery.resetRenderer();
  desktopDeepLinkDelivery.offer(immediate);
}

function sendDesktopDeepLinkNavigation(navigation: DesktopDeepLinkNavigation): boolean {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoading()) {
    return false;
  }
  try {
    window.webContents.send(DESKTOP_CHANNELS.deepLinkNavigate, navigation);
    return true;
  } catch {
    return false;
  }
}

function showMainWindow(): void {
  if (!canShowDesktopWindow({
    quitting,
    channelQuitHandoffPending: desktopUpdateChannelQuitHandoffPending,
    nativeInstallQuitHandoffPending: desktopUpdateNativeInstallQuitHandoffPending,
    completeExitQuitHandoffPending: desktopCompleteExitQuitHandoffPending
  })) return;
  if (mainWindow === undefined || mainWindow.isDestroyed()) createWindow();
  if (mainWindow !== undefined) showWindowFromTray(mainWindow);
}

function installInspectorWindowSecurity(childWindow: BrowserWindow, owner: WebContents): void {
  inspectorWindow = childWindow;
  inspectorWindowOwner = owner;
  inspectorWindowReady = false;
  childWindow.webContents.setZoomFactor(currentWindowZoomFactor);

  installSelectionContextMenu(childWindow, {
    platform: process.platform,
    systemLocale: () => app.getLocale(),
    buildMenu: (template) => Menu.buildFromTemplate([...template]),
    openExternal: (url) => shell.openExternal(url)
  });

  // The child hosts only DOM owned by the main renderer's React portal. It
  // must never become a second application renderer or navigation surface.
  childWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  childWindow.webContents.on("will-prevent-unload", notifyDesktopQuitBlocked);
  childWindow.webContents.on("render-process-gone", () => {
    if (inspectorWindow === childWindow && !childWindow.isDestroyed()) childWindow.destroy();
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
    if (inspectorWindow !== childWindow) return;
    inspectorWindow = undefined;
    inspectorWindowReady = false;
    const notifyOwner = inspectorWindowOwner;
    inspectorWindowOwner = undefined;
    if (notifyOwner === undefined || notifyOwner.isDestroyed() || notifyOwner !== mainWindow?.webContents) return;
    notifyOwner.send(DESKTOP_CHANNELS.inspectorWindowClosed);
    if (mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.focus();
  });
}

function destroyInspectorWindow(): void {
  const childWindow = inspectorWindow;
  inspectorWindow = undefined;
  inspectorWindowOwner = undefined;
  inspectorWindowReady = false;
  if (childWindow !== undefined && !childWindow.isDestroyed()) childWindow.destroy();
}

function ensureTray(icon?: NativeImage): void {
  if (packagedSmoke) return;
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

async function closeWindowToTray(window: BrowserWindow): Promise<void> {
  const result = await hideWindowToAvailableTray(window, ensureTrayAvailable);
  if (result === "unavailable") {
    if (!window.isDestroyed()) {
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
  const settings = await desktopKeepAwakeSettings.initialize();
  desktopKeepAwakeController.apply(settings.enabled);
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
  if (action.kind === "focus") {
    dispatchDesktopNotificationSessionFocus(action.sessionId);
    return;
  }
  const window = mainWindow;
  if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send(DESKTOP_CHANNELS.nativeTaskStatusAction, action);
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

function broadcastDesktopWindowInteractionSettings(settings: DesktopWindowInteractionSettings): void {
  for (const window of applicationWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(DESKTOP_CHANNELS.windowInteractionChanged, settings);
    }
  }
  if (inspectorWindow !== undefined && !inspectorWindow.isDestroyed() &&
    !inspectorWindow.webContents.isDestroyed()) {
    inspectorWindow.webContents.send(DESKTOP_CHANNELS.windowInteractionChanged, settings);
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
  const window = mainWindow;
  if (window === undefined || window.isDestroyed()) return;
  try {
    window.webContents.send(DESKTOP_CHANNELS.updateChannelSettingsChanged, settings);
  } catch {
    // Renderer reload/crash cannot change the durable device setting.
  }
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
    if (settings.enableBeta !== previous.enableBeta) {
      const feedUrl = settings.enableBeta ? desktopUpdateBetaFeedUrl : desktopUpdateReleaseFeedUrl;
      if (feedUrl !== undefined) await service.changeFeed(feedUrl);
      service.startBackgroundPolling();
    }
    broadcastDesktopUpdateChannelSettings(settings);
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
    managedOrchestratorExitFence.releaseForRecovery();
    quitting = false;
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
      ? "The local Joko service could not be stopped."
      : "A window did not finish closing.",
    detail: orchestratorShutdownFailed
      ? "Joko was kept open so you can retry a complete exit without leaving the local Joko service running."
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
    throw error;
  }
}

async function stopManagedOrchestratorForCompleteExit(): Promise<void> {
  globalVoiceSystemAudioOwner = undefined;
  await Promise.all([
    managedOrchestratorExitFence.stop(),
    globalVoiceSystemAudio.releaseAll().catch(() => undefined)
  ]).then(() => undefined);
}

async function recoverManagedOrchestratorAfterUpdateApplyFailure(): Promise<void> {
  const nativeInstallQuitWasPending = desktopUpdateNativeInstallQuitHandoffPending;
  desktopUpdateNativeInstallQuitHandoffPending = false;
  if (nativeInstallQuitWasPending) quitting = false;
  if (quitting || desktopUpdateLifecycleDisposed) return;
  managedOrchestratorExitFence.releaseForRecovery();
  if (nativeInstallQuitWasPending) showMainWindow();
  if (managedOrchestratorStatus.state === "disabled") return;
  managedOrchestratorConnection = undefined;
  managedOrchestratorStatus = { state: "retryableError", reason: "serviceUnavailable" };
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

function showDesktopNotification(value: DesktopNotification): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: value.title, body: value.body });
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    activeDesktopNotifications.delete(notification);
    notification.removeListener("click", onClick);
    notification.removeListener("close", release);
    notification.removeListener("failed", release);
  };
  const onClick = (): void => {
    release();
    showMainWindow();
    if (value.sessionId !== undefined) dispatchDesktopNotificationSessionFocus(value.sessionId);
  };
  notification.once("click", onClick);
  notification.once("close", release);
  notification.once("failed", release);
  activeDesktopNotifications.add(notification);
  try {
    notification.show();
  } catch (error) {
    release();
    throw error;
  }
}

function dispatchDesktopNotificationSessionFocus(sessionId: string): void {
  const window = sessionWindows.get(sessionId) ?? mainWindow;
  if (window === undefined || window.isDestroyed()) return;
  showWindowFromTray(window);
  const send = (): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(DESKTOP_CHANNELS.notificationFocusSession, sessionId);
  };
  if (window.webContents.isLoading()) {
    window.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function disposeDesktopNotifications(): void {
  for (const notification of [...activeDesktopNotifications]) {
    try {
      notification.close();
    } catch {
      activeDesktopNotifications.delete(notification);
    }
  }
  activeDesktopNotifications.clear();
}

function parseDesktopNotification(value: unknown): DesktopNotification {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Desktop notification must be an exact object.");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort().join(",");
  if (keys !== "body,title" && keys !== "body,sessionId,title") {
    throw new TypeError("Desktop notification must contain only title, body, and optional sessionId.");
  }
  if (!isDesktopNotificationText(candidate["title"], 1, MAXIMUM_NOTIFICATION_TITLE_CHARACTERS, true) ||
    !isDesktopNotificationText(candidate["body"], 0, MAXIMUM_NOTIFICATION_BODY_CHARACTERS, false) ||
    (keys === "body,sessionId,title" && !isDesktopNotificationSessionId(candidate["sessionId"]))) {
    throw new TypeError("Desktop notification fields are invalid.");
  }
  return Object.freeze({
    title: candidate["title"] as string,
    body: candidate["body"] as string,
    ...(keys === "body,sessionId,title" ? { sessionId: candidate["sessionId"] as string } : {})
  });
}

function isDesktopNotificationText(
  value: unknown,
  minimumCharacters: number,
  maximumCharacters: number,
  requireNonWhitespace: boolean
): value is string {
  return typeof value === "string" && value.length >= minimumCharacters && value.length <= maximumCharacters &&
    !value.includes("\0") && (!requireNonWhitespace || value.trim().length > 0);
}

function isDesktopNotificationSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= MAXIMUM_NOTIFICATION_SESSION_ID_CHARACTERS && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
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
  ipcMain.handle(DESKTOP_CHANNELS.deepLinkTakePending, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (event.sender !== mainWindow?.webContents || parameters.length !== 0) {
      throw new Error("Desktop deep-link pull is restricted to the owner application window.");
    }
    return desktopDeepLinkDelivery.takeAfterRendererReady();
  });
  ipcMain.handle(DESKTOP_CHANNELS.selectionContextMenuSetLocale, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || !isDesktopLocale(parameters[0])) {
      throw new TypeError("Selection context-menu locale must be en, zh-CN, or en-XA.");
    }
    setSelectionContextMenuLocale(parameters[0]);
    applicationMenuLocale = parameters[0];
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
    if (parameters.length !== 1 || !isDesktopNotificationSessionId(parameters[0])) {
      throw new TypeError("Task window open requires one bounded task identity.");
    }
    return openSessionApplicationWindow(parameters[0]);
  });
  ipcMain.handle(DESKTOP_CHANNELS.sessionDragPreviewBegin, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || !isDesktopSessionDragPreviewRequest(parameters[0]) ||
      !isDesktopNotificationSessionId(parameters[0].sessionId)) {
      throw new TypeError("Task drag preview requires one exact bounded request.");
    }
    const source = trustedApplicationWindowForContents(event.sender);
    if (source === undefined || source === runtimeProcessMonitorWindow) {
      throw new Error("Task drag preview requires a primary task application window.");
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
    const opened = await openSessionApplicationWindow(completion.sessionId, completion.point);
    return { opened: true, focusedExisting: opened.focusedExisting } as const;
  });
  ipcMain.handle(DESKTOP_CHANNELS.runtimeProcessMonitorOpen, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Runtime process monitor open does not accept parameters.");
    const owner = trustedApplicationWindowForContents(event.sender);
    if (owner === undefined || owner === runtimeProcessMonitorWindow) {
      throw new Error("Runtime process monitor can only be opened by a primary application window.");
    }
    return openRuntimeProcessMonitorWindow(owner);
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
  ipcMain.handle(DESKTOP_CHANNELS.windowInteractionSet, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "boolean") {
      throw new TypeError("Window-interaction set requires one boolean.");
    }
    const settings = await requireDesktopWindowInteractionSettings()
      .setSwallowActivationClick(parameters[0]);
    broadcastDesktopWindowInteractionSettings(settings);
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
    assertTrustedIpcSender(event);
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle(DESKTOP_CHANNELS.windowToggleMaximize, (event) => {
    assertTrustedIpcSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) return false;
    if (window.isMaximized()) window.unmaximize(); else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle(DESKTOP_CHANNELS.windowClose, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop close does not accept parameters.");
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null || window.isDestroyed()) throw new Error("Desktop close request has no trusted window.");
    if (window === mainWindow) {
      await closeWindowToTray(window);
      return;
    }
    if (window === runtimeProcessMonitorWindow) {
      window.close();
      return;
    }
    const sessionId = sessionWindowIdsByContents.get(event.sender);
    if (sessionId === undefined || sessionWindows.get(sessionId) !== window) {
      throw new Error("Desktop close requests are restricted to application windows.");
    }
    window.close();
  });
  ipcMain.handle(DESKTOP_CHANNELS.inspectorWindowReady, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 0) throw new TypeError("Inspector readiness does not accept parameters.");
    const window = assertTrustedInspectorWindowSender(event);
    inspectorWindowReady = true;
    if (mainWindow?.isVisible() === true) {
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
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "number" || !Number.isFinite(parameters[0])) {
      throw new TypeError("Desktop zoom factor must be one finite number.");
    }
    const zoomFactor = parameters[0];
    if (zoomFactor < 0.5 || zoomFactor > 3 || Math.abs(zoomFactor * 10 - Math.round(zoomFactor * 10)) > Number.EPSILON * 10) {
      throw new RangeError("Desktop zoom factor must be from 0.5 through 3 in 0.1 increments.");
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null || window.isDestroyed() || trustedApplicationWindowForContents(event.sender) !== window) {
      throw new Error("Desktop zoom requests are restricted to application windows.");
    }
    currentWindowZoomFactor = zoomFactor;
    for (const applicationWindow of applicationWindows()) applicationWindow.webContents.setZoomFactor(zoomFactor);
    if (inspectorWindow !== undefined && !inspectorWindow.isDestroyed()) {
      inspectorWindow.webContents.setZoomFactor(zoomFactor);
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.inspectorWindowClose, (event, ...parameters: unknown[]) => {
    if (parameters.length !== 0) throw new TypeError("Inspector close does not accept parameters.");
    assertTrustedInspectorWindowSender(event).close();
  });
  ipcMain.handle(DESKTOP_CHANNELS.traySetIcon, (event, value: unknown) => {
    assertTrustedIpcSender(event);
    ensureTray(trayIconFromDataUrl(value));
  });
  ipcMain.handle(DESKTOP_CHANNELS.notify, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Desktop notification requires one notification object.");
    showDesktopNotification(parseDesktopNotification(parameters[0]));
  });
  ipcMain.handle(DESKTOP_CHANNELS.attentionMark, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Desktop attention mark requires one exact key.");
    requireDesktopAttentionBadgeController().mark(event.sender.id, parseDesktopAttentionKey(parameters[0]));
  });
  ipcMain.handle(DESKTOP_CHANNELS.attentionClear, (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1) throw new TypeError("Desktop attention clear requires one exact key.");
    requireDesktopAttentionBadgeController().clear(event.sender.id, parseDesktopAttentionKey(parameters[0]));
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
    if (event.sender !== mainWindow?.webContents && !sessionWindowIdsByContents.has(event.sender)) {
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
    const store = requireDesktopKeepAwakeSettings();
    await store.initialize();
    return store.get();
  });
  ipcMain.handle(DESKTOP_CHANNELS.keepAwakeSet, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 1 || typeof parameters[0] !== "boolean") {
      throw new TypeError("Desktop keep-awake set requires one boolean.");
    }
    const settings = await requireDesktopKeepAwakeSettings().setEnabled(parameters[0]);
    requireDesktopKeepAwakeController().apply(settings.enabled);
    return settings;
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
    const status = parseGlobalVoiceStatus(parameters[0]);
    if (status.state === "idle") {
      resetGlobalVoicePresentation();
    } else {
      globalVoiceActive = status.state !== "error";
      setGlobalVoiceStatus(status);
      showGlobalVoiceOverlay();
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceCommit, async (event, ...parameters: unknown[]) => {
    assertGlobalVoiceOwnerSender(event);
    if (parameters.length !== 1) throw new TypeError("Global voice commit requires one result.");
    const request = parseGlobalVoiceCommit(parameters[0]);
    setGlobalVoiceStatus({ state: "submitting", transcript: request.text.slice(0, 4_096) });
    try {
      const result = await insertTextIntoForegroundApplication(request.text, {
        clipboard,
        platform: process.platform,
        runCommand: runBoundedHostCommand
      });
      if (!result.inserted) {
        globalVoiceActive = false;
        setGlobalVoiceStatus({ state: "error", errorKind: "insertion" });
        return false;
      }
      void result.restored.catch(() => undefined);
      resetGlobalVoicePresentation();
      return true;
    } catch {
      globalVoiceActive = false;
      setGlobalVoiceStatus({ state: "error", errorKind: "insertion" });
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
  ipcMain.handle(DESKTOP_CHANNELS.globalVoiceOverlayAction, (event, ...parameters: unknown[]) => {
    assertGlobalVoiceOverlaySender(event);
    if (parameters.length !== 1 || (parameters[0] !== "cancel" && parameters[0] !== "retry")) {
      throw new TypeError("Global voice overlay action is invalid.");
    }
    if (parameters[0] === "cancel") {
      sendGlobalVoiceCommand({ type: "cancel" });
      resetGlobalVoicePresentation();
      return;
    }
    globalVoiceActive = true;
    beginGlobalVoiceSystemAudio();
    setGlobalVoiceStatus({ state: "starting" });
    showGlobalVoiceOverlay();
    sendGlobalVoiceCommand({ type: "retry" });
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
    await deleteCredential(profileId);
    if (managedOrchestratorConnection?.profileId === profileId) {
      managedOrchestratorRecoveryTarget = managedOrchestratorConnection;
      managedOrchestratorConnection = undefined;
      managedOrchestratorStatus = managedOrchestratorRecovery("credentialUnavailable");
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
    void desktopUpdateAutoRelaunchPolicy?.evaluate("settings-set");
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateAutoRelaunchSettingsReset, async (event, ...parameters: unknown[]) => {
    assertTrustedIpcSender(event);
    if (parameters.length !== 0) throw new TypeError("Desktop auto relaunch settings reset does not accept parameters.");
    const result = await requireDesktopUpdateAutoSettings().reset();
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

function requireDesktopKeepAwakeSettings(): DesktopKeepAwakeSettingsStore {
  if (desktopKeepAwakeSettings === undefined) {
    throw new Error("Desktop keep-awake settings are not initialized.");
  }
  return desktopKeepAwakeSettings;
}

function requireDesktopKeepAwakeController(): DesktopKeepAwakeController {
  if (desktopKeepAwakeController === undefined) {
    throw new Error("Desktop keep-awake controller is not initialized.");
  }
  return desktopKeepAwakeController;
}

function requireDesktopWindowInteractionSettings(): DesktopWindowInteractionSettingsStore {
  if (desktopWindowInteractionSettings === undefined) {
    throw new Error("Desktop window-interaction settings are not initialized.");
  }
  return desktopWindowInteractionSettings;
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
      environment: { ...process.env, ...outboundProxySnapshotEnvironment },
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

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const senderFrame = event.senderFrame;
  const expectedWindow = trustedApplicationWindowForContents(event.sender);
  if (!isTrustedIpcSenderIdentity({
    owner,
    expectedWindow,
    sender: event.sender,
    ownerContents: owner?.webContents,
    senderFrame,
    mainFrame: event.sender.mainFrame,
    frameUrl: senderFrame?.url
  }, navigationPolicy)) {
    throw new Error("Desktop IPC request did not originate from the trusted Joko application frame.");
  }
}

function trustedApplicationWindowForContents(contents: WebContents): BrowserWindow | undefined {
  const owner = BrowserWindow.fromWebContents(contents);
  if (owner === null || owner.isDestroyed() || owner.webContents !== contents) return undefined;
  if (owner === mainWindow) return owner;
  if (owner === runtimeProcessMonitorWindow) {
    return isRuntimeProcessMonitorNavigation(contents.getURL()) ? owner : undefined;
  }
  const sessionId = sessionWindowIdsByContents.get(contents);
  return sessionId !== undefined && sessionWindows.get(sessionId) === owner ? owner : undefined;
}

function isTrustedApplicationContents(contents: WebContents): boolean {
  const owner = trustedApplicationWindowForContents(contents);
  return owner !== undefined && isAllowedMainFrameNavigation(contents.getURL(), navigationPolicy);
}

function assertGlobalVoiceOwnerSender(event: IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event);
  if (event.sender !== mainWindow?.webContents) {
    throw new Error("Global voice control is restricted to the owner application window.");
  }
}

function assertGlobalVoiceSettingsSender(event: IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event);
  if (event.sender === mainWindow?.webContents || sessionWindowIdsByContents.has(event.sender)) return;
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
