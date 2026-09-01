import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rename } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface ManagedWorkspaceTrashRequest {
  readonly managedRoot: string;
  readonly workspaceRoot: string;
  readonly targetId: string;
  readonly operationId: string;
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
  if (isSameOrDescendant(trashRoot, workspaceRoot)) {
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
    if (await pathExists(workspaceRoot)) {
      throw new Error("Managed workspace trash destination already exists while the source is still present.");
    }
    await assertCanonicalDirectory(trashedPath, "Trashed managed workspace");
    return { originalRoot: workspaceRoot, trashRoot, trashedPath };
  }

  await assertCanonicalDirectory(workspaceRoot, "Managed workspace");
  await rename(workspaceRoot, trashedPath);
  await assertCanonicalDirectory(trashedPath, "Trashed managed workspace");
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

async function assertCanonicalDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
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

function isSameOrDescendant(root: string, candidate: string): boolean {
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
