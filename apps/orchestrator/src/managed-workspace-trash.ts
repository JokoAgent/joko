import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rename } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ManagedTargetTrashIntent, OperationalStore } from "@joko/store";

type DirectoryIdentity = ManagedTargetTrashIntent["directory"];

export interface ManagedWorkspaceTrashRequest {
  readonly managedRoot: string;
  readonly workspaceRoot: string;
  readonly targetId: string;
  readonly operationId: string;
  readonly beforeMove?: (directory: DirectoryIdentity, trashedPath: string) => void;
}

export interface ManagedWorkspaceTrashResult {
  readonly originalRoot: string;
  readonly trashRoot: string;
  readonly trashedPath: string;
}

/**
 * Atomically moves a service-owned workspace to a recoverable trash folder.
 *
 * Both roots must already be canonical absolute directories.  Requiring the
 * workspace to be a strict descendant of the configured managed root prevents
 * a product flag or stale database row from ever deleting a user project.  A
 * deterministic destination lets startup diagnostics reconcile the narrow
 * rename/Operation-commit crash window without replaying the external effect.
 */
export async function moveManagedWorkspaceToTrash(
  request: ManagedWorkspaceTrashRequest
): Promise<ManagedWorkspaceTrashResult> {
  const managedRoot = normalizedAbsolute(request.managedRoot, "Managed workspace root");
  const workspaceRoot = normalizedAbsolute(request.workspaceRoot, "Managed workspace");
  requireOpaqueId(request.targetId, "Target ID");
  requireOpaqueId(request.operationId, "Operation ID");

  await assertCanonicalDirectory(managedRoot, "Managed workspace root");
  if (!isStrictDescendant(managedRoot, workspaceRoot)) {
    throw new Error("Managed workspace deletion target is outside the configured managed root.");
  }

  const trashRoot = resolve(managedRoot, ".trash");
  if (!isStrictDescendant(managedRoot, trashRoot)) {
    throw new Error("Managed workspace trash path escaped its configured root.");
  }
  if (managedWorkspaceContainsPath(trashRoot, workspaceRoot)) {
    throw new Error("A workspace already inside managed trash cannot be deleted again.");
  }
  await mkdir(trashRoot, { recursive: true, mode: 0o700 });
  await assertCanonicalDirectory(trashRoot, "Managed workspace trash");

  const trashedPath = managedWorkspaceTrashPath(request);
  if (!isStrictDescendant(trashRoot, trashedPath)) {
    throw new Error("Managed workspace trash destination escaped its configured root.");
  }
  const destination = await lstat(trashedPath).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (destination !== undefined) {
    if (request.beforeMove !== undefined) throw new Error("The original workspace move requires its recorded receipt.");
    if (await pathExists(workspaceRoot)) {
      throw new Error("Managed workspace trash destination already exists while the source is still present.");
    }
    await assertCanonicalDirectory(trashedPath, "Trashed managed workspace");
    return { originalRoot: workspaceRoot, trashRoot, trashedPath };
  }

  const directory = await assertCanonicalDirectory(workspaceRoot, "Managed workspace");
  if (request.beforeMove !== undefined && directory.inode === "0") throw new Error("The managed workspace has no stable directory identity.");
  request.beforeMove?.(directory, trashedPath);
  await rename(workspaceRoot, trashedPath);
  const moved = await assertCanonicalDirectory(trashedPath, "Trashed managed workspace");
  if (request.beforeMove !== undefined && !sameDirectory(directory, moved)) throw new Error("The managed workspace changed during the move.");
  return { originalRoot: workspaceRoot, trashRoot, trashedPath };
}

export function managedWorkspaceTrashPath(request: ManagedWorkspaceTrashRequest): string {
  const managedRoot = normalizedAbsolute(request.managedRoot, "Managed workspace root");
  const digest = createHash("sha256")
    .update(request.targetId)
    .update("\0")
    .update(request.operationId)
    .digest("hex")
    .slice(0, 40);
  return resolve(managedRoot, ".trash", `workspace-${digest}`);
}

/** Inspect the original two paths without repeating the external effect. */
export async function inspectManagedWorkspaceTrash(
  managedRoot: string, targetId: string, intent: ManagedTargetTrashIntent
): Promise<"moved" | "not-moved" | "unknown"> {
  if (intent.managedRoot !== managedRoot || !isStrictDescendant(managedRoot, intent.workspaceRoot)
    || managedWorkspaceContainsPath(resolve(managedRoot, ".trash"), intent.workspaceRoot)
    || managedWorkspaceTrashPath({ managedRoot, targetId, workspaceRoot: intent.workspaceRoot, operationId: intent.operationId }) !== intent.trashPath) {
    return "unknown";
  }
  try {
    await assertCanonicalDirectory(managedRoot, "Managed workspace root");
    const sourceExists = await pathExists(intent.workspaceRoot);
    const trashExists = await pathExists(intent.trashPath);
    if (sourceExists === trashExists) return "unknown";
    const observed = await assertCanonicalDirectory(sourceExists ? intent.workspaceRoot : intent.trashPath, "Managed workspace evidence");
    if (!sameDirectory(intent.directory, observed)) return "unknown";
    // A separately recreated source or destination must remain untouched.
    if (await pathExists(sourceExists ? intent.trashPath : intent.workspaceRoot)) return "unknown";
    return sourceExists ? "not-moved" : "moved";
  } catch { return "unknown"; }
}

export async function recoverManagedWorkspaceTrash(store: OperationalStore, managedRoot: string): Promise<void> {
  for (const target of store.listTargets()) {
    if (!isRecord(target.metadata) || !Object.hasOwn(target.metadata, "pendingManagedWorkspaceTrash")) continue;
    const targetId = target.descriptor.id;
    try {
      const intent = readTrashIntent(target.metadata["pendingManagedWorkspaceTrash"]);
      const outcome = await inspectManagedWorkspaceTrash(managedRoot, targetId, intent);
      if (outcome === "unknown") throw new Error("The original workspace location is uncertain.");
      store.settleRecoveredManagedTargetTrash({ targetId, targetRevision: target.revision, intent, outcome });
    } catch {
      store.appendDiagnostic({ severity: "warning", component: "workspace", code: "MANAGED_WORKSPACE_TRASH_UNCONFIRMED",
        message: "The original managed project deletion could not be confirmed.", details: { targetId } });
    }
  }
}

function readTrashIntent(value: unknown): ManagedTargetTrashIntent {
  if (!isRecord(value) || value["format"] !== 1 || typeof value["operationId"] !== "string"
    || typeof value["bodyHash"] !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value["bodyHash"])
    || typeof value["workspaceRoot"] !== "string" || typeof value["managedRoot"] !== "string" || typeof value["trashPath"] !== "string"
    || typeof value["startedAt"] !== "number" || !Number.isSafeInteger(value["startedAt"])
    || value["previousState"] !== undefined && typeof value["previousState"] !== "string") throw new Error("The managed workspace recovery record is invalid.");
  const directory = value["directory"];
  if (!isRecord(directory) || ["device", "inode", "birthtime"].some(key => {
    const entry = directory[key];
    return typeof entry !== "string" || !/^-?[0-9]{1,32}$/u.test(entry);
  })) {
    throw new Error("The managed workspace directory identity is invalid.");
  }
  normalizedAbsolute(value["workspaceRoot"], "Managed workspace");
  return value as unknown as ManagedTargetTrashIntent;
}

async function assertCanonicalDirectory(path: string, label: string): Promise<DirectoryIdentity> {
  const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
    throw new Error(`${label} is unavailable.`, { cause: error });
  });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a link or special file.`);
  }
  const canonical = await realpath(path).catch((error: unknown) => {
    throw new Error(`${label} could not be resolved safely.`, { cause: error });
  });
  if (!samePath(canonical, path)) {
    throw new Error(`${label} contains a path alias, symlink, or junction.`);
  }
  const confirmed = await lstat(path, { bigint: true });
  if (!confirmed.isDirectory() || confirmed.isSymbolicLink() || confirmed.dev !== info.dev || confirmed.ino !== info.ino
    || confirmed.birthtimeNs !== info.birthtimeNs) throw new Error(`${label} changed while its identity was read.`);
  return { device: info.dev.toString(), inode: info.ino.toString(), birthtime: info.birthtimeNs.toString() };
}

function sameDirectory(first: DirectoryIdentity, second: DirectoryIdentity): boolean {
  return first.inode !== "0" && first.device === second.device && first.inode === second.inode && first.birthtime === second.birthtime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedAbsolute(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${label} must be a normalized absolute path.`);
  }
  return value;
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const fragment = relative(root, candidate);
  return fragment !== "" && fragment !== ".." && !fragment.startsWith(`..\\`) && !fragment.startsWith("../") && !isAbsolute(fragment);
}

export function managedWorkspaceContainsPath(root: string, candidate: string): boolean {
  return samePath(root, candidate) || isStrictDescendant(root, candidate);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function requireOpaqueId(value: string, label: string): void {
  if (value.trim() === "" || value.includes("\0") || value.length > 512) {
    throw new Error(`${label} is invalid.`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: unknown) => {
    if (isMissing(error)) return false;
    throw error;
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
