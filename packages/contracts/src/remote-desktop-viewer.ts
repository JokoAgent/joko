import type { RemoteDesktopFailureReason } from "./gen/joko/v1/remote_desktop_types_pb.js";

/** Process-local Desktop window contract. Every RPC body uses its generated schema. */
export interface DesktopRemoteDesktopViewerOwner {
  readonly profileId: string;
  readonly serverId: string;
  readonly deviceId: string;
  readonly origin: string;
  readonly connectionGeneration: number;
}

export interface DesktopRemoteDesktopViewerState {
  readonly generation: number;
  readonly active: boolean;
  readonly target: { readonly deviceId: string; readonly name: string } | null;
  readonly locale: "en" | "zh-CN" | "en-XA";
  readonly audio: boolean;
  readonly hostMute: boolean;
  readonly lockOnExit: boolean;
  readonly clipboardSync: boolean;
  readonly privacyScreen: boolean;
  readonly clipboardSyncState: DesktopRemoteDesktopViewerClipboardSyncState;
}

export interface DesktopRemoteDesktopViewerClipboardSyncState {
  readonly available: boolean;
  readonly active: boolean;
  readonly pending: boolean;
  readonly notice?: "permission" | "conflict" | "temporary" | "skipped" | "unknown";
}

export type DesktopRemoteDesktopViewerCredentialAction = "settings" | "enable" | "disable" | "unlock" | "biometric";
export interface DesktopRemoteDesktopViewerCredentialState {
  readonly available: boolean;
  readonly autoUnlock: boolean;
  readonly biometricVerification: boolean;
  readonly biometricAvailable: boolean;
}
export type DesktopRemoteDesktopViewerCredentialNotice =
  | "cancelled" | "unavailable" | "signing" | "password" | "identity" | "permission" | "expired" | "busy";
export type DesktopRemoteDesktopViewerCredentialReply =
  | { readonly ok: true; readonly state: DesktopRemoteDesktopViewerCredentialState; readonly authenticated: boolean }
  | { readonly ok: false; readonly notice: DesktopRemoteDesktopViewerCredentialNotice };

export type DesktopRemoteDesktopViewerReply =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: number; readonly reason: RemoteDesktopFailureReason };

export type DesktopRemoteDesktopViewerPreferencePatch =
  | { readonly audio: boolean; readonly hostMute?: never; readonly lockOnExit?: never; readonly clipboardSync?: never; readonly privacyScreen?: never }
  | { readonly hostMute: boolean; readonly audio?: never; readonly lockOnExit?: never; readonly clipboardSync?: never; readonly privacyScreen?: never }
  | { readonly lockOnExit: boolean; readonly audio?: never; readonly hostMute?: never; readonly clipboardSync?: never; readonly privacyScreen?: never }
  | { readonly clipboardSync: boolean; readonly audio?: never; readonly hostMute?: never; readonly lockOnExit?: never; readonly privacyScreen?: never }
  | { readonly privacyScreen: boolean; readonly audio?: never; readonly hostMute?: never; readonly lockOnExit?: never; readonly clipboardSync?: never };

export interface DesktopRemoteDesktopViewerApi {
  readonly platform: string;
  state(): Promise<DesktopRemoteDesktopViewerState>;
  ready(generation: number): Promise<void>;
  inputFocus(generation: number, focused: boolean): Promise<void>;
  request(generation: number, method: string, bytes: Uint8Array): Promise<DesktopRemoteDesktopViewerReply>;
  clipboard(generation: number, action: "copy" | "paste"): Promise<void>;
  retryClipboardSync(generation: number): Promise<void>;
  credential(generation: number, action: DesktopRemoteDesktopViewerCredentialAction,
    enabled?: boolean): Promise<DesktopRemoteDesktopViewerCredentialReply>;
  close(generation: number): Promise<void>;
  minimize(): Promise<void>;
  fullscreen(): Promise<boolean>;
  resize(generation: number, width: number, height: number): Promise<void>;
  preferences(generation: number, patch?: DesktopRemoteDesktopViewerPreferencePatch): Promise<{ readonly audio: boolean; readonly hostMute: boolean; readonly lockOnExit: boolean; readonly clipboardSync: boolean; readonly privacyScreen: boolean }>;
  onState(listener: (state: DesktopRemoteDesktopViewerState) => void): () => void;
  onCloseRequested(listener: (generation: number) => void): () => void;
}

export function sameDesktopRemoteDesktopViewerOwner(
  left: DesktopRemoteDesktopViewerOwner | undefined,
  right: DesktopRemoteDesktopViewerOwner | undefined
): boolean {
  return left !== undefined && right !== undefined && left.profileId === right.profileId &&
    left.serverId === right.serverId && left.deviceId === right.deviceId && left.origin === right.origin &&
    left.connectionGeneration === right.connectionGeneration;
}

export function parseDesktopRemoteDesktopViewerOwner(value: unknown): DesktopRemoteDesktopViewerOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid viewer owner.");
  const record = value as Record<string, unknown>;
  const fields = ["profileId", "serverId", "deviceId", "origin", "connectionGeneration"];
  if (Object.keys(record).length !== fields.length || Object.keys(record).some((key) => !fields.includes(key)) ||
    ![record["profileId"], record["serverId"], record["deviceId"]].every((item) =>
      typeof item === "string" && item.length > 0 && item.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(item)) ||
    typeof record["origin"] !== "string" || record["origin"].length > 2048 ||
    !Number.isSafeInteger(record["connectionGeneration"]) || (record["connectionGeneration"] as number) < 1) {
    throw new TypeError("Invalid viewer owner.");
  }
  const url = new URL(record["origin"]);
  if (url.origin !== record["origin"] || !["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new TypeError("Invalid viewer origin.");
  }
  return Object.freeze({ profileId: record["profileId"] as string, serverId: record["serverId"] as string,
    deviceId: record["deviceId"] as string, origin: record["origin"],
    connectionGeneration: record["connectionGeneration"] as number });
}
