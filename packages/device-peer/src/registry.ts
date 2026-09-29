import { randomBytes } from "node:crypto";

import {
  DEVICE_PEER_PROTOCOL_VERSION,
  DevicePeerProtocolError,
  assertDevicePeerHelloFrame,
  assertDevicePeerRequestFrame,
  assertDevicePeerResponseFrame,
  assertDevicePeerStreamEventFrame,
  type DevicePeerAbortFrame,
  type DevicePeerAgentOutcome,
  type DevicePeerCapability,
  type DevicePeerEffectKind,
  type DevicePeerRequestFrame,
  type DevicePeerResponseFrame,
  type DevicePeerRetireFrame,
  type DevicePeerRouteAcceptedFrame,
  type DevicePeerStreamEventFrame,
  type DevicePeerMultiplexEvent,
  type DevicePeerRouteTransport
} from "./protocol.js";

const registeredClaim = Symbol("registered-device-peer-claim");
const MAXIMUM_INITIAL_ROUTE_GENERATION = 2 ** 48 - 1;

export interface DevicePeerRouteRegistryOptions {
  /** First process-local route generation; injectable only for deterministic owners/tests. */
  readonly generationSeed?: number;
}

export interface DevicePeerRouteRegistrationOptions {
  /** Reserve a generation without exposing or replacing a live route yet. */
  readonly deferredActivation?: boolean;
}

export interface DevicePeerRouteLease extends DevicePeerRouteAcceptedFrame {}

export interface DevicePeerClaimInput {
  readonly requestId: string;
  readonly targetDeviceId: string;
  readonly routeGeneration: number;
  readonly capability: DevicePeerCapability;
  readonly effectKind: DevicePeerEffectKind;
  readonly action: string;
  readonly payload: unknown;
}

export interface RegisteredDevicePeerClaim extends DevicePeerClaimInput {
  readonly protocolVersion: typeof DEVICE_PEER_PROTOCOL_VERSION;
  readonly kind: "claim";
  readonly [registeredClaim]: true;
}

export class DevicePeerRegistryError extends Error {
  constructor(readonly code: "claim_conflict" | "route_unavailable" | "capability_unavailable" | "unregistered_claim") {
    super(code);
    this.name = "DevicePeerRegistryError";
  }
}

interface RouteRecord {
  readonly lease: DevicePeerRouteLease;
  readonly transport: DevicePeerRouteTransport;
  readonly claims: Set<ClaimRecord>;
  readonly listeners: Set<(event: DevicePeerMultiplexEvent) => void>;
  readonly streamSequences: Map<string, number>;
  readonly suppressedStreams: Map<string, DevicePeerCapability>;
  subscription?: { dispose(): void };
  retired: boolean;
}

interface ClaimRecord {
  readonly claim: RegisteredDevicePeerClaim;
  readonly route: RouteRecord;
  state: "registered" | "dispatching" | "terminal";
  accepted: boolean;
  controller?: AbortController;
  result?: DevicePeerResponseFrame;
  pending?: Promise<DevicePeerResponseFrame>;
  suppressed: boolean;
}

type InterruptionReason = "caller_aborted" | "route_retired";

/**
 * Process-local live-route registry. Durable queue/effect authority stays with
 * the caller: registerClaim may only be called after that external claim has
 * committed, and this registry never creates a Target, Session, Event, or
 * credential record.
 */
export class DevicePeerRouteRegistry {
  readonly #currentRoutes = new Map<string, RouteRecord>();
  readonly #pendingRoutes = new Map<string, RouteRecord>();
  readonly #lastGenerations = new Map<string, number>();
  readonly #claimsByRequestId = new Map<string, ClaimRecord>();
  readonly #claimRecords = new WeakMap<RegisteredDevicePeerClaim, ClaimRecord>();
  readonly #firstGeneration: number;

  constructor(options: DevicePeerRouteRegistryOptions = {}) {
    const generationSeed = options.generationSeed ?? randomGenerationSeed();
    if (!Number.isSafeInteger(generationSeed)
      || generationSeed < 1
      || generationSeed > MAXIMUM_INITIAL_ROUTE_GENERATION) {
      throw new TypeError("Device peer route generation seed is invalid.");
    }
    this.#firstGeneration = generationSeed;
  }

  registerRoute(
    authenticatedDeviceId: string,
    transport: DevicePeerRouteTransport,
    options: DevicePeerRouteRegistrationOptions = {}
  ): DevicePeerRouteLease {
    assertDevicePeerHelloFrame(transport.hello);
    if (authenticatedDeviceId !== transport.hello.targetDeviceId) {
      throw new DevicePeerProtocolError(
        "identity_mismatch",
        "The authenticated connection Device does not own the claimed target Device."
      );
    }
    const previousGeneration = this.#lastGenerations.get(authenticatedDeviceId) ?? this.#firstGeneration - 1;
    if (previousGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new DevicePeerProtocolError("authority_changed", "The route generation is exhausted.");
    }
    const capabilities = Object.freeze([...transport.hello.capabilities]);
    const lease = Object.freeze({
      protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
      kind: "route_accepted" as const,
      targetDeviceId: authenticatedDeviceId,
      routeGeneration: previousGeneration + 1,
      capabilities
    });

    // Generation is consumed even when activation fails; it must never move backwards.
    this.#lastGenerations.set(authenticatedDeviceId, lease.routeGeneration);
    transport.activate(lease);

    const route: RouteRecord = {
      lease,
      transport,
      claims: new Set(),
      listeners: new Set(),
      streamSequences: new Map(),
      suppressedStreams: new Map(),
      retired: false
    };
    try {
      route.subscription = transport.subscribe((event) => this.#acceptStreamEvent(route, event));
    } catch (error) {
      this.#retire(route, "authority_changed");
      throw error;
    }
    if (route.retired) {
      throw new DevicePeerProtocolError("authority_changed", "The route emitted before activation completed.");
    }
    if (options.deferredActivation === true) {
      const previousPending = this.#pendingRoutes.get(authenticatedDeviceId);
      this.#pendingRoutes.set(authenticatedDeviceId, route);
      if (previousPending !== undefined) this.#retire(previousPending, "replaced");
    } else {
      const previousPending = this.#pendingRoutes.get(authenticatedDeviceId);
      if (previousPending !== undefined) {
        this.#pendingRoutes.delete(authenticatedDeviceId);
        this.#retire(previousPending, "replaced");
      }
      const previous = this.#currentRoutes.get(authenticatedDeviceId);
      this.#currentRoutes.set(authenticatedDeviceId, route);
      if (previous !== undefined) this.#retire(previous, "replaced");
    }
    return lease;
  }

  activateRoute(identity: Pick<DevicePeerRouteLease, "targetDeviceId" | "routeGeneration">): DevicePeerRouteLease {
    const route = this.#pendingRoutes.get(identity.targetDeviceId);
    if (route === undefined || route.retired || route.lease.routeGeneration !== identity.routeGeneration) {
      throw new DevicePeerRegistryError("route_unavailable");
    }
    this.#pendingRoutes.delete(identity.targetDeviceId);
    const previous = this.#currentRoutes.get(identity.targetDeviceId);
    this.#currentRoutes.set(identity.targetDeviceId, route);
    if (previous !== undefined) this.#retire(previous, "replaced");
    return route.lease;
  }

  getRoute(targetDeviceId: string): DevicePeerRouteLease | undefined {
    return this.#currentRoutes.get(targetDeviceId)?.lease;
  }

  listRoutes(requiredCapabilities: readonly DevicePeerCapability[] = []): readonly DevicePeerRouteLease[] {
    return [...this.#currentRoutes.values()]
      .filter(({ lease }) => requiredCapabilities.every((capability) => lease.capabilities.includes(capability)))
      .map(({ lease }) => lease)
      .sort((left, right) => left.targetDeviceId.localeCompare(right.targetDeviceId));
  }

  subscribe(
    lease: Pick<DevicePeerRouteLease, "targetDeviceId" | "routeGeneration">,
    listener: (event: DevicePeerMultiplexEvent) => void
  ): { dispose(): void } {
    const route = this.#currentRoutes.get(lease.targetDeviceId);
    if (route === undefined || route.retired || route.lease.routeGeneration !== lease.routeGeneration) {
      throw new DevicePeerRegistryError("route_unavailable");
    }
    route.listeners.add(listener);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        route.listeners.delete(listener);
      }
    };
  }

  registerClaim(input: DevicePeerClaimInput): RegisteredDevicePeerClaim {
    const requestFrame = requestFromInput(input);
    assertDevicePeerRequestFrame(requestFrame);
    if (this.#claimsByRequestId.has(input.requestId)) throw new DevicePeerRegistryError("claim_conflict");
    const route = this.#currentRoutes.get(input.targetDeviceId);
    if (route === undefined || route.retired || route.lease.routeGeneration !== input.routeGeneration) {
      throw new DevicePeerRegistryError("route_unavailable");
    }
    if (!route.lease.capabilities.includes(input.capability)) {
      throw new DevicePeerRegistryError("capability_unavailable");
    }
    const claim = {
      protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
      kind: "claim" as const,
      ...input
    } as RegisteredDevicePeerClaim;
    Object.defineProperty(claim, registeredClaim, { value: true, enumerable: false });
    Object.freeze(claim);
    if (route.suppressedStreams.has(input.requestId)) throw new DevicePeerRegistryError("claim_conflict");
    const record: ClaimRecord = { claim, route, state: "registered", accepted: false, suppressed: false };
    route.claims.add(record);
    this.#claimsByRequestId.set(claim.requestId, record);
    this.#claimRecords.set(claim, record);
    return claim;
  }

  dispatch(claim: RegisteredDevicePeerClaim, signal?: AbortSignal): Promise<DevicePeerResponseFrame> {
    const record = this.#requireClaim(claim);
    if (record.state === "terminal") return Promise.resolve(requireResult(record));
    if (record.state === "dispatching") return requirePending(record);
    if (signal?.aborted === true) {
      return Promise.resolve(this.#finish(record, response(record, { outcome: "aborted" })));
    }
    if (!this.#isCurrent(record.route)) {
      return Promise.resolve(this.#finish(record, response(record, { outcome: "failed", errorCode: "route_retired" })));
    }
    record.state = "dispatching";
    const pending = this.#dispatch(record, signal);
    record.pending = pending;
    return pending;
  }

  abort(claim: RegisteredDevicePeerClaim): DevicePeerResponseFrame | undefined {
    const record = this.#requireClaim(claim);
    if (record.state === "terminal") return requireResult(record);
    if (record.state === "registered") {
      return this.#finish(record, response(record, { outcome: "aborted" }));
    }
    record.controller?.abort("caller_aborted" satisfies InterruptionReason);
    return undefined;
  }

  retireRoute(
    identity: Pick<DevicePeerRouteLease, "targetDeviceId" | "routeGeneration">,
    reason: DevicePeerRetireFrame["reason"]
  ): boolean {
    let route = this.#currentRoutes.get(identity.targetDeviceId);
    if (route !== undefined && route.lease.routeGeneration === identity.routeGeneration) {
      this.#currentRoutes.delete(identity.targetDeviceId);
    } else {
      route = this.#pendingRoutes.get(identity.targetDeviceId);
      if (route === undefined || route.lease.routeGeneration !== identity.routeGeneration) return false;
      this.#pendingRoutes.delete(identity.targetDeviceId);
    }
    this.#retire(route, reason);
    return true;
  }

  forgetClaim(claim: RegisteredDevicePeerClaim): void {
    const record = this.#requireClaim(claim);
    if (record.state !== "terminal") throw new DevicePeerRegistryError("unregistered_claim");
    this.#dropClaim(record);
  }

  /**
   * Stops projecting an accepted long-lived stream without retiring sibling
   * claims on the same authenticated route. A route-scoped tombstone absorbs
   * late frames until their terminal event or route retirement.
   */
  suppressStreamClaim(claim: RegisteredDevicePeerClaim): void {
    const record = this.#requireClaim(claim);
    if (!record.accepted) {
      this.abort(claim);
      if (record.state === "terminal") this.#dropClaim(record);
      return;
    }
    if (record.suppressed) return;
    record.suppressed = true;
    record.route.suppressedStreams.set(record.claim.requestId, record.claim.capability);
    if (record.state === "dispatching") record.controller?.abort("caller_aborted" satisfies InterruptionReason);
    else if (record.state === "terminal") this.#dropClaim(record);
  }

  shutdown(): void {
    const routes = [...this.#currentRoutes.values(), ...this.#pendingRoutes.values()];
    this.#currentRoutes.clear();
    this.#pendingRoutes.clear();
    for (const route of routes) this.#retire(route, "shutdown");
  }

  async #dispatch(record: ClaimRecord, callerSignal?: AbortSignal): Promise<DevicePeerResponseFrame> {
    const controller = new AbortController();
    record.controller = controller;
    let interruptionResolve: ((reason: InterruptionReason) => void) | undefined;
    const interruption = new Promise<InterruptionReason>((resolve) => { interruptionResolve = resolve; });
    const onInternalAbort = (): void => {
      const reason = controller.signal.reason === "route_retired" ? "route_retired" : "caller_aborted";
      interruptionResolve?.(reason);
      this.#sendAbort(record, reason);
    };
    const onCallerAbort = (): void => controller.abort("caller_aborted" satisfies InterruptionReason);
    controller.signal.addEventListener("abort", onInternalAbort, { once: true });
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    const frame = Object.freeze(requestFromInput(record.claim));
    let transportResult: Promise<{ readonly type: "response"; readonly frame: DevicePeerResponseFrame }
      | { readonly type: "error"; readonly error: unknown }>;
    try {
      const dispatched = record.route.transport.dispatch(frame, {
        signal: controller.signal,
        accepted: () => {
          if (record.accepted) throw new DevicePeerProtocolError("invalid_frame", "The request was accepted twice.");
          if (record.state !== "dispatching" || controller.signal.aborted || !this.#isCurrent(record.route)) {
            throw new DevicePeerProtocolError("authority_changed", "The route retired before agent acceptance.");
          }
          record.accepted = true;
        }
      });
      transportResult = Promise.resolve(dispatched).then(
        (result) => ({ type: "response" as const, frame: result }),
        (error: unknown) => ({ type: "error" as const, error })
      );
    } catch (error) {
      transportResult = Promise.resolve({ type: "error" as const, error });
    }

    try {
      const settled = await Promise.race([
        transportResult,
        interruption.then((reason) => ({ type: "interrupted" as const, reason }))
      ]);
      if (settled.type === "interrupted") return this.#finish(record, this.#interrupted(record, settled.reason));
      if (controller.signal.aborted) {
        const reason = controller.signal.reason === "route_retired" ? "route_retired" : "caller_aborted";
        return this.#finish(record, this.#interrupted(record, reason));
      }
      if (!this.#isCurrent(record.route)) {
        return this.#finish(record, this.#lostAuthority(record, "route_retired"));
      }
      if (settled.type === "error") {
        const result = record.accepted && record.claim.effectKind === "side_effect"
          ? response(record, { outcome: "outcome_unknown", errorCode: "receipt_lost" })
          : response(record, { outcome: "failed", errorCode: "transport_failure" });
        this.#retireActiveRoute(record.route);
        return this.#finish(record, result);
      }
      if (!record.accepted) {
        const result = record.claim.effectKind === "side_effect"
          ? response(record, { outcome: "outcome_unknown", errorCode: "invalid_response" })
          : response(record, { outcome: "failed", errorCode: "invalid_response" });
        this.#retireActiveRoute(record.route);
        return this.#finish(record, result);
      }
      try {
        assertDevicePeerResponseFrame(settled.frame);
      } catch {
        const result = this.#lostAuthority(record, "invalid_response");
        this.#retireActiveRoute(record.route);
        return this.#finish(record, result);
      }
      if (!sameResponseIdentity(record, settled.frame)) {
        const result = this.#lostAuthority(record, "identity_mismatch");
        this.#retireActiveRoute(record.route);
        return this.#finish(record, result);
      }
      return this.#finish(record, Object.freeze(settled.frame));
    } finally {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      record.controller = undefined;
    }
  }

  #interrupted(record: ClaimRecord, reason: InterruptionReason): DevicePeerResponseFrame {
    if (record.accepted && record.claim.effectKind === "side_effect") {
      return response(record, { outcome: "outcome_unknown", errorCode: reason });
    }
    return reason === "caller_aborted"
      ? response(record, { outcome: "aborted" })
      : response(record, { outcome: "failed", errorCode: "route_retired" });
  }

  #lostAuthority(record: ClaimRecord, errorCode: string): DevicePeerResponseFrame {
    return record.accepted && record.claim.effectKind === "side_effect"
      ? response(record, { outcome: "outcome_unknown", errorCode })
      : response(record, { outcome: "failed", errorCode });
  }

  #sendAbort(record: ClaimRecord, reason: InterruptionReason): void {
    const frame: DevicePeerAbortFrame = Object.freeze({
      protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
      kind: "abort",
      requestId: record.claim.requestId,
      targetDeviceId: record.claim.targetDeviceId,
      routeGeneration: record.claim.routeGeneration,
      reason
    });
    settleControl(record.route.transport.abort?.(frame));
  }

  #finish(record: ClaimRecord, result: DevicePeerResponseFrame): DevicePeerResponseFrame {
    if (record.state === "terminal") return requireResult(record);
    record.state = "terminal";
    record.result = result;
    if (record.suppressed) this.#dropClaim(record);
    return result;
  }

  #retire(route: RouteRecord, reason: DevicePeerRetireFrame["reason"]): void {
    if (route.retired) return;
    route.retired = true;
    route.subscription?.dispose();
    route.subscription = undefined;
    const closed: DevicePeerMultiplexEvent = Object.freeze({
      protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
      kind: "route_closed",
      targetDeviceId: route.lease.targetDeviceId,
      routeGeneration: route.lease.routeGeneration,
      reason
    });
    for (const listener of route.listeners) safelyNotify(listener, closed);
    route.listeners.clear();
    route.suppressedStreams.clear();
    const frame: DevicePeerRetireFrame = Object.freeze({
      protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
      kind: "retire",
      targetDeviceId: route.lease.targetDeviceId,
      routeGeneration: route.lease.routeGeneration,
      reason
    });
    settleControl(route.transport.retire?.(frame));
    for (const claim of route.claims) {
      if (claim.state === "dispatching") claim.controller?.abort("route_retired" satisfies InterruptionReason);
    }
  }

  #isCurrent(route: RouteRecord): boolean {
    return !route.retired && this.#currentRoutes.get(route.lease.targetDeviceId) === route;
  }

  #acceptStreamEvent(route: RouteRecord, event: unknown): void {
    if (route.retired) return;
    try {
      assertDevicePeerStreamEventFrame(event);
    } catch {
      this.#retireActiveRoute(route);
      return;
    }
    if (event.targetDeviceId !== route.lease.targetDeviceId
      || event.routeGeneration !== route.lease.routeGeneration) {
      this.#retireActiveRoute(route);
      return;
    }
    const capability = streamCapability(event.channel);
    const suppressedCapability = route.suppressedStreams.get(event.requestId);
    const claim = this.#claimsByRequestId.get(event.requestId);
    if ((claim === undefined && suppressedCapability === undefined)
      || (claim !== undefined && (claim.route !== route || !claim.accepted || capability !== claim.claim.capability))
      || (suppressedCapability !== undefined && capability !== suppressedCapability)) {
      this.#retireActiveRoute(route);
      return;
    }
    const sequenceKey = `${event.requestId}\u0000${event.streamId}`;
    const expected = (route.streamSequences.get(sequenceKey) ?? 0) + 1;
    if (event.sequence !== expected) {
      this.#retireActiveRoute(route);
      return;
    }
    route.streamSequences.set(sequenceKey, event.sequence);
    if (suppressedCapability !== undefined) {
      if (terminalStreamChannel(event.channel)) route.suppressedStreams.delete(event.requestId);
      return;
    }
    for (const listener of route.listeners) safelyNotify(listener, event);
    // A listener may suppress its lease while handling the terminal frame.
    // Retire that just-created tombstone now rather than retaining it until
    // the whole route reconnects.
    if (terminalStreamChannel(event.channel) && route.suppressedStreams.has(event.requestId)) {
      route.suppressedStreams.delete(event.requestId);
    }
  }

  #retireActiveRoute(route: RouteRecord): void {
    if (this.#currentRoutes.get(route.lease.targetDeviceId) === route) {
      this.#currentRoutes.delete(route.lease.targetDeviceId);
    }
    if (this.#pendingRoutes.get(route.lease.targetDeviceId) === route) {
      this.#pendingRoutes.delete(route.lease.targetDeviceId);
    }
    this.#retire(route, "authority_changed");
  }

  #requireClaim(claim: RegisteredDevicePeerClaim): ClaimRecord {
    const record = this.#claimRecords.get(claim);
    if (record === undefined) throw new DevicePeerRegistryError("unregistered_claim");
    return record;
  }

  #dropClaim(record: ClaimRecord): void {
    record.route.claims.delete(record);
    this.#claimsByRequestId.delete(record.claim.requestId);
    this.#claimRecords.delete(record.claim);
  }
}

function randomGenerationSeed(): number {
  for (;;) {
    const seed = randomBytes(6).readUIntBE(0, 6);
    if (seed > 0) return seed;
  }
}

function streamCapability(channel: DevicePeerStreamEventFrame["channel"]): DevicePeerCapability {
  if (channel === "process_stdout" || channel === "process_stderr" || channel === "process_exit") return "process";
  if (channel === "terminal_data" || channel === "terminal_exit") return "terminal";
  return "forwarding";
}

function terminalStreamChannel(channel: DevicePeerStreamEventFrame["channel"]): boolean {
  return channel === "process_exit" || channel === "terminal_exit"
    || channel === "forward_close";
}

function requestFromInput(input: DevicePeerClaimInput): DevicePeerRequestFrame {
  return {
    protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
    kind: "request",
    requestId: input.requestId,
    targetDeviceId: input.targetDeviceId,
    routeGeneration: input.routeGeneration,
    capability: input.capability,
    effectKind: input.effectKind,
    action: input.action,
    payload: input.payload
  };
}

function response(record: ClaimRecord, outcome: DevicePeerAgentOutcome): DevicePeerResponseFrame {
  return Object.freeze({
    protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
    kind: "response",
    requestId: record.claim.requestId,
    targetDeviceId: record.claim.targetDeviceId,
    routeGeneration: record.claim.routeGeneration,
    ...outcome
  } as DevicePeerResponseFrame);
}

function sameResponseIdentity(record: ClaimRecord, frame: DevicePeerResponseFrame): boolean {
  return frame.requestId === record.claim.requestId
    && frame.targetDeviceId === record.claim.targetDeviceId
    && frame.routeGeneration === record.claim.routeGeneration;
}

function settleControl(result: void | Promise<void> | undefined): void {
  if (result instanceof Promise) void result.catch(() => undefined);
}

function safelyNotify(listener: (event: DevicePeerMultiplexEvent) => void, event: DevicePeerMultiplexEvent): void {
  try {
    listener(event);
  } catch {
    // A controller-side observer cannot change route authority or block sibling owners.
  }
}

function requireResult(record: ClaimRecord): DevicePeerResponseFrame {
  if (record.result === undefined) throw new DevicePeerRegistryError("unregistered_claim");
  return record.result;
}

function requirePending(record: ClaimRecord): Promise<DevicePeerResponseFrame> {
  if (record.pending === undefined) throw new DevicePeerRegistryError("unregistered_claim");
  return record.pending;
}
