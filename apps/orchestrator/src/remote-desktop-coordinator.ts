import { create, toBinary } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { DevicePeerMultiplexEvent, DevicePeerResponseFrame } from "@joko/device-peer";
import type { ConnectionRecord } from "@joko/store";

import {
  type DevicePeerAuthority,
  type DevicePeerOwner,
  type DevicePeerSelectionIdentity
} from "./device-peer-owner.js";
import { toProtoTimestamp } from "./proto-mapper.js";

const REMOTE_DESKTOP_LEASE_MS = 12_000;
const MAXIMUM_IDENTIFIER_LENGTH = 256;
const MAXIMUM_DISPLAY_NAME_LENGTH = 256;
const MAXIMUM_DISPLAYS = 16;
const MAXIMUM_DISPLAY_EDGE = 16_384;
const MAXIMUM_INPUT_EVENTS = 64;
const MAXIMUM_INPUT_BYTES = 16 * 1024;
const MAXIMUM_TEXT_INPUT_LENGTH = 4_096;
const MAXIMUM_SCROLL_DELTA = 4_096;
const MAXIMUM_SDP_BYTES = 64 * 1024;
const MAXIMUM_ICE_CANDIDATES = 16;
const MAXIMUM_ICE_CURSOR = 128;
const MAXIMUM_ICE_CANDIDATE_LENGTH = 2_048;
const MAXIMUM_JPEG_BYTES = 180_000;
const MAXIMUM_ICE_SERVERS = 8;
const MAXIMUM_ICE_URLS = 8;
const MAXIMUM_ICE_FIELD_LENGTH = 2_048;
const MAXIMUM_CLIPBOARD_TEXT_CHARACTERS = 16_384;
const CLIPBOARD_CHUNK_CHARACTERS = 64 * 1_024;
const CLIPBOARD_MAX_CHARACTERS = 32 * 1_024 * 1_024;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SIMPLE_KEY_CODE_PATTERN = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2]))$/u;
const NAMED_KEY_CODES = new Set([
  "AltLeft", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Backquote", "Backslash", "Backspace",
  "BracketLeft", "BracketRight", "Comma", "ControlLeft", "Delete", "End", "Enter", "Equal", "Escape",
  "Home", "Insert", "MetaLeft", "Minus", "PageDown", "PageUp", "Period", "Quote", "Semicolon",
  "ShiftLeft", "Slash", "Space", "Tab"
]);

export type RemoteDesktopCoordinatorErrorCode =
  | "invalid_argument"
  | "not_found"
  | "failed_precondition"
  | "permission_denied"
  | "unimplemented"
  | "unavailable"
  | "aborted"
  | "cancelled"
  | "internal";

export class RemoteDesktopCoordinatorError extends Error {
  constructor(
    readonly code: RemoteDesktopCoordinatorErrorCode,
    message: string,
    readonly detail?: contract.RemoteDesktopFailure
  ) {
    super(message);
    this.name = "RemoteDesktopCoordinatorError";
  }
}

export interface RemoteDesktopIceConfigurationProvider {
  getConfiguration(input: {
    readonly controllerDeviceId: string;
    readonly targetDeviceId: string;
    readonly leaseId: string;
    readonly signal: AbortSignal;
  }): Promise<readonly contract.RemoteDesktopIceServer[]>;
}

export interface RemoteDesktopCoordinatorOptions {
  readonly owner: DevicePeerOwner;
  readonly onRevoked: (connectionId: string, listener: () => void) => () => void;
  readonly now?: () => number;
  readonly iceConfiguration?: RemoteDesktopIceConfigurationProvider;
}

interface RemoteDesktopLeaseState {
  readonly leaseId: string;
  readonly displayId: string;
  readonly controllerConnectionId: string;
  readonly controllerDeviceId: string;
  readonly identity: DevicePeerSelectionIdentity;
  readonly cleanupAuthority: DevicePeerAuthority;
  connection: ConnectionRecord;
  controlling: boolean;
  controlGeneration: bigint;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  routeSubscription?: { dispose(): void };
}

interface RemoteDesktopStartFence {
  nextGeneration: number;
  latestAcceptedGeneration: number;
  pending: number;
}

interface RemoteDesktopExpiredResume {
  readonly displayId: string;
  readonly controllerConnectionId: string;
  readonly controllerDeviceId: string;
  readonly identity: DevicePeerSelectionIdentity;
}

/**
 * Process-local Remote Desktop authority. Media, SDP, ICE, input, and frames
 * pass through the call stack only; this owner retains only lease and route
 * fence identifiers and never writes them to OperationalStore.
 */
export class RemoteDesktopCoordinator {
  readonly #owner: DevicePeerOwner;
  readonly #onRevoked: RemoteDesktopCoordinatorOptions["onRevoked"];
  readonly #now: () => number;
  readonly #iceConfiguration: RemoteDesktopIceConfigurationProvider;
  readonly #leases = new Map<string, RemoteDesktopLeaseState>();
  readonly #startFences = new Map<string, RemoteDesktopStartFence>();
  readonly #expiredResumes = new Map<string, RemoteDesktopExpiredResume>();
  readonly #revocationSubscriptions = new Map<string, () => void>();
  #closed = false;

  constructor(options: RemoteDesktopCoordinatorOptions) {
    this.#owner = options.owner;
    this.#onRevoked = options.onRevoked;
    this.#now = options.now ?? Date.now;
    this.#iceConfiguration = options.iceConfiguration ?? new PublicStunRemoteDesktopIceConfiguration(this.#now);
  }

  async getCapabilities(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    signal: AbortSignal
  ): Promise<contract.RemoteDesktopCapabilities> {
    const authority = this.#capture(connection, identity);
    const value = await this.#dispatch<contract.RemoteDesktopCapabilities>(authority, remoteDesktopCommand(
      "getRemoteDesktopCapabilities",
      create(contract.DevicePeerGetRemoteDesktopCapabilitiesActionSchema),
      "read_only"
    ), signal, "remoteDesktopCapabilities", "joko.v1.RemoteDesktopCapabilities");
    validateCapabilities(value);
    return value;
  }

  async getPermissions(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    signal: AbortSignal
  ): Promise<contract.RemoteDesktopPermissions> {
    const authority = this.#capture(connection, identity);
    const value = await this.#dispatch<contract.RemoteDesktopPermissions>(authority, remoteDesktopCommand(
      "getRemoteDesktopPermissions",
      create(contract.DevicePeerGetRemoteDesktopPermissionsActionSchema),
      "read_only"
    ), signal, "remoteDesktopPermissions", "joko.v1.RemoteDesktopPermissions");
    validatePermissions(value);
    return value;
  }

  async showPermissionGuide(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    signal: AbortSignal
  ): Promise<contract.RemoteDesktopPermissions> {
    const authority = this.#capture(connection, identity);
    await this.#dispatch<contract.DevicePeerAcknowledgement>(authority, remoteDesktopCommand(
      "showRemoteDesktopPermissionGuide",
      create(contract.DevicePeerShowRemoteDesktopPermissionGuideActionSchema),
      "side_effect"
    ), signal, "acknowledgement", "joko.v1.DevicePeerAcknowledgement");
    return this.getPermissions(connection, identity, signal);
  }

  async start(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    input: { readonly displayId: string; readonly mode: contract.RemoteDesktopStartMode },
    signal: AbortSignal
  ): Promise<contract.RemoteDesktopLease> {
    this.#assertOpen();
    validateIdentifier(input.displayId, "display_id", true);
    if (input.mode !== contract.RemoteDesktopStartMode.NEW
      && input.mode !== contract.RemoteDesktopStartMode.RESUME
      && input.mode !== contract.RemoteDesktopStartMode.TAKEOVER) {
      throw invalidArgument("Remote Desktop start mode is required.");
    }
    const resumeState = input.mode === contract.RemoteDesktopStartMode.RESUME
      ? this.#requireResumeState(connection, identity, input.displayId)
      : undefined;
    const authority = this.#capture(connection, identity);
    const cleanupAuthority = this.#owner.captureBinding(
      connection.deviceId,
      identity.targetDeviceId,
      ["remote_desktop"]
    );
    if (!sameIdentity(cleanupAuthority.identity, identity)) {
      throw leaseFailure(contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED, "aborted");
    }
    const startFence = this.#beginStart(identity.targetDeviceId);
    try {
      let value: contract.RemoteDesktopLease;
      try {
        value = await this.#dispatch<contract.RemoteDesktopLease>(authority, remoteDesktopCommand(
          "startRemoteDesktop",
          create(contract.DevicePeerStartRemoteDesktopActionSchema, {
            displayId: input.displayId,
            mode: input.mode
          }),
          "side_effect"
        ), signal, "remoteDesktopLease", "joko.v1.RemoteDesktopLease");
      } catch (error) {
        if (resumeState !== undefined) {
          this.#revalidateLeaseCompletion(resumeState, connection, identity, authority);
        }
        throw error;
      }
      validateLease(value);
      if (value.display?.displayId !== input.displayId) {
        void this.#bestEffortStopLease(cleanupAuthority, value.leaseId);
        throw invalidTargetResponse();
      }
      try {
        this.#assertOpen();
        if (resumeState === undefined) authority.assertCurrent(["remote_desktop"]);
        else this.#revalidateLeaseCompletion(resumeState, connection, identity, authority);
      } catch (error) {
        void this.#bestEffortStopLease(cleanupAuthority, value.leaseId);
        throw error;
      }
      if (!this.#acceptStart(startFence)) {
        void this.#bestEffortStopLease(cleanupAuthority, value.leaseId);
        throw leaseFailure(contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED, "aborted");
      }
      this.#expiredResumes.delete(identity.targetDeviceId);

      // The target is the final single-viewer authority. Any successful start
      // supersedes stale local knowledge for that target, including a lost-reply
      // RESUME or an explicit TAKEOVER.
      for (const state of [...this.#leases.values()]) {
        if (state.identity.targetDeviceId === identity.targetDeviceId) this.#forget(state);
      }
      if (this.#leases.has(value.leaseId)) throw invalidTargetResponse();
      const state: RemoteDesktopLeaseState = {
        leaseId: value.leaseId,
        displayId: input.displayId,
        controllerConnectionId: connection.id,
        controllerDeviceId: connection.deviceId,
        identity: Object.freeze({ ...identity }),
        cleanupAuthority,
        connection,
        controlling: value.controlling,
        controlGeneration: value.controlGeneration,
        expiresAt: this.#now() + REMOTE_DESKTOP_LEASE_MS,
        timer: setTimeout(() => undefined, REMOTE_DESKTOP_LEASE_MS)
      };
      clearTimeout(state.timer);
      state.timer = this.#leaseTimer(state);
      this.#leases.set(state.leaseId, state);
      try {
        state.routeSubscription = this.#owner.subscribe(cleanupAuthority, (event) => {
          this.#routeClosed(state, event);
        });
        this.#ensureRevocationSubscription(connection.id);
      } catch (error) {
        this.#forget(state);
        void this.#bestEffortStop(state);
        throw error;
      }
      return value;
    } finally {
      this.#endStart(identity.targetDeviceId, startFence.fence);
    }
  }

  async heartbeat(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    leaseId: string,
    signal: AbortSignal
  ): Promise<contract.RemoteDesktopControlState> {
    const state = this.#requireLease(connection, identity, leaseId);
    const authority = this.#capture(connection, identity);
    const value = await this.#runLeaseBound(state, connection, identity, authority, () =>
      this.#dispatch<contract.RemoteDesktopControlState>(authority, remoteDesktopCommand(
        "heartbeatRemoteDesktop",
        create(contract.DevicePeerHeartbeatRemoteDesktopActionSchema, { leaseId }),
        "side_effect"
      ), signal, "remoteDesktopControlState", "joko.v1.RemoteDesktopControlState"));
    const current = this.#adoptControlState(state, value);
    state.expiresAt = this.#now() + REMOTE_DESKTOP_LEASE_MS;
    clearTimeout(state.timer);
    state.timer = this.#leaseTimer(state);
    return current;
  }

  async stop(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    leaseId: string,
    signal: AbortSignal
  ): Promise<void> {
    const state = this.#requireLease(connection, identity, leaseId);
    const authority = this.#capture(connection, identity);
    // Forget before dispatch: an unknown stop result must never leave a lease
    // reusable from this process. The target independently expires it.
    this.#forget(state);
    await this.#dispatch<contract.DevicePeerAcknowledgement>(authority, remoteDesktopCommand(
      "stopRemoteDesktop",
      create(contract.DevicePeerStopRemoteDesktopActionSchema, { leaseId }),
      "side_effect"
    ), signal, "acknowledgement", "joko.v1.DevicePeerAcknowledgement");
  }

  async setControl(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    input: { readonly leaseId: string; readonly enabled: boolean },
    signal: AbortSignal
  ): Promise<contract.RemoteDesktopControlState> {
    const state = this.#requireLease(connection, identity, input.leaseId);
    const authority = this.#capture(connection, identity);
    const value = await this.#runLeaseBound(state, connection, identity, authority, () =>
      this.#dispatch<contract.RemoteDesktopControlState>(authority, remoteDesktopCommand(
        "setRemoteDesktopControl",
        create(contract.DevicePeerSetRemoteDesktopControlActionSchema, input),
        "side_effect"
      ), signal, "remoteDesktopControlState", "joko.v1.RemoteDesktopControlState"));
    return this.#adoptControlState(state, value);
  }

  async sendInput(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    input: {
      readonly leaseId: string;
      readonly sequence: bigint;
      readonly events: readonly contract.RemoteDesktopInputEvent[];
    },
    signal: AbortSignal
  ): Promise<void> {
    const state = this.#requireLease(connection, identity, input.leaseId);
    validateInput(input.sequence, input.events);
    const authority = this.#capture(connection, identity);
    const action = create(contract.DevicePeerSendRemoteDesktopInputActionSchema, {
      leaseId: input.leaseId,
      sequence: input.sequence,
      events: [...input.events]
    });
    if (toBinary(contract.DevicePeerSendRemoteDesktopInputActionSchema, action).byteLength > MAXIMUM_INPUT_BYTES) {
      throw invalidArgument("Remote Desktop input exceeds the request budget.");
    }
    await this.#runLeaseBound(state, connection, identity, authority, () =>
      this.#dispatch<contract.DevicePeerAcknowledgement>(authority, remoteDesktopCommand(
        "sendRemoteDesktopInput",
        action,
        "side_effect"
      ), signal, "acknowledgement", "joko.v1.DevicePeerAcknowledgement"));
  }

  async getIceConfiguration(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    leaseId: string,
    signal: AbortSignal
  ): Promise<readonly contract.RemoteDesktopIceServer[]> {
    const state = this.#requireLease(connection, identity, leaseId);
    const authority = this.#capture(connection, identity);
    const servers = await this.#runLeaseBound(state, connection, identity, authority, () =>
      this.#iceConfiguration.getConfiguration({
        controllerDeviceId: connection.deviceId,
        targetDeviceId: identity.targetDeviceId,
        leaseId,
        signal
      }));
    validateIceServers(servers, this.#now());
    return Object.freeze([...servers]);
  }

  async createOffer(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    input: { readonly leaseId: string; readonly attemptId: string; readonly offerSdp: string },
    signal: AbortSignal
  ): Promise<contract.RemoteDesktopOfferResult> {
    const state = this.#requireLease(connection, identity, input.leaseId);
    validateAttemptId(input.attemptId);
    validateSdp(input.offerSdp, "offer_sdp");
    const authority = this.#capture(connection, identity);
    const value = await this.#runLeaseBound(state, connection, identity, authority, () =>
      this.#dispatch<contract.RemoteDesktopOfferResult>(authority, remoteDesktopCommand(
        "createRemoteDesktopOffer",
        create(contract.DevicePeerCreateRemoteDesktopOfferActionSchema, input),
        "side_effect"
      ), signal, "remoteDesktopOffer", "joko.v1.RemoteDesktopOfferResult"));
    if (value.attemptId !== input.attemptId) throw invalidTargetResponse();
    validateSdp(value.answerSdp, "answer_sdp");
    return value;
  }

  async exchangeIce(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    input: {
      readonly leaseId: string;
      readonly attemptId: string;
      readonly candidates: readonly contract.RemoteDesktopIceCandidate[];
      readonly after: number;
    },
    signal: AbortSignal
  ): Promise<contract.RemoteDesktopIceExchangeResult> {
    const state = this.#requireLease(connection, identity, input.leaseId);
    validateAttemptId(input.attemptId);
    validateIceCursor(input.after);
    validateIceCandidates(input.candidates);
    const authority = this.#capture(connection, identity);
    const value = await this.#runLeaseBound(state, connection, identity, authority, () =>
      this.#dispatch<contract.RemoteDesktopIceExchangeResult>(authority, remoteDesktopCommand(
        "exchangeRemoteDesktopIce",
        create(contract.DevicePeerExchangeRemoteDesktopIceActionSchema, {
          ...input,
          candidates: [...input.candidates]
        }),
        "side_effect"
      ), signal, "remoteDesktopIce", "joko.v1.RemoteDesktopIceExchangeResult"));
    if (value.attemptId !== input.attemptId || value.next < input.after) throw invalidTargetResponse();
    validateIceCursor(value.next);
    validateIceCandidates(value.candidates);
    return value;
  }

  async getFrame(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    leaseId: string,
    signal: AbortSignal
  ): Promise<contract.RemoteDesktopFrameResult> {
    const state = this.#requireLease(connection, identity, leaseId);
    const authority = this.#capture(connection, identity);
    const value = await this.#runLeaseBound(state, connection, identity, authority, () =>
      this.#dispatch<contract.RemoteDesktopFrameResult>(authority, remoteDesktopCommand(
        "getRemoteDesktopFrame",
        create(contract.DevicePeerGetRemoteDesktopFrameActionSchema, { leaseId }),
        "read_only"
      ), signal, "remoteDesktopFrame", "joko.v1.RemoteDesktopFrameResult"));
    if (value.frame !== undefined
      && (value.frame.jpeg.byteLength < 1 || value.frame.jpeg.byteLength > MAXIMUM_JPEG_BYTES)) {
      throw invalidTargetResponse();
    }
    return value;
  }

  async transferClipboardText(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    input: contract.RemoteDesktopClipboardTextRequest,
    signal: AbortSignal
  ): Promise<contract.RemoteDesktopClipboardTextResult> {
    const state = this.#requireControlLease(
      connection,
      identity,
      input.leaseId,
      input.controlGeneration
    );
    validateClipboardTextRequest(input);
    const authority = this.#capture(connection, identity);
    const value = await this.#runControlBound(
      state,
      connection,
      identity,
      authority,
      input.controlGeneration,
      () => this.#dispatch<contract.RemoteDesktopClipboardTextResult>(authority, remoteDesktopCommand(
        "transferRemoteDesktopClipboardText",
        create(contract.RemoteDesktopClipboardTextRequestSchema, {
          leaseId: input.leaseId,
          controlGeneration: input.controlGeneration,
          action: input.action
        }),
        "side_effect"
      ), signal, "remoteDesktopClipboardText", "joko.v1.RemoteDesktopClipboardTextResult")
    );
    validateClipboardTextResult(input, value);
    return value;
  }

  async transferClipboardContent(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    input: contract.RemoteDesktopClipboardContentRequest,
    signal: AbortSignal
  ): Promise<contract.RemoteDesktopClipboardContentResult> {
    const state = this.#requireControlLease(
      connection,
      identity,
      input.leaseId,
      input.controlGeneration
    );
    validateClipboardContentRequest(input);
    const authority = this.#capture(connection, identity);
    const value = await this.#runControlBound(
      state,
      connection,
      identity,
      authority,
      input.controlGeneration,
      () => this.#dispatch<contract.RemoteDesktopClipboardContentResult>(authority, remoteDesktopCommand(
        "transferRemoteDesktopClipboardContent",
        create(contract.RemoteDesktopClipboardContentRequestSchema, {
          leaseId: input.leaseId,
          controlGeneration: input.controlGeneration,
          action: input.action
        }),
        "side_effect"
      ), signal, "remoteDesktopClipboardContent", "joko.v1.RemoteDesktopClipboardContentResult")
    );
    validateClipboardContentResult(input, value);
    return value;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const states = [...this.#leases.values()];
    for (const state of states) this.#forget(state);
    this.#expiredResumes.clear();
    for (const stop of this.#revocationSubscriptions.values()) stop();
    this.#revocationSubscriptions.clear();
    await Promise.allSettled(states.map((state) => this.#bestEffortStop(state)));
  }

  #capture(connection: ConnectionRecord, identity: DevicePeerSelectionIdentity): DevicePeerAuthority {
    this.#assertOpen();
    return this.#owner.capture(connection, identity, ["remote_desktop"]);
  }

  #requireLease(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    leaseId: string
  ): RemoteDesktopLeaseState {
    this.#assertOpen();
    validateIdentifier(leaseId, "lease_id");
    const state = this.#leases.get(leaseId);
    if (state === undefined) throw leaseFailure(contract.RemoteDesktopFailureReason.STOPPED);
    if (state.expiresAt <= this.#now()) {
      this.#rememberExpiredResume(state);
      this.#forget(state);
      void this.#bestEffortStop(state);
      throw leaseFailure(contract.RemoteDesktopFailureReason.LEASE_EXPIRED);
    }
    if (state.controllerConnectionId !== connection.id || state.controllerDeviceId !== connection.deviceId) {
      throw leaseFailure(contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED, "permission_denied");
    }
    if (!sameIdentity(state.identity, identity)) {
      throw leaseFailure(contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED, "aborted");
    }
    state.connection = connection;
    return state;
  }

  #requireControlLease(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    leaseId: string,
    controlGeneration: bigint
  ): RemoteDesktopLeaseState {
    if (controlGeneration < 1n) {
      throw invalidArgument("Remote Desktop control generation is required.");
    }
    const state = this.#requireLease(connection, identity, leaseId);
    if (!state.controlling) throw leaseFailure(contract.RemoteDesktopFailureReason.VIEW_ONLY);
    if (state.controlGeneration !== controlGeneration) {
      throw leaseFailure(contract.RemoteDesktopFailureReason.CLIPBOARD_EXPIRED);
    }
    return state;
  }

  #requireResumeState(
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    displayId: string
  ): RemoteDesktopLeaseState {
    const state = [...this.#leases.values()].find((candidate) =>
      candidate.controllerConnectionId === connection.id
      && candidate.controllerDeviceId === connection.deviceId
      && candidate.displayId === displayId
      && sameIdentity(candidate.identity, identity));
    if (state === undefined) {
      const expired = this.#expiredResumes.get(identity.targetDeviceId);
      if (expired !== undefined
        && expired.controllerConnectionId === connection.id
        && expired.controllerDeviceId === connection.deviceId
        && expired.displayId === displayId
        && sameIdentity(expired.identity, identity)) {
        throw leaseFailure(contract.RemoteDesktopFailureReason.LEASE_EXPIRED);
      }
      throw leaseFailure(contract.RemoteDesktopFailureReason.STOPPED);
    }
    return this.#requireLease(connection, identity, state.leaseId);
  }

  #leaseTimer(state: RemoteDesktopLeaseState): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (this.#leases.get(state.leaseId) !== state) return;
      if (state.expiresAt > this.#now()) {
        state.timer = this.#leaseTimer(state);
        return;
      }
      this.#rememberExpiredResume(state);
      this.#forget(state);
      void this.#bestEffortStop(state);
    }, Math.max(1, state.expiresAt - this.#now()));
    timer.unref?.();
    return timer;
  }

  #forget(state: RemoteDesktopLeaseState): void {
    if (this.#leases.get(state.leaseId) !== state) return;
    this.#leases.delete(state.leaseId);
    clearTimeout(state.timer);
    state.routeSubscription?.dispose();
    state.routeSubscription = undefined;
    if (![...this.#leases.values()].some((candidate) =>
      candidate.controllerConnectionId === state.controllerConnectionId)) {
      this.#revocationSubscriptions.get(state.controllerConnectionId)?.();
      this.#revocationSubscriptions.delete(state.controllerConnectionId);
    }
  }

  #ensureRevocationSubscription(connectionId: string): void {
    if (this.#revocationSubscriptions.has(connectionId)) return;
    const stop = this.#onRevoked(connectionId, () => {
      const revoked: RemoteDesktopLeaseState[] = [];
      for (const state of [...this.#leases.values()]) {
        if (state.controllerConnectionId !== connectionId) continue;
        revoked.push(state);
        this.#forget(state);
      }
      for (const state of revoked) void this.#bestEffortStop(state);
    });
    this.#revocationSubscriptions.set(connectionId, stop);
  }

  #rememberExpiredResume(state: RemoteDesktopLeaseState): void {
    this.#expiredResumes.set(state.identity.targetDeviceId, Object.freeze({
      displayId: state.displayId,
      controllerConnectionId: state.controllerConnectionId,
      controllerDeviceId: state.controllerDeviceId,
      identity: Object.freeze({ ...state.identity })
    }));
  }

  #beginStart(targetDeviceId: string): {
    readonly fence: RemoteDesktopStartFence;
    readonly generation: number;
  } {
    let fence = this.#startFences.get(targetDeviceId);
    if (fence === undefined) {
      fence = { nextGeneration: 0, latestAcceptedGeneration: 0, pending: 0 };
      this.#startFences.set(targetDeviceId, fence);
    }
    fence.pending += 1;
    fence.nextGeneration += 1;
    return { fence, generation: fence.nextGeneration };
  }

  #acceptStart(start: { readonly fence: RemoteDesktopStartFence; readonly generation: number }): boolean {
    if (start.generation < start.fence.latestAcceptedGeneration) return false;
    start.fence.latestAcceptedGeneration = start.generation;
    return true;
  }

  #endStart(targetDeviceId: string, fence: RemoteDesktopStartFence): void {
    fence.pending -= 1;
    if (fence.pending === 0 && this.#startFences.get(targetDeviceId) === fence) {
      this.#startFences.delete(targetDeviceId);
    }
  }

  async #bestEffortStop(state: RemoteDesktopLeaseState): Promise<void> {
    await this.#bestEffortStopLease(state.cleanupAuthority, state.leaseId);
  }

  async #bestEffortStopLease(authority: DevicePeerAuthority, leaseId: string): Promise<void> {
    try {
      await this.#dispatch<contract.DevicePeerAcknowledgement>(authority, remoteDesktopCommand(
        "stopRemoteDesktop",
        create(contract.DevicePeerStopRemoteDesktopActionSchema, { leaseId }),
        "side_effect"
      ), AbortSignal.timeout(2_000), "acknowledgement", "joko.v1.DevicePeerAcknowledgement");
    } catch {
      // Target leases expire independently after the same bounded lifetime.
    }
  }

  async #runLeaseBound<T>(
    state: RemoteDesktopLeaseState,
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    authority: DevicePeerAuthority,
    operation: () => Promise<T>
  ): Promise<T> {
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      this.#revalidateLeaseCompletion(state, connection, identity, authority);
      throw error;
    }
    this.#revalidateLeaseCompletion(state, connection, identity, authority);
    return value;
  }

  async #runControlBound<T>(
    state: RemoteDesktopLeaseState,
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    authority: DevicePeerAuthority,
    controlGeneration: bigint,
    operation: () => Promise<T>
  ): Promise<T> {
    const value = await this.#runLeaseBound(state, connection, identity, authority, operation);
    if (!state.controlling || state.controlGeneration !== controlGeneration) {
      throw leaseFailure(contract.RemoteDesktopFailureReason.CLIPBOARD_EXPIRED);
    }
    return value;
  }

  #adoptControlState(
    state: RemoteDesktopLeaseState,
    value: contract.RemoteDesktopControlState
  ): contract.RemoteDesktopControlState {
    validateControlState(value);
    if (value.controlGeneration === state.controlGeneration && value.controlling !== state.controlling) {
      throw invalidTargetResponse();
    }
    if (value.controlGeneration > state.controlGeneration) {
      state.controlling = value.controlling;
      state.controlGeneration = value.controlGeneration;
    }
    return create(contract.RemoteDesktopControlStateSchema, {
      controlling: state.controlling,
      controlGeneration: state.controlGeneration
    });
  }

  #revalidateLeaseCompletion(
    state: RemoteDesktopLeaseState,
    connection: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    authority: DevicePeerAuthority
  ): void {
    this.#assertOpen();
    if (state.expiresAt <= this.#now()) {
      if (this.#leases.get(state.leaseId) === state) {
        this.#rememberExpiredResume(state);
        this.#forget(state);
        void this.#bestEffortStop(state);
      }
      throw leaseFailure(contract.RemoteDesktopFailureReason.LEASE_EXPIRED);
    }
    if (this.#leases.get(state.leaseId) !== state) {
      throw leaseFailure(contract.RemoteDesktopFailureReason.STOPPED);
    }
    if (state.controllerConnectionId !== connection.id || state.controllerDeviceId !== connection.deviceId) {
      this.#forget(state);
      void this.#bestEffortStop(state);
      throw leaseFailure(contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED, "permission_denied");
    }
    if (!sameIdentity(state.identity, identity)) {
      this.#forget(state);
      void this.#bestEffortStop(state);
      throw leaseFailure(contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED, "aborted");
    }
    try {
      authority.assertCurrent(["remote_desktop"]);
    } catch (error) {
      this.#forget(state);
      void this.#bestEffortStop(state);
      throw error;
    }
    state.connection = connection;
  }

  #routeClosed(state: RemoteDesktopLeaseState, event: DevicePeerMultiplexEvent): void {
    if (event.kind !== "route_closed"
      || event.targetDeviceId !== state.identity.targetDeviceId
      || event.routeGeneration !== state.identity.routeGeneration
      || this.#leases.get(state.leaseId) !== state) return;
    this.#forget(state);
    void this.#bestEffortStop(state);
  }

  async #dispatch<T>(
    authority: DevicePeerAuthority,
    command: contract.DevicePeerCommand,
    signal: AbortSignal,
    expectedCase: contract.DevicePeerAgentResult["payload"]["case"],
    expectedTypeName: string
  ): Promise<T> {
    const action = command.action.case;
    if (action === undefined) throw invalidArgument("Remote Desktop command action is required.");
    const response = await this.#owner.dispatch(authority, {
      capability: "remote_desktop",
      effectKind: command.effect === contract.DevicePeerEffectKind.READ_ONLY ? "read_only" : "side_effect",
      action,
      payload: command,
      signal
    });
    return responseValue<T>(response, expectedCase, expectedTypeName);
  }

  #assertOpen(): void {
    if (this.#closed) throw new RemoteDesktopCoordinatorError("unavailable", "Remote Desktop is shutting down.");
  }
}

class PublicStunRemoteDesktopIceConfiguration implements RemoteDesktopIceConfigurationProvider {
  constructor(private readonly now: () => number) {}

  getConfiguration(): Promise<readonly contract.RemoteDesktopIceServer[]> {
    return Promise.resolve(Object.freeze([
      create(contract.RemoteDesktopIceServerSchema, {
        urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"],
        expiresAt: toProtoTimestamp(this.now() + 5 * 60_000)
      })
    ]));
  }
}

type RemoteDesktopActionCase = Extract<
  contract.DevicePeerCommand["action"],
  { case: `getRemoteDesktop${string}` | `showRemoteDesktop${string}` | `startRemoteDesktop` | `heartbeatRemoteDesktop`
    | `stopRemoteDesktop` | `setRemoteDesktopControl` | `sendRemoteDesktopInput`
    | `createRemoteDesktopOffer` | `exchangeRemoteDesktopIce`
    | `transferRemoteDesktopClipboardText` | `transferRemoteDesktopClipboardContent` }
>["case"];

function remoteDesktopCommand<TCase extends RemoteDesktopActionCase>(
  action: TCase,
  value: Extract<contract.DevicePeerCommand["action"], { case: TCase }>["value"],
  effect: "read_only" | "side_effect"
): contract.DevicePeerCommand {
  return create(contract.DevicePeerCommandSchema, {
    capability: contract.DevicePeerCapabilityKind.REMOTE_DESKTOP,
    effect: effect === "read_only"
      ? contract.DevicePeerEffectKind.READ_ONLY
      : contract.DevicePeerEffectKind.SIDE_EFFECT,
    action: { case: action, value } as contract.DevicePeerCommand["action"]
  });
}

function responseValue<T>(
  response: DevicePeerResponseFrame,
  expectedCase: contract.DevicePeerAgentResult["payload"]["case"],
  expectedTypeName: string
): T {
  switch (response.outcome) {
    case "completed": {
      const payload = response.value as { readonly case?: unknown; readonly value?: unknown } | undefined;
      const value = payload?.value as { readonly $typeName?: unknown } | undefined;
      if (payload?.case !== expectedCase || value?.$typeName !== expectedTypeName) throw invalidTargetResponse();
      return value as T;
    }
    case "aborted":
      throw new RemoteDesktopCoordinatorError("cancelled", "Remote Desktop request was cancelled.");
    case "outcome_unknown": {
      const detail = remoteDesktopFailureDetail(response.failure);
      throw new RemoteDesktopCoordinatorError(
        "aborted",
        "Remote Desktop request outcome is unknown.",
        detail
      );
    }
    case "failed": {
      const detail = remoteDesktopFailureDetail(response.failure);
      if (detail !== undefined) throw remoteDesktopTargetFailure(detail);
      throw genericTargetFailure(response.errorCode);
    }
  }
}

function remoteDesktopFailureDetail(value: unknown): contract.RemoteDesktopFailure | undefined {
  if (typeof value !== "object" || value === null
    || (value as { readonly $typeName?: unknown }).$typeName !== "joko.v1.DevicePeerFailure") return undefined;
  const detail = (value as contract.DevicePeerFailure).remoteDesktop;
  return detail?.$typeName === "joko.v1.RemoteDesktopFailure" ? detail : undefined;
}

function remoteDesktopTargetFailure(detail: contract.RemoteDesktopFailure): RemoteDesktopCoordinatorError {
  const code: RemoteDesktopCoordinatorErrorCode = detail.reason === contract.RemoteDesktopFailureReason.DISPLAY_MISSING
    ? "not_found"
    : detail.reason === contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED
      ? "aborted"
      : detail.reason === contract.RemoteDesktopFailureReason.UNSUPPORTED
        ? "unimplemented"
        : detail.reason === contract.RemoteDesktopFailureReason.VIDEO_TIMEOUT
          ? "unavailable"
          : "failed_precondition";
  return new RemoteDesktopCoordinatorError(code, "Remote Desktop host rejected the request.", detail);
}

function genericTargetFailure(errorCode: string): RemoteDesktopCoordinatorError {
  const code: RemoteDesktopCoordinatorErrorCode = errorCode === "invalid_request" ? "invalid_argument"
    : errorCode === "not_found" ? "not_found"
      : errorCode === "permission_denied" ? "permission_denied"
        : errorCode === "cancelled" ? "cancelled"
          : errorCode === "timeout" || errorCode === "unavailable" ? "unavailable"
            : errorCode === "internal" ? "internal" : "failed_precondition";
  return new RemoteDesktopCoordinatorError(code, `Remote Desktop host request failed (${errorCode}).`);
}

function validateCapabilities(value: contract.RemoteDesktopCapabilities): void {
  if (value.protocolVersion !== 1 || !/^(?:darwin|linux|win32)$/u.test(value.platform)
    || value.displays.length > MAXIMUM_DISPLAYS || value.permissions === undefined
    || typeof value.clipboardText !== "boolean" || typeof value.clipboardContent !== "boolean") {
    throw invalidTargetResponse();
  }
  for (const display of value.displays) validateDisplay(display);
  validatePermissions(value.permissions);
}

function validatePermissions(value: contract.RemoteDesktopPermissions): void {
  validatePermission(value.screenRecording);
  validatePermission(value.accessibility);
}

function validatePermission(value: contract.RemoteDesktopPermissionStatus): void {
  if (value !== contract.RemoteDesktopPermissionStatus.GRANTED
    && value !== contract.RemoteDesktopPermissionStatus.MISSING
    && value !== contract.RemoteDesktopPermissionStatus.UNKNOWN
    && value !== contract.RemoteDesktopPermissionStatus.NOT_REQUIRED) throw invalidTargetResponse();
}

function validateLease(value: contract.RemoteDesktopLease): void {
  validateIdentifier(value.leaseId, "lease_id");
  if (value.display === undefined || value.controlGeneration < 1n) throw invalidTargetResponse();
  validateDisplay(value.display);
}

function validateControlState(value: contract.RemoteDesktopControlState): void {
  if (typeof value.controlling !== "boolean" || value.controlGeneration < 1n) {
    throw invalidTargetResponse();
  }
}

function validateClipboardTextRequest(value: contract.RemoteDesktopClipboardTextRequest): void {
  validateIdentifier(value.leaseId, "lease_id");
  if (value.controlGeneration < 1n) throw invalidArgument("Remote Desktop control generation is required.");
  switch (value.action.case) {
    case "copy":
      return;
    case "paste":
      validateClipboardText(value.action.value.text);
      return;
    case undefined:
      throw invalidArgument("Remote Desktop clipboard text action is required.");
  }
}

function validateClipboardTextResult(
  request: contract.RemoteDesktopClipboardTextRequest,
  value: contract.RemoteDesktopClipboardTextResult
): void {
  if (request.action.case === "copy") {
    if (value.text === undefined) throw invalidTargetResponse();
    try { validateClipboardText(value.text); }
    catch { throw invalidTargetResponse(); }
    return;
  }
  if (value.text !== undefined) throw invalidTargetResponse();
}

function validateClipboardText(value: string): void {
  if (value.length < 1 || value.length > MAXIMUM_CLIPBOARD_TEXT_CHARACTERS || value.includes("\u0000")) {
    throw invalidArgument("Remote Desktop clipboard text is invalid.");
  }
}

function validateClipboardContentRequest(value: contract.RemoteDesktopClipboardContentRequest): void {
  validateIdentifier(value.leaseId, "lease_id");
  if (value.controlGeneration < 1n) throw invalidArgument("Remote Desktop control generation is required.");
  switch (value.action.case) {
    case "copy":
      return;
    case "begin":
      if (!Number.isInteger(value.action.value.length)
        || value.action.value.length < 1
        || value.action.value.length > CLIPBOARD_MAX_CHARACTERS) {
        throw invalidArgument("Remote Desktop clipboard length is invalid.");
      }
      return;
    case "read":
      validateIdentifier(value.action.value.transferId, "clipboard transfer_id");
      validateClipboardOffset(value.action.value.offset);
      return;
    case "write":
      validateIdentifier(value.action.value.transferId, "clipboard transfer_id");
      validateClipboardOffset(value.action.value.offset);
      if (value.action.value.data.length < 1
        || value.action.value.data.length > CLIPBOARD_CHUNK_CHARACTERS
        || value.action.value.data.includes("\u0000")
        || value.action.value.offset + value.action.value.data.length > CLIPBOARD_MAX_CHARACTERS) {
        throw invalidArgument("Remote Desktop clipboard chunk is invalid.");
      }
      return;
    case "commit":
    case "cancel":
      validateIdentifier(value.action.value.transferId, "clipboard transfer_id");
      return;
    case undefined:
      throw invalidArgument("Remote Desktop clipboard content action is required.");
  }
}

function validateClipboardOffset(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= CLIPBOARD_MAX_CHARACTERS) {
    throw invalidArgument("Remote Desktop clipboard offset is invalid.");
  }
}

function validateClipboardContentResult(
  request: contract.RemoteDesktopClipboardContentRequest,
  value: contract.RemoteDesktopClipboardContentResult
): void {
  switch (request.action.case) {
    case "copy":
      if (value.transferId === undefined || value.length === undefined || value.data !== undefined
        || value.length < 1 || value.length > CLIPBOARD_MAX_CHARACTERS) throw invalidTargetResponse();
      validateTargetIdentifier(value.transferId);
      return;
    case "begin":
      if (value.transferId === undefined || value.length !== undefined || value.data !== undefined) {
        throw invalidTargetResponse();
      }
      validateTargetIdentifier(value.transferId);
      return;
    case "read":
      if (value.transferId !== undefined || value.length !== undefined || value.data === undefined
        || value.data.length < 1 || value.data.length > CLIPBOARD_CHUNK_CHARACTERS
        || value.data.includes("\u0000")) throw invalidTargetResponse();
      return;
    case "write":
    case "commit":
    case "cancel":
      if (value.transferId !== undefined || value.length !== undefined || value.data !== undefined) {
        throw invalidTargetResponse();
      }
      return;
    case undefined:
      throw invalidTargetResponse();
  }
}

function validateTargetIdentifier(value: string): void {
  if (value.length < 1 || value.length > MAXIMUM_IDENTIFIER_LENGTH
    || value.trim() !== value || hasControl(value)) throw invalidTargetResponse();
}

function validateDisplay(value: contract.RemoteDesktopDisplay): void {
  validateIdentifier(value.displayId, "display_id");
  validateDisplayText(value.name);
  if (!Number.isInteger(value.width) || !Number.isInteger(value.height)
    || value.width < 1 || value.height < 1
    || value.width > MAXIMUM_DISPLAY_EDGE || value.height > MAXIMUM_DISPLAY_EDGE) throw invalidTargetResponse();
}

function validateInput(sequence: bigint, events: readonly contract.RemoteDesktopInputEvent[]): void {
  if (sequence < 1n || events.length < 1 || events.length > MAXIMUM_INPUT_EVENTS) {
    throw invalidArgument("Remote Desktop input sequence or event count is invalid.");
  }
  for (const input of events) {
    switch (input.event.case) {
      case "move":
        validateCoordinate(input.event.value.x);
        validateCoordinate(input.event.value.y);
        break;
      case "button":
        if (input.event.value.button !== contract.RemoteDesktopMouseButton.LEFT
          && input.event.value.button !== contract.RemoteDesktopMouseButton.MIDDLE
          && input.event.value.button !== contract.RemoteDesktopMouseButton.RIGHT) {
          throw invalidArgument("Remote Desktop mouse button is invalid.");
        }
        validateCoordinate(input.event.value.x);
        validateCoordinate(input.event.value.y);
        break;
      case "scroll":
        if (!Number.isFinite(input.event.value.deltaX) || !Number.isFinite(input.event.value.deltaY)
          || Math.abs(input.event.value.deltaX) > MAXIMUM_SCROLL_DELTA
          || Math.abs(input.event.value.deltaY) > MAXIMUM_SCROLL_DELTA) {
          throw invalidArgument("Remote Desktop scroll input is invalid.");
        }
        break;
      case "key":
        if (!SIMPLE_KEY_CODE_PATTERN.test(input.event.value.code) && !NAMED_KEY_CODES.has(input.event.value.code)) {
          throw invalidArgument("Remote Desktop key input is not supported.");
        }
        break;
      case "text":
        if (input.event.value.text.length < 1 || input.event.value.text.length > MAXIMUM_TEXT_INPUT_LENGTH
          || input.event.value.text.includes("\u0000")) throw invalidArgument("Remote Desktop text input is invalid.");
        break;
      case "release":
        break;
      case undefined:
        throw invalidArgument("Remote Desktop input event is required.");
    }
  }
}

function validateCoordinate(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidArgument("Remote Desktop pointer coordinate is invalid.");
  }
}

function validateAttemptId(value: string): void {
  if (!ATTEMPT_ID_PATTERN.test(value)) throw invalidArgument("Remote Desktop attempt_id is invalid.");
}

function validateSdp(value: string, field: string): void {
  if (value.length < 1 || value.includes("\u0000") || Buffer.byteLength(value, "utf8") > MAXIMUM_SDP_BYTES) {
    throw invalidArgument(`Remote Desktop ${field} is invalid.`);
  }
}

function validateIceCandidates(values: readonly contract.RemoteDesktopIceCandidate[]): void {
  if (values.length > MAXIMUM_ICE_CANDIDATES) throw invalidArgument("Remote Desktop ICE candidate batch is too large.");
  for (const value of values) {
    if (value.candidate.length < 1 || value.candidate.length > MAXIMUM_ICE_CANDIDATE_LENGTH
      || value.candidate.trim() !== value.candidate || hasControl(value.candidate)) {
      throw invalidArgument("Remote Desktop ICE candidate is invalid.");
    }
    if (value.sdpMid !== undefined) validateOptionalIceField(value.sdpMid);
    if (value.usernameFragment !== undefined) validateOptionalIceField(value.usernameFragment);
    if (value.sdpMLineIndex !== undefined
      && (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0 || value.sdpMLineIndex > 65_535)) {
      throw invalidArgument("Remote Desktop ICE media-line index is invalid.");
    }
  }
}

function validateOptionalIceField(value: string): void {
  if (value.length > MAXIMUM_IDENTIFIER_LENGTH || hasControl(value)) {
    throw invalidArgument("Remote Desktop ICE field is invalid.");
  }
}

function validateIceCursor(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAXIMUM_ICE_CURSOR) {
    throw invalidArgument("Remote Desktop ICE cursor is invalid.");
  }
}

function validateIceServers(values: readonly contract.RemoteDesktopIceServer[], now: number): void {
  if (values.length < 1 || values.length > MAXIMUM_ICE_SERVERS) throw invalidTargetResponse();
  for (const value of values) {
    if (value.urls.length < 1 || value.urls.length > MAXIMUM_ICE_URLS) throw invalidTargetResponse();
    for (const url of value.urls) {
      if (url.length < 1 || url.length > MAXIMUM_ICE_FIELD_LENGTH
        || !/^(?:stun|stuns|turn|turns):/u.test(url) || hasControl(url)) throw invalidTargetResponse();
    }
    if (value.username !== undefined && (value.username.length > MAXIMUM_ICE_FIELD_LENGTH || hasControl(value.username))) {
      throw invalidTargetResponse();
    }
    if (value.credential !== undefined && (value.credential.length > MAXIMUM_ICE_FIELD_LENGTH || hasControl(value.credential))) {
      throw invalidTargetResponse();
    }
    if (value.expiresAt === undefined) throw invalidTargetResponse();
    const expiresAt = Number(value.expiresAt.seconds) * 1_000 + Math.floor(value.expiresAt.nanos / 1_000_000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 24 * 60 * 60_000) {
      throw invalidTargetResponse();
    }
  }
}

function validateIdentifier(value: string, field: string, allowEmpty = false): void {
  if (allowEmpty && value === "") return;
  if (value.length < 1 || value.length > MAXIMUM_IDENTIFIER_LENGTH
    || value.trim() !== value || hasControl(value)) throw invalidArgument(`Remote Desktop ${field} is invalid.`);
}

function validateDisplayText(value: string): void {
  if (value.length < 1 || value.length > MAXIMUM_DISPLAY_NAME_LENGTH
    || value.trim() !== value || hasControl(value)) throw invalidTargetResponse();
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function sameIdentity(left: DevicePeerSelectionIdentity, right: DevicePeerSelectionIdentity): boolean {
  return left.targetDeviceId === right.targetDeviceId
    && left.targetDeviceRevision === right.targetDeviceRevision
    && left.relationId === right.relationId
    && left.relationRevision === right.relationRevision
    && left.routeGeneration === right.routeGeneration;
}

function leaseFailure(
  reason: contract.RemoteDesktopFailureReason,
  code: RemoteDesktopCoordinatorErrorCode = "failed_precondition"
): RemoteDesktopCoordinatorError {
  return new RemoteDesktopCoordinatorError(
    code,
    "Remote Desktop lease is no longer active.",
    create(contract.RemoteDesktopFailureSchema, { reason, retryable: false })
  );
}

function invalidArgument(message: string): RemoteDesktopCoordinatorError {
  return new RemoteDesktopCoordinatorError("invalid_argument", message);
}

function invalidTargetResponse(): RemoteDesktopCoordinatorError {
  return new RemoteDesktopCoordinatorError("internal", "Remote Desktop host returned an invalid response.");
}
