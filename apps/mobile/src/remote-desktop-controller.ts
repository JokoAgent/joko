import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import {
  RemoteDesktopFailureReason,
  RemoteDesktopFailureSchema,
  RemoteDesktopClipboardContentBeginActionSchema,
  RemoteDesktopClipboardContentCancelActionSchema,
  RemoteDesktopClipboardContentCommitActionSchema,
  RemoteDesktopClipboardContentCopyActionSchema,
  RemoteDesktopClipboardContentReadActionSchema,
  RemoteDesktopClipboardContentRequestSchema,
  RemoteDesktopClipboardContentWriteActionSchema,
  RemoteDesktopClipboardTextCopyActionSchema,
  RemoteDesktopClipboardTextPasteActionSchema,
  RemoteDesktopClipboardTextRequestSchema,
  RemoteDesktopInputEventSchema,
  RemoteDesktopKeyInputSchema,
  RemoteDesktopMouseButton,
  RemoteDesktopPermissionStatus,
  RemoteDesktopPointerButtonInputSchema,
  RemoteDesktopPointerMoveInputSchema,
  RemoteDesktopReleaseInputSchema,
  RemoteDesktopScrollInputSchema,
  RemoteDesktopStartMode,
  RemoteDesktopTextInputSchema,
  RemoteDesktopVideoSettingsSchema,
  type DevicePeerDescriptor,
  type RemoteDesktopCapabilities,
  type RemoteDesktopClipboardContentRequest,
  type RemoteDesktopClipboardContentResult,
  type RemoteDesktopClipboardTextRequest,
  type RemoteDesktopClipboardTextResult,
  type RemoteDesktopControlState,
  type RemoteDesktopFrameResult,
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

export const MOBILE_REMOTE_DESKTOP_HEARTBEAT_MS = 3_000;
export const MOBILE_REMOTE_DESKTOP_FRAME_MS = 250;
export const MOBILE_REMOTE_DESKTOP_LEASE_MS = 12_000;

export type MobileRemoteDesktopStatus =
  | "loading" | "select-host" | "select-display" | "connecting" | "live"
  | "reconnecting" | "offline" | "unsupported" | "permission" | "revoked"
  | "busy" | "stopped" | "error";

export type MobileRemoteDesktopInputMode = "touch" | "trackpad" | "pan";

export type MobileRemoteDesktopNotice =
  | "no-hosts" | "unavailable" | "screen-permission" | "screen-permission-guide"
  | "authority-changed" | "compatibility" | "input-overflow" | "view-only"
  | "accessibility-permission" | "input-busy" | "input-unavailable"
  | "busy" | "stopped" | "viewer-restarted" | "audio-unavailable"
  | "video-settings-failed" | "pip-unavailable" | "generic-error";

export type MobileRemoteDesktopClipboardNotice =
  | "copied" | "pasted" | "empty" | "unsupported" | "too-large"
  | "unavailable" | "busy" | "failed";

export interface MobileRemoteDesktopSnapshot {
  readonly status: MobileRemoteDesktopStatus;
  readonly hosts: readonly DevicePeerDescriptor[];
  readonly host?: DevicePeerDescriptor;
  readonly capabilities?: RemoteDesktopCapabilities;
  readonly selectedDisplayId?: string;
  readonly controlling: boolean;
  readonly wantedControl: boolean;
  readonly inputMode: MobileRemoteDesktopInputMode;
  readonly media: "none" | "webrtc" | "jpeg";
  readonly hasFrame: boolean;
  readonly takeoverAvailable: boolean;
  readonly clipboardAvailable: boolean;
  readonly clipboardBusy: boolean;
  readonly clipboardNotice?: MobileRemoteDesktopClipboardNotice;
  readonly videoSettings: MobileRemoteDesktopVideoSettings;
  readonly videoSettingsBusy: boolean;
  readonly pipAvailable: boolean;
  readonly presenting: boolean;
  readonly notice?: MobileRemoteDesktopNotice;
}

export interface MobileRemoteDesktopPresentation {
  readonly nativePictureInPicture: boolean;
  readonly requiresPlaybackSession: boolean;
  playback(enabled: boolean): Promise<void>;
}

export interface MobileRemoteDesktopTransport {
  readonly ownerKey: string;
  isCurrent(): boolean;
  canStop(): boolean;
  listHosts(signal?: AbortSignal): Promise<readonly DevicePeerDescriptor[]>;
  capabilities(host: DevicePeerDescriptor, signal?: AbortSignal): Promise<RemoteDesktopCapabilities>;
  permissions(host: DevicePeerDescriptor, signal?: AbortSignal): Promise<RemoteDesktopPermissions>;
  showPermissionGuide(host: DevicePeerDescriptor, signal?: AbortSignal): Promise<RemoteDesktopPermissions>;
  start(host: DevicePeerDescriptor, displayId: string, mode: RemoteDesktopStartMode,
    signal?: AbortSignal): Promise<RemoteDesktopLease>;
  heartbeat(host: DevicePeerDescriptor, leaseId: string, signal?: AbortSignal): Promise<RemoteDesktopControlState>;
  stop(host: DevicePeerDescriptor, leaseId: string, signal?: AbortSignal): Promise<void>;
  control(host: DevicePeerDescriptor, leaseId: string, enabled: boolean,
    signal?: AbortSignal): Promise<RemoteDesktopControlState>;
  presentation(host: DevicePeerDescriptor, leaseId: string, enabled: boolean,
    signal?: AbortSignal): Promise<RemoteDesktopControlState>;
  input(host: DevicePeerDescriptor, leaseId: string, sequence: bigint,
    events: readonly RemoteDesktopInputEvent[], signal?: AbortSignal): Promise<void>;
  iceConfiguration(host: DevicePeerDescriptor, leaseId: string,
    signal?: AbortSignal): Promise<readonly RemoteDesktopIceServer[]>;
  offer(host: DevicePeerDescriptor, leaseId: string, attemptId: string, sdp: string,
    settings: RemoteDesktopVideoSettings | undefined,
    signal?: AbortSignal): Promise<RemoteDesktopOfferResult>;
  ice(host: DevicePeerDescriptor, leaseId: string, attemptId: string,
    candidates: readonly RemoteDesktopIceCandidate[], after: number,
    signal?: AbortSignal): Promise<RemoteDesktopIceExchangeResult>;
  frame(host: DevicePeerDescriptor, leaseId: string, signal?: AbortSignal): Promise<RemoteDesktopFrameResult>;
  clipboardText(host: DevicePeerDescriptor, request: RemoteDesktopClipboardTextRequest,
    signal?: AbortSignal): Promise<RemoteDesktopClipboardTextResult>;
  clipboardContent(host: DevicePeerDescriptor, request: RemoteDesktopClipboardContentRequest,
    signal?: AbortSignal): Promise<RemoteDesktopClipboardContentResult>;
}

export class MobileRemoteDesktopAuthorityError extends Error {
  constructor() { super("The Remote Desktop authority is no longer current."); }
}

export type MobileRemoteDesktopViewerCommand = Readonly<Record<string, unknown>>;

interface ClipboardOperation {
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

const initialSnapshot = (): MobileRemoteDesktopSnapshot => Object.freeze({
  status: "loading",
  hosts: Object.freeze([]),
  controlling: false,
  wantedControl: false,
  inputMode: "touch",
  media: "none",
  hasFrame: false,
  takeoverAvailable: false,
  clipboardAvailable: false,
  clipboardBusy: false,
  videoSettings: MOBILE_REMOTE_DESKTOP_DEFAULT_VIDEO_SETTINGS,
  videoSettingsBusy: false,
  pipAvailable: false,
  presenting: false
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
  #frameAwaitingPresentation?: { readonly epoch: string; readonly frameId: string };
  #frameSequence = 0;
  #heartbeatPending = false;
  #inputPending = false;
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
  #settingsApplying = false;
  #pendingSettingsReconnect = false;
  #offerPending = false;
  #queuedOffer?: { readonly epoch: string; readonly attemptId: string; readonly sdp: string };
  #viewerPipSupported = false;
  #viewerSink: (message: MobileRemoteDesktopViewerCommand) => void = () => undefined;

  constructor(
    readonly transport: MobileRemoteDesktopTransport,
    private readonly preferredDeviceId?: string,
    private readonly clipboard?: MobileRemoteClipboardSystem,
    private readonly presentation?: MobileRemoteDesktopPresentation
  ) {}

  get snapshot(): MobileRemoteDesktopSnapshot { return this.#snapshot; }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setViewerSink(sink: (message: MobileRemoteDesktopViewerCommand) => void): void {
    this.#viewerSink = sink;
  }

  async open(): Promise<void> {
    const generation = this.#newRequest();
    this.#resumeEligible = false;
    this.#set({ ...initialSnapshot(), status: this.#online ? "loading" : "offline" });
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
    if (!this.#snapshot.hosts.some((candidate) => peerKey(candidate) === peerKey(host))) return;
    const generation = this.#newRequest();
    this.#lease = undefined;
    this.#resumeEligible = false;
    this.#set({ ...this.#snapshot, host, capabilities: undefined, selectedDisplayId: undefined,
      status: "loading", controlling: false, wantedControl: false, media: "none",
      takeoverAvailable: false, clipboardAvailable: false, clipboardBusy: false,
      clipboardNotice: undefined, notice: undefined });
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
      if (capabilities.displays.length === 1) await this.#start(RemoteDesktopStartMode.NEW, generation);
    } catch (error) {
      if (this.#ready(generation)) this.#handleFailure(error, "capabilities");
    }
  }

  async selectDisplay(displayId: string): Promise<void> {
    if (!this.#snapshot.capabilities?.displays.some((display) => display.displayId === displayId)) return;
    const generation = this.#newRequest();
    this.#resumeEligible = false;
    this.#set({ ...this.#snapshot, selectedDisplayId: displayId, status: "connecting", notice: undefined });
    await this.#start(RemoteDesktopStartMode.NEW, generation);
  }

  async takeover(): Promise<void> {
    const generation = this.#newRequest();
    this.#set({ ...this.#snapshot, status: "connecting", takeoverAvailable: false, notice: undefined });
    await this.#start(RemoteDesktopStartMode.TAKEOVER, generation);
  }

  async retry(): Promise<void> {
    this.#retryIndex = 0;
    if (this.#snapshot.host === undefined) return this.open();
    if (this.#snapshot.status === "permission") return this.refreshPermissions();
    const generation = this.#newRequest();
    this.#set({ ...this.#snapshot, status: "connecting", notice: undefined });
    await this.#start(this.#resumeEligible ? RemoteDesktopStartMode.RESUME : RemoteDesktopStartMode.NEW, generation);
  }

  async refreshPermissions(showGuide = false): Promise<void> {
    const host = this.#snapshot.host;
    if (!host) return;
    const generation = this.#newRequest();
    this.#set({ ...this.#snapshot, status: "loading", notice: undefined });
    try {
      const permissions = showGuide
        ? await this.transport.showPermissionGuide(host, this.#request.signal)
        : await this.transport.permissions(host, this.#request.signal);
      if (!this.#ready(generation)) return;
      if (!screenPermissionReady(permissions)) {
        this.#set({ ...this.#snapshot, status: "permission",
          notice: "screen-permission-guide" });
        return;
      }
      await this.selectHost(host);
    } catch (error) {
      if (this.#ready(generation)) this.#handleFailure(error, "permissions");
    }
  }

  async setControl(enabled: boolean): Promise<void> {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    if (!host || !lease || !this.#ready(this.#generation)) return;
    if (enabled && !this.#snapshot.capabilities?.canControl) {
      this.#releaseControl("view-only");
      return;
    }
    const generation = this.#generation;
    this.#set({ ...this.#snapshot, wantedControl: enabled });
    try {
      const state = await this.transport.control(host, lease.leaseId, enabled, this.#request.signal);
      if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) return;
      if (!validControlGeneration(state.controlGeneration)) throw new Error("Invalid Remote Desktop control generation.");
      if (!this.#adoptControlGeneration(state.controlGeneration)) return;
      this.#set({ ...this.#snapshot, controlling: state.controlling,
        wantedControl: enabled && state.controlling, notice: undefined });
      this.#emit({ type: "control", enabled: state.controlling });
      if (!state.controlling) this.#emit({ type: "releaseInput" });
    } catch (error) {
      if (this.#ready(generation)) this.#handleFailure(error, "control");
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

  async startPictureInPicture(): Promise<void> {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const generation = this.#generation;
    if (!host || !lease || this.#presentationState !== "idle" || this.#settingsApplying
      || !this.#snapshot.pipAvailable || !this.#snapshot.capabilities?.backgroundViewing
      || !this.presentation?.nativePictureInPicture || this.#snapshot.media !== "webrtc"
      || !this.#snapshot.hasFrame || !this.#interactive || !this.#ready(generation)) return;
    this.#settingsApplying = true;
    this.#set({ ...this.#snapshot, videoSettingsBusy: true, notice: undefined });
    try {
      await this.#setPlayback(true);
    } catch {
      // Native playback is prepared before changing host authority. Failure is
      // therefore known-not-dispatched: retain the lease and control, mute this
      // occurrence, and let the viewer negotiate the degraded settings.
      this.#audioUnavailable = true;
      this.#settingsApplying = false;
      this.#pendingSettingsReconnect = true;
      this.#set({ ...this.#snapshot, videoSettingsBusy: false, notice: "audio-unavailable" });
      void this.#setPlayback(false).catch(() => undefined);
      void this.#flushVideoSettings();
      return;
    }
    let dispatched = false;
    try {
      if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) {
        await this.#setPlayback(false).catch(() => undefined);
        return;
      }
      dispatched = true;
      const state = await this.transport.presentation(host, lease.leaseId, true, this.#request.signal);
      if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) {
        await this.#setPlayback(false).catch(() => undefined);
        if (this.#lease?.leaseId === lease.leaseId) this.#endLease(true);
        return;
      }
      if (!validControlGeneration(state.controlGeneration) || state.controlling) {
        throw new Error("Invalid Remote Desktop presentation state.");
      }
      if (!this.#adoptControlGeneration(state.controlGeneration)) {
        throw new Error("Stale Remote Desktop presentation state.");
      }
      this.#retireClipboardOperation();
      this.#presentationState = "requesting";
      this.#set({ ...this.#snapshot, controlling: false, wantedControl: false,
        presenting: false, videoSettingsBusy: false, pipAvailable: false });
      this.#emit({ type: "control", enabled: false });
      this.#emit({ type: "releaseInput" });
      this.#emit({ type: "presentation", enabled: true });
      this.#presentationTimer = setTimeout(() => {
        if (this.#presentationState !== "requesting") return;
        void this.#presentationFailed();
      }, 4_000);
    } catch {
      if (!this.#lease || this.#lease.leaseId !== lease.leaseId) return;
      this.#presentationState = "idle";
      this.#set({ ...this.#snapshot, presenting: false, videoSettingsBusy: false,
        notice: "pip-unavailable" });
      void this.#setPlayback(false).catch(() => undefined);
      if (dispatched) {
        // A lost response has an unknown host-side control transition. Retire
        // this lease rather than presenting stale local control authority.
        this.#resumeEligible = false;
        this.#endLease(true);
        if (this.#foreground && this.#online && this.#interactive) this.#scheduleReconnect();
      }
    } finally {
      this.#settingsApplying = false;
    }
  }

  setInputMode(mode: MobileRemoteDesktopInputMode): void {
    this.#set({ ...this.#snapshot, inputMode: mode });
    this.#emit({ type: "mode", mode });
  }

  showKeyboard(): void { this.#emit({ type: "keyboard", enabled: this.#snapshot.controlling }); }
  releaseInput(): void { this.#emit({ type: "releaseInput" }); }
  fit(): void { this.#emit({ type: "fit" }); }
  click(button: 0 | 1 | 2): void {
    if (!this.#snapshot.controlling) return;
    this.#emit({ type: "click", button });
  }

  copyToPhone(): Promise<void> { return this.#transferClipboard("copy"); }
  pasteFromPhone(): Promise<void> { return this.#transferClipboard("paste"); }

  setForeground(foreground: boolean): void {
    if (this.#foreground === foreground || this.#disposed) return;
    this.#foreground = foreground;
    if (!foreground) {
      if (this.#presentationState === "active") this.#suspendPresentation();
      else this.#pause("reconnecting", true);
    } else if (this.#online && this.#interactive) {
      if (this.#presentationState === "active") void this.#finishPresentation();
      else void this.#resume();
    }
  }

  setInteractive(interactive: boolean): void {
    if (this.#interactive === interactive || this.#disposed) return;
    this.#interactive = interactive;
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
    if (this.#foreground && this.#online) {
      if (this.#presentationState === "active") void this.#finishPresentation();
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
    this.#pause("revoked", true);
    this.#set({ ...this.#snapshot, status: "revoked", notice: "authority-changed" });
  }

  viewerMessage(raw: unknown): void {
    const message = parseViewerMessage(raw);
    if (!message || this.#disposed) return;
    if (message.type === "ready") {
      this.#viewerReady = true;
      if (this.#interactive) {
        this.#beginViewerOccurrence();
        this.#sendInit();
      }
      return;
    }
    if (message.epoch !== this.#viewerEpoch) return;
    if (message.type === "pipCapability") {
      this.#viewerPipSupported = message.supported;
      this.#refreshPipAvailability();
      return;
    }
    if (message.type === "presentation") {
      if (message.active) {
        if (this.#presentationState !== "requesting") {
          this.#emit({ type: "presentation", enabled: false });
          return;
        }
        this.#clearPresentationTimer();
        this.#presentationState = "active";
        this.#set({ ...this.#snapshot, presenting: true, controlling: false, wantedControl: false });
      } else if (this.#presentationState !== "idle") {
        void this.#finishPresentation();
      }
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
      this.#set({ ...this.#snapshot, status: "live", media: "webrtc", hasFrame: true,
        videoSettingsBusy: false, notice: this.#audioUnavailable ? "audio-unavailable" : undefined });
      this.#refreshPipAvailability();
      if (settingsApplied || this.#pendingSettingsReconnect) void this.#flushVideoSettings();
      return;
    }
    if (message.type === "reconnecting") {
      if (!this.#mediaAttemptCurrent(message.attemptId)) return;
      this.#startFrameLoop();
      this.#set({ ...this.#snapshot, status: "reconnecting", media: "jpeg" });
      return;
    }
    if (message.type === "fallback") {
      if (message.attemptId !== null && !this.#mediaAttemptCurrent(message.attemptId)) return;
      if (message.attemptId === null && this.#snapshot.capabilities?.webrtcVideo !== false) return;
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
      if (message.presented) this.#set({ ...this.#snapshot, hasFrame: true });
      return;
    }
    if (message.type === "inputOverflow") {
      this.#releaseControl("input-overflow");
      void this.setControl(false);
      return;
    }
    if (message.type === "iceConfig") {
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
    this.#retireViewerEpoch();
    this.#viewerPipSupported = false;
    if (this.#presentationState !== "idle") {
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
      if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) return;
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
    if (this.#disposed) return;
    this.#disposed = true;
    const host = this.#snapshot.host;
    const lease = this.#lease;
    this.#retireRequest();
    this.#stopTimers();
    this.#resetPresentation();
    this.#emit({ type: "stop", preserveFrame: false });
    this.#viewerReady = false;
    this.#retireViewerEpoch();
    this.#lease = undefined;
    this.#controlGeneration = 0n;
    this.#resumeEligible = false;
    await this.#setPlayback(false).catch(() => undefined);
    if (host && lease && this.transport.canStop()) {
      await this.transport.stop(host, lease.leaseId).catch(() => undefined);
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

  #beginClipboardOperation(): ClipboardContext | undefined {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    if (this.#clipboardOperation) {
      this.#set({ ...this.#snapshot, clipboardNotice: "busy" });
      return undefined;
    }
    if (!this.clipboard || !host || !lease
      || !this.#snapshot.clipboardAvailable || !this.#snapshot.controlling
      || !validControlGeneration(this.#controlGeneration) || !this.#interactive
      || !this.#ready(this.#generation)) return undefined;
    const request = new AbortController();
    const ownerSignal = this.#request.signal;
    const retire = () => request.abort();
    ownerSignal.addEventListener("abort", retire, { once: true });
    const sequence = ++this.#clipboardSequence;
    const operation = {
      sequence,
      request,
      ownerSignal,
      deadline: 0,
      retired: false,
      retire
    };
    this.#clipboardOperation = operation;
    this.#refreshClipboardIdle(operation);
    this.#set({ ...this.#snapshot, clipboardBusy: true, clipboardNotice: undefined });
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
      this.#set({ ...this.#snapshot, clipboardBusy: false, clipboardNotice: "failed" });
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
      this.#set({ ...this.#snapshot, clipboardBusy: false, clipboardNotice: notice ?? "failed" });
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

  async #start(
    mode: RemoteDesktopStartMode,
    generation: number,
    allowExpiredFreshFallback = mode === RemoteDesktopStartMode.RESUME
  ): Promise<void> {
    const host = this.#snapshot.host;
    const displayId = this.#snapshot.selectedDisplayId;
    if (!host || !displayId || !this.#ready(generation)) return;
    try {
      const lease = await this.transport.start(host, displayId, mode, this.#request.signal);
      if (!this.#ready(generation) || peerKey(this.#snapshot.host) !== peerKey(host)
        || this.#snapshot.selectedDisplayId !== displayId) {
        if (this.transport.canStop()) void this.transport.stop(host, lease.leaseId).catch(() => undefined);
        return;
      }
      if (!validControlGeneration(lease.controlGeneration)) {
        if (this.transport.canStop()) void this.transport.stop(host, lease.leaseId).catch(() => undefined);
        throw new Error("Invalid Remote Desktop control generation.");
      }
      this.#lease = lease;
      this.#controlGeneration = lease.controlGeneration;
      this.#resumeEligible = true;
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
        wantedControl: lease.controlling, media: "none", hasFrame: false,
        takeoverAvailable: false, videoSettingsBusy: false, pipAvailable: false,
        presenting: false, notice: this.#audioUnavailable ? "audio-unavailable" : undefined });
      this.#startHeartbeat();
      this.#sendInit();
      this.#startFrameLoop();
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
    if (this.#heartbeatPending || this.#presentationState !== "idle"
      || !host || !lease || !this.#ready(generation)) return;
    this.#heartbeatPending = true;
    try {
      const state = await this.transport.heartbeat(host, lease.leaseId, this.#request.signal);
      if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) return;
      if (!validControlGeneration(state.controlGeneration)) throw new Error("Invalid Remote Desktop control generation.");
      if (!this.#adoptControlGeneration(state.controlGeneration)) return;
      if (state.controlling !== this.#snapshot.controlling) {
        this.#set({ ...this.#snapshot, controlling: state.controlling,
          wantedControl: state.controlling && this.#snapshot.wantedControl });
        this.#emit({ type: "control", enabled: state.controlling });
        if (!state.controlling) this.#emit({ type: "releaseInput" });
      }
    } catch (error) {
      if (this.#ready(generation)) this.#handleFailure(error, "heartbeat");
    } finally { this.#heartbeatPending = false; }
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
    this.#framePending = false;
    this.#frameAwaitingPresentation = undefined;
  }

  async #frame(): Promise<void> {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const generation = this.#generation;
    if (this.#framePending || this.#frameAwaitingPresentation !== undefined || !host || !lease
      || !this.#ready(generation) || !this.#interactive || this.#viewerEpoch === undefined
      || this.#snapshot.media === "webrtc") return;
    this.#framePending = true;
    try {
      const result = await this.transport.frame(host, lease.leaseId, this.#request.signal);
      if (!this.#ready(generation) || this.#lease?.leaseId !== lease.leaseId) return;
      const jpeg = result.frame?.jpeg;
      const epoch = this.#viewerEpoch;
      if (jpeg?.length && epoch !== undefined) {
        const frameId = `${epoch}:${++this.#frameSequence}`;
        this.#frameAwaitingPresentation = Object.freeze({ epoch, frameId });
        this.#emit({ type: "frame", epoch, frameId, jpeg: encodeBase64(jpeg) });
      }
    } catch (error) {
      if (this.#ready(generation)) this.#handleFailure(error, "frame");
    } finally {
      this.#framePending = false;
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
      bitrate: this.#snapshot.videoSettings.bitrate,
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
      && this.#snapshot.hasFrame && !this.#settingsApplying;
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
    await this.#finishPresentation("pip-unavailable");
  }

  async #finishPresentation(notice?: MobileRemoteDesktopNotice): Promise<void> {
    if (this.#presentationState === "idle") return;
    const host = this.#snapshot.host;
    const lease = this.#lease;
    const generation = this.#generation;
    this.#presentationState = "idle";
    this.#clearPresentationTimer();
    this.#emit({ type: "presentation", enabled: false });
    this.#set({ ...this.#snapshot, presenting: false, pipAvailable: false,
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
    try {
      const answer = await this.transport.offer(context.host, context.lease.leaseId, attemptId, sdp,
        this.#negotiatedSettings(), this.#request.signal);
      if (!this.#mediaCurrent(context) || answer.attemptId !== attemptId) return;
      this.#emit({ type: "answer", epoch: this.#viewerEpoch, attemptId, sdp: answer.answerSdp });
    } catch (error) {
      if (!this.#mediaCurrent(context)) return;
      const failure = remoteDesktopFailure(error);
      if (failure?.reason === RemoteDesktopFailureReason.AUDIO_UNAVAILABLE
        && this.#negotiatedAudio()) {
        this.#audioUnavailable = true;
        this.#settingsApplying = true;
        this.#set({ ...this.#snapshot, videoSettingsBusy: true, notice: "audio-unavailable" });
        void this.#setPlayback(false).catch(() => undefined);
        this.#emit({ type: "videoSettings", audio: false });
      } else {
        this.#emit({ type: "fallback", epoch: this.#viewerEpoch, attemptId, retry: true });
      }
    } finally {
      this.#offerPending = false;
      const queued = this.#queuedOffer;
      this.#queuedOffer = undefined;
      if (queued && queued.epoch === this.#viewerEpoch) void this.#offer(queued.attemptId, queued.sdp);
      else if (this.#pendingSettingsReconnect && !this.#settingsApplying) void this.#flushVideoSettings();
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
        candidates: result.candidates, next: result.next, complete: result.complete });
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
    if (!events || this.#inputPending || !host || !lease || !this.#snapshot.controlling
      || !this.#interactive || !this.#ready(generation)) return;
    this.#inputPending = true;
    try {
      await this.transport.input(host, lease.leaseId, BigInt(sequence), events, this.#request.signal);
      if (this.#ready(generation) && this.#lease?.leaseId === lease.leaseId) {
        this.#emit({ type: "ack", epoch: this.#viewerEpoch, sequence });
      }
    } catch (error) {
      if (this.#ready(generation)) this.#handleFailure(error, "input");
    } finally {
      this.#inputPending = false;
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
      audio: this.#negotiatedAudio(),
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
    if (operation === "control" || operation === "input") {
      if (failure?.reason === RemoteDesktopFailureReason.INPUT_BUSY
        || failure?.reason === RemoteDesktopFailureReason.INPUT_UNAVAILABLE
        || failure?.reason === RemoteDesktopFailureReason.VIEW_ONLY
        || failure?.reason === RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED) {
        this.#releaseControl(controlFailureNotice(failure.reason));
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

  #scheduleReconnect(): void {
    if (this.#retryTimer !== undefined || !this.#foreground || !this.#interactive
      || !this.#online || this.#disposed || this.#presentationState !== "idle") return;
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#stopFrameLoop();
    this.#set({ ...this.#snapshot, status: "reconnecting", controlling: false, wantedControl: false, media: "jpeg" });
    this.#emit({ type: "control", enabled: false });
    this.#emit({ type: "releaseInput" });
    const delay = RETRY_MS[Math.min(this.#retryIndex, RETRY_MS.length - 1)]!;
    this.#retryIndex = Math.min(this.#retryIndex + 1, RETRY_MS.length);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#resume();
    }, delay);
  }

  async #resume(): Promise<void> {
    if (this.#disposed || !this.#foreground || !this.#interactive
      || !this.#online || !this.transport.isCurrent()) return;
    const host = this.#snapshot.host;
    const displayId = this.#snapshot.selectedDisplayId;
    if (!host || !displayId) return this.open();
    const generation = this.#newRequest();
    this.#set({ ...this.#snapshot, status: "reconnecting", controlling: false, wantedControl: false, notice: undefined });
    await this.#start(this.#resumeEligible ? RemoteDesktopStartMode.RESUME : RemoteDesktopStartMode.NEW, generation);
  }

  #pause(status: "offline" | "reconnecting" | "revoked", stop: boolean): void {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    this.#retireRequest();
    this.#stopTimers();
    this.#resetPresentation();
    void this.#setPlayback(false).catch(() => undefined);
    this.#lease = undefined;
    this.#controlGeneration = 0n;
    this.#resumeEligible = !stop && lease !== undefined;
    this.#settingsApplying = false;
    this.#pendingSettingsReconnect = false;
    this.#offerPending = false;
    this.#queuedOffer = undefined;
    this.#emit({ type: "control", enabled: false });
    this.#emit({ type: "releaseInput" });
    this.#emit({ type: "stop", preserveFrame: true });
    this.#retireViewerEpoch();
    this.#set({ ...this.#snapshot, status, controlling: false, wantedControl: false, media: "none",
      videoSettingsBusy: false, pipAvailable: false, presenting: false });
    if (stop && host && lease && this.transport.canStop()) void this.transport.stop(host, lease.leaseId).catch(() => undefined);
  }

  #endLease(stop: boolean): void {
    const host = this.#snapshot.host;
    const lease = this.#lease;
    this.#retireRequest();
    this.#generation += 1;
    this.#stopTimers();
    this.#resetPresentation();
    void this.#setPlayback(false).catch(() => undefined);
    this.#lease = undefined;
    this.#controlGeneration = 0n;
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
    if (stop && host && lease && this.transport.canStop()) void this.transport.stop(host, lease.leaseId).catch(() => undefined);
  }

  #newRequest(): number {
    this.#retireRequest();
    this.#request = new AbortController();
    this.#generation += 1;
    return this.#generation;
  }

  #retireRequest(): void {
    this.#retireClipboardOperation();
    this.#request.abort();
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
    this.#viewerEpoch = undefined;
    this.#mediaAttempt = undefined;
    this.#queuedOffer = undefined;
    this.#frameAwaitingPresentation = undefined;
    this.#viewerPipSupported = false;
    if (this.#snapshot.pipAvailable) this.#set({ ...this.#snapshot, pipAvailable: false });
  }

  async #resumeInteraction(): Promise<void> {
    const pending = this.#interactionRelease;
    if (pending !== undefined) await pending.catch(() => undefined);
    if (this.#disposed || this.#presentationState !== "idle"
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
      && generation === this.#generation && this.transport.isCurrent();
  }

  #adoptControlGeneration(value: bigint): boolean {
    // Heartbeat and control calls can complete out of order. Never let a stale
    // response reopen an older control authority for a later clipboard call.
    if (this.#controlGeneration !== 0n && value < this.#controlGeneration) return false;
    if (this.#controlGeneration !== 0n && value > this.#controlGeneration) {
      this.#retireClipboardOperation();
    }
    this.#controlGeneration = value;
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

  #emit(message: MobileRemoteDesktopViewerCommand): void { this.#viewerSink(message); }

  #set(snapshot: MobileRemoteDesktopSnapshot): void {
    this.#snapshot = Object.freeze(snapshot);
    for (const listener of this.#listeners) listener();
  }
}

type ViewerMessage =
  | { readonly type: "ready" }
  | { readonly type: "pipCapability"; readonly epoch: string; readonly supported: boolean }
  | { readonly type: "presentation"; readonly epoch: string; readonly active: boolean }
  | { readonly type: "presentationFailed"; readonly epoch: string }
  | { readonly type: "streaming" | "reconnecting"; readonly epoch: string; readonly attemptId: string }
  | { readonly type: "fallback"; readonly epoch: string; readonly attemptId: string | null }
  | { readonly type: "framePresented"; readonly epoch: string; readonly frameId: string; readonly presented: boolean }
  | { readonly type: "inputOverflow"; readonly epoch: string }
  | { readonly type: "iceConfig"; readonly epoch: string; readonly attemptId: string }
  | { readonly type: "offer"; readonly epoch: string; readonly attemptId: string; readonly sdp: string }
  | { readonly type: "ice"; readonly epoch: string; readonly attemptId: string; readonly candidates: readonly RemoteDesktopIceCandidate[];
      readonly after: number; readonly exchangeId: number }
  | { readonly type: "input"; readonly epoch: string; readonly sequence: number; readonly events: unknown };

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
  if (value.type === "fallback" && value.attemptId === null) {
    return { type: "fallback", epoch: value.epoch, attemptId: null };
  }
  if (typeof value.attemptId !== "string" || !ATTEMPT.test(value.attemptId)) return undefined;
  if (value.type === "streaming" || value.type === "reconnecting" || value.type === "fallback") {
    return { type: value.type, epoch: value.epoch, attemptId: value.attemptId };
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
  if (value.type === "input" && Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0) {
    return { type: "input", epoch: value.epoch, sequence: value.sequence as number, events: value.events };
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

function validCapabilities(value: RemoteDesktopCapabilities): boolean {
  return value.protocolVersion === 1 && value.displays.length > 0 && value.displays.length <= 32
    && (value.webrtcVideo || value.jpegFallback)
    && value.displays.every((display) => Boolean(display.displayId) && display.width > 0 && display.height > 0
      && display.width <= 32_768 && display.height <= 32_768)
    && new Set(value.displays.map((display) => display.displayId)).size === value.displays.length;
}

function screenPermissionReady(permissions: RemoteDesktopPermissions | undefined): boolean {
  return permissions?.screenRecording === RemoteDesktopPermissionStatus.GRANTED
    || permissions?.screenRecording === RemoteDesktopPermissionStatus.NOT_REQUIRED;
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
  return left.fps === right.fps && left.bitrate === right.bitrate && left.audio === right.audio;
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
  validIceServers,
  peerKey
});
