import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  DEDICATED_HARDWARE_MODEL_IDS,
  DEDICATED_HARDWARE_PHYSICAL_KEYS,
  parseDedicatedHardwareSettings,
  type DedicatedHardwareModelId,
  type DedicatedHardwarePhysicalKey,
  type DedicatedHardwareSettings
} from "./settings.js";
import type { DedicatedHardwareLightingActivity } from "./lighting-frame.js";

export const DEDICATED_HARDWARE_UTILITY_PROTOCOL_VERSION = 1;
export const DEDICATED_HARDWARE_UTILITY_REQUEST_MAX_BYTES = 72 * 1024;
export const DEDICATED_HARDWARE_UTILITY_MESSAGE_MAX_BYTES = 32 * 1024;

export const DEDICATED_HARDWARE_CONNECTION_STATUSES = [
  "connecting", "connected", "not-detected", "disabled", "error", "unavailable"
] as const;
export type DedicatedHardwareConnectionStatus = (typeof DEDICATED_HARDWARE_CONNECTION_STATUSES)[number];

export const DEDICATED_HARDWARE_CONNECTION_REASONS = [
  "sdk-unavailable", "permission-required", "device-in-use", "connection-timeout",
  "host-crash", "device-disconnected"
] as const;
export type DedicatedHardwareConnectionReason = (typeof DEDICATED_HARDWARE_CONNECTION_REASONS)[number] | null;

export const DEDICATED_HARDWARE_INPUT_PERMISSIONS = ["granted", "denied", "unknown", "not-required"] as const;
export type DedicatedHardwareInputPermission = (typeof DEDICATED_HARDWARE_INPUT_PERMISSIONS)[number];
export type DedicatedHardwareTransport = "usb" | "bluetooth" | null;

export const DEDICATED_HARDWARE_KEYMAP_PHASES = [
  "unavailable", "idle", "applying", "occupied", "restoring", "error"
] as const;
export type DedicatedHardwareProjectedKeymapPhase = (typeof DEDICATED_HARDWARE_KEYMAP_PHASES)[number];
export const DEDICATED_HARDWARE_KEYMAP_FAILURES = [
  "read", "backup", "transform", "apply", "rollback", "restore", "backup-cleanup", "recovery-required"
] as const;
export type DedicatedHardwareProjectedKeymapFailure = (typeof DEDICATED_HARDWARE_KEYMAP_FAILURES)[number] | null;

export type DedicatedHardwareKeymapSnapshot =
  | {
      readonly phase: "unavailable";
      readonly backupAvailable: null;
      readonly failure: null;
    }
  | {
      readonly phase: Exclude<DedicatedHardwareProjectedKeymapPhase, "unavailable">;
      readonly backupAvailable: boolean;
      readonly failure: DedicatedHardwareProjectedKeymapFailure;
    };

export interface DedicatedHardwareConnectionSnapshot {
  readonly model: DedicatedHardwareModelId;
  readonly status: DedicatedHardwareConnectionStatus;
  readonly reason: DedicatedHardwareConnectionReason;
  readonly devicePresent: boolean | null;
  readonly transport: DedicatedHardwareTransport;
  readonly firmwareVersion: string | null;
  readonly batteryPercent: number | null;
  readonly charging: boolean | null;
  readonly inputPermission: DedicatedHardwareInputPermission;
  readonly keymap: DedicatedHardwareKeymapSnapshot | null;
}

export type DedicatedHardwareUtilityDeviceSnapshot = Omit<DedicatedHardwareConnectionSnapshot, "keymap"> & {
  /** Utility-only opaque identity for the exact physical device and firmware keymap schema. */
  readonly keymapDeviceFirmwareIdentity: string | null;
};

export interface DedicatedHardwareDesiredState {
  readonly settings: DedicatedHardwareSettings;
  readonly preview: boolean;
}

export interface DedicatedHardwareLightingState {
  readonly version: 1;
  readonly taskSlots: readonly [
    DedicatedHardwareLightingActivity | null,
    DedicatedHardwareLightingActivity | null,
    DedicatedHardwareLightingActivity | null,
    DedicatedHardwareLightingActivity | null,
    DedicatedHardwareLightingActivity | null,
    DedicatedHardwareLightingActivity | null
  ];
  readonly revealOccurrence: string;
  readonly primaryVisible: boolean;
}

export const DEDICATED_HARDWARE_SDK_PLATFORMS = ["win32", "darwin", "linux"] as const;
export type DedicatedHardwareSdkPlatform = (typeof DEDICATED_HARDWARE_SDK_PLATFORMS)[number];
export const DEDICATED_HARDWARE_SDK_ARCHITECTURES = ["x64", "arm64"] as const;
export type DedicatedHardwareSdkArchitecture = (typeof DEDICATED_HARDWARE_SDK_ARCHITECTURES)[number];

export interface DedicatedHardwareSdkFileManifestEntry {
  readonly relativePath: string;
  readonly size: number;
  readonly integrity: string;
}

export interface DedicatedHardwareSdkNativeAddon {
  readonly identity: string;
  readonly relativePath: string;
  readonly integrity: string;
  readonly abi: "electron-modules" | "node-api";
}

export interface DedicatedHardwareSdkManifest {
  readonly version: 1;
  readonly packageName: "@worklouder/device-kit-oai";
  readonly packageVersion: string;
  readonly redistributionGrantId: string;
  readonly license: Readonly<{ readonly relativePath: string; readonly integrity: string }>;
  readonly target: Readonly<{
    readonly platform: DedicatedHardwareSdkPlatform;
    readonly architecture: DedicatedHardwareSdkArchitecture;
    readonly electronModulesAbi: number;
    readonly nodeApiVersion: number;
  }>;
  readonly entry: Readonly<{ readonly relativePath: string; readonly integrity: string }>;
  readonly nativeAddons: readonly DedicatedHardwareSdkNativeAddon[];
  readonly files: readonly DedicatedHardwareSdkFileManifestEntry[];
  readonly directoryIntegrity: string;
  readonly manifestIntegrity: string;
}

export type DedicatedHardwareSdkIdentity =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "installed";
      readonly packageDirectory: string;
      readonly entryPath: string;
      readonly packageVersion: string;
      readonly entrySha256: string;
      readonly platform: DedicatedHardwareSdkPlatform;
      readonly architecture: DedicatedHardwareSdkArchitecture;
    }
  | {
      readonly kind: "native-usb";
      readonly executablePath: string;
      readonly sha256: string;
      readonly platform: "win32";
      readonly architecture: DedicatedHardwareSdkArchitecture;
    }
  | {
      readonly kind: "staged";
      readonly stagingDirectory: string;
      readonly manifest: DedicatedHardwareSdkManifest;
    };

export type DedicatedHardwareUtilityRequest =
  | {
      readonly version: 1;
      readonly generation: number;
      readonly requestId: string;
      readonly kind: "handshake";
      readonly sdk: DedicatedHardwareSdkIdentity;
      readonly keymapBackupDirectory: string;
    }
  | {
      readonly version: 1;
      readonly generation: number;
      readonly requestId: string;
      readonly kind: "set-desired-state";
      readonly model: DedicatedHardwareModelId;
      readonly settings: DedicatedHardwareSettings;
      readonly preview: boolean;
    }
  | {
      readonly version: 1;
      readonly generation: number;
      readonly requestId: string;
      readonly kind: "set-lighting-state";
      readonly model: DedicatedHardwareModelId;
      readonly state: DedicatedHardwareLightingState;
    }
  | {
      readonly version: 1;
      readonly generation: number;
      readonly requestId: string;
      readonly kind: "probe";
      readonly model: DedicatedHardwareModelId;
    }
  | {
      readonly version: 1;
      readonly generation: number;
      readonly requestId: string;
      readonly kind: "recover-keymap";
      readonly model: "creator-micro-2";
    }
  | {
      readonly version: 1;
      readonly generation: number;
      readonly requestId: string;
      readonly kind: "inspect-keymap";
      readonly model: "creator-micro-2";
    }
  | {
      readonly version: 1;
      readonly generation: number;
      readonly requestId: string;
      readonly kind: "shutdown";
    };

export type DedicatedHardwareInputEvent =
  | { readonly kind: "key"; readonly key: DedicatedHardwarePhysicalKey; readonly pressed: boolean }
  | { readonly kind: "stick"; readonly x: number; readonly y: number; readonly pressed: boolean }
  | { readonly kind: "encoder"; readonly delta: -1 | 0 | 1; readonly pressed: boolean };

export type DedicatedHardwareUtilityMessage =
  | {
      readonly version: 1;
      readonly generation: number;
      readonly requestId: string;
      readonly kind: "ready";
    }
  | {
      readonly version: 1;
      readonly generation: number;
      readonly requestId: string;
      readonly kind: "ack";
    }
  | ({ readonly version: 1; readonly generation: number; readonly kind: "state" } & DedicatedHardwareConnectionSnapshot)
  | {
      readonly version: 1;
      readonly generation: number;
      readonly kind: "input";
      readonly model: DedicatedHardwareModelId;
      readonly sequence: number;
      readonly input: DedicatedHardwareInputEvent;
    }
  | {
      readonly version: 1;
      readonly generation: number;
      readonly requestId: string;
      readonly kind: "stopped";
    };

export function parseDedicatedHardwareUtilityRequest(value: unknown): DedicatedHardwareUtilityRequest | undefined {
  if (!isRecord(value) || value.version !== 1 || !isGeneration(value.generation) ||
      !isRequestId(value.requestId) || typeof value.kind !== "string") return undefined;
  let parsed: DedicatedHardwareUtilityRequest | undefined;
  if (value.kind === "handshake" && hasExactKeys(value, [
    "version", "generation", "requestId", "kind", "sdk", "keymapBackupDirectory"
  ]) && isBoundedPath(value.keymapBackupDirectory)) {
    const sdk = parseDedicatedHardwareSdkIdentity(value.sdk);
    if (sdk !== undefined) {
      parsed = {
        version: 1,
        generation: value.generation,
        requestId: value.requestId,
        kind: "handshake",
        sdk,
        keymapBackupDirectory: value.keymapBackupDirectory
      };
    }
  } else if (value.kind === "set-desired-state" &&
      hasExactKeys(value, ["version", "generation", "requestId", "kind", "model", "settings", "preview"]) &&
      isOption(value.model, DEDICATED_HARDWARE_MODEL_IDS) && typeof value.preview === "boolean") {
    const settings = parseDedicatedHardwareSettings(value.settings);
    if (settings !== undefined) {
      parsed = {
        version: 1, generation: value.generation, requestId: value.requestId,
        kind: "set-desired-state", model: value.model, settings, preview: value.preview
      };
    }
  } else if (value.kind === "set-lighting-state" &&
      hasExactKeys(value, ["version", "generation", "requestId", "kind", "model", "state"]) &&
      isOption(value.model, DEDICATED_HARDWARE_MODEL_IDS)) {
    const state = parseDedicatedHardwareLightingState(value.state);
    if (state !== undefined) {
      parsed = {
        version: 1, generation: value.generation, requestId: value.requestId,
        kind: "set-lighting-state", model: value.model, state
      };
    }
  } else if (value.kind === "probe" &&
      hasExactKeys(value, ["version", "generation", "requestId", "kind", "model"]) &&
      isOption(value.model, DEDICATED_HARDWARE_MODEL_IDS)) {
    parsed = { version: 1, generation: value.generation, requestId: value.requestId, kind: "probe", model: value.model };
  } else if ((value.kind === "recover-keymap" || value.kind === "inspect-keymap") &&
      hasExactKeys(value, ["version", "generation", "requestId", "kind", "model"]) &&
      value.model === "creator-micro-2") {
    parsed = {
      version: 1,
      generation: value.generation,
      requestId: value.requestId,
      kind: value.kind,
      model: "creator-micro-2"
    };
  } else if (value.kind === "shutdown" &&
      hasExactKeys(value, ["version", "generation", "requestId", "kind"])) {
    parsed = { version: 1, generation: value.generation, requestId: value.requestId, kind: "shutdown" };
  }
  return parsed !== undefined && withinBudget(parsed, DEDICATED_HARDWARE_UTILITY_REQUEST_MAX_BYTES) ? parsed : undefined;
}

export function parseDedicatedHardwareUtilityMessage(value: unknown): DedicatedHardwareUtilityMessage | undefined {
  if (!isRecord(value) || value.version !== 1 || !isGeneration(value.generation) || typeof value.kind !== "string") return undefined;
  let parsed: DedicatedHardwareUtilityMessage | undefined;
  if ((value.kind === "ready" || value.kind === "ack" || value.kind === "stopped") &&
      hasExactKeys(value, ["version", "generation", "requestId", "kind"]) && isRequestId(value.requestId)) {
    if (value.kind === "ready") parsed = { version: 1, generation: value.generation, requestId: value.requestId, kind: "ready" };
    if (value.kind === "ack") parsed = { version: 1, generation: value.generation, requestId: value.requestId, kind: "ack" };
    if (value.kind === "stopped") parsed = { version: 1, generation: value.generation, requestId: value.requestId, kind: "stopped" };
  } else if (value.kind === "state" && hasExactKeys(value, [
    "version", "generation", "kind", "model", "status", "reason", "devicePresent", "transport",
    "firmwareVersion", "batteryPercent", "charging", "inputPermission", "keymap"
  ])) {
    const state = parseConnectionSnapshot(value);
    if (state !== undefined) parsed = { version: 1, generation: value.generation, kind: "state", ...state };
  } else if (value.kind === "input" &&
      hasExactKeys(value, ["version", "generation", "kind", "model", "sequence", "input"]) &&
      isOption(value.model, DEDICATED_HARDWARE_MODEL_IDS) && isSequence(value.sequence)) {
    const input = parseInputEvent(value.input);
    if (input !== undefined) {
      parsed = { version: 1, generation: value.generation, kind: "input", model: value.model, sequence: value.sequence, input };
    }
  }
  return parsed !== undefined && withinBudget(parsed, DEDICATED_HARDWARE_UTILITY_MESSAGE_MAX_BYTES) ? parsed : undefined;
}

export function decodeDedicatedHardwareUtilityRequest(frame: string | Uint8Array): DedicatedHardwareUtilityRequest | undefined {
  return decodeFrame(frame, DEDICATED_HARDWARE_UTILITY_REQUEST_MAX_BYTES, parseDedicatedHardwareUtilityRequest);
}

export function decodeDedicatedHardwareUtilityMessage(frame: string | Uint8Array): DedicatedHardwareUtilityMessage | undefined {
  return decodeFrame(frame, DEDICATED_HARDWARE_UTILITY_MESSAGE_MAX_BYTES, parseDedicatedHardwareUtilityMessage);
}

export function encodeDedicatedHardwareUtilityRequest(request: DedicatedHardwareUtilityRequest): string {
  const parsed = parseDedicatedHardwareUtilityRequest(request);
  if (parsed === undefined) throw new TypeError("Invalid dedicated hardware utility request.");
  return JSON.stringify(parsed);
}

export function encodeDedicatedHardwareUtilityMessage(message: DedicatedHardwareUtilityMessage): string {
  const parsed = parseDedicatedHardwareUtilityMessage(message);
  if (parsed === undefined) throw new TypeError("Invalid dedicated hardware utility message.");
  return JSON.stringify(parsed);
}

export function parseDedicatedHardwareLightingState(value: unknown): DedicatedHardwareLightingState | undefined {
  if (!hasExactKeys(value, ["version", "taskSlots", "revealOccurrence", "primaryVisible"]) || value.version !== 1 ||
      !Array.isArray(value.taskSlots) || value.taskSlots.length !== 6 ||
      typeof value.revealOccurrence !== "string" || !/^(?:0|[1-9][0-9]{0,63})$/u.test(value.revealOccurrence) ||
      typeof value.primaryVisible !== "boolean") return undefined;
  const taskSlots: Array<DedicatedHardwareLightingActivity | null> = [];
  for (const activity of value.taskSlots) {
    if (activity === null) {
      taskSlots.push(null);
    } else if (hasExactKeys(activity, ["phase", "attention"]) &&
        (activity.phase === null || isOption(activity.phase, ["running", "needs-interaction", "completed", "error"])) &&
        typeof activity.attention === "boolean") {
      taskSlots.push({ phase: activity.phase, attention: activity.attention });
    } else {
      return undefined;
    }
  }
  return {
    version: 1,
    taskSlots: taskSlots as unknown as DedicatedHardwareLightingState["taskSlots"],
    revealOccurrence: value.revealOccurrence,
    primaryVisible: value.primaryVisible
  };
}

function parseConnectionSnapshot(value: Record<string, unknown>): DedicatedHardwareConnectionSnapshot | undefined {
  if (!isOption(value.model, DEDICATED_HARDWARE_MODEL_IDS) ||
      !isOption(value.status, DEDICATED_HARDWARE_CONNECTION_STATUSES) ||
      !(value.reason === null || isOption(value.reason, DEDICATED_HARDWARE_CONNECTION_REASONS)) ||
      !(value.devicePresent === null || typeof value.devicePresent === "boolean") ||
      !(value.transport === null || value.transport === "usb" || value.transport === "bluetooth") ||
      !(value.firmwareVersion === null || isBoundedText(value.firmwareVersion, 128)) ||
      !(value.batteryPercent === null || Number.isInteger(value.batteryPercent) &&
        (value.batteryPercent as number) >= 0 && (value.batteryPercent as number) <= 100) ||
      !(value.charging === null || typeof value.charging === "boolean") ||
      !isOption(value.inputPermission, DEDICATED_HARDWARE_INPUT_PERMISSIONS)) return undefined;
  const keymap = value.model === "creator-micro-2"
    ? parseKeymapSnapshot(value.keymap)
    : value.keymap === null ? null : undefined;
  if (keymap === undefined) return undefined;
  return {
    model: value.model,
    status: value.status,
    reason: value.reason,
    devicePresent: value.devicePresent,
    transport: value.transport,
    firmwareVersion: value.firmwareVersion,
    batteryPercent: value.batteryPercent as number | null,
    charging: value.charging,
    inputPermission: value.inputPermission,
    keymap
  };
}

function parseKeymapSnapshot(value: unknown): DedicatedHardwareKeymapSnapshot | undefined {
  if (!hasExactKeys(value, ["phase", "backupAvailable", "failure"]) ||
      !isOption(value.phase, DEDICATED_HARDWARE_KEYMAP_PHASES)) return undefined;
  if (value.phase === "unavailable") {
    return value.backupAvailable === null && value.failure === null
      ? { phase: "unavailable", backupAvailable: null, failure: null }
      : undefined;
  }
  if (typeof value.backupAvailable !== "boolean" ||
      !(value.failure === null || isOption(value.failure, DEDICATED_HARDWARE_KEYMAP_FAILURES))) return undefined;
  if (value.failure === "recovery-required" && !value.backupAvailable) return undefined;
  return {
    phase: value.phase,
    backupAvailable: value.backupAvailable,
    failure: value.failure
  };
}

function parseInputEvent(value: unknown): DedicatedHardwareInputEvent | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "key" && hasExactKeys(value, ["kind", "key", "pressed"]) &&
      isOption(value.key, DEDICATED_HARDWARE_PHYSICAL_KEYS) && typeof value.pressed === "boolean") {
    return { kind: "key", key: value.key, pressed: value.pressed };
  }
  if (value.kind === "stick" && hasExactKeys(value, ["kind", "x", "y", "pressed"]) &&
      isUnitAxis(value.x) && isUnitAxis(value.y) && typeof value.pressed === "boolean") {
    return { kind: "stick", x: value.x, y: value.y, pressed: value.pressed };
  }
  if (value.kind === "encoder" && hasExactKeys(value, ["kind", "delta", "pressed"]) &&
      (value.delta === -1 || value.delta === 0 || value.delta === 1) && typeof value.pressed === "boolean") {
    return { kind: "encoder", delta: value.delta, pressed: value.pressed };
  }
  return undefined;
}

export function parseDedicatedHardwareSdkManifest(value: unknown): DedicatedHardwareSdkManifest | undefined {
  if (!hasExactKeys(value, [
    "version", "packageName", "packageVersion", "redistributionGrantId", "license", "target", "entry",
    "nativeAddons", "files", "directoryIntegrity", "manifestIntegrity"
  ]) || value.version !== 1 || value.packageName !== "@worklouder/device-kit-oai" ||
      !isPackageVersion(value.packageVersion) || !isBoundedIdentity(value.redistributionGrantId, 256) ||
      !hasExactKeys(value.license, ["relativePath", "integrity"]) ||
      !isSdkRelativePath(value.license.relativePath) || !isSha512Integrity(value.license.integrity) ||
      !hasExactKeys(value.target, ["platform", "architecture", "electronModulesAbi", "nodeApiVersion"]) ||
      !isOption(value.target.platform, DEDICATED_HARDWARE_SDK_PLATFORMS) ||
      !isOption(value.target.architecture, DEDICATED_HARDWARE_SDK_ARCHITECTURES) ||
      !isPositiveSafeInteger(value.target.electronModulesAbi) || !isPositiveSafeInteger(value.target.nodeApiVersion) ||
      !hasExactKeys(value.entry, ["relativePath", "integrity"]) ||
      !isSdkRelativePath(value.entry.relativePath) || !value.entry.relativePath.endsWith(".mjs") ||
      !isSha512Integrity(value.entry.integrity) || !Array.isArray(value.nativeAddons) ||
      value.nativeAddons.length > 64 || !Array.isArray(value.files) || value.files.length === 0 ||
      value.files.length > 512 || !isSha512Integrity(value.directoryIntegrity) ||
      !isSha512Integrity(value.manifestIntegrity)) return undefined;

  const nativeAddons: DedicatedHardwareSdkNativeAddon[] = [];
  for (const candidate of value.nativeAddons) {
    if (!hasExactKeys(candidate, ["identity", "relativePath", "integrity", "abi"]) ||
        !isSdkAddonIdentity(candidate.identity) || !isSdkRelativePath(candidate.relativePath) ||
        !candidate.relativePath.endsWith(".node") || !isSha512Integrity(candidate.integrity) ||
        (candidate.abi !== "electron-modules" && candidate.abi !== "node-api")) return undefined;
    nativeAddons.push(Object.freeze({
      identity: candidate.identity,
      relativePath: candidate.relativePath,
      integrity: candidate.integrity,
      abi: candidate.abi
    }));
  }
  if (!isStrictlySortedUnique(nativeAddons, (item) => item.identity) ||
      !isCaseInsensitiveUnique(nativeAddons.map((item) => item.relativePath))) return undefined;

  const files: DedicatedHardwareSdkFileManifestEntry[] = [];
  for (const candidate of value.files) {
    if (!hasExactKeys(candidate, ["relativePath", "size", "integrity"]) ||
        !isSdkRelativePath(candidate.relativePath) || !isPositiveSafeInteger(candidate.size) ||
        candidate.size > 128 * 1024 * 1024 || !isSha512Integrity(candidate.integrity)) return undefined;
    files.push(Object.freeze({
      relativePath: candidate.relativePath,
      size: candidate.size,
      integrity: candidate.integrity
    }));
  }
  if (!isStrictlySortedUnique(files, (item) => item.relativePath) ||
      !isCaseInsensitiveUnique(files.map((item) => item.relativePath))) return undefined;
  const totalBytes = files.reduce((sum, item) => sum + item.size, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > 512 * 1024 * 1024) return undefined;

  const fileByPath = new Map(files.map((item) => [item.relativePath, item]));
  const licenseFile = fileByPath.get(value.license.relativePath);
  const entryFile = fileByPath.get(value.entry.relativePath);
  if (licenseFile?.integrity !== value.license.integrity || entryFile?.integrity !== value.entry.integrity) return undefined;
  const nativePaths = new Set(nativeAddons.map((item) => item.relativePath));
  if (nativeAddons.some((item) => fileByPath.get(item.relativePath)?.integrity !== item.integrity) ||
      files.some((item) => item.relativePath.endsWith(".node") !== nativePaths.has(item.relativePath))) return undefined;

  const manifestWithoutIntegrity = Object.freeze({
    version: 1 as const,
    packageName: "@worklouder/device-kit-oai" as const,
    packageVersion: value.packageVersion,
    redistributionGrantId: value.redistributionGrantId,
    license: Object.freeze({ relativePath: value.license.relativePath, integrity: value.license.integrity }),
    target: Object.freeze({
      platform: value.target.platform,
      architecture: value.target.architecture,
      electronModulesAbi: value.target.electronModulesAbi,
      nodeApiVersion: value.target.nodeApiVersion
    }),
    entry: Object.freeze({ relativePath: value.entry.relativePath, integrity: value.entry.integrity }),
    nativeAddons: Object.freeze(nativeAddons),
    files: Object.freeze(files),
    directoryIntegrity: value.directoryIntegrity
  });
  const expectedManifestIntegrity = sha512Integrity(new TextEncoder().encode(
    canonicalJson(manifestWithoutIntegrity)
  ));
  if (expectedManifestIntegrity !== value.manifestIntegrity) return undefined;
  return Object.freeze({ ...manifestWithoutIntegrity, manifestIntegrity: value.manifestIntegrity });
}

export function canonicalDedicatedHardwareSdkManifestJson(
  value: Omit<DedicatedHardwareSdkManifest, "manifestIntegrity">
): string {
  return canonicalJson(value);
}

export function parseDedicatedHardwareSdkIdentity(value: unknown): DedicatedHardwareSdkIdentity | undefined {
  if (hasExactKeys(value, ["kind"]) && value.kind === "unavailable") return { kind: "unavailable" };
  if (hasExactKeys(value, ["kind", "packageDirectory", "entryPath", "packageVersion", "entrySha256", "platform", "architecture"]) &&
      value.kind === "installed" && isBoundedPath(value.packageDirectory) && isBoundedPath(value.entryPath) &&
      isPackageVersion(value.packageVersion) && isSha256(value.entrySha256) &&
      isOption(value.platform, DEDICATED_HARDWARE_SDK_PLATFORMS) &&
      isOption(value.architecture, DEDICATED_HARDWARE_SDK_ARCHITECTURES)) {
    return { kind: "installed", packageDirectory: value.packageDirectory, entryPath: value.entryPath,
      packageVersion: value.packageVersion, entrySha256: value.entrySha256,
      platform: value.platform, architecture: value.architecture };
  }
  if (hasExactKeys(value, ["kind", "executablePath", "sha256", "platform", "architecture"]) &&
      value.kind === "native-usb" && isBoundedPath(value.executablePath) && isSha256(value.sha256) &&
      value.platform === "win32" && isOption(value.architecture, DEDICATED_HARDWARE_SDK_ARCHITECTURES)) {
    return { kind: "native-usb", executablePath: value.executablePath, sha256: value.sha256,
      platform: "win32", architecture: value.architecture };
  }
  if (!hasExactKeys(value, ["kind", "stagingDirectory", "manifest"]) || value.kind !== "staged" ||
      !isBoundedPath(value.stagingDirectory)) return undefined;
  const manifest = parseDedicatedHardwareSdkManifest(value.manifest);
  if (manifest === undefined) return undefined;
  return {
    kind: "staged",
    stagingDirectory: value.stagingDirectory,
    manifest
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function decodeFrame<T>(frame: string | Uint8Array, maximum: number, parse: (value: unknown) => T | undefined): T | undefined {
  let text: string;
  try {
    if (typeof frame === "string") {
      if (new TextEncoder().encode(frame).byteLength > maximum) return undefined;
      text = frame;
    } else {
      if (frame.byteLength > maximum) return undefined;
      text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    }
    return parse(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function withinBudget(value: unknown, maximum: number): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isOption<const T extends readonly string[]>(value: unknown, options: T): value is T[number] {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isBoundedPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
    value.trim() === value && !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    isAbsolute(value) && resolve(value) === value;
}

function isPackageVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

function isBoundedIdentity(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isSdkAddonIdentity(value: unknown): value is string {
  return isBoundedIdentity(value, 256) && /^[A-Za-z0-9@][A-Za-z0-9@/._:+-]*$/u.test(value);
}

function isSdkRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\\") ||
      value.startsWith("/") || value.endsWith("/") || hasLoneSurrogate(value) ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  const segments = value.split("/");
  return segments.length <= 16 && segments.every((segment) =>
    segment !== "." && segment !== ".." && /^[A-Za-z0-9@][A-Za-z0-9@._+-]*$/u.test(segment)
  );
}

function isSha512Integrity(value: unknown): value is string {
  return typeof value === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isStrictlySortedUnique<T>(values: readonly T[], select: (value: T) => string): boolean {
  return values.every((value, index) => index === 0 || select(values[index - 1]!) < select(value));
}

function isCaseInsensitiveUnique(values: readonly string[]): boolean {
  return new Set(values.map((value) => value.toLocaleLowerCase("en-US"))).size === values.length;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Canonical SDK manifest numbers must be safe integers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  throw new TypeError("The SDK manifest cannot be canonicalized.");
}

function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isUnitAxis(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
