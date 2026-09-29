export const DEVICE_PEER_PROTOCOL_VERSION = 1 as const;
/** Public route RPCs accept only this host-owned authorization purpose. */
export const DEVICE_PEER_AGENT_AUTHORIZATION_HEADER = "x-joko-device-peer-agent-authorization";

export const DEVICE_PEER_CAPABILITIES = ["files", "process", "terminal", "forwarding"] as const;
export type DevicePeerCapability = (typeof DEVICE_PEER_CAPABILITIES)[number];
export type DevicePeerEffectKind = "read_only" | "side_effect";

export interface DevicePeerRouteIdentity {
  readonly targetDeviceId: string;
  readonly routeGeneration: number;
}

export interface DevicePeerHelloFrame {
  readonly protocolVersion: typeof DEVICE_PEER_PROTOCOL_VERSION;
  readonly kind: "hello";
  readonly targetDeviceId: string;
  readonly capabilities: readonly DevicePeerCapability[];
}

export interface DevicePeerRouteAcceptedFrame extends DevicePeerRouteIdentity {
  readonly protocolVersion: typeof DEVICE_PEER_PROTOCOL_VERSION;
  readonly kind: "route_accepted";
  readonly capabilities: readonly DevicePeerCapability[];
}

export interface DevicePeerRequestFrame extends DevicePeerRouteIdentity {
  readonly protocolVersion: typeof DEVICE_PEER_PROTOCOL_VERSION;
  readonly kind: "request";
  readonly requestId: string;
  readonly capability: DevicePeerCapability;
  readonly effectKind: DevicePeerEffectKind;
  readonly action: string;
  readonly payload: unknown;
}

export interface DevicePeerAbortFrame extends DevicePeerRouteIdentity {
  readonly protocolVersion: typeof DEVICE_PEER_PROTOCOL_VERSION;
  readonly kind: "abort";
  readonly requestId: string;
  readonly reason: "caller_aborted" | "route_retired";
}

export interface DevicePeerRetireFrame extends DevicePeerRouteIdentity {
  readonly protocolVersion: typeof DEVICE_PEER_PROTOCOL_VERSION;
  readonly kind: "retire";
  readonly reason: "replaced" | "connection_closed" | "authority_changed" | "shutdown";
}

interface DevicePeerStreamEventIdentity extends DevicePeerRouteIdentity {
  readonly protocolVersion: typeof DEVICE_PEER_PROTOCOL_VERSION;
  readonly kind: "stream_event";
  readonly requestId: string;
  readonly streamId: string;
  readonly sequence: number;
}

export type DevicePeerStreamEventFrame = DevicePeerStreamEventIdentity & (
  | {
      readonly channel: "process_stdout" | "process_stderr" | "forward_data" | "reverse_forward_data";
      readonly data: Uint8Array;
    }
  | { readonly channel: "process_exit"; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly channel: "terminal_data"; readonly data: string }
  | {
      readonly channel: "terminal_exit";
      readonly exitCode: number;
      readonly signal: number | null;
      readonly failureCode: string | null;
      readonly processExitConfirmed: boolean;
    }
  | { readonly channel: "forward_close" | "reverse_forward_close"; readonly errorCode: string | null }
  | { readonly channel: "reverse_forward_open" }
);

export interface DevicePeerRouteClosedEvent extends DevicePeerRouteIdentity {
  readonly protocolVersion: typeof DEVICE_PEER_PROTOCOL_VERSION;
  readonly kind: "route_closed";
  readonly reason: DevicePeerRetireFrame["reason"];
}

export type DevicePeerMultiplexEvent = DevicePeerStreamEventFrame | DevicePeerRouteClosedEvent;

interface DevicePeerResponseIdentity extends DevicePeerRouteIdentity {
  readonly protocolVersion: typeof DEVICE_PEER_PROTOCOL_VERSION;
  readonly kind: "response";
  readonly requestId: string;
}

export type DevicePeerResponseFrame = DevicePeerResponseIdentity & (
  | { readonly outcome: "completed"; readonly value: unknown }
  | { readonly outcome: "failed"; readonly errorCode: string }
  | { readonly outcome: "aborted" }
  | { readonly outcome: "outcome_unknown"; readonly errorCode: string }
);

export type DevicePeerAgentOutcome =
  | { readonly outcome: "completed"; readonly value: unknown }
  | { readonly outcome: "failed"; readonly errorCode: string }
  | { readonly outcome: "aborted" }
  | { readonly outcome: "outcome_unknown"; readonly errorCode: string };

export interface DevicePeerDispatchControl {
  readonly signal: AbortSignal;
  /**
   * Must be called exactly once immediately before the target agent may begin
   * the request. Throwing means that authority was retired and the agent must
   * not perform the action.
   */
  accepted(): void;
}

/**
 * Ephemeral authenticated route transport. Implementations must not persist
 * route credentials, request payloads, or response payloads.
 */
export interface DevicePeerRouteTransport {
  readonly hello: DevicePeerHelloFrame;
  /** Synchronously activates the generation assigned by the authenticated registry. */
  activate(frame: DevicePeerRouteAcceptedFrame): void;
  /** Emits only target-to-controller process, PTY, and forwarding stream events. */
  subscribe(listener: (frame: DevicePeerStreamEventFrame) => void): { dispose(): void };
  dispatch(frame: DevicePeerRequestFrame, control: DevicePeerDispatchControl): Promise<DevicePeerResponseFrame>;
  abort?(frame: DevicePeerAbortFrame): void | Promise<void>;
  retire?(frame: DevicePeerRetireFrame): void | Promise<void>;
}

export class DevicePeerProtocolError extends Error {
  constructor(readonly code: "invalid_frame" | "identity_mismatch" | "authority_changed", message: string) {
    super(message);
    this.name = "DevicePeerProtocolError";
  }
}

export function assertDevicePeerHelloFrame(value: unknown): asserts value is DevicePeerHelloFrame {
  const frame = strictRecord(value, ["protocolVersion", "kind", "targetDeviceId", "capabilities"]);
  assertVersionAndKind(frame, "hello");
  assertIdentifier(frame.targetDeviceId, "targetDeviceId");
  if (!Array.isArray(frame.capabilities) || frame.capabilities.length < 1) {
    throw invalidFrame("capabilities must be a non-empty array");
  }
  const seen = new Set<DevicePeerCapability>();
  for (const capability of frame.capabilities) {
    if (!isCapability(capability) || seen.has(capability)) {
      throw invalidFrame("capabilities contain an unknown or duplicate value");
    }
    seen.add(capability);
  }
}

export function assertDevicePeerRequestFrame(value: unknown): asserts value is DevicePeerRequestFrame {
  const frame = strictRecord(value, [
    "protocolVersion", "kind", "requestId", "targetDeviceId", "routeGeneration",
    "capability", "effectKind", "action", "payload"
  ]);
  assertVersionAndKind(frame, "request");
  assertIdentifier(frame.requestId, "requestId");
  assertRouteIdentity(frame);
  if (!isCapability(frame.capability)) throw invalidFrame("capability is unknown");
  if (frame.effectKind !== "read_only" && frame.effectKind !== "side_effect") {
    throw invalidFrame("effectKind is unknown");
  }
  assertIdentifier(frame.action, "action", 128);
}

export function assertDevicePeerRouteAcceptedFrame(value: unknown): asserts value is DevicePeerRouteAcceptedFrame {
  const frame = strictRecord(value, [
    "protocolVersion", "kind", "targetDeviceId", "routeGeneration", "capabilities"
  ]);
  assertVersionAndKind(frame, "route_accepted");
  assertRouteIdentity(frame);
  if (!Array.isArray(frame.capabilities) || frame.capabilities.length < 1) {
    throw invalidFrame("capabilities must be a non-empty array");
  }
  const seen = new Set<DevicePeerCapability>();
  for (const capability of frame.capabilities) {
    if (!isCapability(capability) || seen.has(capability)) {
      throw invalidFrame("capabilities contain an unknown or duplicate value");
    }
    seen.add(capability);
  }
}

export function assertDevicePeerResponseFrame(value: unknown): asserts value is DevicePeerResponseFrame {
  if (!isRecord(value)) throw invalidFrame("frame must be an object");
  const outcome = value.outcome;
  const keys = outcome === "completed"
    ? ["protocolVersion", "kind", "requestId", "targetDeviceId", "routeGeneration", "outcome", "value"]
    : outcome === "failed" || outcome === "outcome_unknown"
      ? ["protocolVersion", "kind", "requestId", "targetDeviceId", "routeGeneration", "outcome", "errorCode"]
      : outcome === "aborted"
        ? ["protocolVersion", "kind", "requestId", "targetDeviceId", "routeGeneration", "outcome"]
        : undefined;
  if (keys === undefined) throw invalidFrame("outcome is unknown");
  const frame = strictRecord(value, keys);
  assertVersionAndKind(frame, "response");
  assertIdentifier(frame.requestId, "requestId");
  assertRouteIdentity(frame);
  if (outcome === "failed" || outcome === "outcome_unknown") assertIdentifier(frame.errorCode, "errorCode", 128);
}

export function assertDevicePeerAbortFrame(value: unknown): asserts value is DevicePeerAbortFrame {
  const frame = strictRecord(value, [
    "protocolVersion", "kind", "requestId", "targetDeviceId", "routeGeneration", "reason"
  ]);
  assertVersionAndKind(frame, "abort");
  assertIdentifier(frame.requestId, "requestId");
  assertRouteIdentity(frame);
  if (frame.reason !== "caller_aborted" && frame.reason !== "route_retired") {
    throw invalidFrame("abort reason is unknown");
  }
}

export function assertDevicePeerRetireFrame(value: unknown): asserts value is DevicePeerRetireFrame {
  const frame = strictRecord(value, ["protocolVersion", "kind", "targetDeviceId", "routeGeneration", "reason"]);
  assertVersionAndKind(frame, "retire");
  assertRouteIdentity(frame);
  if (!(frame.reason === "replaced" || frame.reason === "connection_closed"
    || frame.reason === "authority_changed" || frame.reason === "shutdown")) {
    throw invalidFrame("retirement reason is unknown");
  }
}

export function assertDevicePeerStreamEventFrame(value: unknown): asserts value is DevicePeerStreamEventFrame {
  if (!isRecord(value)) throw invalidFrame("frame must be an object");
  const channel = value.channel;
  const common = [
    "protocolVersion", "kind", "requestId", "targetDeviceId", "routeGeneration",
    "streamId", "sequence", "channel"
  ];
  const keys = channel === "process_stdout" || channel === "process_stderr" || channel === "forward_data"
    || channel === "reverse_forward_data"
    || channel === "terminal_data"
    ? [...common, "data"]
    : channel === "process_exit"
      ? [...common, "exitCode", "signal"]
      : channel === "terminal_exit"
        ? [...common, "exitCode", "signal", "failureCode", "processExitConfirmed"]
        : channel === "forward_close" || channel === "reverse_forward_close"
          ? [...common, "errorCode"]
          : channel === "reverse_forward_open"
            ? common
          : undefined;
  if (keys === undefined) throw invalidFrame("stream channel is unknown");
  const frame = strictRecord(value, keys);
  assertVersionAndKind(frame, "stream_event");
  assertIdentifier(frame.requestId, "requestId");
  assertIdentifier(frame.streamId, "streamId");
  assertRouteIdentity(frame);
  if (!Number.isSafeInteger(frame.sequence) || (frame.sequence as number) < 1) {
    throw invalidFrame("sequence must be a positive safe integer");
  }
  if (channel === "process_stdout" || channel === "process_stderr" || channel === "forward_data"
    || channel === "reverse_forward_data") {
    if (!(frame.data instanceof Uint8Array)) throw invalidFrame("binary stream data must be Uint8Array");
  } else if (channel === "terminal_data") {
    if (typeof frame.data !== "string") throw invalidFrame("terminal data must be a string");
  } else if (channel === "process_exit") {
    if (!(frame.exitCode === null || Number.isSafeInteger(frame.exitCode))) throw invalidFrame("exitCode is invalid");
    if (!(frame.signal === null || typeof frame.signal === "string")) throw invalidFrame("signal is invalid");
  } else if (channel === "terminal_exit") {
    if (!Number.isSafeInteger(frame.exitCode)) throw invalidFrame("exitCode is invalid");
    if (!(frame.signal === null || Number.isSafeInteger(frame.signal))) throw invalidFrame("signal is invalid");
    if (!(frame.failureCode === null || typeof frame.failureCode === "string")) {
      throw invalidFrame("failureCode is invalid");
    }
    if (typeof frame.processExitConfirmed !== "boolean") throw invalidFrame("processExitConfirmed is invalid");
  } else if (channel !== "reverse_forward_open"
    && !(frame.errorCode === null || typeof frame.errorCode === "string")) {
    throw invalidFrame("errorCode is invalid");
  }
}

export function assertRouteIdentity(value: Record<string, unknown>): void {
  assertIdentifier(value.targetDeviceId, "targetDeviceId");
  if (!Number.isSafeInteger(value.routeGeneration) || (value.routeGeneration as number) < 1) {
    throw invalidFrame("routeGeneration must be a positive safe integer");
  }
}

function assertVersionAndKind(frame: Record<string, unknown>, kind: string): void {
  if (frame.protocolVersion !== DEVICE_PEER_PROTOCOL_VERSION || frame.kind !== kind) {
    throw invalidFrame(`expected current-v1 ${kind} frame`);
  }
}

function strictRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw invalidFrame("frame must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidFrame("frame fields do not match the current-v1 shape");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapability(value: unknown): value is DevicePeerCapability {
  return value === "files" || value === "process" || value === "terminal" || value === "forwarding";
}

function assertIdentifier(value: unknown, name: string, maximumLength = 256): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidFrame(`${name} is invalid`);
  }
}

function invalidFrame(message: string): DevicePeerProtocolError {
  return new DevicePeerProtocolError("invalid_frame", message);
}
