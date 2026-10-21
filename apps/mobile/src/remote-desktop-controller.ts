import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { parseMobileRemoteDesktopNativeEvent, parseMobileRemoteDesktopNativeInputBatch, parseMobileRemoteDesktopNativeViewport,
  type MobileRemoteDesktopNativeInputBatch, type MobileRemoteDesktopNativeCommand } from "./remote-desktop-native-bridge";
import { RTC_NETWORK } from "./remote-desktop-viewer";
import { RemoteDesktopChannelClient, RemoteDesktopControlStateSchema, RemoteDesktopHostMuteResultSchema, RemoteDesktopPrivacyScreenResultSchema,
  RemoteDesktopClipboardSyncResultSchema, RemoteDesktopClipboardVersionResultSchema, RemoteDesktopDisplayModeSchema,
  parseRemoteDesktopChannelReply, isRemoteDesktopChannelId, type RemoteDesktopChannelRequest } from "@joko/contracts";
import { mobileRemoteDesktopModifiers, mobileRemoteDesktopShortcuts, type MobileRemoteDesktopKeyboardPage,
  type MobileRemoteDesktopKeyCode } from "./remote-desktop-keyboard";
import {
  RemoteDesktopFailureReason,
  RemoteDesktopFailureSchema,
  RemoteDesktopClipboardContentBeginActionSchema,
  RemoteDesktopClipboardContentCancelActionSchema,
  RemoteDesktopClipboardContentCommitActionSchema,
  RemoteDesktopClipboardContentCopyActionSchema,
  RemoteDesktopClipboardContentPasteActionSchema,
  RemoteDesktopClipboardContentReadActionSchema,
  RemoteDesktopClipboardContentRequestSchema,
  RemoteDesktopClipboardContentWriteActionSchema,
  RemoteDesktopClipboardTextCopyActionSchema,
  RemoteDesktopClipboardTextPasteActionSchema,
  RemoteDesktopClipboardTextRequestSchema,
  RemoteDesktopClipboardSyncRequestSchema,
  RemoteDesktopClipboardVersionRequestSchema,
  RemoteDesktopInputEventSchema,
  RemoteDesktopKeyInputSchema,
  RemoteDesktopMouseButton,
  RemoteDesktopPermissionStatus,
  RemoteDesktopPointerButtonInputSchema,
  RemoteDesktopPointerMoveInputSchema,
  RemoteDesktopReleaseInputSchema,
  RemoteDesktopScrollInputSchema,
  RemoteDesktopStartMode,
  RemoteDesktopVideoQuality,
  RemoteDesktopTextInputSchema,
  RemoteDesktopVideoSettingsSchema,
  type DevicePeerDescriptor,
  type RemoteDesktopCapabilities,
  type RemoteDesktopClipboardContentRequest,
  type RemoteDesktopClipboardContentResult,
  type RemoteDesktopClipboardTextRequest,
  type RemoteDesktopClipboardTextResult,
  type RemoteDesktopClipboardSyncRequest,
  type RemoteDesktopClipboardSyncResult,
  type RemoteDesktopClipboardVersionRequest,
  type RemoteDesktopClipboardVersionResult,
  type RemoteDesktopControlState,
  type RemoteDesktopCursor,
  type RemoteDesktopDisplay, type RemoteDesktopDisplayMode, type RemoteDesktopDisplayModeResult,
  type RemoteDesktopViewerDisplayResult,
  type RemoteDesktopFrameResult,
  type RemoteDesktopHostMuteResult,
  type RemoteDesktopPrivacyScreenResult,
  type RemoteDesktopIceCandidate,
  type RemoteDesktopIceExchangeResult,
  type RemoteDesktopIceServer,
  type RemoteDesktopInputEvent,
  type RemoteDesktopLease,
  type RemoteDesktopOfferResult,
  type RemoteDesktopPermissions,
  type RemoteDesktopVideoSettings
} from "@joko/contracts";
import {
  MOBILE_REMOTE_CLIPBOARD_CHUNK_CHARS,
  MOBILE_REMOTE_CLIPBOARD_TRANSFER_CHARS,
  MOBILE_REMOTE_CLIPBOARD_TRANSFER_MS,
  MobileRemoteClipboardError,
  parseMobileRemoteClipboardItem,
  serializeMobileRemoteClipboardItem,
  type MobileRemoteClipboardSystem
} from "./mobile-remote-desktop-clipboard";
import {
  MOBILE_REMOTE_DESKTOP_DEFAULT_VIDEO_SETTINGS,
  isMobileRemoteDesktopVideoSettings,
  type MobileRemoteDesktopVideoSettings
} from "./mobile-remote-desktop-video-preference";
import type {
  MobileRemoteDesktopHostMuteIdentity,
  MobileRemoteDesktopHostMutePreferences,
  MobileRemoteDesktopPreferenceOwner
} from "./mobile-remote-desktop-host-mute-preference";
import type { MobileRemoteDesktopLockIdentity, MobileRemoteDesktopLockPreferences } from "./mobile-remote-desktop-lock-preference";
import type { MobileRemoteDesktopClipboardSyncPreferences } from "./mobile-remote-desktop-clipboard-sync-preference";
import type { MobileRemoteDesktopPrivacyIdentity, MobileRemoteDesktopPrivacyPreferences } from "./mobile-remote-desktop-privacy-preference";
import { ClipboardSync, ClipboardSyncError, getClipboardSyncFailure,
  type ClipboardSyncBaseline, type LocalClipboardReadCache } from "@joko/remote-desktop-sync";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { MobileRemoteDesktopCredentials, mobileCredentialDefaults,
  type MobileRemoteDesktopCredentialSnapshot, type MobileRemoteDesktopCredentialAction } from "./mobile-remote-desktop-credentials";
import type { MobileRemoteDesktopCredentialsNative } from "./mobile-remote-desktop-credentials-native";
import type { RemoteDesktopSystemAction } from "@joko/contracts";

// Memory-only native read evidence. It never contains clipboard payloads or permissions.
const localClipboardReadCache: LocalClipboardReadCache = {};

export const MOBILE_REMOTE_DESKTOP_HEARTBEAT_MS = 3_000;
export const MOBILE_REMOTE_DESKTOP_FRAME_MS = 250;
export const MOBILE_REMOTE_DESKTOP_LEASE_MS = 12_000;

export type MobileRemoteDesktopStatus =
  | "loading" | "select-host" | "select-display" | "connecting" | "capture-pending" | "live"
  | "reconnecting" | "offline" | "unsupported" | "permission" | "revoked"
  | "busy" | "stopped" | "error";

export type MobileRemoteDesktopInputMode = "touch" | "trackpad" | "pan";
export interface MobileRemoteDesktopKeyPress { readonly id: number; readonly occurrence: number; }
export type MobileRemoteDesktopMouseControl = "left" | "right" | "wheel";
export interface MobileRemoteDesktopMouseGrant { readonly id: number; readonly occurrence: number; }
export interface MobileRemoteDesktopTouchpadGrant { readonly id: number; readonly occurrence: number; }
export interface MobileRemoteDesktopViewportConfiguration {
  readonly fitToInsets: boolean;
  readonly topInset: number;
  readonly bottomInset: number;
}

export type MobileRemoteDesktopNotice =
  | "no-hosts" | "unavailable" | "screen-permission" | "screen-permission-guide"
  | "authority-changed" | "compatibility" | "input-overflow" | "view-only"
  | "accessibility-permission" | "input-busy" | "input-unavailable"
  | "input-recovering"
  | "busy" | "stopped" | "viewer-restarted" | "audio-unavailable"
  | "video-settings-failed" | "pip-unavailable" | "capture-pending" | "generic-error";

export type MobileRemoteDesktopClipboardNotice =
  | "copied" | "pasted" | "empty" | "unsupported" | "too-large"
  | "unavailable" | "busy" | "failed";

export type MobileRemoteDesktopDisplayModeNotice = "load-failed" | "change-failed" | "restore-unavailable";

export interface MobileRemoteDesktopSnapshot {
  readonly credentials: MobileRemoteDesktopCredentialSnapshot;
  readonly status: MobileRemoteDesktopStatus;
  readonly hosts: readonly DevicePeerDescriptor[];
  readonly host?: DevicePeerDescriptor;
  readonly capabilities?: RemoteDesktopCapabilities;
  readonly permissions?: RemoteDesktopPermissions;
  readonly permissionCheckStatus: "idle" | "checking" | "ready" | "failed";
  readonly permissionGuideStatus: "idle" | "pending" | "opened" | "failed" | "unknown";
  readonly permissionNotice?: "check-failed" | "guide-opened" | "guide-failed" | "guide-unknown";
  readonly selectedDisplayId?: string;
  readonly displaySwitchBusy: boolean;
  readonly displaySwitchNotice?: "stop-failed" | "display-missing";
  readonly controlling: boolean;
  readonly wantedControl: boolean;
  readonly inputMode: MobileRemoteDesktopInputMode;
  readonly mouseButtons: boolean;
  readonly mouseOccurrence: number;
  readonly touchpadOccurrence: number;
  readonly keyboardOpen: boolean;
  readonly keyboardMode: "inputMethod" | "computer";
  readonly keyboardPage: MobileRemoteDesktopKeyboardPage;
  readonly keyboardCombo: boolean;
  readonly keyboardModifiers: readonly MobileRemoteDesktopKeyCode[];
  readonly keyboardOccurrence: number;
  readonly backgroundViewing: boolean;
  readonly restoreRequest?: string;
  readonly network?: { readonly transport: "direct" | "relay" | "video" | "screenshot";
    readonly bytesPerSecond: number | null; readonly latencyMs: number | null };
  readonly media: "none" | "webrtc" | "jpeg";
  readonly hasFrame: boolean;
  readonly takeoverAvailable: boolean;
  readonly clipboardAvailable: boolean;
  readonly clipboardBusy: boolean;
  readonly clipboardNotice?: MobileRemoteDesktopClipboardNotice;
  readonly clipboardSync: boolean;
  readonly clipboardSyncLoaded: boolean;
  readonly clipboardSyncSaving: boolean;
  readonly clipboardSyncActive: boolean;
  readonly clipboardSyncNotice?: "load-failed" | "save-failed" | "skipped" | "conflict" | "permission" | "failed" | "unknown";
  readonly videoSettings: MobileRemoteDesktopVideoSettings;
  readonly videoSettingsBusy: boolean;
  readonly displayModes: readonly RemoteDesktopDisplayMode[];
  readonly displayModesStatus: "idle" | "loading" | "ready" | "error";
  readonly displayModeBusy: boolean;
  readonly viewerDisplayFitted: boolean;
  readonly displayModeNotice?: MobileRemoteDesktopDisplayModeNotice;
  readonly systemActionPending: boolean;
  readonly systemActionFailure?: RemoteDesktopSystemAction;
  readonly pipAvailable: boolean;
  readonly presenting: boolean;
  readonly hostMute: boolean;
  readonly hostMuteLoaded: boolean;
  readonly hostMutePending: boolean;
  readonly hostMuteActive: boolean;
  readonly hostMuteNotice?: "load-failed" | "save-failed" | "apply-failed";
  readonly privacyScreen: boolean;
  readonly privacyScreenLoaded: boolean;
  readonly privacyScreenPending: boolean;
  readonly privacyScreenActive: boolean;
  readonly privacyScreenNotice?: "load-failed" | "save-failed" | "privacy-failed";
  readonly lockOnExit: boolean;
  readonly lockOnExitLoaded: boolean;
  readonly lockOnExitPending: boolean;
  readonly lockOnExitNotice?: "load-failed" | "save-failed";
  readonly navigationRetained: boolean;
  readonly exitStatus: "idle" | "pending" | "failed" | "closed";
  readonly exitLockRequested: boolean;
  readonly exitNotice?: "lock-expired" | "lock-unavailable" | "lock-failed" | "exit-failed" | "authority-changed";
  readonly notice?: MobileRemoteDesktopNotice;
}

export interface MobileRemoteDesktopPresentation {
  readonly nativeVideo?: boolean;
  sendInput?(batch: MobileRemoteDesktopNativeInputBatch): Promise<boolean>;
  sendRequest?(request: { readonly epoch: string; readonly attemptId: string; readonly message: RemoteDesktopChannelRequest }): Promise<boolean>;
  readonly nativePictureInPicture: boolean;
  readonly requiresPlaybackSession: boolean;
  playback(enabled: boolean): Promise<void>;
}

export interface MobileRemoteDesktopTransport {
  beginBackgroundTransition?(host: DevicePeerDescriptor, leaseId: string): { isCurrent(): boolean; close(): void } | undefined;
  lockState?(host: DevicePeerDescriptor, signal?: AbortSignal): Promise<import("@joko/contracts").RemoteDesktopLockState>;
  credentials?(host: DevicePeerDescriptor, request: import("@joko/contracts").RemoteDesktopCredentialRequest,
    signal?: AbortSignal): Promise<import("@joko/contracts").RemoteDesktopCredentialResult>;
  readonly ownerKey: string;
  readonly preferenceOwner: MobileRemoteDesktopPreferenceOwner;
  isCurrent(): boolean;
  canStop(): boolean;
  listHosts(signal?: AbortSignal): Promise<readonly DevicePeerDescriptor[]>;
  capabilities(host: DevicePeerDescriptor, signal?: AbortSignal): Promise<RemoteDesktopCapabilities>;
  permissions(host: DevicePeerDescriptor, signal?: AbortSignal): Promise<RemoteDesktopPermissions>;
  showPermissionGuide(host: DevicePeerDescriptor, signal?: AbortSignal): Promise<RemoteDesktopPermissions>;
  start(host: DevicePeerDescriptor, displayId: string, mode: RemoteDesktopStartMode,
    signal?: AbortSignal): Promise<RemoteDesktopLease>;
  heartbeat(host: DevicePeerDescriptor, leaseId: string, signal?: AbortSignal): Promise<RemoteDesktopControlState>;
  stop(host: DevicePeerDescriptor, leaseId: string,
    exit: { readonly lockScreen: boolean; readonly controlGeneration: bigint }, signal?: AbortSignal): Promise<void>;
  control(host: DevicePeerDescriptor, leaseId: string, enabled: boolean,
    signal?: AbortSignal): Promise<RemoteDesktopControlState>;
  systemAction(host: DevicePeerDescriptor, leaseId: string, controlGeneration: bigint, action: RemoteDesktopSystemAction,
    signal?: AbortSignal): Promise<RemoteDesktopSystemAction>;
  setHostMute(host: DevicePeerDescriptor, leaseId: string, controlGeneration: bigint, enabled: boolean,
    signal?: AbortSignal): Promise<RemoteDesktopHostMuteResult>;
  setPrivacyScreen(host: DevicePeerDescriptor, leaseId: string, controlGeneration: bigint, enabled: boolean,
    lockOnExit: boolean, signal?: AbortSignal): Promise<RemoteDesktopPrivacyScreenResult>;
  presentation(host: DevicePeerDescriptor, leaseId: string, enabled: boolean,
    signal?: AbortSignal): Promise<RemoteDesktopControlState>;
  input(host: DevicePeerDescriptor, leaseId: string, sequence: bigint,
    events: readonly RemoteDesktopInputEvent[], signal?: AbortSignal): Promise<void>;
  iceConfiguration(host: DevicePeerDescriptor, leaseId: string,
    signal?: AbortSignal): Promise<readonly RemoteDesktopIceServer[]>;
  offer(host: DevicePeerDescriptor, leaseId: string, attemptId: string, sdp: string,
    settings: RemoteDesktopVideoSettings | undefined,
    cursorOverlay: boolean, signal?: AbortSignal): Promise<RemoteDesktopOfferResult>;
  ice(host: DevicePeerDescriptor, leaseId: string, attemptId: string,
    candidates: readonly RemoteDesktopIceCandidate[], after: number,
    signal?: AbortSignal): Promise<RemoteDesktopIceExchangeResult>;
  frame(host: DevicePeerDescriptor, leaseId: string, cursorOverlay: boolean,
    signal?: AbortSignal): Promise<RemoteDesktopFrameResult>;
  listDisplayModes(host: DevicePeerDescriptor, leaseId: string,
    signal?: AbortSignal): Promise<readonly RemoteDesktopDisplayMode[]>;
  setDisplayMode(host: DevicePeerDescriptor, leaseId: string, controlGeneration: bigint, modeId: string,
    temporary: boolean, signal?: AbortSignal): Promise<RemoteDesktopDisplayModeResult>;
  fitViewerDisplay?(host: DevicePeerDescriptor, leaseId: string, controlGeneration: bigint, width: number, height: number,
    signal?: AbortSignal): Promise<RemoteDesktopViewerDisplayResult>;
  restoreViewerDisplay?(host: DevicePeerDescriptor, leaseId: string, controlGeneration: bigint,
    signal?: AbortSignal): Promise<RemoteDesktopViewerDisplayResult>;
  clipboardText(host: DevicePeerDescriptor, request: RemoteDesktopClipboardTextRequest,
    signal?: AbortSignal): Promise<RemoteDesktopClipboardTextResult>;
  clipboardContent(host: DevicePeerDescriptor, request: RemoteDesktopClipboardContentRequest,
    signal?: AbortSignal): Promise<RemoteDesktopClipboardContentResult>;
  setClipboardSync(host: DevicePeerDescriptor, request: RemoteDesktopClipboardSyncRequest,
    signal?: AbortSignal): Promise<RemoteDesktopClipboardSyncResult>;
  clipboardVersion(host: DevicePeerDescriptor, request: RemoteDesktopClipboardVersionRequest,
    signal?: AbortSignal): Promise<RemoteDesktopClipboardVersionResult>;
}

export class MobileRemoteDesktopAuthorityError extends Error {
  constructor() { super("The Remote Desktop authority is no longer current."); }
}

export type MobileRemoteDesktopViewerCommand = Readonly<Record<string, unknown>>;

interface ClipboardOperation {
  readonly sync: boolean;
  effectStarted?: boolean;
  readonly sequence: number;
  readonly request: AbortController;
  readonly ownerSignal: AbortSignal;
  deadline: number;
  timeout?: ReturnType<typeof setTimeout>;
  retired: boolean;
  readonly retire: () => void;
}

interface ClipboardContext {
  readonly operation: ClipboardOperation;
  readonly host: DevicePeerDescriptor;
  readonly lease: RemoteDesktopLease;
  readonly generation: number;
  readonly controlGeneration: bigint;
}

interface ClipboardSyncScope {
  readonly key: string;
  readonly host: DevicePeerDescriptor;
  readonly leaseId: string;
  readonly controlGeneration: bigint;
  readonly request: AbortController;
  readonly generation: number;
  syncGeneration?: bigint;
  engine?: ClipboardSync;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  failures: number;
}

interface DisplayModeReconnect {
  readonly hostKey: string;
  readonly displayId: string;
  readonly expiresAt?: number;
  readonly restoreControl: boolean;
}

interface DisplaySwitch {
  readonly host: DevicePeerDescriptor;
  readonly lease?: RemoteDesktopLease;
  readonly displayId: string;
  stopConfirmed: boolean;
}

interface PermissionScope {
  readonly key: string;
  readonly host: DevicePeerDescriptor;
  readonly hostKey: string | undefined;
  readonly ownerKey: string;
  readonly generation: number;
  readonly ownerSignal: AbortSignal;
  readonly request: AbortController;
  timer?: ReturnType<typeof setInterval>;
}

interface MobileSystemActionContext {
  readonly action: RemoteDesktopSystemAction;
  readonly host: DevicePeerDescriptor;
  readonly leaseId: string;
  readonly generation: number;
  readonly controlGeneration: bigint;
  readonly viewerOccurrence: number;
  readonly viewerEpoch: string | undefined;
  readonly request: AbortController;
  readonly ownerSignal: AbortSignal;
  readonly retire: () => void;
}

interface MobileKeyboardScope {
  readonly hostKey: string | undefined;
  readonly leaseId: string;
  readonly generation: number;
  readonly controlGeneration: bigint;
  readonly viewerOccurrence: number;
  readonly viewerEpoch: string;
}

interface MobileMouseScope extends MobileKeyboardScope {
  readonly sequenceBase: number;
  readonly sequenceLimit: number;
  readonly inputMode: MobileRemoteDesktopInputMode;
  readonly keyboardPage: MobileRemoteDesktopKeyboardPage;
}

interface MobilePresentationTransition {
  readonly host: DevicePeerDescriptor;
  readonly lease: RemoteDesktopLease;
  readonly generation: number;
  readonly epoch: string | undefined;
  readonly attemptId: string | undefined;
  readonly ticket?: { isCurrent(): boolean; close(): void };
  readonly completion: Promise<boolean>;
  readonly settle: (active: boolean) => void;
  acknowledged: boolean;
  actual: boolean;
}

interface MobileRemoteDesktopExitContext {
  readonly host: DevicePeerDescriptor;
  readonly lease: RemoteDesktopLease;
  readonly ownerKey: string;
  readonly lockScreen: boolean;
  readonly controlGeneration: bigint;
  readonly request: AbortController;
}

const initialSnapshot = (): MobileRemoteDesktopSnapshot => Object.freeze({
  status: "loading",
  permissionCheckStatus: "idle",
  permissionGuideStatus: "idle",
  displaySwitchBusy: false,
  hosts: Object.freeze([]),
  controlling: false,
  wantedControl: false,
  inputMode: "touch",
  mouseButtons: false,
  mouseOccurrence: 0,
  touchpadOccurrence: 0,
  keyboardOpen: false, keyboardMode: "inputMethod", keyboardPage: "abc", keyboardCombo: true,
  keyboardModifiers: Object.freeze([]), keyboardOccurrence: 0,
  backgroundViewing: false,
  media: "none",
  hasFrame: false,
  takeoverAvailable: false,
  clipboardAvailable: false,
  clipboardBusy: false,
  clipboardSync: false, clipboardSyncLoaded: false, clipboardSyncSaving: false, clipboardSyncActive: false,
  videoSettings: MOBILE_REMOTE_DESKTOP_DEFAULT_VIDEO_SETTINGS,
  videoSettingsBusy: false,
  displayModes: Object.freeze([]),
  displayModesStatus: "idle",
  displayModeBusy: false,
  viewerDisplayFitted: false,
  systemActionPending: false,
  pipAvailable: false,
  presenting: false,
  hostMute: false,
  hostMuteLoaded: false,
  hostMutePending: false,
  hostMuteActive: false,
  privacyScreen: false,
  privacyScreenLoaded: false,
  privacyScreenPending: false,
  privacyScreenActive: false,
  lockOnExit: false,
  lockOnExitLoaded: false,
  lockOnExitPending: false,
  navigationRetained: false,
  exitStatus: "idle",
  exitLockRequested: false,
  credentials: mobileCredentialDefaults
});

const RETRY_MS = Object.freeze([1_000, 3_000, 8_000] as const);
// A renderer occurrence owns one disjoint sequence range. Reserving the final
// value lets native release held input before a replacement renderer starts,
// while keeping every DataChannel sequence exact in JavaScript.
const INPUT_SEQUENCE_BLOCK = 1_000_000_000;
const PUBLIC_STUN = Object.freeze([
  Object.freeze({ urls: Object.freeze(["stun:stun.cloudflare.com:3478"]) }),
  Object.freeze({ urls: Object.freeze(["stun:stun.l.google.com:19302"]) })
]);
const ATTEMPT = /^[a-zA-Z0-9_-]{1,128}$/u;
const REMOTE_DESKTOP_MODE_ID = /^[0-9]{1,10}$/u;
const KEY_CODES = new Set([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((key) => `Key${key}`),
  ..."0123456789".split("").map((key) => `Digit${key}`),
  ...Array.from({ length: 12 }, (_value, index) => `F${index + 1}`),
  "Enter", "Escape", "Tab", "Space", "Backspace", "Delete", "Insert", "Home", "End",
  "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft",
  "ControlLeft", "AltLeft", "MetaLeft", "Minus", "Equal", "BracketLeft", "BracketRight",
  "Backslash", "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash"
]);

export class MobileRemoteDesktopController {
  #snapshot = initialSnapshot();
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #request = new AbortController();
  #lease?: RemoteDesktopLease;
  #resumeEligible = false;
  #viewerReady = false;
  #viewerEpoch?: string;
  #viewerOccurrence = 0;
  #viewerSequenceBase = 0;
  #viewerSequenceLimit = INPUT_SEQUENCE_BLOCK - 2;
  #viewerReleaseSequence = INPUT_SEQUENCE_BLOCK - 1;
  #mediaAttempt?: { readonly epoch: string; readonly attemptId: string };
  #foreground = true;
  #interactive = true;
  #online = true;
  #disposed = false;
  #heartbeatTimer?: ReturnType<typeof setInterval>;
  #frameTimer?: ReturnType<typeof setInterval>;
  #retryTimer?: ReturnType<typeof setTimeout>;
  #retryIndex = 0;
  #framePending = false;
  #frameAwaitingPresentation?: { readonly epoch: string; readonly frameId: string; readonly bytes: number;
    readonly receivedAt: number; readonly latencyMs: number };
  #frameRequest?: AbortController;
  #frameSequence = 0;
  #heartbeatPending = false;
  #heartbeatCompletion?: Promise<void>;
  #inputPending = false;
  #inputBatch?: object;
  #interactionRelease?: Promise<void>;
  #controlGeneration = 0n;
  #clipboardSequence = 0;
  #clipboardOperation?: ClipboardOperation;
  #audioUnavailable = false;
  #playbackActive = false;
  #playbackDesired = false;
  #playbackOperation: Promise<void> = Promise.resolve();
  #presentationState: "idle" | "requesting" | "active" = "idle";
  #presentationTimer?: ReturnType<typeof setTimeout>;
  #presentationTransition?: MobilePresentationTransition;
  #presentationRestore?: { readonly epoch: string; readonly attemptId: string; readonly restoreId: number };
  #nativeFrameReady = false;
  #nativeInputGrantKey?: string;
  #nativePipPolicyKey?: string;
  #frameMetricsAt?: number;
  #frameMetricsBytes = 0;
  #settingsApplying = false;
  #pendingSettingsReconnect = false;
  #offerPending = false;
  #offerOperation?: object;
  #displayModesPending = false;
  #systemActionOperation?: MobileSystemActionContext;
  #systemActionRetry?: MobileSystemActionContext;
  #keyboardScope?: MobileKeyboardScope;
  #mouseSequence = 0;
  #mouseOccurrence = 0;
  #mouseConfiguration?: { readonly nativeControls: boolean;
    readonly labels: { readonly left: string; readonly right: string; readonly wheel: string } };
  #mouseConfigurationKey?: string;
  readonly #mouseGrants = new Map<MobileRemoteDesktopMouseGrant, { readonly control: MobileRemoteDesktopMouseControl;
    readonly scope: MobileMouseScope; y: number }>();
  #touchpadSequence = 0;
  #touchpadOccurrence = 0;
  #viewportConfiguration?: MobileRemoteDesktopViewportConfiguration;
  #viewportConfigurationKey?: string;
  readonly #touchpadGrants = new Map<MobileRemoteDesktopTouchpadGrant, MobileMouseScope>();
  #keyPressSequence = 0;
  readonly #keyPresses = new Map<MobileRemoteDesktopKeyPress, { readonly code: MobileRemoteDesktopKeyCode;
    readonly keys: readonly MobileRemoteDesktopKeyCode[]; readonly scope: MobileKeyboardScope }>();
  #displayModeOperation?: { readonly request: AbortController };
  #displayModeReconnect?: DisplayModeReconnect;
  #displaySwitch?: DisplaySwitch;
  #displaySwitchCompletion?: Promise<void>;
  #permissionGuideVisible = false;
  #permissionBlocked = false;
  #permissionScope?: PermissionScope;
  #permissionCheck?: { readonly scope: PermissionScope; readonly ordinal: number };
  #permissionGuide?: { readonly scope: PermissionScope; readonly ordinal: number };
  #permissionReadSequence = 0;
  #permissionReadAdopted = 0;
  #temporaryModeUncertain = false;
  #queuedOffer?: { readonly epoch: string; readonly attemptId: string; readonly sdp: string };
  #viewerPipSupported = false;
  #viewerSink: (message: MobileRemoteDesktopViewerCommand) => void = () => undefined;
  #hostMutePreferenceOperation = 0;
  #hostMuteSaving = false;
  #hostMuteFailedSave?: boolean;
  #hostMuteOccurrence = 0;
  #hostMuteScope?: { readonly key: string; readonly host: DevicePeerDescriptor;
    readonly leaseId: string; readonly controlGeneration: bigint };
  #hostMuteOperation?: AbortController;
  #hostMuteAttempt?: string;
  #hostMuteTail: Promise<void> = Promise.resolve();
  #privacyPreferenceOperation = 0;
  #privacySaving = false;
  #privacyFailedSave?: boolean;
  #privacyScope?: { readonly key: string; readonly host: DevicePeerDescriptor;
    readonly leaseId: string; readonly controlGeneration: bigint };
  #privacyOperation?: AbortController;
  #privacyAttempt?: string;
  #privacyTail: Promise<void> = Promise.resolve();
  #routeFocused = true;
  #lockPreferenceOperation = 0;
  #lockFailedSave?: boolean;
  #navigationExit?: MobileRemoteDesktopExitContext;
  #exitContext?: MobileRemoteDesktopExitContext;
  #exitCompletion?: Promise<"closed" | "failed">;
  #clipboardSyncPreferenceOperation = 0;
  #clipboardSyncFailedSave?: boolean;
  #clipboardSyncAttempt = 0;
  #clipboardSyncBaseline: ClipboardSyncBaseline = { local: "", remote: "" };
  #clipboardSyncScope?: ClipboardSyncScope;
  #clipboardSyncTail: Promise<void> = Promise.resolve();
  readonly #credentials?: MobileRemoteDesktopCredentials;
  readonly #channel = new RemoteDesktopChannelClient();
  #controlRecoveryWanted = false;
  #controlRequest?: object;
  readonly transport: MobileRemoteDesktopTransport;

  constructor(
    transport: MobileRemoteDesktopTransport,
    private readonly preferredDeviceId?: string,
    private readonly clipboard?: MobileRemoteClipboardSystem,
    private readonly presentation?: MobileRemoteDesktopPresentation,
    private readonly hostMutePreferences?: MobileRemoteDesktopHostMutePreferences,
    private readonly lockPreferences?: MobileRemoteDesktopLockPreferences,
    private readonly clipboardSyncPreferences?: MobileRemoteDesktopClipboardSyncPreferences,
    private readonly privacyPreferences?: MobileRemoteDesktopPrivacyPreferences,
    private readonly credentialEnvironment?: { readonly native: MobileRemoteDesktopCredentialsNative;
      readonly locale: () => string; readonly theme: () => "light" | "dark" }
  ) {
    const channelTransport: Pick<MobileRemoteDesktopTransport, "control" | "presentation" | "setHostMute" | "setPrivacyScreen" | "systemAction" | "listDisplayModes" | "setClipboardSync" | "clipboardVersion"> = {
      control: (host, lease, enabled, signal) => this.#smallRequest(host, { op: "control", lease, enabled }, signal,
        () => transport.control(host, lease, enabled, signal), channelControlState),
      presentation: (host, lease, enabled, signal) => this.#smallRequest(host, { op: "presentation", lease, enabled }, signal,
        () => transport.presentation(host, lease, enabled, signal), channelControlState),
      setHostMute: (host, lease, controlGeneration, enabled, signal) => this.#smallRequest(host, { op: "hostMute", lease, controlGeneration: Number(controlGeneration), enabled }, signal,
        () => transport.setHostMute(host, lease, controlGeneration, enabled, signal), result => create(RemoteDesktopHostMuteResultSchema, { enabled: channelEnabled(result) })),
      setPrivacyScreen: (host, lease, controlGeneration, enabled, lockOnExit, signal) => this.#smallRequest(host, { op: "privacyScreen", lease, controlGeneration: Number(controlGeneration), enabled, lockOnExit }, signal,
        () => transport.setPrivacyScreen(host, lease, controlGeneration, enabled, lockOnExit, signal), result => create(RemoteDesktopPrivacyScreenResultSchema, { enabled: channelEnabled(result) })),
      systemAction: (host, lease, controlGeneration, action, signal) => this.#smallRequest(host, { op: "systemAction", lease, controlGeneration: Number(controlGeneration), action }, signal,
        () => transport.systemAction(host, lease, controlGeneration, action, signal), result => {
          if (!isRecord(result) || result.action !== action) throw new Error("REMOTE_DESKTOP_REQUEST_FAILED"); return action;
        }),
      listDisplayModes: (host, lease, signal) => this.#smallRequest(host, { op: "displayModes", lease }, signal,
        () => transport.listDisplayModes(host, lease, signal), result => {
          if (!isRecord(result) || !Array.isArray(result.modes) || result.modes.length > 256) throw new Error("REMOTE_DESKTOP_REQUEST_FAILED");
          return result.modes.map(mode => {
            if (!isRecord(mode) || typeof mode.id !== "string" || !Number.isSafeInteger(mode.width) || !Number.isSafeInteger(mode.height)
              || typeof mode.current !== "boolean" || typeof mode.native !== "boolean") throw new Error("REMOTE_DESKTOP_REQUEST_FAILED");
            return create(RemoteDesktopDisplayModeSchema, { modeId: mode.id, width: mode.width as number, height: mode.height as number,
              current: mode.current, native: mode.native });
          });
        }),
      setClipboardSync: (host, request, signal) => this.#smallRequest(host, { op: "clipboardSync", lease: request.leaseId,
        controlGeneration: Number(request.controlGeneration), enabled: request.enabled }, signal, () => transport.setClipboardSync(host, request, signal), result => {
          if (!isRecord(result)) throw new Error("REMOTE_DESKTOP_REQUEST_FAILED");
          return create(RemoteDesktopClipboardSyncResultSchema, { enabled: channelEnabled(result), syncGeneration: channelGeneration(result.syncGeneration) });
        }),
      clipboardVersion: (host, request, signal) => this.#smallRequest(host, { op: "clipboardVersion", lease: request.leaseId,
        controlGeneration: Number(request.controlGeneration), syncGeneration: Number(request.syncGeneration) }, signal, () => transport.clipboardVersion(host, request, signal), result => {
          if (!isRecord(result) || typeof result.version !== "string" || result.version.length > 512) throw new Error("REMOTE_DESKTOP_REQUEST_FAILED");
          return create(RemoteDesktopClipboardVersionResultSchema, { version: result.version });
        })
    };
    this.transport = Object.assign(Object.create(transport) as MobileRemoteDesktopTransport, channelTransport);
    if (credentialEnvironment) this.#credentials = new MobileRemoteDesktopCredentials(credentialEnvironment.native,
      (credentials) => { if (!this.#disposed) this.#set({ ...this.#snapshot, credentials }); });
  }

  async #smallRequest<T>(host: DevicePeerDescriptor, request: RemoteDesktopChannelRequest["request"], signal: AbortSignal | undefined, fallback: () => Promise<T>, decode: (result: unknown) => T): Promise<T> {
    signal?.throwIfAborted();
    const epoch = this.#viewerEpoch, attemptId = this.#mediaAttempt?.attemptId;
    if (!this.#snapshot.capabilities?.channelRequests || this.#snapshot.media !== "webrtc" || !epoch || !attemptId
      || request.lease !== this.#lease?.leaseId || peerKey(host) !== peerKey(this.#snapshot.host)
      || !this.#foreground || !this.#online || !this.transport.isCurrent()) return fallback();
    const result = await this.#channel.request(request, message => {
      signal?.throwIfAborted();
      if (epoch !== this.#viewerEpoch || !this.#mediaAttemptCurrent(attemptId)) return false;
      if (this.presentation?.nativeVideo) return this.presentation.sendRequest?.({ epoch, attemptId, message }) ?? false;
      this.#emit({ type: "channelRequest", epoch, attemptId, message });
    });
    if (!result.available) return fallback();
    signal?.throwIfAborted();
    if (epoch !== this.#viewerEpoch || !this.#mediaAttemptCurrent(attemptId) || request.lease !== this.#lease?.leaseId
      || peerKey(host) !== peerKey(this.#snapshot.host)) {
      throw new Error("REMOTE_DESKTOP_REQUEST_RESULT_UNKNOWN");
    }
    return decode(result.result);
  }

  private bindCredentials(): void {
    const host = this.#snapshot.host, capabilities = this.#snapshot.capabilities, environment = this.credentialEnvironment;
    if (!host || !capabilities || !environment || !this.#credentials) return;
    const key = peerKey(host), platform = capabilities.platform;
    const current = (): boolean => !this.#disposed && this.#foreground && this.#routeFocused && this.transport.isCurrent() &&
      this.#snapshot.exitStatus === "idle" && peerKey(this.#snapshot.host) === key && this.#snapshot.capabilities?.platform === platform;
    this.#credentials.bind({ key: `${this.transport.ownerKey}:${key}:${platform}`, owner: { profileId: this.transport.preferenceOwner.profileId,
      serverId: this.transport.preferenceOwner.serverId, deviceId: this.transport.preferenceOwner.controllerDeviceId },
      target: host.route!.targetDeviceId, platform: capabilities.platform, capable: capabilities.nativeCredentials,
      locale: environment.locale(), theme: environment.theme(), current, active: () => current() && this.#interactive,
      lockState: async signal => {
        if (!this.transport.lockState) throw new Error("CREDENTIAL_UNAVAILABLE");
        return this.transport.lockState(host, signal);
      }, remote: async (request, signal) => {
        if (!this.transport.credentials) throw new Error("CREDENTIAL_UNAVAILABLE");
        return this.transport.credentials(host, request, signal);
      }, authenticated: () => this.restartAfterCredential(host)
    });
  }
  credential(action: MobileRemoteDesktopCredentialAction, enabled?: boolean): Promise<void> {
    this.bindCredentials(); return this.#credentials?.run(action, enabled) ?? Promise.resolve();
  }
  retryCredential(): Promise<void> { return this.#credentials?.retry() ?? Promise.resolve(); }

  private async restartAfterCredential(host: DevicePeerDescriptor): Promise<void> {
    if (this.#displaySwitch || this.#disposed || !this.#foreground || !this.#routeFocused || !this.#online || !this.transport.isCurrent()
      || this.#snapshot.exitStatus !== "idle" || peerKey(this.#snapshot.host) !== peerKey(host)) return;
    const lease = this.#lease;
    this.#endLease(false);
    const generation = this.#newRequest();
    this.#resumeEligible = false;
    this.#set({ ...this.#snapshot, status: "connecting", controlling: false, wantedControl: false, hasFrame: false, notice: undefined });
    try {
      if (lease) await this.transport.stop(host, lease.leaseId, { lockScreen: false, controlGeneration: 0n }, this.#request.signal);
      if (!this.#ready(generation)) return;
      this.#lease = undefined;
      await this.#start(RemoteDesktopStartMode.NEW, generation);
    } catch (error) { if (this.#ready(generation)) this.#handleFailure(error, "start"); }
  }

  get snapshot(): MobileRemoteDesktopSnapshot { return this.#snapshot; }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setViewerSink(sink: (message: MobileRemoteDesktopViewerCommand) => void): void {
    this.#viewerSink = sink;
  }

  async open(): Promise<void> {
    if (this.#displaySwitch) return;
    this.#permissionBlocked = false;
    this.#credentials?.retire();
    const generation = this.#newRequest();
    this.#resumeEligible = false;
    this.#set({ ...initialSnapshot(), backgroundViewing: this.#snapshot.backgroundViewing,
      mouseButtons: this.#snapshot.mouseButtons, inputMode: this.#snapshot.inputMode,
      mouseOccurrence: this.#mouseOccurrence,
      touchpadOccurrence: this.#touchpadOccurrence,
      status: this.#online ? "loading" : "offline" });
    if (!this.#ready(generation)) return;
    try {
      const hosts = await this.transport.listHosts(this.#request.signal);
      if (!this.#ready(generation)) return;
      if (hosts.length === 0) {
        this.#set({ ...this.#snapshot, hosts, status: "unsupported", notice: "no-hosts" });
        return;
      }
      const preferredMatches = this.preferredDeviceId === undefined
        ? [] : hosts.filter((host) => host.route?.targetDeviceId === this.preferredDeviceId);
      if (this.preferredDeviceId !== undefined && preferredMatches.length !== 1) {
        this.#set({ ...this.#snapshot, hosts: Object.freeze([]), status: "unsupported", notice: "unavailable" });
        return;
      }
      const visibleHosts = this.preferredDeviceId === undefined ? hosts : preferredMatches;
      this.#set({ ...this.#snapshot, hosts: Object.freeze([...visibleHosts]), status: "select-host", notice: undefined });
      if (visibleHosts.length === 1) await this.selectHost(visibleHosts[0]!);
    } catch (error) {
      if (this.#ready(generation)) this.#handleFailure(error, "catalog");
    }
  }

  async selectHost(host: DevicePeerDescriptor): Promise<void> {
    if (this.#displaySwitch) return;
    if (!this.#snapshot.hosts.some((candidate) => peerKey(candidate) === peerKey(host))) return;
    this.#credentials?.retire();
    this.#permissionBlocked = false;
    this.#displayModeReconnect = undefined;
    this.#temporaryModeUncertain = false;
    const generation = this.#newRequest();
    this.#lease = undefined;
    this.#resumeEligible = false;
    this.#set({ ...this.#snapshot, host, capabilities: undefined, selectedDisplayId: undefined,
      permissions: undefined, permissionCheckStatus: "idle", permissionGuideStatus: "idle", permissionNotice: undefined,
      status: "loading", controlling: false, wantedControl: false, media: "none",
      credentials: mobileCredentialDefaults, takeoverAvailable: false, clipboardAvailable: false, clipboardBusy: false,
      clipboardNotice: undefined, displayModes: Object.freeze([]), displayModesStatus: "idle",
      clipboardSync: false, clipboardSyncLoaded: false, clipboardSyncSaving: false, clipboardSyncActive: false,
      clipboardSyncNotice: undefined,
      displayModeBusy: false, displayModeNotice: undefined, notice: undefined,
      hostMute: false, hostMuteLoaded: false, hostMuteActive: false, hostMutePending: false,
      hostMuteNotice: undefined, lockOnExit: false, lockOnExitLoaded: false, lockOnExitPending: false,
      privacyScreen: false, privacyScreenLoaded: false, privacyScreenActive: false, privacyScreenPending: false, privacyScreenNotice: undefined,
      lockOnExitNotice: undefined, exitStatus: "idle", exitLockRequested: false, exitNotice: undefined, navigationRetained: false });
    this.#hostMuteFailedSave = undefined;
    this.#hostMuteSaving = false;
    this.#privacyFailedSave = undefined; this.#privacySaving = false;
    void this.#loadPrivacyScreen();
    void this.#loadHostMute();
    this.#lockFailedSave = undefined;
    void this.#loadLockOnExit();
    this.#clipboardSyncBaseline = { local: "", remote: "" };
    this.#clipboardSyncFailedSave = undefined;
    void this.#loadClipboardSyncPreference();
    try {
      const capabilities = await this.transport.capabilities(host, this.#request.signal);
      if (!this.#ready(generation) || peerKey(this.#snapshot.host) !== peerKey(host)) return;
      if (!validCapabilities(capabilities) || !capabilities.enabled) {
        this.#set({ ...this.#snapshot, capabilities, status: "unsupported",
          notice: "unavailable" });
        return;
      }
      if (!screenPermissionReady(capabilities.permissions)) {
        this.#set({ ...this.#snapshot, capabilities, status: "permission",
          notice: "screen-permission" });
        return;
      }
      const first = capabilities.displays[0]!;
      this.#set({ ...this.#snapshot, capabilities, selectedDisplayId: first.displayId,
        status: capabilities.displays.length > 1 ? "select-display" : "connecting",
        clipboardAvailable: this.#clipboardAvailable(capabilities), clipboardNotice: undefined,
        notice: undefined });
      this.bindCredentials();
      if (capabilities.displays.length === 1) await this.#start(RemoteDesktopStartMode.NEW, generation);
    } catch (error) {
      if (this.#ready(generation)) this.#handleFailure(error, "capabilities");
    }
  }

  async selectDisplay(displayId: string): Promise<void> {
    const host = this.#snapshot.host;
    if (!host || this.#displaySwitch || this.#displayModeOperation
      || !this.#interactive || !this.#routeFocused || !this.#ready(this.#generation)
      || !["select-display", "live", "capture-pending"].includes(this.#snapshot.status)
      || !this.#snapshot.capabilities?.displays.some((display) => display.displayId === displayId)
      || this.#lease && displayId === this.#snapshot.selectedDisplayId) return;
    this.#credentials?.resetAttempt();
    this.#displayModeReconnect = undefined;
    const transition: DisplaySwitch = { host, lease: this.#lease, displayId, stopConfirmed: this.#lease === undefined };
    this.#displaySwitch = transition;
    this.#endLease(false);
    await this.#connectDisplay(transition);
  }

  #connectDisplay(transition: DisplaySwitch): Promise<void> {
    if (this.#displaySwitchCompletion) return this.#displaySwitchCompletion;
    const generation = this.#newRequest();
    const current = () => this.#displaySwitch === transition && this.#ready(generation)
      && this.#interactive && this.#routeFocused && peerKey(this.#snapshot.host) === peerKey(transition.host);
    this.#set({ ...this.#snapshot, selectedDisplayId: transition.displayId, status: "connecting",
      controlling: false, wantedControl: false, media: "none", hasFrame: false,
      displaySwitchBusy: true, displaySwitchNotice: undefined, displayModeBusy: false,
      displayModes: Object.freeze([]), displayModesStatus: "idle", displayModeNotice: undefined,
      viewerDisplayFitted: false, takeoverAvailable: false, notice: undefined });
    const completion = (async () => {
      try {
        if (!transition.stopConfirmed && transition.lease) {
          try {
            if (!this.transport.canStop()) throw new MobileRemoteDesktopAuthorityError();
            await this.transport.stop(transition.host, transition.lease.leaseId,
              { lockScreen: false, controlGeneration: 0n }, this.#request.signal);
          } catch (error) {
            if (!current()) return;
            const reason = remoteDesktopFailure(error)?.reason;
            if (reason !== RemoteDesktopFailureReason.STOPPED && reason !== RemoteDesktopFailureReason.LEASE_EXPIRED) {
              // Keep the captured lease as a stop responsibility, with all of its
              // input and media authority already retired. Only explicit Retry
              // can confirm that it ended before another lease is dispatched.
              this.#lease = { ...transition.lease, controlling: false };
              this.#set({ ...this.#snapshot, status: error instanceof MobileRemoteDesktopAuthorityError
                  || reason === RemoteDesktopFailureReason.AUTHORITY_CHANGED ? "revoked" : "error",
                displaySwitchNotice: "stop-failed", displayModeNotice: reason === RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE
                  ? "restore-unavailable" : undefined,
                notice: error instanceof MobileRemoteDesktopAuthorityError
                  || reason === RemoteDesktopFailureReason.AUTHORITY_CHANGED ? "authority-changed" : "generic-error" });
              return;
            }
          }
          if (!current()) return;
          transition.stopConfirmed = true;
        }
        if (!current()) return;
        this.#lease = undefined; this.#temporaryModeUncertain = false; this.#resumeEligible = false;
        await this.#start(RemoteDesktopStartMode.NEW, generation);
      } finally {
        if (this.#displaySwitch === transition) {
          if (transition.stopConfirmed) this.#displaySwitch = undefined;
          this.#set({ ...this.#snapshot, displaySwitchBusy: false,
            ...(!transition.stopConfirmed && this.#snapshot.status === "connecting"
              ? { status: "error" as const, displaySwitchNotice: "stop-failed" as const, notice: "generic-error" as const } : {}) });
        }
      }
    })();
    this.#displaySwitchCompletion = completion;
    void completion.finally(() => { if (this.#displaySwitchCompletion === completion) this.#displaySwitchCompletion = undefined; });
    return completion;
  }

  async takeover(): Promise<void> {
    if (this.#displaySwitch) return;
    this.#credentials?.resetAttempt();
    this.#displayModeReconnect = undefined;
    const generation = this.#newRequest();
    this.#set({ ...this.#snapshot, status: "connecting", takeoverAvailable: false, notice: undefined });
    await this.#start(RemoteDesktopStartMode.TAKEOVER, generation);
  }

  async retry(): Promise<void> {
    if (this.#displaySwitchCompletion || !this.#interactive || !this.#routeFocused
      || !this.#foreground || !this.#online || !this.transport.isCurrent() || this.#disposed) return;
    this.#credentials?.resetAttempt();
    this.#retryIndex = 0;
    this.#displayModeReconnect = undefined;
    if (this.#displaySwitch) return this.#connectDisplay(this.#displaySwitch);
    if (this.#snapshot.displaySwitchNotice === "display-missing" && this.#snapshot.selectedDisplayId === undefined) return;
    if (this.#snapshot.host === undefined) return this.open();
    if (this.#temporaryModeUncertain) {
      const host = this.#snapshot.host, lease = this.#lease, generation = this.#newRequest();
      try {
        if (lease) await this.transport.stop(host, lease.leaseId, { lockScreen: false, controlGeneration: 0n }, this.#request.signal);
      } catch (error) {
        const failure = remoteDesktopFailure(error);
        if (!this.#ready(generation)) return;
        if (failure?.reason !== RemoteDesktopFailureReason.STOPPED && failure?.reason !== RemoteDesktopFailureReason.LEASE_EXPIRED) {
          this.#set({ ...this.#snapshot, status: "error", displayModeNotice: failure?.reason === RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE ? "restore-unavailable" : "change-failed" });
          return;
        }
      }
      if (!this.#ready(generation)) return;
      this.#lease = undefined; this.#temporaryModeUncertain = false; this.#resumeEligible = false;
    }
    if (this.#permissionBlocked) { this.#permissionBlocked = false; this.#resumeEligible = false; }
    const generation = this.#newRequest();
    this.#set({ ...this.#snapshot, status: "connecting", notice: undefined });
    await this.#start(this.#resumeEligible ? RemoteDesktopStartMode.RESUME : RemoteDesktopStartMode.NEW, generation);
  }

  setPermissionGuideVisible(visible: boolean): void {
    if (this.#disposed || typeof visible !== "boolean" || this.#permissionGuideVisible === visible) return;
    this.#permissionGuideVisible = visible;
    this.#syncPermissions();
  }

  async refreshPermissions(showGuide = false): Promise<void> {
    this.#syncPermissions();
    const scope = this.#permissionScope;
    if (!scope || !this.#permissionScopeCurrent(scope)) return;
    if (!showGuide) return this.#checkPermissions(scope);
    if (this.#permissionGuide) return;
    const operation = { scope, ordinal: ++this.#permissionReadSequence };
    this.#permissionGuide = operation;
    this.#set({ ...this.#snapshot, permissionGuideStatus: "pending", permissionNotice: undefined });
    try {
      const permissions = await this.transport.showPermissionGuide(scope.host, scope.request.signal);
      if (!this.#permissionScopeCurrent(scope) || this.#permissionGuide !== operation) return;
      this.#adoptPermissions(operation.ordinal, permissions);
      this.#set({ ...this.#snapshot, permissionGuideStatus: "opened", permissionNotice: "guide-opened" });
    } catch (error) {
      if (!this.#permissionScopeCurrent(scope) || this.#permissionGuide !== operation) return;
      const unknown = !(error instanceof MobileRemoteDesktopAuthorityError) && remoteDesktopFailure(error) === undefined;
      this.#set({ ...this.#snapshot, permissionGuideStatus: unknown ? "unknown" : "failed",
        permissionNotice: unknown ? "guide-unknown" : "guide-failed" });
    } finally {
      if (this.#permissionGuide === operation) this.#permissionGuide = undefined;
    }
  }

  #syncPermissions(): void {
    if (this.#permissionGuideVisible && this.#permissionBlocked && this.#snapshot.status === "permission"
      && !this.#displaySwitch && this.#request.signal.aborted && !this.#disposed && this.#foreground
      && this.#online && this.#interactive && this.#routeFocused && this.#snapshot.exitStatus === "idle"
      && this.transport.isCurrent()) this.#newRequest();
    const host = this.#snapshot.host;
    const eligible = this.#permissionGuideVisible && host && !this.#displaySwitch
      && this.#interactive && this.#routeFocused && this.#ready(this.#generation)
      && ["permission", "live", "capture-pending"].includes(this.#snapshot.status);
    const key = eligible ? `${this.transport.ownerKey}/${this.#generation}/${peerKey(host)}` : undefined;
    if (key === this.#permissionScope?.key) return;
    this.#retirePermissionScope();
    if (!key || !host) return;
    const scope: PermissionScope = { key, host, hostKey: peerKey(host), ownerKey: this.transport.ownerKey, generation: this.#generation,
      ownerSignal: this.#request.signal, request: new AbortController() };
    this.#permissionScope = scope;
    scope.timer = setInterval(() => { void this.#checkPermissions(scope); }, 2_000);
    void this.#checkPermissions(scope);
  }

  #permissionScopeCurrent(scope: PermissionScope): boolean {
    return this.#permissionScope === scope && !scope.request.signal.aborted && !scope.ownerSignal.aborted
      && this.#permissionGuideVisible && this.#interactive && this.#routeFocused
      && this.#ready(scope.generation) && this.transport.ownerKey === scope.ownerKey
      && peerKey(this.#snapshot.host) === scope.hostKey && !this.#displaySwitch
      && ["permission", "live", "capture-pending"].includes(this.#snapshot.status);
  }

  #retirePermissionScope(): void {
    const scope = this.#permissionScope;
    if (!scope) return;
    this.#permissionScope = undefined;
    if (scope.timer !== undefined) clearInterval(scope.timer);
    scope.request.abort();
    const checkPending = this.#permissionCheck?.scope === scope && this.#snapshot.permissionCheckStatus === "checking";
    const guidePending = this.#permissionGuide?.scope === scope && this.#snapshot.permissionGuideStatus === "pending";
    if (checkPending || guidePending) {
      this.#snapshot = Object.freeze({ ...this.#snapshot,
        ...(checkPending ? { permissionCheckStatus: "idle" as const } : {}),
        ...(guidePending ? { permissionGuideStatus: "unknown" as const, permissionNotice: "guide-unknown" as const } : {}) });
      for (const listener of this.#listeners) listener();
    }
  }

  async #checkPermissions(scope: PermissionScope): Promise<void> {
    if (this.#permissionCheck || !this.#permissionScopeCurrent(scope)) return;
    const operation = { scope, ordinal: ++this.#permissionReadSequence };
    this.#permissionCheck = operation;
    this.#set({ ...this.#snapshot, permissionCheckStatus: "checking" });
    try {
      const permissions = await this.transport.permissions(scope.host, scope.request.signal);
      if (!this.#permissionScopeCurrent(scope) || this.#permissionCheck !== operation) return;
      this.#adoptPermissions(operation.ordinal, permissions);
      this.#set({ ...this.#snapshot, permissionCheckStatus: "ready",
        ...(this.#snapshot.permissionNotice === "check-failed" ? { permissionNotice: undefined } : {}) });
    } catch {
      if (!this.#permissionScopeCurrent(scope) || this.#permissionCheck !== operation) return;
      this.#set({ ...this.#snapshot, permissionCheckStatus: "failed",
        ...(!this.#snapshot.permissionNotice || this.#snapshot.permissionNotice === "check-failed"
          ? { permissionNotice: "check-failed" as const } : {}) });
    } finally {
      if (this.#permissionCheck === operation) this.#permissionCheck = undefined;
    }
  }

  #adoptPermissions(ordinal: number, permissions: RemoteDesktopPermissions): void {
    if (ordinal <= this.#permissionReadAdopted) return;
    this.#permissionReadAdopted = ordinal;
    this.#snapshot = Object.freeze({ ...this.#snapshot, permissions: projectPermissions(permissions) });
  }

  async setControl(enabled: boolean): Promise<void> {
    this.#controlRecoveryWanted = enabled;
    const host = this.#snapshot.host;
    const lease = this.#lease;
    if (this.#displayModeOperation && !enabled) { this.#set({ ...this.#snapshot, wantedControl: false }); return; }
    if (!host || !lease || this.#displaySwitch || this.#displayModeOperation || !this.#ready(this.#generation)) return;
    if (this.#controlRequest) return;
    if (enabled && !this.#snapshot.capabilities?.canControl) {
      this.#releaseControl("view-only");
      return;
    }
    const generation = this.#generation;
    const operation = {}; this.#controlRequest = operation;
    this.#set({ ...this.#snapshot, wantedControl: enabled });
    try {
      const state = await this.transport.control(host, lease.leaseId, enabled, this.#request.signal);
      if (!this.#ready(generation) || this.#displayModeOperation || this.#lease?.leaseId !== lease.leaseId) return;
      if (!validControlGeneration(state.controlGeneration)) throw new Error("Invalid Remote Desktop control generation.");
      if (!this.#adoptControlGeneration(state.controlGeneration)) return;
      this.#set({ ...this.#snapshot, controlling: state.controlling,
        wantedControl: enabled && state.controlling, notice: undefined });
      this.#emit({ type: "control", enabled: state.controlling });
      if (!state.controlling) this.#emit({ type: "releaseInput" });
      else if (this.#snapshot.capabilities?.displayModes) void this.#loadDisplayModes(false);
    } catch (error) {
      if (this.#ready(generation)) this.#handleFailure(error, "control");
    } finally {
      if (this.#controlRequest === operation) {
        this.#controlRequest = undefined;
        if (this.#ready(generation) && this.#lease?.leaseId === lease.leaseId && this.#controlRecoveryWanted !== enabled) {
          void this.setControl(this.#controlRecoveryWanted);
        }
      }
    }
  }

  #restoreForegroundControl(): void {
    if (!this.#controlRecoveryWanted || this.#controlRequest || this.#snapshot.controlling || !this.#snapshot.capabilities?.canControl
      || !this.#foreground || !this.#interactive || !this.#routeFocused || this.#presentationState !== "idle"
      || this.#displayModeOperation || this.#displaySwitch || !this.#ready(this.#generation)) return;
    this.#set({ ...this.#snapshot, notice: "input-recovering" });
    void this.setControl(true);
  }

  async loadDisplayModes(): Promise<void> {
    await this.#loadDisplayModes(true);
  }

  async performSystemAction(action: RemoteDesktopSystemAction): Promise<void> {
    const host = this.#snapshot.host, lease = this.#lease;
    if (!host || !lease || this.#systemActionOperation || !this.#systemActionAvailable(action)
      || !this.#snapshot.controlling || !this.#snapshot.wantedControl || this.#snapshot.status !== "live" || !this.#interactive || !this.#routeFocused
      || this.#displayModeOperation || !validControlGeneration(this.#controlGeneration) || !this.#ready(this.#generation)) return;
    const request = new AbortController(), ownerSignal = this.#request.signal;
    const retire = (): void => request.abort();
    ownerSignal.addEventListener("abort", retire, { once: true });
    const context: MobileSystemActionContext = { action, host, leaseId: lease.leaseId, generation: this.#generation,
      controlGeneration: this.#controlGeneration, viewerOccurrence: this.#viewerOccurrence, viewerEpoch: this.#viewerEpoch,
      request, ownerSignal, retire };
    this.#systemActionOperation = context;
    this.#systemActionRetry = undefined;
    this.#set({ ...this.#snapshot, systemActionPending: true, systemActionFailure: undefined });
    try {
      const result = await this.transport.systemAction(host, lease.leaseId, context.controlGeneration, action, request.signal);
      if (!this.#systemActionCurrent(context) || this.#systemActionOperation !== context) return;
      if (result !== action) throw new Error("REMOTE_DESKTOP_SYSTEM_ACTION_UNAVAILABLE");
    } catch {
      if (!this.#systemActionCurrent(context) || this.#systemActionOperation !== context) return;
      this.#systemActionRetry = context;
      this.#set({ ...this.#snapshot, systemActionFailure: action });
    } finally {
      ownerSignal.removeEventListener("abort", retire);
      if (this.#systemActionOperation === context) {
        this.#systemActionOperation = undefined;
        this.#set({ ...this.#snapshot, systemActionPending: false });
      }
    }
  }

  async retrySystemAction(): Promise<void> {
    const context = this.#systemActionRetry;
    if (context && this.#systemActionCurrent(context)) await this.performSystemAction(context.action);
  }

  #systemActionAvailable(action: RemoteDesktopSystemAction): boolean {
    return action === "systemMenu" ? this.#snapshot.capabilities?.systemMenu === true
      : (action === "workspaceLeft" || action === "workspaceRight") && this.#snapshot.capabilities?.workspaceNavigation === true;
  }

  #systemActionCurrent(context: MobileSystemActionContext): boolean {
    return !context.request.signal.aborted && this.#ready(context.generation) && this.#interactive && this.#routeFocused
      && this.#snapshot.status === "live" && this.#snapshot.controlling && this.#snapshot.wantedControl && !this.#displayModeOperation
      && this.#lease?.leaseId === context.leaseId && peerKey(this.#snapshot.host) === peerKey(context.host)
      && this.#controlGeneration === context.controlGeneration && this.#viewerOccurrence === context.viewerOccurrence
      && this.#viewerEpoch === context.viewerEpoch && this.#systemActionAvailable(context.action);
  }

  #retireSystemAction(): void {
    this.#systemActionOperation?.request.abort();
    this.#systemActionOperation = undefined;
    this.#systemActionRetry = undefined;
    this.#snapshot = Object.freeze({ ...this.#snapshot, systemActionPending: false, systemActionFailure: undefined });
  }

  async setHostMute(enabled: boolean): Promise<void> {
    const identity = this.#hostMuteIdentity();
    if (this.#disposed || !this.#interactive || !this.#ready(this.#generation)
      || !identity || !this.hostMutePreferences || !this.#snapshot.capabilities?.hostMute
      || !this.#snapshot.hostMuteLoaded || this.#snapshot.hostMutePending || typeof enabled !== "boolean") return;
    const operation = ++this.#hostMutePreferenceOperation;
    this.#hostMuteSaving = true;
    this.#hostMuteFailedSave = undefined;
    this.#set({ ...this.#snapshot, hostMutePending: true, hostMuteNotice: undefined });
    try {
      await this.hostMutePreferences.save(identity, enabled);
      if (!this.#hostMutePreferenceCurrent(identity, operation)) return;
      this.#hostMuteSaving = false;
      this.#set({ ...this.#snapshot, hostMute: enabled, hostMutePending: false, hostMuteNotice: undefined });
      await this.#hostMuteTail;
    } catch {
      if (!this.#hostMutePreferenceCurrent(identity, operation)) return;
      this.#hostMuteSaving = false;
      this.#hostMuteFailedSave = enabled;
      this.#set({ ...this.#snapshot, hostMutePending: false, hostMuteNotice: "save-failed" });
    }
  }

  async setPrivacyScreen(enabled: boolean): Promise<void> {
    const identity = this.#hostMuteIdentity();
    if (this.#disposed || !this.#interactive || !this.#ready(this.#generation) || !identity || !this.privacyPreferences ||
      this.#snapshot.privacyScreenPending || typeof enabled !== "boolean" ||
      (!this.#snapshot.privacyScreenLoaded && this.#snapshot.privacyScreenNotice !== "load-failed") ||
      (enabled && !this.#snapshot.capabilities?.privacyScreen)) return;
    const operation = ++this.#privacyPreferenceOperation;
    this.#privacySaving = true; this.#privacyFailedSave = undefined;
    this.#set({ ...this.#snapshot, privacyScreenPending: true, privacyScreenNotice: undefined });
    try {
      await this.privacyPreferences.save(identity, enabled);
      if (!this.#privacyPreferenceCurrent(identity, operation)) return;
      this.#privacySaving = false;
      this.#privacyAttempt = undefined;
      this.#set({ ...this.#snapshot, privacyScreen: enabled, privacyScreenLoaded: true,
        privacyScreenPending: false, privacyScreenNotice: undefined });
      await this.#privacyTail;
    } catch {
      if (!this.#privacyPreferenceCurrent(identity, operation)) return;
      this.#privacySaving = false; this.#privacyFailedSave = enabled;
      this.#set({ ...this.#snapshot, privacyScreenPending: false, privacyScreenNotice: "save-failed" });
    }
  }

  async retryPrivacyScreenPreference(): Promise<void> {
    if (!this.#interactive || !this.#ready(this.#generation) || this.#snapshot.privacyScreenPending) return;
    if (this.#privacyFailedSave !== undefined) return this.setPrivacyScreen(this.#privacyFailedSave);
    if (!this.#snapshot.privacyScreenLoaded) return this.#loadPrivacyScreen();
  }

  async retryHostMute(): Promise<void> {
    if (this.#disposed || !this.#interactive || !this.#ready(this.#generation)
      || this.#snapshot.hostMutePending || !this.#snapshot.capabilities?.hostMute) return;
    if (!this.#snapshot.hostMuteLoaded) return this.#loadHostMute();
    if (this.#hostMuteFailedSave !== undefined) return this.setHostMute(this.#hostMuteFailedSave);
    this.#hostMuteAttempt = undefined;
    this.#set({ ...this.#snapshot, hostMuteNotice: undefined });
    await this.#hostMuteTail;
  }

  async setLockOnExit(enabled: boolean): Promise<void> {
    const identity = this.#hostMuteIdentity();
    if (!identity || !this.lockPreferences || !this.#snapshot.capabilities?.lockOnExit
      || !this.#snapshot.lockOnExitLoaded || this.#snapshot.lockOnExitPending
      || !this.#interactive || !this.#ready(this.#generation) || typeof enabled !== "boolean") return;
    const operation = ++this.#lockPreferenceOperation;
    this.#lockFailedSave = undefined;
    this.#set({ ...this.#snapshot, lockOnExitPending: true, lockOnExitNotice: undefined });
    try {
      await this.lockPreferences.save(identity, enabled);
      if (!this.#lockPreferenceCurrent(identity, operation)) return;
      this.#set({ ...this.#snapshot, lockOnExit: enabled, lockOnExitPending: false, lockOnExitNotice: undefined });
    } catch {
      if (!this.#lockPreferenceCurrent(identity, operation)) return;
      this.#lockFailedSave = enabled;
      this.#set({ ...this.#snapshot, lockOnExitPending: false, lockOnExitNotice: "save-failed" });
    }
  }

  async retryLockOnExitPreference(): Promise<void> {
    if (!this.#interactive || !this.#ready(this.#generation) || this.#snapshot.lockOnExitPending) return;
    if (!this.#snapshot.lockOnExitLoaded) return this.#loadLockOnExit();
    if (this.#lockFailedSave !== undefined) return this.setLockOnExit(this.#lockFailedSave);
  }

  setRouteFocused(focused: boolean): void {
    if (this.#disposed || this.#routeFocused === focused) return;
    this.#routeFocused = focused;
    if (!focused) { this.#retireSystemAction(); this.#emit({ type: "releaseInput" }); this.#retireKeyboardTools(true); this.#set(this.#snapshot); }
    if (!focused) this.#credentials?.retire(); else this.bindCredentials();
    this.#syncClipboard();
    if (focused && this.#navigationExit) {
      this.#navigationExit = undefined;
      this.#set({ ...this.#snapshot, navigationRetained: false });
      if (this.presentation?.nativeVideo && this.#presentationRestore) this.#restoreNativePresentation();
      else if (this.#presentationState !== "idle" && this.#foreground && this.#online) void this.#finishPresentation();
    }
    this.#syncNativeInputAuthority(); this.#restoreNativePresentation();
    this.#syncPermissions();
  }

  async leave(disconnect = false): Promise<"closed" | "retained" | "failed"> {
    this.#credentials?.retire();
    if (this.#displaySwitchCompletion) await this.#displaySwitchCompletion;
    if (this.#exitCompletion) return this.#exitCompletion;
    if (this.#snapshot.exitStatus === "failed") return "failed";
    if (this.#disposed) return "closed";
    if (!disconnect && this.presentation?.nativeVideo && this.#snapshot.backgroundViewing
      && this.#presentationState !== "active" && (this.#snapshot.pipAvailable || this.#presentationTransition)) {
      await this.startPictureInPicture();
      if (this.#disposed) return "closed";
    }
    const context = this.#captureExit();
    if (!context) {
      this.#set({ ...this.#snapshot, exitStatus: "closed" });
      return "closed";
    }
    if (!disconnect && this.#presentationState === "active" && this.#snapshot.presenting) {
      this.#navigationExit = context;
      this.#routeFocused = false;
      this.#set({ ...this.#snapshot, navigationRetained: true });
      return "retained";
    }
    return this.#dispatchExit(context);
  }

  async reconnectAfterExitFailure(): Promise<void> {
    if (this.#snapshot.exitStatus !== "failed" || !this.transport.isCurrent()
      || !this.#foreground || !this.#interactive || this.#disposed) return;
    this.#exitContext = undefined;
    this.#navigationExit = undefined;
    this.#routeFocused = true;
    this.#resumeEligible = false;
    this.#set({ ...this.#snapshot, exitStatus: "idle", exitLockRequested: false, exitNotice: undefined, navigationRetained: false });
    await this.retry();
  }

  #captureExit(): MobileRemoteDesktopExitContext | undefined {
    const host = this.#snapshot.host, lease = this.#lease ?? this.#displaySwitch?.lease;
    if (!host || !lease) return undefined;
    const lockScreen = this.#displaySwitch === undefined && this.#snapshot.lockOnExitLoaded && this.#snapshot.lockOnExit
      && this.#snapshot.capabilities?.lockOnExit === true;
    return { host, lease, ownerKey: this.transport.ownerKey, lockScreen,
      controlGeneration: lockScreen ? this.#controlGeneration : 0n, request: new AbortController() };
  }

  #dispatchExit(context: MobileRemoteDesktopExitContext): Promise<"closed" | "failed"> {
    if (this.#exitCompletion) return this.#exitCompletion;
    this.#exitContext = context;
    this.#navigationExit = undefined;
    this.#retireDisplayModeOperation();
    this.#endLease(false);
    this.#set({ ...this.#snapshot, status: "stopped", exitStatus: "pending", exitNotice: undefined,
      exitLockRequested: context.lockScreen, navigationRetained: false, controlling: false, wantedControl: false });
    const current = () => !this.#disposed && this.#exitContext === context && !context.request.signal.aborted
      && this.transport.ownerKey === context.ownerKey;
    const displaySwitch = this.#displaySwitch;
    const confirmClosed = (): "closed" => {
      if (displaySwitch && this.#displaySwitch === displaySwitch) {
        displaySwitch.stopConfirmed = true;
        this.#displaySwitch = undefined;
      }
      this.#set({ ...this.#snapshot, exitStatus: "closed", exitNotice: undefined });
      this.#emit({ type: "stop", preserveFrame: false });
      return "closed";
    };
    const completion = (async (): Promise<"closed" | "failed"> => {
      try {
        if (!this.transport.canStop()) throw new MobileRemoteDesktopAuthorityError();
        await this.transport.stop(context.host, context.lease.leaseId,
          { lockScreen: context.lockScreen, controlGeneration: context.controlGeneration }, context.request.signal);
        if (!current()) return "failed";
        if (!this.transport.canStop()) throw new MobileRemoteDesktopAuthorityError();
        return confirmClosed();
      } catch (error) {
        if (!current()) return "failed";
        const failure = remoteDesktopFailure(error);
        if (displaySwitch && !context.lockScreen && this.transport.canStop()
          && (failure?.reason === RemoteDesktopFailureReason.STOPPED || failure?.reason === RemoteDesktopFailureReason.LEASE_EXPIRED)) {
          return confirmClosed();
        }
        const exitNotice = error instanceof MobileRemoteDesktopAuthorityError
          || failure?.reason === RemoteDesktopFailureReason.AUTHORITY_CHANGED ? "authority-changed"
          : failure?.reason === RemoteDesktopFailureReason.LOCK_EXPIRED ? "lock-expired"
          : failure?.reason === RemoteDesktopFailureReason.LOCK_UNAVAILABLE ? "lock-unavailable"
          : failure?.reason === RemoteDesktopFailureReason.LOCK_FAILED ? "lock-failed" : "exit-failed";
        this.#set({ ...this.#snapshot, exitStatus: "failed", exitNotice });
        return "failed";
      }
    })();
    this.#exitCompletion = completion;
    void completion.finally(() => { if (this.#exitCompletion === completion) this.#exitCompletion = undefined; });
    return completion;
  }

  async setDisplayMode(modeId: string): Promise<void> {
    return this.#changeDisplay(modeId);
  }

  async fitViewerDisplay(width: number, height: number): Promise<void> {
    const size = viewerDisplaySize(width, height);
    if (!size) return;
    return this.#changeDisplay(undefined, size, false);
  }

  async restoreViewerDisplay(): Promise<void> {
    return this.#changeDisplay(undefined, undefined, true);
  }

  async #changeDisplay(modeId?: string, size?: { readonly width: number; readonly height: number }, restore = false): Promise<void> {
    const heartbeat = this.#heartbeatCompletion;
    if (heartbeat !== undefined) await heartbeat;
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const generation = this.#generation;
    const mode = this.#snapshot.displayModes.find((candidate) => candidate.modeId === modeId);
    const viewerDisplay = modeId === undefined;
    const capabilities = this.#snapshot.capabilities;
    const available = viewerDisplay
      ? restore ? capabilities?.viewerDisplayRestore && this.#snapshot.viewerDisplayFitted && this.transport.restoreViewerDisplay
        : capabilities?.viewerDisplay && size !== undefined && this.transport.fitViewerDisplay
      : mode !== undefined && (!mode.current || this.#snapshot.viewerDisplayFitted) && capabilities?.displayModes && this.#snapshot.displayModesStatus === "ready"
        && REMOTE_DESKTOP_MODE_ID.test(modeId);
    if (!host || !lease || !available || this.#displayModeOperation || this.#displayModesPending
      || !this.#snapshot.controlling
      || this.#snapshot.status !== "live" || this.#snapshot.clipboardBusy || this.#snapshot.videoSettingsBusy
      || this.#presentationState !== "idle" || !this.#ready(generation)
      || !validControlGeneration(this.#controlGeneration)) return;
    const operation = { request: new AbortController() };
    const transitionStartedAt = Date.now();
    this.#displayModeOperation = operation;
    this.#set({ ...this.#snapshot, displayModeBusy: true, displayModeNotice: undefined });
    const previousControl = this.#snapshot.controlling;
    const previousWantedControl = this.#snapshot.wantedControl;
    const previousMedia = this.#snapshot.media;
    const previousControlGeneration = this.#controlGeneration;
    const temporary = viewerDisplay || capabilities?.resolutionRestore === true;
    let error: unknown;
    let result: RemoteDesktopDisplayModeResult | RemoteDesktopViewerDisplayResult | undefined;
    try {
      if (viewerDisplay) {
        this.#emit({ type: "control", enabled: false });
        this.#emit({ type: "releaseInput" });
        await this.#releaseInputForInteractionFence(host, lease, generation, this.#viewerReleaseSequence);
        if (this.#displayModeOperation !== operation || !this.#ready(generation) || !this.#interactive
          || !this.#routeFocused || !this.#snapshot.wantedControl || !this.#snapshot.controlling
          || this.#lease?.leaseId !== lease.leaseId || this.#controlGeneration !== previousControlGeneration) {
          if (this.#displayModeOperation === operation) {
            this.#displayModeOperation = undefined;
            this.#set({ ...this.#snapshot, displayModeBusy: false });
            if (this.#ready(generation) && this.#interactive && this.#routeFocused) {
              if (!this.#snapshot.wantedControl) await this.setControl(false);
              if (this.#ready(generation)) { this.#beginViewerOccurrence(); this.#sendInit(); }
            }
          }
          return;
        }
      }
      const pending = viewerDisplay
        ? restore ? this.transport.restoreViewerDisplay!(host, lease.leaseId, this.#controlGeneration, operation.request.signal)
          : this.transport.fitViewerDisplay!(host, lease.leaseId, this.#controlGeneration, size!.width, size!.height, operation.request.signal)
        : this.transport.setDisplayMode(host, lease.leaseId, this.#controlGeneration, modeId!, temporary, operation.request.signal);
      this.#stopTimers();
      this.#set({ ...this.#snapshot, status: "reconnecting", controlling: false, wantedControl: temporary && previousWantedControl,
        displayModeBusy: true, displayModeNotice: undefined, pipAvailable: false });
      this.#emit({ type: "control", enabled: false });
      this.#emit({ type: "releaseInput" });
      if (temporary) {
        this.#retireClipboardSyncScope(); this.#retireHostMuteScope(); this.#retirePrivacyScope();
        this.#retireViewerEpoch(); this.#emit({ type: "stop", preserveFrame: true });
      }
      result = await pending;
      if (!result || (!temporary && result.lease)) throw new Error("Invalid display mode receipt.");
      if (temporary && (!result.lease || result.lease.leaseId !== lease.leaseId || result.lease.controlling ||
        result.lease.controlGeneration <= previousControlGeneration || !validControlGeneration(result.lease.controlGeneration) ||
        !result.lease.display || !result.lease.display.displayId ||
        (viewerDisplay ? restore && result.lease.display.displayId !== this.#snapshot.selectedDisplayId
          : result.lease.display.displayId !== lease.display?.displayId
            && (!this.#snapshot.viewerDisplayFitted || result.lease.display.displayId !== this.#snapshot.selectedDisplayId)) ||
        (viewerDisplay && !restore && (result.lease.display.displayId === this.#snapshot.selectedDisplayId
          || capabilities?.displays.some(display => display.displayId === result?.lease?.display?.displayId)
          || this.#snapshot.viewerDisplayFitted && result.lease.display.displayId !== lease.display?.displayId
          || !validViewerDisplayGeometry(result.lease.display, size!, capabilities!.platform))) ||
        ![result.lease.display.width, result.lease.display.height].every(size => Number.isSafeInteger(size) && size > 0 && size <= 32_768))) {
        throw new Error("Temporary display mode changed its captured occurrence.");
      }
    } catch (cause) {
      error = cause;
    }
    if (this.#displayModeOperation !== operation) return;
    this.#displayModeOperation = undefined;
    if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId || peerKey(this.#snapshot.host) !== peerKey(host)) return;
    if (temporary && error === undefined && result?.lease) {
      const stillWanted = this.#snapshot.wantedControl;
      const nextGeneration = this.#newRequest();
      this.#lease = result.lease; this.#adoptControlGeneration(result.lease.controlGeneration);
      this.#beginViewerOccurrence(); this.#resumeEligible = true; this.#temporaryModeUncertain = false;
      this.#set({ ...this.#snapshot, status: "live", media: "none", hasFrame: false, controlling: false, wantedControl: stillWanted,
        viewerDisplayFitted: viewerDisplay ? !restore : result.lease.display?.displayId !== this.#snapshot.selectedDisplayId,
        displayModeBusy: false, displayModeNotice: undefined, displayModes: Object.freeze([]), displayModesStatus: "idle" });
      this.#startHeartbeat(); this.#sendInit(); this.#startFrameLoop();
      if (previousControl && previousWantedControl && stillWanted && this.#interactive && this.#routeFocused && this.#ready(nextGeneration)) await this.setControl(true);
      void this.#loadDisplayModes(false);
      return;
    }
    const failure = remoteDesktopFailure(error);
    if (error !== undefined && displayModeFailureKeepsLease(failure?.reason)) {
      if (failure?.reason === RemoteDesktopFailureReason.VIEW_ONLY) {
        this.#set({ ...this.#snapshot, status: "live", media: previousMedia, displayModeBusy: false,
          displayModeNotice: "change-failed" });
        this.#releaseControl("view-only");
      } else {
        const wanted = previousWantedControl && (!temporary || this.#snapshot.wantedControl);
        const controlling = previousControl && (!temporary || wanted && this.#interactive && this.#routeFocused);
        this.#set({ ...this.#snapshot, status: "live", media: previousMedia, controlling,
          wantedControl: wanted, displayModeBusy: false, displayModeNotice: "change-failed",
          ...(failure?.reason === RemoteDesktopFailureReason.DISPLAY_MODES_UNAVAILABLE
            ? { displayModes: Object.freeze([]), displayModesStatus: "error" as const } : {}) });
        this.#emit({ type: "control", enabled: controlling });
      }
      this.#startHeartbeat();
      if (temporary) { this.#beginViewerOccurrence(); this.#set({ ...this.#snapshot, media: "none", hasFrame: false }); this.#sendInit(); this.#startFrameLoop(); }
      else if (previousMedia !== "webrtc") this.#startFrameLoop();
      this.#refreshPipAvailability();
      if (failure?.reason === RemoteDesktopFailureReason.DISPLAY_MODE_MISSING) {
        void this.#loadDisplayModes(false);
      }
      return;
    }
    if (temporary) {
      this.#newRequest();
      this.#temporaryModeUncertain = true; this.#resumeEligible = false;
      this.#lease = { ...lease, controlling: false };
      this.#set({ ...this.#snapshot, status: "error", controlling: false, wantedControl: false, media: "none", hasFrame: false,
        displayModeBusy: false, displayModeNotice: failure?.reason === RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE ? "restore-unavailable" : "change-failed" });
      return;
    }
    // Success and every outcome whose native effect cannot be disproved are
    // terminal for the old geometry and authority.
    this.#endLease(false);
    this.#set({ ...this.#snapshot, status: "reconnecting", media: "none",
      displayModes: Object.freeze([]), displayModesStatus: "idle", displayModeBusy: false,
      ...(error === undefined ? { displayModeNotice: undefined } : { displayModeNotice: "change-failed" as const }) });
    if (error instanceof MobileRemoteDesktopAuthorityError
      || failure?.reason === RemoteDesktopFailureReason.AUTHORITY_CHANGED) {
      this.#displayModeReconnect = undefined;
      this.#set({ ...this.#snapshot, status: "revoked", notice: "authority-changed" });
      return;
    }
    this.#displayModeReconnect = Object.freeze({
      hostKey: peerKey(host)!,
      displayId: this.#snapshot.selectedDisplayId!,
      restoreControl: previousControl && previousWantedControl,
      ...(error !== undefined && failure === undefined ? {
        // The last heartbeat may have landed immediately before dispatch.
        // BUSY retries continue until one NEW attempt crosses this full TTL.
        expiresAt: transitionStartedAt + MOBILE_REMOTE_DESKTOP_LEASE_MS
      } : {})
    });
    if (this.#foreground && this.#online && this.#interactive) {
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = undefined;
        void this.#resume();
      }, 500);
    }
  }

  updateVideoSettings(settings: MobileRemoteDesktopVideoSettings): void {
    if (!isMobileRemoteDesktopVideoSettings(settings) || this.#disposed) return;
    const previous = this.#snapshot.videoSettings;
    if (sameVideoSettings(previous, settings)) return;
    if (previous.audio !== settings.audio) this.#audioUnavailable = false;
    this.#set({ ...this.#snapshot, videoSettings: Object.freeze({ ...settings }),
      pipAvailable: false, notice: undefined });
    if (!this.#snapshot.capabilities?.videoSettings || !this.#lease) return;
    this.#pendingSettingsReconnect = true;
    void this.#flushVideoSettings();
  }

  setBackgroundViewing(enabled: boolean): void {
    if (this.#disposed || this.#snapshot.backgroundViewing === enabled) return;
    this.#set({ ...this.#snapshot, backgroundViewing: enabled });
    if (!enabled && this.#presentationState !== "idle") void this.#presentationFailed();
  }

  async startPictureInPicture(enter = true): Promise<boolean> {
    if (this.#presentationTransition) return this.#presentationTransition.completion;
    const host = this.#snapshot.host, lease = this.#lease, generation = this.#generation;
    const native = this.presentation?.nativeVideo === true;
    if (!host || !lease || this.#presentationState !== "idle" || this.#settingsApplying
      || !this.#snapshot.pipAvailable || !this.#snapshot.capabilities?.backgroundViewing
      || !this.presentation?.nativePictureInPicture || this.#snapshot.media !== "webrtc"
      || !this.#snapshot.hasFrame || !this.#interactive || !this.#routeFocused || !this.#ready(generation)) return false;
    const ticket = native ? this.transport.beginBackgroundTransition?.(host, lease.leaseId) : undefined;
    if (native && !ticket) return false;
    let settle!: (active: boolean) => void;
    const completion = new Promise<boolean>(resolve => { settle = resolve; });
    const context: MobilePresentationTransition = { host, lease, generation, epoch: this.#viewerEpoch,
      attemptId: this.#mediaAttempt?.attemptId, ticket, completion, settle, acknowledged: false, actual: false };
    this.#presentationTransition = context;
    this.#presentationState = "requesting";
    this.#settingsApplying = true;
    this.#presentationTimer = setTimeout(() => { void this.#presentationFailed(); }, 4_000);
    this.#set({ ...this.#snapshot, videoSettingsBusy: true, notice: undefined });
    this.#emit({ type: "control", enabled: false });
    this.#emit({ type: "releaseInput" });
    let dispatched = false;
    try {
      await this.#setPlayback(true);
      if (!this.#presentationTransitionCurrent(context)) {
        await this.#failPresentationTransition(context, false); return false;
      }
      dispatched = true;
      const state = await this.transport.presentation(host, lease.leaseId, true, this.#request.signal);
      if (!this.#presentationTransitionCurrent(context)) {
        await this.#failPresentationTransition(context, true); return false;
      }
      if (!validControlGeneration(state.controlGeneration) || state.controlling || !this.#adoptControlGeneration(state.controlGeneration)) {
        throw new Error("Invalid Remote Desktop presentation state.");
      }
      context.acknowledged = true;
      context.ticket?.close();
      this.#retireClipboardOperation();
      this.#settingsApplying = false;
      this.#set({ ...this.#snapshot, controlling: false, wantedControl: false,
        presenting: false, videoSettingsBusy: false, pipAvailable: false });
      if (enter || !native) this.#emit({ type: "presentation", enabled: enter });
      if (context.actual) this.#actualPresentation(true);
      // The HTML viewer's existing manual operation returns when prepared.
      // Native Back waits for the host acknowledgement and actual AVKit state.
      if (!native) return true;
      return completion;
    } catch {
      if (this.#presentationTransition !== context) return false;
      if (!dispatched) {
        this.#audioUnavailable = true;
        this.#pendingSettingsReconnect = true;
        await this.#failPresentationTransition(context, false, "audio-unavailable");
        void this.#flushVideoSettings();
      } else await this.#failPresentationTransition(context, true);
      return false;
    }
  }

  #presentationTransitionCurrent(context: MobilePresentationTransition): boolean {
    return this.#presentationTransition === context && !this.#disposed && this.#online
      && context.generation === this.#generation && this.#lease?.leaseId === context.lease.leaseId
      && peerKey(this.#snapshot.host) === peerKey(context.host) && this.#viewerEpoch === context.epoch
      && this.#mediaAttempt?.attemptId === context.attemptId
      && (context.acknowledged ? this.transport.canStop()
        : context.ticket ? context.ticket.isCurrent() : this.#ready(context.generation));
  }

  #actualPresentation(active: boolean): void {
    const context = this.#presentationTransition;
    if (active) {
      if (!context || !this.#presentationTransitionCurrent(context)) {
        this.#emit({ type: "presentation", enabled: false }); return;
      }
      context.actual = true;
      if (!context.acknowledged) return;
      this.#clearPresentationTimer();
      this.#presentationState = "active";
      context.settle(true);
      this.#set({ ...this.#snapshot, presenting: true, controlling: false, wantedControl: false });
    } else if (context && !context.acknowledged) {
      void this.#failPresentationTransition(context, true);
    } else if (this.#presentationState === "active") void this.#finishPresentation();
  }

  async #failPresentationTransition(context: MobilePresentationTransition, retireLease: boolean,
    notice: MobileRemoteDesktopNotice = "pip-unavailable"): Promise<void> {
    if (this.#presentationTransition !== context) return;
    this.#presentationTransition = undefined; context.ticket?.close(); context.settle(false);
    this.#presentationState = "idle"; this.#clearPresentationTimer(); this.#settingsApplying = false;
    this.#emit({ type: "presentation", enabled: false });
    this.#set({ ...this.#snapshot, presenting: false, videoSettingsBusy: false, notice });
    await this.#setPlayback(false).catch(() => undefined);
    if (this.#disposed || this.#lease?.leaseId !== context.lease.leaseId || context.generation !== this.#generation) return;
    if (retireLease) {
      this.#resumeEligible = false; this.#endLease(true);
      if (this.#foreground && this.#online && this.#interactive && this.#routeFocused) this.#scheduleReconnect();
    } else {
      this.#emit({ type: "control", enabled: this.#snapshot.controlling });
      this.#refreshPipAvailability();
    }
  }

  setInputMode(mode: MobileRemoteDesktopInputMode): void {
    this.#set({ ...this.#snapshot, inputMode: mode });
    this.#emit({ type: "mode", mode });
  }

  configureMouseControls(enabled: boolean, nativeControls: boolean,
    labels: { readonly left: string; readonly right: string; readonly wheel: string }): void {
    if (this.#disposed || typeof enabled !== "boolean" || typeof nativeControls !== "boolean"
      || !labels || [labels.left, labels.right, labels.wheel].some(label => typeof label !== "string" || label.length < 1 || label.length > 128)) return;
    if (this.#mouseConfiguration?.nativeControls !== nativeControls) {
      this.#retireMouseControls(); this.#retireTouchpad();
    }
    this.#mouseConfiguration = Object.freeze({ nativeControls,
      labels: Object.freeze({ left: labels.left, right: labels.right, wheel: labels.wheel }) });
    this.#set({ ...this.#snapshot, mouseButtons: enabled });
  }

  configureViewport(config: MobileRemoteDesktopViewportConfiguration): void {
    if (this.#disposed || !isRecord(config) || Object.keys(config).length !== 3
      || Object.keys(config).some(key => !["fitToInsets", "topInset", "bottomInset"].includes(key))
      || typeof config.fitToInsets !== "boolean" || ![config.topInset, config.bottomInset]
        .every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 32768)) return;
    if (this.#viewportConfiguration?.fitToInsets === config.fitToInsets
      && this.#viewportConfiguration.topInset === config.topInset && this.#viewportConfiguration.bottomInset === config.bottomInset) return;
    this.#emit({ type: "releaseInput" });
    this.#viewportConfiguration = Object.freeze({ fitToInsets: config.fitToInsets, topInset: config.topInset, bottomInset: config.bottomInset });
    this.#syncViewport();
  }

  beginTouchpad(): MobileRemoteDesktopTouchpadGrant | undefined {
    const scope = this.#captureTouchpadScope();
    if (!scope || this.#touchpadGrants.size > 0) return;
    const grant = Object.freeze({ id: ++this.#touchpadSequence, occurrence: this.#touchpadOccurrence });
    this.#touchpadGrants.set(grant, scope);
    this.#viewerSink({ type: "nativeTouchpad", epoch: scope.viewerEpoch, id: grant.id, event: "start" });
    return grant;
  }

  moveTouchpad(grant: MobileRemoteDesktopTouchpadGrant, dx: number, dy: number): void {
    const scope = this.#touchpadGrants.get(grant);
    if (!scope || !this.#touchpadScopeCurrent(scope) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.#viewerSink({ type: "nativeTouchpad", epoch: scope.viewerEpoch, id: grant.id, event: "move", dx, dy });
  }

  endTouchpad(grant: MobileRemoteDesktopTouchpadGrant, tap = false, cancelled = false): void {
    const scope = this.#touchpadGrants.get(grant);
    if (!scope || !this.#touchpadScopeCurrent(scope) || typeof tap !== "boolean" || typeof cancelled !== "boolean") return;
    this.#touchpadGrants.delete(grant);
    if (cancelled) this.#retireMouseControls();
    this.#viewerSink(cancelled ? { type: "nativeTouchpad", epoch: scope.viewerEpoch, id: grant.id, event: "cancel" }
      : { type: "nativeTouchpad", epoch: scope.viewerEpoch, id: grant.id, event: "end", tap });
  }

  #captureTouchpadScope(): MobileMouseScope | undefined {
    const scope = this.#captureKeyboardScope();
    if (!scope || !this.#mouseConfiguration?.nativeControls || !this.#snapshot.hasFrame
      || this.#snapshot.keyboardOpen || this.#presentationState !== "idle") return;
    return { ...scope, sequenceBase: this.#viewerSequenceBase, sequenceLimit: this.#viewerSequenceLimit,
      inputMode: this.#snapshot.inputMode, keyboardPage: this.#snapshot.keyboardPage };
  }

  #touchpadScopeCurrent(scope: MobileMouseScope): boolean {
    const current = this.#captureTouchpadScope();
    return current !== undefined && this.#mouseAuthorityCurrent(scope)
      && current.inputMode === scope.inputMode && current.keyboardPage === scope.keyboardPage;
  }

  #retireTouchpad(send = true): void {
    const grants = [...this.#touchpadGrants];
    if (grants.length === 0) return;
    this.#touchpadGrants.clear(); this.#touchpadOccurrence += 1;
    this.#snapshot = Object.freeze({ ...this.#snapshot, touchpadOccurrence: this.#touchpadOccurrence });
    if (send) for (const [grant, scope] of grants) {
      if (this.#mouseAuthorityCurrent(scope)) this.#viewerSink({ type: "nativeTouchpad", epoch: scope.viewerEpoch, id: grant.id, event: "cancel" });
    }
    for (const listener of this.#listeners) listener();
  }

  #syncViewport(): void {
    const epoch = this.#viewerEpoch, config = this.#viewportConfiguration;
    if (!epoch || !config || this.#disposed) return;
    const key = JSON.stringify([epoch, config]);
    if (key === this.#viewportConfigurationKey) return;
    this.#viewportConfigurationKey = key;
    this.#viewerSink({ type: "viewport", epoch, ...config });
  }

  beginMouseControl(control: MobileRemoteDesktopMouseControl, y = 0): MobileRemoteDesktopMouseGrant | undefined {
    const scope = this.#captureMouseScope();
    if (!scope || !validMouseControl(control) || !Number.isFinite(y)
      || [...this.#mouseGrants.values()].some(value => value.control === control)) return;
    const grant = Object.freeze({ id: ++this.#mouseSequence, occurrence: this.#mouseOccurrence });
    this.#mouseGrants.set(grant, { control, scope, y });
    this.#sendMouseControl(scope, control, "pointerdown", y);
    return grant;
  }

  moveMouseControl(grant: MobileRemoteDesktopMouseGrant, y: number): void {
    const held = this.#mouseGrants.get(grant);
    if (!held || !Number.isFinite(y) || !this.#mouseScopeCurrent(held.scope)) return;
    held.y = y; this.#sendMouseControl(held.scope, held.control, "pointermove", y);
  }

  endMouseControl(grant: MobileRemoteDesktopMouseGrant, cancelled = false): void {
    const held = this.#mouseGrants.get(grant);
    if (!held || !this.#mouseScopeCurrent(held.scope)) return;
    this.#mouseGrants.delete(grant);
    this.#sendMouseControl(held.scope, held.control, cancelled ? "pointercancel" : "pointerup", held.y);
  }

  clickMouseControl(control: MobileRemoteDesktopMouseControl): void {
    const scope = this.#captureMouseScope();
    if (!scope || !validMouseControl(control) || [...this.#mouseGrants.values()].some(value => value.control === control)) return;
    this.#sendMouseControl(scope, control, "click", 0);
  }

  #captureMouseScope(): MobileMouseScope | undefined {
    const scope = this.#captureKeyboardScope();
    if (!scope || !this.#snapshot.mouseButtons || !this.#mouseConfiguration || !this.#snapshot.hasFrame
      || this.#snapshot.keyboardOpen || this.#presentationState !== "idle") return;
    return { ...scope, sequenceBase: this.#viewerSequenceBase, sequenceLimit: this.#viewerSequenceLimit,
      inputMode: this.#snapshot.inputMode, keyboardPage: this.#snapshot.keyboardPage };
  }

  #mouseScopeCurrent(scope: MobileMouseScope): boolean {
    const current = this.#captureMouseScope();
    return current !== undefined && this.#mouseAuthorityCurrent(scope)
      && current.inputMode === scope.inputMode && current.keyboardPage === scope.keyboardPage;
  }

  #mouseAuthorityCurrent(scope: MobileMouseScope): boolean {
    return !this.#disposed && peerKey(this.#snapshot.host) === scope.hostKey && this.#lease?.leaseId === scope.leaseId
      && this.#generation === scope.generation && this.#controlGeneration === scope.controlGeneration
      && this.#viewerOccurrence === scope.viewerOccurrence && this.#viewerEpoch === scope.viewerEpoch
      && this.#viewerSequenceBase === scope.sequenceBase && this.#viewerSequenceLimit === scope.sequenceLimit;
  }

  #sendMouseControl(scope: MobileMouseScope, control: MobileRemoteDesktopMouseControl,
    event: "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "click", y: number): void {
    this.#viewerSink({ type: "nativeMouse", epoch: scope.viewerEpoch, control, event, id: 0, y });
  }

  #retireMouseControls(send = true): void {
    const grants = [...this.#mouseGrants.values()];
    if (grants.length === 0) return;
    this.#mouseGrants.clear(); this.#mouseOccurrence += 1;
    this.#snapshot = Object.freeze({ ...this.#snapshot, mouseOccurrence: this.#mouseOccurrence });
    if (send) {
      for (const held of grants) {
        if (this.#mouseAuthorityCurrent(held.scope)) this.#sendMouseControl(held.scope, held.control, "pointercancel", held.y);
      }
    }
    for (const listener of this.#listeners) listener();
  }

  #syncMouseControls(): void {
    if ([...this.#touchpadGrants.values()].some(scope => !this.#touchpadScopeCurrent(scope))) this.#retireTouchpad();
    if ([...this.#mouseGrants.values()].some(held => !this.#mouseScopeCurrent(held.scope))) this.#retireMouseControls();
    const epoch = this.#viewerEpoch, config = this.#mouseConfiguration;
    if (!epoch || !config || this.#disposed) return;
    const enabled = this.#captureMouseScope() !== undefined;
    const key = JSON.stringify([epoch, enabled, config.nativeControls, config.labels]);
    if (this.#mouseConfigurationKey === key) return;
    this.#mouseConfigurationKey = key;
    this.#viewerSink({ type: "mouseButtons", epoch, enabled, nativeControls: config.nativeControls, labels: config.labels });
  }

  showKeyboard(): void {
    if (this.#snapshot.keyboardOpen) { this.closeKeyboard(); return; }
    const scope = this.#captureKeyboardScope();
    if (!scope) return;
    this.#keyboardScope = scope;
    this.#set({ ...this.#snapshot, keyboardOpen: true });
    this.#emit({ type: "keyboard", enabled: this.#snapshot.keyboardMode === "inputMethod" });
  }
  closeKeyboard(): void {
    this.#emit({ type: "releaseInput" });
    this.#retireKeyboardTools(true);
  }
  selectKeyboardMode(mode: "inputMethod" | "computer"): void {
    if (!this.#snapshot.keyboardOpen || !this.#captureKeyboardScope()) return;
    this.#emit({ type: "releaseInput" });
    this.#set({ ...this.#snapshot, keyboardMode: mode });
    this.#emit({ type: "keyboard", enabled: mode === "inputMethod" });
  }
  selectKeyboardPage(page: MobileRemoteDesktopKeyboardPage): void {
    if (!this.#snapshot.keyboardOpen || !this.#captureKeyboardScope() || (page !== "abc" && page !== "function")) return;
    this.#emit({ type: "releaseInput" });
    this.#set({ ...this.#snapshot, keyboardPage: page });
  }
  toggleKeyboardCombo(): void {
    if (!this.#snapshot.keyboardOpen || !this.#captureKeyboardScope()) return;
    this.#emit({ type: "releaseInput" });
    this.#set({ ...this.#snapshot, keyboardCombo: !this.#snapshot.keyboardCombo });
  }
  toggleKeyboardModifier(code: MobileRemoteDesktopKeyCode): void {
    if (!this.#snapshot.keyboardOpen || this.#snapshot.keyboardMode !== "computer" || !this.#snapshot.keyboardCombo
      || !this.#captureKeyboardScope() || !mobileRemoteDesktopModifiers.some(modifier => modifier.code === code)) return;
    const selected = this.#snapshot.keyboardModifiers;
    this.#set({ ...this.#snapshot, keyboardModifiers: Object.freeze(selected.includes(code)
      ? selected.filter(key => key !== code) : [...selected, code]) });
  }
  pressKeyboardKey(code: MobileRemoteDesktopKeyCode): MobileRemoteDesktopKeyPress | undefined {
    const scope = this.#keyboardScope;
    if (!scope || !this.#keyboardScopeCurrent(scope) || !this.#snapshot.keyboardOpen || this.#snapshot.keyboardMode !== "computer"
      || !KEY_CODES.has(code) || [...this.#keyPresses.values()].some(press => press.code === code)
      || (this.#snapshot.keyboardCombo && mobileRemoteDesktopModifiers.some(modifier => modifier.code === code))) return;
    const alreadyHeld = new Set([...this.#keyPresses.values()].flatMap(press => [...press.keys]));
    const keys = Object.freeze(this.#snapshot.keyboardCombo ? [...this.#snapshot.keyboardModifiers, code] : [code]);
    const grant = Object.freeze({ id: ++this.#keyPressSequence, occurrence: this.#snapshot.keyboardOccurrence });
    this.#keyPresses.set(grant, { code, keys, scope });
    this.#emit({ type: "events", events: keys.filter(key => !alreadyHeld.has(key)).map(key => ({ kind: "key", code: key, down: true })) });
    this.#publishHeldModifiers();
    return grant;
  }
  releaseKeyboardKey(grant: MobileRemoteDesktopKeyPress | undefined): void {
    if (!grant) return;
    const press = this.#keyPresses.get(grant);
    if (!press || !this.#keyboardScopeCurrent(press.scope)) return;
    this.#keyPresses.delete(grant);
    const stillHeld = new Set([...this.#keyPresses.values()].flatMap(value => [...value.keys]));
    this.#emit({ type: "events", events: [...press.keys].reverse().filter(key => !stillHeld.has(key))
      .map(key => ({ kind: "key", code: key, down: false })) });
    this.#publishHeldModifiers();
  }
  performKeyboardShortcut(id: "allWindows" | "showDesktop"): void {
    if (!this.#captureKeyboardScope() || !this.#snapshot.capabilities) return;
    const shortcut = mobileRemoteDesktopShortcuts(this.#snapshot.capabilities).find(item => item.id === id);
    if (!shortcut) return;
    this.#emit({ type: "releaseInput" });
    this.#emit({ type: "events", events: [
      ...shortcut.keys.map(code => ({ kind: "key", code, down: true })),
      ...[...shortcut.keys].reverse().map(code => ({ kind: "key", code, down: false }))
    ] });
  }
  #captureKeyboardScope(): MobileKeyboardScope | undefined {
    if (!this.#lease || this.#viewerEpoch === undefined || !this.#snapshot.capabilities?.canControl
      || !this.#snapshot.controlling || !this.#snapshot.wantedControl || this.#snapshot.status !== "live"
      || !this.#interactive || !this.#routeFocused || this.#displayModeOperation || !validControlGeneration(this.#controlGeneration)
      || !this.#ready(this.#generation)) return;
    return { hostKey: peerKey(this.#snapshot.host), leaseId: this.#lease.leaseId, generation: this.#generation,
      controlGeneration: this.#controlGeneration, viewerOccurrence: this.#viewerOccurrence, viewerEpoch: this.#viewerEpoch };
  }
  #keyboardScopeCurrent(scope: MobileKeyboardScope): boolean {
    const current = this.#captureKeyboardScope();
    return current !== undefined && current.hostKey === scope.hostKey && current.leaseId === scope.leaseId
      && current.generation === scope.generation && current.controlGeneration === scope.controlGeneration
      && current.viewerOccurrence === scope.viewerOccurrence && current.viewerEpoch === scope.viewerEpoch;
  }
  #publishHeldModifiers(): void {
    if (this.#snapshot.keyboardCombo) return;
    const held = new Set([...this.#keyPresses.values()].flatMap(press => [...press.keys]));
    this.#set({ ...this.#snapshot, keyboardModifiers: Object.freeze(mobileRemoteDesktopModifiers
      .filter(modifier => held.has(modifier.code)).map(modifier => modifier.code)) });
  }
  #retireKeyboardTools(close: boolean): void {
    this.#keyPresses.clear();
    this.#keyboardScope = close ? undefined : this.#captureKeyboardScope();
    if (!this.#snapshot.keyboardOpen && this.#snapshot.keyboardModifiers.length === 0) return;
    this.#snapshot = Object.freeze({ ...this.#snapshot, keyboardOpen: close ? false : this.#snapshot.keyboardOpen,
      keyboardModifiers: Object.freeze([]), keyboardOccurrence: this.#snapshot.keyboardOccurrence + 1 });
    if (close) this.#viewerSink({ type: "keyboard", enabled: false });
    this.#syncMouseControls();
    for (const listener of this.#listeners) listener();
  }
  releaseInput(): void { this.#emit({ type: "releaseInput" }); }
  fit(): void { this.#emit({ type: "fit" }); }
  click(button: 0 | 1 | 2): void {
    if (!this.#snapshot.controlling) return;
    this.#emit({ type: "click", button });
  }

  copyToPhone(): Promise<void> { return this.#transferClipboard("copy"); }
  pasteFromPhone(): Promise<void> { return this.#transferClipboard("paste"); }

  async setClipboardSync(enabled: boolean): Promise<void> {
    const identity = this.#hostMuteIdentity();
    if (!identity || !this.clipboardSyncPreferences || !this.#interactive || !this.#routeFocused
      || !this.#ready(this.#generation) || (enabled && !this.#clipboardSyncAvailable()) || this.#snapshot.clipboardSyncSaving
      || (!this.#snapshot.clipboardSyncLoaded && this.#snapshot.clipboardSyncNotice !== "load-failed")
      || typeof enabled !== "boolean") return;
    const operation = ++this.#clipboardSyncPreferenceOperation;
    this.#set({ ...this.#snapshot, clipboardSyncSaving: true, clipboardSyncNotice: undefined });
    try {
      await this.clipboardSyncPreferences.save(identity, enabled);
      if (!this.#clipboardSyncPreferenceCurrent(identity.targetDeviceId, operation)) return;
      this.#clipboardSyncFailedSave = undefined;
      if (!enabled) this.#clipboardSyncBaseline = { local: "", remote: "" };
      this.#set({ ...this.#snapshot, clipboardSync: enabled, clipboardSyncLoaded: true,
        clipboardSyncSaving: false, clipboardSyncNotice: undefined });
    } catch {
      if (!this.#clipboardSyncPreferenceCurrent(identity.targetDeviceId, operation)) return;
      this.#clipboardSyncFailedSave = enabled;
      this.#set({ ...this.#snapshot, clipboardSyncSaving: false, clipboardSyncNotice: "save-failed" });
    }
  }

  async retryClipboardSync(): Promise<void> {
    if (this.#snapshot.clipboardSyncSaving || !this.#interactive || !this.#routeFocused
      || !this.#ready(this.#generation)) return;
    if (this.#clipboardSyncFailedSave !== undefined) {
      await this.setClipboardSync(this.#clipboardSyncFailedSave);
      return;
    }
    if (!this.#snapshot.clipboardSyncLoaded) {
      await this.#loadClipboardSyncPreference();
      return;
    }
    this.#clipboardSyncBaseline = { local: "", remote: "" };
    this.#clipboardSyncAttempt += 1;
    this.#set({ ...this.#snapshot, clipboardSyncNotice: undefined });
  }

  setForeground(foreground: boolean): void {
    if (this.#foreground === foreground || this.#disposed) return;
    this.#foreground = foreground;
    if (!foreground) this.#credentials?.retire(); else this.bindCredentials();
    this.#syncClipboard();
    if (!foreground) {
      if (this.#presentationState === "active") this.#suspendPresentation();
      else if (this.presentation?.nativeVideo && this.#presentationTransition
        && this.#presentationTransitionCurrent(this.#presentationTransition)) {
        this.#stopTimers(); this.#emit({ type: "control", enabled: false }); this.#emit({ type: "releaseInput" });
      }
      else this.#pause("reconnecting", true);
    } else if (this.#online && this.#interactive) {
      if (this.#presentationState === "active" && this.#routeFocused) {
        if (this.presentation?.nativeVideo) this.#restoreNativePresentation(); else void this.#finishPresentation();
      }
      else void this.#resume();
    }
  }

  setInteractive(interactive: boolean): void {
    if (this.#interactive === interactive || this.#disposed) return;
    if (!interactive && this.presentation?.nativeVideo && this.#snapshot.backgroundViewing
      && this.#presentationState === "idle") void this.startPictureInPicture(false);
    this.#interactive = interactive;
    this.#syncPermissions();
    this.#hostMuteOccurrence += 1;
    this.#syncHostMute();
    this.#syncClipboard();
    if (!interactive) {
      const host = this.#snapshot.host;
      const lease = this.#lease;
      const generation = this.#generation;
      const releaseSequence = this.#viewerReleaseSequence;
      this.#emit({ type: "control", enabled: false });
      this.#emit({ type: "releaseInput" });
      if (this.#presentationState === "idle") {
        this.#emit({ type: "stop", preserveFrame: true });
        this.#retireViewerEpoch();
      }
      this.#stopFrameLoop();
      if (host && lease && this.#snapshot.controlling && this.#ready(generation)) {
        const pending = this.#releaseInputForInteractionFence(host, lease, generation, releaseSequence);
        let tracked!: Promise<void>;
        tracked = pending.finally(() => {
          if (this.#interactionRelease === tracked) this.#interactionRelease = undefined;
        });
        this.#interactionRelease = tracked;
      }
      return;
    }
    if (this.presentation?.nativeVideo && this.#presentationState === "requesting" && this.#presentationTransition) {
      void this.#failPresentationTransition(this.#presentationTransition, true);
      return;
    }
    if (this.#foreground && this.#online) {
      if (this.#presentationState === "active") {
        if (this.presentation?.nativeVideo) this.#restoreNativePresentation(); else void this.#finishPresentation();
      }
      else if (this.#presentationState === "idle") void this.#resumeInteraction();
    }
  }

  setOnline(online: boolean): void {
    if (this.#online === online || this.#disposed) return;
    this.#online = online;
    if (!online) this.#pause("offline", false);
    else if (this.#foreground && this.#interactive) void this.#resume();
  }

  authorityChanged(): void {
    if (this.#disposed) return;
    this.#displayModeReconnect = undefined;
    this.#pause("revoked", true);
    this.#set({ ...this.#snapshot, status: "revoked", notice: "authority-changed" });
  }

  nativeMessage(raw: unknown): void {
    const message = parseMobileRemoteDesktopNativeEvent(raw);
    if (!message || !this.presentation?.nativeVideo || this.#disposed || message.epoch !== this.#viewerEpoch || !this.#lease
      || !this.transport.canStop() || !this.#online) return;
    if (message.type === "channelReply") {
      if (this.#mediaAttemptCurrent(message.attemptId)) this.#channel.receive(message.reply); return;
    }
    if (message.type === "iceConfig") {
      if (this.#mediaAttempt?.attemptId !== message.attemptId) this.#channel.retire();
      if (!this.#ready(this.#generation) || !this.#interactive) return;
      if (this.#presentationState !== "idle") this.#resetPresentation();
      this.#nativeFrameReady = false; this.#viewerPipSupported = false;
      this.#mediaAttempt = Object.freeze({ epoch: message.epoch, attemptId: message.attemptId });
      this.#emit({ type: "nativeAttempt", epoch: message.epoch, attemptId: message.attemptId });
      this.#set({ ...this.#snapshot, pipAvailable: false,
        network: { transport: "video", bytesPerSecond: null, latencyMs: null } });
      void this.#iceConfiguration(message.attemptId); return;
    }
    if (!this.#mediaAttemptCurrent(message.attemptId)) return;
    if (message.type === "videoFrameReady") {
      this.#nativeFrameReady = true;
      this.#stopFrameLoop();
      this.#emit({ type: "nativeVideo", epoch: message.epoch, attemptId: message.attemptId });
      this.#set({ ...this.#snapshot, hasFrame: true, media: "webrtc", status: "live" });
      this.bindCredentials(); void this.#credentials?.presented();
      this.#refreshPipAvailability(); return;
    }
    if (message.type === "network") {
      this.#set({ ...this.#snapshot, network: { transport: message.transport, bytesPerSecond: message.bytesPerSecond, latencyMs: message.latencyMs } }); return;
    }
    if (message.type === "nativeCursor") { this.#emit({ ...message }); return; }
    if (message.type === "presentationStarting") {
      if (this.#snapshot.backgroundViewing && this.#presentationState === "idle") void this.startPictureInPicture(false);
      return;
    }
    if (message.type === "presentation") {
      if (message.active && this.#snapshot.backgroundViewing && this.#presentationState === "idle") void this.startPictureInPicture(false);
      this.#actualPresentation(message.active); return;
    }
    if (message.type === "presentationRestore") {
      if (this.#presentationState !== "active") return;
      this.#presentationRestore = { epoch: message.epoch, attemptId: message.attemptId, restoreId: message.restoreId };
      this.#set({ ...this.#snapshot, restoreRequest: `${message.epoch}/${message.attemptId}/${message.restoreId}` });
      this.#restoreNativePresentation(); return;
    }
    if (message.type === "reconnecting" || message.type === "fallback") {
      this.#nativeFrameReady = false;
      this.#syncNativeInputAuthority();
      this.#emit({ type: message.type, epoch: message.epoch, attemptId: message.attemptId,
        ...(message.type === "fallback" ? { capturePending: message.reason === "capture-pending", retry: message.retry } : {}) });
      if (message.type === "fallback" && this.#presentationState !== "idle") void this.#presentationFailed();
    }
    this.#processViewerMessage(message, true);
  }

  nativeCommandFailed(command: MobileRemoteDesktopNativeCommand): void {
    if (!this.presentation?.nativeVideo || this.#disposed || command.epoch !== this.#viewerEpoch || !this.#lease) return;
    if ("attemptId" in command && !this.#mediaAttemptCurrent(command.attemptId)) return;
    if (command.type === "inputAuthority" && command.grant !== null
      && (!this.#mediaAttemptCurrent(command.grant.attemptId) || command.grant.controlGeneration !== this.#controlGeneration.toString())) return;
    this.#resumeEligible = false; this.#endLease(true);
    this.#set({ ...this.#snapshot, status: "error", notice: "viewer-restarted" });
  }

  #restoreNativePresentation(): void {
    const restore = this.#presentationRestore;
    if (!restore || !this.#routeFocused || !this.#foreground || !this.#interactive || restore.epoch !== this.#viewerEpoch
      || !this.#mediaAttemptCurrent(restore.attemptId)) return;
    this.#emit({ type: "restorePresentation", ...restore });
  }

  viewerMessage(raw: unknown): void {
    let value = raw;
    if (typeof raw === "string" && raw.length <= 100_000) {
      try { value = JSON.parse(raw); } catch { return; }
    }
    if (isRecord(value) && value.type === "mouseControlsRetired") {
      if (!this.#disposed && Object.keys(value).length === 2 && Object.keys(value).every(key => key === "type" || key === "epoch")
        && value.epoch === this.#viewerEpoch) { this.#retireMouseControls(false); this.#retireTouchpad(false); }
      return;
    }
    if (this.presentation?.nativeVideo) {
      if (isRecord(value) && value.type === "nativeViewport") {
        const viewport = parseMobileRemoteDesktopNativeViewport(value);
        if (viewport && viewport.epoch === this.#viewerEpoch && this.#routeFocused && this.#interactive
          && this.#ready(this.#generation)) this.#emit({ ...viewport });
        return;
      }
    }
    this.#processViewerMessage(raw, false);
  }

  #processViewerMessage(raw: unknown, native: boolean): void {
    const message = parseViewerMessage(raw);
    if (!message || this.#disposed) return;
    if (this.presentation?.nativeVideo && !native && !["ready", "input", "inputOverflow", "framePresented"].includes(message.type)) return;
    if (message.type === "ready") {
      this.#viewerReady = true;
      if (this.#interactive) {
        this.#beginViewerOccurrence();
        this.#sendInit();
        if (this.presentation?.nativeVideo) this.#startFrameLoop();
      }
      return;
    }
    if (message.epoch !== this.#viewerEpoch) return;
    if (message.type === "channelReply") {
      if (this.#mediaAttemptCurrent(message.attemptId)) this.#channel.receive(message.reply); return;
    }
    if (message.type === "channelUnavailable") {
      if (this.#mediaAttemptCurrent(message.attemptId)) this.#channel.unavailable(message.id); return;
    }
    if (message.type === "pipCapability") {
      this.#viewerPipSupported = message.supported;
      this.#refreshPipAvailability();
      return;
    }
    if (message.type === "presentation") {
      this.#actualPresentation(message.active);
      return;
    }
    if (message.type === "presentationFailed") {
      if (this.#presentationState !== "idle") void this.#presentationFailed();
      return;
    }
    if (message.type === "streaming") {
      if (!this.#mediaAttemptCurrent(message.attemptId)) return;
      this.#stopFrameLoop();
      this.#retryIndex = 0;
      const settingsApplied = this.#settingsApplying;
      this.#settingsApplying = false;
      this.#set({ ...this.#snapshot, status: "live", media: "webrtc", hasFrame: !native || this.#nativeFrameReady,
        videoSettingsBusy: false, network: this.#snapshot.network ?? { transport: "video", bytesPerSecond: null, latencyMs: null },
        notice: this.#audioUnavailable ? "audio-unavailable" : undefined });
      this.bindCredentials(); void this.#credentials?.presented();
      this.#refreshPipAvailability();
      if (settingsApplied || this.#pendingSettingsReconnect) void this.#flushVideoSettings();
      return;
    }
    if (message.type === "reconnecting") {
      this.#channel.retire();
      if (!this.#mediaAttemptCurrent(message.attemptId)) return;
      this.#startFrameLoop();
      this.#set({ ...this.#snapshot, status: "reconnecting", media: "jpeg" });
      return;
    }
    if (message.type === "fallback") {
      this.#channel.retire();
      if (message.attemptId !== null && !this.#mediaAttemptCurrent(message.attemptId)) return;
      if (message.attemptId === null && this.#snapshot.capabilities?.webrtcVideo !== false) return;
      if (message.capturePending) {
        this.#viewerPipSupported = false; this.#startFrameLoop();
        this.#set({ ...this.#snapshot, status: "capture-pending", media: "jpeg", pipAvailable: false, notice: "capture-pending" });
        return;
      }
      const settingsFailed = this.#settingsApplying;
      this.#settingsApplying = false;
      this.#viewerPipSupported = false;
      if (this.#presentationState !== "idle") void this.#presentationFailed();
      this.#startFrameLoop();
      this.#set({ ...this.#snapshot, status: "live", media: "jpeg",
        videoSettingsBusy: false, pipAvailable: false,
        notice: settingsFailed ? (this.#audioUnavailable ? "audio-unavailable" : "video-settings-failed")
          : this.#snapshot.hasFrame ? undefined : "compatibility" });
      if (this.#pendingSettingsReconnect) void this.#flushVideoSettings();
      return;
    }
    if (message.type === "framePresented") {
      const awaiting = this.#frameAwaitingPresentation;
      if (awaiting?.epoch !== message.epoch || awaiting.frameId !== message.frameId) return;
      this.#frameAwaitingPresentation = undefined;
      if (message.presented) {
        const pending = this.#snapshot.status === "capture-pending";
        this.#frameMetricsBytes += awaiting.bytes;
        const elapsed = this.#frameMetricsAt === undefined ? 0 : awaiting.receivedAt - this.#frameMetricsAt;
        const bytesPerSecond = elapsed >= 250 ? this.#frameMetricsBytes * 1_000 / elapsed : null;
        if (this.#frameMetricsAt === undefined || elapsed >= 1_000) {
          this.#frameMetricsAt = awaiting.receivedAt; this.#frameMetricsBytes = 0;
        }
        this.#set({ ...this.#snapshot, hasFrame: true,
          network: { transport: "screenshot", bytesPerSecond, latencyMs: awaiting.latencyMs },
          ...(pending ? { status: "live", notice: undefined, videoSettingsBusy: false } : {}) });
        if (pending) { this.#settingsApplying = false; if (this.#pendingSettingsReconnect) void this.#flushVideoSettings(); }
        this.bindCredentials(); void this.#credentials?.presented();
      }
      return;
    }
    if (message.type === "inputOverflow") {
      this.#releaseControl("input-overflow");
      void this.setControl(false);
      return;
    }
    if (message.type === "iceConfig") {
      if (this.#mediaAttempt?.attemptId !== message.attemptId) this.#channel.retire();
      this.#mediaAttempt = Object.freeze({ epoch: message.epoch, attemptId: message.attemptId });
      void this.#iceConfiguration(message.attemptId);
    }
    else if (message.type === "offer") void this.#offer(message.attemptId, message.sdp);
    else if (message.type === "ice") void this.#ice(message);
    else if (message.type === "input" && this.#interactive
      && message.sequence > this.#viewerSequenceBase && message.sequence <= this.#viewerSequenceLimit) {
      void this.#input(message.sequence, message.events);
    }
  }

  viewerProcessLost(): void {
    if (this.#disposed || (!this.#viewerReady && this.#viewerEpoch === undefined)) return;
    this.#viewerReady = false;
    const wasPresenting = this.#presentationState !== "idle";
    this.#retireViewerEpoch();
    this.#viewerPipSupported = false;
    if (wasPresenting) {
      this.#presentationState = "idle";
      this.#clearPresentationTimer();
      void this.#setPlayback(false).catch(() => undefined);
      this.#resumeEligible = false;
      this.#endLease(true);
      if (this.#foreground && this.#online && this.#interactive) this.#scheduleReconnect();
      return;
    }
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const generation = this.#generation;
    if (!host || !lease || !this.#snapshot.controlling || !this.#ready(generation)) return;
    this.#releaseControl("viewer-restarted");
    void this.transport.control(host, lease.leaseId, false, this.#request.signal).catch((error) => {
      if (!this.#ready(generation) || this.#displayModeOperation || this.#lease?.leaseId !== lease.leaseId) return;
      if (error instanceof MobileRemoteDesktopAuthorityError) {
        this.authorityChanged();
        return;
      }
      this.#resumeEligible = false;
      this.#endLease(true);
      this.#scheduleReconnect();
    });
  }

  async close(): Promise<void> {
    this.#credentials?.retire();
    if (this.#disposed) return;
    this.#disposed = true;
    this.#displayModeReconnect = undefined;
    const host = this.#snapshot.host;
    const lease = this.#lease ?? this.#displaySwitch?.lease ?? this.#navigationExit?.lease ?? this.#exitContext?.lease;
    this.#exitContext?.request.abort();
    this.#navigationExit?.request.abort();
    this.#exitContext = undefined;
    this.#navigationExit = undefined;
    this.#retireDisplayModeOperation();
    this.#retireRequest();
    if (this.#displaySwitchCompletion) await this.#displaySwitchCompletion;
    this.#displaySwitch = undefined;
    this.#stopTimers();
    this.#resetPresentation();
    this.#emit({ type: "stop", preserveFrame: false });
    this.#viewerReady = false;
    this.#retireViewerEpoch();
    this.#lease = undefined;
    this.#controlGeneration = 0n;
    this.#displayModesPending = false;
    this.#resumeEligible = false;
    await this.#setPlayback(false).catch(() => undefined);
    if (host && lease && this.transport.canStop()) {
      await this.transport.stop(host, lease.leaseId, { lockScreen: false, controlGeneration: 0n }).catch(() => undefined);
    }
    this.#listeners.clear();
  }

  async #transferClipboard(action: "copy" | "paste"): Promise<void> {
    const context = this.#beginClipboardOperation();
    if (!context) return;
    let transferId: string | undefined;
    let completionNotice: MobileRemoteDesktopClipboardNotice | undefined;
    try {
      this.#emit({ type: "releaseInput" });
      const capabilities = this.#snapshot.capabilities;
      if (capabilities?.clipboardContent && this.clipboard?.richAvailable) {
        if (action === "copy") {
          const started = await this.transport.clipboardContent(context.host,
            create(RemoteDesktopClipboardContentRequestSchema, {
              leaseId: context.lease.leaseId,
              controlGeneration: context.controlGeneration,
              action: { case: "copy", value: create(RemoteDesktopClipboardContentCopyActionSchema, {}) }
            }), context.operation.request.signal);
          this.#markClipboardProgress(context);
          transferId = validTransferId(started.transferId) ? started.transferId : undefined;
          const length = started.length;
          if (!transferId || length === undefined || !Number.isSafeInteger(length)
            || length < 1 || length > MOBILE_REMOTE_CLIPBOARD_TRANSFER_CHARS) {
            throw new MobileRemoteClipboardError(length !== undefined
              && length > MOBILE_REMOTE_CLIPBOARD_TRANSFER_CHARS ? "too-long" : "unsupported");
          }
          let json = "";
          while (json.length < length) {
            this.#assertClipboardCurrent(context);
            const chunk = await this.transport.clipboardContent(context.host,
              create(RemoteDesktopClipboardContentRequestSchema, {
                leaseId: context.lease.leaseId,
                controlGeneration: context.controlGeneration,
                action: { case: "read", value: create(RemoteDesktopClipboardContentReadActionSchema, {
                  transferId, offset: json.length
                }) }
              }), context.operation.request.signal);
            this.#markClipboardProgress(context);
            if (typeof chunk.data !== "string" || chunk.data.length < 1
              || chunk.data.length > MOBILE_REMOTE_CLIPBOARD_CHUNK_CHARS
              || json.length + chunk.data.length > length) {
              throw new MobileRemoteClipboardError("unsupported");
            }
            json += chunk.data;
          }
          const item = parseMobileRemoteClipboardItem(json);
          await this.clipboard.writePortable(item, () => this.#markClipboardProgress(context));
        } else {
          const item = await this.clipboard.readPortable(() => this.#markClipboardProgress(context));
          const json = serializeMobileRemoteClipboardItem(item);
          const started = await this.transport.clipboardContent(context.host,
            create(RemoteDesktopClipboardContentRequestSchema, {
              leaseId: context.lease.leaseId,
              controlGeneration: context.controlGeneration,
              action: { case: "begin", value: create(RemoteDesktopClipboardContentBeginActionSchema, {
                length: json.length
              }) }
            }), context.operation.request.signal);
          this.#markClipboardProgress(context);
          transferId = validTransferId(started.transferId) ? started.transferId : undefined;
          if (!transferId) throw new MobileRemoteClipboardError("unsupported");
          for (let offset = 0; offset < json.length; offset += MOBILE_REMOTE_CLIPBOARD_CHUNK_CHARS) {
            this.#assertClipboardCurrent(context);
            await this.transport.clipboardContent(context.host,
              create(RemoteDesktopClipboardContentRequestSchema, {
                leaseId: context.lease.leaseId,
                controlGeneration: context.controlGeneration,
                action: { case: "write", value: create(RemoteDesktopClipboardContentWriteActionSchema, {
                  transferId, offset, data: json.slice(offset, offset + MOBILE_REMOTE_CLIPBOARD_CHUNK_CHARS)
                }) }
              }), context.operation.request.signal);
            this.#markClipboardProgress(context);
          }
          this.#assertClipboardCurrent(context);
          // Commit atomically consumes the staged item before the host injects
          // paste. An unknown response is never replayed automatically.
          await this.transport.clipboardContent(context.host,
            create(RemoteDesktopClipboardContentRequestSchema, {
              leaseId: context.lease.leaseId,
              controlGeneration: context.controlGeneration,
              action: { case: "commit", value: create(RemoteDesktopClipboardContentCommitActionSchema, {
                transferId
              }) }
            }), context.operation.request.signal);
          this.#markClipboardProgress(context);
        }
      } else if (capabilities?.clipboardText && this.clipboard) {
        if (action === "copy") {
          const result = await this.transport.clipboardText(context.host,
            create(RemoteDesktopClipboardTextRequestSchema, {
              leaseId: context.lease.leaseId,
              controlGeneration: context.controlGeneration,
              action: { case: "copy", value: create(RemoteDesktopClipboardTextCopyActionSchema, {}) }
            }), context.operation.request.signal);
          this.#markClipboardProgress(context);
          if (result.text === undefined) throw new MobileRemoteClipboardError("empty");
          await this.clipboard.writeLegacyText(result.text, () => this.#markClipboardProgress(context));
        } else {
          const text = await this.clipboard.readLegacyText(() => this.#markClipboardProgress(context));
          await this.transport.clipboardText(context.host,
            create(RemoteDesktopClipboardTextRequestSchema, {
              leaseId: context.lease.leaseId,
              controlGeneration: context.controlGeneration,
              action: { case: "paste", value: create(RemoteDesktopClipboardTextPasteActionSchema, { text }) }
            }), context.operation.request.signal);
          this.#markClipboardProgress(context);
        }
      } else {
        throw new MobileRemoteClipboardError("unavailable");
      }
      completionNotice = action === "copy" ? "copied" : "pasted";
    } catch (error) {
      if (this.#clipboardOperation === context.operation && !context.operation.retired) {
        this.#handleClipboardFailure(error);
        completionNotice = this.#snapshot.clipboardNotice ?? "failed";
      }
    } finally {
      if (transferId && this.#clipboardLeaseCurrent(context)) {
        void this.transport.clipboardContent(context.host,
          create(RemoteDesktopClipboardContentRequestSchema, {
            leaseId: context.lease.leaseId,
            controlGeneration: context.controlGeneration,
            action: { case: "cancel", value: create(RemoteDesktopClipboardContentCancelActionSchema, {
              transferId
            }) }
          }), this.#request.signal).catch(() => undefined);
      }
      this.#settleClipboardOperation(context.operation, completionNotice);
    }
  }

  #beginClipboardOperation(sync = false): ClipboardContext | undefined {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    if (this.#clipboardOperation) {
      if (!sync) this.#set({ ...this.#snapshot, clipboardNotice: "busy" });
      return undefined;
    }
    if (!this.clipboard || !host || !lease
      || !this.#snapshot.clipboardAvailable || !this.#snapshot.controlling
      || this.#snapshot.status !== "live" || this.#displayModeOperation
      || !validControlGeneration(this.#controlGeneration) || !this.#interactive
      || !this.#ready(this.#generation)) return undefined;
    const request = new AbortController();
    const ownerSignal = this.#request.signal;
    const retire = () => request.abort();
    ownerSignal.addEventListener("abort", retire, { once: true });
    const sequence = ++this.#clipboardSequence;
    const operation = {
      sync,
      sequence,
      request,
      ownerSignal,
      deadline: 0,
      retired: false,
      retire
    };
    this.#clipboardOperation = operation;
    this.#refreshClipboardIdle(operation);
    this.#set({ ...this.#snapshot, clipboardBusy: true, ...(sync ? {} : { clipboardNotice: undefined }) });
    return Object.freeze({ operation, host, lease, generation: this.#generation,
      controlGeneration: this.#controlGeneration });
  }

  #assertClipboardCurrent(context: ClipboardContext): void {
    if (!this.#clipboardContextCurrent(context)) throw new MobileRemoteClipboardError("retired");
  }

  #markClipboardProgress(context: ClipboardContext): void {
    this.#assertClipboardCurrent(context);
    this.#refreshClipboardIdle(context.operation);
  }

  #refreshClipboardIdle(operation: ClipboardOperation): void {
    if (this.#clipboardOperation !== operation) return;
    if (operation.timeout !== undefined) clearTimeout(operation.timeout);
    operation.deadline = Date.now() + MOBILE_REMOTE_CLIPBOARD_TRANSFER_MS;
    operation.timeout = setTimeout(() => {
      if (this.#clipboardOperation !== operation || Date.now() < operation.deadline) return;
      operation.timeout = undefined;
      operation.retired = true;
      operation.request.abort();
      this.#set({ ...this.#snapshot, clipboardBusy: false, ...(operation.sync
        ? { clipboardSyncActive: false, clipboardSyncNotice: "unknown" as const }
        : { clipboardNotice: "failed" as const }) });
    }, MOBILE_REMOTE_CLIPBOARD_TRANSFER_MS);
  }

  #clipboardContextCurrent(context: ClipboardContext): boolean {
    return this.#clipboardOperation === context.operation && this.#clipboardLeaseCurrent(context);
  }

  #clipboardLeaseCurrent(context: ClipboardContext): boolean {
    return !context.operation.request.signal.aborted && Date.now() <= context.operation.deadline
      && this.#interactive && this.#ready(context.generation) && this.#lease?.leaseId === context.lease.leaseId
      && peerKey(this.#snapshot.host) === peerKey(context.host) && this.#snapshot.controlling
      && this.#controlGeneration === context.controlGeneration;
  }

  #settleClipboardOperation(
    operation: ClipboardOperation,
    notice: MobileRemoteDesktopClipboardNotice | undefined
  ): void {
    if (this.#clipboardOperation !== operation) return;
    if (operation.timeout !== undefined) clearTimeout(operation.timeout);
    operation.ownerSignal.removeEventListener("abort", operation.retire);
    this.#clipboardOperation = undefined;
    if (!operation.retired) {
      this.#set({ ...this.#snapshot, clipboardBusy: false,
        ...(operation.sync ? {} : { clipboardNotice: notice ?? "failed" }) });
    }
  }

  #retireClipboardOperation(clearNotice = true): void {
    const operation = this.#clipboardOperation;
    if (!operation) return;
    if (operation.timeout !== undefined) clearTimeout(operation.timeout);
    operation.timeout = undefined;
    operation.retired = true;
    operation.request.abort();
    this.#set({ ...this.#snapshot, clipboardBusy: false,
      ...(clearNotice ? { clipboardNotice: undefined } : {}) });
  }

  #handleClipboardFailure(error: unknown): void {
    if (error instanceof MobileRemoteClipboardError) {
      const notice: MobileRemoteDesktopClipboardNotice = error.code === "empty" ? "empty"
        : error.code === "unsupported" ? "unsupported"
        : error.code === "too-long" ? "too-large"
        : error.code === "unavailable" ? "unavailable" : "failed";
      this.#set({ ...this.#snapshot, clipboardNotice: notice });
      return;
    }
    const failure = remoteDesktopFailure(error);
    if (failure?.reason === RemoteDesktopFailureReason.CLIPBOARD_EMPTY) {
      this.#set({ ...this.#snapshot, clipboardNotice: "empty" });
    } else if (failure?.reason === RemoteDesktopFailureReason.CLIPBOARD_TOO_LARGE) {
      this.#set({ ...this.#snapshot, clipboardNotice: "too-large" });
    } else if (failure?.reason === RemoteDesktopFailureReason.CLIPBOARD_UNSUPPORTED) {
      this.#set({ ...this.#snapshot, clipboardNotice: "unsupported" });
    } else if (failure?.reason === RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE) {
      this.#set({ ...this.#snapshot, clipboardNotice: "unavailable" });
    } else if (failure?.reason === RemoteDesktopFailureReason.CLIPBOARD_BUSY) {
      this.#set({ ...this.#snapshot, clipboardNotice: "busy" });
    } else if (failure?.reason === RemoteDesktopFailureReason.AUTHORITY_CHANGED
      || failure?.reason === RemoteDesktopFailureReason.LEASE_EXPIRED
      || failure?.reason === RemoteDesktopFailureReason.STOPPED) {
      this.#handleFailure(error, "clipboard");
    } else {
      this.#set({ ...this.#snapshot, clipboardNotice: "failed" });
    }
  }

  async #loadDisplayModes(clearNotice: boolean): Promise<void> {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const generation = this.#generation;
    if (this.#displayModesPending || this.#displayModeOperation || !host || !lease
      || !this.#snapshot.capabilities?.displayModes
      || !this.#ready(generation)) return;
    this.#displayModesPending = true;
    this.#set({ ...this.#snapshot, displayModesStatus: "loading",
      ...(clearNotice ? { displayModeNotice: undefined } : {}) });
    try {
      const modes = await this.transport.listDisplayModes(host, lease.leaseId, this.#request.signal);
      if (!this.#ready(generation) || this.#displayModeOperation
        || this.#lease?.leaseId !== lease.leaseId) return;
      if (!validDisplayModes(modes)) throw new Error("Invalid Remote Desktop display modes.");
      this.#set({ ...this.#snapshot, displayModes: Object.freeze([...modes]), displayModesStatus: "ready" });
    } catch {
      if (!this.#ready(generation) || this.#displayModeOperation
        || this.#lease?.leaseId !== lease.leaseId) return;
      this.#set({ ...this.#snapshot, displayModes: Object.freeze([]), displayModesStatus: "error",
        displayModeNotice: "load-failed" });
    } finally {
      this.#displayModesPending = false;
    }
  }

  async #start(
    mode: RemoteDesktopStartMode,
    generation: number,
    allowExpiredFreshFallback = mode === RemoteDesktopStartMode.RESUME
  ): Promise<void> {
    const host = this.#snapshot.host;
    let displayId = this.#snapshot.selectedDisplayId;
    const requestedDisplayId = displayId;
    if (!host || !this.#ready(generation)) return;
    try {
      const capabilities = await this.transport.capabilities(host, this.#request.signal);
      if (!this.#ready(generation) || peerKey(this.#snapshot.host) !== peerKey(host)
        || this.#snapshot.selectedDisplayId !== requestedDisplayId) return;
      if (!validCapabilities(capabilities)) throw new Error("Invalid Remote Desktop capabilities.");
      if (!capabilities.enabled) {
        this.#set({ ...this.#snapshot, capabilities, status: "unsupported", notice: "unavailable" });
        return;
      }
      this.#set({ ...this.#snapshot, capabilities, clipboardAvailable: this.#clipboardAvailable(capabilities) });
      if (!screenPermissionReady(capabilities.permissions)) {
        this.#set({ ...this.#snapshot, status: "permission", notice: "screen-permission" });
        return;
      }
      if (!displayId) {
        displayId = capabilities.displays[0]!.displayId;
        this.#set({ ...this.#snapshot, selectedDisplayId: displayId,
          status: capabilities.displays.length > 1 ? "select-display" : this.#snapshot.status });
        if (capabilities.displays.length > 1) return;
      }
      if (!capabilities.displays.some(display => display.displayId === displayId)) {
        this.#resumeEligible = false;
        this.#set({ ...this.#snapshot, selectedDisplayId: undefined, status: "select-display",
          displaySwitchNotice: "display-missing", notice: undefined });
        return;
      }
      if (this.#snapshot.capabilities?.platform === "linux") {
        this.bindCredentials();
        const authenticated = await this.#credentials?.beforeCapture();
        if (!this.#ready(generation) || peerKey(this.#snapshot.host) !== peerKey(host)
          || this.#snapshot.selectedDisplayId !== displayId) return;
        if (authenticated) {
          const capabilities = await this.transport.capabilities(host, this.#request.signal);
          if (!this.#ready(generation)) return;
          if (!validCapabilities(capabilities) || capabilities.platform !== "linux" || !capabilities.enabled
            || !screenPermissionReady(capabilities.permissions)
            || !capabilities.displays.some(display => display.displayId === displayId)) {
            throw new Error("Remote Desktop capabilities unavailable after native unlock.");
          }
          this.#set({ ...this.#snapshot, capabilities });
          this.bindCredentials();
        }
      }
      const lease = await this.transport.start(host, displayId, mode, this.#request.signal);
      if (!this.#ready(generation) || peerKey(this.#snapshot.host) !== peerKey(host)
        || this.#snapshot.selectedDisplayId !== displayId) {
        if (this.transport.canStop()) void this.transport.stop(host, lease.leaseId, { lockScreen: false, controlGeneration: 0n }).catch(() => undefined);
        return;
      }
      if (!validControlGeneration(lease.controlGeneration)) {
        if (this.transport.canStop()) void this.transport.stop(host, lease.leaseId, { lockScreen: false, controlGeneration: 0n }).catch(() => undefined);
        throw new Error("Invalid Remote Desktop control generation.");
      }
      this.#lease = lease;
      this.#controlRecoveryWanted = lease.controlling;
      this.#controlGeneration = lease.controlGeneration;
      this.#resumeEligible = true;
      const displayModeReconnect = this.#displayModeReconnect;
      const restoreControl = mode === RemoteDesktopStartMode.NEW
        && displayModeReconnect !== undefined
        && displayModeReconnect.hostKey === peerKey(host)
        && displayModeReconnect.displayId === displayId
        && displayModeReconnect.restoreControl;
      this.#displayModeReconnect = undefined;
      this.#retryIndex = 0;
      this.#audioUnavailable = false;
      if (this.#snapshot.capabilities?.systemAudio && this.#snapshot.videoSettings.audio) {
        try {
          await this.#setPlayback(true);
        } catch {
          // Audio is optional. A native playback-session failure degrades this
          // lease occurrence without discarding the saved user preference.
          this.#audioUnavailable = true;
          await this.#setPlayback(false).catch(() => undefined);
        }
      } else {
        await this.#setPlayback(false).catch(() => undefined);
      }
      if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) {
        await this.#setPlayback(false).catch(() => undefined);
        return;
      }
      this.#set({ ...this.#snapshot, status: "live", controlling: lease.controlling,
        displaySwitchNotice: undefined,
        viewerDisplayFitted: false,
        wantedControl: lease.controlling, media: "none", hasFrame: false,
        takeoverAvailable: false, videoSettingsBusy: false, pipAvailable: false,
        presenting: false, displayModes: Object.freeze([]), displayModesStatus: "idle",
        displayModeBusy: false, displayModeNotice: undefined,
        notice: this.#audioUnavailable ? "audio-unavailable" : undefined });
      this.#startHeartbeat();
      this.#sendInit();
      this.#startFrameLoop();
      if (this.#snapshot.capabilities?.displayModes) void this.#loadDisplayModes(false);
      if (restoreControl && !lease.controlling && this.#snapshot.capabilities?.canControl) {
        await this.setControl(true);
      }
    } catch (error) {
      if (!this.#ready(generation)) return;
      const failure = remoteDesktopFailure(error);
      if (allowExpiredFreshFallback && failure?.reason === RemoteDesktopFailureReason.LEASE_EXPIRED) {
        this.#resumeEligible = false;
        await this.#start(RemoteDesktopStartMode.NEW, generation, false);
        return;
      }
      this.#handleFailure(error, "start");
    }
  }

  #startHeartbeat(): void {
    if (this.#presentationState !== "idle") return;
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = setInterval(() => void this.#heartbeat(), MOBILE_REMOTE_DESKTOP_HEARTBEAT_MS);
  }

  async #heartbeat(): Promise<void> {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const generation = this.#generation;
    if (this.#heartbeatCompletion !== undefined || this.#heartbeatPending
      || this.#displayModeOperation || this.#presentationState !== "idle"
      || !host || !lease || !this.#ready(generation)) return;
    this.#heartbeatPending = true;
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => { settle = resolve; });
    this.#heartbeatCompletion = completion;
    try {
      const state = await this.transport.heartbeat(host, lease.leaseId, this.#request.signal);
      if (!this.#ready(generation) || this.#displayModeOperation
        || this.#lease?.leaseId !== lease.leaseId) return;
      if (!validControlGeneration(state.controlGeneration)) throw new Error("Invalid Remote Desktop control generation.");
      if (!this.#adoptControlGeneration(state.controlGeneration)) return;
      if (state.controlling !== this.#snapshot.controlling) {
        this.#set({ ...this.#snapshot, controlling: state.controlling,
          wantedControl: state.controlling && this.#snapshot.wantedControl });
        this.#emit({ type: "control", enabled: state.controlling });
        if (!state.controlling) this.#emit({ type: "releaseInput" });
      }
      this.#syncHostMute();
      if (!state.controlling) this.#restoreForegroundControl();
    } catch (error) {
      if (this.#ready(generation) && !this.#displayModeOperation) this.#handleFailure(error, "heartbeat");
    } finally {
      this.#heartbeatPending = false;
      if (this.#heartbeatCompletion === completion) this.#heartbeatCompletion = undefined;
      settle();
    }
  }

  #startFrameLoop(): void {
    if (!this.#snapshot.capabilities?.jpegFallback || this.#frameTimer !== undefined || this.#disposed
      || this.#presentationState !== "idle" || !this.#interactive || this.#viewerEpoch === undefined) return;
    this.#set({ ...this.#snapshot, media: this.#snapshot.media === "webrtc" ? "webrtc" : "jpeg" });
    void this.#frame();
    this.#frameTimer = setInterval(() => void this.#frame(), MOBILE_REMOTE_DESKTOP_FRAME_MS);
  }

  #stopFrameLoop(): void {
    if (this.#frameTimer !== undefined) clearInterval(this.#frameTimer);
    this.#frameTimer = undefined;
    this.#frameRequest?.abort(); this.#frameRequest = undefined;
    this.#framePending = false;
    this.#frameAwaitingPresentation = undefined;
  }

  async #frame(): Promise<void> {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const generation = this.#generation;
    const capturedEpoch = this.#viewerEpoch;
    if (this.#framePending || this.#displayModeOperation || this.#frameAwaitingPresentation !== undefined || !host || !lease
      || !this.#ready(generation) || !this.#interactive || this.#viewerEpoch === undefined
      || this.#snapshot.media === "webrtc") return;
    this.#framePending = true;
    const request = new AbortController(), ownerSignal = this.#request.signal;
    const retire = () => request.abort(); ownerSignal.addEventListener("abort", retire, { once: true });
    this.#frameRequest = request;
    const startedAt = Date.now();
    try {
      const cursorOverlay = this.#snapshot.capabilities?.cursorOverlay === true;
      const result = await this.transport.frame(host, lease.leaseId, cursorOverlay, request.signal);
      if (!this.#ready(generation) || this.#displayModeOperation || this.#lease?.leaseId !== lease.leaseId
        || capturedEpoch !== this.#viewerEpoch || request.signal.aborted || this.#frameRequest !== request) return;
      const frame = result.frame;
      const jpeg = frame?.jpeg;
      const epoch = this.#viewerEpoch;
      if (jpeg?.length && epoch !== undefined) {
        const cursor = frame?.cursor;
        if (cursor !== undefined && !validRemoteDesktopCursor(cursor)) {
          throw new Error("Invalid Remote Desktop cursor.");
        }
        const frameId = `${epoch}:${++this.#frameSequence}`;
        const receivedAt = Date.now();
        this.#frameAwaitingPresentation = Object.freeze({ epoch, frameId, bytes: jpeg.length, receivedAt,
          latencyMs: Math.max(0, receivedAt - startedAt) });
        this.#emit({ type: "frame", epoch, frameId, jpeg: encodeBase64(jpeg),
          ...(cursorOverlay ? { cursor: cursor === undefined ? null : viewerCursor(cursor) } : {}) });
      }
    } catch (error) {
      if (this.#ready(generation) && !this.#displayModeOperation && capturedEpoch === this.#viewerEpoch
        && !request.signal.aborted && this.#frameRequest === request) this.#handleFailure(error, "frame");
    } finally {
      ownerSignal.removeEventListener("abort", retire);
      if (this.#frameRequest === request) { this.#frameRequest = undefined; this.#framePending = false; }
    }
  }

  async #flushVideoSettings(): Promise<void> {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const generation = this.#generation;
    if (!this.#pendingSettingsReconnect || this.#settingsApplying || this.#offerPending
      || this.#presentationState !== "idle" || !host || !lease
      || !this.#snapshot.capabilities?.videoSettings || !this.#ready(generation)) return;
    this.#pendingSettingsReconnect = false;
    this.#settingsApplying = true;
    this.#set({ ...this.#snapshot, videoSettingsBusy: true,
      notice: this.#audioUnavailable ? "audio-unavailable" : undefined });
    if (this.#snapshot.videoSettings.audio && this.#snapshot.capabilities.systemAudio
      && !this.#audioUnavailable) {
      try {
        await this.#setPlayback(true);
      } catch {
        this.#audioUnavailable = true;
        await this.#setPlayback(false).catch(() => undefined);
      }
    } else {
      await this.#setPlayback(false).catch(() => undefined);
    }
    if (this.#audioUnavailable && this.#snapshot.notice !== "audio-unavailable") {
      this.#set({ ...this.#snapshot, notice: "audio-unavailable" });
    }
    if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) {
      this.#settingsApplying = false;
      return;
    }
    if (!this.#viewerReady || this.#viewerEpoch === undefined) {
      this.#settingsApplying = false;
      this.#set({ ...this.#snapshot, videoSettingsBusy: false,
        notice: this.#audioUnavailable ? "audio-unavailable" : undefined });
      return;
    }
    this.#emit({ type: "videoSettings", audio: this.#negotiatedAudio() });
  }

  #negotiatedAudio(): boolean {
    return this.#snapshot.capabilities?.systemAudio === true
      && this.#snapshot.videoSettings.audio && !this.#audioUnavailable;
  }

  #negotiatedSettings(): RemoteDesktopVideoSettings | undefined {
    if (!this.#snapshot.capabilities?.videoSettings) return undefined;
    return create(RemoteDesktopVideoSettingsSchema, {
      fps: this.#snapshot.videoSettings.fps,
      quality: this.#snapshot.videoSettings.quality === "auto"
        ? RemoteDesktopVideoQuality.AUTO
        : this.#snapshot.videoSettings.quality === "saver"
          ? RemoteDesktopVideoQuality.SAVER
          : RemoteDesktopVideoQuality.HD,
      audio: this.#negotiatedAudio()
    });
  }

  async #setPlayback(enabled: boolean): Promise<void> {
    if (!this.presentation?.requiresPlaybackSession) return;
    this.#playbackDesired = enabled;
    const operation = this.#playbackOperation.catch(() => undefined).then(async () => {
      while (this.#playbackDesired !== this.#playbackActive) {
        const desired = this.#playbackDesired;
        await this.presentation!.playback(desired);
        this.#playbackActive = desired;
      }
    });
    this.#playbackOperation = operation;
    await operation;
    if (this.#playbackDesired !== enabled || this.#playbackActive !== enabled) {
      throw new Error("The Remote Desktop playback request was retired.");
    }
  }

  #refreshPipAvailability(): void {
    const available = this.#presentationState === "idle"
      && this.#viewerPipSupported && this.presentation?.nativePictureInPicture === true
      && this.#snapshot.capabilities?.backgroundViewing === true
      && this.#snapshot.status === "live" && this.#snapshot.media === "webrtc"
      && this.#snapshot.hasFrame && !this.#settingsApplying
      && (!this.presentation?.nativeVideo || this.#nativeFrameReady);
    if (available !== this.#snapshot.pipAvailable) {
      this.#set({ ...this.#snapshot, pipAvailable: available });
    }
  }

  #suspendPresentation(): void {
    this.#retireRequest();
    this.#request = new AbortController();
    this.#stopTimers();
    this.#retireClipboardOperation();
    this.#settingsApplying = false;
    this.#offerPending = false;
    this.#queuedOffer = undefined;
    this.#set({ ...this.#snapshot, controlling: false, wantedControl: false,
      clipboardBusy: false, videoSettingsBusy: false, pipAvailable: false });
    this.#emit({ type: "control", enabled: false });
    this.#emit({ type: "releaseInput" });
  }

  async #presentationFailed(): Promise<void> {
    if (this.presentation?.nativeVideo && this.#presentationState === "requesting" && this.#presentationTransition) {
      await this.#failPresentationTransition(this.#presentationTransition, true);
    } else await this.#finishPresentation("pip-unavailable");
  }

  async #finishPresentation(notice?: MobileRemoteDesktopNotice): Promise<void> {
    if (this.#presentationState === "idle") return;
    if (this.#navigationExit) {
      await this.#dispatchExit(this.#navigationExit);
      return;
    }
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const generation = this.#generation;
    const transition = this.#presentationTransition;
    this.#presentationTransition = undefined; transition?.ticket?.close(); transition?.settle(false);
    this.#presentationRestore = undefined;
    this.#presentationState = "idle";
    this.#clearPresentationTimer();
    this.#emit({ type: "presentation", enabled: false });
    this.#set({ ...this.#snapshot, presenting: false, pipAvailable: false, restoreRequest: undefined,
      controlling: false, wantedControl: false, ...(notice ? { notice } : {}) });
    // Always release the presentation-owned audio session first. A foreground
    // viewer that still wants system audio reacquires it below.
    await this.#setPlayback(false).catch(() => undefined);
    if (!host || !lease || !this.#foreground || !this.#online || !this.#interactive
      || !this.transport.isCurrent()) {
      this.#pause("reconnecting", true);
      return;
    }
    try {
      const state = await this.transport.presentation(host, lease.leaseId, false, this.#request.signal);
      if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) return;
      if (!validControlGeneration(state.controlGeneration) || state.controlling) {
        throw new Error("Invalid Remote Desktop presentation state.");
      }
      if (!this.#adoptControlGeneration(state.controlGeneration)) return;
      if (this.#negotiatedAudio()) {
        try { await this.#setPlayback(true); }
        catch {
          this.#audioUnavailable = true;
          this.#pendingSettingsReconnect = true;
          this.#set({ ...this.#snapshot, notice: "audio-unavailable" });
        }
      }
      if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) return;
      this.#startHeartbeat();
      this.#refreshPipAvailability();
      if (this.#pendingSettingsReconnect) void this.#flushVideoSettings();
    } catch {
      if (this.#lease?.leaseId !== lease.leaseId) return;
      await this.#setPlayback(false).catch(() => undefined);
      this.#resumeEligible = false;
      this.#endLease(true);
      if (this.#foreground && this.#online && this.#interactive) this.#scheduleReconnect();
    }
  }

  #clearPresentationTimer(): void {
    if (this.#presentationTimer !== undefined) clearTimeout(this.#presentationTimer);
    this.#presentationTimer = undefined;
  }

  #resetPresentation(): void {
    const active = this.#presentationState !== "idle";
    const context = this.#presentationTransition;
    this.#presentationTransition = undefined; context?.ticket?.close(); context?.settle(false);
    this.#presentationRestore = undefined;
    this.#presentationState = "idle";
    this.#clearPresentationTimer();
    if (active) this.#emit({ type: "presentation", enabled: false });
  }

  async #iceConfiguration(attemptId: string): Promise<void> {
    const context = this.#mediaContext(attemptId);
    if (!context) return;
    let iceServers: readonly { readonly urls: readonly string[]; readonly username?: string; readonly credential?: string }[] = PUBLIC_STUN;
    try {
      const raw = await this.transport.iceConfiguration(context.host, context.lease.leaseId, this.#request.signal);
      if (!this.#mediaCurrent(context)) return;
      iceServers = validIceServers(raw);
    } catch {
      if (!this.#mediaCurrent(context)) return;
    }
    this.#emit({ type: "iceConfig", epoch: this.#viewerEpoch, attemptId, iceServers });
  }

  async #offer(attemptId: string, sdp: string): Promise<void> {
    const context = this.#mediaContext(attemptId);
    if (!context || !sdp || sdp.length > 64_000) return;
    if (this.#offerPending) {
      this.#queuedOffer = Object.freeze({ epoch: context.epoch, attemptId, sdp });
      return;
    }
    this.#offerPending = true;
    const operation = {}; this.#offerOperation = operation;
    try {
      const answer = await this.transport.offer(context.host, context.lease.leaseId, attemptId, sdp,
        this.#negotiatedSettings(), this.#snapshot.capabilities?.cursorOverlay === true, this.#request.signal);
      if (!this.#mediaCurrent(context) || answer.attemptId !== attemptId) return;
      this.#emit({ type: "answer", epoch: this.#viewerEpoch, attemptId, sdp: answer.answerSdp });
    } catch (error) {
      if (!this.#mediaCurrent(context)) return;
      const failure = remoteDesktopFailure(error);
      if (failure?.reason === RemoteDesktopFailureReason.CAPTURE_PENDING) {
        this.#set({ ...this.#snapshot, status: "capture-pending", notice: "capture-pending" });
        this.#emit({ type: "fallback", epoch: context.epoch, attemptId, retry: true, capturePending: true });
      } else if (failure?.reason === RemoteDesktopFailureReason.SCREEN_PERMISSION_REQUIRED) {
        this.#handleFailure(error, "frame");
      } else if (failure?.reason === RemoteDesktopFailureReason.AUDIO_UNAVAILABLE
        && this.#negotiatedAudio()) {
        this.#audioUnavailable = true;
        this.#settingsApplying = true;
        this.#set({ ...this.#snapshot, videoSettingsBusy: true, notice: "audio-unavailable" });
        void this.#setPlayback(false).catch(() => undefined);
        this.#emit({ type: "videoSettings", audio: false });
      } else {
        this.#emit({ type: "fallback", epoch: this.#viewerEpoch, attemptId, retry: true, capturePending: false });
      }
    } finally {
      if (this.#offerOperation === operation) {
        this.#offerOperation = undefined; this.#offerPending = false;
        const queued = this.#queuedOffer;
        this.#queuedOffer = undefined;
        if (queued && queued.epoch === this.#viewerEpoch) void this.#offer(queued.attemptId, queued.sdp);
        else if (this.#pendingSettingsReconnect && !this.#settingsApplying) void this.#flushVideoSettings();
      }
    }
  }

  async #ice(message: Extract<ViewerMessage, { readonly type: "ice" }>): Promise<void> {
    const context = this.#mediaContext(message.attemptId);
    if (!context) return;
    try {
      const result = await this.transport.ice(context.host, context.lease.leaseId, message.attemptId,
        message.candidates, message.after, this.#request.signal);
      if (!this.#mediaCurrent(context)) return;
      this.#emit({ type: "ice", epoch: this.#viewerEpoch, attemptId: message.attemptId, exchangeId: message.exchangeId,
        error: false, candidates: this.presentation?.nativeVideo ? result.candidates.map(candidate => ({
          candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null, usernameFragment: candidate.usernameFragment ?? null
        })) : result.candidates, next: result.next, complete: result.complete });
    } catch {
      if (this.#mediaCurrent(context)) this.#emit({ type: "ice", epoch: this.#viewerEpoch, attemptId: message.attemptId,
        exchangeId: message.exchangeId, error: true });
    }
  }

  async #input(sequence: number, rawEvents: unknown): Promise<void> {
    const events = parseInputEvents(rawEvents);
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const generation = this.#generation;
    const epoch = this.#viewerEpoch, attemptId = this.#mediaAttempt?.attemptId;
    const controlGeneration = this.#controlGeneration;
    if (!events || this.#inputPending || !host || !lease || !this.#snapshot.controlling
      || !epoch || !this.#interactive || !this.#routeFocused || !this.#ready(generation)) return;
    const token = {}; this.#inputBatch = token; this.#inputPending = true;
    let nativeDispatched = false;
    const current = () => this.#inputBatch === token && this.#ready(generation) && this.#interactive && this.#routeFocused
      && this.#snapshot.controlling && this.#controlGeneration === controlGeneration
      && this.#lease?.leaseId === lease.leaseId && peerKey(this.#snapshot.host) === peerKey(host)
      && this.#viewerEpoch === epoch && (!attemptId || this.#mediaAttemptCurrent(attemptId));
    try {
      if (this.presentation?.nativeVideo && this.#nativeFrameReady && this.#snapshot.media === "webrtc"
        && attemptId && this.presentation.sendInput) {
        const batch = parseMobileRemoteDesktopNativeInputBatch({ epoch, attemptId, controlGeneration: controlGeneration.toString(),
          sequenceBase: this.#viewerSequenceBase, sequenceLimit: this.#viewerSequenceLimit, sequence, events: rawEvents });
        if (!batch) throw new Error("Invalid Remote Desktop native input batch.");
        nativeDispatched = true;
        const accepted = await this.presentation.sendInput(batch);
        if (accepted !== true && accepted !== false) throw new Error("Invalid Remote Desktop native input receipt.");
        if (accepted) {
          if (current()) this.#emit({ type: "ack", epoch, sequence });
          return;
        }
        if (!current()) return;
        nativeDispatched = false;
      }
      await this.transport.input(host, lease.leaseId, BigInt(sequence), events, this.#request.signal);
      if (current()) this.#emit({ type: "ack", epoch, sequence });
    } catch (error) {
      if (current()) {
        if (nativeDispatched) {
          this.#resumeEligible = false; this.#endLease(true);
          this.#set({ ...this.#snapshot, status: "error", notice: "input-unavailable" });
        } else this.#handleFailure(error, "input");
      }
    } finally {
      if (this.#inputBatch === token) { this.#inputBatch = undefined; this.#inputPending = false; }
    }
  }

  #sendInit(): void {
    const display = this.#lease?.display;
    if (!this.#viewerReady || !this.#interactive || !display || !this.#snapshot.capabilities
      || this.#viewerOccurrence < 1) return;
    const epoch = `${this.#generation}-${this.#viewerOccurrence}-${this.#lease!.leaseId}`;
    if (this.#viewerEpoch !== epoch) {
      this.#mediaAttempt = undefined;
      this.#frameAwaitingPresentation = undefined;
    }
    this.#viewerEpoch = epoch;
    this.#emit({ type: "init", epoch,
      width: display.width, height: display.height, trickleIce: this.#snapshot.capabilities.trickleIce,
      webrtc: this.#snapshot.capabilities.webrtcVideo,
      cursorOverlay: this.#snapshot.capabilities.cursorOverlay,
      audio: this.#negotiatedAudio(),
      nativeVideo: this.presentation?.nativeVideo === true, net: RTC_NETWORK, iceServers: PUBLIC_STUN,
      sequenceBase: this.#viewerSequenceBase,
      sequenceLimit: this.#viewerSequenceLimit });
    this.#emit({ type: "mode", mode: this.#snapshot.inputMode });
    this.#emit({ type: "control", enabled: this.#snapshot.controlling });
  }

  #mediaContext(attemptId: string) {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const attempt = this.#mediaAttempt;
    if (!ATTEMPT.test(attemptId) || !host || !lease || !attempt || !this.#ready(this.#generation)
      || attempt.epoch !== this.#viewerEpoch || attempt.attemptId !== attemptId) return undefined;
    return Object.freeze({ attemptId, epoch: attempt.epoch, host, lease, generation: this.#generation });
  }

  #mediaCurrent(context: { readonly attemptId: string; readonly host: DevicePeerDescriptor;
    readonly epoch: string; readonly lease: RemoteDesktopLease; readonly generation: number }): boolean {
    return this.#ready(context.generation) && this.#lease?.leaseId === context.lease.leaseId
      && peerKey(this.#snapshot.host) === peerKey(context.host)
      && this.#viewerEpoch === context.epoch && this.#mediaAttempt?.epoch === context.epoch
      && this.#mediaAttempt?.attemptId === context.attemptId;
  }

  #mediaAttemptCurrent(attemptId: string): boolean {
    return this.#mediaAttempt?.epoch === this.#viewerEpoch && this.#mediaAttempt?.attemptId === attemptId;
  }

  #handleFailure(error: unknown, operation: "catalog" | "capabilities" | "permissions" | "start"
    | "heartbeat" | "control" | "input" | "frame" | "clipboard"): void {
    if (error instanceof MobileRemoteDesktopAuthorityError) {
      this.authorityChanged();
      return;
    }
    const failure = remoteDesktopFailure(error);
    if (operation === "start" && failure?.reason === RemoteDesktopFailureReason.DISPLAY_MISSING) {
      this.#endLease(false);
      this.#set({ ...this.#snapshot, selectedDisplayId: undefined, status: "select-display",
        displaySwitchNotice: "display-missing", controlling: false, wantedControl: false, notice: undefined });
      return;
    }
    if (failure?.reason === RemoteDesktopFailureReason.CAPTURE_PENDING && this.#lease) {
      this.#set({ ...this.#snapshot, status: "capture-pending", notice: "capture-pending" });
      return;
    }
    if (operation === "control" || operation === "input") {
      if (failure?.reason === RemoteDesktopFailureReason.INPUT_BUSY
        || failure?.reason === RemoteDesktopFailureReason.INPUT_UNAVAILABLE
        || failure?.reason === RemoteDesktopFailureReason.VIEW_ONLY
        || failure?.reason === RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED) {
        this.#releaseControl(controlFailureNotice(failure.reason));
        if (operation === "input") this.#restoreForegroundControl();
        return;
      }
      if (failure?.reason !== RemoteDesktopFailureReason.AUTHORITY_CHANGED
        && failure?.reason !== RemoteDesktopFailureReason.LEASE_EXPIRED
        && failure?.reason !== RemoteDesktopFailureReason.STOPPED) {
        this.#releaseControl("input-unavailable");
        return;
      }
    }
    if (failure?.reason === RemoteDesktopFailureReason.SCREEN_PERMISSION_REQUIRED) {
      this.#endLease(true);
      this.#set({ ...this.#snapshot, status: "permission", controlling: false, wantedControl: false,
        notice: "screen-permission" });
      return;
    }
    if (failure?.reason === RemoteDesktopFailureReason.BUSY) {
      const transition = operation === "start" ? this.#displayModeReconnect : undefined;
      const expiresAt = transition?.expiresAt;
      if (transition !== undefined
        && expiresAt !== undefined
        && transition.hostKey === peerKey(this.#snapshot.host)
        && transition.displayId === this.#snapshot.selectedDisplayId
        && Date.now() < expiresAt
        && this.#foreground && this.#online && this.#interactive) {
        const normalDelay = RETRY_MS[Math.min(this.#retryIndex, RETRY_MS.length - 1)]!;
        const delay = Math.min(normalDelay, Math.max(0, expiresAt + 500 - Date.now()));
        this.#endLease(false);
        this.#scheduleReconnect(delay);
        return;
      }
      this.#displayModeReconnect = undefined;
      this.#resumeEligible = false;
      this.#endLease(false);
      this.#set({ ...this.#snapshot, status: "busy", controlling: false, wantedControl: false,
        takeoverAvailable: this.#snapshot.capabilities?.connectionTakeover === true,
        notice: "busy" });
      return;
    }
    if (failure?.reason === RemoteDesktopFailureReason.AUTHORITY_CHANGED) {
      this.#resumeEligible = false;
      this.authorityChanged();
      return;
    }
    if (failure?.reason === RemoteDesktopFailureReason.DISABLED
      || failure?.reason === RemoteDesktopFailureReason.UNSUPPORTED
      || failure?.reason === RemoteDesktopFailureReason.LOCKED_SESSION_UNSUPPORTED) {
      this.#endLease(true);
      this.#set({ ...this.#snapshot, status: "unsupported", controlling: false, wantedControl: false,
        notice: "unavailable" });
      return;
    }
    if (failure?.reason === RemoteDesktopFailureReason.STOPPED) {
      this.#endLease(false);
      this.#set({ ...this.#snapshot, status: "stopped", controlling: false, wantedControl: false,
        notice: "stopped" });
      return;
    }
    if (failure?.reason === RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE) {
      this.#endLease(false); this.#resumeEligible = false; this.#temporaryModeUncertain = true;
      this.#set({ ...this.#snapshot, status: "error", controlling: false, wantedControl: false, displayModeNotice: "restore-unavailable" });
      return;
    }
    if (operation === "frame" && (failure?.reason === RemoteDesktopFailureReason.VIDEO_BUSY
      || failure?.reason === RemoteDesktopFailureReason.VIDEO_TIMEOUT)) return;
    if (operation === "heartbeat" && failure && [RemoteDesktopFailureReason.INPUT_BUSY,
      RemoteDesktopFailureReason.INPUT_UNAVAILABLE, RemoteDesktopFailureReason.VIEW_ONLY,
      RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED].includes(failure.reason)) {
      this.#releaseControl(controlFailureNotice(failure.reason));
      return;
    }
    if ((failure?.retryable ?? (operation === "heartbeat" || operation === "frame"))
      && this.#foreground && this.#online) {
      this.#scheduleReconnect();
      return;
    }
    this.#endLease(true);
    this.#set({ ...this.#snapshot, status: "error", controlling: false, wantedControl: false,
      notice: "generic-error" });
  }

  #releaseControl(notice?: MobileRemoteDesktopNotice): void {
    this.#retireClipboardOperation();
    this.#controlGeneration = 0n;
    this.#set({ ...this.#snapshot, controlling: false, wantedControl: false, ...(notice ? { notice } : {}) });
    this.#emit({ type: "control", enabled: false });
    this.#emit({ type: "releaseInput" });
  }

  #scheduleReconnect(delayOverride?: number): void {
    if (this.#retryTimer !== undefined || !this.#foreground || !this.#interactive
      || !this.#online || this.#disposed || this.#presentationState !== "idle") return;
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#stopFrameLoop();
    this.#set({ ...this.#snapshot, status: "reconnecting", controlling: false, wantedControl: false, media: "jpeg" });
    this.#emit({ type: "control", enabled: false });
    this.#emit({ type: "releaseInput" });
    const delay = delayOverride ?? RETRY_MS[Math.min(this.#retryIndex, RETRY_MS.length - 1)]!;
    this.#retryIndex = Math.min(this.#retryIndex + 1, RETRY_MS.length);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#resume();
    }, delay);
  }

  async #resume(): Promise<void> {
    if (this.#temporaryModeUncertain || this.#displaySwitch) return;
    if (this.#disposed || this.#snapshot.exitStatus !== "idle" || !this.#foreground || !this.#interactive
      || !this.#online || !this.transport.isCurrent()) return;
    if (this.#permissionBlocked) {
      this.#newRequest(); this.#resumeEligible = false;
      this.#set({ ...this.#snapshot, status: "permission", notice: "screen-permission" });
      return;
    }
    if (this.#snapshot.displaySwitchNotice === "display-missing") {
      this.#newRequest();
      this.#set({ ...this.#snapshot, status: "select-display" });
      return;
    }
    const host = this.#snapshot.host;
    const displayId = this.#snapshot.selectedDisplayId;
    if (!host || !displayId) return this.open();
    const generation = this.#newRequest();
    this.#set({ ...this.#snapshot, status: "reconnecting", controlling: false, wantedControl: false, notice: undefined });
    await this.#start(this.#resumeEligible ? RemoteDesktopStartMode.RESUME : RemoteDesktopStartMode.NEW, generation);
  }

  #pause(status: "offline" | "reconnecting" | "revoked", stop: boolean): void {
    if (status === "offline" || status === "revoked") this.#credentials?.retire();
    const host = this.#snapshot.host;
    const lease = this.#lease;
    this.#navigationExit = undefined;
    this.#retireDisplayModeOperation();
    this.#retireRequest();
    this.#stopTimers();
    this.#resetPresentation();
    void this.#setPlayback(false).catch(() => undefined);
    this.#lease = undefined;
    this.#controlGeneration = 0n;
    this.#displayModesPending = false;
    this.#resumeEligible = !stop && lease !== undefined;
    this.#settingsApplying = false;
    this.#pendingSettingsReconnect = false;
    this.#offerPending = false;
    this.#queuedOffer = undefined;
    this.#emit({ type: "control", enabled: false });
    this.#emit({ type: "releaseInput" });
    this.#emit({ type: "stop", preserveFrame: true });
    this.#retireViewerEpoch();
    this.#set({ ...this.#snapshot, status: this.#permissionBlocked && status !== "revoked" ? "permission" : status,
      controlling: false, wantedControl: false, media: "none", navigationRetained: false,
      videoSettingsBusy: false, pipAvailable: false, presenting: false });
    if (stop && host && lease && !this.#displaySwitch && this.transport.canStop()) void this.transport.stop(host, lease.leaseId,
      { lockScreen: false, controlGeneration: 0n }).catch(() => undefined);
  }

  #endLease(stop: boolean): void {
    this.#controlRecoveryWanted = false; this.#controlRequest = undefined;
    const host = this.#snapshot.host;
    const lease = this.#lease;
    this.#retireRequest();
    this.#generation += 1;
    this.#stopTimers();
    this.#resetPresentation();
    void this.#setPlayback(false).catch(() => undefined);
    this.#lease = undefined;
    this.#controlGeneration = 0n;
    this.#displayModesPending = false;
    this.#resumeEligible = false;
    this.#settingsApplying = false;
    this.#pendingSettingsReconnect = false;
    this.#offerPending = false;
    this.#queuedOffer = undefined;
    this.#emit({ type: "control", enabled: false });
    this.#emit({ type: "releaseInput" });
    this.#emit({ type: "stop", preserveFrame: true });
    this.#retireViewerEpoch();
    this.#set({ ...this.#snapshot, controlling: false, wantedControl: false,
      videoSettingsBusy: false, pipAvailable: false, presenting: false });
    if (stop && host && lease && this.transport.canStop()) void this.transport.stop(host, lease.leaseId,
      { lockScreen: false, controlGeneration: 0n }).catch(() => undefined);
  }

  #newRequest(): number {
    this.#exitContext?.request.abort();
    this.#navigationExit?.request.abort();
    this.#exitContext = undefined;
    this.#exitCompletion = undefined;
    this.#navigationExit = undefined;
    this.#retireDisplayModeOperation();
    this.#retireRequest();
    this.#displayModesPending = false;
    this.#request = new AbortController();
    this.#generation += 1;
    return this.#generation;
  }

  #retireRequest(): void {
    this.#retirePermissionScope();
    this.#retireKeyboardTools(true);
    this.#retireSystemAction();
    this.#retireClipboardSyncScope();
    this.#retireHostMuteScope();
    this.#retirePrivacyScope();
    this.#retireClipboardOperation();
    this.#request.abort();
  }

  #retireDisplayModeOperation(): void {
    const operation = this.#displayModeOperation;
    this.#displayModeOperation = undefined;
    operation?.request.abort();
  }

  #beginViewerOccurrence(): void {
    this.#viewerOccurrence += 1;
    const sequenceBase = (this.#viewerOccurrence - 1) * INPUT_SEQUENCE_BLOCK;
    const releaseSequence = sequenceBase + INPUT_SEQUENCE_BLOCK - 1;
    if (!Number.isSafeInteger(releaseSequence)) {
      this.#endLease(true);
      this.#set({ ...this.#snapshot, status: "error", controlling: false, wantedControl: false,
        notice: "generic-error" });
      return;
    }
    this.#viewerSequenceBase = sequenceBase;
    this.#viewerSequenceLimit = releaseSequence - 1;
    this.#viewerReleaseSequence = releaseSequence;
    this.#retireViewerEpoch();
  }

  #retireViewerEpoch(): void {
    this.#channel.retire();
    this.#retireTouchpad(); this.#viewportConfigurationKey = undefined;
    this.#retireMouseControls(); this.#mouseConfigurationKey = undefined;
    this.#retireKeyboardTools(true);
    this.#retireSystemAction();
    this.#revokeNativeInputAuthority();
    this.#resetPresentation();
    this.#inputBatch = undefined; this.#inputPending = false;
    this.#nativeFrameReady = false; this.#nativePipPolicyKey = undefined;
    this.#frameMetricsAt = undefined; this.#frameMetricsBytes = 0;
    this.#viewerEpoch = undefined;
    this.#mediaAttempt = undefined;
    this.#offerOperation = undefined; this.#offerPending = false;
    this.#queuedOffer = undefined;
    this.#frameAwaitingPresentation = undefined;
    this.#viewerPipSupported = false;
    if (this.#snapshot.pipAvailable || this.#snapshot.network || this.#snapshot.restoreRequest) {
      this.#set({ ...this.#snapshot, pipAvailable: false, network: undefined, restoreRequest: undefined });
    }
  }

  async #resumeInteraction(): Promise<void> {
    const pending = this.#interactionRelease;
    if (pending !== undefined) await pending.catch(() => undefined);
    if (this.#disposed || this.#snapshot.exitStatus !== "idle" || this.#presentationState !== "idle"
      || !this.#interactive || !this.#foreground || !this.#online
      || !this.transport.isCurrent()) return;
    if (!this.#lease) {
      await this.#resume();
      return;
    }
    this.#beginViewerOccurrence();
    this.#sendInit();
    this.#startFrameLoop();
  }

  async #releaseInputForInteractionFence(
    host: DevicePeerDescriptor,
    lease: RemoteDesktopLease,
    generation: number,
    sequence: number
  ): Promise<void> {
    const release = create(RemoteDesktopInputEventSchema, {
      event: { case: "release", value: create(RemoteDesktopReleaseInputSchema, {}) }
    });
    try {
      await this.transport.input(host, lease.leaseId, BigInt(sequence), [release], this.#request.signal);
    } catch (error) {
      if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) return;
      try {
        const state = await this.transport.control(host, lease.leaseId, false, this.#request.signal);
        if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) return;
        if (!validControlGeneration(state.controlGeneration)) throw new Error("Invalid Remote Desktop control generation.");
        if (!this.#adoptControlGeneration(state.controlGeneration)) return;
        this.#set({ ...this.#snapshot, controlling: state.controlling,
          wantedControl: false, notice: state.controlling ? "input-unavailable" : this.#snapshot.notice });
      } catch (controlError) {
        if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) return;
        if (controlError instanceof MobileRemoteDesktopAuthorityError
          || error instanceof MobileRemoteDesktopAuthorityError) {
          this.authorityChanged();
          return;
        }
        this.#resumeEligible = false;
        this.#endLease(true);
        this.#scheduleReconnect();
      }
    }
  }

  #ready(generation: number): boolean {
    return !this.#disposed && this.#foreground && this.#online && !this.#request.signal.aborted
      && this.#snapshot.exitStatus === "idle" && generation === this.#generation && this.transport.isCurrent();
  }

  #adoptControlGeneration(value: bigint): boolean {
    // Heartbeat and control calls can complete out of order. Never let a stale
    // response reopen an older control authority for a later clipboard call.
    if (this.#controlGeneration !== 0n && value < this.#controlGeneration) return false;
    if (this.#controlGeneration !== 0n && value > this.#controlGeneration) {
      if (this.#keyboardScope || this.#snapshot.keyboardOpen || this.#mouseGrants.size > 0) {
        this.#emit({ type: "releaseInput" });
        this.#retireKeyboardTools(true);
      }
      this.#retireClipboardOperation();
      if (this.#systemActionOperation || this.#systemActionRetry) {
        this.#retireSystemAction();
        this.#set(this.#snapshot);
      }
    }
    this.#controlGeneration = value;
    this.#syncClipboard();
    return true;
  }

  #clipboardAvailable(capabilities: RemoteDesktopCapabilities): boolean {
    return this.clipboard !== undefined && (capabilities.clipboardText
      || (capabilities.clipboardContent && this.clipboard.richAvailable));
  }

  #stopTimers(): void {
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#heartbeatTimer = undefined;
    this.#retryTimer = undefined;
    this.#heartbeatPending = false;
    this.#stopFrameLoop();
  }

  #emit(message: MobileRemoteDesktopViewerCommand): void {
    if (message.type === "releaseInput" || message.type === "mode" || message.type === "init"
      || message.type === "stop" || (message.type === "control" && message.enabled !== true)) {
      this.#retireTouchpad();
      this.#retireMouseControls();
      this.#retireKeyboardTools(message.type === "init" || message.type === "stop" || message.type === "control");
    }
    if (message.type === "init") { this.#mouseConfigurationKey = undefined; this.#viewportConfigurationKey = undefined; }
    if (this.presentation?.nativeVideo) {
      const epoch = this.#viewerEpoch, attemptId = this.#mediaAttempt?.attemptId;
      if (message.type === "stop" || message.type === "resume") {
        this.#revokeNativeInputAuthority();
        if (epoch) this.#viewerSink({ type: message.type, epoch });
        return;
      }
      if (message.type === "presentation" || message.type === "videoSettings") {
        if (epoch && attemptId) this.#viewerSink({ ...message, epoch, attemptId });
        return;
      }
      if (message.type === "control" && message.enabled !== true) this.#revokeNativeInputAuthority();
    }
    this.#viewerSink(message);
    if (message.type === "init" || message.type === "control") { this.#syncViewport(); this.#syncMouseControls(); }
    if (message.type === "control" && message.enabled === true) this.#syncNativeInputAuthority();
  }

  #revokeNativeInputAuthority(): void {
    if (!this.presentation?.nativeVideo || !this.#viewerEpoch) return;
    if (this.#nativeInputGrantKey !== undefined) {
      this.#nativeInputGrantKey = undefined;
      this.#viewerSink({ type: "inputAuthority", epoch: this.#viewerEpoch, grant: null });
    }
  }

  #syncNativeInputAuthority(): void {
    const epoch = this.#viewerEpoch, attemptId = this.#mediaAttempt?.attemptId;
    if (!this.presentation?.nativeVideo || !epoch) return;
    if (!attemptId || !this.#nativeFrameReady || this.#snapshot.media !== "webrtc" || !this.#lease
      || !this.#snapshot.controlling || !validControlGeneration(this.#controlGeneration)
      || !this.#interactive || !this.#routeFocused || this.#presentationState !== "idle" || !this.#ready(this.#generation)) {
      this.#revokeNativeInputAuthority(); return;
    }
    const grant = { attemptId, controlGeneration: this.#controlGeneration.toString(),
      sequenceBase: this.#viewerSequenceBase, sequenceLimit: this.#viewerSequenceLimit };
    const key = `${epoch}/${attemptId}/${grant.controlGeneration}/${grant.sequenceBase}/${grant.sequenceLimit}`;
    if (this.#nativeInputGrantKey === key) return;
    this.#nativeInputGrantKey = key;
    this.#viewerSink({ type: "inputAuthority", epoch, grant });
  }

  #syncNativePipPolicy(): void {
    const epoch = this.#viewerEpoch, attemptId = this.#mediaAttempt?.attemptId;
    if (!this.presentation?.nativeVideo || !epoch || !attemptId) return;
    const context = this.#presentationTransition;
    const preparing = this.#presentationState === "requesting" && context?.acknowledged !== true;
    const authorized = context?.acknowledged === true && this.#presentationState !== "idle";
    const enabled = (this.#snapshot.backgroundViewing || context !== undefined) && this.#nativeFrameReady
      && this.#viewerPipSupported && this.#snapshot.media === "webrtc";
    const key = `${epoch}/${attemptId}/${enabled}/${preparing}/${authorized}`;
    if (this.#nativePipPolicyKey === key) return;
    this.#nativePipPolicyKey = key;
    this.#viewerSink({ type: "pipPolicy", epoch, attemptId, enabled, preparing, authorized });
  }

  #set(snapshot: MobileRemoteDesktopSnapshot): void {
    if (snapshot.status === "permission") this.#permissionBlocked = true;
    if (snapshot.capabilities !== this.#snapshot.capabilities && snapshot.capabilities?.permissions) {
      snapshot = { ...snapshot, permissions: projectPermissions(snapshot.capabilities.permissions) };
    }
    this.#snapshot = Object.freeze(snapshot);
    this.#syncPermissions();
    const systemAction = this.#systemActionOperation ?? this.#systemActionRetry;
    if (systemAction && !this.#systemActionCurrent(systemAction)) this.#retireSystemAction();
    if (this.#keyboardScope && !this.#keyboardScopeCurrent(this.#keyboardScope)) {
      this.#viewerSink({ type: "releaseInput" });
      this.#retireKeyboardTools(true);
    }
    this.#syncMouseControls(); this.#syncNativeInputAuthority(); this.#syncNativePipPolicy();
    for (const listener of this.#listeners) listener();
    this.#syncHostMute();
    this.#syncPrivacyScreen();
    this.#syncClipboard();
  }

  #clipboardSyncAvailable(): boolean {
    return this.#snapshot.capabilities?.clipboardSync === true && this.clipboard?.syncAvailable === true;
  }

  #clipboardSyncPreferenceCurrent(target: string, operation: number): boolean {
    return !this.#disposed && operation === this.#clipboardSyncPreferenceOperation
      && this.#hostMuteIdentity()?.targetDeviceId === target && this.transport.canStop();
  }

  async #loadClipboardSyncPreference(): Promise<void> {
    const identity = this.#hostMuteIdentity();
    if (!identity || !this.clipboardSyncPreferences || this.#disposed) return;
    const operation = ++this.#clipboardSyncPreferenceOperation;
    this.#set({ ...this.#snapshot, clipboardSyncLoaded: false, clipboardSyncSaving: true, clipboardSyncNotice: undefined });
    try {
      const enabled = await this.clipboardSyncPreferences.load(identity);
      if (!this.#clipboardSyncPreferenceCurrent(identity.targetDeviceId, operation)) return;
      this.#set({ ...this.#snapshot, clipboardSync: enabled, clipboardSyncLoaded: true,
        clipboardSyncSaving: false, clipboardSyncNotice: undefined });
    } catch {
      if (!this.#clipboardSyncPreferenceCurrent(identity.targetDeviceId, operation)) return;
      this.#set({ ...this.#snapshot, clipboardSyncSaving: false, clipboardSyncNotice: "load-failed" });
    }
  }

  #publishClipboardSyncInactive(): void {
    this.#snapshot = Object.freeze({ ...this.#snapshot, clipboardSyncActive: false });
    for (const listener of this.#listeners) listener();
  }

  #retireClipboardSyncScope(): void {
    const scope = this.#clipboardSyncScope;
    this.#clipboardSyncScope = undefined;
    if (!scope) return;
    scope.request.abort();
    if (scope.timer !== undefined) clearTimeout(scope.timer);
    const operation = this.#clipboardOperation;
    if (operation?.sync) {
      if (operation.timeout !== undefined) clearTimeout(operation.timeout);
      operation.timeout = undefined;
      operation.retired = true;
      operation.request.abort();
      this.#snapshot = Object.freeze({ ...this.#snapshot, clipboardBusy: false });
    }
    this.#publishClipboardSyncInactive();
    // Serialize disable behind its enable and before a new foreground loop.
    // A late cleanup cannot disable the replacement sync occurrence.
    this.#clipboardSyncTail = this.#clipboardSyncTail.catch(() => undefined).then(async () => {
      if (!this.transport.canStop()) return;
      await this.transport.setClipboardSync(scope.host, create(RemoteDesktopClipboardSyncRequestSchema, {
        leaseId: scope.leaseId, controlGeneration: scope.controlGeneration, enabled: false
      })).catch(() => undefined);
    });
  }

  #syncClipboard(): void {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const eligible = host && lease && this.#snapshot.status === "live" && this.#snapshot.controlling
      && this.#clipboardSyncAvailable() && this.#snapshot.clipboardSyncLoaded && this.#snapshot.clipboardSync
      && this.#interactive && this.#routeFocused && this.#presentationState === "idle"
      && !this.#displayModeOperation && this.#ready(this.#generation) && validControlGeneration(this.#controlGeneration);
    const key = eligible ? JSON.stringify([peerKey(host), lease.leaseId, this.#generation,
      this.#controlGeneration.toString(), this.#clipboardSyncAttempt]) : undefined;
    if (key === this.#clipboardSyncScope?.key) return;
    this.#retireClipboardSyncScope();
    if (!key || !host || !lease) return;
    const scope: ClipboardSyncScope = { key, host, leaseId: lease.leaseId, controlGeneration: this.#controlGeneration,
      generation: this.#generation, request: new AbortController(), running: false, failures: 0 };
    this.#clipboardSyncScope = scope;
    void this.#runClipboardSync(scope);
  }

  #clipboardSyncCurrent(scope: ClipboardSyncScope): boolean {
    return this.#clipboardSyncScope === scope && !scope.request.signal.aborted
      && this.#lease?.leaseId === scope.leaseId && this.#controlGeneration === scope.controlGeneration
      && this.#snapshot.controlling && this.#snapshot.clipboardSync && this.#snapshot.clipboardSyncLoaded
      && this.#interactive && this.#routeFocused && this.#presentationState === "idle"
      && !this.#displayModeOperation && this.#ready(scope.generation);
  }

  #scheduleClipboardSync(scope: ClipboardSyncScope, delay: number): void {
    if (!this.#clipboardSyncCurrent(scope)) return;
    if (scope.timer !== undefined) clearTimeout(scope.timer);
    scope.timer = setTimeout(() => { scope.timer = undefined; void this.#runClipboardSync(scope); }, delay);
  }

  async #runClipboardSync(scope: ClipboardSyncScope): Promise<void> {
    if (scope.running || !this.#clipboardSyncCurrent(scope)) return;
    if (this.#clipboardOperation) {
      this.#scheduleClipboardSync(scope, 1_500);
      return;
    }
    scope.running = true;
    const baseline = this.#clipboardSyncBaseline;
    let context: ClipboardContext | undefined;
    let delay: number | null = 1_500;
    try {
      if (scope.syncGeneration === undefined) {
        const enable = this.#clipboardSyncTail.catch(() => undefined).then(async () => {
          if (!this.#clipboardSyncCurrent(scope)) return;
          const result = await this.transport.setClipboardSync(scope.host, create(RemoteDesktopClipboardSyncRequestSchema, {
            leaseId: scope.leaseId, controlGeneration: scope.controlGeneration, enabled: true
          }), scope.request.signal);
          if (!this.#clipboardSyncCurrent(scope)) return;
          if (!result.enabled || !validControlGeneration(result.syncGeneration)) throw new ClipboardSyncError("unsupported");
          scope.syncGeneration = result.syncGeneration;
        });
        this.#clipboardSyncTail = enable.then(() => undefined, () => undefined);
        await enable;
      }
      if (!this.#clipboardSyncCurrent(scope) || scope.syncGeneration === undefined) return;
      context = this.#beginClipboardOperation(true);
      if (!context) return;
      const captured = context;
      const syncGeneration = scope.syncGeneration;
      const current = () => this.#clipboardSyncCurrent(scope) && this.#clipboardContextCurrent(captured);
      const check = () => {
        if (!current()) throw new ClipboardSyncError("expired");
        this.#markClipboardProgress(captured);
      };
      const call = async <T>(operation: () => Promise<T>): Promise<T> => {
        check();
        try {
          const result = await operation();
          check();
          return result;
        } catch (error) { throw mobileClipboardSyncError(error); }
      };
      const content = (action: RemoteDesktopClipboardContentRequest["action"], version?: string, inline = false) =>
        call(() => {
          if (action.case === "commit" || action.case === "paste") captured.operation.effectStarted = true;
          return this.transport.clipboardContent(scope.host, create(RemoteDesktopClipboardContentRequestSchema, {
          leaseId: scope.leaseId, controlGeneration: scope.controlGeneration, sync: true, syncGeneration,
          version, inline, action
          }), captured.operation.request.signal);
        });
      // A fresh adapter is bound to this tick's exact operation. The baseline,
      // including actual post-write digests, persists across ordinary pauses.
      scope.engine = new ClipboardSync({
        current, inline: this.#snapshot.capabilities?.clipboardInline === true, localReadCache: localClipboardReadCache,
        digest: json => {
          try {
            const item = parseMobileRemoteClipboardItem(json);
            return bytesToHex(sha256(utf8ToBytes(JSON.stringify([item.text, item.html, item.rtf, item.url, item.png]))));
          } catch (error) { throw mobileClipboardSyncError(error); }
        },
        localVersion: () => call(() => this.clipboard!.version(check)),
        readLocal: () => call(async () => serializeMobileRemoteClipboardItem(await this.clipboard!.readPortable(check))),
        writeLocal: (json, version) => call(() => {
          const item = parseMobileRemoteClipboardItem(json);
          captured.operation.effectStarted = true;
          return this.clipboard!.writeExpected(item, version, check);
        }),
        remote: {
          version: () => call(async () => (await this.transport.clipboardVersion(scope.host,
            create(RemoteDesktopClipboardVersionRequestSchema, { leaseId: scope.leaseId,
              controlGeneration: scope.controlGeneration, syncGeneration }), captured.operation.request.signal)).version),
          copy: async (version, inline) => {
            const result = await content({ case: "copy", value: create(RemoteDesktopClipboardContentCopyActionSchema, {}) }, version, inline);
            return { id: result.transferId, length: result.length ?? 0, data: result.data };
          },
          begin: async (length, version) => {
            const result = await content({ case: "begin", value: create(RemoteDesktopClipboardContentBeginActionSchema, { length }) }, version);
            if (!validTransferId(result.transferId)) throw new ClipboardSyncError("unsupported");
            return result.transferId!;
          },
          read: async (transferId, offset) => (await content({ case: "read",
            value: create(RemoteDesktopClipboardContentReadActionSchema, { transferId, offset }) })).data ?? "",
          write: async (transferId, offset, data) => { await content({ case: "write",
            value: create(RemoteDesktopClipboardContentWriteActionSchema, { transferId, offset, data }) }); },
          commit: async transferId => {
            const result = await content({ case: "commit", value: create(RemoteDesktopClipboardContentCommitActionSchema, { transferId }) });
            if (result.version === undefined) throw new ClipboardSyncError("unsupported");
            return result.version;
          },
          paste: async (data, version) => {
            const result = await content({ case: "paste", value: create(RemoteDesktopClipboardContentPasteActionSchema, { data }) }, version);
            if (result.version === undefined) throw new ClipboardSyncError("unsupported");
            return result.version;
          },
          cancel: async transferId => { await content({ case: "cancel", value: create(RemoteDesktopClipboardContentCancelActionSchema, { transferId }) }); }
        },
        trace: stage => {
          if (!current()) return;
          if (stage === "content-skipped") this.#set({ ...this.#snapshot, clipboardSyncNotice: "skipped" });
          else if (stage === "local-to-remote-complete" || stage === "remote-to-local-complete") {
            this.#set({ ...this.#snapshot, clipboardSyncNotice: undefined });
          }
        }
      }, baseline);
      await scope.engine.tick();
      if (!current()) return;
      scope.failures = 0;
      this.#set({ ...this.#snapshot, clipboardSyncActive: true,
        clipboardSyncNotice: this.#snapshot.clipboardSyncNotice === "failed"
          || this.#snapshot.clipboardSyncNotice === "permission" ? undefined : this.#snapshot.clipboardSyncNotice });
    } catch (error) {
      if (!this.#clipboardSyncCurrent(scope)) return;
      const failure = getClipboardSyncFailure(mobileClipboardSyncError(error), scope.failures++);
      if (failure.reason === "unavailable") scope.syncGeneration = undefined;
      delay = failure.delay;
      this.#set({ ...this.#snapshot, clipboardSyncActive: false, clipboardSyncNotice: failure.reason === "outcome-unknown" ? "unknown" : failure.notice });
    } finally {
      if (context) {
        if (context.operation.retired && context.operation.effectStarted && this.#clipboardSyncBaseline === baseline) {
          // Unknown native completion is reconciled by a new no-write baseline,
          // never by replaying the consumed commit or captured inline payload.
          this.#clipboardSyncBaseline = { local: "", remote: "" };
        }
        this.#settleClipboardOperation(context.operation, undefined);
      }
      scope.running = false;
      if (delay !== null) this.#scheduleClipboardSync(scope, delay);
    }
  }

  #hostMuteIdentity(): MobileRemoteDesktopHostMuteIdentity | undefined {
    const targetDeviceId = this.#snapshot.host?.route?.targetDeviceId;
    return targetDeviceId ? { ...this.transport.preferenceOwner, targetDeviceId } : undefined;
  }

  #privacyPreferenceCurrent(identity: MobileRemoteDesktopPrivacyIdentity, operation: number): boolean {
    return !this.#disposed && operation === this.#privacyPreferenceOperation &&
      this.#hostMuteIdentity()?.targetDeviceId === identity.targetDeviceId && this.transport.canStop();
  }

  async #loadPrivacyScreen(): Promise<void> {
    const identity = this.#hostMuteIdentity();
    if (!identity || !this.privacyPreferences || this.#disposed) return;
    const operation = ++this.#privacyPreferenceOperation;
    this.#set({ ...this.#snapshot, privacyScreenLoaded: false, privacyScreenPending: true, privacyScreenNotice: undefined });
    try {
      const enabled = await this.privacyPreferences.load(identity);
      if (!this.#privacyPreferenceCurrent(identity, operation)) return;
      this.#set({ ...this.#snapshot, privacyScreen: enabled, privacyScreenLoaded: true,
        privacyScreenPending: false, privacyScreenNotice: undefined });
    } catch {
      if (!this.#privacyPreferenceCurrent(identity, operation)) return;
      this.#set({ ...this.#snapshot, privacyScreenPending: false, privacyScreenNotice: "load-failed" });
    }
  }

  #retirePrivacyScope(): void {
    this.#privacyScope = undefined; this.#privacyOperation?.abort(); this.#privacyOperation = undefined;
    this.#privacyAttempt = undefined;
    if (this.#snapshot.privacyScreenActive || (this.#snapshot.privacyScreenPending && !this.#privacySaving && this.#snapshot.privacyScreenLoaded)) {
      this.#snapshot = Object.freeze({ ...this.#snapshot, privacyScreenActive: false, privacyScreenPending: this.#privacySaving });
      for (const listener of this.#listeners) listener();
    }
  }

  #syncPrivacyScreen(): void {
    const host = this.#snapshot.host, lease = this.#lease;
    const eligible = host && lease && this.#snapshot.status === "live" && this.#snapshot.controlling &&
      this.#snapshot.capabilities?.privacyScreen && this.#ready(this.#generation) && validControlGeneration(this.#controlGeneration);
    const key = eligible ? JSON.stringify([peerKey(host), lease.leaseId, this.#generation, this.#controlGeneration.toString()]) : undefined;
    if (key !== this.#privacyScope?.key) {
      this.#retirePrivacyScope();
      if (key && host && lease) this.#privacyScope = { key, host, leaseId: lease.leaseId, controlGeneration: this.#controlGeneration };
    }
    const scope = this.#privacyScope;
    if (!scope || !this.#snapshot.privacyScreenLoaded || this.#privacySaving) return;
    const enabled = this.#snapshot.privacyScreen;
    const lockOnExit = this.#snapshot.lockOnExitLoaded && this.#snapshot.lockOnExit;
    const attempt = `${scope.key}/${enabled}/${lockOnExit}`;
    if (this.#privacyAttempt === attempt) return;
    this.#privacyAttempt = attempt; this.#privacyOperation?.abort();
    const request = new AbortController(); this.#privacyOperation = request;
    this.#snapshot = Object.freeze({ ...this.#snapshot, privacyScreenActive: false, privacyScreenPending: true, privacyScreenNotice: undefined });
    for (const listener of this.#listeners) listener();
    const current = () => !request.signal.aborted && this.#privacyOperation === request && this.#privacyScope === scope &&
      this.#snapshot.privacyScreen === enabled && (this.#snapshot.lockOnExitLoaded && this.#snapshot.lockOnExit) === lockOnExit && this.#ready(this.#generation);
    this.#privacyTail = this.#privacyTail.catch(() => undefined).then(async () => {
      if (!current()) return;
      try {
        const result = await this.transport.setPrivacyScreen(scope.host, scope.leaseId, scope.controlGeneration, enabled, lockOnExit, request.signal);
        if (!current()) return;
        if (result.enabled !== enabled) throw new Error("Unexpected Remote Desktop privacy result.");
        this.#set({ ...this.#snapshot, privacyScreenActive: result.enabled, privacyScreenPending: false, privacyScreenNotice: undefined });
      } catch {
        if (!current()) return;
        this.#set({ ...this.#snapshot, privacyScreenActive: false, privacyScreenPending: false, privacyScreenNotice: "privacy-failed" });
      }
    });
  }

  #lockPreferenceCurrent(identity: MobileRemoteDesktopLockIdentity, operation: number): boolean {
    return !this.#disposed && operation === this.#lockPreferenceOperation
      && this.#hostMuteIdentity()?.targetDeviceId === identity.targetDeviceId && this.transport.canStop();
  }

  async #loadLockOnExit(): Promise<void> {
    const identity = this.#hostMuteIdentity();
    if (!identity || !this.lockPreferences || this.#disposed) return;
    const operation = ++this.#lockPreferenceOperation;
    this.#set({ ...this.#snapshot, lockOnExitLoaded: false, lockOnExitPending: true, lockOnExitNotice: undefined });
    try {
      const enabled = await this.lockPreferences.load(identity);
      if (!this.#lockPreferenceCurrent(identity, operation)) return;
      this.#set({ ...this.#snapshot, lockOnExit: enabled, lockOnExitLoaded: true,
        lockOnExitPending: false, lockOnExitNotice: undefined });
    } catch {
      if (!this.#lockPreferenceCurrent(identity, operation)) return;
      this.#set({ ...this.#snapshot, lockOnExitPending: false, lockOnExitNotice: "load-failed" });
    }
  }

  #hostMutePreferenceCurrent(identity: MobileRemoteDesktopHostMuteIdentity, operation: number): boolean {
    return !this.#disposed && operation === this.#hostMutePreferenceOperation
      && this.#hostMuteIdentity()?.targetDeviceId === identity.targetDeviceId && this.transport.canStop();
  }

  async #loadHostMute(): Promise<void> {
    const identity = this.#hostMuteIdentity();
    if (!identity || !this.hostMutePreferences || this.#disposed) return;
    const operation = ++this.#hostMutePreferenceOperation;
    this.#set({ ...this.#snapshot, hostMutePending: true, hostMuteLoaded: false, hostMuteNotice: undefined });
    try {
      const enabled = await this.hostMutePreferences.load(identity);
      if (!this.#hostMutePreferenceCurrent(identity, operation)) return;
      this.#set({ ...this.#snapshot, hostMute: enabled, hostMuteLoaded: true,
        hostMutePending: false, hostMuteNotice: undefined });
    } catch {
      if (!this.#hostMutePreferenceCurrent(identity, operation)) return;
      this.#set({ ...this.#snapshot, hostMutePending: false, hostMuteNotice: "load-failed" });
    }
  }

  #retireHostMuteScope(): void {
    const scope = this.#hostMuteScope;
    this.#hostMuteScope = undefined;
    this.#hostMuteOperation?.abort();
    this.#hostMuteOperation = undefined;
    this.#hostMuteAttempt = undefined;
    // Serialize restoration behind the retired apply so a hidden viewer cannot
    // leave a late enable request ahead of its matching restore request.
    if (scope && this.transport.canStop()) {
      this.#hostMuteTail = this.#hostMuteTail.catch(() => undefined).then(async () => {
        await this.transport.setHostMute(scope.host, scope.leaseId, scope.controlGeneration, false).catch(() => undefined);
      });
    }
    if (this.#snapshot.hostMuteActive || (this.#snapshot.hostMutePending && !this.#hostMuteSaving
      && this.#snapshot.hostMuteLoaded)) {
      this.#snapshot = Object.freeze({ ...this.#snapshot, hostMuteActive: false,
        hostMutePending: this.#hostMuteSaving || !this.#snapshot.hostMuteLoaded });
      for (const listener of this.#listeners) listener();
    }
  }

  #syncHostMute(): void {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const eligible = host && lease && this.#snapshot.status === "live" && this.#snapshot.controlling
      && this.#snapshot.capabilities?.hostMute && this.#interactive && this.#presentationState === "idle"
      && this.#ready(this.#generation) && validControlGeneration(this.#controlGeneration);
    const key = eligible ? JSON.stringify([peerKey(host), lease.leaseId, this.#generation,
      this.#controlGeneration.toString(), this.#hostMuteOccurrence]) : undefined;
    if (key !== this.#hostMuteScope?.key) {
      this.#retireHostMuteScope();
      if (key && host && lease) this.#hostMuteScope = { key, host, leaseId: lease.leaseId,
        controlGeneration: this.#controlGeneration };
    }
    const scope = this.#hostMuteScope;
    if (!scope || !this.#snapshot.hostMuteLoaded || this.#hostMuteSaving) return;
    const enabled = this.#snapshot.hostMute;
    const attempt = `${scope.key}/${enabled}`;
    if (this.#hostMuteAttempt === attempt) return;
    this.#hostMuteAttempt = attempt;
    this.#hostMuteOperation?.abort();
    const request = new AbortController();
    this.#hostMuteOperation = request;
    this.#snapshot = Object.freeze({ ...this.#snapshot, hostMutePending: true, hostMuteNotice: undefined });
    for (const listener of this.#listeners) listener();
    const current = () => !request.signal.aborted && this.#hostMuteOperation === request
      && this.#hostMuteScope === scope && this.#snapshot.hostMute === enabled
      && this.#interactive && this.#ready(this.#generation);
    this.#hostMuteTail = this.#hostMuteTail.catch(() => undefined).then(async () => {
      if (!current()) return;
      try {
        const result = await this.transport.setHostMute(scope.host, scope.leaseId,
          scope.controlGeneration, enabled, request.signal);
        if (!current()) return;
        if (result.enabled !== enabled) throw new Error("Unexpected Remote Desktop host mute result.");
        this.#set({ ...this.#snapshot, hostMuteActive: result.enabled, hostMutePending: false,
          hostMuteNotice: undefined });
      } catch {
        if (!current()) return;
        this.#set({ ...this.#snapshot, hostMuteActive: false, hostMutePending: false,
          hostMuteNotice: "apply-failed" });
      }
    });
  }
}

function mobileClipboardSyncError(error: unknown): ClipboardSyncError {
  if (error instanceof ClipboardSyncError) return error;
  if (error instanceof MobileRemoteClipboardError) {
    return new ClipboardSyncError(error.code === "too-long" ? "too-large"
      : error.code === "retired" ? "expired"
      : error.code === "failed" ? "write-failed" : error.code);
  }
  if (error instanceof MobileRemoteDesktopAuthorityError) return new ClipboardSyncError("expired");
  const detail = remoteDesktopFailure(error), reason = detail?.reason;
  if (error instanceof ConnectError && error.code === Code.Aborted && reason === RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE && detail?.retryable === false) {
    return new ClipboardSyncError("outcome-unknown");
  }
  return new ClipboardSyncError(reason === RemoteDesktopFailureReason.CLIPBOARD_EMPTY ? "empty"
    : reason === RemoteDesktopFailureReason.CLIPBOARD_UNSUPPORTED ? "unsupported"
    : reason === RemoteDesktopFailureReason.CLIPBOARD_TOO_LARGE ? "too-large"
    : reason === RemoteDesktopFailureReason.CLIPBOARD_CHANGED ? "changed"
    : reason === RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE
      || reason === RemoteDesktopFailureReason.CLIPBOARD_EXPIRED ? "unavailable"
    : reason === RemoteDesktopFailureReason.AUTHORITY_CHANGED || reason === RemoteDesktopFailureReason.LEASE_EXPIRED
      || reason === RemoteDesktopFailureReason.STOPPED || reason === RemoteDesktopFailureReason.VIEW_ONLY ? "expired"
    : "unknown");
}

type ViewerMessage =
  | { readonly type: "channelReply"; readonly epoch: string; readonly attemptId: string; readonly reply: NonNullable<ReturnType<typeof parseRemoteDesktopChannelReply>> }
  | { readonly type: "channelUnavailable"; readonly epoch: string; readonly attemptId: string; readonly id: string }
  | { readonly type: "ready" }
  | { readonly type: "pipCapability"; readonly epoch: string; readonly supported: boolean }
  | { readonly type: "presentation"; readonly epoch: string; readonly active: boolean }
  | { readonly type: "presentationFailed"; readonly epoch: string }
  | { readonly type: "streaming" | "reconnecting"; readonly epoch: string; readonly attemptId: string }
  | { readonly type: "fallback"; readonly epoch: string; readonly attemptId: string | null; readonly capturePending?: boolean }
  | { readonly type: "framePresented"; readonly epoch: string; readonly frameId: string; readonly presented: boolean }
  | { readonly type: "inputOverflow"; readonly epoch: string }
  | { readonly type: "iceConfig"; readonly epoch: string; readonly attemptId: string }
  | { readonly type: "offer"; readonly epoch: string; readonly attemptId: string; readonly sdp: string }
  | { readonly type: "ice"; readonly epoch: string; readonly attemptId: string; readonly candidates: readonly RemoteDesktopIceCandidate[];
      readonly after: number; readonly exchangeId: number }
  | { readonly type: "input"; readonly epoch: string; readonly sequence: number; readonly events: unknown };

function channelGeneration(value: unknown): bigint {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("REMOTE_DESKTOP_REQUEST_FAILED");
  return BigInt(value as number);
}
function channelEnabled(value: unknown): boolean {
  if (!isRecord(value) || typeof value.enabled !== "boolean") throw new Error("REMOTE_DESKTOP_REQUEST_FAILED");
  return value.enabled;
}
function channelControlState(value: unknown): RemoteDesktopControlState {
  if (!isRecord(value) || typeof value.controlling !== "boolean") throw new Error("REMOTE_DESKTOP_REQUEST_FAILED");
  return create(RemoteDesktopControlStateSchema, { controlling: value.controlling, controlGeneration: channelGeneration(value.controlGeneration) });
}

function parseViewerMessage(raw: unknown): ViewerMessage | undefined {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > 100_000) return undefined;
    try { value = JSON.parse(raw); } catch { return undefined; }
  }
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "ready") return { type: "ready" };
  if (typeof value.epoch !== "string" || value.epoch.length < 1 || value.epoch.length > 256) return undefined;
  if (value.type === "pipCapability" && typeof value.supported === "boolean") {
    return { type: "pipCapability", epoch: value.epoch, supported: value.supported };
  }
  if (value.type === "presentation" && typeof value.active === "boolean") {
    return { type: "presentation", epoch: value.epoch, active: value.active };
  }
  if (value.type === "presentationFailed") return { type: "presentationFailed", epoch: value.epoch };
  if (value.type === "inputOverflow") return { type: "inputOverflow", epoch: value.epoch };
  if (value.type === "framePresented" && typeof value.frameId === "string"
    && value.frameId.length >= 1 && value.frameId.length <= 512 && typeof value.presented === "boolean") {
    return { type: "framePresented", epoch: value.epoch, frameId: value.frameId, presented: value.presented };
  }
  if (value.type === "input" && Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0) {
    return { type: "input", epoch: value.epoch, sequence: value.sequence as number, events: value.events };
  }
  if (value.type === "fallback" && value.attemptId === null) {
    return { type: "fallback", epoch: value.epoch, attemptId: null };
  }
  if (typeof value.attemptId !== "string" || !ATTEMPT.test(value.attemptId)) return undefined;
  if (value.type === "channelReply") {
    const reply = parseRemoteDesktopChannelReply(value.reply);
    if (reply) return { type: "channelReply", epoch: value.epoch, attemptId: value.attemptId, reply };
  }
  if (value.type === "channelUnavailable" && isRemoteDesktopChannelId(value.id)) return { type: "channelUnavailable", epoch: value.epoch, attemptId: value.attemptId, id: value.id };
  if (value.type === "streaming" || value.type === "reconnecting" || value.type === "fallback") {
    return { type: value.type, epoch: value.epoch, attemptId: value.attemptId,
      ...(value.type === "fallback" && value.reason === "capture-pending" ? { capturePending: true } : {}) };
  }
  if (value.type === "iceConfig") return { type: "iceConfig", epoch: value.epoch, attemptId: value.attemptId as string };
  if (value.type === "offer" && typeof value.sdp === "string" && value.sdp.length > 0 && value.sdp.length <= 64_000) {
    return { type: "offer", epoch: value.epoch, attemptId: value.attemptId as string, sdp: value.sdp };
  }
  if (value.type === "ice" && Number.isSafeInteger(value.after) && (value.after as number) >= 0
    && (value.after as number) <= 128 && Number.isSafeInteger(value.exchangeId)
    && (value.exchangeId as number) >= 0 && Array.isArray(value.candidates) && value.candidates.length <= 16) {
    const candidates = value.candidates.map(parseIceCandidate);
    if (candidates.every((candidate) => candidate !== undefined)) return {
      type: "ice", epoch: value.epoch, attemptId: value.attemptId as string,
      candidates: candidates as readonly RemoteDesktopIceCandidate[], after: value.after as number,
      exchangeId: value.exchangeId as number
    };
  }
  return undefined;
}

function parseIceCandidate(value: unknown): RemoteDesktopIceCandidate | undefined {
  if (!isRecord(value) || typeof value.candidate !== "string" || !value.candidate.startsWith("candidate:")
    || value.candidate.length > 2_048 || !(value.sdpMid === null || value.sdpMid === undefined
      || typeof value.sdpMid === "string") || !(value.sdpMLineIndex === null || value.sdpMLineIndex === undefined
      || (Number.isInteger(value.sdpMLineIndex) && (value.sdpMLineIndex as number) >= 0
        && (value.sdpMLineIndex as number) < 32))
    || ((value.sdpMid === null || value.sdpMid === undefined)
      && (value.sdpMLineIndex === null || value.sdpMLineIndex === undefined))) return undefined;
  return {
    $typeName: "joko.v1.RemoteDesktopIceCandidate",
    candidate: value.candidate,
    ...(typeof value.sdpMid === "string" ? { sdpMid: value.sdpMid.slice(0, 128) } : {}),
    ...(typeof value.sdpMLineIndex === "number" ? { sdpMLineIndex: value.sdpMLineIndex } : {}),
    ...(typeof value.usernameFragment === "string" && value.usernameFragment.length <= 256
      ? { usernameFragment: value.usernameFragment } : {})
  };
}

function validMouseControl(value: unknown): value is MobileRemoteDesktopMouseControl {
  return value === "left" || value === "right" || value === "wheel";
}

function parseInputEvents(value: unknown): readonly RemoteDesktopInputEvent[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64 || JSON.stringify(value).length > 16_384) return undefined;
  const events: RemoteDesktopInputEvent[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.kind !== "string") return undefined;
    if (item.kind === "move" && unit(item.x) && unit(item.y)) events.push(create(RemoteDesktopInputEventSchema, {
      event: { case: "move", value: create(RemoteDesktopPointerMoveInputSchema, { x: item.x, y: item.y }) }
    }));
    else if (item.kind === "button" && unit(item.x) && unit(item.y) && typeof item.down === "boolean"
      && (item.button === 0 || item.button === 1 || item.button === 2)) events.push(create(RemoteDesktopInputEventSchema, {
      event: { case: "button", value: create(RemoteDesktopPointerButtonInputSchema, {
        button: item.button === 0 ? RemoteDesktopMouseButton.LEFT
          : item.button === 1 ? RemoteDesktopMouseButton.MIDDLE : RemoteDesktopMouseButton.RIGHT,
        down: item.down, x: item.x, y: item.y
      }) }
    }));
    else if (item.kind === "scroll" && delta(item.dx) && delta(item.dy)) events.push(create(RemoteDesktopInputEventSchema, {
      event: { case: "scroll", value: create(RemoteDesktopScrollInputSchema, { deltaX: item.dx, deltaY: item.dy }) }
    }));
    else if (item.kind === "key" && typeof item.code === "string" && KEY_CODES.has(item.code)
      && typeof item.down === "boolean") events.push(create(RemoteDesktopInputEventSchema, {
      event: { case: "key", value: create(RemoteDesktopKeyInputSchema, { code: item.code, down: item.down }) }
    }));
    else if (item.kind === "text" && typeof item.text === "string" && item.text.length > 0
      && item.text.length <= 4_096) events.push(create(RemoteDesktopInputEventSchema, {
      event: { case: "text", value: create(RemoteDesktopTextInputSchema, { text: item.text }) }
    }));
    else if (item.kind === "release" && Object.keys(item).length === 1) events.push(create(RemoteDesktopInputEventSchema, {
      event: { case: "release", value: create(RemoteDesktopReleaseInputSchema, {}) }
    }));
    else return undefined;
  }
  return Object.freeze(events);
}

function validRemoteDesktopCursor(cursor: RemoteDesktopCursor): boolean {
  const png = cursor.png;
  return typeof cursor.visible === "boolean"
    && [cursor.x, cursor.y, cursor.width, cursor.height, cursor.hotX, cursor.hotY].every(Number.isFinite)
    && unit(cursor.x) && unit(cursor.y)
    && cursor.width > 0 && cursor.width <= 256 && cursor.height > 0 && cursor.height <= 256
    && cursor.hotX >= 0 && cursor.hotX <= cursor.width && cursor.hotY >= 0 && cursor.hotY <= cursor.height
    && png instanceof Uint8Array && png.length >= 33 && png.length <= 49_152
    && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47
    && png[4] === 0x0d && png[5] === 0x0a && png[6] === 0x1a && png[7] === 0x0a
    && png[8] === 0 && png[9] === 0 && png[10] === 0 && png[11] === 13
    && png[12] === 0x49 && png[13] === 0x48 && png[14] === 0x44 && png[15] === 0x52
    && pngDimension(png, 16) >= 1 && pngDimension(png, 16) <= 512
    && pngDimension(png, 20) >= 1 && pngDimension(png, 20) <= 512;
}

function pngDimension(png: Uint8Array, offset: number): number {
  return png[offset]! * 0x1000000 + png[offset + 1]! * 0x10000 + png[offset + 2]! * 0x100 + png[offset + 3]!;
}

function viewerCursor(cursor: RemoteDesktopCursor): Readonly<Record<string, unknown>> {
  return Object.freeze({
    visible: cursor.visible,
    x: cursor.x,
    y: cursor.y,
    width: cursor.width,
    height: cursor.height,
    hotX: cursor.hotX,
    hotY: cursor.hotY,
    png: encodeBase64(cursor.png)
  });
}

function validDisplayModes(modes: readonly RemoteDesktopDisplayMode[]): boolean {
  return modes.length >= 1 && modes.length <= 256
    && modes.filter((mode) => mode.current).length === 1
    && new Set(modes.map((mode) => mode.modeId)).size === modes.length
    && modes.every((mode) => REMOTE_DESKTOP_MODE_ID.test(mode.modeId)
      && Number.isInteger(mode.width) && mode.width >= 1 && mode.width <= 32_768
      && Number.isInteger(mode.height) && mode.height >= 1 && mode.height <= 32_768
      && typeof mode.current === "boolean" && typeof mode.native === "boolean");
}

function validCapabilities(value: RemoteDesktopCapabilities): boolean {
  return value.protocolVersion === 1 && value.displays.length > 0 && value.displays.length <= 32
    && (value.platform === "darwin" || value.platform === "win32" || value.platform === "linux")
    && typeof value.displayModes === "boolean" && typeof value.cursorOverlay === "boolean"
    && typeof value.resolutionRestore === "boolean"
    && typeof value.lockOnExit === "boolean"
    && typeof value.workspaceNavigation === "boolean" && typeof value.systemMenu === "boolean"
    && (!(value.workspaceNavigation || value.systemMenu) || value.platform === "linux")
    && (!value.lockOnExit || value.platform !== "win32")
    && typeof value.viewerDisplay === "boolean" && typeof value.viewerDisplayRestore === "boolean"
    && (!value.viewerDisplay && !value.viewerDisplayRestore || value.platform === "linux" || value.platform === "darwin")
    && (!value.viewerDisplayRestore || value.viewerDisplay)
    && (value.platform !== "win32" || !value.displayModes)
    && (!value.resolutionRestore || value.platform !== "win32" && value.displayModes)
    && (value.webrtcVideo || value.jpegFallback)
    && value.displays.every((display) => Boolean(display.displayId) && display.width > 0 && display.height > 0
      && display.width <= 32_768 && display.height <= 32_768)
    && new Set(value.displays.map((display) => display.displayId)).size === value.displays.length;
}

function validViewerDisplayGeometry(display: RemoteDesktopDisplay, requested: { readonly width: number; readonly height: number }, platform: string): boolean {
  if (platform === "linux") return display.width === requested.width && display.height === requested.height;
  return platform === "darwin"
    && [display.width, display.height].every(size => Number.isSafeInteger(size) && size >= 1 && size <= 4_096)
    && Math.abs(display.width * requested.height - display.height * requested.width) <= Math.max(requested.width, requested.height);
}

function viewerDisplaySize(width: number, height: number): { readonly width: number; readonly height: number } | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  const scale = 1_920 / Math.max(width, height);
  const size = { width: Math.round(width * scale / 2) * 2, height: Math.round(height * scale / 2) * 2 };
  return [size.width, size.height].every(value => Number.isSafeInteger(value) && value >= 320 && value <= 2_560) ? size : undefined;
}

function screenPermissionReady(permissions: RemoteDesktopPermissions | undefined): boolean {
  return permissions?.screenRecording === RemoteDesktopPermissionStatus.GRANTED
    || permissions?.screenRecording === RemoteDesktopPermissionStatus.NOT_REQUIRED;
}

function projectPermissions(permissions: RemoteDesktopPermissions): RemoteDesktopPermissions {
  const status = (value: RemoteDesktopPermissionStatus): RemoteDesktopPermissionStatus =>
    value === RemoteDesktopPermissionStatus.GRANTED || value === RemoteDesktopPermissionStatus.NOT_REQUIRED
      || value === RemoteDesktopPermissionStatus.MISSING ? value : RemoteDesktopPermissionStatus.UNKNOWN;
  return Object.freeze({ $typeName: "joko.v1.RemoteDesktopPermissions" as const,
    screenRecording: status(permissions.screenRecording), accessibility: status(permissions.accessibility) });
}

function validIceServers(raw: readonly RemoteDesktopIceServer[], now = Date.now()) {
  if (raw.length === 0 || raw.length > 4) return PUBLIC_STUN;
  const result = raw.map((server) => {
    if (server.urls.length < 1 || server.urls.length > 4
      || server.urls.some((url) => !/^(?:stun|turn|turns):[^\s]{1,500}$/u.test(url))) {
      throw new Error("INVALID_ICE_CONFIG");
    }
    const turn = server.urls.some((url) => /^turns?:/u.test(url));
    if (!turn) {
      if (server.username !== undefined || server.credential !== undefined) throw new Error("INVALID_ICE_CONFIG");
      return Object.freeze({ urls: Object.freeze([...server.urls]) });
    }
    const expiresAt = server.expiresAt === undefined
      ? Number.NaN : Number(server.expiresAt.seconds) * 1_000 + Math.floor(server.expiresAt.nanos / 1_000_000);
    if (!server.username || !server.credential || server.username.length > 256 || server.credential.length > 256
      || expiresAt <= now + 120_000 || expiresAt > now + 86_400_000) throw new Error("INVALID_ICE_CONFIG");
    return Object.freeze({ urls: Object.freeze([...server.urls]), username: server.username, credential: server.credential });
  });
  return Object.freeze(result);
}

function remoteDesktopFailure(error: unknown) {
  return error instanceof ConnectError ? error.findDetails(RemoteDesktopFailureSchema)[0] : undefined;
}

function controlFailureNotice(reason: RemoteDesktopFailureReason): MobileRemoteDesktopNotice {
  return reason === RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED
    ? "accessibility-permission"
    : reason === RemoteDesktopFailureReason.INPUT_BUSY ? "input-busy"
      : reason === RemoteDesktopFailureReason.VIEW_ONLY ? "view-only" : "input-unavailable";
}

function displayModeFailureKeepsLease(reason: RemoteDesktopFailureReason | undefined): boolean {
  return reason === RemoteDesktopFailureReason.DISPLAY_MODES_UNAVAILABLE
    || reason === RemoteDesktopFailureReason.DISPLAY_MODE_MISSING
    || reason === RemoteDesktopFailureReason.DISPLAY_BUSY
    || reason === RemoteDesktopFailureReason.VIEW_ONLY;
}

function peerKey(host: DevicePeerDescriptor | undefined): string | undefined {
  const route = host?.route;
  return route ? JSON.stringify([route.targetDeviceId, route.relationId,
    route.targetDeviceRevision?.value.toString(), route.targetDeviceRevision?.etag,
    route.relationRevision?.value.toString(), route.relationRevision?.etag,
    route.routeGeneration.toString()]) : undefined;
}

function validControlGeneration(value: bigint): boolean {
  return value >= 1n && value <= 18_446_744_073_709_551_615n;
}

function validTransferId(value: string | undefined): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

function sameVideoSettings(
  left: MobileRemoteDesktopVideoSettings,
  right: MobileRemoteDesktopVideoSettings
): boolean {
  return left.fps === right.fps && left.quality === right.quality && left.audio === right.audio;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === "function") return btoa(binary);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < binary.length; index += 3) {
    const one = binary.charCodeAt(index);
    const two = index + 1 < binary.length ? binary.charCodeAt(index + 1) : Number.NaN;
    const three = index + 2 < binary.length ? binary.charCodeAt(index + 2) : Number.NaN;
    const bits = (one << 16) | ((Number.isNaN(two) ? 0 : two) << 8) | (Number.isNaN(three) ? 0 : three);
    output += alphabet[(bits >> 18) & 63] + alphabet[(bits >> 12) & 63]
      + (Number.isNaN(two) ? "=" : alphabet[(bits >> 6) & 63]) + (Number.isNaN(three) ? "=" : alphabet[bits & 63]);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function delta(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 2_000;
}

export const mobileRemoteDesktopTesting = Object.freeze({
  parseViewerMessage,
  parseInputEvents,
  validRemoteDesktopCursor,
  validDisplayModes,
  validCapabilities,
  viewerDisplaySize,
  displayModeFailureKeepsLease,
  validIceServers,
  peerKey
});
