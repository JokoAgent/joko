import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isWorktreeServiceError, WorktreeServiceError } from "./errors.js";
import { runGit } from "./git.js";
import {
  DEFAULT_WORKTREE_OPERATION_TIMEOUT_MS,
  WorktreeOperationControl,
  validateWorktreeTimeout
} from "./operation.js";
import {
  attachedWorktreeBranch,
  branchExists,
  hasUnsafeTrackedIndexFlags,
  isWorktreeCompletelyClean,
  listWorktreeSources,
  probeWorktreeCwd,
  resolveWorktreeSource,
  worktreeHeadCommit
} from "./repository.js";
import {
  isEntryLayoutSafe,
  pathInside,
  samePath,
  validateOrdinaryDirectory,
  WorktreeStateStore,
  type ManagedWorktreeEntry
} from "./state.js";
import {
  MAXIMUM_WORKTREE_SESSION_ID_CHARACTERS,
  type WorktreeAcquireRequest,
  type WorktreeAcquisition,
  type WorktreeCallOptions,
  type WorktreeCwdDetection,
  type WorktreeInitialization,
  type WorktreeInitializeOptions,
  type WorktreeLease,
  type WorktreeRelease,
  type WorktreeReleaseOptions,
  type WorktreeResult,
  type WorktreeServiceSnapshot,
  type WorktreeSourceResolution,
  type WorktreeSourceOption,
  type WorktreeSweepRecord
} from "./types.js";

const MANAGED_BRANCH_PREFIX = "joko/ephemeral";
const SNAPSHOT_REF_PREFIX = "refs/joko/worktree-snapshots";
const ENTRY_ID_PATTERN = /^[a-f0-9]{24}$/u;

export interface EphemeralWorktreeServiceOptions {
  readonly storageRoot: string;
  readonly operationTimeoutMs?: number;
  readonly now?: () => number;
}

interface DestructionResult {
  readonly pathRemoved: boolean;
  readonly branchPreserved: boolean;
}

const SNAPSHOT_IDENTITY_ENVIRONMENT = Object.freeze({
  GIT_AUTHOR_NAME: "Joko Workspace Snapshot",
  GIT_AUTHOR_EMAIL: "workspace-snapshot@invalid.example",
  GIT_COMMITTER_NAME: "Joko Workspace Snapshot",
  GIT_COMMITTER_EMAIL: "workspace-snapshot@invalid.example"
});

/** Device-local lifecycle owner for isolated, disposable Git worktrees. */
export class EphemeralWorktreeService {
  readonly #storageRoot: string;
  readonly #operationTimeoutMs: number;
  readonly #now: () => number;
  #store: WorktreeStateStore | undefined;
  #initialized = false;
  #disposed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: EphemeralWorktreeServiceOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("Worktree service options are required.");
    }
    if (typeof options.storageRoot !== "string" || options.storageRoot.length === 0) {
      throw new TypeError("Worktree storageRoot is required.");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("Worktree now must be a function.");
    }
    this.#storageRoot = options.storageRoot;
    this.#operationTimeoutMs = validateWorktreeTimeout(
      options.operationTimeoutMs ?? DEFAULT_WORKTREE_OPERATION_TIMEOUT_MS,
      "operationTimeoutMs"
    );
    this.#now = options.now ?? Date.now;
  }

  initialize(options?: WorktreeInitializeOptions): Promise<WorktreeResult<WorktreeInitialization>> {
    return this.#serialize(options, false, async (control) => {
      if (this.#initialized) {
        const store = this.#requireStore();
        return {
          storageRoot: store.root,
          removed: 0,
          preserved: store.entries().length,
          records: store.entries().map((entry) => sweepRecord(entry, "preserved", "service_already_initialized"))
        };
      }
      const store = await WorktreeStateStore.open(this.#storageRoot, control);
      this.#store = store;
      const retained = validateRetainedSessionIds(options?.retainSessionIds);
      const preservedOwners = validateRetainedSessionIds(options?.preserveSessionIds);
      if ([...retained].some((sessionId) => preservedOwners.has(sessionId))) {
        throw invalidArgument(
          "preserveSessionIds",
          "A Session cannot be both live and archived during worktree recovery."
        );
      }
      const records: WorktreeSweepRecord[] = [];
      for (const entry of store.entries()) {
        control.check();
        try {
          if (preservedOwners.has(entry.sessionId)) {
            const release = await this.#releaseEntry(entry, true, control);
            records.push(sweepRecord(entry, "preserved", release.reason ?? "archived_session"));
            continue;
          }
          if (retained.has(entry.sessionId)) {
            const active = await this.#restoreEntry(entry, control);
            records.push(sweepRecord(active, "preserved", "live_session"));
            continue;
          }
          const release = await this.#releaseEntry(entry, false, control);
          records.push(sweepRecord(
            entry,
            release.status === "destroyed" || release.status === "not_found" ? "removed" : "preserved",
            release.reason
          ));
        } catch (error) {
          const current = store.get(entry.id) ?? entry;
          await store.set(preservedEntry(current, this.#now()), control)
            .catch(() => undefined);
          records.push(sweepRecord(entry, "preserved", errorCode(error)));
        }
      }
      this.#initialized = true;
      return Object.freeze({
        storageRoot: store.root,
        removed: records.filter((record) => record.status === "removed").length,
        preserved: records.filter((record) => record.status === "preserved").length,
        records: Object.freeze(records)
      });
    });
  }

  listSources(cwd: string, options?: WorktreeCallOptions): Promise<WorktreeResult<readonly WorktreeSourceOption[]>> {
    return this.#serialize(options, true, async (control) => {
      const detection = await probeWorktreeCwd(cwd, control);
      if (detection.isLinkedWorktree) {
        throw new WorktreeServiceError("CWD_IS_WORKTREE", "A linked worktree cannot be used as a worktree base.");
      }
      this.#assertRepositorySeparated(detection.repositoryRoot);
      return listWorktreeSources(detection, control);
    });
  }

  detectCwd(cwd: string, options?: WorktreeCallOptions): Promise<WorktreeResult<WorktreeCwdDetection>> {
    return this.#serialize(options, true, (control) => probeWorktreeCwd(cwd, control));
  }

  resolveSource(
    input: { readonly cwd: string; readonly sourceRef?: string; readonly refreshRemote?: boolean },
    options?: WorktreeCallOptions
  ): Promise<WorktreeResult<WorktreeSourceResolution>> {
    return this.#serialize(options, true, async (control) => {
      if (!isRecord(input) || hasUnsupportedKeys(input, ["cwd", "sourceRef", "refreshRemote"])) {
        throw invalidArgument("input", "The source-resolution request is invalid.");
      }
      if (input.refreshRemote !== undefined && typeof input.refreshRemote !== "boolean") {
        throw invalidArgument("refreshRemote", "refreshRemote must be a boolean.");
      }
      const detection = await probeWorktreeCwd(input.cwd, control);
      if (detection.isLinkedWorktree) {
        throw new WorktreeServiceError("CWD_IS_WORKTREE", "A linked worktree cannot be used as a worktree base.");
      }
      this.#assertRepositorySeparated(detection.repositoryRoot);
      return resolveWorktreeSource(detection, input.sourceRef, input.refreshRemote === true, control);
    });
  }

  acquire(
    request: WorktreeAcquireRequest,
    options?: WorktreeCallOptions
  ): Promise<WorktreeResult<WorktreeAcquisition>> {
    return this.#serialize(options, true, async (control) => {
      const accepted = validateAcquireRequest(request);
      const store = this.#requireStore();
      const existing = store.entries().find((entry) => entry.sessionId === accepted.sessionId);
      if (existing !== undefined) {
        const detection = await probeWorktreeCwd(accepted.cwd, control);
        if (existing.status === "creating" || !samePath(existing.repositoryRoot, detection.repositoryRoot)) {
          throw new WorktreeServiceError(
            "SESSION_CONFLICT",
            "The session already owns a different worktree lease.",
            { sessionId: accepted.sessionId }
          );
        }
        const active = await this.#restoreEntry(existing, control);
        return Object.freeze({ lease: leaseFromEntry(active), existing: true });
      }

      const detection = await probeWorktreeCwd(accepted.cwd, control);
      if (detection.isLinkedWorktree) {
        throw new WorktreeServiceError("CWD_IS_WORKTREE", "A linked worktree cannot be used as a worktree base.");
      }
      this.#assertRepositorySeparated(detection.repositoryRoot);
      const source = await resolveWorktreeSource(
        detection,
        accepted.sourceRef,
        accepted.refreshRemote === true,
        control
      );

      const created = await this.#createEntry(detection, accepted.sessionId, source, control);
      return Object.freeze({ lease: leaseFromEntry(created), existing: false });
    });
  }

  release(sessionId: string, options?: WorktreeReleaseOptions): Promise<WorktreeResult<WorktreeRelease>> {
    return this.#serialize(options, true, async (control) => {
      if (options?.retainForRestore !== undefined && typeof options.retainForRestore !== "boolean") {
        throw invalidArgument("retainForRestore", "retainForRestore must be a boolean.");
      }
      const acceptedSessionId = validateSessionId(sessionId);
      const store = this.#requireStore();
      const entry = store.entries().find((candidate) => candidate.sessionId === acceptedSessionId);
      if (entry === undefined) {
        return Object.freeze({ status: "not_found" });
      }
      if (entry.status === "creating") {
        throw new WorktreeServiceError("SESSION_CONFLICT", "The Session worktree is changing ownership.");
      }
      return this.#releaseEntry(entry, options?.retainForRestore === true, control);
    });
  }

  snapshot(): WorktreeServiceSnapshot {
    const entries = this.#store?.entries() ?? [];
    return Object.freeze({
      initialized: this.#initialized,
      active: Object.freeze(entries.filter((entry) => entry.status === "active").map(leaseFromEntry)),
      residualCount: entries.filter((entry) => entry.status !== "active").length
    });
  }

  dispose(): void {
    this.#disposed = true;
  }

  async #createEntry(
    detection: WorktreeCwdDetection,
    sessionId: string,
    source: WorktreeSourceResolution,
    control: WorktreeOperationControl
  ): Promise<ManagedWorktreeEntry> {
    const store = this.#requireStore();
    await validateOrdinaryDirectory(store.root, "STORAGE_UNSAFE", "The worktree storage root changed unsafely.");
    const repositoryId = repositoryIdFor(detection.repositoryRoot);
    const repositoryDirectory = join(store.root, repositoryId);
    await mkdir(repositoryDirectory, { recursive: true });
    await validateOrdinaryDirectory(
      repositoryDirectory,
      "PATH_UNSAFE",
      "The managed repository directory is unsafe."
    );
    if (!pathInside(store.root, repositoryDirectory)) {
      throw new WorktreeServiceError("PATH_UNSAFE", "The managed repository directory escaped storage.");
    }

    const id = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 24);
    const slotId = `wt-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const path = join(repositoryDirectory, slotId);
    if (await pathExists(path)) {
      throw new WorktreeServiceError("PATH_UNSAFE", "The managed worktree slot already exists.");
    }
    const branch = await this.#uniqueBranch(sessionId, detection.repositoryRoot, control);
    const now = this.#now();
    const creating: ManagedWorktreeEntry = {
      id,
      repositoryId,
      slotId,
      path,
      repositoryRoot: detection.repositoryRoot,
      branch,
      source,
      sessionId,
      status: "creating",
      createdAt: now,
      updatedAt: now
    };
    await store.set(creating, control);

    try {
      await runGit([
        "-c",
        "core.longpaths=true",
        "worktree",
        "add",
        "--no-track",
        "-b",
        branch,
        path,
        source.commit
      ], detection.repositoryRoot, control);
      await this.#validateManagedPath(creating, true);
      const attached = await attachedWorktreeBranch(path, control);
      if (attached !== branch || !(await isWorktreeCompletelyClean(path, control))) {
        throw new WorktreeServiceError("GIT_FAILED", "The created worktree did not reach a clean attached state.");
      }
      const active: ManagedWorktreeEntry = { ...creating, status: "active", updatedAt: this.#now() };
      await store.set(active, control);
      return active;
    } catch (error) {
      const failed: ManagedWorktreeEntry = { ...creating, status: "failed", updatedAt: this.#now() };
      await store.set(failed, control).catch(() => undefined);
      try {
        await this.#destroyEntry(failed, control);
      } catch {
        if (isTerminalError(error)) throw error;
        throw new WorktreeServiceError(
          "CLEANUP_FAILED",
          "A failed worktree creation could not be destroyed safely."
        );
      }
      throw error;
    }
  }

  async #releaseEntry(
    entry: ManagedWorktreeEntry,
    retainForRestore: boolean,
    control: WorktreeOperationControl
  ): Promise<WorktreeRelease> {
    const store = this.#requireStore();
    let current = store.get(entry.id) ?? entry;
    await this.#validateManagedRecord(current);
    let snapshotSha = retainForRestore
      ? await this.#prepareSnapshotForRestore(current, control)
      : await this.#snapshotForDeletion(current, control);
    current = store.get(entry.id) ?? current;
    if (!(await pathExists(current.path))) {
      if (retainForRestore) {
        if (current.archiveSnapshot === undefined) {
          throw new WorktreeServiceError(
            "STATE_CORRUPT",
            "A missing Session worktree has no durable clean-or-dirty archive evidence."
          );
        }
        const preserved = preservedEntry(current, this.#now());
        await store.set(preserved, control);
        return Object.freeze({
          status: "preserved",
          reason: "restorable",
          pathRemoved: true,
          branchPreserved: true
        });
      }
      if (snapshotSha !== undefined) {
        await this.#storeSnapshotInStash(current, snapshotSha, control);
        await this.#retireOwnerSnapshotAfterDeletion(current, snapshotSha, control);
      }
      await store.delete(current.id, control);
      await this.#removeEmptyRepositoryDirectory(current);
      return Object.freeze({ status: "destroyed", pathRemoved: true, branchPreserved: true });
    }

    await this.#validateManagedPath(current, true);
    if (await pathExists(join(current.path, ".worktree-keep"))) {
      await store.set(preservedEntry(current, this.#now()), control);
      return Object.freeze({ status: "preserved", reason: "keep", pathRemoved: false, branchPreserved: true });
    }
    const attached = await attachedWorktreeBranch(current.path, control);
    if (attached !== current.branch) {
      await store.set(preservedEntry(current, this.#now()), control);
      return Object.freeze({
        status: "preserved",
        reason: "branch_changed",
        pathRemoved: false,
        branchPreserved: true
      });
    }

    if (current.checkoutCleanup !== undefined) {
      if (snapshotSha === undefined || current.checkoutCleanup.sha !== snapshotSha) {
        throw new WorktreeServiceError("STATE_CORRUPT", "The checkout cleanup lost its exact owner snapshot.");
      }
      await this.#finishCheckoutCleanup(current, snapshotSha, control);
      current = store.get(entry.id) ?? current;
    }

    if (!(await isWorktreeCompletelyClean(current.path, control))) {
      if (snapshotSha !== undefined) {
        if (!(await this.#snapshotMatchesWorktree(current, snapshotSha, control))) {
          await store.set(preservedEntry(current, this.#now()), control);
          return Object.freeze({ status: "preserved", reason: "dirty", pathRemoved: false, branchPreserved: true });
        }
      } else {
        snapshotSha = await this.#createDirtySnapshot(current, control);
        if (snapshotSha === undefined) {
          await store.set(preservedEntry(current, this.#now()), control);
          return Object.freeze({ status: "preserved", reason: "dirty", pathRemoved: false, branchPreserved: true });
        }
      }
    }

    current = store.get(entry.id) ?? current;

    const prepared = await this.#prepareCheckoutForRemoval(current, snapshotSha, control);
    snapshotSha = prepared.snapshotSha;
    current = store.get(entry.id) ?? current;
    if (snapshotSha === undefined && current.archiveSnapshot === undefined) {
      current = await this.#recordCleanArchive(current, control);
    }
    await this.#assertRecordedBranchTip(current, control);
    const preserved = preservedEntry(current, this.#now());
    await store.set(preserved, control);
    const result = await this.#destroyEntry(preserved, control, true, true);
    if (retainForRestore) {
      return Object.freeze({
        status: "preserved",
        reason: "restorable",
        pathRemoved: result.pathRemoved,
        branchPreserved: result.branchPreserved
      });
    }
    if (snapshotSha !== undefined) {
      await this.#storeSnapshotInStash(current, snapshotSha, control);
      await this.#retireOwnerSnapshotAfterDeletion(current, snapshotSha, control);
    }
    await store.delete(current.id, control);
    await this.#removeEmptyRepositoryDirectory(current);
    return Object.freeze({
      status: "destroyed",
      pathRemoved: result.pathRemoved,
      branchPreserved: result.branchPreserved
    });
  }

  async #prepareCheckoutForRemoval(
    entry: ManagedWorktreeEntry,
    snapshotSha: string | undefined,
    control: WorktreeOperationControl
  ): Promise<{ readonly snapshotSha: string | undefined }> {
    if (await isWorktreeCompletelyClean(entry.path, control)) {
      return { snapshotSha };
    }
    if (snapshotSha === undefined) {
      throw new WorktreeServiceError("SESSION_CONFLICT", "The dirty worktree has no durable recovery snapshot.");
    }

    const latestSha = await this.#createDirtySnapshotObject(entry, control);
    if (latestSha === undefined) {
      throw new WorktreeServiceError(
        "SESSION_CONFLICT",
        "The worktree contains content that cannot be archived safely."
      );
    }
    await this.#assertSnapshotMatchesRecordedBranchTip(entry, latestSha, control);
    const [expectedIdentity, latestIdentity] = await Promise.all([
      this.#snapshotContentIdentity(entry, snapshotSha, control),
      this.#snapshotContentIdentity(entry, latestSha, control)
    ]);
    if (expectedIdentity !== latestIdentity) {
      await this.#recordDirtyArchive(entry, latestSha, control, snapshotSha);
      await runGit(
        ["update-ref", snapshotRefFor(entry.sessionId), latestSha, snapshotSha],
        entry.repositoryRoot,
        control
      );
      await this.#clearPendingOwnerRef(entry, control);
      snapshotSha = latestSha;
    }

    // The exact latest tree/index/untracked identity is protected by durable
    // state and the owner ref before reset/clean mutates the checkout. No
    // temporary entry is added to the repository's shared stash.
    await this.#recordCheckoutCleanup(entry, snapshotSha, control);
    await this.#finishCheckoutCleanup(entry, snapshotSha, control);
    return { snapshotSha };
  }

  async #restoreEntry(
    entry: ManagedWorktreeEntry,
    control: WorktreeOperationControl
  ): Promise<ManagedWorktreeEntry> {
    const store = this.#requireStore();
    let current = store.get(entry.id) ?? entry;
    await this.#validateManagedRecord(current);
    await validateOrdinaryDirectory(
      current.repositoryRoot,
      "REPOSITORY_UNSAFE",
      "The repository root is unavailable during worktree recovery."
    );
    if (!(await branchExists(current.repositoryRoot, current.branch, control))) {
      throw new WorktreeServiceError("SESSION_CONFLICT", "The preserved Session worktree branch is unavailable.");
    }
    if (current.archiveSnapshot !== undefined) await this.#assertRecordedBranchTip(current, control);
    if (current.status === "restored" && current.archiveSnapshot?.kind === "dirty"
      && current.pendingOwnerRefTransition === undefined
      && await this.#snapshotSha(current, control) === undefined) {
      if (!(await pathExists(current.path))) {
        throw new WorktreeServiceError(
          "SESSION_CONFLICT",
          "The applied Session worktree disappeared before recovery completed."
        );
      }
      await this.#validateManagedPath(current, true);
      if (await attachedWorktreeBranch(current.path, control) !== current.branch
        || !(await this.#snapshotMatchesWorktree(current, current.archiveSnapshot.sha, control))) {
        throw new WorktreeServiceError(
          "SESSION_CONFLICT",
          "The applied Session worktree no longer matches its durable recovery snapshot."
        );
      }
      const active = {
        ...current,
        status: "active" as const,
        archiveSnapshot: undefined,
        pendingOwnerRefTransition: undefined,
        checkoutCleanup: undefined,
        deletionTransfer: undefined,
        updatedAt: this.#now()
      };
      await store.set(active, control);
      return active;
    }
    const snapshotSha = await this.#prepareSnapshotForRestore(current, control);
    current = store.get(entry.id) ?? current;
    if (current.checkoutCleanup !== undefined) {
      if (snapshotSha === undefined || current.checkoutCleanup.sha !== snapshotSha) {
        throw new WorktreeServiceError("STATE_CORRUPT", "The checkout cleanup lost its exact owner snapshot.");
      }
      if (await pathExists(current.path)) {
        await this.#finishCheckoutCleanup(current, snapshotSha, control);
      } else {
        await this.#clearCheckoutCleanup(current, control);
      }
      current = store.get(entry.id) ?? current;
    }

    const pathAvailable = await pathExists(current.path);
    if (!pathAvailable && current.archiveSnapshot === undefined) {
      throw new WorktreeServiceError(
        "STATE_CORRUPT",
        "A missing Session worktree has no durable clean-or-dirty archive evidence."
      );
    }
    if (!pathAvailable && current.status === "restored") {
      throw new WorktreeServiceError(
        "SESSION_CONFLICT",
        "The applied Session worktree disappeared before recovery completed."
      );
    }
    if (!pathAvailable) {
      await this.#validateManagedPath(current, false);
      try {
        await runGit(
          ["-c", "core.longpaths=true", "worktree", "add", current.path, current.branch],
          current.repositoryRoot,
          control
        );
      } catch (error) {
        if (isTerminalError(error)) throw error;
        await runGit(["worktree", "prune"], current.repositoryRoot, control);
        await runGit(
          ["-c", "core.longpaths=true", "worktree", "add", current.path, current.branch],
          current.repositoryRoot,
          control
        );
      }
    }

    let recoveryRecord = current;
    try {
      await this.#validateManagedPath(current, true);
      const attached = await attachedWorktreeBranch(current.path, control);
      if (attached !== current.branch) {
        throw new WorktreeServiceError("SESSION_CONFLICT", "The restored Session worktree branch does not match its owner record.");
      }
      if (current.status === "restored" && snapshotSha !== undefined
        && !(await this.#snapshotMatchesWorktree(current, snapshotSha, control))) {
        throw new WorktreeServiceError(
          "SESSION_CONFLICT",
          "The restored Session worktree changed before its recovery snapshot was consumed."
        );
      }
      if (current.status !== "restored" && snapshotSha !== undefined) {
        if (await isWorktreeCompletelyClean(current.path, control)) {
          recoveryRecord = { ...current, status: "restoring", updatedAt: this.#now() };
          await store.set(recoveryRecord, control);
          await runGit(["stash", "apply", "--index", snapshotSha], current.path, control);
        }
        if (!(await this.#snapshotMatchesWorktree(current, snapshotSha, control))) {
          throw new WorktreeServiceError(
            "SESSION_CONFLICT",
            "The Session worktree changed while its recovery snapshot was being applied."
          );
        }
        recoveryRecord = { ...current, status: "restored", updatedAt: this.#now() };
        await store.set(recoveryRecord, control);
      } else if (current.status === "restoring") {
        throw new WorktreeServiceError(
          "STATE_CORRUPT",
          "The Session worktree lost its snapshot during recovery."
        );
      }
      if (recoveryRecord.status === "restored" && snapshotSha !== undefined) {
        await this.#deleteSnapshotRef(current, snapshotSha, control);
      }
      const active = {
        ...current,
        status: "active" as const,
        archiveSnapshot: undefined,
        pendingOwnerRefTransition: undefined,
        checkoutCleanup: undefined,
        deletionTransfer: undefined,
        updatedAt: this.#now()
      };
      await store.set(active, control);
      return active;
    } catch (error) {
      const failed = recoveryRecord.status === "restoring" || recoveryRecord.status === "restored"
        ? { ...recoveryRecord, updatedAt: this.#now() }
        : preservedEntry(current, this.#now());
      await store.set(failed, control)
        .catch(() => undefined);
      throw error;
    }
  }

  async #createDirtySnapshot(
    entry: ManagedWorktreeEntry,
    control: WorktreeOperationControl
  ): Promise<string | undefined> {
    const snapshotSha = await this.#createDirtySnapshotObject(entry, control);
    if (snapshotSha === undefined) return undefined;
    await this.#recordDirtyArchive(entry, snapshotSha, control);
    await runGit(
      ["update-ref", snapshotRefFor(entry.sessionId), snapshotSha, ""],
      entry.repositoryRoot,
      control
    );
    await this.#clearPendingOwnerRef(entry, control);
    const durableSha = await this.#snapshotSha(entry, control);
    if (durableSha !== snapshotSha) {
      throw new WorktreeServiceError("STATE_CORRUPT", "The Session worktree snapshot was not durably recorded.");
    }
    return snapshotSha;
  }

  async #createDirtySnapshotObject(
    entry: ManagedWorktreeEntry,
    control: WorktreeOperationControl
  ): Promise<string | undefined> {
    if (await hasUnsafeTrackedIndexFlags(entry.path, control)) return undefined;
    const status = await runGit(
      ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching"],
      entry.path,
      control
    );
    if (snapshotHasUnsupportedContent(status.stdout)) return undefined;

    const untracked = (await runGit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      entry.path,
      control
    )).stdout.split("\0").filter((path) => path.length > 0);
    const marker = `joko-worktree-snapshot:${snapshotOwnerKey(entry.sessionId)}:${randomUUID()}`;
    const created = await runGit(
      ["stash", "create", marker],
      entry.path,
      control,
      { environment: SNAPSHOT_IDENTITY_ENVIRONMENT }
    );
    const trackedSha = optionalGitObjectId(created.stdout, "The tracked worktree snapshot is invalid.");
    const snapshotSha = untracked.length === 0
      ? trackedSha
      : await this.#createSnapshotWithUntracked(entry, marker, trackedSha, untracked, control);
    return snapshotSha;
  }

  async #createSnapshotWithUntracked(
    entry: ManagedWorktreeEntry,
    marker: string,
    trackedSha: string | undefined,
    untracked: readonly string[],
    control: WorktreeOperationControl
  ): Promise<string> {
    let worktreeTree: string;
    let headCommit: string;
    let indexCommit: string;
    if (trackedSha === undefined) {
      headCommit = gitObjectId(
        (await runGit(["rev-parse", "HEAD"], entry.path, control)).stdout,
        "The worktree HEAD is invalid."
      );
      worktreeTree = gitObjectId(
        (await runGit(["write-tree"], entry.path, control)).stdout,
        "The worktree index tree is invalid."
      );
      indexCommit = await this.#commitSnapshotTree(
        entry,
        worktreeTree,
        [headCommit],
        `${marker} index`,
        control
      );
    } else {
      worktreeTree = gitObjectId(
        (await runGit(["rev-parse", `${trackedSha}^{tree}`], entry.path, control)).stdout,
        "The tracked worktree tree is invalid."
      );
      headCommit = gitObjectId(
        (await runGit(["rev-parse", `${trackedSha}^1`], entry.path, control)).stdout,
        "The tracked worktree base is invalid."
      );
      indexCommit = gitObjectId(
        (await runGit(["rev-parse", `${trackedSha}^2`], entry.path, control)).stdout,
        "The tracked worktree index snapshot is invalid."
      );
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "joko-worktree-snapshot-"));
    try {
      const indexFile = join(temporaryRoot, "index");
      await runGit(["read-tree", "--empty"], entry.path, control, { indexFile });
      for (let offset = 0; offset < untracked.length; offset += 100) {
        await runGit(
          ["add", "-f", "--", ...untracked.slice(offset, offset + 100)],
          entry.path,
          control,
          { indexFile }
        );
      }
      const untrackedTree = gitObjectId(
        (await runGit(["write-tree"], entry.path, control, { indexFile })).stdout,
        "The untracked worktree tree is invalid."
      );
      const untrackedCommit = await this.#commitSnapshotTree(
        entry,
        untrackedTree,
        [],
        `${marker} untracked`,
        control
      );
      return this.#commitSnapshotTree(
        entry,
        worktreeTree,
        [headCommit, indexCommit, untrackedCommit],
        marker,
        control
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  async #commitSnapshotTree(
    entry: ManagedWorktreeEntry,
    tree: string,
    parents: readonly string[],
    message: string,
    control: WorktreeOperationControl
  ): Promise<string> {
    const args = ["commit-tree", tree];
    for (const parent of parents) args.push("-p", parent);
    args.push("-m", message);
    return gitObjectId(
      (await runGit(args, entry.repositoryRoot, control, { environment: SNAPSHOT_IDENTITY_ENVIRONMENT })).stdout,
      "The worktree snapshot commit is invalid."
    );
  }

  async #snapshotMatchesWorktree(
    entry: ManagedWorktreeEntry,
    expectedSha: string,
    control: WorktreeOperationControl
  ): Promise<boolean> {
    const actualSha = await this.#createDirtySnapshotObject(entry, control);
    if (actualSha === undefined) return false;
    const [expected, actual] = await Promise.all([
      this.#snapshotContentIdentity(entry, expectedSha, control),
      this.#snapshotContentIdentity(entry, actualSha, control)
    ]);
    return expected === actual;
  }

  async #snapshotContentIdentity(
    entry: ManagedWorktreeEntry,
    snapshotSha: string,
    control: WorktreeOperationControl
  ): Promise<string> {
    const worktreeTree = gitObjectId(
      (await runGit(["rev-parse", `${snapshotSha}^{tree}`], entry.repositoryRoot, control)).stdout,
      "The worktree snapshot tree is invalid."
    );
    const indexTree = gitObjectId(
      (await runGit(["rev-parse", `${snapshotSha}^2^{tree}`], entry.repositoryRoot, control)).stdout,
      "The worktree snapshot index tree is invalid."
    );
    const ancestry = (await runGit(
      ["rev-list", "--parents", "-n", "1", snapshotSha],
      entry.repositoryRoot,
      control
    )).stdout.trim().split(/\s+/u);
    if (ancestry.length < 3 || ancestry.some((candidate) => !/^[a-f0-9]{40,64}$/u.test(candidate))) {
      throw new WorktreeServiceError("STATE_CORRUPT", "The worktree snapshot ancestry is invalid.");
    }
    let untrackedTree = "";
    if (ancestry.length >= 4) {
      const candidate = gitObjectId(
        (await runGit(["rev-parse", `${snapshotSha}^3^{tree}`], entry.repositoryRoot, control)).stdout,
        "The untracked worktree snapshot tree is invalid."
      );
      if ((await runGit(["ls-tree", candidate], entry.repositoryRoot, control)).stdout.length > 0) {
        untrackedTree = candidate;
      }
    }
    return `${worktreeTree}:${indexTree}:${untrackedTree}`;
  }

  async #prepareSnapshotForRestore(
    entry: ManagedWorktreeEntry,
    control: WorktreeOperationControl
  ): Promise<string | undefined> {
    return this.#validatedArchiveSnapshot(entry, control);
  }

  async #snapshotForDeletion(
    entry: ManagedWorktreeEntry,
    control: WorktreeOperationControl
  ): Promise<string | undefined> {
    return this.#validatedArchiveSnapshot(entry, control);
  }

  async #validatedArchiveSnapshot(
    entry: ManagedWorktreeEntry,
    control: WorktreeOperationControl
  ): Promise<string | undefined> {
    const recorded = entry.archiveSnapshot;
    let ownerSha = await this.#snapshotSha(entry, control);
    if (recorded === undefined) {
      if (ownerSha !== undefined || entry.pendingOwnerRefTransition !== undefined
        || entry.checkoutCleanup !== undefined
        || entry.deletionTransfer !== undefined) {
        throw new WorktreeServiceError(
          "STATE_CORRUPT",
          "A worktree recovery object exists without durable archive ownership evidence."
        );
      }
      return undefined;
    }
    await this.#assertRecordedBranchTip(entry, control);
    if (recorded.kind === "clean") {
      if (ownerSha !== undefined || entry.pendingOwnerRefTransition !== undefined
        || entry.checkoutCleanup !== undefined
        || entry.deletionTransfer !== undefined) {
        throw new WorktreeServiceError(
          "SESSION_CONFLICT",
          "A clean archive record conflicts with a Git recovery object."
        );
      }
      return undefined;
    }

    const transition = entry.pendingOwnerRefTransition;
    if (transition !== undefined) {
      if (transition.sha !== recorded.sha) {
        throw new WorktreeServiceError("STATE_CORRUPT", "The pending owner ref identity changed in durable state.");
      }
      const expectedPrevious = transition.previousSha;
      const ownerAtPrevious = expectedPrevious === undefined
        ? ownerSha === undefined
        : ownerSha === expectedPrevious;
      if (ownerAtPrevious) {
        if (!(await pathExists(entry.path))) {
          throw new WorktreeServiceError(
            "STATE_CORRUPT",
            "A pending owner ref cannot be recovered after its exact checkout disappeared."
          );
        }
        await this.#validateManagedPath(entry, true);
        if (await attachedWorktreeBranch(entry.path, control) !== entry.branch
          || !(await this.#snapshotMatchesWorktree(entry, recorded.sha, control))) {
          throw new WorktreeServiceError(
            "SESSION_CONFLICT",
            "A pending owner ref no longer matches the exact managed checkout."
          );
        }
        await runGit(
          ["update-ref", snapshotRefFor(entry.sessionId), recorded.sha, expectedPrevious ?? ""],
          entry.repositoryRoot,
          control
        );
        ownerSha = recorded.sha;
      } else if (ownerSha !== recorded.sha) {
        throw new WorktreeServiceError(
          "SESSION_CONFLICT",
          "The pending owner ref was created with a different object identity."
        );
      }
      await this.#clearPendingOwnerRef(entry, control);
    }

    const current = this.#requireStore().get(entry.id) ?? entry;
    const expectedSha = current.archiveSnapshot?.kind === "dirty"
      ? current.archiveSnapshot.sha
      : recorded.sha;
    const currentOwnerSha = await this.#snapshotSha(current, control);
    if (currentOwnerSha === undefined) {
      if (current.deletionTransfer?.stashSha === expectedSha
        && await this.#stashContainsSha(current, expectedSha, control)) {
        return expectedSha;
      }
      throw new WorktreeServiceError(
        "STATE_CORRUPT",
        "The dirty Session archive is missing its authoritative owner reference."
      );
    }
    if (currentOwnerSha !== expectedSha) {
      throw new WorktreeServiceError(
        "SESSION_CONFLICT",
        "The dirty Session archive owner reference moved away from its durable object identity."
      );
    }
    return expectedSha;
  }

  async #snapshotSha(
    entry: ManagedWorktreeEntry,
    control: WorktreeOperationControl
  ): Promise<string | undefined> {
    const result = await runGit(
      ["for-each-ref", "--format=%(objectname)", snapshotRefFor(entry.sessionId)],
      entry.repositoryRoot,
      control
    );
    const sha = result.stdout.trim().toLowerCase();
    if (sha === "") return undefined;
    if (!/^[a-f0-9]{40,64}$/u.test(sha)) {
      throw new WorktreeServiceError("STATE_CORRUPT", "The Session worktree snapshot reference is invalid.");
    }
    return sha;
  }

  async #storeSnapshotInStash(
    entry: ManagedWorktreeEntry,
    snapshotSha: string,
    control: WorktreeOperationControl
  ): Promise<void> {
    const store = this.#requireStore();
    let current = store.get(entry.id) ?? entry;
    if (current.archiveSnapshot?.kind !== "dirty" || current.archiveSnapshot.sha !== snapshotSha) {
      throw new WorktreeServiceError("STATE_CORRUPT", "A deleted snapshot has no exact dirty archive authority.");
    }
    if (current.deletionTransfer !== undefined && current.deletionTransfer.stashSha !== snapshotSha) {
      throw new WorktreeServiceError("STATE_CORRUPT", "The deletion transfer changed object identity.");
    }
    if (current.deletionTransfer === undefined) {
      current = {
        ...current,
        deletionTransfer: { stashSha: snapshotSha },
        updatedAt: this.#now()
      };
      await store.set(current, control);
    }
    if (!(await this.#stashContainsSha(current, snapshotSha, control))) {
      await runGit(
        ["stash", "store", "-m", deletedSnapshotMarker(entry.sessionId), snapshotSha],
        entry.repositoryRoot,
        control
      );
    }
    if (!(await this.#stashContainsSha(current, snapshotSha, control))) {
      throw new WorktreeServiceError("STATE_CORRUPT", "The deleted worktree snapshot was not durably stored.");
    }
  }

  async #stashContainsSha(
    entry: ManagedWorktreeEntry,
    snapshotSha: string,
    control: WorktreeOperationControl
  ): Promise<boolean> {
    const listing = await runGit(
      ["stash", "list", "--format=%H"],
      entry.repositoryRoot,
      control
    );
    return listing.stdout.split(/\r?\n/u).some((candidate) => candidate.trim().toLowerCase() === snapshotSha);
  }

  async #recordCleanArchive(
    entry: ManagedWorktreeEntry,
    control: WorktreeOperationControl
  ): Promise<ManagedWorktreeEntry> {
    const store = this.#requireStore();
    const current = store.get(entry.id) ?? entry;
    const branchHeadSha = await worktreeHeadCommit(current.path, control);
    if (branchHeadSha === undefined) {
      throw new WorktreeServiceError("SESSION_CONFLICT", "The archive branch tip is unavailable.");
    }
    const recorded = {
      ...current,
      archiveSnapshot: { kind: "clean" as const, branchHeadSha },
      pendingOwnerRefTransition: undefined,
      checkoutCleanup: undefined,
      deletionTransfer: undefined,
      updatedAt: this.#now()
    };
    await store.set(recorded, control);
    return recorded;
  }

  async #recordDirtyArchive(
    entry: ManagedWorktreeEntry,
    sha: string,
    control: WorktreeOperationControl,
    previousSha?: string
  ): Promise<ManagedWorktreeEntry> {
    const store = this.#requireStore();
    const current = store.get(entry.id) ?? entry;
    const snapshotBranchHeadSha = await this.#snapshotBranchHeadSha(current, sha, control);
    const branchHeadSha = current.archiveSnapshot?.branchHeadSha ?? snapshotBranchHeadSha;
    if (snapshotBranchHeadSha !== branchHeadSha) {
      throw new WorktreeServiceError(
        "SESSION_CONFLICT",
        "The cleanup snapshot was created from a moved archive branch tip."
      );
    }
    const recorded = {
      ...current,
      archiveSnapshot: { kind: "dirty" as const, sha, branchHeadSha },
      pendingOwnerRefTransition: {
        sha,
        ...(previousSha === undefined ? {} : { previousSha })
      },
      checkoutCleanup: undefined,
      deletionTransfer: undefined,
      updatedAt: this.#now()
    };
    await store.set(recorded, control);
    return recorded;
  }

  async #clearPendingOwnerRef(
    entry: ManagedWorktreeEntry,
    control: WorktreeOperationControl
  ): Promise<void> {
    const store = this.#requireStore();
    const current = store.get(entry.id) ?? entry;
    if (current.pendingOwnerRefTransition === undefined) return;
    await store.set({ ...current, pendingOwnerRefTransition: undefined, updatedAt: this.#now() }, control);
  }

  async #recordCheckoutCleanup(
    entry: ManagedWorktreeEntry,
    snapshotSha: string,
    control: WorktreeOperationControl
  ): Promise<void> {
    const store = this.#requireStore();
    const current = store.get(entry.id) ?? entry;
    if (current.archiveSnapshot?.kind !== "dirty" || current.archiveSnapshot.sha !== snapshotSha
      || current.pendingOwnerRefTransition !== undefined || current.deletionTransfer !== undefined) {
      throw new WorktreeServiceError("STATE_CORRUPT", "The checkout cleanup has no exact durable owner authority.");
    }
    if (current.checkoutCleanup !== undefined && current.checkoutCleanup.sha !== snapshotSha) {
      throw new WorktreeServiceError("STATE_CORRUPT", "The checkout cleanup changed object identity.");
    }
    if (current.checkoutCleanup === undefined) {
      await store.set({
        ...current,
        checkoutCleanup: { sha: snapshotSha },
        updatedAt: this.#now()
      }, control);
    }
  }

  async #finishCheckoutCleanup(
    entry: ManagedWorktreeEntry,
    snapshotSha: string,
    control: WorktreeOperationControl
  ): Promise<void> {
    const current = this.#requireStore().get(entry.id) ?? entry;
    if (current.checkoutCleanup?.sha !== snapshotSha
      || await this.#snapshotSha(current, control) !== snapshotSha) {
      throw new WorktreeServiceError("STATE_CORRUPT", "The checkout cleanup lost its exact durable owner authority.");
    }
    await this.#validateManagedPath(current, true);
    if (await attachedWorktreeBranch(current.path, control) !== current.branch) {
      throw new WorktreeServiceError("SESSION_CONFLICT", "The checkout cleanup branch changed.");
    }
    await this.#assertRecordedBranchTip(current, control);
    await runGit(["reset", "--hard", "HEAD"], current.path, control);
    await runGit(["clean", "-fd"], current.path, control);
    if (!(await isWorktreeCompletelyClean(current.path, control))) {
      throw new WorktreeServiceError("SESSION_CONFLICT", "The checkout could not be cleaned without losing recovery authority.");
    }
    await this.#clearCheckoutCleanup(current, control);
  }

  async #clearCheckoutCleanup(
    entry: ManagedWorktreeEntry,
    control: WorktreeOperationControl
  ): Promise<void> {
    const store = this.#requireStore();
    const current = store.get(entry.id) ?? entry;
    if (current.checkoutCleanup === undefined) return;
    await store.set({ ...current, checkoutCleanup: undefined, updatedAt: this.#now() }, control);
  }

  async #snapshotBranchHeadSha(
    entry: ManagedWorktreeEntry,
    snapshotSha: string,
    control: WorktreeOperationControl
  ): Promise<string> {
    return gitObjectId(
      (await runGit(["rev-parse", `${snapshotSha}^1`], entry.repositoryRoot, control)).stdout,
      "The worktree snapshot branch-tip identity is invalid."
    );
  }

  async #assertRecordedBranchTip(
    entry: ManagedWorktreeEntry,
    control: WorktreeOperationControl
  ): Promise<void> {
    const recordedTip = entry.archiveSnapshot?.branchHeadSha;
    if (recordedTip === undefined) return;
    const currentTip = gitObjectId(
      (await runGit(
        ["rev-parse", "--verify", `refs/heads/${entry.branch}^{commit}`],
        entry.repositoryRoot,
        control
      )).stdout,
      "The Session worktree branch tip is invalid."
    );
    if (currentTip !== recordedTip) {
      throw new WorktreeServiceError(
        "SESSION_CONFLICT",
        "The Session worktree branch moved away from its archived commit identity."
      );
    }
  }

  async #assertSnapshotMatchesRecordedBranchTip(
    entry: ManagedWorktreeEntry,
    snapshotSha: string,
    control: WorktreeOperationControl
  ): Promise<void> {
    const recordedTip = (this.#requireStore().get(entry.id) ?? entry).archiveSnapshot?.branchHeadSha;
    if (recordedTip !== undefined
      && await this.#snapshotBranchHeadSha(entry, snapshotSha, control) !== recordedTip) {
      throw new WorktreeServiceError(
        "SESSION_CONFLICT",
        "The worktree snapshot branch tip moved during archive cleanup."
      );
    }
  }

  async #deleteSnapshotRef(
    entry: ManagedWorktreeEntry,
    expectedSha: string,
    control: WorktreeOperationControl
  ): Promise<void> {
    const currentSha = await this.#snapshotSha(entry, control);
    if (currentSha === undefined) return;
    if (currentSha !== expectedSha) {
      throw new WorktreeServiceError("SESSION_CONFLICT", "The Session worktree snapshot changed during cleanup.");
    }
    await runGit(
      ["update-ref", "-d", snapshotRefFor(entry.sessionId), expectedSha],
      entry.repositoryRoot,
      control
    );
  }

  async #retireOwnerSnapshotAfterDeletion(
    entry: ManagedWorktreeEntry,
    snapshotSha: string,
    control: WorktreeOperationControl
  ): Promise<void> {
    const current = this.#requireStore().get(entry.id) ?? entry;
    if (current.deletionTransfer?.stashSha !== snapshotSha
      || !(await this.#stashContainsSha(current, snapshotSha, control))) {
      throw new WorktreeServiceError(
        "STATE_CORRUPT",
        "The owner ref cannot be retired before its exact deletion transfer is durable."
      );
    }
    const durableSha = await this.#snapshotSha(entry, control);
    if (durableSha === undefined) return;
    if (durableSha !== snapshotSha) {
      throw new WorktreeServiceError("SESSION_CONFLICT", "The worktree snapshot changed during deletion.");
    }
    await this.#deleteSnapshotRef(entry, snapshotSha, control);
  }

  async #destroyEntry(
    entry: ManagedWorktreeEntry,
    control: WorktreeOperationControl,
    retainForRestore = false,
    safeRemoval = false
  ): Promise<DestructionResult> {
    const store = this.#requireStore();
    const current = store.get(entry.id) ?? entry;
    await this.#validateManagedRecord(current);
    const destroying: ManagedWorktreeEntry = {
      ...current,
      status: "destroying",
      updatedAt: this.#now()
    };
    await store.set(destroying, control);

    let pathRemoved = !(await pathExists(destroying.path));
    let repositoryAvailable = false;
    try {
      await validateOrdinaryDirectory(
        destroying.repositoryRoot,
        "REPOSITORY_UNSAFE",
        "The repository root is unavailable during cleanup."
      );
      repositoryAvailable = true;
    } catch {
      repositoryAvailable = false;
    }

    if (!pathRemoved) {
      await this.#validateManagedPath(destroying, true);
      if (safeRemoval && !repositoryAvailable) {
        await store.set(preservedEntry(destroying, this.#now()), control);
        throw new WorktreeServiceError("REPOSITORY_UNSAFE", "The repository is unavailable for safe worktree removal.");
      }
      if (repositoryAvailable) {
        try {
          if (safeRemoval) await this.#assertRecordedBranchTip(destroying, control);
          await runGit(
            safeRemoval
              ? ["worktree", "remove", destroying.path]
              : ["worktree", "remove", "--force", destroying.path],
            destroying.repositoryRoot,
            control
          );
        } catch (error) {
          if (isTerminalError(error)) throw error;
        }
        pathRemoved = !(await pathExists(destroying.path));
      }
      if (!pathRemoved && !safeRemoval) {
        await this.#validateManagedPath(destroying, true);
        await rm(destroying.path, { recursive: true, force: true, maxRetries: 3 });
        pathRemoved = !(await pathExists(destroying.path));
      }
    }
    if (!pathRemoved) {
      await store.set(
        safeRemoval
          ? preservedEntry(destroying, this.#now())
          : { ...destroying, status: "failed", updatedAt: this.#now() },
        control
      );
      throw new WorktreeServiceError(
        safeRemoval ? "SESSION_CONFLICT" : "CLEANUP_FAILED",
        safeRemoval
          ? "The worktree changed before it could be removed safely."
          : "The managed worktree directory could not be removed."
      );
    }

    if (repositoryAvailable) {
      await runGit(["worktree", "prune"], destroying.repositoryRoot, control).catch((error) => {
        if (isTerminalError(error)) throw error;
      });
    }
    // Product worktree branches are durable recovery handles. Removing the
    // checkout must never force-delete the branch, even when it still matches
    // its source exactly; a later user action may merge or cherry-pick it.
    if (retainForRestore) {
      await store.set(preservedEntry(destroying, this.#now()), control);
    } else {
      await store.delete(destroying.id, control);
      await this.#removeEmptyRepositoryDirectory(destroying);
    }
    return Object.freeze({ pathRemoved, branchPreserved: true });
  }

  async #validateManagedPath(entry: ManagedWorktreeEntry, requireExisting: boolean): Promise<void> {
    const store = this.#requireStore();
    await this.#validateManagedRecord(entry);
    const repositoryDirectory = dirname(entry.path);
    if (!samePath(repositoryDirectory, join(store.root, entry.repositoryId))) {
      throw new WorktreeServiceError("PATH_UNSAFE", "The managed worktree parent is invalid.");
    }
    await validateOrdinaryDirectory(
      repositoryDirectory,
      "PATH_UNSAFE",
      "The managed worktree parent is unsafe."
    );
    if (!(await pathExists(entry.path))) {
      if (requireExisting) throw new WorktreeServiceError("PATH_UNSAFE", "The managed worktree path is missing.");
      return;
    }
    let info;
    try { info = await lstat(entry.path); } catch {
      throw new WorktreeServiceError("PATH_UNSAFE", "The managed worktree path could not be inspected.");
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new WorktreeServiceError("PATH_UNSAFE", "The managed worktree path is not an ordinary directory.");
    }
    const canonical = await realpath(entry.path).catch(() => undefined);
    if (canonical === undefined || !samePath(canonical, entry.path) || !pathInside(store.root, canonical)) {
      throw new WorktreeServiceError("PATH_UNSAFE", "The managed worktree path contains an unsafe alias.");
    }
  }

  async #validateManagedRecord(entry: ManagedWorktreeEntry): Promise<void> {
    const store = this.#requireStore();
    await validateOrdinaryDirectory(store.root, "STORAGE_UNSAFE", "The worktree storage root changed unsafely.");
    if (!isEntryLayoutSafe(store.root, entry) || !ENTRY_ID_PATTERN.test(entry.id)
      || entry.repositoryId !== repositoryIdFor(entry.repositoryRoot)) {
      throw new WorktreeServiceError("PATH_UNSAFE", "The managed worktree path does not match its durable record.");
    }
    if (samePath(store.root, entry.repositoryRoot) || pathInside(store.root, entry.repositoryRoot)
      || pathInside(entry.repositoryRoot, store.root)) {
      throw new WorktreeServiceError("PATH_UNSAFE", "The managed repository and storage paths overlap.");
    }
  }

  async #uniqueBranch(
    sessionId: string,
    repositoryRoot: string,
    control: WorktreeOperationControl
  ): Promise<string> {
    const sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
      const branch = `${MANAGED_BRANCH_PREFIX}/${sessionKey}-${suffix}`;
      if (!(await branchExists(repositoryRoot, branch, control))) return branch;
    }
    throw new WorktreeServiceError("GIT_FAILED", "A unique managed branch could not be allocated.");
  }

  #assertRepositorySeparated(repositoryRoot: string): void {
    const root = this.#requireStore().root;
    if (samePath(root, repositoryRoot) || pathInside(root, repositoryRoot) || pathInside(repositoryRoot, root)) {
      throw new WorktreeServiceError(
        "STORAGE_UNSAFE",
        "Worktree storage and the source repository must not contain one another."
      );
    }
  }

  async #removeEmptyRepositoryDirectory(entry: ManagedWorktreeEntry): Promise<void> {
    const store = this.#requireStore();
    if (store.entries().some((candidate) => candidate.repositoryId === entry.repositoryId)) return;
    const directory = join(store.root, entry.repositoryId);
    if (!pathInside(store.root, directory) || !samePath(directory, dirname(entry.path))) return;
    try { await rmdir(directory); } catch { /* It is either non-empty or already gone. */ }
  }

  #requireStore(): WorktreeStateStore {
    if (this.#store === undefined) {
      throw new WorktreeServiceError("NOT_INITIALIZED", "The worktree service has not been initialized.");
    }
    return this.#store;
  }

  #serialize<T>(
    options: WorktreeCallOptions | undefined,
    requireInitialized: boolean,
    operation: (control: WorktreeOperationControl) => Promise<T>
  ): Promise<WorktreeResult<T>> {
    let control: WorktreeOperationControl;
    try {
      control = new WorktreeOperationControl(options, this.#operationTimeoutMs, this.#now);
    } catch (error) {
      return Promise.resolve(failure(error));
    }
    const execute = async (): Promise<WorktreeResult<T>> => {
      try {
        if (this.#disposed) throw new WorktreeServiceError("DISPOSED", "The worktree service has been disposed.");
        control.check();
        if (requireInitialized && !this.#initialized) {
          throw new WorktreeServiceError("NOT_INITIALIZED", "The worktree service has not been initialized.");
        }
        return success(await operation(control));
      } catch (error) {
        return failure(error);
      }
    };
    const result = this.#tail.then(execute, execute);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateRetainedSessionIds(value: readonly string[] | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set<string>();
  if (!Array.isArray(value) || value.length > 100_000) {
    throw invalidArgument("retainSessionIds", "retainSessionIds must be a bounded array.");
  }
  const accepted = new Set<string>();
  for (const sessionId of value) accepted.add(validateSessionId(sessionId));
  return accepted;
}

function validateAcquireRequest(value: unknown): WorktreeAcquireRequest {
  if (!isRecord(value) || hasUnsupportedKeys(value, ["sessionId", "cwd", "sourceRef", "refreshRemote"])) {
    throw invalidArgument("request", "The worktree acquisition request is invalid.");
  }
  const sessionId = validateSessionId(value["sessionId"]);
  if (typeof value["cwd"] !== "string") throw invalidArgument("cwd", "cwd must be a string.");
  if (value["sourceRef"] !== undefined && typeof value["sourceRef"] !== "string") {
    throw invalidArgument("sourceRef", "sourceRef must be a string.");
  }
  if (value["refreshRemote"] !== undefined && typeof value["refreshRemote"] !== "boolean") {
    throw invalidArgument("refreshRemote", "refreshRemote must be a boolean.");
  }
  return {
    sessionId,
    cwd: value["cwd"],
    ...(value["sourceRef"] === undefined ? {} : { sourceRef: value["sourceRef"] }),
    ...(value["refreshRemote"] === undefined ? {} : { refreshRemote: value["refreshRemote"] })
  };
}

function validateSessionId(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0
    || value.length > MAXIMUM_WORKTREE_SESSION_ID_CHARACTERS || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw invalidArgument("sessionId", "sessionId is invalid.");
  }
  return value;
}

function repositoryIdFor(repositoryRoot: string): string {
  const identity = process.platform === "win32" ? resolve(repositoryRoot).toLowerCase() : resolve(repositoryRoot);
  return `repo-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function snapshotOwnerKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function snapshotRefFor(sessionId: string): string {
  return `${SNAPSHOT_REF_PREFIX}/${snapshotOwnerKey(sessionId)}`;
}

function deletedSnapshotMarker(sessionId: string): string {
  return `joko-worktree-deleted:${snapshotOwnerKey(sessionId)}`;
}

function preservedEntry(entry: ManagedWorktreeEntry, updatedAt: number): ManagedWorktreeEntry {
  return {
    ...entry,
    status: entry.archiveSnapshot === undefined ? "active" : "preserved",
    updatedAt
  };
}

function snapshotHasUnsupportedContent(status: string): boolean {
  for (const record of status.split("\0")) {
    if (record.startsWith("! ") || record.startsWith("u ")) return true;
    if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const submodule = record.split(" ", 4)[2];
      if (submodule?.startsWith("S") === true) return true;
    }
  }
  return false;
}

function optionalGitObjectId(value: string, message: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  return gitObjectId(trimmed, message);
}

function gitObjectId(value: string, message: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(trimmed)) {
    throw new WorktreeServiceError("GIT_FAILED", message);
  }
  return trimmed;
}

function leaseFromEntry(entry: ManagedWorktreeEntry): WorktreeLease {
  return Object.freeze({
    id: entry.id,
    sessionId: entry.sessionId,
    path: entry.path,
    repositoryRoot: entry.repositoryRoot,
    branch: entry.branch,
    source: Object.freeze({ ...entry.source }),
    acquiredAt: entry.updatedAt
  });
}

function sweepRecord(
  entry: ManagedWorktreeEntry,
  status: WorktreeSweepRecord["status"],
  reason?: string
): WorktreeSweepRecord {
  return Object.freeze({
    id: entry.id,
    path: entry.path,
    repositoryRoot: entry.repositoryRoot,
    status,
    ...(reason === undefined ? {} : { reason })
  });
}

function success<T>(value: T): WorktreeResult<T> {
  return Object.freeze({ ok: true, value });
}

function failure<T = never>(error: unknown): WorktreeResult<T> {
  const accepted = isWorktreeServiceError(error)
    ? error
    : new WorktreeServiceError("INTERNAL", "The worktree operation failed safely.");
  return Object.freeze({ ok: false, error: accepted.toJSON() });
}

function invalidArgument(field: string, message: string): WorktreeServiceError {
  return new WorktreeServiceError("INVALID_ARGUMENT", message, { field });
}

function hasUnsupportedKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).some((key) => !accepted.has(key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalError(error: unknown): boolean {
  return isWorktreeServiceError(error)
    && (error.code === "ABORTED" || error.code === "DISPOSED" || error.code === "OPERATION_TIMEOUT");
}

function errorCode(error: unknown): string {
  return isWorktreeServiceError(error) ? error.code : "INTERNAL";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw new WorktreeServiceError("PATH_UNSAFE", "A managed path could not be inspected safely.");
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}
