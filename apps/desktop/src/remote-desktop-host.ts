import { AsyncLocalStorage } from "node:async_hooks";

import { create } from "@bufbuild/protobuf";
import {
  RemoteDesktopCapabilitiesSchema,
  RemoteDesktopClipboardContentSchema,
  RemoteDesktopControlStateSchema,
  RemoteDesktopCursorSchema,
  RemoteDesktopDisplaySchema,
  RemoteDesktopDisplayModeSchema,
  RemoteDesktopFailureReason,
  RemoteDesktopFrameResultSchema,
  RemoteDesktopFrameSchema,
  RemoteDesktopIceCandidateSchema,
  RemoteDesktopIceExchangeResultSchema,
  RemoteDesktopLeaseSchema,
  RemoteDesktopMouseButton,
  RemoteDesktopOfferResultSchema,
  RemoteDesktopPermissionsSchema,
  RemoteDesktopPermissionStatus,
  RemoteDesktopPresentationProofSchema,
  RemoteDesktopStartMode,
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
  type RemoteDesktopPermissions
} from "@joko/device-peer";

import type { DesktopRemoteDesktopClipboardContent } from "./remote-desktop-clipboard.js";
import type {
  DesktopRemoteDesktopVideoQuality,
  DesktopRemoteDesktopVideoSettings
} from "./remote-desktop-media-settings.js";
import type { DesktopRemoteDesktopSessionState } from "./remote-desktop-input.js";

export interface DesktopRemoteDesktopMediaPort {
  frame(
    displayId: string,
    cursorOverlay: boolean,
    signal: AbortSignal
  ): Promise<RemoteDesktopJpegFrame | null>;
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
  setSessionState(nativeOnly: boolean): void;
  stop(): void;
  retire(): Promise<void>;
}

export interface DesktopRemoteDesktopInputPort {
  start(displayId: string, signal: AbortSignal): Promise<void>;
  send(events: readonly RemoteDesktopInput[]): void;
  stop(): void;
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
}

export interface DesktopRemoteDesktopHostDependencies {
  readonly platform: "darwin" | "win32" | "linux";
  readonly systemAudio: boolean;
  enabled(): boolean;
  sessionState(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState>;
  displays(): readonly RemoteDesktopDisplay[];
  permissions(signal: AbortSignal): Promise<RemoteDesktopPermissions>;
  showPermissionGuide(signal: AbortSignal): Promise<void>;
  readonly media: DesktopRemoteDesktopMediaPort;
  readonly input: DesktopRemoteDesktopInputPort;
  readonly clipboard?: DesktopRemoteDesktopClipboardPort;
  displayModes?(displayId: string, signal: AbortSignal): Promise<readonly RemoteDesktopDisplayMode[]>;
  setDisplayMode?(
    displayId: string,
    modeId: string,
    beforeChange: () => void,
    signal: AbortSignal
  ): Promise<void>;
  changed(state: DesktopRemoteDesktopState | undefined): void;
  retired?(): void;
  onDisplayChange?(listener: (displayId: string, geometryChanged: boolean) => void): () => void;
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
  readonly #signals = new AsyncLocalStorage<AbortSignal>();
  readonly #lifecycleToken = Object.freeze({});
  readonly #stopInputHandler: () => void;
  readonly #stopPresentationPongHandler: () => void;
  readonly #stopSubscriptions: readonly (() => void)[];
  readonly #timer: ReturnType<typeof setInterval>;
  #sessionState: DesktopRemoteDesktopSessionState = "unknown";
  #sessionGeneration = 0;
  #sessionTransitionGeneration: number | undefined;
  #retired = false;

  constructor(dependencies: DesktopRemoteDesktopHostDependencies) {
    this.#dependencies = dependencies;
    this.#controller = new RemoteDesktopController({
      authorityCurrent: (authority) => !this.#retired
        && authority.lifecycleToken === this.#lifecycleToken
        && validControllerId(authority.controllerDeviceId),
      capabilities: async () => this.#capabilities(),
      permissions: async (action) => {
        this.#requireEnabled();
        if (action === "guide") await dependencies.showPermissionGuide(this.#signal());
        return dependencies.permissions(this.#signal());
      },
      frame: (displayId, cursorOverlay) => this.#whileSessionViewable(
        () => dependencies.media.frame(
          displayId,
          cursorOverlay,
          this.#signal()
        ),
        () => null
      ),
      startInput: (displayId) => this.#whileSessionUnlocked(
        () => dependencies.input.start(displayId, this.#signal())
      ),
      input: (events) => dependencies.input.send(events),
      stopInput: () => dependencies.input.stop(),
      stopVideo: () => dependencies.media.stop(),
      offer: (lease, sdp, attemptId, settings, cursorOverlay, authority) =>
        this.#whileSessionViewable((sessionGeneration) => dependencies.media.offer({
          displayId: lease.display.id,
          leaseId: lease.lease,
          attemptId,
          offerSdp: sdp,
          cursorOverlay,
          ...(settings === undefined ? {} : { settings }),
          current: () => sessionGeneration === this.#sessionGeneration
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
        setDisplayMode: (displayId: string, modeId: string, beforeChange: () => void) =>
          this.#whileSessionUnlocked(() => dependencies.setDisplayMode!(
            displayId,
            modeId,
            beforeChange,
            this.#signal()
          ))
      }),
      changed: () => dependencies.changed(this.state),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.createLeaseId === undefined ? {} : { createLeaseId: dependencies.createLeaseId })
    });
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
      subscriptions.push(dependencies.onDisplayChange((displayId, geometryChanged) => {
        const state = this.#controller.state;
        if (state?.displayId === displayId && geometryChanged) this.#controller.stop();
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

  /** Explicit local Disconnect also fences RESUME for the ended lease. */
  disconnect(): void {
    if (this.#retired) return;
    this.#controller.stopByUser();
  }

  /** Native injection failure is control-scoped; picture and lease stay alive. */
  releaseControl(): void {
    if (this.#retired) return;
    this.#controller.releaseControl();
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
      cursorOverlay: value.cursorOverlay
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

  async stop(request: DevicePeerRemoteDesktopLeaseRequest): Promise<void> {
    await this.#request(request, { op: "stop", lease: request.leaseId });
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
  }): Promise<void> {
    if (request.controlGeneration < 1n
      || request.controlGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw failure(RemoteDesktopFailureReason.LEASE_EXPIRED, false);
    }
    await this.#request(request, {
      op: "resolution",
      lease: request.leaseId,
      controlGeneration: Number(request.controlGeneration),
      modeId: request.modeId
    });
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
  }): Promise<RemoteDesktopClipboardContent> {
    const value = await this.#clipboardRequest(request, (clipboard, current) =>
      clipboard.copyContent(current, request.signal));
    return create(RemoteDesktopClipboardContentSchema, value);
  }

  async pasteClipboardContent(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
    readonly content: RemoteDesktopClipboardContent;
  }): Promise<void> {
    const content: DesktopRemoteDesktopClipboardContent = Object.freeze({
      ...(request.content.text === undefined ? {} : { text: request.content.text }),
      ...(request.content.html === undefined ? {} : { html: request.content.html }),
      ...(request.content.rtf === undefined ? {} : { rtf: request.content.rtf }),
      ...(request.content.url === undefined ? {} : { url: request.content.url }),
      ...(request.content.png === undefined ? {} : { png: request.content.png })
    });
    await this.#clipboardRequest(request, (clipboard, current) =>
      clipboard.pasteContent(content, current, request.signal));
  }

  async retire(): Promise<void> {
    if (this.#retired) return;
    this.#retired = true;
    clearInterval(this.#timer);
    this.#stopInputHandler();
    this.#stopPresentationPongHandler();
    for (const stop of this.#stopSubscriptions) stop();
    this.#controller.stop();
    await Promise.allSettled([
      this.#dependencies.input.retire(),
      this.#dependencies.media.retire()
    ]);
    this.#dependencies.retired?.();
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
        platform: this.#dependencies.platform,
        displays: Object.freeze([]),
        permissions: disabledPermissions(this.#dependencies.platform)
      });
    }
    await this.#refreshSessionState();
    const generation = this.#requireSessionViewable();
    const permissions = await this.#dependencies.permissions(this.#signal());
    await this.#refreshSessionState();
    if (this.#validateSessionCompletion(generation) === "stale") staleHostOperation();
    const displays = this.#dependencies.displays();
    if (this.#validateSessionCompletion(generation) === "stale") staleHostOperation();
    return Object.freeze({
      version: 1,
      enabled: true,
      canControl: this.#sessionState === "unlocked" && this.#dependencies.platform !== "linux",
      clipboardText: this.#sessionState === "unlocked" && this.#dependencies.clipboard !== undefined,
      clipboardContent: this.#sessionState === "unlocked" && this.#dependencies.clipboard !== undefined,
      videoSettings: true,
      systemAudio: this.#dependencies.systemAudio,
      backgroundViewing: true,
      displayModes: this.#dependencies.platform === "darwin"
        && this.#dependencies.displayModes !== undefined
        && this.#dependencies.setDisplayMode !== undefined,
      cursorOverlay: this.#dependencies.platform === "darwin",
      platform: this.#dependencies.platform,
      displays,
      permissions
    });
  }

  #requireEnabled(): void {
    if (!this.#dependencies.enabled()) throw new Error("REMOTE_DESKTOP_DISABLED");
  }

  async #clipboardRequest<T>(
    request: DevicePeerRemoteDesktopLeaseRequest & { readonly controlGeneration: bigint },
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
    const current = (): boolean => this.#controller.isControlCurrent(
      authority,
      request.leaseId,
      generation
    );
    if (!current()) throw failure(RemoteDesktopFailureReason.CLIPBOARD_EXPIRED, false);
    try {
      return await this.#signals.run(request.signal, async () => {
        const value = await operation(clipboard, current);
        throwIfAborted(request.signal);
        if (!current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
        return value;
      });
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      throw translateFailure(error);
    }
  }

  async #whileSessionViewable<T>(
    operation: (sessionGeneration: number) => Promise<T>,
    stale: () => T
  ): Promise<T> {
    if (this.#sessionTransitionGeneration !== undefined) return stale();
    const generation = this.#requireSessionViewable();
    try {
      const value = await operation(generation);
      if (this.#validateSessionCompletion(generation) === "stale") return stale();
      return value;
    } catch (error) {
      if (this.#validateSessionCompletion(generation) === "stale") return stale();
      throw error;
    }
  }

  async #whileSessionUnlocked<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.#requireSessionUnlocked();
    try {
      const value = await operation();
      this.#revalidateSessionUnlocked(generation);
      return value;
    } catch (error) {
      this.#revalidateSessionUnlocked(generation);
      throw error;
    }
  }

  #requireSessionViewable(): number {
    if (!isViewableSession(this.#sessionState)) {
      if (this.#controller.state !== undefined) this.#controller.stop();
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
      if (this.#controller.state !== undefined) this.#controller.stop();
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
    this.#dependencies.media.setSessionState(false);
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
      if (!isViewableSession(state) && this.#controller.state !== undefined) this.#controller.stop();
      return;
    }
    // A change discovered by the fresh probe is fenced before any subsequent
    // pixel or native effect can start.
    this.#sessionGeneration += 1;
    this.#sessionState = state;
    this.#controller.releaseControl();
    this.#dependencies.media.setSessionState(state === "locked-logged-in");
    if (!isViewableSession(state) && this.#controller.state !== undefined) {
      this.#controller.stop();
    }
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
    case "REMOTE_DESKTOP_AUDIO_UNAVAILABLE": return failure(RemoteDesktopFailureReason.AUDIO_UNAVAILABLE, true);
    case "REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE":
      return failure(RemoteDesktopFailureReason.DISPLAY_MODES_UNAVAILABLE, false);
    case "REMOTE_DESKTOP_DISPLAY_MODE_MISSING":
      return failure(RemoteDesktopFailureReason.DISPLAY_MODE_MISSING, false);
    case "REMOTE_DESKTOP_DISPLAY_BUSY":
      return failure(RemoteDesktopFailureReason.DISPLAY_BUSY, true);
    case "REMOTE_DESKTOP_ACCESS_REVOKED":
      return failure(RemoteDesktopFailureReason.AUTHORITY_CHANGED, false);
    case "REMOTE_DESKTOP_INPUT_UNSUPPORTED":
      return failure(RemoteDesktopFailureReason.UNSUPPORTED, false);
    case "REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED":
      return failure(RemoteDesktopFailureReason.LOCKED_SESSION_UNSUPPORTED, false);
    case "REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE":
    case "REMOTE_DESKTOP_CLIPBOARD_COPY_FAILED":
    case "REMOTE_DESKTOP_CLIPBOARD_WRITE_FAILED":
      return failure(RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE, true);
    case "REMOTE_DESKTOP_CLIPBOARD_CHANGED":
      return failure(RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE, true);
    case "REMOTE_DESKTOP_CLIPBOARD_EMPTY":
      return failure(RemoteDesktopFailureReason.CLIPBOARD_EMPTY, false);
    case "REMOTE_DESKTOP_CLIPBOARD_TOO_LARGE":
      return failure(RemoteDesktopFailureReason.CLIPBOARD_TOO_LARGE, false);
    case "REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED":
      return failure(RemoteDesktopFailureReason.CLIPBOARD_UNSUPPORTED, false);
    case "REMOTE_DESKTOP_CLIPBOARD_EXPIRED":
      return failure(RemoteDesktopFailureReason.CLIPBOARD_EXPIRED, false);
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
