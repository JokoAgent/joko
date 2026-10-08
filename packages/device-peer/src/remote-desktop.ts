import {
  isRemoteDesktopAttemptId,
  isRemoteDesktopIceCursor,
  parseRemoteDesktopIceCandidates,
  type RemoteDesktopIceRequest
} from "./remote-desktop-ice.js";

export const REMOTE_DESKTOP_PROTOCOL_VERSION = 1 as const;
export const REMOTE_DESKTOP_LEASE_MS = 12_000;
export const REMOTE_DESKTOP_HEARTBEAT_MS = 3_000;
export const REMOTE_DESKTOP_MAX_FRAME_BYTES = 180_000;
export const REMOTE_DESKTOP_MAX_FRAME_DIMENSION = 1_280;
export const REMOTE_DESKTOP_MAX_DISPLAY_DIMENSION = 32_768;
export const REMOTE_DESKTOP_MAX_DISPLAYS = 32;
export const REMOTE_DESKTOP_FRAME_INTERVAL_MS = 250;

export type RemoteDesktopInput =
  | { readonly kind: "move"; readonly x: number; readonly y: number }
  | {
      readonly kind: "button";
      readonly button: 0 | 1 | 2;
      readonly down: boolean;
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: "scroll"; readonly dx: number; readonly dy: number }
  | { readonly kind: "key"; readonly code: RemoteDesktopKeyCode; readonly down: boolean }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "release" };

export const REMOTE_DESKTOP_KEY_CODES = Object.freeze([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((key) => `Key${key}`),
  ..."0123456789".split("").map((key) => `Digit${key}`),
  ...Array.from({ length: 12 }, (_value, index) => `F${index + 1}`),
  "Enter", "Escape", "Tab", "Space", "Backspace", "Delete", "Insert", "Home", "End",
  "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft",
  "ControlLeft", "AltLeft", "MetaLeft", "Minus", "Equal", "BracketLeft", "BracketRight",
  "Backslash", "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash"
] as const);

export type RemoteDesktopKeyCode = (typeof REMOTE_DESKTOP_KEY_CODES)[number];
const REMOTE_DESKTOP_KEY_CODE_SET = new Set<string>(REMOTE_DESKTOP_KEY_CODES);

export type RemoteDesktopPlatform = "darwin" | "win32" | "linux";
export type RemoteDesktopPermission = "screenRecording" | "accessibility";
export type RemoteDesktopPermissionStatus = "granted" | "missing" | "unknown" | "notRequired";

export interface RemoteDesktopPermissions {
  readonly screenRecording: RemoteDesktopPermissionStatus;
  readonly accessibility: RemoteDesktopPermissionStatus;
}

export interface RemoteDesktopDisplay {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export interface RemoteDesktopCapabilities {
  readonly version: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
  readonly enabled: boolean;
  readonly canControl: boolean;
  readonly platform: RemoteDesktopPlatform;
  readonly displays: readonly RemoteDesktopDisplay[];
  readonly permissions: RemoteDesktopPermissions;
  readonly automaticReconnect: boolean;
  readonly connectionTakeover: boolean;
  readonly webrtcVideo: boolean;
  readonly trickleIce: boolean;
  readonly jpegFallback: boolean;
}

export type RemoteDesktopHostCapabilities = Omit<
  RemoteDesktopCapabilities,
  | "automaticReconnect"
  | "connectionTakeover"
  | "webrtcVideo"
  | "trickleIce"
  | "jpegFallback"
>;

export interface RemoteDesktopLease {
  readonly lease: string;
  readonly display: RemoteDesktopDisplay;
  readonly controlling: boolean;
}

/** Capture-adapter result. Dimensions are checked before pixels may leave the host. */
export interface RemoteDesktopJpegFrame {
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
}

export type RemoteDesktopRequest =
  | RemoteDesktopIceRequest
  | { readonly op: "capabilities" }
  | { readonly op: "permissions"; readonly action: "check" | "guide" }
  | { readonly op: "start"; readonly displayId: string; readonly resume?: boolean; readonly takeover?: boolean }
  | { readonly op: "heartbeat"; readonly lease: string }
  | { readonly op: "stop"; readonly lease: string }
  | { readonly op: "frame"; readonly lease: string }
  | { readonly op: "control"; readonly lease: string; readonly enabled: boolean }
  | {
      readonly op: "input";
      readonly lease: string;
      readonly sequence: number;
      readonly events: readonly RemoteDesktopInput[];
    }
  | { readonly op: "offer"; readonly lease: string; readonly sdp: string; readonly attemptId: string };

export function isRemoteDesktopPermission(value: unknown): value is RemoteDesktopPermission {
  return value === "screenRecording" || value === "accessibility";
}

export function remoteDesktopPermissionReady(status: RemoteDesktopPermissionStatus): boolean {
  return status === "granted" || status === "notRequired";
}

/** Sanitizes the trusted native permission adapter before it reaches a route. */
export function parseRemoteDesktopPermissions(value: unknown): RemoteDesktopPermissions {
  if (!isRecord(value)
    || !permissionStatus(value.screenRecording)
    || !permissionStatus(value.accessibility)) {
    throw new Error("INVALID_REMOTE_DESKTOP_CAPABILITIES");
  }
  return Object.freeze({
    screenRecording: value.screenRecording,
    accessibility: value.accessibility
  });
}

/** Keeps excluded or future host flags from becoming portable v1 capabilities. */
export function parseRemoteDesktopHostCapabilities(value: unknown): RemoteDesktopHostCapabilities {
  if (!isRecord(value)
    || value.version !== REMOTE_DESKTOP_PROTOCOL_VERSION
    || typeof value.enabled !== "boolean"
    || typeof value.canControl !== "boolean"
    || (value.platform !== "darwin" && value.platform !== "win32" && value.platform !== "linux")
    || !Array.isArray(value.displays)
    || value.displays.length > REMOTE_DESKTOP_MAX_DISPLAYS
    || (value.enabled && value.displays.length === 0)
    || value.permissions === undefined) {
    throw new Error("INVALID_REMOTE_DESKTOP_CAPABILITIES");
  }
  const displays = value.displays.map(parseRemoteDesktopDisplay);
  if (new Set(displays.map((display) => display.id)).size !== displays.length) {
    throw new Error("INVALID_REMOTE_DESKTOP_CAPABILITIES");
  }
  return Object.freeze({
    version: REMOTE_DESKTOP_PROTOCOL_VERSION,
    enabled: value.enabled,
    canControl: value.canControl,
    platform: value.platform,
    displays: Object.freeze(displays),
    permissions: parseRemoteDesktopPermissions(value.permissions)
  });
}

export function isRemoteDesktopInput(value: unknown): value is RemoteDesktopInput {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "release":
      return hasExactKeys(value, ["kind"]);
    case "move":
      return hasExactKeys(value, ["kind", "x", "y"]) && unit(value.x) && unit(value.y);
    case "button":
      return hasExactKeys(value, ["kind", "button", "down", "x", "y"])
        && unit(value.x)
        && unit(value.y)
        && (value.button === 0 || value.button === 1 || value.button === 2)
        && typeof value.down === "boolean";
    case "scroll":
      return hasExactKeys(value, ["kind", "dx", "dy"]) && delta(value.dx) && delta(value.dy);
    case "key":
      return hasExactKeys(value, ["kind", "code", "down"])
        && typeof value.code === "string"
        && REMOTE_DESKTOP_KEY_CODE_SET.has(value.code)
        && typeof value.down === "boolean";
    case "text":
      return hasExactKeys(value, ["kind", "text"])
        && typeof value.text === "string"
        && value.text.length <= 4_096;
    default:
      return false;
  }
}

export function parseRemoteDesktopRequest(value: unknown): RemoteDesktopRequest {
  if (!isRecord(value) || typeof value.op !== "string") throw new Error("INVALID_REMOTE_DESKTOP_REQUEST");
  switch (value.op) {
    case "capabilities":
      requireExactKeys(value, ["op"]);
      return Object.freeze({ op: "capabilities" });
    case "permissions":
      requireExactKeys(value, ["op", "action"]);
      if (value.action !== "check" && value.action !== "guide") throw new Error("INVALID_REMOTE_DESKTOP_REQUEST");
      return Object.freeze({ op: "permissions", action: value.action });
    case "start": {
      requireExactKeys(value, ["op", "displayId"], ["resume", "takeover"]);
      if (!boundedIdentifier(value.displayId)
        || (value.resume !== undefined && typeof value.resume !== "boolean")
        || (value.takeover !== undefined && typeof value.takeover !== "boolean")
        || (value.resume === true && value.takeover === true)) {
        throw new Error("INVALID_REMOTE_DESKTOP_REQUEST");
      }
      return Object.freeze({
        op: "start",
        displayId: value.displayId,
        ...(value.resume === true ? { resume: true } : {}),
        ...(value.takeover === true ? { takeover: true } : {})
      });
    }
    default:
      break;
  }
  if (!boundedIdentifier(value.lease)) throw new Error("INVALID_REMOTE_DESKTOP_LEASE");
  const lease = value.lease;
  switch (value.op) {
    case "heartbeat":
    case "stop":
    case "frame":
      requireExactKeys(value, ["op", "lease"]);
      return Object.freeze({ op: value.op, lease });
    case "control":
      requireExactKeys(value, ["op", "lease", "enabled"]);
      if (typeof value.enabled !== "boolean") throw new Error("INVALID_REMOTE_DESKTOP_REQUEST");
      return Object.freeze({ op: "control", lease, enabled: value.enabled });
    case "input": {
      requireExactKeys(value, ["op", "lease", "sequence", "events"]);
      if (!Number.isSafeInteger(value.sequence)
        || (value.sequence as number) < 1
        || !Array.isArray(value.events)
        || value.events.length < 1
        || value.events.length > 64
        || !value.events.every(isRemoteDesktopInput)
        || JSON.stringify(value.events).length > 16_384) {
        throw new Error("INVALID_REMOTE_DESKTOP_REQUEST");
      }
      return Object.freeze({
        op: "input",
        lease,
        sequence: value.sequence as number,
        events: Object.freeze(value.events.map((event) => Object.freeze({ ...event })))
      });
    }
    case "offer":
      requireExactKeys(value, ["op", "lease", "sdp", "attemptId"]);
      if (typeof value.sdp !== "string"
        || value.sdp.length < 1
        || value.sdp.length > 64_000
        || !isRemoteDesktopAttemptId(value.attemptId)) {
        throw new Error("INVALID_REMOTE_DESKTOP_REQUEST");
      }
      return Object.freeze({
        op: "offer",
        lease,
        sdp: value.sdp,
        attemptId: value.attemptId
      });
    case "ice":
      requireExactKeys(value, ["op", "lease", "attemptId", "candidates", "after"]);
      if (!isRemoteDesktopAttemptId(value.attemptId) || !isRemoteDesktopIceCursor(value.after)) {
        throw new Error("INVALID_REMOTE_DESKTOP_REQUEST");
      }
      return Object.freeze({
        op: "ice",
        lease,
        attemptId: value.attemptId,
        candidates: parseRemoteDesktopIceCandidates(value.candidates),
        after: value.after
      });
    default:
      throw new Error("INVALID_REMOTE_DESKTOP_REQUEST");
  }
}

export function isBoundedRemoteDesktopJpegFrame(value: unknown): value is RemoteDesktopJpegFrame {
  if (!isRecord(value)
    || !hasExactKeys(value, ["jpeg", "width", "height"])
    || typeof value.jpeg !== "string"
    || !Number.isSafeInteger(value.width)
    || !Number.isSafeInteger(value.height)
    || (value.width as number) < 1
    || (value.height as number) < 1
    || (value.width as number) > REMOTE_DESKTOP_MAX_FRAME_DIMENSION
    || (value.height as number) > REMOTE_DESKTOP_MAX_FRAME_DIMENSION) {
    return false;
  }
  return remoteDesktopBase64Bytes(value.jpeg) <= REMOTE_DESKTOP_MAX_FRAME_BYTES;
}

function parseRemoteDesktopDisplay(value: unknown): RemoteDesktopDisplay {
  if (!isRecord(value)
    || !boundedIdentifier(value.id)
    || typeof value.name !== "string"
    || value.name.length < 1
    || value.name.length > 256
    || !Number.isSafeInteger(value.width)
    || !Number.isSafeInteger(value.height)
    || (value.width as number) < 1
    || (value.height as number) < 1
    || (value.width as number) > REMOTE_DESKTOP_MAX_DISPLAY_DIMENSION
    || (value.height as number) > REMOTE_DESKTOP_MAX_DISPLAY_DIMENSION) {
    throw new Error("INVALID_REMOTE_DESKTOP_CAPABILITIES");
  }
  return Object.freeze({
    id: value.id,
    name: value.name,
    width: value.width as number,
    height: value.height as number
  });
}

function permissionStatus(value: unknown): value is RemoteDesktopPermissionStatus {
  return value === "granted"
    || value === "missing"
    || value === "unknown"
    || value === "notRequired";
}

function remoteDesktopBase64Bytes(value: string): number {
  if (value.length === 0
    || value.length > Math.ceil(REMOTE_DESKTOP_MAX_FRAME_BYTES / 3) * 4
    || value.length % 4 === 1
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return Number.POSITIVE_INFINITY;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function delta(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 2_000;
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || actual.some((key) => !allowed.has(key))) {
    throw new Error("INVALID_REMOTE_DESKTOP_REQUEST");
  }
}
