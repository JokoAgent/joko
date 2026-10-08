import {
  REMOTE_DESKTOP_FRAME_INTERVAL_MS,
  REMOTE_DESKTOP_LEASE_MS,
  isBoundedRemoteDesktopJpegFrame,
  parseRemoteDesktopDisplayModes,
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
  type RemoteDesktopPermissions,
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
}

export interface RemoteDesktopControllerState {
  readonly controllerDeviceId: string;
  readonly lease: string;
  readonly displayId: string;
  readonly controlling: boolean;
  readonly controlGeneration: number;
}

export interface RemoteDesktopControllerDependencies {
  /** Must revalidate the exact local executor lifecycle token. */
  authorityCurrent(authority: RemoteDesktopAuthority): boolean;
  capabilities(authority: RemoteDesktopAuthority): Promise<RemoteDesktopHostCapabilities>;
  permissions?(
    action: "check" | "guide",
    authority: RemoteDesktopAuthority
  ): Promise<RemoteDesktopPermissions>;
  frame(
    displayId: string,
    cursorOverlay: boolean,
    authority: RemoteDesktopAuthority
  ): Promise<RemoteDesktopJpegFrame | null>;
  startInput(displayId: string, authority: RemoteDesktopAuthority): Promise<void>;
  input(events: readonly RemoteDesktopInput[], authority: RemoteDesktopAuthority): void;
  stopInput(): void;
  stopVideo(): void;
  offer(
    lease: RemoteDesktopLease,
    sdp: string,
    attemptId: string,
    settings: RemoteDesktopVideoSettings | undefined,
    cursorOverlay: boolean,
    authority: RemoteDesktopAuthority
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
    beforeChange: () => void,
    authority: RemoteDesktopAuthority
  ): Promise<void>;
  changed(): void;
  now?(): number;
  createLeaseId?(): string;
}

interface ActiveRemoteDesktopLease {
  readonly lease: string;
  readonly display: RemoteDesktopLease["display"];
  readonly canControl: boolean;
  readonly displayModes: boolean;
  readonly cursorOverlay: boolean;
  controlling: boolean;
  controlGeneration: number;
  readonly authority: RemoteDesktopAuthority;
  expiresAt: number;
  sequence: number;
  backgroundViewing: boolean;
  presentationProofSequence: number;
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
  #framePending = false;
  #displayModePending = false;
  #lastFrameAt = Number.NEGATIVE_INFINITY;
  #controlGeneration = 0;
  #locallyStopped = new Map<string, string>();
  #lastEnded: { readonly peer: string; readonly lease: string } | undefined;

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
          controlling: active.controlling,
          controlGeneration: active.controlGeneration
        });
  }

  tick(): void {
    const active = this.#active;
    if (active !== undefined
      && (active.expiresAt <= this.#now() || !this.#authorityCurrent(active.authority))) {
      this.stop();
    }
  }

  hasLease(authority: RemoteDesktopAuthority, lease: string): boolean {
    if (!validAuthority(authority)) return false;
    this.tick();
    return this.#active?.lease === lease && sameAuthority(this.#active.authority, authority);
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
      return active.controlling && active.controlGeneration === controlGeneration;
    } catch {
      return false;
    }
  }

  /** Route retirement may target only its exact captured authority. */
  stop(authority?: RemoteDesktopAuthority): void {
    if (authority !== undefined) {
      if (!validAuthority(authority)) return;
      if (this.#active !== undefined && !sameAuthority(this.#active.authority, authority)) {
        if (this.#startingPeer === peerKey(authority)) this.#startingPeer = undefined;
        return;
      }
      if (this.#active === undefined && this.#startingPeer !== peerKey(authority)) return;
    }
    if (this.#active !== undefined) {
      this.#lastEnded = { peer: peerKey(this.#active.authority), lease: this.#active.lease };
    }
    this.#controlGeneration += 1;
    this.#active = undefined;
    this.#dependencies.stopInput();
    this.#dependencies.stopVideo();
    this.#dependencies.changed();
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
  releaseControl(): void {
    const active = this.#active;
    if (active === undefined || (!active.controlling && !this.#inputStarting)) return;
    active.controlling = false;
    active.controlGeneration = ++this.#controlGeneration;
    this.#dependencies.stopInput();
    this.#dependencies.changed();
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
    if (!active.controlling) throw new Error("REMOTE_DESKTOP_VIEW_ONLY");
    if (sequence <= active.sequence) return;
    active.sequence = sequence;
    try {
      this.#dependencies.input(request.events, authority);
    } catch (error) {
      this.releaseControl();
      throw error;
    }
  }

  async request(authority: RemoteDesktopAuthority, raw: unknown): Promise<unknown> {
    const request = parseRemoteDesktopRequest(raw);
    this.#assertAuthority(authority);
    this.tick();
    if (request.op === "capabilities") {
      const capabilities = parseRemoteDesktopHostCapabilities(await this.#runChecked(
        authority,
        undefined,
        () => this.#dependencies.capabilities(authority)
      ));
      return Object.freeze({
        ...capabilities,
        automaticReconnect: true,
        connectionTakeover: true,
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
    if (request.op === "start") return this.#start(authority, request);
    const active = this.#require(authority, request.lease);
    switch (request.op) {
      case "stop":
        this.stop(authority);
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
      case "resolution":
        if (!active.displayModes) throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
        return this.#setDisplayMode(
          authority,
          active,
          request.controlGeneration,
          request.modeId
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
            authority
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
    const peer = peerKey(authority);
    if (request.resume === true && this.#locallyStopped.has(peer)) {
      throw new Error("REMOTE_DESKTOP_STOPPED");
    }
    const resumesActive = request.resume === true
      && this.#active !== undefined
      && sameAuthority(this.#active.authority, authority)
      && this.#active.display.id === request.displayId;
    if (this.#displayModePending) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
    if (this.#starting
      || (this.#active !== undefined && request.takeover !== true && !resumesActive)) {
      throw new Error("REMOTE_DESKTOP_BUSY");
    }
    this.#starting = true;
    this.#startingPeer = peer;
    const generation = this.#controlGeneration;
    try {
      const capabilities = parseRemoteDesktopHostCapabilities(await this.#runChecked(
        authority,
        undefined,
        () => this.#dependencies.capabilities(authority)
      ));
      if (!capabilities.enabled) throw new Error("REMOTE_DESKTOP_DISABLED");
      const display = capabilities.displays.find((candidate) => candidate.id === request.displayId);
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
      if (request.resume !== true) this.#locallyStopped.delete(peer);
      const lease: ActiveRemoteDesktopLease = {
        lease: this.#createLeaseId(),
        display: Object.freeze({ ...display }),
        canControl: capabilities.canControl,
        displayModes: capabilities.displayModes,
        cursorOverlay: capabilities.cursorOverlay,
        controlling: false,
        controlGeneration: ++this.#controlGeneration,
        authority: Object.freeze({ ...authority }),
        expiresAt: this.#now() + REMOTE_DESKTOP_LEASE_MS,
        sequence: -1,
        backgroundViewing: false,
        presentationProofSequence: 0
      };
      this.#active = lease;
      this.#dependencies.changed();
      return leaseView(lease);
    } finally {
      this.#starting = false;
      this.#startingPeer = undefined;
    }
  }

  #presentation(
    active: ActiveRemoteDesktopLease,
    enabled: boolean
  ): { readonly controlling: boolean; readonly controlGeneration: number } {
    active.backgroundViewing = enabled;
    if (enabled) {
      active.controlling = false;
      active.controlGeneration = ++this.#controlGeneration;
      this.#dependencies.stopInput();
    }
    this.#dependencies.changed();
    return Object.freeze({
      controlling: active.controlling,
      controlGeneration: active.controlGeneration
    });
  }

  async #control(
    authority: RemoteDesktopAuthority,
    active: ActiveRemoteDesktopLease,
    enabled: boolean
  ): Promise<{ readonly controlling: boolean; readonly controlGeneration: number }> {
    if (enabled && !active.canControl) throw new Error("REMOTE_DESKTOP_VIEW_ONLY");
    if (enabled && this.#inputStarting) throw new Error("REMOTE_DESKTOP_INPUT_BUSY");
    if (enabled) active.backgroundViewing = false;
    const generation = ++this.#controlGeneration;
    active.controlGeneration = generation;
    if (!enabled) {
      active.controlling = false;
      this.#dependencies.stopInput();
      this.#dependencies.changed();
      return Object.freeze({ controlling: false, controlGeneration: active.controlGeneration });
    }
    if (!active.controlling) {
      this.#inputStarting = true;
      try {
        await this.#runChecked(
          authority,
          active,
          () => this.#dependencies.startInput(active.display.id, authority)
        );
        if (generation !== this.#controlGeneration || this.#active !== active) {
          this.#dependencies.stopInput();
          throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        }
        active.controlling = true;
      } catch (error) {
        this.#dependencies.stopInput();
        if (this.#active === active) {
          active.controlling = false;
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
    try {
      const frame = await this.#runChecked(
        authority,
        active,
        () => this.#dependencies.frame(active.display.id, cursorOverlay, authority)
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
      () => this.#dependencies.displayModes!(active.display.id, authority)
    ));
  }

  async #setDisplayMode(
    authority: RemoteDesktopAuthority,
    active: ActiveRemoteDesktopLease,
    controlGeneration: number,
    modeId: string
  ): Promise<{ readonly ok: true }> {
    if (!active.controlling) throw new Error("REMOTE_DESKTOP_VIEW_ONLY");
    if (active.controlGeneration !== controlGeneration) {
      throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    }
    if (this.#dependencies.displayModes === undefined || this.#dependencies.setDisplayMode === undefined) {
      throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    }
    if (this.#displayModePending) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
    this.#displayModePending = true;
    let committed = false;
    try {
      const modes = await this.#displayModes(authority, active);
      if (!modes.some((mode) => mode.id === modeId)) {
        throw new Error("REMOTE_DESKTOP_DISPLAY_MODE_MISSING");
      }
      const beforeChange = () => {
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
      };
      try {
        await this.#dependencies.setDisplayMode(active.display.id, modeId, beforeChange, authority);
      } catch (error) {
        // Once beforeChange retires the coordinate/media authority, no native
        // error can prove that the geometry write did not happen.
        if (committed) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        throw error;
      }
      if (!committed) throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
      return Object.freeze({ ok: true as const });
    } finally {
      this.#displayModePending = false;
    }
  }

  #require(authority: RemoteDesktopAuthority, lease: string): ActiveRemoteDesktopLease {
    if (!validAuthority(authority)) throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
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
    try {
      const value = await operation();
      this.#revalidateAsyncCompletion(authority, active);
      return value;
    } catch (error) {
      this.#revalidateAsyncCompletion(authority, active);
      throw error;
    }
  }

  #revalidateAsyncCompletion(
    authority: RemoteDesktopAuthority,
    active: ActiveRemoteDesktopLease | undefined
  ): void {
    if (!validAuthority(authority) || !this.#authorityCurrent(authority)) {
      if (active !== undefined && this.#active === active) this.stop(active.authority);
      throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
    }
    if (active === undefined) return;
    const current = this.#require(authority, active.lease);
    if (current !== active) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
  }

  #assertAuthority(authority: RemoteDesktopAuthority): void {
    if (!validAuthority(authority) || !this.#authorityCurrent(authority)) {
      throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
    }
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
    controlGeneration: active.controlGeneration
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
