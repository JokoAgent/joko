import { AsyncLocalStorage } from "node:async_hooks";

import { create } from "@bufbuild/protobuf";
import {
  RemoteDesktopCapabilitiesSchema,
  RemoteDesktopClipboardContentSchema,
  RemoteDesktopClipboardSyncResultSchema,
  RemoteDesktopClipboardVersionResultSchema,
  RemoteDesktopControlStateSchema,
  RemoteDesktopCursorSchema,
  RemoteDesktopDisplaySchema,
  RemoteDesktopDisplayModeSchema,
  RemoteDesktopFailureReason,
  RemoteDesktopFrameResultSchema,
  RemoteDesktopFrameSchema,
  RemoteDesktopHostMuteResultSchema,
  RemoteDesktopPrivacyScreenResultSchema,
  RemoteDesktopLockState,
  RemoteDesktopLockStateResultSchema,
  type RemoteDesktopCredentialRequest,
  RemoteDesktopIceCandidateSchema,
  RemoteDesktopIceExchangeResultSchema,
  RemoteDesktopLeaseSchema,
  RemoteDesktopDisplayModeResultSchema,
  RemoteDesktopViewerDisplayResultSchema,
  RemoteDesktopMouseButton,
  RemoteDesktopOfferResultSchema,
  RemoteDesktopPermissionsSchema,
  RemoteDesktopPermissionStatus,
  RemoteDesktopPresentationProofSchema,
  RemoteDesktopStartMode,
  RemoteDesktopSystemActionKind,
  RemoteDesktopSystemActionResultSchema,
  RemoteDesktopVideoQuality,
  type RemoteDesktopClipboardContent,
  type RemoteDesktopInputEvent,
  type RemoteDesktopVideoSettings as ContractRemoteDesktopVideoSettings
} from "@joko/contracts";
import {
  DevicePeerRemoteDesktopHostError,
  RemoteDesktopController,
  type DevicePeerRemoteDesktopHostPort,
  type DevicePeerRemoteDesktopHostRequest,
  type DevicePeerRemoteDesktopLeaseRequest,
  type RemoteDesktopAuthority,
  type RemoteDesktopDisplay,
  type RemoteDesktopDisplayMode,
  type RemoteDesktopHostCapabilities,
  type RemoteDesktopIceCandidate,
  type RemoteDesktopInput,
  type RemoteDesktopJpegFrame,
  type RemoteDesktopPermissions,
  type RemoteDesktopSystemAction
} from "@joko/device-peer";

import type { DesktopRemoteDesktopClipboardContent } from "./remote-desktop-clipboard.js";
import type {
  DesktopRemoteDesktopVideoQuality,
  DesktopRemoteDesktopVideoSettings
} from "./remote-desktop-media-settings.js";
import type { DesktopRemoteDesktopSessionState } from "./remote-desktop-input.js";
import { DesktopRemoteDesktopCredentialsHost } from "./remote-desktop-credentials-host.js";
import type { DesktopRemoteCredentialsNative, DesktopRemoteCredentialsNativeOwner } from "./remote-desktop-credentials-native.js";

export interface DesktopRemoteDesktopMediaPort {
  frame(request: {
    readonly displayId: string;
    readonly leaseId: string;
    readonly cursorOverlay: boolean;
    readonly current: () => boolean;
    readonly signal: AbortSignal;
  }): Promise<RemoteDesktopJpegFrame | null>;
  offer(request: {
    readonly displayId: string;
    readonly leaseId: string;
    readonly attemptId: string;
    readonly offerSdp: string;
    readonly cursorOverlay: boolean;
    readonly settings?: DesktopRemoteDesktopVideoSettings;
    readonly current: () => boolean;
    readonly signal: AbortSignal;
  }): Promise<string>;
  exchangeIce(request: {
    readonly leaseId: string;
    readonly attemptId: string;
    readonly candidates: readonly RemoteDesktopIceCandidate[];
    readonly after: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly attemptId: string;
    readonly candidates: readonly RemoteDesktopIceCandidate[];
    readonly next: number;
    readonly complete: boolean;
  }>;
  setInputHandler(handler: (
    leaseId: string,
    sequence: number,
    events: readonly RemoteDesktopInput[]
  ) => void): () => void;
  setPresentationPongHandler(handler: (leaseId: string) => void): () => void;
  setPresentation(leaseId: string, enabled: boolean): void;
  setSessionState(nativeOnly: boolean, state?: DesktopRemoteDesktopSessionState): void;
  setPrivacyExclusions(owner: object, ids: readonly number[]): void;
  preparePrivacy(owner: object, displayId: string, current: () => boolean, signal: AbortSignal): Promise<void>;
  clearPrivacyExclusions(owner: object): void;
  stop(): void;
  release?(): Promise<void>;
  retire(): Promise<void>;
}

export interface DesktopRemoteDesktopInputPort {
  start(displayId: string, signal: AbortSignal): Promise<void>;
  resumeAfterPrivacy?(displayId: string, current: () => boolean, signal: AbortSignal): Promise<void>;
  send(events: readonly RemoteDesktopInput[]): void;
  stop(): void;
  release(): Promise<void>;
  retire(): Promise<void>;
}

export interface DesktopRemoteDesktopClipboardPort {
  copyText(current: () => boolean, signal: AbortSignal): Promise<string>;
  pasteText(text: string, current: () => boolean, signal: AbortSignal): Promise<void>;
  copyContent(
    current: () => boolean,
    signal: AbortSignal
  ): Promise<DesktopRemoteDesktopClipboardContent>;
  pasteContent(
    content: DesktopRemoteDesktopClipboardContent,
    current: () => boolean,
    signal: AbortSignal
  ): Promise<void>;
  readSystemContent(current: () => boolean, signal: AbortSignal, expectedVersion?: string): Promise<DesktopRemoteDesktopClipboardContent>;
  writeSystemContent(content: DesktopRemoteDesktopClipboardContent, expectedVersion: string,
    current: () => boolean, signal: AbortSignal): Promise<string>;
}

export interface DesktopRemoteDesktopHostDependencies {
  readonly platform: "darwin" | "win32" | "linux";
  readonly systemAudio: boolean;
  enabled(): boolean;
  sessionState(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState>;
  lockSessionState?(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState>;
  displays(signal: AbortSignal): readonly RemoteDesktopDisplay[] | Promise<readonly RemoteDesktopDisplay[]>;
  linuxCapabilities?(signal: AbortSignal): Promise<{ readonly canControl: boolean; readonly cursorOverlay: boolean;
    readonly displayModes?: boolean; readonly viewerDisplay?: boolean; readonly lockOnExit?: boolean; readonly privacyScreen?: boolean;
    readonly workspaceNavigation?: boolean; readonly systemMenu?: boolean }>;
  windowsCapabilities?(signal: AbortSignal): Promise<{ readonly canControl: boolean; readonly cursorOverlay: boolean }>;
  viewerDisplaySupported?(signal: AbortSignal): Promise<boolean>;
  prepare?(current: () => boolean, signal: AbortSignal): Promise<void>;
  permissions(signal: AbortSignal): Promise<RemoteDesktopPermissions>;
  showPermissionGuide(signal: AbortSignal): Promise<void>;
  readonly media: DesktopRemoteDesktopMediaPort;
  readonly input: DesktopRemoteDesktopInputPort;
  readonly clipboard?: DesktopRemoteDesktopClipboardPort;
  readonly credentials?: {
    readonly native: Pick<DesktopRemoteCredentialsNative, "request" | "close">;
    readonly owner: DesktopRemoteCredentialsNativeOwner;
    lockState?(signal: AbortSignal): Promise<"locked" | "unlocked" | "unavailable">;
  };
  readonly clipboardCounter?: {
    read(portable: boolean, signal: AbortSignal, current?: () => boolean): Promise<string>;
    stop(): void;
  };
  readonly hostMute?: {
    set(owner: object, enabled: boolean, current: () => boolean, signal: AbortSignal): Promise<void>;
    release(owner: object): Promise<void>;
  };
  readonly privacyScreen?: {
    set(owner: object, displayId: string, current: () => boolean, signal: AbortSignal): Promise<void>;
    release(owner: object): Promise<void>;
  };
  workspaceAction?(action: RemoteDesktopSystemAction, displayId: string, current: () => boolean,
    signal: AbortSignal): Promise<void>;
  stopWorkspaceActions?(): Promise<void>;
  lockScreen?(current: () => boolean, signal: AbortSignal): Promise<void>;
  displayModes?(displayId: string, signal: AbortSignal): Promise<readonly RemoteDesktopDisplayMode[]>;
  setDisplayMode?(
    displayId: string,
    modeId: string,
    beforeChange: () => void | Promise<void>,
    signal: AbortSignal,
    expected?: { readonly width: number; readonly height: number; readonly current?: () => boolean }
  ): Promise<RemoteDesktopDisplay | void>;
  restoreDisplayMode?(
    displayId: string,
    modeId: string,
    current: () => boolean,
    expected: { readonly width: number; readonly height: number },
    signal: AbortSignal
  ): Promise<RemoteDesktopDisplay>;
  displayPresent?(displayId: string): boolean | Promise<boolean>;
  createViewerDisplay?(sourceDisplayId: string, current: () => boolean, onFailure: () => void,
    signal: AbortSignal): Promise<import("@joko/device-peer").RemoteDesktopViewerDisplayHandle>;
  changed(state: DesktopRemoteDesktopState | undefined): void;
  retired?(): void;
  onDisplayChange?(listener: (displayId: string, geometryChanged: boolean,
    geometry?: { readonly width: number; readonly height: number; readonly metrics: readonly string[] }) => void): () => void;
  onSessionStateChange?(listener: () => void): () => void;
  now?(): number;
  createLeaseId?(): string;
}

export interface DesktopRemoteDesktopState {
  readonly controllerDeviceId: string;
  readonly leaseId: string;
  readonly displayId: string;
  readonly controlling: boolean;
}

const NEVER_ABORTED = new AbortController().signal;

/**
 * Trusted Main-process adapter from generated DevicePeer commands to the
 * portable, ephemeral single-viewer controller. It owns no durable media,
 * signaling, input, or lease payloads.
 */
export class DesktopRemoteDesktopHost implements DevicePeerRemoteDesktopHostPort {
  readonly #dependencies: DesktopRemoteDesktopHostDependencies;
  readonly #controller: RemoteDesktopController;
  readonly #credentials: DesktopRemoteDesktopCredentialsHost | undefined;
  readonly #signals = new AsyncLocalStorage<AbortSignal>();
  readonly #lifecycleToken = Object.freeze({});
  readonly #clipboardAuthorityListeners = new Set<() => void>();
  readonly #stopInputHandler: () => void;
  readonly #stopPresentationPongHandler: () => void;
  readonly #stopSubscriptions: readonly (() => void)[];
  readonly #timer: ReturnType<typeof setInterval>;
  #sessionState: DesktopRemoteDesktopSessionState = "unknown";
  #sessionGeneration = 0;
  #sessionTransitionGeneration: number | undefined;
  #terminalLockCurrent: (() => boolean) | undefined;
  #retired = false;
  #retirement: Promise<void> | undefined;
  #retirementReported = false;

  constructor(dependencies: DesktopRemoteDesktopHostDependencies) {
    this.#dependencies = dependencies;
    this.#controller = new RemoteDesktopController({
      authorityCurrent: (authority) => !this.#retired
        && authority.lifecycleToken === this.#lifecycleToken
        && validControllerId(authority.controllerDeviceId),
      authenticationSession: (authority) => authority.authenticationOwner === undefined ? undefined
        : this.#credentials?.authenticationSession(authority.authenticationOwner) ?? null,
      capabilities: async () => this.#capabilities(),
      permissions: async (action) => {
        this.#requireEnabled();
        if (action === "guide") await dependencies.showPermissionGuide(this.#signal());
        return dependencies.permissions(this.#signal());
      },
      frame: (request) => this.#whileSessionViewable(
        (sessionGeneration) => dependencies.media.frame({ ...request, signal: this.#signal(),
          current: () => request.current() && sessionGeneration === this.#sessionGeneration
            && isViewableSession(this.#sessionState) }),
        () => null
      ),
      startInput: (displayId) => this.#whileSessionControllable(
        () => dependencies.input.start(displayId, this.#signal())
      ),
      input: (events) => dependencies.input.send(events),
      stopInput: () => dependencies.input.stop(),
      releaseInput: () => dependencies.input.release(),
      stopVideo: () => dependencies.media.stop(),
      ...(dependencies.prepare === undefined && !(dependencies.platform === "linux" && dependencies.credentials !== undefined) ? {} : {
        prepare: async (current: () => boolean) => {
          if (!dependencies.enabled()) return;
          await this.#refreshSessionState();
          this.#requireSessionViewable();
          if (dependencies.prepare === undefined) return;
          const generation = this.#sessionGeneration;
          const signal = this.#signal();
          const valid = (): boolean => !this.#retired && !signal.aborted && current()
            && this.#sessionState === "unlocked" && generation === this.#sessionGeneration
            && this.#sessionTransitionGeneration === undefined;
          if (!valid()) {
            // Ordinary locked viewing has no compositor mutation authority.
            if (this.#sessionState === "locked-logged-in" && !signal.aborted && current()) return;
            throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
          }
          await dependencies.prepare!(valid, signal);
          await this.#refreshSessionState();
          if (!valid()) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
        }
      }),
      ...(dependencies.privacyScreen === undefined ? {} : {
        privacyScreen: async (owner: object, displayId: string, current: () => boolean) => {
          await this.#refreshSessionState();
          const generation = this.#sessionGeneration;
          const signal = this.#signal();
          const valid = (): boolean => !this.#retired && !signal.aborted && current()
            && this.#sessionState === "unlocked" && generation === this.#sessionGeneration
            && this.#sessionTransitionGeneration === undefined;
          if (!valid()) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
          await dependencies.privacyScreen!.set(owner, displayId, valid, signal);
          await this.#refreshSessionState();
          if (!valid()) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
        },
        stopPrivacyScreen: (owner: object) => dependencies.privacyScreen!.release(owner),
        ...(dependencies.input.resumeAfterPrivacy === undefined ? {} : {
          resumeInputAfterPrivacy: async (displayId: string, current: () => boolean) => {
            await this.#refreshSessionState();
            const generation = this.#sessionGeneration;
            const signal = this.#signal();
            const valid = (): boolean => !this.#retired && !signal.aborted && current()
              && this.#sessionState === "unlocked" && generation === this.#sessionGeneration
              && this.#sessionTransitionGeneration === undefined;
            if (!valid()) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
            await dependencies.input.resumeAfterPrivacy!(displayId, valid, signal);
            await this.#refreshSessionState();
            if (!valid()) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
          }
        })
      }),
      ...(dependencies.clipboard === undefined || dependencies.clipboardCounter === undefined ? {} : {
        clipboardVersion: (current: () => boolean) => this.#whileSessionUnlocked(async () => {
          const sessionGeneration = this.#sessionGeneration;
          const valid = (): boolean => current() && this.#sessionState === "unlocked"
            && this.#sessionGeneration === sessionGeneration && this.#sessionTransitionGeneration === undefined;
          if (!valid()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
          const version = await dependencies.clipboardCounter!.read(false, this.#signal(), valid);
          if (!valid()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
          return version;
        }),
        stopClipboardVersion: () => dependencies.clipboardCounter!.stop()
      }),
      ...((dependencies.platform !== "darwin" && dependencies.platform !== "linux") || dependencies.lockScreen === undefined
        || (dependencies.platform === "linux" && dependencies.lockSessionState === undefined) ? {} : {
        lockScreen: async (current: () => boolean, cancellation: AbortSignal) => {
          const signal = AbortSignal.any([cancellation, this.#signal()]);
          if (dependencies.platform === "linux") {
            const valid = (): boolean => !this.#retired && !signal.aborted && current()
              && this.#terminalLockCurrent === valid;
            this.#terminalLockCurrent = valid;
            try {
              const before = await dependencies.lockSessionState!(signal);
              if (!valid() || !isViewableSession(before)) throw new Error("REMOTE_DESKTOP_LOCK_EXPIRED");
              await dependencies.lockScreen!(valid, signal);
              const after = await dependencies.lockSessionState!(signal);
              if (!valid() || after !== "locked-logged-in") throw new Error("REMOTE_DESKTOP_LOCK_EXPIRED");
            } finally {
              if (this.#terminalLockCurrent === valid && !current()) this.#terminalLockCurrent = undefined;
            }
            return;
          }
          await this.#refreshSessionState();
          if (!isViewableSession(this.#sessionState)) throw new Error("REMOTE_DESKTOP_LOCK_EXPIRED");
          const valid = (): boolean => !this.#retired && !signal.aborted && current()
            && (isViewableSession(this.#sessionState)
              || (this.#sessionState === "unknown" && this.#sessionTransitionGeneration !== undefined));
          if (!valid() || !isViewableSession(this.#sessionState)) throw new Error("REMOTE_DESKTOP_LOCK_EXPIRED");
          await dependencies.lockScreen!(valid, signal);
          // The expected owned-session transition to locked is valid for this
          // terminal occurrence; ordinary unlocked input guards cannot apply.
          await this.#refreshSessionState();
          if (!valid() || !isViewableSession(this.#sessionState)) throw new Error("REMOTE_DESKTOP_LOCK_EXPIRED");
        }
      }),
      ...(dependencies.hostMute === undefined ? {} : {
        hostMute: async (owner: object, enabled: boolean, current: () => boolean) => {
          await this.#refreshSessionState();
          if (this.#sessionState !== "unlocked") throw new Error("REMOTE_DESKTOP_HOST_MUTE_EXPIRED");
          const generation = this.#sessionGeneration;
          const signal = this.#signal();
          const valid = (): boolean => !this.#retired && !signal.aborted
            && this.#sessionState === "unlocked"
            && this.#sessionTransitionGeneration === undefined
            && generation === this.#sessionGeneration && current();
          if (!valid()) throw new Error("REMOTE_DESKTOP_HOST_MUTE_EXPIRED");
          await dependencies.hostMute!.set(owner, enabled, valid, signal);
          await this.#refreshSessionState();
          if (!valid()) throw new Error("REMOTE_DESKTOP_HOST_MUTE_EXPIRED");
        },
        stopHostMute: (owner: object) => dependencies.hostMute!.release(owner)
      }),
      ...(dependencies.workspaceAction === undefined || dependencies.stopWorkspaceActions === undefined ? {} : {
        workspaceAction: async (action: RemoteDesktopSystemAction, displayId: string, current: () => boolean) => {
          await this.#refreshSessionState();
          const generation = this.#sessionGeneration;
          const signal = this.#signal();
          const valid = (): boolean => !this.#retired && !signal.aborted && current()
            && dependencies.platform === "linux" && this.#sessionState === "unlocked"
            && generation === this.#sessionGeneration && this.#sessionTransitionGeneration === undefined;
          if (!valid()) throw new Error("REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED");
          await dependencies.workspaceAction!(action, displayId, valid, signal);
          await this.#refreshSessionState();
          if (!valid()) throw new Error("REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED");
        },
        stopWorkspaceActions: () => dependencies.stopWorkspaceActions!()
      }),
      offer: (lease, sdp, attemptId, settings, cursorOverlay, authority) =>
        this.#whileSessionViewable((sessionGeneration) => dependencies.media.offer({
          displayId: lease.display.id,
          leaseId: lease.lease,
          attemptId,
          offerSdp: sdp,
          cursorOverlay,
          ...(settings === undefined ? {} : { settings }),
          current: () => (sessionGeneration === this.#sessionGeneration
            || dependencies.platform === "linux" && dependencies.systemAudio && settings?.audio === true)
            && isViewableSession(this.#sessionState)
            && this.#controller.hasLease(authority, lease.lease),
          signal: this.#signal()
        }), staleVideoOperation),
      ice: (request) => dependencies.media.exchangeIce({
        leaseId: request.lease,
        attemptId: request.attemptId,
        candidates: request.candidates,
        after: request.after,
        signal: this.#signal()
      }),
      ...(dependencies.displayModes === undefined || dependencies.setDisplayMode === undefined ? {} : {
        displayModes: (displayId: string) => this.#whileSessionViewable(
          () => dependencies.displayModes!(displayId, this.#signal()),
          staleDisplayOperation
        )
      }),
      ...(dependencies.displayModes === undefined || dependencies.setDisplayMode === undefined ? {} : {
        setDisplayMode: (displayId: string, modeId: string, beforeChange: () => void | Promise<void>,
          _authority: RemoteDesktopAuthority, expected?: { readonly width: number; readonly height: number; readonly current?: () => boolean }) =>
          this.#whileSessionUnlocked(() => dependencies.setDisplayMode!(
            displayId,
            modeId,
            beforeChange,
            this.#signal(),
            expected
          ))
      }),
      ...(dependencies.restoreDisplayMode === undefined ? {} : {
        restoreDisplayMode: async (displayId: string, modeId: string, current: () => boolean,
          expected: { readonly width: number; readonly height: number }) => {
          const session = await dependencies.sessionState(NEVER_ABORTED);
          if (!current() || !isViewableSession(session)) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
          const actual = await dependencies.restoreDisplayMode!(displayId, modeId, current, expected, NEVER_ABORTED);
          const after = await dependencies.sessionState(NEVER_ABORTED);
          if (!current() || !isViewableSession(after)) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
          return actual;
        },
        displayPresent: async (displayId: string) => dependencies.displayPresent === undefined
          ? (await dependencies.displays(NEVER_ABORTED)).some((display) => display.id === displayId)
          : dependencies.displayPresent(displayId)
      }),
      ...(dependencies.createViewerDisplay === undefined ? {} : {
        createViewerDisplay: async (sourceDisplayId: string, current: () => boolean, onFailure: () => void) => {
          await this.#refreshSessionState(); this.#requireSessionUnlocked();
          // The handle belongs to the lease; a unary request ending cannot retire its cleanup responsibility.
          return dependencies.createViewerDisplay!(sourceDisplayId, current, onFailure, NEVER_ABORTED);
        }
      }),
      changed: () => {
        if (this.#controller.state === undefined) this.#terminalLockCurrent = undefined;
        for (const listener of this.#clipboardAuthorityListeners) listener();
        dependencies.changed(this.state);
      },
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.createLeaseId === undefined ? {} : { createLeaseId: dependencies.createLeaseId })
    });
    this.#credentials = (dependencies.platform === "darwin" || dependencies.platform === "linux"
      && dependencies.credentials?.lockState !== undefined) && dependencies.credentials !== undefined
      ? new DesktopRemoteDesktopCredentialsHost({
        ...dependencies.credentials,
        current: () => !this.#retired && dependencies.enabled(),
        invalidated: () => this.#controller.tick(),
        execute: async (peer, body, authenticationOwner, signal) => {
          try {
            return await this.#signals.run(signal, () => this.#controller.request(
              Object.freeze({ ...this.#authority(peer), authenticationOwner }), body
            ));
          } catch (error) { throw translateFailure(error); }
        },
        ...(dependencies.now === undefined ? {} : { now: dependencies.now })
      }) : undefined;
    this.#stopInputHandler = dependencies.media.setInputHandler((leaseId, sequence, events) => {
      const state = this.#controller.state;
      if (this.#retired || state === undefined || state.lease !== leaseId) return;
      try {
        this.#controller.input(this.#authority(state.controllerDeviceId), leaseId, sequence, events);
      } catch {
        // A rejected DataChannel batch is scoped to the current control bit.
        // The generated heartbeat reports the resulting view-only state.
      }
    });
    this.#stopPresentationPongHandler = dependencies.media.setPresentationPongHandler((leaseId) => {
      if (this.#retired) return;
      this.#controller.recordPresentationPong(leaseId);
    });
    const subscriptions: (() => void)[] = [];
    if (dependencies.onDisplayChange !== undefined) {
      subscriptions.push(dependencies.onDisplayChange((displayId, geometryChanged, geometry) => {
        const managed = this.#controller.managedViewerDisplay;
        if (managed?.sourceDisplayId === displayId && geometry?.metrics.includes("removed")) {
          this.#controller.stop();
          return;
        }
        if (this.#controller.changingDisplay && geometry !== undefined
          && geometry.metrics.every((metric) => metric === "bounds" || metric === "workArea" || metric === "scaleFactor")) return;
        const state = this.#controller.state;
        if (state?.displayId === displayId && geometryChanged
          && !(geometry !== undefined
            && geometry.metrics.every((metric) => metric === "bounds" || metric === "workArea" || metric === "scaleFactor")
            && this.#controller.displayGeometryMatches(displayId, geometry.width, geometry.height))) {
          this.#controller.stop();
        }
      }));
    }
    if (dependencies.onSessionStateChange !== undefined) {
      subscriptions.push(dependencies.onSessionStateChange(() => this.#beginSessionTransition()));
    }
    this.#stopSubscriptions = Object.freeze(subscriptions);
    this.#timer = setInterval(() => this.#controller.tick(), 1_000);
    this.#timer.unref?.();
  }

  get state(): DesktopRemoteDesktopState | undefined {
    const state = this.#controller.state;
    return state === undefined ? undefined : Object.freeze({
      controllerDeviceId: state.controllerDeviceId,
      leaseId: state.lease,
      displayId: state.displayId,
      controlling: state.controlling
    });
  }

  /** Main's compositor poll must not invalidate a change already owned by this lease. */
  managesDisplayGeometry(displayId: string, width: number, height: number): boolean {
    return this.#controller.changingDisplay
      || this.#controller.displayGeometryMatches(displayId, width, height);
  }

  get managedViewerDisplay() { return this.#controller.managedViewerDisplay; }
  get changingDisplay(): boolean { return this.#controller.changingDisplay; }

  /** Explicit local Disconnect also fences RESUME for the ended lease. */
  disconnect(): void {
    if (this.#retired) return;
    this.#controller.stopByUser();
  }

  async disconnectAndRelease(): Promise<void> {
    this.disconnect();
    await Promise.all([this.#controller.stopAndRestore(), this.#dependencies.input.release(), this.#dependencies.media.release?.()]);
  }

  async stopPrivacyByUser(owner: object): Promise<void> {
    if (this.#retired) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
    await this.#controller.stopPrivacyByUser(owner);
  }

  displayCoverageChanged(): void {
    if (!this.#retired) this.#controller.stop();
  }

  /** Native injection failure is control-scoped; picture and lease stay alive. */
  releaseControl(): void {
    if (this.#retired) return;
    this.#controller.releaseControl();
  }

  async getLockState(request: DevicePeerRemoteDesktopHostRequest) {
    this.#requireCredentialAuthority(request);
    if (this.#dependencies.platform === "linux") {
      const state = this.#credentials === undefined ? "unavailable"
        : await this.#dependencies.credentials!.lockState!(request.signal);
      this.#requireCredentialAuthority(request);
      return create(RemoteDesktopLockStateResultSchema, { state: state === "locked" ? RemoteDesktopLockState.LOCKED
        : state === "unlocked" ? RemoteDesktopLockState.UNLOCKED : RemoteDesktopLockState.UNAVAILABLE });
    }
    if (this.#dependencies.platform !== "darwin") {
      return create(RemoteDesktopLockStateResultSchema, { state: RemoteDesktopLockState.UNAVAILABLE });
    }
    await this.#signals.run(request.signal, () => this.#refreshSessionState());
    this.#requireCredentialAuthority(request);
    return create(RemoteDesktopLockStateResultSchema, { state: this.#sessionState === "unlocked"
      ? RemoteDesktopLockState.UNLOCKED : this.#sessionState === "locked-logged-in"
        ? RemoteDesktopLockState.LOCKED : RemoteDesktopLockState.UNAVAILABLE });
  }

  async requestCredentials(request: DevicePeerRemoteDesktopHostRequest & { readonly request: RemoteDesktopCredentialRequest }) {
    this.#requireCredentialAuthority(request);
    if (this.#credentials === undefined) throw failure(RemoteDesktopFailureReason.CREDENTIAL_UNAVAILABLE, false);
    const result = await this.#credentials.request(request.controllerDeviceId, request.request, request.signal);
    this.#requireCredentialAuthority(request);
    return result;
  }

  async closeCredentials(request: DevicePeerRemoteDesktopHostRequest & { readonly handle: string }): Promise<void> {
    throwIfAborted(request.signal);
    if (!validControllerId(request.controllerDeviceId)) throw failure(RemoteDesktopFailureReason.AUTHORITY_CHANGED, false);
    // Retirement may arrive after permission was revoked. It only closes an
    // already captured handle and must never create authentication authority.
    if (this.#retired) { await this.#credentials?.retire(); return; }
    if (this.#credentials === undefined) return;
    await this.#credentials.closeHandle(request.controllerDeviceId, request.handle);
  }

  async getCapabilities(request: DevicePeerRemoteDesktopHostRequest) {
    const value = await this.#request(request, { op: "capabilities" }) as {
      readonly version: 1;
      readonly enabled: boolean;
      readonly canControl: boolean;
      readonly platform: string;
      readonly displays: readonly RemoteDesktopDisplay[];
      readonly permissions: RemoteDesktopPermissions;
      readonly automaticReconnect: boolean;
      readonly connectionTakeover: boolean;
      readonly webrtcVideo: boolean;
      readonly trickleIce: boolean;
      readonly jpegFallback: boolean;
      readonly clipboardText: boolean;
      readonly clipboardContent: boolean;
      readonly videoSettings: boolean;
      readonly systemAudio: boolean;
      readonly backgroundViewing: boolean;
      readonly displayModes: boolean;
      readonly cursorOverlay: boolean;
      readonly hostMute: boolean;
      readonly lockOnExit: boolean;
      readonly clipboardSync: boolean;
      readonly clipboardInline: boolean;
      readonly privacyScreen: boolean;
      readonly nativeCredentials: boolean;
      readonly resolutionRestore: boolean;
      readonly viewerDisplay: boolean;
      readonly viewerDisplayRestore: boolean;
      readonly workspaceNavigation: boolean;
      readonly systemMenu: boolean;
    };
    return create(RemoteDesktopCapabilitiesSchema, {
      protocolVersion: value.version,
      enabled: value.enabled,
      canControl: value.canControl,
      platform: value.platform,
      displays: value.displays.map((display) => create(RemoteDesktopDisplaySchema, {
        displayId: display.id,
        name: display.name,
        width: display.width,
        height: display.height
      })),
      permissions: permissionsToContract(value.permissions),
      automaticReconnect: value.automaticReconnect,
      connectionTakeover: value.connectionTakeover,
      webrtcVideo: value.webrtcVideo,
      trickleIce: value.trickleIce,
      jpegFallback: value.jpegFallback,
      clipboardText: value.clipboardText,
      clipboardContent: value.clipboardContent,
      videoSettings: value.videoSettings,
      systemAudio: value.systemAudio,
      backgroundViewing: value.backgroundViewing,
      displayModes: value.displayModes,
      resolutionRestore: value.resolutionRestore,
      viewerDisplay: value.viewerDisplay,
      viewerDisplayRestore: value.viewerDisplayRestore,
      cursorOverlay: value.cursorOverlay,
      hostMute: value.hostMute,
      lockOnExit: value.lockOnExit,
      clipboardSync: value.clipboardSync,
      clipboardInline: value.clipboardInline,
      privacyScreen: value.privacyScreen,
      nativeCredentials: value.nativeCredentials,
      workspaceNavigation: value.workspaceNavigation,
      systemMenu: value.systemMenu
    });
  }

  async getPermissions(request: DevicePeerRemoteDesktopHostRequest) {
    const value = await this.#request(request, { op: "permissions", action: "check" }) as RemoteDesktopPermissions;
    return permissionsToContract(value);
  }

  async showPermissionGuide(request: DevicePeerRemoteDesktopHostRequest): Promise<void> {
    await this.#request(request, { op: "permissions", action: "guide" });
  }

  async start(request: DevicePeerRemoteDesktopHostRequest & {
    readonly displayId: string;
    readonly mode: RemoteDesktopStartMode;
  }) {
    const value = await this.#request(request, {
      op: "start",
      displayId: request.displayId,
      ...(request.mode === RemoteDesktopStartMode.RESUME ? { resume: true } : {}),
      ...(request.mode === RemoteDesktopStartMode.TAKEOVER ? { takeover: true } : {})
    }) as {
      readonly lease: string;
      readonly display: RemoteDesktopDisplay;
      readonly controlling: boolean;
      readonly controlGeneration: number;
    };
    return create(RemoteDesktopLeaseSchema, {
      leaseId: value.lease,
      display: create(RemoteDesktopDisplaySchema, {
        displayId: value.display.id,
        name: value.display.name,
        width: value.display.width,
        height: value.display.height
      }),
      controlling: value.controlling,
      controlGeneration: BigInt(value.controlGeneration)
    });
  }

  async heartbeat(request: DevicePeerRemoteDesktopLeaseRequest) {
    const value = await this.#request(request, { op: "heartbeat", lease: request.leaseId }) as {
      readonly controlling: boolean;
      readonly controlGeneration: number;
    };
    return create(RemoteDesktopControlStateSchema, {
      controlling: value.controlling,
      controlGeneration: BigInt(value.controlGeneration)
    });
  }

  async stop(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly lockScreen?: boolean;
    readonly controlGeneration?: bigint;
  }): Promise<void> {
    if (request.lockScreen && (request.controlGeneration === undefined || request.controlGeneration < 1n
      || request.controlGeneration > BigInt(Number.MAX_SAFE_INTEGER))) {
      throw failure(RemoteDesktopFailureReason.LOCK_EXPIRED, false);
    }
    await this.#request(request, request.lockScreen ? {
      op: "stop", lease: request.leaseId, lockScreen: true, controlGeneration: Number(request.controlGeneration)
    } : { op: "stop", lease: request.leaseId });
  }

  async setControl(request: DevicePeerRemoteDesktopLeaseRequest & { readonly enabled: boolean }) {
    const value = await this.#request(request, {
      op: "control",
      lease: request.leaseId,
      enabled: request.enabled
    }) as { readonly controlling: boolean; readonly controlGeneration: number };
    if (request.enabled) this.#dependencies.media.setPresentation(request.leaseId, false);
    return create(RemoteDesktopControlStateSchema, {
      controlling: value.controlling,
      controlGeneration: BigInt(value.controlGeneration)
    });
  }

  async setHostMute(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
    readonly enabled: boolean;
  }) {
    if (request.controlGeneration < 1n
      || request.controlGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw failure(RemoteDesktopFailureReason.HOST_MUTE_EXPIRED, false);
    }
    const value = await this.#request(request, {
      op: "hostMute",
      lease: request.leaseId,
      controlGeneration: Number(request.controlGeneration),
      enabled: request.enabled
    }) as { readonly enabled: boolean };
    return create(RemoteDesktopHostMuteResultSchema, { enabled: value.enabled });
  }

  async setPrivacyScreen(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint; readonly enabled: boolean; readonly lockOnExit: boolean;
  }) {
    if (!exactGeneration(request.controlGeneration)) throw failure(RemoteDesktopFailureReason.PRIVACY_EXPIRED, false);
    const value = await this.#request(request, { op: "privacyScreen", lease: request.leaseId,
      controlGeneration: Number(request.controlGeneration), enabled: request.enabled, lockOnExit: request.lockOnExit }) as { enabled: boolean };
    return create(RemoteDesktopPrivacyScreenResultSchema, value);
  }

  async performSystemAction(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint; readonly action: RemoteDesktopSystemActionKind;
  }) {
    if (!exactGeneration(request.controlGeneration)) {
      throw failure(RemoteDesktopFailureReason.SYSTEM_ACTION_EXPIRED, false);
    }
    const action = request.action === RemoteDesktopSystemActionKind.WORKSPACE_LEFT ? "workspaceLeft"
      : request.action === RemoteDesktopSystemActionKind.WORKSPACE_RIGHT ? "workspaceRight"
      : request.action === RemoteDesktopSystemActionKind.SYSTEM_MENU ? "systemMenu" : undefined;
    if (action === undefined) throw failure(RemoteDesktopFailureReason.SYSTEM_ACTION_UNAVAILABLE, false);
    const value = await this.#request(request, { op: "systemAction", lease: request.leaseId,
      controlGeneration: Number(request.controlGeneration), action }) as { readonly action: RemoteDesktopSystemAction };
    const result = value.action === "workspaceLeft" ? RemoteDesktopSystemActionKind.WORKSPACE_LEFT
      : value.action === "workspaceRight" ? RemoteDesktopSystemActionKind.WORKSPACE_RIGHT
      : value.action === "systemMenu" ? RemoteDesktopSystemActionKind.SYSTEM_MENU : undefined;
    if (result === undefined) throw failure(RemoteDesktopFailureReason.SYSTEM_ACTION_UNAVAILABLE, false);
    return create(RemoteDesktopSystemActionResultSchema, { action: result });
  }

  async setClipboardSync(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint; readonly enabled: boolean;
  }) {
    if (!exactGeneration(request.controlGeneration)) throw failure(RemoteDesktopFailureReason.CLIPBOARD_EXPIRED, false);
    const value = await this.#request(request, { op: "clipboardSync", lease: request.leaseId,
      controlGeneration: Number(request.controlGeneration), enabled: request.enabled }) as { enabled: boolean; syncGeneration: number };
    return create(RemoteDesktopClipboardSyncResultSchema, { enabled: value.enabled, syncGeneration: BigInt(value.syncGeneration) });
  }

  async getClipboardVersion(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint; readonly syncGeneration: bigint;
  }) {
    if (!exactGeneration(request.controlGeneration) || !exactGeneration(request.syncGeneration)) {
      throw failure(RemoteDesktopFailureReason.CLIPBOARD_EXPIRED, false);
    }
    const value = await this.#request(request, { op: "clipboardVersion", lease: request.leaseId,
      controlGeneration: Number(request.controlGeneration), syncGeneration: Number(request.syncGeneration) }) as { version: string };
    return create(RemoteDesktopClipboardVersionResultSchema, value);
  }

  isClipboardSyncCurrent(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint; readonly syncGeneration: bigint;
  }): boolean {
    return !this.#retired && !request.signal.aborted && exactGeneration(request.controlGeneration)
      && exactGeneration(request.syncGeneration) && this.#controller.isClipboardSyncCurrent(
        this.#authority(request.controllerDeviceId), request.leaseId,
        Number(request.controlGeneration), Number(request.syncGeneration));
  }

  onClipboardAuthorityChanged(listener: () => void): () => void {
    this.#clipboardAuthorityListeners.add(listener);
    return () => { this.#clipboardAuthorityListeners.delete(listener); };
  }

  async setPresentation(
    request: DevicePeerRemoteDesktopLeaseRequest & { readonly enabled: boolean }
  ) {
    const value = await this.#request(request, {
      op: "presentation",
      lease: request.leaseId,
      enabled: request.enabled
    }) as { readonly controlling: boolean; readonly controlGeneration: number };
    this.#dependencies.media.setPresentation(request.leaseId, request.enabled);
    return create(RemoteDesktopControlStateSchema, {
      controlling: value.controlling,
      controlGeneration: BigInt(value.controlGeneration)
    });
  }

  async probePresentation(request: DevicePeerRemoteDesktopLeaseRequest) {
    if (this.#retired) throw failure(RemoteDesktopFailureReason.STOPPED, false);
    throwIfAborted(request.signal);
    try {
      const proof = this.#controller.probePresentation(
        this.#authority(request.controllerDeviceId),
        request.leaseId
      );
      throwIfAborted(request.signal);
      return create(RemoteDesktopPresentationProofSchema, {
        leaseId: proof.lease,
        proofSequence: BigInt(proof.proofSequence)
      });
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      throw translateFailure(error);
    }
  }

  async sendInput(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly sequence: bigint;
    readonly events: readonly RemoteDesktopInputEvent[];
  }): Promise<void> {
    if (typeof request.sequence !== "bigint" || request.sequence < 1n
      || request.sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError("Remote Desktop input sequence is outside the exact integer range.");
    }
    await this.#request(request, {
      op: "input",
      lease: request.leaseId,
      sequence: Number(request.sequence),
      events: request.events.map(inputFromContract)
    });
  }

  async createOffer(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly attemptId: string;
    readonly offerSdp: string;
    readonly settings?: ContractRemoteDesktopVideoSettings;
    readonly cursorOverlay: boolean;
  }) {
    const value = await this.#request(request, {
      op: "offer",
      lease: request.leaseId,
      attemptId: request.attemptId,
      sdp: request.offerSdp,
      cursorOverlay: request.cursorOverlay,
      ...(request.settings === undefined ? {} : {
        settings: Object.freeze({
          fps: request.settings.fps,
          quality: desktopVideoQualityFromContract(request.settings.quality),
          audio: request.settings.audio
        })
      })
    }) as { readonly sdp: string };
    return create(RemoteDesktopOfferResultSchema, {
      attemptId: request.attemptId,
      answerSdp: value.sdp
    });
  }

  async exchangeIce(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly attemptId: string;
    readonly candidates: readonly import("@joko/contracts").RemoteDesktopIceCandidate[];
    readonly after: number;
  }) {
    const value = await this.#request(request, {
      op: "ice",
      lease: request.leaseId,
      attemptId: request.attemptId,
      candidates: request.candidates.map((candidate) => Object.freeze({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        ...(candidate.usernameFragment === undefined ? {} : {
          usernameFragment: candidate.usernameFragment
        })
      })),
      after: request.after
    }) as {
      readonly attemptId: string;
      readonly candidates: readonly RemoteDesktopIceCandidate[];
      readonly next: number;
      readonly complete: boolean;
    };
    return create(RemoteDesktopIceExchangeResultSchema, {
      attemptId: value.attemptId,
      candidates: value.candidates.map((candidate) => create(RemoteDesktopIceCandidateSchema, {
        candidate: candidate.candidate,
        ...(candidate.sdpMid === null ? {} : { sdpMid: candidate.sdpMid }),
        ...(candidate.sdpMLineIndex === null ? {} : { sdpMLineIndex: candidate.sdpMLineIndex }),
        ...(candidate.usernameFragment === undefined ? {} : {
          usernameFragment: candidate.usernameFragment
        })
      })),
      next: value.next,
      complete: value.complete
    });
  }

  async getFrame(request: DevicePeerRemoteDesktopLeaseRequest & { readonly cursorOverlay: boolean }) {
    const value = await this.#request(request, {
      op: "frame",
      lease: request.leaseId,
      cursorOverlay: request.cursorOverlay
    }) as {
      readonly jpeg: string | null;
      readonly cursor?: import("@joko/device-peer").RemoteDesktopCursor | null;
    };
    return create(RemoteDesktopFrameResultSchema, value.jpeg === null ? {} : {
      frame: create(RemoteDesktopFrameSchema, {
        jpeg: Buffer.from(value.jpeg, "base64"),
        ...(value.cursor === undefined || value.cursor === null ? {} : {
          cursor: create(RemoteDesktopCursorSchema, {
            visible: value.cursor.visible,
            x: value.cursor.x,
            y: value.cursor.y,
            width: value.cursor.width,
            height: value.cursor.height,
            hotX: value.cursor.hotX,
            hotY: value.cursor.hotY,
            png: Buffer.from(value.cursor.png, "base64")
          })
        })
      })
    });
  }

  async listDisplayModes(request: DevicePeerRemoteDesktopLeaseRequest) {
    const modes = await this.#request(request, {
      op: "displayModes",
      lease: request.leaseId
    }) as readonly RemoteDesktopDisplayMode[];
    return Object.freeze(modes.map((mode) => create(RemoteDesktopDisplayModeSchema, {
      modeId: mode.id,
      width: mode.width,
      height: mode.height,
      current: mode.current,
      native: mode.native
    })));
  }

  async setDisplayMode(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
    readonly modeId: string;
    readonly temporary: boolean;
  }) {
    if (request.controlGeneration < 1n
      || request.controlGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw failure(RemoteDesktopFailureReason.LEASE_EXPIRED, false);
    }
    const value = await this.#request(request, {
      op: "resolution",
      lease: request.leaseId,
      controlGeneration: Number(request.controlGeneration),
      modeId: request.modeId,
      temporary: request.temporary
    }) as { readonly lease?: import("@joko/device-peer").RemoteDesktopLease };
    return create(RemoteDesktopDisplayModeResultSchema, value.lease === undefined ? {} : {
      lease: create(RemoteDesktopLeaseSchema, {
        leaseId: value.lease.lease,
        display: create(RemoteDesktopDisplaySchema, { displayId: value.lease.display.id,
          name: value.lease.display.name, width: value.lease.display.width, height: value.lease.display.height }),
        controlling: value.lease.controlling,
        controlGeneration: BigInt(value.lease.controlGeneration)
      })
    });
  }

  async setViewerDisplay(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint; readonly width: number; readonly height: number;
  }) { return this.#viewerDisplayRequest(request, { op: "viewerDisplay", width: request.width, height: request.height }); }

  async restoreViewerDisplay(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
  }) { return this.#viewerDisplayRequest(request, { op: "restoreViewerDisplay" }); }

  async #viewerDisplayRequest(request: DevicePeerRemoteDesktopLeaseRequest & { readonly controlGeneration: bigint },
    operation: { readonly op: "viewerDisplay"; readonly width: number; readonly height: number } | { readonly op: "restoreViewerDisplay" }) {
    if (request.controlGeneration < 1n || request.controlGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw failure(RemoteDesktopFailureReason.LEASE_EXPIRED, false);
    }
    const value = await this.#request(request, { ...operation, lease: request.leaseId,
      controlGeneration: Number(request.controlGeneration) }) as { readonly lease: import("@joko/device-peer").RemoteDesktopLease };
    return create(RemoteDesktopViewerDisplayResultSchema, { lease: create(RemoteDesktopLeaseSchema, {
      leaseId: value.lease.lease, display: create(RemoteDesktopDisplaySchema, { displayId: value.lease.display.id,
        name: value.lease.display.name, width: value.lease.display.width, height: value.lease.display.height }),
      controlling: value.lease.controlling, controlGeneration: BigInt(value.lease.controlGeneration)
    }) });
  }

  isControlCurrent(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
  }): boolean {
    if (this.#retired || request.signal.aborted
      || request.controlGeneration < 1n
      || request.controlGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
      return false;
    }
    return this.#controller.isControlCurrent(
      this.#authority(request.controllerDeviceId),
      request.leaseId,
      Number(request.controlGeneration)
    );
  }

  async copyClipboardText(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
  }): Promise<string> {
    return this.#clipboardRequest(request, (clipboard, current) =>
      clipboard.copyText(current, request.signal));
  }

  async pasteClipboardText(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
    readonly text: string;
  }): Promise<void> {
    await this.#clipboardRequest(request, (clipboard, current) =>
      clipboard.pasteText(request.text, current, request.signal));
  }

  async copyClipboardContent(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
    readonly sync?: boolean; readonly syncGeneration?: bigint; readonly version?: string;
  }): Promise<RemoteDesktopClipboardContent> {
    const value = await this.#clipboardRequest(request, (clipboard, current) =>
      request.sync ? clipboard.readSystemContent(current, request.signal, request.version)
        : clipboard.copyContent(current, request.signal));
    return create(RemoteDesktopClipboardContentSchema, value);
  }

  async pasteClipboardContent(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
    readonly content: RemoteDesktopClipboardContent;
    readonly sync?: boolean; readonly syncGeneration?: bigint; readonly version?: string;
  }): Promise<string | void> {
    const content: DesktopRemoteDesktopClipboardContent = Object.freeze({
      ...(request.content.text === undefined ? {} : { text: request.content.text }),
      ...(request.content.html === undefined ? {} : { html: request.content.html }),
      ...(request.content.rtf === undefined ? {} : { rtf: request.content.rtf }),
      ...(request.content.url === undefined ? {} : { url: request.content.url }),
      ...(request.content.png === undefined ? {} : { png: request.content.png })
    });
    return this.#clipboardRequest<string | void>(request, (clipboard, current) =>
      request.sync ? clipboard.writeSystemContent(content, request.version!, current, request.signal)
        : clipboard.pasteContent(content, current, request.signal));
  }

  retire(): Promise<void> {
    if (this.#retirement !== undefined) return this.#retirement;
    if (!this.#retired) {
      this.#retired = true;
      clearInterval(this.#timer);
      this.#stopInputHandler();
      this.#stopPresentationPongHandler();
      for (const stop of this.#stopSubscriptions) stop();
    }
    const pending = this.#finishRetire();
    this.#retirement = pending;
    void pending.finally(() => { if (this.#retirement === pending) this.#retirement = undefined; }).catch(() => undefined);
    return pending;
  }

  async #finishRetire(): Promise<void> {
    const results = await Promise.allSettled([
      this.#controller.stopAndRestore(),
      this.#dependencies.input.release().then(() => this.#dependencies.input.retire()),
      this.#dependencies.media.retire(),
      this.#credentials?.retire()
    ]);
    if (results[0]?.status === "rejected") throw translateFailure(results[0].reason);
    if (results[1]?.status === "rejected") throw results[1].reason;
    if (results[2]?.status === "rejected") throw results[2].reason;
    if (results[3]?.status === "rejected") throw results[3].reason;
    if (!this.#retirementReported) {
      this.#retirementReported = true;
      this.#dependencies.retired?.();
    }
  }

  async #request(
    request: DevicePeerRemoteDesktopHostRequest,
    value: unknown
  ): Promise<unknown> {
    if (this.#retired) throw failure(RemoteDesktopFailureReason.STOPPED, false);
    throwIfAborted(request.signal);
    try {
      return await this.#signals.run(request.signal, async () => {
        const result = await this.#controller.request(this.#authority(request.controllerDeviceId), value);
        throwIfAborted(request.signal);
        return result;
      });
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      throw translateFailure(error);
    }
  }

  async #capabilities(): Promise<RemoteDesktopHostCapabilities> {
    const enabled = this.#dependencies.enabled();
    if (!enabled) {
      return Object.freeze({
        version: 1,
        enabled: false,
        canControl: false,
        clipboardText: false,
        clipboardContent: false,
        videoSettings: true,
        systemAudio: this.#dependencies.systemAudio,
        backgroundViewing: true,
        displayModes: this.#dependencies.platform === "darwin"
          && this.#dependencies.displayModes !== undefined
          && this.#dependencies.setDisplayMode !== undefined,
        cursorOverlay: this.#dependencies.platform === "darwin",
        hostMute: this.#dependencies.hostMute !== undefined,
        lockOnExit: this.#dependencies.platform === "darwin" && this.#dependencies.lockScreen !== undefined,
        clipboardSync: false,
        clipboardInline: false,
        privacyScreen: false,
        nativeCredentials: this.#dependencies.platform === "darwin" && this.#credentials !== undefined,
        resolutionRestore: this.#dependencies.platform === "darwin"
          && this.#dependencies.displayModes !== undefined && this.#dependencies.setDisplayMode !== undefined
          && this.#dependencies.restoreDisplayMode !== undefined,
        viewerDisplay: false,
        viewerDisplayRestore: false,
        workspaceNavigation: false,
        systemMenu: false,
        platform: this.#dependencies.platform,
        displays: Object.freeze([]),
        permissions: disabledPermissions(this.#dependencies.platform)
      });
    }
    await this.#refreshSessionState();
    // A trusted Linux locker may be unlocked before capture. Metadata never grants pixels or input.
    const credentialOnly = this.#dependencies.platform === "linux" && this.#sessionState === "unsupported"
      && this.#credentials !== undefined && await this.#dependencies.credentials!.lockState!(this.#signal()) === "locked";
    const generation = credentialOnly ? this.#sessionGeneration : this.#requireSessionViewable();
    const validate = async (): Promise<void> => {
      if (credentialOnly) {
        const locked = await this.#dependencies.credentials!.lockState!(this.#signal());
        if (this.#retired || !this.#dependencies.enabled() || this.#sessionState !== "unsupported"
          || generation !== this.#sessionGeneration
          || locked !== "locked") staleHostOperation();
      } else if (this.#validateSessionCompletion(generation) === "stale") staleHostOperation();
    };
    const permissions = await this.#dependencies.permissions(this.#signal());
    await this.#refreshSessionState();
    await validate();
    const displays = await this.#dependencies.displays(this.#signal());
    const linux = this.#dependencies.platform === "linux"
      ? await this.#dependencies.linuxCapabilities?.(this.#signal()) : undefined;
    const windows = this.#dependencies.platform === "win32"
      ? await this.#dependencies.windowsCapabilities?.(this.#signal()) : undefined;
    const viewerDisplay = this.#dependencies.platform === "darwin" && this.#dependencies.createViewerDisplay !== undefined
      ? await this.#dependencies.viewerDisplaySupported?.(this.#signal()) === true : linux?.viewerDisplay === true;
    const nativeCredentials = this.#credentials !== undefined && (this.#dependencies.platform !== "linux"
      || await this.#dependencies.credentials!.lockState!(this.#signal()) !== "unavailable");
    await this.#refreshSessionState();
    await validate();
    return Object.freeze({
      version: 1,
      enabled: true,
      canControl: (this.#sessionState === "unlocked" && (this.#dependencies.platform !== "linux" || linux?.canControl === true))
        || this.#sessionState === "locked-logged-in" && windows?.canControl === true,
      clipboardText: this.#sessionState === "unlocked" && this.#dependencies.clipboard !== undefined,
      clipboardContent: this.#sessionState === "unlocked" && this.#dependencies.clipboard !== undefined,
      videoSettings: true,
      systemAudio: this.#dependencies.systemAudio,
      backgroundViewing: true,
      displayModes: (this.#dependencies.platform === "darwin" || linux?.displayModes === true)
        && this.#dependencies.displayModes !== undefined
        && this.#dependencies.setDisplayMode !== undefined,
      cursorOverlay: this.#dependencies.platform === "darwin" || linux?.cursorOverlay === true || windows?.cursorOverlay === true,
      hostMute: this.#sessionState === "unlocked" && this.#dependencies.hostMute !== undefined,
      lockOnExit: (this.#dependencies.platform === "darwin" || linux?.lockOnExit === true)
        && this.#dependencies.lockScreen !== undefined
        && (this.#dependencies.platform !== "linux" || this.#dependencies.lockSessionState !== undefined),
      clipboardSync: this.#sessionState === "unlocked" && this.#dependencies.clipboard !== undefined
        && this.#dependencies.clipboardCounter !== undefined,
      privacyScreen: this.#sessionState === "unlocked" && this.#dependencies.privacyScreen !== undefined
        && (this.#dependencies.platform !== "linux" || linux?.privacyScreen === true),
      nativeCredentials,
      resolutionRestore: (this.#dependencies.platform === "darwin" || linux?.displayModes === true)
        && this.#dependencies.displayModes !== undefined && this.#dependencies.setDisplayMode !== undefined
        && this.#dependencies.restoreDisplayMode !== undefined,
      viewerDisplay: viewerDisplay && this.#dependencies.createViewerDisplay !== undefined,
      viewerDisplayRestore: viewerDisplay && this.#dependencies.createViewerDisplay !== undefined,
      workspaceNavigation: this.#sessionState === "unlocked" && linux?.workspaceNavigation === true
        && this.#dependencies.workspaceAction !== undefined && this.#dependencies.stopWorkspaceActions !== undefined,
      systemMenu: this.#sessionState === "unlocked" && linux?.workspaceNavigation === true && linux.systemMenu === true
        && this.#dependencies.workspaceAction !== undefined && this.#dependencies.stopWorkspaceActions !== undefined,
      clipboardInline: this.#sessionState === "unlocked" && this.#dependencies.clipboard !== undefined
        && this.#dependencies.clipboardCounter !== undefined,
      platform: this.#dependencies.platform,
      displays,
      permissions
    });
  }

  #requireEnabled(): void {
    if (!this.#dependencies.enabled()) throw new Error("REMOTE_DESKTOP_DISABLED");
  }

  #requireCredentialAuthority(request: DevicePeerRemoteDesktopHostRequest): void {
    throwIfAborted(request.signal);
    if (this.#retired || !validControllerId(request.controllerDeviceId)) throw failure(RemoteDesktopFailureReason.AUTHORITY_CHANGED, false);
    if (!this.#dependencies.enabled()) throw failure(RemoteDesktopFailureReason.DISABLED, false);
  }

  async #clipboardRequest<T>(
    request: DevicePeerRemoteDesktopLeaseRequest & { readonly controlGeneration: bigint;
      readonly sync?: boolean; readonly syncGeneration?: bigint },
    operation: (
      clipboard: DesktopRemoteDesktopClipboardPort,
      current: () => boolean
    ) => Promise<T>
  ): Promise<T> {
    if (this.#retired) throw failure(RemoteDesktopFailureReason.STOPPED, false);
    throwIfAborted(request.signal);
    const clipboard = this.#dependencies.clipboard;
    if (clipboard === undefined) {
      throw failure(RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE, false);
    }
    if (request.controlGeneration < 1n
      || request.controlGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw failure(RemoteDesktopFailureReason.CLIPBOARD_EXPIRED, false);
    }
    const generation = Number(request.controlGeneration);
    const authority = this.#authority(request.controllerDeviceId);
    if (this.#dependencies.platform === "linux") await this.#refreshSessionState();
    const sessionGeneration = this.#sessionGeneration;
    const current = (): boolean => !request.signal.aborted && this.#sessionState === "unlocked"
      && this.#sessionGeneration === sessionGeneration && this.#sessionTransitionGeneration === undefined && (request.sync
      ? request.syncGeneration !== undefined && exactGeneration(request.syncGeneration)
        && this.#controller.isClipboardSyncCurrent(authority, request.leaseId, generation, Number(request.syncGeneration))
      : this.#controller.isControlCurrent(authority, request.leaseId, generation));
    if (!current()) throw failure(RemoteDesktopFailureReason.CLIPBOARD_EXPIRED, false);
    try {
      return await this.#signals.run(request.signal, async () => {
        const value = await operation(clipboard, current);
        if (this.#dependencies.platform === "linux") await this.#refreshSessionState();
        throwIfAborted(request.signal);
        if (!current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
        return value;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "REMOTE_DESKTOP_CLIPBOARD_OUTCOME_UNKNOWN"
        && "outcomeUnknown" in error && error.outcomeUnknown === true) {
        throw new DevicePeerRemoteDesktopHostError(RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE, false, true);
      }
      if (request.signal.aborted) throw request.signal.reason;
      throw translateFailure(error);
    }
  }

  async #whileSessionViewable<T>(
    operation: (sessionGeneration: number) => Promise<T>,
    stale: () => T
  ): Promise<T> {
    if (this.#dependencies.platform === "linux") await this.#refreshSessionState();
    if (this.#sessionTransitionGeneration !== undefined) return stale();
    const generation = this.#requireSessionViewable();
    try {
      const value = await operation(generation);
      if (this.#dependencies.platform === "linux") await this.#refreshSessionState();
      if (this.#validateSessionCompletion(generation) === "stale") return stale();
      return value;
    } catch (error) {
      if (this.#dependencies.platform === "linux") await this.#refreshSessionState();
      if (this.#validateSessionCompletion(generation) === "stale") return stale();
      throw error;
    }
  }

  async #whileSessionControllable<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#dependencies.platform !== "win32") return this.#whileSessionUnlocked(operation);
    await this.#refreshSessionState();
    const generation = this.#requireSessionViewable();
    const proof = await this.#dependencies.windowsCapabilities?.(this.#signal());
    if (generation !== this.#sessionGeneration || this.#sessionState !== "unlocked" && proof?.canControl !== true) {
      throw new Error("REMOTE_DESKTOP_VIEW_ONLY");
    }
    const value = await operation();
    await this.#refreshSessionState();
    if (generation !== this.#sessionGeneration || !isViewableSession(this.#sessionState)) {
      this.#dependencies.input.stop();
      throw new Error("REMOTE_DESKTOP_VIEW_ONLY");
    }
    return value;
  }

  async #whileSessionUnlocked<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#dependencies.platform === "linux") await this.#refreshSessionState();
    const generation = this.#requireSessionUnlocked();
    try {
      const value = await operation();
      if (this.#dependencies.platform === "linux") await this.#refreshSessionState();
      this.#revalidateSessionUnlocked(generation);
      return value;
    } catch (error) {
      if (this.#dependencies.platform === "linux") await this.#refreshSessionState();
      this.#revalidateSessionUnlocked(generation);
      throw error;
    }
  }

  #requireSessionViewable(): number {
    if (!isViewableSession(this.#sessionState)) {
      this.#stopUnviewableSession();
      throw new Error("REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED");
    }
    return this.#sessionGeneration;
  }

  #validateSessionCompletion(generation: number): "current" | "stale" {
    if (this.#sessionTransitionGeneration !== undefined
      || (isViewableSession(this.#sessionState) && generation !== this.#sessionGeneration)) {
      return "stale";
    }
    if (!isViewableSession(this.#sessionState)) {
      this.#stopUnviewableSession();
      throw new Error("REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED");
    }
    return "current";
  }

  #requireSessionUnlocked(): number {
    if (this.#sessionState !== "unlocked") {
      throw new Error(this.#sessionTransitionGeneration !== undefined
        || this.#sessionState === "locked-logged-in"
        ? "REMOTE_DESKTOP_VIEW_ONLY"
        : "REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED");
    }
    return this.#sessionGeneration;
  }

  #revalidateSessionUnlocked(generation: number): void {
    if (this.#sessionState !== "unlocked" || generation !== this.#sessionGeneration) {
      throw new Error(this.#sessionTransitionGeneration !== undefined
        || this.#sessionState === "locked-logged-in"
        || this.#sessionState === "unlocked"
        ? "REMOTE_DESKTOP_VIEW_ONLY"
        : "REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED");
    }
  }

  #beginSessionTransition(): void {
    if (this.#retired) return;
    const generation = ++this.#sessionGeneration;
    this.#sessionTransitionGeneration = generation;
    this.#sessionState = "unknown";
    // Fence control/clipboard and clear all old pixels/native cursor state
    // before the asynchronous native session probe begins.
    this.#controller.releaseControl();
    if (this.#dependencies.platform === "linux" && this.#dependencies.systemAudio) {
      this.#dependencies.media.setSessionState(false, "unknown");
    } else this.#dependencies.media.setSessionState(false);
    void this.#probeSessionState(generation, NEVER_ABORTED);
  }

  async #refreshSessionState(): Promise<void> {
    const generation = this.#sessionGeneration;
    await this.#probeSessionState(generation, this.#signal());
  }

  async #probeSessionState(generation: number, signal: AbortSignal): Promise<void> {
    let state: DesktopRemoteDesktopSessionState = "unknown";
    try { state = await this.#dependencies.sessionState(signal); }
    catch {
      if (signal.aborted) throw signal.reason;
    }
    if (this.#retired || generation !== this.#sessionGeneration) return;
    if (this.#sessionTransitionGeneration === generation) {
      this.#sessionTransitionGeneration = undefined;
    }
    if (state === this.#sessionState) {
      if (!isViewableSession(state)) this.#stopUnviewableSession();
      return;
    }
    // A change discovered by the fresh probe is fenced before any subsequent
    // pixel or native effect can start.
    this.#sessionGeneration += 1;
    this.#sessionState = state;
    this.#controller.releaseControl();
    if (this.#dependencies.platform === "linux" && this.#dependencies.systemAudio) {
      this.#dependencies.media.setSessionState(state === "locked-logged-in", state);
    } else this.#dependencies.media.setSessionState(state === "locked-logged-in");
    if (!isViewableSession(state) && this.#controller.state !== undefined) {
      this.#stopUnviewableSession();
    }
  }

  #stopUnviewableSession(): void {
    // A Linux lock ending owns its independent raw session proof. Preserve only
    // that captured terminal occurrence; ordinary pixels and input still fail.
    if (this.#terminalLockCurrent?.() === true) return;
    if (this.#controller.state !== undefined) this.#controller.stop();
  }

  #signal(): AbortSignal {
    return this.#signals.getStore() ?? NEVER_ABORTED;
  }

  #authority(controllerDeviceId: string): RemoteDesktopAuthority {
    return Object.freeze({ controllerDeviceId, lifecycleToken: this.#lifecycleToken });
  }
}

function desktopVideoQualityFromContract(
  value: RemoteDesktopVideoQuality
): DesktopRemoteDesktopVideoQuality {
  switch (value) {
    case RemoteDesktopVideoQuality.AUTO: return "auto";
    case RemoteDesktopVideoQuality.SAVER: return "saver";
    case RemoteDesktopVideoQuality.HD: return "hd";
    default: throw new TypeError("Remote Desktop video quality is invalid.");
  }
}

function isViewableSession(state: DesktopRemoteDesktopSessionState): boolean {
  return state === "unlocked" || state === "locked-logged-in";
}

function exactGeneration(value: bigint): boolean {
  return typeof value === "bigint" && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
}

function staleVideoOperation(): never {
  throw new Error("REMOTE_DESKTOP_VIDEO_BUSY");
}

function staleDisplayOperation(): never {
  throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
}

function staleHostOperation(): never {
  throw new Error("REMOTE_DESKTOP_BUSY");
}

function validControllerId(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function disabledPermissions(platform: DesktopRemoteDesktopHostDependencies["platform"]): RemoteDesktopPermissions {
  return platform === "darwin"
    ? Object.freeze({ screenRecording: "unknown", accessibility: "unknown" })
    : Object.freeze({ screenRecording: "notRequired", accessibility: "notRequired" });
}

function permissionsToContract(value: RemoteDesktopPermissions) {
  return create(RemoteDesktopPermissionsSchema, {
    screenRecording: permissionToContract(value.screenRecording),
    accessibility: permissionToContract(value.accessibility)
  });
}

function permissionToContract(value: RemoteDesktopPermissions["screenRecording"]): RemoteDesktopPermissionStatus {
  switch (value) {
    case "granted": return RemoteDesktopPermissionStatus.GRANTED;
    case "missing": return RemoteDesktopPermissionStatus.MISSING;
    case "unknown": return RemoteDesktopPermissionStatus.UNKNOWN;
    case "notRequired": return RemoteDesktopPermissionStatus.NOT_REQUIRED;
  }
}

function inputFromContract(value: RemoteDesktopInputEvent): RemoteDesktopInput {
  switch (value.event.case) {
    case "move": return Object.freeze({ kind: "move", x: value.event.value.x, y: value.event.value.y });
    case "button": return Object.freeze({
      kind: "button",
      button: mouseButton(value.event.value.button),
      down: value.event.value.down,
      x: value.event.value.x,
      y: value.event.value.y
    });
    case "scroll": return Object.freeze({
      kind: "scroll",
      dx: value.event.value.deltaX,
      dy: value.event.value.deltaY
    });
    case "key": return Object.freeze({
      kind: "key",
      code: value.event.value.code as Extract<RemoteDesktopInput, { readonly kind: "key" }>["code"],
      down: value.event.value.down
    });
    case "text": return Object.freeze({ kind: "text", text: value.event.value.text });
    case "release": return Object.freeze({ kind: "release" });
    case undefined: throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
  }
}

function mouseButton(value: RemoteDesktopMouseButton): 0 | 1 | 2 {
  switch (value) {
    case RemoteDesktopMouseButton.LEFT: return 0;
    case RemoteDesktopMouseButton.MIDDLE: return 1;
    case RemoteDesktopMouseButton.RIGHT: return 2;
    default: throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
  }
}

function translateFailure(error: unknown): unknown {
  if (error instanceof DevicePeerRemoteDesktopHostError) return error;
  const code = error instanceof Error ? error.message : "";
  switch (code) {
    case "REMOTE_DESKTOP_DISABLED": return failure(RemoteDesktopFailureReason.DISABLED, false);
    case "REMOTE_DESKTOP_BUSY": return failure(RemoteDesktopFailureReason.BUSY, true);
    case "REMOTE_DESKTOP_STOPPED":
    case "REMOTE_DESKTOP_VIDEO_STOPPED": return failure(RemoteDesktopFailureReason.STOPPED, false);
    case "REMOTE_DESKTOP_LEASE_EXPIRED": return failure(RemoteDesktopFailureReason.LEASE_EXPIRED, false);
    case "REMOTE_DESKTOP_DISPLAY_MISSING": return failure(RemoteDesktopFailureReason.DISPLAY_MISSING, false);
    case "REMOTE_DESKTOP_SCREEN_PERMISSION_REQUIRED":
      return failure(RemoteDesktopFailureReason.SCREEN_PERMISSION_REQUIRED, false);
    case "REMOTE_DESKTOP_ACCESSIBILITY_PERMISSION_REQUIRED":
      return failure(RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED, false);
    case "REMOTE_DESKTOP_INPUT_UNAVAILABLE": return failure(RemoteDesktopFailureReason.INPUT_UNAVAILABLE, true);
    case "REMOTE_DESKTOP_INPUT_BUSY": return failure(RemoteDesktopFailureReason.INPUT_BUSY, true);
    case "REMOTE_DESKTOP_VIEW_ONLY": return failure(RemoteDesktopFailureReason.VIEW_ONLY, false);
    case "REMOTE_DESKTOP_VIDEO_BUSY": return failure(RemoteDesktopFailureReason.VIDEO_BUSY, true);
    case "REMOTE_DESKTOP_VIDEO_TIMEOUT": return failure(RemoteDesktopFailureReason.VIDEO_TIMEOUT, true);
    case "REMOTE_DESKTOP_VIDEO_UNAVAILABLE": return failure(RemoteDesktopFailureReason.VIDEO_UNAVAILABLE, true);
    case "REMOTE_DESKTOP_CAPTURE_PENDING": return failure(RemoteDesktopFailureReason.CAPTURE_PENDING, true);
    case "REMOTE_DESKTOP_AUDIO_UNAVAILABLE": return failure(RemoteDesktopFailureReason.AUDIO_UNAVAILABLE, true);
    case "REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE":
      return failure(RemoteDesktopFailureReason.DISPLAY_MODES_UNAVAILABLE, false);
    case "REMOTE_DESKTOP_DISPLAY_MODE_MISSING":
      return failure(RemoteDesktopFailureReason.DISPLAY_MODE_MISSING, false);
    case "REMOTE_DESKTOP_DISPLAY_BUSY":
      return failure(RemoteDesktopFailureReason.DISPLAY_BUSY, true);
    case "REMOTE_DESKTOP_ACCESS_REVOKED":
      return failure(RemoteDesktopFailureReason.AUTHORITY_CHANGED, false);
    case "REMOTE_DESKTOP_AUTHENTICATION_REQUIRED":
      return failure(RemoteDesktopFailureReason.AUTHENTICATION_REQUIRED, false);
    case "REMOTE_DESKTOP_INPUT_UNSUPPORTED":
      return failure(RemoteDesktopFailureReason.UNSUPPORTED, false);
    case "REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED":
      return failure(RemoteDesktopFailureReason.LOCKED_SESSION_UNSUPPORTED, false);
    case "REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE":
    case "REMOTE_DESKTOP_CLIPBOARD_COPY_FAILED":
    case "REMOTE_DESKTOP_CLIPBOARD_WRITE_FAILED":
      return failure(RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE, true);
    case "REMOTE_DESKTOP_PRIVACY_UNAVAILABLE":
      return failure(RemoteDesktopFailureReason.PRIVACY_UNAVAILABLE, false);
    case "REMOTE_DESKTOP_PRIVACY_FAILED":
      return failure(RemoteDesktopFailureReason.PRIVACY_FAILED, false);
    case "REMOTE_DESKTOP_PRIVACY_EXPIRED":
      return failure(RemoteDesktopFailureReason.PRIVACY_EXPIRED, false);
    case "REMOTE_DESKTOP_CLIPBOARD_CHANGED":
      return failure(RemoteDesktopFailureReason.CLIPBOARD_CHANGED, false);
    case "REMOTE_DESKTOP_CLIPBOARD_EMPTY":
      return failure(RemoteDesktopFailureReason.CLIPBOARD_EMPTY, false);
    case "REMOTE_DESKTOP_CLIPBOARD_TOO_LARGE":
      return failure(RemoteDesktopFailureReason.CLIPBOARD_TOO_LARGE, false);
    case "REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED":
      return failure(RemoteDesktopFailureReason.CLIPBOARD_UNSUPPORTED, false);
    case "REMOTE_DESKTOP_CLIPBOARD_EXPIRED":
      return failure(RemoteDesktopFailureReason.CLIPBOARD_EXPIRED, false);
    case "REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE":
      return failure(RemoteDesktopFailureReason.HOST_MUTE_UNAVAILABLE, true);
    case "REMOTE_DESKTOP_HOST_MUTE_EXPIRED":
      return failure(RemoteDesktopFailureReason.HOST_MUTE_EXPIRED, false);
    case "REMOTE_DESKTOP_SYSTEM_ACTION_UNAVAILABLE":
      return failure(RemoteDesktopFailureReason.SYSTEM_ACTION_UNAVAILABLE, true);
    case "REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED":
      return failure(RemoteDesktopFailureReason.SYSTEM_ACTION_EXPIRED, false);
    case "REMOTE_DESKTOP_LOCK_UNAVAILABLE":
      return failure(RemoteDesktopFailureReason.LOCK_UNAVAILABLE, false);
    case "REMOTE_DESKTOP_LOCK_FAILED":
      return failure(RemoteDesktopFailureReason.LOCK_FAILED, false);
    case "REMOTE_DESKTOP_LOCK_EXPIRED":
      return failure(RemoteDesktopFailureReason.LOCK_EXPIRED, false);
    case "REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE":
      return failure(RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE, false);
    default: return error;
  }
}

function failure(reason: RemoteDesktopFailureReason, retryable: boolean): DevicePeerRemoteDesktopHostError {
  return new DevicePeerRemoteDesktopHostError(reason, retryable);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new Error("Remote Desktop request was aborted.");
}
