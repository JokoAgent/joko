import {
  DEVICE_PEER_PROTOCOL_VERSION,
  DevicePeerProtocolError,
  assertDevicePeerAbortFrame,
  assertDevicePeerRequestFrame,
  assertDevicePeerResponseFrame,
  assertDevicePeerRetireFrame,
  assertDevicePeerRouteAcceptedFrame,
  assertDevicePeerStreamEventFrame,
  type DevicePeerAbortFrame,
  type DevicePeerAgentOutcome,
  type DevicePeerCapability,
  type DevicePeerDispatchControl,
  type DevicePeerHelloFrame,
  type DevicePeerRequestFrame,
  type DevicePeerResponseFrame,
  type DevicePeerRetireFrame,
  type DevicePeerRouteAcceptedFrame,
  type DevicePeerRouteTransport,
  type DevicePeerStreamEventFrame
} from "./protocol.js";

export interface DevicePeerTargetAgent {
  handle(frame: DevicePeerRequestFrame, signal: AbortSignal): Promise<DevicePeerAgentOutcome>;
  abort?(frame: DevicePeerAbortFrame): void | Promise<void>;
  retire?(frame: DevicePeerRetireFrame): void | Promise<void>;
}

export interface InProcessDevicePeerHarnessOptions {
  readonly targetDeviceId: string;
  readonly capabilities: readonly DevicePeerCapability[];
  readonly agent: DevicePeerTargetAgent;
  /** Test-only fault injection after the target handler has run. */
  readonly transformResponse?: (frame: DevicePeerResponseFrame) => DevicePeerResponseFrame;
}

export interface InProcessDevicePeerHarness {
  readonly transport: DevicePeerRouteTransport;
  readonly activatedRoutes: readonly DevicePeerRouteAcceptedFrame[];
  readonly acceptedRequests: readonly DevicePeerRequestFrame[];
  readonly aborts: readonly DevicePeerAbortFrame[];
  readonly retirements: readonly DevicePeerRetireFrame[];
  /** Emits an agent stream frame through the same fenced multiplex route. */
  emit(frame: DevicePeerStreamEventFrame): void;
  /** Drop a terminal receipt after the named request has reached the target handler. */
  loseReceipt(requestId: string): void;
}

/**
 * Deterministic in-process route for owner and composition tests. It exercises
 * the same strict frames and acceptance boundary as a streaming transport; it
 * does not create a second product model or persist requests and credentials.
 */
export function createInProcessDevicePeerHarness(
  options: InProcessDevicePeerHarnessOptions
): InProcessDevicePeerHarness {
  const hello: DevicePeerHelloFrame = Object.freeze({
    protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
    kind: "hello",
    targetDeviceId: options.targetDeviceId,
    capabilities: Object.freeze([...options.capabilities])
  });
  const activatedRoutes: DevicePeerRouteAcceptedFrame[] = [];
  const acceptedRequests: DevicePeerRequestFrame[] = [];
  const aborts: DevicePeerAbortFrame[] = [];
  const retirements: DevicePeerRetireFrame[] = [];
  const lostReceipts = new Set<string>();
  const streamListeners = new Set<(frame: DevicePeerStreamEventFrame) => void>();
  let activeRoute: DevicePeerRouteAcceptedFrame | undefined;

  const transport: DevicePeerRouteTransport = {
    hello,
    activate(frame) {
      assertDevicePeerRouteAcceptedFrame(frame);
      if (frame.targetDeviceId !== hello.targetDeviceId || !sameCapabilities(frame.capabilities, hello.capabilities)) {
        throw new DevicePeerProtocolError("identity_mismatch", "The activated route does not match the target hello.");
      }
      if (activeRoute !== undefined && frame.routeGeneration <= activeRoute.routeGeneration) {
        throw new DevicePeerProtocolError("authority_changed", "The route generation did not advance.");
      }
      activeRoute = frame;
      activatedRoutes.push(frame);
    },
    subscribe(listener) {
      streamListeners.add(listener);
      let disposed = false;
      return {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          streamListeners.delete(listener);
        }
      };
    },
    async dispatch(frame: DevicePeerRequestFrame, control: DevicePeerDispatchControl): Promise<DevicePeerResponseFrame> {
      assertDevicePeerRequestFrame(frame);
      if (activeRoute === undefined || frame.targetDeviceId !== activeRoute.targetDeviceId
        || frame.routeGeneration !== activeRoute.routeGeneration) {
        throw new DevicePeerProtocolError("identity_mismatch", "The request does not belong to the active route.");
      }
      if (!activeRoute.capabilities.includes(frame.capability)) {
        throw new DevicePeerProtocolError("authority_changed", "The active route lacks the requested capability.");
      }
      if (control.signal.aborted) throw new DevicePeerProtocolError("authority_changed", "The request was aborted.");
      control.accepted();
      acceptedRequests.push(frame);
      const outcome = await options.agent.handle(frame, control.signal);
      let response = responseFor(frame, outcome);
      assertDevicePeerResponseFrame(response);
      if (options.transformResponse !== undefined) response = options.transformResponse(response);
      if (lostReceipts.delete(frame.requestId)) throw new Error("The in-process receipt was intentionally lost.");
      return response;
    },
    abort(frame) {
      assertDevicePeerAbortFrame(frame);
      aborts.push(frame);
      return options.agent.abort?.(frame);
    },
    retire(frame) {
      assertDevicePeerRetireFrame(frame);
      retirements.push(frame);
      if (activeRoute?.targetDeviceId === frame.targetDeviceId
        && activeRoute.routeGeneration === frame.routeGeneration) activeRoute = undefined;
      return options.agent.retire?.(frame);
    }
  };

  return {
    transport,
    get activatedRoutes() { return activatedRoutes.slice(); },
    get acceptedRequests() { return acceptedRequests.slice(); },
    get aborts() { return aborts.slice(); },
    get retirements() { return retirements.slice(); },
    emit(frame) {
      assertDevicePeerStreamEventFrame(frame);
      for (const listener of streamListeners) listener(frame);
    },
    loseReceipt(requestId) { lostReceipts.add(requestId); }
  };
}

function responseFor(frame: DevicePeerRequestFrame, outcome: DevicePeerAgentOutcome): DevicePeerResponseFrame {
  return Object.freeze({
    protocolVersion: DEVICE_PEER_PROTOCOL_VERSION,
    kind: "response",
    requestId: frame.requestId,
    targetDeviceId: frame.targetDeviceId,
    routeGeneration: frame.routeGeneration,
    ...outcome
  });
}

function sameCapabilities(
  left: readonly DevicePeerCapability[],
  right: readonly DevicePeerCapability[]
): boolean {
  return left.length === right.length && left.every((capability) => right.includes(capability));
}
