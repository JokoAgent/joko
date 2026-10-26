import { MOBILE_REMOTE_DESKTOP_KEY_CODES, RTC_NETWORK } from "./remote-desktop-viewer";
import { parseRemoteDesktopChannelReply, parseRemoteDesktopChannelRequest, type RemoteDesktopChannelRequest, type RemoteDesktopChannelReply } from "@joko/contracts";

export interface MobileRemoteDesktopNativeScope {
  readonly epoch: string;
  readonly attemptId: string;
}

export interface MobileRemoteDesktopNativeInputGrant {
  readonly attemptId: string;
  readonly controlGeneration: string;
  readonly sequenceBase: number;
  readonly sequenceLimit: number;
}

export type MobileRemoteDesktopNativeInputEvent =
  | { readonly kind: "move"; readonly x: number; readonly y: number }
  | { readonly kind: "button"; readonly button: 0 | 1 | 2; readonly down: boolean; readonly x: number; readonly y: number }
  | { readonly kind: "scroll"; readonly dx: number; readonly dy: number }
  | { readonly kind: "key"; readonly code: string; readonly down: boolean }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "release" };

export interface MobileRemoteDesktopNativeInputBatch extends MobileRemoteDesktopNativeInputGrant {
  readonly epoch: string;
  readonly sequence: number;
  readonly events: readonly MobileRemoteDesktopNativeInputEvent[];
}

export interface MobileRemoteDesktopNativeViewport {
  readonly type: "nativeViewport";
  readonly epoch: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fillHeight: boolean;
}

export interface MobileRemoteDesktopNativeIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
  readonly usernameFragment: string | null;
}

export interface MobileRemoteDesktopNativeIceServer {
  readonly urls: readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

export interface MobileRemoteDesktopNativeCursor {
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly hotX: number;
  readonly hotY: number;
  readonly png: string;
}

export type MobileRemoteDesktopNativeCommand =
  | { readonly type: "init"; readonly epoch: string; readonly width: number; readonly height: number;
      readonly webrtc: boolean; readonly audio: boolean; readonly trickleIce: boolean; readonly cursorOverlay: boolean;
      readonly sequenceBase: number; readonly sequenceLimit: number; readonly net: typeof RTC_NETWORK;
      readonly iceServers: readonly MobileRemoteDesktopNativeIceServer[] }
  | { readonly type: "stop" | "resume"; readonly epoch: string }
  | { readonly type: "inputAuthority"; readonly epoch: string; readonly grant: MobileRemoteDesktopNativeInputGrant | null }
  | MobileRemoteDesktopNativeViewport
  | (MobileRemoteDesktopNativeScope & { readonly type: "videoSettings"; readonly audio: boolean })
  | (MobileRemoteDesktopNativeScope & { readonly type: "iceConfig"; readonly iceServers: readonly MobileRemoteDesktopNativeIceServer[] })
  | (MobileRemoteDesktopNativeScope & { readonly type: "answer"; readonly sdp: string })
  | (MobileRemoteDesktopNativeScope & { readonly type: "ice"; readonly exchangeId: number; readonly error: true })
  | (MobileRemoteDesktopNativeScope & { readonly type: "ice"; readonly exchangeId: number; readonly error: false;
      readonly candidates: readonly MobileRemoteDesktopNativeIceCandidate[]; readonly next: number; readonly complete: boolean })
  | (MobileRemoteDesktopNativeScope & { readonly type: "fallback"; readonly capturePending: boolean; readonly retry: boolean })
  | (MobileRemoteDesktopNativeScope & { readonly type: "pipPolicy"; readonly enabled: boolean;
      readonly preparing: boolean; readonly authorized: boolean })
  | (MobileRemoteDesktopNativeScope & { readonly type: "presentation"; readonly enabled: boolean })
  | (MobileRemoteDesktopNativeScope & { readonly type: "restorePresentation"; readonly restoreId: number });

export type MobileRemoteDesktopNativeFallbackReason =
  | "setup" | "offer" | "answer" | "candidates" | "candidate-limit" | "transport" | "disconnected"
  | "answer-timeout" | "connect-timeout" | "host" | "background" | "capture-pending";

export type MobileRemoteDesktopNativeEvent = MobileRemoteDesktopNativeScope & (
  | { readonly type: "channelReply"; readonly reply: RemoteDesktopChannelReply }
  | { readonly type: "iceConfig" | "videoFrameReady" | "streaming" | "reconnecting" | "presentationStarting" }
  | { readonly type: "offer"; readonly sdp: string }
  | { readonly type: "ice"; readonly candidates: readonly MobileRemoteDesktopNativeIceCandidate[];
      readonly after: number; readonly exchangeId: number }
  | { readonly type: "fallback"; readonly reason: MobileRemoteDesktopNativeFallbackReason; readonly retry: boolean }
  | { readonly type: "pipCapability"; readonly supported: boolean }
  | { readonly type: "presentation"; readonly active: boolean }
  | { readonly type: "presentationRestore"; readonly restoreId: number; readonly inlineVisible: boolean; readonly sourceHidden: boolean }
  | { readonly type: "presentationFailed"; readonly reason: "not-ready" | "scene-not-active" | "avkit" }
  | { readonly type: "nativeCursor"; readonly cursor: MobileRemoteDesktopNativeCursor | null }
  | { readonly type: "network"; readonly transport: "video" | "direct" | "relay";
      readonly bytesPerSecond: number | null; readonly latencyMs: number | null }
);

export interface MobileRemoteDesktopNativeHandle {
  receive(command: MobileRemoteDesktopNativeCommand): Promise<void>;
  sendInput(batch: MobileRemoteDesktopNativeInputBatch): Promise<boolean>;
  sendRequest?(request: MobileRemoteDesktopNativeScope & { readonly message: RemoteDesktopChannelRequest }): Promise<boolean>;
}

const ATTEMPT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_CODES = new Set<string>(MOBILE_REMOTE_DESKTOP_KEY_CODES);
const FALLBACK_REASONS = new Set<MobileRemoteDesktopNativeFallbackReason>([
  "setup", "offer", "answer", "candidates", "candidate-limit", "transport", "disconnected",
  "answer-timeout", "connect-timeout", "host", "background", "capture-pending"
]);
const COMMANDS = new Set([
  "init", "stop", "resume", "inputAuthority", "nativeViewport", "videoSettings", "iceConfig",
  "answer", "ice", "fallback", "pipPolicy", "presentation", "restorePresentation"
]);

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function safe(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function unit(value: unknown): value is number { return finite(value) && value >= 0 && value <= 1; }
function epoch(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 256; }
function attempt(value: unknown): value is string { return typeof value === "string" && ATTEMPT.test(value); }
function text(value: unknown, maximum: number, minimum = 0): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}
function uint64(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value)
    && BigInt(value) <= 18_446_744_073_709_551_615n;
}
function sequenceBlock(value: RecordValue): boolean {
  return safe(value.sequenceBase) && safe(value.sequenceLimit, 1) && value.sequenceLimit > value.sequenceBase;
}
function scope(value: RecordValue): value is RecordValue & MobileRemoteDesktopNativeScope {
  return epoch(value.epoch) && attempt(value.attemptId);
}
function sdp(value: unknown): value is string {
  return text(value, 64_000, 1) && utf8Bytes(value) <= 64_000;
}
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
function network(value: unknown): value is typeof RTC_NETWORK {
  if (!record(value) || !keys(value, Object.keys(RTC_NETWORK))) return false;
  return Object.entries(RTC_NETWORK).every(([key, expected]) => Array.isArray(expected)
    ? Array.isArray(value[key]) && value[key].length === expected.length
      && value[key].every((item, index) => item === expected[index])
    : value[key] === expected);
}

function grant(value: unknown): MobileRemoteDesktopNativeInputGrant | undefined {
  if (!record(value) || !keys(value, ["attemptId", "controlGeneration", "sequenceBase", "sequenceLimit"])
    || !attempt(value.attemptId) || !uint64(value.controlGeneration) || !sequenceBlock(value)) return undefined;
  return Object.freeze({ attemptId: value.attemptId, controlGeneration: value.controlGeneration,
    sequenceBase: value.sequenceBase as number, sequenceLimit: value.sequenceLimit as number });
}

function iceCandidate(value: unknown): MobileRemoteDesktopNativeIceCandidate | undefined {
  if (!record(value) || !keys(value, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])
    || !text(value.candidate, 2_048, 1) || !value.candidate.startsWith("candidate:")
    || utf8Bytes(value.candidate) > 2_048 || !(value.sdpMid === null || text(value.sdpMid, 128))
    || !(value.sdpMLineIndex === null || safe(value.sdpMLineIndex, 0, 31))
    || (value.sdpMid === null && value.sdpMLineIndex === null)
    || !(value.usernameFragment === null || text(value.usernameFragment, 256))) return undefined;
  return Object.freeze({ candidate: value.candidate, sdpMid: value.sdpMid as string | null,
    sdpMLineIndex: value.sdpMLineIndex as number | null, usernameFragment: value.usernameFragment as string | null });
}
function iceCandidates(value: unknown): readonly MobileRemoteDesktopNativeIceCandidate[] | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const result = value.map(iceCandidate);
  return result.every(item => item !== undefined) ? Object.freeze(result) : undefined;
}
function iceServers(value: unknown): readonly MobileRemoteDesktopNativeIceServer[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return undefined;
  const result: MobileRemoteDesktopNativeIceServer[] = [];
  for (const item of value) {
    if (!record(item) || !keys(item, ["urls"], ["username", "credential"])
      || !Array.isArray(item.urls) || item.urls.length < 1 || item.urls.length > 4
      || !item.urls.every(url => typeof url === "string" && /^(?:stun|turn|turns):[^\s]{1,500}$/u.test(url))) return undefined;
    const urls = Object.freeze([...(item.urls as string[])]);
    const turn = urls.some(url => /^turns?:/u.test(url));
    if (turn) {
      if (!text(item.username, 256, 1) || !text(item.credential, 256, 1)) return undefined;
      result.push(Object.freeze({ urls, username: item.username, credential: item.credential }));
    } else {
      if (Object.hasOwn(item, "username") || Object.hasOwn(item, "credential")) return undefined;
      result.push(Object.freeze({ urls }));
    }
  }
  return Object.freeze(result);
}

export function parseMobileRemoteDesktopNativeViewport(raw: unknown): MobileRemoteDesktopNativeViewport | undefined {
  if (!record(raw) || !keys(raw, ["type", "epoch", "x", "y", "width", "height", "fillHeight"])
    || raw.type !== "nativeViewport" || !epoch(raw.epoch) || !finite(raw.x) || !finite(raw.y)
    || !finite(raw.width) || raw.width <= 0 || !finite(raw.height) || raw.height <= 0
    || typeof raw.fillHeight !== "boolean") return undefined;
  return Object.freeze({ type: "nativeViewport", epoch: raw.epoch, x: raw.x, y: raw.y,
    width: raw.width, height: raw.height, fillHeight: raw.fillHeight });
}

export function parseMobileRemoteDesktopNativeCommand(raw: unknown): MobileRemoteDesktopNativeCommand | undefined {
  if (!record(raw) || typeof raw.type !== "string" || !epoch(raw.epoch)) return undefined;
  const base = { epoch: raw.epoch };
  if (raw.type === "init") {
    const servers = iceServers(raw.iceServers);
    if (!keys(raw, ["type", "epoch", "width", "height", "webrtc", "audio", "trickleIce", "cursorOverlay",
      "sequenceBase", "sequenceLimit", "net", "iceServers"]) || !safe(raw.width, 1, 32_768)
      || !safe(raw.height, 1, 32_768) || typeof raw.webrtc !== "boolean" || typeof raw.audio !== "boolean"
      || typeof raw.trickleIce !== "boolean" || typeof raw.cursorOverlay !== "boolean"
      || !sequenceBlock(raw) || !network(raw.net) || !servers) return undefined;
    return Object.freeze({ type: "init", ...base, width: raw.width, height: raw.height, webrtc: raw.webrtc,
      audio: raw.audio, trickleIce: raw.trickleIce, cursorOverlay: raw.cursorOverlay,
      sequenceBase: raw.sequenceBase as number, sequenceLimit: raw.sequenceLimit as number,
      net: RTC_NETWORK, iceServers: servers });
  }
  if ((raw.type === "stop" || raw.type === "resume") && keys(raw, ["type", "epoch"])) {
    return Object.freeze({ type: raw.type, ...base });
  }
  if (raw.type === "inputAuthority" && keys(raw, ["type", "epoch", "grant"])) {
    const parsed = raw.grant === null ? null : grant(raw.grant);
    return parsed !== undefined ? Object.freeze({ type: "inputAuthority", ...base, grant: parsed }) : undefined;
  }
  if (raw.type === "nativeViewport") return parseMobileRemoteDesktopNativeViewport(raw);
  if (!scope(raw)) return undefined;
  const owned = { ...base, attemptId: raw.attemptId };
  if (raw.type === "videoSettings" && keys(raw, ["type", "epoch", "attemptId", "audio"])
    && typeof raw.audio === "boolean") return Object.freeze({ type: "videoSettings", ...owned, audio: raw.audio });
  if (raw.type === "iceConfig" && keys(raw, ["type", "epoch", "attemptId", "iceServers"])) {
    const servers = iceServers(raw.iceServers);
    return servers ? Object.freeze({ type: "iceConfig", ...owned, iceServers: servers }) : undefined;
  }
  if (raw.type === "answer" && keys(raw, ["type", "epoch", "attemptId", "sdp"]) && sdp(raw.sdp)) {
    return Object.freeze({ type: "answer", ...owned, sdp: raw.sdp });
  }
  if (raw.type === "ice" && safe(raw.exchangeId, 1)) {
    if (raw.error === true && keys(raw, ["type", "epoch", "attemptId", "exchangeId", "error"])) {
      return Object.freeze({ type: "ice", ...owned, exchangeId: raw.exchangeId, error: true });
    }
    const candidates = iceCandidates(raw.candidates);
    if (raw.error === false && keys(raw, ["type", "epoch", "attemptId", "exchangeId", "error", "candidates", "next", "complete"])
      && candidates && safe(raw.next, 0, RTC_NETWORK.maxCandidates) && typeof raw.complete === "boolean") {
      return Object.freeze({ type: "ice", ...owned, exchangeId: raw.exchangeId, error: false,
        candidates, next: raw.next, complete: raw.complete });
    }
  }
  if (raw.type === "fallback" && keys(raw, ["type", "epoch", "attemptId", "capturePending", "retry"])
    && typeof raw.capturePending === "boolean" && typeof raw.retry === "boolean") {
    return Object.freeze({ type: "fallback", ...owned, capturePending: raw.capturePending, retry: raw.retry });
  }
  if (raw.type === "pipPolicy" && keys(raw, ["type", "epoch", "attemptId", "enabled", "preparing", "authorized"])
    && typeof raw.enabled === "boolean" && typeof raw.preparing === "boolean" && typeof raw.authorized === "boolean") {
    return Object.freeze({ type: "pipPolicy", ...owned, enabled: raw.enabled, preparing: raw.preparing, authorized: raw.authorized });
  }
  if (raw.type === "presentation" && keys(raw, ["type", "epoch", "attemptId", "enabled"]) && typeof raw.enabled === "boolean") {
    return Object.freeze({ type: "presentation", ...owned, enabled: raw.enabled });
  }
  if (raw.type === "restorePresentation" && keys(raw, ["type", "epoch", "attemptId", "restoreId"]) && safe(raw.restoreId, 1)) {
    return Object.freeze({ type: "restorePresentation", ...owned, restoreId: raw.restoreId });
  }
  return undefined;
}

function inputEvents(value: unknown): readonly MobileRemoteDesktopNativeInputEvent[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return undefined;
  try { if (JSON.stringify(value).length > 16_384) return undefined; } catch { return undefined; }
  const result: MobileRemoteDesktopNativeInputEvent[] = [];
  for (const item of value) {
    if (!record(item)) return undefined;
    if (item.kind === "move" && keys(item, ["kind", "x", "y"]) && unit(item.x) && unit(item.y)) {
      result.push(Object.freeze({ kind: "move", x: item.x, y: item.y }));
    } else if (item.kind === "button" && keys(item, ["kind", "button", "down", "x", "y"])
      && safe(item.button, 0, 2) && typeof item.down === "boolean" && unit(item.x) && unit(item.y)) {
      result.push(Object.freeze({ kind: "button", button: item.button as 0 | 1 | 2, down: item.down, x: item.x, y: item.y }));
    } else if (item.kind === "scroll" && keys(item, ["kind", "dx", "dy"])
      && finite(item.dx) && Math.abs(item.dx) <= 2_000 && finite(item.dy) && Math.abs(item.dy) <= 2_000) {
      result.push(Object.freeze({ kind: "scroll", dx: item.dx, dy: item.dy }));
    } else if (item.kind === "key" && keys(item, ["kind", "code", "down"])
      && typeof item.code === "string" && KEY_CODES.has(item.code) && typeof item.down === "boolean") {
      result.push(Object.freeze({ kind: "key", code: item.code, down: item.down }));
    } else if (item.kind === "text" && keys(item, ["kind", "text"]) && text(item.text, 4_096, 1)) {
      result.push(Object.freeze({ kind: "text", text: item.text }));
    } else if (item.kind === "release" && keys(item, ["kind"])) result.push(Object.freeze({ kind: "release" }));
    else return undefined;
  }
  return Object.freeze(result);
}

export function parseMobileRemoteDesktopNativeInputBatch(raw: unknown): MobileRemoteDesktopNativeInputBatch | undefined {
  if (!record(raw) || !keys(raw, ["epoch", "attemptId", "controlGeneration", "sequenceBase", "sequenceLimit", "sequence", "events"])
    || !scope(raw) || !uint64(raw.controlGeneration) || !sequenceBlock(raw) || !safe(raw.sequence, 1)
    || raw.sequence <= (raw.sequenceBase as number) || raw.sequence > (raw.sequenceLimit as number)) return undefined;
  const events = inputEvents(raw.events);
  if (!events) return undefined;
  const wire = JSON.stringify({ sequence: raw.sequence, events });
  if (utf8Bytes(wire) > 32_768) return undefined;
  return Object.freeze({ epoch: raw.epoch, attemptId: raw.attemptId, controlGeneration: raw.controlGeneration,
    sequenceBase: raw.sequenceBase as number, sequenceLimit: raw.sequenceLimit as number, sequence: raw.sequence, events });
}

function cursor(raw: unknown): MobileRemoteDesktopNativeCursor | null | undefined {
  if (raw === null) return null;
  if (!record(raw) || !keys(raw, ["visible", "x", "y", "width", "height", "hotX", "hotY", "png"])
    || typeof raw.visible !== "boolean" || !unit(raw.x) || !unit(raw.y)
    || !finite(raw.width) || raw.width <= 0 || raw.width > 256 || !finite(raw.height) || raw.height <= 0 || raw.height > 256
    || !finite(raw.hotX) || raw.hotX < 0 || raw.hotX > raw.width
    || !finite(raw.hotY) || raw.hotY < 0 || raw.hotY > raw.height || !text(raw.png, 65_536, 1)
    || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u.test(raw.png)) return undefined;
  let bytes: string;
  try { bytes = atob(raw.png); if (btoa(bytes) !== raw.png) return undefined; } catch { return undefined; }
  if (bytes.length < 33 || bytes.length > 49_152 || bytes.charCodeAt(8) !== 0 || bytes.charCodeAt(9) !== 0
    || bytes.charCodeAt(10) !== 0 || bytes.charCodeAt(11) !== 13 || bytes.slice(12, 16) !== "IHDR") return undefined;
  const dimension = (offset: number) => bytes.charCodeAt(offset) * 0x1000000 + bytes.charCodeAt(offset + 1) * 0x10000
    + bytes.charCodeAt(offset + 2) * 0x100 + bytes.charCodeAt(offset + 3);
  if (!safe(dimension(16), 1, 512) || !safe(dimension(20), 1, 512)) return undefined;
  return Object.freeze({ visible: raw.visible, x: raw.x, y: raw.y, width: raw.width, height: raw.height,
    hotX: raw.hotX, hotY: raw.hotY, png: raw.png });
}

/** Expo native events have their own entry point; HTML cannot supply a native frame or PiP receipt. */
export function parseMobileRemoteDesktopNativeEvent(raw: unknown): MobileRemoteDesktopNativeEvent | undefined {
  if (typeof raw !== "string" || raw.length > 100_000) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!record(value) || typeof value.type !== "string" || !scope(value)) return undefined;
  const owned = { epoch: value.epoch, attemptId: value.attemptId };
  if (value.type === "channelReply" && keys(value, ["type", "epoch", "attemptId", "reply"])) {
    const reply = parseRemoteDesktopChannelReply(value.reply);
    if (reply) return { ...owned, type: "channelReply", reply };
  }
  if (["iceConfig", "videoFrameReady", "streaming", "reconnecting", "presentationStarting"].includes(value.type)
    && keys(value, ["type", "epoch", "attemptId"])) {
    return Object.freeze({ ...owned, type: value.type as "iceConfig" | "videoFrameReady" | "streaming" | "reconnecting" | "presentationStarting" });
  }
  if (value.type === "offer" && keys(value, ["type", "epoch", "attemptId", "sdp"]) && sdp(value.sdp)) {
    return Object.freeze({ ...owned, type: "offer", sdp: value.sdp });
  }
  if (value.type === "ice" && keys(value, ["type", "epoch", "attemptId", "candidates", "after", "exchangeId"])
    && safe(value.after, 0, RTC_NETWORK.maxCandidates) && safe(value.exchangeId, 1)) {
    const candidates = iceCandidates(value.candidates);
    if (candidates) return Object.freeze({ ...owned, type: "ice", candidates, after: value.after, exchangeId: value.exchangeId });
  }
  if (value.type === "fallback" && keys(value, ["type", "epoch", "attemptId", "reason", "retry"])
    && FALLBACK_REASONS.has(value.reason as MobileRemoteDesktopNativeFallbackReason) && typeof value.retry === "boolean") {
    return Object.freeze({ ...owned, type: "fallback", reason: value.reason as MobileRemoteDesktopNativeFallbackReason, retry: value.retry });
  }
  if (value.type === "pipCapability" && keys(value, ["type", "epoch", "attemptId", "supported"]) && typeof value.supported === "boolean") {
    return Object.freeze({ ...owned, type: "pipCapability", supported: value.supported });
  }
  if (value.type === "presentation" && keys(value, ["type", "epoch", "attemptId", "active"]) && typeof value.active === "boolean") {
    return Object.freeze({ ...owned, type: "presentation", active: value.active });
  }
  if (value.type === "presentationRestore" && keys(value, ["type", "epoch", "attemptId", "restoreId", "inlineVisible", "sourceHidden"])
    && safe(value.restoreId, 1) && typeof value.inlineVisible === "boolean" && typeof value.sourceHidden === "boolean") {
    return Object.freeze({ ...owned, type: "presentationRestore", restoreId: value.restoreId,
      inlineVisible: value.inlineVisible, sourceHidden: value.sourceHidden });
  }
  if (value.type === "presentationFailed" && keys(value, ["type", "epoch", "attemptId", "reason"])
    && (value.reason === "not-ready" || value.reason === "scene-not-active" || value.reason === "avkit")) {
    return Object.freeze({ ...owned, type: "presentationFailed", reason: value.reason });
  }
  if (value.type === "nativeCursor" && keys(value, ["type", "epoch", "attemptId", "cursor"])) {
    const parsed = cursor(value.cursor);
    if (parsed !== undefined) return Object.freeze({ ...owned, type: "nativeCursor", cursor: parsed });
  }
  if (value.type === "network" && keys(value, ["type", "epoch", "attemptId", "transport", "bytesPerSecond", "latencyMs"])
    && (value.transport === "video" || value.transport === "direct" || value.transport === "relay")
    && (value.bytesPerSecond === null || (finite(value.bytesPerSecond) && value.bytesPerSecond >= 0))
    && (value.latencyMs === null || (finite(value.latencyMs) && value.latencyMs >= 0))) {
    return Object.freeze({ ...owned, type: "network", transport: value.transport,
      bytesPerSecond: value.bytesPerSecond, latencyMs: value.latencyMs });
  }
  return undefined;
}

export class MobileRemoteDesktopNativeBridgeError extends Error {
  constructor(readonly code: "invalid-command" | "unavailable" | "command-failed" | "invalid-input" | "input-failed",
    readonly epoch?: string, readonly attemptId?: string) {
    super("Remote Desktop native bridge unavailable.");
  }
}

/** Dispatch against the captured handle and original scope, never a replacement ref. */
export async function dispatchMobileRemoteDesktopNativeCommand(
  handle: MobileRemoteDesktopNativeHandle | null, raw: unknown
): Promise<boolean> {
  if (!record(raw) || typeof raw.type !== "string" || !COMMANDS.has(raw.type)) return false;
  let input = raw;
  if (raw.type === "init" && Object.hasOwn(raw, "nativeVideo") && typeof raw.nativeVideo === "boolean") {
    const { nativeVideo: _nativeVideo, ...native } = raw;
    input = native;
  }
  const command = parseMobileRemoteDesktopNativeCommand(input);
  const originalEpoch = epoch(raw.epoch) ? raw.epoch : undefined;
  const originalAttempt = attempt(raw.attemptId) ? raw.attemptId : undefined;
  if (!command) throw new MobileRemoteDesktopNativeBridgeError("invalid-command", originalEpoch, originalAttempt);
  if (!handle) throw new MobileRemoteDesktopNativeBridgeError("unavailable", originalEpoch, originalAttempt);
  try { await handle.receive(command); }
  catch { throw new MobileRemoteDesktopNativeBridgeError("command-failed", originalEpoch, originalAttempt); }
  return true;
}

/** A thrown/invalid receipt has unknown effect status and must never trigger an RPC replay. */
export async function sendMobileRemoteDesktopNativeInput(
  handle: MobileRemoteDesktopNativeHandle, raw: unknown
): Promise<boolean> {
  const batch = parseMobileRemoteDesktopNativeInputBatch(raw);
  if (!batch) throw new MobileRemoteDesktopNativeBridgeError("invalid-input");
  let sent: unknown;
  try { sent = await handle.sendInput(batch); }
  catch { throw new MobileRemoteDesktopNativeBridgeError("input-failed", batch.epoch, batch.attemptId); }
  if (typeof sent !== "boolean") throw new MobileRemoteDesktopNativeBridgeError("input-failed", batch.epoch, batch.attemptId);
  return sent;
}

export async function sendMobileRemoteDesktopNativeRequest(handle: MobileRemoteDesktopNativeHandle, raw: unknown): Promise<boolean> {
  if (!record(raw) || !scope(raw) || !keys(raw, ["epoch", "attemptId", "message"]) || !parseRemoteDesktopChannelRequest(raw.message)) {
    throw new MobileRemoteDesktopNativeBridgeError("invalid-input");
  }
  if (!handle.sendRequest) return false;
  const sent = await handle.sendRequest({ epoch: raw.epoch, attemptId: raw.attemptId, message: raw.message as RemoteDesktopChannelRequest });
  if (typeof sent !== "boolean") throw new MobileRemoteDesktopNativeBridgeError("input-failed", raw.epoch, raw.attemptId);
  return sent;
}
