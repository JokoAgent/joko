import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { WorktreeServiceError, type WorktreeErrorCode } from "./errors.js";
import { WorktreeOperationControl } from "./operation.js";
import type { WorktreeSourceResolution } from "./types.js";

const STATE_FILE_NAME = "state.json";
const MAXIMUM_STATE_BYTES = 10 * 1024 * 1024;
const ENTRY_ID_PATTERN = /^[a-f0-9]{24}$/u;
const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{20}$/u;
const SLOT_ID_PATTERN = /^wt-[a-f0-9]{24}$/u;

export type ManagedWorktreeStatus =
  | "active"
  | "creating"
  | "destroying"
  | "failed"
  | "preserved"
  | "restored"
  | "restoring";

export type ManagedWorktreeArchiveSnapshot =
  | { readonly kind: "clean"; readonly branchHeadSha: string }
  | { readonly kind: "dirty"; readonly sha: string; readonly branchHeadSha: string };

export interface ManagedWorktreeOwnerRefTransition {
  readonly sha: string;
  readonly previousSha?: string;
}

export interface ManagedWorktreeDeletionTransfer {
  readonly stashSha: string;
}

export interface ManagedWorktreeCheckoutCleanup {
  readonly sha: string;
}

export interface ManagedWorktreeEntry {
  readonly id: string;
  readonly repositoryId: string;
  readonly slotId: string;
  readonly path: string;
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly source: WorktreeSourceResolution;
  readonly sessionId: string;
  readonly status: ManagedWorktreeStatus;
  /** Durable evidence distinguishing a clean archive from one that requires
   * an exact owner-ref object for tracked/index/untracked recovery. */
  readonly archiveSnapshot?: ManagedWorktreeArchiveSnapshot;
  /** State-first fence for creating or moving the owner ref. When previousSha
   * is absent the exact owner ref is expected not to exist yet. */
  readonly pendingOwnerRefTransition?: ManagedWorktreeOwnerRefTransition;
  /** Exact owner snapshot protecting a destructive reset/clean phase. */
  readonly checkoutCleanup?: ManagedWorktreeCheckoutCleanup;
  /** State-first transfer of a deleted worktree snapshot into the user's stash.
   * The exact object, never its subject or position, authorizes ref retirement. */
  readonly deletionTransfer?: ManagedWorktreeDeletionTransfer;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface PersistedWorktreeState {
  readonly format: 1;
  readonly entries: readonly ManagedWorktreeEntry[];
}

export class WorktreeStateStore {
  readonly root: string;
  readonly statePath: string;
  readonly #entries = new Map<string, ManagedWorktreeEntry>();

  private constructor(root: string, state: PersistedWorktreeState) {
    this.root = root;
    this.statePath = join(root, STATE_FILE_NAME);
    for (const entry of state.entries) this.#entries.set(entry.id, freezeEntry(entry));
  }

  static async open(storageRoot: string, control: WorktreeOperationControl): Promise<WorktreeStateStore> {
    const root = await prepareStorageRoot(storageRoot, control);
    const statePath = join(root, STATE_FILE_NAME);
    let state: PersistedWorktreeState;
    try {
      const info = await lstat(statePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAXIMUM_STATE_BYTES) {
        throw new WorktreeServiceError("STATE_CORRUPT", "The worktree state file is unsafe.");
      }
      const canonical = await realpath(statePath);
      if (!samePath(canonical, statePath)) {
        throw new WorktreeServiceError("STATE_CORRUPT", "The worktree state file contains a path alias.");
      }
      const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
      const handle = await open(statePath, flags);
      let text: string;
      try {
        const openedInfo = await handle.stat();
        if (!openedInfo.isFile() || openedInfo.size > MAXIMUM_STATE_BYTES) {
          throw new WorktreeServiceError("STATE_CORRUPT", "The opened worktree state file is unsafe.");
        }
        text = await handle.readFile({ encoding: "utf8" });
      } finally {
        await handle.close();
      }
      if (Buffer.byteLength(text, "utf8") > MAXIMUM_STATE_BYTES) {
        throw new WorktreeServiceError("STATE_CORRUPT", "The worktree state file exceeds its safe limit.");
      }
      state = validateState(JSON.parse(text) as unknown);
    } catch (error) {
      if (isMissing(error)) state = { format: 1, entries: [] };
      else if (error instanceof WorktreeServiceError) throw error;
      else throw new WorktreeServiceError("STATE_CORRUPT", "The worktree state file is invalid.");
    }
    const store = new WorktreeStateStore(root, state);
    if (!(await fileExists(statePath))) await store.persist(control);
    return store;
  }

  entries(): readonly ManagedWorktreeEntry[] {
    return [...this.#entries.values()].sort((left, right) => left.createdAt - right.createdAt);
  }

  get(id: string): ManagedWorktreeEntry | undefined {
    return this.#entries.get(id);
  }

  async set(entry: ManagedWorktreeEntry, control: WorktreeOperationControl): Promise<void> {
    control.check();
    const accepted = validateEntry(entry);
    const previous = this.#entries.get(accepted.id);
    this.#entries.set(accepted.id, freezeEntry(accepted));
    try {
      await this.persist(control);
    } catch (error) {
      if (previous === undefined) this.#entries.delete(accepted.id);
      else this.#entries.set(previous.id, previous);
      throw error;
    }
  }

  async delete(id: string, control: WorktreeOperationControl): Promise<void> {
    control.check();
    const previous = this.#entries.get(id);
    if (previous === undefined) return;
    this.#entries.delete(id);
    try {
      await this.persist(control);
    } catch (error) {
      this.#entries.set(id, previous);
      throw error;
    }
  }

  private async persist(control: WorktreeOperationControl): Promise<void> {
    control.check();
    await validateOrdinaryDirectory(
      this.root,
      "STORAGE_UNSAFE",
      "The worktree storage root changed unsafely."
    );
    const state: PersistedWorktreeState = { format: 1, entries: this.entries() };
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_STATE_BYTES) {
      throw new WorktreeServiceError("STATE_CORRUPT", "The worktree state exceeds its safe limit.");
    }
    const temporary = join(this.root, `.state-${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      control.check();
      await rename(temporary, this.statePath);
      renamed = true;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    if (!renamed) throw new WorktreeServiceError("INTERNAL", "The worktree state was not committed.");
    try {
      const directory = await open(this.root, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      // Some Windows filesystems do not support directory fsync; the file rename remains atomic.
    }
  }
}

export async function validateOrdinaryDirectory(
  candidate: string,
  code: WorktreeErrorCode,
  message: string
): Promise<string> {
  let info;
  try {
    info = await lstat(candidate);
  } catch {
    throw new WorktreeServiceError(code, message);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WorktreeServiceError(code, message);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw new WorktreeServiceError(code, message);
  }
  if (!samePath(canonical, resolve(candidate))) throw new WorktreeServiceError(code, message);
  return resolve(candidate);
}

export function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replace(/[\\/]+$/u, "");
  const normalizedRight = resolve(right).replace(/[\\/]+$/u, "");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function pathInside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function isEntryLayoutSafe(root: string, entry: ManagedWorktreeEntry): boolean {
  if (!REPOSITORY_ID_PATTERN.test(entry.repositoryId) || !SLOT_ID_PATTERN.test(entry.slotId)) return false;
  return samePath(entry.path, join(root, entry.repositoryId, entry.slotId)) && pathInside(root, entry.path);
}

export function validEntryId(value: string): boolean {
  return ENTRY_ID_PATTERN.test(value);
}

async function prepareStorageRoot(storageRoot: string, control: WorktreeOperationControl): Promise<string> {
  if (typeof storageRoot !== "string" || storageRoot.length === 0 || storageRoot.length > 32_768
    || storageRoot.includes("\0") || !isAbsolute(storageRoot)) {
    throw new WorktreeServiceError("INVALID_ARGUMENT", "storageRoot must be an absolute bounded path.", {
      field: "storageRoot"
    });
  }
  const root = resolve(storageRoot);
  if (dirname(root) === root) {
    throw new WorktreeServiceError("STORAGE_UNSAFE", "A filesystem root cannot be used for worktree storage.");
  }
  control.check();
  await mkdir(root, { recursive: true });
  return validateOrdinaryDirectory(root, "STORAGE_UNSAFE", "The worktree storage root is unsafe.");
}

function validateState(value: unknown): PersistedWorktreeState {
  if (!isRecord(value) || value["format"] !== 1 || !Array.isArray(value["entries"])) {
    throw new WorktreeServiceError("STATE_CORRUPT", "The worktree state has an unsupported format.");
  }
  if (value["entries"].length > 100_000) {
    throw new WorktreeServiceError("STATE_CORRUPT", "The worktree state contains too many entries.");
  }
  const entries = value["entries"].map(validateEntry);
  const ids = new Set<string>();
  const sessions = new Set<string>();
  const paths = new Set<string>();
  for (const entry of entries) {
    const pathKey = process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
    if (ids.has(entry.id) || paths.has(pathKey) || sessions.has(entry.sessionId)) {
      throw new WorktreeServiceError("STATE_CORRUPT", "The worktree state contains duplicate ownership.");
    }
    ids.add(entry.id);
    paths.add(pathKey);
    sessions.add(entry.sessionId);
  }
  return { format: 1, entries };
}

function validateEntry(value: unknown): ManagedWorktreeEntry {
  if (!isRecord(value)) throw new WorktreeServiceError("STATE_CORRUPT", "A worktree state entry is invalid.");
  const id = stringField(value, "id");
  const repositoryId = stringField(value, "repositoryId");
  const slotId = stringField(value, "slotId");
  const path = stringField(value, "path");
  const repositoryRoot = stringField(value, "repositoryRoot");
  const branch = stringField(value, "branch");
  const sessionId = stringField(value, "sessionId");
  const status = value["status"];
  const createdAt = value["createdAt"];
  const updatedAt = value["updatedAt"];
  if (!validEntryId(id) || !REPOSITORY_ID_PATTERN.test(repositoryId) || !SLOT_ID_PATTERN.test(slotId)
    || !isAbsolute(path) || !isAbsolute(repositoryRoot) || path.includes("\0") || repositoryRoot.includes("\0")
    || !isStatus(status) || !Number.isSafeInteger(createdAt) || !Number.isSafeInteger(updatedAt)
    || (createdAt as number) < 0 || (updatedAt as number) < (createdAt as number)) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A worktree state entry contains invalid fields.");
  }
  const source = validateSource(value["source"]);
  const archiveSnapshot = validateArchiveSnapshot(value["archiveSnapshot"]);
  const pendingOwnerRefTransition = validateOwnerRefTransition(value["pendingOwnerRefTransition"]);
  const checkoutCleanup = validateCheckoutCleanup(value["checkoutCleanup"]);
  const deletionTransfer = validateDeletionTransfer(value["deletionTransfer"]);
  if (pendingOwnerRefTransition !== undefined
    && (archiveSnapshot?.kind !== "dirty" || archiveSnapshot.sha !== pendingOwnerRefTransition.sha)) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A pending owner ref does not match its dirty archive identity.");
  }
  if (deletionTransfer !== undefined
    && (archiveSnapshot?.kind !== "dirty" || archiveSnapshot.sha !== deletionTransfer.stashSha)) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A deletion transfer does not match its dirty archive identity.");
  }
  if (checkoutCleanup !== undefined
    && (archiveSnapshot?.kind !== "dirty" || archiveSnapshot.sha !== checkoutCleanup.sha)) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A checkout cleanup does not match its dirty archive identity.");
  }
  if ([pendingOwnerRefTransition, checkoutCleanup, deletionTransfer]
    .filter((candidate) => candidate !== undefined).length > 1) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A worktree has conflicting durable transition phases.");
  }
  if (status === "preserved" && archiveSnapshot === undefined) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A preserved worktree has no clean-or-dirty archive identity.");
  }
  if ((status === "restoring" || status === "restored") && archiveSnapshot?.kind !== "dirty") {
    throw new WorktreeServiceError("STATE_CORRUPT", "A restoring worktree has no dirty archive identity.");
  }
  if (!/^joko\/ephemeral\/[a-f0-9]{12}-[a-f0-9]{8}$/u.test(branch)
    || sessionId.length === 0 || sessionId.includes("\0") || /[\r\n]/u.test(sessionId)) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A worktree state entry has invalid ownership metadata.");
  }
  return {
    id,
    repositoryId,
    slotId,
    path: resolve(path),
    repositoryRoot: resolve(repositoryRoot),
    branch,
    source,
    sessionId,
    status,
    ...(archiveSnapshot === undefined ? {} : { archiveSnapshot }),
    ...(pendingOwnerRefTransition === undefined ? {} : { pendingOwnerRefTransition }),
    ...(checkoutCleanup === undefined ? {} : { checkoutCleanup }),
    ...(deletionTransfer === undefined ? {} : { deletionTransfer }),
    createdAt: createdAt as number,
    updatedAt: updatedAt as number
  };
}

function validateSource(value: unknown): WorktreeSourceResolution {
  if (!isRecord(value)) throw new WorktreeServiceError("STATE_CORRUPT", "A worktree source record is invalid.");
  const ref = stringField(value, "ref");
  const commit = stringField(value, "commit");
  const strategy = value["strategy"];
  const refreshed = value["refreshed"];
  const remote = optionalStringField(value, "remote");
  const reason = optionalStringField(value, "reason");
  if (!/^[a-f0-9]{40,64}$/u.test(commit) || typeof refreshed !== "boolean" || !isStrategy(strategy)) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A worktree source record contains invalid fields.");
  }
  return {
    ref,
    commit,
    refreshed,
    strategy,
    ...(remote === undefined ? {} : { remote }),
    ...(reason === undefined ? {} : { reason })
  };
}

function validateArchiveSnapshot(value: unknown): ManagedWorktreeArchiveSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A worktree archive snapshot record is invalid.");
  }
  const branchHeadSha = validateOptionalObjectId(value["branchHeadSha"]);
  if (branchHeadSha === undefined) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A worktree archive snapshot has no branch-tip identity.");
  }
  if (value["kind"] === "clean" && Object.keys(value).length === 2) {
    return { kind: "clean", branchHeadSha };
  }
  if (value["kind"] === "dirty" && Object.keys(value).length === 3
    && typeof value["sha"] === "string" && /^[a-f0-9]{40,64}$/u.test(value["sha"])) {
    return { kind: "dirty", sha: value["sha"], branchHeadSha };
  }
  throw new WorktreeServiceError("STATE_CORRUPT", "A worktree archive snapshot record is invalid.");
}

function validateOptionalObjectId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/u.test(value)) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A worktree cleanup snapshot identity is invalid.");
  }
  return value;
}

function validateOwnerRefTransition(value: unknown): ManagedWorktreeOwnerRefTransition | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "sha" && key !== "previousSha")) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A pending owner-ref transition is invalid.");
  }
  const sha = validateOptionalObjectId(value["sha"]);
  const previousSha = validateOptionalObjectId(value["previousSha"]);
  if (sha === undefined || previousSha === sha) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A pending owner-ref transition is invalid.");
  }
  return { sha, ...(previousSha === undefined ? {} : { previousSha }) };
}

function validateDeletionTransfer(value: unknown): ManagedWorktreeDeletionTransfer | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A worktree deletion transfer is invalid.");
  }
  const stashSha = validateOptionalObjectId(value["stashSha"]);
  if (stashSha === undefined) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A worktree deletion transfer is invalid.");
  }
  return { stashSha };
}

function validateCheckoutCleanup(value: unknown): ManagedWorktreeCheckoutCleanup | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A worktree checkout cleanup is invalid.");
  }
  const sha = validateOptionalObjectId(value["sha"]);
  if (sha === undefined) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A worktree checkout cleanup is invalid.");
  }
  return { sha };
}

function freezeEntry(entry: ManagedWorktreeEntry): ManagedWorktreeEntry {
  return Object.freeze({
    ...entry,
    source: Object.freeze({ ...entry.source }),
    ...(entry.archiveSnapshot === undefined
      ? {}
      : { archiveSnapshot: Object.freeze({ ...entry.archiveSnapshot }) }),
    ...(entry.pendingOwnerRefTransition === undefined
      ? {}
      : { pendingOwnerRefTransition: Object.freeze({ ...entry.pendingOwnerRefTransition }) }),
    ...(entry.checkoutCleanup === undefined
      ? {}
      : { checkoutCleanup: Object.freeze({ ...entry.checkoutCleanup }) }),
    ...(entry.deletionTransfer === undefined
      ? {}
      : { deletionTransfer: Object.freeze({ ...entry.deletionTransfer }) })
  });
}

function stringField(value: Readonly<Record<string, unknown>>, field: string): string {
  const selected = value[field];
  if (typeof selected !== "string" || selected.length === 0 || selected.length > 32_768 || selected.includes("\0")) {
    throw new WorktreeServiceError("STATE_CORRUPT", "A worktree state string field is invalid.", { field });
  }
  return selected;
}

function optionalStringField(value: Readonly<Record<string, unknown>>, field: string): string | undefined {
  return value[field] === undefined ? undefined : stringField(value, field);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function isStatus(value: unknown): value is ManagedWorktreeStatus {
  return value === "active" || value === "creating" || value === "destroying"
    || value === "failed" || value === "preserved" || value === "restored" || value === "restoring";
}

function isStrategy(value: unknown): value is WorktreeSourceResolution["strategy"] {
  return value === "explicit" || value === "remote_default_refreshed"
    || value === "remote_default_local" || value === "current_branch"
    || value === "local_default" || value === "head";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw new WorktreeServiceError("STATE_CORRUPT", "The worktree state file could not be inspected safely.");
  }
}
