import { isRemoteDesktopClipboardVersion } from "@joko/contracts";
import type { RemoteDesktopHostIceServer } from "./remote-desktop-ice-config.js";
import {
  REMOTE_DESKTOP_FRAME_INTERVAL_MS,
  REMOTE_DESKTOP_LEASE_MS,
  isBoundedRemoteDesktopJpegFrame,
  isRemoteDesktopViewerDisplayGeometry,
  parseRemoteDesktopDisplayModes,
  parseRemoteDesktopDisplay,
  parseRemoteDesktopHostCapabilities,
  parseRemoteDesktopPermissions,
  parseRemoteDesktopRequest,
  remoteDesktopPermissionReady,
  type RemoteDesktopCapabilities,
  type RemoteDesktopDisplayMode,
  type RemoteDesktopHostCapabilities,
  type RemoteDesktopInput,
  type RemoteDesktopJpegFrame,
  type RemoteDesktopLease,
  type RemoteDesktopHandoffWindow,
  type RemoteDesktopPermissions,
  type RemoteDesktopPlatform,
  type RemoteDesktopSystemAction,
  type RemoteDesktopVideoSettings
} from "./remote-desktop.js";
import {
  parseRemoteDesktopIceReply,
  type RemoteDesktopIceReply,
  type RemoteDesktopIceRequest
} from "./remote-desktop-ice.js";

/**
 * Target-side authority for one authenticated DevicePeer executor lifetime.
 * The Orchestrator owns the durable relation/revision/route fence. The target
 * receives only the authenticated controller identity and an opaque local
 * lifecycle token that becomes invalid when its executor is retired.
 */
export interface RemoteDesktopAuthority {
  readonly controllerDeviceId: string;
  readonly lifecycleToken: object;
  /** Trusted native command occurrence; never part of a DevicePeer envelope. */
  readonly authenticationOwner?: object;
}

export interface RemoteDesktopControllerState {
  readonly controllerDeviceId: string;
  readonly lease: string;
  readonly displayId: string;
  readonly sourceDisplayId: string;
  readonly controlling: boolean;
  readonly controlGeneration: number;
}

export interface RemoteDesktopViewerDisplayHandle {
  readonly displayId?: string;
  resize(width: number, height: number, current: () => boolean): Promise<RemoteDesktopLease["display"]>;
  restore(current: () => boolean): Promise<RemoteDesktopLease["display"]>;
  /** Starts release; restore joins actual close and physical geometry. */
  dispose(): void;
}

export interface RemoteDesktopControllerDependencies {
  /** Must revalidate the exact local executor lifecycle token. */
  authorityCurrent(authority: RemoteDesktopAuthority): boolean;
  /** undefined: ordinary paired request; null: captured native proof retired. */
  authenticationSession?(authority: RemoteDesktopAuthority): string | null | undefined;
  capabilities(authority: RemoteDesktopAuthority): Promise<RemoteDesktopHostCapabilities>;
  /** Prepare native host effects only after old layout/safety restoration and before a new lease. */
  prepare?(current: () => boolean, authority: RemoteDesktopAuthority): Promise<void>;
  permissions?(
    action: "check" | "guide",
    authority: RemoteDesktopAuthority
  ): Promise<RemoteDesktopPermissions>;
  frame(request: {
    readonly displayId: string;
    readonly leaseId: string;
    readonly cursorOverlay: boolean;
    readonly current: () => boolean;
  }, authority: RemoteDesktopAuthority): Promise<RemoteDesktopJpegFrame | null>;
  startInput(displayId: string, authority: RemoteDesktopAuthority, window?: RemoteDesktopHandoffWindow): Promise<void>;
  input(events: readonly RemoteDesktopInput[], authority: RemoteDesktopAuthority): void;
  stopInput(): void;
  releaseInput?(): Promise<void>;
  stopVideo(): void;
  lockScreen?(current: () => boolean, signal: AbortSignal, authority: RemoteDesktopAuthority): Promise<void>;
  hostMute?(owner: object, enabled: boolean, current: () => boolean,
    authority: RemoteDesktopAuthority): Promise<void>;
  stopHostMute?(owner: object): Promise<void>;
  workspaceAction?(action: RemoteDesktopSystemAction, displayId: string, current: () => boolean,
    authority: RemoteDesktopAuthority): Promise<void>;
  stopWorkspaceActions?(): Promise<void>;
  clipboardVersion?(current: () => boolean, authority: RemoteDesktopAuthority): Promise<string>;
  stopClipboardVersion?(): void;
  privacyScreen?(owner: object, displayId: string, current: () => boolean, authority: RemoteDesktopAuthority): Promise<void>;
  stopPrivacyScreen?(owner: object): Promise<void>;
  resumeInputAfterPrivacy?(displayId: string, current: () => boolean, authority: RemoteDesktopAuthority): Promise<void>;
  offer(
    lease: RemoteDesktopLease,
    sdp: string,
    attemptId: string,
    settings: RemoteDesktopVideoSettings | undefined,
    cursorOverlay: boolean,
    authority: RemoteDesktopAuthority,
    iceServers?: readonly RemoteDesktopHostIceServer[]
  ): Promise<string>;
  ice?(
    request: RemoteDesktopIceRequest,
    authority: RemoteDesktopAuthority
  ): Promise<RemoteDesktopIceReply>;
  displayModes?(
    displayId: string,
    authority: RemoteDesktopAuthority
  ): Promise<readonly RemoteDesktopDisplayMode[]>;
  setDisplayMode?(
    displayId: string,
    modeId: string,
    beforeChange: () => void | Promise<void>,
    authority: RemoteDesktopAuthority,
    expected?: { readonly width: number; readonly height: number; readonly current?: () => boolean }
  ): Promise<RemoteDesktopLease["display"] | void>;
  restoreDisplayMode?(
    displayId: string,
    modeId: string,
    current: () => boolean,
    expected: { readonly width: number; readonly height: number },
    authority: RemoteDesktopAuthority
  ): Promise<RemoteDesktopLease["display"] | void>;
  displayPresent?(displayId: string): Promise<boolean>;
  createViewerDisplay?(sourceDisplayId: string, current: () => boolean, onFailure: () => void,
    authority: RemoteDesktopAuthority): Promise<RemoteDesktopViewerDisplayHandle>;
  changed(): void;
  now?(): number;
  createLeaseId?(): string;
  handoffWindow?(requestId: string, authority: RemoteDesktopAuthority): Promise<RemoteDesktopHandoffWindow | null>;
  handoffCurrent?(window: RemoteDesktopHandoffWindow, authority: RemoteDesktopAuthority): Promise<boolean>;
  handoffEnded?(window: RemoteDesktopHandoffWindow, authority: RemoteDesktopAuthority): void;
}

interface ActiveRemoteDesktopLease {
  readonly lease: string;
  readonly platform: RemoteDesktopPlatform;
  readonly sourceDisplayId: string;
  display: RemoteDesktopLease["display"];
  readonly canControl: boolean;
  readonly displayModes: boolean;
  readonly resolutionRestore: boolean;
  readonly viewerDisplay: boolean;
  readonly viewerDisplayRestore: boolean;
  readonly cursorOverlay: boolean;
  readonly hostMute: boolean;
  readonly lockOnExit: boolean;
  readonly clipboardSyncAvailable: boolean;
  readonly privacyScreen: boolean;
  readonly workspaceNavigation: boolean;
  readonly systemMenu: boolean;
  privacyOwner?: object;
  privacyLockOnExit: boolean;
  privacyRevision: number;
  clipboardSync: boolean;
  syncGeneration: number;
  muteOwner?: object;
  controlling: boolean;
  controlGeneration: number;
  readonly authority: RemoteDesktopAuthority;
  readonly authenticationSession: string | undefined;
  expiresAt: number;
  sequence: number;
  backgroundViewing: boolean;
  presentationProofSequence: number;
  readonly handoff?: RemoteDesktopHandoffWindow;
}

/**
 * One ephemeral human-viewer lease. It owns no durable records, credentials,
 * signaling history, frames or input history.
 */
export class RemoteDesktopController {
  readonly #dependencies: RemoteDesktopControllerDependencies;
  #active: ActiveRemoteDesktopLease | undefined;
  #starting = false;
  #startingPeer: string | undefined;
  #inputStarting = false;
  #inputRecoveryUsed = false;
  #framePending = false;
  #displayModePending = false;
  #displayWrite: Promise<void> | undefined;
  #displayRestoring: Promise<void> | undefined;
  #originalResolution: {
    readonly displayId: string;
    readonly modeId: string;
    readonly width: number;
    readonly height: number;
    readonly authority: RemoteDesktopAuthority;
  } | undefined;
  #viewerGeometryManaged = false;
  #viewerDisplay: { readonly sourceDisplayId: string; handle?: RemoteDesktopViewerDisplayHandle } | undefined;
  #viewerDisplayRevision = 0;
  #lastFrameAt = Number.NEGATIVE_INFINITY;
  #controlGeneration = 0;
  #syncGeneration = 0;
  #locallyStopped = new Map<string, string>();
  #lastEnded: { readonly peer: string; readonly lease: string } | undefined;
  #safetyTail: Promise<void> = Promise.resolve();
  #systemActionTail: Promise<void> = Promise.resolve();
  #systemActionDrain: Promise<void> | undefined;
  #systemActionNeedsDrain = false;
  readonly #pendingMuteRestores = new Set<object>();
  readonly #pendingPrivacyRestores = new Set<object>();
  #privacyPending: Promise<void> | undefined;
  #privacyOperation: { readonly owner: object; readonly promise: Promise<void> } | undefined;
  #locking: {
    readonly active: ActiveRemoteDesktopLease;
    readonly authority: RemoteDesktopAuthority;
    readonly cancellation: AbortController;
    readonly controlGeneration: number;
  } | undefined;
  #lockPending: Promise<void> | undefined;
  #handoffInputTail: Promise<void> = Promise.resolve();
  #handoffInputPending = 0;

  constructor(dependencies: RemoteDesktopControllerDependencies) {
    this.#dependencies = dependencies;
  }

  get state(): RemoteDesktopControllerState | undefined {
    const active = this.#active;
    return active === undefined
      ? undefined
      : Object.freeze({
          controllerDeviceId: active.authority.controllerDeviceId,
          lease: active.lease,
          displayId: active.display.id,
          sourceDisplayId: active.sourceDisplayId,
          controlling: active.controlling,
          controlGeneration: active.controlGeneration
        });
  }

  get changingDisplay(): boolean { return this.#displayModePending || this.#displayRestoring !== undefined; }

  get managedViewerDisplay(): { readonly sourceDisplayId: string; readonly displayId?: string } | undefined {
    const viewer = this.#viewerDisplay;
    return viewer === undefined ? undefined : Object.freeze({ sourceDisplayId: viewer.sourceDisplayId,
      ...(viewer.handle?.displayId === undefined ? {} : { displayId: viewer.handle.displayId }) });
  }

  displayGeometryMatches(displayId: string, width: number, height: number): boolean {
    return this.#viewerGeometryManaged && this.#active?.display.id === displayId
      && this.#active.display.width === width && this.#active.display.height === height;
  }

  tick(): void {
    const active = this.#active;
    if (active !== undefined
      && (active.expiresAt <= this.#now() || !this.#authorityCurrent(active.authority)
        || !this.#authenticationCurrent(active))) {
      this.stop();
    }
  }

  hasLease(authority: RemoteDesktopAuthority, lease: string): boolean {
    if (!validAuthority(authority)) return false;
    this.tick();
    return this.#active?.lease === lease && sameAuthority(this.#active.authority, authority);
  }
  handoffWindow(lease: string): RemoteDesktopHandoffWindow | undefined { return this.#active?.lease === lease ? this.#active.handoff : undefined; }
  async checkHandoff(lease: string): Promise<boolean> {
    const active = this.#active; if (!active || active.lease !== lease) return false;
    try { await this.#ensureHandoff(active); return this.hasLease(active.authority, lease); } catch { return false; }
  }

  /** Trusted capture-renderer acknowledgement of an actual system presentation. */
  recordPresentationPong(lease: string): void {
    const active = this.#active;
    if (active === undefined || active.lease !== lease
      || !active.backgroundViewing || active.controlling
      || !this.#authorityCurrent(active.authority)) return;
    this.tick();
    if (this.#active !== active) return;
    active.expiresAt = this.#now() + REMOTE_DESKTOP_LEASE_MS;
    active.presentationProofSequence += 1;
  }

  /** Read-only exact proof probe; probing itself never extends either lease. */
  probePresentation(authority: RemoteDesktopAuthority, lease: string): {
    readonly lease: string;
    readonly proofSequence: number;
  } {
    const active = this.#require(authority, lease);
    if (this.#displayModePending) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
    if (!active.backgroundViewing || active.controlling) {
      throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    }
    return Object.freeze({ lease: active.lease, proofSequence: active.presentationProofSequence });
  }

  /** Exact fence for clipboard and other control-scoped asynchronous effects. */
  isControlCurrent(
    authority: RemoteDesktopAuthority,
    lease: string,
    controlGeneration: number
  ): boolean {
    if (!Number.isSafeInteger(controlGeneration) || controlGeneration < 1) return false;
    try {
      const active = this.#require(authority, lease);
      return !this.#displayModePending && active.controlling && active.controlGeneration === controlGeneration;
    } catch {
      return false;
    }
  }

  isClipboardSyncCurrent(authority: RemoteDesktopAuthority, lease: string,
    controlGeneration: number, syncGeneration: number): boolean {
    if (!Number.isSafeInteger(syncGeneration) || syncGeneration < 1
      || !this.isControlCurrent(authority, lease, controlGeneration)) return false;
    return this.#active?.clipboardSync === true && this.#active.syncGeneration === syncGeneration;
  }

  /** Route retirement may target only its exact captured authority. */
  stop(authority?: RemoteDesktopAuthority): void {
    if (authority !== undefined) {
      if (!validAuthority(authority)) return;
      if (this.#active !== undefined && !sameAuthority(this.#active.authority, authority)) {
        if (this.#startingPeer === peerKey(authority)) this.#startingPeer = undefined;
        return;
      }
      if (this.#active === undefined && this.#startingPeer !== peerKey(authority)
        && (this.#locking === undefined || !sameAuthority(this.#locking.authority, authority))) return;
    }
    this.#locking?.cancellation.abort();
    if (this.#active !== undefined) {
      this.#lastEnded = { peer: peerKey(this.#active.authority), lease: this.#active.lease };
      this.#clearHostMute(this.#active);
      if (this.#active.handoff) this.#dependencies.handoffEnded?.(this.#active.handoff, this.#active.authority);
    } else {
      for (const owner of this.#pendingMuteRestores) this.#queueMuteRestore(owner);
      for (const owner of this.#pendingPrivacyRestores) this.#queuePrivacyRestore(owner);
    }
    this.#controlGeneration += 1;
    this.#active = undefined;
    this.#dependencies.stopInput();
    this.#dependencies.stopVideo();
    this.#dependencies.changed();
    this.#viewerGeometryManaged = false;
    if (this.#viewerDisplay !== undefined || this.#originalResolution !== undefined || this.#displayWrite !== undefined) {
      void this.#restoreStoppedDisplay().catch(() => undefined);
    }
  }

  /** Explicit host-side Disconnect fences automatic resume for this controller. */
  stopByUser(): void {
    const target = this.#active === undefined
      ? this.#lastEnded
      : { peer: peerKey(this.#active.authority), lease: this.#active.lease };
    if (target !== undefined) this.#locallyStopped.set(target.peer, target.lease);
    this.stop();
  }

  /** Input failure is control-scoped: preserve the lease, picture and viewer. */
  async releaseControl(recoverInput = false): Promise<void> {
    const active = this.#active;
    if (active === undefined || (!active.controlling && !this.#inputStarting)) return;
    const recover = recoverInput && active.controlling && !this.#inputStarting && !this.#inputRecoveryUsed
      && !this.#starting && !this.#displayModePending && this.#displayRestoring === undefined && !active.backgroundViewing;
    if (recover) this.#inputRecoveryUsed = true;
    active.controlling = false;
    active.controlGeneration = ++this.#controlGeneration;
    const generation = active.controlGeneration;
    if (!recover) this.#clearHostMute(active);
    else {
      active.clipboardSync = false; active.syncGeneration = ++this.#syncGeneration;
      this.#dependencies.stopClipboardVersion?.(); this.#retireSystemActions();
    }
    this.#dependencies.stopInput();
    this.#dependencies.changed();
    if (!recover) return;
    try {
      await this.#awaitSafety();
      if (this.#active !== active || this.#starting || this.#displayModePending || active.controlGeneration !== generation) return;
      this.#require(active.authority, active.lease);
      await this.#control(active.authority, active, true, true);
    } catch {
      if (this.#active === active && !active.controlling) {
        this.#clearHostMute(active); this.#dependencies.changed();
        await this.#awaitSafety().catch(() => undefined);
      }
    }
  }

  /** Join exact captured safety cleanup after synchronous authority retirement. */
  async stopAndRestore(): Promise<void> {
    this.stop();
    await this.#lockPending;
    await Promise.all([this.#awaitSafety(), this.#restoreStoppedDisplay()]);
  }

  #restoreStoppedDisplay(terminalCurrent?: () => boolean): Promise<void> {
    if (this.#displayRestoring !== undefined) return this.#displayRestoring;
    if ((this.#active !== undefined && terminalCurrent?.() !== true) || (this.#viewerDisplay === undefined && this.#originalResolution === undefined
      && this.#displayWrite === undefined)) return Promise.resolve();
    const pending = (async () => {
      await this.#displayWrite?.catch(() => undefined);
      await this.#awaitSafety();
      await this.#dependencies.releaseInput?.();
      try {
        const viewer = this.#viewerDisplay;
        if (viewer !== undefined) {
          const current = () => (this.#active === undefined || terminalCurrent?.() === true) && this.#viewerDisplay === viewer;
          if (!current()) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
          if (viewer.handle === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
          viewer.handle.dispose();
          const restored = await viewer.handle.restore(current);
          if (!current()) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
          if (terminalCurrent?.() === true && this.#active !== undefined) {
            const actual = parseRemoteDesktopDisplay(restored);
            if (actual.id !== this.#active.sourceDisplayId) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
            this.#active.display = actual;
            this.#viewerGeometryManaged = true;
          }
          this.#viewerDisplay = undefined;
          this.#viewerDisplayRevision += 1;
          if (terminalCurrent?.() === true) this.#dependencies.changed();
        }
        const original = this.#originalResolution;
        if (original === undefined) return;
        const current = () => (this.#active === undefined || terminalCurrent?.() === true) && this.#originalResolution === original;
        if (!current()) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
        if ((await this.#dependencies.displayPresent?.(original.displayId)) !== false) {
          if (this.#dependencies.restoreDisplayMode === undefined) {
            throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
          }
          const restored = await this.#dependencies.restoreDisplayMode(original.displayId, original.modeId,
            current, original, original.authority);
          if (terminalCurrent?.() === true && this.#active !== undefined) {
            const result = restored ?? parseRemoteDesktopHostCapabilities(
              await this.#dependencies.capabilities(original.authority)).displays.find(display => display.id === original.displayId);
            if (!current() || result === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
            const actual = parseRemoteDesktopDisplay(result);
            if (actual.id !== this.#active.sourceDisplayId || actual.width !== original.width || actual.height !== original.height) {
              throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
            }
            this.#active.display = actual;
            this.#viewerGeometryManaged = true;
            this.#dependencies.changed();
          }
        } else if (terminalCurrent?.() === true) {
          throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
        }
        if (!current()) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
        this.#originalResolution = undefined;
      } catch { throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE"); }
    })();
    this.#displayRestoring = pending;
    void pending.finally(() => {
      if (this.#displayRestoring === pending) this.#displayRestoring = undefined;
    }).catch(() => undefined);
    return pending;
  }

  #enqueueSafety(operation: () => Promise<void>): Promise<void> {
    const result = this.#safetyTail.then(operation, operation);
    this.#safetyTail = result.catch(() => undefined);
    return result;
  }

  #clearHostMute(active: ActiveRemoteDesktopLease, retainPrivacy = false): void {
    this.#retireSystemActions();
    if (!retainPrivacy) this.#clearPrivacy(active);
    this.#stopClipboardSync(active);
    const owner = active.muteOwner;
    active.muteOwner = undefined;
    if (owner !== undefined && this.#dependencies.stopHostMute !== undefined) {
      this.#pendingMuteRestores.add(owner);
      this.#queueMuteRestore(owner);
    } else {
      for (const pending of this.#pendingMuteRestores) this.#queueMuteRestore(pending);
    }
  }

  #stopClipboardSync(active: ActiveRemoteDesktopLease): void {
    active.clipboardSync = false;
    active.syncGeneration = ++this.#syncGeneration;
    this.#dependencies.stopClipboardVersion?.();
  }

  #queueMuteRestore(owner: object): void {
    void this.#enqueueSafety(async () => {
      if (!this.#pendingMuteRestores.has(owner)) return;
      await this.#dependencies.stopHostMute!(owner);
      this.#pendingMuteRestores.delete(owner);
    }).catch(() => undefined);
  }

  async #awaitSafety(): Promise<void> {
    await this.#safetyTail;
    if (this.#systemActionNeedsDrain) this.#retireSystemActions();
    await this.#systemActionDrain;
    if (this.#pendingMuteRestores.size !== 0) throw new Error("REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE");
    if (this.#pendingPrivacyRestores.size !== 0) throw new Error("REMOTE_DESKTOP_PRIVACY_FAILED");
  }

  #clearPrivacy(active: ActiveRemoteDesktopLease): void {
    active.privacyRevision += 1;
    const owner = active.privacyOwner;
    active.privacyOwner = undefined;
    active.privacyLockOnExit = false;
    if (owner !== undefined) this.#pendingPrivacyRestores.add(owner);
    this.#privacyOperation = undefined;
    for (const pending of this.#pendingPrivacyRestores) this.#queuePrivacyRestore(pending);
  }

  #queuePrivacyRestore(owner: object): void {
    const pending = this.#privacyPending;
    void this.#enqueueSafety(async () => {
      await pending?.catch(() => undefined);
      if (!this.#pendingPrivacyRestores.has(owner)) return;
      await this.#dependencies.stopPrivacyScreen!(owner);
      this.#pendingPrivacyRestores.delete(owner);
    }).catch(() => undefined);
  }

  /** Called only by the exact mask's native physical-input confirmation. */
  async stopPrivacyByUser(owner: object): Promise<void> {
    this.tick();
    const active = this.#active;
    if (active === undefined || active.privacyOwner !== owner
      || !this.#authorityCurrent(active.authority)) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
    this.#locallyStopped.set(peerKey(active.authority), active.lease);
    if (active.privacyLockOnExit && active.lockOnExit) {
      const operation = this.#lockStop(active.authority, active, active.controlGeneration);
      this.#lockPending = operation.then(() => undefined, () => undefined);
      await operation;
    } else {
      this.stop(active.authority);
      await Promise.all([this.#awaitSafety(), this.#restoreStoppedDisplay()]);
    }
  }

  /** Entry used by the isolated capture renderer's ordered input DataChannel. */
  input(
    authority: RemoteDesktopAuthority,
    lease: string,
    sequence: number,
    events: unknown
  ): void {
    const request = parseRemoteDesktopRequest({ op: "input", lease, sequence, events });
    if (request.op !== "input") throw new Error("INVALID_REMOTE_DESKTOP_REQUEST");
    const active = this.#require(authority, lease);
    if (this.#displayModePending) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
    if (!active.controlling) throw new Error("REMOTE_DESKTOP_VIEW_ONLY");
    if (sequence <= active.sequence) return;
    active.sequence = sequence;
    if (active.handoff) {
      // DataChannel delivery is ordered, but source authority validation is
      // asynchronous. Recheck immediately before each native input batch.
      if (++this.#handoffInputPending > 64) { this.#handoffInputPending--; this.stop(authority); return; }
      this.#handoffInputTail = this.#handoffInputTail.then(async () => {
        await this.#ensureHandoff(active);
        if (this.#active !== active || !active.controlling) return;
        this.#dependencies.input(request.events, authority);
      }).catch(() => { if (this.#active === active) this.stop(authority); }).finally(() => { this.#handoffInputPending--; });
      return;
    }
    try {
      this.#dependencies.input(request.events, authority);
      this.#inputRecoveryUsed = false;
    } catch (error) {
      void this.releaseControl();
      throw error;
    }
  }

  async request(authority: RemoteDesktopAuthority, raw: unknown): Promise<unknown> {
    const request = parseRemoteDesktopRequest(raw);
    this.#assertAuthority(authority);
    this.tick();
    if (request.op === "capabilities") {
      const viewer = this.#viewerDisplay;
      const viewerRevision = this.#viewerDisplayRevision;
      const displayId = viewer?.handle?.displayId;
      const capabilities = parseRemoteDesktopHostCapabilities(await this.#runChecked(
        authority,
        undefined,
        () => this.#dependencies.capabilities(authority)
      ));
      if (this.#viewerDisplayRevision !== viewerRevision || this.#viewerDisplay !== viewer
        || viewer?.handle?.displayId !== displayId) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
      return Object.freeze({
        ...capabilities,
        displays: Object.freeze(capabilities.displays.filter(display => display.id === viewer?.sourceDisplayId || display.id !== displayId)),
        automaticReconnect: true,
        connectionTakeover: true,
        autoControl: capabilities.canControl,
        webrtcVideo: true,
        trickleIce: true,
        jpegFallback: true
      } satisfies RemoteDesktopCapabilities);
    }
    if (request.op === "permissions") {
      if (this.#dependencies.permissions === undefined) {
        throw new Error("REMOTE_DESKTOP_PERMISSIONS_UNAVAILABLE");
      }
      const permissions = parseRemoteDesktopPermissions(await this.#runChecked(
        authority,
        undefined,
        () => this.#dependencies.permissions!(request.action, authority)
      ));
      return permissions;
    }
    if (request.op === "start") {
      const lease = await this.#start(authority, request);
      const active = this.#active;
      return request.control && active?.lease === lease.lease
        ? this.#withControl(authority, active) : lease;
    }
    if (request.op === "systemAction"
      && !this.isControlCurrent(authority, request.lease, request.controlGeneration)) throw new Error("REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED");
    if (request.op === "privacyScreen"
      && !this.isControlCurrent(authority, request.lease, request.controlGeneration)) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
    if (request.op === "hostMute"
      && !this.isControlCurrent(authority, request.lease, request.controlGeneration)) {
      throw new Error("REMOTE_DESKTOP_HOST_MUTE_EXPIRED");
    }
    let active: ActiveRemoteDesktopLease;
    try { active = this.#require(authority, request.lease); }
    catch (error) {
      if (request.op === "stop" && request.lockScreen) throw new Error("REMOTE_DESKTOP_LOCK_EXPIRED");
      throw error;
    }
    if (active.handoff) {
      await this.#ensureHandoff(active);
      if (!["stop", "heartbeat", "control", "presentation", "input", "offer", "ice", "frame"].includes(request.op)
        || request.op === "stop" && request.lockScreen
        || request.op === "offer" && request.settings?.audio) throw new Error("REMOTE_DESKTOP_HANDOFF_UNAVAILABLE");
    }
    if (this.#displayModePending && request.op !== "stop" && request.op !== "heartbeat") {
      throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
    }
    switch (request.op) {
      case "stop":
        if (request.lockScreen) {
          if (this.#locking !== undefined) throw new Error("REMOTE_DESKTOP_BUSY");
          const operation = this.#lockStop(authority, active, request.controlGeneration);
          const settled = operation.then(() => undefined, () => undefined);
          this.#lockPending = settled;
          void settled.then(() => { if (this.#lockPending === settled) this.#lockPending = undefined; });
          return operation;
        }
        this.stop(authority);
        await Promise.all([this.#awaitSafety(), this.#restoreStoppedDisplay()]);
        return Object.freeze({ ok: true });
      case "heartbeat":
        active.expiresAt = this.#now() + REMOTE_DESKTOP_LEASE_MS;
        return Object.freeze({
          controlling: active.controlling,
          controlGeneration: active.controlGeneration
        });
      case "control":
        return this.#control(authority, active, request.enabled);
      case "presentation":
        return this.#presentation(active, request.enabled);
      case "hostMute":
        return this.#hostMute(authority, active, request.controlGeneration, request.enabled);
      case "systemAction":
        return this.#systemAction(authority, active, request.controlGeneration, request.action);
      case "privacyScreen":
        return this.#privacy(authority, active, request.controlGeneration, request.enabled, request.lockOnExit);
      case "clipboardSync": {
        if (!this.isControlCurrent(authority, active.lease, request.controlGeneration)) {
          throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
        }
        if (!active.clipboardSyncAvailable || this.#dependencies.clipboardVersion === undefined) {
          throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
        }
        if (active.clipboardSync !== request.enabled) active.syncGeneration = ++this.#syncGeneration;
        active.clipboardSync = request.enabled;
        if (!request.enabled) this.#dependencies.stopClipboardVersion?.();
        this.#dependencies.changed();
        return Object.freeze({ enabled: request.enabled, syncGeneration: active.syncGeneration });
      }
      case "clipboardVersion": {
        const current = (): boolean => this.isClipboardSyncCurrent(authority, active.lease,
          request.controlGeneration, request.syncGeneration);
        if (!current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
        if (this.#dependencies.clipboardVersion === undefined) throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
        const version = await this.#dependencies.clipboardVersion(current, authority);
        if (!current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
        if (!isRemoteDesktopClipboardVersion(version)) throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
        return Object.freeze({ version });
      }
      case "input":
        this.input(authority, request.lease, request.sequence, request.events);
        return Object.freeze({ ok: true });
      case "frame":
        if (request.cursorOverlay && !active.cursorOverlay) {
          throw new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE");
        }
        return this.#frame(authority, active, request.cursorOverlay);
      case "displayModes":
        if (!active.displayModes) throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
        return this.#displayModes(authority, active);
      case "viewerDisplay":
        if (!active.viewerDisplay) throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
        return this.#changeViewerDisplay(authority, active, request.controlGeneration, request, request.control === true);
      case "restoreViewerDisplay":
        if (!active.viewerDisplayRestore) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
        return this.#changeViewerDisplay(authority, active, request.controlGeneration, undefined, request.control === true);
      case "resolution":
        if (this.#locking !== undefined) throw new Error("REMOTE_DESKTOP_BUSY");
        if (!active.displayModes) throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
        return this.#setDisplayMode(
          authority,
          active,
          request.controlGeneration,
          request.modeId,
          request.temporary,
          request.control === true
        );
      case "offer": {
        if (request.cursorOverlay && !active.cursorOverlay) {
          throw new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE");
        }
        const answer = await this.#runChecked(
          authority,
          active,
          () => this.#dependencies.offer(
            leaseView(active),
            request.sdp,
            request.attemptId,
            request.settings,
            request.cursorOverlay,
            authority,
            request.iceServers
          )
        );
        if (typeof answer !== "string" || answer.length < 1 || answer.length > 64_000) {
          throw new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE");
        }
        return Object.freeze({ sdp: answer });
      }
      case "ice": {
        if (this.#dependencies.ice === undefined) throw new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE");
        const reply = parseRemoteDesktopIceReply(await this.#runChecked(
          authority,
          active,
          () => this.#dependencies.ice!(request, authority)
        ));
        if (reply.attemptId !== request.attemptId
          || reply.next !== request.after + reply.candidates.length) {
          throw new Error("REMOTE_DESKTOP_VIDEO_STOPPED");
        }
        return reply;
      }
      default:
        return assertNever(request);
    }
  }

  async #start(
    authority: RemoteDesktopAuthority,
    request: Extract<ReturnType<typeof parseRemoteDesktopRequest>, { readonly op: "start" }>
  ): Promise<RemoteDesktopLease> {
    const authenticationSession = this.#requireAuthentication(authority);
    const peer = peerKey(authority);
    if (request.inputHandoffRequestId !== undefined && (!this.#dependencies.handoffWindow || !this.#dependencies.handoffCurrent)) throw new Error("REMOTE_DESKTOP_HANDOFF_UNAVAILABLE");
    if (this.#locking !== undefined) throw new Error("REMOTE_DESKTOP_BUSY");
    if (request.resume === true && this.#locallyStopped.has(peer)) {
      throw new Error("REMOTE_DESKTOP_STOPPED");
    }
    const resumesActive = request.resume === true
      && this.#active !== undefined
      && sameAuthority(this.#active.authority, authority)
      && (request.inputHandoffRequestId === undefined ? !this.#active.handoff && this.#active.sourceDisplayId === request.displayId
        : this.#active.handoff?.requestId === request.inputHandoffRequestId);
    if (this.#displayModePending && request.takeover !== true) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
    if (this.#starting
      || (this.#active !== undefined && request.takeover !== true && !resumesActive)) {
      throw new Error("REMOTE_DESKTOP_BUSY");
    }
    this.#starting = true;
    this.#startingPeer = peer;
    let generation = this.#controlGeneration;
    try {
      if (this.#displayModePending && request.takeover === true) {
        this.stopByUser();
        await this.#displayWrite?.catch(() => undefined);
      }
      if (this.#active === undefined) {
        await this.#restoreStoppedDisplay();
        this.#assertAuthority(authority);
        if (this.#startingPeer !== peer) throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
        generation = this.#controlGeneration;
      }
      let capabilities = parseRemoteDesktopHostCapabilities(await this.#runChecked(
        authority,
        undefined,
        () => this.#dependencies.capabilities(authority)
      ));
      if (!capabilities.enabled) throw new Error("REMOTE_DESKTOP_DISABLED");
      const handoff = request.inputHandoffRequestId === undefined ? undefined
        : await this.#runChecked(authority, undefined, () => this.#dependencies.handoffWindow!(request.inputHandoffRequestId!, authority)) ?? undefined;
      if (request.inputHandoffRequestId !== undefined && (!handoff || capabilities.platform !== "darwin"
        || handoff.requestId !== request.inputHandoffRequestId || !Number.isSafeInteger(handoff.windowId) || handoff.windowId < 1
        || !Number.isSafeInteger(handoff.pid) || handoff.pid < 1 || ![handoff.width, handoff.height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 32_768))) throw new Error("REMOTE_DESKTOP_HANDOFF_UNAVAILABLE");
      const displayId = handoff?.displayId ?? request.displayId;
      let display = capabilities.displays.find((candidate) => candidate.id === displayId);
      if (display === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_MISSING");
      if (this.#startingPeer !== peer || generation !== this.#controlGeneration) {
        throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
      }
      if (!remoteDesktopPermissionReady(capabilities.permissions.screenRecording)) {
        throw new Error("REMOTE_DESKTOP_SCREEN_PERMISSION_REQUIRED");
      }
      if (request.resume === true && this.#locallyStopped.has(peer)) {
        throw new Error("REMOTE_DESKTOP_STOPPED");
      }
      if (request.takeover === true && this.#active !== undefined) this.stopByUser();
      else if (resumesActive) this.stop(authority);
      if (this.#viewerDisplay !== undefined || this.#originalResolution !== undefined || this.#displayRestoring !== undefined) {
        await this.#restoreStoppedDisplay();
        capabilities = parseRemoteDesktopHostCapabilities(await this.#runChecked(
          authority, undefined, () => this.#dependencies.capabilities(authority)));
        if (this.#startingPeer !== peer) throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
        display = capabilities.displays.find((candidate) => candidate.id === displayId);
        if (display === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_MISSING");
      }
      if (this.#dependencies.prepare !== undefined) {
        await Promise.all([this.#awaitSafety(), this.#restoreStoppedDisplay()]);
        const prepareGeneration = this.#controlGeneration;
        const current = (): boolean => this.#active === undefined && this.#startingPeer === peer
          && prepareGeneration === this.#controlGeneration && this.#authorityCurrent(authority)
          && this.#authenticationSession(authority) === authenticationSession;
        if (!current()) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        await this.#runChecked(authority, undefined, () => this.#dependencies.prepare!(current, authority));
        if (!current()) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        capabilities = parseRemoteDesktopHostCapabilities(await this.#runChecked(
          authority, undefined, () => this.#dependencies.capabilities(authority)));
        if (!current()) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        if (!capabilities.enabled) throw new Error("REMOTE_DESKTOP_DISABLED");
        if (!remoteDesktopPermissionReady(capabilities.permissions.screenRecording)) {
          throw new Error("REMOTE_DESKTOP_SCREEN_PERMISSION_REQUIRED");
        }
        display = capabilities.displays.find(candidate => candidate.id === displayId);
        if (display === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_MISSING");
      }
      if (this.#requireAuthentication(authority) !== authenticationSession) {
        throw new Error("REMOTE_DESKTOP_AUTHENTICATION_REQUIRED");
      }
      if (request.resume !== true) this.#locallyStopped.delete(peer);
      const lease: ActiveRemoteDesktopLease = {
        lease: this.#createLeaseId(),
        platform: capabilities.platform,
        sourceDisplayId: display.id,
        display: Object.freeze({ ...display, ...(handoff ? { width: handoff.width, height: handoff.height, name: handoff.app } : {}) }),
        ...(handoff ? { handoff } : {}),
        canControl: capabilities.canControl,
        displayModes: !handoff && capabilities.displayModes,
        resolutionRestore: !handoff && capabilities.resolutionRestore,
        viewerDisplay: !handoff && capabilities.viewerDisplay,
        viewerDisplayRestore: !handoff && capabilities.viewerDisplayRestore,
        cursorOverlay: handoff ? true : capabilities.cursorOverlay,
        hostMute: !handoff && capabilities.hostMute,
        lockOnExit: !handoff && capabilities.lockOnExit,
        clipboardSyncAvailable: !handoff && capabilities.clipboardSync,
        privacyScreen: !handoff && capabilities.privacyScreen,
        workspaceNavigation: !handoff && capabilities.workspaceNavigation,
        systemMenu: !handoff && capabilities.systemMenu,
        privacyLockOnExit: false,
        privacyRevision: 0,
        clipboardSync: false,
        syncGeneration: ++this.#syncGeneration,
        controlling: false,
        controlGeneration: ++this.#controlGeneration,
        authority: Object.freeze({ ...authority }),
        authenticationSession,
        expiresAt: this.#now() + REMOTE_DESKTOP_LEASE_MS,
        sequence: -1,
        backgroundViewing: false,
        presentationProofSequence: 0
      };
      this.#active = lease;
      this.#viewerGeometryManaged = false;
      this.#dependencies.changed();
      return leaseView(lease);
    } finally {
      this.#starting = false;
      this.#startingPeer = undefined;
    }
  }

  async #presentation(
    active: ActiveRemoteDesktopLease,
    enabled: boolean
  ): Promise<{ readonly controlling: boolean; readonly controlGeneration: number }> {
    active.backgroundViewing = enabled;
    if (enabled) {
      active.controlling = false;
      active.controlGeneration = ++this.#controlGeneration;
      this.#retireSystemActions();
      this.#stopClipboardSync(active);
      this.#dependencies.stopInput();
    }
    this.#dependencies.changed();
    await this.#awaitSafety();
    this.#revalidateAsyncCompletion(active.authority, active);
    return Object.freeze({
      controlling: active.controlling,
      controlGeneration: active.controlGeneration
    });
  }

  async #control(
    authority: RemoteDesktopAuthority,
    active: ActiveRemoteDesktopLease,
    enabled: boolean,
    recovering = false
  ): Promise<{ readonly controlling: boolean; readonly controlGeneration: number }> {
    if (this.#locking !== undefined) throw new Error("REMOTE_DESKTOP_BUSY");
    if (enabled && !active.canControl) throw new Error("REMOTE_DESKTOP_VIEW_ONLY");
    if (enabled && this.#inputStarting) throw new Error("REMOTE_DESKTOP_INPUT_BUSY");
    if (!recovering) this.#inputRecoveryUsed = false;
    if (enabled) active.backgroundViewing = false;
    const generation = ++this.#controlGeneration;
    active.controlGeneration = generation;
    if (!recovering) {
      if (enabled) { this.#retireSystemActions(); this.#stopClipboardSync(active); }
      else this.#clearHostMute(active);
    }
    if (enabled) {
      await this.#awaitSafety();
      this.#revalidateAsyncCompletion(authority, active);
      if (generation !== active.controlGeneration) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    }
    if (!enabled) {
      active.controlling = false;
      this.#dependencies.stopInput();
      this.#dependencies.changed();
      await this.#awaitSafety();
      this.#revalidateAsyncCompletion(authority, active);
      return Object.freeze({ controlling: false, controlGeneration: active.controlGeneration });
    }
    if (!active.controlling) {
      this.#inputStarting = true;
      try {
        await this.#runChecked(
          authority,
          active,
          () => active.handoff ? this.#dependencies.startInput(active.display.id, authority, active.handoff)
            : this.#dependencies.startInput(active.display.id, authority)
        );
        if (generation !== this.#controlGeneration || this.#active !== active) {
          throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        }
        active.controlling = true;
      } catch (error) {
        if (this.#active === active && generation === this.#controlGeneration) {
          this.#dependencies.stopInput();
          active.controlling = false;
          if (!recovering) {
            this.#clearHostMute(active);
            await this.#awaitSafety();
          }
          this.#dependencies.changed();
        }
        throw error;
      } finally {
        this.#inputStarting = false;
      }
    }
    this.#dependencies.changed();
    return Object.freeze({
      controlling: active.controlling,
      controlGeneration: active.controlGeneration
    });
  }

  /** An input refusal retains the picture; revoked/replaced authority never does. */
  async #withControl(authority: RemoteDesktopAuthority, active: ActiveRemoteDesktopLease): Promise<RemoteDesktopLease> {
    try { await this.#control(authority, active, true); }
    catch (error) {
      if (this.#active !== active) throw error;
      this.#revalidateAsyncCompletion(authority, active);
    }
    return leaseView(active);
  }

  #retireSystemActions(): void {
    if (this.#dependencies.stopWorkspaceActions === undefined) return;
    this.#systemActionNeedsDrain = true;
    if (this.#systemActionDrain !== undefined) return;
    let native: Promise<void>;
    try { native = this.#dependencies.stopWorkspaceActions(); }
    catch { native = Promise.reject(new Error("REMOTE_DESKTOP_SYSTEM_ACTION_UNAVAILABLE")); }
    const operation = Promise.all([this.#systemActionTail, native]).then(() => {
      this.#systemActionNeedsDrain = false;
    });
    this.#systemActionDrain = operation;
    void operation.finally(() => {
      if (this.#systemActionDrain === operation) this.#systemActionDrain = undefined;
    }).catch(() => undefined);
  }

  async #systemAction(authority: RemoteDesktopAuthority, active: ActiveRemoteDesktopLease,
    generation: number, action: RemoteDesktopSystemAction): Promise<{ readonly action: RemoteDesktopSystemAction }> {
    if (!active.workspaceNavigation || (action === "systemMenu" && !active.systemMenu)
      || this.#dependencies.workspaceAction === undefined || this.#dependencies.stopWorkspaceActions === undefined) {
      throw new Error("REMOTE_DESKTOP_SYSTEM_ACTION_UNAVAILABLE");
    }
    const current = (): boolean => this.isControlCurrent(authority, active.lease, generation)
      && this.#active === active;
    if (!current()) throw new Error("REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED");
    if (this.#systemActionNeedsDrain) this.#retireSystemActions();
    const drain = this.#systemActionDrain;
    const operation = this.#systemActionTail.then(async () => {
      await drain;
      if (!current()) throw new Error("REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED");
      await this.#dependencies.workspaceAction!(action, active.display.id, current, authority);
      if (!current()) throw new Error("REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED");
    });
    this.#systemActionTail = operation.catch(() => undefined);
    await operation;
    return Object.freeze({ action });
  }

  async #hostMute(authority: RemoteDesktopAuthority, active: ActiveRemoteDesktopLease,
    controlGeneration: number, enabled: boolean): Promise<{ readonly enabled: boolean }> {
    if (!active.hostMute || this.#dependencies.hostMute === undefined
      || this.#dependencies.stopHostMute === undefined) throw new Error("REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE");
    const current = (): boolean => this.isControlCurrent(authority, active.lease, controlGeneration);
    if (!current()) throw new Error("REMOTE_DESKTOP_HOST_MUTE_EXPIRED");
    const owner = active.muteOwner ??= Object.freeze({});
    await this.#enqueueSafety(async () => {
      if (!current()) throw new Error("REMOTE_DESKTOP_HOST_MUTE_EXPIRED");
      for (const pending of this.#pendingMuteRestores) {
        await this.#dependencies.stopHostMute!(pending);
        this.#pendingMuteRestores.delete(pending);
      }
      try {
        if (!current()) throw new Error("REMOTE_DESKTOP_HOST_MUTE_EXPIRED");
        await this.#dependencies.hostMute!(owner, enabled, current, authority);
        if (!current()) throw new Error("REMOTE_DESKTOP_HOST_MUTE_EXPIRED");
      } catch (error) {
        // A rejected native write may already have changed output. Restore only
        // this occurrence; replacement viewers and voice own different tokens.
        this.#pendingMuteRestores.add(owner);
        try {
          await this.#dependencies.stopHostMute!(owner);
          this.#pendingMuteRestores.delete(owner);
        } catch {
          throw new Error("REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE");
        }
        throw error;
      }
      if (!enabled && active.muteOwner === owner) active.muteOwner = undefined;
    });
    return Object.freeze({ enabled });
  }

  async #privacy(authority: RemoteDesktopAuthority, active: ActiveRemoteDesktopLease,
    controlGeneration: number, enabled: boolean, lockOnExit: boolean): Promise<{ readonly enabled: boolean }> {
    const controlCurrent = (): boolean => this.isControlCurrent(authority, active.lease, controlGeneration);
    if (!controlCurrent()) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
    if (!active.privacyScreen || this.#dependencies.privacyScreen === undefined
      || this.#dependencies.stopPrivacyScreen === undefined) throw new Error("REMOTE_DESKTOP_PRIVACY_UNAVAILABLE");
    if (this.#inputStarting) throw new Error("REMOTE_DESKTOP_PRIVACY_FAILED");
    const revision = ++active.privacyRevision;
    if (!enabled) {
      this.#clearPrivacy(active);
      const offRevision = active.privacyRevision;
      await this.#awaitSafety();
      if (!controlCurrent() || active.privacyRevision !== offRevision) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
      if (this.#dependencies.resumeInputAfterPrivacy !== undefined) {
        this.#inputStarting = true;
        const current = (): boolean => controlCurrent() && active.privacyRevision === offRevision;
        try {
          await this.#runChecked(authority, active, () => this.#dependencies.resumeInputAfterPrivacy!(
            active.display.id, current, authority));
          if (!current()) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
        } catch (error) {
          if (current()) {
            this.#dependencies.stopInput();
            active.controlling = false;
            active.controlGeneration = ++this.#controlGeneration;
            this.#clearHostMute(active);
            this.#dependencies.changed();
            throw new Error("REMOTE_DESKTOP_PRIVACY_FAILED");
          }
          throw error;
        } finally { this.#inputStarting = false; }
      }
      return Object.freeze({ enabled: false });
    }
    let owner = active.privacyOwner;
    let operation = this.#privacyOperation;
    if (owner === undefined || operation?.owner !== owner) {
      if (this.#privacyPending !== undefined) throw new Error("REMOTE_DESKTOP_PRIVACY_FAILED");
      owner = Object.freeze({});
      active.privacyOwner = owner;
      const captured = owner;
      const current = (): boolean => {
        this.tick();
        return this.#active === active && this.#authorityCurrent(authority)
          && this.#authenticationCurrent(active) && active.privacyOwner === captured;
      };
      const promise = (async () => {
        await this.#awaitSafety();
        if (!current()) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
        await this.#dependencies.privacyScreen!(captured, active.display.id, current, authority);
        if (!current()) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
      })();
      operation = { owner: captured, promise };
      this.#privacyOperation = operation;
      const pending = promise.then(() => undefined, () => undefined);
      this.#privacyPending = pending;
      void pending.then(() => { if (this.#privacyPending === pending) this.#privacyPending = undefined; });
    }
    const captured = owner;
    const leaseCurrent = (): boolean => {
      this.tick();
      return this.#active === active && this.#authorityCurrent(authority) && this.#authenticationCurrent(active);
    };
    try {
      await operation.promise;
      if (!leaseCurrent() || active.privacyOwner !== captured) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
      if (active.privacyRevision === revision) active.privacyLockOnExit = lockOnExit && active.lockOnExit;
      return Object.freeze({ enabled: true });
    } catch (error) {
      if (active.privacyOwner === captured) this.#clearPrivacy(active);
      await this.#awaitSafety();
      if (!leaseCurrent()) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
      throw error;
    }
  }

  async #lockStop(authority: RemoteDesktopAuthority, active: ActiveRemoteDesktopLease,
    controlGeneration: number): Promise<{ readonly ok: true }> {
    if (active.controlGeneration !== controlGeneration) throw new Error("REMOTE_DESKTOP_LOCK_EXPIRED");
    if (!active.lockOnExit || this.#dependencies.lockScreen === undefined
      || this.#dependencies.releaseInput === undefined) throw new Error("REMOTE_DESKTOP_LOCK_UNAVAILABLE");
    if (this.#starting) throw new Error("REMOTE_DESKTOP_BUSY");
    active.controlling = false;
    active.controlGeneration = ++this.#controlGeneration;
    const ending = { active, authority, cancellation: new AbortController(), controlGeneration: active.controlGeneration };
    this.#locking = ending;
    this.#clearHostMute(active, true);
    this.#dependencies.stopInput();
    this.#dependencies.changed();
    const current = (): boolean => {
      this.tick();
      return this.#locking === ending && this.#active === active
        && !ending.cancellation.signal.aborted && this.#authorityCurrent(authority)
        && active.controlGeneration === ending.controlGeneration;
    };
    const check = (): void => {
      if (!current()) throw new Error("REMOTE_DESKTOP_LOCK_EXPIRED");
    };
    try {
      await this.#awaitSafety();
      check();
      await this.#dependencies.releaseInput();
      check();
      this.#dependencies.stopVideo();
      await this.#restoreStoppedDisplay(current);
      check();
      await this.#dependencies.lockScreen(current, ending.cancellation.signal, authority);
      check();
      return Object.freeze({ ok: true });
    } catch (error) {
      check();
      throw error;
    } finally {
      // The captured lease is terminal even if native lock fails. Never retire
      // a replacement helper or replay a lock against an ended authority.
      if (this.#active === active) this.stop(authority);
      try { await Promise.all([this.#awaitSafety(), this.#restoreStoppedDisplay()]); }
      finally { if (this.#locking === ending) this.#locking = undefined; }
    }
  }

  async #frame(
    authority: RemoteDesktopAuthority,
    active: ActiveRemoteDesktopLease,
    cursorOverlay: boolean
  ): Promise<{
    readonly jpeg: string | null;
    readonly cursor?: RemoteDesktopJpegFrame["cursor"];
  }> {
    if (this.#framePending || this.#now() - this.#lastFrameAt < REMOTE_DESKTOP_FRAME_INTERVAL_MS) {
      return Object.freeze({ jpeg: null });
    }
    this.#framePending = true;
    this.#lastFrameAt = this.#now();
    const display = active.display;
    try {
      const frame = await this.#runChecked(
        authority,
        active,
        () => this.#dependencies.frame({ displayId: active.display.id, leaseId: active.lease,
          cursorOverlay, current: () => this.#active === active && active.display === display && this.#authorityCurrent(authority)
            && this.#authenticationCurrent(active) }, authority)
      );
      if (frame === null || !isBoundedRemoteDesktopJpegFrame(frame)) {
        return Object.freeze({ jpeg: null });
      }
      return Object.freeze({
        jpeg: frame.jpeg,
        ...(frame.cursor === undefined ? {} : {
          cursor: frame.cursor === null ? null : Object.freeze({ ...frame.cursor })
        })
      });
    } finally {
      this.#framePending = false;
    }
  }

  async #displayModes(
    authority: RemoteDesktopAuthority,
    active: ActiveRemoteDesktopLease
  ): Promise<readonly RemoteDesktopDisplayMode[]> {
    if (this.#dependencies.displayModes === undefined) {
      throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    }
    return parseRemoteDesktopDisplayModes(await this.#runChecked(
      authority,
      active,
      () => this.#dependencies.displayModes!(active.sourceDisplayId, authority)
    ));
  }

  async #setDisplayMode(
    authority: RemoteDesktopAuthority,
    active: ActiveRemoteDesktopLease,
    controlGeneration: number,
    modeId: string,
    temporary: boolean,
    control = false
  ): Promise<{ readonly lease?: RemoteDesktopLease }> {
    if (!active.controlling) throw new Error("REMOTE_DESKTOP_VIEW_ONLY");
    if (active.controlGeneration !== controlGeneration) {
      throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    }
    if (this.#dependencies.displayModes === undefined || this.#dependencies.setDisplayMode === undefined) {
      throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    }
    if (this.#displayModePending) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
    if (temporary && (!active.resolutionRestore || this.#dependencies.restoreDisplayMode === undefined)) {
      throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    }
    this.#displayModePending = true;
    let committed = false;
    let prepared = false;
    try {
      // The physical source is immutable. Remove its owned mirror before
      // enumerating or writing modes, and retain release responsibility on failure.
      const viewer = this.#viewerDisplay;
      if (viewer !== undefined) {
        if (viewer.handle === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
        this.#dependencies.stopInput(); this.#dependencies.stopVideo(); prepared = true;
        this.#clearHostMute(active); await this.#awaitSafety(); await this.#dependencies.releaseInput?.();
        const current = () => this.#active === active && active.controlling
          && active.controlGeneration === controlGeneration && this.#authorityCurrent(authority) && this.#viewerDisplay === viewer;
        if (!current()) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        const restore = Promise.resolve().then(() => viewer.handle!.restore(current));
        this.#displayWrite = restore.then(() => undefined, () => undefined);
        let actual: RemoteDesktopLease["display"];
        try { actual = parseRemoteDesktopDisplay(await restore); }
        catch { throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE"); }
        if (!current()) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        if (actual.id !== active.sourceDisplayId) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
        this.#viewerDisplay = undefined; this.#viewerDisplayRevision += 1; active.display = actual;
      }
      const modes = await this.#displayModes(authority, active);
      const selected = modes.find((mode) => mode.id === modeId);
      if (selected === undefined) {
        throw new Error("REMOTE_DESKTOP_DISPLAY_MODE_MISSING");
      }
      if (temporary) {
        const original = modes.find((mode) => mode.current);
        if (original === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_MODE_MISSING");
        this.#dependencies.stopInput();
        this.#dependencies.stopVideo();
        prepared = true;
        this.#clearHostMute(active);
        await this.#awaitSafety();
        await this.#dependencies.releaseInput?.();
        this.#revalidateAsyncCompletion(authority, active);
        if (!active.controlling || active.controlGeneration !== controlGeneration) {
          throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        }
        this.#originalResolution ??= Object.freeze({ displayId: active.sourceDisplayId,
          modeId: original.id, width: original.width, height: original.height, authority: active.authority });
        const current = () => {
          this.tick();
          if (this.#active !== active || !active.controlling
            || active.controlGeneration !== controlGeneration || !this.#authorityCurrent(authority)) {
            throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
          }
        };
        const write = Promise.resolve().then(() => this.#dependencies.setDisplayMode!(
          active.sourceDisplayId, modeId, current, authority, { width: selected.width, height: selected.height,
            current: () => { try { current(); return true; } catch { return false; } } }));
        this.#displayWrite = write.then(() => undefined, () => undefined);
        let actual: RemoteDesktopLease["display"] | void;
        try { actual = await write; }
        catch (error) {
          if (this.#active === active) this.stop(authority);
          throw error;
        }
        current();
        const display = parseRemoteDesktopDisplay(actual);
        if (display.id !== active.sourceDisplayId || display.width !== selected.width || display.height !== selected.height) {
          this.stop(authority);
          throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
        }
        active.display = display;
        this.#viewerGeometryManaged = true;
        active.controlling = false;
        active.controlGeneration = ++this.#controlGeneration;
        this.#dependencies.changed();
        return Object.freeze({ lease: control ? await this.#withControl(authority, active) : leaseView(active) });
      }
      if (this.#originalResolution !== undefined) {
        const original = this.#originalResolution;
        this.#dependencies.stopInput();
        this.#dependencies.stopVideo();
        prepared = true;
        this.#clearHostMute(active);
        await this.#awaitSafety();
        await this.#dependencies.releaseInput?.();
        const current = () => this.#active === active && active.controlling
          && active.controlGeneration === controlGeneration && this.#authorityCurrent(authority)
          && this.#originalResolution === original;
        const restore = Promise.resolve().then(() => this.#dependencies.restoreDisplayMode!(
          original.displayId, original.modeId, current, original, original.authority));
        this.#displayWrite = restore.then(() => undefined, () => undefined);
        try { await restore; }
        catch { throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE"); }
        if (!current()) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        this.#originalResolution = undefined;
      }
      const beforeChange = async () => {
        if (committed) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
        this.tick();
        if (this.#active !== active
          || !active.controlling
          || active.controlGeneration !== controlGeneration
          || !this.#authorityCurrent(authority)) {
          throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        }
        committed = true;
        // Geometry, video and input all belong to this lease. Retire it before
        // the native write. New starts remain fenced until the effect settles.
        this.stop(authority);
        await this.#awaitSafety();
        await this.#dependencies.releaseInput?.();
      };
      try {
        const write = Promise.resolve().then(() => this.#dependencies.setDisplayMode!(
          active.sourceDisplayId, modeId, beforeChange, authority, { width: selected.width, height: selected.height,
            current: () => this.#authorityCurrent(authority) && (committed
              ? this.#active === undefined
              : this.#active === active && active.controlling && active.controlGeneration === controlGeneration) }));
        this.#displayWrite = write.then(() => undefined, () => undefined);
        await write;
      } catch (error) {
        // Once beforeChange retires the coordinate/media authority, no native
        // error can prove that the geometry write did not happen.
        if (committed) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        throw error;
      }
      if (!committed) throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
      return Object.freeze({});
    } catch (error) {
      if (prepared) {
        if (this.#active === active) this.stop(authority);
        if (error instanceof Error && error.message === "REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE") throw error;
        // Once old native owners are drained, a write or geometry receipt may
        // already have changed the display. Never project a pre-effect reason.
        throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
      }
      throw error;
    } finally {
      this.#displayModePending = false;
      this.#displayWrite = undefined;
    }
  }

  async #changeViewerDisplay(
    authority: RemoteDesktopAuthority,
    active: ActiveRemoteDesktopLease,
    controlGeneration: number,
    fit?: { readonly width: number; readonly height: number },
    control = false
  ): Promise<{ readonly lease: RemoteDesktopLease }> {
    if (!active.controlling) throw new Error("REMOTE_DESKTOP_VIEW_ONLY");
    if (active.controlGeneration !== controlGeneration) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    if (this.#displayModePending || this.#inputStarting || this.#locking !== undefined || this.#starting) {
      throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
    }
    if (fit !== undefined && this.#dependencies.createViewerDisplay === undefined) {
      throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    }
    this.#displayModePending = true;
    const current = () => {
      this.tick();
      return this.#active === active && active.controlling && active.controlGeneration === controlGeneration
        && this.#authorityCurrent(authority) && this.#authenticationCurrent(active);
    };
    const requireCurrent = () => { if (!current()) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED"); };
    const leaseCurrent = () => {
      this.tick();
      return this.#active === active && this.#authorityCurrent(authority) && this.#authenticationCurrent(active);
    };
    const write = Promise.resolve().then(async () => {
      this.#dependencies.stopInput(); this.#dependencies.stopVideo();
      this.#clearHostMute(active); await this.#awaitSafety(); requireCurrent();
      await this.#dependencies.releaseInput?.(); requireCurrent();
      let display: RemoteDesktopLease["display"];
      if (fit !== undefined) {
        let viewer = this.#viewerDisplay;
        if (viewer === undefined) {
          viewer = { sourceDisplayId: active.sourceDisplayId };
          this.#viewerDisplay = viewer;
          this.#viewerDisplayRevision += 1;
          const captured = viewer;
          try {
            // Own the occurrence before native creation. A late handle belongs
            // to stopped cleanup, never to a replacement lease.
            viewer.handle = await this.#dependencies.createViewerDisplay!(active.sourceDisplayId, leaseCurrent, () => {
              if (this.#viewerDisplay === captured && this.#active === active) this.stop(authority);
            }, authority);
          } catch (error) {
            if (this.#viewerDisplay === captured && captured.handle === undefined) {
              this.#viewerDisplay = undefined; this.#viewerDisplayRevision += 1;
            }
            throw error;
          }
          requireCurrent();
        }
        if (viewer.handle === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
        display = parseRemoteDesktopDisplay(await viewer.handle.resize(fit.width, fit.height, current));
        requireCurrent();
        if (display.id === active.sourceDisplayId || display.id !== viewer.handle.displayId
          || (active.display.id !== active.sourceDisplayId && display.id !== active.display.id)
          || !isRemoteDesktopViewerDisplayGeometry(active.platform, fit.width, fit.height, display.width, display.height)) {
          throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
        }
      } else {
        const viewer = this.#viewerDisplay;
        if (viewer === undefined) display = active.display;
        else {
          if (viewer.handle === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
          try { display = parseRemoteDesktopDisplay(await viewer.handle.restore(current)); }
          catch { throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE"); }
          requireCurrent();
          if (display.id !== active.sourceDisplayId) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
          this.#viewerDisplay = undefined;
          this.#viewerDisplayRevision += 1;
        }
      }
      requireCurrent();
      active.display = display; this.#viewerGeometryManaged = true;
      active.controlling = false; active.controlGeneration = ++this.#controlGeneration;
      this.#dependencies.changed();
      return Object.freeze({ lease: control ? await this.#withControl(authority, active) : leaseView(active) });
    });
    this.#displayWrite = write.then(() => undefined, () => undefined);
    try { return await write; }
    catch (error) {
      if (this.#active === active) this.stop(authority);
      if (error instanceof Error && error.message === "REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE") throw error;
      throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    } finally {
      this.#displayModePending = false; this.#displayWrite = undefined;
    }
  }

  #require(authority: RemoteDesktopAuthority, lease: string): ActiveRemoteDesktopLease {
    if (!validAuthority(authority)) throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
    if (this.#active !== undefined && this.#active.lease === lease
      && sameAuthority(this.#active.authority, authority) && !this.#authenticationCurrent(this.#active)) {
      this.stop(this.#active.authority);
      throw new Error("REMOTE_DESKTOP_AUTHENTICATION_REQUIRED");
    }
    this.#requireAuthentication(authority);
    const peer = peerKey(authority);
    if (this.#active !== undefined
      && sameAuthority(this.#active.authority, authority)
      && !this.#authorityCurrent(authority)) {
      this.stop(authority);
      throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
    }
    this.tick();
    if (this.#locallyStopped.get(peer) === lease) throw new Error("REMOTE_DESKTOP_STOPPED");
    const active = this.#active;
    if (active === undefined || active.lease !== lease || !sameAuthority(active.authority, authority)) {
      throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    }
    return active;
  }

  async #runChecked<T>(
    authority: RemoteDesktopAuthority,
    active: ActiveRemoteDesktopLease | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const authenticationSession = this.#requireAuthentication(authority);
    const geometry = active?.display;
    const check = (): void => {
      if (active !== undefined && active.display !== geometry) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
      this.#revalidateAsyncCompletion(authority, active);
      if (this.#authenticationSession(authority) !== authenticationSession) {
        if (active !== undefined && this.#active === active) this.stop(active.authority);
        throw new Error("REMOTE_DESKTOP_AUTHENTICATION_REQUIRED");
      }
    };
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      check();
      throw error;
    }
    check();
    return value;
  }

  #revalidateAsyncCompletion(
    authority: RemoteDesktopAuthority,
    active: ActiveRemoteDesktopLease | undefined
  ): void {
    if (!validAuthority(authority) || !this.#authorityCurrent(authority)) {
      if (active !== undefined && this.#active === active) this.stop(active.authority);
      throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
    }
    if (this.#authenticationSession(authority) === null) {
      if (active !== undefined && this.#active === active) this.stop(active.authority);
      throw new Error("REMOTE_DESKTOP_AUTHENTICATION_REQUIRED");
    }
    if (active === undefined) return;
    const current = this.#require(authority, active.lease);
    if (current !== active) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
  }

  #assertAuthority(authority: RemoteDesktopAuthority): void {
    if (!validAuthority(authority) || !this.#authorityCurrent(authority)) {
      throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
    }
    this.#requireAuthentication(authority);
  }
  async #ensureHandoff(active: ActiveRemoteDesktopLease): Promise<void> {
    if (!active.handoff) return;
    let current = false;
    try { current = await this.#dependencies.handoffCurrent?.(active.handoff, active.authority) === true; } catch { /* Source proof failed closed. */ }
    if (!current || this.#active !== active || !this.#authorityCurrent(active.authority) || !this.#authenticationCurrent(active)) {
      if (this.#active === active) this.stop(active.authority);
      throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    }
  }

  #authenticationSession(authority: RemoteDesktopAuthority): string | null | undefined {
    if (authority.authenticationOwner === undefined) return undefined;
    try {
      const session = this.#dependencies.authenticationSession?.(authority);
      return typeof session === "string" && session.length > 0 ? session : null;
    } catch {
      return null;
    }
  }

  #requireAuthentication(authority: RemoteDesktopAuthority): string | undefined {
    const session = this.#authenticationSession(authority);
    if (session === null) throw new Error("REMOTE_DESKTOP_AUTHENTICATION_REQUIRED");
    return session;
  }

  #authenticationCurrent(active: ActiveRemoteDesktopLease): boolean {
    return this.#authenticationSession(active.authority) === active.authenticationSession;
  }

  #authorityCurrent(authority: RemoteDesktopAuthority): boolean {
    try {
      return this.#dependencies.authorityCurrent(authority);
    } catch {
      return false;
    }
  }

  #now(): number {
    return this.#dependencies.now?.() ?? Date.now();
  }

  #createLeaseId(): string {
    const lease = this.#dependencies.createLeaseId?.() ?? globalThis.crypto?.randomUUID();
    if (typeof lease !== "string" || lease.length < 1 || lease.length > 128) {
      throw new Error("REMOTE_DESKTOP_LEASE_UNAVAILABLE");
    }
    return lease;
  }
}

function leaseView(active: ActiveRemoteDesktopLease): RemoteDesktopLease {
  return Object.freeze({
    lease: active.lease,
    display: active.display,
    controlling: active.controlling,
    controlGeneration: active.controlGeneration,
    ...(active.handoff ? { inputHandoffRequestId: active.handoff.requestId, window: { app: active.handoff.app, ...(active.handoff.title ? { title: active.handoff.title } : {}) } } : {})
  });
}

function validAuthority(authority: unknown): authority is RemoteDesktopAuthority {
  if (typeof authority !== "object" || authority === null || Array.isArray(authority)) return false;
  const candidate = authority as Record<string, unknown>;
  return boundedIdentity(candidate.controllerDeviceId)
    && typeof candidate.lifecycleToken === "object"
    && candidate.lifecycleToken !== null
    && !Array.isArray(candidate.lifecycleToken);
}

function sameAuthority(left: RemoteDesktopAuthority, right: RemoteDesktopAuthority): boolean {
  return left.controllerDeviceId === right.controllerDeviceId
    && left.lifecycleToken === right.lifecycleToken;
}

function peerKey(authority: RemoteDesktopAuthority): string {
  return authority.controllerDeviceId;
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 256
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported remote desktop request: ${String(value)}`);
}
