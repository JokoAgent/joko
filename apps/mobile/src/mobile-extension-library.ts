import {
  ExtensionLibraryLocationKind,
  ExtensionLibraryState,
  ExtensionLibraryUnavailableReason,
  type ExtensionLibraryGraceEntry,
  type ExtensionLibraryLocation,
  type ExtensionLibraryLocationValidation,
  type ExtensionLibraryOverview,
  type ExtensionLibraryTrashEntry
} from "@joko/contracts";
import type { MobileExtension } from "./mobile-extensions";

const EXTENSION_ID = /^extension_[a-f0-9]{32}$/u;
const TRASH_ID = /^library_trash_[a-f0-9]{32}$/u;
const GRACE_ID = /^library_grace_[a-f0-9]{32}$/u;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const MAXIMUM_RECOVERY_ENTRIES = 10_000;
const MAXIMUM_REMOTE_PATH_CHARACTERS = 32_768;
const MAXIMUM_DATE_MILLISECONDS = 8_640_000_000_000_000n;

export type MobileExtensionLibraryState = "ready" | "readOnly" | "unavailable";
export type MobileExtensionLibraryUnavailableReason =
  | "metadataCorrupt"
  | "fileLimit"
  | "io"
  | "operationInProgress"
  | "diskMissing"
  | "bindingMoved"
  | "stateCorrupt";

export interface MobileExtensionLibraryLocation {
  readonly kind: "default" | "custom";
  readonly path: string;
  readonly generation: bigint;
}

export interface MobileExtensionLibraryOverview {
  readonly extensionId: string;
  readonly name: string;
  readonly state: MobileExtensionLibraryState;
  readonly unavailableReason?: MobileExtensionLibraryUnavailableReason;
  readonly location?: MobileExtensionLibraryLocation;
  readonly files: number;
  readonly bytes: bigint;
  readonly diskFreeBytes?: bigint;
  readonly softLimitBytes: bigint;
  readonly softLimitExceeded: boolean;
  readonly orphaned: boolean;
  readonly trashCount: number;
  readonly graceCount: number;
  readonly operation?: { readonly id: string; readonly phase: string };
}

export interface MobileExtensionLibraryLocationValidation {
  readonly libraryRoot: string;
  readonly warnings: readonly string[];
  readonly diskFreeBytes?: bigint;
}

export interface MobileExtensionLibraryTrashEntry {
  readonly id: string;
  readonly extensionId: string;
  readonly name: string;
  readonly deletedAt: number;
  readonly expiresAt: number;
  readonly files: number;
  readonly bytes: bigint;
}

export interface MobileExtensionLibraryGraceEntry {
  readonly id: string;
  readonly extensionId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly files: number;
  readonly bytes: bigint;
}

export interface MobileExtensionLibrarySnapshot {
  readonly overview?: MobileExtensionLibraryOverview;
  readonly trash: readonly MobileExtensionLibraryTrashEntry[];
  readonly grace: readonly MobileExtensionLibraryGraceEntry[];
}

export type MobileExtensionLibraryDestination =
  | { readonly kind: "default" }
  | {
      readonly kind: "custom";
      readonly candidate: string;
      readonly validation: MobileExtensionLibraryLocationValidation;
    };

export type MobileExtensionLibraryMutation =
  | { readonly kind: "relocate"; readonly destination: MobileExtensionLibraryDestination }
  | {
      readonly kind: "rebind";
      readonly candidate: string;
      readonly validation: MobileExtensionLibraryLocationValidation;
    }
  | { readonly kind: "unbind" }
  | { readonly kind: "repairState" }
  | { readonly kind: "repairMetadata" }
  | { readonly kind: "trash"; readonly confirmation: string }
  | {
      readonly kind: "restore";
      readonly entry: MobileExtensionLibraryTrashEntry;
      readonly confirmation: string;
      readonly destination: "original" | "default";
    }
  | {
      readonly kind: "purge";
      readonly entry: MobileExtensionLibraryTrashEntry;
      readonly confirmation: string;
    }
  | { readonly kind: "rollback"; readonly entry: MobileExtensionLibraryGraceEntry };

export function mobileExtensionLibrarySupported(extension: MobileExtension | undefined): extension is MobileExtension & {
  readonly owner: Extract<MobileExtension["owner"], { readonly kind: "resource" }>;
  readonly library: { readonly schemaVersion: 1 };
} {
  return extension !== undefined && extension.owner.kind === "resource" && extension.library?.schemaVersion === 1
    && extension.installed && (extension.installState === "installed" || extension.installState === "updateAvailable");
}

export function mobileExtensionLibraryReady(extension: MobileExtension | undefined): boolean {
  return mobileExtensionLibrarySupported(extension) && extension.enabled
    && (extension.setup.state === "ready" || extension.setup.state === "notRequired");
}

export function normalizeMobileExtensionLibraryCandidate(value: string): string {
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAXIMUM_REMOTE_PATH_CHARACTERS || candidate.includes("\0")) {
    throw new Error("Enter a valid parent folder on the connected Joko node.");
  }
  return candidate;
}

export function projectMobileExtensionLibraryOverview(
  value: ExtensionLibraryOverview,
  expectedExtensionId: string
): MobileExtensionLibraryOverview {
  const state = projectState(value.state);
  const unavailableReason = projectUnavailableReason(value.unavailableReason);
  if (!EXTENSION_ID.test(expectedExtensionId) || value.extensionId !== expectedExtensionId
    || invalidText(value.name, 256) || !validCount(value.files) || !validCount(value.trashCount)
    || !validCount(value.graceCount) || value.bytes < 0n || value.softLimitBytes < 1n
    || value.diskFreeBytes !== undefined && value.diskFreeBytes < 0n
    || state === "unavailable" && unavailableReason === undefined
    || state !== "unavailable" && unavailableReason !== undefined
    || value.operation !== undefined && (invalidText(value.operation.operationId, 256)
      || invalidToken(value.operation.phase, 64))) {
    invalid("Extension Library overview");
  }
  return {
    extensionId: value.extensionId,
    name: value.name,
    state,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    ...(value.location === undefined ? {} : { location: projectMobileExtensionLibraryLocation(value.location) }),
    files: value.files,
    bytes: value.bytes,
    ...(value.diskFreeBytes === undefined ? {} : { diskFreeBytes: value.diskFreeBytes }),
    softLimitBytes: value.softLimitBytes,
    softLimitExceeded: value.softLimitExceeded,
    orphaned: value.orphaned,
    trashCount: value.trashCount,
    graceCount: value.graceCount,
    ...(value.operation === undefined ? {} : { operation: {
      id: value.operation.operationId,
      phase: value.operation.phase
    } })
  };
}

export function projectMobileExtensionLibraryLocation(
  value: ExtensionLibraryLocation
): MobileExtensionLibraryLocation {
  const kind = value.kind === ExtensionLibraryLocationKind.DEFAULT
    ? "default" as const
    : value.kind === ExtensionLibraryLocationKind.CUSTOM
      ? "custom" as const
      : undefined;
  const generation = value.generation?.value;
  if (kind === undefined || invalidPath(value.path) || generation === undefined || generation < 1n) {
    invalid("Extension Library location");
  }
  return { kind, path: value.path, generation };
}

export function projectMobileExtensionLibraryLocationValidation(
  value: ExtensionLibraryLocationValidation
): MobileExtensionLibraryLocationValidation {
  if (invalidPath(value.libraryRoot) || value.diskFreeBytes !== undefined && value.diskFreeBytes < 0n
    || value.warnings.length > 64) {
    invalid("Extension Library location validation");
  }
  const warnings = projectMobileExtensionLibraryWarnings(value.warnings);
  return {
    libraryRoot: value.libraryRoot,
    warnings: Object.freeze(warnings),
    ...(value.diskFreeBytes === undefined ? {} : { diskFreeBytes: value.diskFreeBytes })
  };
}

export function projectMobileExtensionLibraryWarnings(values: readonly string[]): readonly string[] {
  if (values.length > 64) invalid("Extension Library warnings");
  const warnings = values.map((warning) => {
    if (invalidToken(warning, 128)) invalid("Extension Library warning");
    return warning;
  });
  if (new Set(warnings).size !== warnings.length) invalid("Extension Library warnings");
  return Object.freeze(warnings);
}

export function projectMobileExtensionLibraryTrash(
  value: ExtensionLibraryTrashEntry,
  expectedExtensionId: string
): MobileExtensionLibraryTrashEntry {
  if (!TRASH_ID.test(value.trashId) || value.extensionId !== expectedExtensionId
    || !EXTENSION_ID.test(value.extensionId) || invalidText(value.name, 256)
    || !validCount(value.files) || value.bytes < 0n) {
    invalid("Extension Library trash record");
  }
  const deletedAt = requiredTimestamp(value.deletedAt, "Extension Library trash deletion");
  const expiresAt = requiredTimestamp(value.expiresAt, "Extension Library trash expiry");
  if (expiresAt <= deletedAt) invalid("Extension Library trash retention window");
  return {
    id: value.trashId,
    extensionId: value.extensionId,
    name: value.name,
    deletedAt,
    expiresAt,
    files: value.files,
    bytes: value.bytes
  };
}

export function projectMobileExtensionLibraryGrace(
  value: ExtensionLibraryGraceEntry,
  expectedExtensionId: string
): MobileExtensionLibraryGraceEntry {
  if (!GRACE_ID.test(value.graceId) || value.extensionId !== expectedExtensionId
    || !EXTENSION_ID.test(value.extensionId) || invalidText(value.name, 256)
    || !validCount(value.files) || value.bytes < 0n) {
    invalid("Extension Library grace record");
  }
  const createdAt = requiredTimestamp(value.createdAt, "Extension Library grace creation");
  const expiresAt = requiredTimestamp(value.expiresAt, "Extension Library grace expiry");
  if (expiresAt <= createdAt) invalid("Extension Library grace window");
  return {
    id: value.graceId,
    extensionId: value.extensionId,
    name: value.name,
    createdAt,
    expiresAt,
    files: value.files,
    bytes: value.bytes
  };
}

export function projectMobileExtensionLibraryTrashList(
  values: readonly ExtensionLibraryTrashEntry[],
  expectedExtensionId: string
): readonly MobileExtensionLibraryTrashEntry[] {
  if (values.length > MAXIMUM_RECOVERY_ENTRIES) invalid("Extension Library trash list");
  const entries = values.map((value) => projectMobileExtensionLibraryTrash(value, expectedExtensionId));
  assertUnique(entries.map((entry) => entry.id), "Extension Library trash list");
  return Object.freeze(entries);
}

export function projectMobileExtensionLibraryGraceList(
  values: readonly ExtensionLibraryGraceEntry[],
  expectedExtensionId: string
): readonly MobileExtensionLibraryGraceEntry[] {
  if (values.length > MAXIMUM_RECOVERY_ENTRIES) invalid("Extension Library grace list");
  const entries = values.map((value) => projectMobileExtensionLibraryGrace(value, expectedExtensionId));
  assertUnique(entries.map((entry) => entry.id), "Extension Library grace list");
  return Object.freeze(entries);
}

export function sameMobileExtensionLibraryValidation(
  left: MobileExtensionLibraryLocationValidation,
  right: MobileExtensionLibraryLocationValidation
): boolean {
  return validationKey(left) === validationKey(right);
}

export function sameMobileExtensionLibrarySnapshot(
  left: MobileExtensionLibrarySnapshot,
  right: MobileExtensionLibrarySnapshot
): boolean {
  return snapshotKey(left) === snapshotKey(right);
}

export function sameMobileExtensionLibraryTrashEntry(
  left: MobileExtensionLibraryTrashEntry,
  right: MobileExtensionLibraryTrashEntry
): boolean {
  return recoveryKey(left) === recoveryKey(right) && left.deletedAt === right.deletedAt;
}

export function sameMobileExtensionLibraryGraceEntry(
  left: MobileExtensionLibraryGraceEntry,
  right: MobileExtensionLibraryGraceEntry
): boolean {
  return recoveryKey(left) === recoveryKey(right) && left.createdAt === right.createdAt;
}

function projectState(value: ExtensionLibraryState): MobileExtensionLibraryState {
  switch (value) {
    case ExtensionLibraryState.READY: return "ready";
    case ExtensionLibraryState.READ_ONLY: return "readOnly";
    case ExtensionLibraryState.UNAVAILABLE: return "unavailable";
    default: return invalid("Extension Library state");
  }
}

function projectUnavailableReason(
  value: ExtensionLibraryUnavailableReason
): MobileExtensionLibraryUnavailableReason | undefined {
  switch (value) {
    case ExtensionLibraryUnavailableReason.UNSPECIFIED: return undefined;
    case ExtensionLibraryUnavailableReason.METADATA_CORRUPT: return "metadataCorrupt";
    case ExtensionLibraryUnavailableReason.FILE_LIMIT: return "fileLimit";
    case ExtensionLibraryUnavailableReason.IO: return "io";
    case ExtensionLibraryUnavailableReason.OPERATION_IN_PROGRESS: return "operationInProgress";
    case ExtensionLibraryUnavailableReason.DISK_MISSING: return "diskMissing";
    case ExtensionLibraryUnavailableReason.BINDING_MOVED: return "bindingMoved";
    case ExtensionLibraryUnavailableReason.STATE_CORRUPT: return "stateCorrupt";
    default: return invalid("Extension Library unavailable reason");
  }
}

function validationKey(value: MobileExtensionLibraryLocationValidation): string {
  return JSON.stringify({
    libraryRoot: value.libraryRoot,
    warnings: value.warnings,
    diskFreeBytes: value.diskFreeBytes?.toString(10) ?? ""
  });
}

function snapshotKey(value: MobileExtensionLibrarySnapshot): string {
  const overview = value.overview === undefined ? undefined : {
    ...value.overview,
    bytes: value.overview.bytes.toString(10),
    diskFreeBytes: value.overview.diskFreeBytes?.toString(10),
    softLimitBytes: value.overview.softLimitBytes.toString(10),
    location: value.overview.location === undefined ? undefined : {
      ...value.overview.location,
      generation: value.overview.location.generation.toString(10)
    }
  };
  const recovery = (entry: MobileExtensionLibraryTrashEntry | MobileExtensionLibraryGraceEntry) => ({
    key: recoveryKey(entry),
    start: "deletedAt" in entry ? entry.deletedAt : entry.createdAt
  });
  return JSON.stringify({
    overview,
    trash: [...value.trash].sort((a, b) => a.id.localeCompare(b.id)).map(recovery),
    grace: [...value.grace].sort((a, b) => a.id.localeCompare(b.id)).map(recovery)
  });
}

function recoveryKey(value: MobileExtensionLibraryTrashEntry | MobileExtensionLibraryGraceEntry): string {
  return [
    value.id,
    value.extensionId,
    value.name,
    value.expiresAt.toString(10),
    value.files.toString(10),
    value.bytes.toString(10)
  ].join("\u001f");
}

function requiredTimestamp(value: {
  readonly seconds: bigint;
  readonly nanos: number;
} | undefined, field: string): number {
  if (value === undefined || value.seconds < 0n
    || !Number.isSafeInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999) {
    return invalid(field);
  }
  const milliseconds = value.seconds * 1_000n + BigInt(Math.floor(value.nanos / 1_000_000));
  return milliseconds <= MAXIMUM_DATE_MILLISECONDS ? Number(milliseconds) : invalid(field);
}

function invalidPath(value: string): boolean {
  return value.trim().length === 0 || value.length > MAXIMUM_REMOTE_PATH_CHARACTERS || value.includes("\0")
    || value.includes("\r") || value.includes("\n");
}

function invalidText(value: string, maximum: number): boolean {
  return value.trim().length === 0 || value.length > maximum || FORBIDDEN_TEXT.test(value);
}

function invalidToken(value: string, maximum: number): boolean {
  return value.trim() !== value || invalidText(value, maximum) || !/^[a-zA-Z0-9._:-]+$/u.test(value);
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) invalid(field);
}

function invalid(field: string): never {
  throw new Error(`The Joko node returned an invalid ${field}.`);
}
