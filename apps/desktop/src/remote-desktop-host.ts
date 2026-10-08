import { AsyncLocalStorage } from "node:async_hooks";

import { create } from "@bufbuild/protobuf";
import {
  RemoteDesktopCapabilitiesSchema,
  RemoteDesktopClipboardContentSchema,
  RemoteDesktopControlStateSchema,
  RemoteDesktopDisplaySchema,
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
  RemoteDesktopStartMode,
  type RemoteDesktopClipboardContent,
  type RemoteDesktopInputEvent
} from "@joko/contracts";
import {
  DevicePeerRemoteDesktopHostError,
  RemoteDesktopController,
  type DevicePeerRemoteDesktopHostPort,
  type DevicePeerRemoteDesktopHostRequest,
  type DevicePeerRemoteDesktopLeaseRequest,
  type RemoteDesktopAuthority,
  type RemoteDesktopDisplay,
  type RemoteDesktopHostCapabilities,
  type RemoteDesktopIceCandidate,
  type RemoteDesktopInput,
  type RemoteDesktopJpegFrame,
  type RemoteDesktopPermissions
} from "@joko/device-peer";

import type { DesktopRemoteDesktopClipboardContent } from "./remote-desktop-clipboard.js";

export interface DesktopRemoteDesktopMediaPort {
  frame(displayId: string, signal: AbortSignal): Promise<RemoteDesktopJpegFrame | null>;
  offer(request: {
    readonly displayId: string;
    readonly leaseId: string;
    readonly attemptId: string;
    readonly offerSdp: string;
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
  enabled(): boolean;
  sessionUnlocked(): boolean;
  displays(): readonly RemoteDesktopDisplay[];
  permissions(signal: AbortSignal): Promise<RemoteDesktopPermissions>;
  showPermissionGuide(signal: AbortSignal): Promise<void>;
  readonly media: DesktopRemoteDesktopMediaPort;
  readonly input: DesktopRemoteDesktopInputPort;
  readonly clipboard?: DesktopRemoteDesktopClipboardPort;
  changed(state: DesktopRemoteDesktopState | undefined): void;
  retired?(): void;
  onDisplayChange?(listener: (displayId: string, geometryChanged: boolean) => void): () => void;
  onSessionStateChange?(listener: (unlocked: boolean) => void): () => void;
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
  readonly #stopSubscriptions: readonly (() => void)[];
  readonly #timer: ReturnType<typeof setInterval>;
  #sessionUnlocked: boolean;
  #sessionGeneration = 0;
  #retired = false;

  constructor(dependencies: DesktopRemoteDesktopHostDependencies) {
    this.#dependencies = dependencies;
    this.#sessionUnlocked = readSessionUnlocked(dependencies);
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
      frame: (displayId) => this.#whileSessionUnlocked(
        () => dependencies.media.frame(displayId, this.#signal())
      ),
      startInput: (displayId) => dependencies.input.start(displayId, this.#signal()),
      input: (events) => dependencies.input.send(events),
      stopInput: () => dependencies.input.stop(),
      stopVideo: () => dependencies.media.stop(),
      offer: (lease, sdp, attemptId) => this.#whileSessionUnlocked(
        () => dependencies.media.offer({
          displayId: lease.display.id,
          leaseId: lease.lease,
          attemptId,
          offerSdp: sdp,
          signal: this.#signal()
        })
      ),
      ice: (request) => dependencies.media.exchangeIce({
        leaseId: request.lease,
        attemptId: request.attemptId,
        candidates: request.candidates,
        after: request.after,
        signal: this.#signal()
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
    const subscriptions: (() => void)[] = [];
    if (dependencies.onDisplayChange !== undefined) {
      subscriptions.push(dependencies.onDisplayChange((displayId, geometryChanged) => {
        const state = this.#controller.state;
        if (state?.displayId === displayId && geometryChanged) this.#controller.stop();
      }));
    }
    if (dependencies.onSessionStateChange !== undefined) {
      subscriptions.push(dependencies.onSessionStateChange((unlocked) => {
        this.#sessionGeneration += 1;
        this.#sessionUnlocked = unlocked;
        if (!unlocked && this.#controller.state !== undefined) this.#controller.stop();
      }));
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
      clipboardContent: value.clipboardContent
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
    return create(RemoteDesktopControlStateSchema, {
      controlling: value.controlling,
      controlGeneration: BigInt(value.controlGeneration)
    });
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
  }) {
    const value = await this.#request(request, {
      op: "offer",
      lease: request.leaseId,
      attemptId: request.attemptId,
      sdp: request.offerSdp
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

  async getFrame(request: DevicePeerRemoteDesktopLeaseRequest) {
    const value = await this.#request(request, { op: "frame", lease: request.leaseId }) as {
      readonly jpeg: string | null;
    };
    return create(RemoteDesktopFrameResultSchema, value.jpeg === null ? {} : {
      frame: create(RemoteDesktopFrameSchema, { jpeg: Buffer.from(value.jpeg, "base64") })
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
        platform: this.#dependencies.platform,
        displays: Object.freeze([]),
        permissions: disabledPermissions(this.#dependencies.platform)
      });
    }
    return this.#whileSessionUnlocked(async () => {
      const permissions = await this.#dependencies.permissions(this.#signal());
      const displays = this.#dependencies.displays();
      return Object.freeze({
        version: 1,
        enabled: true,
        canControl: this.#dependencies.platform !== "linux",
        clipboardText: this.#dependencies.clipboard !== undefined,
        clipboardContent: this.#dependencies.clipboard !== undefined,
        platform: this.#dependencies.platform,
        displays,
        permissions
      });
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

  #requireSessionUnlocked(): number {
    this.#refreshSessionState();
    if (!this.#sessionUnlocked) {
      if (this.#controller.state !== undefined) this.#controller.stop();
      throw new Error("REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED");
    }
    return this.#sessionGeneration;
  }

  #revalidateSessionUnlocked(generation: number): void {
    this.#refreshSessionState();
    if (!this.#sessionUnlocked || generation !== this.#sessionGeneration) {
      if (this.#controller.state !== undefined) this.#controller.stop();
      throw new Error("REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED");
    }
  }

  #refreshSessionState(): void {
    const unlocked = readSessionUnlocked(this.#dependencies);
    if (unlocked === this.#sessionUnlocked) return;
    this.#sessionUnlocked = unlocked;
    this.#sessionGeneration += 1;
  }

  #signal(): AbortSignal {
    return this.#signals.getStore() ?? NEVER_ABORTED;
  }

  #authority(controllerDeviceId: string): RemoteDesktopAuthority {
    return Object.freeze({ controllerDeviceId, lifecycleToken: this.#lifecycleToken });
  }
}

function readSessionUnlocked(dependencies: DesktopRemoteDesktopHostDependencies): boolean {
  try {
    return dependencies.sessionUnlocked() === true;
  } catch {
    return false;
  }
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
