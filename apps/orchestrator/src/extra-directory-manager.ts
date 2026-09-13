import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { JokoError, type ApprovedDirectory } from "@joko/core";
import type { OperationalStore, SettingRecord, StoredTarget } from "@joko/store";

const SETTING_PREFIX = "extra_directory.";
const MAX_EXTRA_DIRECTORIES = 32;

export type ExtraDirectoryAccess = ApprovedDirectory["access"];

export interface ExtraDirectoryRecord extends ApprovedDirectory {
  readonly workspaceId: string;
  readonly targetId: string;
  readonly approved: true;
  readonly approvedAt: number;
  readonly updatedAt: number;
  readonly revision: bigint;
}

interface PersistedExtraDirectory {
  readonly id: string;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly path: string;
  readonly access: ExtraDirectoryAccess;
  readonly approved: true;
  readonly approvedAt: number;
}

/**
 * Authoritative service-node registry for paths explicitly approved by an
 * owner. Only canonical regular directories written by this manager are ever
 * projected or passed to an adapter.
 */
export class ExtraDirectoryManager {
  constructor(private readonly store: OperationalStore) {}

  async add(input: {
    readonly workspaceId: string;
    readonly serverPath: string;
    readonly access: ExtraDirectoryAccess;
  }): Promise<ExtraDirectoryRecord> {
    const target = this.requireWorkspace(input.workspaceId);
    const canonicalPath = await canonicalDirectory(input.serverPath);
    const existing = this.listForTarget(target.descriptor.id);
    const duplicate = existing.find((entry) => samePath(entry.path, canonicalPath));
    if (duplicate !== undefined) {
      if (duplicate.access === input.access) return duplicate;
      throw directoryError(
        "EXTRA_DIRECTORY_ALREADY_APPROVED",
        "The directory is already approved with a different access level.",
        "Remove the existing approval before adding it with another access level."
      );
    }
    if (existing.length >= MAX_EXTRA_DIRECTORIES) {
      throw directoryError(
        "EXTRA_DIRECTORY_LIMIT_REACHED",
        `A workspace can approve at most ${MAX_EXTRA_DIRECTORIES} extra directories.`,
        "Remove an unused directory approval and retry."
      );
    }
    const workspaceId = workspaceIdForTarget(target);
    const now = Date.now();
    const id = stableDirectoryId(target.descriptor.id, canonicalPath);
    const value: PersistedExtraDirectory = {
      id,
      workspaceId,
      targetId: target.descriptor.id,
      path: canonicalPath,
      access: input.access,
      approved: true,
      approvedAt: now
    };
    const setting = this.store.setSetting("target", target.descriptor.id, `${SETTING_PREFIX}${id}`, value, now);
    return fromSetting(setting, value);
  }

  remove(id: string): ExtraDirectoryRecord {
    const normalizedId = requiredId(id);
    for (const setting of this.store.listSettings("target")) {
      if (setting.key !== `${SETTING_PREFIX}${normalizedId}`) continue;
      const parsed = parseSetting(setting);
      if (parsed === undefined) continue;
      this.store.deleteSetting(setting.scopeType, setting.scopeId, setting.key);
      return parsed;
    }
    throw directoryError(
      "EXTRA_DIRECTORY_NOT_FOUND",
      "The approved extra directory does not exist.",
      "Refresh the workspace snapshot and select an existing directory approval."
    );
  }

  get(id: string): ExtraDirectoryRecord {
    const normalizedId = requiredId(id);
    const value = this.list().find((entry) => entry.id === normalizedId);
    if (value === undefined) {
      throw directoryError(
        "EXTRA_DIRECTORY_NOT_FOUND",
        "The approved extra directory does not exist.",
        "Refresh the workspace snapshot and select an existing directory approval."
      );
    }
    return value;
  }

  list(): readonly ExtraDirectoryRecord[] {
    return this.store.listSettings("target")
      .filter((setting) => setting.key.startsWith(SETTING_PREFIX))
      .map(parseSetting)
      .filter((value): value is ExtraDirectoryRecord => value !== undefined)
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId) || left.path.localeCompare(right.path));
  }

  listForTarget(targetId: string): readonly ExtraDirectoryRecord[] {
    return this.list().filter((entry) => entry.targetId === targetId);
  }

  listForWorkspace(workspaceId: string): readonly ExtraDirectoryRecord[] {
    return this.list().filter((entry) => entry.workspaceId === workspaceId);
  }

  resolveSelection(targetId: string, ids: readonly string[] | undefined): readonly ExtraDirectoryRecord[] {
    const available = this.listForTarget(targetId);
    if (ids === undefined) return available;
    const byId = new Map(available.map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    return ids.map((rawId) => {
      const id = requiredId(rawId);
      if (seen.has(id)) {
        throw directoryError(
          "EXTRA_DIRECTORY_DUPLICATE_SELECTION",
          "An extra directory was selected more than once.",
          "Remove duplicate extra-directory IDs and retry."
        );
      }
      seen.add(id);
      const entry = byId.get(id);
      if (entry === undefined) {
        throw directoryError(
          "EXTRA_DIRECTORY_NOT_APPROVED",
          "A selected extra directory is not approved for this workspace.",
          "Refresh the workspace and select only its approved directories."
        );
      }
      return entry;
    });
  }

  private requireWorkspace(workspaceId: string): StoredTarget {
    const normalized = workspaceId.trim();
    if (normalized === "") {
      throw directoryError("EXTRA_DIRECTORY_WORKSPACE_REQUIRED", "Workspace ID is required.", "Select a workspace and retry.");
    }
    const target = this.store.listTargets().find((candidate) => workspaceIdForTarget(candidate) === normalized);
    if (target === undefined) {
      throw directoryError(
        "EXTRA_DIRECTORY_WORKSPACE_NOT_FOUND",
        "The workspace does not exist on this service node.",
        "Refresh targets and select an existing workspace."
      );
    }
    return target;
  }
}

async function canonicalDirectory(rawPath: string): Promise<string> {
  const candidate = rawPath.trim();
  if (!isAbsolute(candidate)) {
    throw directoryError(
      "EXTRA_DIRECTORY_PATH_NOT_ABSOLUTE",
      "An extra directory must be an absolute service-node path.",
      "Choose the directory on the service node and retry with its absolute path."
    );
  }
  const normalized = resolve(candidate);
  let info;
  try {
    info = await lstat(normalized);
  } catch (cause) {
    throw directoryError(
      "EXTRA_DIRECTORY_UNAVAILABLE",
      "The extra directory is unavailable on the service node.",
      "Restore the directory and retry.",
      cause
    );
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw directoryError(
      "EXTRA_DIRECTORY_UNSAFE_TYPE",
      "An extra directory must be a regular directory, not a symlink, junction, file, or special node.",
      "Choose a canonical regular directory."
    );
  }
  let canonical: string;
  try {
    canonical = await realpath(normalized);
  } catch (cause) {
    throw directoryError(
      "EXTRA_DIRECTORY_RESOLUTION_FAILED",
      "The extra directory could not be resolved safely.",
      "Repair path aliases and retry with the canonical directory.",
      cause
    );
  }
  if (!samePath(normalized, canonical)) {
    throw directoryError(
      "EXTRA_DIRECTORY_ALIAS_DENIED",
      "The extra directory path contains a symlink, junction, or non-canonical alias.",
      "Retry with the canonical regular directory path."
    );
  }
  return canonical;
}

function parseSetting(setting: SettingRecord): ExtraDirectoryRecord | undefined {
  if (!isRecord(setting.value)) return undefined;
  const value = setting.value;
  const id = typeof value["id"] === "string" ? value["id"] : undefined;
  const workspaceId = typeof value["workspaceId"] === "string" ? value["workspaceId"] : undefined;
  const targetId = typeof value["targetId"] === "string" ? value["targetId"] : undefined;
  const path = typeof value["path"] === "string" ? value["path"] : undefined;
  const access = value["access"] === "read_only" || value["access"] === "read_write" ? value["access"] : undefined;
  const approvedAt = typeof value["approvedAt"] === "number" && Number.isSafeInteger(value["approvedAt"])
    ? value["approvedAt"]
    : undefined;
  if (
    id === undefined || workspaceId === undefined || targetId === undefined || path === undefined ||
    access === undefined || approvedAt === undefined || value["approved"] !== true ||
    setting.scopeId !== targetId || setting.key !== `${SETTING_PREFIX}${id}` ||
    !isAbsolute(path) || resolve(path) !== path
  ) return undefined;
  return {
    id,
    workspaceId,
    targetId,
    path,
    access,
    approved: true,
    approvedAt,
    updatedAt: setting.updatedAt,
    revision: setting.revision
  };
}

function fromSetting(setting: SettingRecord<PersistedExtraDirectory>, value: PersistedExtraDirectory): ExtraDirectoryRecord {
  return { ...value, updatedAt: setting.updatedAt, revision: setting.revision };
}

function workspaceIdForTarget(target: StoredTarget): string {
  if (isRecord(target.metadata) && typeof target.metadata["workspaceId"] === "string" && target.metadata["workspaceId"].trim() !== "") {
    return target.metadata["workspaceId"];
  }
  return target.descriptor.id;
}

function stableDirectoryId(targetId: string, path: string): string {
  return `extra-${createHash("sha256").update(targetId).update("\0").update(normalizedPathKey(path)).digest("hex").slice(0, 24)}`;
}

function requiredId(value: string): string {
  const normalized = value.trim();
  if (!/^extra-[a-f0-9]{24}$/.test(normalized)) {
    throw directoryError(
      "EXTRA_DIRECTORY_ID_INVALID",
      "The extra-directory ID is invalid.",
      "Refresh the workspace snapshot and retry with an authoritative ID."
    );
  }
  return normalized;
}

function normalizedPathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return normalizedPathKey(left) === normalizedPathKey(right);
}

function directoryError(code: string, message: string, recovery: string, cause?: unknown): JokoError {
  return new JokoError({
    code,
    message,
    phase: "workspace",
    retryable: false,
    stateMayHaveChanged: false,
    recovery
  }, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
