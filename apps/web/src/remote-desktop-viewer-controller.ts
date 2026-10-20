import { create } from "@bufbuild/protobuf";
import { base64Encode } from "@bufbuild/protobuf/wire";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  RemoteDesktopStartMode, RemoteDesktopVideoQuality, RemoteDesktopMouseButton, RemoteDesktopInputEventSchema,
  RemoteDesktopFailureReason as Failure, RemoteDesktopFailureSchema,
  type RemoteDesktopCapabilities, type RemoteDesktopLease, type RemoteDesktopDisplayMode,
  type RemoteDesktopVideoSettings, type DesktopRemoteDesktopViewerApi, type DesktopRemoteDesktopViewerState,
  type DesktopRemoteDesktopViewerCredentialAction, type DesktopRemoteDesktopViewerCredentialState,
  type DesktopRemoteDesktopViewerCredentialNotice
} from "@joko/contracts";
import { createDesktopRemoteDesktopViewerClient } from "./remote-desktop-viewer-bridge.js";
import { mountRemoteDesktopViewer } from "./remote-desktop-viewer-runtime.js";

const KEYS = [ ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((key) => `Key${key}`),
  ..."0123456789".split("").map((key) => `Digit${key}`), ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  "Enter", "Escape", "Tab", "Space", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ControlLeft", "AltLeft", "MetaLeft",
  "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash" ];
const NETWORK = { iceConfigMs: 10000, iceConfigBridgeMs: 500, maxCandidates: 128, batchSize: 16, pollMs: 250,
  exchangeMs: 30000, disconnectedMs: 5000, answerMs: 32000, connectMs: 15000, gatherMs: 5000,
  stableMs: 30000, retryMs: [1000, 3000, 8000] };

export interface DesktopViewerSnapshot {
  readonly target: DesktopRemoteDesktopViewerState["target"] | undefined;
  readonly locale: DesktopRemoteDesktopViewerState["locale"];
  readonly status: "connecting" | "capture-pending" | "live" | "reconnecting" | "inactive" | "error" | "stopped";
  readonly error?: "busy" | "permission" | "revoked" | "disabled" | "unsupported" | "connection" | "clipboard" | "display" | "preferences";
  readonly caps?: RemoteDesktopCapabilities;
  readonly lease?: RemoteDesktopLease;
  readonly sourceDisplayId?: string;
  readonly ready: boolean;
  readonly controlling: boolean;
  readonly controlPending: boolean;
  readonly media: "video" | "direct" | "relay" | "screenshots" | "none";
  readonly latency?: number;
  readonly receiveRate?: number;
  readonly scaleMode: "fit" | "actual" | "custom";
  readonly settings: Pick<RemoteDesktopVideoSettings, "fps" | "quality" | "audio">;
  readonly modes: readonly RemoteDesktopDisplayMode[];
  readonly modeNotice?: "change-failed" | "restore-unavailable";
  readonly settingsBusy: boolean;
  readonly viewerDisplayFitted: boolean;
  readonly clipboardBusy: boolean;
  readonly audioPending: boolean;
  readonly hostMuteDesired: boolean;
  readonly hostMuteActive: boolean;
  readonly hostMutePending: boolean;
  readonly hostMuteNotice?: "save" | "effect";
  readonly privacyScreenDesired: boolean;
  readonly privacyScreenActive: boolean;
  readonly privacyScreenPending: boolean;
  readonly privacyScreenNotice?: "save" | "effect";
  readonly lockOnExit: boolean;
  readonly lockOnExitPending: boolean;
  readonly lockOnExitNotice?: "save";
  readonly clipboardSyncDesired: boolean;
  readonly clipboardSyncAvailable: boolean;
  readonly clipboardSyncActive: boolean;
  readonly clipboardSyncPending: boolean;
  readonly clipboardSyncSaving: boolean;
  readonly clipboardSyncNotice?: "save" | "permission" | "conflict" | "temporary" | "skipped" | "unknown";
  readonly closeNotice?: "lock" | "disconnect";
  readonly closing: boolean;
  readonly credential?: DesktopRemoteDesktopViewerCredentialState;
  readonly credentialBusy: boolean;
  readonly credentialNotice?: Exclude<DesktopRemoteDesktopViewerCredentialNotice, "cancelled">;
}

export class DesktopRemoteDesktopViewerController {
  #snapshot: DesktopViewerSnapshot = { target: undefined, locale: "en", status: "connecting", ready: false,
    controlling: false, controlPending: false, media: "none", scaleMode: "fit",
    settings: { fps: 30, quality: RemoteDesktopVideoQuality.AUTO, audio: true }, modes: [], settingsBusy: false, viewerDisplayFitted: false,
    clipboardBusy: false, audioPending: false, hostMuteDesired: false, hostMuteActive: false, hostMutePending: false,
    privacyScreenDesired: false, privacyScreenActive: false, privacyScreenPending: false,
    lockOnExit: false, lockOnExitPending: false, clipboardSyncDesired: false, clipboardSyncAvailable: false,
    clipboardSyncActive: false, clipboardSyncPending: false, clipboardSyncSaving: false, closing: false, credentialBusy: false };
  #scope?: DesktopRemoteDesktopViewerState;
  #epoch = 0;
  #abort = new AbortController();
  #disposed = false;
  #client?: ReturnType<typeof createDesktopRemoteDesktopViewerClient>;
  #runtime: ReturnType<typeof mountRemoteDesktopViewer>;
  #timers: ReturnType<typeof setInterval>[];
  #off: () => void;
  #attempt?: string;
  #framePending = false;
  #awaitingFrame = false;
  #heartbeatPending = false;
  #sequenceBase = 0;
  #opening = false;
  #lastControlRequest = 0;
  #connectionDeadline?: ReturnType<typeof setTimeout>;
  #runtimeControl = false;
  #retryTimer?: ReturnType<typeof setTimeout>;
  #retryDelay = 1000;
  #readyGeneration = -1;
  #runtimeEpoch?: string;
  #offerPending?: Promise<void>;
  #restartMedia = false;
  #hostMuteAuthority?: string;
  #hostMuteOperation = 0;
  #hostMuteAttempted = false;
  #hostMuteSaving = false;
  #hostMuteSaveRetry?: boolean;
  #privacyAuthority?: string;
  #privacyOperation = 0;
  #privacyAttempt?: string;
  #privacySaving = false;
  #privacySaveRetry?: boolean;
  #lockOnExitSaveRetry?: boolean;
  #clipboardSyncSaving = false;
  #clipboardSyncSaveRetry?: boolean;
  #unlockAttempted = false;
  #modePending = false;
  #sourceDisplayId?: string;
  #geometryUnknown = false;
  #wantedControl = false;
  #initialControlPending = false;
  readonly #onWindowFocus = (): void => {
    void this.acquireInitialControl(); this.syncControl(); this.syncHostMute();
  };
  #credentialRetry?: { readonly action: DesktopRemoteDesktopViewerCredentialAction; readonly enabled?: boolean };
  constructor(private readonly api: DesktopRemoteDesktopViewerApi, private readonly root: HTMLElement,
    private readonly changed: (snapshot: DesktopViewerSnapshot) => void) {
    this.#runtime = mountRemoteDesktopViewer(root, (message) => this.message(message),
      { desktop: true, net: NETWORK, iceServers: [], keyCodes: KEYS });
    this.#off = api.onState((scope) => this.scope(scope));
    void api.state().then((scope) => {
      if (this.#disposed) return;
      this.scope(scope);
    }).catch(() => { if (this.#scope === undefined) this.publish({ status: "error", error: "connection" }); });
    this.#timers = [setInterval(() => void this.heartbeat(), 3000), setInterval(() => void this.frame(), 350)];
    window.addEventListener("focus", this.#onWindowFocus);
  }
  get snapshot(): DesktopViewerSnapshot { return this.#snapshot; }
  private publish(patch: Partial<DesktopViewerSnapshot>): void {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...patch }; this.changed(this.#snapshot);
  }
  private scope(scope: DesktopRemoteDesktopViewerState): void {
    if (this.#disposed || scope.generation < (this.#scope?.generation ?? -1)) return;
    const previous = this.#scope;
    this.#scope = scope;
    if (this.#readyGeneration !== scope.generation) {
      this.#readyGeneration = scope.generation;
      void Promise.resolve().then(() => this.#disposed || this.#scope?.generation !== scope.generation
        ? undefined : this.api.ready(scope.generation)).catch(() => undefined);
    }
    this.publish({ target: scope.target, locale: scope.locale });
    if (previous?.generation === scope.generation && previous.active === scope.active) {
      this.acceptClipboardSync(scope);
      if (this.#snapshot.settings.audio !== scope.audio) this.applySettings({ audio: scope.audio });
      if (this.#snapshot.hostMuteDesired !== scope.hostMute) {
        this.publish({ hostMuteDesired: scope.hostMute });
        if (!this.#hostMuteSaving) { this.#hostMuteAttempted = false; this.syncHostMute(); }
      }
      if (this.#snapshot.lockOnExit !== scope.lockOnExit) { this.publish({ lockOnExit: scope.lockOnExit }); this.syncPrivacyScreen(); }
      if (this.#snapshot.privacyScreenDesired !== scope.privacyScreen) {
        this.publish({ privacyScreenDesired: scope.privacyScreen });
        if (!this.#privacySaving) this.syncPrivacyScreen();
      }
      return;
    }
    this.cancel();
    this.#client = scope.target === null ? undefined : createDesktopRemoteDesktopViewerClient(this.api, scope.generation);
    this.#unlockAttempted = false; this.#credentialRetry = undefined;
    this.publish({ status: scope.active ? "connecting" : "inactive", error: undefined,
      caps: undefined, lease: undefined, ready: false, controlling: false, controlPending: false,
      media: "none", modes: [], modeNotice: undefined, settings: { ...this.#snapshot.settings, audio: scope.audio },
      settingsBusy: false, clipboardBusy: false, audioPending: false, lockOnExit: scope.lockOnExit,
      credential: undefined, credentialBusy: false, credentialNotice: undefined,
      lockOnExitPending: false, lockOnExitNotice: undefined, closeNotice: undefined, closing: false });
    this.publish({ hostMuteDesired: scope.hostMute, hostMuteActive: false, hostMutePending: false, hostMuteNotice: undefined });
    this.publish({ privacyScreenDesired: scope.privacyScreen, privacyScreenActive: false, privacyScreenPending: false, privacyScreenNotice: undefined });
    this.acceptClipboardSync(scope);
    if (scope.target !== null && scope.active) void this.connect();
  }
  private cancel(): void {
    this.#initialControlPending = false;
    this.#modePending = false; this.#wantedControl = false; this.#geometryUnknown = false;
    this.#epoch++; this.#abort.abort(); this.#abort = new AbortController(); this.#attempt = undefined;
    clearTimeout(this.#connectionDeadline); this.#connectionDeadline = undefined;
    clearTimeout(this.#retryTimer); this.#retryTimer = undefined;
    this.#framePending = false; this.#heartbeatPending = false; this.#awaitingFrame = false; this.#opening = false;
    this.#runtimeEpoch = undefined; this.#restartMedia = false;
    this.#runtime?.receive({ type: "stop" });
    this.#runtimeControl = false;
    this.#hostMuteAuthority = undefined; this.#hostMuteOperation++; this.#hostMuteAttempted = false;
    this.#hostMuteSaving = false; this.#hostMuteSaveRetry = undefined;
    this.#privacyAuthority = undefined; this.#privacyOperation++; this.#privacyAttempt = undefined;
    this.#privacySaving = false; this.#privacySaveRetry = undefined;
    this.#lockOnExitSaveRetry = undefined;
    this.#clipboardSyncSaving = false; this.#clipboardSyncSaveRetry = undefined;
    this.#snapshot = { ...this.#snapshot, audioPending: false, hostMuteActive: false, hostMutePending: false,
      hostMuteNotice: undefined, lockOnExitPending: false, lockOnExitNotice: undefined, closeNotice: undefined,
      privacyScreenActive: false, privacyScreenPending: false, privacyScreenNotice: undefined,
      clipboardSyncSaving: false, clipboardSyncPending: false, clipboardSyncActive: false, clipboardSyncNotice: undefined };
  }
  private acceptClipboardSync(scope: DesktopRemoteDesktopViewerState): void {
    this.publish({ clipboardSyncDesired: scope.clipboardSync, clipboardSyncAvailable: scope.clipboardSyncState.available,
      clipboardSyncActive: scope.clipboardSyncState.active, clipboardSyncPending: this.#clipboardSyncSaving || scope.clipboardSyncState.pending,
      clipboardSyncNotice: this.#clipboardSyncSaveRetry !== undefined ? this.#snapshot.clipboardSyncNotice : scope.clipboardSyncState.notice });
  }
  private boundScope(): DesktopRemoteDesktopViewerState | undefined {
    const scope = this.#scope; return scope?.target === null ? undefined : scope;
  }
  private current(epoch: number): boolean { return !this.#disposed && this.boundScope()?.active === true && epoch === this.#epoch; }

  async credential(action: DesktopRemoteDesktopViewerCredentialAction, enabled?: boolean): Promise<void> {
    const scope = this.boundScope();
    if (!scope?.active || this.api.platform !== "darwin" || this.#snapshot.caps?.platform !== "darwin" ||
      !this.#snapshot.ready || this.#snapshot.closing || this.#snapshot.credentialBusy) return;
    this.#credentialRetry = { action, ...(enabled === undefined ? {} : { enabled }) };
    this.publish({ credentialBusy: true, credentialNotice: undefined });
    const current = (): boolean => !this.#disposed && this.#scope?.generation === scope.generation &&
      this.#scope.active && !this.#snapshot.closing;
    try {
      const reply = await this.api.credential(scope.generation, action, enabled);
      if (!current()) return;
      if (reply.ok) {
        this.#credentialRetry = undefined; this.publish({ credential: reply.state });
        if (reply.authenticated && current()) await this.retry(false, true);
      }
      else if (reply.notice !== "cancelled") {
        if (action === "unlock" && reply.notice === "password") this.#credentialRetry = { action: "enable" };
        this.publish({ credentialNotice: reply.notice });
      }
    } catch { if (current()) this.publish({ credentialNotice: "unavailable" }); }
    finally { if (current()) this.publish({ credentialBusy: false }); }
  }
  retryCredential(): void {
    const retry = this.#credentialRetry;
    if (retry) void this.credential(retry.action, retry.enabled);
  }
  private options() { return { signal: this.#abort.signal }; }
  private armConnectionDeadline(): void {
    if (this.#snapshot.status === "capture-pending") return;
    if (this.#connectionDeadline !== undefined) return;
    const epoch = this.#epoch;
    this.#connectionDeadline = setTimeout(() => {
      this.#connectionDeadline = undefined;
      if (this.current(epoch) && !this.#snapshot.ready) {
        this.releaseInput(); this.#runtime.receive({ type: "stop", preserveFrame: true }); this.#runtimeControl = false;
        this.publish({ status: "error", error: "connection", controlling: false });
        this.syncPrivacyScreen();
        this.syncHostMute();
      }
    }, 60000);
  }
  private async connect(displayId?: string, takeover = false, resume = false): Promise<void> {
    if (this.#opening || this.#client === undefined || !this.#scope?.active) return;
    this.#opening = true;
    const epoch = this.#epoch;
    const rpc = this.#client;
    this.publish({ status: "connecting", ready: false, error: undefined });
    this.armConnectionDeadline();
    try {
      const caps = (await rpc.getRemoteDesktopCapabilities({}, this.options())).capabilities;
      if (!this.current(epoch)) return;
      if (caps?.protocolVersion !== 1 || !caps.enabled || !caps.displays.length) {
        this.publish({ status: "error", error: caps?.enabled === false ? "disabled" : "unsupported" }); return;
      }
      this.publish({ caps });
      const display = caps.displays.find((item) => item.displayId === displayId) ?? caps.displays[0]!;
      const started = await rpc.startRemoteDesktop({ displayId: display.displayId,
        mode: takeover ? RemoteDesktopStartMode.TAKEOVER : resume ? RemoteDesktopStartMode.RESUME : RemoteDesktopStartMode.NEW }, this.options());
      if (!this.current(epoch)) return;
      if (started.lease === undefined || !started.lease.leaseId || started.lease.display === undefined) throw new Error("Invalid lease.");
      this.#sourceDisplayId = display.displayId;
      this.publish({ lease: started.lease, sourceDisplayId: display.displayId, viewerDisplayFitted: started.lease.display.displayId !== display.displayId });
      this.#initialControlPending = caps.canControl;
      this.initMedia();
      await this.acquireInitialControl();
      if (this.current(epoch) && caps.displayModes) void this.loadModes();
    } catch (error) { if (this.current(epoch)) await this.fail(error); }
    finally { if (this.current(epoch)) this.#opening = false; }
  }
  private async acquireInitialControl(): Promise<void> {
    if (this.#initialControlPending && document.hasFocus()) await this.control(true);
  }
  private initMedia(): void {
    if (this.#geometryUnknown || this.#modePending) return;
    const { lease, caps, settings } = this.#snapshot;
    if (lease?.display === undefined || caps === undefined) return;
    this.#sequenceBase += 1_000_000_000;
    this.#runtimeEpoch = `${lease.leaseId}:${this.#sequenceBase}`;
    this.#restartMedia = false;
    this.#awaitingFrame = false; this.#attempt = undefined;
    this.#runtimeControl = false;
    this.publish({ status: this.#snapshot.status === "capture-pending" ? "capture-pending" : "connecting" }); this.armConnectionDeadline();
    this.#runtime.receive({ type: "init", epoch: this.#runtimeEpoch, width: lease.display.width, height: lease.display.height,
      inputSequenceBase: this.#sequenceBase, fillHeight: false, webrtcVideo: caps.webrtcVideo,
      trickleIce: caps.trickleIce, audio: caps.systemAudio && settings.audio,
      clipboardShortcuts: caps.clipboardContent || caps.clipboardText, clipboardModifier: this.api.platform === "darwin" ? "meta" : "control" });
    this.#runtime.receive({ type: "mode", mode: "pointer" });
    this.syncControl();
  }
  private syncControl(): void {
    this.syncPrivacyScreen();
    this.syncHostMute();
    const enabled = this.#snapshot.ready && this.#snapshot.controlling && !this.#snapshot.controlPending &&
      !this.#snapshot.settingsBusy && !this.#snapshot.closing && document.hasFocus();
    if (enabled === this.#runtimeControl) return;
    this.#runtimeControl = enabled;
    this.#runtime.receive({ type: "control", enabled });
  }
  private privacyAuthority(): string | undefined {
    const { lease, controlling, caps, closing, closeNotice } = this.#snapshot;
    return this.#scope?.active && !closing && !closeNotice && controlling && lease?.controlling && caps?.privacyScreen
      ? `${this.#epoch}:${lease.leaseId}:${lease.controlGeneration}` : undefined;
  }
  private syncPrivacyScreen(): void {
    const authority = this.privacyAuthority();
    if (authority !== this.#privacyAuthority) {
      this.#privacyAuthority = authority; this.#privacyOperation++; this.#privacyAttempt = undefined;
      this.publish({ privacyScreenActive: false, privacyScreenPending: this.#privacySaving, privacyScreenNotice: undefined });
    }
    if (authority && this.#snapshot.ready && !this.#snapshot.controlPending && !this.#snapshot.settingsBusy &&
      !this.#snapshot.privacyScreenPending && !this.#privacySaving) void this.applyPrivacyScreen();
  }
  private async applyPrivacyScreen(): Promise<void> {
    const authority = this.privacyAuthority(), { lease, ready, controlPending, privacyScreenDesired, lockOnExit } = this.#snapshot;
    if (!authority || !lease || !ready || controlPending || this.#snapshot.settingsBusy || this.#privacySaving ||
      this.#snapshot.privacyScreenPending || !this.#client) return;
    const attempt = `${authority}:${privacyScreenDesired}:${lockOnExit}`;
    if (this.#privacyAttempt === attempt) return;
    this.#privacyAttempt = attempt;
    const epoch = this.#epoch, operation = ++this.#privacyOperation;
    this.publish({ privacyScreenActive: false, privacyScreenPending: true, privacyScreenNotice: undefined });
    const current = (): boolean => this.current(epoch) && operation === this.#privacyOperation && authority === this.privacyAuthority() &&
      this.#snapshot.privacyScreenDesired === privacyScreenDesired && this.#snapshot.lockOnExit === lockOnExit;
    try {
      const response = await this.#client.setRemoteDesktopPrivacyScreen({ request: { leaseId: lease.leaseId,
        controlGeneration: lease.controlGeneration, enabled: privacyScreenDesired, lockOnExit } }, this.options());
      if (!current()) return;
      if (response.result?.enabled !== privacyScreenDesired) throw new Error("Privacy screen was not acknowledged.");
      this.publish({ privacyScreenActive: response.result.enabled, privacyScreenNotice: undefined });
    } catch { if (current()) this.publish({ privacyScreenActive: false, privacyScreenNotice: "effect" }); }
    finally {
      if (this.current(epoch) && operation === this.#privacyOperation) {
        this.publish({ privacyScreenPending: false }); this.syncPrivacyScreen();
      }
    }
  }
  async privacyScreen(enabled: boolean): Promise<void> {
    const scope = this.boundScope();
    if (!scope?.active || this.#snapshot.closing || this.#snapshot.privacyScreenPending || this.#privacySaving ||
      (enabled && (!this.#snapshot.ready || !this.#snapshot.caps?.privacyScreen || !this.#snapshot.controlling))) return;
    const epoch = this.#epoch;
    this.#privacySaving = true; this.#privacySaveRetry = enabled;
    this.publish({ privacyScreenPending: true, privacyScreenNotice: undefined });
    let saved = false;
    try {
      const preferences = await this.api.preferences(scope.generation, { privacyScreen: enabled });
      if (!this.current(epoch) || this.#scope?.generation !== scope.generation) return;
      this.publish({ privacyScreenDesired: preferences.privacyScreen }); this.#privacySaveRetry = undefined; saved = true;
    } catch { if (this.current(epoch)) this.publish({ privacyScreenNotice: "save" }); }
    finally { if (this.current(epoch)) { this.#privacySaving = false; this.publish({ privacyScreenPending: false }); } }
    if (saved && this.current(epoch)) { this.#privacyAttempt = undefined; await this.applyPrivacyScreen(); }
  }
  retryPrivacyScreen(): void {
    if (this.#privacySaveRetry !== undefined) void this.privacyScreen(this.#privacySaveRetry);
    else { this.#privacyAttempt = undefined; void this.applyPrivacyScreen(); }
  }
  private muteAuthority(): string | undefined {
    const { lease, controlling, caps, closing } = this.#snapshot;
    return this.#scope?.active && !closing && controlling && lease?.controlling && caps?.hostMute && document.hasFocus()
      ? `${this.#epoch}:${lease.leaseId}:${lease.controlGeneration}` : undefined;
  }
  private syncHostMute(): void {
    const authority = this.muteAuthority();
    if (authority !== this.#hostMuteAuthority) {
      this.#hostMuteAuthority = authority; this.#hostMuteOperation++; this.#hostMuteAttempted = false;
      this.publish({ hostMuteActive: false, hostMutePending: this.#hostMuteSaving, hostMuteNotice: undefined });
    }
    if (authority && this.#snapshot.ready && !this.#snapshot.controlPending && !this.#snapshot.settingsBusy &&
      !this.#snapshot.hostMutePending && !this.#hostMuteSaving && !this.#hostMuteAttempted &&
      (this.#snapshot.hostMuteDesired || this.#snapshot.hostMuteActive)) void this.applyHostMute();
  }
  private async applyHostMute(): Promise<void> {
    const authority = this.muteAuthority(), { lease, ready, controlPending, hostMuteDesired } = this.#snapshot;
    if (!authority || !lease || !ready || controlPending || this.#snapshot.settingsBusy || this.#hostMuteSaving ||
      this.#snapshot.hostMutePending || !this.#client) return;
    const epoch = this.#epoch, operation = ++this.#hostMuteOperation;
    this.#hostMuteAttempted = true;
    this.publish({ hostMutePending: true, hostMuteNotice: undefined });
    const current = (): boolean => this.current(epoch) && operation === this.#hostMuteOperation && authority === this.muteAuthority();
    try {
      const response = await this.#client.setRemoteDesktopHostMute({ request: { leaseId: lease.leaseId,
        controlGeneration: lease.controlGeneration, enabled: hostMuteDesired } }, this.options());
      if (!current()) return;
      if (response.result?.enabled !== hostMuteDesired) throw new Error("Host mute was not acknowledged.");
      this.publish({ hostMuteActive: response.result.enabled, hostMuteNotice: undefined });
    } catch (error) {
      if (!current()) return;
      const failure = ConnectError.from(error), reason = failure.findDetails(RemoteDesktopFailureSchema)[0]?.reason;
      if (failure.code === Code.PermissionDenied || failure.code === Code.Unauthenticated || reason === Failure.AUTHORITY_CHANGED ||
        reason === Failure.STOPPED || reason === Failure.LEASE_EXPIRED || reason === Failure.DISABLED) await this.fail(error);
      else this.publish({ hostMuteActive: false, hostMuteNotice: "effect" });
    } finally { if (current()) this.publish({ hostMutePending: false }); }
  }
  async hostMute(enabled: boolean): Promise<void> {
    const scope = this.boundScope();
    if (!scope?.active || this.#snapshot.hostMutePending || this.#hostMuteSaving ||
      (enabled && (!this.#snapshot.caps?.hostMute || !this.#snapshot.controlling))) return;
    const epoch = this.#epoch;
    this.#hostMuteSaving = true; this.#hostMuteSaveRetry = enabled;
    this.publish({ hostMutePending: true, hostMuteNotice: undefined });
    let saved = false;
    try {
      const preferences = await this.api.preferences(scope.generation, { hostMute: enabled });
      if (!this.current(epoch) || this.#scope?.generation !== scope.generation) return;
      this.publish({ hostMuteDesired: preferences.hostMute }); this.#hostMuteSaveRetry = undefined; saved = true;
    } catch {
      if (this.current(epoch)) this.publish({ hostMuteNotice: "save" });
    } finally {
      if (this.current(epoch)) { this.#hostMuteSaving = false; this.publish({ hostMutePending: false }); }
    }
    if (saved && this.current(epoch)) { this.#hostMuteAttempted = false; await this.applyHostMute(); }
  }
  retryHostMute(): void {
    if (this.#hostMuteSaveRetry !== undefined) void this.hostMute(this.#hostMuteSaveRetry);
    else void this.applyHostMute();
  }
  async lockOnExit(enabled: boolean): Promise<void> {
    const scope = this.boundScope();
    if (!scope?.active || this.#snapshot.closing || this.#snapshot.lockOnExitPending ||
      (enabled && (!this.#snapshot.ready || !this.#snapshot.caps?.lockOnExit))) return;
    const epoch = this.#epoch;
    this.#lockOnExitSaveRetry = enabled;
    this.publish({ lockOnExitPending: true, lockOnExitNotice: undefined });
    try {
      const preferences = await this.api.preferences(scope.generation, { lockOnExit: enabled });
      if (!this.current(epoch) || this.#scope?.generation !== scope.generation) return;
      this.#lockOnExitSaveRetry = undefined;
      this.publish({ lockOnExit: preferences.lockOnExit });
      this.syncPrivacyScreen();
    } catch { if (this.current(epoch)) this.publish({ lockOnExitNotice: "save" }); }
    finally { if (this.current(epoch)) this.publish({ lockOnExitPending: false }); }
  }
  retryLockOnExit(): void {
    if (this.#lockOnExitSaveRetry !== undefined) void this.lockOnExit(this.#lockOnExitSaveRetry);
  }
  async clipboardSync(enabled: boolean): Promise<void> {
    const scope = this.boundScope();
    if (!scope?.active || this.#snapshot.closing || this.#clipboardSyncSaving ||
      (enabled && (!this.#snapshot.ready || !this.#snapshot.controlling || !this.#snapshot.caps?.clipboardSync || !this.#snapshot.clipboardSyncAvailable))) return;
    const epoch = this.#epoch;
    this.#clipboardSyncSaving = true; this.#clipboardSyncSaveRetry = enabled;
    this.publish({ clipboardSyncPending: true, clipboardSyncSaving: true, clipboardSyncNotice: undefined });
    try {
      const preferences = await this.api.preferences(scope.generation, { clipboardSync: enabled });
      if (!this.current(epoch) || this.#scope?.generation !== scope.generation) return;
      this.#clipboardSyncSaveRetry = undefined;
      this.publish({ clipboardSyncDesired: preferences.clipboardSync, clipboardSyncNotice: this.#scope.clipboardSyncState.notice });
    } catch { if (this.current(epoch)) this.publish({ clipboardSyncNotice: "save" }); }
    finally {
      if (this.current(epoch)) { this.#clipboardSyncSaving = false; this.publish({ clipboardSyncSaving: false, clipboardSyncPending: this.#scope?.clipboardSyncState.pending ?? false }); }
    }
  }
  async retryClipboardSync(): Promise<void> {
    if (this.#clipboardSyncSaveRetry !== undefined) { await this.clipboardSync(this.#clipboardSyncSaveRetry); return; }
    const scope = this.boundScope(), epoch = this.#epoch;
    if (!scope?.active || !this.#snapshot.clipboardSyncDesired || this.#snapshot.closing || this.#snapshot.clipboardSyncPending) return;
    this.publish({ clipboardSyncPending: true });
    try { await this.api.retryClipboardSync(scope.generation); }
    catch { if (this.current(epoch)) this.publish({ clipboardSyncNotice: "temporary" }); }
    finally { if (this.current(epoch)) this.publish({ clipboardSyncPending: this.#scope?.clipboardSyncState.pending ?? false }); }
  }
  async control(enabled: boolean): Promise<void> {
    if (!enabled) this.#initialControlPending = false;
    if (this.#modePending || this.#geometryUnknown) { if (!enabled) this.#wantedControl = false; return; }
    const { lease } = this.#snapshot;
    if (lease === undefined || !this.#client || this.#snapshot.controlPending || this.#snapshot.closing || this.#snapshot.closeNotice) return;
    this.#initialControlPending = false;
    this.#wantedControl = enabled;
    const epoch = this.#epoch;
    const occurrence = ++this.#lastControlRequest;
    this.releaseInput(); this.publish({ controlPending: true }); this.syncControl();
    try {
      const state = (await this.#client.setRemoteDesktopControl({ leaseId: lease.leaseId, enabled }, this.options())).state;
      if (!this.current(epoch) || this.#snapshot.closing || this.#snapshot.closeNotice || state === undefined || occurrence !== this.#lastControlRequest) return;
      this.publish({ controlling: state.controlling, lease: { ...lease, controlling: state.controlling, controlGeneration: state.controlGeneration }, error: undefined });
    } catch (error) {
      if (this.current(epoch) && !this.#snapshot.closing && !this.#snapshot.closeNotice) {
        const failure = ConnectError.from(error);
        const reason = failure.findDetails(RemoteDesktopFailureSchema)[0]?.reason;
        if (failure.code === Code.PermissionDenied || failure.code === Code.Unauthenticated || reason === Failure.AUTHORITY_CHANGED) await this.fail(error);
        else this.publish({ controlling: false, error: failure.code === Code.Canceled ? undefined :
          reason === Failure.VIEW_ONLY || reason === Failure.INPUT_UNAVAILABLE || reason === Failure.UNSUPPORTED ? "unsupported" : "permission" });
      }
    }
    finally { if (this.current(epoch)) { this.publish({ controlPending: false }); this.syncControl(); } }
  }
  private async heartbeat(): Promise<void> {
    const lease = this.#snapshot.lease;
    if (!this.#scope?.active || !this.#client || !lease || this.#heartbeatPending || this.#modePending || this.#snapshot.closing || this.#snapshot.status === "error") return;
    const epoch = this.#epoch, controlRequest = this.#lastControlRequest;
    const controlPending = this.#snapshot.controlPending;
    this.#heartbeatPending = true;
    try {
      const state = (await this.#client.heartbeatRemoteDesktop({ leaseId: lease.leaseId }, this.options())).state;
      if (!this.current(epoch) || this.#snapshot.closing || this.#snapshot.closeNotice || !state || controlPending || this.#snapshot.controlPending || controlRequest !== this.#lastControlRequest) return;
      if (state.controlGeneration < lease.controlGeneration) return;
      this.publish({ controlling: state.controlling, lease: { ...lease, controlling: state.controlling, controlGeneration: state.controlGeneration } }); this.syncControl();
      if (this.#snapshot.status === "reconnecting") { this.publish({ media: "none" }); this.initMedia(); }
    } catch (error) { if (this.current(epoch) && controlRequest === this.#lastControlRequest && !this.#modePending && !this.#snapshot.closing && !this.#snapshot.closeNotice) await this.fail(error); }
    finally { if (this.current(epoch)) this.#heartbeatPending = false; }
  }
  private async frame(): Promise<void> {
    const { lease, caps, media } = this.#snapshot;
    if (!lease || !caps?.jpegFallback || !this.#client || !this.#scope?.active || this.#framePending || this.#awaitingFrame ||
      this.#modePending || this.#snapshot.closing || this.#snapshot.status === "error" || (media !== "none" && media !== "screenshots")) return;
    const epoch = this.#epoch, runtimeEpoch = this.#runtimeEpoch; this.#framePending = true;
    try {
      const frame = (await this.#client.getRemoteDesktopFrame({ leaseId: lease.leaseId, cursorOverlay: caps.cursorOverlay }, this.options())).result?.frame;
      if (!this.current(epoch) || runtimeEpoch !== this.#runtimeEpoch || !frame) return;
      if (frame.jpeg.length < 4 || frame.jpeg.length > 180000 || frame.jpeg[0] !== 255 || frame.jpeg[1] !== 216 ||
        frame.jpeg[frame.jpeg.length - 2] !== 255 || frame.jpeg[frame.jpeg.length - 1] !== 217) throw new Error("Invalid frame.");
      this.#awaitingFrame = true;
      const cursor = frame.cursor;
      this.#runtime.receive({ type: "frame", epoch: runtimeEpoch, jpeg: base64Encode(frame.jpeg), cursor: cursor === undefined ? null :
        { ...cursor, png: base64Encode(cursor.png), hotX: cursor.hotX, hotY: cursor.hotY } });
    } catch (error) { if (this.current(epoch) && runtimeEpoch === this.#runtimeEpoch && !this.#modePending && !this.#snapshot.closing && !this.#snapshot.closeNotice) await this.fail(error); }
    finally { if (this.current(epoch)) this.#framePending = false; }
  }
  private async fail(error: unknown): Promise<void> {
    const code = ConnectError.from(error);
    const reason = code.findDetails(RemoteDesktopFailureSchema)[0]?.reason;
    if (reason === Failure.CAPTURE_PENDING && this.#snapshot.lease) {
      clearTimeout(this.#connectionDeadline); this.#connectionDeadline = undefined;
      this.releaseInput(); this.publish({ status: "capture-pending", ready: false, error: undefined }); this.syncControl();
      return;
    }
    if (reason === Failure.DISPLAY_RESTORE_UNAVAILABLE) this.publish({ modeNotice: "restore-unavailable" });
    if (reason === Failure.LEASE_EXPIRED && this.#snapshot.caps?.automaticReconnect && this.#retryTimer === undefined) {
      const displayId = this.#sourceDisplayId ?? this.#snapshot.lease?.display?.displayId;
      this.releaseInput(); this.publish({ lease: undefined, ready: false, controlling: false, status: "reconnecting", media: "none" });
      this.syncPrivacyScreen();
      this.syncHostMute();
      this.#runtime.receive({ type: "stop", preserveFrame: true }); this.#runtimeControl = false;
      const epoch = this.#epoch;
      this.#retryTimer = setTimeout(() => { this.#retryTimer = undefined;
        if (this.current(epoch)) void this.connect(displayId, false, true); }, this.#retryDelay);
      this.#retryDelay = Math.min(8000, this.#retryDelay * 2);
      return;
    }
    if ((code.code === Code.Unavailable || code.code === Code.DeadlineExceeded) && this.#snapshot.lease !== undefined) {
      this.releaseInput(); this.publish({ status: "reconnecting", ready: false, controlling: false });
      this.syncPrivacyScreen();
      this.syncHostMute();
      this.#runtime.receive({ type: "stop", preserveFrame: true }); this.#runtimeControl = false;
      this.armConnectionDeadline();
      return;
    }
    const issue = reason === Failure.BUSY ? "busy" : reason === Failure.DISABLED ? "disabled" :
      reason === Failure.SCREEN_PERMISSION_REQUIRED || reason === Failure.ACCESSIBILITY_PERMISSION_REQUIRED ? "permission" :
      code.code === Code.PermissionDenied || code.code === Code.Unauthenticated || reason === Failure.AUTHORITY_CHANGED ? "revoked" :
      reason === Failure.UNSUPPORTED || reason === Failure.LOCKED_SESSION_UNSUPPORTED ? "unsupported" : "connection";
    this.releaseInput();
    this.#restartMedia = false;
    this.publish({ status: "error", error: issue, controlling: false, ready: false });
    this.syncPrivacyScreen();
    this.syncHostMute();
    clearTimeout(this.#connectionDeadline); this.#connectionDeadline = undefined;
    this.#runtime.receive({ type: "stop", preserveFrame: true });
  }
  private message(message: Record<string, unknown>): void {
    if (this.#disposed) return;
    if (message["type"] === "scaleMode" && ["fit", "actual", "custom"].includes(String(message["mode"]))) {
      this.publish({ scaleMode: message["mode"] as DesktopViewerSnapshot["scaleMode"] }); return;
    }
    const { lease } = this.#snapshot;
    if (!this.#scope?.active || !lease || this.#runtimeEpoch === undefined || message["epoch"] !== this.#runtimeEpoch) return;
    const type = message["type"];
    if (type === "iceConfig" || type === "offer" || type === "ice") { void this.signal(message); return; }
    if (type === "streaming" || type === "framePresented") {
      this.#awaitingFrame = false;
      clearTimeout(this.#connectionDeadline); this.#connectionDeadline = undefined;
      this.#retryDelay = 1000;
      this.publish({ status: "live", ready: true, media: type === "streaming" ? "video" : "screenshots", error: undefined }); this.syncControl();
      if (!this.#unlockAttempted && this.api.platform === "darwin" && this.#snapshot.caps?.platform === "darwin") {
        this.#unlockAttempted = true; void this.credential("unlock");
      }
    } else if (type === "fallback") {
      if (message["reason"] === "capture-pending") {
        clearTimeout(this.#connectionDeadline); this.#connectionDeadline = undefined;
        this.publish({ status: "capture-pending", ready: false, error: undefined });
      }
      this.publish({ media: "screenshots", latency: undefined, receiveRate: undefined });
    }
    else if (type === "network" && this.#snapshot.media !== "screenshots") {
      if (["direct", "relay", "video"].includes(String(message["transport"]))) this.publish({ media: message["transport"] as "direct" | "relay" | "video",
        latency: finitePositive(message["latencyMs"]), receiveRate: finitePositive(message["bytesPerSecond"]) });
    } else if (type === "clipboard" && (message["action"] === "copy" || message["action"] === "paste")) {
      void this.clipboard(message["action"]);
    } else if (type === "input" && this.#snapshot.ready && this.#snapshot.controlling && !this.#snapshot.controlPending) {
      const sequence = message["sequence"], events = message["events"];
      if (!Number.isSafeInteger(sequence) || (sequence as number) <= this.#sequenceBase || !Array.isArray(events) || events.length > 64) return;
      const epoch = this.#epoch, runtimeEpoch = this.#runtimeEpoch;
      try {
        const inputs = events.map(desktopViewerInput);
        void this.#client?.sendRemoteDesktopInput({ leaseId: lease.leaseId, sequence: BigInt(sequence as number), events: inputs }, this.options())
          .catch(() => { if (this.current(epoch) && runtimeEpoch === this.#runtimeEpoch) void this.control(false); })
          .finally(() => { if (this.current(epoch) && runtimeEpoch === this.#runtimeEpoch) this.#runtime.receive({ type: "ack", epoch: runtimeEpoch, sequence }); });
      } catch { void this.control(false); }
    } else if (type === "inputOverflow") { void this.control(false); }
  }
  private async signal(message: Record<string, unknown>): Promise<void> {
    const { lease, caps, settings } = this.#snapshot;
    if (!lease || !caps || !this.#client || typeof message["attemptId"] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(message["attemptId"])) return;
    const attempt = message["attemptId"], epoch = this.#epoch, runtimeEpoch = this.#runtimeEpoch, rpc = this.#client;
    if (message["type"] !== "ice") this.#attempt = attempt;
    const current = (): boolean => this.current(epoch) && !this.#snapshot.closing && !this.#snapshot.closeNotice &&
      this.#attempt === attempt && runtimeEpoch === this.#runtimeEpoch && !this.#restartMedia;
    const send = (value: object): void => { if (current()) this.#runtime.receive({ ...value, epoch: runtimeEpoch, attemptId: attempt }); };
    try {
      if (message["type"] === "iceConfig") {
        const config = await rpc.getRemoteDesktopIceConfiguration({ leaseId: lease.leaseId }, this.options());
        send({ type: "iceConfig", iceServers: [ { urls: ["stun:stun.cloudflare.com:3478"] }, { urls: ["stun:stun.l.google.com:19302"] },
          ...config.iceServers.map(({ urls, username, credential }) => ({ urls, ...(username === undefined ? {} : { username }),
            ...(credential === undefined ? {} : { credential }) })) ] });
      } else if (message["type"] === "offer") {
        if (typeof message["sdp"] !== "string" || message["sdp"].length > 65536) return;
        const preceding = this.#offerPending;
        const pending = (async () => {
          if (preceding !== undefined) await preceding.catch(() => undefined);
          if (!current()) return;
          const offer = await rpc.createRemoteDesktopOffer({ leaseId: lease.leaseId, attemptId: attempt,
            offerSdp: message["sdp"] as string, settings: { ...settings, audio: caps.systemAudio && settings.audio }, cursorOverlay: caps.cursorOverlay }, this.options());
          if (offer.offer?.attemptId !== attempt || !offer.offer.answerSdp) throw new Error("Invalid answer.");
          send({ type: "answer", sdp: offer.offer.answerSdp });
        })();
        this.#offerPending = pending;
        try { await pending; }
        finally {
          if (this.#offerPending === pending) {
            this.#offerPending = undefined;
            if (this.current(epoch) && this.#restartMedia) { this.#restartMedia = false; this.initMedia(); }
          }
        }
      } else if (current() && Number.isSafeInteger(message["after"]) && Number.isSafeInteger(message["exchangeId"]) && Array.isArray(message["candidates"]) && message["candidates"].length <= 16) {
        const ice = await rpc.exchangeRemoteDesktopIce({ leaseId: lease.leaseId, attemptId: attempt,
          after: message["after"] as number, candidates: message["candidates"] }, this.options());
        if (ice.exchange?.attemptId === attempt) send({ type: "ice", exchangeId: message["exchangeId"], ...ice.exchange });
      }
    } catch (error) {
      if (!current()) return;
      const failure = ConnectError.from(error), reason = failure.findDetails(RemoteDesktopFailureSchema)[0]?.reason;
      if (reason === Failure.CAPTURE_PENDING) {
        await this.fail(error);
        send(message["type"] === "ice" ? { type: "ice", exchangeId: message["exchangeId"], error: true } :
          { type: "fallback", retry: true, capturePending: true });
        return;
      }
      if (failure.code === Code.PermissionDenied || failure.code === Code.Unauthenticated || reason === Failure.AUTHORITY_CHANGED ||
        reason === Failure.DISABLED || reason === Failure.LEASE_EXPIRED || reason === Failure.STOPPED || reason === Failure.SCREEN_PERMISSION_REQUIRED) {
        await this.fail(error); return;
      }
      send(message["type"] === "ice" ? { type: "ice", exchangeId: message["exchangeId"], error: true } :
        { type: "fallback", retry: reason !== Failure.UNSUPPORTED && reason !== Failure.LOCKED_SESSION_UNSUPPORTED && reason !== Failure.AUDIO_UNAVAILABLE });
    }
  }
  async retry(takeover = false, preserveCredentialAttempt = false): Promise<void> {
    const rpc = this.#client, lease = this.#snapshot.lease, epoch = this.#epoch;
    const failedExit = this.#snapshot.closeNotice;
    if (this.#snapshot.settingsBusy || this.#snapshot.closing) return;
    if (!preserveCredentialAttempt) this.#unlockAttempted = false;
    this.releaseInput();
    this.publish({ controlling: false, ready: false, closeNotice: undefined }); this.syncControl();
    if (rpc && lease) {
      try { await rpc.stopRemoteDesktop({ leaseId: lease.leaseId }, this.options()); }
      catch (error) {
        const failure = ConnectError.from(error), reason = failure.findDetails(RemoteDesktopFailureSchema)[0]?.reason;
        if ((failedExit === undefined && this.#snapshot.modeNotice === undefined) || failure.code !== Code.FailedPrecondition ||
          (reason !== Failure.STOPPED && (this.#geometryUnknown || reason !== Failure.LEASE_EXPIRED))) {
          if (this.current(epoch)) this.publish({ status: "error", error: "connection", closeNotice: failedExit });
          return;
        }
      }
    }
    if (!this.current(epoch)) return;
    this.cancel(); this.publish({ lease: undefined, controlling: false, ready: false, media: "none", modeNotice: undefined });
    await this.connect(this.#sourceDisplayId, takeover);
  }
  async selectDisplay(displayId: string): Promise<void> {
    const rpc = this.#client, lease = this.#snapshot.lease;
    if (!rpc || !lease || this.#snapshot.settingsBusy) return;
    const epoch = this.#epoch, generation = this.#scope?.generation;
    this.releaseInput(); this.publish({ settingsBusy: true });
    this.syncControl();
    try { await rpc.stopRemoteDesktop({ leaseId: lease.leaseId }, this.options());
      if (!this.current(epoch)) return;
      this.cancel(); this.publish({ lease: undefined, controlling: false, ready: false, media: "none" });
      await this.connect(displayId);
    } catch { if (this.current(epoch)) this.publish({ error: "display" }); }
    finally { if (!this.#disposed && this.#scope?.generation === generation) { this.publish({ settingsBusy: false }); this.syncControl(); } }
  }
  settings(patch: Partial<DesktopViewerSnapshot["settings"]>): void {
    if (this.#snapshot.settingsBusy) return;
    const { audio, ...video } = patch;
    if (Object.keys(video).length) this.applySettings(video);
    if (audio !== undefined) void this.saveAudio(audio);
  }
  private async saveAudio(audio: boolean): Promise<void> {
    const scope = this.boundScope();
    if (!scope?.active || this.#snapshot.audioPending || audio === this.#snapshot.settings.audio) return;
    const epoch = this.#epoch;
    this.publish({ audioPending: true, error: undefined });
    try {
      const saved = await this.api.preferences(scope.generation, { audio });
      if (this.current(epoch) && this.#scope?.generation === scope.generation) this.applySettings({ audio: saved.audio });
    } catch {
      if (this.current(epoch)) this.publish({ error: "preferences" });
    } finally {
      if (this.current(epoch)) this.publish({ audioPending: false });
    }
  }
  private applySettings(patch: Partial<DesktopViewerSnapshot["settings"]>): void {
    if (Object.entries(patch).every(([key, value]) => this.#snapshot.settings[key as keyof DesktopViewerSnapshot["settings"]] === value)) return;
    this.releaseInput(); this.publish({ settings: { ...this.#snapshot.settings, ...patch }, media: "none", ready: false });
    if (this.#offerPending !== undefined) {
      this.#restartMedia = true; this.#runtimeEpoch = undefined; this.#runtimeControl = false;
      this.#runtime.receive({ type: "stop", preserveFrame: true });
    } else this.initMedia();
  }
  async loadModes(): Promise<void> {
    const lease = this.#snapshot.lease; if (!lease || !this.#client || !this.#snapshot.caps?.displayModes || this.#modePending) return;
    const epoch = this.#epoch;
    const current = () => this.current(epoch) && !this.#modePending && this.#snapshot.lease?.leaseId === lease.leaseId &&
      this.#snapshot.lease.controlGeneration === lease.controlGeneration;
    try { const result = await this.#client.listRemoteDesktopDisplayModes({ leaseId: lease.leaseId }, this.options());
      if (current()) this.publish({ modes: result.modes }); }
    catch { if (current()) this.publish({ error: "display" }); }
  }
  async setMode(modeId: string): Promise<void> {
    const lease = this.#snapshot.lease;
    if (!lease || !this.#client || !this.#snapshot.controlling || this.#snapshot.settingsBusy || this.#snapshot.controlPending ||
      this.#snapshot.closing || this.#geometryUnknown || !this.#snapshot.modes.some(mode => mode.modeId === modeId && (!mode.current || this.#snapshot.viewerDisplayFitted))) return;
    const rpc = this.#client;
    const epoch = this.#epoch, generation = this.#scope?.generation;
    const temporary = this.#snapshot.caps?.resolutionRestore === true, restoreControl = this.#snapshot.controlling && this.#wantedControl;
    this.#modePending = true; this.#lastControlRequest++; this.releaseInput();
    this.#runtime.receive({ type: "stop", preserveFrame: true }); this.#runtimeEpoch = undefined; this.#runtimeControl = false;
    this.#awaitingFrame = false;
    this.publish({ settingsBusy: true, ready: false, controlling: false, media: "none", modeNotice: undefined });
    this.syncControl();
    try { const response = await rpc.setRemoteDesktopDisplayMode({ leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, modeId, temporary }, this.options());
      if (!this.current(epoch)) return;
      if (!response.result) throw new Error("Display mode receipt missing.");
      if (temporary) {
        const next = response.result.lease;
        if (!next || next.leaseId !== lease.leaseId || next.controlling || next.controlGeneration <= lease.controlGeneration ||
          !next.display || (next.display.displayId !== lease.display?.displayId && next.display.displayId !== this.#sourceDisplayId) ||
          ![next.display.width, next.display.height].every(size => Number.isSafeInteger(size) && size > 0 && size <= 32_768)) throw new Error("Display mode occurrence changed.");
        this.publish({ lease: next, controlling: false, ready: false, status: "reconnecting", modes: [],
          viewerDisplayFitted: next.display.displayId !== this.#sourceDisplayId });
        this.#modePending = false; this.initMedia();
        if (restoreControl && this.#wantedControl && document.hasFocus()) await this.control(true);
        void this.loadModes();
        return;
      }
      if (response.result.lease) throw new Error("Permanent display mode returned a lease.");
      // A successful mode change retires the old geometry/lease. Reconnect explicitly to that display.
      this.cancel(); this.publish({ lease: undefined, ready: false, controlling: false, media: "none" });
      await this.connect(this.#sourceDisplayId ?? lease.display?.displayId);
    } catch (error) {
      if (!this.current(epoch)) return;
      const reason = ConnectError.from(error).findDetails(RemoteDesktopFailureSchema)[0]?.reason;
      const keepsLease = [Failure.DISPLAY_MODES_UNAVAILABLE, Failure.DISPLAY_MODE_MISSING, Failure.DISPLAY_BUSY, Failure.VIEW_ONLY].includes(reason ?? Failure.UNSPECIFIED);
      this.#geometryUnknown = !keepsLease;
      this.#modePending = false;
      this.publish({ modeNotice: reason === Failure.DISPLAY_RESTORE_UNAVAILABLE ? "restore-unavailable" : "change-failed",
        controlling: keepsLease && reason !== Failure.VIEW_ONLY && this.#wantedControl, status: keepsLease ? "live" : "error", error: keepsLease ? undefined : "connection" });
      if (keepsLease) this.initMedia();
    }
    finally { if (!this.#disposed && this.#scope?.generation === generation) { this.#modePending = false; this.publish({ settingsBusy: false }); this.syncControl(); } }
  }
  async fitViewerDisplay(): Promise<void> {
    const bounds = this.root.querySelector("#stage")?.getBoundingClientRect() ?? this.root.getBoundingClientRect();
    const size = desktopViewerDisplaySize(bounds.width, bounds.height);
    if (size) await this.changeViewerDisplay(size);
  }
  async restoreViewerDisplay(): Promise<void> { await this.changeViewerDisplay(); }
  private async changeViewerDisplay(size?: { readonly width: number; readonly height: number }): Promise<void> {
    const { lease, caps } = this.#snapshot, rpc = this.#client;
    if (!lease || !rpc || !caps?.viewerDisplay || !caps.viewerDisplayRestore || !this.#snapshot.controlling ||
      this.#snapshot.settingsBusy || this.#snapshot.controlPending || this.#snapshot.closing || this.#geometryUnknown ||
      (!size && !this.#snapshot.viewerDisplayFitted)) return;
    const epoch = this.#epoch, generation = this.#scope?.generation, restoreControl = this.#wantedControl;
    this.#modePending = true; this.#lastControlRequest++; this.releaseInput();
    this.#runtime.receive({ type: "stop", preserveFrame: true }); this.#runtimeEpoch = undefined; this.#runtimeControl = false;
    this.#awaitingFrame = false;
    this.publish({ settingsBusy: true, ready: false, controlling: false, media: "none", modeNotice: undefined }); this.syncControl();
    try {
      const input = { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration };
      const response = size ? await rpc.setRemoteDesktopViewerDisplay({ ...input, ...size }, this.options())
        : await rpc.restoreRemoteDesktopViewerDisplay(input, this.options());
      if (!this.current(epoch)) return;
      const next = response.result?.lease;
      if (!next || next.leaseId !== lease.leaseId || next.controlling || next.controlGeneration <= lease.controlGeneration ||
        !next.display || !next.display.displayId || (!size && next.display.displayId !== this.#sourceDisplayId) ||
        (size && (next.display.displayId === this.#sourceDisplayId || next.display.width !== size.width || next.display.height !== size.height ||
          this.#snapshot.viewerDisplayFitted && next.display.displayId !== lease.display?.displayId)) ||
        ![next.display.width, next.display.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= (size ? 2560 : 32_768))) {
        throw new Error("Display geometry receipt changed its authority.");
      }
      this.publish({ lease: next, controlling: false, ready: false, status: "reconnecting", modes: [], viewerDisplayFitted: !!size });
      this.#modePending = false; this.initMedia();
      if (restoreControl && this.#wantedControl && document.hasFocus()) await this.control(true);
      void this.loadModes();
    } catch (error) {
      if (!this.current(epoch)) return;
      const reason = ConnectError.from(error).findDetails(RemoteDesktopFailureSchema)[0]?.reason;
      const keepsLease = [Failure.DISPLAY_MODES_UNAVAILABLE, Failure.DISPLAY_BUSY, Failure.VIEW_ONLY].includes(reason ?? Failure.UNSPECIFIED);
      this.#geometryUnknown = !keepsLease; this.#modePending = false;
      this.publish({ modeNotice: reason === Failure.DISPLAY_RESTORE_UNAVAILABLE ? "restore-unavailable" : "change-failed",
        controlling: keepsLease && reason !== Failure.VIEW_ONLY && this.#wantedControl, status: keepsLease ? "live" : "error",
        error: keepsLease ? undefined : "connection" });
      if (keepsLease) this.initMedia();
    } finally { if (!this.#disposed && this.#scope?.generation === generation) {
      this.#modePending = false; this.publish({ settingsBusy: false }); this.syncControl();
    } }
  }
  async clipboard(action: "copy" | "paste"): Promise<void> {
    const scope = this.boundScope();
    if (!scope?.active || !this.#snapshot.controlling || this.#snapshot.clipboardBusy) return;
    const epoch = this.#epoch; this.releaseInput(); this.publish({ clipboardBusy: true, error: undefined });
    try { await this.api.clipboard(scope.generation, action); }
    catch { if (this.current(epoch)) this.publish({ error: "clipboard" }); }
    finally { if (this.current(epoch)) this.publish({ clipboardBusy: false }); }
  }
  releaseInput(): void { this.#runtime.receive({ type: "releaseInput" }); }
  focusLost(): void { this.releaseInput(); this.syncHostMute(); }
  focusInput(): void { this.syncControl(); this.#runtime.receive({ type: "keyboard", enabled: true }); }
  dismissNotice(): void { if (["clipboard", "display", "preferences"].includes(this.#snapshot.error ?? "")) this.publish({ error: undefined }); }
  keys(codes: readonly string[]): void {
    if (!this.#snapshot.controlling || !this.#snapshot.ready || !codes.every((code) => KEYS.includes(code))) return;
    this.#runtime.receive({ type: "events", events: [...codes.map((code) => ({ kind: "key", code, down: true })),
      ...[...codes].reverse().map((code) => ({ kind: "key", code, down: false }))] });
  }
  zoom(direction: "in" | "out"): void { this.#runtime.receive({ type: "zoom", factor: direction === "in" ? 1.25 : 0.8 }); }
  fit(): void { this.#runtime.receive({ type: "fit" }); }
  actualSize(): void {
    const { lease, ready } = this.#snapshot;
    if (!ready || !lease?.display || !this.#scope?.active) return;
    this.#runtime.receive({ type: "actualSize" });
    const toolbar = this.root.parentElement?.querySelector(".remote-viewer-toolbar");
    const toolbarHeight = toolbar?.getBoundingClientRect().height ?? 60;
    void this.api.resize(this.#scope.generation, Math.ceil(lease.display.width),
      Math.ceil(lease.display.height + toolbarHeight)).catch(() => undefined);
  }
  async close(): Promise<void> {
    const scope = this.boundScope();
    if (!scope || this.#snapshot.closing || this.#snapshot.lockOnExitPending || this.#snapshot.controlPending) return;
    const epoch = this.#epoch, lockScreen = this.#snapshot.lockOnExit && this.#snapshot.caps?.lockOnExit;
    clearTimeout(this.#connectionDeadline); this.#connectionDeadline = undefined;
    clearTimeout(this.#retryTimer); this.#retryTimer = undefined;
    this.releaseInput(); this.publish({ closing: true, controlling: false, closeNotice: undefined }); this.syncControl();
    try { await this.api.close(scope.generation); }
    catch {
      if (this.current(epoch)) {
        this.#runtime.receive({ type: "stop", preserveFrame: true }); this.#runtimeControl = false;
        this.publish({ closing: false, controlling: false, ready: false, status: "error", error: undefined,
          closeNotice: lockScreen ? "lock" : "disconnect" });
      }
    }
  }
  dispose(): void {
    window.removeEventListener("focus", this.#onWindowFocus);
    this.cancel(); this.#disposed = true; this.#off(); for (const timer of this.#timers) clearInterval(timer); this.#runtime.dispose();
  }
}

function finitePositive(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
export function desktopViewerDisplaySize(width: number, height: number): { width: number; height: number } | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  const scale = 1920 / Math.max(width, height);
  const result = { width: Math.round(width * scale / 2) * 2, height: Math.round(height * scale / 2) * 2 };
  return Math.min(result.width, result.height) >= 320 ? result : undefined;
}
export function desktopViewerInput(value: unknown) {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid viewer input.");
  const event = value as Record<string, unknown>;
  switch (event["kind"]) {
    case "move": return create(RemoteDesktopInputEventSchema, { event: { case: "move", value: { x: event["x"] as number, y: event["y"] as number } } });
    case "button": return create(RemoteDesktopInputEventSchema, { event: { case: "button", value: {
      x: event["x"] as number, y: event["y"] as number, down: event["down"] === true,
      button: event["button"] === 0 ? RemoteDesktopMouseButton.LEFT : event["button"] === 1 ? RemoteDesktopMouseButton.MIDDLE : RemoteDesktopMouseButton.RIGHT } } });
    case "scroll": return create(RemoteDesktopInputEventSchema, { event: { case: "scroll", value: { deltaX: event["dx"] as number, deltaY: event["dy"] as number } } });
    case "key": if (!KEYS.includes(String(event["code"]))) throw new TypeError("Invalid key.");
      return create(RemoteDesktopInputEventSchema, { event: { case: "key", value: { code: String(event["code"]), down: event["down"] === true } } });
    case "text": if (typeof event["text"] !== "string" || event["text"].length > 4096) throw new TypeError("Invalid text.");
      return create(RemoteDesktopInputEventSchema, { event: { case: "text", value: { text: event["text"] } } });
    case "release": return create(RemoteDesktopInputEventSchema, { event: { case: "release", value: {} } });
    default: throw new TypeError("Invalid input kind.");
  }
}
