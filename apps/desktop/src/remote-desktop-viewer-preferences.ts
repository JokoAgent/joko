import { createHash } from "node:crypto";
import type { DesktopRemoteDesktopViewerOwner } from "@joko/contracts";
import { atomicWritePrivateFile, readPrivateFile } from "@joko/device-peer/private-files";

type PreferenceOwner = Pick<DesktopRemoteDesktopViewerOwner, "profileId" | "serverId" | "deviceId">;
export interface DesktopRemoteDesktopViewerPreferences { readonly audio: boolean; readonly hostMute: boolean; readonly lockOnExit: boolean; readonly clipboardSync: boolean; readonly privacyScreen: boolean }
export interface DesktopRemoteDesktopViewerPreferencesStore {
  initialize(): Promise<void>;
  get(owner: PreferenceOwner, targetDeviceId: string): DesktopRemoteDesktopViewerPreferences;
  setAudio(owner: PreferenceOwner, targetDeviceId: string, audio: boolean,
    current?: () => void): Promise<DesktopRemoteDesktopViewerPreferences>;
  setHostMute(owner: PreferenceOwner, targetDeviceId: string, hostMute: boolean,
    current?: () => void): Promise<DesktopRemoteDesktopViewerPreferences>;
  setLockOnExit(owner: PreferenceOwner, targetDeviceId: string, lockOnExit: boolean,
    current?: () => void): Promise<DesktopRemoteDesktopViewerPreferences>;
  setClipboardSync(owner: PreferenceOwner, targetDeviceId: string, clipboardSync: boolean,
    current?: () => void): Promise<DesktopRemoteDesktopViewerPreferences>;
  setPrivacyScreen(owner: PreferenceOwner, targetDeviceId: string, privacyScreen: boolean,
    current?: () => void): Promise<DesktopRemoteDesktopViewerPreferences>;
}
type Targets = Record<string, DesktopRemoteDesktopViewerPreferences>;

/** Private playback intent for the exact profile, node, controller and target. */
export function createDesktopRemoteDesktopViewerPreferencesStore(path: string | (() => string)): DesktopRemoteDesktopViewerPreferencesStore {
  let targets: Targets = {};
  let resolvedPath: string | undefined;
  const filePath = (): string => resolvedPath ??= typeof path === "string" ? path : path();
  let initialization: Promise<void> | undefined;
  let writeTail = Promise.resolve();
  const initialize = (): Promise<void> => {
    initialization ??= readPrivateFile(filePath()).then((bytes) => {
      if (bytes === undefined) return;
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (isPreferences(value)) targets = value.targets;
      } catch {
        // Incompatible or unreadable development state is rebuilt only by an explicit setting change.
      } finally { bytes.fill(0); }
    }).catch(() => undefined);
    return initialization;
  };
  const set = (owner: PreferenceOwner, targetDeviceId: string, patch: Partial<DesktopRemoteDesktopViewerPreferences>, current?: () => void) => {
      const key = keyFor(owner, targetDeviceId);
      const operation = async (): Promise<DesktopRemoteDesktopViewerPreferences> => {
        await initialize(); current?.();
        const previous = targets[key];
        const value = snapshot(patch.audio ?? previous?.audio ?? true, patch.hostMute ?? previous?.hostMute ?? false,
          patch.lockOnExit ?? previous?.lockOnExit ?? false, patch.clipboardSync ?? previous?.clipboardSync ?? false,
          patch.privacyScreen ?? previous?.privacyScreen ?? false);
        const next = { ...targets, [key]: value };
        const bytes = Buffer.from(`${JSON.stringify({ version: 1, targets: next })}\n`, "utf8");
        try { await atomicWritePrivateFile(filePath(), bytes); }
        finally { bytes.fill(0); }
        targets = next;
        return value;
      };
      const result = writeTail.then(operation, operation);
      writeTail = result.then(() => undefined, () => undefined);
      return result;
  };
  return Object.freeze({
    initialize,
    get: (owner: PreferenceOwner, targetDeviceId: string) => {
      const value = targets[keyFor(owner, targetDeviceId)]; return snapshot(value?.audio ?? true, value?.hostMute ?? false, value?.lockOnExit ?? false, value?.clipboardSync ?? false, value?.privacyScreen ?? false);
    },
    setAudio: (owner: PreferenceOwner, targetDeviceId: string, audio: boolean, current?: () => void) => {
      if (typeof audio !== "boolean") return Promise.reject(new TypeError("Viewer audio preference must be boolean."));
      return set(owner, targetDeviceId, { audio }, current);
    },
    setHostMute: (owner: PreferenceOwner, targetDeviceId: string, hostMute: boolean, current?: () => void) => {
      if (typeof hostMute !== "boolean") return Promise.reject(new TypeError("Viewer host mute preference must be boolean."));
      return set(owner, targetDeviceId, { hostMute }, current);
    },
    setLockOnExit: (owner: PreferenceOwner, targetDeviceId: string, lockOnExit: boolean, current?: () => void) => {
      if (typeof lockOnExit !== "boolean") return Promise.reject(new TypeError("Viewer lock on exit preference must be boolean."));
      return set(owner, targetDeviceId, { lockOnExit }, current);
    },
    setClipboardSync: (owner: PreferenceOwner, targetDeviceId: string, clipboardSync: boolean, current?: () => void) => {
      if (typeof clipboardSync !== "boolean") return Promise.reject(new TypeError("Viewer clipboard sync preference must be boolean."));
      return set(owner, targetDeviceId, { clipboardSync }, current);
    },
    setPrivacyScreen: (owner: PreferenceOwner, targetDeviceId: string, privacyScreen: boolean, current?: () => void) => {
      if (typeof privacyScreen !== "boolean") return Promise.reject(new TypeError("Viewer privacy screen preference must be boolean."));
      return set(owner, targetDeviceId, { privacyScreen }, current);
    }
  });
}

function keyFor(owner: PreferenceOwner, targetDeviceId: string): string {
  return createHash("sha256").update(JSON.stringify([owner.profileId, owner.serverId, owner.deviceId, targetDeviceId])).digest("hex");
}
function snapshot(audio: boolean, hostMute: boolean, lockOnExit: boolean, clipboardSync: boolean, privacyScreen: boolean): DesktopRemoteDesktopViewerPreferences { return Object.freeze({ audio, hostMute, lockOnExit, clipboardSync, privacyScreen }); }
function isPreferences(value: unknown): value is { version: 1; targets: Targets } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "targets,version" || record["version"] !== 1 ||
    typeof record["targets"] !== "object" || record["targets"] === null || Array.isArray(record["targets"])) return false;
  return Object.entries(record["targets"]).every(([key, item]) => /^[a-f0-9]{64}$/u.test(key) &&
    typeof item === "object" && item !== null && !Array.isArray(item) && Object.keys(item).sort().join(",") === "audio,clipboardSync,hostMute,lockOnExit,privacyScreen" &&
    ["audio", "hostMute", "lockOnExit", "clipboardSync", "privacyScreen"].every((key) => typeof (item as Record<string, unknown>)[key] === "boolean"));
}
